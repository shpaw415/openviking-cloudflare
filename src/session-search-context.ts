// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { searchSessionLimits } from './model-config.js'
import { keyFor } from './session/flight.js'
import { messageText } from './session/protocol.js'
import { sessionContext, sessionId } from './session/store.js'

// Use the authoritative session read, including its calling identity and no auto-creation.
// Only the user's text, not tool output or referenced files, augments a query.
export function retrievalContext(ctx:WorkspaceContext,id:string) {
  const current=sessionContext(ctx,keyFor(ctx,sessionId(id)),256,8192)
  const take = ctx.retrievalSettings?.session_context_messages ?? searchSessionLimits.messages
  const cap = ctx.retrievalSettings?.session_context_chars
  const messages = current.messages.filter(m => m.role === 'user').slice(-take).map(m => messageText(m).trim()).filter(Boolean)
  const prefix = (text: string, max: number) => text.slice(0, (text.charCodeAt(max) & 0xfc00) === 0xdc00 ? max - 1 : max)
  if (cap === undefined) {
    const text = messages.map(message => prefix(message, searchSessionLimits.perMessageChars)).join('\n')
    return { text: prefix(text, searchSessionLimits.chars), usedMessages: messages.length }
  }
  let room = cap
  const recent: string[] = []
  for (const message of messages.reverse()) {
    if (room <= 0) break
    const text = prefix(message, Math.min(room, searchSessionLimits.perMessageChars)).trim()
    if (!text) continue
    recent.push(text)
    room -= text.length + 1
  }
  return { text: recent.reverse().join('\n'), usedMessages: recent.length }
}
