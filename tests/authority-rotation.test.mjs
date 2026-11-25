// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const project = fileURLToPath(new URL('..', import.meta.url))
const model = '@cf/meta/llama-3.1-8b-instruct'
const root = testPrincipal('fixture-root', 'root', 'root')
const account = 'fixture-rotations', accounts = '/api/v1/admin/accounts'
const users = `${accounts}/${account}/users`, groups = `${accounts}/${account}/groups`, models = '/gateway/v1/models'
const rotations = user => `${users}/${user}/key`
const files = 'viking://~/resources/notes.txt'
const source = 'https://fixtures.invalid/notes.txt', text = 'A synthetic coastal note.'
const post = (send, url, body) => send(url, { method: 'POST', body })
const put = (send, url, body) => send(url, { method: 'PUT', body })

async function json(pending, status = 200, code) {
  const response = await pending
  const value = await response.json()
  assert.equal(response.status, status, value.reason ?? value.error?.code)
  if (code) assert.equal(value.reason ?? value.error?.code, code)
  return value.result ?? value
}

const bundle = build({ absWorkingDir: project, stdin: { resolveDir: project, contents: `
  import worker, { Control as ProductionControl } from './src/worker.ts';
  import { LIMIT } from './src/control/input.ts';
  import { Workspace as StreamFixture } from './tests/gateway/worker-fixture.mjs';
  export default { fetch(request, env, execution) {
    return worker.fetch(request, {...env, AI: {run() { throw Error('Provider belongs to the Workspace fixture'); }}}, execution);
  } };
  export class Control extends ProductionControl {
    fixtureCappedUser() {
      // Materialize an already-full synthetic ledger in one transaction,
      // without performing repeated rotations or issuing any credentials.
      this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec(\`
        WITH RECURSIVE entries(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM entries WHERE n < ?)
        INSERT INTO ov_control_key_history (digest,account_id,user_id)
          SELECT printf('%064x', n), 'fixture-rotations', 'alice' FROM entries\`, LIMIT.keysPerUser-1));
      return LIMIT.keysPerUser;
    }
    fixtureAuthoritySummary() {
      const sql = this.ctx.storage.sql;
      const account = sql.exec(\`SELECT revision FROM ov_control_gateway_credential_fence WHERE account_id='fixture-rotations'\`).toArray()[0]?.revision;
      const members = sql.exec(\`SELECT user_id,revision,pending FROM ov_control_data_member_fence WHERE account_id='fixture-rotations' ORDER BY user_id\`).toArray();
      const keys = sql.exec(\`SELECT count(*) AS n FROM ov_control_key_history WHERE account_id='fixture-rotations' AND user_id='alice'\`).one().n;
      return JSON.stringify({account,members,keys});
    }
  }
  export class Workspace extends StreamFixture {
    async fenceGatewayCredentials(account, change) {
      const receipt = await super.fenceGatewayCredentials(account, change);
      const gate = await this.env.RECEIPT.fetch('https://fixtures.invalid/ack', {method:'POST', body:JSON.stringify(change)});
      if (gate.status !== 204) throw Error('Synthetic Workspace acknowledgement unavailable');
      return receipt;
    }
  }
  ` }, bundle: true, platform: 'browser', format: 'esm', write: false, external: ['cloudflare:workers'] })

async function fixture(t, persist) {
  let runtime, onFence, onSource
  const fences = [], requests = []
  const signingSecret = randomBytes(32).toString('hex')
  const { outputFiles } = await bundle
  const launch = async () => {
    const options = convertV4MiniflareOptions({ script: outputFiles[0].text, modules: true, name: 'rotation-fixture', host: '127.0.0.1', port: 0,
      compatibilityDate: '2026-11-19', cf: false, logRequests: false,
      durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
      bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root]), OPENVIKING_EDGE_GENERATION: '1', TEST_GATEWAY_STREAMING: 'on',
        OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: signingSecret,
        OPENVIKING_EDGE_TEXT_SOURCES: JSON.stringify([source]) },
      serviceBindings: {
        async RECEIPT(request) { fences.push(await request.json()); return new Response(null, { status: await onFence?.() ?? 204 }) },
        async TEXT_SOURCE(request) { assert.equal(request.url, source); requests.push(request.method); await onSource?.();
          return new Response(text, { headers: { 'content-type': 'text/plain' } }) },
      }, outboundService() { throw new Error('No external network in the fixture') }, log: new Log(LogLevel.ERROR) })
    runtime = new Miniflare({ ...options, ...(persist && { resourcePersistencePath: persist }), enableDevRegistry: false, telemetry: { enabled: false } })
    assert.equal((await runtime.ready).hostname, '127.0.0.1')
  }
  const close = async () => { await runtime?.dispose(); runtime = undefined }
  t.after(close)
  await launch()
  // Keep function identity stable across the restart; resolve the current runtime per request.
  const send = principal => (...args) => api(runtime, principal)(...args)
  const asRoot = send(root)
  const principal = result => ({ key: result.user_key })
  const owner = send(principal(await json(post(asRoot, accounts, { account_id: account, admin_user_id: 'owner' }))))
  const alice = send(principal(await json(post(owner, users, { user_id: 'alice' }))))
  const bob = send(principal(await json(post(owner, users, { user_id: 'bob' }))))
  await json(put(owner, '/gateway/admin/policies/default', { name: 'Fixture policy', capture: true }))
  await json(put(owner, '/gateway/admin/upstreams/chat', { name: 'Fixture model', protocol: 'chat', binding: 'workers_ai', models: [model] }))
  const dedicated = async requester => send({ key: (await json(post(requester, '/gateway/admin/keys', {
    name: 'Fixture', policy_id: 'default', upstream_ids: ['chat'], models: [model],
  }))).key })
  const workspace = async () => (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${account}`)
  const control = async () => (await runtime.getDurableObjectNamespace('CONTROL')).getByName('openviking:control:v1')
  const readAuthority = async () => JSON.parse(await (await control()).fixtureAuthoritySummary())
  const gate = kind => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers()
    const stage = async () => { entered.resolve(); return resume.promise }
    if (kind === 'ack') onFence = stage
    else onSource = stage
    return { entered: entered.promise, release(status) {
      if (kind === 'ack') onFence = undefined
      else onSource = undefined
      resume.resolve(status)
    } }
  }
  return { asRoot, owner, alice, bob, send, dedicated, principal, workspace, control, readAuthority, fences, requests, gate,
    restart: async () => { await close(); await launch() } }
}

async function entered(gate) {
  const signal = new AbortController()
  try { await Promise.race([gate.entered, delay(2500, null, { signal: signal.signal }).then(() => assert.fail('Fixture phase not reached'))]) }
  finally { signal.abort() }
}

async function held(f, send, mode) {
  const response = await post(send, '/gateway/v1/chat/completions', { model, stream: true, messages: [{ role: 'user', content: mode }] })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const read = response.body.getReader(), decoder = new TextDecoder()
  let raw = ''
  const chunk = async () => {
    const part = await read.read()
    raw += decoder.decode(part.value, { stream: !part.done })
    return !part.done
  }
  while (!raw.includes('Marée 🌊')) assert.equal(await chunk(), true)
  const stub = await f.workspace()
  const state = async () => JSON.parse(await stub.fixtureStreamState(mode))
  assert.deepEqual(await state(), { released: false, cancelled: false, tail: false })
  return { state, async end(release = false) {
    if (release) assert.equal(await stub.fixtureReleaseStream(mode), true)
    while (await chunk()) {}
    return raw
  } }
}

const success = raw => { assert.match(raw, / haute[\s\S]*\[DONE\]/); assert.doesNotMatch(raw, /openviking_key_invalid/) }
const retired = raw => { assert.match(raw, /openviking_key_invalid/); assert.doesNotMatch(raw, / haute|\[DONE\]/) }
const importUrl = (requester, to, wait) => post(requester, '/api/v1/resources', { path: source, to, wait })
async function ticketFor(requester) {
  await json(post(requester, '/api/v1/content/write', { uri: files, content: text, processing_mode: 'vectors_only' }))
  return json(post(requester, '/gateway/transfers/tickets', { action: 'download', uri: files, ticket_transport: 'header' }), 201)
}
const useTicket = (requester, ticket) => requester(ticket.url, { headers: { [ticket.ticket_header]: ticket.ticket } })

test('a quota refusal does not write a floor or interrupt admitted direct and dedicated streams', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const dedicated = await f.dedicated(f.bob)
  const a = await held(f, f.alice, 'sse-held'), b = await held(f, dedicated, 'sse-cancel')
  const cap = await (await f.control()).fixtureCappedUser()
  const before = await f.readAuthority()
  assert.deepEqual(before, { account: 0, members: [], keys: cap })
  await json(post(f.alice, rotations('alice'), {}), 413, 'RESOURCE_EXHAUSTED')
  assert.deepEqual(await f.readAuthority(), before)
  assert.deepEqual(f.fences, [])
  assert.equal((await a.state()).cancelled || (await b.state()).cancelled, false)
  success(await a.end(true)); success(await b.end(true))
  await json(f.alice(models))
})

test('a User rotates only their own authority; the other member finishes before the Workspace ACK is returned', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const dedicated = await f.dedicated(f.alice), bobTicket = await ticketFor(f.bob)
  const a = await held(f, dedicated, 'sse-held'), b = await held(f, f.bob, 'sse-cancel')
  const sourceGate = f.gate('source'), workspaceAck = f.gate('ack')
  const url = 'viking://~/resources/pending.txt'
  let rotation, accepted, acked = false
  try {
    accepted = await json(importUrl(f.alice, url, false))
    await entered(sourceGate)
    rotation = post(f.alice, rotations('alice'), {}).then(response => { acked = true; return response })
    await entered(workspaceAck)
    retired(await a.end())
    assert.equal((await a.state()).cancelled, true)
    assert.equal((await b.state()).cancelled, false)
    success(await b.end(true))
    const received = await useTicket(f.bob, bobTicket)
    assert.equal(received.status, 200)
    assert.equal(await received.text(), text)
    assert.equal(acked, false)
    await json(post(f.bob, rotations('bob'), {}), 409, 'CONFLICT')
    assert.deepEqual(f.fences, [{ scope: 'members', floors: [['alice', 1]] }])
  } finally { sourceGate.release(); workspaceAck.release(204) }
  const replacement = f.send(f.principal(await json(rotation)))
  await json(f.alice(models), 401, 'UNAUTHENTICATED')
  await json(dedicated(models), 401, 'openviking_key_invalid')
  await json(replacement(models))
  await json(post(replacement, '/api/v1/system/wait', { timeout: 8 }))
  const job = await json(replacement(`/api/v1/tasks/${accepted.task_id}`))
  assert.equal(job.status, 'failed')
  assert.equal(job.result, null)
  await json(replacement('/api/v1/content/read?' + new URLSearchParams({ uri: url })), 404)
  assert.deepEqual(f.requests, ['GET'])
  assert.deepEqual(await f.readAuthority(), { account: 0, members: [{ user_id: 'alice', revision: 1, pending: 0 }], keys: 2 })
})

test('only changed members lose their leases on a group edit or a role change', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const path = `${groups}/keepers/members`
  await json(post(f.owner, groups, { group_id: 'keepers' }))
  await json(put(f.owner, path, { user_ids: ['alice', 'bob'] }))
  const a = await held(f, f.alice, 'sse-held'), b = await held(f, f.bob, 'sse-cancel')
  assert.deepEqual(await json(put(f.owner, path, { user_ids: ['bob'] })), { added: false })
  assert.deepEqual(await json(f.owner(path, { method: 'DELETE', body: { user_ids: ['alice'] } })), { removed: true })
  retired(await a.end()); success(await b.end(true))

  const c = await held(f, f.alice, 'sse-reconfigure'), d = await held(f, f.bob, 'sse-idle')
  await json(put(f.owner, `${users}/alice/role`, { role: 'admin' }))
  retired(await c.end()); success(await d.end(true))
  assert.deepEqual(f.fences, [{ scope: 'members', floors: [['alice', 1]] }, { scope: 'members', floors: [['alice', 2]] }])
  assert.deepEqual(await f.readAuthority(), { account: 0, members: [{ user_id: 'alice', revision: 2, pending: 0 }], keys: 1 })
})

test('the account floor is reserved for an authorized change of the account ACL catalogue', { timeout: 12000 }, async t => {
  const f = await fixture(t)
  await json(post(f.owner, groups, { group_id: 'keepers' }))
  await json(put(f.owner, `${groups}/keepers/members`, { user_ids: ['alice'] }))
  const a = await held(f, f.alice, 'sse-held'), b = await held(f, f.bob, 'sse-cancel')
  await json(f.alice(`${groups}/keepers`, { method: 'DELETE' }), 403, 'PERMISSION_DENIED')
  assert.deepEqual(f.fences, [])
  await json(f.owner(`${groups}/keepers`, { method: 'DELETE' }))
  retired(await a.end()); retired(await b.end())
  assert.deepEqual(f.fences, [{ scope: 'account', revision: 1 }])
  assert.deepEqual(await f.readAuthority(), { account: 1, members: [], keys: 1 })
  await json(f.bob(models))
})

test('lost Workspace ACK persists only the affected member’s freeze; restart and authorized retry never reopen old leases', { timeout: 18000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rotation-sqlite-'))
  const f = await fixture(t, dir)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const oldTicket = await ticketFor(f.alice), peerTicket = await ticketFor(f.bob)
  const dedicated = await f.dedicated(f.alice)
  await json(dedicated(models))
  const workspaceAck = f.gate('ack')
  const rejected = post(f.alice, rotations('alice'), {})
  try { await entered(workspaceAck) } finally { workspaceAck.release(500) }
  await json(rejected, 503, 'GATEWAY_FENCE_UNAVAILABLE')
  const pending = { account: 0, members: [{ user_id: 'alice', revision: 1, pending: 1 }], keys: 1 }
  assert.deepEqual(await f.readAuthority(), pending)
  await f.restart()
  assert.deepEqual(await f.readAuthority(), pending)
  await json(f.alice(models), 401, 'openviking_key_invalid')
  await json(dedicated(models), 401, 'openviking_key_invalid')
  await json(useTicket(f.alice, oldTicket), 403, 'PERMISSION_DENIED')
  const peer = await useTicket(f.bob, peerTicket)
  assert.equal(peer.status, 200)
  assert.equal(await peer.text(), text)
  await json(f.bob(models))
  const replacement = f.send(f.principal(await json(post(f.alice, rotations('alice'), {}))))
  await json(replacement(models))
  await json(f.alice(models), 401, 'UNAUTHENTICATED')
  await json(useTicket(replacement, oldTicket), 401, 'invalid_transfer_ticket')
  assert.deepEqual(await f.readAuthority(), { account: 0, members: [{ user_id: 'alice', revision: 2, pending: 0 }], keys: 2 })
})
