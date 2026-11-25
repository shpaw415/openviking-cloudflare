// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { principal } from '../control/harness.mjs'
import { backupHarness } from './backup-harness.mjs'
import { recordBundle } from './receipt.mjs'

const account = 'edge-domains-fixture'
const edge = { profile: 'edge-v1' }
const overwrite = { ...edge, on_conflict: 'overwrite' }
const api = '/api/v1'
const session = `${api}/sessions/round-trip`
const events = ['fixture=portable']
const privateRoot = 'viking://user/ada'
const doc = `${privateRoot}/resources/imports/fixture.md`
const skills = `${privateRoot}/skills`
const setting = `${api}/user-settings/add-locations`
const plain = value => createHash('sha256').update(value).digest('hex')

function expect(response, status = 200, code) {
  assert.equal(response.status, status, `${response.json?.error?.code ?? 'no error envelope'}: ${response.json?.error?.message ?? ''}`)
  if (status >= 400 && response.json) assert.equal('result' in response.json, false)
  if (code) assert.equal(response.json.error.code, code)
  return response.json?.result
}

test('Edge backup restores portable history, data-only skills and private add locations in one commit', async t => {
  const admin = principal(account, 'admin', 'admin'), ada = principal(account, 'ada'), ben = principal(account, 'ben')
  const foreign = principal('edge-other-fixture', 'ada')
  const actors = [admin, ada, ben, foreign]
  const backup = {
    key: randomBytes(32).toString('hex'), policy: [{ account_id: account, scope_id: randomBytes(16).toString('hex') }],
    adapter: await readFile(new URL('./backup-adapter.mjs', import.meta.url), 'utf8'),
    ai: `import { WorkerEntrypoint } from 'cloudflare:workers';
      export default class TestAI extends WorkerEntrypoint {
        run(model, { text }) {
          if (model !== '@cf/baai/bge-base-en-v1.5' || !Array.isArray(text)) throw new Error('Only synthetic embeddings are allowed');
          return { data: text.map(() => Array.from({length:768}, (_, i) => i === 0 ? 1 : 0)) };
        }
      }`,
  }
  const src = await backupHarness(t, actors, backup)
  await recordBundle(t, src.dir)
  const capture = (h, options) => h.operator('/capture', { method: 'POST', body: { account, options } })
  const get = (h, actor, path) => h.send(path, { key: actor.key })
  const change = (h, actor, path, body, method = 'POST') => h.send(path, { key: actor.key, body, method })
  const provision = async h => { for (const actor of actors) expect(await get(h, actor, '/health')) }
  const read = (h, actor, uri) => get(h, actor, `${api}/content/read?${new URLSearchParams({ uri })}`)
  await provision(src)
  expect(await change(src, ada, `${api}/content/write`, { uri: doc, mode: 'create', content: '# mount fixture\r\n', defer_processing: true }))
  expect(await change(src, ada, `${api}/sessions`, { session_id: 'round-trip', memory_policy: { self: { enabled: false } },
    memory_extraction_config: { events: { tags: events } } }))
  expect(await change(src, ada, `${session}/messages`, { role: 'user', content: 'Archived É content\r\n' }))
  assert.equal(expect(await change(src, ada, `${session}/commit?wait=true`, { reset_context: true })).archived, true)
  expect(await change(src, ada, `${session}/messages`, { role: 'assistant', content: 'Active suffix 🐿' }))
  const detail = expect(await get(src, ada, session)), context = expect(await get(src, ada, `${session}/context`))
  const first = expect(await get(src, ada, `${session}/archives/archive_001`))
  const reset = expect(await get(src, ada, `${session}/archives/archive_002`))
  assert.equal(detail.commit_count, 2)
  assert.equal(first.messages.length, 1)
  assert.deepEqual(reset.messages, [])
  const data = { name: 'field-notes', description: 'Notebook reference', content: 'Plain instructions as data.\n',
    files: { 'refs/field.txt': 'Read-only note é\r\n' } }
  expect(await change(src, ada, `${api}/skills`, { data, target_uri: skills }))
  const skillPath = `${api}/skills/field-notes?${new URLSearchParams({ target_uri: skills, include_integrity: 'true' })}`
  const oldSkill = expect(await get(src, ada, skillPath))
  const locations = { resource_uri: `${privateRoot}/resources/imports`, skill_uri: skills }
  expect(await change(src, ada, setting, locations, 'PATCH'))
  expect(await capture(src), 501, 'BACKUP_TOPOLOGY_UNSUPPORTED')
  const captured = await capture(src, edge)
  expect(captured)
  assert.match(captured.headers['content-disposition'], /openviking-edge-backup\.zip/)
  const oracle = spawnSync('/usr/bin/python3', ['-I', fileURLToPath(new URL('./backup-oracle.py', import.meta.url)), 'verify-edge'],
    { input: captured.bytes, maxBuffer: 8192, timeout: 4000 })
  assert.equal(oracle.status, 0, oracle.stderr.toString())
  const wire = JSON.parse(oracle.stdout)
  assert.deepEqual(wire, { sha256: plain(captured.bytes), files: { [doc]: plain('# mount fixture\r\n') },
    sessions: ['viking://user/ada/sessions/round-trip'], skills: [`${skills}/field-notes`], settings: [privateRoot] })
  t.diagnostic(`Edge v1 SHA-256 ${wire.sha256}`)
  expect(await change(src, ben, `${api}/skills`, { data: { ...data, allowed_tools: ['fixture-only'] } }))
  expect(await capture(src, edge), 501, 'BACKUP_TOPOLOGY_UNSUPPORTED')
  const to = async (h, action, options = overwrite, approval) => h.operator(`/${action}`, { method: 'POST', body: {
    account, options, approval, archive: captured.bytes.toString('base64'), seal: captured.headers['x-ovpack-seal'],
  } })
  await src.close()
  const dest = await backupHarness(t, actors, { ...backup, ai: undefined })
  await provision(dest)
  expect(await to(dest, 'evaluate', { on_conflict: 'overwrite' }), 400)
  const initial = expect(await to(dest, 'evaluate'))
  assert.equal(initial.dry_run, true)
  assert.deepEqual(initial.domain_counts, { sessions: 1, skills: 1, settings: 1 })
  expect(await get(dest, ada, session), 404)
  expect(await get(dest, ada, skillPath), 404)
  assert.deepEqual(expect(await get(dest, ada, setting)).effective, {})
  expect(await read(dest, ada, doc), 404)
  expect(await change(dest, ada, `${api}/sessions`, { session_id: 'round-trip' }))
  expect(await to(dest, 'apply', overwrite, initial.approval), 409, 'BACKUP_SESSION_CONFLICT')
  expect(await read(dest, ada, doc), 404)
  expect(await get(dest, ada, skillPath), 404)
  assert.deepEqual(expect(await get(dest, ada, setting)).effective, {})
  expect(await change(dest, ada, session, undefined, 'DELETE'))
  expect(await change(dest, foreign, `${api}/sessions`, { session_id: 'round-trip' }))
  expect(await change(dest, foreign, `${session}/messages`, { role: 'user', content: 'unrelated account sentinel' }))
  expect(await change(dest, admin, `${api}/content/write`, { uri: 'viking://resources/rollback-sentinel.txt',
    mode: 'create', content: 'untouched synthetic sentinel', defer_processing: true }))
  async function fault(operation) {
    await dest.close()
    const run = spawnSync('/usr/bin/python3', ['-I', fileURLToPath(new URL('./backup-rollback.py', import.meta.url)), dest.dir, operation],
      { timeout: 5000, maxBuffer: 8192 })
    assert.equal(run.status, 0, run.stderr.toString().slice(-1024))
    await dest.restart()
  }
  await fault('add')
  const willFail = expect(await to(dest, 'evaluate'))
  expect(await to(dest, 'apply', overwrite, willFail.approval), 500, 'INTERNAL_ERROR')
  expect(await read(dest, ada, doc), 404)
  expect(await get(dest, ada, session), 404)
  expect(await get(dest, ada, skillPath), 404)
  assert.deepEqual(expect(await get(dest, ada, setting)).effective, {})
  await fault('remove')
  const checked = expect(await to(dest, 'evaluate'))
  const done = expect(await to(dest, 'apply', overwrite, checked.approval))
  assert.equal(done.outcome, 'applied')
  assert.deepEqual(done.domain_counts, checked.domain_counts)
  await dest.restart()
  assert.deepEqual(expect(await get(dest, ada, session)), detail)
  assert.deepEqual(expect(await get(dest, ada, `${session}/context`)), context)
  assert.deepEqual(expect(await get(dest, ada, `${session}/archives/archive_001`)), first)
  assert.deepEqual(expect(await get(dest, ada, `${session}/archives/archive_002`)), reset)
  assert.deepEqual(expect(await get(dest, ada, setting)).effective, locations)
  assert.equal(expect(await read(dest, ada, doc)), '# mount fixture\r\n')
  const restored = expect(await get(dest, ada, skillPath))
  for (const field of ['content', 'files', 'revision', 'owner_user_id', 'allowed_tools']) assert.deepEqual(restored[field], oldSkill[field])
  assert.equal(expect(await read(dest, ada, `${skills}/field-notes/refs/field.txt`)), data.files['refs/field.txt'])
  expect(await get(dest, ben, session), 404)
  expect(await get(dest, ben, skillPath), 403)
  assert.equal(expect(await get(dest, foreign, `${session}/context`)).messages[0].parts[0].text, 'unrelated account sentinel')
  expect(await change(dest, ada, `${session}/messages`, { role: 'user', parts: [{ type: 'context', uri: doc, abstract: 'non-portable part' }] }))
  expect(await capture(dest, edge), 501, 'BACKUP_TOPOLOGY_UNSUPPORTED')
})
