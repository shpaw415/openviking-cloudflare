// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { api as client, localWorker, testPrincipal } from './support/local-worker.mjs'

const base = '/api/v1/sessions'
const root = fileURLToPath(new URL('../', import.meta.url))
let script

before(async () => {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: root,
      contents: `
        import { DurableObject } from 'cloudflare:workers';
        import { initSessions, routeSessions, runSessionCommit } from './src/sessions.js';
        import { initFilesystem, routeFilesystem } from './src/filesystem.js';
        import { assertJobRunning, claimJob, completeJob, finishJobInTransaction, initTasks, jobAccess, routeTasks, scheduleNextJob } from './src/tasks.js';
        import { ApiError, apiError } from './src/http.js';
        const principals = {
          owner: { accountId: 'demo', userId: 'alice', agentId: 'studio', role: 'user' },
          agent: { accountId: 'demo', userId: 'alice', agentId: 'cli', role: 'user' },
          admin: { accountId: 'demo', userId: 'bob', agentId: 'studio', role: 'admin' },
          account: { accountId: 'other', userId: 'alice', agentId: 'studio', role: 'user' },
        };
        export class SessionFixture extends DurableObject {
          paused;
          unblocked = false;
          context(caller) {
            const storage = this.ctx.storage, sql = storage.sql;
            if (!this.initialized) this.initialize(sql, storage, { sql, storage, caller });
            const ctx = { sql, storage, caller, embed: async texts => {
              if (this.env.AI_MODE === 'second-embed-fails' && texts.some(text => text.includes('relaunch proof'))) {
                throw new ApiError(429, 'RATE_LIMITED', 'Fixture embedding quota.');
              }
              if (this.env.AI_MODE === 'pause-index' && !this.unblocked) await new Promise(resolve => { this.paused = resolve; });
              return texts.map(() => [1, 0, 0]);
            } };
            if (this.env.AI_MODE) ctx.generate = async ([system, data]) => {
              const { transcript, previous } = JSON.parse(data.content);
              if (system.content.startsWith('Write a factual')) {
                return { text: (previous ? previous + ' ' : '') + 'Recap: marina cleanup confirmed.', inputTokens: 13, outputTokens: 7 };
              }
              if (this.env.AI_MODE === 'malformed' || (this.env.AI_MODE === 'mixed' && transcript[0].text === 'Bad first archive')) {
                return { text: '{"events":[{"page_id":101,"ranges":"999"}]}', inputTokens: 15, outputTokens: 9 };
              }
              if (this.env.AI_MODE === 'delayed') await new Promise(resolve => setTimeout(resolve, 450));
              const events = transcript[0].text.includes('No event') ? [] : [
                { page_id: 100, event_name: 'marina cleanup', goal: 'volunteer planning', summary: 'Marina cleanup confirmed.', ranges: '0' },
              ];
              if (transcript.some(line => line.text.includes('two events'))) events.push(
                { page_id: 101, event_name: 'second date', goal: 'planning', summary: 'The relaunch proof was recorded.', ranges: '0' });
              return { text: JSON.stringify({events}), inputTokens: 15, outputTokens: 9 };
            };
            if (this.env.JOBS) ctx.jobs = jobAccess(ctx, 'fixture-local-authority', new Set(['session_commit']));
            return ctx;
          }
          async fetch(request) {
            const caller = principals[request.headers.get('test-principal') ?? 'owner'];
            try {
              const ctx = this.context(caller), url = new URL(request.url);
              if (url.pathname === '/fixture/index') {
                if (request.method === 'POST') { this.unblocked = true; this.paused?.(); this.paused = undefined; }
                return Response.json({ status: 'ok', result: Boolean(this.paused) });
              }
              return await routeSessions(request, url, ctx) ??
                (this.env.JOBS ? await routeTasks(request, url, ctx) : undefined) ??
                await routeFilesystem(request, url, ctx) ??
                new Response(null, { status: 404, headers: { 'test-fallthrough': 'true' } });
            } catch (error) {
              return apiError(error, 'sessions-test');
            }
          }
          initialize(sql, storage, ctx) {
              storage.transactionSync(() => {
                initSessions(ctx);
                initFilesystem(ctx);
                if (this.env.JOBS) initTasks(sql);
                // Seed only counters near a quota; the append/commit/delete under test use real rows.
                let index = 0;
                for (const [user, bytes, messages, copies = 1] of this.env.QUOTA_SEED) {
                  for (let i = 0; i < copies; ++i) {
                    sql.exec("INSERT INTO ov_sessions (account_id,user_id,agent_id,session_id,created_at,updated_at," +
                      "message_bytes,total_message_count) VALUES ('demo',?,'seed',?,'','',?,?)",
                      user, 'quota-seed-' + (++index), bytes, messages);
                  }
                }
                // Storage-failure fixtures; never installed by the session module.
                if (this.env.FORCE_SQL_FAILURE) {
                  sql.exec("CREATE TRIGGER IF NOT EXISTS test_append_failure BEFORE INSERT ON ov_session_messages " +
                    "WHEN (NEW.session_id = 'fresh-rollback' AND NEW.seq = 2) OR " +
                    "(NEW.session_id = 'existing-rollback' AND NEW.seq = 3) " +
                    "BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
                  sql.exec("CREATE TRIGGER IF NOT EXISTS test_archive_failure BEFORE UPDATE OF commit_count ON ov_sessions " +
                    "WHEN NEW.session_id = 'archive-rollback' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
                }
              });
              this.initialized = true;
          }
          async alarm() {
            const storage = this.ctx.storage;
            this.context(principals.owner);
            const job = await claimJob(storage);
            if (!job) return;
            try {
              const ctx = this.context(job.actor);
              ctx.taskId = job.taskId;
              ctx.assertActive = () => assertJobRunning(ctx.sql, job.taskId);
              ctx.finishJobInTransaction = result => finishJobInTransaction(ctx.sql, job.taskId, result);
              const result = await runSessionCommit({ ...job.payload, taskId: job.taskId }, ctx);
              completeJob(storage, job.taskId, result, 'ok');
            } catch { completeJob(storage, job.taskId, null, 'failed'); }
            finally { await scheduleNextJob(storage); }
          }
        }
        export default {
          fetch(request, env) {
            // Force all principals into the very same SQLite instance.
            return env.TEST_SESSIONS.getByName('shared-fixture').fetch(request);
          }
        };`,
    },
    external: ['cloudflare:workers'],
    bundle: true,
    write: false,
    format: 'esm',
  })
  script = outputFiles[0].text
})

function start(persist, forceSqlFailure = false, quotaSeed = [], { model = '', jobs = false } = {}) {
  return new Miniflare({
    ...convertV4MiniflareOptions({
      script, modules: true, name: 'sessions-fixture', host: '127.0.0.1', port: 0, cf: false,
      compatibilityDate: '2026-11-19',
      durableObjects: { TEST_SESSIONS: { className: 'SessionFixture', useSQLite: true } },
      bindings: { FORCE_SQL_FAILURE: forceSqlFailure, QUOTA_SEED: quotaSeed, AI_MODE: model, JOBS: jobs },
    }),
    enableDevRegistry: false,
    resourcePersistencePath: persist,
    logRequests: false,
    telemetry: { enabled: false },
  })
}

async function eventual(read, accept) {
  for (let i = 0; i < 100; i++) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Expected durable state never became visible')
}

test('upstream pinned session commit cases: unchanged assertions over the mounted Workerd', { timeout: 25_000 }, async t => {
  const names = ['test_session_commit_flow', 'test_session_commit_returns_task_id', 'test_session_commit_empty_session']
  const actor = testPrincipal('strict-pinned-commit', 'owner')
  const worker = await localWorker({ principals: [actor], embeddings: 'fixture', vars: { OPENVIKING_EDGE_GENERATION: '1' } })
  t.after(() => worker.dispose())
  const send = client(worker, actor)
  for (const name of names) await t.test(name, async () => {
    const child = spawn('python3', ['-I', '-B', fileURLToPath(new URL('./bot/original-commit.py', import.meta.url)), name], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000,
    })
    let err = '', commit
    child.stderr.setEncoding('utf8').on('data', chunk => { if (err.length < 8192) err += chunk })
    const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    const seen = []
    try {
      for await (const line of createInterface({ input: child.stdout })) {
        const req = JSON.parse(line)
        assert.match(req.path, /^\/api\/v1\/sessions(?:\/[a-zA-Z0-9_.@-]+(?:\/(?:messages|commit))?)?$/)
        assert.ok(['POST', 'DELETE'].includes(req.method))
        assert.ok(seen.length < 5)
        seen.push(req.op)
        const response = await send(req.path, { method: req.method, body: req.body ?? undefined })
        const json = await response.json()
        if (req.op === 'session_commit') {
          assert.deepEqual(req.body, {})
          commit = { http: response.status, result: json.result }
        }
        if (req.op === 'delete_session') assert.equal(response.status, 200)
        child.stdin.write(JSON.stringify({ status_code: response.status, json }) + '\n')
      }
      assert.equal(await exit, 0, err)
      const empty = name.endsWith('empty_session')
      assert.deepEqual(seen, ['create_session', ...(empty ? [] : ['add_message', 'add_message']), 'session_commit', 'delete_session'])
      assert.equal(commit.http, 200)
      assert.equal(commit.result.status, empty ? 'skipped' : 'accepted')
      if (!empty) {
        assert.equal(typeof commit.result.task_id, 'string')
        assert.ok(commit.result.task_id.length > 0)
        assert.equal(commit.result.archived, true)
      }
    } finally { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill() }
  })
  t.diagnostic(`Parent bundle SHA-256 ${worker.localBuildSha256}`)
})

test('original default commit contract: both nonempty cases yield a real task and a sealed archive on the parent Worker', { timeout: 25_000 }, async t => {
  const actor = testPrincipal('strict-local-commit', 'owner')
  const worker = await localWorker({ principals: [actor], embeddings: 'fixture', vars: { OPENVIKING_EDGE_GENERATION: '1' } })
  t.after(() => worker.dispose())
  const send = client(worker, actor)
  const result = async (path, options) => {
    const reply = await send(path, options)
    const body = await reply.json()
    assert.equal(reply.status, 200, JSON.stringify(body))
    assert.equal(body.status, 'ok')
    return body.result
  }
  for (const [question, answer] of [['I prefer Python for scripting.', 'Python is great for scripting.'],
    ['I love machine learning.', 'ML is fascinating!']]) {
    const created = await result(base, { method: 'POST', body: {} })
    const path = `${base}/${created.session_id}`
    for (const [role, content] of [['user', question], ['assistant', answer]]) await result(`${path}/messages`, { method: 'POST', body: { role, content } })
    // Original client sends {}. No wait query/body override and same assertion:
    // a real task_id is a nonempty string. Also prove the stronger lifecycle.
    const accepted = await result(`${path}/commit`, { method: 'POST', body: {} })
    assert.equal(accepted.session_id, created.session_id)
    assert.equal(typeof accepted.task_id, 'string')
    assert.ok(accepted.task_id.length > 0)
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.archived, true)
    assert.match(accepted.archive_uri, /archive_001$/)
    assert.equal((await result(path)).message_count, 0)
    const archive = await result(`${path}/archives/archive_001`)
    assert.deepEqual(keptText(archive.messages), [question, answer])
    const task = `/api/v1/tasks/${accepted.task_id}`
    const terminal = await eventual(() => result(task), row => ['completed', 'failed', 'cancelled'].includes(row.status))
    assert.equal(terminal.status, 'completed')
    assert.equal(terminal.task_type, 'session_commit')
    assert.equal(terminal.result.archive_uri, accepted.archive_uri)
    await result(path, { method: 'DELETE' })
  }
  const empty = await result(base, { method: 'POST', body: {} })
  const skipped = await result(`${base}/${empty.session_id}/commit`, { method: 'POST', body: {} })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.task_id, null)
  t.diagnostic(`Parent bundle SHA-256 ${worker.localBuildSha256}`)
})

test('failed synchronous phase 1 rolls back the pending job and the archive together', { timeout: 20_000 }, async t => {
  const worker = start(undefined, true, [], { jobs: true, model: 'good' })
  t.after(() => worker.dispose())
  const path = '/archive-rollback'
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'The marina date was agreed.' })
  await fails(worker, 500, 'INTERNAL_ERROR', 'POST', `${path}/commit`, {})
  assert.equal((await ok(worker, 'GET', path)).message_count, 1)
  assert.deepEqual(await api(worker, '/api/v1/tasks?resource_id=archive-rollback'), [])
  await fails(worker, 404, 'NOT_FOUND', 'GET', `${path}/archives/archive_001`)
})

async function request(worker, method, path = '', body, principal = 'owner') {
  const headers = { 'test-principal': principal }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await worker.dispatchFetch(`http://local.invalid${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, payload: response.headers.has('test-fallthrough') ? null : await response.json() }
}

async function ok(worker, method, path, body, principal) {
  const { status, payload } = await request(worker, method, path, body, principal)
  assert.equal(status, 200, JSON.stringify(payload))
  assert.equal(payload.status, 'ok')
  return payload.result
}

async function fails(worker, status, code, method, path, body, principal) {
  const reply = await request(worker, method, path, body, principal)
  assert.equal(reply.status, status, JSON.stringify(reply.payload))
  assert.equal(reply.payload.status, 'error')
  assert.equal(reply.payload.error.code, code)
  return reply.payload.error.message
}

async function api(worker, path, { method = 'GET', body, principal = 'owner', status = 200 } = {}) {
  const response = await worker.dispatchFetch(`http://local.invalid${path}`, {
    method, headers: { 'test-principal': principal, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(response.status, status, JSON.stringify(payload))
  return status === 200 ? payload.result : payload.error
}

test('semantic commit writes a searchable, tagged memory and recovers a cumulative recap until reset', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [], { model: 'good' })
  t.after(() => worker.dispose())
  const path = '/marina'
  const created = await ok(worker, 'POST', '', { session_id: 'marina', memory_policy: { memory_types: ['events'] },
    memory_extraction_config: { events: { tags: ['team=original'] } } })
  assert.deepEqual(created.memory_extraction_config.events.tags, ['team=original'])
  await ok(worker, 'PATCH', `${path}/config`, { memory_extraction_config: { events: { tags: ['team=patch'] } } })
  await fails(worker, 404, 'NOT_FOUND', 'PATCH', `${path}/config`, {}, 'agent')
  await ok(worker, 'POST', `${path}/messages/batch`, { messages: [
    { role: 'user', content: 'The marina cleanup was confirmed for Saturday.', created_at: '2026-11-18T00:00:00Z' },
    { role: 'assistant', content: 'I recorded the date.' },
    { role: 'user', content: 'Tail' },
  ] })
  const result = await ok(worker, 'POST', `${path}/commit`, { wait: true, keep_recent_count: 1, enable_working_memory: true })
  assert.equal(result.status, 'completed')
  assert.equal(result.task_id, null)
  assert.equal(result.memories_extracted, 1)
  const [uri] = result.memory_uris
  assert.match(uri, /^viking:\/\/user\/alice\/memories\/events\/2026\/11\/18\/marina cleanup-/)
  const file = await api(worker, `/api/v1/content/read?${new URLSearchParams({ uri })}`)
  assert.match(file, /Marina cleanup confirmed\./)
  assert.match(file, /confirmed for Saturday/)
  assert.doesNotMatch(file, /recorded the date|Tail/)
  const hits = await api(worker, '/api/v1/search/find', { method: 'POST', body: { query: 'marina cleanup', tags: ['team=patch'] } })
  assert.deepEqual(hits.memories.map(hit => hit.uri), [uri])
  const other = await api(worker, '/api/v1/search/find', { method: 'POST', body: { query: 'marina cleanup' }, principal: 'admin' })
  assert.deepEqual(other.memories, [])
  assert.deepEqual(await api(worker, '/api/v1/stats/sessions/marina'), { session_id: 'marina', total_turns: 2, memories_extracted: 1 })
  const stats = await api(worker, '/api/v1/stats/memories?category=events')
  assert.equal(stats.total_memories, 1)
  assert.deepEqual(stats.by_category, { events: 1 })
  assert.equal(stats.hotness_distribution, null)
  const ctx = await ok(worker, 'GET', `${path}/context`)
  assert.match(ctx.latest_archive_overview, /Recap: marina cleanup/)
  assert.deepEqual(keptText(ctx.messages), ['Tail'])
  assert.equal(ctx.stats.includedArchives, 1)
  assert.equal((await ok(worker, 'GET', `${path}/context?token_budget=1`)).latest_archive_overview, '')
  const archived = await ok(worker, 'GET', `${path}/archives/archive_001`)
  const diff = await api(worker, `/api/v1/content/read?${new URLSearchParams({ uri: `${result.archive_uri}/memory_diff.json` })}`)
  assert.deepEqual(JSON.parse(diff).operations.adds, [{ uri, memory_type: 'events' }])
  await fails(worker, 409, 'FAILED_PRECONDITION', 'POST', `${path}/archives/archive_001/retry`, { expected_messages_sha256: archived.messages_sha256 })
  await ok(worker, 'PATCH', `${path}/config`, { memory_extraction_config: { events: { tags: [] } } })
  await ok(worker, 'POST', `${path}/commit`, { wait: true, enable_working_memory: true, extraction_metadata: { event: { tags: ['commit=override'] } } })
  const cumulative = (await ok(worker, 'GET', `${path}/context`)).latest_archive_overview
  assert.equal(cumulative, `${ctx.latest_archive_overview} ${ctx.latest_archive_overview}`)
  assert.equal((await ok(worker, 'GET', path)).llm_token_usage.total_tokens, 88)
  await ok(worker, 'POST', `${path}/commit`, { reset_context: true })
  assert.equal((await ok(worker, 'GET', `${path}/context`)).latest_archive_overview, '')
})

test('failed extraction can be retried after restart using the exact sealed hash and frozen tags', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-session-retry-'))
  let worker = start(dir, false, [], { model: 'second-embed-fails' })
  try {
    const path = '/retry', archive = `${path}/archives/archive_001`
    await ok(worker, 'POST', '', { session_id: 'retry', memory_extraction_config: { events: { tags: ['day=initial'] } } })
    await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'We agreed on two events.' })
    await fails(worker, 429, 'RATE_LIMITED', 'POST', `${path}/commit?wait=true`)
    const failed = await ok(worker, 'GET', archive)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.memories_extracted, 1)
    assert.equal(failed.failure.code, 'RATE_LIMITED')
    assert.equal((await ok(worker, 'GET', `${path}/context`)).stats.failedArchives, 1)
    await ok(worker, 'PATCH', `${path}/config`, { memory_extraction_config: { events: { tags: ['day=changed'] } } })
    await worker.dispose()
    worker = start(dir) // No generator installed: retry uses the durable, already validated plan.
    await fails(worker, 409, 'FAILED_PRECONDITION', 'POST', `${archive}/retry`, { expected_messages_sha256: '0'.repeat(64) })
    await fails(worker, 404, 'NOT_FOUND', 'POST', `${archive}/retry`, { expected_messages_sha256: failed.messages_sha256 }, 'agent')
    const retried = await ok(worker, 'POST', `${archive}/retry`, { expected_messages_sha256: failed.messages_sha256 })
    assert.equal(retried.memories_extracted, 2)
    assert.equal(retried.memory_uris[0], failed.memory_uris[0])
    const completed = await ok(worker, 'GET', archive)
    assert.equal(completed.messages_sha256, failed.messages_sha256)
    assert.equal(completed.status, 'completed')
    const hits = await api(worker, '/api/v1/search/find', { method: 'POST', body: { query: 'events', tags: ['day=initial'] } })
    assert.equal(hits.total, 2)
    assert.equal((await ok(worker, 'GET', path)).llm_token_usage.total_tokens, 24)
  } finally { await worker.dispose(); await rm(dir, { recursive: true, force: true }) }
})

test('out-of-schema output fails honestly; a valid empty extraction produces zero writes', { timeout: 20_000 }, async t => {
  for (const model of ['malformed', 'good']) {
    const worker = start(undefined, false, [], { model })
    t.after(() => worker.dispose())
    const path = '/empty-result'
    await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'No event in this test.' })
    if (model === 'malformed') await fails(worker, 502, 'INVALID_MODEL_OUTPUT', 'POST', `${path}/commit?wait=true`)
    else assert.equal((await ok(worker, 'POST', `${path}/commit?wait=true`)).memories_extracted, 0)
    const archive = await ok(worker, 'GET', `${path}/archives/archive_001`)
    assert.equal(archive.status, model === 'malformed' ? 'failed' : 'completed')
    assert.equal((await api(worker, '/api/v1/stats/memories')).total_memories, 0)
  }
})

test('a terminal extraction failure does not block a later, independently sealed commit', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [], { model: 'mixed', jobs: true })
  t.after(() => worker.dispose())
  const path = '/separate-archives'
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'Bad first archive' })
  await fails(worker, 502, 'INVALID_MODEL_OUTPUT', 'POST', `${path}/commit?wait=true`)
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'The harbor cleanup took place.' })
  const later = await ok(worker, 'POST', `${path}/commit`, {})
  const task = await eventual(() => api(worker, `/api/v1/tasks/${later.task_id}`), row => row.status === 'completed')
  assert.match(task.result.archive_uri, /archive_002$/)
  assert.equal((await ok(worker, 'GET', `${path}/archives/archive_001`)).status, 'failed')
  assert.equal((await ok(worker, 'GET', `${path}/archives/archive_002`)).status, 'completed')
})

test('a durable job runs through the parent alarm and reports real completion', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [], { jobs: true, model: 'delayed' })
  t.after(() => worker.dispose())
  const path = '/queued'
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'The meeting has been rescheduled.' })
  const accepted = await ok(worker, 'POST', `${path}/commit`, { wait: false })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.archived, true)
  assert.match(accepted.archive_uri, /archive_001$/)
  assert.equal((await ok(worker, 'GET', `${path}/archives/archive_001`)).task_id, accepted.task_id)
  const task = `/api/v1/tasks/${accepted.task_id}`
  await api(worker, task, { principal: 'agent', status: 404 })
  let terminal
  for (let i = 0; i < 50; i++) {
    const row = await api(worker, task)
    if (row.status === 'completed' || row.status === 'failed') { terminal = row; break }
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.equal(terminal?.status, 'completed', JSON.stringify(terminal))
  assert.equal(terminal.result.memories_extracted, 1)
  assert.equal((await ok(worker, 'GET', `${path}/archives/archive_001`)).status, 'completed')
})

test('auto-policy merges fields, fires only above threshold, retains the tail, and obeys disabled/interval gates', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [], { jobs: true })
  t.after(() => worker.dispose())
  const path = '/auto-count'
  const init = await ok(worker, 'POST', '', { session_id: 'auto-count', memory_policy: { memory_types: [] },
    auto_commit_policy: { pending_token_threshold: 0, message_count_threshold: 2, keep_recent_count: 1 } })
  assert.equal(init.auto_commit_policy.idle_timeout_seconds, 0)
  const config = await ok(worker, 'PATCH', `${path}/config`, { auto_commit_policy: { min_commit_interval_seconds: 60 } })
  assert.equal(config.auto_commit_policy.keep_recent_count, 1)
  assert.equal(config.auto_commit_policy.message_count_threshold, 2)
  await fails(worker, 400, 'INVALID_ARGUMENT', 'PATCH', `${path}/config`, { auto_commit_policy: { idle_timeout_seconds: 299 } })
  await fails(worker, 501, 'NOT_IMPLEMENTED', 'PATCH', `${path}/config`, { auto_commit_policy: { idle_timeout_seconds: 300 } })
  const put = content => ok(worker, 'POST', `${path}/messages`, { role: 'user', content })
  await put('first')
  await put('second')
  const tasks = `/api/v1/tasks?${new URLSearchParams({ task_type: 'session_commit', resource_id: 'auto-count' })}`
  assert.deepEqual(await api(worker, tasks), [])
  await put('retained')
  const status = await eventual(() => api(worker, tasks), rows => rows.length && rows[0].status === 'completed')
  assert.equal(status[0].meta.trigger, 'message_write')
  assert.equal(status[0].result.archived, true)
  const detail = await ok(worker, 'GET', path)
  assert.ok(detail.last_auto_commit_at)
  assert.equal(detail.message_count, 1)
  assert.deepEqual(keptText((await ok(worker, 'GET', `${path}/archives/archive_001`)).messages), ['first', 'second'])
  await put('before interval')
  await put('still before interval')
  assert.equal((await api(worker, tasks)).length, 1)
  const disabled = await ok(worker, 'PATCH', `${path}/config`, { auto_commit_policy: null })
  assert.equal(disabled.auto_commit_policy, null)
  await put('while disabled')
  assert.equal((await api(worker, tasks)).length, 1)
})

test('cancellation during indexing prevents publication and a reviewed queued retry can finish it', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [], { jobs: true, model: 'pause-index' })
  t.after(() => worker.dispose())
  const path = '/cancelled', archive = `${path}/archives/archive_001`
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'The marina cleanup was confirmed.' })
  const accepted = await ok(worker, 'POST', `${path}/commit?wait=false`)
  const task = `/api/v1/tasks/${accepted.task_id}`
  const until = async predicate => {
    for (let i = 0; i < 100; i++) {
      const result = await predicate()
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('The durable task did not reach the expected state')
  }
  try {
    await until(() => api(worker, '/fixture/index'))
    assert.equal((await ok(worker, 'GET', archive)).status, 'pending')
    assert.equal((await api(worker, `${task}/cancel`, { method: 'POST' })).status, 'cancelling')
  } finally {
    await api(worker, '/fixture/index', { method: 'POST' })
  }
  await until(async () => (await api(worker, task)).status === 'cancelled')
  const failed = await ok(worker, 'GET', archive)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failure.code, 'TASK_CANCELLED')
  assert.deepEqual(failed.memory_uris, [])
  assert.equal((await api(worker, '/api/v1/stats/memories')).total_memories, 0)
  await fails(worker, 409, 'FAILED_PRECONDITION', 'POST', `${archive}/retry`, { expected_messages_sha256: failed.messages_sha256 })
  const retry = await ok(worker, 'POST', `${archive}/retry?wait=false`, {
    expected_messages_sha256: failed.messages_sha256, allow_cancelled_failure: true,
  })
  assert.equal(retry.status, 'accepted')
  await until(async () => (await api(worker, `/api/v1/tasks/${retry.task_id}`)).status === 'completed')
  assert.equal((await ok(worker, 'GET', archive)).memories_extracted, 1)
  assert.equal((await api(worker, '/api/v1/stats/memories')).total_memories, 1)
})

test('tool results are range-read and searched by Unicode code point after rotation', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const path = '/tool-lookup'
  await ok(worker, 'POST', '', { session_id: 'tool-lookup', memory_policy: { memory_types: [] } })
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', parts: [
    { type: 'tool', tool_id: 'weather', tool_name: 'forecast', tool_output: 'a🌧️b🌧️c', tool_status: 'completed' },
    { type: 'tool', tool_id: 'preview', tool_name: 'forecast', tool_output: 'partial', tool_output_truncated: true, tool_output_ref: 'unverified' },
  ] })
  await ok(worker, 'POST', `${path}/commit?wait=true`)
  const { tool_results: records } = await ok(worker, 'GET', `${path}/tool-results?tool_name=forecast`)
  assert.equal(records.length, 1)
  const [tool] = records
  assert.equal(tool.sha256, createHash('sha256').update('a🌧️b🌧️c').digest('hex'))
  const result = `${path}/tool-results/${tool.tool_result_id}`
  const range = await ok(worker, 'GET', `${result}?offset=1&limit=2&include_metadata=false`)
  assert.equal(range.content, '🌧️')
  assert.equal(range.total_chars, 7)
  assert.equal(range.has_more, true)
  assert.ok(!('metadata' in range))
  const found = await ok(worker, 'GET', `${result}/search?${new URLSearchParams({ q: '🌧️', context_chars: '1' })}`)
  assert.deepEqual(found.matches.map(s => s.offset), [1, 4])
  await fails(worker, 404, 'NOT_FOUND', 'GET', result, undefined, 'agent')
  assert.equal((await api(worker, '/api/v1/stats/sessions/tool-lookup')).total_turns, 0)
  await ok(worker, 'DELETE', path)
  await fails(worker, 404, 'NOT_FOUND', 'GET', result)
})

test('create, list, get, and delete persist across a workerd restart', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-sessions-'))
  let worker
  try {
    const persist = join(dir, 'sqlite')
    worker = start(persist)
    const created = await ok(worker, 'POST', '', { session_id: 'notes' })
    assert.equal(created.session_id, 'notes')
    assert.equal(created.uri, 'viking://user/alice/sessions/notes')
    assert.equal(created.user.user_id, 'alice')
    await fails(worker, 409, 'ALREADY_EXISTS', 'POST', '', { session_id: 'notes' })
    const generated = await ok(worker, 'POST', '')
    assert.match(generated.session_id, /^\d{8}-\d{6}-[a-f0-9]{16}$/)
    await worker.dispose()
    worker = start(persist)
    const listed = await ok(worker, 'GET', '')
    assert.deepEqual(listed.map(item => item.session_id).sort(), [generated.session_id, 'notes'].sort())
    assert.ok(listed.every(item => item.is_dir && item.mod_time))
    const detail = await ok(worker, 'GET', '/notes')
    assert.equal(detail.message_count, 0)
    assert.equal(detail.total_message_count, 0)
    assert.equal(detail.pending_tokens, 0)
    assert.equal(detail.commit_count, 0)
    assert.equal(detail.uri, created.uri)
    assert.deepEqual(await ok(worker, 'DELETE', '/notes'), { session_id: 'notes' })
    await fails(worker, 404, 'NOT_FOUND', 'GET', '/notes')
    assert.equal((await ok(worker, 'GET', '/notes?auto_create=true')).message_count, 0)
  } finally {
    await worker?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('append auto-creates a session and context reads persisted parts under a token budget', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const first = await ok(worker, 'POST', '/conversation/messages', { role: 'user', content: 'abcdefgh' })
  assert.deepEqual(first, { session_id: 'conversation', message_count: 1, pending_tokens: 2 })
  const old = (await ok(worker, 'GET', '/conversation/context')).messages[0]
  assert.match(old.id, /^msg_[a-f0-9]{32}$/)
  const batch = await ok(worker, 'POST', '/conversation/messages/batch', { messages: [
    { role: 'assistant', content: 'not written', parts: [
      { type: 'text', text: 'four' },
      { type: 'context', uri: 'viking://~/memories/sample.md', abstract: '漢' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/image.png', detail: 'low' } },
      { type: 'tool', tool_id: 't1', tool_name: 'lookup', tool_input: { n: 3 }, tool_output: 'value', duration_ms: 1.5,
        prompt_tokens: 7, completion_tokens: 2, tool_output_ref: 'toolr_fixture', tool_output_truncated: true },
    ], peer_id: ' peer-one ', turn_id: 'turn-1', message_kind: 'assistant_step', created_at: '2025-01-01T00:00:00Z',
    source_message_ids: [old.id], interrupted: true },
    { role: 'user', parts: [{ type: 'tool', tool_id: 'a' }, { type: 'tool', tool_id: 'b' }] },
    { role: 'user', content: 'tail' },
  ] })
  assert.equal(batch.added, 4)
  assert.equal(batch.message_count, 5)
  const whole = await ok(worker, 'GET', '/conversation/context')
  assert.equal(whole.messages.length, 5)
  assert.equal(whole.estimatedTokens, batch.pending_tokens)
  const [, assistant, tool1, tool2, tail] = whole.messages
  assert.equal(assistant.parts[0].text, 'four')
  assert.deepEqual(assistant.parts[1], { type: 'context', uri: 'viking://user/alice/memories/sample.md', abstract: '漢', context_type: 'memory' })
  assert.equal(assistant.parts[2].image_url.detail, 'low')
  assert.deepEqual(assistant.parts[3], {
    type: 'tool', tool_id: 't1', tool_name: 'lookup', tool_uri: '', skill_uri: '', tool_status: 'pending', tool_input: { n: 3 },
    tool_output: 'value', duration_ms: 1.5, prompt_tokens: 7, completion_tokens: 2,
    tool_output_ref: 'toolr_fixture', tool_output_truncated: true,
  })
  assert.equal(assistant.peer_id, 'peer-one')
  assert.equal(assistant.turn_id, 'turn-1')
  assert.equal(assistant.created_at, '2025-01-01T00:00:00Z')
  assert.equal(assistant.interrupted, true)
  assert.deepEqual(assistant.source_message_ids, [old.id])
  assert.deepEqual([tool1, tool2].map(m => [m.message_kind, m.parts[0].tool_id]), [['tool_transport', 'a'], ['tool_transport', 'b']])
  const recent = await ok(worker, 'GET', '/conversation/context?token_budget=1')
  assert.deepEqual(recent.messages, [tail])
  assert.equal(recent.estimatedTokens, 1)
  assert.deepEqual((await ok(worker, 'GET', '/conversation/context?token_budget=0')).messages, [])
  assert.deepEqual((await ok(worker, 'GET', '/conversation/context')).messages, whole.messages)
  await fails(worker, 400, 'INVALID_ARGUMENT', 'GET', '/conversation/context?token_budget=-1')
  const detail = await ok(worker, 'GET', '/conversation')
  assert.equal(detail.pending_tokens, batch.pending_tokens)
  assert.equal(detail.total_message_count, whole.messages.length)
})

const rawPolicy = { memory_types: [] }
const keptText = messages => messages.map(message => message.parts[0].text)

test('explicit archive-only commit persists raw history and leaves exactly the requested live suffix', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ov-archives-'))
  let worker
  try {
    worker = start(dir)
    const path = '/commit-local'
    await ok(worker, 'POST', '', { session_id: 'commit-local', memory_policy: rawPolicy, auto_commit_policy: null })
    await ok(worker, 'POST', `${path}/messages/batch`, { messages: ['one!', 'two!', 'keep'].map(content => ({ role: 'user', content })) })
    const beforeCommit = (await ok(worker, 'GET', `${path}/context`)).messages
    await fails(worker, 503, 'GENERATION_UNAVAILABLE', 'POST', `${path}/commit`, { wait: true, enable_working_memory: true })
    await fails(worker, 501, 'NOT_IMPLEMENTED', 'POST', `${path}/commit`, { retention_mode: 'turn_budget' })
    assert.deepEqual((await ok(worker, 'GET', `${path}/context`)).messages, beforeCommit)
    const committed = await ok(worker, 'POST', `${path}/commit`, { wait: true, keep_recent_count: 1 })
    assert.equal(committed.status, 'completed')
    assert.equal(committed.archived, true)
    assert.equal(committed.task_id, null)
    assert.equal(committed.archive_uri, 'viking://user/alice/sessions/commit-local/history/archive_001')
    await worker.dispose()
    worker = start(dir)

    const archive = await ok(worker, 'GET', `${path}/archives/archive_001`)
    assert.equal(archive.archive_id, 'archive_001')
    assert.equal(archive.status, 'completed')
    assert.equal(archive.overview, '')
    assert.deepEqual(archive.messages, beforeCommit.slice(0, 2))
    assert.equal(archive.messages_sha256, createHash('sha256')
      .update(beforeCommit.slice(0, 2).map(row => JSON.stringify(row) + '\n').join('')).digest('hex'))
    const live = await ok(worker, 'GET', `${path}/context`)
    assert.deepEqual(live.messages, beforeCommit.slice(2))
    assert.deepEqual(live.stats, { totalArchives: 1, includedArchives: 0, droppedArchives: 1, failedArchives: 0, activeTokens: 1, archiveTokens: 0 })
    const meta = await ok(worker, 'GET', path)
    assert.deepEqual(meta.memory_policy.memory_types, [])
    assert.equal(meta.commit_count, 1)
    assert.equal(meta.pending_tokens, 0)
    assert.equal(meta.keep_recent_count, 1)
    assert.equal(meta.message_count, 1)
    assert.equal(meta.total_message_count, 3)
    assert.ok(meta.last_commit_at)
    const skipped = await ok(worker, 'POST', `${path}/commit`, { wait: true, keep_recent_count: 1 })
    assert.equal(skipped.status, 'skipped')
    assert.equal(skipped.reason, 'all_within_keep_window')
    assert.equal(skipped.archived, false)
    assert.equal((await ok(worker, 'POST', `${path}/messages`, { role: 'assistant', content: 'tail' })).pending_tokens, 1)

    const reset = await ok(worker, 'POST', `${path}/commit`, { wait: true, reset_context: true, enable_working_memory: false })
    assert.equal(reset.reset_context, true)
    assert.deepEqual(keptText((await ok(worker, 'GET', `${path}/archives/archive_002`)).messages), ['keep', 'tail'])
    const boundary = await ok(worker, 'GET', `${path}/archives/archive_003`)
    assert.deepEqual(boundary.messages, [])
    assert.equal(boundary.messages_sha256, createHash('sha256').digest('hex'))
    assert.deepEqual((await ok(worker, 'GET', `${path}/context`)).messages, [])
    assert.equal((await ok(worker, 'POST', `${path}/commit`, { reset_context: true })).reason, 'no_messages')
    assert.equal((await ok(worker, 'GET', path)).commit_count, 3)

    await ok(worker, 'DELETE', path)
    await ok(worker, 'POST', '', { session_id: 'commit-local', memory_policy: rawPolicy })
    await fails(worker, 404, 'NOT_FOUND', 'GET', `${path}/archives/archive_001`)
    await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'after recreation' })
    await ok(worker, 'POST', `${path}/commit?wait=true`)
    assert.deepEqual(keptText((await ok(worker, 'GET', `${path}/archives/archive_001`)).messages), ['after recreation'])
  } finally {
    await worker?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unavailable generation provider or durable consumer never acknowledges a fictitious job', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  await ok(worker, 'POST', '/ordinary/messages', { role: 'user', content: 'not archived by a failed commit' })
  await fails(worker, 503, 'GENERATION_UNAVAILABLE', 'POST', '/ordinary/commit?wait=true')
  await fails(worker, 503, 'GENERATION_UNAVAILABLE', 'POST', '/ordinary/commit', { wait: true, enable_working_memory: false })
  await fails(worker, 501, 'NOT_IMPLEMENTED', 'POST', '/ordinary/commit', { wait: false })
  await fails(worker, 404, 'NOT_FOUND', 'POST', '/ordinary/archives/archive_001/retry', { expected_messages_sha256: '0'.repeat(64) })
  assert.deepEqual(await ok(worker, 'GET', '/ordinary/tool-results'), { tool_results: [] })
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/ordinary/tool-results/sample')
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/ordinary/tool-results/sample/search?q=example')
  await fails(worker, 501, 'NOT_IMPLEMENTED', 'PATCH', '/ordinary/config', { auto_commit_policy: { keep_recent_count: 1 } })
  await fails(worker, 501, 'NOT_IMPLEMENTED', 'POST', '', { session_id: 'rejected', auto_commit_policy: {} })
  await fails(worker, 501, 'NOT_IMPLEMENTED', 'POST', '', { session_id: 'rejected', memory_policy: { memory_types: ['preferences'] } })
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/rejected')
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/ordinary/archives/archive_001')
  assert.equal((await ok(worker, 'GET', '/ordinary')).commit_count, 0)
  assert.deepEqual(keptText((await ok(worker, 'GET', '/ordinary/context')).messages), ['not archived by a failed commit'])
  const response = await worker.dispatchFetch('http://local.invalid/api/v1/tasks')
  assert.equal(response.headers.get('test-fallthrough'), 'true')
  await response.body?.cancel()
})

test('a session ID can coexist for different users, agents and accounts in one Durable Object', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const sid = 'same-name', path = `/${sid}`, archived = `${path}/archives/archive_001`
  const put = (principal, content) => ok(worker, 'POST', `${path}/messages`, { role: 'user', content }, principal)
  const create = principal => ok(worker, 'POST', '', { session_id: sid, memory_policy: rawPolicy }, principal)
  const principals = ['agent', 'admin', 'account']

  await create('owner')
  await put('owner', 'owner archive')
  await ok(worker, 'POST', `${path}/commit?wait=true`)
  await put('owner', 'owner live')
  for (const principal of principals) {
    assert.deepEqual(await ok(worker, 'GET', '', undefined, principal), [])
    await fails(worker, 404, 'NOT_FOUND', 'GET', path, undefined, principal)
    await fails(worker, 404, 'NOT_FOUND', 'GET', `${path}/context`, undefined, principal)
    await fails(worker, 404, 'NOT_FOUND', 'GET', archived, undefined, principal)
    await fails(worker, 404, 'NOT_FOUND', 'DELETE', path, undefined, principal)
    await create(principal)
    await put(principal, `${principal} archive`)
    await ok(worker, 'POST', `${path}/commit?wait=true`, undefined, principal)
    await put(principal, `${principal} live`)
  }
  for (const principal of ['owner', ...principals]) {
    assert.deepEqual((await ok(worker, 'GET', '', undefined, principal)).map(item => item.session_id), [sid])
    assert.deepEqual(keptText((await ok(worker, 'GET', archived, undefined, principal)).messages), [`${principal} archive`])
    assert.deepEqual(keptText((await ok(worker, 'GET', `${path}/context`, undefined, principal)).messages), [`${principal} live`])
  }
  await ok(worker, 'DELETE', path, undefined, 'admin')
  assert.equal((await ok(worker, 'GET', path)).total_message_count, 2)
  assert.equal((await ok(worker, 'GET', archived)).messages.length, 1)
  await fails(worker, 404, 'NOT_FOUND', 'GET', archived, undefined, 'admin')
})

test('invalid batches and size violations are rejected before creating a session or changing counters', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const text = { role: 'user', content: 'valid' }
  await fails(worker, 400, 'INVALID_ARGUMENT', 'POST', '/unknown/messages/batch', { messages: [text, { role: 'assistant' }] })
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/unknown')
  await fails(worker, 400, 'INVALID_ARGUMENT', 'POST', '/unknown/messages/batch', { messages: Array(101).fill(text) })
  await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', '/unknown/messages', { ...text, content: 'é'.repeat(32 * 1024) })
  await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', '/unknown/messages', { ...text, content: 'x'.repeat(512 * 1024) })
  await fails(worker, 400, 'INVALID_ARGUMENT', 'POST', '', { session_id: 'unfinished\n' })
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/unknown')
  const empty = await ok(worker, 'POST', '/empty/messages/batch', { messages: [] })
  assert.deepEqual(empty, { session_id: 'empty', message_count: 0, added: 0, pending_tokens: 0 })
  await ok(worker, 'POST', '/existing/messages', text)
  await fails(worker, 400, 'INVALID_ARGUMENT', 'POST', '/existing/messages/batch', { messages: [text, { role: 'assistant' }] })
  assert.deepEqual(keptText((await ok(worker, 'GET', '/existing/context')).messages), ['valid'])
  assert.equal((await ok(worker, 'GET', '/existing')).total_message_count, 1)
})

test('SQLite write failures roll back the batch and archive transaction, not just their HTTP responses', { timeout: 20_000 }, async t => {
  const worker = start(undefined, true)
  t.after(() => worker.dispose())
  const ur = content => ({ role: 'user', content })
  const messages = [ur('first row'), ur('second row')]
  await fails(worker, 500, 'INTERNAL_ERROR', 'POST', '/fresh-rollback/messages/batch', { messages })
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/fresh-rollback')
  assert.equal((await ok(worker, 'POST', '/fresh-rollback/messages', ur('after failed batch'))).message_count, 1)

  await ok(worker, 'POST', '/existing-rollback/messages', ur('original row'))
  await fails(worker, 500, 'INTERNAL_ERROR', 'POST', '/existing-rollback/messages/batch', { messages })
  assert.deepEqual(keptText((await ok(worker, 'GET', '/existing-rollback/context')).messages), ['original row'])
  assert.equal((await ok(worker, 'GET', '/existing-rollback')).total_message_count, 1)
  assert.equal((await ok(worker, 'POST', '/existing-rollback/messages', ur('second valid row'))).message_count, 2)

  await ok(worker, 'POST', '', { session_id: 'archive-rollback', memory_policy: rawPolicy })
  await ok(worker, 'POST', '/archive-rollback/messages/batch', { messages })
  await fails(worker, 500, 'INTERNAL_ERROR', 'POST', '/archive-rollback/commit?wait=true')
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/archive-rollback/archives/archive_001')
  assert.equal((await ok(worker, 'GET', '/archive-rollback')).commit_count, 0)
  assert.deepEqual(keptText((await ok(worker, 'GET', '/archive-rollback/context')).messages), ['first row', 'second row'])
})

test('concurrent batches and archive-only commit keep every acknowledged message in order within its batch', { timeout: 20_000 }, async t => {
  const worker = start()
  t.after(() => worker.dispose())
  const path = '/concurrent'
  await ok(worker, 'POST', '', { session_id: 'concurrent', memory_policy: rawPolicy })
  await ok(worker, 'POST', `${path}/messages`, { role: 'user', content: 'seed' })
  const tags = Array.from({ length: 12 }, (_, i) => [`${i}:first`, `${i}:second`])
  const writes = tags.map(pair => ok(worker, 'POST', `${path}/messages/batch`, { messages: pair.map(content => ({ role: 'user', content })) }))
  const activeCommit = ok(worker, 'POST', `${path}/commit?wait=true`)
  const results = await Promise.all(writes)
  assert.ok(results.every(result => result.added === 2))
  await activeCommit
  await ok(worker, 'POST', `${path}/commit?wait=true`)
  const detail = await ok(worker, 'GET', path)
  assert.equal(detail.message_count, 0)
  assert.equal(detail.total_message_count, tags.length * 2 + 1)
  const stored = []
  for (let index = 1; index <= detail.commit_count; index++) {
    const archive = await ok(worker, 'GET', `${path}/archives/archive_${String(index).padStart(3, '0')}`)
    stored.push(...archive.messages)
  }
  assert.equal(new Set(stored.map(message => message.id)).size, detail.total_message_count)
  const contents = keptText(stored)
  assert.equal(contents[0], 'seed')
  assert.equal(contents.length, detail.total_message_count)
  for (const [first, second] of tags) {
    assert.ok(contents.includes(first))
    assert.equal(contents[contents.indexOf(first) + 1], second)
  }
})

const mib = 1024 * 1024
const quotaMessage = { role: 'user', content: 'é', created_at: '2026-11-21T00:00:00Z' }
const quotaMessageBytes = Buffer.byteLength(JSON.stringify({
  id: `msg_${'0'.repeat(32)}`, role: 'user', parts: [{ type: 'text', text: 'é' }], created_at: quotaMessage.created_at,
}) + '\n')

test('user byte quota spans agents; archive retains the charge and cascade makes it reusable', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [['alice', 8 * mib, 128], ['alice', 4 * mib - quotaMessageBytes, 64]])
  t.after(() => worker.dispose())
  const sid = '/quota-archived'
  const oversized = await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', `${sid}/messages`, { ...quotaMessage, content: 'é!' })
  assert.match(oversized, /^User /)
  await fails(worker, 404, 'NOT_FOUND', 'GET', sid)
  await ok(worker, 'POST', '', { session_id: sid.slice(1), memory_policy: rawPolicy })
  await ok(worker, 'POST', `${sid}/messages`, quotaMessage)
  await ok(worker, 'POST', `${sid}/commit?wait=true`)
  const archive = `${sid}/archives/archive_001`
  await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', `${sid}/messages`, quotaMessage)
  assert.equal((await ok(worker, 'GET', sid)).total_message_count, 1)
  assert.deepEqual(keptText((await ok(worker, 'GET', archive)).messages), ['é'])
  await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', '/next/messages/batch', { messages: [quotaMessage] }, 'agent')
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/next', undefined, 'agent')
  await ok(worker, 'POST', '/other-user/messages', quotaMessage, 'admin')
  await ok(worker, 'DELETE', sid)
  await fails(worker, 404, 'NOT_FOUND', 'GET', archive)
  assert.equal((await ok(worker, 'POST', '/next/messages', quotaMessage, 'agent')).message_count, 1)
})

test('a concurrent pair cannot exceed the last bytes in one account or consume another account quota', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [
    ['seed-a', 8 * mib, 128], ['seed-b', 8 * mib, 128], ['seed-c', 8 * mib, 128],
    ['seed-d', 8 * mib - quotaMessageBytes, 128],
  ])
  t.after(() => worker.dispose())
  const callers = ['owner', 'admin']
  const replies = await Promise.all(callers.map(principal => request(worker, 'POST', '/last/messages', quotaMessage, principal)))
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 413])
  const winner = replies.findIndex(reply => reply.status === 200)
  const loser = 1 - winner
  assert.equal(replies[loser].payload.error.code, 'RESOURCE_EXHAUSTED')
  assert.match(replies[loser].payload.error.message, /^Account /)
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/last', undefined, callers[loser])
  await ok(worker, 'POST', '/last/messages', quotaMessage, 'account')
  await ok(worker, 'DELETE', '/last', undefined, callers[winner])
  await ok(worker, 'POST', '/last/messages', quotaMessage, callers[loser])
})

test('session row quotas cover explicit create, GET auto-create and append, and deletion frees a slot', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [
    ['alice', 0, 0, 511], ['seed-a', 0, 0, 512], ['seed-b', 0, 0, 512], ['seed-c', 0, 0, 512],
  ])
  t.after(() => worker.dispose())
  await ok(worker, 'POST', '', { session_id: 'last-slot' })
  assert.match(await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'GET', '/blocked?auto_create=true', undefined, 'agent'), /^User /)
  assert.match(await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', '/blocked/messages', quotaMessage, 'admin'), /^Account /)
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/blocked', undefined, 'admin')
  await ok(worker, 'DELETE', '/last-slot')
  await ok(worker, 'GET', '/blocked?auto_create=true', undefined, 'admin')
  await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', '', { session_id: 'blocked' })
  await ok(worker, 'POST', '', { session_id: 'blocked' }, 'account')
})

test('message row quotas reject a batch even when the byte quota has plenty of room', { timeout: 20_000 }, async t => {
  const worker = start(undefined, false, [
    ['alice', 2 * mib, 8_000], ['alice', mib, 3_999],
    ...['seed-a', 'seed-b', 'seed-c', 'seed-d'].map(user => [user, 2 * mib, 7_000]),
  ])
  t.after(() => worker.dispose())
  const batch = '/counter/messages/batch'
  const tooMany = { messages: [quotaMessage, quotaMessage] }
  assert.match(await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', batch, tooMany, 'agent'), /^User /)
  await fails(worker, 404, 'NOT_FOUND', 'GET', '/counter', undefined, 'agent')
  await ok(worker, 'POST', batch, { messages: [quotaMessage] }, 'agent')
  assert.match(await fails(worker, 413, 'RESOURCE_EXHAUSTED', 'POST', batch, { messages: [quotaMessage] }, 'admin'), /^Account /)
  await ok(worker, 'DELETE', '/counter', undefined, 'agent')
  await ok(worker, 'POST', batch, { messages: [quotaMessage] }, 'admin')
})
