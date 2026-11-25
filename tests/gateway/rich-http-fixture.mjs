// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'

const permitted = new Set(['https://rich.fixture.test/v1/chat/completions', 'https://other.fixture.test/v1/chat/completions'])
const encoder = new TextEncoder()
const fn = (args = '{"place":"wharf","counts":[2,3]}', name = 'fixture_tide') => ({ id: 'call_fixture_tide', type: 'function',
  function: { name, arguments: args } })
const json = (content, finish_reason = 'stop', tool_calls) => Response.json({
  choices: [{ index: 0, finish_reason, message: { role: 'assistant', content, tool_calls } }],
  usage: { prompt_tokens: 12, completion_tokens: 6 },
}, { headers: { 'x-origin-marker': 'fixture-only' } })
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`
const terminal = 'data: [DONE]\r\n\r\n'

export class Provider extends DurableObject {
  calls = []
  holds = new Map()

  async fetch(request) {
    const url = new URL(request.url)
    if (url.origin === 'https://rich-control.invalid') {
      if (url.pathname === '/calls' && request.method === 'GET') return Response.json(this.calls)
      const state = this.holds.get(url.searchParams.get('name'))
      if (!state) return Response.json(null)
      if (url.pathname === '/release' && request.method === 'POST') { state.released = true; state.wake() }
      return Response.json({ released: state.released, tail: state.tail, cancelled: state.cancelled })
    }
    if (!permitted.has(request.url) || request.method !== 'POST') {
      this.calls.push({ unexpected: request.url })
      return new Response(null, { status: 599 })
    }
    const body = await request.json()
    const accepted = request.headers.get('authorization') === `Bearer ${this.env.PROVIDER_TEST_KEY}`
    this.calls.push({ url: request.url, body, accepted, accept: request.headers.get('accept'),
      forwarded: request.headers.has('x-api-key') || request.headers.has('x-only-client') || request.headers.has('x-openviking-session') })
    if (!accepted || body.model !== 'fixture-vision-audio') return new Response(null, { status: 403 })
    const user = body.messages.findLast(message => message.role === 'user')
    const prompt = typeof user.content === 'string' ? user.content : user.content.find(part => part.type === 'text')?.text ?? ''
    if (prompt === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://never.fixture.test/v1/chat/completions' } })
    const last = body.messages.at(-1)
    if (last.role === 'tool' && last.tool_call_id === 'call_fixture_tide' && last.content === 'watermark 17 cm') {
      if (!body.stream) return json('From the client measurement: 17 cm.')
      return this.stream([event({ content: 'From the client measurement: 17 cm.' }, 'stop'), terminal])
    }
    if (prompt === 'bad typed output' || prompt === 'secret arguments') {
      const reply = fn(prompt === 'bad typed output' ? '{"place":19}' : JSON.stringify({ place: this.env.PROVIDER_TEST_KEY, counts: [] }))
      if (!body.stream) return json(null, 'tool_calls', [reply])
      const { id, type, function: spec } = reply, split = Math.floor(spec.arguments.length / 2)
      const first = event({ tool_calls: [{ index: 0, id, type, function: { name: spec.name, arguments: spec.arguments.slice(0, split) } }] })
      const last = event({ tool_calls: [{ index: 0, function: { arguments: spec.arguments.slice(split) } }] }, 'tool_calls')
      return this.stream([first, last, terminal])
    }
    if (prompt === 'secret text') {
      const mid = Math.floor(this.env.PROVIDER_TEST_KEY.length / 2)
      return this.stream([event({ content: 'Safe prefix ' }), event({ content: this.env.PROVIDER_TEST_KEY.slice(0, mid) }),
        event({ content: this.env.PROVIDER_TEST_KEY.slice(mid) }, 'stop'), terminal])
    }
    if (prompt.startsWith('held-json ')) {
      const state = this.hold(prompt)
      return new Response(new ReadableStream({
        async pull(controller) {
          await state.gate
          if (state.cancelled) return
          state.tail = true
          controller.enqueue(encoder.encode(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'late' } }] })))
          controller.close()
        }, cancel() { state.cancelled = true; state.wake() },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })
    }
    if (body.tools?.length) {
      if (!body.stream) return json(prompt === 'tool prose' ? 'Checking the fixture.' : null, 'tool_calls', [fn()])
      const chunks = [event({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_', type: 'function',
        function: { name: 'fixture_', arguments: '{"place":' } }] }),
      event({ tool_calls: [{ index: 0, id: 'tide', function: { name: 'tide', arguments: '"wharf","counts":[2,3]}' } }] }, 'tool_calls')]
      if (prompt.startsWith('held-prose ')) {
        return this.stream([event({ content: 'Marée 🌊' }), ...chunks, terminal], this.hold(prompt), 1)
      }
      if (prompt === 'missing DONE') return this.stream([...chunks])
      return this.stream([...chunks, terminal], this.hold(prompt), 2)
    }
    if (prompt.startsWith('held-media ')) return this.stream([event({ content: 'Marée 🌊' }), event({ content: ' haute' }, 'stop'), terminal], this.hold(prompt), 1)
    return json('Fixture received structured media.')
  }

  hold(name) {
    const state = { released: false, tail: false, cancelled: false }
    state.gate = new Promise(resolve => { state.wake = resolve })
    this.holds.set(name, state)
    return state
  }

  stream(chunks, state, holdIndex = 0) {
    const encoded = chunks.map(chunk => encoder.encode(chunk))
    // Split one transport chunk within the first emoji, not at a code point boundary.
    const offset = encoded[0]?.indexOf(0xf0) ?? -1
    if (offset >= 0) {
      const chunk = encoded[0]
      encoded.splice(0, 1, chunk.slice(0, offset + 1), chunk.slice(offset + 1))
      holdIndex++
    }
    let index = 0
    return new Response(new ReadableStream({
      async pull(controller) {
        if (state && index === holdIndex) {
          await state.gate
          if (state.cancelled) return
          state.tail = true
        }
        if (index >= encoded.length) { controller.close(); return }
        controller.enqueue(encoded[index++])
      }, cancel() { if (state) { state.cancelled = true; state.wake() } },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream', 'x-origin-marker': 'fixture-only' } })
  }
}

export default { fetch(request, env) { return env.PROVIDER.get(env.PROVIDER.idFromName('sole-private-fixture')).fetch(request) } }
