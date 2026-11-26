// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principal } from '../control/harness.mjs'
import { portableBundle, portableHarness, random, sha } from './instance-portable-harness.mjs'

const version = 'edge-v1-portable-state', A = 'fixture-alpha', B = 'fixture-beta'
const roster = () => [principal(A, 'admin', 'admin'), principal(A, 'ada'), principal(A, 'ben'), principal(B, 'admin', 'admin'), principal(B, 'ada')]
const policy = () => [A, B].map(account_id => ({ account_id, scope_id: random(16) }))
const result = (response, status = 200, code) => {
  assert.equal(response.status, status, JSON.stringify(response.json?.error))
  if (code) assert.equal(response.json?.error?.code, code)
  if (status >= 400) assert.equal(Object.hasOwn(response.json ?? {}, 'result'), false)
  return response.json?.result
}
const actor = (h, key) => (path, body, method) => h.api('/api/v1/' + path, { key, body, method })
const qs = (path, values) => path + '?' + new URLSearchParams(values)
const write = (send, uri, content, mode = 'create') => send('content/write', { uri, content, mode, defer_processing: true })
const commit = (send, path, message, branch = 'main') => send('snapshot/commit', { paths: [path], message, branch })
const read = (send, uri) => send(qs('content/read', { uri }))
const show = (send, uri, target_ref) => send(qs('snapshot/show', { path: uri, target_ref }))
const log = (send, uri) => send(qs('snapshot/log', { paths: uri }))
const config = 'compile/config?compile_name=Maritime'
const sourceDir = 'viking://user/ada/resources/guide', note = `${sourceDir}/chapter.md`, ignoreNote = `${sourceDir}/local.txt`
const shared = 'viking://resources/timeline.md', bystander = 'viking://resources/independent.md'
const define = { compile_name: 'Maritime', from: [sourceDir], to: 'viking://user/ada/resources/wiki',
  skill: 'viking://system/compile/example-skills/llm-wiki' }

test('instance v3 round-trip: real Data history, ignore and inert Compile, Control lost ACK/restart and shared quarantine', { timeout: 50000 }, async t => {
  const bundle = await portableBundle(), key = random(32), directory = policy(), s = roster(), d = roster()
  t.diagnostic(`Worker bundle SHA-256: ${sha(bundle)}`)
  const src = await portableHarness(t, bundle, s, key, directory), dst = await portableHarness(t, bundle, d, key, directory)
  const srcControl = result(await src.op('identify')).control, dstControl = result(await dst.op('identify')).control
  assert.notEqual(srcControl, dstControl)
  const one = random(16), two = random(16)
  const source = { mode: 'source', instance_id: one, peer_id: two, peer_control: dstControl }
  const standby = { mode: 'standby', instance_id: two, peer_id: one, peer_control: srcControl }
  for (const h of [src, dst]) result(await actor(h, h.root)('admin/accounts'))

  const [admin, ada, , beta] = s.map(a => actor(src, a.key)), [dAdmin, dAda, dBen, dBeta, dBetaAda] = d.map(a => actor(dst, a.key))
  result(await admin('snapshot/ignore', { content: '*.txt\n' }, 'PUT'))
  result(await ada('fs/mkdir', { uri: sourceDir }))
  result(await write(ada, note, 'Alpha première édition\r\n'))
  const first = result(await commit(ada, note, 'First')).commit_oid
  result(await write(ada, note, 'Alpha current\n', 'replace'))
  const second = result(await commit(ada, note, 'Second')).commit_oid
  const side = result(await commit(ada, note, 'Isolated branch', 'review/side')).commit_oid
  result(await ada('compile/create', define))
  const expectedConfig = result(await ada(config)), expectedLog = result(await log(ada, note))
  assert.deepEqual(expectedLog.map(row => [row.oid, row.parents]), [[second, [first]], [first, []]])
  const empty = result(await commit(admin, 'viking://resources/not-tracked.md', 'Empty shared branch', 'empty'))
  assert.equal(empty.changed, 0)
  result(await write(admin, shared, 'Alpha old shared\n'))
  result(await admin('acl', { uri: shared, acl_mode: 'restricted', entries: [{ principal: 'user:ben', level: 'read' }] }, 'PUT'))
  const aclId = result(await commit(admin, shared, 'Shared history')).commit_oid
  result(await write(admin, shared, 'Alpha current shared\n', 'replace'))
  result(await write(admin, bystander, 'Unrelated current file\n'))
  result(await write(beta, shared, 'Beta old shared\n'))
  const betaId = result(await commit(beta, shared, 'Beta history')).commit_oid
  await src.close()
  const physicalSource = (await src.inspect()).workspaces.map(row => row.physical)
  assert.equal(physicalSource.length, 2)
  await src.restart(source)
  for (const profile of [undefined, 'edge-v1-attachments']) result(await src.op('capture', { profile }), 409, 'INSTANCE_BACKUP_DOMAIN_UNSUPPORTED')
  const pack = await src.op('capture', { profile: version })
  result(pack)
  assert.equal(pack.headers['cache-control'], 'private, no-store')
  assert.equal(pack.bytes.includes(Buffer.from('user:ben')), false)
  for (const credential of [key, src.root, dst.root, ...s.map(a => a.key), ...d.map(a => a.key)]) {
    assert.equal(pack.bytes.includes(Buffer.from(credential)), false)
    assert.equal(pack.bytes.includes(Buffer.from(sha(credential))), false)
  }
  await src.close()

  const call = (action, arg, bytes = pack.bytes) => dst.op(action, { archive: bytes.toString('base64'), arg })
  await dst.restart(standby, d.map((a, i) => i === 1 ? { ...a, agentId: 'different-agent' } : a))
  result(await call('evaluate'), 409, 'INSTANCE_BACKUP_INVENTORY')
  await dst.restart(standby)
  const altered = Buffer.from(pack.bytes), at = altered.indexOf(Buffer.from('Alpha première édition'))
  assert.ok(at >= 0); altered[at] ^= 1
  result(await call('evaluate', undefined, altered), 400)
  const { approval, job, accounts, dry_run, attachment_count } = result(await call('evaluate'))
  assert.deepEqual([accounts, dry_run, attachment_count], [2, true, 0])
  await dst.close()
  assert.deepEqual(await dst.inspect(), { journal: null, workspaces: [] })
  await dst.restart(standby)
  assert.equal(result(await call('begin', approval), 202).phase, 'staged')
  result(await call('release'), 409, 'INSTANCE_BACKUP_STAGE')
  await dst.close(); await dst.inspect('pause'); await dst.restart(standby)
  result(await call('step', 0), 500, 'INTERNAL_ERROR')
  await dst.close()
  const prefix = await dst.inspect(), [a] = prefix.workspaces
  assert.deepEqual(prefix.journal, { receipts: [], released: 0 })
  assert.equal(prefix.workspaces.length, 1)
  assert.deepEqual([a.account, a.commits, a.blobs, a.hidden, a.configs, a.schedules, a.runs, a.jobs], [A, 5, 3, 2, 1, 0, 0, 0])
  assert.ok(!physicalSource.includes(a.physical))
  await dst.inspect('resume'); await dst.restart(undefined, d, null)
  result(await show(dAda, note, first), 503, 'INSTANCE_MAINTENANCE')
  result(await dAda(config), 503, 'INSTANCE_MAINTENANCE')
  await dst.restart(standby)
  const recovered = result(await call('step', 0), 202)
  assert.deepEqual(recovered.receipts, [a.receipt]); assert.deepEqual(result(await call('step', 0), 202), recovered)
  const complete = result(await call('step', 1), 202)
  assert.equal(complete.phase, 'awaiting_release')
  result(await show(dBeta, shared, betaId), 503, 'INSTANCE_MAINTENANCE')
  await dst.restart(standby)
  assert.deepEqual(result(await call('release')), { ...complete, phase: 'published' })
  await dst.restart(standby)
  assert.deepEqual(result(await call('release')), { ...complete, phase: 'published' })

  assert.equal(result(await read(dAda, note)), 'Alpha current\n')
  const archived = await show(dAda, note, first)
  result(archived); assert.deepEqual(archived.bytes, Buffer.from('Alpha première édition\r\n'))
  assert.equal(archived.headers['x-snapshot-commit-oid'], first)
  assert.equal((await show(dAda, note, 'refs/heads/review/side')).headers['x-snapshot-commit-oid'], side)
  assert.deepEqual(result(await log(dAda, note)), expectedLog)
  assert.deepEqual(result(await dAda(config)), expectedConfig)
  assert.equal(expectedConfig.auto_update, false); assert.equal(expectedConfig.next_triggered_slot, null)
  assert.deepEqual(result(await dAda('compile/runs?compile_name=Maritime')), { runs: [], next_cursor: null })
  result(await dBetaAda(config), 404); result(await show(dBen, note, first), 403)
  result(await show(dBetaAda, note, first), 404); result(await show(actor(dst, s[1].key), note, first), 401)
  assert.equal(result(await dAdmin('snapshot/ignore')), '*.txt\n')
  assert.equal(result(await dBeta('snapshot/ignore')), '')
  result(await write(dAda, ignoreNote, 'Untracked contents\n'))
  const ignored = result(await commit(dAda, ignoreNote, 'Uses restored ignore'))
  assert.deepEqual([ignored.result, ignored.ignored, ignored.commit_oid], ['noop', 1, second])
  result(await dAda('snapshot/restore', { path: note, restore_commit_id: first, current_commit_id: second }))
  assert.equal(result(await read(dAda, note)), 'Alpha première édition\r\n')
  assert.deepEqual(result(await log(dAda, note))[0].parents, [second])

  assert.deepEqual((await show(dAdmin, shared, aclId)).bytes, Buffer.from('Alpha old shared\n'))
  assert.equal(result(await dAdmin(qs('snapshot/show', { target_ref: 'empty' }))).oid, empty.commit_oid)
  assert.deepEqual((await show(dBeta, shared, betaId)).bytes, Buffer.from('Beta old shared\n'))
  result(await show(dBeta, shared, aclId), 404)
  result(await read(dBen, shared), 403)
  const direct = result(await dAdmin(qs('acl', { uri: shared })))
  assert.deepEqual([direct.acl_mode, direct.direct_entries], ['restricted', []])
  for (const uri of [shared, bystander]) result(await dAdmin('acl', { uri, acl_mode: 'restricted',
    entries: [{ principal: 'user:ben', level: 'manage' }] }, 'PUT'))
  assert.equal(result(await read(dBen, shared)), 'Alpha current shared\n')
  for (const ref of [aclId, aclId.slice(0, 10), 'main']) result(await show(dBen, shared, ref), 404)
  result(await show(dBen, bystander, 'empty'), 404)
  await dst.close()
  const final = await dst.inspect()
  assert.deepEqual(final.journal, { receipts: complete.receipts, released: 1 })
  assert.equal(final.workspaces.length, 2)
  assert.equal(new Set([...physicalSource, ...final.workspaces.map(row => row.physical)]).size, 4)
  assert.ok(final.workspaces.every(row => row.schedules === 0 && row.runs === 0 && row.jobs === 0))
  t.diagnostic(`v3 ZIP ${sha(pack.bytes)} job=${job} receipts=${complete.receipts.join(',')} persisted-before-ACK=5 commits, 3 blobs, 1 inactive definition; four distinct Workspaces`)
})

test('instance v3 refuses real inactive Compile definitions outside the inert self-owned subset', { timeout: 25000 }, async t => {
  const bundle = await portableBundle(), key = random(32), s = roster()
  const src = await portableHarness(t, bundle, s, key, policy())
  result(await actor(src, src.root)('admin/accounts'))
  const ada = actor(src, s[1].key)
  result(await ada('fs/mkdir', { uri: sourceDir }))
  result(await ada('compile/create', { ...define, instruction: 'Synthetic nonportable instruction' }))
  await src.restart({ mode: 'source', instance_id: random(16), peer_id: random(16), peer_control: random(32) })
  const rejected = await src.op('capture', { profile: version })
  result(rejected, 409, 'INSTANCE_BACKUP_PORTABLE_STATE')
  assert.doesNotMatch(rejected.bytes.toString(), /nonportable instruction|accounts\//)
})
