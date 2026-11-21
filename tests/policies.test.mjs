// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = '/api/v1/privacy-configs'
const markers = ['fictional-value-a', 'fictional-value-b', 'fictional-note', 'fictional-label']

async function checked(send, path, options, status = 200) {
  const response = await send(`${root}${path}`, options)
  const raw = await response.text()
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}`)
  for (const marker of markers) assert.ok(!raw.includes(marker), 'Privacy returned a confidential payload')
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  const envelope = JSON.parse(raw)
  assert.equal(envelope.status, status < 400 ? 'ok' : 'error')
  return status < 400 ? envelope.result : envelope.error
}

test('Privacy stores configurations, lists categories and masks all snapshot payloads', async t => {
  const actor = testPrincipal('test-account', 'fixture-user')
  const runtime = await localWorker({ principals: [actor] })
  t.after(() => runtime.dispose())
  const send = api(runtime, actor)

  assert.deepEqual(await checked(send, ''), [])
  const snapshot = await checked(send, '/credential/git%40lab', { method: 'POST', body: {
    values: { 'api/key': markers[0], unset: null, disabled: false, zero: 0, blank: '' },
    labels: { arbitrary: markers[3] }, change_reason: markers[2],
  } })
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.created_by, 'fixture-user')
  assert.equal(snapshot.redacted, true)
  assert.deepEqual(snapshot.values, { 'api/key': null, unset: null, disabled: null, zero: null, blank: null })
  assert.deepEqual(await checked(send, ''), ['credential'])
  assert.deepEqual(await checked(send, '/credential'), ['git@lab'])
  const { meta, current } = await checked(send, '/credential/git@lab')
  assert.equal(meta.active_version, 1)
  assert.equal(meta.latest_version, 1)
  assert.equal(meta.labels_redacted, true)
  assert.equal(current.change_reason_redacted, true)
  assert.deepEqual(current, snapshot)
  assert.deepEqual(await checked(send, '/credential/git@lab/versions'), [1])
  assert.deepEqual(await checked(send, '/credential/git@lab/versions/1'), snapshot)

  const tree = await checked(send, '/tree?category=credential')
  assert.deepEqual(tree, { owner_user_id: 'fixture-user', categories: [{ category: 'credential', targets: [{
    target_key: 'git@lab', version: 1, fields: [
      { field: 'api/key', configured: true, reference: '{{ov_privacy:fixture-user:viking://~/privacy/credential/git%40lab#/values/api%2Fkey}}' },
      { field: 'blank', configured: false, reference: '{{ov_privacy:fixture-user:viking://~/privacy/credential/git%40lab#/values/blank}}' },
      { field: 'disabled', configured: true, reference: '{{ov_privacy:fixture-user:viking://~/privacy/credential/git%40lab#/values/disabled}}' },
      { field: 'unset', configured: false, reference: '{{ov_privacy:fixture-user:viking://~/privacy/credential/git%40lab#/values/unset}}' },
      { field: 'zero', configured: true, reference: '{{ov_privacy:fixture-user:viking://~/privacy/credential/git%40lab#/values/zero}}' },
    ],
  }] }] })
  assert.deepEqual((await checked(send, '/tree?category=missing')).categories, [{ category: 'missing', targets: [] }])
})

test('Privacy activates historical fields, linearizes patches, and deletes without resurrecting history', async t => {
  const actor = testPrincipal('acct', 'alice')
  const runtime = await localWorker({ principals: [actor] })
  t.after(() => runtime.dispose())
  const send = api(runtime, actor)
  const target = '/skill/fixture'
  const write = (values, method = 'PATCH') => checked(send, target, { method, body: { values } })

  assert.equal((await write({ 'clé/β': markers[0], nested: { b: 1, a: 2 } })).version, 1)
  const patches = await Promise.all([write({ first: markers[1] }), write({ second: markers[0] })])
  assert.deepEqual(patches.map(value => value.version).sort(), [2, 3])
  assert.deepEqual(Object.keys((await checked(send, target)).current.values).sort(), ['clé/β', 'first', 'nested', 'second'])
  assert.equal((await write({ nested: { a: 2, b: 1 } })).version, 3)
  assert.equal((await checked(send, `${target}/activate`, { method: 'POST', body: { version: 1 } })).version, 1)
  const fields = await checked(send, `${target}/fields`)
  assert.equal(fields.version, 1)
  const { reference } = fields.fields.find(field => field.field === 'clé/β')
  for (const selector of [reference, reference.replace('{{', '{{ ').replace('}}', ' }}'),
    'viking://~/privacy/skill/fixture#/values/cl%C3%A9%2F%CE%B2',
    'viking://user/alice/privacy/skill/fixture#/values/cl%C3%A9%2F%CE%B2']) {
    const found = await checked(send, '/resolve', { method: 'POST', body: { selector } })
    assert.equal(found.reference, reference)
    assert.equal(found.version, 1)
    assert.equal(found.redacted, true)
    assert.ok(!Object.hasOwn(found, 'value'))
  }
  const field = await checked(send, `${target}/field?field=cl%C3%A9%2F%CE%B2`)
  assert.equal(field.reference, reference)
  assert.ok(!Object.hasOwn(field, 'value'))
  await checked(send, `${target}/field?field=cl%C3%A9%2F%CE%B2&reveal=true`, {}, 403)
  const deletion = await checked(send, '/selector', { method: 'DELETE', body: { selector: reference } })
  assert.equal(deletion.active_version, 4)
  assert.equal(deletion.scope, 'field')
  assert.equal(deletion.target_deleted, false)
  assert.deepEqual(await checked(send, `${target}/versions`), [1, 2, 3, 4])
  assert.deepEqual(Object.keys((await checked(send, `${target}/versions/1`)).values).sort(), ['clé/β', 'nested'])
  assert.equal((await checked(send, `${target}/field?field=nested`, { method: 'DELETE' })).target_deleted, true)
  await checked(send, `${target}/versions/1`, {}, 404)
  assert.equal((await checked(send, target, { method: 'DELETE' })).deleted, false)
  assert.equal((await write({ seed: markers[0] }, 'POST')).version, 1)
  const removed = await checked(send, '/selector', { method: 'DELETE', body: { selector: 'viking://~/privacy/skill/fixture' } })
  assert.deepEqual(removed, { owner_user_id: 'alice', category: 'skill', target_key: 'fixture', deleted: true, scope: 'target' })
})

test('Privacy is account and owner scoped and redaction also binds admins', async t => {
  const owner = testPrincipal('acct-a', 'alice')
  const sameOwner = testPrincipal('acct-a', 'alice', 'user', 'agent-b')
  const admin = testPrincipal('acct-a', 'admin', 'admin')
  const other = testPrincipal('acct-b', 'alice', 'admin')
  const runtime = await localWorker({ principals: [owner, sameOwner, admin, other] })
  t.after(() => runtime.dispose())
  const target = '/credential/private'
  const payload = { method: 'POST', body: { values: { token: markers[0] }, labels: { a: markers[3] }, change_reason: markers[2] } }
  const send = api(runtime, owner)
  await checked(send, target, payload)
  const rows = await checked(api(runtime, sameOwner), `${target}/fields`)
  const { reference } = rows.fields[0]
  await checked(api(runtime), target, {}, 401)
  for (const actor of [admin, other]) {
    const foreign = api(runtime, actor)
    assert.deepEqual(await checked(foreign, ''), [])
    assert.equal((await checked(foreign, target, { headers: { 'x-openviking-user-id': 'alice', 'x-openviking-account-id': 'acct-a' } }, 404)).code, 'NOT_FOUND')
    assert.equal((await checked(foreign, target, { method: 'DELETE' })).deleted, false)
  }
  const asAdmin = api(runtime, admin)
  for (const [path, method] of [['/resolve', 'POST'], ['/selector', 'DELETE']]) {
    assert.equal((await checked(asAdmin, path, { method, body: { selector: reference } }, 403)).code, 'PERMISSION_DENIED')
  }
  await checked(asAdmin, target, payload)
  await checked(asAdmin, `${target}/field?field=token&reveal=true`, {}, 403)
  assert.deepEqual((await checked(asAdmin, target)).current.values, { token: null })
  assert.equal((await checked(send, target)).meta.updated_by, 'alice')
})

test('Privacy validation never includes inputs in errors and scan never claims a result', async t => {
  const actor = testPrincipal('acct', 'alice')
  const runtime = await localWorker({ principals: [actor] })
  t.after(() => runtime.dispose())
  const send = api(runtime, actor)
  const target = '/credential/sample'
  const invalidTarget = await checked(send, '/credential/two@@signs', { method: 'POST', body: { values: {} } }, 400)
  assert.deepEqual(invalidTarget, {
    code: 'INVALID_ARGUMENT', message: "Invalid Privacy target_key: must contain at most one '@'.",
    details: { field: 'target_key', reason: "must contain at most one '@'", allowed_pattern: '[A-Za-z0-9_.@-]+', max_characters: 255 },
  })
  const huge = markers[0] + 'z'.repeat(64 * 1024)
  assert.equal((await checked(send, target, { method: 'POST', body: { values: { [markers[2]]: huge } } }, 400)).details.reason, 'string value too large')
  const result = await checked(send, target, { method: 'POST', body: { [markers[3]]: {}, values: {} } }, 400)
  assert.equal(result.details.reason, 'unexpected JSON member')
  assert.deepEqual(await checked(send, ''), [])
  await checked(send, '/tree?category=', {}, 400)
  await checked(send, '/scan', { method: 'POST', body: {} }, 400)
  await checked(send, '/scan', { method: 'POST', body: { uri: 'viking://~/resources', node_limit: 1001 } }, 400)
  assert.equal((await checked(send, '/scan', { method: 'POST', body: { uri: 'viking://~/resources' } }, 501)).code, 'NOT_IMPLEMENTED')
})

test('Privacy active pointer and full history survive a restart and are not virtual filesystem entries', async () => {
  const actor = testPrincipal('acct', 'alice')
  const persist = await mkdtemp(join(tmpdir(), 'ov-privacy-fixture-'))
  const target = '/credential/persisted'
  let runtime
  try {
    const bundle = await build({ absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), entryPoints: ['src/worker.ts'],
      platform: 'browser', format: 'esm', bundle: true, write: false, external: ['cloudflare:workers'] })
    const launch = () => new Miniflare(convertV4MiniflareOptions({
      name: 'ov-privacy-restart', host: '127.0.0.1', port: 0, modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-11-19', resourcePersistencePath: persist, logRequests: false, log: new Log(LogLevel.ERROR),
      durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true } },
      outboundService: () => new Response(null, { status: 503 }),
      bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify([actor]) },
    }))
    runtime = launch()
    let send = api(runtime, actor)
    for (const [index, marker] of markers.slice(0, 2).entries()) {
      assert.equal((await checked(send, target, { method: 'POST', body: { values: { token: marker } } })).version, index + 1)
    }
    await checked(send, `${target}/activate`, { method: 'POST', body: { version: 1 } })
    await runtime.dispose()
    runtime = undefined

    runtime = launch()
    send = api(runtime, actor)
    assert.deepEqual(await checked(send, `${target}/versions`), [1, 2])
    assert.equal((await checked(send, target)).meta.active_version, 1)
    assert.equal((await checked(send, target, { method: 'PATCH', body: { values: { token: markers[0] } } })).version, 1)
    // Repeating the *other* history version from v1 must create v3: history is not an equality oracle.
    assert.equal((await checked(send, target, { method: 'PATCH', body: { values: { token: markers[1] } } })).version, 3)
    const uri = encodeURIComponent('viking://~/privacy/credential/persisted/current.json')
    const generic = await send(`/api/v1/content/read?uri=${uri}`)
    assert.ok([403, 404].includes(generic.status))
    for (const marker of markers) assert.ok(!(await generic.clone().text()).includes(marker))
  } finally {
    if (runtime) await runtime.dispose()
    await rm(persist, { recursive: true, force: true })
  }
})
