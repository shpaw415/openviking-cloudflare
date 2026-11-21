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
const config = (root, fixed, production, filesystem, model) => {
  const rootPrincipal = { key: root, role: 'root', accountId: 'default', userId: 'edge-root', agentId: 'default' }
  const workspace = production ? 'Workspace' : filesystem ? 'TestWorkspace' : null
  const oauth = production ? ', (className = "OAuth", uniqueKey = "oauth-test", enableSql = true)' : ''
  const secrets = production ? `(name = "OPENVIKING_EDGE_KEYS", text = ${JSON.stringify(JSON.stringify([rootPrincipal, ...fixed]))}),
        (name = "OAUTH", durableObjectNamespace = (className = "OAuth"))` : `(name = "ROOT", text = ${JSON.stringify(root)}),
        (name = "FIXED", json = ${JSON.stringify(JSON.stringify(fixed))}),
        (name = "MODEL", text = ${JSON.stringify(model)})`
  return `using Workerd = import "/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "local", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-11-19",
      globalOutbound = "deny",
      durableObjectNamespaces = [
        (className = "Control", uniqueKey = "control-test", enableSql = true)
        ${workspace ? `, (className = "${workspace}", uniqueKey = "workspace-test", enableSql = true)` : ''}${oauth}
      ],
      durableObjectStorage = (localDisk = "disk"),
      bindings = [
        (name = "CONTROL", durableObjectNamespace = (className = "Control")),
        ${workspace ? `(name = "WORKSPACES", durableObjectNamespace = (className = "${workspace}")),` : ''}
        ${secrets}
      ]
    )),
    (name = "disk", disk = (path = "state", writable = true)),
    (name = "deny", worker = (
      modules = [(name = "deny.mjs", esModule = "export default { fetch() { return new Response(null, { status: 503 }) } }")],
      compatibilityDate = "2026-11-19"
    ))
  ],
  sockets = [(name = "http", service = "local")]
);
`
}

export function principal(accountId, userId, role = 'user', agentId = 'default') {
  return { accountId, userId, role, agentId, key: randomBytes(32).toString('hex') }
}

export async function harness(t, fixed = [], { production = false, filesystem = false, model = 'missing' } = {}) {
  const { outputFiles } = await build({
    absWorkingDir: project, entryPoints: [production ? 'src/worker.ts' : filesystem ? 'tests/control/filesystem-worker.ts' : 'tests/control/worker.ts'],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', platform: 'browser', write: false,
  })
  const dir = await mkdtemp('/tmp/opencode/ov-control-')
  const socketPath = resolve(dir, 'api.sock')
  const root = randomBytes(32).toString('hex')
  let child, exited
  const close = async () => {
    if (!child) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer); child = undefined }
    await rm(socketPath, { force: true })
  }
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }) })
  await mkdir(resolve(dir, 'state'))
  await writeFile(resolve(dir, 'worker.mjs'), outputFiles[0].text, { mode: 0o600 })

  function send(path, { key, method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request({ socketPath, path, method, agent: false, timeout: 5000, headers: {
        ...(key === undefined ? {} : { 'x-api-key': key }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      } }, response => {
        const chunks = []
        response.on('error', reject)
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try { json = JSON.parse(text) } catch { /* asserted by the caller if expected */ }
          resolve({ status: response.statusCode, headers: response.headers, json, text })
        })
      })
      req.on('timeout', () => req.destroy(new Error('Control test HTTP timeout')))
      req.on('error', reject)
      req.end(payload)
    })
  }

  async function launch(fixedNow) {
    await writeFile(resolve(dir, 'main.capnp'), config(root, fixedNow, production, filesystem, model), { mode: 0o600 })
    const arch = process.arch === 'arm64' ? 'arm64' : '64'
    const worker = require.resolve(`@cloudflare/workerd-linux-${arch}/bin/workerd`)
    const offline = resolve(project, 'tests/control/offline.py')
    child = spawn('/usr/bin/python3', ['-I', offline, worker, 'serve', '--experimental',
      '-I', resolve(project, 'node_modules/workerd'), '--socket-addr', `http=unix:${socketPath}`, '--', 'main.capnp'], {
      cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let diagnostic = ''
    child.stderr.on('data', part => { diagnostic = (diagnostic + part.toString()).slice(-8192) })
    const safeDiagnostic = () => [root, ...fixedNow.map(item => item.key)].reduce(
      (output, key) => output.replaceAll(key, '[test credential]'), diagnostic).slice(-4096)
    exited = once(child, 'exit')
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Local workerd failed to start: ${safeDiagnostic()}`)
      if ((await send('/health').catch(() => null))?.status === 200) return
      await delay(25)
    }
    throw new Error(`Timed out starting local workerd: ${safeDiagnostic()}`)
  }
  await launch(fixed)
  return { send, root, dir, close, restart: async (fixedNow = fixed) => { await close(); await launch(fixedNow) } }
}
