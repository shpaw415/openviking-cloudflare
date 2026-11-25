// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const account = 'b2-fixture', responsePath = '/gateway/v1/responses', models = '/gateway/v1/models'
const admin = testPrincipal(account, 'admin', 'admin'), member = testPrincipal(account, 'member')
const root = testPrincipal('fixture-root', 'root', 'root')
const second = testPrincipal('b2-second', 'admin', 'admin')
const config = '/api/v1/admin/configuration/import'
const base = '/gateway/admin', keys = `${base}/keys`
const model = '@cf/meta/llama-3.1-8b-instruct'
const temp = temperature => ({ vlm: { provider: 'workers_ai', model, temperature } })
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const put = (send, path, body) => send(path, { method: 'PUT', body })
const remove = (send, path, headers) => send(path, { method: 'DELETE', headers })
const turn = (send, extra = {}, headers) => post(send, responsePath, { model: 'harbor', input: 'Harbor fixture', ...extra }, headers)
const named = name => ({ 'x-openviking-session': name })

async function checked(pending, status = 200, reason) {
  const response = await pending
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const value = await response.json()
  if (reason) assert.equal(value.reason ?? value.error?.code, reason)
  return value
}

async function runtime(persist) {
  const { outputFiles } = await build({ absWorkingDir: project, platform: 'browser', bundle: true, format: 'esm', write: false,
    external: ['cloudflare:workers'], entryPoints: ['tests/gateway/b2-fixture.mjs'] })
  return new Miniflare({ ...convertV4MiniflareOptions({ name: 'b2-gateway-conformance', host: '127.0.0.1', port: 0,
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-11-19',
    outboundService() { throw new Error('No upstream service in conformance tests') }, log: new Log(LogLevel.ERROR),
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { OPENVIKING_EDGE_GENERATION: '1', OPENVIKING_EDGE_KEYS: JSON.stringify([root, admin, member, second]) },
  }), ...(persist && { resourcePersistencePath: persist }) })
}

async function stub(mf, id = account) {
  const ws = await mf.getDurableObjectNamespace('WORKSPACES')
  return ws.getByName(`openviking:account:${id}`)
}

async function setup(mf, who = admin, capture = true) {
  const manage = api(mf, who)
  await checked(put(manage, `${base}/policies/bound`, { name: 'Bound fixture', capture, client_overrides: true }))
  await checked(put(manage, `${base}/upstreams/responses`, { name: 'Response fixture', protocol: 'responses', aliases: { harbor: model } }))
}

async function issue(mf, who = member, policy_id = 'bound') {
  const { key } = await checked(post(api(mf, who), keys, { name: 'B2 fixture key', policy_id, upstream_ids: ['responses'], models: ['harbor'] }))
  return { key }
}

async function waitFor(observe) {
  const end = Date.now() + 4000
  while (Date.now() < end) { if (await observe()) return; await delay(10) }
  assert.fail('A required fixture boundary was not reached')
}

test('B-SEC-01: matching authority, same-route scope refusals, additive migration and restart with classic continuation', { timeout: 20000 }, async () => {
  const persist = await mkdtemp(join(tmpdir(), 'ov-b2-provenance-'))
  let mf = await runtime(persist)
  try {
    const legacy = 'resp_' + '1'.repeat(32)
    await (await stub(mf)).fixtureLegacy(account, member.userId, legacy)
    await setup(mf, admin, false)
    const manage = api(mf, admin)
    await checked(put(manage, `${base}/policies/other`, { name: 'Other fixture' }))
    const a = await issue(mf), b = await issue(mf, member, 'other'), c = await issue(mf)
    const use = api(mf, a), direct = api(mf, member)
    const own = (await checked(turn(use, { store: true }))).id
    const classic = (await checked(turn(direct, { store: true }))).id
    const narrow = { 'x-openviking-context': JSON.stringify({ max_tokens: 128 }) }
    const narrowed = (await checked(turn(use, { store: true }, narrow))).id
    const scopeRefusal = async (send, id) => {
      await checked(send(`${responsePath}/${id}`), 403, 'response_scope_disallowed')
      await checked(turn(send, { previous_response_id: id }), 403, 'response_scope_disallowed')
      await checked(remove(send, `${responsePath}/${id}`), 403, 'response_scope_disallowed')
    }
    await scopeRefusal(api(mf, b), own)
    await scopeRefusal(api(mf, c), own)
    await scopeRefusal(use, classic)
    await scopeRefusal(use, legacy)
    await scopeRefusal(use, narrowed)
    await checked(use(`${responsePath}/${narrowed}`, { headers: narrow }))
    await checked(turn(use, { previous_response_id: own }))
    await mf.dispose(); mf = await runtime(persist)
    const resumed = api(mf, a), workspace = api(mf, member)
    assert.equal((await checked(resumed(`${responsePath}/${own}`))).id, own)
    assert.equal((await checked(workspace(`${responsePath}/${legacy}`))).id, legacy)
    await checked(turn(workspace, { previous_response_id: legacy }))
    await checked(remove(workspace, `${responsePath}/${legacy}`))
    await checked(workspace(`${responsePath}/${legacy}`), 404, 'response_unknown')
    await checked(put(api(mf, admin), `${base}/policies/bound`, { name: 'Tightened fixture', max_tokens: 64 }))
    await scopeRefusal(resumed, own)
    await checked(workspace(`${responsePath}/${own}`))
    const current = (await checked(turn(resumed, { store: true }))).id
    await checked(remove(resumed, `${responsePath}/${current}`))
    await checked(resumed(`${responsePath}/${current}`), 404, 'response_unknown')
  } finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }) }
})

test('B-SEC-02: configuration waits for both Workspaces and a pre-invocation mount is fenced', { timeout: 15000 }, async t => {
  const mf = await runtime(); t.after(() => mf.dispose())
  await setup(mf); await setup(mf, second)
  const use = api(mf, await issue(mf)), useSecond = api(mf, await issue(mf, second))
  const control = api(mf, root), w = await stub(mf), w2 = await stub(mf, second.accountId)
  await checked(useSecond(models))
  const pending = turn(use, { store: true }, named('held-admission'))
  try {
    await waitFor(() => w.fixtureHeld('mount'))
    await w2.fixtureMode('hold')
    const modifying = post(control, `${config}?if_revision=0`, temp(0.4))
    try {
      await waitFor(() => w2.fixtureHeld('fence'))
      assert.equal((await checked(control(config))).result.revision, 0)
      await checked(useSecond(models), 409, 'gateway_configuration_changed')
      await checked(post(control, config, temp(0.8)), 409, 'CONFLICT')
    } finally { await w2.fixtureRelease('fence') }
    assert.equal((await checked(modifying)).result.revision, 1)
    assert.equal(await w.fixtureFloor(), 1); assert.equal(await w2.fixtureFloor(), 1)
  } finally { await w.fixtureRelease('mount') }
  await checked(pending, 409, 'gateway_configuration_changed')
  assert.equal((await w.fixtureCounts()).generation, 0)
  assert.deepEqual(await w.fixtureWritten(), [0, 0, 0])
  await checked(turn(use, { store: true }, named('fresh')))
  assert.equal((await w.fixtureCounts()).temperature, 0.4)
  assert.deepEqual(await w.fixtureWritten(), [1, 1, 1])
})

test('B-SEC-02: non-stream held in the binding cannot publish a new success or content after acknowledgment', { timeout: 15000 }, async t => {
  const mf = await runtime(); t.after(() => mf.dispose())
  await setup(mf)
  const use = api(mf, await issue(mf)), control = api(mf, root), w = await stub(mf)
  const prior = (await checked(turn(use, { store: true }, named('completed')))).id
  const inFlight = turn(use, { input: 'held generation', store: true }, named('held-json'))
  try {
    await waitFor(() => w.fixtureHeld('generation'))
    assert.equal((await checked(post(control, config, temp(0.5)))).result.revision, 1)
  } finally { await w.fixtureRelease('generation') }
  await checked(inFlight, 409, 'gateway_configuration_changed')
  assert.deepEqual(await w.fixtureWritten(), [1, 1, 1])
  await checked(use(`${responsePath}/${prior}`))
  assert.equal((await w.fixtureCounts()).generation, 2)
})

test('B-SEC-02: a real first SSE delta is preserved; the held tail and all new writes are refused', { timeout: 15000 }, async t => {
  const mf = await runtime(); t.after(() => mf.dispose())
  await setup(mf)
  const { key } = await issue(mf), w = await stub(mf), control = api(mf, root)
  const url = await mf.ready
  assert.equal(url.hostname, '127.0.0.1')
  const response = await fetch(new URL(responsePath, url), { method: 'POST', signal: AbortSignal.timeout(9000),
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...named('held-sse') },
    body: JSON.stringify({ model: 'harbor', input: 'Stream fixture', stream: true, store: true }) })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const stream = response.body.getReader(), decoder = new TextDecoder()
  try {
    let text = ''
    while (!text.includes('First fixture delta')) {
      const part = await stream.read()
      assert.equal(part.done, false)
      text += decoder.decode(part.value, { stream: true })
    }
    await waitFor(() => w.fixtureHeld('stream-tail'))
    assert.equal((await w.fixtureCounts()).tail, false)
    assert.equal((await checked(post(control, config, temp(0.6)))).result.revision, 1)
    for (;;) {
      const part = await stream.read()
      if (part.done) break
      text += decoder.decode(part.value, { stream: true })
    }
    assert.match(text, /gateway_configuration_changed/)
    assert.doesNotMatch(text, /Second fixture delta|response\.completed|\[DONE\]/)
    await waitFor(async () => (await w.fixtureCounts()).cancelled)
    assert.deepEqual(await w.fixtureWritten(), [0, 0, 0])
  } finally { await w.fixtureRelease('stream-tail'); await stream.cancel().catch(() => {}) }
})

test('B-SEC-02: a partially acknowledged fence fails closed across restart, same import resumes without rollback', { timeout: 20000 }, async () => {
  const persist = await mkdtemp(join(tmpdir(), 'ov-b2-mount-'))
  let mf = await runtime(persist)
  try {
    await setup(mf)
    const credential = await issue(mf)
    await checked(api(mf, credential)(models))
    const ws = await stub(mf)
    await ws.fixtureMode('unavailable')
    await checked(post(api(mf, root), `${config}?if_revision=0`, temp(0.7)), 503, 'GATEWAY_FENCE_UNAVAILABLE')
    assert.equal(await ws.fixtureFloor(), 1)
    await mf.dispose(); mf = await runtime(persist)
    const control = api(mf, root), use = api(mf, credential), newWs = await stub(mf)
    assert.equal(await newWs.fixtureFloor(), 1)
    assert.equal((await checked(control(config))).result.revision, 0)
    await checked(use(models), 409, 'gateway_configuration_changed')
    await checked(post(control, config, temp(0.9)), 409, 'CONFLICT')
    assert.equal((await checked(post(control, `${config}?if_revision=0`, temp(0.7)))).result.revision, 1)
    await checked(turn(use, { store: true }))
    assert.equal((await newWs.fixtureCounts()).temperature, 0.7)
  } finally { await mf.dispose(); await rm(persist, { recursive: true, force: true }) }
})
