// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'
import { embeddingGate } from './fs/async-worker.mjs'

const issuePath = '/gateway/transfers/tickets'
const post = (send, path, body, headers) => send(path, { method: 'POST', body, headers })
const put = (send, path, body) => send(path, { method: 'PUT', body })
const readPath = uri => '/api/v1/content/read?' + new URLSearchParams({ uri })
const bearer = key => ({ authorization: `Bearer ${key}` })
const credential = () => randomBytes(32).toString('hex')
const noOutbound = () => { throw new Error('Outbound I/O is not part of the transfer fixture.') }
const enabled = (secret = credential()) => ({ OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: secret })
const resource = (filename = 'notes.md') => ({ action: 'upload', filename, parent: 'viking://~/resources', processing_mode: 'vectors_only' })
const tokenOf = ticket => new URL(ticket.url, 'http://localhost').searchParams.get('token')

function form(name, content, type = 'application/octet-stream') {
  const data = new FormData()
  data.append('file', new Blob([content], { type }), name)
  data.set('upload_mode', 'local')
  data.set('telemetry', 'false')
  return data
}

async function responseWith(pending, status) {
  const response = await pending
  assert.equal(response.status, status)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  return response
}

async function result(pending, status = 200) {
  const { status: state, result } = await (await responseWith(pending, status)).json()
  assert.equal(state, 'ok')
  return result
}

async function refused(pending, status, code) {
  const response = await responseWith(pending, status)
  assert.equal(response.headers.get('content-disposition'), null)
  const payload = await response.json()
  if (code) assert.equal(payload.reason ?? payload.error?.code, code)
  return payload
}

async function fixture(t, principals, vars = {}, options = {}) {
  const runtime = await localWorker({ principals, embeddings: 'fixture', ...options,
    vars: { ...enabled(), ...vars }, outboundService: noOutbound })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  return runtime
}

test('a multipart resource upload is published and fetched byte-for-byte from the owner’s workspace', async t => {
  const alice = testPrincipal('transfer-fixture', 'alice')
  const runtime = await fixture(t, [alice])
  const send = api(runtime, alice)
  const content = '\uFEFFJournal de marée : 5 °C\r\nBateau A\n'
  const uri = 'viking://user/alice/resources/Marée.md'
  const up = await result(post(send, issuePath, { action: 'upload', filename: 'Marée.md', parent: 'viking://~/resources/',
    reason: 'Journal de la fixture', parse_mode: 'no_split', processing_mode: 'vectors_only', tags: ['type=marée'] }), 201)
  assert.equal(up.method, 'POST')
  assert.ok(up.url.startsWith('/gateway/uploads?token='))
  assert.equal(up.uri, uri)
  assert.ok(!up.url.includes(alice.key))
  const received = await result(post(send, up.url, form('Marée.md', content)))
  assert.equal(received.root_uri, uri)
  assert.equal(received.status, 'success')
  assert.ok(!Object.hasOwn(received, 'temp_file_id'))
  assert.equal(await result(send(readPath(uri))), content)
  const attrs = await result(send('/api/v1/fs/attrs?' + new URLSearchParams({ uri })))
  assert.deepEqual(attrs.attrs.tags, ['type=marée'])
  const down = await result(post(send, issuePath, { action: 'download', uri }), 201)
  assert.equal(down.method, 'GET')
  assert.ok(down.url.startsWith('/gateway/downloads?token='))
  const attachment = await responseWith(send(down.url), 200)
  assert.equal(attachment.headers.get('content-type'), 'application/octet-stream')
  assert.equal(attachment.headers.get('content-disposition'), "attachment; filename*=UTF-8''Mar%C3%A9e.md")
  assert.equal(attachment.headers.get('x-content-type-options'), 'nosniff')
  assert.match(attachment.headers.get('content-security-policy') ?? '', /^sandbox;/)
  assert.deepEqual(new Uint8Array(await attachment.arrayBuffer()), new TextEncoder().encode(content))
})

test('a signed SKILL.md can be previewed without installing, then installed through the skill owner', async t => {
  // The tenant is a direct API-key user, not a model/tool client.
  const user = testPrincipal('skill-fixture', 'alice')
  const runtime = await fixture(t, [user])
  const send = api(runtime, user)
  const target = 'viking://~/skills/tide-note'
  const data = '---\nname: tide-note\ndescription: Synthetic tide note\n---\n\n# Tide note\n'
  const multipart = () => form('SKILL.md', data, 'text/markdown')
  const inspect = () => send('/api/v1/skills/tide-note')
  const draft = { action: 'upload', kind: 'skill', target_uri: target, skills: ['tide-note'] }
  const preview = await result(post(send, issuePath, { ...draft, list_only: true }), 201)
  const previewed = await result(post(send, preview.url, multipart()))
  assert.equal(previewed.skills[0].name, 'tide-note')
  await responseWith(inspect(), 404)
  const install = await result(post(send, issuePath, draft), 201)
  const published = await result(post(send, install.url, multipart()))
  assert.equal(published.root_uri, 'viking://user/alice/skills/tide-note')
  assert.equal(published.owner_user_id, 'alice')
  assert.equal((await result(inspect())).content, data)
  await responseWith(post(send, issuePath, draft), 409)
  await responseWith(post(send, issuePath, { ...draft, target_uri: 'viking://agent/skills/tide-note' }), 403)
  await responseWith(post(api(runtime, null), issuePath, draft), 401)
})

test('opt-in and a separately provisioned signing secret are both required', async () => {
  const actor = testPrincipal('defaults', 'reader')
  for (const vars of [{}, { OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1' }, { OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: credential() },
    enabled('00'.repeat(32))]) {
    const runtime = await localWorker({ principals: [actor], vars, outboundService: noOutbound })
    try {
      const send = api(runtime, actor)
      await refused(post(send, issuePath, resource()), 501, 'signed_transfer_unavailable')
      await refused(post(send, '/gateway/uploads', form('notes.md', 'Local')), 501, 'signed_transfer_unavailable')
      await refused(send('/gateway/downloads'), 501, 'signed_transfer_unavailable')
    } finally { await runtime.dispose() }
  }
})

test('ticket scope requires a current direct matching tenant, actor, role, credential, origin and action', async t => {
  const owner = testPrincipal('scope', 'alice'), peer = testPrincipal('scope', 'alice', 'user', 'second'),
    other = testPrincipal('scope', 'bob'), tenant = testPrincipal('outside', 'alice'), secondKey = testPrincipal('scope', 'alice'),
    root = testPrincipal('scope', 'root', 'root'), admin = testPrincipal('scope', 'admin', 'admin')
  const runtime = await fixture(t, [owner, peer, other, tenant, secondKey, root, admin], { OPENVIKING_EDGE_GENERATION: '1' })
  const send = api(runtime, owner), manage = api(runtime, admin), an = api(runtime, null)
  const up = await result(post(send, issuePath, resource()), 201)
  const token = tokenOf(up)
  assert.ok(typeof token === 'string' && /^v1\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(token))
  const synthetic = () => form('notes.md', 'Fixture text')
  await refused(post(an, up.url, synthetic()), 401)
  await refused(post(api(runtime, root), issuePath, resource()), 403)
  await refused(post(api(runtime, root), up.url, synthetic()), 403)
  for (const principal of [peer, other, tenant, secondKey, admin]) {
    await refused(post(api(runtime, principal), up.url, synthetic()), 401, 'invalid_transfer_ticket')
  }
  await refused(send(`/gateway/downloads?token=${token}`), 401, 'invalid_transfer_ticket')
  await refused(post(send, up.url, synthetic(), { origin: 'http://origin.invalid' }), 403)
  await refused(post(send, `http://other-origin.invalid${up.url}`, synthetic()), 401, 'invalid_transfer_ticket')
  await refused(post(send, `${up.url}&uri=viking://~/resources/other.md`, synthetic()), 400)
  await refused(post(send, `${up.url}&token=${token}`, synthetic()), 400)
  const altered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')
  await refused(post(send, `/gateway/uploads?token=${altered}`, synthetic()), 401, 'invalid_transfer_ticket')

  // Genuine B3 dedicated key; still valid on the selected model route only.
  const model = '@cf/meta/llama-3.1-8b-instruct'
  assert.equal((await responseWith(put(manage, '/gateway/admin/policies/direct', { name: 'Local' }), 200)).ok, true)
  await responseWith(put(manage, '/gateway/admin/upstreams/chat', { name: 'Local', protocol: 'chat', models: [model] }), 200)
  const { key } = await (await responseWith(post(send, '/gateway/admin/keys', {
    name: 'Fixture', policy_id: 'direct', upstream_ids: ['chat'], models: [model],
  }), 200)).json()
  const limited = api(runtime, { key })
  await responseWith(limited('/gateway/v1/models'), 200)
  await refused(post(limited, issuePath, resource()), 401)
  await refused(post(limited, up.url, synthetic()), 401)
  await refused(limited(`/gateway/downloads?token=${token}`), 401)

  // Denials never grant or claim the ticket on behalf of another identity.
  await result(post(send, up.url, synthetic()))
  const logs = await result(send('/api/v1/console/audit?page_size=100'))
  const receipt = JSON.stringify(logs)
  assert.equal(receipt.includes(token), false)
  assert.equal(receipt.includes(owner.key), false)
  assert.ok(logs.items.some(item => item.route === '/gateway/uploads' && item.status_code === 200))
})

test('multipart bounds reject unsupported fields and bytes without creating any resource', async t => {
  const owner = testPrincipal('multipart', 'alice')
  const runtime = await fixture(t, [owner])
  const send = api(runtime, owner)
  const uri = 'viking://~/resources/notes.md'
  await refused(post(send, issuePath, { ...resource(), to: '/local/notes.md', parent: undefined }), 400)
  await refused(post(send, issuePath, { ...resource(), parent: 'viking://user/bob/resources' }), 403)
  await refused(post(send, issuePath, { ...resource(), filename: 'pack.ovpack' }), 415)
  const badFields = form('notes.md', 'Synthetic text')
  badFields.append('to', 'viking://~/resources/elsewhere.md')
  const two = form('notes.md', 'Synthetic text')
  two.append('file', new Blob(['Another file']), 'another.md')
  const shared = form('notes.md', 'Synthetic text')
  shared.set('upload_mode', 'shared')
  const uploads = [[badFields, 400], [two, 400], [shared, 501], [form('other.md', 'Synthetic text'), 400],
    [form('notes.md', new Uint8Array([0x00, 0x01, 0x02])), 415], [form('notes.md', 'x'.repeat(65537)), 413],
    [form('notes.md', 'x'.repeat(74 * 1024)), 413]]
  for (const [input, status] of uploads) {
    const up = await result(post(send, issuePath, resource()), 201)
    await refused(post(send, up.url, input), status)
    await refused(post(send, up.url, form('notes.md', 'Synthetic text')), 401, 'invalid_transfer_ticket')
  }
  const compressed = await result(post(send, issuePath, resource()), 201)
  await refused(post(send, compressed.url, form('notes.md', 'Synthetic text'), { 'content-encoding': 'gzip' }), 415)
  await refused(send(readPath(uri)), 404)
})

test('shared ACL is checked at issuance and at use; new revisions and parent replacement stop stale tickets', async t => {
  const admin = testPrincipal('acl-fixture', 'owner', 'admin'), alice = testPrincipal('acl-fixture', 'alice'),
    bob = testPrincipal('acl-fixture', 'bob')
  const runtime = await fixture(t, [admin, alice, bob])
  const manage = api(runtime, admin), send = api(runtime, alice), denied = api(runtime, bob)
  const parent = 'viking://resources/pier', uri = `${parent}/notes.md`
  const policy = (principal, level) => ({ acl_mode: 'restricted', entries: [{ principal, level }] })
  const acl = policy('user:alice', 'manage')
  const make = () => result(post(manage, '/api/v1/fs/mkdir', { uri: parent, acl }))
  const draft = { ...resource(), to: uri, parent: undefined, acl: policy('user:alice', 'read'), tags: ['topic=tides'] }
  const issueDownload = (client, options = {}) => post(client, issuePath, { action: 'download', uri, ...options })
  await make()
  await refused(post(denied, issuePath, draft), 403)
  const staleParent = await result(post(send, issuePath, draft), 201)
  await result(manage('/api/v1/fs?' + new URLSearchParams({ uri: parent }), { method: 'DELETE' }))
  await make()
  await refused(post(send, staleParent.url, form('notes.md', 'Old destination')), 409)
  await refused(send(readPath(uri)), 404)
  const fresh = await result(post(send, issuePath, draft), 201)
  const winner = await result(post(send, fresh.url, form('notes.md', 'First revision')))
  assert.equal(winner.root_uri, uri)
  await refused(issueDownload(denied), 403)
  await refused(post(manage, issuePath, draft), 409)
  const staleAcl = await result(issueDownload(send), 201)
  await result(put(manage, '/api/v1/acl', { uri, ...policy('user:owner', 'read') }))
  await refused(send(staleAcl.url), 403)
  await result(put(manage, '/api/v1/acl', { uri, ...policy('user:alice', 'read') }))
  const old = await result(issueDownload(send), 201)
  await result(post(manage, '/api/v1/content/write', { uri, content: 'Revised', mode: 'replace', processing_mode: 'vectors_only' }))
  await refused(send(old.url), 409, 'transfer_revision_changed')
  const next = await result(issueDownload(send, { ticket_transport: 'header' }), 201)
  assert.equal(next.url, '/gateway/downloads')
  assert.equal(next.ticket_header, 'x-openviking-transfer-ticket')
  const headers = { [next.ticket_header]: next.ticket }
  await responseWith(send(next.url, { method: 'HEAD', headers }), 405)
  const download = await responseWith(send(next.url, { headers }), 200)
  assert.equal(await download.text(), 'Revised')
  await refused(send(next.url, { headers }), 401, 'invalid_transfer_ticket')
})

test('a claimed upload cannot run twice; a group revocation during indexing prevents publication', { timeout: 15000 }, async t => {
  const admin = testPrincipal('held-transfer', 'owner', 'admin'), member = testPrincipal('held-transfer', 'alice')
  let calls = 0
  const gate = embeddingGate(texts => texts.includes('Held fixture text'))
  const project = fileURLToPath(new URL('..', import.meta.url))
  const { outputFiles } = await build({ absWorkingDir: project, stdin: { resolveDir: project, contents: `
    import worker, { Workspace as ProductionWorkspace } from './src/worker.ts';
    export default worker;
    export { Control, OAuth } from './src/worker.ts';
    export class Workspace extends ProductionWorkspace {
      constructor(ctx, env) { super(ctx, {...env, AI: { async run(model, { text }) {
        if (model !== '@cf/baai/bge-base-en-v1.5') throw Error('Unexpected fixture model');
        return (await env.PROVIDER.fetch('https://fixture.invalid/embedding', {method:'POST', body:JSON.stringify(text)})).json();
      }} }); }
    }` }, platform: 'browser', format: 'esm', bundle: true, external: ['cloudflare:workers'], write: false })
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({ name: 'gateway-transfer-held', host: '127.0.0.1', port: 0,
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-11-19', cf: false, logRequests: false,
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { ...enabled(), OPENVIKING_EDGE_KEYS: JSON.stringify([admin, member]) }, log: new Log(LogLevel.ERROR),
    outboundService: noOutbound, serviceBindings: { PROVIDER: async request => {
      calls++
      return Response.json(await gate.provider(await request.json()))
    } },
  }), enableDevRegistry: false, telemetry: { enabled: false } })
  t.after(async () => { gate.release(); await runtime.dispose() })
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  const manage = api(runtime, admin), send = api(runtime, member)
  const groups = '/api/v1/admin/accounts/held-transfer/groups', membership = `${groups}/writers/members`
  const parent = 'viking://resources/pier', uri = `${parent}/notes.md`
  await result(post(manage, groups, { group_id: 'writers' }))
  await result(put(manage, membership, { user_ids: ['alice'] }))
  await result(post(manage, '/api/v1/fs/mkdir', { uri: parent, acl: { acl_mode: 'restricted', entries: [
    { principal: 'group:writers', level: 'write' },
  ] } }))
  const signed = await result(post(send, issuePath, { ...resource(), parent }), 201)
  const pending = post(send, signed.url, form('notes.md', 'Held fixture text'))
  const deadline = new AbortController()
  try {
    await Promise.race([gate.entered, delay(5000, null, { signal: deadline.signal }).then(() => assert.fail('Indexing fixture was not reached'))])
    const second = await refused(post(send, signed.url, form('notes.md', 'Another fixture text')), 401, 'invalid_transfer_ticket')
    assert.equal(JSON.stringify(second).includes(tokenOf(signed)), false)
    await refused(manage(readPath(uri)), 404)
    await result(manage(membership, { method: 'DELETE', body: { user_ids: ['alice'] } }))
  } finally {
    deadline.abort()
    gate.release()
  }
  await refused(pending, 403, 'PERMISSION_DENIED')
  assert.equal(calls, 1)
  await refused(manage(readPath(uri)), 404)
})

test('expiry, quotas, restart and signing-key rotation are applied to the durable ticket ledger', { timeout: 15000 }, async t => {
  const persist = await mkdtemp(join(tmpdir(), 'ov-transfer-ledger-'))
  const principal = testPrincipal('ledger', 'alice'), secret = credential()
  const launch = (key = secret) => localWorker({ principals: [principal], embeddings: 'fixture', persist,
    vars: enabled(key), outboundService: noOutbound })
  let runtime = await launch()
  t.after(async () => { await runtime.dispose(); await rm(persist, { recursive: true, force: true }) })
  let send = api(runtime, principal)
  const expired = await result(post(send, issuePath, { ...resource('short.md'), ttl_seconds: 1 }), 201)
  await delay(Math.max(0, Date.parse(expired.expires_at) - Date.now()) + 50)
  await refused(post(send, expired.url, form('short.md', 'No file')), 401, 'invalid_transfer_ticket')
  const used = await result(post(send, issuePath, resource()), 201)
  await result(post(send, used.url, form('notes.md', 'Durable content')))
  const toRotate = await result(post(send, issuePath, resource('rotate.md')), 201)
  const live = await result(post(send, issuePath, { action: 'download', uri: 'viking://~/resources/notes.md' }), 201)
  for (let i = 0; i < 13; i++) await result(post(send, issuePath, resource(`slot-${i}.md`)), 201)
  await refused(post(send, issuePath, resource('slot-excess.md')), 429, 'transfer_ticket_limit')
  await runtime.dispose()
  runtime = await launch()
  send = api(runtime, principal)
  await refused(post(send, used.url, form('notes.md', 'No second file')), 401, 'invalid_transfer_ticket')
  assert.equal(await (await responseWith(send(live.url), 200)).text(), 'Durable content')
  await runtime.dispose()
  runtime = await launch(credential())
  send = api(runtime, principal)
  await refused(post(send, toRotate.url, form('rotate.md', 'No file')), 401, 'invalid_transfer_ticket')
  await refused(send(readPath('viking://~/resources/rotate.md')), 404)
})

test('valid OIDC and OAuth read credentials do not gain a transfer capability', async t => {
  const account = 'delegation', subject = 'transfer-fixture-user'
  const issuer = 'https://issuer.invalid/fixture', audience = 'transfer-fixture', tenantClaim = 'tenant'
  const jwtKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), kid = 'fixture-id'
  const jwk = { ...jwtKey.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] }
  const root = testPrincipal('delegate-bootstrap', 'root', 'root')
  const origin = 'http://localhost', callback = 'http://127.0.0.1:49257/fixture', client = 'transfer-fixture-cli'
  const runtime = await fixture(t, [root], {
    OPENVIKING_EDGE_OIDC: JSON.stringify({ enabled: true, issuer, audience, tenantClaim, jwks: { keys: [jwk] },
      mappings: [{ sub: subject, tenant: 'fixture', accountId: account, userId: 'alice' }] }),
    OPENVIKING_OAUTH_ISSUER: origin,
    OPENVIKING_OAUTH_CLIENTS: JSON.stringify([{ client_id: client, client_name: 'Transfer test', redirect_uris: [callback] }]),
  }, { serviceBindings: { ASSETS: () => new Response(null, { headers: { 'content-type': 'text/html' } }) } })
  const accounts = '/api/v1/admin/accounts', members = `${accounts}/${account}/users`
  const { user_key: admin } = await result(post(api(runtime, root), accounts, { account_id: account, admin_user_id: 'owner' }))
  const { user_key: key } = await result(post(api(runtime, { key: admin }), members, { user_id: 'alice' }))
  const owner = api(runtime, { key }), send = api(runtime, null)
  const upload = await result(post(owner, issuePath, resource()), 201)
  await result(post(owner, upload.url, form('notes.md', 'Direct data only')))
  const uri = upload.uri
  const down = await result(post(owner, issuePath, { action: 'download', uri, ticket_transport: 'header' }), 201)
  const up = await result(post(owner, issuePath, { ...resource('other.md'), ticket_transport: 'header' }), 201)
  const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url')
  const input = `${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode({ iss: issuer, aud: audience, sub: subject,
    tenant: 'fixture', exp: Math.floor(Date.now() / 1000) + 120 })}`
  const oidc = input + '.' + sign('sha256', Buffer.from(input), { key: jwtKey.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')

  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: callback, scope: 'workspace:read',
    resource: `${origin}/api/v1`, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') })
  const start = await responseWith(send(`/authorize?${query}`), 302)
  const pending = new URL(start.headers.get('location'), origin).searchParams.get('pending')
  const cookie = start.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(pending && cookie)
  await responseWith(post(owner, '/api/v1/auth/oauth-verify', { pending_id: pending, decision: 'approve' }, { cookie, origin }), 200)
  const consent = await (await responseWith(send(`/oauth/authorize/page/status?pending=${pending}`, { headers: { cookie } }), 200)).json()
  const code = new URL(consent.redirect_url).searchParams.get('code')
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: client, redirect_uri: callback,
    resource: `${origin}/api/v1`, code, code_verifier: verifier })
  const exchange = await responseWith(post(send, '/token', body.toString(), { 'content-type': 'application/x-www-form-urlencoded' }), 200)
  const { access_token: oauth } = await exchange.json()
  assert.ok(typeof oauth === 'string' && oauth.startsWith('ovat_'))
  for (const token of [oidc, oauth]) {
    assert.equal(await result(send(readPath(uri), { headers: bearer(token) })), 'Direct data only')
    await refused(post(send, issuePath, { action: 'download', uri }, bearer(token)), 403)
    await refused(post(send, up.url, form('other.md', 'No write'), { ...bearer(token), [up.ticket_header]: up.ticket }), 403)
    await refused(send(down.url, { headers: { ...bearer(token), [down.ticket_header]: down.ticket } }), 403)
  }
  assert.equal(await (await responseWith(owner(down.url, { headers: { [down.ticket_header]: down.ticket } }), 200)).text(), 'Direct data only')
  await refused(owner(readPath(up.uri)), 404)
  await result(post(owner, up.url, form('other.md', 'Owner write'), { [up.ticket_header]: up.ticket }))
})

test('a managed ticket cannot follow an API-key rotation or a role change', async t => {
  const root = testPrincipal('bootstrap', 'root', 'root'), accounts = '/api/v1/admin/accounts'
  const runtime = await fixture(t, [root])
  const { user_key: owner } = await result(post(api(runtime, root), accounts, { account_id: 'managed', admin_user_id: 'owner' }))
  const manage = api(runtime, { key: owner }), member = `${accounts}/managed/users/alice`
  const { user_key: original } = await result(post(manage, `${accounts}/managed/users`, { user_id: 'alice' }))
  const send = api(runtime, { key: original })
  const oldRole = await result(post(send, issuePath, resource()), 201)
  await result(put(manage, `${member}/role`, { role: 'admin' }))
  await refused(post(send, oldRole.url, form('notes.md', 'No promotion')), 401, 'invalid_transfer_ticket')
  const oldKey = await result(post(send, issuePath, resource()), 201)
  const { user_key: replacement } = await result(post(manage, `${member}/key`))
  await refused(post(send, oldKey.url, form('notes.md', 'Revoked')), 401, 'UNAUTHENTICATED')
  const current = api(runtime, { key: replacement })
  await refused(post(current, oldKey.url, form('notes.md', 'Wrong key')), 401, 'invalid_transfer_ticket')
  await refused(current(readPath(oldKey.uri)), 404)
  const fresh = await result(post(current, issuePath, resource()), 201)
  await result(post(current, fresh.url, form('notes.md', 'Current member')))
  assert.equal(await result(current(readPath(fresh.uri))), 'Current member')
})
