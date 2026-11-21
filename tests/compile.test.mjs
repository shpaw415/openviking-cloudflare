// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'
import { compileWorker } from './compile/runtime.mjs'

const skill = 'viking://system/compile/example-skills/llm-wiki'
const source = 'viking://~/resources/maritime'
const destination = 'viking://~/resources/wiki'
const named = { compile_name: 'Maritime', from: [source], to: destination, skill }
const fsPath = (path, uri) => `/api/v1/${path}?${new URLSearchParams({ uri })}`

async function expect(request, status = 200) {
  const response = await request
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  return status < 400 ? body.result : body.error
}

async function initSource(send, root = source) {
  await expect(send('/api/v1/fs/mkdir', { method: 'POST', body: { uri: root } }))
  await expect(send('/api/v1/content/write', { method: 'POST', body: {
    uri: `${root}/notes.md`, content: 'The boat runs every Friday. Marine safety checks are required before sailing.',
  } }))
}

test('unbound Compile and Rules cannot claim to accept work', async t => {
  const alice = testPrincipal('compile-disabled', 'alice')
  const runtime = await localWorker({ principals: [alice] })
  t.after(() => runtime.dispose())
  const send = api(runtime, alice)
  assert.deepEqual(await expect(send('/api/v1/compile/capabilities')), {
    configured: false, can_create: false, reason_code: 'NOT_CONFIGURED',
  })
  await expect(send('/api/v1/compile', { method: 'POST', body: named }), 400)
  await expect(send('/api/v1/compile', { method: 'POST', body: { compile_name: 'Maritime' } }), 503)
  await expect(send('/api/v1/rules/compile', { method: 'POST', body: { instruction: 'Boat logs must record departures.' } }), 503)
})

test('configuration create/update/list preserve name case, target, scope and time without running', async t => {
  const alice = testPrincipal('compile-configs', 'alice')
  const bob = testPrincipal('compile-configs', 'bob')
  const admin = testPrincipal('compile-configs', 'admin', 'admin')
  const runtime = await localWorker({ principals: [alice, bob, admin], embeddings: 'fixture' })
  t.after(() => runtime.dispose())
  const send = api(runtime, alice)
  const sendBob = api(runtime, bob)
  await initSource(send)
  const create = body => send('/api/v1/compile/create', { method: 'POST', body })
  assert.deepEqual(await expect(create(named)), { compile_name: 'Maritime' })
  const second = { ...named, compile_name: 'maritime', to: 'viking://~/resources/wiki-other' }
  assert.deepEqual(await expect(create(second)), { compile_name: 'maritime' })
  await expect(create(named), 409)
  await expect(create({ ...named, compile_name: 'no-self-input', to: `${source}/result` }), 400)
  await expect(create({ ...named, compile_name: 'no-parent-overlap', to: `${destination}/nested` }), 409)
  const url = '/api/v1/compile/config?compile_name=Maritime'
  const config = await expect(send(url))
  assert.equal(config.last_run_time, null)
  assert.equal(typeof config.task_first_create_time, 'number')
  const { to, ...update } = { ...named, auto_update: false, instruction: 'Synthesize the boat notes.' }
  await expect(send('/api/v1/compile/config/update', { method: 'POST', body: { ...update, to: second.to } }), 400)
  const saved = await expect(send('/api/v1/compile/config/update', { method: 'POST', body: update }))
  assert.equal(saved.to, 'viking://user/alice/resources/wiki')
  assert.equal(saved.instruction, 'Synthesize the boat notes.')
  assert.equal(saved.task_first_create_time, config.task_first_create_time)
  assert.equal((await expect(send(fsPath('fs/attrs', destination)))).attrs.tags.includes('compile_target=true'), true)
  const first = await expect(send('/api/v1/compile/configs?limit=1'))
  assert.deepEqual(first.configs.map(item => item.compile_name), ['Maritime'])
  const next = await expect(send(`/api/v1/compile/configs?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`))
  assert.deepEqual(next.configs.map(item => item.compile_name), ['maritime'])
  assert.equal(next.next_cursor, null)
  assert.equal((await expect(send(fsPath('compile/config', destination).replace('?uri=', '?to=')))).compile_name, 'Maritime')
  assert.deepEqual(await expect(send('/api/v1/compile/runs?compile_name=Maritime')), { runs: [], next_cursor: null })
  await expect(sendBob(url), 404)
  await expect(sendBob('/api/v1/compile/configs?scope=account'), 403)
  const all = await expect(api(runtime, admin)('/api/v1/compile/configs?scope=account'))
  assert.equal(all.configs[0].owner_user_id, 'alice')
  assert.equal(all.configs[0].instruction, null)
})

const post = (send, path, body, headers) => expect(send(`/api/v1/${path}`, { method: 'POST', body, headers }), path === 'compile' || path === 'rules/compile' ? 202 : 200)
const submit = (send, body, key) => post(send, 'compile', body, key && { 'Idempotency-Key': key })

async function getTask(send, id, states = ['completed', 'failed', 'cancelled']) {
  for (let i = 0; i < 100; i++) {
    const task = await expect(send(`/api/v1/tasks/${id}`))
    if (states.includes(task.status)) return task
    assert.ok(['pending', 'running', 'cancelling'].includes(task.status), JSON.stringify(task))
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.fail(`Task ${id} did not reach ${states.join('/')}`)
}

test('named run on a real alarm produces verified and indexed artifacts; idempotency replays frozen input', async t => {
  const agent = testPrincipal('compile-run', 'alice')
  const anotherAgent = testPrincipal('compile-run', 'alice', 'user', 'other')
  const runtime = await compileWorker([agent, anotherAgent])
  t.after(() => runtime.dispose())
  const send = api(runtime, agent)
  await initSource(send)
  await post(send, 'compile/create', named)
  const key = 'test:submission:maritime'
  const first = await submit(send, { compile_name: 'Maritime' }, key)
  const done = await getTask(send, first.task_id)
  assert.equal(done.status, 'completed', JSON.stringify(done))
  await expect(send(`/api/v1/tasks/${first.task_id}/cancel`, { method: 'POST', body: {} }), 409)
  assert.equal(done.result.created, 2)
  const runUrl = `/api/v1/compile/runs/${first.task_id}`
  const run = await expect(send(`${runUrl}?compile_name=Maritime`))
  assert.equal(run.meta.mode, 'full')
  assert.equal(run.meta.trigger, 'initial')
  assert.notEqual(run.meta.start_snapshot, run.meta.finish_snapshot)
  const outputs = await expect(send(`${runUrl}/outputs?compile_name=Maritime&limit=1`))
  assert.equal(outputs.outputs[0].uri.endsWith('/index.md'), true)
  assert.equal(outputs.outputs[0].provenance.sources[0].sha256.length, 64)
  assert.equal((await expect(send(`${runUrl}/outputs?compile_name=Maritime&cursor=${encodeURIComponent(outputs.next_cursor)}`))).outputs.length, 1)
  assert.match(await expect(send(fsPath('content/read', `${destination}/index.md`))), /Friday boat guide/)
  const hits = await post(send, 'search/find', { query: 'sailing marine checks', target_uri: destination })
  assert.ok(hits.resources.some(hit => hit.uri.endsWith('/topics/checks.md')))
  const another = api(runtime, anotherAgent)
  await expect(another(`${runUrl}?compile_name=Maritime`), 404)
  await expect(another(`/api/v1/compile/submissions/${key}`), 404)
  await post(send, 'compile/config/update', { ...named, auto_update: false, instruction: 'New instruction for later runs.' })
  assert.equal((await submit(send, { compile_name: 'Maritime' }, key)).task_id, first.task_id)
  assert.equal((await expect(send(`/api/v1/compile/submissions/${key}`))).task_id, first.task_id)
  await expect(send('/api/v1/compile', { method: 'POST', body: { from: [source], to: destination, skill }, headers: { 'Idempotency-Key': key } }), 409)
  assert.equal((await expect(send(`${runUrl}?compile_name=Maritime`))).params.instruction, null)
})

test('bad generation, a failed index, or a cancellation publishes no partial output', async t => {
  const actor = testPrincipal('compile-cancel', 'alice')
  const runtime = await compileWorker([actor])
  t.after(() => runtime.dispose())
  const send = api(runtime, actor)
  await initSource(send)
  for (const [suffix, instruction] of [['citations', 'fixture invalid citation'], ['index', 'fixture index failure'], ['cancel', 'fixture cancellation']]) {
    const to = `${destination}-${suffix}`
    const task = await submit(send, { from: [source], to, skill, instruction })
    if (suffix === 'cancel') {
      await getTask(send, task.task_id, ['running'])
      const cancelling = await post(send, `tasks/${task.task_id}/cancel`, {})
      assert.equal(cancelling.status, 'cancelling')
    }
    assert.equal((await getTask(send, task.task_id)).status, suffix === 'cancel' ? 'cancelled' : 'failed')
    await expect(send(fsPath('fs/stat', to)), 404)
  }
})

test('Rules extracts exact evidence, indexes scenarios and independently judges active rules', async t => {
  const alice = testPrincipal('compile-rules', 'alice')
  const bob = testPrincipal('compile-rules', 'bob')
  const runtime = await compileWorker([alice, bob])
  t.after(() => runtime.dispose())
  const send = api(runtime, alice)
  const search = (actor, task_context) => post(actor, 'rules/search', { task_context })
  const rule = 'Before sailing the boat, check marine safety equipment, except during an emergency departure.'
  const invalid = await post(send, 'rules/compile', { instruction: 'fixture bad evidence' })
  assert.equal((await getTask(send, invalid.task_id)).status, 'failed')
  const first = await post(send, 'rules/compile', { instruction: rule })
  assert.equal(first.task_type, 'rule_compile')
  const done = await getTask(send, first.task_id)
  assert.equal(done.status, 'completed', JSON.stringify(done))
  const operation = done.result.operations[0]
  assert.equal(operation.operation, 'NEW')
  assert.match(await expect(send(fsPath('content/read', operation.uri))), /Preparing to sail/)
  const match = await search(send, 'boat sailing marine safety')
  assert.equal(match.judge, 'workers_ai')
  assert.equal(match.rules[0].atomic_id, operation.atomic_id)
  assert.match(match.rendered, /Check the boat before sailing/)
  assert.equal((await search(send, 'boat sailing marine emergency')).rules.length, 0)
  assert.equal((await search(api(runtime, bob), 'boat sailing marine safety')).rules.length, 0)
  const pause = await post(send, 'rules/compile', { instruction: `Pause rule ${operation.atomic_id}.` })
  assert.equal((await getTask(send, pause.task_id)).status, 'completed')
  assert.equal((await search(send, 'boat sailing marine safety')).rules.length, 0)
  const restore = await post(send, 'rules/compile', { instruction: `Restore rule ${operation.atomic_id}.` })
  assert.equal((await getTask(send, restore.task_id)).status, 'completed')
  assert.equal((await search(send, 'boat sailing marine safety')).rules[0].revision, 3)
  const keep = await post(send, 'rules/compile', { instruction: `Do not archive rule ${operation.atomic_id}.` })
  assert.equal((await getTask(send, keep.task_id)).status, 'failed')
  assert.equal((await search(send, 'boat sailing marine safety')).rules[0].revision, 3)
  const archived = await post(send, 'rules/compile', { instruction: `Archive rule ${operation.atomic_id}.` })
  assert.equal((await getTask(send, archived.task_id)).status, 'completed')
  assert.equal((await search(send, 'boat sailing marine safety')).rules.length, 0)
})

test('incremental reruns register no changes until source bytes change, and never overwrite manual edits', async t => {
  const user = testPrincipal('compile-incremental', 'alice')
  const runtime = await compileWorker([user])
  t.after(() => runtime.dispose())
  const send = api(runtime, user)
  await initSource(send)
  await post(send, 'compile/create', named)
  const run = async () => getTask(send, (await submit(send, { compile_name: named.compile_name })).task_id)
  const first = await run()
  assert.equal(first.status, 'completed')
  const second = await run()
  assert.deepEqual([second.result.created, second.result.updated, second.result.deleted], [0, 0, 0])
  const secondState = await expect(send(`/api/v1/compile/runs/${second.task_id}?compile_name=Maritime`))
  assert.equal(secondState.meta.mode, 'incremental')
  assert.equal(secondState.meta.start_snapshot, secondState.meta.finish_snapshot)
  const text = 'The boat now runs on Saturday. Marine safety checks are still required before sailing.'
  await post(send, 'content/write', { uri: `${source}/notes.md`, content: text })
  const third = await run()
  assert.equal(third.status, 'completed', JSON.stringify(third))
  assert.equal(third.result.updated, 1)
  assert.match(await expect(send(fsPath('content/read', `${destination}/index.md`))), /Saturday boat guide/)
  const output = await expect(send(`/api/v1/compile/runs/${first.task_id}/outputs?compile_name=Maritime`))
  const index = output.outputs.find(item => item.uri.endsWith('/index.md'))
  assert.notEqual(index.latest_snapshot_id, index.snapshot_id)
  assert.match(index.provenance.sources[0].quote, /Friday/)
  await post(send, 'content/write', { uri: `${destination}/index.md`, content: 'Manual correction must remain intact.' })
  assert.equal((await run()).status, 'failed')
  assert.equal(await expect(send(fsPath('content/read', `${destination}/index.md`))), 'Manual correction must remain intact.')
})

test('clear read ACLs do not authorize publishing a restricted source into shared output', async t => {
  const admin = testPrincipal('compile-publication', 'alice', 'admin')
  const bob = testPrincipal('compile-publication', 'bob')
  const other = testPrincipal('compile-other-account', 'alice', 'admin')
  const runtime = await compileWorker([admin, bob, other])
  t.after(() => runtime.dispose())
  const send = api(runtime, admin)
  const shared = 'viking://resources/maritime'
  const restricted = `${shared}/notes.md`
  const target = 'viking://resources/wiki'
  await initSource(send, shared)
  await expect(send('/api/v1/acl', { method: 'PUT', body: { uri: restricted, acl_mode: 'restricted', entries: [] } }))
  const blocked = await submit(send, { from: [shared], to: target, skill })
  assert.equal((await getTask(send, blocked.task_id)).status, 'failed')
  await expect(send(fsPath('fs/stat', target)), 404)
  await expect(api(runtime, bob)(fsPath('content/read', restricted)), 403)
  await expect(api(runtime, other)(`/api/v1/tasks/${blocked.task_id}`), 404)
  const privateRun = await submit(send, { from: [shared], to: destination, skill })
  assert.equal((await getTask(send, privateRun.task_id)).status, 'completed')
  await expect(api(runtime, bob)(fsPath('content/read', 'viking://user/alice/resources/wiki/index.md')), 403)
  await expect(send('/api/v1/compile', { method: 'POST', body: { from: [destination], to: target, skill } }), 403)
})

test('routing embeddings use the bound identity and do not create resource entries', async t => {
  const actor = testPrincipal('compile-embeddings', 'alice')
  const runtime = await compileWorker([actor])
  t.after(() => runtime.dispose())
  const send = api(runtime, actor)
  await initSource(send)
  const empty = await post(send, 'compile/embeddings', { target_uri: source })
  assert.deepEqual(empty.vectors, [])
  const result = await post(send, 'compile/embeddings', { target_uri: source, expected_model: empty.model, texts: ['sailing', 'boat'] })
  assert.deepEqual(result.vectors[0], result.vectors[1])
  assert.equal(result.vectors[0].length, 768)
  await expect(send('/api/v1/compile/embeddings', { method: 'POST', body: { target_uri: source, expected_model: 'not-this-model' } }), 400)
  assert.deepEqual((await expect(send(fsPath('fs/ls', source)))).map(item => item.name), ['notes.md'])
})

test('cancelled pending tasks survive a cold restart without publishing an artifact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-compile-cold-'))
  const actor = testPrincipal('compile-cold', 'alice')
  let runtime = await compileWorker([actor], dir)
  t.after(async () => { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }) })
  let send = api(runtime, actor)
  await initSource(send)
  await post(send, 'compile/create', named)
  const key = 'cold:cancelled:compile:fixture'
  const accepted = await submit(send, { compile_name: 'Maritime' }, key)
  assert.equal(accepted.status, 'pending')
  const cancelled = await post(send, `tasks/${accepted.task_id}/cancel`, {})
  assert.equal(cancelled.status, 'cancelled') // Not a running/cooperative cancellation.
  await runtime.dispose()
  runtime = undefined
  runtime = await compileWorker([actor], dir)
  send = api(runtime, actor)
  const task = await expect(send(`/api/v1/compile/submissions/${key}`))
  assert.equal(task.status, 'cancelled')
  const run = await expect(send(`/api/v1/compile/runs/${task.task_id}?compile_name=Maritime`))
  assert.equal(run.status, 'cancelled')
  assert.equal(run.started_at, null)
  assert.ok(run.finished_at >= run.created_at)
  assert.equal(run.meta.finish_snapshot, null)
  await expect(send(fsPath('content/read', `${destination}/index.md`)), 404)
})

test('Rules consumes a caller-owned staged text as real provenance and keeps failed imports retryable', async t => {
  const alice = testPrincipal('compile-staged', 'alice')
  const bob = testPrincipal('compile-staged', 'bob')
  const runtime = await compileWorker([alice, bob])
  t.after(() => runtime.dispose())
  const send = api(runtime, alice)
  const upload = async text => {
    const boundary = 'compile-test-multipart-fixture'
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sailing.md"\r\nContent-Type: text/markdown\r\n\r\n${text}\r\n--${boundary}--\r\n`
    return expect(send('/api/v1/resources/temp_upload', { method: 'POST', body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }))
  }
  const text = 'Before sailing the boat, check marine safety equipment, except during an emergency departure.'
  const { temp_file_id } = await upload(text)
  const input = { sources: [{ temp_file_id }] }
  await expect(api(runtime, bob)('/api/v1/rules/compile', { method: 'POST', body: input }), 404)
  const task = await post(send, 'rules/compile', input)
  const done = await getTask(send, task.task_id)
  assert.equal(done.status, 'completed', JSON.stringify(done))
  const uri = done.result.source_uris[0]
  assert.match(uri, /^viking:\/\/user\/alice\/resources\/rule-sources\//u)
  assert.equal(await expect(send(fsPath('content/read', uri))), text)
  await expect(send('/api/v1/rules/compile', { method: 'POST', body: input }), 404)

  const rejected = await upload('fixture bad evidence')
  const failedInput = { sources: [{ temp_file_id: rejected.temp_file_id }] }
  const refused = await post(send, 'rules/compile', failedInput)
  assert.equal((await getTask(send, refused.task_id)).status, 'failed')
  const retry = await post(send, 'rules/compile', failedInput)
  assert.equal((await getTask(send, retry.task_id)).status, 'failed')
  assert.deepEqual((await expect(send(fsPath('fs/ls', 'viking://~/resources/rule-sources')))).map(item => item.name), [task.task_id])
})

test('the Studio catalogue returns readable example Skill definitions and Compile can use an installed shared Skill', async t => {
  const admin = testPrincipal('compile-catalogue', 'alice', 'admin')
  const runtime = await compileWorker([admin])
  t.after(() => runtime.dispose())
  const send = api(runtime, admin)
  const root = 'viking://system/compile/example-skills'
  const example = await expect(send(`/api/v1/skills?${new URLSearchParams({ target_uri: root })}`))
  assert.equal(example.skills.length, 4)
  const wiki = example.skills.find(item => item.uri === skill)
  assert.ok(wiki?.description)
  const content = await expect(send(fsPath('content/read', `${wiki.uri}/SKILL.md`)))
  assert.match(content, /^---\nname: llm-wiki\n/u)
  const shared = 'viking://resources/maritime'
  await initSource(send, shared)
  await post(send, 'skills', { target_uri: 'viking://agent/skills',
    data: '---\nname: sailing-report\ndescription: Compile maritime notes as a sailing report.\n---\n\nWrite Markdown only.\n' })
  const to = 'viking://resources/shared-report'
  const launched = await submit(send, { from: [shared], to, skill: 'viking://agent/skills/sailing-report/SKILL.md' })
  assert.equal((await getTask(send, launched.task_id)).status, 'completed')
  assert.match(await expect(send(fsPath('content/read', `${to}/index.md`))), /Friday boat guide/)
})

async function managedKey(runtime, root, account) {
  const response = await api(runtime, root)('/api/v1/admin/accounts', {
    method: 'POST', body: { account_id: account, admin_user_id: 'alice' },
  })
  // Auth responses contain a synthetic key; do not print their body on failure.
  assert.equal(response.status, 200)
  const { result: { user_key: key } } = await response.json()
  assert.equal(typeof key, 'string')
  return { key }
}

test('schedule settings normalize daily/weekly in Beijing time, reject cron and require a managed grant', async t => {
  const root = testPrincipal('root-fixture', 'root', 'root')
  const fixed = testPrincipal('schedule-fixed', 'alice')
  const runtime = await compileWorker([root, fixed])
  t.after(() => runtime.dispose())
  const send = api(runtime, await managedKey(runtime, root, 'schedule-config'))
  await initSource(send)
  const create = (client, args) => client('/api/v1/compile/create', { method: 'POST', body: { ...named, args } })
  assert.equal((await expect(create(send, { auto_update: true, update_schedule: { frequency: 'cron', expression: '* * * * *' } }), 501)).code, 'NOT_IMPLEMENTED')
  await expect(create(send, { cron: '* * * * *' }), 501)
  await expect(create(send, { auto_update: true }), 400)
  await expect(send(fsPath('fs/stat', destination)), 404)
  assert.equal((await expect(create(api(runtime, fixed), { update_schedule: { frequency: 'daily' } }), 412)).code, 'FAILED_PRECONDITION')
  const future = new Date(Date.now() + 60 * 60_000 + 8 * 60 * 60_000)
  const schedule = { frequency: 'weekly', weekday: future.getUTCDay() || 7, minute: future.getUTCMinutes() }
  assert.deepEqual(await expect(create(send, { update_schedule: schedule })), { compile_name: 'Maritime' })
  const url = '/api/v1/compile/config?compile_name=Maritime'
  const first = await expect(send(url))
  assert.equal(first.auto_update, true)
  assert.deepEqual(first.update_schedule, { ...schedule, hour: 0 })
  assert.ok(Date.parse(first.next_triggered_slot) > Date.now())
  assert.match(first.next_triggered_slot, /\+08:00$/u)
  assert.equal(first.last_triggered_slot, null)
  assert.equal(first.last_run_time, null)
  assert.equal(first.next_run_at, first.next_triggered_slot)
  const edit = controls => send('/api/v1/compile/config/update', { method: 'POST', body: { ...named, ...controls } })
  assert.equal((await expect(edit({ auto_update: true, instruction: 'Revise the plan.' }))).next_triggered_slot, first.next_triggered_slot)
  const disabled = await expect(edit({ auto_update: false }))
  assert.equal(disabled.auto_update, false)
  assert.deepEqual(disabled.update_schedule, first.update_schedule)
  assert.equal(disabled.next_triggered_slot, null)
  assert.deepEqual(await expect(send('/api/v1/compile/runs?compile_name=Maritime')), { runs: [], next_cursor: null })
})

test('scheduled Workerd alarm survives cold downtime, deduplicates, rechecks authority and runs cancellable jobs', { timeout: 110_000 }, async t => {
  const root = testPrincipal('root-scheduler-fixture', 'root', 'root')
  const dir = await mkdtemp(join(tmpdir(), 'ov-scheduler-cold-'))
  let runtime = await compileWorker([root], dir)
  t.after(async () => { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }) })
  const create = account => managedKey(runtime, root, account)
  const good = await create('schedule-alarm'), cancel = await create('schedule-cancel-job')
  const revoked = await create('schedule-rotated-key'), disabled = await create('schedule-disabled-plan')
  const aclAdmin = await create('schedule-live-acl')
  const aclSend = api(runtime, aclAdmin)
  const makeBob = await aclSend('/api/v1/admin/accounts/schedule-live-acl/users', { method: 'POST', body: { user_id: 'bob' } })
  assert.equal(makeBob.status, 200)
  const bob = { key: (await makeBob.json()).result.user_key }
  const shared = 'viking://resources/maritime'
  const publicSource = 'viking://resources/public-source'
  const sharedTarget = 'viking://resources/shared-target'
  const acl = (send, uri, entries) => expect(send('/api/v1/acl', { method: 'PUT', body: { uri, acl_mode: 'restricted', entries } }))
  await Promise.all([good, cancel, revoked, disabled].map(key => initSource(api(runtime, key))))
  await initSource(aclSend, shared)
  await initSource(aclSend, publicSource)
  await post(aclSend, 'fs/mkdir', { uri: sharedTarget })
  await acl(aclSend, sharedTarget, [{ principal: 'user:bob', level: 'write' }])
  const leaf = `${shared}/notes.md`
  await acl(aclSend, leaf, [{ principal: 'user:bob', level: 'read' }])
  // Keep one other source document readable after the lesson's ACL is removed;
  // scheduling must not proceed on an accidentally smaller corpus.
  await post(aclSend, 'content/write', { uri: `${shared}/public.md`, content: 'Supplies are counted every Monday.' })

  const deadline = Math.ceil((Date.now() + 18_000) / 60_000) * 60_000
  const clock = new Date(deadline + 8 * 60 * 60_000)
  const daily = { frequency: 'daily', hour: clock.getUTCHours(), minute: clock.getUTCMinutes() }
  const weekly = { ...daily, frequency: 'weekly', weekday: clock.getUTCDay() || 7 }
  const createPlan = (p, plan, values = {}) => post(api(runtime, p), 'compile/create', { ...named, args: { update_schedule: plan }, ...values })
  const config = (p, name = 'Maritime') => expect(api(runtime, p)(`/api/v1/compile/config?compile_name=${name}`))
  const runs = (p, name = 'Maritime') => expect(api(runtime, p)(`/api/v1/compile/runs?compile_name=${name}`))
  await Promise.all([
    createPlan(good, daily), createPlan(cancel, weekly, { instruction: 'fixture scheduled cancellation' }),
    createPlan(revoked, daily), createPlan(disabled, daily), createPlan(bob, daily, { from: [shared] }),
    createPlan(bob, daily, { compile_name: 'Destination', from: [publicSource], to: sharedTarget }),
  ])
  assert.equal(Date.parse((await config(good)).next_triggered_slot), deadline)
  assert.equal(Date.parse((await config(cancel)).next_triggered_slot), deadline)
  assert.equal((await runs(good)).runs.length, 0)
  await expect(api(runtime, good)(fsPath('content/read', `${destination}/index.md`)), 404)

  const rotation = await api(runtime, revoked)('/api/v1/admin/accounts/schedule-rotated-key/users/alice/key', { method: 'POST' })
  assert.equal(rotation.status, 200)
  const replacement = { key: (await rotation.json()).result.user_key }
  await acl(aclSend, leaf, [])
  await acl(aclSend, sharedTarget, [{ principal: 'user:bob', level: 'read' }])
  await post(api(runtime, disabled), 'compile/config/update', { ...named, auto_update: false })
  assert.ok(Date.now() < deadline, 'Fixture changes have to finish before the real slot')
  await runtime.dispose()
  runtime = undefined
  // The SQLite alarm is actually overdue when workerd starts again; no private method,
  // fake clock, synthetic trigger endpoint or direct SQL is used to run the work.
  await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 100)))
  runtime = await compileWorker([root], dir)
  const until = Date.now() + 15_000
  async function observe(read, predicate, description) {
    while (Date.now() < until) {
      const result = await read()
      if (predicate(result)) return result
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    assert.fail(`Real scheduled alarm did not reach ${description}`)
  }
  const cancelSend = api(runtime, cancel)
  const abort = async () => {
    const scheduled = await observe(() => runs(cancel), history => history.runs.length === 1, 'cancellable job')
    const { task_id } = scheduled.runs[0]
    await getTask(cancelSend, task_id, ['running'])
    const response = await post(cancelSend, `tasks/${task_id}/cancel`, {})
    assert.equal(response.status, 'cancelling')
    assert.equal((await getTask(cancelSend, task_id)).status, 'cancelled')
    await expect(cancelSend(fsPath('content/read', `${destination}/index.md`)), 404)
    assert.equal(Date.parse((await config(cancel)).next_triggered_slot), deadline + 7 * 86400_000)
  }
  const complete = async () => {
    const { runs: [run] } = await observe(() => runs(good), history => history.runs[0]?.status === 'completed', 'published daily job')
    const send = api(runtime, good)
    const task = await expect(send(`/api/v1/tasks/${run.task_id}`))
    assert.equal(task.meta.trigger, 'scheduled')
    assert.equal(run.meta.trigger, 'initial')
    assert.equal(Date.parse(run.meta.scheduled_slot), deadline)
    assert.ok(run.created_at * 1000 >= deadline)
    const saved = await config(good)
    assert.equal(saved.last_run_time, run.created_at)
    assert.equal(Date.parse(saved.last_triggered_slot), deadline)
    assert.equal(Date.parse(saved.next_triggered_slot), deadline + 86400_000)
    assert.match(await expect(send(fsPath('content/read', `${destination}/index.md`))), /Friday boat guide/)
    await expect(api(runtime, bob)(`/api/v1/tasks/${task.task_id}`), 404)
  }
  const denied = async (p, want, uri, name = 'Maritime') => {
    const view = await observe(() => config(p, name), value => value.schedule_error === want, want)
    assert.equal(view.auto_update, false)
    assert.equal(view.last_triggered_slot, null)
    assert.equal(view.next_triggered_slot, null)
    assert.deepEqual((await runs(p, name)).runs, [])
    await expect(api(runtime, p)(fsPath('content/read', uri)), 404)
  }
  await Promise.all([abort(), complete(),
    denied(replacement, 'COMPILE_CREDENTIAL_INVALID', `${destination}/index.md`),
    denied(bob, 'COMPILE_SCHEDULE_ACCESS_DENIED', `${destination}/index.md`),
    denied(bob, 'COMPILE_SCHEDULE_ACCESS_DENIED', `${sharedTarget}/index.md`, 'Destination'),
  ])
  assert.deepEqual((await runs(disabled)).runs, [])
  assert.equal((await config(disabled)).next_triggered_slot, null)
  assert.equal((await runs(good)).runs.length, 1)
  assert.equal((await runs(cancel)).runs.length, 1)
  await expect(api(runtime, revoked)('/api/v1/compile/config?compile_name=Maritime'), 401)
})
