// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { build } from 'esbuild'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('f4-operator', 'root', 'root')
const alice = testPrincipal('f4-gallery', 'alice')
const bob = testPrincipal(alice.accountId, 'bob', 'admin')
const otherAgent = testPrincipal(alice.accountId, alice.userId, 'user', 'other-agent')
const otherAccount = testPrincipal('f4-other-gallery', alice.userId)
const base = 'https://gallery.fixture.test/v1', model = 'fixture-f4-gallery'
const modelKey = randomBytes(24).toString('hex')
const chat = '/gateway/v1/chat/completions', responses = '/gateway/api/v3/responses', messages = '/gateway/api/compatible/v1/messages'
const tickets = '/gateway/transfers/tickets'
// A 2×1 grayscale PNG generated from two synthetic samples with checked CRCs.
const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 0, 0, 0, 0])
function chunk(tag, data) {
  const content = Buffer.concat([Buffer.from(tag), data]), out = Buffer.alloc(content.length + 8)
  out.writeUInt32BE(data.length)
  content.copy(out, 4)
  out.writeUInt32BE(crc32(content), out.length - 4)
  return out
}
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.from([0, 96, 144]))), chunk('IEND', Buffer.alloc(0))])
const post = (send, path, body) => send(path, { method: 'POST', body })

async function checked(response, status = 200, reason) {
  const reply = await response
  const payload = await reply.json()
  assert.equal(reply.status, status, payload.reason ?? payload.error?.code)
  if (reason) assert.equal(payload.reason ?? payload.error?.code, reason)
  return payload.result ?? payload
}

const rich = (attachment, stream = false) => ({ model, stream,
  messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: attachment } }] }] })
const sse = delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\n\n`
const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const deltaFrames = value => value.split('\n\n').flatMap(frame => /^data: \{/.test(frame) ?
  [JSON.parse(frame.slice(6)).choices?.[0]?.delta?.content].filter(Boolean) : [])

async function fixture(t) {
  const calls = [], textLatch = Promise.withResolvers(), pending = Promise.withResolvers()
  const runtime = await localWorker({ principals: [root, alice, bob, otherAgent, otherAccount], vars: {
    OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: randomBytes(32).toString('hex'),
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: modelKey }]), OPENVIKING_EDGE_OPERATOR_STREAMING: '1',
    OPENVIKING_EDGE_GATEWAY_CAPABILITIES: JSON.stringify([{ api_base: base, model, capabilities: ['image'] }]),
  }, async outboundService(req) {
    assert.equal(req.url, `${base}/chat/completions`)
    assert.equal(req.headers.get('authorization') === `Bearer ${modelKey}`, true)
    assert.equal(req.headers.has('x-api-key'), false)
    const body = await req.json()
    calls.push(body)
    const text = body.messages[0].content
    if (body.stream) {
      const e = new TextEncoder(), held = text === 'Hold the approved text stream.'
      return new Response(new ReadableStream({ async start(out) {
        out.enqueue(e.encode(sse('Early ✓')))
        if (held) await textLatch.promise
        out.enqueue(e.encode(sse(' white') + finish))
        out.close()
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    if (Array.isArray(text) && text[0]?.text === 'Hold the multimedia response.') await pending.promise
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Gallery fixture' } }] })
  } })
  t.after(async () => { textLatch.resolve(); pending.resolve(); await runtime.dispose() })
  await checked(post(api(runtime, root), '/api/v1/admin/configuration/import', {
    vlm: { provider: 'openai-compatible', api_base: base, model, top_p: 0.45, max_concurrent: 1 },
  }))
  return { runtime, send: api(runtime, alice), calls, textLatch, pending }
}

async function upload(send, filename = 'gallery.png', bytes = png, content_type = 'image/png', retention_seconds = 60) {
  const ticket = await checked(post(send, tickets, { kind: 'attachment', action: 'upload', filename, content_type,
    size: bytes.length, retention_seconds, ticket_transport: 'header' }), 201)
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: content_type }), filename)
  const saved = await checked(send(ticket.url, { method: ticket.method, headers: { [ticket.ticket_header]: ticket.ticket }, body: form }))
  assert.equal(saved.attachment_id, ticket.attachment_id)
  return saved
}

test('integrated F4 resolves real signed media bytes for the exact owner and only sends inline data', { timeout: 18000 }, async t => {
  const { runtime, send, calls } = await fixture(t)
  const { attachment_id: id } = await upload(send)
  for (const actor of [bob, otherAgent, otherAccount]) {
    await checked(post(api(runtime, actor), chat, rich(id)), 404, 'attachment_unavailable')
  }
  await checked(post(api(runtime, root), chat, rich(id)), 403)
  assert.equal(calls.length, 0)
  await checked(post(send, chat, rich(id)))
  await checked(post(send, responses, { model, input: [{ role: 'user', content: [{ type: 'input_image', file_id: id }] }] }))
  await checked(post(send, messages, { model, max_tokens: 32, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'file', file_id: id } },
  ] }] }))
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.top_p, 0.45)
    const url = call.messages[0].content[0].image_url.url
    assert.equal(url, `data:image/png;base64,${png.toString('base64')}`)
    assert.equal(JSON.stringify(call).includes(id), false)
    assert.equal(JSON.stringify(call).includes('gallery.png'), false)
  }
  const zip = await upload(send, 'archive.zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), 'application/zip')
  await checked(post(send, chat, rich(zip.attachment_id)), 501, 'non_text_input_unsupported')
  assert.equal(calls.length, 3)
})

test('integrated F4 shares provider concurrency with text and preserves safe SSE frame boundaries', { timeout: 15000 }, async t => {
  const { send, calls, textLatch } = await fixture(t)
  const { attachment_id: id } = await upload(send)
  const text = await post(send, chat, { model, stream: true, messages: [{ role: 'user', content: 'Hold the approved text stream.' }] })
  assert.equal(text.status, 200)
  const reader = text.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let output = ''
  while (!output.includes('Early ✓')) {
    const part = await reader.read()
    assert.equal(part.done, false)
    output += decoder.decode(part.value, { stream: true })
  }
  assert.deepEqual(deltaFrames(output), ['Early ✓'])
  await checked(post(send, chat, rich(id)), 429, 'rate_limited')
  assert.equal(calls.length, 1)
  textLatch.resolve()
  for (;;) {
    const part = await reader.read()
    output += decoder.decode(part.value, { stream: !part.done })
    if (part.done) break
  }
  assert.deepEqual(deltaFrames(output), ['Early ✓', ' white'])
  assert.match(output, /data: \[DONE\]\n\n$/u)
  const next = await post(send, chat, rich(id, true))
  assert.equal(next.status, 200)
  assert.deepEqual(deltaFrames(await next.text()), ['Early ✓', ' white'])
  assert.equal(calls.length, 2)
})

test('integrated F4 attachment expiry fences a pending reply and prevents another provider call', { timeout: 12000 }, async t => {
  const { send, calls, pending } = await fixture(t)
  const saved = await upload(send, 'gallery.png', png, 'image/png', 3)
  const input = rich(saved.attachment_id)
  input.messages[0].content.unshift({ type: 'text', text: 'Hold the multimedia response.' })
  const request = post(send, chat, input)
  for (let i = 0; !calls.length && i < 40; i++) await delay(25)
  assert.equal(calls.length, 1)
  assert.ok(Date.parse(saved.expires_at) > Date.now())
  await delay(Math.max(0, Date.parse(saved.expires_at) - Date.now()) + 50)
  pending.resolve()
  await checked(request, 409, 'attachment_changed')
  await checked(post(send, chat, rich(saved.attachment_id)), 404, 'attachment_unavailable')
  assert.equal(calls.length, 1)
})

test('frame release uses public text boundaries and fixed lookahead, independent of the provider credential', async () => {
  const { outputFiles } = await build({ entryPoints: ['src/gateway/sse-source.ts'], bundle: true, write: false,
    format: 'esm', platform: 'node' })
  const { protectStreamText } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
  const marker = 'ed73-fixture-sentinel'
  for (const synthetic of [marker, 'sample-fixture-authentication-value']) {
    const clear = protectStreamText(synthetic)
    assert.deepEqual(clear('Opening ✓'), ['Opening ✓'])
    assert.deepEqual(clear(' one'), [])
    assert.deepEqual(clear(' two'), [' one'])
    assert.deepEqual(clear('!'), [' two', '!'])
    assert.deepEqual(clear(' at the end: e'), [])
    assert.deepEqual(clear('', true), [' at the end: e'])
    const run = protectStreamText(synthetic)
    assert.deepEqual(run('a'), [])
    assert.deepEqual(run('x'.repeat(2046)), [])
    assert.deepEqual(run('x'), ['a'])
  }
  const blocked = protectStreamText(marker)
  assert.deepEqual(blocked('Opening ✓'), ['Opening ✓'])
  assert.deepEqual(blocked(` blurb ${marker.slice(0, 5)}`), [])
  assert.throws(() => blocked(marker.slice(5)), { code: 'upstream_error' })
  assert.throws(() => blocked('', true), { code: 'upstream_error' })
})
