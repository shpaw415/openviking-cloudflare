// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { mountDataAuthority } from '../data-authority.js'
import { Filesystem } from '../fs/store.js'
import { GatewayError, bytes, unsupported } from './contract.js'
import { chatCall, toolOutputError } from './tool-dto.js'
import type { ToolRules } from './tool-dto.js'
import type { NativeInput } from './native-dto.js'
import type { RichReply } from './operator-rich.js'

export const localReadHeader = 'x-openviking-allow-read'
const name = 'openviking_read'
export const localReadUnavailable = () => unsupported('A local read requires an enabled native model and a direct Data credential.', 'local_tool_unsupported')
const denied = () => new GatewayError(404, 'local_tool_resource_unavailable', 'The consented text resource is not available to this request.')

export async function consentRead(ctx: WorkspaceContext, uri: string) {
  if (!ctx.loadDataAuthority) throw localReadUnavailable()
  // Canonical shared resource IDs only. No roots, directory listing, aliases, other scopes or schemes.
  if (!/^viking:\/\/resources\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(uri) || uri.length > 256) throw denied()
  const fs = new Filesystem(ctx)
  const path = (() => { try { return fs.path(uri) } catch { throw denied() } })()
  if (path.uri !== uri) throw denied()
  const authority = await mountDataAuthority(ctx)
  const entry = () => {
    authority.assertCurrent()
    try {
      const item = fs.require(path)
      if (item.is_dir || item.bytes > 8192) throw denied()
      return item
    } catch { throw denied() }
  }
  const revision = entry().revision
  const check = () => { if (entry().revision !== revision) throw denied() }
  const rules: ToolRules = { tools: [{ type: 'function', function: { name, description: 'Read the one text resource explicitly consented for this turn.',
    parameters: { type: 'object', properties: { uri: { type: 'string', enum: [uri] } }, required: ['uri'], additionalProperties: false }, strict: true } }],
    choice: { type: 'function', function: { name } }, parallel: false }
  return { check, rules, continue(input: NativeInput, reply: RichReply) {
    check()
    const [call] = reply.calls
    if (reply.finish !== 'tool_calls' || reply.calls.length !== 1 || call.name !== name || call.args.uri !== uri) throw toolOutputError()
    const result = fs.read(uri)
    if (bytes(result) > 8192) throw denied()
    const messages: NativeInput['messages'] = [...input.messages, { role: 'assistant', content: reply.text || null, tool_calls: [chatCall(call)] },
      { role: 'tool', tool_call_id: call.id, content: result }]
    return { ...input, messages, ids: new Set([call.id]), rules: { tools: rules.tools, choice: 'none' as const },
      inputBytes: bytes(JSON.stringify(messages)) } satisfies NativeInput
  } }
}
