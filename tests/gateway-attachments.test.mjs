// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const ticketPath = '/gateway/transfers/tickets'
const headersFor = ticket => ticket.ticket_header ? { [ticket.ticket_header]: ticket.ticket } : {}
const issue = (send, action, fields) => send(ticketPath, { method: 'POST', body: { action, kind: 'attachment', ...fields } })
const redeem = (send, ticket, body) => send(ticket.url, { method: ticket.method, body, headers: headersFor(ticket) })
const post = (send, path, body) => send(path, { method: 'POST', body })
const noOutbound = () => { throw new Error('Outbound I/O is not part of the attachment fixture.') }
const vars = () => ({ OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1', OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: randomBytes(32).toString('hex') })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XyZkAAAAASUVORK5CYII=', 'base64')
const draft = (data = png, filename = 'Marée.png', content_type = 'image/png') => ({ filename, content_type, size: data.byteLength })
function wave(size, seed = 0) {
  const pcm = Buffer.alloc(size, seed)
  pcm.write('RIFF', 0); pcm.writeUInt32LE(size - 8, 4); pcm.write('WAVEfmt ', 8)
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22)
  pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(8000, 28); pcm.writeUInt16LE(1, 32); pcm.writeUInt16LE(8, 34)
  pcm.write('data', 36); pcm.writeUInt32LE(size - 44, 40)
  return pcm
}

function pdf() {
  let data = '%PDF-1.4\n%\x80\x81\x82\xff\n'
  const offsets = []
  for (const object of ['/Type /Catalog /Pages 2 0 R', '/Type /Pages /Kids [3 0 R] /Count 1',
    '/Type /Page /Parent 2 0 R /MediaBox [0 0 72 72]']) {
    offsets.push(data.length)
    data += `${offsets.length} 0 obj\n<< ${object} >>\nendobj\n`
  }
  const xref = data.length
  data += 'xref\n0 4\n0000000000 65535 f \n' + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
  return Buffer.from(data + `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1')
}

function multipart(fields, bytes = png, type = fields.content_type, filename = fields.filename) {
  const form = new FormData()
  form.set('file', new Blob([bytes], { type }), filename)
  return form
}

async function expect(pending, status, code) {
  const response = await pending
  assert.equal(response.status, status, response.status === status ? undefined : (await response.clone().json().catch(() => ({}))).error?.code)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  if (status >= 400) assert.equal(response.headers.get('content-disposition'), null)
  if (code) {
    const payload = await response.json()
    assert.equal(payload.reason ?? payload.error?.code, code)
  }
  return response
}

async function fixture(t, principals, options = {}) {
  const runtime = await localWorker({ principals, vars: vars(), outboundService: noOutbound, ...options })
  t.after(() => runtime.dispose())
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  return runtime
}

async function upload(send, fields = draft(), bytes = png) {
  const ticket = await result(issue(send, 'upload', { ...fields, ticket_transport: 'header' }), 201)
  return result(redeem(send, ticket, multipart(fields, bytes)))
}

async function result(pending, status = 200) {
  const payload = await (await expect(pending, status)).json()
  assert.equal(payload.status, 'ok')
  return payload.result
}

test('signed private attachment publishes bytes and serves the identical file after Workerd restarts', { timeout: 15000 }, async t => {
  const principal = testPrincipal('attachment-restart', 'alice'), settings = vars()
  const persist = await mkdtemp(join(tmpdir(), 'ov-attachments-'))
  const launch = () => localWorker({ principals: [principal], vars: settings, persist, outboundService: noOutbound })
  let runtime = await launch()
  t.after(async () => { await runtime.dispose(); await rm(persist, { recursive: true, force: true }) })
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  let send = api(runtime, principal)
  const fields = draft()
  const upload = await result(issue(send, 'upload', { ...fields, ticket_transport: 'header' }), 201)
  assert.equal(upload.url, '/gateway/uploads')
  assert.match(upload.attachment_id, /^att_[0-9a-f]{32}$/u)
  await expect(issue(send, 'download', { attachment_id: upload.attachment_id }), 404)
  const receipt = await result(redeem(send, upload, multipart(fields)))
  assert.deepEqual(receipt, { attachment_id: upload.attachment_id, ...fields, expires_at: receipt.expires_at })
  assert.ok(Date.parse(receipt.expires_at) > Date.now())
  const download = await result(issue(send, 'download', { attachment_id: receipt.attachment_id }), 201)
  assert.equal(download.method, 'GET')
  assert.ok(download.url.startsWith('/gateway/downloads?token='))
  await runtime.dispose()
  runtime = await launch()
  send = api(runtime, principal)
  await expect(redeem(send, upload, multipart(fields)), 401, 'invalid_transfer_ticket')
  const response = await expect(redeem(send, download), 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''Mar%C3%A9e.png")
  assert.equal(response.headers.get('content-length'), String(png.length))
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox;/u)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png)
  await expect(redeem(send, download), 401, 'invalid_transfer_ticket')
})

test('the signed multipart route stores WAV, PDF, ZIP and gzip as opaque bytes', async t => {
  const principal = testPrincipal('attachment-formats', 'alice')
  const send = api(await fixture(t, [principal], { embeddings: 'fixture', vars: { ...vars(), OPENVIKING_EDGE_DOCUMENT_CONVERSION: '1' } }), principal)
  const formats = [
    ['tide.wav', 'audio/wav', wave(256, 192)], ['page.pdf', 'application/pdf', pdf()],
    ['empty.zip', 'application/zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex')],
    ['journal.gz', 'application/gzip', gzipSync(Buffer.from('Journal de marée.'))],
  ]
  for (const [filename, type, bytes] of formats) {
    const saved = await upload(send, draft(bytes, filename, type), bytes)
    const ticket = await result(issue(send, 'download', { attachment_id: saved.attachment_id, ticket_transport: 'header' }), 201)
    const response = await expect(redeem(send, ticket), 200)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes, filename)
  }
})

test('mismatched attachment metadata, oversize and incomplete bodies never publish or stage an object', async t => {
  const principal = testPrincipal('attachment-validation', 'alice')
  const runtime = await fixture(t, [principal]), send = api(runtime, principal)
  const fields = draft()
  for (const [changes, status] of [
    [{ filename: 'plan.svg', content_type: 'image/svg+xml' }, 415], [{ filename: 'pack.ovpack', content_type: 'application/zip' }, 415],
    [{ filename: 'tide.wav' }, 415], [{ filename: 'photos/sea.png' }, 400], [{ size: 0 }, 400], [{ size: 1024 * 1024 + 1 }, 413],
    [{ retention_seconds: 604801 }, 400], [{ to: 'viking://~/resources' }, 400],
  ]) await expect(issue(send, 'upload', { ...fields, ...changes }), status)

  const extra = multipart(fields); extra.set('uri', 'viking://~/resources')
  for (const [form, status] of [[multipart(fields, png, 'image/jpeg'), 415], [multipart(fields, png, 'image/png', 'Other.png'), 400],
    [multipart(fields, Buffer.alloc(png.length)), 415], [multipart(fields, png.subarray(0, -2)), 400],
    [multipart(fields, Buffer.alloc(png.length + 1)), 413], [extra, 400]]) {
    const ticket = await result(issue(send, 'upload', fields), 201)
    await expect(redeem(send, ticket, form), status)
    await expect(issue(send, 'download', { attachment_id: ticket.attachment_id }), 404)
    await expect(redeem(send, ticket, multipart(fields)), 401, 'invalid_transfer_ticket')
  }
  const short = await result(issue(send, 'upload', { ...fields, filename: 'coast.png', ticket_transport: 'header' }), 201)
  const boundary = 'attachment-fixture'
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="coast.png"\r\nContent-Type: image/png\r\n\r\n`)
  const headers = { ...headersFor(short), 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-api-key': principal.key }
  await expect(runtime.dispatchFetch('http://localhost' + short.url,
    { method: 'POST', headers, body: Buffer.concat([prefix, png]) }), 400)
  await expect(issue(send, 'download', { attachment_id: short.attachment_id }), 404)
  await expect(post(send, '/api/v1/resources', { temp_file_id: short.attachment_id, wait: true }), 400)
})

test('owner-only signed deletion is single-use, invalidates outstanding tickets and does not disclose secrets in audit', async t => {
  const owner = testPrincipal('attachment-owner', 'alice'), otherKey = testPrincipal('attachment-owner', 'alice')
  const otherAgent = testPrincipal('attachment-owner', 'alice', 'user', 'elsewhere'), otherUser = testPrincipal('attachment-owner', 'bob', 'admin')
  const otherTenant = testPrincipal('attachment-other', 'alice'), root = testPrincipal('attachment-root', 'root', 'root')
  const runtime = await fixture(t, [owner, otherKey, otherAgent, otherUser, otherTenant, root], { embeddings: 'fixture',
    vars: { ...vars(), OPENVIKING_EDGE_GENERATION: '1' } })
  const send = api(runtime, owner), admin = api(runtime, otherUser), anon = api(runtime, null)
  const { attachment_id } = await upload(send)
  const body = { attachment_id, ticket_transport: 'header' }
  const model = '@cf/meta/llama-3.1-8b-instruct'
  const put = (url, body) => admin(url, { method: 'PUT', body })
  await expect(put('/gateway/admin/policies/direct', { name: 'Fixture' }), 200)
  await expect(put('/gateway/admin/upstreams/chat', { name: 'Fixture', protocol: 'chat', models: [model] }), 200)
  const { key } = await (await expect(post(send, '/gateway/admin/keys', {
    name: 'Fixture', policy_id: 'direct', upstream_ids: ['chat'], models: [model],
  }), 200)).json()
  const dedicated = api(runtime, { key })
  await expect(dedicated('/gateway/v1/models'), 200)
  const deleteTicket = await result(issue(send, 'delete', body), 201)
  const deletePeer = await result(issue(send, 'delete', body), 201)
  const readTicket = await result(issue(send, 'download', body), 201)
  assert.equal(deleteTicket.url, '/gateway/transfers/attachments')
  assert.equal(deleteTicket.method, 'DELETE')
  await expect(issue(anon, 'delete', body), 401)
  await expect(issue(api(runtime, root), 'delete', body), 403)
  for (const operation of ['delete', 'download']) await expect(issue(dedicated, operation, body), 401)
  for (const client of [anon, dedicated, api(runtime, otherKey), api(runtime, otherAgent), admin, api(runtime, otherTenant)]) {
    await expect(redeem(client, deleteTicket), 401)
  }
  for (const client of [api(runtime, otherAgent), admin, api(runtime, otherTenant)]) {
    await expect(issue(client, 'download', body), 404, 'attachment_not_found')
    await expect(issue(client, 'delete', body), 404, 'attachment_not_found')
  }
  await expect(send('/gateway/uploads', { method: 'POST', headers: headersFor(deleteTicket), body: multipart(draft()) }), 401)
  await expect(send(deleteTicket.url, { method: 'DELETE', headers: headersFor(readTicket) }), 401)
  await expect(send(deleteTicket.url + '?attachment_id=' + attachment_id, { method: 'DELETE', headers: headersFor(deleteTicket) }), 400)
  await expect(send(`http://other-origin.invalid${deleteTicket.url}`, { method: 'DELETE', headers: headersFor(deleteTicket) }), 401)
  const pair = await Promise.all([redeem(send, deleteTicket), redeem(send, deleteTicket)])
  assert.deepEqual(pair.map(r => r.status).sort(), [200, 401])
  assert.deepEqual((await pair.find(r => r.ok).json()).result, { attachment_id, deleted: true })
  for (const ticket of [readTicket, deletePeer]) {
    await expect(redeem(send, ticket), 404, 'attachment_not_found')
    await expect(redeem(send, ticket), 401, 'invalid_transfer_ticket')
  }
  await expect(issue(send, 'download', body), 404)
  const audit = await result(send('/api/v1/console/audit?page_size=100'))
  const observed = JSON.stringify(audit)
  for (const value of [deleteTicket.ticket, readTicket.ticket, attachment_id, owner.key, key]) assert.equal(observed.includes(value), false)
  assert.ok(audit.items.some(item => item.route === deleteTicket.url && item.method === 'DELETE' && item.status_code === 200))
})

test('per-member byte quotas block preissued tickets and deletion frees capacity', { timeout: 15000 }, async t => {
  const principal = testPrincipal('attachment-quota', 'alice')
  const send = api(await fixture(t, [principal]), principal)
  const bytes = wave(1024 * 1024, 137), fields = draft(bytes, 'large.wav', 'audio/wav')
  const staleCapacity = await result(issue(send, 'upload', fields), 201)
  const object = await upload(send, fields, bytes)
  for (let i = 1; i < 8; i++) await upload(send, fields, bytes)
  await expect(issue(send, 'upload', fields), 429, 'attachment_quota')
  await expect(redeem(send, staleCapacity, multipart(fields, bytes)), 429, 'attachment_quota')
  await expect(redeem(send, staleCapacity, multipart(fields, bytes)), 401, 'invalid_transfer_ticket')
  await expect(issue(send, 'download', { attachment_id: staleCapacity.attachment_id }), 404)
  const deletion = await result(issue(send, 'delete', { attachment_id: object.attachment_id }), 201)
  await result(redeem(send, deletion))
  const last = await upload(send, fields, bytes)
  const read = await result(issue(send, 'download', { attachment_id: last.attachment_id }), 201)
  assert.deepEqual(Buffer.from(await (await expect(redeem(send, read), 200)).arrayBuffer()), bytes)
})

const project = fileURLToPath(new URL('..', import.meta.url))
async function probeRuntime(principals, settings, persist) {
  const { outputFiles } = await build({ absWorkingDir: project, stdin: { resolveDir: project, contents: `
    import worker, { Workspace as Base } from './src/worker.ts';
    export { Control, OAuth } from './src/worker.ts';
    import { armGatewayAttachmentPurge, insertGatewayAttachment } from './src/gateway/attachments.ts';
    export default worker;
    export class Workspace extends Base {
      attachmentFixtureState(id, ticketId) {
        const sql=this.ctx.storage.sql;
        const bytes=sql.exec('SELECT length(body) AS size FROM ov_edge_gateway_attachment WHERE id=?', id).toArray()[0]?.size ?? 0;
        const spent=sql.exec('SELECT spent FROM ov_edge_gateway_transfer WHERE id=?', ticketId).toArray()[0]?.spent ?? null;
        const staging=sql.exec('SELECT count(*) AS n FROM ov_edge_fs_upload').one().n;
        return JSON.stringify({bytes,spent,staging});
      }
      async attachmentFixtureInsert(owner, id, meta, octets) {
        // Exercise the private storage primitive only in the synthetic fixture,
        // not a new production restore RPC or a bypass of the HTTP gate.
        try {
          await armGatewayAttachmentPurge(this.ctx.storage, meta.expiresAt);
          const info = this.ctx.storage.transactionSync(() => insertGatewayAttachment(this.ctx.storage.sql, owner, id, meta, Uint8Array.from(octets).buffer));
          return JSON.stringify(info);
        } catch (error) { return JSON.stringify({code:error.code}); }
      }
    }` }, bundle: true, write: false, platform: 'browser', format: 'esm', external: ['cloudflare:workers'] })
  const options = convertV4MiniflareOptions({ name: 'attachment-probe', host: '127.0.0.1', port: 0, modules: true,
    script: outputFiles[0].text, compatibilityDate: '2026-11-19', cf: false, logRequests: false,
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { ...settings, OPENVIKING_EDGE_KEYS: JSON.stringify(principals) }, log: new Log(LogLevel.ERROR), outboundService: noOutbound })
  const runtime = new Miniflare({ ...options, ...(persist && { resourcePersistencePath: persist }),
    enableDevRegistry: false, telemetry: { enabled: false } })
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  return runtime
}

async function workspace(runtime, account) {
  return (await runtime.getDurableObjectNamespace('WORKSPACES')).getByName(`openviking:account:${account}`)
}

async function until(read, predicate, limit = 5000) {
  const stop = Date.now() + limit
  do {
    const state = await read()
    if (predicate(state)) return state
    await delay(30)
  } while (Date.now() < stop)
  assert.fail('The expected fixture state was not reached before its deadline.')
}

test('the Workspace alarm removes expired BLOBs after restart and re-arms for the next deadline', { timeout: 15000 }, async t => {
  const owner = testPrincipal('attachment-expiry', 'alice'), settings = vars()
  const persist = await mkdtemp(join(tmpdir(), 'ov-attachment-expiry-'))
  const launch = () => probeRuntime([owner], settings, persist)
  let runtime = await launch()
  t.after(async () => { await runtime.dispose(); await rm(persist, { recursive: true, force: true }) })
  let send = api(runtime, owner)
  const first = await upload(send, { ...draft(), retention_seconds: 3 })
  const next = await upload(send, { ...draft(), retention_seconds: 5 })
  const earlier = await result(issue(send, 'download', { attachment_id: first.attachment_id }), 201)
  const later = await result(issue(send, 'download', { attachment_id: next.attachment_id }), 201)
  assert.ok(Date.parse(first.expires_at) < Date.parse(next.expires_at))
  await runtime.dispose()
  runtime = await launch()
  send = api(runtime, owner)
  const binding = await workspace(runtime, owner.accountId)
  const state = async id => JSON.parse(await binding.attachmentFixtureState(id, ''))
  assert.equal((await state(first.attachment_id)).bytes, png.length)
  await until(() => state(first.attachment_id), row => row.bytes === 0)
  await expect(redeem(send, earlier), 404, 'attachment_not_found')
  assert.equal((await state(next.attachment_id)).bytes, png.length)
  assert.deepEqual(Buffer.from(await (await expect(redeem(send, later), 200)).arrayBuffer()), png)
  await until(() => state(next.attachment_id), row => row.bytes === 0)
  await expect(issue(send, 'delete', { attachment_id: next.attachment_id }), 404, 'attachment_not_found')
})

test('isolated private SQL import preserves absolute expiry and invalidates tickets to a previous revision', async t => {
  const owner = testPrincipal('attachment-restore-hook', 'alice')
  const runtime = await probeRuntime([owner], vars())
  t.after(() => runtime.dispose())
  const send = api(runtime, owner)
  const item = await upload(send)
  const recorded = await result(issue(send, 'download', { attachment_id: item.attachment_id, ticket_transport: 'header' }), 201)
  const ticketId = recorded.ticket.split('.')[1]
  const binding = await workspace(runtime, owner.accountId)
  const scope = { accountId: owner.accountId, userId: owner.userId, agentId: owner.agentId }
  const state = async () => JSON.parse(await binding.attachmentFixtureState(item.attachment_id, ticketId))
  const meta = { filename: item.filename, contentType: item.content_type, size: item.size, expiresAt: Date.parse(item.expires_at) }
  const insert = async () => JSON.parse(await binding.attachmentFixtureInsert(scope, item.attachment_id, meta, [...png]))
  assert.deepEqual(await insert(), { code: 'transfer_revision_changed' })
  assert.deepEqual(await state(), { bytes: png.length, spent: 0, staging: 0 })
  await result(redeem(send, await result(issue(send, 'delete', { attachment_id: item.attachment_id }), 201)))
  assert.deepEqual(await state(), { bytes: 0, spent: 0, staging: 0 })
  const { revision, ...restored } = await insert()
  assert.match(revision, /^[0-9a-f-]{36}$/u)
  assert.deepEqual(restored, meta)
  assert.deepEqual(await state(), { bytes: png.length, spent: 0, staging: 0 })
  await expect(redeem(send, recorded), 409, 'transfer_revision_changed')
  await expect(redeem(send, recorded), 401, 'invalid_transfer_ticket')
  const fresh = await result(issue(send, 'download', { attachment_id: item.attachment_id }), 201)
  assert.deepEqual(Buffer.from(await (await expect(redeem(send, fresh), 200)).arrayBuffer()), png)
})

function tcpClient(origin, key) {
  return (path, { method = 'GET', body, headers } = {}) => fetch(new URL(path, origin), {
    method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
    headers: { 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  })
}

function holdMultipart(origin, principal, ticket, fields, bytes = png) {
  const boundary = 'held-attachment-fixture'
  const headers = { 'x-api-key': principal.key, ...headersFor(ticket), 'content-type': `multipart/form-data; boundary=${boundary}` }
  const { promise: receipt, resolve, reject } = Promise.withResolvers()
  // Prevent an unhandled rejection if the fixture fails before reading the receipt.
  void receipt.catch(() => {})
  const upload = request(new URL(ticket.url, origin), { method: 'POST', headers, agent: false }, async response => {
    try {
      const chunks = []
      for await (const chunk of response) chunks.push(chunk)
      resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks)) })
    } catch (error) { reject(error) }
  })
  upload.on('error', reject)
  upload.setTimeout(7500, () => upload.destroy(new Error('Fixture multipart receipt timed out.')))
  upload.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fields.filename}"\r\nContent-Type: ${fields.content_type}\r\n\r\n`)
  return { close: () => upload.end(Buffer.concat([bytes, Buffer.from(`\r\n--${boundary}--\r\n`)])), stop: () => upload.destroy(), receipt }
}

test('member authority lost while the multipart is pending prevents publication, independently of another member', { timeout: 15000 }, async t => {
  const root = testPrincipal('synthetic-bootstrap', 'root', 'root'), account = 'attachment-authority'
  const runtime = await probeRuntime([root], vars())
  t.after(() => runtime.dispose())
  const base = await runtime.ready
  const boot = tcpClient(base, root.key), accounts = '/api/v1/admin/accounts', users = `${accounts}/${account}/users`
  const manage = tcpClient(base, (await result(post(boot, accounts, { account_id: account, admin_user_id: 'owner' }))).user_key)
  const member = { key: (await result(post(manage, users, { user_id: 'alice' }))).user_key }
  const bobKey = (await result(post(manage, users, { user_id: 'bob' }))).user_key
  const bob = tcpClient(base, bobKey)
  const send = tcpClient(base, member.key), fields = draft(png, 'Coast.png')
  const bobTicket = await result(issue(bob, 'upload', fields), 201)
  const ticket = await result(issue(send, 'upload', { ...fields, ticket_transport: 'header' }), 201)
  const ticketId = ticket.ticket.split('.')[1]
  const binding = await workspace(runtime, account)
  const held = holdMultipart(base, member, ticket, fields)
  t.after(held.stop)
  const state = async () => JSON.parse(await binding.attachmentFixtureState(ticket.attachment_id, ticketId))
  assert.deepEqual(await until(state, row => row.spent === 1), { bytes: 0, spent: 1, staging: 0 })
  await expect(issue(send, 'download', { attachment_id: ticket.attachment_id }), 404)
  const { user_key } = await result(post(manage, `${users}/alice/key`))
  held.close()
  const stopped = await held.receipt
  assert.equal(stopped.status, 403)
  assert.equal(stopped.value.error.code, 'PERMISSION_DENIED')
  await expect(issue(tcpClient(base, user_key), 'download', { attachment_id: ticket.attachment_id }), 404)
  assert.deepEqual(await state(), { bytes: 0, spent: 1, staging: 0 })
  const bobForm = multipart(fields)
  const body = new Request('http://localhost', { method: 'POST', body: bobForm })
  await result(fetch(new URL(bobTicket.url, base), { method: 'POST', body: await body.arrayBuffer(),
    headers: { 'x-api-key': bobKey, 'content-type': body.headers.get('content-type') } }))
})
