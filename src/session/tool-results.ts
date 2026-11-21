// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, ok } from '../http.js'
import { sessionColumns, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { byteLength, sha256 } from './generation.js'
import { decodeSegment, invalid, quota } from './protocol.js'
import type { encodeMessages, StoredMessage } from './protocol.js'
import { queryBool, queryInt, requireSession } from './store.js'

export function initToolResults(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_tool_results (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    id TEXT NOT NULL, seq INTEGER NOT NULL, part_no INTEGER NOT NULL,
    tool_name TEXT NOT NULL, sha256 TEXT NOT NULL, chars INTEGER NOT NULL,
    PRIMARY KEY (${sessionColumns},id), FOREIGN KEY (${sessionColumns},seq)
      REFERENCES ov_session_messages (${sessionColumns},seq) ON DELETE CASCADE
  ) WITHOUT ROWID`)
  for (const [name, filter] of [['recent', ''], ['named', 'tool_name,']]) {
    sql.exec(`CREATE INDEX IF NOT EXISTS ov_session_tools_${name} ON ov_session_tool_results
      (${sessionColumns},${filter}seq DESC,part_no,id)`)
  }
}

type ToolIndex = { id: string, row: number, part: number, name: string, hash: string, chars: number }

export async function prepareToolResults(input: ReturnType<typeof encodeMessages>): Promise<ToolIndex[]> {
  const index: ToolIndex[] = []
  for (const [row, record] of input.rows.entries()) {
    const message: StoredMessage = JSON.parse(record.payload)
    const candidates = message.parts.flatMap((p, part) => p.type === 'tool' && p.tool_output && !p.tool_output_truncated
      && !p.tool_output_ref && !p.tool_output_storage_uri ? [{ p, part, content: p.tool_output }] : [])
    if (!candidates.length) continue
    if (index.length + candidates.length > 128) quota('At most 128 complete tool outputs may be indexed per append.')
    for (const { p, part, content } of candidates) {
      if (p.tool_name.length > 256 || /\p{Cs}/u.test(content)) invalid('Tool output must be valid Unicode and the tool name must be bounded.')
      const digest = await sha256(content)
      const safe = p.tool_id.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 96)
      const id = p.tool_id ? `tr_${safe || 'tool'}_${digest.slice(0, 16)}` : `tr_${digest.slice(0, 24)}`
      const chars = Array.from(content).length
      index.push({ id, row, part, name: p.tool_name, hash: digest, chars })
      p.tool_output_ref = id
      p.tool_output_sha256 = digest
    }
    const payload = JSON.stringify(message)
    const nextSize = byteLength(payload)
    if (nextSize + 1 > 64 * 1024) quota('One indexed message exceeds 64 KiB.')
    input.bytes += nextSize - byteLength(record.payload)
    if (input.bytes > 1024 * 1024) quota('Expanded append exceeds 1 MiB.')
    record.payload = payload
  }
  return index
}

export function insertToolResults(sql: SqlStorage, key: SessionKey, start: number, index: ToolIndex[]): void {
  for (const r of index) sql.exec(`INSERT INTO ov_session_tool_results (${sessionColumns},id,seq,part_no,tool_name,sha256,chars)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT (${sessionColumns},id) DO NOTHING`, ...key, r.id, start + r.row + 1,
  r.part, r.name, r.hash, r.chars)
}

type ToolRow = { id: string, sha256: string, chars: number, part_no: number, payload: string }
const unit = 'unicode_code_point'

function metadata(key: SessionKey, row: ToolRow, msg: StoredMessage) {
  const part = msg.parts[row.part_no]
  if (part.type !== 'tool') throw new Error('Invalid tool index row.')
  return { tool_result_id: row.id, session_id: key[3], message_id: msg.id, tool_id: part.tool_id,
    tool_name: part.tool_name, user_id: key[1], peer_id: msg.peer_id ?? null, created_at: msg.created_at,
    original_chars: row.chars, preview_chars: row.chars, sha256: row.sha256,
    mime_type: 'text/plain', offset_unit: unit }
}

export function toolResults(sql: SqlStorage, key: SessionKey, url: URL, tail: string[]): Response {
  requireSession(sql, key)
  const scope = sessionWhere.replace(/\b(\w+) =/g, 't.$1 =')
  const join = `SELECT t.id,t.sha256,t.chars,t.part_no,m.payload FROM ov_session_tool_results t JOIN ov_session_messages m
    USING (${sessionColumns},seq) WHERE ${scope}`
  if (!tail.length) {
    const limit = queryInt(url, 'limit', 50, 1, 100)
    const name = url.searchParams.get('tool_name')
    if (name && name.length > 256) invalid('tool_name is too long.')
    const rows = sql.exec<ToolRow>(`${join}${name ? ' AND t.tool_name=?' : ''} ORDER BY t.seq DESC,t.part_no,t.id LIMIT ?`,
      ...key, ...(name ? [name] : []), limit)
    return ok({ tool_results: Array.from(rows, r => metadata(key, r, JSON.parse(r.payload))) })
  }
  const id = decodeSegment(tail[0])
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id)) invalid('Invalid tool_result_id.')
  const row = sql.exec<ToolRow>(`${join} AND t.id=?`, ...key, id).toArray()[0]
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Tool result not found.')
  const msg: StoredMessage = JSON.parse(row.payload)
  const part = msg.parts[row.part_no]
  const content = part.type === 'tool' ? part.tool_output! : ''
  const chars = Array.from(content)
  if (tail.length === 2) {
    const query = url.searchParams.get('q')
    if (!query || query.length > 1024 || /\p{Cs}/u.test(query)) invalid('q must be a nonempty bounded Unicode string.')
    const limit = queryInt(url, 'limit', 20, 1, 50)
    const context = queryInt(url, 'context_chars', 300, 0, 1000)
    const matches = []
    let start = 0, offset = 0
    const length = Array.from(query).length
    while (matches.length < limit) {
      const found = content.indexOf(query, start)
      if (found === -1) break
      offset += Array.from(content.slice(start, found)).length
      matches.push({ offset, offset_unit: unit, snippet: chars.slice(Math.max(0, offset - context), offset + length + context).join('') })
      start = found + query.length
      offset += length
    }
    return ok({ tool_result_id: id, matches })
  }
  const offset = queryInt(url, 'offset', 0), limit = queryInt(url, 'limit', 20_000, -1)
  const end = limit === -1 ? chars.length : Math.min(chars.length, offset + limit)
  return ok({ tool_result_id: id, content: chars.slice(offset, end).join(''), offset, limit,
    offset_unit: unit, total_chars: chars.length, has_more: end < chars.length,
    ...(queryBool(url, 'include_metadata', true) && { metadata: metadata(key, row, msg) }) })
}
