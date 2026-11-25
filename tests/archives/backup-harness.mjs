// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const project = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
const config = (principals, backup) => `using Workerd = import "/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "local", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny",
      durableObjectNamespaces = [
        (className = "Control", uniqueKey = "backup-test-control", enableSql = true),
        (className = "Workspace", uniqueKey = "backup-test-workspace", enableSql = true)
      ],
      durableObjectStorage = (localDisk = "disk"),
      bindings = [
        (name = "CONTROL", durableObjectNamespace = (className = "Control")),
        (name = "WORKSPACES", durableObjectNamespace = (className = "Workspace")),
        (name = "OPENVIKING_EDGE_KEYS", text = ${JSON.stringify(JSON.stringify(principals))}),
        (name = "OPENVIKING_EDGE_BACKUP_POLICY", text = ${JSON.stringify(JSON.stringify(backup.policy))}),
        (name = "OPENVIKING_EDGE_BACKUP_KEY", text = ${JSON.stringify(backup.key)})
        ${backup.ai ? ', (name = "AI", service = (name = "fixture-ai"))' : ''}
      ]
    )),
    (name = "backup-fixture", worker = (
      modules = [(name = "operator.mjs", esModule = embed "operator.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny",
      bindings = [(name = "OPERATOR", service = (name = "local", entrypoint = "BackupOperator"))]
    )),
    (name = "disk", disk = (path = "state", writable = true)),
    (name = "deny", worker = (
      modules = [(name = "deny.mjs", esModule = "export default { fetch() { return new Response(null, { status: 503 }) } }")],
      compatibilityDate = "2026-11-19"
    ))${backup.ai ? `,
    (name = "fixture-ai", worker = (
      modules = [(name = "ai.mjs", esModule = embed "ai.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny"
    ))` : ''}
  ],
  sockets = [(name = "http", service = "local"), (name = "backup", service = "backup-fixture")]
);`

export async function backupHarness(t, fixed, backup) {
  const { outputFiles } = await build({ absWorkingDir: project, entryPoints: ['src/worker.ts'], bundle: true,
    external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false })
  const dir = await mkdtemp(resolve(project, '.work/b-'))
  const api = resolve(dir, 'api.sock'), op = resolve(dir, 'op.sock')
  const root = randomBytes(32).toString('hex')
  const rootActor = { accountId: 'default', userId: 'edge-root', agentId: 'default', role: 'root', key: root }
  let child, exited
  async function close() {
    if (!child) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer); child = undefined }
    await Promise.all([api, op].map(socket => rm(socket, { force: true })))
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  await mkdir(resolve(dir, 'state'))
  await writeFile(resolve(dir, 'worker.mjs'), outputFiles[0].text, { mode: 0o600 })
  await writeFile(resolve(dir, 'operator.mjs'), backup.adapter, { mode: 0o600 })
  if (backup.ai) await writeFile(resolve(dir, 'ai.mjs'), backup.ai, { mode: 0o600 })

  function http(socketPath, path, { key, method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request({ socketPath, path, method, agent: false, timeout: 6000, headers: {
        ...(key && { 'x-api-key': key }),
        ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }), ...headers,
      } }, res => {
        const chunks = []
        res.on('error', reject)
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const bytes = Buffer.concat(chunks)
          let json
          try { json = JSON.parse(bytes.toString('utf8')) } catch { /* ZIP response */ }
          resolve({ status: res.statusCode, headers: res.headers, json, bytes })
        })
      })
      req.on('timeout', () => req.destroy(new Error('Backup fixture timeout')))
      req.on('error', reject)
      req.end(payload)
    })
  }

  async function start(actors, policy) {
    const capnp = config([rootActor, ...actors], policy)
    await writeFile(resolve(dir, 'main.capnp'), capnp, { mode: 0o600 })
    const arch = process.arch === 'arm64' ? 'arm64' : '64'
    const worker = require.resolve(`@cloudflare/workerd-linux-${arch}/bin/workerd`)
    child = spawn('/usr/bin/python3', ['-I', resolve(project, 'tests/control/offline.py'), worker, 'serve', '--experimental',
      '-I', resolve(project, 'node_modules/workerd'), '--socket-addr', `http=unix:${api}`, '--socket-addr', `backup=unix:${op}`, '--', 'main.capnp'], {
      cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', part => { stderr = (stderr + part.toString()).slice(-8192) })
    exited = once(child, 'exit')
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) {
        throw new Error(`Local Workerd refused the mount: ${[root, policy.key, ...actors.map(item => item.key)]
          .reduce((text, secret) => text.replaceAll(secret, '[test credential]'), stderr).slice(-1024)}`)
      }
      if ((await http(api, '/health').catch(() => null))?.status === 200 &&
          (await http(op, '/ready').catch(() => null))?.status === 204) return
      await delay(25)
    }
    throw new Error('Backup Workerd did not start.')
  }
  await start(fixed, backup)
  return { dir, close, root, send: (path, opts) => http(api, path, opts), operator: (path, opts) => http(op, path, opts),
    restart: async (fixedNow = fixed, policy = backup) => { await close(); await start(fixedNow, policy) } }
}
