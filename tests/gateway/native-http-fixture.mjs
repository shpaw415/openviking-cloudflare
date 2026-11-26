// SPDX-License-Identifier: AGPL-3.0-only
const first = 'Marée 🌊', tail = ' en vue.', text = first + tail
const output = (text, status = 'completed') => ({ id: 'msg_fixture', type: 'message', role: 'assistant', status,
  content: [{ type: 'output_text', text, annotations: [] }] })
const typed = (name, data) => ({ type: name, ...data })
const resp = (output, status = 'completed') => ({ id: 'resp_fixture', object: 'response', status, output,
  usage: { input_tokens: 13, output_tokens: 7 } })
const message = (content, stop_reason = 'end_turn') => ({ id: 'msg_fixture', type: 'message', role: 'assistant', content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 17, output_tokens: 5 } })
const call = { id: 'fc_fixture', type: 'function_call', status: 'completed', call_id: 'call_fixture', name: 'lookup_marker', arguments: '{"marker":"dock"}' }
const use = { id: 'call_fixture', type: 'tool_use', name: 'lookup_marker', input: { marker: 'dock' } }

function frames(openai, tool) {
  if (openai) {
    const location = { item_id: 'msg_fixture', output_index: 0, content_index: 0 }
    const start = [typed('response.created', { response: resp([], 'in_progress') }),
      typed('response.in_progress', { response: resp([], 'in_progress') }),
      typed('response.output_item.added', { output_index: 0, item: { ...output('', 'in_progress'), content: [] } }),
      typed('response.content_part.added', { ...location, part: output('').content[0] }),
      typed('response.output_text.delta', { ...location, delta: first })]
    const end = [typed('response.output_text.delta', { ...location, delta: tail }),
      typed('response.output_text.done', { ...location, text }),
      typed('response.content_part.done', { ...location, part: output(text).content[0] }),
      typed('response.output_item.done', { output_index: 0, item: output(text) })]
    const loc = { item_id: call.id, output_index: 1 }
    if (tool) end.push(typed('response.output_item.added', { output_index: 1, item: { ...call, status: 'in_progress', arguments: '' } }),
      typed('response.function_call_arguments.delta', { ...loc, delta: '{"marker":' }),
      typed('response.function_call_arguments.delta', { ...loc, delta: '"dock"}' }),
      typed('response.function_call_arguments.done', { ...loc, arguments: call.arguments }),
      typed('response.output_item.done', { output_index: 1, item: call }))
    end.push(typed('response.completed', { response: resp([output(text), ...(tool ? [call] : [])]) }))
    return [start, end].map((group, n) => group.map((value, i) => ({ ...value, sequence_number: i + n * start.length })))
  }
  const start = [typed('message_start', { message: { ...message([], null), usage: { input_tokens: 17, output_tokens: 1 } } }),
    typed('ping', {}), typed('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: first } })]
  const end = [typed('content_block_delta', { index: 0, delta: { type: 'text_delta', text: tail } }), typed('content_block_stop', { index: 0 })]
  if (tool) end.push(typed('content_block_start', { index: 1, content_block: { ...use, input: {} } }),
    typed('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"marker":' } }),
    typed('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"dock"}' } }),
    typed('content_block_stop', { index: 1 }))
  end.push(typed('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }),
    typed('message_stop', {}))
  return [start, end]
}

export class Provider {
  constructor(_state, env) { this.env = env; this.calls = []; this.gates = new Map() }
  async fetch(request) {
    const url = new URL(request.url), name = url.searchParams.get('name')
    if (url.origin === 'https://native-control.test') {
      if (url.pathname === '/calls') return Response.json(this.calls)
      const gate = this.gates.get(name)
      if (!gate) return new Response(null, { status: 404 })
      if (url.pathname === '/release' && request.method === 'POST') gate.release()
      return Response.json({ released: gate.released, tail: gate.tail, cancelled: gate.cancelled })
    }
    const openai = url.origin === 'https://api.openai.com', anthropic = url.origin === 'https://api.anthropic.com'
    const valid = request.method === 'POST' && ((openai && url.pathname === '/v1/responses') ||
      (anthropic && url.pathname === '/v1/messages') || (openai && url.pathname === '/v1/chat/completions'))
    const h = request.headers
    const authority = openai ? h.get('authorization') === `Bearer ${this.env.OPENAI}` && !h.has('x-api-key') && !h.has('anthropic-version') :
      h.get('x-api-key') === this.env.ANTHROPIC && !h.has('authorization') && h.get('anthropic-version') === '2023-06-01'
    const contentType = h.get('content-type'), accept = h.get('accept')
    const forwarded = [...h.keys()].filter(name => /^x-/.test(name) && name !== 'x-api-key' || ['cookie', 'anthropic-beta', 'openai-organization', 'openai-project'].includes(name))
    const body = request.method === 'POST' ? await request.json() : null
    this.calls.push({ url: url.href, valid, authority, contentType, accept, forwarded, body })
    if (!valid || !authority || contentType !== 'application/json' || forwarded.length) return new Response(null, { status: 591 })
    if (url.pathname === '/v1/chat/completions') return Response.json({ choices: [{ message: { role: 'assistant', content: 'Chat inchangé.' } }] })
    const wire = JSON.stringify(body), tool = !!body.tools?.length && !wire.includes('Client figure'), mode = /fixture-(held|eof|error|redirect|length|amend|secret)/.exec(wire)?.[1]
    if (mode === 'redirect') return new Response('fixture private error', { status: 302, headers: { location: 'https://unexpected.test/private' } })
    if (!body.stream) {
      const reply = openai ? resp(tool ? [call] : [output(text)]) : message(tool ? [use] : [{ type: 'text', text }], tool ? 'tool_use' : 'end_turn')
      if (mode === 'length') {
        if (openai) Object.assign(reply, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [output(text, 'incomplete')] })
        else reply.stop_reason = 'max_tokens'
      }
      if (mode === 'secret') {
        if (openai) reply.output[0].content[0].text = this.env.OPENAI
        else reply.content[0].text = this.env.ANTHROPIC
      }
      return Response.json(reply, { headers: { 'x-fixture-output': 'not forwarded' } })
    }
    const [start, end] = frames(openai, tool)
    const sse = values => new TextEncoder().encode(values.map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(''))
    const bytes = sse(start), offset = bytes.indexOf(0xf0) + 2
    const gate = { released: mode !== 'held', tail: false, cancelled: false, release: () => {} }
    const wait = gate.released ? Promise.resolve() : new Promise(resolve => { gate.release = () => { gate.released = true; resolve() } })
    this.gates.set(body.instructions === 'hold-openai' ? 'responses' : 'messages', gate)
    let step = 0
    return new Response(new ReadableStream({
      async pull(controller) {
        if (step++ === 0) return controller.enqueue(bytes.slice(0, offset))
        if (step === 2) return controller.enqueue(bytes.slice(offset))
        await wait
        if (gate.cancelled) return
        gate.tail = true
        if (mode === 'error') controller.enqueue(sse([typed(openai ? 'response.failed' : 'error', { diagnostic: 'fixture private error' })]))
        else if (mode === 'amend' && openai) {
          end.at(-1).response.output[0].content[0].text = 'different summary'; controller.enqueue(sse(end))
        } else if (mode !== 'eof') controller.enqueue(sse(end))
        controller.close()
      },
      cancel() { gate.cancelled = true; if (!gate.released) { gate.release(); gate.released = false } },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'x-fixture-output': 'not forwarded' } })
  }
}

export default { fetch: (request, env) => env.PROVIDER.get(env.PROVIDER.idFromName('only')).fetch(request) }
