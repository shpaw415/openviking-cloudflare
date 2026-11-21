// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, principal } from '../control/harness.mjs'
import { recordBundle } from './receipt.mjs'

test('global pack routes refuse rather than broaden the filesystem mount or return a partial success', async t => {
  const owner = principal('pack-scope-fixture', 'owner', 'admin')
  const member = principal('pack-scope-fixture', 'member')
  const foreign = principal('foreign-pack-fixture', 'owner', 'admin')
  const { dir, send } = await harness(t, [owner, member, foreign], { production: true })
  await recordBundle(t, dir)
  const privateFile = 'viking://user/member/resources/draft.md'
  const created = await send('/api/v1/content/write', { method: 'POST', key: member.key, body: {
    uri: privateFile, mode: 'create', content: 'private fixture', defer_processing: true,
  } })
  assert.equal(created.status, 200)
  const read = actor => send(`/api/v1/content/read?${new URLSearchParams({ uri: privateFile })}`, { key: actor.key })
  assert.equal((await read(owner)).status, 403)
  for (const [action, body] of [['backup', {}], ['restore', { temp_file_id: '10000000-0000-0000-0000-000000000001' }]]) {
    const submit = actor => send(`/api/v1/pack/${action}`, { method: 'POST', key: actor.key, body })
    assert.equal((await submit(member)).status, 403)
    for (const actor of [owner, foreign]) {
      const reply = await submit(actor)
      assert.equal(reply.status, 501)
      assert.equal(reply.json.error.code, 'NOT_IMPLEMENTED')
      assert.equal(Object.hasOwn(reply.json, 'result'), false)
    }
  }
  const unchanged = await read(member)
  assert.equal(unchanged.status, 200)
  assert.equal(unchanged.json.result, 'private fixture')
})
