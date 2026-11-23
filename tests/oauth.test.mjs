// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'

const origin = 'http://localhost'
const resource = `${origin}/api/v1`
const callback = 'http://127.0.0.1:49371/callback'
const scope = 'workspace:read'
const clientId = 'local-fixture'
const authorize = '/authorize'
const metadata = '/.well-known/oauth-authorization-server'
const resourceMetadata = '/.well-known/oauth-protected-resource/api/v1'
const verify = '/api/v1/auth/oauth-verify'
const statusPath = '/oauth/authorize/page/status'
const accounts = '/api/v1/admin/accounts'
const project = fileURLToPath(new URL('..', import.meta.url))
const hash = (value, encoding = 'hex') => createHash('sha256').update(value).digest(encoding)
const random = () => randomBytes(32).toString('base64url')

// Production routing with a test-only clock and an aggregate SQLite change
// counter. Neither RPC enumerates records or reads confidential columns.
const entry = `
import { OAuth } from './src/oauth.ts';
export { default, Control, Workspace } from './src/worker.ts';
let clockOffset = 0;
const fixtureNow = Date.now.bind(Date);
Date.now = () => fixtureNow() + clockOffset;
export class TestOAuth extends OAuth {
  advanceFixtureClock(ms) { clockOffset += ms; }
  fixFixtureTime(ms) { clockOffset = ms - fixtureNow(); }
  sqlChanges() { return this.ctx.storage.sql.exec('SELECT total_changes() AS n').one().n; }
}`

async function harness(t, { enabled = true, issuer = origin, hasControl = true, hasStudio = true, persist = false } = {}) {
  const bundle = await build({ absWorkingDir: project, stdin: { contents: entry, resolveDir: project },
    platform: 'browser', format: 'esm', bundle: true, external: ['cloudflare:workers'], write: false, logLevel: 'silent' })
  const bootstrap = randomBytes(32).toString('hex')
  const fixed = randomBytes(32).toString('hex')
  const persistence = persist ? await mkdtemp(join(tmpdir(), 'ov-oauth-fixture-')) : undefined
  const launch = () => new Miniflare(convertV4MiniflareOptions({
    name: 'oauth-local-only', host: '127.0.0.1', port: 0, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-11-19', log: new Log(LogLevel.ERROR), logRequests: false,
    resourcePersistencePath: persistence,
    outboundService: () => new Response(null, { status: 503 }),
    // Verifies that the prerequisite is checked; not a browser/Studio test.
    ...(hasStudio && { serviceBindings: { ASSETS: request => new URL(request.url).pathname === '/studio/index.html'
      ? new Response(null, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response(null, { status: 404 }) } }),
    durableObjects: { ...(hasControl && { CONTROL: { className: 'Control', useSQLite: true } }),
      WORKSPACES: { className: 'Workspace', useSQLite: true },
      OAUTH: { className: 'TestOAuth', useSQLite: true } },
    bindings: {
      ...(enabled && { OPENVIKING_OAUTH_ISSUER: issuer,
        OPENVIKING_OAUTH_CLIENTS: JSON.stringify([{ client_id: clientId, client_name: 'Fixture CLI', redirect_uris: [callback] }]) }),
      OPENVIKING_EDGE_KEYS: JSON.stringify([
        { key: bootstrap, accountId: 'root', userId: 'root', agentId: 'default', role: 'root' },
        { key: fixed, accountId: 'fixed', userId: 'fixed', agentId: 'default', role: 'admin' },
      ]),
    },
  }))
  let runtime = launch()
  t.after(async () => {
    await runtime.dispose()
    if (persistence) await rm(persistence, { recursive: true, force: true })
  })
  const send = (path, { method = 'GET', key, cookie, body, requestOrigin, headers = {} } = {}) => runtime.dispatchFetch(
    new URL(path, issuer), { method, redirect: 'manual', headers: {
      ...(key && { Authorization: `Bearer ${key}` }), ...(cookie && { Cookie: cookie }),
      ...(requestOrigin !== undefined && { Origin: requestOrigin }),
      ...(body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body !== undefined && { 'Content-Type': 'application/json' }),
      ...headers,
    }, body: body instanceof URLSearchParams ? body.toString() : body !== undefined ? JSON.stringify(body) : null },
  )
  async function provision(account = 'managed') {
    const response = await send(accounts, { method: 'POST', key: bootstrap, body: { account_id: account, admin_user_id: 'owner' } })
    assert.equal(response.status, 200, 'real Control account create')
    const { result } = await response.json()
    assert.ok(typeof result.user_key === 'string')
    return result.user_key
  }
  async function store() {
    return (await runtime.getDurableObjectNamespace('OAUTH')).getByName('openviking:oauth:v1')
  }
  return { send, provision, bootstrap, fixed, store, issuer, restart: async () => {
    assert.ok(persistence, 'restart requires an isolated persistent store')
    await runtime.dispose()
    runtime = launch()
  } }
}

function flow(issuer, changes = {}) {
  const verifier = random()
  const state = random()
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, scope, redirect_uri: callback,
    resource: `${issuer}/api/v1`, code_challenge: hash(verifier, 'base64url'), code_challenge_method: 'S256', state, ...changes })
  return { path: `${authorize}?${params}`, verifier, state }
}

async function start(h, request = flow(h.issuer)) {
  const response = await h.send(request.path)
  assert.equal(response.status, 302, 'registered authorize request')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const browser = new URL(response.headers.get('location'), h.issuer)
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.equal(browser.origin, h.issuer)
  assert.equal(browser.pathname, '/studio/oauth/consent')
  assert.match(setCookie, /HttpOnly/i)
  assert.match(setCookie, /SameSite=Strict/i)
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(browser.searchParams.get('pending')), 'Studio still receives a short opaque handle')
  assert.ok([...browser.searchParams.keys()].join(',') === 'pending')
  assert.ok(setCookie.length <= 4096)
  return { ...request, pending: browser.searchParams.get('pending'), cookie: setCookie.split(';', 1)[0], setCookie }
}

const decision = (h, f, key, options = {}) => h.send(verify, {
  method: 'POST', requestOrigin: h.issuer, key, cookie: f.cookie, body: { pending_id: f.pending, decision: 'approve' }, ...options,
})
const poll = (h, f, options = {}) => h.send(`${statusPath}?pending=${encodeURIComponent(f.pending)}`, { cookie: f.cookie, ...options })

async function codeFor(h, f, key) {
  assert.equal((await decision(h, f, key)).status, 200, 'verified by a current managed key')
  const response = await poll(h, f)
  assert.equal(response.status, 200)
  const info = await response.json()
  assert.equal(info.status, 'approved')
  const redirect = new URL(info.redirect_url)
  assert.ok(`${redirect.origin}${redirect.pathname}` === callback)
  assert.ok(redirect.searchParams.get('state') === f.state)
  assert.equal(redirect.searchParams.get('iss'), h.issuer)
  const code = redirect.searchParams.get('code')
  assert.ok(typeof code === 'string' && /^ovac_[A-Za-z0-9_-]{43}$/.test(code))
  return code
}

function exchange(h, f, code, changes = {}) {
  return h.send('/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
    redirect_uri: callback, resource: `${h.issuer}/api/v1`, code_verifier: f.verifier, code, ...changes }) })
}

const directory = `/api/v1/fs/ls?${new URLSearchParams({ uri: 'viking://~/resources' })}`

async function access(h, f, code) {
  const response = await exchange(h, f, code)
  assert.equal(response.status, 200)
  const { access_token: token } = await response.json()
  assert.ok(typeof token === 'string' && /^ovat_[A-Za-z0-9_-]{43}$/.test(token))
  return token
}

test('PAR-03: anonymous OAuth starts and Studio reads make no per-intent SQLite writes', async t => {
  const h = await harness(t)
  const sql = await h.store()
  await sql.fixFixtureTime(Date.UTC(2026, 10, 21, 10, 15))
  await start(h) // Initialize the single sealing key for this period.
  const before = await sql.sqlChanges()
  const first = await start(h)
  const second = await start(h)
  assert.equal((await h.send(`/api/v1/auth/oauth/pending/${first.pending}`, { cookie: first.cookie })).status, 200)
  assert.deepEqual(await (await poll(h, second)).json(), { status: 'pending' })
  assert.equal(await sql.sqlChanges() - before, 0, 'no anonymous consent records and no anonymous cleanup writes')

  const key = await h.provision()
  const code = await codeFor(h, first, key)
  const token = await access(h, first, code)
  assert.equal((await h.send(directory, { key: token })).status, 200)
})

test('PAR-03: a sealed intent requires the originating cookie and is decided and consumed only once', async t => {
  const h = await harness(t)
  const key = await h.provision()
  const first = await start(h)
  const second = await start(h)
  const sql = await h.store()
  const before = await sql.sqlChanges()
  assert.equal((await poll(h, first, { cookie: second.cookie })).status, 410)
  // Corrupt one byte of a local fixture cookie; the public response must not
  // dereference or reveal any fields from an unauthenticated capsule.
  const index = first.cookie.lastIndexOf('.') + 1
  const invalidCookie = first.cookie.slice(0, index) + (first.cookie[index] === 'A' ? 'B' : 'A') + first.cookie.slice(index + 1)
  assert.equal((await h.send(`/api/v1/auth/oauth/pending/${first.pending}`, { cookie: invalidCookie })).status, 404)
  assert.equal((await decision(h, first, key, { cookie: invalidCookie })).status, 410)
  assert.equal(await sql.sqlChanges(), before)

  const approvals = await Promise.all([decision(h, first, key), decision(h, first, key)])
  assert.deepEqual(approvals.map(item => item.status).sort(), [200, 410])
  const results = await Promise.all([poll(h, first), poll(h, first)])
  assert.deepEqual(results.map(item => item.status).sort(), [200, 410])
  const { redirect_url: redirect } = await results.find(item => item.status === 200).json()
  const code = new URL(redirect).searchParams.get('code')
  await access(h, first, code)
  const consumed = await sql.sqlChanges()
  assert.equal((await decision(h, first, key)).status, 410)
  assert.equal((await poll(h, first)).status, 410)
  assert.equal(await sql.sqlChanges(), consumed)
  assert.equal((await decision(h, second, key, { body: { pending_id: second.pending, decision: 'deny' } })).status, 200)
  assert.equal((await decision(h, second, key)).status, 410)
})

test('PAR-03: receipt capacity follows the managed owner, not the client or rotated credential', async t => {
  const h = await harness(t)
  const key = await h.provision()
  const users = `${accounts}/managed/users`
  const created = await h.send(users, { method: 'POST', key, body: { user_id: 'second-user', role: 'user' } })
  assert.equal(created.status, 200)
  const { result: { user_key: other } } = await created.json()
  const time = await h.store()
  await time.fixFixtureTime(Date.UTC(2026, 10, 21, 10, 15))
  // Eight ordinary managed decisions in a single fixture, not a load test.
  for (let slot = 0; slot < 8; slot++) {
    const f = await start(h)
    assert.equal((await decision(h, f, key, { body: { pending_id: f.pending, decision: 'deny' } })).status, 200)
  }
  const next = await start(h)
  assert.equal((await decision(h, next, key)).status, 429)
  const rotation = await h.send(`${users}/owner/key`, { method: 'POST', key })
  assert.equal(rotation.status, 200)
  const { result: { user_key: rotated } } = await rotation.json()
  assert.equal((await decision(h, next, rotated)).status, 429)
  await access(h, next, await codeFor(h, next, other))
  await time.advanceFixtureClock(301_000)
  const fresh = await start(h)
  await access(h, fresh, await codeFor(h, fresh, rotated))
})

test('PAR-03: the previous sealing key survives rotation and restart within the intent lifetime', async t => {
  const h = await harness(t, { persist: true })
  const key = await h.provision()
  const before = Date.UTC(2026, 10, 21, 10, 59, 50)
  await (await h.store()).fixFixtureTime(before)
  const f = await start(h)
  await (await h.store()).fixFixtureTime(before + 20_000)
  await start(h) // New epoch now has a different stored sealing key.
  await h.restart()
  await (await h.store()).fixFixtureTime(before + 30_000)
  assert.deepEqual(await (await poll(h, f)).json(), { status: 'pending' })
  await access(h, f, await codeFor(h, f, key))
})

test('OAuth discovery advertises only the enabled issuer, resource, S256 and authorization code', async t => {
  const h = await harness(t)
  const response = await h.send(metadata)
  assert.equal(response.status, 200)
  const document = await response.json()
  assert.equal(document.issuer, origin)
  assert.equal(document.token_endpoint, `${origin}/token`)
  assert.deepEqual(document.code_challenge_methods_supported, ['S256'])
  assert.deepEqual(document.grant_types_supported, ['authorization_code'])
  assert.deepEqual(document.scopes_supported, [scope])
  assert.ok(!Object.hasOwn(document, 'registration_endpoint'))
  assert.equal((await (await h.send(resourceMetadata)).json()).resource, resource)
  assert.equal((await h.send('/.well-known/oauth-protected-resource/mcp')).status, 404)
  assert.equal((await h.send('/register', { method: 'POST', body: { redirect_uris: [callback] } })).status, 404)
  const disabled = await harness(t, { enabled: false })
  assert.equal((await disabled.send(metadata)).status, 404)
  const withoutControl = await harness(t, { hasControl: false })
  assert.equal((await withoutControl.send(metadata)).status, 404)
  const withoutStudio = await harness(t, { hasStudio: false })
  assert.equal((await withoutStudio.send(metadata)).status, 503)
  assert.equal((await withoutStudio.send(flow(withoutStudio.issuer).path)).status, 503)
})

test('OAuth consent, one-use exchange and read-only grant use real managed credentials', async t => {
  const h = await harness(t)
  const key = await h.provision()
  const note = 'viking://~/resources/managed-fixture'
  assert.equal((await h.send('/api/v1/fs/mkdir', { method: 'POST', key, body: { uri: note } })).status, 200)
  const f = await start(h)
  const pending = await h.send(`/api/v1/auth/oauth/pending/${f.pending}`, { cookie: f.cookie })
  assert.equal(pending.status, 200)
  assert.deepEqual(await pending.json(), { client_id: clientId, client_name: 'Fixture CLI', redirect_host: '127.0.0.1:49371', scopes: [scope] })
  assert.equal((await poll(h, f, { cookie: '' })).status, 410)
  assert.equal((await poll(h, f)).status, 200)
  assert.equal((await decision(h, f, h.bootstrap)).status, 403)
  assert.equal((await decision(h, f, h.fixed)).status, 403)
  assert.equal((await decision(h, f, key, { requestOrigin: null })).status, 403)
  const code = await codeFor(h, f, key)
  assert.equal((await poll(h, f)).status, 410)
  for (const bad of [{ code_verifier: random() }, { resource: `${origin}/mcp` }, { redirect_uri: `${callback}/other` }]) {
    assert.equal((await exchange(h, f, code, bad)).status, 400)
  }
  const candidates = await Promise.all([exchange(h, f, code), exchange(h, f, code)])
  assert.deepEqual(candidates.map(item => item.status).sort(), [200, 400])
  const response = candidates.find(item => item.status === 200)
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const tokens = await response.json()
  assert.deepEqual(Object.keys(tokens).sort(), ['access_token', 'expires_in', 'scope', 'token_type'])
  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.scope, scope)
  assert.ok(/^ovat_[A-Za-z0-9_-]{43}$/.test(tokens.access_token))
  const grants = await (await h.store()).resolveGrant(hash(tokens.access_token))
  assert.ok(grants?.keyDigest === hash(key))
  assert.deepEqual(grants.scope, [scope])
  const accepted = await h.send(directory, { key: tokens.access_token })
  assert.equal(accepted.status, 200)
  const files = await accepted.json()
  assert.equal(files.status, 'ok')
  assert.ok(JSON.stringify(files.result).includes('managed-fixture'))
  assert.equal((await decision(h, await start(h), tokens.access_token)).status, 401)
  assert.equal((await h.send(directory, { method: 'POST', key: tokens.access_token })).status, 403)
  assert.equal((await h.send('/api/v1/fs/mkdir', { method: 'POST', key: tokens.access_token, body: { uri: note } })).status, 403)
  assert.equal((await h.send('/api/v1/search/search', { method: 'POST', key: tokens.access_token, body: {} })).status, 403)
  assert.equal((await h.send(accounts, { key: tokens.access_token })).status, 403)
  assert.equal((await h.send('/api/v1/privacy-configs', { key: tokens.access_token })).status, 403)
  assert.equal((await h.send('/api/v1/observer/system', { key: tokens.access_token })).status, 403)
  assert.equal((await h.send('/api/v1/system/edge-capabilities', { key: tokens.access_token })).status, 403)
})

test('OAuth stays on the configured origin and requires approved client, redirect, resource, state and S256', async t => {
  const h = await harness(t, { issuer: 'https://lan.example.test' })
  const info = await h.send(metadata)
  assert.equal(info.status, 200)
  assert.equal((await info.json()).issuer, h.issuer)
  assert.equal((await h.send('https://alternate.example.test' + metadata)).status, 404)
  const f = await start(h)
  assert.match(f.setCookie, /^__Host-/)
  assert.match(f.setCookie, /; Secure$/)
  for (const input of [
    { client_id: 'not-approved' }, { redirect_uri: `${callback}/different` }, { state: '' },
    { resource: '' }, { scope: 'workspace:write' }, { code_challenge_method: 'plain' },
  ]) {
    const rejected = await h.send(flow(h.issuer, input).path)
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('location'), null)
    assert.equal(rejected.headers.get('set-cookie'), null)
  }
  const key = await h.provision()
  assert.equal((await decision(h, f, key, { requestOrigin: 'https://alternate.example.test' })).status, 403)
  assert.equal((await decision(h, f, key, { cookie: '' })).status, 410)
  assert.equal((await decision(h, f, key, { body: { pending_id: f.pending, decision: 'deny' } })).status, 200)
  assert.equal((await poll(h, f)).status, 410)
  const plain = await harness(t, { issuer: 'http://lan.example.test' })
  assert.equal((await plain.send(metadata)).status, 503)
})

test('OAuth pending, authorization code and access grant expire in the Durable Object', async t => {
  const h = await harness(t)
  const key = await h.provision()
  const time = await h.store()

  const pending = await start(h)
  await time.advanceFixtureClock(301_000)
  assert.equal((await poll(h, pending)).status, 410)
  assert.equal((await decision(h, pending, key)).status, 410)

  const f = await start(h)
  const code = await codeFor(h, f, key)
  await time.advanceFixtureClock(91_000)
  assert.equal((await exchange(h, f, code)).status, 400)

  const next = await start(h)
  const token = await access(h, next, await codeFor(h, next, key))
  assert.ok(await time.resolveGrant(hash(token)))
  await time.advanceFixtureClock(601_000)
  assert.equal(await time.resolveGrant(hash(token)), null)
  assert.equal((await h.send(directory, { key: token })).status, 401)
})

test('OAuth loses active grants and unexchanged codes on Control rotation or account removal', async t => {
  const h = await harness(t)
  const key = await h.provision()
  const initial = await start(h)
  const token = await access(h, initial, await codeFor(h, initial, key))
  const outstanding = await start(h)
  const code = await codeFor(h, outstanding, key)
  const rotation = await h.send(`${accounts}/managed/users/owner/key`, { method: 'POST', key })
  assert.equal(rotation.status, 200)
  const { result: { user_key: next } } = await rotation.json()
  assert.ok(next && next !== key)
  assert.equal((await exchange(h, outstanding, code)).status, 400)
  assert.equal(await (await h.store()).resolveGrant(hash(token)), null)
  assert.equal((await h.send(directory, { key: token })).status, 401)

  const after = await start(h)
  assert.equal((await decision(h, after, key)).status, 401)
  const newToken = await access(h, after, await codeFor(h, after, next))
  assert.equal((await h.send(directory, { key: newToken })).status, 200)
  assert.equal((await h.send(`${accounts}/managed`, { method: 'DELETE', key: h.bootstrap })).status, 202)
  assert.equal((await h.send(directory, { key: newToken })).status, 401)
})
