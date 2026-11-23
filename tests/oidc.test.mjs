// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { constants, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { clientId, harness, origin, redirect } from './oidc/harness.mjs'

const algorithms = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512']
const issuer = 'https://idp.example.invalid/organization/'
const audience = 'openviking-fixture'
const subject = 'external|member'
const tenantClaim = 'https://claims.example.invalid/tenant'
const mappings = [
  { sub: subject, tenant: 'green', accountId: 'north', userId: 'member' },
  { sub: subject, tenant: 'blue', accountId: 'south', userId: 'member' },
  { sub: 'legacy-member', tenant: 'green', accountId: 'legacy', userId: 'fixed' },
  { sub: 'local-admin', tenant: 'green', accountId: 'north', userId: 'owner' },
]

function signer(alg, kid = `fixture-${alg}`) {
  const ec = alg.startsWith('ES')
  const { privateKey, publicKey } = ec
    ? generateKeyPairSync('ec', { namedCurve: { ES256: 'prime256v1', ES384: 'secp384r1', ES512: 'secp521r1' }[alg] })
    : generateKeyPairSync('rsa', { modulusLength: 2048 })
  const bits = Number(alg.slice(2))
  const options = ec ? { dsaEncoding: 'ieee-p1363' } : alg.startsWith('PS')
    ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: bits / 8 } : { padding: constants.RSA_PKCS1_PADDING }
  return {
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig', key_ops: ['verify'] },
    token(payload, headers = {}, replacements = {}) {
      const encoded = value => Buffer.from(value).toString('base64url')
      const header = { kid, alg, typ: 'JWT', ...headers }
      const input = `${encoded(replacements.header ?? JSON.stringify(header))}.${encoded(replacements.body ?? JSON.stringify(payload))}`
      return `${input}.${sign(`sha${bits}`, Buffer.from(input), { key: privateKey, ...options, ...replacements.sign }).toString('base64url')}`
    },
  }
}

const active = signer('RS256')
const next = signer('ES256', 'fixture-rotation')
const operator = (keys = [active.jwk], changes = {}) => ({ enabled: true, issuer, audience, tenantClaim, jwks: { keys }, mappings, ...changes })
const at = (time, changes = {}) => ({ iss: issuer, aud: audience, sub: subject, [tenantClaim]: 'green', exp: time + 300, ...changes })
const now = () => Math.floor(Date.now() / 1000)
const jwt = (changes = {}, headers, signing = active) => signing.token(at(now(), changes), headers)
const fixtureJwt = (changes = {}, headers, signing = active, replacements) => signing.token(at(1_800_000_000, changes), headers, replacements)

function result(response, label = '') {
  assert.equal(response.status, 200, `${label}: HTTP ${response.status} ${response.json?.error?.code ?? ''}`)
  assert.equal(response.json?.status, 'ok', label)
  return response.json.result
}

function denied(response, status = 401, code = 'UNAUTHENTICATED', label = '') {
  assert.equal(response.status, status, label)
  if (code) assert.equal(response.json?.error?.code, code, label)
  if (status === 401) assert.equal(response.headers['www-authenticate'], 'Bearer', label)
}

test('module on workerd: all nine pinned JOSE algorithms; exact directory tuple only', async t => {
  const signers = algorithms.map(alg => alg === 'RS256' ? active : signer(alg))
  const h = await harness(operator(signers.map(item => item.jwk)), { mode: 'module' })
  t.after(h.close)
  assert.equal(result(await h.send('/main/configuration')), true)
  for (const key of signers) {
    const response = await h.send('/main/admit', { jwt: fixtureJwt({
      role: 'root', groups: ['administrator'], accountId: 'other', agent_id: 'other', user_id: 'owner',
    }, {}, key) })
    assert.deepEqual(result(response, key.jwk.alg), { accountId: 'north', userId: 'member', agentId: 'default', role: 'user' })
  }
  assert.equal(result(await h.send('/main/admit', { jwt: fixtureJwt({ [tenantClaim]: 'blue' }) })).accountId, 'south')
  const pss = signers.find(key => key.jwk.alg === 'PS256')
  denied(await h.send('/main/admit', { jwt: fixtureJwt({}, {}, pss, { sign: { saltLength: 20 } }) }), 401, 'UNAUTHENTICATED', 'non-JOSE PSS salt')
  const ecs = signers.find(key => key.jwk.alg === 'ES256')
  denied(await h.send('/main/admit', { jwt: fixtureJwt({}, {}, ecs, { sign: { dsaEncoding: 'der' } }) }), 401, 'UNAUTHENTICATED', 'not the JOSE ECDSA representation')
})

test('module on workerd: malformed/disabled operator configurations isolate unrelated credentials', async t => {
  const profiles = Object.fromEntries(Object.entries({
    disabled: { enabled: false }, noAudience: operator(undefined, { audience: undefined }),
    httpIssuer: operator(undefined, { issuer: 'http://idp.example.invalid' }),
    queryIssuer: operator(undefined, { issuer: `${issuer}?x=y` }), inconsistent: operator(undefined, { enabled: false }),
    duplicateKid: operator([active.jwk, { ...next.jwk, kid: active.jwk.kid }]),
    duplicateKey: operator([active.jwk, { ...active.jwk, kid: 'second' }]),
    privateKey: operator([{ ...active.jwk, d: 'synthetic-invalid' }]),
    unsignedPolicy: operator([{ ...active.jwk, alg: 'none' }]),
    symmetricPolicy: operator([{ kty: 'oct', kid: 'no', alg: 'HS256', k: 'synthetic-invalid' }]),
    absentAlgorithm: operator([{ ...active.jwk, alg: undefined }]),
    keyOperations: operator([{ ...active.jwk, key_ops: ['sign'] }]),
    smallModulus: operator([{ ...active.jwk, n: Buffer.alloc(128, 255).toString('base64url') }]),
    wrongCurve: operator([{ ...next.jwk, alg: 'ES384' }]),
    invalidPoint: operator([{ ...next.jwk, x: Buffer.alloc(32).toString('base64url'), y: Buffer.alloc(32).toString('base64url') }]),
    mismatchedTenantClaim: operator(undefined, { tenantClaim: 'sub' }),
    duplicateSource: operator(undefined, { mappings: [...mappings, { ...mappings[0], userId: 'different' }] }),
    duplicateTarget: operator(undefined, { mappings: [...mappings, { ...mappings[0], sub: 'different' }] }),
    localIdentifier: operator(undefined, { mappings: [{ ...mappings[0], userId: 'member\n' }] }),
    remoteJwks: operator(undefined, { jwks: { keys: [active.jwk], uri: 'https://idp.example.invalid/keys' } }),
  }).map(([name, value]) => [name, JSON.stringify(value)]))
  profiles.ambiguous = JSON.stringify(operator()).replace('"enabled":true', '"enabled":false,"\\u0065nabled":true')
  profiles.tooLong = ' '.repeat(65_537)
  const h = await harness(operator(), { mode: 'module', profiles })
  t.after(h.close)
  for (const profile of ['absent', 'disabled']) {
    assert.equal(result(await h.send(`/${profile}/configuration`)), false)
    denied(await h.send(`/${profile}/admit`, { jwt: fixtureJwt() }))
  }
  for (const profile of Object.keys(profiles).filter(name => name !== 'disabled')) {
    denied(await h.send(`/${profile}/configuration`), 503, 'AUTH_NOT_CONFIGURED', profile)
    denied(await h.send(`/${profile}/admit`, { jwt: fixtureJwt() }), 503, 'AUTH_NOT_CONFIGURED', profile)
    assert.equal(result(await h.send(`/${profile}/admit`, { jwt: 'opaque_key_without_a_dot' })), null, profile)
  }
})

test('module on workerd: signature, JOSE metadata, serialization and credential channel negatives', async t => {
  const h = await harness(operator(), { mode: 'module' })
  t.after(h.close)
  const wrong = signer('RS256', active.jwk.kid)
  const token = fixtureJwt()
  const header = JSON.stringify({ alg: 'RS256', kid: active.jwk.kid })
  const cases = [
    fixtureJwt({}, {}, wrong), fixtureJwt({}, { kid: 'unregistered' }), fixtureJwt({}, { kid: undefined }),
    fixtureJwt({}, { alg: undefined }), fixtureJwt({}, { alg: 'RS384' }), fixtureJwt({}, { alg: 'none' }),
    fixtureJwt({}, { typ: 'at+jwt' }), fixtureJwt({}, { jku: 'https://idp.example.invalid/keys' }),
    fixtureJwt({}, { jwk: next.jwk }), fixtureJwt({}, { x5u: 'https://idp.example.invalid/cert' }),
    fixtureJwt({}, { crit: ['future'], future: true }),
    fixtureJwt({}, {}, active, { header: header.replace('{', '{"\\u0061lg":"RS256",') }),
    fixtureJwt({}, {}, active, { body: JSON.stringify(at(1_800_000_000)).replace('{', '{"sub":"duplicate",') }),
    fixtureJwt({}, {}, active, { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(at(1_800_000_000)))]) }),
    fixtureJwt({}, {}, active, { body: Buffer.from([123, 255, 125]) }),
    fixtureJwt({ nested: JSON.parse('['.repeat(24) + '0' + ']'.repeat(24)) }),
    `${token}=`, token.split('.').slice(0, 2).join('.'), `${token}.extra`, 'a.b.c',
    fixtureJwt({ padding: 'a'.repeat(6200) }),
  ]
  for (const [i, candidate] of cases.entries()) {
    const reply = await h.send('/main/admit/down', { jwt: candidate })
    denied(reply, 401, 'UNAUTHENTICATED', `JOSE negative ${i}`)
    assert.equal(reply.json.error.message, 'A valid OIDC bearer is required.')
  }
  for (const name of ['access_token', 'id_token', 'token']) {
    denied(await h.send(`/main/admit?${name}=test`, { jwt: token }))
    assert.equal(result(await h.send(`/main/admit?${name}=${token}`)), null)
  }
  denied(await h.send('/main/admit', { jwt: token, key: h.fixed }))
  denied(await h.send('/main/admit', { headers: { authorization: `Bearer ${token}, Bearer ${token}` } }))
  assert.equal(result(await h.send('/main/admit', { key: token })), null)
  assert.equal(result(await h.send('/main/admit', { headers: { cookie: `id_token=${token}`, 'x-openviking-user': 'member' } })), null)
  assert.equal(result(await h.send('/main/admit', { jwt: fixtureJwt({}, { typ: undefined }) })).role, 'user')
})

test('module on workerd: signed issuer, audience/azp, exact tuple and time boundaries', async t => {
  const profiles = {
    distinct: JSON.stringify(operator(undefined, { clientId: 'fixture-client', additionalAudiences: ['trusted-side'] })),
    clientOnly: JSON.stringify(operator(undefined, { audience: undefined, clientId: audience })),
  }
  const h = await harness(operator(), { mode: 'module', profiles })
  t.after(h.close)
  const time = 1_800_000_000
  const bad = [
    { iss: issuer.slice(0, -1) }, { iss: issuer.toUpperCase() }, { iss: undefined },
    { aud: undefined }, { aud: 'different' }, { aud: [] }, { aud: [audience, audience] }, { aud: [audience, 'untrusted'] },
    { aud: [audience, 7] }, { azp: null }, { azp: 'different' },
    { exp: undefined }, { exp: time }, { exp: time - 1 }, { exp: String(time + 100) }, { exp: time + 1.5 },
    { nbf: time + 1 }, { nbf: null }, { nbf: false }, { nbf: -1 }, { iat: time + 1 },
    { sub: undefined }, { sub: 'EXTERNAL|MEMBER' }, { sub: `${subject}\n` }, { sub: 123 },
    { [tenantClaim]: undefined }, { [tenantClaim]: 'Green' }, { [tenantClaim]: 'green ' }, { [tenantClaim]: ['green'] },
    { cnf: { jkt: 'synthetic-fixture' } },
  ]
  for (const [i, changes] of bad.entries()) denied(await h.send('/main/admit/down', { jwt: fixtureJwt(changes) }), 401, 'UNAUTHENTICATED', `signed claim negative ${i}`)
  assert.equal(result(await h.send('/main/admit', { jwt: fixtureJwt({ nbf: time, iat: time, exp: time + 1, aud: [audience], azp: audience }) })).role, 'user')
  assert.equal(result(await h.send('/clientOnly/admit', { jwt: fixtureJwt() })).role, 'user')
  const coAudience = [audience, 'trusted-side']
  for (const changes of [{}, { aud: coAudience }, { aud: coAudience, azp: audience }, { aud: ['trusted-side'], azp: 'fixture-client' }]) {
    denied(await h.send('/distinct/admit', { jwt: fixtureJwt(changes) }))
  }
  for (const aud of [audience, coAudience.slice().reverse()]) {
    assert.equal(result(await h.send('/distinct/admit', { jwt: fixtureJwt({ aud, azp: 'fixture-client' }) })).role, 'user')
  }
})

test('module on workerd: receipt rechecks live authority, policy and expiry after waits', async t => {
  const h = await harness(operator(), { mode: 'module', profiles: { rotated: JSON.stringify(operator([next.jwk])) } })
  t.after(h.close)
  const signed = fixtureJwt()
  for (const mode of ['revoked', 'wrong', 'fixed', 'root', 'admin', 'bad-agent']) {
    denied(await h.send(`/main/admit/${mode}`, { jwt: signed }))
    denied(await h.send(`/main/reauthorize/${mode}`, { jwt: signed }))
  }
  for (const mode of ['missing', 'down']) {
    for (const operation of ['admit', 'reauthorize']) {
      const response = await h.send(`/main/${operation}/${mode}`, { jwt: signed })
      denied(response, 503, 'AUTH_UNAVAILABLE')
      assert.ok(!response.text.includes('fixture-directory-private-diagnostic'))
    }
  }
  assert.equal(result(await h.send('/main/reauthorize', { jwt: signed })).role, 'user')
  denied(await h.send('/main/reauthorize/agent', { jwt: signed }))
  denied(await h.send('/main/reauthorize/stale-policy', { jwt: signed }))
  const expiring = fixtureJwt({ exp: 1_800_000_001 })
  for (const path of ['/main/admit/late', '/main/reauthorize/late', '/main/fence']) denied(await h.send(path, { jwt: expiring }))
})

const accounts = '/api/v1/admin/accounts'
const status = '/api/v1/system/status'
const privateRoot = 'viking://~/resources'
const pathFor = (route, uri) => `/api/v1/${route}?${new URLSearchParams({ uri })}`

async function provision(h, account) {
  const owner = result(await h.send(accounts, { method: 'POST', key: h.root, body: { account_id: account, admin_user_id: 'owner' } })).user_key
  const member = `${accounts}/${account}/users/member`
  const key = result(await h.send(`${accounts}/${account}/users`, { method: 'POST', key: owner, body: { user_id: 'member' } })).user_key
  assert.ok(typeof owner === 'string' && typeof key === 'string', 'managed credentials produced')
  return { owner, member, key }
}

test('mounted Worker: disabled and malformed OIDC do not change historical API-key authentication', async t => {
  const h = await harness()
  t.after(h.close)
  for (const [config, expected, code] of [[undefined, 401, 'UNAUTHENTICATED'], [{ enabled: false }, 401, 'UNAUTHENTICATED'], ['{}', 503, 'AUTH_NOT_CONFIGURED']]) {
    if (config !== undefined) await h.restart(config)
    denied(await h.send(status, { jwt: jwt() }), expected, code)
    assert.equal(result(await h.send(status, { key: h.fixed })).user, 'fixed')
    assert.equal(result(await h.send(status, { jwt: h.fixed })).user, 'fixed')
    const health = await h.send('/health', { key: h.root })
    assert.equal(health.status, 200)
    assert.equal(health.json.auth_mode, 'api_key')
    assert.equal(health.json.role, 'root')
  }
})

test('mounted Worker: /health keeps API-key authentication only', async t => {
  const h = await harness(operator())
  t.after(h.close)
  const north = await provision(h, 'north')
  for (const credentials of [{}, { key: north.key }, { jwt: north.key }]) {
    const response = await h.send('/health', credentials)
    assert.equal(response.status, 200)
    assert.equal(response.json.auth_mode, 'api_key')
    assert.equal(response.json.user_id, Object.keys(credentials).length ? 'member' : undefined)
  }
  denied(await h.send('/health', { jwt: jwt() }), 401, 'UNAUTHENTICATED', 'the federated bearer is restricted to the data allowlist')
})

test('mounted Worker: cross-account isolation and actual reads/search, never writes/admin/jobs', async t => {
  const h = await harness(operator())
  t.after(h.close)
  const north = await provision(h, 'north'), south = await provision(h, 'south')
  const uri = `${privateRoot}/fixture.md`
  const write = '/api/v1/content/write'
  for (const [directory, marker] of [[north, 'green proof'], [south, 'blue proof']]) {
    result(await h.send(write, { method: 'POST', key: directory.key, body: { uri, content: marker, defer_processing: true } }))
  }
  const green = jwt({ role: 'root', account_id: 'south', user_id: 'owner', agent_id: 'overridden' })
  const blue = jwt({ [tenantClaim]: 'blue' })
  const read = pathFor('content/read', uri)
  assert.equal(result(await h.send(read, { jwt: green, headers: { 'x-openviking-account': 'south', 'x-openviking-user': 'owner' } })), 'green proof')
  assert.equal(result(await h.send(read, { jwt: blue })), 'blue proof')
  const listing = await h.send(pathFor('fs/stat', uri), { method: 'HEAD', jwt: green })
  assert.equal(listing.status, 200)
  assert.equal(listing.text, '')
  assert.match(listing.headers['cache-control'], /no-store/)
  assert.equal(result(await h.send(status, { jwt: green })).user, 'member')
  for (const [operation, pattern] of [['grep', 'green proof'], ['glob', '*.md']]) {
    const hits = result(await h.send(`/api/v1/search/${operation}`, { jwt: green, method: 'POST', body: { uri: privateRoot, pattern } }))
    assert.equal(hits.matches.length, 1)
  }
  const gated = result(await h.send('/api/v1/system/edge-capabilities', { jwt: green }))
  assert.equal(gated.unsupported_api_status, 403)
  assert.equal(gated.generation.configured, false)
  assert.equal(gated.features.monitoring, false)
  assert.ok(Object.keys(gated.features).length > 0 && Object.values(gated.features).every(value => value === false))
  const dataKey = result(await h.send('/api/v1/system/edge-capabilities', { key: north.key }))
  assert.equal(dataKey.features.tasks, true)
  assert.equal(dataKey.features.monitoring, true)
  for (const [method, path, body] of [
    ['POST', write, { uri, content: 'denied write', defer_processing: true }], ['GET', accounts],
    ['GET', '/api/v1/tasks'], ['POST', '/api/v1/system/wait', {}], ['POST', '/api/v1/search/find', { query: 'proof' }],
    ['GET', '/api/v1/debug/health'], ['GET', '/api/v1/observer/system'], ['GET', '/webdav/resources'], ['GET', '/metrics'],
  ]) denied(await h.send(path, { method, jwt: green, body }), 403, 'PERMISSION_DENIED', path)
  assert.equal(result(await h.send(read, { key: north.key })), 'green proof')
  denied(await h.send(status, { jwt: green, key: north.key }))
  denied(await h.send(status, { key: green }))
  assert.equal((await h.send(status, { headers: { 'x-openviking-account': 'north', 'x-openviking-user': 'member' } })).status, 401)
  assert.equal((await h.send('/__observe-oidc-north', { key: h.root })).status, 404, 'no test endpoint in public Worker')
})

test('mounted Worker: Control group, role, user/account revocation and rotation are current', async t => {
  const h = await harness(operator())
  t.after(h.close)
  const north = await provision(h, 'north'), south = await provision(h, 'south')
  const green = jwt(), blue = jwt({ [tenantClaim]: 'blue' })
  const uri = 'viking://resources/group-only'
  const stat = pathFor('fs/stat', uri)
  const group = `${accounts}/north/groups`, members = `${group}/readers/members`
  assert.equal((await h.send(status, { key: h.fixed })).status, 200)
  denied(await h.send(status, { jwt: jwt({ sub: 'legacy-member' }) }))
  denied(await h.send(status, { jwt: jwt({ sub: 'local-admin' }) }))
  result(await h.send(group, { key: north.owner, method: 'POST', body: { group_id: 'readers' } }))
  result(await h.send('/api/v1/fs/mkdir', { key: north.owner, method: 'POST', body: { uri } }))
  result(await h.send('/api/v1/acl', { key: north.owner, method: 'PUT', body: { uri, acl_mode: 'restricted', entries: [{ principal: 'group:readers', level: 'read' }] } }))
  denied(await h.send(stat, { jwt: green }), 403, 'PERMISSION_DENIED')
  result(await h.send(members, { key: north.owner, method: 'PUT', body: { user_ids: ['member'] } }))
  assert.equal(result(await h.send(stat, { jwt: green })).uri, uri)
  result(await h.send(members, { key: north.owner, method: 'DELETE', body: { user_ids: ['member'] } }))
  denied(await h.send(stat, { jwt: green }), 403, 'PERMISSION_DENIED')
  const rotatedKey = result(await h.send(`${north.member}/key`, { key: north.key, method: 'POST' })).user_key
  denied(await h.send(status, { key: north.key }))
  assert.equal(result(await h.send(status, { key: rotatedKey })).user, 'member')
  assert.equal(result(await h.send(status, { jwt: green })).user, 'member')
  result(await h.send(`${north.member}/role`, { key: north.owner, method: 'PUT', body: { role: 'admin' } }))
  denied(await h.send(status, { jwt: green }))
  result(await h.send(`${north.member}/role`, { key: north.owner, method: 'PUT', body: { role: 'user' } }))
  assert.equal(result(await h.send(status, { jwt: green })).user, 'member')

  const rotatedConfig = operator([next.jwk])
  await h.restart(rotatedConfig)
  denied(await h.send(status, { jwt: green }))
  const newGreen = jwt({}, {}, next), newBlue = jwt({ [tenantClaim]: 'blue' }, {}, next)
  assert.equal(result(await h.send(status, { jwt: newGreen })).user, 'member')
  assert.equal(result(await h.send(status, { jwt: newBlue })).user, 'member')
  assert.equal((await h.send(north.member, { key: north.owner, method: 'DELETE' })).status, 202)
  assert.equal((await h.send(`${accounts}/south`, { key: h.root, method: 'DELETE' })).status, 202)
  await h.restart(rotatedConfig)
  for (const bearer of [newGreen, newBlue]) denied(await h.send(status, { jwt: bearer }))
  denied(await h.send(status, { key: south.key }))
  assert.equal(result(await h.send(status, { key: north.owner })).user, 'owner')
})

test('mounted Worker with a dispatch observer: no raw credentials reach Workspace and live revocation stops dispatch', async t => {
  const h = await harness(operator(), { mode: 'observed' })
  t.after(h.close)
  const north = await provision(h, 'north')
  const gate = '/__observe-oidc-north'
  const signed = jwt()
  const pending = h.send(status, { jwt: signed, headers: { prefer: 'fixture-oidc-pause', 'x-openviking-user': 'owner' } })
  try {
    let waiting = false
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = result(await h.send(gate, { key: h.root }))
      if (!waiting) await delay(10)
    }
    assert.equal(waiting, true, 'receipt reached the observer without bearer or identity headers')
    assert.equal((await h.send(north.member, { key: north.owner, method: 'DELETE' })).status, 202)
  } finally {
    await h.send(gate, { key: h.root, method: 'POST' })
  }
  denied(await pending)
  assert.equal(result(await h.send(status, { key: north.owner })).user, 'owner')
})

test('mounted Worker: managed-key OAuth consent and opaque bearer still work with OIDC enabled', async t => {
  const h = await harness(operator())
  t.after(h.close)
  const north = await provision(h, 'north')
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url')
  const resource = `${origin}/api/v1`
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: 'workspace:read', resource,
    state, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
  const start = await h.send(`/authorize?${params}`)
  assert.equal(start.status, 302, 'authorize prepares Studio consent')
  const pending = new URL(start.headers.location, origin).searchParams.get('pending')
  const cookie = start.headers['set-cookie'][0].split(';', 1)[0]
  const consent = { method: 'POST', headers: { origin, cookie }, body: { pending_id: pending, decision: 'approve' } }
  assert.equal((await h.send('/api/v1/auth/oauth-verify', { ...consent, jwt: jwt() })).status, 403)
  assert.equal((await h.send('/api/v1/auth/oauth-verify', { ...consent, jwt: north.key })).status, 200)
  const poll = await h.send(`/oauth/authorize/page/status?pending=${encodeURIComponent(pending)}`, { headers: { cookie, origin } })
  assert.equal(poll.status, 200, 'poll reads approved intent')
  const code = new URL(poll.json.redirect_url).searchParams.get('code')
  const exchange = await h.send('/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: clientId,
    code_verifier: verifier, code, redirect_uri: redirect, resource } })
  assert.equal(exchange.status, 200, 'code exchange with the live managed key binding')
  const opaque = exchange.json?.access_token
  assert.ok(typeof opaque === 'string' && opaque.startsWith('ovat_'))
  const list = pathFor('fs/ls', privateRoot)
  result(await h.send(list, { jwt: opaque }))
  denied(await h.send(status, { jwt: opaque }), 403, 'PERMISSION_DENIED')
  result(await h.send(`${north.member}/key`, { key: north.key, method: 'POST' }))
  denied(await h.send(list, { jwt: opaque }))
  assert.equal(result(await h.send(status, { jwt: jwt() })).user, 'member')
})
