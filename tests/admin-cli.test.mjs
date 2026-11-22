// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { localWorker, testPrincipal } from './support/local-worker.mjs'

const script = fileURLToPath(new URL('../scripts/admin.mjs', import.meta.url))
const freshKey = () => randomBytes(32).toString('hex')

async function run(origin, command, flags, input, env) {
  const args = [command, '--url', origin, ...flags]
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = once(child, 'close')
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  let out = '', err = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  try {
    const [code, signal] = await closed
    assert.equal(signal, null, 'CLI should exit normally')
    return { code, out, err }
  } finally { clearTimeout(timer) }
}

async function privateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ov-admin-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function listen(t, handle) {
  const server = createServer(handle)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((done, fail) => {
    server.close(error => error ? fail(error) : done())
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

function safeOutput(result, ...keys) {
  // Assertion failures must not dump either stream when a key leaks.
  assert.ok(keys.every(key => !result.out.includes(key) && !result.err.includes(key)), 'CLI output must not contain a key')
}

async function keyIn(file) {
  const info = await lstat(file)
  assert.equal(info.mode & 0o777, 0o600)
  assert.ok(info.isFile())
  const key = await readFile(file, 'utf8')
  assert.ok(/^[a-f0-9]{64}\n$/u.test(key), 'output must be one key followed by LF')
  return key.trimEnd()
}

test('real Workerd/SQLite: root creates accounts, admins register and rotate keys without a redeploy', { timeout: 30_000 }, async t => {
  const dir = await privateDir(t)
  const root = testPrincipal('bootstrap', 'root', 'root')
  const runtime = await localWorker({ principals: [root] })
  t.after(() => runtime.dispose())
  const { origin } = await runtime.ready
  const rootPath = join(dir, 'root.key')
  await writeFile(rootPath, `${root.key}\r\n`, { mode: 0o600 })

  const create = async account => {
    const path = join(dir, `${account}.key`)
    const response = await run(origin, 'create-account', ['--key-file', rootPath,
      '--account', account, '--admin', 'owner', '--out-key', path])
    const key = response.code === 0 ? await keyIn(path) : null
    safeOutput(response, root.key, ...(key ? [key] : []))
    assert.equal(response.code, 0, response.err)
    return path
  }
  const admin = await create('demo')
  const other = await create('other')
  const owner = await keyIn(admin)

  const accounts = await run(origin, 'list-accounts', ['--key-stdin'], `${root.key}\n`)
  safeOutput(accounts, root.key, owner)
  assert.equal(accounts.code, 0, accounts.err)
  assert.deepEqual(JSON.parse(accounts.out), [{ account_id: 'demo', user_count: 1 }, { account_id: 'other', user_count: 1 }])
  const dataRoot = await fetch(`${origin}/api/v1/fs/ls?uri=viking%3A%2F%2F`, { headers: { 'x-api-key': root.key } })
  assert.equal(dataRoot.status, 403)
  await dataRoot.body.cancel()

  const member = join(dir, 'member.key')
  const registration = ['--account', 'demo', '--user', 'alice', '--out-key', member]
  const registered = await run(origin, 'register-user', ['--key-file', admin, ...registration])
  const originalKey = registered.code === 0 ? await keyIn(member) : null
  safeOutput(registered, owner, ...(originalKey ? [originalKey] : []))
  assert.equal(registered.code, 0, registered.err)
  const users = await run(origin, 'list-users', ['--key-file', member, '--account', 'demo'])
  safeOutput(users, owner, originalKey)
  assert.equal(users.code, 0, users.err)
  assert.deepEqual(JSON.parse(users.out), [{ user_id: 'owner', role: 'admin' }, { user_id: 'alice', role: 'user' }])

  const refused = join(dir, 'refused.key')
  for (const [credential, account, code] of [[admin, 'other', 403], [other, 'demo', 403], [member, 'demo', 403], [admin, 'demo', 409]]) {
    const response = await run(origin, 'register-user', ['--key-file', credential, '--account', account,
      '--user', 'alice', '--out-key', refused])
    safeOutput(response, root.key, owner, originalKey)
    assert.equal(response.code, 1)
    assert.match(response.err, new RegExp(`HTTP ${code}:`))
    await assert.rejects(lstat(refused), { code: 'ENOENT' })
  }

  // An existing output must fail locally, before the rotation can invalidate the input key.
  const same = await run(origin, 'regenerate-key', ['--key-file', member, ...registration])
  safeOutput(same, originalKey)
  assert.equal(same.code, 2)
  assert.ok(await keyIn(member) === originalKey, 'existing key must be preserved')
  const oldBefore = await run(origin, 'list-users', ['--key-file', member, '--account', 'demo'])
  safeOutput(oldBefore, originalKey)
  assert.equal(oldBefore.code, 0)

  const next = join(dir, 'member-v2.key')
  const rotated = await run(origin, 'regenerate-key', ['--key-file', admin, '--account', 'demo', '--user', 'alice', '--out-key', next])
  const nextKey = rotated.code === 0 ? await keyIn(next) : null
  safeOutput(rotated, owner, originalKey, ...(nextKey ? [nextKey] : []))
  assert.equal(rotated.code, 0, rotated.err)
  assert.ok(nextKey !== originalKey, 'rotation must issue a different key')
  const old = await run(origin, 'list-users', ['--key-file', member, '--account', 'demo'])
  safeOutput(old, originalKey)
  assert.equal(old.code, 1)
  assert.match(old.err, /HTTP 401:/u)
  const accepted = await run(origin, 'list-users', ['--key-file', next, '--account', 'demo'])
  safeOutput(accepted, nextKey)
  assert.equal(accepted.code, 0, accepted.err)
  assert.equal(accepted.out, users.out)
  assert.deepEqual((await readdir(dir)).sort(), ['demo.key', 'member-v2.key', 'member.key', 'other.key', 'root.key'])
})

test('CLI local preflight rejects unsafe arguments and credential files without sending a request', async t => {
  const dir = await privateDir(t)
  let requests = 0
  const origin = await listen(t, (_req, res) => { requests++; res.writeHead(500).end() })
  const key = freshKey()
  const file = join(dir, 'original.key')
  const publicFile = join(dir, 'public.key')
  const target = join(dir, 'link.key')
  const publicDir = join(dir, 'public')
  await writeFile(file, key, { mode: 0o600 })
  await writeFile(publicFile, key, { mode: 0o600 })
  await chmod(publicFile, 0o644)
  await symlink('absent.key', target)
  await mkdir(publicDir, { mode: 0o755 })
  await chmod(publicDir, 0o755)

  for (const [url, cmd, flags, input, env] of [
    ['http://example.invalid', 'list-accounts', ['--key-file', file]],
    [`${origin}/studio`, 'list-accounts', ['--key-file', file]],
    [`${origin}?`, 'list-accounts', ['--key-file', file]],
    [origin, 'list-accounts', ['--api-key', key]],
    [origin, 'list-accounts', ['--key-file', file, '--key-file', file]],
    [origin, 'list-accounts', ['--key-file', publicFile]],
    [origin, 'list-accounts', ['--key-stdin'], 'x'.repeat(131)],
    [origin, 'list-accounts', ['--key-stdin'], `${key}\n\n`],
    [origin, 'list-accounts', ['--key-file', file], undefined, { NODE_DEBUG: 'http' }],
    [origin, 'list-users', ['--key-file', file, '--account', '..']],
    [origin, 'create-account', ['--key-file', file, '--account', 'demo', '--admin', 'owner', '--out-key', target]],
    [origin, 'create-account', ['--key-file', file, '--account', 'demo', '--admin', 'owner', '--out-key', join(publicDir, 'out.key')]],
  ]) {
    const result = await run(url, cmd, flags, input, env)
    safeOutput(result, key)
    assert.equal(result.code, 2, result.err)
    assert.equal(result.out, '')
  }
  assert.equal(requests, 0)
  assert.ok((await lstat(target)).isSymbolicLink())
  assert.deepEqual((await readdir(dir)).sort(), ['link.key', 'original.key', 'public', 'public.key'])
})

test('redirects, echoed error responses and lost responses are not followed, logged or retried', async t => {
  const dir = await privateDir(t)
  const key = freshKey(), issued = freshKey()
  const output = join(dir, 'requested.key')
  let destinations = 0, requests = 0, receivedKey = true
  const redirected = await listen(t, (_req, res) => { destinations++; res.end() })
  const origin = await listen(t, (req, res) => {
    receivedKey &&= req.headers['x-api-key'] === key && !req.headers.authorization
    requests++
    if (requests === 1) res.writeHead(307, { Location: `${redirected}/?never-log=${key}` }).end(key)
    else if (requests === 2) res.writeHead(401).end(JSON.stringify({ error: { message: issued } }))
    else if (requests === 3) req.destroy()
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      status: 'ok', result: { account_id: 'unrelated', admin_user_id: 'owner', user_key: issued },
    }))
  })
  for (const [code, message] of [[3, /redirect not followed/u], [1, /HTTP 401:/u], [3, /may have been applied/u], [3, /Unexpected response/u]]) {
    const result = await run(origin, 'create-account', ['--key-stdin', '--account', 'demo', '--admin', 'owner', '--out-key', output], key)
    safeOutput(result, key, issued)
    assert.equal(result.code, code, result.err)
    assert.match(result.err, message)
    assert.equal(result.out, '')
    assert.deepEqual(await readdir(dir), [])
  }
  assert.equal(destinations, 0)
  assert.equal(requests, 4)
  assert.ok(receivedKey)
})

test('a concurrent local file creation cannot be overwritten after issuance', async t => {
  const dir = await privateDir(t)
  const key = freshKey(), issued = freshKey()
  const output = join(dir, 'requested.key')
  const origin = await listen(t, (_req, res) => {
    void writeFile(output, 'existing', { mode: 0o600, flag: 'wx' }).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'ok', result: { user_key: issued } }))
    }, () => { res.writeHead(500).end() })
  })
  const result = await run(origin, 'regenerate-key', ['--key-stdin', '--account', 'demo', '--user', 'owner', '--out-key', output], key)
  safeOutput(result, key, issued)
  assert.equal(result.code, 3)
  assert.match(result.err, /issued a key, but the private output could not be saved/u)
  assert.equal(await readFile(output, 'utf8'), 'existing')
  assert.deepEqual(await readdir(dir), ['requested.key'])
})

test('CLI sends only a supported config file, previews it and applies a specific revision', async t => {
  const dir = await privateDir(t)
  const root = testPrincipal('bootstrap', 'root', 'root')
  const runtime = await localWorker({ principals: [root], embeddings: 'fixture',
    outboundService() { return new Response(null, { status: 599 }) } })
  t.after(() => runtime.dispose())
  const { origin } = await runtime.ready
  const path = join(dir, 'ov.edge.conf')
  const flags = ['--key-stdin', '--file', path]
  const valid = { vlm: { provider: 'workers_ai', model: '@cf/meta/llama-3.1-8b-instruct', max_tokens: 128 }, default_search_limit: 2 }
  await writeFile(path, JSON.stringify({ ...valid, vlm: { ...valid.vlm, api_key: root.key } }), { mode: 0o600 })
  const refused = await run(origin, 'import-config', [...flags, '--apply'], root.key)
  safeOutput(refused, root.key)
  assert.equal(refused.code, 2)
  await writeFile(path, JSON.stringify(valid))
  const dry = await run(origin, 'import-config', [...flags, '--dry-run', '--revision', '0'], root.key)
  safeOutput(dry, root.key)
  assert.equal(dry.code, 0, dry.err)
  assert.equal(JSON.parse(dry.out).vlm.max_tokens, 128)
  const show = await run(origin, 'show-config', ['--key-stdin'], root.key)
  assert.equal(show.code, 0, show.err)
  assert.equal(JSON.parse(show.out).vlm, null)
  const apply = await run(origin, 'import-config', [...flags, '--apply', '--revision', '0'], root.key)
  safeOutput(apply, root.key)
  assert.equal(apply.code, 0, apply.err)
  assert.equal(JSON.parse(apply.out).revision, 1)
  const result = await run(origin, 'test-config', ['--key-stdin', '--kind', 'vlm'], root.key)
  safeOutput(result, root.key)
  assert.equal(result.code, 0, result.err)
  assert.equal(JSON.parse(result.out).ok, true)
})
