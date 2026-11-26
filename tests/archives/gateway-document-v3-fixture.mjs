// SPDX-License-Identifier: AGPL-3.0-only
import worker, { Workspace as ProductWorkspace } from '../../src/worker.ts'
export { Control, InstanceBackupOperator } from '../../src/worker.ts'

const model = 'fixture-document', openai = 'https://api.openai.com/v1', anthropic = 'https://api.anthropic.com/v1'
const extras = {
  OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: FIXTURE_TRANSFER_SECRET,
  OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: openai, api_key: FIXTURE_OPENAI }, { api_base: anthropic, api_key: FIXTURE_ANTHROPIC }]),
  OPENVIKING_EDGE_GATEWAY_NATIVE: JSON.stringify([[openai, 'responses'], [anthropic, 'anthropic']].map(([api_base, protocol]) =>
    ({ api_base, protocol, model, capabilities: ['document'] }))),
}

// Only the isolated test bundle contains this synthetic provider. Workerd's
// external service is still deny, and seccomp still denies all IP sockets.
globalThis.fetch = async (url, init) => {
  const responses = url === `${openai}/responses`
  if (!responses && url !== `${anthropic}/messages` || init.method !== 'POST' || init.redirect !== 'manual') throw new Error('Unexpected fixture outbound')
  const h = new Headers(init.headers)
  if (responses ? h.get('authorization') !== `Bearer ${FIXTURE_OPENAI}` || h.has('x-api-key') :
    h.get('x-api-key') !== FIXTURE_ANTHROPIC || h.has('authorization') || h.get('anthropic-version') !== '2023-06-01') throw new Error('Wrong fixture authorization')
  const body = JSON.parse(init.body), [row, ...extraRows] = responses ? body.input : body.messages
  const [block, ...extraBlocks] = row.content
  if (body.model !== model || body.stream !== false || row.role !== 'user' || extraRows.length || extraBlocks.length ||
      /att_[a-f0-9]{32}/.test(init.body)) throw new Error('Unexpected provider DTO')
  let bytes
  if (responses) {
    if (body.store !== false || block.type !== 'input_file' || block.filename !== 'buoy.txt' || !block.file_data.startsWith('data:text/plain;base64,')) throw new Error('Wrong Responses file')
    bytes = Uint8Array.from(atob(block.file_data.slice('data:text/plain;base64,'.length)), c => c.charCodeAt(0))
  } else {
    if (block.type !== 'document' || block.title !== 'buoy.txt' || block.source.type !== 'text' || block.source.media_type !== 'text/plain') throw new Error('Wrong Messages document')
    bytes = new TextEncoder().encode(block.source.data)
  }
  const text = `SHA256 ${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')}.`
  return Response.json(responses ? { object: 'response', status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
  ] } : { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] })
}

export class Workspace extends ProductWorkspace {
  constructor(state, env) { super(state, { ...env, ...extras }) }
}

export default { async fetch(request, env, execution) {
  // The inherited Unix harness accepts JSON only. For the one upload route,
  // unwrap the exact client-serialized multipart bytes, keeping origin, URL,
  // signed ticket, auth and method. Production still parses the real multipart.
  if (request.method === 'POST' && new URL(request.url).pathname === '/gateway/uploads' && request.headers.get('content-type') === 'application/json') {
    const { contentType, data } = await request.json()
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0)), headers = new Headers(request.headers)
    headers.set('content-type', contentType)
    headers.set('content-length', String(bytes.length))
    request = new Request(request.url, { method: 'POST', headers, body: bytes })
  }
  return worker.fetch(request, { ...env, ...extras }, execution)
} }
