// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, ok, readJson } from '../http.js'
import { pathFor } from '../fs/contract.js'
import { Filesystem } from '../fs/store.js'
import { keyFor, ownerFor, ownerWhere, sessionColumns, sessionForeignKey, sessionWhere } from '../session/flight.js'
import type { SessionKey } from '../session/flight.js'
import { byteLength } from '../session/generation.js'
import { invalid, messageText, quota, unsupported, userUriPart } from '../session/protocol.js'
import type { StoredMessage } from '../session/protocol.js'
import { queryInt, requireMethod, sessionId } from '../session/store.js'
import type { Source } from './retrieval.js'

const outcomes = ['success', 'failure', 'partial', 'unknown', 'unfinished'] as const
type Outcome = typeof outcomes[number]
type Feedback = 'thumb_up' | 'thumb_down' | 'rating'
type State = 'running' | 'completed' | 'interrupted' | 'failed'
const dayMs = 86_400_000
const retention = 30 * dayMs
const perActor = 128, perUser = 384, perAccount = 2048
const owner = 'account_id,user_id,agent_id'
const turnColumns = `${owner},turn_id`
const base = '/api/v1/agent-evolution/experiences'
const trajectoryName = /^edge-vikingbot-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.md$/

export function initEvolution(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_bot_observations (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,
    question_seq INTEGER NOT NULL,answer_seq INTEGER,response_id TEXT,state TEXT NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,answered_at INTEGER,
    feedback_type TEXT,feedback_score REAL,feedback_reason TEXT,feedback_text TEXT,feedback_at INTEGER,
    PRIMARY KEY (${turnColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ov_bot_observation_response ON ov_bot_observations (${sessionColumns},response_id)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_bot_observation_expiry ON ov_bot_observations (account_id,created_at)`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_bot_observation_retention ON ov_bot_observations (${owner},created_at,turn_id)`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_bot_experience_evidence (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,turn_id TEXT NOT NULL,
    experience_node TEXT NOT NULL,experience_uri TEXT NOT NULL,revision TEXT NOT NULL,
    PRIMARY KEY (${turnColumns},experience_node), FOREIGN KEY (${turnColumns})
      REFERENCES ov_bot_observations (${turnColumns}) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_bot_experience_lineage ON ov_bot_experience_evidence (${owner},experience_node,experience_uri,turn_id)`)
}

function experiencePath(uri: unknown, ctx: WorkspaceContext) {
  if (typeof uri !== 'string' || !uri.trim().startsWith('viking://')) invalid('experience_uri must identify an Experience owned by the current user.')
  const path = pathFor(uri.trim(), ctx.caller)
  const [root, user, kind, sub, ...rest] = path.parts
  if (root !== 'user' || user !== ctx.caller.userId || kind !== 'memories' || sub !== 'experiences' ||
      !rest.length || rest.some(part => part.startsWith('.'))) {
    invalid('experience_uri must identify an Experience owned by the current user.')
  }
  return path
}

// Transactional with the local submission to the text binding. No client-supplied
// ContextParts, tags, ToolParts or model claims can assert a read or a response ID.
export function observeSubmission(sql: SqlStorage, key: SessionKey, turn: string, seq: number, sources: readonly Source[]): void {
  const now = Date.now()
  sql.exec(`DELETE FROM ov_bot_observations WHERE account_id=? AND created_at<=?`, key[0], now - retention)
  const counts = sql.exec<{ account: number, user_count: number, actor: number }>(`SELECT count(*) AS account,
    count(*) FILTER (WHERE user_id=?) AS user_count,
    count(*) FILTER (WHERE user_id=? AND agent_id=?) AS actor FROM ov_bot_observations WHERE account_id=?`,
  key[1], key[1], key[2], key[0]).one()
  // An actor only rolls its own history. Overflow at the broader quotas must
  // not evict another actor or prevent chat itself from using the session.
  if (counts.actor >= perActor) {
    const removed = sql.exec(`DELETE FROM ov_bot_observations WHERE ${ownerWhere} AND turn_id=(SELECT turn_id
      FROM ov_bot_observations WHERE ${ownerWhere} AND (state!='running' OR created_at<=?)
      ORDER BY created_at,turn_id LIMIT 1)`, ...key.slice(0, 3), ...key.slice(0, 3), now - 60_000).rowsWritten
    if (!removed) return
  } else if (counts.account >= perAccount || counts.user_count >= perUser) return

  sql.exec(`INSERT INTO ov_bot_observations (${sessionColumns},turn_id,question_seq,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'running',?,?)`, ...key, turn, seq, now, now)
  for (const source of sources) {
    if (!source.experience) continue
    sql.exec(`INSERT INTO ov_bot_experience_evidence (${turnColumns},experience_node,experience_uri,revision)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT (${turnColumns},experience_node) DO NOTHING`,
    key[0], key[1], key[2], turn, source.nodeId, source.uri, source.revision)
  }
}

export function observeAnswer(sql: SqlStorage, key: SessionKey, turn: string, seq: number, responseId: string): void {
  const now = Date.now()
  sql.exec(`UPDATE ov_bot_observations SET state='completed',answer_seq=?,response_id=?,answered_at=?,updated_at=?
    WHERE ${sessionWhere} AND turn_id=? AND state='running'`, seq, responseId, now, now, ...key, turn)
}

export function observeStop(sql: SqlStorage, key: SessionKey, turn: string, state: 'failed' | 'interrupted'): void {
  sql.exec(`UPDATE ov_bot_observations SET state=?,updated_at=? WHERE ${sessionWhere} AND turn_id=? AND state='running'`,
    state, Date.now(), ...key, turn)
}

function feedbackString(text: unknown, field: string, limit: number): string | null {
  if (text == null) return null
  if (typeof text !== 'string' || /\p{Cs}/u.test(text)) invalid(`${field} must be a Unicode string.`)
  if (text.length > limit || byteLength(text) > limit) quota(`${field} is too long.`)
  return text
}

export async function acceptFeedback(request: Request, ctx: WorkspaceContext): Promise<Response> {
  const body = await readJson(request, 8 * 1024)
  if (body.channel_id) unsupported('Feedback for external channels is not available.')
  const key = keyFor(ctx, sessionId(body.session_id)), id = body.response_id
  if (typeof id !== 'string' || !id.length || id.length > 255) invalid('response_id must be a nonempty string.')
  const type = body.feedback_type
  if (type !== 'thumb_up' && type !== 'thumb_down' && type !== 'rating') invalid('Unknown feedback_type.')
  const score = body.feedback_score ?? null
  if ((score !== null && (typeof score !== 'number' || !Number.isFinite(score))) || (type === 'rating' && score === null)) {
    invalid('Rating requires a finite feedback_score.')
  }
  const why = feedbackString(body.feedback_reason, 'feedback_reason', 256)
  const text = feedbackString(body.feedback_text, 'feedback_text', 2048)
  // The authenticated principal, not the caller's user_id/connection fields.
  await ctx.reauthorize?.()
  return Response.json(ctx.storage.transactionSync(() => {
    const now = Date.now(), { sql } = ctx
    ctx.assertActive?.()
    const response = sql.exec<{ answered_at: number }>(`UPDATE ov_bot_observations
      SET feedback_type=?,feedback_score=?,feedback_reason=?,feedback_text=?,feedback_at=?,updated_at=?
      WHERE ${sessionWhere} AND response_id=? AND state='completed' AND created_at>? RETURNING answered_at`,
    type, score, why, text, now, now, ...key, id, now - retention).toArray()[0]
    if (!response) throw new ApiError(404, 'NOT_FOUND', 'Response not found or no longer retained.')
    return { accepted: true, response_id: id, session_id: key[3], feedback_type: type,
      feedback_delay_sec: Math.max(0, now - response.answered_at) / 1000, timestamp: new Date(now).toISOString() }
  }))
}

type Trace = { turn_id: string, session_id: string, response_id: string | null, state: State, created_at: number, updated_at: number,
  archive_no: number, question_seq: number, answer_seq: number | null, feedback_type: Feedback | null, feedback_score: number | null }
const columns = `t.turn_id,t.session_id,t.response_id,t.state,t.created_at,t.updated_at,t.question_seq,t.answer_seq,
  t.feedback_type,t.feedback_score,m.archive_no`
const sealed = `JOIN ov_session_messages m ON m.account_id=t.account_id AND m.user_id=t.user_id AND m.agent_id=t.agent_id
      AND m.session_id=t.session_id AND m.seq=COALESCE(t.answer_seq,t.question_seq)
    LEFT JOIN ov_session_semantic_archives a ON a.account_id=m.account_id AND a.user_id=m.user_id AND a.agent_id=m.agent_id
      AND a.session_id=m.session_id AND a.archive_no=m.archive_no`
const visible = `t.account_id=? AND t.user_id=? AND t.agent_id=? AND t.created_at>? AND m.archive_no IS NOT NULL
  AND (a.status IS NULL OR a.status='completed')`

function outcome(trace: Trace): Outcome {
  if (trace.state !== 'completed') return 'unfinished'
  if (trace.feedback_type === 'thumb_up' || (trace.feedback_type === 'rating' && trace.feedback_score! > 0)) return 'success'
  if (trace.feedback_type === 'thumb_down' || (trace.feedback_type === 'rating' && trace.feedback_score! < 0)) return 'failure'
  return 'unknown' // Completion/no follow-up (or a neutral rating) isn't evidence of task success.
}
const name = (id: string) => `edge-vikingbot-${id}.md`
const traceUri = (user: string, id: string) => `viking://user/${userUriPart(user)}/memories/trajectories/${name(id)}`

function date(url: URL, field: string): number | undefined {
  const value = url.searchParams.get(field)?.trim()
  if (!value) return
  const stamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d\d-\d\d$/.test(value) || value.startsWith('0000-') || !Number.isFinite(stamp) ||
      new Date(stamp).toISOString().slice(0, 10) !== value) invalid(`${field} must be a valid YYYY-MM-DD date.`)
  return stamp
}

function scopeExperience(url: URL, ctx: WorkspaceContext) {
  const start = date(url, 'start_date'), end = date(url, 'end_date')
  if (start !== undefined && end !== undefined && start > end) invalid('start_date must not follow end_date.')
  const experience = experiencePath(url.searchParams.get('experience_uri'), ctx)
  const entry = new Filesystem(ctx).require(experience)
  if (entry.is_dir) invalid('experience_uri must identify an Experience file.')
  const rows = ctx.sql.exec<Trace>(`SELECT ${columns} FROM ov_bot_experience_evidence e JOIN ov_bot_observations t USING (${turnColumns})
    ${sealed} WHERE ${visible} AND e.experience_node=? AND e.experience_uri=? AND t.created_at>=? AND t.created_at<?
    ORDER BY t.updated_at DESC,t.created_at DESC,t.turn_id`, ...ownerFor(ctx), Date.now() - retention, entry.node_id,
  experience.uri, start ?? 0, end === undefined ? Number.MAX_SAFE_INTEGER : end + dayMs).toArray()
  // At most perActor rows: the same snapshot drives both pagination and counts.
  return { experience_uri: experience.uri, rows }
}

function readTrace(request: Request, url: URL, ctx: WorkspaceContext): Response | undefined {
  const uri = url.searchParams.get('uri') ?? ''
  if (!/\/memories\/trajectories\/edge-vikingbot-[a-f0-9-]+\.md$/u.test(uri)) return undefined
  const path = pathFor(uri, ctx.caller), [root, user, kind, sub, leaf, ...rest] = path.parts
  const id = leaf && trajectoryName.exec(leaf)?.[1]
  if (!id || root !== 'user' || user !== ctx.caller.userId || kind !== 'memories' || sub !== 'trajectories' || rest.length) return undefined
  requireMethod(request.method, 'GET')
  const { sql } = ctx
  const trace = sql.exec<Trace>(`SELECT ${columns} FROM ov_bot_observations t ${sealed} WHERE ${visible} AND t.turn_id=?`,
    ...ownerFor(ctx), Date.now() - retention, id).toArray()[0]
  const missing = () => new ApiError(404, 'NOT_FOUND', 'Trajectory not found.')
  if (!trace) throw missing()
  const fs = new Filesystem(ctx)
  const evidence = sql.exec<{ experience_uri: string, experience_node: string, revision: string }>(`SELECT experience_uri,experience_node,revision
    FROM ov_bot_experience_evidence WHERE ${ownerWhere} AND turn_id=? ORDER BY experience_uri`, ...ownerFor(ctx), id).toArray()
    .filter(row => {
      const source = experiencePath(row.experience_uri, ctx)
      return fs.acl.allows(source, 'read') && fs.entry(source)?.node_id === row.experience_node
    })
  if (!evidence.length) throw missing()
  const textAt = (seq: number | null) => {
    if (!seq) return ''
    const row = sql.exec<{ payload: string }>(`SELECT payload FROM ov_session_messages WHERE ${sessionWhere} AND seq=?`,
      ...keyFor(ctx, trace.session_id), seq).toArray()[0]
    return row ? messageText(JSON.parse(row.payload) as StoredMessage) : ''
  }
  const literal = (value: string, cap: number) => value.slice(0, cap).replace(/[&<>!`*_\[\]()#~|\\]/g, ch => `&#${ch.charCodeAt(0)};`)
    .replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')
  const lines = [
    '# VikingBot trajectory', '', `Outcome: ${outcome(trace)}`, `State: ${trace.state === 'running' ? 'owner_lost' : trace.state}`,
    `Archive: archive_${String(trace.archive_no).padStart(3, '0')}`, `Observed: ${new Date(trace.created_at).toISOString()}`,
    '', '## Experience excerpts submitted to the generation binding', ...evidence.map(e => literal(`${e.experience_uri} (${e.revision})`, 1152)),
    '', '## User input (excerpt)', literal(textAt(trace.question_seq), 768),
    ...(trace.answer_seq ? ['', '## Stored assistant response (excerpt)', literal(textAt(trace.answer_seq), 768)] : []),
  ].join('\n').split('\n')
  const offset = queryInt(url, 'offset', 0), limit = queryInt(url, 'limit', -1, -1)
  return ok(lines.slice(offset, limit === -1 ? undefined : offset + limit).join('\n'))
}

export function routeEvolution(request: Request, url: URL, ctx: WorkspaceContext): Response | undefined {
  const path = url.pathname.replace(/\/$/, '')
  if (path === '/api/v1/content/read') return readTrace(request, url, ctx)
  if (path !== `${base}/outcomes` && path !== `${base}/trajectories`) return undefined
  requireMethod(request.method, 'GET')
  if (path.endsWith('/outcomes')) {
    const { experience_uri, rows } = scopeExperience(url, ctx)
    const counts = { success: 0, failure: 0, partial: 0, unknown: 0, unfinished: 0 }
    for (const row of rows) counts[outcome(row)]++
    return ok({ experience_uri, outcome_distribution: outcomes.map(value => ({ outcome: value, count: counts[value] })) })
  }
  const limit = queryInt(url, 'limit', 50, 1, 1000), offset = queryInt(url, 'offset', 0)
  const { experience_uri, rows } = scopeExperience(url, ctx)
  const items = rows.slice(offset, offset + limit).map(row => ({ uri: traceUri(ctx.caller.userId, row.turn_id), name: name(row.turn_id),
    description: `VikingBot · ${outcome(row)}`, created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString() }))
  return ok({ experience_uri, items, total: rows.length, limit, offset, has_more: offset + items.length < rows.length })
}
