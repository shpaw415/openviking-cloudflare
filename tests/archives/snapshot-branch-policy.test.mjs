// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { principal } from '../control/harness.mjs'
import { portableBundle, portableHarness, random, sha } from './instance-portable-harness.mjs'

test('shared snapshot commits require an administrator, without affecting private commits or the live tree', async t => {
  const account = 'branch-policy-fixture'
  const owner = principal(account, 'owner', 'admin'), member = principal(account, 'member')
  const bundle = await portableBundle()
  t.diagnostic(`Worker bundle SHA-256: ${sha(bundle)}`)
  const local = await portableHarness(t, bundle, [owner, member], random(32), [{ account_id: account, scope_id: random(16) }])
  const call = (actor, path, body, method) => local.api(`/api/v1/${path}`, { key: actor.key, body, method })
  const result = r => { assert.equal(r.status, 200, r.json?.error?.code); return r.json?.result }
  const shared = 'viking://resources/shared.md', own = 'viking://~/resources/private.md'
  const commit = (actor, uri, branch) => call(actor, 'snapshot/commit', { paths: [uri], message: 'Policy fixture', branch })
  const show = (actor, uri, ref) => call(actor, `snapshot/show?${new URLSearchParams({ path: uri, target_ref: ref })}`)
  const head = ref => call(owner, `snapshot/show?${new URLSearchParams({ target_ref: ref })}`)
  const write = (actor, uri, content, mode = 'create') => call(actor, 'content/write', { uri, content, mode, defer_processing: true })

  result(await call({ key: local.root }, 'admin/accounts'))
  result(await write(owner, shared, 'original'))
  const first = result(await commit(owner, shared, 'main')).commit_oid
  const named = result(await commit(owner, shared, 'review/published')).commit_oid
  result(await call(owner, 'acl', { uri: shared, acl_mode: 'restricted', entries: [{ principal: 'user:member', level: 'manage' }] }, 'PUT'))
  result(await write(member, shared, 'live edit', 'replace'))
  await local.close()
  const before = await local.inspect()
  await local.restart()
  for (const branch of [undefined, 'main', 'review/published', 'review/new']) {
    const forbidden = await commit(member, shared, branch)
    assert.equal(forbidden.status, 403)
    assert.equal(forbidden.json.error.code, 'PERMISSION_DENIED')
    assert.equal(forbidden.json.error.message, 'Committing snapshots to shared branches requires an administrator.')
    assert.equal(Object.hasOwn(forbidden.json, 'result'), false)
  }
  assert.equal(result(await head('main')).oid, first)
  assert.equal(result(await head('review/published')).oid, named)
  assert.equal((await head('review/new')).status, 404)
  assert.equal(result(await call(member, `content/read?${new URLSearchParams({ uri: shared })}`)), 'live edit')
  await local.close()
  assert.deepEqual(await local.inspect(), before)

  await local.restart()
  result(await write(member, own, 'private bytes'))
  const mine = result(await commit(member, own, 'review/new')).commit_oid
  const historical = await show(member, own, 'refs/heads/review/new')
  assert.equal(historical.status, 200)
  assert.equal(historical.headers['x-snapshot-commit-oid'], mine)
  assert.equal(historical.bytes.toString(), 'private bytes')
  const advanced = result(await commit(owner, shared, 'main')).commit_oid
  assert.deepEqual(result(await head('main')).parents, [first])
  assert.equal((await show(owner, shared, advanced)).bytes.toString(), 'live edit')
  assert.equal(result(await commit(owner, shared, 'review/new')).result, 'created')
})
