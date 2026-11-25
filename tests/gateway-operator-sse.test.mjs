// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const openai = 'https://api.openai.com/v1', ollama = 'https://inference.example.test/v1'
const officialModel = 'gpt-4o-mini', ollamaModel = 'llama3.2:3b'
const base = '/gateway/v1', config = '/api/v1/admin/configuration/import'
const root = testPrincipal('operator-bootstrap', 'root', 'root')
const owner = testPrincipal('operator-tenant', 'owner', 'admin')
const member = testPrincipal(owner.accountId, 'member')
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const route = { chat: 'chat/completions', responses: 'responses', messages: 'messages' }
const streamBody = (protocol, model, prompt, store = false) => ({ model, stream: true,
  ...(protocol === 'responses' ? { input: prompt, max_output_tokens: 220, store } : {
    messages: [{ role: 'user', content: prompt }], max_tokens: 220,
    ...(protocol === 'chat' && { stream_options: { include_usage: true } }),
  }),
})
const run = (send, protocol, model, prompt, headers, store) => post(send, `${base}/${route[protocol]}`, streamBody(protocol, model, prompt, store), headers)
const vlm = (model = ollamaModel, more = {}) => ({ ...(model === officialModel ? { provider: 'openai' } : { provider: 'ollama', api_base: ollama }),
  model, max_tokens: 96, timeout: 5, ...more })

async function json(response, status = 200, reason) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  const value = await response.json()
  if (reason) assert.equal(value.reason, reason)
  return value.result ?? value
}

async function fixture(t, enabled = true) {
  const absWorkingDir = fileURLToPath(new URL('..', import.meta.url))
  const bundle = async entry => (await build({ absWorkingDir, entryPoints: [entry], platform: 'browser', format: 'esm', bundle: true,
    write: false, external: ['cloudflare:workers'] })).outputFiles[0].text
  const [app, provider] = await Promise.all([bundle('src/worker.ts'), bundle('tests/gateway/operator-http-fixture.mjs')])
  const [openaiKey, compatibleKey] = Array.from({ length: 2 }, () => randomBytes(24).toString('hex'))
  const service = 'operator-http-provider'
  const common = { modules: true, compatibilityDate: '2026-11-19' }
  const product = { ...common, script: app, name: 'operator-edge', outboundService: service,
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root, owner, member]), ...(enabled && { OPENVIKING_EDGE_OPERATOR_STREAMING: '1' }),
      OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: openai, api_key: openaiKey }, { api_base: ollama, api_key: compatibleKey }]) },
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
  }
  const mock = { ...common, script: provider, name: service,
    durableObjects: { PROVIDER: { className: 'Provider', useSQLite: true } },
    outboundService: () => new Response(null, { status: 599 }),
    bindings: { FIXTURE_OPENAI_KEY: openaiKey, FIXTURE_COMPATIBLE_KEY: compatibleKey },
  }
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false,
    workers: [product, mock], log: new Log(LogLevel.ERROR) }))
  t.after(() => runtime.dispose())
  const stub = await runtime.getWorker(service)
  async function inspect(path, name, method) {
    const url = new URL(`https://fixture-control.invalid/${path}`)
    if (name) url.searchParams.set('name', name)
    return (await stub.fetch(url, { method })).json()
  }
  return { runtime, asRoot: api(runtime, root), admin: api(runtime, owner), send: api(runtime, member),
    state: name => inspect('state', name), release: name => inspect('release', name, 'POST'), calls: () => inspect('calls') }
}

function parse(raw) {
  assert.ok(raw.endsWith('\n\n'))
  return raw.trimEnd().split('\n\n').map(frame => {
    const lines = frame.split('\n')
    const event = lines.find(line => line.startsWith('event: '))?.slice(7)
    const payload = lines.find(line => line.startsWith('data: ')).slice(6)
    return { event, value: payload === '[DONE]' ? payload : JSON.parse(payload) }
  })
}
const delta = record => record.event === 'response.output_text.delta' ? record.value.delta :
  record.event === 'content_block_delta' ? record.value.delta.text : record.value.choices?.[0]?.delta.content
const successes = records => records.filter(record => record.value === '[DONE]' || ['message_stop', 'response.completed'].includes(record.event))

function reader(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(response.headers.get('x-origin-marker'), null)
  const stream = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let raw = ''
  const more = async () => {
    const part = await stream.read()
    raw += decoder.decode(part.value, { stream: !part.done })
    return !part.done
  }
  return {
    async first() {
      while (!raw.includes('Marée 🌊') || !raw.endsWith('\n\n')) assert.ok(await more(), 'no first delta on the HTTP body')
      const records = parse(raw)
      assert.deepEqual(records.map(delta).filter(Boolean), ['Marée 🌊'])
      assert.equal(successes(records).length, 0)
      return records
    },
    async end() { while (await more()) {} return parse(raw) },
  }
}

async function producerCancelled(fixture, name) {
  for (let i = 0; i < 40; i++) {
    const state = await fixture.state(name)
    if (state.cancelled) { assert.deepEqual(state, { released: false, tail: false, cancelled: true }); return }
    await delay(30)
  }
  assert.fail(`Outbound service did not observe cancellation for ${name}`)
}

test('HTTP operator SSE: both providers yield the first delta before release over Chat, Responses and Messages', { timeout: 18_000 }, async t => {
  const f = await fixture(t)
  for (const model of [officialModel, ollamaModel]) {
    await json(await post(f.asRoot, config, { vlm: vlm(model) }))
    assert.equal((await json(await f.send('/gateway/admin/access'))).edge.streaming, true)
    const alias = 'fixture-alias'
    for (const protocol of ['chat', 'responses', 'messages']) {
      const prompt = `held ${model} ${protocol}`
      if (protocol === 'chat') {
        const path = '/gateway/admin/upstreams/fixture-chat'
        await json(await f.admin(path, { method: 'PUT', body: { name: 'Fixture chat', binding: 'operator', protocol, models: [model], aliases: { [alias]: model } } }))
        assert.equal((await json(await f.send(`${base}/models`))).data.some(item => item.id === alias), true)
      }
      const response = await run(f.send, protocol, protocol === 'chat' ? alias : model, prompt, { 'x-fixture-client-only': 'do not forward' }, protocol === 'responses')
      const chunks = reader(response), opening = await chunks.first()
      assert.deepEqual(await f.state(prompt), { released: false, tail: false, cancelled: false })
      assert.equal((await f.release(prompt)).released, true)
      const events = await chunks.end()
      assert.deepEqual(events.map(delta).filter(Boolean), ['Marée 🌊', ' haute'])
      assert.equal(successes(events).length, 1)
      assert.equal((await f.state(prompt)).tail, true)
      if (protocol === 'chat') {
        assert.equal(events.at(-1).value, '[DONE]')
        assert.equal(opening[0].value.model, alias)
        if (model === officialModel) assert.deepEqual(events.at(-2).value.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 })
        await json(await f.admin('/gateway/admin/upstreams/fixture-chat', { method: 'DELETE' }))
      } else if (protocol === 'responses') {
        const final = events.at(-1).value.response
        assert.equal(events.at(-1).event, 'response.completed')
        assert.deepEqual(events.map(event => event.value.sequence_number), [...events.keys()])
        assert.equal(final.output[0].content[0].text, 'Marée 🌊 haute')
        assert.deepEqual(await json(await f.send(`${base}/responses/${final.id}`)), final)
        if (model === officialModel) assert.deepEqual(final.usage, { input_tokens: 7, output_tokens: 4, total_tokens: 11 })
      } else {
        assert.equal(events.at(-1).event, 'message_stop')
        assert.equal(events.at(-2).value.delta.stop_reason, 'end_turn')
        if (model === officialModel) assert.deepEqual(events.at(-2).value.usage, { input_tokens: 7, output_tokens: 4 })
      }
      if (model === ollamaModel) assert.doesNotMatch(JSON.stringify(events), /"usage"/)
    }
  }
  const calls = await f.calls()
  assert.equal(calls.length, 6)
  for (const [i, call] of calls.entries()) {
    assert.equal(call.url, `${i < 3 ? openai : ollama}/chat/completions`)
    assert.equal(call.accept, 'text/event-stream')
    assert.equal(call.accepted, true)
    assert.equal(call.forwardedKey || call.forwardedOption, false)
    assert.equal(call.body.model, i < 3 ? officialModel : ollamaModel)
    assert.equal(call.body.stream, true)
    assert.equal(call.body[i < 3 ? 'max_completion_tokens' : 'max_tokens'], 96)
    assert.deepEqual(call.body.stream_options, i < 3 ? { include_usage: true } : undefined)
    assert.equal(call.body.messages.length, 1, 'no implicit tenant context on either provider')
  }
})

test('HTTP operator SSE defaults closed; a refused model never calls non-stream or any outbound route', { timeout: 12_000 }, async t => {
  const off = await fixture(t, false)
  await json(await post(off.asRoot, config, { vlm: vlm() }))
  assert.equal((await json(await off.send('/gateway/admin/access'))).edge.streaming, false)
  await json(await run(off.send, 'chat', ollamaModel, 'normal'), 501, 'streaming_unavailable')
  assert.deepEqual(await off.calls(), [])
  const f = await fixture(t)
  await json(await post(f.asRoot, config, { vlm: vlm() }))
  await json(await run(f.send, 'chat', 'not-in-inventory', 'normal'), 404, 'no_matching_upstream')
  await json(await run(f.send, 'chat', ollamaModel, 'normal', { 'x-openviking-context': '{"recall":true}' }), 403, 'context_override_not_allowed')
  await json(await run(f.asRoot, 'chat', ollamaModel, 'normal'), 403)
  await json(await run(api(f.runtime), 'chat', ollamaModel, 'normal'), 401)
  assert.deepEqual(await f.calls(), [])
})

test('HTTP operator SSE has safe pre-header errors and terminal typed failures, without redirect or replay', { timeout: 15_000 }, async t => {
  const f = await fixture(t)
  await json(await post(f.asRoot, config, { vlm: vlm() }))
  for (const [prompt, reason] of [['redirect', 'upstream_error'], ['json', 'upstream_error'], ['failed opening', 'upstream_error'], ['bad frame', 'invalid_stream']]) {
    const result = await json(await run(f.send, 'chat', ollamaModel, prompt), 502, reason)
    assert.doesNotMatch(JSON.stringify(result), /Private provider diagnostic|other\.example/)
  }
  for (const [protocol, prompt, code] of [['chat', 'eof', 'stream_incomplete'], ['messages', 'sse error', 'upstream_error'], ['responses', 'wire limit', 'stream_limit']]) {
    const response = await run(f.send, protocol, ollamaModel, prompt, undefined, true)
    const events = await reader(response).end()
    assert.equal(successes(events).length, 0)
    assert.ok(events.some(event => delta(event) === 'Marée 🌊'))
    assert.equal(events.at(-1).value.code ?? events.at(-1).value.error.code, code)
    assert.doesNotMatch(JSON.stringify(events), /Private provider diagnostic/)
  }
  const limited = await reader(await run(f.send, 'responses', ollamaModel, 'length', undefined, true)).end()
  assert.equal(limited.at(-1).event, 'response.incomplete')
  await json(await f.send(`${base}/responses/${limited.at(-1).value.response.id}`), 404, 'response_unknown')
  const calls = await f.calls()
  assert.equal(calls.length, 8)
  assert.ok(calls.every(call => call.url === `${ollama}/chat/completions` && call.body.stream === true))
})

test('HTTP operator SSE: TCP disconnect cancels the held outbound body and frees the conversation', { timeout: 13_000 }, async t => {
  const f = await fixture(t)
  await json(await post(f.asRoot, config, { vlm: vlm() }))
  const where = await f.runtime.ready
  assert.equal(where.hostname, '127.0.0.1')
  const prompt = 'held disconnect', session = { 'x-openviking-session': 'tcp-cancel' }
  const payload = JSON.stringify(streamBody('chat', ollamaModel, prompt))
  const incoming = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL(`${base}/chat/completions`, where), { method: 'POST', agent: false,
      headers: { ...session, 'x-api-key': member.key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, resolve)
    request.on('error', reject)
    request.end(payload)
  })
  t.after(() => incoming.destroy())
  const response = new Response(Readable.toWeb(incoming), { headers: incoming.headers, status: incoming.statusCode })
  await reader(response).first()
  await json(await run(f.send, 'chat', ollamaModel, 'another still held', session), 409, 'conversation_busy')
  incoming.socket.resetAndDestroy()
  await producerCancelled(f, prompt)
  assert.equal(successes(await reader(await run(f.send, 'chat', ollamaModel, 'next turn', session)).end()).length, 1)
  const log = (await json(await f.send('/gateway/admin/logs'))).find(row => row.request_id === response.headers.get('x-openviking-request-id'))
  assert.equal(log.status, 499)
  assert.equal(log.capture_messages, undefined)
  assert.deepEqual((await f.calls()).map(call => call.body.messages.at(-1).content), [prompt, 'next turn'])
})

test('HTTP operator SSE: dry-run/no-op leave a held turn alive, effective import and Data revocation close it before further output', { timeout: 18_000 }, async t => {
  const f = await fixture(t)
  const file = { vlm: vlm() }
  await json(await post(f.asRoot, `${config}?if_revision=0`, file))
  await json(await f.admin('/gateway/admin/policies/default', { method: 'PUT', body: { name: 'Explicit raw capture', capture: true } }))
  const name = 'held new configuration'
  const res = await run(f.send, 'responses', ollamaModel, name, undefined, true)
  const stream = reader(res), opening = await stream.first(), id = opening[0].value.response.id
  assert.equal((await json(await post(f.asRoot, `${config}?dry_run=true&if_revision=1`, { default_search_limit: 1 }))).revision, 1)
  assert.equal((await json(await post(f.asRoot, `${config}?if_revision=1`, file))).revision, 1)
  assert.deepEqual(await f.state(name), { released: false, tail: false, cancelled: false })
  assert.equal((await json(await post(f.asRoot, `${config}?if_revision=1`, { default_search_limit: 1 }))).revision, 2)
  const error = await stream.end()
  assert.equal(error.at(-1).value.code, 'gateway_configuration_changed')
  assert.equal(successes(error).length, 0)
  await producerCancelled(f, name)
  await json(await f.send(`${base}/responses/${id}`), 404, 'response_unknown')
  assert.deepEqual(await json(await f.send('/api/v1/sessions')), [])

  const path = `/api/v1/admin/accounts/${owner.accountId}/users`
  const managed = await json(await post(f.admin, path, { user_id: 'managed-member' }))
  const key = { key: managed.user_key }
  const managedSend = api(f.runtime, key)
  const pending = await run(managedSend, 'responses', ollamaModel, 'held revoked', undefined, true)
  const held = reader(pending), started = await held.first()
  await json(await f.admin(`${path}/managed-member`, { method: 'DELETE' }), 202)
  const stopped = await held.end()
  assert.equal(stopped.at(-1).value.code, 'openviking_key_invalid')
  assert.equal(successes(stopped).length, 0)
  await producerCancelled(f, 'held revoked')
  await json(await managedSend(`${base}/responses/${started[0].value.response.id}`), 401)
  // The fixture reads only counts; it never dereferences the revoked data identity.
  assert.equal((await f.calls()).length, 2)
})

test('HTTP operator SSE uses the shorter configured provider deadline and aborts the body', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await json(await post(f.asRoot, config, { vlm: vlm(ollamaModel, { timeout: 1 }) }))
  const stream = reader(await run(f.send, 'chat', ollamaModel, 'held deadline'))
  await stream.first()
  const events = await stream.end()
  assert.equal(events.at(-1).value.error.code, 'upstream_timeout')
  assert.equal(successes(events).length, 0)
  await producerCancelled(f, 'held deadline')
})

test('HTTP operator Responses history follows its admitted destination, not just the model spelling', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  await json(await post(f.asRoot, config, { vlm: vlm(officialModel) }))
  const stored = await reader(await run(f.send, 'responses', officialModel, 'normal', undefined, true)).end()
  const { id } = stored.at(-1).value.response
  const resume = () => post(f.send, `${base}/responses`, { ...streamBody('responses', officialModel, 'follow up'), previous_response_id: id })
  assert.equal(successes(await reader(await resume()).end()).length, 1)
  assert.equal((await f.calls()).at(-1).body.messages.length, 3)
  await json(await post(f.asRoot, config, { vlm: vlm(officialModel, { provider: 'openai-compatible', api_base: ollama }) }))
  await json(await f.send(`${base}/responses/${id}`)) // The rightful owner can still read it.
  await json(await resume(), 403, 'response_upstream_disallowed')
  assert.equal((await f.calls()).length, 2)
})
