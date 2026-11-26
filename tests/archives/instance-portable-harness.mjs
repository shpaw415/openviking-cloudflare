// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { glob, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const base = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const workerd = require.resolve(`@cloudflare/workerd-linux-${process.arch === 'arm64' ? 'arm64' : '64'}/bin/workerd`)
const guard = join(base, 'tests/control/offline.py')
export const random = n => randomBytes(n).toString('hex')
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const driver = `export default { async fetch(request, env) {
  const op = new URL(request.url).pathname.slice(1);
  if (op === 'identify' || op === 'status') return env.OP[op]();
  if (op === 'capture') return env.OP.capture((await request.json()).profile);
  if (!['evaluate','begin','step','release'].includes(op)) return new Response(null, {status:404});
  const { archive, arg } = await request.json();
  return env.OP[op](Uint8Array.from(atob(archive), c => c.charCodeAt(0)).buffer, arg);
} };`

export async function portableBundle() {
  const { outputFiles } = await build({ absWorkingDir: base, entryPoints: ['src/worker.ts'], bundle: true,
    platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false })
  return outputFiles[0].contents
}

export async function portableHarness(t, bundle, principals, key, policy) {
  const dir = await mkdtemp(join(base, '.work/pv-')), ns = basename(dir)
  const sockets = { data: join(dir, 'data.sock'), operator: join(dir, 'op.sock') }
  const root = random(32), accountKey = random(32)
  const rootActor = { accountId: 'fixture-root', userId: 'fixture-root', agentId: 'default', role: 'root', key: root }
  let child, stopped
  async function close() {
    if (!child) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await stopped } finally { clearTimeout(timer); child = undefined }
    await Promise.all(Object.values(sockets).map(socket => rm(socket, { force: true })))
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'state'))
  await writeFile(join(dir, 'worker.mjs'), bundle, { mode: 0o600 })
  await writeFile(join(dir, 'driver.mjs'), driver, { mode: 0o600 })
  await writeFile(join(dir, 'ai.mjs'), `import { WorkerEntrypoint } from 'cloudflare:workers';
    export default class Fixture extends WorkerEntrypoint {
      run(model, { text }) {
        if (model !== '@cf/baai/bge-base-en-v1.5' || !Array.isArray(text)) throw new Error('Only embeddings are allowed');
        return { data: text.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)) };
      }
    }`, { mode: 0o600 })

  function send(which, path, { key, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: sockets[which], path, method, agent: false, timeout: 8000, headers: {
        ...(key && { 'x-api-key': key }), ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      } }, res => {
        const chunks = []
        res.on('error', reject)
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          try { resolve({ status: res.statusCode, headers: res.headers, bytes,
            json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes) : undefined }) } catch (error) { reject(error) }
        })
      })
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('Unix request timeout')))
      req.end(payload)
    })
  }
  async function start(mode, actors = principals, mountedKey = key) {
    const vars = Object.entries({ OPENVIKING_EDGE_KEYS: JSON.stringify([rootActor, ...actors]), OPENVIKING_EDGE_BACKUP_KEY: accountKey,
      OPENVIKING_EDGE_BACKUP_POLICY: JSON.stringify(policy), OPENVIKING_EDGE_INSTANCE_BACKUP_KEY: mountedKey,
      OPENVIKING_EDGE_INSTANCE_BACKUP: mode && JSON.stringify(mode) }).filter(([, value]) => value != null)
    await writeFile(join(dir, 'main.capnp'), `using W = import "/workerd.capnp";
      const config :W.Config = (services = [
        (name="product", worker=(modules=[(name="worker.mjs", esModule=embed "worker.mjs")], compatibilityDate="2026-11-19",
          globalOutbound="deny", durableObjectStorage=(localDisk="disk"), durableObjectNamespaces=[
            (className="Control", uniqueKey="${ns}-control", enableSql=true),
            (className="Workspace", uniqueKey="${ns}-workspace", enableSql=true)], bindings=[
            (name="CONTROL", durableObjectNamespace=(className="Control")), (name="WORKSPACES", durableObjectNamespace=(className="Workspace")),
            (name="AI", service=(name="fixture-ai")),
            ${vars.map(([name, value]) => `(name="${name}", text=${JSON.stringify(value)})`).join(',')}])),
        (name="driver", worker=(modules=[(name="driver.mjs", esModule=embed "driver.mjs")], compatibilityDate="2026-11-19", globalOutbound="deny",
          bindings=[(name="OP", service=(name="product", entrypoint="InstanceBackupOperator"))])),
        (name="fixture-ai", worker=(modules=[(name="ai.mjs", esModule=embed "ai.mjs")], compatibilityDate="2026-11-19", globalOutbound="deny")),
        (name="disk", disk=(path="state", writable=true)),
        (name="deny", worker=(compatibilityDate="2026-11-19", modules=[(name="deny.mjs", esModule="export default{fetch(){return new Response(null,{status:503})}}")]))],
        sockets=[(name="data", service="product"),(name="operator", service="driver")]);`, { mode: 0o600 })
    child = spawn('/usr/bin/python3', ['-I', guard, workerd, 'serve', '--experimental', '-I', join(base, 'node_modules/workerd'),
      ...Object.entries(sockets).flatMap(([name, socket]) => ['--socket-addr', `${name}=unix:${socket}`]), '--', 'main.capnp'],
    { cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2048) })
    stopped = once(child, 'exit')
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break
      if ((await send('data', '/health').catch(() => null))?.status === 200) return
      await delay(25)
    }
    throw new Error(`Unix fixture startup failed: ${stderr.replace(/[a-f0-9]{32,}/giu, '[fixture]')}`)
  }

  await start()
  return { root, close, restart: async (...args) => { await close(); await start(...args) },
    api: (path, options) => send('data', path, options), op: (action, body) => send('operator', `/${action}`, { body }),
    async inspect(action = 'read') {
      assert.equal(child, undefined)
      const states = { journal: null, workspaces: [] }
      for await (const path of glob('**/*.sqlite', { cwd: join(dir, 'state') })) {
        const sql = new DatabaseSync(join(dir, 'state', path), { readOnly: action === 'read' })
        try {
          const tables = new Set(sql.prepare('SELECT name FROM sqlite_schema WHERE type=\'table\'').all().map(({ name }) => name))
          const rows = name => tables.has(name) ? sql.prepare(`SELECT count(*) AS n FROM ${name}`).get().n : 0
          if (tables.has('ov_control_instance_restore')) {
            const row = sql.prepare('SELECT receipts,released FROM ov_control_instance_restore').get()
            states.journal = { receipts: JSON.parse(row.receipts), released: row.released }
            if (action === 'pause') sql.exec(`CREATE TRIGGER fixture_ack_stop BEFORE UPDATE OF receipts ON ov_control_instance_restore
              BEGIN SELECT RAISE(ABORT, 'synthetic ACK interruption'); END`)
            if (action === 'resume') sql.exec('DROP TRIGGER fixture_ack_stop')
          }
          if (tables.has('ov_edge_fs_entry') || tables.has('ov_edge_snapshot_commit') || tables.has('ov_edge_compile_config')) {
            const r = tables.has('ov_edge_instance_restore_receipt') && sql.prepare('SELECT account,receipt FROM ov_edge_instance_restore_receipt').get()
            states.workspaces.push({ account: r?.account, receipt: r?.receipt, physical: path,
              commits: rows('ov_edge_snapshot_commit'), blobs: rows('ov_edge_snapshot_blob'), hidden: rows('ov_edge_snapshot_portable_hidden'),
              configs: rows('ov_edge_compile_config'), schedules: rows('ov_edge_compile_schedule'), runs: rows('ov_edge_compile_run'), jobs: rows('ov_jobs') })
          }
        } finally { sql.close() }
      }
      return states
    },
  }
}
