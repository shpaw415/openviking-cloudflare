// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { harness, principal } from './control/harness.mjs'

const accounts = '/api/v1/admin/accounts'
const privateUri = 'viking://~/resources/notes'
const roots = '/api/v1/fs/ls?uri=viking%3A%2F%2F'
const identity = '/_control-test/identity'
const stat = `/api/v1/fs/stat?uri=${encodeURIComponent(privateUri)}`
const users = account => `${accounts}/${account}/users`
const groups = account => `${accounts}/${account}/groups`

function result(response, status = 200) {
  // Do not dump an unexpectedly successful response that might contain a credential.
  assert.equal(response.status, status, `expected HTTP ${status}, got ${response.status} ${response.json?.error?.code ?? ''}`)
  assert.equal(response.json?.status, 'ok')
  return response.json.result
}

function denied(response, status, code) {
  assert.equal(response.status, status, `expected HTTP ${status}, got ${response.status}`)
  if (code) assert.equal(response.json?.error?.code, code)
}

async function create(h, account, admin = 'owner') {
  const response = await h.send(accounts, { method: 'POST', key: h.root, body: { account_id: account, admin_user_id: admin } })
  const data = result(response)
  assert.deepEqual(Object.keys(data).sort(), ['account_id', 'admin_user_id', 'user_key'])
  assert.equal(data.account_id, account)
  assert.equal(data.admin_user_id, admin)
  assert.ok(/^[a-f0-9]{64}$/.test(data.user_key))
  assert.match(response.headers['cache-control'], /(?:^|,\s*)no-store$/)
  return data.user_key
}

async function register(h, key, account, user, role = 'user') {
  return result(await h.send(users(account), { method: 'POST', key, body: { user_id: user, role } })).user_key
}

test('account creation activates its admin atomically; directories do not expose keys', async t => {
  const h = await harness(t)
  denied(await h.send(accounts), 401, 'UNAUTHENTICATED')
  const admin = await create(h, 'acme')
  const user = await register(h, admin, 'acme', 'alice')
  const list = result(await h.send(accounts, { key: h.root }))
  assert.deepEqual(list, [{ account_id: 'acme', created_at: list[0]?.created_at, user_count: 2, status: 'active' }])
  assert.ok(Number.isFinite(Date.parse(list[0].created_at)))
  for (const key of [h.root, admin, user]) {
    const response = await h.send(`${users('acme')}?include_summary=true&include_credentials=true`, { key })
    const { users: rows, total } = result(response)
    assert.equal(total, 2)
    assert.ok(!response.text.includes(admin) && !response.text.includes(user) && !response.text.includes(h.root))
    assert.deepEqual(rows, [{ user_id: 'owner', role: 'admin' }, { user_id: 'alice', role: 'user' }])
  }
  denied(await h.send(`${accounts}/acme`, { key: admin }), 403)
  denied(await h.send(roots, { key: h.root }), 403)
  assert.equal(result(await h.send(identity, { key: user })).role, 'user')
})

test('role changes and key rotation affect the same identity and preserve private data', async t => {
  const fixed = principal('legacy', 'old-admin', 'admin')
  const h = await harness(t, [fixed], { filesystem: true })
  const a = await create(h, 'acme')
  const b = await create(h, 'other')
  const key = await register(h, a, 'acme', 'alice')
  const bob = `${users('acme')}/alice`
  result(await h.send('/api/v1/fs/mkdir', { method: 'POST', key, body: { uri: privateUri } }))
  denied(await h.send(stat, { key: a }), 404)
  denied(await h.send(stat, { key: b }), 404)
  denied(await h.send(`${users('other')}/owner`, { key: a, headers: { 'x-openviking-account': 'other' } }), 403)
  denied(await h.send(`${bob}/role`, { method: 'PUT', key, body: { role: 'admin' } }), 403)
  denied(await h.send(`${bob}/role`, { method: 'PUT', key: a, body: { role: 'root' } }), 400)
  assert.deepEqual(result(await h.send(`${bob}/role`, { method: 'PUT', key: a, body: { role: 'Admin' } })),
    { account_id: 'acme', user_id: 'alice', role: 'admin' })
  result(await h.send(bob, { key }))
  result(await h.send(`${bob}/role`, { method: 'PUT', key: a, body: { role: 'user' } }))
  denied(await h.send(bob, { key }), 403)
  const rotations = await Promise.all(Array.from({ length: 4 }, () => h.send(`${bob}/key`, { method: 'POST', key })))
  assert.equal(rotations.filter(item => item.status === 200).length, 1)
  assert.ok(rotations.every(item => [200, 401, 409].includes(item.status)))
  const next = result(rotations.find(item => item.status === 200)).user_key
  assert.ok(next !== key)
  denied(await h.send(roots, { key }), 401)
  await h.restart()
  assert.equal(result(await h.send(stat, { headers: { authorization: `Bearer ${next}` } })).uri, 'viking://user/alice/resources/notes')
  denied(await h.send(`${users('legacy')}/old-admin/key`, { method: 'POST', key: h.root }), 403)
  denied(await h.send(`${accounts}/legacy`, { method: 'DELETE', key: h.root }), 403)
  denied(await h.send(`${users('legacy')}/old-admin/role`, { method: 'PUT', key: h.root, body: { role: 'user' } }), 403)
})

test('group updates are atomic, scoped, and immediately visible to the real ACL consumer', async t => {
  const h = await harness(t, [], { filesystem: true })
  const admin = await create(h, 'groups-one')
  const alice = await register(h, admin, 'groups-one', 'alice')
  const otherAdmin = await create(h, 'groups-other')
  const otherAlice = await register(h, otherAdmin, 'groups-other', 'alice')
  const endpoint = groups('groups-one')
  const members = `${endpoint}/writers/members`
  const uri = 'viking://resources/team'
  const inspect = `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`
  const createGroup = { method: 'POST', key: admin, body: { group_id: 'writers' } }
  assert.deepEqual(result(await h.send(endpoint, createGroup)), { group_id: 'writers', member_count: 0 })
  denied(await h.send(members, { method: 'PUT', key: admin, body: { user_ids: ['alice', 'missing'] } }), 404)
  assert.deepEqual(result(await h.send(members, { key: admin })).members, [])
  denied(await h.send(members, { method: 'PUT', key: otherAdmin, body: { user_ids: ['alice'] } }), 403)
  const add = { method: 'PUT', key: admin, body: { user_ids: ['alice', 'alice'] } }
  assert.deepEqual(result(await h.send(members, add)), { added: true })
  assert.deepEqual(result(await h.send(members, add)), { added: false })
  assert.deepEqual(result(await h.send('/_control-test/groups', { key: alice })), ['writers'])
  assert.deepEqual(result(await h.send('/_control-test/groups', { key: otherAlice })), [])
  result(await h.send('/api/v1/fs/mkdir', { method: 'POST', key: admin, body: { uri } }))
  result(await h.send('/api/v1/acl', { method: 'PUT', key: admin, body: {
    uri, acl_mode: 'restricted', entries: [{ principal: 'group:writers', level: 'read' }],
  } }))
  result(await h.send(inspect, { key: alice }))
  const remove = { method: 'DELETE', key: admin, body: { user_ids: ['alice', 'missing'] } }
  assert.deepEqual(result(await h.send(members, remove)), { removed: true })
  assert.deepEqual(result(await h.send(members, remove)), { removed: false })
  denied(await h.send(inspect, { key: alice }), 403)
  result(await h.send(`${endpoint}/writers`, { method: 'DELETE', key: admin }))
  denied(await h.send(endpoint, createGroup), 409)
})

test('tombstones fence deleted users and accounts even after a restart or a conflicting static configuration', async t => {
  const fixed = principal('legacy-id', 'legacy-user', 'admin')
  const h = await harness(t, [fixed], { filesystem: true })
  result(await h.send(roots, { key: fixed.key }))
  const admin = await create(h, 'retire')
  const retired = await register(h, admin, 'retire', 'former')
  result(await h.send('/api/v1/fs/mkdir', { method: 'POST', key: retired, body: { uri: privateUri } }))
  const userPath = `${users('retire')}/former`
  assert.deepEqual(result(await h.send(userPath, { method: 'DELETE', key: admin }), 202),
    { account_id: 'retire', user_id: 'former', status: 'revoked', data_retained: true })
  denied(await h.send(stat, { key: retired }), 401)
  denied(await h.send(users('retire'), { method: 'POST', key: admin, body: { user_id: 'former' } }), 409)
  denied(await h.send(stat, { key: admin }), 404)
  result(await h.send(`${accounts}/retire`, { method: 'DELETE', key: h.root }), 202)
  const conflicting = principal('retire', 'former')
  await h.restart([conflicting])
  denied(await h.send(stat, { key: conflicting.key }), 401)
  denied(await h.send(roots, { key: admin }), 401)
  await h.restart([])
  for (const account_id of ['retire', 'legacy-id']) {
    denied(await h.send(accounts, { method: 'POST', key: h.root, body: { account_id, admin_user_id: 'owner' } }), 409)
  }
})

test('managed identity lookup uses the exact active triplet and current role, excluding tombstones', async t => {
  const fixed = principal('oidc-fixed', 'fixed-owner', 'admin')
  const h = await harness(t, [fixed])
  const path = '/_control-test/managed-identity'
  const lookup = async (accountId, userId, agentId = 'default') => result(await h.send(path, {
    key: h.root, method: 'POST', body: { accountId, userId, agentId },
  }))
  const account = 'oidc-one'
  const user = 'mapped-member'
  const expected = { accountId: account, userId: user, agentId: 'default', role: 'user' }
  assert.equal(await lookup(account, user), null)
  const admin = await create(h, account)
  const other = await create(h, 'oidc-other')
  assert.equal(await lookup(account, user), null)
  const userKey = await register(h, admin, account, user)
  await register(h, other, 'oidc-other', user, 'admin')
  await register(h, fixed.key, fixed.accountId, user)

  assert.deepEqual(await lookup(account, user), expected)
  assert.deepEqual(await lookup('oidc-other', user), { ...expected, accountId: 'oidc-other', role: 'admin' })
  assert.deepEqual(await lookup(fixed.accountId, user), { ...expected, accountId: fixed.accountId })
  assert.equal(await lookup(fixed.accountId, fixed.userId), null)
  assert.equal(await lookup('default', 'edge-root'), null)
  assert.equal(await lookup(account, 'not-registered'), null)
  for (const agent of ['different-agent', '', 'default/other', 'x'.repeat(49), null, 3]) {
    assert.equal(await lookup(account, user, agent), null)
  }
  assert.equal(await lookup(null, user), null)
  assert.equal(await lookup(account, 3), null)

  const member = `${users(account)}/${user}`
  result(await h.send(`${member}/role`, { key: admin, method: 'PUT', body: { role: 'admin' } }))
  assert.deepEqual(await lookup(account, user), { ...expected, role: 'admin' })
  result(await h.send(`${member}/role`, { key: admin, method: 'PUT', body: { role: 'user' } }))
  assert.deepEqual(await lookup(account, user), expected)
  const replacement = result(await h.send(`${member}/key`, { key: userKey, method: 'POST' })).user_key
  denied(await h.send(identity, { key: userKey }), 401)
  assert.deepEqual(result(await h.send(identity, { key: replacement })), expected)
  assert.deepEqual(await lookup(account, user), expected)

  result(await h.send(member, { key: admin, method: 'DELETE' }), 202)
  assert.equal(await lookup(account, user), null)
  assert.equal((await lookup('oidc-other', user)).role, 'admin')
  result(await h.send(`${accounts}/oidc-other`, { key: h.root, method: 'DELETE' }), 202)
  assert.equal(await lookup('oidc-other', user), null)
  await h.restart()
  assert.equal(await lookup(account, user), null)
  assert.equal(await lookup('oidc-other', user), null)
  assert.equal((await lookup(account, 'owner')).role, 'admin')
})

test('configuration scopes and user settings persist sparse patches without enabling unsupported capabilities', async t => {
  const h = await harness(t)
  const created = await h.send(accounts, { method: 'POST', key: h.root, body: {
    account_id: 'cfg', admin_user_id: 'owner', settings: { output_language_override: 'fr-CA', acl: { enabled: true } },
    user_config: { add_targets: { resource_uri: 'viking://~/resources/notes' } },
  } })
  const admin = result(created).user_key
  const alice = await register(h, admin, 'cfg', 'alice')
  const cfg = `${accounts}/cfg/configuration`
  const cfgCluster = '/api/v1/admin/configuration'
  const settings = `${users('cfg')}/alice/settings`
  assert.equal(result(await h.send(cfg, { key: admin })).settings.output_language_override, 'fr-CA')
  denied(await h.send(cfg, { key: alice }), 403)
  denied(await h.send(cfgCluster, { method: 'PATCH', key: admin, body: { settings: {} } }), 403)
  denied(await h.send(cfg, { method: 'PATCH', key: admin, body: { settings: { embedding: null } } }), 403)
  denied(await h.send(cfg, { method: 'PATCH', key: admin, body: { settings: { output_language_override: 'en', acl: { enabled: false } } } }), 412)
  denied(await h.send(cfgCluster + '?source=file', { key: h.root }), 501, 'NOT_IMPLEMENTED')
  assert.equal(result(await h.send(cfg, { key: admin })).settings.output_language_override, 'fr-CA')
  const cluster = result(await h.send(cfgCluster, { method: 'PATCH', key: h.root, body: { settings: { output_language_override: 'fr' } } }))
  assert.deepEqual(cluster.settings, { output_language_override: 'fr' })
  result(await h.send(cfg, { method: 'PATCH', key: admin, body: { settings: { output_language_override: null } } }))
  assert.deepEqual(result(await h.send(`${accounts}/cfg/settings`, { key: admin })).overrides, { acl: { enabled: true } })
  denied(await h.send(settings.replace('/alice/', '/owner/'), { key: alice }), 403)
  const added = result(await h.send(settings, { method: 'PATCH', key: alice, body: { add_targets: { resource_uri: 'viking://~/resources/notes' } } }))
  assert.equal(added.add_targets.resource_uri, 'viking://user/alice/resources/notes')
  assert.deepEqual(result(await h.send('/_control-test/settings', { key: alice })),
    { resource_parent: 'viking://user/alice/resources/notes', skill_parent: null, output_language: 'fr' })
  denied(await h.send(settings, { method: 'PATCH', key: alice, body: { add_targets: { resource_uri: 'viking://user/owner/resources' } } }), 400)
  denied(await h.send(settings, { method: 'PATCH', key: alice, body: { ttl: { sessions: 1 } } }), 501)
  await h.restart()
  assert.deepEqual(result(await h.send(settings, { key: alice })), added)
  assert.equal(result(await h.send(settings, { method: 'PATCH', key: alice, body: { add_targets: null } })).add_targets.resource_uri, null)
})

test('template publishing is account scoped and default round trips clear only that override', async t => {
  const h = await harness(t)
  const admin = await create(h, 'templates')
  const other = await create(h, 'templates-other')
  const user = await register(h, admin, 'templates', 'alice')
  const list = `${accounts}/templates/memory-templates`
  const endpoint = `${list}/preferences`
  const types = result(await h.send(list, { key: admin })).templates.map(t => t.memory_type)
  assert.deepEqual(types, ['profile', 'events', 'preferences', 'entities'])
  const defaults = result(await h.send(endpoint, { key: admin }))
  assert.equal(defaults.status, 'system_default')
  denied(await h.send(endpoint, { key: user }), 403)
  denied(await h.send(endpoint, { key: other }), 403)
  const edited = result(await h.send(endpoint, { method: 'PUT', key: admin, body: {
    fields: [{ name: 'topic', description: 'Topic in {{ language }}.' }],
  } }))
  assert.equal(edited.status, 'custom')
  assert.ok(edited.updated_at)
  assert.equal(edited.effective.fields.find(f => f.name === 'topic').description, 'Topic in {{ language }}.')
  denied(await h.send(endpoint, { method: 'PUT', key: admin, body: { directory: 'viking://resources' } }), 400)
  denied(await h.send(endpoint, { method: 'PUT', key: admin, body: { fields: [{ name: 'user', description: 'Locked.' }] } }), 400)
  await h.restart()
  assert.deepEqual(result(await h.send(endpoint, { key: admin })), edited)
  assert.equal(result(await h.send(endpoint, { method: 'PUT', key: admin, body: defaults.defaults })).status, 'system_default')
  assert.equal(result(await h.send(endpoint, { method: 'DELETE', key: admin })).status, 'system_default')
})

test('the model probe requires root and refuses non-bound models without storing submitted config', async t => {
  const h = await harness(t)
  const admin = await create(h, 'models')
  const url = '/api/v1/admin/configuration/test-model'
  const payload = { kind: 'embedding', config: { provider: 'workers_ai', model: '@cf/baai/bge-base-en-v1.5' } }
  denied(await h.send(url, { key: admin, method: 'POST', body: payload }), 403)
  denied(await h.send(url, { key: h.root, method: 'POST', body: { ...payload, config: { ...payload.config, provider: 'unbound' } } }), 400)
  denied(await h.send(url, { key: h.root, method: 'POST', body: payload }), 503, 'MODEL_PROBE_UNAVAILABLE')
  assert.deepEqual(result(await h.send('/api/v1/admin/configuration', { key: h.root })).settings, {})
})

test('the approved binding is called with fixed text only, checked, and subject to quota', async t => {
  const h = await harness(t, [], { model: 'fixture' })
  const badProvider = await harness(t, [], { model: 'invalid' })
  const url = '/api/v1/admin/configuration/test-model'
  const payload = { kind: 'embedding', config: { provider: 'workers_ai', model: '@cf/baai/bge-base-en-v1.5', dimension: 768 } }
  const bad = await badProvider.send(url, { key: badProvider.root, method: 'POST', body: payload })
  assert.equal(result(bad).ok, false)
  assert.match(bad.headers['cache-control'], /no-store/)
  for (let i = 0; i < 8; i++) {
    const body = i === 0 ? { kind: 'vlm', config: { provider: 'workers_ai', model: '@cf/meta/llama-3.1-8b-instruct' } } : payload
    const response = result(await h.send(url, { key: h.root, method: 'POST', body }))
    assert.deepEqual(Object.keys(response).sort(), ['ms', 'ok'])
    assert.equal(response.ok, true)
    assert.ok(Number.isFinite(response.ms))
  }
  denied(await h.send(url, { key: h.root, method: 'POST', body: payload }), 429, 'RATE_LIMITED')
})

test('event overrides render as bounded text from an allowlist, not upstream Jinja', async t => {
  const h = await harness(t)
  const admin = await create(h, 'event-template')
  const user = await register(h, admin, 'event-template', 'ev-reader')
  const endpoint = `${accounts}/event-template/memory-templates/events`
  const local = '/_control-test/template'
  const event = { event_name: 'fixture', summary: ' A sample. ' }
  assert.equal(result(await h.send(local, { key: user, method: 'POST', body: event })).content, null)
  result(await h.send(endpoint, { key: admin, method: 'PUT', body: {
    description: "{% if language == 'fr' %}Français{% else %}Other{% endif %}",
    content_template: '# {{ event_name | upper }}\n{{ summary | trim }}',
  } }))
  let outcome = result(await h.send(local, { key: user, method: 'POST', body: event }))
  assert.equal(outcome.description, 'Français')
  assert.equal(outcome.content, '# FIXTURE\nA sample.')
  denied(await h.send(endpoint, { key: admin, method: 'PUT', body: { content_template: '{% for item in items %}{{ item }}{% endfor %}' } }), 400)
  outcome = result(await h.send(local, { key: user, method: 'POST', body: { ...event, summary: '{{ goal }}' } }))
  assert.equal(outcome.content, '# FIXTURE\n{{ goal }}')
})

test('real Worker: root cannot see sessions, rotation preserves them, deletion fences their namespace', async t => {
  const h = await harness(t, [], { production: true })
  const admin = await create(h, 'session-control')
  const user = await register(h, admin, 'session-control', 'session-owner')
  denied(await h.send('/_control-test/managed-identity', { key: h.root, method: 'POST', body: {
    accountId: 'session-control', userId: 'session-owner', agentId: 'default',
  } }), 404)
  const session = '/api/v1/sessions/owned-session'
  result(await h.send('/api/v1/sessions', { key: user, method: 'POST', body: { session_id: 'owned-session' } }))
  result(await h.send(`${session}/messages`, { key: user, method: 'POST', body: { role: 'user', content: 'Control test fixture' } }))
  denied(await h.send(session, { key: admin }), 404)
  denied(await h.send(session, { key: h.root }), 403)
  const member = `${users('session-control')}/session-owner`
  const next = result(await h.send(`${member}/key`, { key: user, method: 'POST' })).user_key
  denied(await h.send(session, { key: user }), 401)
  await h.restart()
  assert.equal(result(await h.send(session, { key: next })).message_count, 1)
  result(await h.send(member, { key: admin, method: 'DELETE' }), 202)
  denied(await h.send(session, { key: next }), 401)
  denied(await h.send(users('session-control'), { key: admin, method: 'POST', body: { user_id: 'session-owner' } }), 409)
})

test('only digests persist; the historical digest cannot authenticate after rotation', async t => {
  const fixed = principal('secret-boundary', 'fixed-owner', 'admin')
  const h = await harness(t, [fixed])
  const old = await register(h, fixed.key, fixed.accountId, 'registered')
  const endpoint = `${users(fixed.accountId)}/registered/key`
  const next = result(await h.send(endpoint, { key: old, method: 'POST' })).user_key
  denied(await h.send(roots, { key: old }), 401)
  result(await h.send(identity, { key: next }))
  await h.close()
  const location = join(h.dir, 'state/control-test')
  const files = await readdir(location)
  assert.ok(files.length > 0)
  for (const file of files) {
    const data = await readFile(join(location, file))
    assert.ok([old, next, fixed.key, h.root].every(key => !data.includes(key)))
  }
  const path = join(location, files.find(file => file.endsWith('.sqlite')))
  const hash = key => createHash('sha256').update(key).digest('hex')
  const counts = execFileSync('/usr/bin/python3', ['-I', '-c', `import json, pathlib, sqlite3, sys
old, new = json.load(sys.stdin)
with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + '?mode=ro', uri=True) as database:
    def count(sql, *values):
        return database.execute(sql, values).fetchone()[0]
    print(json.dumps([
        count('SELECT count(*) FROM ov_control_key_history WHERE digest IN (?, ?)', old, new),
        count('SELECT count(*) FROM ov_control_users WHERE digest = ?', new),
        count('SELECT count(*) FROM ov_control_users WHERE digest = ?', old),
    ]))`, path], { input: JSON.stringify([hash(old), hash(next)]), encoding: 'utf8' })
  assert.deepEqual(JSON.parse(counts), [2, 1, 0])
})

test('concurrent provisioning is atomic; permanent group quotas do not recycle revoked IDs', async t => {
  const h = await harness(t)
  const createRequest = { key: h.root, method: 'POST', body: { account_id: 'quotas', admin_user_id: 'owner' } }
  denied(await h.send(accounts, { ...createRequest, body: { ...createRequest.body, user_config: { ttl: { sessions: 1 } } } }), 501)
  denied(await h.send(`${accounts}/quotas`, { key: h.root }), 404)
  const [first, second] = await Promise.all([h.send(accounts, createRequest), h.send(accounts, createRequest)])
  assert.deepEqual([first.status, second.status].sort(), [200, 409])
  const admin = result(first.status === 200 ? first : second).user_key
  const endpoint = groups('quotas')
  const createGroup = index => h.send(endpoint, { key: admin, method: 'POST', body: { group_id: `g${index}` } })
  for (let i = 0; i < 127; i++) result(await createGroup(i))
  const last = await Promise.all([createGroup(127), createGroup(128)])
  assert.deepEqual(last.map(item => item.status).sort(), [200, 413])
  result(await h.send(`${endpoint}/g0`, { key: admin, method: 'DELETE' }))
  denied(await createGroup(129), 413, 'RESOURCE_EXHAUSTED')
  assert.equal(result(await h.send(endpoint, { key: admin })).length, 127)
})
