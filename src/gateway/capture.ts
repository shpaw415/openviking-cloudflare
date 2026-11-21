// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { commitArchive, commitAnchor } from '../session/archives.js'
import { assertIdle, keyFor } from '../session/flight.js'
import { commitOptions, encodeMessages, memoryPolicy } from '../session/protocol.js'
import { appendRows, getSession, insertSession, requireSession } from '../session/store.js'
import { GatewayError } from './contract.js'
import type { Protocol } from './contract.js'
import type { Profile } from './profiles.js'
import { checkConversationLimit, conversation, saveConversation } from './store.js'
import type { Metrics } from './store.js'

type Turn = { protocol: Protocol; name: string | null; user: string; assistant: string; recallCost: number }

export async function publishTurn(ctx: WorkspaceContext, profile: Profile, turn: Turn, metrics: Metrics, guard: () => void): Promise<string> {
  const { sql, storage } = ctx
  const before = turn.name ? conversation(ctx, turn.protocol, turn.name) : undefined
  const conversationId = before?.conversation ?? crypto.randomUUID()
  metrics.session = conversationId
  const storeState = (session_id: string | null) => {
    if (!turn.name) return
    if (!before) checkConversationLimit(ctx)
    saveConversation(ctx, turn.protocol, turn.name, { conversation: conversationId, session_id,
      recall_spent: (before?.recall_spent ?? 0) + turn.recallCost })
  }
  if (!profile.capture) {
    if (turn.name && (before || profile.recall || profile.profile)) storage.transactionSync(() => { guard(); storeState(before?.session_id ?? null) })
    metrics.capture_status = 'disabled'
    return 'disabled'
  }
  let candidate = before?.session_id
  const capturePolicy = memoryPolicy({ memory_types: profile.capture_memory_types })
  // Never use a retained session with a different extraction policy. A policy
  // narrowing must also stop extracting from later Gateway turns.
  if (!candidate || getSession(sql, keyFor(ctx, candidate))?.memory_policy !== capturePolicy) candidate = `gw-${crypto.randomUUID()}`
  const sessionId = candidate, key = keyFor(ctx, sessionId)
  let archiveAnchor: string | undefined
  try {
    const messages = encodeMessages({ messages: [{ role: 'user', content: turn.user }, { role: 'assistant', content: turn.assistant }] }, true, ctx.caller.userId)
    archiveAnchor = storage.transactionSync(() => {
      guard()
      assertIdle(ctx, key)
      if (!getSession(sql, key)) insertSession(sql, key, new Date().toISOString(), capturePolicy)
      const appended = appendRows(sql, key, messages, true)
      storeState(sessionId)
      const now = requireSession(sql, key)
      return now.message_count > profile.keep_recent_messages && appended.pending_tokens >= profile.commit_tokens
        ? commitAnchor(sql, key, now) : undefined
    })
  } catch (error) {
    if (error instanceof GatewayError) throw error
    metrics.capture_status = 'failed'
    metrics.capture_reason = error instanceof ApiError && error.status === 413 ? 'capture_limit' : 'save_failed'
    return 'failed'
  }
  metrics.capture_status = 'active'
  metrics.capture_messages = 2
  metrics.openviking_session = sessionId
  if (!archiveAnchor) return 'saved'
  try {
    const scoped: WorkspaceContext = { ...ctx, assertActive: guard }
    const result = await commitArchive(scoped, key, commitOptions({ keep_recent_count: profile.keep_recent_messages, enable_working_memory: false }), archiveAnchor)
    return result.archived ? 'archived' : 'saved'
  } catch {
    // The pair was durably written. Do not report archival or extraction as completed.
    metrics.degradation = 'archive_failed'
    metrics.capture_reason = 'archive_failed'
    return 'saved_archive_failed'
  }
}
