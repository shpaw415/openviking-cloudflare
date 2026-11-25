// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { resolve, basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const base = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const adapter = `export default { async fetch(request, env) {
  const action = new URL(request.url).pathname.slice(1);
  if (action === 'ready') return new Response(null, { status: 204 });
  if (action === 'identify') return env.OPERATOR.identify();
  if (action === 'capture') return env.OPERATOR.capture();
  if (action === 'capture-pieces') return env.OPERATOR.capture('edge-v1-attachments');
  if (action === 'status') return env.OPERATOR.status();
  if (action === 'account-capture') return env.WORKSPACE_BACKUP.capture((await request.json()).account, { profile: 'edge-v1' });
  const body = await request.json();
  const bytes = Uint8Array.from(atob(body.archive), c => c.charCodeAt(0)).buffer;
  if (action === 'evaluate') return env.OPERATOR.evaluate(bytes);
  if (action === 'begin') return env.OPERATOR.begin(bytes, body.approval);
  if (action === 'step') return env.OPERATOR.step(bytes, body.index);
  if (action === 'release') return env.OPERATOR.release(bytes);
  return new Response(null, { status: 404 });
} };`

// Separate synthetic fault bundle. Append one throw *after* all three real
// inserts, before SQLite sees the transaction callback return. No product flag.
const rollbackFault = { name: 'late-sqlite-fixture-fault', setup(build) {
  build.onLoad({ filter: /\/instance-workspace\.ts$/ }, async ({ path }) => {
    const text = await readFile(path, 'utf8'), point = '          return receipt\n'
    if (text.split(point).length !== 2) throw new Error('Rollback test attachment point changed.')
    const contents = text.replace(point, `          if (env.FIXTURE_ABORT_BACKUP_COMMIT && count === 1 &&
            sql.exec('SELECT count(*) AS n FROM ov_edge_fs_entry WHERE is_dir=0').one().n === 1 &&
            sql.exec('SELECT count(*) AS n FROM ov_edge_gateway_attachment').one().n === 1 &&
            sql.exec('SELECT count(*) AS n FROM ov_edge_instance_restore_receipt').one().n === 1) {
            throw new Error('Synthetic interruption inside final restore transaction')
          }\n` + point)
    return { contents, loader: 'ts' }
  })
} };

function config(namespace, vars, ai) {
  return `using Workerd = import "/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "product", worker = (modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny", durableObjectStorage = (localDisk = "disk"),
      durableObjectNamespaces = [
        (className = "Control", uniqueKey = "${namespace}-control", enableSql = true),
        (className = "Workspace", uniqueKey = "${namespace}-workspace", enableSql = true)
      ], bindings = [
        (name = "CONTROL", durableObjectNamespace = (className = "Control")),
        (name = "WORKSPACES", durableObjectNamespace = (className = "Workspace")),
        ${ai ? '(name = "AI", service = (name = "fixture-ai")),' : ''}
        ${Object.entries(vars).filter(([, value]) => value != null).map(([name, value]) =>
          `(name = "${name}", text = ${JSON.stringify(value)})`).join(',')}
      ])),
    (name = "driver", worker = (modules = [(name = "adapter.mjs", esModule = embed "adapter.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny", bindings = [
        (name = "OPERATOR", service = (name = "product", entrypoint = "InstanceBackupOperator")),
        (name = "WORKSPACE_BACKUP", service = (name = "product", entrypoint = "BackupOperator"))
      ])),
    ${ai ? '(name = "fixture-ai", worker = (modules = [(name = "ai.mjs", esModule = embed "ai.mjs")], compatibilityDate = "2026-11-19", globalOutbound = "deny")),' : ''}
    (name = "disk", disk = (path = "state", writable = true)),
    (name = "deny", worker = (compatibilityDate = "2026-11-19", modules = [
      (name = "deny.mjs", esModule = "export default { fetch() { return new Response(null,{status:503}) } }")]))
  ], sockets = [(name = "http", service = "product"), (name = "operator", service = "driver")]
);`
}

export async function instanceHarness(t, principals, options) {
  const { outputFiles } = await build({ absWorkingDir: base, entryPoints: ['src/worker.ts'],
    plugins: options.rollbackFixture ? [rollbackFault] : [], bundle: true,
    external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false })
  const dir = await mkdtemp(resolve(base, '.work/ib-')), api = resolve(dir, 'api.sock'), op = resolve(dir, 'op.sock')
  const namespace = options.namespace ?? basename(dir)
  const root = randomBytes(32).toString('hex'), accountKey = randomBytes(32).toString('hex')
  const transferKey = options.attachments ? randomBytes(32).toString('hex') : undefined
  const rootActor = { accountId: 'root-fixture', userId: 'root-fixture', agentId: 'default', role: 'root', key: root }
  let child, stopped
  async function close() {
    if (!child) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000)
    try { await stopped } finally { clearTimeout(timer); child = undefined }
    await Promise.all([api, op].map(path => rm(path, { force: true })))
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  await mkdir(resolve(dir, 'state'))
  await writeFile(resolve(dir, 'worker.mjs'), outputFiles[0].text, { mode: 0o600 })
  await writeFile(resolve(dir, 'adapter.mjs'), adapter, { mode: 0o600 })
  if (options.ai) await writeFile(resolve(dir, 'ai.mjs'), `import { WorkerEntrypoint } from 'cloudflare:workers';
    export default class Fixture extends WorkerEntrypoint {
      run(model, { text }) {
        if (model !== '@cf/baai/bge-base-en-v1.5' || !Array.isArray(text)) throw new Error('Only synthetic embeddings are allowed');
        return { data: text.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)) };
      }
    }`, { mode: 0o600 })

  async function http(socketPath, path, { key, body, headers, method = body === undefined ? 'GET' : 'POST' } = {}) {
    let type = 'application/json', payload = body === undefined ? undefined : JSON.stringify(body)
    if (body instanceof FormData) {
      const serialized = new Request('http://localhost', { method: 'POST', body })
      type = serialized.headers.get('content-type')
      payload = Buffer.from(await serialized.arrayBuffer())
    }
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path, method, agent: false, timeout: 8000, headers: {
        ...(key && { 'x-api-key': key }), ...(payload && { 'content-type': type, 'content-length': Buffer.byteLength(payload) }), ...headers,
      } }, res => {
        const chunks = []
        res.on('error', reject)
        res.on('data', value => chunks.push(value))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          const json = res.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString('utf8')) : undefined
          resolve({ status: res.statusCode, headers: res.headers, bytes, json })
        })
      })
      req.on('timeout', () => req.destroy(new Error('Instance fixture timeout')))
      req.on('error', reject)
      req.end(payload)
    })
  }

  async function start({ mode, policy = options.policy, actors = principals, key = options.key, abortCommit = false } = {}) {
    if (abortCommit && !options.rollbackFixture) throw new Error('Not a rollback fixture.')
    await writeFile(resolve(dir, 'main.capnp'), config(namespace, {
      OPENVIKING_EDGE_KEYS: JSON.stringify([rootActor, ...actors]), OPENVIKING_EDGE_BACKUP_KEY: accountKey,
      OPENVIKING_EDGE_BACKUP_POLICY: JSON.stringify(policy), OPENVIKING_EDGE_INSTANCE_BACKUP_KEY: key,
      OPENVIKING_EDGE_INSTANCE_BACKUP: mode === undefined ? undefined : JSON.stringify(mode),
      OPENVIKING_EDGE_GATEWAY_TRANSFERS: transferKey ? '1' : undefined, OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: transferKey,
      FIXTURE_ABORT_BACKUP_COMMIT: abortCommit ? '1' : undefined,
    }, options.ai), { mode: 0o600 })
    const exe = require.resolve(`@cloudflare/workerd-linux-${process.arch === 'arm64' ? 'arm64' : '64'}/bin/workerd`)
    child = spawn('/usr/bin/python3', ['-I', resolve(base, 'tests/control/offline.py'), exe, 'serve', '--experimental',
      '-I', resolve(base, 'node_modules/workerd'), '--socket-addr', `http=unix:${api}`, '--socket-addr', `operator=unix:${op}`, '--', 'main.capnp'],
    { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048) })
    stopped = once(child, 'exit')
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Workerd mount failed; see safe diagnostic: ${stderr.replace(/[a-f0-9]{32,}/gi, '[fixture id]')}`)
      if ((await http(api, '/health').catch(() => null))?.status === 200 && (await http(op, '/ready').catch(() => null))?.status === 204) return
      await delay(25)
    }
    throw new Error('Workerd mount timeout.')
  }

  await start()
  return { root, dir, close, restart: async opts => { await close(); await start(opts) }, send: (path, opts) => http(api, path, opts),
    operator: (path, body) => http(op, `/${path}`, { body }), inspect(action, ...args) {
      if (child) throw new Error('Inspect SQLite only with the owned synthetic worker stopped.')
      const result = spawnSync('/usr/bin/python3', ['-I', resolve(base, 'tests/archives/instance-oracle.py'), action, dir, ...args],
        { timeout: 4000, maxBuffer: 8192 })
      if (result.status !== 0) throw new Error(`Fixture inspection failed: ${result.stderr.toString().slice(-500)}`)
      return JSON.parse(result.stdout)
    } }
}
