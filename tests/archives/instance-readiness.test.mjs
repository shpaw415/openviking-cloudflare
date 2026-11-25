// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { principal } from '../control/harness.mjs'
import { instanceHarness } from './instance-backup-harness.mjs'

const random = n => randomBytes(n).toString('hex')
const fixed = () => [principal('first-account', 'admin', 'admin'), principal('second-account', 'admin', 'admin')]
const uri = 'viking://~/resources/compass.txt'
const content = 'Fictional compass notes, held for recovery.'

function result(reply, status = 200, code) {
  assert.equal(reply.status, status, reply.json?.error?.code)
  if (code) assert.equal(reply.json.error.code, code)
  return reply.json?.result
}

test('readiness does not initialize a cold standby and its durable journal remains authoritative across configuration changes', { timeout: 30_000 }, async t => {
  const owners = fixed(), recipients = fixed()
  const options = { key: random(32), policy: owners.map(({ accountId }) => ({ account_id: accountId, scope_id: random(16) })) }
  const source = await instanceHarness(t, owners, options)
  const recovery = await instanceHarness(t, recipients, options)
  for (const h of [source, recovery]) result(await h.send('/api/v1/admin/accounts', { key: h.root }))
  result(await recovery.send('/ready'))
  await recovery.close()
  assert.equal(recovery.inspect('inspect').workspaces, 0, 'ordinary readiness leaves the Workspace cold')
  await recovery.restart()

  for (const { key } of owners) result(await source.send('/api/v1/content/write', {
    key, body: { uri, content, mode: 'create', defer_processing: true },
  }))
  const a = result(await source.operator('identify')), b = result(await recovery.operator('identify'))
  const aId = random(16), bId = random(16)
  const standby = { mode: 'standby', instance_id: bId, peer_id: aId, peer_control: a.control }
  await source.restart({ mode: { mode: 'source', instance_id: aId, peer_id: bId, peer_control: b.control } })
  const packed = await source.operator('capture')
  result(packed)
  await source.close()

  const send = (command, fields = {}) => recovery.operator(command, { archive: packed.bytes.toString('base64'), ...fields })
  await recovery.restart({ mode: standby })
  const preview = result(await send('evaluate'))
  result(await send('begin', { approval: preview.approval }), 202)
  await recovery.restart({ key: null })
  result(await recovery.send('/health'))
  result(await recovery.send('/ready'), 503, 'INSTANCE_MAINTENANCE')
  await recovery.close()
  assert.deepEqual(recovery.inspect('inspect'), { progress: [[], 0], commits: [], workspaces: 0 })

  await recovery.restart({ mode: standby })
  assert.equal(result(await send('step', { index: 0 }), 202).completed, 1)
  assert.equal(result(await send('step', { index: 1 }), 202).completed, 2)
  assert.equal(result(await send('release')).phase, 'published')
  await recovery.restart({ key: null })
  result(await recovery.send('/ready'))
  for (const { key } of recipients) assert.equal(result(await recovery.send(`/api/v1/content/read?${new URLSearchParams({ uri })}`, { key })), content)
})
