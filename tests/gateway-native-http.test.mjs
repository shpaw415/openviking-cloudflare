// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const gateway = '/gateway/v1', configuration = '/api/v1/admin/configuration/import'
const openai = 'https://api.openai.com/v1', anthropic = 'https://api.anthropic.com/v1'
const roster = [{ protocol: 'responses', api_base: openai, model: 'fixture-openai', capabilities: ['image', 'tools'] },
  { protocol: 'anthropic', api_base: anthropic, model: 'fixture-anthropic', capabilities: ['image', 'tools'] }]
const member = testPrincipal('native-tenant', 'native-user'), admin = testPrincipal('native-tenant', 'native-admin', 'admin')
const root = testPrincipal('native-operator', 'root', 'root')
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const fixtureBody = (protocol, text, extra = {}) => protocol === 'responses' ? { model: roster[0].model, input: text, ...extra } :
  { model: roster[1].model, messages: [{ role: 'user', content: text }], max_tokens: 160, ...extra }
const postNative = (send, protocol, text, extra, headers) => post(send, `${gateway}/${protocol}`, fixtureBody(protocol, text, extra), headers)

async function json(res, status = 200, reason) {
  assert.equal(res.status, status)
  assert.equal(res.headers.get('x-fixture-output'), null)
  const data = await res.json()
  if (reason) assert.equal(data.reason, reason)
  return data.result ?? data
}

const bundle = async entry => (await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: [entry],
  platform: 'browser', format: 'esm', bundle: true, write: false, external: ['cloudflare:workers'] })).outputFiles[0].text
let bundles
async function fixture(t, { native = JSON.stringify(roster), missing = false, streaming = true } = {}) {
  const [worker, provider] = await (bundles ??= Promise.all([bundle('src/worker.ts'), bundle('tests/gateway/native-http-fixture.mjs')]))
  const [a, b] = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
  const common = { modules: true, compatibilityDate: '2026-11-19' }, service = 'native-provider'
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.ERROR), workers: [
    { ...common, script: worker, name: 'native-edge', outboundService: service,
      bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root, admin, member]),
        ...(native !== null && { OPENVIKING_EDGE_GATEWAY_NATIVE: native }), ...(streaming && { OPENVIKING_EDGE_OPERATOR_STREAMING: '1' }),
        OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: openai, api_key: a }, ...(!missing ? [{ api_base: anthropic, api_key: b }] : [])]) },
      durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } } },
    { ...common, script: provider, name: service, outboundService: () => new Response(null, { status: 599 }), bindings: { OPENAI: a, ANTHROPIC: b },
      durableObjects: { PROVIDER: { className: 'Provider', useSQLite: true } } },
  ] }))
  t.after(() => runtime.dispose())
  const stub = await runtime.getWorker(service)
  async function inspect(path, name = '', method = 'GET') {
    return json(await stub.fetch(`https://native-control.test/${path}?name=${name}`, { method }))
  }
  return { send: api(runtime, member), admin: api(runtime, admin), root: api(runtime, root), anonymous: api(runtime),
    calls: () => inspect('calls'), state: name => inspect('state', name), release: name => inspect('release', name, 'POST') }
}

function sse(res) {
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(res.headers.get('x-fixture-output'), null)
  const rd = res.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  const frames = []
  async function next() {
    const read = await rd.read()
    buffer += decoder.decode(read.value, { stream: !read.done })
    for (let limit; (limit = buffer.indexOf('\n\n')) >= 0;) {
      const text = buffer.slice(0, limit)
      buffer = buffer.slice(limit + 2)
      frames.push({ name: /^event: (.+)$/m.exec(text)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(text)[1]) })
    }
    return !read.done
  }
  return { async first() { while (!frames.some(frame => delta(frame))) assert.ok(await next(), 'missing causal delta'); return [...frames] },
    async end() { while (await next()) {} assert.equal(buffer, ''); return frames } }
}
const delta = frame => frame.name === 'response.output_text.delta' ? frame.data.delta :
  frame.name === 'content_block_delta' ? frame.data.delta.text : undefined
const successes = frames => frames.filter(frame => ['message_stop', 'response.completed'].includes(frame.name))
const params = { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }
const tools = {
  responses: [{ type: 'function', name: 'lookup_marker', parameters: params }],
  messages: [{ name: 'lookup_marker', input_schema: params }],
}
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwrjoDAAJdAXr98KwwAAAAAElFTkSuQmCC'
const url = `data:image/png;base64,${png}`

test('F5 native JSON projects exact DTOs, minimal auth, local history and capture; Chat keeps its transport', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  await json(await post(f.root, configuration, { vlm: { provider: 'openai', model: 'fixture-chat', max_tokens: 70 } }))
  const headers = { 'openai-organization': 'not forwarded', 'anthropic-beta': 'not forwarded', 'x-fixture-tenant': 'not forwarded' }
  const saved = await json(await postNative(f.send, 'responses', '', { instructions: 'Instruction fictive', store: true, max_output_tokens: 100,
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'Développeur fictif' }] }, { role: 'user', content: 'Carte du port' }] }, headers))
  assert.equal(saved.output[0].content[0].text, 'Marée 🌊 en vue.')
  assert.deepEqual(saved.usage, { input_tokens: 13, output_tokens: 7, total_tokens: 20 })
  assert.deepEqual(await json(await f.send(`${gateway}/responses/${saved.id}`)), saved)
  await json(await postNative(f.send, 'responses', 'Suite', { previous_response_id: saved.id }))
  await json(await f.admin('/gateway/admin/policies/default', { method: 'PUT', body: { name: 'Capture', capture: true } }))
  const captured = await postNative(f.send, 'messages', 'Autre carte', { system: [{ type: 'text', text: 'Instructions Messages' }] }, headers)
  assert.equal(captured.headers.get('x-openviking-capture'), 'saved')
  assert.ok(captured.headers.get('x-openviking-captured-session'))
  const msg = await json(captured)
  assert.deepEqual(msg.content, [{ type: 'text', text: 'Marée 🌊 en vue.' }])
  assert.deepEqual(msg.usage, { input_tokens: 17, output_tokens: 5 })
  assert.equal(msg.stop_reason, 'end_turn')
  const listing = await json(await f.send('/api/v1/sessions'))
  assert.equal(listing.length, 1)
  const chat = await json(await post(f.send, `${gateway}/chat/completions`, { model: 'fixture-chat', messages: [{ role: 'user', content: 'Chat' }] }))
  assert.equal(chat.choices[0].message.content, 'Chat inchangé.')
  const calls = await f.calls()
  assert.deepEqual(calls.map(call => call.url), [`${openai}/responses`, `${openai}/responses`, `${anthropic}/messages`, `${openai}/chat/completions`])
  for (const call of calls) assert.deepEqual([call.valid, call.authority, call.contentType, call.accept, call.forwarded], [true, true, 'application/json', 'application/json', []])
  assert.deepEqual(calls[0].body, { model: roster[0].model, input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Développeur fictif' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Carte du port' }] },
  ], instructions: 'Instruction fictive', max_output_tokens: 70, stream: false, store: false })
  assert.deepEqual(calls[1].body.input.map(row => row.role), ['user', 'assistant', 'user'])
  assert.deepEqual(calls[1].body.input[1], { type: 'message', role: 'assistant', content: 'Marée 🌊 en vue.' })
  assert.equal(calls[1].body.previous_response_id, undefined)
  assert.deepEqual(calls[2].body, { model: roster[1].model, max_tokens: 70, stream: false,
    system: [{ type: 'text', text: 'Instructions Messages' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'Autre carte' }] }] })
})

test('F5 native SSE: each first delta is visible over HTTP before provider release; real tools stream and terminal usage', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  for (const protocol of ['responses', 'messages']) {
    const cursor = sse(await postNative(f.send, protocol, 'fixture-held', { stream: true, tools: tools[protocol],
      ...(protocol === 'responses' && { instructions: 'hold-openai' }) }))
    const first = await cursor.first()
    assert.deepEqual(first.map(delta).filter(Boolean), ['Marée 🌊'])
    assert.equal(successes(first).length, 0)
    assert.deepEqual(await f.state(protocol), { released: false, tail: false, cancelled: false })
    assert.equal((await f.release(protocol)).released, true)
    const events = await cursor.end()
    assert.deepEqual(events.map(delta).filter(Boolean), ['Marée 🌊', ' en vue.'])
    assert.equal(successes(events).length, 1)
    assert.equal((await f.state(protocol)).tail, true)
    if (protocol === 'responses') {
      assert.equal(events.at(-1).data.response.output.at(-1).name, 'lookup_marker')
      assert.deepEqual(events.at(-1).data.response.usage, { input_tokens: 13, output_tokens: 7, total_tokens: 20 })
    } else {
      assert.ok(events.some(frame => frame.data.delta?.partial_json === '{"marker":"dock"}'))
      assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use')
      assert.deepEqual(events.at(-2).data.usage, { input_tokens: 17, output_tokens: 5 })
    }
  }
  assert.deepEqual((await f.calls()).map(call => [call.url, call.accept]), [[`${openai}/responses`, 'text/event-stream'], [`${anthropic}/messages`, 'text/event-stream']])
})

test('F5 native images reach both providers inline; client tool results are projected on the next request only', { timeout: 12_000 }, async t => {
  const f = await fixture(t)
  for (const protocol of ['responses', 'messages']) {
    const responses = protocol === 'responses'
    const block = responses ? { type: 'input_image', image_url: url, detail: 'high' } : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
    const question = { role: 'user', content: [{ type: responses ? 'input_text' : 'text', text: 'Image' }, block] }
    const rich = await json(await postNative(f.send, protocol, '', { [responses ? 'input' : 'messages']: [question], tools: tools[protocol],
      tool_choice: responses ? { type: 'function', name: 'lookup_marker' } : { type: 'tool', name: 'lookup_marker', disable_parallel_tool_use: true } }))
    const call = (responses ? rich.output : rich.content)[0]
    assert.equal(call.name, 'lookup_marker')
    assert.equal((await f.calls()).length, responses ? 1 : 3)
    const next = await json(await postNative(f.send, protocol, '', { tools: tools[protocol], [responses ? 'input' : 'messages']: responses ?
      [question, call, { type: 'function_call_output', call_id: call.call_id, output: 'Client figure' }] :
      [question, { role: 'assistant', content: [call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'Client figure', is_error: true }] }] }))
    assert.equal((responses ? next.output[0].content[0] : next.content[0]).text, 'Marée 🌊 en vue.')
    const calls = await f.calls(), before = calls.at(-2).body, after = calls.at(-1).body
    assert.deepEqual((responses ? before.input : before.messages)[0].content[1], block)
    assert.equal(before.tool_choice.name, 'lookup_marker')
    if (responses) {
      assert.equal(before.tools[0].strict, false)
      assert.deepEqual(after.input.at(-1), { type: 'function_call_output', call_id: 'call_fixture', output: 'Client figure' })
    } else {
      assert.equal(before.tool_choice.disable_parallel_tool_use, true)
      assert.deepEqual(after.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'Client figure', is_error: true }])
    }
  }
  assert.equal((await f.calls()).length, 4)
  assert.deepEqual(await json(await f.send('/api/v1/sessions')), [])
})

test('F5 native refusals precede invocation; error, EOF and mismatched terminal cannot succeed or persist', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  await json(await postNative(f.anonymous, 'responses', 'Question'), 401)
  await json(await postNative(f.root, 'responses', 'Question'), 403)
  await json(await postNative(f.send, 'responses', 'Question', { model: roster[1].model }), 404, 'no_matching_upstream')
  await json(await postNative(f.send, 'responses', 'Question', { tools: [{ type: 'web_search' }] }), 501, 'tools_unsupported')
  await json(await postNative(f.send, 'responses', 'Question', { tools: tools.responses, store: true }), 501, 'rich_persistence_unsupported')
  await json(await postNative(f.send, 'messages', 'Question', { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://unused.test/' } }] }] }), 501, 'non_text_input_unsupported')
  await json(await f.send('/gateway/admin/tools'), 501, 'tools_unsupported')
  await json(await post(f.send, `${gateway}/messages/count_tokens`, { model: roster[1].model, messages: [{ role: 'user', content: 'Question' }] }), 501, 'token_count_unavailable')
  assert.deepEqual(await f.calls(), [])
  let invoked = 0
  for (const protocol of ['responses', 'messages']) {
    for (const [mode, code] of [['eof', 'stream_incomplete'], ['error', 'upstream_error'], ...(protocol === 'responses' ? [['amend', 'invalid_stream']] : [])]) {
      const stream = sse(await postNative(f.send, protocol, `fixture-${mode}`, { stream: true, ...(protocol === 'responses' && { store: true }) }))
      const first = await stream.first(), ended = await stream.end()
      assert.equal(successes(ended).length, 0)
      assert.equal(ended.at(-1).data.code ?? ended.at(-1).data.error.code, code)
      assert.doesNotMatch(JSON.stringify(ended), /fixture private error/)
      if (protocol === 'responses') await json(await f.send(`${gateway}/responses/${first[0].data.response.id}`), 404, 'response_unknown')
      invoked++
    }
    await json(await postNative(f.send, protocol, 'fixture-redirect'), 502, 'upstream_error')
    await json(await postNative(f.send, protocol, 'fixture-secret'), 502, 'upstream_error')
    invoked += 2
  }
  assert.equal((await f.calls()).length, invoked, 'no redirect or fallback')
})

test('F5 native absent, missing credential, malformed roster, or streaming off stays closed', { timeout: 18_000 }, async t => {
  for (const [opts, status, code] of [[{ native: null }, 503, 'generation_unavailable'], [{ missing: true }, 404, 'no_matching_upstream'],
    [{ native: JSON.stringify([{ ...roster[1], api_base: openai }]) }, 503, 'generation_unavailable'],
    [{ streaming: false }, 501, 'streaming_unavailable']]) {
    const f = await fixture(t, opts)
    await json(await postNative(f.send, 'messages', 'Question', { stream: true }), status, code)
    assert.deepEqual(await f.calls(), [])
  }
})

test('F5 native Data revocation cancels the blocked producer and prevents terminal publication', { timeout: 12_000 }, async t => {
  const f = await fixture(t)
  const path = `/api/v1/admin/accounts/${admin.accountId}/users`
  const managed = await json(await post(f.admin, path, { user_id: 'revoked-member' }))
  const send = (url, options = {}) => f.anonymous(url, { ...options, headers: { ...options.headers, 'x-api-key': managed.user_key } })
  const stream = sse(await postNative(send, 'responses', 'fixture-held', { stream: true, store: true, instructions: 'hold-openai' }))
  const first = await stream.first()
  assert.deepEqual(first.map(delta).filter(Boolean), ['Marée 🌊'])
  assert.deepEqual(await f.state('responses'), { released: false, tail: false, cancelled: false })
  await json(await f.admin(`${path}/revoked-member`, { method: 'DELETE' }), 202)
  const frames = await stream.end()
  assert.equal(successes(frames).length, 0)
  assert.equal(frames.at(-1).data.code, 'openviking_key_invalid')
  for (let i = 0; i < 40 && !(await f.state('responses')).cancelled; i++) await delay(30)
  assert.deepEqual(await f.state('responses'), { released: false, tail: false, cancelled: true })
  await json(await send(`${gateway}/responses/${first[0].data.response.id}`), 401)
  assert.equal((await f.calls()).length, 1)
})
