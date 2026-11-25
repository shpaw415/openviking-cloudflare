// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const project = fileURLToPath(new URL('..', import.meta.url))
const source = 'https://docs.fixture.test/tide-note.txt'
const text = 'Synthetic notes from the tide gauge.'
const account = 'authority-fixture'
const root = testPrincipal('fixture-bootstrap', 'root', 'root')
const admin = testPrincipal(account, 'owner', 'admin')
const reader = testPrincipal(account, 'reader')
const group = `/api/v1/admin/accounts/${account}/groups`
const members = `${group}/editors/members`
const parent = 'viking://resources/tides'
const readPath = uri => '/api/v1/content/read?' + new URLSearchParams({ uri })
const statPath = uri => '/api/v1/fs/stat?' + new URLSearchParams({ uri })
const post = (send, path, body) => send(path, { method: 'POST', body })
const issue = (send, uri) => post(send, '/gateway/transfers/tickets', { action: 'download', uri, ticket_transport: 'header' })
const download = (send, ticket) => send(ticket.url, { headers: { [ticket.ticket_header]: ticket.ticket } })
const enqueue = (send, dir, wait = false) => post(send, '/api/v1/resources', { path: source, parent: dir, create_parent: true, wait })

async function json(pending, status = 200, code) {
  const response = await pending
  assert.equal(response.status, status)
  const value = await response.json()
  if (code) assert.equal(value.error?.code ?? value.reason, code)
  return value.result
}

const worker = build({ absWorkingDir: project, stdin: { resolveDir: project, contents: `
  import worker, { Control as BaseControl, Workspace as BaseWorkspace } from './src/worker.ts';
  const withAI = env => ({...env, AI: { async run(model, {text}) {
    if (model !== '@cf/baai/bge-base-en-v1.5') throw Error('Fixture is embeddings only');
    return (await env.BARRIER.fetch('https://fixtures.invalid/embedding', {method:'POST',body:JSON.stringify(text)})).json();
  } }});
  export default { fetch(request, env, execution) { return worker.fetch(request, withAI(env), execution); } };
  export class Control extends BaseControl {
    dataAuthorityGrant(owner, fixed, expected) {
      if (this.env.TEST_UNAVAILABLE === '1') throw Error('Fixture cannot confirm authority');
      return super.dataAuthorityGrant(owner, fixed, expected);
    }
  }
  export class Workspace extends BaseWorkspace {
    constructor(ctx, env) { super(ctx, withAI(env)); }
    async workspaceContext(...args) {
      const context = await super.workspaceContext(...args);
      const load = context.loadDataAuthority;
      if (load && context.caller.userId === 'reader') context.loadDataAuthority = async expected => {
        const snapshot = await load(expected);
        // Hold the returned Control grant at the Workspace receiver, not
        // inside Control's own concurrency gate.
        if (expected !== undefined && snapshot.status === 'ok') await this.env.BARRIER.fetch('https://fixtures.invalid/directory');
        return snapshot;
      };
      return context;
    }
    async fenceGatewayCredentials(account, revision) {
      const receipt = await super.fenceGatewayCredentials(account, revision);
      await this.env.BARRIER.fetch('https://fixtures.invalid/acknowledgement');
      return receipt;
    }
    async alarm() {
      await this.env.BARRIER.fetch('https://fixtures.invalid/scheduler');
      return super.alarm();
    }
    async dataFixtureLedger() {
      return JSON.stringify({ tickets: this.ctx.storage.sql.exec('SELECT count(*) AS n FROM ov_edge_gateway_transfer').one().n,
        spent: this.ctx.storage.sql.exec('SELECT count(*) AS n FROM ov_edge_gateway_transfer WHERE spent=1').one().n });
    }
  }
  ` }, bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers'] })

async function harness(t, { authorities = 'available' } = {}) {
  const { outputFiles } = await worker
  const gates = new Map(), calls = { source: 0, embedding: 0, outbound: 0 }
  async function cross(label) {
    const gate = gates.get(label)
    if (!gate?.triggered) {
      if (!gate) return
      gate.triggered = true
      gate.enter.resolve()
      await gate.resume.promise
    }
  }
  function gate(label) {
    assert.ok(!gates.has(label))
    const enter = Promise.withResolvers(), resume = Promise.withResolvers()
    gates.set(label, { enter, resume, triggered: false })
    return { entered: enter.promise, release() { gates.delete(label); resume.resolve() } }
  }
  const options = convertV4MiniflareOptions({ modules: true, name: 'data-authority-local', host: '127.0.0.1', port: 0,
    script: outputFiles[0].text, compatibilityDate: '2026-11-19', cf: false, logRequests: false,
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true },
      ...(authorities !== 'unmounted' && { CONTROL: { className: 'Control', useSQLite: true } }) },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root, admin, reader]), OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1',
      OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: randomBytes(32).toString('hex'), OPENVIKING_EDGE_TEXT_SOURCES: JSON.stringify([source]),
      ...(authorities === 'unavailable' && { TEST_UNAVAILABLE: '1' }),
    }, serviceBindings: {
      async BARRIER(request) {
        const label = new URL(request.url).pathname.slice(1)
        await cross(label)
        if (label !== 'embedding') return new Response(null, { status: 204 })
        calls.embedding++
        const texts = await request.json()
        return Response.json({ data: texts.map(() => [1, ...Array(767).fill(0)]) })
      },
      async TEXT_SOURCE(request) {
        assert.equal(request.url, source)
        calls.source++
        await cross('source')
        return new Response(text, { headers: { 'content-type': 'text/plain' } })
      },
    }, outboundService() { calls.outbound++; return new Response(null, { status: 599 }) }, log: new Log(LogLevel.ERROR),
  })
  const runtime = new Miniflare({ ...options, enableDevRegistry: false, telemetry: { enabled: false } })
  t.after(async () => {
    for (const item of gates.values()) item.resume.resolve()
    try { assert.equal(calls.outbound, 0) } finally { await runtime.dispose() }
  })
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  const asRoot = api(runtime, root), manage = api(runtime, admin), send = api(runtime, reader)
  const setMembership = verb => json(manage(members, { method: verb, body: { user_ids: ['reader'] } }))
  async function setUpShared() {
    await json(post(manage, group, { group_id: 'editors' }))
    await setMembership('PUT')
    await json(post(manage, '/api/v1/fs/mkdir', { uri: parent, acl: { acl_mode: 'restricted', entries: [
      { principal: 'group:editors', level: 'write' },
    ] } }))
  }
  const ledger = async () => JSON.parse(await (await runtime.getDurableObjectNamespace('WORKSPACES'))
    .getByName(`openviking:account:${account}`).dataFixtureLedger())
  return { runtime, asRoot, manage, send, setMembership, setUpShared, ledger, gate, calls }
}

async function entered(gate) {
  const deadline = new AbortController()
  try { await Promise.race([gate.entered, delay(3000, null, { signal: deadline.signal }).then(() => assert.fail('Expected phase not reached'))]) }
  finally { deadline.abort() }
}

test('a legitimate download waits at the directory; the Workspace floor orders refusal before the Control acknowledgement', { timeout: 12000 }, async t => {
  const f = await harness(t)
  await f.setUpShared()
  assert.equal((await json(f.send('/api/v1/system/edge-capabilities'))).features.urlImport, true)
  const uri = `${parent}/ledger.txt`
  await json(post(f.manage, '/api/v1/content/write', { uri, content: text, processing_mode: 'vectors_only' }))
  const ticket = await json(issue(f.send, uri), 201)
  const directory = f.gate('directory'), ack = f.gate('acknowledgement')
  const pending = download(f.send, ticket)
  let acknowledged = false
  try {
    await entered(directory)
    const change = f.setMembership('DELETE').then(result => { acknowledged = true; return result })
    await entered(ack) // The real SQLite floor has moved; Control has not committed the change yet.
    directory.release()
    const refused = await pending
    assert.equal(refused.status, 403)
    assert.equal(refused.headers.has('content-disposition'), false)
    assert.equal(acknowledged, false)
    const { error } = await refused.json()
    assert.equal(error.code, 'PERMISSION_DENIED')
    assert.deepEqual(await f.ledger(), { tickets: 1, spent: 0 })
    ack.release()
    assert.deepEqual(await change, { removed: true })
  } finally { directory.release(); ack.release() }
  await json(issue(f.send, uri), 403)
  await f.setMembership('PUT')
  await json(download(f.send, ticket), 401, 'invalid_transfer_ticket')
  const fresh = await json(issue(f.send, uri), 201)
  const current = await download(f.send, fresh)
  assert.equal(current.status, 200)
  assert.equal(await current.text(), text)
})

test('one-time URL import rechecks after document I/O; a model import alone does not retire the Data lease', { timeout: 12000 }, async t => {
  const f = await harness(t)
  await f.setUpShared()
  const blocked = `${parent}/missing`
  let held = f.gate('source')
  const pending = enqueue(f.send, blocked, true)
  try { await entered(held); await f.setMembership('DELETE') }
  finally { held.release() }
  await json(pending, 403, 'PERMISSION_DENIED')
  assert.deepEqual(f.calls, { source: 1, embedding: 0, outbound: 0 })
  await json(f.manage(statPath(blocked)), 404)
  await f.setMembership('PUT')
  held = f.gate('source')
  const current = enqueue(f.send, blocked, true)
  try {
    await entered(held)
    const settings = await json(post(f.asRoot, '/api/v1/admin/configuration/import?if_revision=0', { default_search_limit: 2 }))
    assert.equal(settings.revision, 1)
  } finally { held.release() }
  const completed = await json(current)
  assert.equal(await json(f.send(readPath(completed.uri))), text)
  assert.deepEqual(f.calls, { source: 2, embedding: 1, outbound: 0 })
})

test('the deferred URL consumer cannot adopt a replacement scope; after indexing it cannot publish a stale success either', { timeout: 15000 }, async t => {
  const f = await harness(t)
  await f.setUpShared()
  const blocked = `${parent}/queued`
  const scheduler = f.gate('scheduler')
  const first = await json(enqueue(f.send, blocked))
  try {
    await entered(scheduler)
    await f.setMembership('DELETE')
    await f.setMembership('PUT') // Current rights are valid; this accepted job still has its original revision.
  } finally { scheduler.release() }
  await json(post(f.send, '/api/v1/system/wait', { timeout: 8 }))
  const task = id => json(f.send(`/api/v1/tasks/${id}`))
  assert.equal((await task(first.task_id)).status, 'failed')
  assert.deepEqual(f.calls, { source: 0, embedding: 0, outbound: 0 })
  await json(f.manage(statPath(blocked)), 404)

  const index = f.gate('embedding')
  const second = await json(enqueue(f.send, blocked))
  try { await entered(index); await f.setMembership('DELETE') }
  finally { index.release() }
  await json(post(f.send, '/api/v1/system/wait', { timeout: 8 }))
  const ended = await task(second.task_id)
  assert.equal(ended.status, 'failed')
  assert.equal(ended.result, null)
  assert.deepEqual(f.calls, { source: 1, embedding: 1, outbound: 0 })
  await json(f.manage(statPath(blocked)), 404)
  await f.setMembership('PUT')
  const fresh = await json(enqueue(f.send, blocked))
  await json(post(f.send, '/api/v1/system/wait', { timeout: 8 }))
  const complete = await task(fresh.task_id)
  assert.equal(complete.status, 'completed')
  assert.equal(await json(f.send(readPath(complete.result.uri))), text)
})

test('authority unmounted or unavailable denies effects without blocking ordinary fixed-key Data reads', { timeout: 12000 }, async t => {
  for (const authorities of ['unmounted', 'unavailable']) {
    const f = await harness(t, { authorities })
    const ordinary = 'viking://~/resources/plain.txt'
    await json(post(f.send, '/api/v1/content/write', { uri: ordinary, content: text, defer_processing: true }))
    assert.equal(await json(f.send(readPath(ordinary))), text)
    if (authorities === 'unmounted') {
      const capabilities = await json(f.send('/api/v1/system/edge-capabilities'))
      assert.equal(capabilities.features.urlImport, false)
    }
    await json(issue(f.send, ordinary), 503, 'AUTH_UNAVAILABLE')
    await json(enqueue(f.send, 'viking://~/resources/one-time', true), 503, 'AUTH_UNAVAILABLE')
    await json(enqueue(f.send, 'viking://~/resources/scheduled'), 503, 'AUTH_UNAVAILABLE')
    assert.deepEqual(f.calls, { source: 0, embedding: 0, outbound: 0 })
  }
})
