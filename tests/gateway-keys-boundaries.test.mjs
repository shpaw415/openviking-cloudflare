// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const base = '/gateway/admin', keys = `${base}/keys`, chat = '/gateway/v1/chat/completions'
const responsePath = '/gateway/v1/responses'
const model = '@cf/meta/llama-3.1-8b-instruct'
const body = { model: 'harbor', messages: [{ role: 'user', content: 'Marina fixture' }] }
const draft = { name: 'Fixture', policy_id: 'bound', upstream_ids: ['chat'], models: ['harbor'] }
const noOutbound = () => { throw new Error('Local tests must not contact an upstream service') }
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const put = (send, path, body) => send(path, { method: 'PUT', body })
const remove = (send, path) => send(path, { method: 'DELETE' })

async function checked(pending, status = 200, reason) {
  const response = await pending
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const payload = await response.json()
  assert.equal(response.status, status, `reason: ${payload.reason ?? payload.error?.code ?? 'none'}`)
  if (reason) assert.equal(payload.reason ?? payload.error?.code, reason)
  return payload
}

async function configure(admin, { capture = false } = {}) {
  await checked(put(admin, `${base}/policies/bound`, { name: 'Bound', capture }))
  await checked(put(admin, `${base}/upstreams/chat`, { name: 'Local chat', protocol: 'chat', aliases: { harbor: model } }))
  await checked(put(admin, `${base}/upstreams/responses`, { name: 'Local responses', protocol: 'responses', aliases: { harbor: model } }))
}

test('managed owner proof is checked at issuance and after its OpenViking credential is rotated', async t => {
  const root = testPrincipal('fixture-root', 'root', 'root'), outsider = testPrincipal('foreign', 'bob')
  const runtime = await localWorker({ principals: [root, outsider], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_GENERATION: '1' }, outboundService: noOutbound })
  t.after(() => runtime.dispose())
  const principal = await checked(post(api(runtime, root), '/api/v1/admin/accounts', { account_id: 'managed-fixture', admin_user_id: 'owner' }))
  const admin = api(runtime, { key: principal.result.user_key })
  const users = '/api/v1/admin/accounts/managed-fixture/users'
  const member = await checked(post(admin, users, { user_id: 'bob' }))
  const bob = api(runtime, { key: member.result.user_key })
  await configure(admin)
  assert.equal((await checked(admin(`${base}/access`))).can_issue_for_others, true)
  assert.equal((await checked(bob(`${base}/access`))).can_issue_for_others, false)
  assert.equal((await checked(admin('/api/v1/system/edge-capabilities'))).result.features.gatewayKeys, true)
  assert.equal((await checked(api(runtime, root)('/api/v1/system/edge-capabilities'))).result.features.gatewayKeys, false)
  const requested = { ...draft, user_id: 'bob' }
  await checked(post(admin, keys, requested), 409, 'user_key_unreadable')
  await checked(post(bob, keys, { ...draft, user_id: 'owner' }), 403, 'forbidden')
  await checked(post(admin, keys, { ...requested, openviking_key: outsider.key }), 403, 'other_account')
  await checked(post(admin, keys, { ...requested, openviking_key: root.key }), 403, 'root_key_not_allowed')
  const issued = await checked(post(admin, keys, { ...requested, openviking_key: member.result.user_key }))
  const credential = api(runtime, { key: issued.key })
  assert.equal(issued.user_id, 'bob')
  assert.ok(!Object.hasOwn(issued, 'openviking_key'))
  assert.deepEqual((await checked(bob(keys))).map(k => k.id), [issued.id])
  await checked(post(credential, chat, body, { 'x-openviking-account': 'foreign', 'x-openviking-user': 'owner' }))
  const log = (await checked(admin(`${base}/logs`))).find(item => item.credential_id === issued.id)
  assert.equal(log?.user_id, 'bob')
  assert.equal(log?.openviking_account, 'managed-fixture')
  await checked(remove(admin, `${base}/upstreams/chat`), 409, 'in_use')
  await checked(remove(admin, `${base}/policies/bound`), 409, 'in_use')
  const newMember = await checked(post(admin, `${users}/bob/key`))
  await checked(post(credential, chat, body), 401, 'openviking_key_invalid')
  await checked(post(credential, chat, body), 401, 'gateway_key_invalid')
  assert.equal((await checked(admin(keys))).length, 0)
  await checked(post(api(runtime, { key: newMember.result.user_key }), chat, body))
})

test('bound profile and stored Responses stay within the admitted key scope', async t => {
  const admin = testPrincipal('scope-fixture','owner','admin'), member = testPrincipal('scope-fixture','alice')
  const runtime = await localWorker({ principals: [admin, member], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_GENERATION: '1' }, outboundService: noOutbound })
  t.after(() => runtime.dispose())
  const manage = api(runtime, admin), owner = api(runtime, member)
  await configure(manage, { capture: true })
  const limited = await checked(post(owner, keys, draft))
  const allowed = await checked(post(owner, keys, { ...draft, upstream_ids: ['chat', 'responses'] }))
  const use = api(runtime, { key: allowed.key }), limitedUse = api(runtime, { key: limited.key })
  const held = await checked(post(use, responsePath, { model: 'harbor', input: 'Local reply', store: true }))
  await checked(use(`${responsePath}/${held.id}`))
  await checked(limitedUse(`${responsePath}/${held.id}`), 403, 'response_upstream_disallowed')
  await checked(remove(limitedUse, `${responsePath}/${held.id}`), 403, 'response_upstream_disallowed')
  await checked(use(`${responsePath}/${held.id}`))
  const captured = async () => {
    const response = await post(use, chat, body, { 'x-openviking-session': 'fixture-reset' })
    const id = response.headers.get('x-openviking-captured-session')
    await checked(response)
    assert.ok(id)
    return id
  }
  const first = await captured()
  assert.equal(await captured(), first)
  await checked(post(owner, `${keys}/${allowed.id}/capture/reset`, { session: 'fixture-reset', protocol: 'chat' }))
  assert.notEqual(await captured(), first)
  await checked(owner(`/api/v1/sessions/${first}`))
  await checked(remove(manage, `${base}/users/alice/data`))
  await checked(post(use, chat, body), 401, 'gateway_key_invalid')
  await checked(post(owner, chat, body))
  await checked(owner(`/api/v1/sessions/${first}`))
})

test('revocation after the first real SSE delta cancels the binding and never saves the held turn', { timeout: 15000 }, async () => {
  const admin = testPrincipal('stream-key-fixture', 'owner', 'admin')
  const reader = testPrincipal('stream-key-fixture', 'reader')
  const project = fileURLToPath(new URL('../', import.meta.url))
  const { outputFiles } = await build({ absWorkingDir: project, platform: 'browser', bundle: true, format: 'esm', write: false,
    external: ['cloudflare:workers'], stdin: { resolveDir: project, contents: `
      import worker from './src/worker.ts';
      export { Workspace, Control } from './tests/gateway/worker-fixture.mjs';
      // The Workspace fixture owns the provider; the parent only checks the binding.
      export default {fetch(request, env, ctx) {return worker.fetch(request, {...env, AI:{run(){throw Error('unexpected parent generation')}}}, ctx)}};
    ` } })
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'gateway-key-revocation-fixture', host: '127.0.0.1', port: 0,
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-11-19', outboundService: noOutbound,
    durableObjects: { WORKSPACES: {className:'Workspace',useSQLite:true}, CONTROL: {className:'Control',useSQLite:true} },
    bindings: { OPENVIKING_EDGE_GENERATION: '1', OPENVIKING_EDGE_KEYS: JSON.stringify([admin, reader]), TEST_GATEWAY_STREAMING: 'on' }, log: new Log(LogLevel.ERROR) }))
  let stream
  try {
    const manage = api(runtime, admin), send = api(runtime, reader)
    await configure(manage, { capture: true })
    const key = await checked(post(send, keys, draft))
    const url = await runtime.ready
    assert.equal(url.hostname, '127.0.0.1')
    const response = await fetch(new URL(chat, url), { method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { 'x-api-key': key.key, 'content-type': 'application/json', 'x-openviking-session': 'held-turn' },
      body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'sse-held' }], stream: true }) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    stream = response.body.getReader()
    const decoder = new TextDecoder()
    let got = ''
    while (!got.includes('Marée')) {
      const { done, value } = await stream.read()
      assert.equal(done, false, 'first text before producer release')
      got += decoder.decode(value,{stream:true})
    }
    const ns = await runtime.getDurableObjectNamespace('WORKSPACES')
    const stub = ns.get(ns.idFromName('openviking:account:stream-key-fixture'))
    const state = () => stub.fixtureStreamState('sse-held').then(JSON.parse)
    assert.deepEqual(await state(), { released: false, cancelled: false, tail: false })
    await checked(remove(manage, `${keys}/${key.id}`))
    await stub.fixtureReleaseStream('sse-held')
    for (;;) {
      const { done, value } = await stream.read()
      if (done) break
      got += decoder.decode(value,{stream:true})
    }
    assert.match(got, /gateway_key_invalid/)
    assert.doesNotMatch(got, /\[DONE\]| haute/)
    for (let i = 0; i < 40 && !(await state()).cancelled; i++) await delay(15)
    assert.equal((await state()).cancelled, true)
    const sessions = await checked(send('/api/v1/sessions'))
    assert.deepEqual(sessions.result, [])
    await checked(post(send, chat, body))
  } finally {
    await stream?.cancel().catch(() => {})
    await runtime.dispose()
  }
})
