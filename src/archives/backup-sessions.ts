// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { int, invalid, onlyKeys, parseTags, textSize } from '../fs/contract.js'
import { sessionWhere, type SessionKey } from '../session/flight.js'
import { estimateText, memoryPolicy, type StoredMessage } from '../session/protocol.js'
import { sessionConfig, sessionId, sessionUri, type RecoveredSession, type SessionRow } from '../session/store.js'
import { encoder, quota } from './common.js'
import { topology } from './backup-codec.js'
import { hasTable, privateURI, type Domain } from './backup-domain.js'

export const SESSION_CAP = 32, HISTORY_CAP = 256, SESSION_BYTES = 256 * 1024
const unsupported = (): never => topology('Edge backup cannot represent this session history, message type, agent or runtime state.')
export type BackupSession = Omit<RecoveredSession, 'memory_policy'> & { uri: string; memory_policy: unknown }

function date(value: unknown, empty = false): string {
  if (empty && value === '') return value
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return unsupported()
  return value
}

function messages(value: unknown, seen: Set<string>): StoredMessage[] {
  if (!Array.isArray(value) || value.length > HISTORY_CAP) return unsupported()
  return value.map(item => {
    if (!isRecord(item) || Object.keys(item).length !== 4 || typeof item.id !== 'string' || !/^msg_[a-f0-9]{32}$/.test(item.id) ||
        seen.has(item.id) || (item.role !== 'user' && item.role !== 'assistant') || !Array.isArray(item.parts) || item.parts.length > 64) return unsupported()
    seen.add(item.id)
    const parts = item.parts.map(part => {
      if (!isRecord(part) || Object.keys(part).length !== 2 || part.type !== 'text' || typeof part.text !== 'string') return unsupported()
      textSize(part.text)
      return { type: 'text' as const, text: part.text }
    })
    const message = { id: item.id, role: item.role, parts, created_at: date(item.created_at) }
    if (encoder.encode(JSON.stringify(message)).byteLength >= 64 * 1024) quota('Backup message exceeds the session limit.')
    return message
  })
}

export function readBackupSession(domain: Domain, value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 10 || !Array.isArray(value.archives) || value.archives.length > HISTORY_CAP ||
      !Array.isArray(value.tags)) invalid('Invalid Edge session record.')
  onlyKeys(value, 'uri created_at updated_at last_message_at last_commit_at keep_recent_count memory_policy tags messages archives')
  const { uri, owner, name } = privateURI(domain, value.uri, 'sessions')
  const id = sessionId(name)
  if (!domain.scope.sessionOwners.includes(owner)) return unsupported()
  const seen = new Set<string>()
  const archives = value.archives.map(archive => {
    if (!isRecord(archive) || Object.keys(archive).length !== 2 || typeof archive.reset !== 'boolean') invalid('Invalid Edge archive boundary.')
    const recovered = messages(archive.messages, seen)
    if (archive.reset ? recovered.length : !recovered.length) return unsupported()
    return { reset: archive.reset, messages: recovered }
  })
  const active = messages(value.messages, seen), tags = parseTags(value.tags)
  if (seen.size > HISTORY_CAP) quota('Edge session message limit exceeded.')
  if (JSON.stringify(tags) !== JSON.stringify(value.tags)) invalid('Edge session tags are not canonical.')
  const policy = memoryPolicy(value.memory_policy)
  const data: BackupSession = { uri, created_at: date(value.created_at), updated_at: date(value.updated_at),
    last_message_at: date(value.last_message_at, true), last_commit_at: date(value.last_commit_at, true),
    keep_recent_count: int(value.keep_recent_count, 'keep_recent_count', -1, 0, 10_000),
    memory_policy: policy === null ? null : JSON.parse(policy), tags, messages: active, archives }
  if (data.keep_recent_count < 0 || Boolean(seen.size) !== Boolean(data.last_message_at) ||
      archives.some(archive => !archive.reset) !== Boolean(data.last_commit_at)) return unsupported()
  return { data, key: [domain.scope.account, owner, 'default', id] as SessionKey,
    restore: { ...data, memory_policy: policy } satisfies RecoveredSession }
}

export function captureSessions(d: Domain): BackupSession[] {
  const { sql, scope: { account } } = d
  if (!hasTable(sql, 'ov_sessions')) return []
  for (const [table, filter] of [['ov_session_flights', ''], ['ov_session_semantic_archives', ''], ['ov_session_tool_results', ''],
    ['ov_session_auto_commit', ' AND policy IS NOT NULL'], ['ov_bot_threads', '']]) {
    if (hasTable(sql, table) && sql.exec(`SELECT 1 FROM ${table} WHERE account_id=?${filter} LIMIT 1`, account).toArray().length) unsupported()
  }
  const rows = sql.exec<SessionRow & { user_id: string; agent_id: string }>(`SELECT user_id,agent_id,session_id,created_at,updated_at,last_message_at,last_commit_at,
    message_count,total_message_count,commit_count,keep_recent_count,message_bytes,memory_policy FROM ov_sessions WHERE account_id=?
    ORDER BY user_id,session_id LIMIT ?`, account, SESSION_CAP + 1).toArray()
  if (rows.length > SESSION_CAP || rows.reduce((n, r) => n + r.total_message_count, 0) > HISTORY_CAP ||
      rows.reduce((n, r) => n + r.message_bytes, 0) > SESSION_BYTES) quota('Edge session snapshot exceeds its aggregate cap.')
  return rows.map(row => {
    const { user_id, agent_id, session_id, total_message_count, message_count, commit_count } = row
    if (agent_id !== 'default' || commit_count > HISTORY_CAP || !d.scope.sessionOwners.includes(user_id)) return unsupported()
    const key: SessionKey = [account, user_id, 'default', session_id]
    const history = sql.exec<{ archive_no: number; context_reset: number }>(`SELECT archive_no,context_reset FROM ov_session_archives
      WHERE ${sessionWhere} ORDER BY archive_no LIMIT ?`, ...key, HISTORY_CAP + 1).toArray()
    if (history.length !== commit_count || history.some((item, i) => item.archive_no !== i + 1)) return unsupported()
    const archives = history.map(a => ({ reset: a.context_reset === 1, messages: [] as StoredMessage[] }))
    const active: StoredMessage[] = []
    const source = sql.exec<{ seq: number; archive_no: number | null; payload: string; tokens: number }>(`SELECT seq,archive_no,payload,tokens
      FROM ov_session_messages WHERE ${sessionWhere} ORDER BY seq LIMIT ?`, ...key, HISTORY_CAP + 1).toArray()
    if (source.length !== total_message_count) return unsupported()
    let last = 0, consumed = 0
    for (const [i, item] of source.entries()) {
      const n = item.archive_no ?? commit_count + 1
      if (item.seq !== i + 1 || n < last || n < 1 || (item.archive_no !== null && !archives[n - 1])) return unsupported()
      const parsed = messages([JSON.parse(item.payload)], new Set())[0]
      if (JSON.stringify(parsed) !== item.payload || estimateText(parsed.parts.map(part => part.type === 'text' ? part.text : '').join('')) !== item.tokens) return unsupported()
      ;(n > commit_count ? active : archives[n - 1].messages).push(parsed)
      last = n; consumed += encoder.encode(item.payload).byteLength + 1
    }
    if (active.length !== message_count || consumed !== row.message_bytes) return unsupported()
    const { created_at, updated_at, last_message_at, last_commit_at, keep_recent_count } = row
    return readBackupSession(d, { uri: sessionUri(user_id, session_id), created_at, updated_at, last_message_at,
      last_commit_at, keep_recent_count, memory_policy: row.memory_policy === null ? null : JSON.parse(row.memory_policy),
      tags: sessionConfig(sql, key).memory_extraction_config.events.tags, messages: active, archives }).data
  })
}
