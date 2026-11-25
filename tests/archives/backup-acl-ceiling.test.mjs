// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { principal } from '../control/harness.mjs'
import { backupHarness } from './backup-harness.mjs'
import { recordBundle } from './receipt.mjs'

const api = '/api/v1'
const at = (path, uri) => `${api}/${path}?${new URLSearchParams({ uri })}`
const grant = (principal, level) => ({ principal, level })

function result(reply, code = 200, error) {
  assert.equal(reply.status, code, reply.json?.error?.code)
  if (code >= 400) {
    assert.equal(Object.hasOwn(reply.json, 'result'), false)
    if (error) assert.equal(reply.json.error.code, error)
  }
  return reply.json?.result
}

test('backup restore conforms to the sealed read/write/manage ceiling', async t => {
  const account = 'backup-acl-fixture'
  const admin = principal(account, 'admin', 'admin')
  const writer = principal(account, 'writer')
  const reader = principal(account, 'reader')
  const scopeId = randomBytes(16).toString('hex')
  const setup = {
    key: randomBytes(32).toString('hex'), policy: [{ account_id: account, scope_id: scopeId }],
    adapter: await readFile(new URL('./backup-adapter.mjs', import.meta.url), 'utf8'),
  }
  const store = await backupHarness(t, [admin, writer, reader], setup)
  await recordBundle(t, store.dir)
  const base = 'viking://resources/fixture', note = `${base}/memo.md`, isolated = 'viking://resources/quarantine.md'
  const namedRead = grant('user:reader', 'read'), namedWrite = grant('user:writer', 'write')
  const namedManage = grant('user:writer', 'manage'), publicRead = grant('user:*', 'read'), publicWrite = grant('user:*', 'write')
  const groupRead = grant('group:reviewers', 'read')
  const owners = [admin, writer, reader]
  const data = (path, actor = admin, method = 'GET', body) => store.send(path, { key: actor.key, method, body })
  const write = (uri, content, mode = 'replace', actor = admin) => data(`${api}/content/write`, actor, 'POST', {
    uri, content, mode, defer_processing: true,
  })
  const read = (uri, actor = admin) => data(at('content/read', uri), actor)
  const inspect = uri => data(at('acl', uri))
  const set = (uri, entries, mode = 'restricted') => data(`${api}/acl`, admin, 'PUT', { uri, acl_mode: mode, entries })
  const operator = (action, body) => store.operator(`/${action}`, { method: 'POST', body: { account, ...body } })
  for (const actor of owners) result(await data('/health', actor))
  result(await data(`${api}/admin/accounts/${account}/groups`, admin, 'POST', { group_id: 'reviewers' }))
  result(await write(note, 'Archived text\r\n', 'create'))
  result(await write(isolated, 'New object stays quarantined\n', 'create'))
  // The child inherits public read and one specific writer. Its capture has no
  // group membership dependency. All expectations below concern the fixed Worker.
  result(await set(base, [publicRead, namedWrite]))
  const capture = await operator('capture', {})
  result(capture)
  const seal = capture.headers['x-ovpack-seal'], archive = capture.bytes.toString('base64')
  assert.ok(seal.startsWith('acl2-'))
  const apply = (approval, witness = seal) => operator('apply', { archive, seal: witness, approval, options: { on_conflict: 'overwrite' } })
  const plan = (witness = seal) => operator('evaluate', { archive, seal: witness, options: { on_conflict: 'overwrite' } })
  result(await write(note, 'Destination text\n'))
  result(await data(at('fs', isolated), admin, 'DELETE'))
  const before = result(await plan())
  assert.equal(before.dry_run, true)
  assert.equal(before.counts.update, 1)
  assert.equal(before.counts.quarantined, 1)

  await t.test('broader inherited write, direct manage and membership-dependent write are refused', async () => {
    for (const setupAcl of [
      async () => result(await set(base, [publicWrite])),
      async () => { result(await set(base, [publicRead, namedWrite])); result(await set(note, [namedManage], 'inherit')) },
      async () => result(await set(note, [grant('group:reviewers', 'write')])),
    ]) {
      await setupAcl()
      const current = result(await inspect(note))
      result(await plan(), 409, 'BACKUP_ACL_CONFLICT')
      result(await apply(before.approval), 409, 'BACKUP_ACL_CONFLICT')
      assert.deepEqual(result(await inspect(note)), current)
      assert.equal(result(await read(note)), 'Destination text\n')
      result(await read(isolated), 404)
    }
  })

  await t.test('an authentic old seal and an altered ceiling are not accepted', async () => {
    // A fixed-shape legacy fixture authenticated with this test's ephemeral key;
    // the old Worker never runs, and neither token is reusable elsewhere.
    const legacy = '0'.repeat(64), sha = capture.headers['x-ovpack-sha256']
    const mac = createHmac('sha256', Buffer.from(setup.key, 'hex'))
      .update(JSON.stringify(['openviking:backup:v1', 'archive', account, scopeId, sha, legacy])).digest('hex')
    const old = `${legacy}.${mac}`
    const altered = seal.slice(0, 5) + (seal[5] === '0' ? '1' : '0') + seal.slice(6)
    for (const witness of [old, altered]) {
      result(await plan(witness), 403, 'BACKUP_SEAL_INVALID')
      result(await apply(before.approval, witness), 403, 'BACKUP_SEAL_INVALID')
    }
    assert.equal(result(await read(note)), 'Destination text\n')
    result(await read(isolated), 404)
  })

  await t.test('narrower ACL remains eligible but needs a fresh CAS; restart preserves target ACLs', async () => {
    result(await set(base, [publicRead, namedWrite]))
    result(await set(note, [namedRead, groupRead])) // subset, with group rights covered by universal read
    const targetAcl = result(await inspect(note))
    result(await apply(before.approval), 409, 'BACKUP_PLAN_STALE')
    const fresh = result(await plan())
    assert.equal(fresh.counts.update, 1)
    assert.equal(result(await read(note)), 'Destination text\n')
    const { commit_oid } = result(await data(`${api}/snapshot/commit`, admin, 'POST', { paths: [note], message: 'Destination fixture before restore' }))
    const show = `${api}/snapshot/show?${new URLSearchParams({ path: note, target_ref: commit_oid })}`
    const applied = result(await apply(fresh.approval))
    assert.equal(applied.outcome, 'applied')
    await store.restart()
    assert.deepEqual(result(await inspect(note)), targetAcl)
    assert.equal(result(await read(note, reader)), 'Archived text\r\n')
    result(await read(note, writer), 403)
    result(await write(note, 'Rejected edit', 'replace', reader), 403)
    assert.equal(result(await read(note, reader)), 'Archived text\r\n')
    const historical = await data(show, reader)
    assert.equal(historical.status, 200) // Overwrite preserved the destination incarnation.
    assert.deepEqual(historical.bytes, Buffer.from('Destination text\n'))
    result(await data(show, writer), 403) // Historical ACL gate was not bypassed.
    assert.equal(result(await read(isolated)), 'New object stays quarantined\n')
    assert.deepEqual(result(await inspect(isolated)).effective_entries, [])
    result(await read(isolated, reader), 403)
  })

  await t.test('a different named reader is incomparable; equal and narrower named grants stay usable', async () => {
    result(await set(note, [namedWrite]))
    const captured = await operator('capture', { options: { profile: 'edge-v1' } })
    result(captured)
    const options = { on_conflict: 'overwrite', profile: 'edge-v1' }
    const backup = { archive: captured.bytes.toString('base64'), seal: captured.headers['x-ovpack-seal'], options }
    result(await write(note, 'Next destination value\n'))
    result(await set(note, [namedRead]))
    result(await operator('evaluate', backup), 409, 'BACKUP_ACL_CONFLICT')
    assert.equal(result(await read(note, reader)), 'Next destination value\n')
    result(await set(note, [namedWrite]))
    const equal = result(await operator('evaluate', backup))
    const acl = result(await inspect(note))
    result(await operator('apply', { ...backup, approval: equal.approval }))
    assert.deepEqual(result(await inspect(note)), acl)
    assert.equal(result(await read(note, writer)), 'Archived text\r\n')
    result(await read(note, reader), 403)
  })
})
