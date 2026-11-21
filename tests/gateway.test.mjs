// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'
import { fixtureWorker } from './gateway/local.mjs'

const base = '/gateway/v1'
const adminBase = '/gateway/admin'
const workers = '@cf/meta/llama-3.1-8b-instruct'
const aliases = (model = workers) => ({ 'harbor-chat': model })
const chatBody = (model, text) => ({ model, messages: [{ role: 'user', content: text }], max_tokens: 41 })
const chat = (send, model, text, headers = {}) => send(`${base}/chat/completions`, { method: 'POST', body: chatBody(model, text), headers })
const put = (send, path, body) => send(adminBase + path, { method: 'PUT', body })
const access = send => send(`${adminBase}/access`).then(response => json(response))
const profile = (send, data) => put(send, '/policies/default', data).then(response => json(response))
const drop = (send, path) => send(adminBase + path, { method: 'DELETE' }).then(response => json(response))
const textOf = body => body.choices[0].message.content
const md = (send, uri, content) => send('/api/v1/content/write', { method: 'POST', body: { uri, content, mode: 'create', wait: true } }).then(response => json(response))
const session = (send, id, path = '') => send(`/api/v1/sessions/${id}${path}`)

const streamRequest = (send, protocol, text, headers = {}, extras = {}) => {
  const path = protocol === 'chat' ? '/gateway/v1/chat/completions' : protocol === 'responses' ? '/gateway/api/v3/responses' :
    '/gateway/api/compatible/v1/messages'
  const payload = protocol === 'chat' ? { ...chatBody(workers, text), stream_options: { include_usage: true } } :
    protocol === 'responses' ? { model: workers, input: text, max_output_tokens: 41, store: false } :
    { ...chatBody(workers, text) }
  return send(path, { method: 'POST', body: { ...payload, ...extras, stream: true }, headers })
}

function sseEvents(raw) {
  assert.ok(raw.endsWith('\n\n'), 'wire ends on a complete SSE frame')
  return raw.trimEnd().split('\n\n').map(record => {
    const lines = record.split('\n')
    const event = lines.find(line => line.startsWith('event: '))?.slice(7)
    const data = lines.find(line => line.startsWith('data: '))?.slice(6)
    assert.ok(data)
    return { event, value: data === '[DONE]' ? data : JSON.parse(data) }
  })
}

function sseReader(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream\b/)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let raw = ''
  return {
    async firstDelta(match) {
      while (!match(raw)) {
        const next = await reader.read()
        assert.equal(next.done, false, raw)
        raw += decoder.decode(next.value, { stream: true })
      }
      return raw
    },
    async end() {
      for (;;) {
        const next = await reader.read()
        if (next.done) return sseEvents(raw + decoder.decode())
        raw += decoder.decode(next.value, { stream: true })
      }
    },
    cancel: () => reader.cancel(),
  }
}

const streamState = async (binding, mode) => JSON.parse(await binding.fixtureStreamState(mode))
const streamActor = ({ accountId, userId, agentId }) => ({ accountId, userId, agentId })

test('PAR-06 SSE admission keeps bounded expiring markers without blocking another admitted user', async () => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../src/gateway/stream.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false })
  const { StreamRegistry } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
  const registry = new StreamRegistry({ tombstones: 2, perUser: 2, ttlMs: 20 })
  const a = { accountId: 'fixture', userId: 'first-reader', agentId: 'main' }
  const alternate = { ...a, agentId: 'alternate' }
  const b = { ...a, userId: 'second-reader' }
  const ids = ['1', '2', '3', '4', '5'].map(suffix => `00000000-0000-4000-8000-00000000000${suffix}`)
  const [first, second, third, nextB, fresh] = ids
  const aborted = { status: 499, code: 'client_disconnected' }
  const perUser = new StreamRegistry({ tombstones: 3, perUser: 1, ttlMs: 20 })
  perUser.cancel(first, a, 100)
  perUser.cancel(nextB, b, 101)
  perUser.cancel(second, alternate, 102)
  assert.doesNotThrow(() => perUser.admit(first, a, 102), 'the per-user limit applies below workspace capacity, across agents')
  assert.throws(() => perUser.admit(second, alternate, 102), aborted)
  assert.throws(() => perUser.admit(nextB, b, 102), aborted)
  registry.cancel(first, a, 100)
  registry.cancel(second, alternate, 101)
  registry.cancel(first, a, 102) // Duplicate does not jump the queue.
  registry.cancel(third, a, 103)
  assert.doesNotThrow(() => registry.admit(fresh, b, 103), 'a full marker set does not prevent peer admission')
  assert.doesNotThrow(() => registry.admit(first, a, 103), 'oldest marker was recycled')
  assert.throws(() => registry.admit(second, alternate, 103), aborted)
  assert.doesNotThrow(() => registry.admit(second, a, 103), 'pre-abort does not cross agents')
  assert.doesNotThrow(() => registry.admit(third, b, 103), 'UUID alone cannot pre-abort a different actor')
  registry.cancel(nextB, b, 104) // B has no own marker to recycle at this point.
  assert.doesNotThrow(() => registry.admit(second, alternate, 104), 'workspace FIFO evicted its oldest marker')
  registry.cancel(first, alternate, 105) // Still the first user's allowance, not B's.
  assert.throws(() => registry.admit(nextB, b, 105), aborted, 'churn prefers the same user at the global cap')
  assert.doesNotThrow(() => registry.admit(third, a, 105))
  registry.cancel(nextB, b, 123)
  assert.throws(() => registry.admit(nextB, b, 123), aborted)
  assert.doesNotThrow(() => registry.admit(nextB, b, 124), 'duplicates cannot extend the TTL')
  let notifications = 0
  const unregister = registry.register(fresh, b, () => { notifications++ }, 200, 124)
  registry.cancel(fresh, a, 125)
  registry.cancel(fresh, { ...b, agentId: 'alternate' }, 125)
  registry.cancel(fresh, { ...b, accountId: 'different' }, 125)
  assert.equal(notifications, 0)
  registry.cancel(fresh, b, 126)
  assert.equal(notifications, 1)
  unregister()
  assert.doesNotThrow(() => registry.admit(fresh, b, 126))
})

async function tcpStream(runtime, principal, text, headers = {}) {
  const local = await runtime.ready
  assert.equal(local.hostname, '127.0.0.1')
  const requestBody = JSON.stringify({ ...chatBody(workers, text), stream: true })
  const incoming = await new Promise((resolve, reject) => {
    const req = httpRequest(new URL(`${base}/chat/completions`, local), { method: 'POST', agent: false,
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody),
        'x-api-key': principal.key } }, resolve)
    req.on('error', reject)
    req.end(requestBody)
  })
  return { response: new Response(Readable.toWeb(incoming), { headers: incoming.headers, status: incoming.statusCode }),
    abort: () => incoming.socket.resetAndDestroy() }
}

async function json(response, status = 200) {
  const raw = await response.text()
  assert.equal(response.status, status, raw)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  return JSON.parse(raw)
}

async function reason(response, status, code) {
  const value = await json(response, status)
  assert.equal(value.reason, code)
  assert.equal(typeof value.detail, 'string')
  if (value.request_id) assert.equal(value.request_id, response.headers.get('x-openviking-request-id'))
  return value
}

function fixtureNames() {
  return { a: testPrincipal('navigation-fixture', 'owner', 'admin'), b: testPrincipal('other-fixture', 'owner', 'admin'),
    u: testPrincipal('navigation-fixture', 'reader'), uOther: testPrincipal('other-fixture', 'reader'),
    alt: testPrincipal('navigation-fixture', 'reader', 'user', 'alt'), r: testPrincipal('control-fixture', 'bootstrap', 'root') }
}

test('Gateway is discoverable with the production helper but generation is honestly unavailable without a binding', async t => {
  const { a, u, r } = fixtureNames()
  const worker = await localWorker({ principals: [a, u, r] })
  t.after(() => worker.dispose())
  const user = api(worker, u)
  const view = await access(user)
  assert.equal(view.edge.version, '0.2.0')
  assert.equal(view.edge.generation_configured, false)
  assert.equal(view.can_write_objects, false)
  assert.equal(view.edge.dedicated_gateway_keys, false)
  assert.deepEqual(view.warnings, ['generation_unavailable'])
  assert.equal((await access(api(worker, a))).can_write_objects, true)
  await reason(await user(`${base}/models`), 503, 'generation_unavailable')
  await reason(await chat(user, workers, 'ordinary fixture prompt'), 503, 'generation_unavailable')
  assert.equal((await api(worker)(`${base}/models`)).status, 401)
  assert.equal((await api(worker, r)(`${adminBase}/access`)).status, 403)
  assert.equal((await api(worker, r)(`${base}/models`)).status, 403)
  assert.equal((await user('/v1/models')).status, 404)
  const probe = await json(await api(worker, a)(`${adminBase}/upstreams`))
  assert.ok(probe.length >= 1 && probe.every(item => !item.binding_configured && !item.has_api_key))
})

test('Profiles with the exact same ID, revisions and management scopes survive a workerd/SQLite restart', async t => {
  const names = fixtureNames()
  const principals = Object.values(names)
  const persist = await mkdtemp(join(tmpdir(), 'ov-gateway-'))
  let active
  t.after(async () => { if (active) await active.close(); await rm(persist, { recursive: true, force: true }) })
  active = await fixtureWorker(null, { principals, persist })
  const first = api(active.runtime, names.a), second = api(active.runtime, names.b), reader = api(active.runtime, names.u)
  assert.deepEqual(await json(await reader(`${adminBase}/policies`)), [])
  const a = await profile(first, { name: 'Harbor first', recall: true, context_types: ['memory', 'resource'] })
  const b = await profile(second, { name: 'Harbor second', capture: true })
  assert.equal(a.id, b.id)
  assert.equal(a.revision, 1)
  assert.equal(b.revision, 1)
  await reason(await put(reader, '/policies/default', { name: 'Reader edit' }), 403, 'forbidden')
  await reason(await reader(`${adminBase}/policies/default?account_id=other-fixture`), 403, 'other_account')
  await reason(await put(first, '/policies/default', { recall: 'true' }), 422, 'invalid_configuration')
  await reason(await put(first, '/policies/default', { gateway_tools: true }), 501, 'profile_setting_unsupported')
  assert.equal((await profile(first, { ...a, name: 'Harbor revised', revision: 99 })).revision, 2)
  await active.close()
  active = null
  active = await fixtureWorker(null, { principals, persist })
  const readA = api(active.runtime, names.u), readB = api(active.runtime, names.uOther)
  assert.equal((await json(await readA(`${adminBase}/policies/default`))).name, 'Harbor revised')
  assert.deepEqual(await json(await readB(`${adminBase}/policies/default`)), b)
  assert.deepEqual(await drop(api(active.runtime, names.a), '/policies/default'), { deleted: true })
  await reason(await readA(`${adminBase}/policies/default`), 404, 'not_found')
  assert.deepEqual(await json(await readB(`${adminBase}/policies/default`)), b)
})

test('Gateway completes text turns in all three protocol envelopes on canonical embedded prefixes', async t => {
  const { a, u } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, u] })
  const send = api(runtime, u)
  const paths = ['/gateway/v1', '/gateway/api/v3', '/gateway/api/compatible/v1']
  for (const prefix of paths) {
    const catalog = await json(await send(`${prefix}/models`))
    assert.deepEqual(catalog, { object: 'list', data: [{ id: workers, object: 'model', owned_by: 'openviking-gateway' }] })
  }
  const reply = await chat(send, workers, 'map the fictional harbor', { authorization: `Bearer ${u.key}` })
  const value = await json(reply)
  assert.equal(reply.headers.get('x-openviking-capture'), 'disabled')
  assert.equal(reply.headers.get('x-openviking-recall'), 'disabled')
  assert.match(value.id, /^chatcmpl-/)
  assert.equal(value.model, workers)
  assert.equal(textOf(value), 'Workers AI fixture (41): map the fictional harbor')
  assert.deepEqual(value.usage, { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 })
  const responses = await json(await send(`${paths[1]}/responses`, { method: 'POST', body: {
    model: workers, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'map the river' }] }],
    instructions: 'Short response.', max_output_tokens: 26, store: false,
  } }))
  assert.equal(responses.status, 'completed')
  assert.equal(responses.output[0].content[0].text, 'Workers AI fixture (26): map the river')
  assert.equal(responses.usage.total_tokens, 23)
  const msg = await json(await send(`${paths[2]}/messages`, { method: 'POST', body: {
    model: workers, max_tokens: 19, system: [{ type: 'text', text: 'Answer briefly.' }], messages: [{ role: 'user',
      content: [{ type: 'text', text: 'map' }, { type: 'text', text: 'the coast' }] }],
  } }))
  assert.equal(msg.type, 'message')
  assert.equal(msg.content[0].text, 'Workers AI fixture (19): map\nthe coast')
  assert.deepEqual(msg.usage, { input_tokens: 17, output_tokens: 6 })
  await reason(await send(`${base}/messages/count_tokens`, { method: 'POST', body: { model: workers, messages: [{ role: 'user', content: 'hello' }] } }),
    501, 'token_count_unavailable')
})

test('Operator inventory, protocol match, priority and alias actually select the invoker and optional tokenizer', async t => {
  const a = testPrincipal('operator-fixture', 'owner', 'admin')
  const u = testPrincipal('operator-fixture', 'reader')
  const outside = testPrincipal('no-operator-fixture', 'owner', 'admin')
  const { runtime } = await fixtureWorker(t, { principals: [a, u, outside], embeddings: false, generate: false })
  const admin = api(runtime, a), user = api(runtime, u), other = api(runtime, outside)
  const rule = (model, priority, extra = {}) => ({ name: `Fixture ${model}`, protocol: 'chat', binding: 'operator', models: [model],
    aliases: aliases(model), priority, ...extra })
  const red = rule('local/red', 5), blue = rule('local/blue', 10)
  assert.equal((await json(await put(admin, '/upstreams/red', red))).base_url, 'binding://operator')
  await json(await put(admin, '/upstreams/blue', blue))
  await reason(await put(other, '/upstreams/red', red), 422, 'invalid_configuration')
  await reason(await put(admin, '/upstreams/outside', rule('local/not-configured', 12)), 422, 'invalid_configuration')
  await json(await put(admin, '/upstreams/count', { ...blue, protocol: 'anthropic' }))
  assert.deepEqual((await json(await user(`${base}/models`))).data.map(item => item.id), ['harbor-chat', 'local/blue', 'local/red'])
  const first = await json(await chat(user, 'harbor-chat', 'selected blue'))
  assert.equal(textOf(first), 'Operator fixture local/blue: selected blue')
  assert.equal(first.usage, undefined)
  await json(await put(admin, '/upstreams/blue', { ...blue, enabled: false }))
  assert.equal(textOf(await json(await chat(user, 'harbor-chat', 'selected red'))), 'Operator fixture local/red: selected red')
  await reason(await user(`${base}/responses`, { method: 'POST', body: { model: 'harbor-chat', input: 'Wrong protocol.' } }), 404, 'no_matching_upstream')
  assert.deepEqual(await json(await user(`${base}/messages/count_tokens`, { method: 'POST', body: { model: 'harbor-chat', system: 'é', messages: [{ role: 'user', content: 'a🌊' }] } })), { input_tokens: 3 })
  const probe = (send, data) => send(`${adminBase}/upstreams/red/test`, { method: 'POST', body: data })
  await reason(await probe(user, { model: 'harbor-chat' }), 403, 'forbidden')
  await reason(await probe(admin, {}), 501, 'connection_test_unavailable')
  assert.deepEqual(await json(await probe(admin, { model: 'harbor-chat' })), { ok: true, kind: 'model', status: 200, reason: 'passed', url: 'binding://operator' })
  await profile(admin, { recall: true, show_recall: true })
  const degraded = await chat(user, 'harbor-chat', 'a long enough query')
  const degradedBody = await json(degraded)
  assert.equal(degraded.headers.get('x-openviking-recall'), 'embedding_unavailable')
  assert.match(textOf(degradedBody), /recall unavailable.*\n\nOperator fixture local\/red/s)
  const stats = await json(await user(`${adminBase}/overview`))
  assert.equal(stats.degradations.embedding_unavailable, 1)
  assert.equal(stats.usage_unknown_requests, 3)
  assert.equal(stats.cache_metrics_available, false)
})

test('Scoped semantic recall and opening profile reach generation, and captured pairs are really archived in the owner session', async t => {
  const { a, b, u, uOther, alt } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, b, u, uOther, alt] })
  const admin = api(runtime, a), user = api(runtime, u), other = api(runtime, uOther), alternative = api(runtime, alt)
  await profile(admin, { name: 'Scoped harbor', recall: true, profile: true, capture: true, show_recall: true,
    client_overrides: true, context_types: ['memory', 'resource'], score_threshold: 0.22, commit_tokens: 1, keep_recent_messages: 0 })
  await md(user, 'viking://~/memories/profile.md', 'OPENER northbound passenger')
  await md(user, 'viking://~/memories/chart.md', 'ALICEOWN sailing harbor compass wind')
  await md(other, 'viking://~/memories/chart.md', 'FOREIGNTENANT sailing harbor compass wind')
  await md(admin, 'viking://~/memories/chart.md', 'ADMINPRIVATE sailing harbor compass wind')
  await md(admin, 'viking://resources/landing.md', 'SHARED sailing harbor compass wind')
  await md(admin, 'viking://resources/permit.md', 'RESTRICTED sailing harbor compass wind')
  await json(await admin('/api/v1/acl', { method: 'PUT', body: {
    uri: 'viking://resources/permit.md', acl_mode: 'restricted', entries: [{ principal: 'user:owner', level: 'read' }],
  } }))
  const header = { 'x-openviking-session': 'same-fixture-conversation' }
  const first = await chat(user, workers, 'sailing harbor compass', header)
  const output = textOf(await json(first))
  assert.match(output, /^> OpenViking recall: 2 item\(s\)/)
  assert.match(output, /untrusted reference data.*OPENER northbound passenger.*ALICEOWN/s)
  assert.match(output, /SHARED/)
  assert.doesNotMatch(output, /FOREIGNTENANT|ADMINPRIVATE|RESTRICTED/)
  assert.equal(first.headers.get('x-openviking-capture'), 'archived')
  const firstId = first.headers.get('x-openviking-captured-session')
  assert.match(firstId, /^gw-/)
  const archive = (await json(await session(user, firstId, '/archives/archive_001'))).result
  assert.equal(archive.status, 'completed')
  assert.deepEqual(archive.messages.map(message => message.role), ['user', 'assistant'])
  assert.equal(archive.messages[0].parts[0].text, 'sailing harbor compass')
  assert.ok(archive.messages[1].parts[0].text.startsWith('Workers AI fixture (41):'))
  assert.equal((await session(other, firstId)).status, 404)
  assert.equal((await session(alternative, firstId)).status, 404)
  const second = await chat(user, workers, 'second route home', header)
  assert.doesNotMatch(textOf(await json(second)), /OPENER northbound passenger/)
  assert.equal(second.headers.get('x-openviking-captured-session'), firstId)
  assert.equal((await json(await session(user, firstId))).result.total_message_count, 4)
  const narrowed = await chat(user, workers, 'sailing harbor compass', { ...header, 'x-openviking-context': '{"recall":false,"capture":false}' })
  assert.equal(textOf(await json(narrowed)), 'Workers AI fixture (41): sailing harbor compass')
  assert.equal(narrowed.headers.get('x-openviking-capture'), 'disabled')
  await reason(await chat(user, workers, 'sailing harbor compass', { ...header, 'x-openviking-context': '{"max_tokens":2000}' }), 403, 'context_override_not_allowed')
  assert.equal((await json(await session(user, firstId))).result.total_message_count, 4)
  const foreign = await chat(other, workers, 'sailing harbor compass', header)
  assert.equal(textOf(await json(foreign)), 'Workers AI fixture (41): sailing harbor compass')
  assert.equal(foreign.headers.get('x-openviking-captured-session'), null)
  const records = await json(await user(`${adminBase}/logs`))
  assert.deepEqual(records.map(entry => entry.status), [403, 200, 200, 200])
  assert.equal(records.at(-1).recall_count, 2)
  assert.equal(records.at(-1).capture_messages, 2)
  assert.doesNotMatch(JSON.stringify(records), /same-fixture-conversation|ALICEOWN|FOREIGNTENANT|sailing harbor compass|northbound passenger/)
  assert.equal(await api(runtime, b)(`${adminBase}/logs`).then(response => json(response)).then(value => value.length), 1)
})

test('Failure, disabled features and model constraints return typed statuses without decorative generation or secret-bearing errors', async t => {
  const { a, u } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, u] })
  const admin = api(runtime, a), user = api(runtime, u)
  await profile(admin, { recall: true })
  const failure = await reason(await chat(user, workers, 'fixture generation failure'), 502, 'upstream_error')
  assert.doesNotMatch(JSON.stringify(failure), /synthetic provider detail/)
  const fallback = await chat(user, workers, 'fixture embedding failure')
  assert.equal(fallback.headers.get('x-openviking-recall'), 'embedding_unavailable')
  assert.match(textOf(await json(fallback)), /fixture embedding failure$/)
  await reason(await chat(user, workers, 'plain text', { 'x-openviking-context': '{"recall":false}' }), 403, 'context_override_not_allowed')
  await reason(await chat(user, 'not-enabled', 'plain text'), 404, 'no_matching_upstream')
  await reason(await user(`${base}/chat/completions`, { method: 'POST', body: { ...chatBody(workers, 'normal prompt'), stream: true } }), 501, 'streaming_unavailable')
  await reason(await user(`${base}/chat/completions`, { method: 'POST', body: { ...chatBody(workers, 'normal prompt'), tools: [{ type: 'function' }] } }), 501, 'tools_unsupported')
  await reason(await user(`${base}/responses`, { method: 'POST', body: { model: workers, input: 'normal prompt', conversation: 'opaque' } }), 501, 'response_storage_unsupported')
  await reason(await user(`${base}/responses/synthetic-id`), 404, 'response_unknown')
  await reason(await user(`${adminBase}/keys`), 501, 'gateway_keys_unavailable')
  await reason(await admin(`${adminBase}/upstreams/import-vlm`, { method: 'POST' }), 501, 'vlm_import_unavailable')
  await reason(await user(`${adminBase}/tools`), 501, 'tools_unsupported')
  await reason(await user('/gateway/downloads'), 501, 'signed_transfer_unavailable')
  const unavailable = await reason(await put(admin, '/upstreams/unavailable', { name: 'Other', protocol: 'chat', base_url: 'https://unconfigured.example.invalid/v1' }),
    422, 'invalid_configuration')
  assert.doesNotMatch(JSON.stringify(unavailable), /example\.invalid/)
  assert.deepEqual((await json(await user(`${base}/models`))).data.map(item => item.id), [workers])
  const logs = await json(await user(`${adminBase}/logs?limit=5`))
  assert.ok(logs.every(log => log.event === 'request' && !Object.hasOwn(log, 'detail')))
})

test('Optional event extraction follows the native session pipeline; Gateway erasure preserves already published sessions', async t => {
  const { a, b, u, uOther } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, b, u, uOther] })
  const admin = api(runtime, a), otherAdmin = api(runtime, b), user = api(runtime, u), other = api(runtime, uOther)
  const policy = await profile(admin, { capture: true, capture_memory_types: ['events'], commit_tokens: 1, keep_recent_messages: 0 })
  const turnHeader = { 'x-openviking-session': 'fictional-cleanup' }
  const first = await chat(user, workers, 'The synthetic marina cleanup was confirmed.', turnHeader)
  await json(first)
  const firstId = first.headers.get('x-openviking-captured-session')
  assert.equal(first.headers.get('x-openviking-capture'), 'archived')
  const { result: archive } = await json(await session(user, firstId, '/archives/archive_001'))
  assert.equal(archive.memories_extracted, 1)
  const uri = archive.memory_uris[0]
  const readMemory = send => send(`/api/v1/content/read?${new URLSearchParams({ uri })}`)
  assert.match((await json(await readMemory(user))).result, /# Summary\nThe synthetic marina cleanup was confirmed\./)
  assert.equal((await readMemory(other)).status, 404)
  await profile(admin, { ...policy, capture_memory_types: [] })
  const second = await chat(user, workers, 'A fresh turn with raw capture.', turnHeader)
  await json(second)
  const secondId = second.headers.get('x-openviking-captured-session')
  assert.notEqual(secondId, firstId)
  assert.equal((await json(await session(user, secondId))).result.memories_extracted.total, 0)
  await json(await chat(other, workers, 'The other tenant has its own log.'))
  await reason(await user(`${adminBase}/users/reader/data`, { method: 'DELETE' }), 403, 'forbidden')
  assert.deepEqual(await drop(admin, '/users/reader/data'), { deleted: true })
  assert.deepEqual(await json(await user(`${adminBase}/logs`)), [])
  assert.equal((await json(await otherAdmin(`${adminBase}/logs`))).length, 1)
  assert.equal((await json(await session(user, secondId))).result.total_message_count, 2)
  const third = await chat(user, workers, 'After forgetting Gateway state.', turnHeader)
  await json(third)
  assert.notEqual(third.headers.get('x-openviking-captured-session'), secondId)
})

test('SSE emits a real first text delta before the binding is allowed to produce its tail, across all three protocols', { timeout: 18_000 }, async t => {
  const { a, u } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, u], streaming: true })
  const admin = api(runtime, a), send = api(runtime, u)
  const binding = (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${u.accountId}`)
  assert.equal((await access(send)).edge.streaming, true)
  await profile(admin, { capture: true, commit_tokens: 1, keep_recent_messages: 0 })
  for (const protocol of ['chat', 'responses', 'messages']) {
    const response = await streamRequest(send, protocol, 'sse-held', { 'x-openviking-session': 'sse-proof' })
    const reader = sseReader(response)
    const first = await reader.firstDelta(raw => raw.includes('Marée 🌊') && raw.endsWith('\n\n'))
    assert.doesNotMatch(first, /haute|\[DONE\]|message_stop|response.completed/)
    assert.deepEqual(await streamState(binding, 'sse-held'), { released: false, cancelled: false, tail: false }, 'the provider has not generated its second delta')
    assert.ok(await binding.fixtureReleaseStream('sse-held'), 'release provider only after observing bytes at the HTTP client')
    const records = await reader.end()
    assert.deepEqual(await streamState(binding, 'sse-held'), { released: true, cancelled: true, tail: true })
    if (protocol === 'chat') {
      assert.deepEqual(records.map(record => record.value?.choices?.[0]?.delta.content).filter(Boolean), ['Marée 🌊', ' haute'])
      assert.equal(records.at(-3).value.choices[0].finish_reason, 'stop')
      assert.deepEqual(records.at(-2).value.usage, { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 })
      assert.equal(records.at(-1).value, '[DONE]')
    } else if (protocol === 'responses') {
      assert.deepEqual(records.map(record => record.event), ['response.created', 'response.in_progress', 'response.output_item.added',
        'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done',
        'response.content_part.done', 'response.output_item.done', 'response.completed'])
      assert.deepEqual(records.map(record => record.value.sequence_number), [...records.keys()])
      assert.deepEqual(records.filter(record => record.event.endsWith('.delta')).map(record => record.value.delta), ['Marée 🌊', ' haute'])
      assert.equal(records.at(-1).value.response.output[0].content[0].text, 'Marée 🌊 haute')
    } else {
      assert.deepEqual(records.map(record => record.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
        'content_block_stop', 'message_delta', 'message_stop'])
      assert.deepEqual(records.filter(record => record.event === 'content_block_delta').map(record => record.value.delta.text), ['Marée 🌊', ' haute'])
      assert.equal(records.at(-2).value.delta.stop_reason, 'end_turn')
      assert.equal(records.at(-2).value.usage.output_tokens, 6)
    }
    const rid = response.headers.get('x-openviking-request-id')
    const logs = (await json(await send(`${adminBase}/logs`))).filter(log => log.request_id === rid)
    assert.equal(logs.length, 1, 'one terminal log, not an opening success')
    assert.equal(logs[0].stream, true)
    assert.equal(logs[0].capture_messages, 2)
    assert.equal(logs[0].input_tokens, 17)
    assert.equal(logs[0].output_tokens, 6)
    const archived = (await json(await session(send, logs[0].openviking_session, '/archives/archive_001'))).result
    assert.deepEqual(archived.messages.map(message => message.parts[0].text), ['sse-held', 'Marée 🌊 haute'])
  }
  const plain = await chat(send, workers, 'non-streaming stays on its original path')
  assert.match(textOf(await json(plain)), /Workers AI fixture \(41\)/)
  assert.equal(await binding.fixtureQuota(u.userId), 4, 'the same per-user generation ledger counted all four calls')
})

test('SSE provider failures before and after headers stay distinguishable, with no synthetic terminal or saves', { timeout: 18_000 }, async t => {
  const { a, u } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, u], streaming: true })
  const send = api(runtime, u)
  await profile(api(runtime, a), { capture: true })
  await reason(await streamRequest(send, 'chat', 'sse-bad'), 502, 'invalid_stream')
  await reason(await streamRequest(send, 'chat', 'sse-empty'), 502, 'stream_incomplete')
  await reason(await streamRequest(send, 'chat', 'sse-binding-unavailable'), 503, 'generation_unavailable')
  for (const [protocol, payload, code] of [['chat', 'sse-eof', 'stream_incomplete'], ['messages', 'sse-error', 'upstream_error'],
    ['responses', 'sse-big', 'stream_limit'], ['chat', 'sse-invalid-utf', 'invalid_stream']]) {
    const response = await streamRequest(send, protocol, payload)
    const raw = await response.text()
    assert.match(raw, /Marée 🌊/)
    assert.doesNotMatch(raw, /\[DONE\]|response.completed|message_stop|private fixture detail|unframed/)
    const events = sseEvents(raw)
    const last = events.at(-1).value
    assert.equal(last.code ?? last.error?.code, code)
    if (protocol !== 'chat') assert.equal(events.at(-1).event, 'error')
    const log = (await json(await send(`${adminBase}/logs`))).find(log => log.request_id === response.headers.get('x-openviking-request-id'))
    assert.equal(log.stream_error, code)
    assert.equal(log.capture_messages, undefined)
  }
  const noUsage = sseEvents(await (await streamRequest(send, 'chat', 'sse-no-usage')).text())
  assert.equal(noUsage.at(-2).value.choices[0].finish_reason, null)
  assert.ok(noUsage.slice(0, -1).every(record => record.value.usage === null))
  const limited = sseEvents(await (await streamRequest(send, 'responses', 'sse-length')).text())
  assert.equal(limited.at(-1).event, 'response.incomplete')
  assert.equal(limited.at(-1).value.response.incomplete_details.reason, 'max_output_tokens')
})

test('SSE session lease spans the body; cancellation reaches the binding and configuration change stops publication', { timeout: 20_000 }, async t => {
  const { a, b, u, uOther } = fixtureNames()
  const peer = testPrincipal(u.accountId, 'other-reader')
  const { runtime } = await fixtureWorker(t, { principals: [a, b, u, uOther, peer], streaming: true })
  const admin = api(runtime, a), send = api(runtime, u), other = api(runtime, uOther), sendPeer = api(runtime, peer)
  const binding = (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${u.accountId}`)
  await profile(admin, { capture: true })
  const headers = { 'x-openviking-session': 'session-concurrency-proof' }
  const { response: cancelled, abort } = await tcpStream(runtime, u, 'sse-cancel', headers)
  const started = sseReader(cancelled)
  await started.firstDelta(raw => raw.includes('Marée 🌊'))
  await reason(await chat(send, workers, 'other turn in the same session', headers), 409, 'conversation_busy')
  assert.equal((await json(await chat(other, workers, 'same name in the other account', headers))).object, 'chat.completion')
  abort()
  let state
  for (let step = 0; step < 30; step++) {
    state = await streamState(binding, 'sse-cancel')
    if (state.cancelled) break
    await delay(50)
  }
  const notifications = await binding.fixtureAborts()
  assert.deepEqual(state, { released: false, cancelled: true, tail: false }, `downstream cancel reached provider (binding RPC notifications: ${notifications})`)
  assert.equal(notifications, 1)
  assert.deepEqual(JSON.parse(await binding.fixtureAbortActor()), streamActor(u))
  const cancelledLog = (await json(await send(`${adminBase}/logs`))).find(log => log.request_id === cancelled.headers.get('x-openviking-request-id'))
  assert.equal(cancelledLog.client_disconnected, true)
  assert.equal(cancelledLog.status, 499)
  assert.equal(cancelledLog.capture_messages, undefined)
  const uninterrupted = await streamRequest(sendPeer, 'chat', 'sse-normal', headers)
  assert.equal(uninterrupted.status, 200)
  assert.equal(sseEvents(await uninterrupted.text()).at(-1).value, '[DONE]', 'the other admitted user in the same workspace still streams')
  const changed = await streamRequest(send, 'chat', 'sse-reconfigure', headers)
  const reader = sseReader(changed)
  await reader.firstDelta(raw => raw.includes('Marée 🌊'))
  await profile(admin, { capture: false })
  assert.ok(await binding.fixtureReleaseStream('sse-reconfigure'))
  const records = await reader.end()
  assert.equal(records.at(-1).value.error.code, 'gateway_configuration_changed')
  assert.ok(!records.some(record => record.value === '[DONE]' || record.value.choices?.[0]?.delta.content === ' haute'))
})

test('SSE rejects a binding-only pre-abort without generation and times out a stalled provider without committing', { timeout: 22_000 }, async t => {
  const { u } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [u], streaming: true })
  const send = api(runtime, u), binding = (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${u.accountId}`)
  await binding.fixtureArmPreAbort(streamActor(u))
  await reason(await streamRequest(send, 'chat', 'sse-held'), 499, 'client_disconnected')
  assert.equal(await binding.fixtureQuota(u.userId), 0)
  assert.equal(await streamState(binding, 'sse-held'), null)
  const reply = await streamRequest(send, 'chat', 'sse-idle', { 'x-openviking-session': 'idle-boundary' })
  const raw = await reply.text()
  assert.match(raw, /Marée 🌊/)
  assert.doesNotMatch(raw, /\[DONE\]/)
  assert.equal(sseEvents(raw).at(-1).value.error.code, 'upstream_timeout')
  assert.deepEqual(await streamState(binding, 'sse-idle'), { released: false, cancelled: true, tail: false })
  assert.equal((await json(await chat(send, workers, 'same slot is free', { 'x-openviking-session': 'idle-boundary' }))).object, 'chat.completion')
})

test('Responses retention is opt-in, restart-safe, owner-only, and resumes real model input on the same resolved route', { timeout: 20_000 }, async t => {
  const names = fixtureNames(), accounts = Object.values(names)
  const persist = await mkdtemp(join(tmpdir(), 'ov-gateway-responses-'))
  let fixture
  t.after(async () => { if (fixture) await fixture.close(); await rm(persist, { recursive: true, force: true }) })
  fixture = await fixtureWorker(null, { principals: accounts, persist, streaming: true })
  let user = api(fixture.runtime, names.u)
  const paths = ['/gateway/v1/responses', '/gateway/api/v3/responses', '/gateway/api/compatible/v1/responses']
  const post = (send, input, fields = {}) => send(paths[0], { method: 'POST', body: { model: workers, input, ...fields } })
  const unstored = await json(await post(user, 'Fictional ephemeral input.'))
  assert.equal(unstored.store, false)
  await reason(await user(`${paths[0]}/${unstored.id}`), 404, 'response_unknown')
  const first = await json(await post(user, 'first retained turn', { store: true, instructions: 'Do not inherit this instruction.' }))
  assert.equal(first.store, true)
  assert.deepEqual(await json(await user(`${paths[1]}/${first.id}`)), first)
  await fixture.close()
  fixture = null
  fixture = await fixtureWorker(null, { principals: accounts, persist, streaming: true })
  user = api(fixture.runtime, names.u)
  assert.deepEqual(await json(await user(`${paths[2]}/${first.id}`)), first)
  for (const caller of [names.a, names.uOther, names.alt]) {
    const send = api(fixture.runtime, caller)
    await reason(await send(`${paths[0]}/${first.id}`), 404, 'response_unknown')
    await reason(await post(send, 'isolated continuation', { previous_response_id: first.id }), 404, 'response_unknown')
  }
  const continuation = await json(await post(user, 'report fictional history', { previous_response_id: first.id, instructions: 'New instruction.' }))
  assert.deepEqual(JSON.parse(continuation.output[0].content[0].text), [
    { role: 'system', content: 'New instruction.' }, { role: 'user', content: 'first retained turn' },
    { role: 'assistant', content: first.output[0].content[0].text }, { role: 'user', content: 'report fictional history' },
  ])
  assert.equal(continuation.previous_response_id, first.id)
  const stream = await streamRequest(user, 'responses', 'sse-no-usage', {}, { store: true, previous_response_id: first.id })
  const final = sseEvents(await stream.text()).at(-1).value.response
  assert.deepEqual(await json(await user(`${paths[0]}/${final.id}`)), final)
  const limited = await streamRequest(user, 'responses', 'sse-length', {}, { store: true })
  const partial = sseEvents(await limited.text()).at(-1).value.response
  assert.equal(partial.status, 'incomplete')
  await reason(await user(`${paths[0]}/${partial.id}`), 404, 'response_unknown')
  assert.deepEqual(await json(await user(`${paths[1]}/${first.id}`, { method: 'DELETE' })), { id: first.id, object: 'response.deleted', deleted: true })
  await reason(await post(user, 'parent was deleted', { previous_response_id: first.id }), 404, 'response_unknown')
  const binding = (await fixture.runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${names.u.accountId}`)
  await binding.fixtureAgeResponse(final.id)
  await reason(await user(`${paths[0]}/${final.id}`), 404, 'response_unknown')
})

test('Responses quota is checked before generation and replay cannot silently switch account model routes', async t => {
  const { a, u, uOther } = fixtureNames()
  const { runtime } = await fixtureWorker(t, { principals: [a, u, uOther] })
  const admin = api(runtime, a), user = api(runtime, u)
  const path = `${base}/responses`, post = (send, opts = {}) => send(path, { method: 'POST', body: { model: workers, input: 'fixture', store: true, ...opts } })
  const first = await json(await post(user))
  const binding = (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${u.accountId}`)
  await json(await put(admin, '/upstreams/other-route', { name: 'New Responses route', protocol: 'responses' }))
  await reason(await post(user, { previous_response_id: first.id }), 403, 'response_upstream_disallowed')
  for (let i = 1; i < 16; i++) await json(await post(user))
  await reason(await post(user), 429, 'response_storage_limit')
  assert.equal(await binding.fixtureQuota(u.userId), 16)
  await json(await post(api(runtime, uOther)))
  await json(await post(user, { store: false }))
  await drop(admin, '/users/reader/data')
  await reason(await user(`${path}/${first.id}`), 404, 'response_unknown')
  await json(await post(user))
})
