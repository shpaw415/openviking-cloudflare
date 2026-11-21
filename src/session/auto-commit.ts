// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { currentFlight, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { sha256 } from './generation.js'
import { autoState } from './auto-policy.js'
import { getSession, pendingTokens } from './store.js'
import type { SessionRow } from './store.js'

export function autoDecision(sql: SqlStorage, key: SessionKey, row: SessionRow) {
  const { policy, revision, last } = autoState(sql, key)
  if (!policy || row.message_count <= policy.keep_recent_count || row.message_count <= row.keep_recent_count) return
  if (last && Date.now() - Date.parse(last) < policy.min_commit_interval_seconds * 1000) return
  const count = policy.message_count_threshold > 0 && row.message_count > policy.message_count_threshold
  const tokens = policy.pending_token_threshold > 0 && pendingTokens(sql, key, row) > policy.pending_token_threshold
  if (!count && !tokens) return
  const first = sql.exec<{ id: string }>(`SELECT json_extract(payload,'$.id') AS id FROM ov_session_messages
    WHERE ${sessionWhere} AND seq=?`, ...key, row.total_message_count - row.message_count + 1).toArray()[0]?.id
  if (!first) return
  // Appends do not invalidate this rotation's decision. A reset, new first
  // message, policy replacement/disable, or delete/recreate invalidates it.
  return { keep: policy.keep_recent_count, anchor: JSON.stringify([row.created_at, row.commit_count, first, revision]) }
}

export async function maybeQueueAuto(ctx: WorkspaceContext, key: SessionKey): Promise<void> {
  if (!ctx.jobs) return
  try {
    const row = getSession(ctx.sql, key)
    if (!row || currentFlight(ctx, key)) return
    const decision = autoDecision(ctx.sql, key, row)
    if (!decision) return
    const pending = ctx.sql.exec<{ task_id: string | null }>(`SELECT task_id FROM ov_session_semantic_archives
      WHERE ${sessionWhere} AND status='pending' LIMIT 8`, ...key).toArray()
    if (pending.some(row => row.task_id && ['pending', 'running', 'cancelling'].includes(ctx.jobs!.get(row.task_id)?.status ?? ''))) return
    // Bound repeat submissions during a burst; allow retry on a later write
    // after transient admission/provider failure rather than polling forever.
    const digest = await sha256(JSON.stringify([key[3], decision.anchor, Math.floor(Date.now() / 30_000)]))
    await ctx.reauthorize?.()
    await ctx.jobs.enqueue('session_commit', key[3], { session_id: key[3], op: 'auto', body: {}, anchor: decision.anchor },
      { idempotencyKey: `auto:${digest}`, meta: { session_id: key[3], trigger: 'message_write' } })
  } catch {
    // As upstream, a scheduler failure cannot turn an already durable append
    // into a failed append, and must not create a fabricated task response.
  }
}
