// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { backupHarness } from './backup-harness.mjs'
import { principal } from '../control/harness.mjs'
import { recordBundle } from './receipt.mjs'

const account = 'ovpack-fixture-tenant'
const other = 'ovpack-fixture-other'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const url = (path, uri) => `${path}?${new URLSearchParams({ uri })}`
const post = body => ({ method: 'POST', body })
const overwrite = { on_conflict: 'overwrite' }
const oraclePath = fileURLToPath(new URL('./backup-oracle.py', import.meta.url))

function oracle(bytes, mode) {
  const run = spawnSync('/usr/bin/python3', ['-I', oraclePath, mode], { input: bytes, timeout: 4000, maxBuffer: 2_000_000 })
  assert.equal(run.status, 0, run.stderr.toString().slice(-1024))
  return run.stdout
}

function status(reply, expected, code) {
  assert.equal(reply.status, expected, `status / code: ${reply.status} / ${reply.json?.error?.code ?? '(none)'}`)
  if (code) assert.equal(reply.json.error.code, code)
  if (expected >= 400 && reply.json) assert.equal(Object.hasOwn(reply.json, 'result'), false)
  return reply.json?.result
}

test('private operator OVPack v3: complete portable tenant mounts, guarded evaluation and durable readback', async t => {
  const admin = principal(account, 'admin', 'admin')
  const ada = principal(account, 'ada')
  const ben = principal(account, 'ben')
  const foreign = principal(other, 'admin', 'admin')
  const foreignAda = principal(other, 'ada')
  const fixed = [admin, ada, ben, foreign, foreignAda]
  const scope_id = randomBytes(16).toString('hex')
  const backup = {
    policy: [{ account_id: account, scope_id }, { account_id: other, scope_id: randomBytes(16).toString('hex') }],
    key: randomBytes(32).toString('hex'),
    adapter: await readFile(new URL('./backup-adapter.mjs', import.meta.url), 'utf8'),
  }
  const open = () => backupHarness(t, fixed, backup)
  const source = await open()
  await recordBundle(t, source.dir)
  const shared = 'viking://resources/notes/étoile.md', secret = 'viking://resources/restricted.txt'
  const left = 'viking://user/ada/memories/note.md', sidecar = 'viking://user/ada/memories/.overview.md'
  const right = 'viking://user/ben/resources/draft.md'
  const empty = 'viking://user/ben/resources/empty'
  const onlyInTarget = 'viking://resources/target-only.txt'
  const files = [[admin, shared, '\uFEFF# Boréal ⛄\r\nligne\r\n'], [admin, secret, 'Restricted synthetic text'],
    [ada, left, 'Ada private\r\n'], [ada, sidecar, 'Authored sidecar\n'], [ben, right, 'Ben private 🐿\n']]
  const read = (h, actor, uri) => h.send(url('/api/v1/content/read', uri), { key: actor.key })
  const write = async (h, actor, uri, content, mode = 'create') => status(await h.send('/api/v1/content/write', {
    key: actor.key, ...post({ uri, content, mode, defer_processing: true }),
  }), 200)
  const mkdir = async (h, actor, uri, description) => status(await h.send('/api/v1/fs/mkdir', {
    key: actor.key, ...post({ uri, description }),
  }), 200)
  const setAcl = async (h, entries) => status(await h.send('/api/v1/acl', {
    key: admin.key, method: 'PUT', body: { uri: secret, acl_mode: 'restricted', entries },
  }), 200)
  const capture = (h, account, options) => h.operator('/capture', post({ account, options }))
  for (const args of files) await write(source, ...args)
  await mkdir(source, ben, empty, 'Portable directory description')
  await setAcl(source, [])
  await write(source, foreign, shared, 'Other tenant shared')
  await write(source, foreignAda, left, 'Other tenant private, same user and URI')
  status(await read(source, admin, left), 403)
  status(await read(source, ben, left), 403)
  status(await read(source, ada, secret), 403)
  for (const action of ['backup', 'restore']) {
    const path = `/api/v1/pack/${action}`
    status(await source.send(path, { key: source.root, ...post({ account }) }), 403)
    status(await source.send(path, { key: admin.key, ...post({ account }) }), 501)
    status(await source.send(path, { key: ben.key, ...post({ account }) }), 403)
    status(await source.send(path, post({ account })), 401)
  }
  status(await source.send('/capture', { key: source.root, ...post({ account }) }), 404)
  status(await capture(source, 'not-opted-in'), 403)
  status(await capture(source, account, { include_vectors: true }), 501)
  const captured = await capture(source, account)
  status(captured, 200)
  assert.equal(captured.headers['content-type'], 'application/zip')
  assert.equal(captured.headers['cache-control'], 'private, no-store')
  const original = JSON.parse(oracle(captured.bytes, 'verify'))
  assert.equal(captured.headers['x-ovpack-sha256'], original.sha256)
  assert.deepEqual(original.files, Object.fromEntries(files.map(([, uri, content]) => [uri, sha(content)])))
  assert.ok(original.directories.includes(empty))
  assert.ok(original.records.some(record => record.path === empty.slice(9) && record.scalars.description === 'Portable directory description'))
  t.diagnostic(`OVPack SHA-256 ${original.sha256}, ${Object.keys(original.files).length} files`)
  const seal = captured.headers['x-ovpack-seal']
  const request = (h, action, { zip = captured.bytes, authority = seal, target = account, options = overwrite, approval } = {}) =>
    h.operator(`/${action}`, post({ account: target, archive: zip.toString('base64'), seal: authority, options, approval }))

  // The other target is also opted in and has overlapping URI/owner names.
  status(await request(source, 'evaluate', { target: other }), 403, 'BACKUP_SEAL_INVALID')
  const second = JSON.parse(oracle((await capture(source, other)).bytes, 'verify'))
  assert.deepEqual(second.files, { [shared]: sha('Other tenant shared'), [left]: sha('Other tenant private, same user and URI') })
  status(await request(source, 'evaluate', { options: {} }), 409, 'CONFLICT')
  const skip = status(await request(source, 'evaluate', { options: { on_conflict: 'skip' } }), 200)
  assert.equal(skip.outcome, 'skipped')
  const same = status(await request(source, 'evaluate'), 200)
  assert.equal(same.counts.create, 0)
  assert.equal(same.counts.update, 0)
  await write(source, admin, shared, 'new shared text', 'replace')
  status(await request(source, 'apply', { approval: same.approval }), 409, 'BACKUP_PLAN_STALE')
  assert.equal(status(await read(source, admin, shared), 200), 'new shared text')
  await write(source, admin, secret, 'new restricted text', 'replace')
  await setAcl(source, [{ principal: 'user:ada', level: 'read' }])
  status(await request(source, 'evaluate'), 409, 'BACKUP_ACL_CONFLICT')
  assert.equal(status(await read(source, admin, shared), 200), 'new shared text')
  await setAcl(source, [])
  const updated = status(await request(source, 'evaluate'), 200)
  assert.equal(updated.counts.update, 2)
  status(await request(source, 'apply', { approval: updated.approval }), 200)
  assert.equal(status(await read(source, admin, secret), 200), files[1][2])
  status(await read(source, ada, secret), 403)

  // Fresh Workerd, new SQLite directory, same approved backup realm; Control only is provisioned first.
  await source.close()
  const target = await open()
  assert.notEqual(source.dir, target.dir)
  for (const actor of fixed) status(await target.send('/health', { key: actor.key }), 200)
  const cold = status(await request(target, 'evaluate'), 200)
  assert.equal(cold.dry_run, true)
  assert.equal(cold.counts.files_written, 5)
  status(await request(target, 'apply'), 400)
  status(await read(target, ada, left), 404)
  await write(target, foreign, shared, 'Foreign target sentinel')
  await write(target, foreignAda, left, 'Foreign target private sentinel')
  await write(target, admin, onlyInTarget, 'Target-only sentinel')
  await mkdir(target, ben, right, 'Same URI with incompatible type')
  status(await request(target, 'evaluate'), 409, 'BACKUP_TYPE_CONFLICT')
  status(await read(target, admin, shared), 404)
  status(await target.send(url('/api/v1/fs', right), { method: 'DELETE', key: ben.key }), 200)

  // Pre-authorized malformed format fixtures (the independent Node signer has only the ephemeral test key).
  // SQL must see none of these; the negative cases exercise structural checks after provenance admission.
  const [visibility] = seal.split('.')
  const syntheticSeal = bytes => visibility + '.' + createHmac('sha256', Buffer.from(backup.key, 'hex'))
    .update(JSON.stringify(['openviking:backup:v1', 'archive', account, scope_id, sha(bytes), visibility])).digest('hex')
  const repacked = oracle(captured.bytes, 'deflate')
  status(await request(target, 'evaluate', { zip: repacked }), 403, 'BACKUP_SEAL_INVALID')
  for (const [variant, expected] of [['field', 400], ['duplicate', 400], ['mount', 501], ['owner', 400], ['checksum', 400], ['sessions', 501]]) {
    const zip = oracle(captured.bytes, variant)
    status(await request(target, 'evaluate', { zip, authority: syntheticSeal(zip) }), expected)
    status(await read(target, ada, left), 404)
    status(await read(target, admin, shared), 404)
  }
  // Cross-check that valid DEFLATE from stdlib remains readable and the plan binds byte-for-byte.
  status(await request(target, 'evaluate', { zip: repacked, authority: syntheticSeal(repacked) }), 200)
  const evaluated = status(await request(target, 'evaluate'), 200)
  assert.equal(evaluated.dry_run, true)
  assert.equal(evaluated.counts.files_written, 5)
  assert.deepEqual(evaluated.scopes, ['resources', 'user'])
  assert.equal(evaluated.index_status, 'deferred')
  status(await read(target, admin, shared), 404)
  status(await read(target, ben, right), 404)
  const applied = status(await request(target, 'apply', { approval: evaluated.approval }), 200)
  assert.equal(applied.outcome, 'applied')
  assert.equal(applied.uri, 'viking://')
  assert.equal(applied.counts.files_written, 5)
  assert.ok((await readdir(`${target.dir}/state`)).length > 0)

  // Read from the normal Data API, after an actual Workerd process restart on that SQLite.
  await target.restart()
  for (const [actor, uri, content] of files) {
    assert.equal(sha(status(await read(target, actor, uri), 200)), original.files[uri])
    assert.equal(status(await read(target, actor, uri), 200), content)
  }
  assert.equal(status(await target.send(url('/api/v1/fs/stat', empty), { key: ben.key }), 200).description,
    'Portable directory description')
  status(await read(target, ben, left), 403)
  status(await read(target, admin, right), 403)
  status(await read(target, ada, secret), 403)
  status(await read(target, ada, shared), 403) // Missing shared paths restore quarantined, not as wildcard reads.
  assert.equal(status(await read(target, admin, onlyInTarget), 200), 'Target-only sentinel')
  assert.equal(status(await read(target, foreign, shared), 200), 'Foreign target sentinel')
  assert.equal(status(await read(target, foreignAda, left), 200), 'Foreign target private sentinel')
  status(await request(target, 'apply', { approval: evaluated.approval }), 409, 'BACKUP_PLAN_STALE')

  // An upstream-included managed user domain must be diagnosed, not silently left out of a success.
  status(await target.send('/api/v1/sessions', { key: ben.key, ...post({}) }), 200)
  status(await capture(target, account), 501, 'BACKUP_TOPOLOGY_UNSUPPORTED')
  status(await request(target, 'evaluate'), 501, 'BACKUP_TOPOLOGY_UNSUPPORTED')
  await target.restart(fixed, { ...backup, policy: [] })
  status(await capture(target, account), 403)
  status(await request(target, 'apply', { approval: evaluated.approval }), 403)
  assert.equal(status(await read(target, ada, left), 200), files[2][2])
})
