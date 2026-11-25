// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { principal } from '../control/harness.mjs'
import { instanceHarness } from './instance-backup-harness.mjs'
import { recordBundle } from './receipt.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const oraclePath = fileURLToPath(new URL('./instance-oracle.py', import.meta.url))
const A = 'fixture-alpha', B = 'fixture-beta'
const roster = () => [principal(A, 'admin', 'admin'), principal(A, 'ada'), principal(A, 'ben'),
  principal(B, 'admin', 'admin'), principal(B, 'ada')]
const random = n => randomBytes(n).toString('hex')
const options = () => ({ key: random(32), policy: [A, B].map(account_id => ({ account_id, scope_id: random(16) })) })
const get = (h, key, path) => h.send(path, { key })
const change = (h, key, path, body, method = 'POST') => h.send(path, { method, key, body })
const shared = 'viking://resources/same.txt', privateA = 'viking://user/ada/memories/note.md', privateB = 'viking://user/ben/resources/draft.txt'
const read = (h, key, uri) => get(h, key, `/api/v1/content/read?${new URLSearchParams({ uri })}`)
const write = (h, actor, uri, content) => change(h, actor.key, '/api/v1/content/write', { uri, content, mode: 'create', defer_processing: true })
const provision = async h => check(await get(h, h.root, '/api/v1/admin/accounts'))

function check(reply, status = 200, code) {
  assert.equal(reply.status, status, `expected ${status}; got ${reply.status} (${reply.json?.error?.code ?? 'no code'}: ${reply.json?.error?.message ?? ''})`)
  if (code) assert.equal(reply.json?.error?.code, code)
  if (status >= 400 && reply.json) assert.equal(Object.hasOwn(reply.json, 'result'), false)
  return reply.json?.result
}

function inspectArchive(mode, key, archive) {
  const result = spawnSync('/usr/bin/python3', ['-I', oraclePath, mode], {
    input: Buffer.concat([Buffer.from(key, 'hex'), archive]), timeout: 4000, maxBuffer: 2_000_000,
  })
  assert.equal(result.status, 0, result.stderr.toString().slice(-1000))
  return mode === 'archive' ? JSON.parse(result.stdout) : result.stdout
}

async function pair(src, dst) {
  const source = check(await src.operator('identify')).control, dest = check(await dst.operator('identify')).control
  const id = random(16), peer = random(16)
  return [{ mode: 'source', instance_id: id, peer_id: peer, peer_control: dest },
    { mode: 'standby', instance_id: peer, peer_id: id, peer_control: source }]
}

test('instance backup globally evaluates two fixed accounts, recovers a lost ACK and releases only after reboot and receipt verification', { timeout: 45000 }, async t => {
  const srcActors = roster(), dstActors = roster(), policy = options()
  const src = await instanceHarness(t, srcActors, { ...policy, ai: true }), dst = await instanceHarness(t, dstActors, policy)
  await recordBundle(t, src.dir)
  const [source, standby] = await pair(src, dst)
  await provision(src)
  await provision(dst)
  check(await src.operator('capture'), 403, 'INSTANCE_BACKUP_AUTHORITY')
  check(await change(src, src.root, '/capture', {}), 404)
  const seeded = [[0, shared, 'Alpha private-to-admin\r\n'], [1, privateA, 'Ada 🇨🇦\r\n'], [2, privateB, 'Ben\n'],
    [3, shared, 'Beta, same URI\r\n'], [4, privateA, 'Ada on Beta only\n']]
  for (const [i, uri, body] of seeded) check(await write(src, srcActors[i], uri, body))
  check(await change(src, srcActors[0].key, '/api/v1/acl', { uri: shared, entries: [], acl_mode: 'restricted' }, 'PUT'))
  const session = '/api/v1/sessions/round-trip', ada = srcActors[1].key
  check(await change(src, ada, '/api/v1/sessions', { session_id: 'round-trip', memory_policy: { self: { enabled: false } },
    memory_extraction_config: { events: { tags: ['fixture=portable'] } } }))
  check(await change(src, ada, `${session}/messages`, { role: 'user', content: 'History É\n' }))
  check(await change(src, ada, `${session}/commit?wait=true`, { reset_context: true }))
  check(await change(src, ada, `${session}/messages`, { role: 'assistant', content: 'Live suffix.' }))
  const expectedHistory = check(await get(src, ada, `${session}/archives/archive_001`))
  const expectedReset = check(await get(src, ada, `${session}/archives/archive_002`))
  const expectedContext = check(await get(src, ada, `${session}/context`))
  const target_uri = 'viking://user/ben/skills'
  check(await change(src, srcActors[2].key, '/api/v1/skills', { target_uri,
    data: { name: 'notebook', description: 'Local fixture', content: 'Portable notes.\n', files: { 'ref.txt': 'É\r\n' } } }))
  const settingPath = '/api/v1/user-settings/add-locations', settings = { resource_uri: 'viking://user/ben/resources', skill_uri: target_uri }
  check(await change(src, srcActors[2].key, settingPath, settings, 'PATCH'))
  const setup = '/api/v1/admin/configuration', tenantConfig = `/api/v1/admin/accounts/${B}/configuration`
  check(await change(src, src.root, setup, { settings: { output_language_override: 'fr-CA' } }, 'PATCH'))
  check(await change(src, srcActors[3].key, tenantConfig, { settings: { output_language_override: 'en-CA' } }, 'PATCH'))

  await src.restart({ mode: source, policy: policy.policy.slice(0, 1) })
  check(await src.operator('capture'), 409, 'INSTANCE_BACKUP_INVENTORY')
  await src.restart({ mode: source })
  check(await get(src, src.root, '/ready'), 503, 'INSTANCE_MAINTENANCE')
  check(await write(src, srcActors[0], 'viking://resources/not-admitted.txt', 'Not admitted'), 503)
  check(await src.operator('account-capture', { account: A }), 503, 'INSTANCE_MAINTENANCE')
  const pack = await src.operator('capture')
  check(pack)
  assert.match(pack.headers['content-disposition'], /openviking-instance-backup\.zip/)
  assert.equal(pack.headers['cache-control'], 'private, no-store')
  const outline = inspectArchive('archive', policy.key, pack.bytes)
  assert.equal(outline.source.id, source.instance_id)
  assert.equal(outline.destination.id, standby.instance_id)
  assert.deepEqual(outline.members, { [A]: { files: Object.fromEntries(seeded.slice(0, 3).map(([, uri, body]) => [uri.slice(9), sha(body)])), sessions: 1, skills: 1 },
    [B]: { files: Object.fromEntries(seeded.slice(3).map(([, uri, body]) => [uri.slice(9), sha(body)])), sessions: 0, skills: 0 } })
  assert.deepEqual(outline.settings.cluster, { output_language_override: 'fr-CA' })
  for (const key of [policy.key, src.root, dst.root, ...[...srcActors, ...dstActors].map(a => a.key)]) {
    assert.equal(pack.bytes.includes(Buffer.from(key)), false)
    assert.equal(pack.bytes.includes(Buffer.from(sha(key))), false)
  }
  t.diagnostic(`Synthetic ZIP ${sha(pack.bytes)}, two scoped members, five files, one session and one skill`)
  await src.close()

  const call = (action, body = {}, bytes = pack.bytes) => dst.operator(action, { archive: bytes.toString('base64'), ...body })
  await dst.restart({ mode: { ...standby, peer_control: outline.destination.control } })
  check(await call('evaluate'), 403, 'INSTANCE_BACKUP_AUTHORITY')
  await dst.restart({ mode: standby, actors: dstActors.map((a, i) => i === 4 ? { ...a, role: 'admin' } : a) })
  check(await call('evaluate'), 409, 'INSTANCE_BACKUP_INVENTORY')
  await dst.restart({ mode: standby })
  check(await read(dst, dstActors[1].key, privateA), 503, 'INSTANCE_MAINTENANCE')
  for (const variant of ['missing', 'swap', 'wrong-peer', 'config']) check(await call('evaluate', {}, inspectArchive(variant, policy.key, pack.bytes)), 409)
  const plan = check(await call('evaluate'))
  assert.equal(plan.dry_run, true)
  assert.equal(plan.accounts, 2)
  assert.equal(plan.job, outline.job)
  check(await call('step', { index: 0 }), 409, 'INSTANCE_BACKUP_STAGE')
  await dst.close()
  assert.deepEqual(dst.inspect('inspect'), { progress: null, commits: [], workspaces: 0 })
  await dst.restart({ mode: standby })

  const started = check(await call('begin', { approval: plan.approval }), 202)
  assert.deepEqual(started, { phase: 'staged', job: plan.job, total: 2, completed: 0, receipts: [] })
  check(await call('step', { index: 1 }), 409, 'INSTANCE_BACKUP_STAGE')
  check(await call('release'), 409, 'INSTANCE_BACKUP_STAGE')
  await dst.close()
  dst.inspect('pause-ack')
  await dst.restart({ mode: standby })
  check(await call('step', { index: 0 }), 500, 'INTERNAL_ERROR')
  assert.equal(check(await dst.operator('status'), 202).completed, 0)
  await dst.close()
  const prefix = dst.inspect('inspect')
  assert.deepEqual(prefix.progress, [[], 0])
  assert.equal(prefix.workspaces, 1)
  assert.deepEqual(prefix.commits.map(([account, , , sessions]) => [account, sessions]), [[A, 1]])
  const [, firstReceipt] = prefix.commits[0]
  dst.inspect('resume-ack')

  // Even removing the maintenance bindings on this code/storage cannot expose the acknowledged or unacknowledged prefix.
  await dst.restart({ key: null })
  check(await read(dst, dstActors[1].key, privateA), 503)
  check(await get(dst, dst.root, setup), 503, 'INSTANCE_MAINTENANCE')
  await dst.restart({ mode: standby })
  const recovered = check(await call('step', { index: 0 }), 202)
  assert.deepEqual(recovered.receipts, [firstReceipt])
  assert.deepEqual(check(await call('step', { index: 0 }), 202), recovered)
  const complete = check(await call('step', { index: 1 }), 202)
  assert.equal(complete.phase, 'awaiting_release')
  check(await get(dst, dst.root, '/ready'), 503, 'INSTANCE_MAINTENANCE')
  await dst.restart({ mode: standby })
  assert.deepEqual(check(await dst.operator('status'), 202), complete)
  const released = check(await call('release'))
  assert.deepEqual(released, { ...complete, phase: 'published' })
  await dst.restart({ mode: standby })
  assert.deepEqual(check(await call('release')), released)
  assert.deepEqual(check(await dst.operator('status')), released)
  check(await get(dst, undefined, '/ready'))
  for (const [i, uri, body] of seeded) assert.equal(check(await read(dst, dstActors[i].key, uri)), body)
  check(await read(dst, dstActors[1].key, shared), 403)
  check(await read(dst, dstActors[4].key, shared), 403)
  check(await read(dst, dstActors[0].key, privateA), 403)
  check(await read(dst, dstActors[1].key, privateB), 403)
  check(await read(dst, dst.root, privateA), 403)
  check(await read(dst, srcActors[1].key, privateA), 401)
  check(await change(dst, dstActors[0].key, '/api/v1/pack/backup', {}), 501)
  check(await change(dst, dst.root, '/api/v1/pack/restore', {}), 403)
  check(await change(dst, dst.root, '/capture', {}), 404)
  assert.deepEqual(check(await get(dst, dstActors[1].key, `${session}/archives/archive_001`)), expectedHistory)
  assert.deepEqual(check(await get(dst, dstActors[1].key, `${session}/archives/archive_002`)), expectedReset)
  assert.deepEqual(check(await get(dst, dstActors[1].key, `${session}/context`)), expectedContext)
  check(await get(dst, dstActors[4].key, session), 404)
  assert.equal(check(await read(dst, dstActors[2].key, `${target_uri}/notebook/ref.txt`)), 'É\r\n')
  assert.deepEqual(check(await get(dst, dstActors[2].key, settingPath)).effective, settings)
  assert.equal(check(await get(dst, dst.root, setup)).settings.output_language_override, 'fr-CA')
  assert.equal(check(await get(dst, dstActors[3].key, tenantConfig)).settings.output_language_override, 'en-CA')
})

test('instance backup rejects nonempty standby and discloses no partial archive for attachments', { timeout: 30000 }, async t => {
  const srcActors = roster(), dstActors = roster(), policy = options()
  const src = await instanceHarness(t, srcActors, policy), dst = await instanceHarness(t, dstActors, policy)
  const [source, standby] = await pair(src, dst)
  await provision(src)
  await provision(dst)
  check(await write(src, srcActors[3], shared, 'Beta source fixture'))
  check(await write(dst, dstActors[3], shared, 'Keep the existing standby sentinel'))
  await src.restart({ mode: source })
  const pack = await src.operator('capture')
  check(pack)
  await dst.restart({ mode: standby })
  check(await dst.operator('evaluate', { archive: pack.bytes.toString('base64') }), 409, 'INSTANCE_BACKUP_NOT_COLD')
  await dst.close()
  assert.deepEqual(dst.inspect('inspect'), { progress: null, commits: [], workspaces: 1 })
  await dst.restart()
  assert.equal(check(await read(dst, dstActors[3].key, shared)), 'Keep the existing standby sentinel')
  await src.close()
  src.inspect('seed-attachment', B)
  await src.restart({ mode: source })
  const refused = await src.operator('capture')
  check(refused, 409, 'INSTANCE_BACKUP_ATTACHMENTS_UNSUPPORTED')
  assert.doesNotMatch(refused.bytes.toString(), /Beta source fixture|accounts\//)
})
