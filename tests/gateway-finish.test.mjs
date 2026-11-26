// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const openai = 'https://api.openai.com/v1', anth = 'https://api.anthropic.com/v1'
const root = testPrincipal('operator', 'root', 'root'), admin = testPrincipal('finish', 'admin', 'admin')
const member = testPrincipal('finish', 'member'), other = testPrincipal('finish', 'neighbor')
const model = 'finish-model', capabilities = ['document', 'sampling', 'structured', 'local_read']
const uri = 'viking://resources/map.txt', info = 'Balise de synthèse 🌊', encoded = Buffer.from(info).toString('base64')
const native = [{ model, protocol: 'responses', api_base: openai, capabilities },
  { model, protocol: 'anthropic', api_base: anth, capabilities: [...capabilities, 'count_tokens', 'stop_sequences'] }]
const wav = Buffer.alloc(48)
wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40); wav.writeInt16LE(41, 44)
const wavData = wav.toString('base64')
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const call = (send, protocol, extra = {}, headers) => post(send, `/gateway/v1/${protocol}`, { model,
  ...(protocol === 'responses' ? { input: 'question' } : { messages: [{ role: 'user', content: 'question' }] }),
  ...(protocol === 'messages' && { max_tokens: 32 }), ...extra }, headers)
async function json(promise, status = 200, code) {
  const res = await promise, data = await res.json()
  assert.equal(res.status, status, JSON.stringify(data))
  if (code) assert.equal(data.reason ?? data.error?.code, code)
  return data.result ?? data
}
const result = (isOpen, text, stop) => isOpen ? { object: 'response', status: 'completed', output: [
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
] } : { type: 'message', role: 'assistant', stop_reason: stop ? 'stop_sequence' : 'end_turn', stop_sequence: stop ?? null,
  content: [{ type: 'text', text }] }

async function fixture(t, enabled = true) {
  const secrets = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')], calls = []
  let intercept
  const runtime = await localWorker({ principals: [root, admin, member, other], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_OPERATOR_STREAMING: '1',
      OPENVIKING_EDGE_GATEWAY_NATIVE: JSON.stringify(enabled ? native : native.map(entry => ({ ...entry, capabilities: [] }))),
      OPENVIKING_EDGE_GATEWAY_CAPABILITIES: JSON.stringify([{ api_base: openai, model, capabilities: enabled ? ['audio', 'audio_output'] : ['audio'] }]),
      OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: randomBytes(32).toString('hex'),
      OPENVIKING_EDGE_PROVIDERS: JSON.stringify([openai, anth].map((api_base, i) => ({ api_base, api_key: secrets[i] }))) },
    outboundService: async request => {
      const isOpen = request.url.startsWith(`${openai}/`), h = request.headers
      assert.ok([`${openai}/responses`, `${openai}/chat/completions`, `${anth}/messages`, `${anth}/messages/count_tokens`].includes(request.url))
      assert.equal(request.method, 'POST')
      if (isOpen) assert.equal(h.get('authorization'), `Bearer ${secrets[0]}`)
      else { assert.equal(h.get('x-api-key'), secrets[1]); assert.equal(h.get('anthropic-version'), '2023-06-01') }
      assert.equal(h.has('x-openviking-allow-read'), false)
      const body = await request.json()
      calls.push({ url: request.url, body })
      const response = await intercept?.(body, isOpen)
      if (response) return response
      if (request.url.endsWith('/count_tokens')) return Response.json({ input_tokens: 113 })
      if (body.audio) return Response.json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null,
        audio: { data: wavData, transcript: 'Bouée', id: 'audio_fixture', expires_at: 2000000000 } } }] })
      if (body.text || body.output_config) return Response.json(result(isOpen, JSON.stringify({ beacon: true })))
      return Response.json(result(isOpen, 'Réponse synthétique.', body.stop_sequences?.[0]))
    },
  })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  return { calls, send: api(runtime, member), admin: api(runtime, admin), other: api(runtime, other), root: api(runtime, root),
    setIntercept: f => { intercept = f } }
}

test('private and inline UTF-8 documents reach both fixed native DTOs by bytes; non-owner cannot send them', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  const ticket = await json(post(f.send, '/gateway/transfers/tickets', { action: 'upload', kind: 'attachment', ticket_transport: 'header',
    filename: 'map.txt', content_type: 'text/plain', size: Buffer.byteLength(info) }), 201)
  const form = new FormData()
  form.set('file', new Blob([info], { type: 'text/plain' }), 'map.txt')
  const upload = await json(f.send(ticket.url, { method: ticket.method, headers: { [ticket.ticket_header]: ticket.ticket }, body: form }))
  const id = upload.attachment_id
  const doc = (send, p, part) => call(send, p, { [p === 'responses' ? 'input' : 'messages']: [{ role: 'user', content: [part] }] })
  for (const [p, inline, ref] of [
    ['responses', { type: 'input_file', filename: 'map.txt', file_data: encoded }, { type: 'input_file', file_id: id }],
    ['messages', { type: 'document', title: 'map.txt', source: { type: 'base64', media_type: 'text/plain', data: encoded } },
      { type: 'document', source: { type: 'file', file_id: id } }],
  ]) {
    await json(doc(f.send, p, inline)); await json(doc(f.send, p, ref)); await json(doc(f.other, p, ref), 404, 'attachment_unavailable')
  }
  const block = (call, p) => call.body[p][0].content[0]
  for (const row of f.calls.slice(0, 2)) assert.deepEqual(block(row, 'input'), { type: 'input_file', filename: 'map.txt', file_data: `data:text/plain;base64,${encoded}` })
  for (const row of f.calls.slice(2)) assert.deepEqual(block(row, 'messages'), { type: 'document', title: 'map.txt', source: { type: 'text', media_type: 'text/plain', data: info } })
  assert.equal(f.calls.length, 4)
  assert.ok(f.calls.every(row => !JSON.stringify(row).includes(id)))
  assert.deepEqual(await json(f.send('/api/v1/sessions')), [])
})

test('opt-in sampling, exact native count, matched stop and schema-checked JSON have wire effects and typed refusals', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  const schema = { type: 'object', properties: { beacon: { type: 'boolean' } }, required: ['beacon'], additionalProperties: false }
  const text = { format: { type: 'json_schema', name: 'map', schema, strict: true } }
  const output_config = { format: { type: 'json_schema', schema } }
  const out = await json(call(f.send, 'responses', { temperature: 0.5, top_p: 0.9, text }))
  assert.equal(out.output[0].content[0].text, '{"beacon":true}')
  assert.deepEqual(f.calls[0].body.text, text)
  assert.deepEqual([f.calls[0].body.temperature, f.calls[0].body.top_p, f.calls[0].body.store], [0.5, 0.9, false])
  assert.equal((await json(call(f.send, 'messages', { output_config }))).content[0].text, '{"beacon":true}')
  assert.deepEqual(f.calls[1].body.output_config, output_config)
  const stopped = await json(call(f.send, 'messages', { top_p: 0.4, stop_sequences: ['FIN'] }))
  assert.deepEqual([stopped.stop_reason, stopped.stop_sequence, f.calls[2].body.top_p, f.calls[2].body.stop_sequences], ['stop_sequence', 'FIN', 0.4, ['FIN']])
  assert.deepEqual(await json(call(f.send, 'messages/count_tokens', { system: 'instruction' })), { input_tokens: 113 })
  assert.deepEqual(f.calls[3], { url: `${anth}/messages/count_tokens`, body: { model, system: [{ type: 'text', text: 'instruction' }], messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
  ] } })
  await json(call(f.send, 'responses', { text, stream: true }), 501, 'native_option_unsupported')
  await json(call(f.send, 'messages', { temperature: 0.5, top_p: 0.2 }), 400, 'native_option_invalid')
  assert.equal(f.calls.length, 4)
  f.setIntercept((_body, isOpen) => Response.json(result(isOpen, '{"beacon":"not a boolean"}')))
  await json(call(f.send, 'responses', { text }), 502, 'upstream_error')
  f.setIntercept(() => Response.json(result(false, 'no', 'UNREQUESTED')))
  await json(call(f.send, 'messages', { stop_sequences: ['FIN'] }), 502, 'upstream_error')
})

test('Chat audio is opt-in, emits the received WAV bytes and transcript, without retaining the turn', { timeout: 10000 }, async t => {
  const f = await fixture(t)
  await json(post(f.root, '/api/v1/admin/configuration/import', { vlm: { provider: 'openai', model } }))
  const body = { model, modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' },
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { format: 'wav', data: wavData } }] }] }
  const run = more => post(f.send, '/gateway/v1/chat/completions', { ...body, ...more })
  const output = (await json(run())).choices[0].message.audio
  assert.deepEqual(Buffer.from(output.data, 'base64'), wav)
  assert.equal(output.transcript, 'Bouée'); assert.notEqual(output.id, 'audio_fixture')
  assert.deepEqual(f.calls[0].body.audio, body.audio)
  assert.deepEqual(f.calls[0].body.messages, body.messages)
  await json(run({ stream: true }), 501, 'audio_output_unsupported')
  assert.equal(f.calls.length, 1)
  assert.deepEqual(await json(f.send('/api/v1/sessions')), [])
})

test('local read invokes only the consented SQLite file and rechecks ACL before using its bytes', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const headers = { 'x-openviking-allow-read': uri }
  const grant = { principal: `user:${member.userId}`, level: 'read' }
  await json(post(f.admin, '/api/v1/content/write', { uri, content: info, processing_mode: 'vectors_only', acl: { acl_mode: 'restricted', entries: [grant] } }))
  const restrict = () => json(f.admin('/api/v1/acl', { method: 'PUT', body: { uri, acl_mode: 'restricted', entries: [] } }))
  let revoke = false, wrong = false
  f.setIntercept(async (body, isOpen) => {
    if (!['function', 'tool'].includes(body.tool_choice?.type)) return
    assert.equal(JSON.stringify(body).includes(info), false)
    if (revoke) await restrict()
    const requested = wrong ? 'viking://resources/not-consented.txt' : uri
    return Response.json(isOpen ? { object: 'response', status: 'completed', output: [{ type: 'function_call', status: 'completed',
      name: 'openviking_read', call_id: 'read_fixture', arguments: JSON.stringify({ uri: requested }) }] } :
      { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'read_fixture', name: 'openviking_read', input: { uri: requested } },
      ] })
  })
  await json(call(f.other, 'responses', {}, headers), 404, 'local_tool_resource_unavailable')
  assert.equal(f.calls.length, 0)
  await json(call(f.send, 'responses'))
  assert.equal(f.calls[0].body.tools, undefined)
  for (const p of ['responses', 'messages']) {
    const output = await json(call(f.send, p, {}, headers))
    assert.doesNotMatch(JSON.stringify(output), /openviking_read|read_fixture/)
    const body = f.calls.at(-1).body
    if (p === 'responses') assert.deepEqual(body.input.at(-1), { type: 'function_call_output', call_id: 'read_fixture', output: info })
    else assert.deepEqual(body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'read_fixture', content: info }])
  }
  wrong = true
  await json(call(f.send, 'responses', {}, headers), 502, 'tool_call_invalid')
  assert.equal(f.calls.length, 6)
  wrong = false; revoke = true
  const res = await call(f.send, 'responses', {}, headers)
  assert.equal(res.ok, false)
  assert.equal(f.calls.length, 7, 'no continuation after revocation')
  assert.deepEqual(await json(f.send('/api/v1/sessions')), [])
})

test('all new features fail closed when the inventory does not opt in', { timeout: 10000 }, async t => {
  const f = await fixture(t, false)
  await json(call(f.send, 'responses', { temperature: 1 }), 501, 'native_option_unsupported')
  await json(call(f.send, 'messages/count_tokens'), 501, 'token_count_unavailable')
  await json(call(f.send, 'responses', {}, { 'x-openviking-allow-read': uri }), 501, 'local_tool_unsupported')
  assert.deepEqual(f.calls, [])
})

test('native Messages document and stop: first SSE text precedes producer release, then exact terminal', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  const gate = Promise.withResolvers()
  let sentTerminal = false
  const frame = (type, rest) => `event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`
  f.setIntercept(body => {
    assert.equal(body.stream, true)
    assert.deepEqual(body.stop_sequences, ['FIN'])
    assert.equal(body.messages[0].content[0].source.data, info)
    let first = true
    const enc = new TextEncoder()
    return new Response(new ReadableStream({ async pull(c) {
      if (first) {
        first = false
        c.enqueue(enc.encode(frame('message_start', { message: { type: 'message', role: 'assistant', content: [] } }) +
          frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
          frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Balise 🌊' } })))
        return
      }
      await gate.promise
      sentTerminal = true
      c.enqueue(enc.encode(frame('content_block_stop', { index: 0 }) +
        frame('message_delta', { delta: { stop_reason: 'stop_sequence', stop_sequence: 'FIN' }, usage: { output_tokens: 3 } }) + frame('message_stop', {})))
      c.close()
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } })
  })
  try {
    const reply = await call(f.send, 'messages', { stream: true, stop_sequences: ['FIN'], messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: info } },
    ] }] })
    assert.equal(reply.status, 200)
    const rd = reply.body.getReader(), dec = new TextDecoder()
    let text = ''
    while (!text.includes('Balise 🌊')) { const part = await rd.read(); assert.equal(part.done, false); text += dec.decode(part.value, { stream: true }) }
    assert.equal(sentTerminal, false)
    assert.doesNotMatch(text, /message_stop/)
    gate.resolve()
    for (let part; !(part = await rd.read()).done;) text += dec.decode(part.value, { stream: true })
    assert.match(text, /"stop_reason":"stop_sequence","stop_sequence":"FIN"/)
    assert.equal(text.match(/event: message_stop/g)?.length, 1)
  } finally { gate.resolve() }
})
