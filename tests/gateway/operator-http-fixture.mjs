// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'

const official = 'https://api.openai.com/v1'
const compatible = 'https://inference.example.test/v1'
const firstText = 'Marée 🌊'
const tailText = ' haute'
const enc = new TextEncoder()
const data = value => `data: ${JSON.stringify(value)}\r\n\r\n`
const choice = (delta, finish_reason = null) => data({ choices: [{ index: 0, delta, finish_reason }] })
const done = 'data: [DONE]\r\n\r\n'
const first = enc.encode(choice({ content: firstText }))
const split = first.indexOf(0xf0) + 2
const sse = body => new Response(body, { headers: { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-origin-marker': 'not forwarded' } })

// This DO only exists in the second, in-process Workerd service. The tested
// Worker makes real fetch() calls to its outbound service binding, never here
// via the public application router. The test controls the latch separately.
export class Provider extends DurableObject {
  calls = []
  turns = new Map()

  async fetch(request) {
    const url = new URL(request.url)
    if (url.origin === 'https://fixture-control.invalid') {
      if (url.pathname === '/calls') return Response.json(this.calls)
      const turn = this.turns.get(url.searchParams.get('name'))
      if (!turn) return new Response(null, { status: 404 })
      if (url.pathname === '/release' && request.method === 'POST') { turn.released = true; turn.release() }
      return Response.json({ released: turn.released, tail: turn.tail, cancelled: turn.cancelled })
    }

    const isOfficial = request.url === `${official}/chat/completions`
    const isCompatible = request.url === `${compatible}/chat/completions`
    const body = await request.json().catch(() => ({}))
    const accepted = (isOfficial || isCompatible) && request.method === 'POST' &&
      request.headers.get('authorization') === `Bearer ${isOfficial ? this.env.FIXTURE_OPENAI_KEY : this.env.FIXTURE_COMPATIBLE_KEY}`
    this.calls.push({ url: request.url, body, accepted, accept: request.headers.get('accept'),
      forwardedKey: request.headers.has('x-api-key'), forwardedOption: request.headers.has('x-fixture-client-only') })
    if (!accepted) return new Response(null, { status: 599 })
    const prompt = body.messages?.at(-1)?.content
    if (body.stream !== true) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Non-stream fixture.' } }] })
    if (prompt === 'redirect') return new Response(null, { status: 307, headers: { location: 'https://other.example.test/v1/chat/completions' } })
    if (prompt === 'json') return Response.json({ choices: [{ message: { role: 'assistant', content: 'Not SSE.' } }] })
    if (prompt === 'failed opening') return new Response('Private provider diagnostic.', { status: 400 })
    if (prompt === 'bad frame') return sse('data: non-json\n\n')
    if (prompt === 'eof') return sse(choice({ content: firstText }) + choice({}, 'stop'))
    if (prompt === 'sse error') return sse(choice({ content: firstText }) + data({ error: { message: 'Private provider diagnostic.' } }))
    if (prompt === 'wire limit') return sse(new ReadableStream({
      start(out) { out.enqueue(first); for (let i = 0; i < 5; i++) out.enqueue(enc.encode(`:${'x'.repeat(60_000)}\n\n`)); out.close() },
    }))
    if (prompt === 'length') return sse(choice({ content: firstText }) + choice({}, 'length') + done)

    let release
    const gate = new Promise(resolve => { release = resolve })
    const turn = { released: !prompt?.startsWith('held '), tail: false, cancelled: false, release }
    this.turns.set(prompt, turn)
    let i = 0
    return sse(new ReadableStream({
      async pull(out) {
        if (i === 0) { i++; out.enqueue(first.subarray(0, split)); return }
        if (i === 1) { i++; out.enqueue(first.subarray(split)); return }
        if (!turn.released) await gate
        if (turn.cancelled) return
        turn.tail = true
        out.enqueue(enc.encode(choice({ content: tailText }) + choice({}, 'stop') +
          (isOfficial ? data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }) : '') + done))
        out.close()
      },
      cancel() { turn.cancelled = true; release() },
    }, { highWaterMark: 0 }))
  }
}

export default { fetch(request, env) { return env.PROVIDER.getByName('single-test-operator').fetch(request) } }
