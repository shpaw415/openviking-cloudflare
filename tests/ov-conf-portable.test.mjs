// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('conf-bootstrap', 'root', 'root')
const admin = testPrincipal('conf-tenant', 'owner', 'admin')
const member = testPrincipal(admin.accountId, 'member')
const config = '/api/v1/admin/configuration/import'
const endpoint = 'https://portable.example.test/v1'
const model = 'compatible-plain-text'
const chat = '/gateway/v1/chat/completions'
const dirs = 'viking://~/resources'
const post = (send, path, body) => send(path, { method: 'POST', body })
const key = randomBytes(32).toString('hex')
const patch = (send, revision, body, dry = false) => post(send, `${config}?if_revision=${revision}${dry ? '&dry_run=true' : ''}`, body)
const search = (send, route, body = {}) => post(send, `/api/v1/search/${route}`, { query: 'marina', target_uri: dirs, level: 2, ...body })
const write = (send, name, content) => post(send, '/api/v1/content/write', { uri: `${dirs}/${name}.txt`, content, wait: true })
const prompt = (send, options = {}) => post(send, chat, { model, messages: [{ role: 'user', content: 'marina' }], max_tokens: 800, ...options })
const dense = { dense: { provider: 'openai-compatible', api_base: endpoint, model: 'deterministic-vector', dimension: 2 } }

async function expect(response, status = 200) {
  assert.equal(response.status, status)
  const raw = await response.text()
  assert.equal(raw.includes(key), false, 'no provider credential in any result')
  const data = JSON.parse(raw)
  return data.result ?? data
}

async function fixture(t, sessionScenario = false) {
  const calls = []
  const runtime = await localWorker({ principals: [root, admin, member], vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: endpoint, api_key: key }]), OPENVIKING_EDGE_OPERATOR_STREAMING: '1',
  }, async outboundService(request) {
    const path = new URL(request.url).pathname
    assert.ok(request.url === `${endpoint}/embeddings` || request.url === `${endpoint}/chat/completions`)
    assert.ok(request.headers.get('authorization') === `Bearer ${key}`)
    const body = await request.json()
    calls.push({ path, body })
    if (path.endsWith('embeddings')) {
      const vector = text => text.includes('glacier') ? [0, 1] : text.includes('mid fixture') || sessionScenario && text === 'marina'
        ? [0.8, 0.6] : text.includes('low fixture') ? [0.4, 0.916515138991168] : [1, 0]
      return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vector(text) })) })
    }
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Synthetic reply"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Synthetic reply' } }] })
  } })
  t.after(() => runtime.dispose())
  return { control: api(runtime, root), owner: api(runtime, admin), send: api(runtime, member), calls }
}

test('ov.conf score and limit change actual find/search and explicit Gateway recall, never broaden profile policy', async t => {
  const { control, owner, send, calls } = await fixture(t)
  await expect(await patch(control, 0, { embedding: dense }))
  await expect(await write(send, 'best', 'marina best fixture'))
  await expect(await write(send, 'mid', 'marina mid fixture'))
  await expect(await write(send, 'low', 'marina low fixture'))
  assert.equal((await expect(await search(send, 'find'))).total, 3)
  const retrieval = { default_search_limit: 1, default_search_score_threshold: 0.7 }
  const count = calls.length
  assert.equal((await expect(await patch(control, 1, retrieval, true))).effective.default_search_score_threshold, 0.7)
  assert.equal(calls.length, count, 'dry-run does not call any binding')
  assert.equal((await expect(await search(send, 'find'))).total, 3, 'dry-run has no search effect')
  assert.equal((await expect(await patch(control, 1, retrieval))).revision, 2)
  for (const route of ['find', 'search']) {
    assert.equal((await expect(await search(send, route))).total, 1)
    assert.equal((await expect(await search(send, route, { limit: 3 }))).total, 2, 'score independently affects the result')
    assert.equal((await expect(await search(send, route, { limit: 3, score_threshold: 0.1 }))).total, 3, 'explicit values win')
  }
  await expect(await patch(control, 2, { vlm: { provider: 'ollama', api_base: endpoint, model } }))
  assert.equal((await prompt(send)).headers.get('x-openviking-recall'), 'disabled')
  assert.equal(calls.at(-1).body.messages.at(-1).content, 'marina')
  await expect(await owner('/gateway/admin/policies/default', { method: 'PUT', body: {
    name: 'Explicit resource recall', recall: true, context_types: ['resource'], score_threshold: 0.5,
  } }))
  const observed = []
  for (const params of [undefined, { default_search_limit: 12 }, { default_search_score_threshold: 0.9 }, { default_search_score_threshold: 0 }]) {
    if (params) {
      const { revision } = await expect(await control(config))
      await expect(await patch(control, revision, params))
    }
    await expect(await prompt(send))
    const content = calls.at(-1).body.messages.at(-1).content
    observed.push(['best', 'mid', 'low'].filter(label => content.includes(`${label} fixture`)))
  }
  assert.deepEqual(observed, [['best'], ['best', 'mid'], ['best'], ['best', 'mid']])
  const { revision } = await expect(await control(config))
  const restored = await expect(await patch(control, revision, { default_search_limit: null, default_search_score_threshold: null }))
  assert.equal(restored.revision, revision + 1)
  assert.equal(restored.effective.default_search_limit, 10)
  assert.equal(restored.effective.default_search_score_threshold, 0.1)
  assert.equal((await expect(await search(send, 'find'))).total, 3)
})

test('ov.conf retrieval.enable_intent:false sends only the raw query and null restores bounded local session context', async t => {
  const { control, send, calls } = await fixture(t, true)
  await expect(await patch(control, 0, { embedding: dense }))
  await expect(await write(send, 'land', 'glacier route'))
  await expect(await write(send, 'water', 'marina route'))
  const { session_id } = await expect(await post(send, '/api/v1/sessions', {}))
  await expect(await post(send, `/api/v1/sessions/${session_id}/messages`, { role: 'user', content: 'glacier is the topic' }))
  const searchWithSession = () => search(send, 'search', { session_id, limit: 1, include_provenance: true }).then(expect)
  assert.match((await searchWithSession()).resources[0].uri, /land\.txt$/)
  assert.ok(calls.at(-1).body.input[1].includes('glacier is the topic'))
  const imported = await expect(await patch(control, 1, { retrieval: { enable_intent: false } }))
  assert.deepEqual(imported.effective.retrieval, { use_session_context: false, intent_planner: false })
  const raw = await searchWithSession()
  assert.match(raw.resources[0].uri, /water\.txt$/)
  assert.deepEqual(calls.at(-1).body.input, ['marina'])
  assert.equal(raw.provenance[0].thinking_trace.statistics.session_messages_used, undefined)
  await expect(await patch(control, 2, { retrieval: null }))
  assert.match((await searchWithSession()).resources[0].uri, /land\.txt$/)
})

test('ov.conf bounded generation parameters reach both HTTP consumers; refusals do not partially apply', async t => {
  const { control, owner, send, calls } = await fixture(t)
  const vlm = { backend: 'openai-compatible', api_base: endpoint, model, temperature: 0.25, reasoning_effort: 'low', max_tokens: 70, timeout: 3 }
  await expect(await patch(owner, 0, { vlm }), 403)
  const before = await expect(await control(config))
  for (const [status, change] of [
    [400, { default_search_score_threshold: 1.1 }], [400, { retrieval: { enable_intent: 'false' } }],
    [501, { retrieval: { enable_intent: true } }], [501, { retrieval: { recall_intent_timeout_s: 0.5 } }],
    [501, { rerank: { threshold: 0.4 } }], [501, { storage: { workspace: '/var/openviking' } }],
    [501, { vlm: { ...vlm, extra_request_body: { top_p: 0.5 } } }], [501, { vlm: { ...vlm, max_retries: 0 } }],
    [400, { vlm: { ...vlm, reasoning_effort: 'arbitrary' } }], [400, { vlm: { ...vlm, max_tokens: 2049 } }],
    [400, { vlm: { ...vlm, timeout: 26 } }], [400, { vlm: { ...vlm, provider: 'openai' } }],
    [400, { vlm: { ...vlm, api_key: key } }], [501, { gateway: { upstreams: [] } }],
  ]) await expect(await patch(control, 0, { default_search_limit: 4, ...change }), status)
  assert.deepEqual(await expect(await control(config)), before)
  assert.equal(calls.length, 0)
  const trial = await expect(await patch(control, 0, { vlm }, true))
  assert.equal(trial.settings.vlm.provider, 'openai')
  assert.equal(trial.settings.vlm.backend, undefined)
  assert.equal(trial.revision, 0)
  assert.equal(calls.length, 0)
  const race = await Promise.all([patch(control, 0, { vlm }), patch(control, 0, { default_search_limit: 5 })])
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409])
  await expect(race.find(result => result.status === 409), 409)
  let active = await expect(race.find(result => result.status === 200))
  if (!active.settings.vlm) active = await expect(await patch(control, active.revision, { vlm }))
  const current = active.revision
  assert.ok(current >= 1)
  assert.equal((await expect(await patch(control, current, { vlm }))).revision, current, 'same normalized import is idempotent')
  await expect(await prompt(send))
  const streamed = await prompt(send, { stream: true })
  assert.equal(streamed.status, 200)
  assert.match(await streamed.text(), /Synthetic reply[\s\S]*\[DONE\]/)
  assert.deepEqual(calls.map(({ body }) => [body.stream, body.max_tokens, body.temperature, body.reasoning_effort]),
    [[false, 70, 0.25, 'low'], [true, 70, 0.25, 'low']])
  await expect(await patch(control, current, { vlm: { ...vlm, reasoning_effort: null, temperature: null, max_tokens: null } }))
  await expect(await prompt(send))
  assert.equal(calls.at(-1).body.max_tokens, 800)
  assert.equal(calls.at(-1).body.reasoning_effort, undefined)
  assert.equal(calls.at(-1).body.temperature, undefined)
})
