// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { principal } from '../control/harness.mjs'
import { instanceHarness } from './instance-backup-harness.mjs'
import { recordBundle } from './receipt.mjs'

const A = 'pieces-alpha', B = 'pieces-beta'
const actors = () => [principal(A, 'admin', 'admin'), principal(A, 'alice', 'user', 'camera'), principal(A, 'alice'),
  principal(B, 'admin', 'admin'), principal(B, 'alice', 'user', 'camera')]
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XyZkAAAAASUVORK5CYII=', 'base64')
const sha = data => createHash('sha256').update(data).digest('hex')
const oracle = fileURLToPath(new URL('./instance-attachment-oracle.py', import.meta.url))
const ticketPath = '/gateway/transfers/tickets'
const issue = (h, actor, action, body) => h.send(ticketPath, { key: actor.key, body: { action, kind: 'attachment', ticket_transport: 'header', ...body } })
const redeem = (h, actor, ticket, body) => h.send(ticket.url, { key: actor.key, method: ticket.method, body, headers: { [ticket.ticket_header]: ticket.ticket } })

function wave(size) {
  const data = Buffer.alloc(size, 130)
  data.write('RIFF', 0); data.writeUInt32LE(size - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(8000, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34)
  data.write('data', 36); data.writeUInt32LE(size - 44, 40)
  return data
}

function check(reply, status = 200, code) {
  assert.equal(reply.status, status, `expected ${status}; got ${reply.status} (${reply.json?.error?.code ?? reply.json?.reason ?? '-'})`)
  if (code) assert.equal(reply.json?.error?.code ?? reply.json?.reason, code)
  if (status >= 400) assert.equal(Object.hasOwn(reply.json ?? {}, 'result'), false)
  return reply.json?.result
}

async function upload(h, actor, filename, retention_seconds = 90, bytes = png, content_type = 'image/png') {
  const ticket = check(await issue(h, actor, 'upload', { filename, retention_seconds, size: bytes.length, content_type }), 201)
  const form = new FormData()
  form.set('file', new Blob([bytes], { type: content_type }), filename)
  return check(await redeem(h, actor, ticket, form))
}

function python(args, input) {
  const r = spawnSync('/usr/bin/python3', ['-I', oracle, ...args], { input, timeout: 5000, maxBuffer: 6 * 1024 * 1024 })
  assert.equal(r.status, 0, r.stderr.toString().slice(-800))
  return r.stdout
}
async function disk(h) {
  await h.close()
  return JSON.parse(python(['state', h.dir]))
}

async function fixture(t, rollbackFixture = false) {
  const key = randomBytes(32).toString('hex'), actorsSrc = actors(), actorsDst = actors()
  const policy = [A, B].map(account_id => ({ account_id, scope_id: randomBytes(16).toString('hex') }))
  const opts = { key, policy, attachments: true }
  const src = await instanceHarness(t, actorsSrc, opts), dst = await instanceHarness(t, actorsDst, { ...opts, rollbackFixture })
  const source = { mode: 'source', instance_id: randomBytes(16).toString('hex'), peer_control: check(await dst.operator('identify')).control }
  const standby = { mode: 'standby', instance_id: randomBytes(16).toString('hex'), peer_control: check(await src.operator('identify')).control }
  source.peer_id = standby.instance_id; standby.peer_id = source.instance_id
  for (const h of [src, dst]) check(await h.send('/api/v1/admin/accounts', { key: h.root }))
  const send = (command, bytes, fields = {}) => dst.operator(command, { archive: bytes.toString('base64'), ...fields })
  const archiveInput = (op, archive) => python([op], Buffer.concat([Buffer.from(JSON.stringify({ key, account: B,
    scopes: Object.fromEntries(policy.map(p => [p.account_id, p.scope_id])) }) + '\n'), archive]))
  return { src, dst, s: actorsSrc, d: actorsDst, policy, source, standby, send, archiveInput }
}

test('instance v2 restores exact scoped bytes with fresh tickets after lost ACK and restart, then purges at the original TTL', { timeout: 32000 }, async t => {
  const { src, dst, s, d, source, standby, send, archiveInput } = await fixture(t)
  await recordBundle(t, src.dir)
  const uri = 'viking://user/alice/memories/pieces.md'
  check(await src.send('/api/v1/content/write', { key: s[1].key, body: { uri, content: 'Application and media transaction.', mode: 'create', defer_processing: true } }))
  const a = await upload(src, s[1], 'alpha.png')
  const audio = wave(192 * 1024)
  const retained = await upload(src, s[4], 'retained.wav', 90, audio, 'audio/wav')
  const issued = check(await issue(src, s[1], 'upload', { filename: 'not-completed.png', content_type: 'image/png', size: png.length }), 201)
  const stale = check(await issue(src, s[1], 'download', { attachment_id: a.attachment_id }), 201)
  const staging = new FormData()
  staging.set('file', new Blob(['staging-synthetic-sentinel'], { type: 'text/plain' }), 'stage.txt')
  const { temp_file_id } = check(await src.send('/api/v1/resources/temp_upload', { key: s[1].key, body: staging }))
  assert.ok(temp_file_id)
  const b = await upload(src, s[4], 'quick.png', 10)
  const before = await disk(src)
  assert.ok(before.tickets > 0 && before.staging === 1)
  assert.equal(Object.keys(before.rows).length, 3)
  await src.restart({ mode: source, actors: s.filter(actor => actor !== s[1]) })
  check(await src.operator('capture-pieces'), 409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE')
  await src.restart({ mode: source })
  check(await src.operator('capture'), 409, 'INSTANCE_BACKUP_ATTACHMENTS_UNSUPPORTED')
  const pack = await src.operator('capture-pieces')
  check(pack)
  await src.close()
  const archive = pack.bytes, wire = JSON.parse(archiveInput('wire', archive))
  assert.deepEqual(wire[A].map(r => r.id), [a.attachment_id])
  assert.deepEqual(wire[B].map(r => r.id).sort(), [retained.attachment_id, b.attachment_id].sort())
  for (const [account, rows] of Object.entries(wire)) for (const r of rows) {
    assert.deepEqual([account, r.user_id, r.agent_id, r.filename, r.content_type, r.expires_at, r.sha256],
      before.rows[r.id].filter((_, i) => i !== 6))
  }
  for (const forbidden of [stale.ticket, issued.ticket, issued.attachment_id, temp_file_id, 'staging-synthetic-sentinel',
    ...Object.values(before.rows).map(row => row[6])]) assert.equal(archive.includes(Buffer.from(forbidden)), false)

  await dst.restart({ mode: standby })
  for (const [action, status, code] of [['wrong-seat', 409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE'], ['wrong-hash', 400, 'INVALID_ARGUMENT'],
    ['missing-piece', 400, 'INVALID_ARGUMENT']]) check(await send('evaluate', archiveInput(action, archive)), status, code)
  const plan = check(await send('evaluate', archive))
  assert.equal(plan.attachment_count, 3)
  assert.deepEqual(await disk(dst), { rows: {}, receipts: [], tickets: 0, staging: 0, job_tables: 0 })
  await dst.restart({ mode: standby })
  check(await send('begin', archive, { approval: plan.approval }), 202)
  await dst.close()
  dst.inspect('pause-ack')
  await dst.restart({ mode: standby })
  check(await send('step', archive, { index: 0 }), 500, 'INTERNAL_ERROR')
  assert.equal(check(await dst.operator('status'), 202).completed, 0)
  check(await issue(dst, d[1], 'download', { attachment_id: a.attachment_id }), 503, 'INSTANCE_MAINTENANCE')
  const partial = await disk(dst)
  assert.deepEqual(Object.keys(partial.rows), [a.attachment_id])
  const [[account, receipt]] = partial.receipts
  assert.equal(account, A)
  assert.notEqual(partial.rows[a.attachment_id][6], before.rows[a.attachment_id][6])
  assert.equal(partial.job_tables, 0)
  dst.inspect('resume-ack')
  assert.equal(dst.inspect('inspect').commits[0][2], 1)
  await dst.restart({ mode: standby })
  const first = check(await send('step', archive, { index: 0 }), 202)
  assert.deepEqual(first.receipts, [receipt])
  assert.deepEqual(check(await send('step', archive, { index: 0 }), 202), first)
  const both = check(await send('step', archive, { index: 1 }), 202)
  assert.equal(both.phase, 'awaiting_release')
  const installed = await disk(dst)
  assert.deepEqual(installed.rows[a.attachment_id], partial.rows[a.attachment_id])
  assert.equal(installed.receipts.length, 2)
  assert.equal(installed.tickets + installed.staging + installed.job_tables, 0)
  for (const [id, row] of Object.entries(installed.rows)) {
    assert.notEqual(row[6], before.rows[id][6])
    const omitRevision = r => r.filter((_, i) => i !== 6)
    assert.deepEqual(omitRevision(row), omitRevision(before.rows[id]))
  }
  await dst.restart({ mode: standby })
  assert.equal(check(await send('release', archive)).phase, 'published')
  await dst.restart({ mode: standby })
  check(await redeem(dst, d[1], stale), 401, 'invalid_transfer_ticket')
  for (const actor of [d[0], d[2], d[4]]) check(await issue(dst, actor, 'download', { attachment_id: a.attachment_id }), 404, 'attachment_not_found')
  assert.equal(check(await dst.send(`/api/v1/content/read?${new URLSearchParams({ uri })}`, { key: d[1].key })), 'Application and media transaction.')
  for (const [item, actor, bytes] of [[a, d[1], png], [b, d[4], png], [retained, d[4], audio]]) {
    const fresh = check(await issue(dst, actor, 'download', { attachment_id: item.attachment_id }), 201)
    const reply = await redeem(dst, actor, fresh)
    check(reply)
    assert.deepEqual(reply.bytes, bytes)
  }
  const old = check(await issue(dst, d[1], 'download', { attachment_id: a.attachment_id }), 201)
  check(await redeem(dst, d[1], check(await issue(dst, d[1], 'delete', { attachment_id: a.attachment_id }), 201)))
  check(await redeem(dst, d[1], old), 404, 'attachment_not_found')

  // Stop and restart once more before expiry; no requests advance the purge.
  await dst.restart({ mode: standby })
  await delay(Math.max(0, Date.parse(b.expires_at) - Date.now()) + 900)
  const purged = await disk(dst)
  assert.deepEqual(Object.keys(purged.rows), [retained.attachment_id])
  assert.deepEqual(purged.rows[retained.attachment_id], installed.rows[retained.attachment_id])
  t.diagnostic(`synthetic receipt: job=${plan.job} ids=${[a, b, retained].map(r => r.attachment_id).join(',')} restored=3 downloaded=3 purged=1 deleted=1 receipts=2`)
})

test('standby alarm purges expired bytes without running jobs; an expired package never releases a prefix', { timeout: 22000 }, async t => {
  const { src, dst, s, d, source, standby, send } = await fixture(t)
  const later = await upload(src, s[1], 'later.png')
  const other = await upload(src, s[4], 'other.png')
  const first = await upload(src, s[1], 'expires-closed.png', 6)
  await src.restart({ mode: source })
  const archive = await src.operator('capture-pieces')
  check(archive)
  await src.close()
  await dst.restart({ mode: standby })
  const plan = check(await send('evaluate', archive.bytes))
  check(await send('begin', archive.bytes, { approval: plan.approval }), 202)
  check(await send('step', archive.bytes, { index: 0 }), 202)
  await dst.restart({ mode: standby })
  await delay(Math.max(0, Date.parse(first.expires_at) - Date.now()) + 900)
  check(await send('step', archive.bytes, { index: 1 }), 409, 'INSTANCE_BACKUP_ATTACHMENT_EXPIRED')
  check(await send('release', archive.bytes), 409, 'INSTANCE_BACKUP_ATTACHMENT_EXPIRED')
  assert.equal(check(await dst.operator('status'), 202).phase, 'expired')
  check(await issue(dst, d[1], 'download', { attachment_id: later.attachment_id }), 503, 'INSTANCE_MAINTENANCE')
  const closed = await disk(dst)
  assert.deepEqual(Object.keys(closed.rows), [later.attachment_id])
  assert.equal(other.attachment_id in closed.rows, false)
  assert.equal(closed.receipts.length, 1)
  assert.equal(closed.tickets + closed.staging + closed.job_tables, 0)
  t.diagnostic(`synthetic standby: job=${plan.job} expired=${first.attachment_id} preserved=${later.attachment_id} unpublished=${other.attachment_id} purged=1 receipts=1 jobs=0 released=0`)
})

test('a late Workspace transaction failure rolls back the file, attachment and durable receipt together', { timeout: 17000 }, async t => {
  const { src, dst, s, source, standby, send } = await fixture(t, true)
  const uri = 'viking://user/alice/memories/rollback.md'
  const media = await upload(src, s[1], 'rollback.png')
  check(await src.send('/api/v1/content/write', { key: s[1].key, body: { uri, content: 'Rollback together.', mode: 'create', defer_processing: true } }))
  await src.restart({ mode: source })
  const pack = await src.operator('capture-pieces')
  check(pack)
  await src.close()
  await dst.restart({ mode: standby, abortCommit: true })
  const plan = check(await send('evaluate', pack.bytes))
  check(await send('begin', pack.bytes, { approval: plan.approval }), 202)
  check(await send('step', pack.bytes, { index: 0 }), 500, 'INTERNAL_ERROR')
  assert.equal(check(await dst.operator('status'), 202).completed, 0)
  assert.deepEqual(await disk(dst), { rows: {}, receipts: [], tickets: 0, staging: 0, job_tables: 0 })
  assert.equal(dst.inspect('inspect').workspaces, 0)
  await dst.restart({ mode: standby })
  check(await send('step', pack.bytes, { index: 0 }), 202)
  const applied = await disk(dst)
  assert.deepEqual(Object.keys(applied.rows), [media.attachment_id])
  assert.equal(applied.receipts.length, 1)
  assert.equal(dst.inspect('inspect').commits[0][2], 1)
  t.diagnostic(`synthetic rollback: job=${plan.job} id=${media.attachment_id} rolled_back=3 local_commits_after_replay=1 releases=0`)
})
