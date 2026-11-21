// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const tenantA = testPrincipal('alpha', 'alice', 'admin')
const tenantB = testPrincipal('beta', 'bob')
let runtime, site, anonymous, alice

before(async () => {
  site = await mkdtemp(join(tmpdir(), 'openviking-test-assets-'))
  await mkdir(join(site, 'studio/assets'), { recursive: true })
  // This minimal isolated asset fixture verifies worker routing only, never Studio rendering.
  await writeFile(join(site, 'studio/index.html'), '<!doctype html><h1>Asset routing fixture</h1>')
  await writeFile(join(site, 'studio/assets/example.js'), 'export const value = 1;')
  await writeFile(join(site, 'studio/assets/example.js.map'), '{"version":3}')
  runtime = await localWorker({ principals: [tenantA, tenantB], assetsDir: site })
  await runtime.ready
  anonymous = api(runtime)
  alice = api(runtime, tenantA)
})

after(async () => {
  await runtime?.dispose()
  if (site) await rm(site, { recursive: true, force: true })
})

test('public liveness and initialized SQLite readiness have distinct checks', async () => {
  const health = await anonymous('/health')
  assert.equal(health.status, 200)
  const body = await health.json()
  assert.equal(body.healthy, true)
  assert.equal(body.auth_mode, 'api_key')
  assert.equal(body.user_id, undefined)
  assert.equal(health.headers.get('cache-control'), 'private, no-store')
  assert.match(health.headers.get('x-request-id'), /^[a-f\d-]{36}$/)
  const readiness = await anonymous('/ready')
  assert.equal(readiness.status, 200)
  assert.deepEqual(await readiness.json(), {
    status: 'ready', checks: { api_key_manager: 'ok', sqlite: 'ok', embedding: 'not_configured' },
  })
})

test('protected endpoints require a key and SDK identity cannot override its scope', async () => {
  const path = '/api/v1/system/status'
  const denied = await anonymous(path)
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer')
  assert.equal((await denied.json()).error.code, 'UNAUTHENTICATED')
  assert.equal((await anonymous(path, { headers: { 'x-openviking-account': 'alpha' } })).status, 401)
  const hint = await alice('/health', { headers: {
    'x-openviking-account': 'beta', 'x-openviking-user': 'bob', 'x-openviking-agent': 'other',
  } })
  assert.equal(hint.status, 200)
  const identity = await hint.json()
  assert.equal(identity.account_id, 'alpha')
  assert.equal(identity.user_id, 'alice')
  assert.equal(identity.role, 'admin')
  const allowed = await alice(path, { headers: { authorization: `Bearer ${tenantA.key}` } })
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), { status: 'ok', result: { initialized: true, user: 'alice' } })
  const other = await api(runtime, tenantB)('/health')
  const otherIdentity = await other.json()
  assert.equal(otherIdentity.account_id, 'beta')
  assert.equal(otherIdentity.user_id, 'bob')
  assert.equal(otherIdentity.role, 'user')
})

test('no ambiguous credential source or cross-origin API access', async () => {
  const path = '/api/v1/debug/health'
  const both = await alice(path, {
    headers: { 'x-api-key': tenantA.key, authorization: `Bearer ${tenantA.key}` },
  })
  assert.equal(both.status, 401)
  const cors = await alice(path, { headers: { origin: 'https://unrelated.example.test' } })
  assert.equal(cors.status, 403)
  assert.equal(cors.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal((await alice(path, { headers: { origin: 'http://localhost' } })).status, 200)
})

test('a missing credential configuration fails closed', async () => {
  const blank = await localWorker()
  try {
    const send = api(blank, tenantA)
    const status = await send('/api/v1/system/status')
    assert.equal(status.status, 503)
    assert.equal((await status.json()).error.code, 'AUTH_NOT_CONFIGURED')
    assert.equal((await api(blank)('/ready')).status, 503)
    assert.equal((await api(blank)('/health')).status, 200)
  } finally {
    await blank.dispose()
  }
})

test('unsupported API does not claim success and is never routed to SPA HTML', async () => {
  const unsupported = await alice('/api/v1/not-ported', { method: 'POST', body: { query: 'example' } })
  assert.equal(unsupported.status, 501)
  assert.equal((await unsupported.json()).error.code, 'NOT_IMPLEMENTED')
  const capability = await alice('/api/v1/system/edge-capabilities')
  assert.equal((await capability.json()).result.parity, 'partial')
  const dashboard = await alice('/api/v1/console/dashboard/summary')
  assert.equal((await dashboard.json()).result.enabled, true)
})

test('Studio deep links serve the entrypoint and missing assets do not', async () => {
  const root = await anonymous('/')
  assert.equal(root.status, 307)
  assert.equal(root.headers.get('location'), '/studio/')
  const match = await anonymous('/studio/filesystem', { headers: { accept: 'text/html' } })
  assert.equal(match.status, 200)
  assert.match(await match.text(), /Asset routing fixture/)
  assert.match(match.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(match.headers.get('cache-control'), 'private, no-store')
  const asset = await anonymous('/studio/assets/example.js')
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /javascript/)
  for (const missing of ['/studio/assets/missing.js', '/studio/missing.css', '/studio/assets/example.js.map']) {
    assert.equal((await anonymous(missing, { headers: { accept: 'text/html' } })).status, 404)
  }
  assert.equal((await anonymous('/studio/', { method: 'POST' })).status, 405)
  const head = await anonymous('/studio/', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
})
