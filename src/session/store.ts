// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { assertIdle, currentFlight, ownerWhere, sessionColumns, sessionForeignKey, sessionWhere } from './flight.js'
import type { Owner, SessionKey } from './flight.js'
import { byteLength } from './generation.js'
import type { Generation } from './generation.js'
import { estimateText, invalid, quota, userUriPart } from './protocol.js'
import type { encodeMessages, StoredMessage } from './protocol.js'
import { autoState, initAutoPolicy } from './auto-policy.js'
import { activeCheckpoint, initRetention, retentionState } from './retention.js'
import { initIdle, lastIdleAccepted } from './idle.js'

const accountQuota = { sessions: 2_048, messages: 40_000, bytes: 32 * 1024 * 1024 }
const userQuota = { sessions: 512, messages: 12_000, bytes: 12 * 1024 * 1024 }
const maxSessionMessages = 10_000
const maxSessionBytes = 8 * 1024 * 1024
type AppendGrowth = { messages: number, bytes: number }
export type SessionRow = {
  session_id: string
  created_at: string
  updated_at: string
  last_message_at: string
  last_commit_at: string
  message_count: number
  total_message_count: number
  commit_count: number
  keep_recent_count: number
  message_bytes: number
  memory_policy: string | null
}

export function initStore({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_sessions (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL DEFAULT '', last_commit_at TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0, total_message_count INTEGER NOT NULL DEFAULT 0,
    commit_count INTEGER NOT NULL DEFAULT 0, keep_recent_count INTEGER NOT NULL DEFAULT 0,
    message_bytes INTEGER NOT NULL DEFAULT 0,
    memory_policy TEXT,
    PRIMARY KEY (account_id, user_id, agent_id, session_id)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_archives (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    archive_no INTEGER NOT NULL, context_reset INTEGER NOT NULL CHECK (context_reset IN (0, 1)),
    PRIMARY KEY (account_id, user_id, agent_id, session_id, archive_no),
    FOREIGN KEY (account_id, user_id, agent_id, session_id)
      REFERENCES ov_sessions (account_id, user_id, agent_id, session_id) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_messages (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    seq INTEGER NOT NULL, archive_no INTEGER, payload TEXT NOT NULL, tokens INTEGER NOT NULL,
    PRIMARY KEY (account_id, user_id, agent_id, session_id, seq),
    FOREIGN KEY (account_id, user_id, agent_id, session_id)
      REFERENCES ov_sessions (account_id, user_id, agent_id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, user_id, agent_id, session_id, archive_no)
      REFERENCES ov_session_archives (account_id, user_id, agent_id, session_id, archive_no)
      ON DELETE CASCADE
  ) WITHOUT ROWID`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_session_messages_by_archive
    ON ov_session_messages (account_id, user_id, agent_id, session_id, archive_no, seq)`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_settings (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tags TEXT NOT NULL,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_usage (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, unknown_calls INTEGER NOT NULL,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_semantic_archives (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    archive_no INTEGER NOT NULL, job_id TEXT NOT NULL, flight_token TEXT NOT NULL, options TEXT NOT NULL, sealed_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'completed')), failure TEXT,
    plan TEXT, overview TEXT NOT NULL DEFAULT '', task_id TEXT,
    PRIMARY KEY (${sessionColumns},archive_no), FOREIGN KEY (${sessionColumns},archive_no)
      REFERENCES ov_session_archives (${sessionColumns},archive_no) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  if (!sql.exec<{ name: string }>('PRAGMA table_info(ov_session_semantic_archives)').toArray().some(column => column.name === 'task_id')) {
    sql.exec('ALTER TABLE ov_session_semantic_archives ADD COLUMN task_id TEXT')
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_session_semantic_unfinished ON ov_session_semantic_archives
    (${sessionColumns},status,archive_no) WHERE status != 'completed'`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_memory_receipts (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    archive_no INTEGER NOT NULL, page_id INTEGER NOT NULL, uri TEXT NOT NULL,
    PRIMARY KEY (${sessionColumns},archive_no,page_id), FOREIGN KEY (${sessionColumns},archive_no)
      REFERENCES ov_session_semantic_archives (${sessionColumns},archive_no) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  initAutoPolicy(sql)
  initIdle(sql)
  initRetention(sql)
}

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 255 || /[^a-zA-Z0-9_.@-]/.test(value) ||
      value === '.' || value === '..') invalid('Invalid session_id.')
  return value
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `${stamp}-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function queryBool(url: URL, name: string, fallback: boolean): boolean {
  const raw = url.searchParams.get(name)?.toLowerCase()
  if (raw === undefined) return fallback
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(raw)) return true
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(raw)) return false
  return invalid(`${name} must be a boolean.`)
}

export function requireMethod(actual: string, ...allowed: string[]): void {
  if (!allowed.includes(actual) && !(actual === 'HEAD' && allowed.includes('GET'))) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Expected ${allowed.join(' or ')}.`)
  }
}

export function getSession(sql: SqlStorage, key: SessionKey): SessionRow | undefined {
  return sql.exec<SessionRow>(`SELECT * FROM ov_sessions WHERE ${sessionWhere}`, ...key).toArray()[0]
}

export function requireSession(sql: SqlStorage, key: SessionKey): SessionRow {
  const row = getSession(sql, key)
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Session not found.')
  return row
}

// Read persisted totals in the same transaction as admission and mutation. The
// session row counts live AND archived messages; no separate ledger can drift.
function checkGrowth(sql: SqlStorage, [account, user]: SessionKey, sessions: number, { messages, bytes }: AppendGrowth): void {
  if (!sessions && !messages && !bytes) return
  const usage = sql.exec<{
    account_sessions: number, account_messages: number, account_bytes: number,
    user_sessions: number, user_messages: number, user_bytes: number,
  }>(`SELECT COUNT(*) AS account_sessions,
      COALESCE(SUM(total_message_count), 0) AS account_messages,
      COALESCE(SUM(message_bytes), 0) AS account_bytes,
      COUNT(*) FILTER (WHERE user_id = ?) AS user_sessions,
      COALESCE(SUM(total_message_count) FILTER (WHERE user_id = ?), 0) AS user_messages,
      COALESCE(SUM(message_bytes) FILTER (WHERE user_id = ?), 0) AS user_bytes
    FROM ov_sessions WHERE account_id = ?`, user, user, user, account).one()
  if ((sessions && usage.user_sessions + sessions > userQuota.sessions) ||
      (messages && usage.user_messages + messages > userQuota.messages) ||
      (bytes && usage.user_bytes + bytes > userQuota.bytes)) quota('User session storage quota exceeded.')
  if ((sessions && usage.account_sessions + sessions > accountQuota.sessions) ||
      (messages && usage.account_messages + messages > accountQuota.messages) ||
      (bytes && usage.account_bytes + bytes > accountQuota.bytes)) quota('Account session storage quota exceeded.')
}

// Called inside transactionSync, including the get-or-create and append paths.
export function insertSession(sql: SqlStorage, key: SessionKey, now: string, policy: string | null,
  growth: AppendGrowth = { messages: 0, bytes: 0 }): SessionRow {
  checkGrowth(sql, key, 1, growth)
  sql.exec(`INSERT INTO ov_sessions (account_id, user_id, agent_id, session_id, created_at, updated_at, memory_policy)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, ...key, now, now, policy)
  return requireSession(sql, key)
}

export function sessionUri(userId: string, id: string): string {
  return `viking://user/${userUriPart(userId)}/sessions/${id}`
}

export function identity(owner: Owner | SessionKey) {
  return { account_id: owner[0], user_id: owner[1], user_space_name: owner[1] }
}

export function setSessionTags(sql: SqlStorage, key: SessionKey, tags: string[]): void {
  sql.exec(`INSERT INTO ov_session_settings (${sessionColumns},tags) VALUES (?,?,?,?,?)
    ON CONFLICT (${sessionColumns}) DO UPDATE SET tags=excluded.tags`, ...key, JSON.stringify(tags))
}

export function sessionConfig(sql: SqlStorage, key: SessionKey) {
  const entry = sql.exec<{ tags: string }>(`SELECT tags FROM ov_session_settings WHERE ${sessionWhere}`, ...key).toArray()[0]
  const tags: string[] = entry ? JSON.parse(entry.tags) : []
  return { auto_commit_policy: autoState(sql, key).policy, memory_extraction_config: { events: { tags } } }
}

// Called only after a provider response, in the transaction guarded by its flight.
export function addUsage(sql: SqlStorage, key: SessionKey, usage: Pick<Generation, 'inputTokens' | 'outputTokens'>): void {
  sql.exec(`INSERT INTO ov_session_usage (${sessionColumns},input,output,unknown_calls) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT (${sessionColumns}) DO UPDATE SET input=input+excluded.input, output=output+excluded.output,
      unknown_calls=unknown_calls+excluded.unknown_calls`, ...key, usage.inputTokens ?? 0, usage.outputTokens ?? 0,
  (usage.inputTokens === null || usage.outputTokens === null) ? 1 : 0)
}

export function extractionCount(sql: SqlStorage, key: SessionKey): number {
  return sql.exec<{ total: number }>(`SELECT count(*) AS total FROM ov_session_memory_receipts WHERE ${sessionWhere}`, ...key).one().total
}

export function pendingTokens(sql: SqlStorage, key: SessionKey, s: SessionRow): number {
  if (s.message_count <= s.keep_recent_count) return 0
  return sql.exec<{ tokens: number }>(`SELECT COALESCE(SUM(tokens), 0) AS tokens FROM ov_session_messages
    WHERE ${sessionWhere} AND archive_no IS NULL AND seq <= ?`, ...key,
    s.total_message_count - s.keep_recent_count).one().tokens
}

export function sessionDetail(sql: SqlStorage, key: SessionKey, s: SessionRow) {
  const usage = sql.exec<{ input: number, output: number, unknown_calls: number }>(`SELECT input,output,unknown_calls
    FROM ov_session_usage WHERE ${sessionWhere}`, ...key).toArray()[0]
  const extracted = extractionCount(sql, key)
  return {
    session_id: s.session_id, uri: sessionUri(key[1], s.session_id), user: identity(key),
    created_at: s.created_at, updated_at: s.updated_at, last_message_at: s.last_message_at,
    created_by_account_id: key[0], created_by_user_id: key[1],
    message_count: s.message_count, total_message_count: s.total_message_count,
    commit_count: s.commit_count, last_commit_at: s.last_commit_at, keep_recent_count: s.keep_recent_count,
    pending_tokens: pendingTokens(sql, key, s),
    memory_policy: s.memory_policy === null ? null : JSON.parse(s.memory_policy),
    memories_extracted: { total: extracted, ...(extracted ? { events: extracted } : {}) },
    llm_token_usage: { prompt_tokens: usage?.input ?? 0, completion_tokens: usage?.output ?? 0,
      total_tokens: (usage?.input ?? 0) + (usage?.output ?? 0), unknown_calls: usage?.unknown_calls ?? 0 },
    embedding_token_usage: { total_tokens: null },
    ...retentionState(sql, key),
    last_auto_commit_at: autoState(sql, key).last, last_idle_commit_accepted_at: lastIdleAccepted(sql,key),
    ...sessionConfig(sql, key),
  }
}

// Caller owns the transaction and checks/acquires its flight before mutation.
export function appendRows(sql: SqlStorage, key: SessionKey, input: ReturnType<typeof encodeMessages>, batch: boolean) {
  const added = input.rows.length
  const now = new Date().toISOString()
  const existing = getSession(sql, key)
  const total = (existing?.total_message_count ?? 0) + added
  const bytes = (existing?.message_bytes ?? 0) + input.bytes
  if (total > maxSessionMessages || bytes > maxSessionBytes) quota('Session exceeds 10,000 messages or 8 MiB of history.')
  const growth = { messages: added, bytes: input.bytes }
  if (existing) checkGrowth(sql, key, 0, growth)
  const session = existing ?? insertSession(sql, key, now, null, growth)

  let seq = session.total_message_count
  for (const { payload, tokens } of input.rows) {
    sql.exec(`INSERT INTO ov_session_messages (account_id, user_id, agent_id, session_id, seq, payload, tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, ...key, ++seq, payload, tokens)
  }
  const message_count = session.message_count + added
  if (added) {
    sql.exec(`UPDATE ov_sessions SET message_count = ?, total_message_count = ?, message_bytes = ?,
      updated_at = ?, last_message_at = ? WHERE ${sessionWhere}`, message_count, total, bytes, now, now, ...key)
  }
  return { session_id: key[3], message_count, ...(batch ? { added } : {}), pending_tokens: pendingTokens(sql, key, {
    ...session, message_count, total_message_count: total,
  }) }
}

export type RecoveredSession = {
  created_at: string; updated_at: string; last_message_at: string; last_commit_at: string; keep_recent_count: number
  memory_policy: string | null; tags: string[]; messages: StoredMessage[]; archives: { reset: boolean; messages: StoredMessage[] }[]
}

/** Called only inside the caller's outer transaction with validated history.
 * Rebuild counters/indexes. Do not publish jobs, leases or identities. */
export function restoreSessionHistory(sql: SqlStorage, key: SessionKey, data: RecoveredSession): void {
  const encode = (message: StoredMessage) => ({ payload: JSON.stringify(message),
    tokens: estimateText(message.parts.map(part => part.type === 'text' ? part.text : '').join('')) })
  const groups = data.archives.map(archive => archive.messages.map(encode)), active = data.messages.map(encode)
  const all = [...groups.flat(), ...active]
  const bytes = all.reduce((sum, row) => sum + byteLength(row.payload) + 1, 0)
  insertSession(sql, key, data.created_at, data.memory_policy, { bytes, messages: all.length })
  let seq = 0
  const append = (rows: typeof active, archive: number | null) => {
    for (const { payload, tokens } of rows) sql.exec(`INSERT INTO ov_session_messages
      (${sessionColumns},seq,archive_no,payload,tokens) VALUES (?,?,?,?,?,?,?,?)`, ...key, ++seq, archive, payload, tokens)
  }
  data.archives.forEach(({ reset }, i) => {
    sql.exec(`INSERT INTO ov_session_archives (${sessionColumns},archive_no,context_reset) VALUES (?,?,?,?,?,?)`, ...key, i + 1, Number(reset))
    append(groups[i], i + 1)
  })
  append(active, null)
  setSessionTags(sql, key, data.tags)
  sql.exec(`UPDATE ov_sessions SET updated_at=?,last_message_at=?,last_commit_at=?,keep_recent_count=?,
    message_count=?,total_message_count=?,commit_count=?,message_bytes=? WHERE ${sessionWhere}`, data.updated_at, data.last_message_at,
  data.last_commit_at, data.keep_recent_count, active.length, all.length, groups.length, bytes, ...key)
}

export function deleteSession(ctx: WorkspaceContext, key: SessionKey): void {
  ctx.storage.transactionSync(() => {
    requireSession(ctx.sql, key)
    if (currentFlight(ctx, key)?.kind === 'bot') assertIdle(ctx, key)
    ctx.sql.exec(`DELETE FROM ov_sessions WHERE ${sessionWhere}`, ...key)
  })
}

export function listSessions(sql: SqlStorage, owner: Owner): SessionRow[] {
  return sql.exec<SessionRow>(`SELECT * FROM ov_sessions WHERE ${ownerWhere} ORDER BY updated_at DESC, session_id`, ...owner).toArray()
}

export function queryInt(url: URL, name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < min || n > max) invalid(`${name} must be an integer in range.`)
  return n
}

export function latestOverview(sql: SqlStorage, key: SessionKey, before = Number.MAX_SAFE_INTEGER): string {
  return sql.exec<{ overview: string }>(`SELECT w.overview FROM ov_session_semantic_archives w WHERE ${sessionWhere}
    AND w.status='completed' AND w.overview != '' AND w.archive_no<? AND w.archive_no > COALESCE((SELECT max(archive_no)
      FROM ov_session_archives WHERE ${sessionWhere} AND context_reset=1 AND archive_no<?),0)
    ORDER BY w.archive_no DESC LIMIT 1`, ...key, before, ...key, before).toArray()[0]?.overview ?? ''
}

export function sessionContext(ctx: WorkspaceContext, key: SessionKey, budget: number, responseBytes = maxSessionBytes) {
  const { sql } = ctx
  const session = requireSession(sql, key)
  let tokens = 0
  let bytes = 0
  const messages: StoredMessage[] = []
  if (budget > 0) {
    const rows = sql.exec<{ payload: string, tokens: number }>(`SELECT payload, tokens FROM ov_session_messages
      WHERE ${sessionWhere} AND archive_no IS NULL ORDER BY seq DESC`, ...key)
    for (const row of rows) {
      const size = byteLength(row.payload) + 1
      if (tokens + row.tokens > budget || bytes + size > responseBytes) break
      messages.push(JSON.parse(row.payload))
      tokens += row.tokens
      bytes += size
    }
    messages.reverse()
    const checkpoint=activeCheckpoint(sql,key)
    if (checkpoint && messages.length===session.message_count && session.total_message_count-session.message_count+1===checkpoint.tail_start &&
        tokens+checkpoint.tokens<=budget && bytes+byteLength(checkpoint.anchor)+1<=responseBytes) {
      messages.unshift(JSON.parse(checkpoint.anchor));tokens+=checkpoint.tokens
    }
  }
  const overview = budget > tokens ? latestOverview(sql, key) : ''
  const summaryTokens = estimateText(overview)
  const included = !!overview && summaryTokens <= budget - tokens
  const failed = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ov_session_semantic_archives
    WHERE ${sessionWhere} AND status='failed'`, ...key).one().n + sql.exec<{ task_id: string }>(`SELECT task_id
      FROM ov_session_semantic_archives WHERE ${sessionWhere} AND status='pending' AND task_id IS NOT NULL`, ...key)
    .toArray().filter(row => ctx.jobs?.get(row.task_id)?.status === 'cancelled').length
  return {
    latest_archive_overview: included ? overview : '', pre_archive_abstracts: [], messages,
    estimatedTokens: tokens + (included ? summaryTokens : 0),
    stats: { totalArchives: session.commit_count, includedArchives: included ? 1 : 0,
      droppedArchives: session.commit_count - (included ? 1 : 0) - failed, failedArchives: failed,
      activeTokens: tokens, archiveTokens: included ? summaryTokens : 0 },
  }
}
