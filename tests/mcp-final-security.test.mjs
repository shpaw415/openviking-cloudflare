// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('root-fixture', 'root', 'root')
const owner = testPrincipal('mcp-final', 'owner', 'admin')
const neighbor = testPrincipal('mcp-final', 'neighbor')
const origin = 'https://mcp-provider.example.test/v1', key = randomBytes(32).toString('hex')
const uri = 'viking://user/owner/resources/lantern.md', sid = 'lantern-fixture'
const combined = { query: 'lantern', mode: 'context', session_id: sid, detail: 'full', dedup_turns: 1, min_score: 0 }
const call = (args, id = 5) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: args } })
const project = fileURLToPath(new URL('..', import.meta.url))

// Only this test bundle has private observability and an authority-race seam.
// No public route, test dependency or override in the production entry point.
const bundle = build({ absWorkingDir: project, stdin: { resolveDir: project, contents: `
  import worker, { Workspace as BaseWorkspace, Control } from './src/worker.ts';
  import { fenceDataAuthority } from './src/data-authority.ts';
  export { Control };
  export default worker;
  export class Workspace extends BaseWorkspace {
    cancelled = 0;
    completed = [];
    lateFence = false;
    constructor(ctx, env) {
      super(ctx, {...env, AI: { async run(model, {text}) {
        if (model !== '@cf/baai/bge-base-en-v1.5') throw Error('Only fixture embeddings are mounted');
        return (await env.HOLD.fetch('https://fixture.invalid/binding', {method:'POST',body:JSON.stringify(text)})).json();
      } }});
    }
    async cancelContextSearch(...args) {
      await super.cancelContextSearch(...args);
      this.cancelled++;
    }
    async dispatch(request, ...args) {
      const isMcp = new URL(request.url).pathname === '/mcp';
      const response = await super.dispatch(request, ...args);
      if (isMcp) this.completed.push(response.status);
      return response;
    }
    async workspaceContext(...args) {
      const ctx = await super.workspaceContext(...args);
      if (this.lateFence && ctx.prepareMcpSearch) {
        Object.defineProperty(ctx, 'publishMcpSearch', { set: callback => {
          Object.defineProperty(ctx, 'publishMcpSearch', { value: () => {
            this.lateFence = false;
            // Apply the production SQLite member floor just before handoff.
            fenceDataAuthority(ctx.sql, { scope: 'members', floors: [[ctx.caller.userId, 1]] });
            callback();
          } });
        }, configurable: true });
      }
      return ctx;
    }
    async fixtureArmFence() { this.lateFence = true; }
    async fixtureState() {
      const sql = this.ctx.storage.sql;
      return JSON.stringify({ cancelled: this.cancelled, completed: this.completed,
        ledger: sql.exec('SELECT user_id, session_id, revision, served FROM ov_edge_context_recall ORDER BY user_id, session_id').toArray() });
    }
  }
` }, bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers'] })

async function fixture(t, { policy = 'read-write', native = false } = {}) {
  const { outputFiles: [output] } = await bundle
  let hold
  const calls = []
  const cross = async stage => {
    calls.push(stage)
    if (hold?.stage === stage) {
      hold.enter.resolve()
      await hold.release.promise
    }
  }
  const worker = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, host: '127.0.0.1', port: 0,
    name: 'mcp-final-test', script: output.text, compatibilityDate: '2026-11-19', log: new Log(LogLevel.ERROR), cf: false,
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root, owner, neighbor]), OPENVIKING_EDGE_MCP: policy,
      OPENVIKING_EDGE_MCP_LIVE: '1', OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: origin, api_key: key }]) },
    serviceBindings: { async HOLD(req) {
      const texts = await req.json()
      await cross('binding')
      return Response.json({ data: texts.map(() => [1, ...Array(767).fill(0)]) })
    } },
    async outboundService(req) {
      assert.ok(req.headers.get('authorization') === `Bearer ${key}`)
      const data = await req.json()
      if (req.url === `${origin}/embeddings`) {
        await cross('embedding')
        return Response.json({ data: data.input.map((_, index) => ({ index, embedding: [1, 0] })) })
      }
      assert.equal(req.url, `${origin}/chat/completions`)
      const planning = data.messages[0].content.startsWith('openviking_edge_query_expansion_v1')
      await cross(planning ? 'planner' : 'digest')
      return Response.json({ choices: [{ message: { role: 'assistant', content: planning ? '{"queries":["alternative lantern"]}' : `- A fictional light. ${uri}` } }] })
    },
  }), enableDevRegistry: false, telemetry: { enabled: false } })
  t.after(async () => { hold?.release.resolve(); await worker.dispose() })
  const send = api(worker, owner), admin = api(worker, root), peer = api(worker, neighbor)
  const post = (client, path, body) => client(path, { method: 'POST', body })
  const provider = { provider: 'openai-compatible', api_base: origin }
  assert.equal((await post(admin, '/api/v1/admin/configuration/import', { vlm: { ...provider, model: 'test-vlm' },
    retrieval: { edge_context_rewrite: true }, ...(!native && { embedding: { dense: { ...provider, model: 'test-vector', dimension: 2 } } }) })).status, 200)
  assert.equal((await post(send, '/api/v1/content/write', { uri, content: 'Fictional lantern reference.', wait: true })).status, 200)
  assert.equal((await post(send, '/api/v1/sessions', { session_id: sid })).status, 200)
  calls.length = 0
  const stub = (await worker.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${owner.accountId}`)
  return { worker, calls, send, peer, stub, state: async () => JSON.parse(await stub.fixtureState()),
    mcp: (args, client = send) => post(client, '/mcp', call(args)),
    hold(stage) {
      const gate = hold = { stage, enter: Promise.withResolvers(), release: Promise.withResolvers() }
      return { entered: gate.enter.promise, release() { hold = undefined; gate.release.resolve() } }
    }, hash: createHash('sha256').update(output.text).digest('hex') }
}

async function result(pending) {
  const response = await pending
  assert.equal(response.status, 200)
  const wire = await response.json()
  assert.equal(wire.id, 5)
  assert.ok(wire.result)
  return wire.result
}

async function until(state, predicate, message) {
  const end = Date.now() + 2000
  do {
    const value = await state()
    if (predicate(value)) return value
    await delay(15)
  } while (Date.now() < end)
  assert.fail(message)
}

async function tcp(worker, args) {
  const url = await worker.ready
  assert.equal(url.hostname, '127.0.0.1')
  const body = JSON.stringify(call(args))
  let socket
  const result = new Promise(resolve => {
    const req = request(new URL('/mcp', url), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-api-key': owner.key } }, response => resolve(response.statusCode))
    req.once('socket', value => { socket = value })
    req.once('error', error => resolve(error.code))
    req.end(body)
  })
  return { result, reset: () => socket.resetAndDestroy() }
}

test('MCP read rejects ledger mutation before any provider, but permits read-only context', { timeout: 12_000 }, async t => {
  const f = await fixture(t, { policy: 'read' })
  const before = (await f.state()).ledger
  assert.equal(before[0].revision, 0)
  const rejected = await result(f.mcp({ ...combined, query_expansion: 'auto', rewrite: 'auto' }))
  assert.equal(rejected.structuredContent.error.code, 'PERMISSION_DENIED')
  assert.deepEqual(f.calls, [])
  assert.deepEqual((await f.state()).ledger, before)
  const read = await result(f.mcp({ ...combined, dedup_turns: 0 }))
  assert.equal(read.structuredContent.entries[0].uri, uri)
  assert.deepEqual(f.calls, ['embedding'])
  assert.deepEqual((await f.state()).ledger, before)
  console.log(`MCP defensive Workerd bundle sha256=${f.hash}`)
})

test('MCP read-write commits only an authorized served result; late member fence rejects handoff', { timeout: 12_000 }, async t => {
  const f = await fixture(t)
  const before = (await f.state()).ledger
  const found = await result(f.mcp(combined))
  assert.equal(found.structuredContent.entries[0].uri, uri)
  const committed = (await f.state()).ledger
  assert.equal(committed[0].revision, 1)
  assert.notEqual(committed[0].served, before[0].served)
  assert.deepEqual((await result(f.mcp(combined))).structuredContent.entries, [])
  assert.equal((await result(f.mcp(combined, f.peer))).structuredContent.error.code, 'NOT_FOUND')
  assert.deepEqual((await f.state()).ledger, committed)
  const next = 'late-fence-fixture'
  assert.equal((await f.send('/api/v1/sessions', { method: 'POST', body: { session_id: next } })).status, 200)
  const snapshot = (await f.state()).ledger
  await f.stub.fixtureArmFence()
  const denied = await f.mcp({ ...combined, session_id: next })
  assert.equal(denied.status, 403)
  const wire = await denied.json()
  assert.equal(wire.error.code, 'PERMISSION_DENIED')
  assert.doesNotMatch(JSON.stringify(wire), /Fictional lantern|resources\/lantern/u)
  assert.deepEqual((await f.state()).ledger, snapshot)
})

for (const [stage, args, expected] of [
  ['planner', { query_expansion: 'auto', rewrite: 'auto' }, ['planner']],
  ['embedding', { query_expansion: 'auto', rewrite: 'auto' }, ['planner', 'embedding']],
  ['digest', { rewrite: 'auto' }, ['embedding', 'digest']],
  ['binding', { query_expansion: 'auto', rewrite: 'auto' }, ['planner', 'binding']],
]) {
  test(`MCP TCP reset during ${stage} prevents follow-up providers and ledger publication`, { timeout: 12_000 }, async t => {
    const f = await fixture(t, { native: stage === 'binding' })
    const before = (await f.state()).ledger
    const gate = f.hold(stage)
    const client = await tcp(f.worker, { ...combined, ...args })
    try {
      await Promise.race([gate.entered, client.result.then(value => assert.fail(`Provider boundary not reached: ${value}`))])
      client.reset()
      assert.equal(await client.result, 'ECONNRESET')
      await until(f.state, value => value.cancelled === 1, 'Workspace did not receive the cancellation')
      if (stage === 'binding') {
        assert.deepEqual((await f.state()).completed, [], 'non-interruptible binding has not returned')
        gate.release()
      }
      const stopped = await until(f.state, value => value.completed.length === 1, 'Search did not stop while the HTTP provider remained held')
      assert.deepEqual(stopped.completed, [409])
      assert.deepEqual(stopped.ledger, before)
      assert.deepEqual(f.calls, expected)
    } finally { gate.release() }
  })
}
