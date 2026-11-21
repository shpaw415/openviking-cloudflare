// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { pathFor } from '../fs/contract.js'
import { Filesystem } from '../fs/store.js'
import { sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { invalid } from './protocol.js'
import { extractionCount, requireSession } from './store.js'

export function sessionStats(sql: SqlStorage, key: SessionKey) {
  requireSession(sql, key)
  const { n } = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ov_session_messages m WHERE ${sessionWhere}
    AND (json_extract(payload,'$.message_kind')='user_query' OR (
      json_extract(payload,'$.role')='user' AND COALESCE(json_extract(payload,'$.message_kind'),'')!='tool_transport'
      AND (json_array_length(payload,'$.parts')=0 OR EXISTS (SELECT 1 FROM json_each(m.payload,'$.parts') p
        WHERE json_extract(p.value,'$.type')!='tool'))))`, ...key).one()
  return { session_id: key[3], total_turns: n, memories_extracted: extractionCount(sql, key) }
}

const categories = ['profile', 'preferences', 'entities', 'events', 'cases', 'patterns', 'tools', 'skills']

export function memoryStats(ctx: WorkspaceContext, category: string | null) {
  if (category && !categories.includes(category)) invalid('Unknown memory category.')
  const selected = category ? [category] : categories
  const by_category = Object.fromEntries(selected.map(cat => [cat, 0]))
  const root = pathFor('viking://~/memories', ctx.caller)
  const fs = new Filesystem(ctx)
  const now = Date.now()
  let total = 0, oldest = 0, untouched7 = 0, untouched30 = 0
  for (const entry of fs.entries(root)) {
    if (entry.is_dir || !entry.dimensions) continue
    const cat = entry.uri.slice(root.uri.length + 1).split('/')[0].replace(/\.md$/, '')
    if (!selected.includes(cat)) continue
    by_category[cat]++
    total++
    const age = (now - entry.updated_at) / 86_400_000
    if (age > 7) untouched7++
    if (age > 30) untouched30++
    oldest = Math.max(oldest, (now - entry.created_at) / 86_400_000)
  }
  // FS exposes write dates but does not track retrieval counts/last access.
  // An unavailable histogram is not reported as an empty one.
  return { total_memories: total, by_category, hotness_distribution: null,
    staleness: { not_accessed_7d: null, not_accessed_30d: null, oldest_memory_age_days: Math.round(oldest * 10) / 10,
      not_updated_7d: untouched7, not_updated_30d: untouched30 } }
}
