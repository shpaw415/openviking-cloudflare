// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const config = '/api/v1/admin/configuration/import'
const probe = '/api/v1/admin/configuration/test-model'
const caps = '/api/v1/system/edge-capabilities'
const provider = 'https://model.example.test/v1'
const openai = 'https://api.openai.com/v1'
const legacy = '@cf/baai/bge-base-en-v1.5'
const llama = 'llama3.2:3b'
const root = testPrincipal('bootstrap', 'root', 'root')
const one = testPrincipal('first', 'owner', 'admin')
const two = testPrincipal('second', 'writer')
const three = testPrincipal('third', 'writer')
const secret = () => randomBytes(32).toString('hex')
const admitted = (api_base, api_key) => ({ OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base, api_key }]) })
const post = (send, path, body) => send(path, { method: 'POST', body })

async function checked(response, status = 200, ...hidden) {
  const body = await response.text()
  assert.ok(hidden.every(value => !body.includes(value)), 'the Worker did not disclose a credential')
  const data = JSON.parse(body)
  assert.equal(response.status, status, `expected HTTP ${status}; got ${response.status}`)
  return data.result
}

test('only root imports a bounded subset; dry-run, invalid file and stale revisions do not change SQLite', async t => {
  const key = secret()
  let outbound = 0
  const runtime = await localWorker({ principals: [root, one, two], vars: admitted(provider, key),
    outboundService() { outbound++; return new Response(null, { status: 599 }) } })
  t.after(() => runtime.dispose())
  const control = api(runtime, root)
  const file = { vlm: { provider: 'ollama', api_base: provider, model: llama, max_tokens: 256 }, default_search_limit: 3 }
  await checked(await post(api(runtime), config, file), 401)
  for (const actor of [one, two]) {
    const send = api(runtime, actor)
    await checked(await post(send, config, file), 403)
    await checked(await send(config), 403)
    await checked(await post(send, probe, { kind: 'vlm', active: true }), 403)
  }
  const before = await checked(await control(config), 200, key)
  assert.equal(before.revision, 0)
  assert.equal(before.effective.vlm, null)
  const trial = await checked(await post(control, `${config}?dry_run=true&if_revision=0`, file), 200, key)
  assert.equal(trial.dry_run, true)
  assert.equal(trial.revision, 0)
  assert.equal(trial.effective.vlm.model, llama)
  assert.equal(trial.effective.vlm.configured, true)
  assert.deepEqual(await checked(await control(config), 200, key), before)
  for (const [status, body] of [
    [400, { vlm: { ...file.vlm, api_key: key } }],
    [412, { vlm: { ...file.vlm, api_base: 'https://not-admitted.example.test/v1' } }],
    [400, { vlm: { ...file.vlm, api_base: 'http://localhost:11434/v1' } }],
    [501, { ...file, server: { root_api_key: key } }],
    [501, { ...file, embedding: { sparse: {} } }],
    [501, { vlm: { ...file.vlm, extra_headers: {} } }],
    [400, { ...file, default_search_limit: 90 }],
    [413, { padding: '.'.repeat(16 * 1024) }],
  ]) await checked(await post(control, config, body), status, key)
  assert.deepEqual(await checked(await control(config), 200, key), before)
  const race = await Promise.all([3, 4].map(default_search_limit => post(control, `${config}?if_revision=0`, { ...file, default_search_limit })))
  assert.deepEqual(race.map(response => response.status).sort(), [200, 409])
  const current = await checked(race.find(res => res.status === 200), 200, key)
  await checked(race.find(res => res.status === 409), 409, key)
  assert.equal(current.revision, 1)
  assert.deepEqual(await checked(await control(config), 200, key), current)
  assert.equal(outbound, 0)
})

test('the configured compatible Llama receives real Gateway generation and a bounded root probe', async t => {
  const key = secret()
  const received = []
  let behavior = 'reply'
  const officialKey = secret()
  const vars = { OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: provider, api_key: key }, { api_base: openai, api_key: officialKey }]) }
  const runtime = await localWorker({ principals: [root, one], vars, embeddings: 'fixture',
    async outboundService(request) {
      const body = await request.json()
      const expectedKey = request.url.startsWith(`${openai}/`) ? officialKey : key
      received.push({ url: request.url, method: request.method, authorized: request.headers.get('authorization') === `Bearer ${expectedKey}`,
        forwardedOVKey: request.headers.has('x-api-key'), body })
      if (behavior === 'redirect') return new Response(key, { status: 307, headers: { location: 'https://other.example.test/v1/chat/completions' } })
      if (behavior === 'echo') return Response.json({ choices: [{ message: { role: 'assistant', content: key } }] })
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'Local provider fixture reply.', tool_calls: [] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } })
    } })
  t.after(() => runtime.dispose())
  const asRoot = api(runtime, root), asUser = api(runtime, one)
  const profile = { vlm: { provider: 'ollama', api_base: provider, model: llama, temperature: 0.2, max_tokens: 128, timeout: 3 } }
  await checked(await post(asRoot, config, profile), 200, key)
  const status = await checked(await asUser(caps), 200, key, provider)
  assert.equal(status.generation.model, llama)
  assert.equal(status.generation.configured, true)
  assert.equal(status.features.bot, true)
  assert.equal(status.features.gateway, true)
  const models = await (await asUser('/gateway/v1/models')).json()
  assert.deepEqual(models.data.map(item => item.id), [llama])
  const route = '/gateway/v1/chat/completions'
  const input = { model: llama, messages: [{ role: 'user', content: 'Test text.' }], max_tokens: 500 }
  const reply = await post(asUser, route, input)
  assert.equal(reply.status, 200)
  assert.equal((await reply.json()).choices[0].message.content, 'Local provider fixture reply.')
  assert.deepEqual(received[0], { url: `${provider}/chat/completions`, method: 'POST', authorized: true, forwardedOVKey: false,
    body: { model: llama, messages: input.messages, stream: false, max_tokens: 128, temperature: 0.2 } })
  assert.equal((await checked(await post(asRoot, probe, { kind: 'vlm', active: true }), 200, key)).ok, true)
  assert.deepEqual(received[1].body.messages, [{ role: 'user', content: 'Reply OK.' }])
  for (const failure of ['redirect', 'echo']) {
    behavior = failure
    const unavailable = await post(asUser, route, input)
    assert.equal(unavailable.status, 502)
    assert.ok(!(await unavailable.text()).includes(key))
  }
  assert.deepEqual(received.map(item => item.url), Array(4).fill(`${provider}/chat/completions`))
  behavior = 'reply'
  await checked(await post(asRoot, config, { vlm: { provider: 'openai', model: 'gpt-4o-mini' } }), 200, key, officialKey)
  const official = await post(asUser, route, { ...input, model: 'gpt-4o-mini' })
  assert.equal(official.status, 200)
  await official.text()
  assert.deepEqual(received[4], { url: `${openai}/chat/completions`, method: 'POST', authorized: true, forwardedOVKey: false,
    body: { model: 'gpt-4o-mini', messages: input.messages, stream: false, max_completion_tokens: 500 } })
  await checked(await post(asRoot, config, { vlm: null }), 200, key)
  assert.equal((await checked(await asUser(caps), 200, key)).generation.configured, false)
})

test('new workspaces use the uploaded dense model; established indexes retain their model after changes and restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-model-config-'))
  const key = secret()
  const seen = []
  let runtime
  t.after(async () => { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }) })
  const launch = (vars = admitted(openai, key)) => localWorker({ principals: [root, one, two, three], vars, persist: dir, embeddings: 'fixture',
    async outboundService(request) {
      const body = await request.json()
      seen.push({ url: request.url, authorized: request.headers.get('authorization') === `Bearer ${key}`, model: body.model, dimension: body.dimensions })
      const data = body.input.map((text, index) => ({ index, embedding: Array.from({ length: body.dimensions }, (_, i) => i === (text.includes('sailing') ? 0 : 1) ? 1 : 0) }))
      return Response.json({ data: data.reverse(), usage: { prompt_tokens: 7 } })
    } })
  runtime = await launch()
  const uri = 'viking://~/resources/navigation.txt'
  const write = (send, path = uri) => post(send, '/api/v1/content/write', { uri: path, content: 'sailing directions', wait: true })
  const find = (send, limit) => post(send, '/api/v1/search/find', { query: 'sailing', target_uri: 'viking://~/resources', ...(limit && { limit }) })
  await checked(await write(api(runtime, one)))
  const dense = model => ({ dense: { provider: 'openai', model, dimension: 768, input: 'text' } })
  await checked(await post(api(runtime, root), config, { embedding: dense('text-embedding-3-small'), default_search_limit: 1 }), 200, key)
  assert.equal((await checked(await api(runtime, one)(caps))).embedding.model, legacy)
  assert.equal((await checked(await find(api(runtime, one)))).total, 1)
  assert.equal(seen.length, 0)
  await checked(await write(api(runtime, two)))
  await checked(await write(api(runtime, two), 'viking://~/resources/navigation-2.txt'))
  const result = await checked(await find(api(runtime, two)), 200, key)
  assert.equal(result.total, 1)
  assert.equal(result.resources[0].score, 1)
  assert.equal((await checked(await find(api(runtime, two), 2))).total, 2)
  const vectors = await checked(await post(api(runtime, two), '/api/v1/compile/embeddings', { target_uri: uri,
    expected_model: 'text-embedding-3-small', texts: ['sailing', 'unrelated'] }), 200, key)
  assert.deepEqual(vectors.vectors.map(v => v.slice(0, 2)), [[1, 0], [0, 1]])
  const prior = seen.length
  await checked(await post(api(runtime, root), config, { embedding: dense('text-embedding-3-large') }), 200, key)
  assert.equal((await checked(await api(runtime, two)(caps))).embedding.model, 'text-embedding-3-small')
  assert.equal((await checked(await api(runtime, three)(caps))).embedding.model, 'text-embedding-3-large')
  assert.equal(seen.length, prior)
  await runtime.dispose()
  runtime = await launch()
  assert.equal((await checked(await api(runtime, root)(config), 200, key)).revision, 2)
  assert.equal((await checked(await find(api(runtime, two)))).total, 1)
  await checked(await write(api(runtime, three)))
  assert.equal(seen.at(-2).model, 'text-embedding-3-small')
  assert.equal(seen.at(-1).model, 'text-embedding-3-large')
  assert.ok(seen.every(call => call.authorized && call.url === `${openai}/embeddings` && call.dimension === 768))

  // Removing the deployment secret does not downgrade an established remote index to BGE.
  const requests = seen.length
  await runtime.dispose()
  runtime = await launch({})
  assert.equal((await checked(await api(runtime, two)(caps))).embedding.binding_present, false)
  await checked(await find(api(runtime, two)), 503, key)
  assert.equal((await checked(await find(api(runtime, one)))).total, 1)
  assert.equal(seen.length, requests)
})
