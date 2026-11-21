// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { keyFor } from './session/flight.js'
import { messageText } from './session/protocol.js'
import { sessionContext, sessionId } from './session/store.js'

// Use the authoritative session read, including its calling identity and no auto-creation.
// Only the user's text, not tool output or referenced files, augments a query.
export function retrievalContext(ctx:WorkspaceContext,id:string) {
  const current=sessionContext(ctx,keyFor(ctx,sessionId(id)),256,8192)
  const messages=current.messages.filter(m=>m.role==='user').slice(-4)
    .map(m=>messageText(m).trim().slice(0,256)).filter(Boolean)
  return {text:messages.join('\n').slice(0,1024),usedMessages:messages.length}
}
