// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import test from 'node:test'
import { api, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('archive-config-bootstrap', 'owner', 'root')
const member = testPrincipal('archive-config-space', 'reader')
const config = '/api/v1/admin/configuration/import'
const post = (send, path, body) => send(path, { method: 'POST', body })

async function result(reply, status = 200) {
  const response = await reply, body = await response.json()
  assert.equal(response.status, status, body.error?.code)
  return response.ok ? body.result : body.error
}

test('a policy change orders new synchronous and queued archive seals without rewriting existing archives', { timeout: 18000 }, async t => {
  const { outputFiles } = await build({ stdin: { sourcefile: 'archive-config-fixture.mjs', resolveDir: process.cwd(), contents: `
    import app, { Control, Workspace as RealWorkspace } from './src/worker.ts';
    export { Control };
    export default app;
    export class Workspace extends RealWorkspace {
      async workspaceContext(...args) {
        const ctx = await super.workspaceContext(...args);
        const request = args[2];
        if (request?.headers.get('idempotency-key') === 'fixture-held-new-archive') {
          await this.env.SEAL_FIXTURE.fetch('https://fixture.invalid/hold');
        }
        return ctx;
      }
    }
  ` }, write: false, format: 'esm', platform: 'browser', bundle: true, external: ['cloudflare:workers'] })
  let latch, entered, outbound = 0
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false,
    compatibilityDate: '2026-11-19', modules: true, script: outputFiles[0].text,
    log: new Log(LogLevel.ERROR), bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([root, member]) },
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    serviceBindings: { async SEAL_FIXTURE() { entered.resolve(); await latch.promise; return new Response(null, { status: 204 }) } },
    outboundService() { outbound++; return new Response(null, { status: 599 }) },
  }))
  t.after(async () => { latch?.resolve(); await runtime.dispose() })
  const control = api(runtime, root), send = api(runtime, member)
  const select = extraction_enabled => result(post(control, config, { memory: { extraction_enabled } }))
  await select(false)
  const sessions = '/api/v1/sessions'
  await result(post(send, `${sessions}/preserved/messages`, { role: 'user', content: 'Previously archived fiction.' }))
  await result(post(send, `${sessions}/preserved/commit?wait=true`, {}))
  const previous = `${sessions}/preserved/archives/archive_001`
  const snapshot = await result(send(previous))
  for (const mode of ['sync', 'async']) {
    const path = `${sessions}/revision-${mode}`
    await select(true)
    await result(post(send, `${path}/messages`, { role: 'user', content: 'A new fictional line.' }))
    const wait = mode === 'sync'
    latch = Promise.withResolvers(); entered = Promise.withResolvers()
    const pending = send(`${path}/commit?wait=${wait}`, { method: 'POST', body: {},
      headers: { 'idempotency-key': 'fixture-held-new-archive' } })
    await Promise.race([entered.promise, pending.then(r => assert.fail(`Archive did not reach the policy boundary: ${r.status}`))])
    await select(false)
    latch.resolve()
    assert.equal((await result(pending, 409)).code, 'CONFLICT')
    assert.equal((await result(send(path))).message_count, 1)
    await result(send(`${path}/archives/archive_001`), 404)
    const fresh = await result(post(send, `${path}/commit?wait=${wait}`, {}))
    if (!wait) {
      assert.equal(fresh.status, 'accepted')
      await result(post(send, '/api/v1/system/wait', { timeout: 5 }))
      assert.equal((await result(send(`/api/v1/tasks/${fresh.task_id}`))).status, 'completed')
    }
    const after = await result(send(`${path}/archives/archive_001`))
    assert.equal(after.messages.length, 1)
    assert.equal((await result(send(path))).message_count, 0)
  }
  assert.deepEqual(await result(send(previous)), snapshot)
  assert.equal(outbound, 0)
})
