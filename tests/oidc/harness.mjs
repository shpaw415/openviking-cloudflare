// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const project = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(import.meta.url)
export const origin = 'http://localhost'
export const clientId = 'oidc-adjacent-cli'
export const redirect = 'http://127.0.0.1:49383/callback'

function configuration(main, profiles, root, fixed) {
  const bindings = {
    ...(main === undefined ? {} : { OPENVIKING_EDGE_OIDC: typeof main === 'string' ? main : JSON.stringify(main) }),
    OIDC_FIXTURE_PROFILES: JSON.stringify(profiles),
    OPENVIKING_EDGE_KEYS: JSON.stringify([
      { key: root, role: 'root', accountId: 'root', userId: 'root', agentId: 'default' },
      { key: fixed, role: 'user', accountId: 'legacy', userId: 'fixed', agentId: 'default' },
    ]),
    OPENVIKING_OAUTH_ISSUER: origin,
    OPENVIKING_OAUTH_CLIENTS: JSON.stringify([{ client_id: clientId, client_name: 'Fixture CLI', redirect_uris: [redirect] }]),
  }
  const namespaces = { CONTROL: 'Control', WORKSPACES: 'Workspace', OAUTH: 'OAuth' }
  return `using W = import "/workerd.capnp";
const config :W.Config = (
  services = [
    (name = "local", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = "2026-11-19", globalOutbound = "deny",
      durableObjectNamespaces = [${Object.values(namespaces).map(name => `(className = "${name}", uniqueKey = "oidc-test-${name}", enableSql = true)`).join(',')}],
      durableObjectStorage = (localDisk = "disk"),
      bindings = [
        ${Object.entries(namespaces).map(([name, target]) => `(name = "${name}", durableObjectNamespace = (className = "${target}"))`).join(',')},
        ${Object.entries(bindings).map(([name, text]) => `(name = "${name}", text = ${JSON.stringify(text)})`).join(',')},
        (name = "ASSETS", service = "assets")
      ]
    )),
    (name = "disk", disk = (path = "state", writable = true)),
    (name = "deny", worker = (compatibilityDate = "2026-11-19", modules = [
      (name = "deny.mjs", esModule = "export default { fetch() { return new Response(null, { status: 503 }); } }")
    ])),
    (name = "assets", worker = (compatibilityDate = "2026-11-19", modules = [
      (name = "assets.mjs", esModule = ${JSON.stringify(`export default { fetch(request) {
        return new URL(request.url).pathname === '/studio/index.html'
          ? new Response(null, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
          : new Response(null, { status: 404 });
      } }`)})
    ]))
  ],
  sockets = [(name = "http", service = "local")]
);
`
}

export async function harness(main, { mode = 'production', profiles = {} } = {}) {
  const entry = mode === 'module' ? 'tests/oidc/worker.ts' : mode === 'observed' ? 'tests/oidc/observed.ts' : 'src/worker.ts'
  const { outputFiles } = await build({ absWorkingDir: project, entryPoints: [entry],
    bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false })
  const dir = await mkdtemp('/tmp/opencode/ov-oidc-')
  const socketPath = resolve(dir, 'api.sock')
  const root = randomBytes(32).toString('hex'), fixed = randomBytes(32).toString('hex')
  let child, completion
  const stop = async () => {
    if (child) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
      try { await completion } finally { clearTimeout(timer); child = undefined }
    }
    await rm(socketPath, { force: true })
  }
  const close = async () => {
    await stop()
    await rm(dir, { recursive: true, force: true })
  }
  const send = (path, { method = 'GET', jwt, key, headers = {}, body, form } = {}) => new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body)
    const req = request({ socketPath, path, method, agent: false, timeout: 5000, headers: {
      host: 'localhost', ...(jwt !== undefined ? { authorization: `Bearer ${jwt}` } : {}),
      ...(key !== undefined ? { 'x-api-key': key } : {}),
      ...(payload === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'content-length': Buffer.byteLength(payload) }), ...headers,
    } }, response => {
      const chunks = []
      response.on('error', reject)
      response.on('data', part => chunks.push(part))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = JSON.parse(text) } catch { /* callers check the typed result */ }
        resolve({ status: response.statusCode, headers: response.headers, json, text })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('OIDC fixture HTTP timeout.')))
    req.end(payload)
  })

  async function launch(operatorConfig) {
    await writeFile(resolve(dir, 'main.capnp'), configuration(operatorConfig, profiles, root, fixed), { mode: 0o600 })
    const workerd = require.resolve(`@cloudflare/workerd-linux-${process.arch === 'arm64' ? 'arm64' : '64'}/bin/workerd`)
    child = spawn('/usr/bin/python3', ['-I', resolve(project, 'tests/control/offline.py'), workerd, 'serve', '--experimental',
      '-I', resolve(project, 'node_modules/workerd'), '--socket-addr', `http=unix:${socketPath}`, '--', 'main.capnp'], {
      cwd: dir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let failed = false, diagnostic = ''
    child.stderr.on('data', part => { diagnostic = (diagnostic + part.toString()).slice(-4096) })
    completion = new Promise(done => {
      child.once('error', () => { failed = true; done() })
      child.once('exit', done)
    })
    for (let i = 0; i < 100 && !failed && child.exitCode === null && child.signalCode === null; i++) {
      if ((await send('/health').catch(() => null))?.status === 200) return
      await delay(25)
    }
    // Diagnostics can point at a configuration line. Report fixed categories,
    // not stderr content or any test key/credential from that configuration.
    const reason = /workerd\.capnp/u.test(diagnostic) ? 'configuration' : failed ? 'spawn' : 'startup'
    throw new Error(`OIDC fixture could not start (${reason}).`)
  }
  try {
    await mkdir(resolve(dir, 'state'))
    await writeFile(resolve(dir, 'worker.mjs'), outputFiles[0].text, { mode: 0o600 })
    await launch(main)
    return { send, root, fixed, close, restart: async operatorConfig => { await stop(); await launch(operatorConfig) } }
  } catch (error) {
    await close()
    throw error
  }
}
