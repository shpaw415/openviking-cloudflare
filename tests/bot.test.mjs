// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { api as client, localWorker, testPrincipal } from './support/local-worker.mjs'

let script
before(async () => {
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('./bot/fixture.mjs', import.meta.url))],
    bundle: true, external: ['cloudflare:workers'], format: 'esm', write: false })
  script = outputFiles[0].text
})

function start(resourcePersistencePath, mode = 'model') {
  return new Miniflare({
    ...convertV4MiniflareOptions({ script, modules: true, name: 'bot-fixture', host: '127.0.0.1', port: 0, cf: false,
      compatibilityDate: '2026-11-19', durableObjects: { BOT_SQL: { className: 'BotFixture', useSQLite: true } }, bindings: { MODE: mode } }),
    resourcePersistencePath, enableDevRegistry: false, telemetry: { enabled: false }, logRequests: false,
  })
}

const bot = '/bot/v1', api = '/api/v1'
const experience = 'viking://~/memories/experiences/Harbor notes.md'
const experienceUri = 'viking://user/alice/memories/experiences/Harbor notes.md'
function request(worker, path, { method = 'GET', principal = 'alice', body, signal } = {}) {
  return worker.dispatchFetch(`http://local.invalid${path}`, { method, headers: { 'test-principal': principal,
    ...(body !== undefined && { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal })
}
async function json(worker, path, { status = 200, ...options } = {}) {
  const response = await request(worker, path, options)
  const payload = await response.json()
  assert.equal(response.status, status, JSON.stringify(payload))
  return payload.result ?? payload
}
const chat = (worker, body, opts) => json(worker, `${bot}/chat`, { method: 'POST', body, ...opts })
const detail = (worker, id, opts) => json(worker, `${bot}/sessions/${id}`, opts)
const setFile = (worker, uri, content, principal, extra) => json(worker, `${api}/content/write`, { method: 'POST', principal,
  body: { uri, content, processing_mode: 'vectors_only', ...extra } })
const active = async (worker, question) => {
  const status = `/fixture/model?${new URLSearchParams({ question })}`
  for (let i = 0; i < 100; i++) {
    if ((await json(worker, status)).pending) return () => json(worker, status, { method: 'POST' })
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('Local provider never reached its controlled wait')
}
function events(text) {
  return text.split('\n\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}

const query = (route, values) => `${api}/agent-evolution/experiences/${route}?${new URLSearchParams({ experience_uri: experience, ...values })}`
const trajectoryContent = uri => `${api}/content/read?${new URLSearchParams({ uri })}`
const counts = result => Object.fromEntries(result.outcome_distribution.map(x => [x.outcome, x.count]))
async function seedExperience(worker) {
  await json(worker, `${api}/fs/mkdir`, { method: 'POST', body: { uri: 'viking://~/memories/experiences' } })
  await setFile(worker, experience, 'Harbor tide checklist: inspect the eastern breakwater.')
}
const rawSession = (worker, id) => json(worker, `${api}/sessions`, { method: 'POST', body: { session_id: id, memory_policy: { memory_types: [] } } })
const commit = (worker, id, body) => json(worker, `${api}/sessions/${id}/commit`, { method: 'POST', body: { wait: true, ...body } })
const feedback = (worker, id, responseId, options, requestOptions) => json(worker, `${bot}/feedback`, { method: 'POST',
  body: { session_id: id, response_id: responseId, ...options }, ...requestOptions })

test('Experience evolution counts only a real submitted, sealed turn and latest feedback; survives restart', { timeout: 25_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-evolution-'))
  let worker = start(dir)
  try {
    await seedExperience(worker)
    const id = 'trace-owner'
    await rawSession(worker, id)
    const reply = await chat(worker, { session_id: id, message: 'How do I inspect the harbor?' })
    assert.match(reply.message, /eastern breakwater/)
    assert.equal((await json(worker, query('trajectories'))).total, 0)
    assert.equal((await feedback(worker, id, reply.response_id, { feedback_type: 'thumb_up' })).accepted, true)
    await feedback(worker, 'other-session', reply.response_id, { feedback_type: 'thumb_up' }, { status: 404 })
    await feedback(worker, id, reply.response_id, { feedback_type: 'rating' }, { status: 400 })
    assert.equal((await commit(worker, id, { keep_recent_count: 1 })).status, 'completed')
    assert.equal((await json(worker, query('trajectories'))).total, 0)
    await commit(worker, id)
    const first = await json(worker, query('trajectories', { limit: '1' }))
    assert.equal(first.experience_uri, experienceUri)
    assert.equal(first.total, 1)
    assert.match(first.items[0].description, /success/)
    const uri = first.items[0].uri
    assert.match(await json(worker, trajectoryContent(uri)), /Archive: archive_002/)
    assert.match(await json(worker, trajectoryContent(uri)), /Stored assistant response/)
    assert.equal(counts(await json(worker, query('outcomes'))).success, 1)
    assert.equal((await json(worker, query('trajectories', { offset: '1' }))).items.length, 0)
    const today = first.items[0].created_at.slice(0, 10)
    assert.equal(counts(await json(worker, query('outcomes', { start_date: today, end_date: today }))).success, 1)
    assert.equal((await json(worker, query('trajectories', { end_date: '2001-01-01' }))).total, 0)
    await json(worker, query('outcomes', { start_date: '2026-02-30' }), { status: 400 })

    await worker.dispose()
    worker = start(dir)
    assert.equal((await json(worker, query('trajectories'))).items[0].uri, uri)
    assert.deepEqual(counts(await json(worker, query('outcomes'))), { success: 1, failure: 0, partial: 0, unknown: 0, unfinished: 0 })
    assert.equal((await json(worker, query('trajectories'), { principal: 'agent' })).total, 0)
    await json(worker, trajectoryContent(uri), { principal: 'agent', status: 404 })
    await json(worker, query('outcomes', { experience_uri: experienceUri }), { principal: 'bob', status: 403 })
    await feedback(worker, id, reply.response_id, { feedback_type: 'thumb_down' }, { principal: 'agent', status: 404 })
    await feedback(worker, id, reply.response_id, { feedback_type: 'rating', feedback_score: -0.5 })
    assert.deepEqual(counts(await json(worker, query('outcomes'))), { success: 0, failure: 1, partial: 0, unknown: 0, unfinished: 0 })
    await json(worker, `${api}/sessions/${id}`, { method: 'DELETE' })
    assert.equal((await json(worker, query('trajectories'))).total, 0)
    await json(worker, trajectoryContent(uri), { status: 404 })
    await feedback(worker, id, reply.response_id, { feedback_type: 'thumb_up' }, { status: 404 })
  } finally { await worker.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('interrupted Experience use is unfinished, unscored responses are unknown, and path reuse is not lineage', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  await seedExperience(worker)
  const id = 'trace-states'
  await rawSession(worker, id)
  const waiting = await request(worker, `${bot}/chat/stream`, { method: 'POST', body: { session_id: id, message: 'Hold harbor' } })
  const transcript = waiting.text().then(text => ({ text }), error => ({ error }))
  const release = await active(worker, 'Hold harbor')
  try {
    await json(worker, `${bot}/sessions/${id}/interrupt`, { method: 'POST' })
    const received = await transcript
    if (received.error) throw received.error
    assert.equal(events(received.text)[0].event, 'interrupt')
  } finally { await release() }
  const answer = await chat(worker, { session_id: id, message: 'Review the harbor checklist.' })
  await feedback(worker, id, answer.response_id, { feedback_type: 'rating', feedback_score: 0 })
  await json(worker, `${api}/sessions/${id}/messages`, { method: 'POST', body: { role: 'assistant', parts: [
    { type: 'context', uri: experience, abstract: 'A user-authored citation.' },
  ] } })
  await commit(worker, id)
  assert.deepEqual(counts(await json(worker, query('outcomes'))), { success: 0, failure: 0, partial: 0, unknown: 1, unfinished: 1 })
  const page = await json(worker, query('trajectories', { limit: '1' }))
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(page.has_more, true)
  const next = await json(worker, query('trajectories', { limit: '1', offset: '1' }))
  assert.notEqual(next.items[0].uri, page.items[0].uri)
  const path = `${api}/fs?${new URLSearchParams({ uri: experience })}`
  await json(worker, path, { method: 'DELETE' })
  await json(worker, query('outcomes'), { status: 404 })
  await setFile(worker, experience, 'Different harbor plan, same filename.')
  assert.equal((await json(worker, query('trajectories'))).total, 0)
  await json(worker, trajectoryContent(page.items[0].uri), { status: 404 })
})

test('real turn retention caps each actor without rolling out another agent’s evidence', { timeout: 25_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  await seedExperience(worker)
  const id = 'bounded-traces'
  await rawSession(worker, id)
  await json(worker, `${api}/sessions`, { method: 'POST', principal: 'agent', body: { session_id: id, memory_policy: { memory_types: [] } } })
  const independent = await chat(worker, { session_id: id, message: 'Check harbor independently' }, { principal: 'agent' })
  await json(worker, `${api}/sessions/${id}/commit?wait=true`, { method: 'POST', principal: 'agent' })
  const first = await chat(worker, { session_id: id, message: 'Harbor first' })
  // This is one shared SQLite instance. Each row is produced through chat;
  // the quota proof doesn't seed a synthetic trajectory or manipulate counts.
  for (let i = 1; i <= 128; i++) await chat(worker, { session_id: id, message: `Harbor check ${i}` })
  await commit(worker, id)
  assert.equal((await json(worker, query('trajectories', { limit: '1000' }))).total, 128)
  assert.equal((await json(worker, query('trajectories'), { principal: 'agent' })).total, 1)
  await feedback(worker, id, first.response_id, { feedback_type: 'thumb_up' }, { status: 404 })
  assert.equal((await feedback(worker, id, independent.response_id, { feedback_type: 'thumb_up' }, { principal: 'agent' })).accepted, true)
  assert.equal((await json(worker, `${api}/sessions/${id}`)).total_message_count, 258)
})

test('health is a binding readiness check; no-reply really stores the input without a model', { timeout: 20_000 }, async t => {
  const worker = start(undefined, 'no-model')
  t.after(() => worker.dispose())
  assert.equal((await json(worker, `${bot}/health`, { status: 503 })).generation, 'not_configured')
  assert.equal((await chat(worker, { message: 'Hello', session_id: 'future' }, { status: 503 })).error.code, 'GENERATION_UNAVAILABLE')
  await detail(worker, 'future', { status: 404 })
  const saved = await chat(worker, { message: 'Log this note', need_reply: false })
  assert.equal(saved.response_id, null)
  assert.equal(saved.message, '')
  assert.equal((await detail(worker, saved.session_id)).turn.status, 'no_reply')
  assert.deepEqual((await detail(worker, saved.session_id)).messages.map(m => m.content), ['Log this note'])
})

test('chat uses authorized vector results, real session history, and survives a workerd restart', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-bot-'))
  let worker = start(dir)
  try {
    assert.equal((await json(worker, `${bot}/health`)).generation, 'configured_not_probed')
    await setFile(worker, 'viking://~/resources/harbor.md', 'Harbor buoy number seven.', 'alice')
    await setFile(worker, 'viking://~/resources/bobs-harbor.md', 'Harbor Bob private source.', 'bob')
    const first = await chat(worker, { message: 'Harbor status?', session_id: 'bridge', user_id: 'bob',
      openviking_connection: { user_id: 'bob', role: 'admin' } })
    assert.match(first.message, /Harbor buoy number seven/)
    assert.doesNotMatch(first.message, /Bob private/)
    assert.equal(first.token_usage.total_tokens, 30)
    assert.match(first.response_id, /^msg_/)
    for (const principal of ['bob', 'agent', 'elsewhere']) {
      await detail(worker, 'bridge', { principal, status: 404 })
      assert.equal((await json(worker, `${bot}/sessions`, { principal })).total, 0)
    }
    await worker.dispose()
    worker = start(dir)
    const recovered = await detail(worker, 'bridge')
    assert.equal(recovered.turn.response_id, first.response_id)
    assert.equal(recovered.turn.status, 'completed')
    assert.deepEqual(recovered.messages.map(m => m.role), ['user', 'assistant'])
    assert.equal((await json(worker, `${api}/sessions/bridge`)).total_message_count, 2)
    const next = await chat(worker, { message: 'Continue?', session_id: 'bridge' })
    assert.match(next.message, /Prior question: Harbor status\?/)
    const counted = await json(worker, `${api}/stats/sessions/bridge`)
    assert.equal(counted.total_turns, 2)
    const created = await json(worker, `${bot}/sessions`, { method: 'POST', body: { metadata: { title: 'New' } } })
    assert.equal((await json(worker, `${bot}/sessions`)).total, 2)
    assert.deepEqual(await detail(worker, created.session_id, { method: 'DELETE' }), { deleted: true })
    await json(worker, `${api}/sessions/${created.session_id}`, { status: 404 })
  } finally { await worker.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('VikingBot retrieves the real memory created by committing an earlier bot conversation', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const source = await chat(worker, { message: 'The harbor cleanup was confirmed for low tide.' })
  const commit = await json(worker, `${api}/sessions/${source.session_id}/commit`, { method: 'POST', body: { wait: true } })
  assert.equal(commit.memories_extracted, 1)
  const next = await chat(worker, { message: 'What was planned for the harbor?' })
  assert.match(next.message, /confirmed a cleanup at low tide/)
  assert.equal(JSON.parse(next.relevant_memories)[0].uri, commit.memory_uris[0])
})

test('SSE sends the upstream terminal event shape and only acknowledges an already-durable reply', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const response = await request(worker, `${bot}/chat/stream`, { method: 'POST', body: { message: 'A reply\non two lines' } })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const id = response.headers.get('x-vikingbot-session-id')
  assert.ok(id)
  const frame = events(await response.text())
  assert.equal(frame.length, 1)
  assert.equal(frame[0].event, 'response')
  assert.equal(frame[0].data.content, 'A reply\non two lines')
  assert.ok(Number.isFinite(Date.parse(frame[0].timestamp)))
  assert.equal((await detail(worker, id)).turn.response_id, frame[0].data.response_id)
})

test('interrupt releases the turn but rejects late output even after deletion and recreation', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const path = `${bot}/sessions/interruption`, session = `${api}/sessions/interruption`
  const response = await request(worker, `${bot}/chat/stream`, { method: 'POST', body: { message: 'Hold first turn', session_id: 'interruption' } })
  const transcript = response.text().then(text => ({ text }), error => ({ error }))
  const release = await active(worker, 'Hold first turn')
  try {
    assert.equal((await detail(worker, 'interruption')).turn.status, 'running')
    assert.equal((await chat(worker, { message: 'Concurrent', session_id: 'interruption' }, { status: 409 })).error.code, 'CONFLICT')
    await json(worker, `${session}/commit`, { method: 'POST', status: 409 })
    await json(worker, session, { method: 'DELETE', status: 409 })
    const interrupt = `${path}/interrupt`
    assert.deepEqual(await json(worker, interrupt, { method: 'POST', principal: 'bob' }), { interrupted: false })
    assert.deepEqual(await json(worker, interrupt, { method: 'POST' }), { interrupted: true })
    const received = await transcript
    if (received.error) throw received.error
    assert.equal(events(received.text)[0].event, 'interrupt')
    assert.equal((await detail(worker, 'interruption')).turn.status, 'interrupted')
    assert.deepEqual((await detail(worker, 'interruption')).messages.map(m => m.role), ['user'])
    await json(worker, path, { method: 'DELETE' })
    await chat(worker, { message: 'New conversation', session_id: 'interruption' })
  } finally { await release() }
  assert.deepEqual((await detail(worker, 'interruption')).messages.map(m => m.content), ['New conversation', 'New conversation'])
})

test('failed or oversized provider output never adds a reply; missing usage is not invented', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  for (const [message, status, code] of [['Temporary failure', 429, 'RATE_LIMITED'], ['Large output', 502, 'INVALID_MODEL_OUTPUT']]) {
    const failed = await chat(worker, { message, session_id: 'errors' }, { status })
    assert.equal(failed.error.code, code)
  }
  const sse = await request(worker, `${bot}/chat/stream`, { method: 'POST', body: { message: 'Temporary failure', session_id: 'errors' } })
  const [event] = events(await sse.text())
  assert.equal(event.event, 'response')
  assert.equal(event.data.code, 'RATE_LIMITED')
  assert.ok(event.data.error)
  assert.equal((await detail(worker, 'errors')).turn.status, 'failed')
  assert.deepEqual((await detail(worker, 'errors')).messages.map(m => m.role), ['user', 'user', 'user'])
  const reply = await chat(worker, { message: 'Unknown usage', session_id: 'errors' })
  assert.deepEqual(reply.token_usage, { prompt_tokens: 25 })
  assert.equal((await json(worker, `${api}/sessions/errors`)).llm_token_usage.unknown_calls, 1)
})

test('an indexed source changed during generation invalidates the pending answer', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const uri = 'viking://~/resources/tide.md'
  await setFile(worker, uri, 'Tide forecast at noon.', 'alice')
  const response = await request(worker, `${bot}/chat/stream`, { method: 'POST', body: { message: 'Hold tide', session_id: 'changed' } })
  const release = await active(worker, 'Hold tide')
  try { await setFile(worker, uri, 'Tide forecast changed to evening.', 'alice') } finally { await release() }
  const [last] = events(await response.text())
  assert.equal(last.data.code, 'CONTEXT_CHANGED')
  assert.deepEqual((await detail(worker, 'changed')).messages.map(m => m.role), ['user'])
})

test('parent gate authenticates the native bot and forwards SSE from its real workspace RPC', { timeout: 20_000 }, async t => {
  const owner = testPrincipal('bot-local', 'chat-owner'), other = testPrincipal('bot-local', 'chat-other', 'admin')
  const worker = await localWorker({ principals: [owner, other], embeddings: 'fixture', vars: { OPENVIKING_EDGE_GENERATION: '1' } })
  t.after(() => worker.dispose())
  const denied = await client(worker)(`${bot}/health`)
  assert.equal(denied.status, 401)
  await denied.body?.cancel()
  const uri = 'viking://~/memories/experiences/binding-proof.md'
  const send = client(worker, owner)
  const seedDir = await send(`${api}/fs/mkdir`, { method: 'POST', body: { uri: 'viking://~/memories/experiences' } })
  assert.equal(seedDir.status, 200)
  await seedDir.body?.cancel()
  const seedFile = await send(`${api}/content/write`, { method: 'POST', body: { uri, content: 'Local binding smoke evidence.', processing_mode: 'vectors_only' } })
  assert.equal(seedFile.status, 200)
  await seedFile.body?.cancel()
  assert.equal((await (await client(worker, owner)(`${bot}/health`)).json()).status, 'healthy')
  const response = await client(worker, owner)(`${bot}/chat/stream`, { method: 'POST', body: { message: 'Local binding smoke', session_id: 'mounted' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-vikingbot-session-id'), 'mounted')
  const [end] = events(await response.text())
  assert.equal(end.event, 'response')
  assert.match(end.data.response_id, /^msg_/)
  const snapshot = await (await client(worker, owner)(`${api}/sessions/mounted/context`)).json()
  assert.equal(snapshot.result.messages[1].id, end.data.response_id)
  const commit = await send(`${api}/sessions/mounted/commit?wait=true`, { method: 'POST' })
  assert.equal(commit.status, 200)
  await commit.body?.cancel()
  const trace = await send(query('trajectories', { experience_uri: uri }))
  assert.equal(trace.status, 200)
  const listed = (await trace.json()).result
  assert.equal(listed.total, 1)
  const traceRead = await send(trajectoryContent(listed.items[0].uri))
  assert.equal(traceRead.status, 200)
  assert.match((await traceRead.json()).result, /binding-proof/)
  const isolated = await client(worker, other)(`${bot}/sessions/mounted`)
  assert.equal(isolated.status, 404)
  await isolated.body?.cancel()
})
