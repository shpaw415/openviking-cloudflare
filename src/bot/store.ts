// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { acquire, assertFlight, assertIdle, currentFlight, ownerWhere, release, sessionColumns, sessionForeignKey, sessionWhere } from '../session/flight.js'
import type { Owner, SessionKey } from '../session/flight.js'
import { byteLength } from '../session/generation.js'
import type { Generation } from '../session/generation.js'
import { encodeMessages, estimateText, messageText } from '../session/protocol.js'
import type { StoredMessage } from '../session/protocol.js'
import { addUsage, appendRows, getSession, insertSession, requireSession } from '../session/store.js'
import type { SessionRow } from '../session/store.js'
import { observeAnswer, observeStop } from './evolution.js'
import { hasActiveArchiveTask } from '../session/archives.js'

type Flight = ReturnType<typeof acquire>
type Turn = { turn_id: string | null, flight_token: string | null, status: string | null, error: string | null, response_id: string | null }

export function initBot({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_bot_threads (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,
    metadata TEXT NOT NULL,turn_id TEXT,flight_token TEXT,status TEXT,error TEXT,response_id TEXT,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
}

const info = (row: SessionRow) => ({ id: row.session_id, created_at: row.created_at, last_active: row.updated_at,
  message_count: row.total_message_count })

export function createThread(ctx: WorkspaceContext, key: SessionKey, metadata: Record<string, unknown>) {
  return ctx.storage.transactionSync(() => {
    ctx.assertActive?.()
    const now = new Date().toISOString()
    if (getSession(ctx.sql, key)) throw new ApiError(409, 'ALREADY_EXISTS', 'Session already exists.')
    insertSession(ctx.sql, key, now, null)
    ctx.sql.exec(`INSERT INTO ov_bot_threads (${sessionColumns},metadata) VALUES (?,?,?,?,?)`, ...key, JSON.stringify(metadata))
    return { session_id: key[3], created_at: now }
  })
}

export function botSessions(sql: SqlStorage, owner: Owner) {
  const sessions = sql.exec<SessionRow>(`SELECT s.* FROM ov_sessions s JOIN ov_bot_threads b USING (${sessionColumns})
    WHERE ${ownerWhere} ORDER BY s.updated_at DESC,s.session_id`, ...owner).toArray().map(info)
  return { sessions, total: sessions.length }
}

function turnFor(sql: SqlStorage, key: SessionKey): Turn | undefined {
  return sql.exec<Turn>(`SELECT turn_id,flight_token,status,error,response_id FROM ov_bot_threads WHERE ${sessionWhere}`, ...key).toArray()[0]
}

export function requireThread(sql: SqlStorage, key: SessionKey): Turn {
  const row = turnFor(sql, key)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Bot session not found.')
  return row
}

export function botDetail(ctx: WorkspaceContext, key: SessionKey, budget: number) {
  const turn = requireThread(ctx.sql, key), session = requireSession(ctx.sql, key)
  const messages: Array<{ role: string, content: string, timestamp: string }> = []
  let bytes = 0, estimated_tokens = 0
  if (budget > 0) {
    for (const { payload } of ctx.sql.exec<{ payload: string }>(`SELECT payload FROM ov_session_messages
      WHERE ${sessionWhere} ORDER BY seq DESC LIMIT 200`, ...key)) {
      const m: StoredMessage = JSON.parse(payload)
      if (!['user', 'assistant', 'tool', 'system'].includes(m.role)) continue
      const content = messageText(m)
      if (!content) continue
      const msg = { role: m.role, content, timestamp: m.created_at }
      const cost = estimateText(content), size = byteLength(JSON.stringify(msg)) + 1
      if (estimated_tokens + cost > budget || bytes + size > 256 * 1024) break
      estimated_tokens += cost
      bytes += size
      messages.push(msg)
    }
  }
  const lost = turn.status === 'running' && currentFlight(ctx, key)?.token !== turn.flight_token
  return { session: info(session), messages: messages.reverse(), estimated_tokens,
    ...(turn.turn_id && { turn: { turn_id: turn.turn_id, status: lost ? 'failed' : turn.status,
      error: lost ? 'TURN_OWNER_LOST' : turn.error, response_id: turn.response_id } }) }
}

export function beginTurn(ctx: WorkspaceContext, key: SessionKey, content: string, reply: boolean) {
  const turn = crypto.randomUUID(), { sql, storage } = ctx
  const input = encodeMessages({ role: 'user', turn_id: turn, message_kind: 'user_query', content }, false, key[1])
  const user: StoredMessage = JSON.parse(input.rows[0].payload)
  const { flight, seq } = storage.transactionSync(() => {
    ctx.assertActive?.()
    assertIdle(ctx, key)
    if (reply && hasActiveArchiveTask(ctx, key)) throw new ApiError(409, 'CONFLICT', 'An archive task is active in this session.')
    appendRows(sql, key, input, false)
    const lease = reply ? acquire(ctx, key, 'bot') : undefined
    sql.exec(`INSERT INTO ov_bot_threads (${sessionColumns},metadata,turn_id,flight_token,status) VALUES (?,?,?,?,'{}',?,?,?)
      ON CONFLICT (${sessionColumns}) DO UPDATE SET turn_id=excluded.turn_id,flight_token=excluded.flight_token,
      status=excluded.status,error=NULL,response_id=NULL`, ...key, turn, lease?.token ?? null, reply ? 'running' : 'no_reply')
    return { flight: lease, seq: requireSession(sql, key).total_message_count }
  })
  return { user, turn, flight, seq }
}

export function finishTurn(ctx: WorkspaceContext, key: SessionKey, flight: Flight, turn: string, user: StoredMessage, result: Generation) {
  const output = encodeMessages({ role: 'assistant', turn_id: turn, message_kind: 'assistant_step',
    source_message_ids: [user.id], content: result.text }, false, key[1])
  const msg: StoredMessage = JSON.parse(output.rows[0].payload)
  return ctx.storage.transactionSync(() => {
    ctx.assertActive?.()
    assertFlight(ctx, key, flight)
    appendRows(ctx.sql, key, output, false)
    addUsage(ctx.sql, key, result)
    observeAnswer(ctx.sql, key, turn, requireSession(ctx.sql, key).total_message_count, msg.id)
    ctx.sql.exec(`UPDATE ov_bot_threads SET status='completed',error=NULL,response_id=? WHERE ${sessionWhere} AND flight_token=?`,
      msg.id, ...key, flight.token)
    release(ctx, key, flight)
    return msg
  })
}

export function stopTurn(ctx: WorkspaceContext, key: SessionKey, flight: Pick<Flight, 'token'>, state: 'interrupted' | 'failed', error: string): boolean {
  return ctx.storage.transactionSync(() => {
    if (!release(ctx, key, flight)) return false
    const turn = ctx.sql.exec<{ turn_id: string }>(`UPDATE ov_bot_threads SET status=?,error=? WHERE ${sessionWhere} AND flight_token=?
      RETURNING turn_id`, state, error, ...key, flight.token).toArray()[0]
    if (turn) observeStop(ctx.sql, key, turn.turn_id, state)
    return true
  })
}
