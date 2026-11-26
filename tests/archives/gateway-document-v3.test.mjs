// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { principal } from '../control/harness.mjs'
import { portableHarness, random, sha } from './instance-portable-harness.mjs'

const A = 'fixture-doc-alpha', B = 'fixture-doc-beta'
const profile = 'edge-v1-portable-state', expiryCode = 'attachment_not_found'
const roster = () => [principal(A, 'admin', 'admin'), principal(A, 'reader', 'user', 'notes'),
  principal(A, 'reader'), principal(A, 'neighbor'), principal(B, 'reader', 'user', 'notes'), principal(B, 'admin', 'admin')]
const check = (reply, status = 200, code) => {
  assert.equal(reply.status, status, `Expected ${status}, received ${reply.status} (${reply.json?.error?.code ?? reply.json?.reason ?? '-'})`)
  if (code) assert.equal(reply.json?.error?.code ?? reply.json?.reason, code)
  if (status >= 400) assert.equal(Object.hasOwn(reply.json ?? {}, 'result'), false)
  return reply.json?.result
}
const ticket = (h, actor, action, fields) => h.api('/gateway/transfers/tickets', { key: actor.key,
  body: { action, kind: 'attachment', ticket_transport: 'query', ...fields } })
const redeem = (h, actor, issued, extra = {}) => h.api(issued.url, { key: actor.key, method: issued.method,
  ...extra })
async function upload(h, actor, bytes, retention_seconds) {
  const filename = 'buoy.txt', content_type = 'text/plain'
  const draft = { filename, content_type, size: bytes.length, retention_seconds }
  const issued = check(await ticket(h, actor, 'upload', draft), 201)
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: content_type }), filename)
  const payload = new Request('http://localhost/gateway/uploads', { method: 'POST', body: form })
  const before = Date.now()
  const reply = await redeem(h, actor, issued, { body: { data: Buffer.from(await payload.arrayBuffer()).toString('base64'),
    contentType: payload.headers.get('content-type') } })
  return { before, reply, issued, draft }
}
const native = (h, actor, protocol, id) => h.api(`/gateway/v1/${protocol}`, { key: actor.key, body: { model: 'fixture-document',
  ...(protocol === 'responses' ? { input: [{ role: 'user', content: [{ type: 'input_file', file_id: id }] }] } :
    { max_tokens: 160, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: id } }] }] }),
} })

function sealedRecords(archive) {
  // Independent read-only ZIP oracle, no JSON or SQL writes to either instance.
  const r = spawnSync('/usr/bin/python3', ['-I', '-c', `import hashlib, io, json, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    meta = json.loads(z.read('inventory.json'))
    rows = {}
    for name in z.namelist():
        if not name.startswith('accounts/') or not name.endswith('.zip'): continue
        account = name.removeprefix('accounts/').removesuffix('.zip')
        with zipfile.ZipFile(io.BytesIO(z.read(name))) as member:
            assert 'portable-state.json' in member.namelist()
            with zipfile.ZipFile(io.BytesIO(member.read('workspace.zip'))) as domain:
                entries = json.loads(domain.read('attachments.json'))
                assert all(hashlib.sha256(domain.read('attachments/'+e['id']+'.bin')).hexdigest() == e['sha256'] for e in entries)
                rows[account] = entries
    print(json.dumps([meta['format_version'], meta['profile'], rows]))`], { input: archive, timeout: 4000, maxBuffer: 8192 })
  assert.equal(r.status, 0, r.stderr.toString())
  return JSON.parse(r.stdout)
}

test('private UTF-8 attachment survives an instance v3 round-trip and restart, remains scoped and expires on the original deadline',
  { timeout: 45000 }, async t => {
    const key = random(32), policy = [A, B].map(account_id => ({ account_id, scope_id: random(16) }))
    const s = roster(), d = roster()
    const { outputFiles: [bundle] } = await build({ entryPoints: [fileURLToPath(new URL('./gateway-document-v3-fixture.mjs', import.meta.url))],
      define: Object.fromEntries(['FIXTURE_TRANSFER_SECRET', 'FIXTURE_OPENAI', 'FIXTURE_ANTHROPIC'].map(k => [k, JSON.stringify(random(32))])),
      bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false })
    const src = await portableHarness(t, bundle.contents, s, key, policy), dst = await portableHarness(t, bundle.contents, d, key, policy)
    const sc = check(await src.op('identify')).control, dc = check(await dst.op('identify')).control
    assert.notEqual(sc, dc)
    const sourceId = random(16), standbyId = random(16)
    const source = { mode: 'source', instance_id: sourceId, peer_id: standbyId, peer_control: dc }
    const standby = { mode: 'standby', instance_id: standbyId, peer_id: sourceId, peer_control: sc }
    for (const h of [src, dst]) check(await h.api('/api/v1/admin/accounts', { key: h.root }))
    check(await src.api('/api/v1/snapshot/ignore', { key: s[0].key, method: 'PUT', body: { content: '*.log\n' } }))

    for (const invalid of [Buffer.from([0xc3, 0x28]), Buffer.from('texte\u0000'), Buffer.from('\ufeffmarée')]) {
      const rejected = await upload(src, s[1], invalid, 90)
      check(rejected.reply, 415, 'UNSUPPORTED_MEDIA_TYPE')
      check(await ticket(src, s[1], 'download', { attachment_id: rejected.issued.attachment_id }), 404, expiryCode)
    }
    const payload = Buffer.from('Marée 🌊 — café\r\nÉcoute\tdu quai\n'), expectedDigest = sha(payload), ttl = 18
    const good = await upload(src, s[1], payload, ttl), item = check(good.reply)
    const { attachment_id: id, expires_at } = item, expires = Date.parse(expires_at)
    assert.deepEqual(item, { attachment_id: good.issued.attachment_id, expires_at, filename: good.draft.filename, content_type: 'text/plain', size: payload.length })
    assert.ok(expires >= good.before + ttl * 1000 && expires <= Date.now() + ttl * 1000)
    const requestPiece = { attachment_id: id }
    const assertNative = async (h, actor, protocol) => {
      const reply = await native(h, actor, protocol, id)
      check(reply)
      assert.equal(protocol === 'responses' ? reply.json.output[0].content[0].text : reply.json.content[0].text, `SHA256 ${expectedDigest}.`)
      assert.equal(reply.headers['x-openviking-capture'], 'disabled')
    }
    for (const p of ['responses', 'messages']) await assertNative(src, s[1], p)
    const stale = check(await ticket(src, s[1], 'download', requestPiece), 201)
    await src.restart(source)
    const pack = await src.op('capture', { profile })
    check(pack)
    await src.close()
    assert.deepEqual(sealedRecords(pack.bytes), [3, profile, { [A]: [{ id, user_id: 'reader', agent_id: 'notes', filename: 'buoy.txt',
      content_type: 'text/plain', size: payload.length, expires_at: expires, sha256: expectedDigest }], [B]: [] }])
    assert.equal(pack.bytes.includes(Buffer.from(new URL(stale.url, 'http://fixture.local').searchParams.get('token'))), false)

    const apply = (action, arg) => dst.op(action, { archive: pack.bytes.toString('base64'), arg })
    await dst.restart(standby, d.filter(a => a !== d[1]))
    check(await apply('evaluate'), 409, 'INSTANCE_BACKUP_INVENTORY')
    await dst.restart(standby)
    const plan = check(await apply('evaluate'))
    assert.deepEqual([plan.dry_run, plan.accounts, plan.attachment_count], [true, 2, 1])
    assert.equal(check(await apply('begin', plan.approval), 202).phase, 'staged')
    check(await apply('step', 0), 202)
    const complete = check(await apply('step', 1), 202)
    assert.equal(complete.phase, 'awaiting_release')
    check(await ticket(dst, d[1], 'download', requestPiece), 503, 'INSTANCE_MAINTENANCE')
    await dst.restart(standby)
    assert.deepEqual(check(await apply('release')), { ...complete, phase: 'published' })
    await dst.restart(standby)

    assert.equal(check(await dst.api('/api/v1/snapshot/ignore', { key: d[0].key })), '*.log\n')
    check(await redeem(dst, d[1], stale), 401, 'invalid_transfer_ticket')
    check(await ticket(dst, s[1], 'download', requestPiece), 401)
    for (const foreign of [d[0], d[2], d[3], d[4]]) {
      check(await ticket(dst, foreign, 'download', requestPiece), 404, expiryCode)
      for (const p of ['responses', 'messages']) check(await native(dst, foreign, p, id), 404, 'attachment_unavailable')
    }
    const fresh = check(await ticket(dst, d[1], 'download', requestPiece), 201), download = await redeem(dst, d[1], fresh)
    check(download)
    assert.deepEqual(download.bytes, payload)
    assert.equal(download.headers['content-length'], String(payload.length))
    assert.match(download.headers['content-disposition'], /buoy\.txt$/)
    for (const p of ['responses', 'messages']) await assertNative(dst, d[1], p)
    assert.deepEqual(check(await dst.api('/api/v1/sessions', { key: d[1].key })), [])
    const last = check(await ticket(dst, d[1], 'download', requestPiece), 201)
    assert.ok(Date.now() < expires && Date.parse(last.expires_at) > expires, 'the fresh transfer ticket must outlive the original attachment')
    await delay(Math.max(0, expires - Date.now()) + 250)
    check(await redeem(dst, d[1], last), 404, expiryCode)
    check(await ticket(dst, d[1], 'download', requestPiece), 404, expiryCode)
    for (const p of ['responses', 'messages']) check(await native(dst, d[1], p, id), 404, 'attachment_unavailable')
    t.diagnostic(`Worker bundle SHA-256 ${sha(bundle.contents)}; archive SHA-256 ${sha(pack.bytes)}; document SHA-256 ${expectedDigest}; exact original TTL ${ttl}s; 2 fixed accounts, 1 attachment, 2 restore receipts`)
  })
