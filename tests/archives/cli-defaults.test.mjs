// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, principal } from '../control/harness.mjs'
import { recordBundle } from './receipt.mjs'

test('CLI snapshot defaults are admin-only and target the shared mount without crossing history', async t => {
  const admin = principal('snapshot-defaults', 'owner', 'admin')
  const member = principal('snapshot-defaults', 'reader')
  const foreign = principal('foreign-snapshot-defaults', 'owner', 'admin')
  const { send, dir } = await harness(t, [admin, member, foreign], { production: true })
  await recordBundle(t, dir)
  const file = 'viking://resources/readme.md', memberFile = 'viking://user/reader/resources/private.md'
  const privateFile = 'viking://~/resources/scratch.md', agentFile = 'viking://agent/scratch.md'
  const snapshot = (actor, route, query = {}, body) => send(`/api/v1/snapshot/${route}?${new URLSearchParams(query)}`, {
    key: actor?.key, method: body === undefined ? 'GET' : 'POST', body,
  })
  const ok = response => {
    assert.equal(response.status, 200, response.json?.error?.code)
    return response.json.result
  }
  const write = (actor, uri, content, mode = 'create') => send('/api/v1/content/write', { key: actor.key, method: 'POST',
    body: { uri, content, mode, defer_processing: true } }).then(ok)
  const commit = (actor, body) => snapshot(actor, 'commit', {}, body).then(ok)

  await write(admin, file, 'first shared\n')
  await write(member, memberFile, 'private member fixture')
  await write(admin, privateFile, 'private administrator fixture')
  await write(admin, agentFile, 'agent fixture')
  const own = await commit(admin, { message: 'explicit private', paths: [privateFile] })
  for (const actor of [undefined, member]) {
    const expected = actor ? 403 : 401
    for (const [route, query, body] of [['commit', {}, { message: 'implicit' }], ['log', {}, undefined],
      ['show', { target_ref: 'main' }, undefined], ['restore', {}, { source_commit: 'main', dry_run: true }]]) {
      assert.equal((await snapshot(actor, route, query, body)).status, expected)
    }
  }

  const first = await commit(admin, { message: 'default' })
  assert.equal(first.changed, 1)
  for (const uri of [privateFile, agentFile, memberFile]) {
    assert.equal((await snapshot(admin, 'show', { target_ref: first.commit_oid, path: uri })).status, uri === memberFile ? 403 : 404)
  }
  assert.equal((await snapshot(admin, 'show', { target_ref: own.commit_oid })).status, 404)
  assert.equal((await snapshot(foreign, 'show', { target_ref: first.commit_oid })).status, 404)
  assert.equal((await snapshot(admin, 'show', { target_ref: first.commit_oid, path: file })).text, 'first shared\n')

  await write(admin, file, 'second shared\n', 'replace')
  const alt = await commit(admin, { message: 'isolated branch', branch: 'review/draft', paths: null })
  assert.equal(alt.changed, 1)
  const metadata = ok(await snapshot(admin, 'show', { target_ref: 'refs/heads/review/draft' }))
  assert.equal(metadata.oid, alt.commit_oid)
  assert.deepEqual(metadata.parents, [])
  assert.equal(ok(await snapshot(admin, 'show', { target_ref: 'main' })).oid, first.commit_oid)
  const second = await commit(admin, { message: 'advance main' })
  assert.deepEqual(ok(await snapshot(admin, 'log')).map(row => row.oid), [second.commit_oid, first.commit_oid])
  assert.deepEqual(ok(await snapshot(admin, 'log', { branch: 'review/draft' })).map(row => row.oid), [alt.commit_oid])
  assert.deepEqual(ok(await snapshot(member, 'log', { paths: file })).map(row => row.oid), [second.commit_oid, first.commit_oid])

  const plan = ok(await snapshot(admin, 'restore', {}, { source_commit: first.commit_oid, dry_run: true }))
  assert.equal(plan.result, 'dry_run')
  assert.deepEqual(plan.diff.to_write.map(row => row.path), ['readme.md'])
  assert.equal((await snapshot(admin, 'restore', {}, { source_commit: first.commit_oid })).status, 403)
  const live = await send(`/api/v1/content/read?${new URLSearchParams({ uri: file })}`, { key: admin.key })
  assert.equal(ok(live), 'second shared\n')
})
