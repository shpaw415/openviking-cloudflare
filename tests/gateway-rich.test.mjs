// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const model = 'fixture-vision-audio', origin = 'https://rich.fixture.test/v1', other = 'https://other.fixture.test/v1'
const config = '/api/v1/admin/configuration/import', policy = '/gateway/admin/policies/default'
const endpoints = { chat: '/gateway/v1/chat/completions', responses: '/gateway/api/v3/responses', messages: '/gateway/api/compatible/v1/messages' }
const root = testPrincipal('fixture-root', 'operator', 'root')
const admin = testPrincipal('fixture-rich', 'fixture-admin', 'admin'), member = testPrincipal(admin.accountId, 'fixture-member')
const capabilities = JSON.stringify([{ api_base: origin, model, capabilities: ['image', 'audio', 'tools'] }])
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const put = (send, path, body) => send(path, { method: 'PUT', body })

function makePNG(width = 2) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8
  const chunk = (name, data) => {
    const bytes = Buffer.concat([Buffer.from(name), data]), result = Buffer.alloc(bytes.length + 8)
    result.writeUInt32BE(data.length); bytes.copy(result, 4); result.writeUInt32BE(crc32(bytes), result.length - 4)
    return result
  }
  const pixels = Buffer.alloc(1 + width, 127)
  pixels[0] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
function makeWAV(size = 3244) {
  const wav = Buffer.alloc(size)
  wav.write('RIFF'); wav.writeUInt32LE(size - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(size - 44, 40)
  for (let i = 44; i < size; i += 2) wav.writeInt16LE(i * 39 % 1000 - 500, i)
  return wav
}
const png = makePNG(), wav = makeWAV()
// 2×2 grayscale baseline JFIF generated for this test.
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AD//Z', 'base64')
const imageURL = (data = png, format = 'png') => `data:image/${format};base64,${data.toString('base64')}`
const image = (url = imageURL()) => ({ type: 'image_url', image_url: { url, detail: 'low' } })
const audio = (data = wav) => ({ type: 'input_audio', input_audio: { format: 'wav', data: data.toString('base64') } })
const media = (k, prompt, stream = false) => turn(k, k === 'chat' ? [{ type: 'text', text: prompt }, image(), audio()] :
  k === 'responses' ? [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: imageURL(jpeg, 'jpeg'), detail: 'high' }] :
    [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }], stream)
function turn(k, content, stream = false) {
  return { model, stream, ...(k === 'responses' ? { input: [{ role: 'user', content }], store: false, max_output_tokens: 220 } :
    { messages: [{ role: 'user', content }], max_tokens: 220 }) }
}
const name = 'fixture_tide', result = 'watermark 17 cm', expectedAnswer = 'From the client measurement: 17 cm.'
const args = { place: 'wharf', counts: [2, 3] }
const tool = { name, description: 'Read a synthetic tide gauge supplied by the client.', parameters: { type: 'object',
  properties: { place: { type: 'string' }, counts: { type: 'array', items: { type: 'integer' } } }, required: ['place', 'counts'], additionalProperties: false } }
function toolTurn(k, prompt, stream = false, choice = true) {
  return { ...turn(k, prompt, stream),
    tools: [k === 'chat' ? { type: 'function', function: tool } : k === 'responses' ? { type: 'function', ...tool } :
      { name, description: tool.description, input_schema: tool.parameters }],
    ...(choice && { tool_choice: k === 'chat' ? { type: 'function', function: { name } } : k === 'responses' ? { type: 'function', name } :
      { type: 'tool', name, disable_parallel_tool_use: true } }), ...(choice && k !== 'messages' && { parallel_tool_calls: false }),
  }
}
function continuation(k, sent, output, streaming = false) {
  const follow = { ...sent, stream: streaming, tool_choice: k === 'messages' ? { type: 'none' } : 'none' }
  if (k === 'chat') {
    const call = output.tool_calls[0]
    return { ...follow, messages: [...sent.messages, output, { role: 'tool', tool_call_id: call.id, content: result }] }
  }
  if (k === 'responses') return { ...follow, input: [...sent.input, ...output,
    { type: 'function_call_output', call_id: output.find(item => item.type === 'function_call').call_id, output: result }] }
  const call = output.find(block => block.type === 'tool_use')
  return { ...follow, messages: [...sent.messages, { role: 'assistant', content: output },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result }] }] }
}

async function body(response, status = 200, reason) {
  assert.match(response.headers.get('content-type'), /^application\/json/)
  const value = await response.json()
  assert.equal(response.status, status, `${response.status}: ${value.reason ?? value.error?.code ?? ''}`)
  if (reason) assert.equal(value.reason, reason)
  return value.result ?? value
}

let bundles
async function fixture(t, { inventory = capabilities, streaming = true } = {}) {
  const absWorkingDir = fileURLToPath(new URL('..', import.meta.url))
  const bundle = async entry => (await build({ absWorkingDir, entryPoints: [entry], platform: 'browser', format: 'esm', bundle: true,
    write: false, external: ['cloudflare:workers'] })).outputFiles[0].text
  bundles ??= Promise.all([bundle('src/worker.ts'), bundle('tests/gateway/rich-http-fixture.mjs')])
  const [script, provider] = await bundles
  const key = randomBytes(24).toString('hex'), providerName = 'rich-provider'
  const common = { modules: true, compatibilityDate: '2026-11-19' }
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR), workers: [
    { ...common, name: 'rich-gateway', script, durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true },
      CONTROL: { className: 'Control', useSQLite: true } }, outboundService: providerName, bindings: {
        OPENVIKING_EDGE_KEYS: JSON.stringify([root, admin, member]),
        OPENVIKING_EDGE_PROVIDERS: JSON.stringify([origin, other].map(api_base => ({ api_base, api_key: key }))),
        ...(inventory && { OPENVIKING_EDGE_GATEWAY_CAPABILITIES: inventory }), ...(streaming && { OPENVIKING_EDGE_OPERATOR_STREAMING: '1' }),
      } },
    { ...common, name: providerName, script: provider, durableObjects: { PROVIDER: { className: 'Provider', useSQLite: true } },
      bindings: { PROVIDER_TEST_KEY: key }, outboundService: () => new Response(null, { status: 599 }) },
  ] }))
  t.after(() => runtime.dispose())
  const stub = await runtime.getWorker(providerName)
  const inspect = (path, name = '', method = 'GET') => {
    const url = new URL(`https://rich-control.invalid/${path}`)
    url.searchParams.set('name', name)
    return stub.fetch(url, { method }).then(response => response.json())
  }
  const asRoot = api(runtime, root), send = api(runtime, member), asAdmin = api(runtime, admin)
  const select = async (api_base = origin, timeout = 6) => body(await post(asRoot, config, { vlm: { provider: 'openai-compatible',
    api_base, model, max_tokens: 64, timeout } }))
  await select()
  return { runtime, send, asAdmin, asRoot, select, key, run: (k, value, headers) => post(send, endpoints[k], value, headers),
    calls: () => inspect('calls'), state: name => inspect('state', name), release: name => inspect('release', name, 'POST') }
}

function sse(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(response.headers.get('x-openviking-capture'), 'disabled')
  assert.equal(response.headers.get('x-origin-marker'), null)
  const reader = response.body.getReader(), decode = new TextDecoder('utf-8', { fatal: true })
  let pending = '', done = false
  const values = []
  async function read() {
    const part = await reader.read()
    pending += decode.decode(part.value, { stream: !part.done })
    for (let end; (end = pending.indexOf('\n\n')) >= 0;) {
      const lines = pending.slice(0, end).split('\n')
      pending = pending.slice(end + 2)
      const event = lines.find(line => line.startsWith('event: '))?.slice(7)
      const data = lines.find(line => line.startsWith('data: ')).slice(6)
      values.push({ event, value: data === '[DONE]' ? data : JSON.parse(data) })
    }
    done = part.done
  }
  return { async until(check) { while (!values.some(check) && !done) await read(); assert.ok(values.some(check)); return [...values] },
    async end() { while (!done) await read(); assert.equal(pending, ''); return [...values] } }
}
const text = row => row.event === 'response.output_text.delta' ? row.value.delta :
  row.event === 'content_block_delta' ? row.value.delta.text : row.value?.choices?.[0]?.delta?.content
const toolEvent = row => row.event === 'response.function_call_arguments.done' ||
  row.event === 'content_block_delta' && row.value.delta.type === 'input_json_delta' || row.value?.choices?.[0]?.delta?.tool_calls !== undefined
const terminal = row => row.value === '[DONE]' || ['message_stop', 'response.completed', 'response.incomplete'].includes(row.event)
const errorCode = row => row.value.code ?? row.value.error?.code
const visible = (k, value) => k === 'chat' ? value.choices[0].message.content : k === 'responses' ? value.output[0].content[0].text : value.content[0].text
const sessions = async f => body(await f.send('/api/v1/sessions'))
const assertFresh = state => assert.deepEqual(state, { released: false, tail: false, cancelled: false })
async function waitState(f, prompt, predicate) {
  for (let i = 0; i < 40; i++) {
    const state = await f.state(prompt)
    if (predicate(state)) return state
    await delay(30)
  }
  assert.fail('The provider did not reach the expected state.')
}

test('F4 media: actual PNG, JPEG, WAV bytes reach the only admitted HTTP model, across all image protocols', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  for (const k of Object.keys(endpoints)) {
    const response = await f.run(k, media(k, 'Read the fixture'), { 'x-only-client': 'not for the provider', 'x-openviking-session': 'private-rich' })
    assert.equal(response.headers.get('x-origin-marker'), null)
    assert.equal(response.headers.get('x-openviking-capture'), 'disabled')
    const payload = await body(response)
    assert.equal(visible(k, payload), 'Fixture received structured media.')
    if (k === 'responses') await body(await f.send(`${endpoints[k]}/${payload.id}`), 404, 'response_unknown')
  }
  assert.deepEqual(await sessions(f), [])
  const calls = await f.calls()
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.url, `${origin}/chat/completions`)
    assert.equal(call.accept, 'application/json')
    assert.equal(call.accepted, true)
    assert.equal(call.forwarded, false)
    assert.equal(call.body.max_tokens, 64)
    assert.equal(call.body.messages.length, 1)
  }
  assert.deepEqual(calls[0].body.messages[0].content, [{ type: 'text', text: 'Read the fixture' }, image(), audio()])
  assert.deepEqual(Buffer.from(calls[0].body.messages[0].content[2].input_audio.data, 'base64'), wav)
  assert.deepEqual(calls.slice(1).map(call => call.body.messages[0].content[1].image_url), [
    { url: imageURL(jpeg, 'jpeg'), detail: 'high' }, { url: imageURL() },
  ])
  const logs = JSON.stringify(await body(await f.send('/gateway/admin/logs')))
  assert.doesNotMatch(logs, /Read the fixture|data:image|private-rich/)
})

test('F4 media: each protocol delivers a text delta before the held supplier tail', { timeout: 14000 }, async t => {
  const f = await fixture(t)
  for (const k of Object.keys(endpoints)) {
    const prompt = `held-media ${k}`
    const stream = sse(await f.run(k, media(k, prompt, true)))
    const first = await stream.until(row => text(row) === 'Marée 🌊')
    assert.equal(first.some(terminal), false)
    assertFresh(await f.state(prompt))
    assert.equal((await f.release(prompt)).released, true)
    const all = await stream.end()
    // The credential filter may hold a matching suffix across frame boundaries.
    assert.equal(all.map(text).filter(Boolean).join(''), 'Marée 🌊 haute')
    assert.equal(all.filter(terminal).length, 1)
    assert.equal((await f.state(prompt)).tail, true)
  }
  assert.equal((await f.calls()).length, 3)
})

test('F4 tools: complete native JSON cycles on Chat, Responses and Messages, one invocation per request', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  for (const k of Object.keys(endpoints)) {
    const first = toolTurn(k, 'tool prose')
    const opening = await body(await f.run(k, first))
    const output = k === 'chat' ? opening.choices[0].message : k === 'responses' ? opening.output : opening.content
    const call = k === 'chat' ? output.tool_calls[0] : output.at(-1)
    assert.deepEqual(k === 'messages' ? call.input : JSON.parse(k === 'chat' ? call.function.arguments : call.arguments), args)
    assert.equal(k === 'chat' ? opening.choices[0].finish_reason : k === 'messages' ? opening.stop_reason : opening.status,
      k === 'chat' ? 'tool_calls' : k === 'messages' ? 'tool_use' : 'completed')
    const count = (await f.calls()).length
    assert.equal(visible(k, await body(await f.run(k, continuation(k, first, output)))), expectedAnswer)
    const calls = await f.calls()
    assert.equal(calls.length, count + 1)
    assert.deepEqual(calls.at(-2).body.tools, [{ type: 'function', function: tool }])
    assert.deepEqual(calls.at(-2).body.tool_choice, { type: 'function', function: { name } })
    assert.equal(calls.at(-2).body.parallel_tool_calls, false)
    assert.equal(calls.at(-1).body.tool_choice, 'none')
    assert.equal(calls.at(-1).body.messages.at(-2).tool_calls[0].id, 'call_fixture_tide')
    assert.deepEqual(calls.at(-1).body.messages.at(-1), { role: 'tool', tool_call_id: 'call_fixture_tide', content: result })
    if (k === 'responses') await body(await f.send(`${endpoints[k]}/${opening.id}`), 404, 'response_unknown')
  }
  assert.equal((await f.calls()).length, 6)
  assert.deepEqual(await sessions(f), [])
  assert.doesNotMatch(JSON.stringify(await body(await f.send('/gateway/admin/logs'))), /watermark|call_fixture_tide|wharf/)
})

test('F4 tools: safe tool-only SSE events precede a held DONE and support real second requests', { timeout: 16000 }, async t => {
  const f = await fixture(t)
  for (const k of Object.keys(endpoints)) {
    const prompt = `held-call ${k}`, first = toolTurn(k, prompt, true)
    const stream = sse(await f.run(k, first))
    const early = await stream.until(toolEvent)
    assert.equal(early.some(terminal), false)
    assertFresh(await f.state(prompt))
    await f.release(prompt)
    const complete = await stream.end()
    assert.equal(complete.filter(terminal).length, 1)
    assert.equal(complete.map(text).filter(Boolean).length, 0, 'no synthetic prose delta for a tool-only turn')
    let output
    if (k === 'chat') {
      const { index, ...call } = complete.find(toolEvent).value.choices[0].delta.tool_calls[0]
      assert.equal(index, 0)
      assert.equal(complete.at(-2).value.choices[0].finish_reason, 'tool_calls')
      output = { role: 'assistant', content: null, tool_calls: [call] }
    } else if (k === 'responses') {
      assert.deepEqual(complete.map(row => row.value.sequence_number), [...complete.keys()])
      output = complete.at(-1).value.response.output
      assert.deepEqual(JSON.parse(output[0].arguments), args)
    } else {
      const block = complete.find(row => row.event === 'content_block_start').value.content_block
      assert.equal(complete.at(-2).value.delta.stop_reason, 'tool_use')
      output = [{ ...block, input: JSON.parse(complete.find(toolEvent).value.delta.partial_json) }]
    }
    const follow = sse(await f.run(k, continuation(k, first, output, true)))
    const final = await follow.end()
    assert.deepEqual(final.map(text).filter(Boolean), [expectedAnswer])
    assert.equal(final.filter(terminal).length, 1)
  }
  assert.equal((await f.calls()).length, 6)
})

test('F4 mixed turn: text is progressive; only after release are validated tool blocks appended', { timeout: 13000 }, async t => {
  const f = await fixture(t)
  for (const k of ['responses', 'messages']) {
    const prompt = `held-prose ${k}`
    const first = { ...media(k, prompt, true), tools: toolTurn(k, '').tools }
    const stream = sse(await f.run(k, first))
    const early = await stream.until(row => text(row) === 'Marée 🌊')
    assert.equal(early.some(toolEvent), false)
    assertFresh(await f.state(prompt))
    await f.release(prompt)
    const frames = await stream.end()
    assert.equal(frames.filter(terminal).length, 1)
    assert.ok(frames.findIndex(row => row.event === (k === 'responses' ? 'response.output_text.done' : 'content_block_stop')) < frames.findIndex(toolEvent))
    const projected = frames.find(toolEvent).value
    assert.equal(k === 'responses' ? projected.output_index : projected.index, 1)
    assert.deepEqual(JSON.parse(k === 'responses' ? projected.arguments : projected.delta.partial_json), args)
    const output = k === 'responses' ? frames.at(-1).value.response.output : [
      { type: 'text', text: 'Marée 🌊' },
      ...frames.filter(row => row.event === 'content_block_start' && row.value.index === 1)
        .map(row => ({ ...row.value.content_block, input: args })),
    ]
    assert.equal(visible(k, await body(await f.run(k, continuation(k, first, output)))), expectedAnswer)
  }
  assert.equal((await f.calls()).length, 4)
})

test('F4 refusals before egress: opt-in, exact destination/model, body forms and retention boundaries', { timeout: 16000 }, async t => {
  const off = await fixture(t, { inventory: '' })
  await body(await off.run('chat', media('chat', 'disabled')), 501, 'non_text_input_unsupported')
  await body(await off.run('chat', toolTurn('chat', 'disabled')), 501, 'tools_unsupported')
  assert.deepEqual(await off.calls(), [])
  const f = await fixture(t)
  const input = media('responses', 'Unstored media')
  await body(await f.run('responses', { ...input, model: 'unlisted-fixture' }), 404, 'no_matching_upstream')
  await body(await post(api(f.runtime), endpoints.responses, input), 401)
  await body(await post(f.asRoot, endpoints.responses, input), 403)
  await body(await f.run('responses', { ...input, store: true }), 501, 'rich_persistence_unsupported')
  await body(await f.run('responses', { ...input, previous_response_id: `resp_${'1'.repeat(32)}` }), 501, 'rich_persistence_unsupported')
  await body(await put(f.asAdmin, policy, { name: 'fixture capture', capture: true }))
  await body(await f.run('chat', toolTurn('chat', 'do not capture')), 501, 'rich_persistence_unsupported')
  await body(await put(f.asAdmin, policy, { name: 'fixture profile', profile: true }))
  await body(await f.run('responses', input), 501, 'rich_context_unsupported')
  await body(await f.asAdmin(policy, { method: 'DELETE' }))
  const attachment = `att_${'2'.repeat(32)}`
  for (const part of [image('https://never.fixture.test/image.png'), image('viking://resources/image.png'), image(attachment)]) {
    await body(await f.run('chat', turn('chat', [part])), 501, 'non_text_input_unsupported')
  }
  await body(await f.run('responses', turn('responses', [{ type: 'input_image', file_id: attachment }])), 501, 'non_text_input_unsupported')
  await body(await f.run('responses', turn('responses', [audio()])), 501, 'non_text_input_unsupported')
  await body(await post(f.send, `${endpoints.messages}/count_tokens`, { model, messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
  ] }] }), 501, 'non_text_input_unsupported')
  const malformed = [image('data:image/png;base64,!bad'), image(imageURL(wav)), image(imageURL(makePNG(2049))), audio(Buffer.from('junk'))]
  for (const part of malformed) await body(await f.run('chat', turn('chat', [part])), 400, 'media_invalid')
  await body(await f.run('chat', turn('chat', [audio(makeWAV(65538))])), 413, 'media_limit')
  await body(await f.run('chat', turn('chat', Array.from({ length: 3 }, () => audio(makeWAV(47044))))), 413, 'media_limit')
  await body(await f.run('chat', turn('chat', Array.from({ length: 5 }, () => image()))), 413, 'media_limit')
  const stale = toolTurn('chat', 'missing call')
  await body(await f.run('chat', { ...stale, messages: [...stale.messages, { role: 'tool', tool_call_id: 'another_call', content: result }] }), 400, 'tool_history_invalid')
  await body(await f.run('chat', { ...stale, tools: [{ type: 'function', function: { name, parameters: { type: 'object', additionalProperties: true } } }] }), 400, 'tool_declaration_invalid')
  await f.select(other)
  await body(await f.run('responses', input), 501, 'non_text_input_unsupported')
  assert.deepEqual(await f.calls(), [])
  assert.deepEqual(await sessions(f), [])
})

test('F4 operator explicitly opts in per capability; SSE off cannot silently use JSON', { timeout: 12000 }, async t => {
  const f = await fixture(t, { inventory: JSON.stringify([{ api_base: origin, model, capabilities: ['image'] }]), streaming: false })
  const payload = turn('chat', [image()])
  await body(await f.run('chat', media('chat', 'audio is off')), 501, 'non_text_input_unsupported')
  await body(await f.run('chat', toolTurn('chat', 'tools are off')), 501, 'tools_unsupported')
  await body(await f.run('chat', { ...payload, stream: true }), 501, 'streaming_unavailable')
  assert.deepEqual(await f.calls(), [])
  assert.equal(visible('chat', await body(await f.run('chat', payload))), 'Fixture received structured media.')
  assert.equal((await f.calls()).length, 1)
})

test('F4 failures are static, tool fields are filtered before emission, and no DONE means no successful terminal', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  for (const stream of [false, true]) {
    await body(await f.run('chat', toolTurn('chat', 'bad typed output', stream)), 502, 'tool_call_invalid')
    const leak = await body(await f.run('chat', toolTurn('chat', 'secret arguments', stream)), 502, 'upstream_error')
    assert.equal(JSON.stringify(leak).includes(f.key), false)
  }
  const partial = await sse(await f.run('chat', media('chat', 'secret text', true))).end()
  assert.deepEqual(partial.map(text).filter(Boolean), ['Safe prefix '])
  assert.equal(partial.some(terminal), false)
  assert.equal(errorCode(partial.at(-1)), 'upstream_error')
  assert.equal(JSON.stringify(partial).includes(f.key.slice(0, f.key.length / 2)), false)
  const eof = await sse(await f.run('responses', toolTurn('responses', 'missing DONE', true))).end()
  assert.ok(eof.some(toolEvent))
  assert.equal(eof.some(terminal), false)
  assert.equal(errorCode(eof.at(-1)), 'stream_incomplete')
  await body(await f.run('chat', media('chat', 'redirect')), 502, 'upstream_error')
  const calls = await f.calls()
  assert.equal(calls.length, 7)
  assert.ok(calls.every(call => call.url === `${origin}/chat/completions`))
})

test('F4 cancellation: TCP disconnect reaches the held mixed SSE body; model change closes a pending JSON call', { timeout: 16000 }, async t => {
  const f = await fixture(t)
  const where = await f.runtime.ready
  assert.equal(where.hostname, '127.0.0.1')
  const prompt = 'held-prose disconnect', label = { 'x-openviking-session': 'rich-disconnect' }
  const requestBody = JSON.stringify(toolTurn('chat', prompt, true))
  const incoming = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL(endpoints.chat, where), { method: 'POST', agent: false,
      headers: { ...label, 'x-api-key': member.key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(requestBody) } }, resolve)
    request.on('error', reject)
    request.end(requestBody)
  })
  t.after(() => incoming.destroy())
  const opened = sse(new Response(Readable.toWeb(incoming), { headers: incoming.headers, status: incoming.statusCode }))
  assert.equal((await opened.until(row => text(row) === 'Marée 🌊')).some(toolEvent), false)
  assertFresh(await f.state(prompt))
  await body(await f.run('chat', toolTurn('chat', 'concurrent named turn'), label), 409, 'conversation_busy')
  incoming.socket.resetAndDestroy()
  assert.deepEqual(await waitState(f, prompt, state => state?.cancelled), { released: false, tail: false, cancelled: true })
  await body(await f.run('chat', media('chat', 'next'), label))

  const pending = f.run('responses', media('responses', 'held-json revision'))
  assertFresh(await waitState(f, 'held-json revision', Boolean))
  await body(await post(f.asRoot, config, { default_search_limit: 1 }))
  await body(await pending, 409, 'gateway_configuration_changed')
  assert.deepEqual(await waitState(f, 'held-json revision', state => state?.cancelled), { released: false, tail: false, cancelled: true })
  assert.deepEqual(await sessions(f), [])
  assert.equal((await f.calls()).length, 3)
})
