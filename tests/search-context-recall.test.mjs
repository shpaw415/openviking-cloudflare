// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('bootstrap', 'root', 'root')
const editor = testPrincipal('fixture', 'editor', 'admin')
const reader = testPrincipal('fixture', 'reader')
const agent = testPrincipal('fixture', 'reader', 'user', 'neighbor')
const peer = testPrincipal('fixture', 'peer')
const other = testPrincipal('other', 'reader')
const route = '/api/v1/search/search', config = '/api/v1/admin/configuration/import', sessions = '/api/v1/sessions'
const sid = 'recall-fixture'
const lookup = (send, more = {}) => send(route, { method: 'POST', body: {
  mode: 'context', query: 'beacon', session_id: sid, detail: 'full', limit: 1, dedup_turns: 2, ...more,
} })
async function json(response, expected = 200) {
  const res = await response, data = await res.json()
  assert.equal(res.status, expected, data.error?.message)
  return res.ok ? data.result : data.error
}
const post = (send, path, body, status) => json(send(path, { method: 'POST', body }), status)
const put = (send, uri, content, acl) => post(send, '/api/v1/content/write', { uri, content, acl, wait: true })
const session = send => post(send, sessions, { session_id: sid })
const message = send => post(send, `${sessions}/${sid}/messages`, { role: 'user', content: 'Fictional session-only text.' })
const erase = (send, uri) => json(send(`/api/v1/fs?uri=${encodeURIComponent(uri)}`, { method: 'DELETE' }))
const a = 'viking://resources/a.md', b = 'viking://resources/b.md'
const acl = entries => ({ acl_mode: 'restricted', entries })
const allowed = [{ principal: 'user:reader', level: 'read' }]
const setAcl = (send, uri, entries) => json(send('/api/v1/acl', { method: 'PUT', body: { uri, ...acl(entries) } }))
const names = result => result.entries.map(entry => entry.uri)

test('HTTP recall restarts on SQLite, uses message turns and cannot cross member, account or agent', { timeout: 20_000 }, async t => {
  const persist = await mkdtemp(join(tmpdir(), 'context-recall-'))
  const fixture = { principals: [root, editor, reader, agent, other, peer], embeddings: 'fixture', persist }
  let runtime = await localWorker(fixture)
  t.after(async () => { await runtime.dispose(); await rm(persist, { recursive: true, force: true }) })
  let send = api(runtime, reader)
  await put(api(runtime, editor), a, 'beacon lighthouse')
  await put(api(runtime, editor), b, 'beacon harbor')
  await session(send)
  const first = await json(lookup(send))
  assert.deepEqual(names(first), [a])
  assert.deepEqual(first.stats.dedup, { turns: 2, status: 'new', cooled: 0, turn: 0 })
  for (const principal of [agent, peer, other]) await json(lookup(api(runtime, principal)), 404)
  await session(api(runtime, agent))
  assert.deepEqual(names(await json(lookup(api(runtime, agent)))), [a])
  await session(api(runtime, other))
  assert.deepEqual(names(await json(lookup(api(runtime, other)))), [])
  await runtime.dispose()
  runtime = await localWorker(fixture)
  send = api(runtime, reader)
  await message(send)
  const second = await json(lookup(send))
  assert.deepEqual(names(second), [b])
  assert.deepEqual(second.stats.dedup, { turns: 2, status: 'ok', cooled: 1, turn: 1 })
  assert.deepEqual(names(await json(lookup(send))), [])
  await message(send)
  const third = await json(lookup(send))
  assert.deepEqual(names(third), [a])
  assert.equal(third.stats.dedup.turn, 2)
  await json(send(`${sessions}/${sid}`, { method: 'DELETE' }))
  await json(lookup(send), 404)
  await session(send)
  assert.deepEqual((await json(lookup(send))).stats.dedup, { turns: 2, status: 'new', cooled: 0, turn: 0 })
  console.log(`context recall SQLite bundle sha256=${runtime.localBuildSha256}`)
})

async function providerFixture(t) {
  const base = 'https://digest-fixture.example.test/v1', key = randomBytes(32).toString('hex')
  const state = { calls: [], answer: `- Its light is fictional. ${a}` }
  const runtime = await localWorker({ principals: [root, editor, reader, agent, other], vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: key }]),
  }, async outboundService(req) {
    assert.equal(req.method, 'POST')
    assert.ok(req.headers.get('authorization') === `Bearer ${key}`)
    const body = await req.json()
    state.calls.push(body)
    if (req.url === `${base}/embeddings`) {
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })
    }
    assert.equal(req.url, `${base}/chat/completions`)
    assert.match(body.messages[0].content, /^openviking_edge_context_digest_v1\./u)
    if (state.hold) {
      const hold = state.hold
      hold.entered.resolve()
      await hold.release.promise
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: state.answer } }], usage: { prompt_tokens: 11, completion_tokens: 7 } })
  } })
  t.after(async () => { state.hold?.release.resolve(); await runtime.dispose() })
  const admin = api(runtime, root), owner = api(runtime, editor), send = api(runtime, reader)
  const dto = { provider: 'openai-compatible', api_base: base }
  await post(admin, config, { vlm: { ...dto, model: 'fixture-digest' }, embedding: { dense: { ...dto, model: 'fixture-vector', dimension: 2 } } })
  const enable = (retrieval = {}, suffix = '') => post(admin, config + suffix, { retrieval: { edge_context_rewrite: true, ...retrieval } })
  await session(send)
  await message(send)
  return { runtime, state, owner, send, enable }
}

test('digest is real, opt-in, budgeted and only receives selected projections', { timeout: 20_000 }, async t => {
  const { runtime, state, owner, send, enable } = await providerFixture(t)
  await put(owner, a, '# Beacon\n\nA fictional blue light.')
  await put(owner, b, 'Explicitly excluded body')
  await put(owner, 'viking://resources/c.md', 'Restricted body', acl([]))
  await put(owner, 'viking://resources/d.md', 'Outside width body')
  const req = { rewrite: true, dedup_turns: 0, purpose: 'chat', quotas: { resources: 1 }, limit: 7, exclude_uris: [b],
    max_tokens: 128, rewrite_max_bullets: 1, include_provenance: true }
  state.calls.length = 0
  await json(lookup(send, req), 501)
  await enable({}, '?dry_run=true')
  await json(lookup(send, req), 501)
  assert.deepEqual(state.calls, [])
  await enable()
  const prior = state.calls.length
  for (const changes of [{ rewrite: 'true' }, { include_provenance: 'false' }, { read_content: null },
    { filter: { op: 'made_up', field: 'uri', conds: [a] } }, { quotas: { resources: '1' } }]) {
    await json(lookup(send, { ...req, ...changes }), 400)
  }
  assert.equal(state.calls.length, prior)
  state.answer = `- Discard this wrong citation ${b}\n* Verified fixture light ${a}\n- Second good line ${a}`
  const result = await json(lookup(send, req))
  assert.deepEqual(names(result), [a])
  assert.deepEqual(result.provenance[0].matched_contexts.map(x => x.uri), [a])
  assert.equal(result.digest, `OpenViking memory digest:\n- Verified fixture light ${a}`)
  assert.equal(result.stats.rewrite, 'ok')
  assert.deepEqual(result.stats.rewrite_usage, { prompt_tokens: 11, completion_tokens: 7 })
  assert.deepEqual(result.stats.ignored, ['limit'])
  assert.ok(result.stats.used_tokens <= req.max_tokens)
  assert.equal(state.calls.length, prior + 2)
  const payload = state.calls.at(-1)
  assert.equal(payload.max_tokens, 128)
  assert.deepEqual(JSON.parse(payload.messages[1].content), { query: 'beacon', rendered: result.rendered, max_bullets: 1 })
  assert.doesNotMatch(JSON.stringify(state.calls), /session-only|Outside width|excluded body|Restricted body/u)

  state.answer = `- Only bogus source ${b}`
  const failed = await json(lookup(send, { ...req, rewrite: 'auto' }))
  assert.equal(failed.stats.rewrite, 'failed')
  assert.equal(failed.digest, '')
  assert.equal(failed.rendered, result.rendered)
  state.answer = 'NO_RELEVANT_MEMORY'
  const irrelevant = await json(lookup(send, { ...req, dedup_turns: 2 }))
  assert.equal(irrelevant.stats.rewrite, 'no_relevant')
  assert.equal(irrelevant.rendered, '')
  assert.deepEqual(names(await json(lookup(send, { ...req, rewrite: false, dedup_turns: 2 }))), [a])
  await enable({ recall_rewrite_timeout_s: 0.1 })
  const empty = await json(lookup(send, { ...req, quotas: {} }))
  assert.equal(empty.stats.rewrite, 'empty')
  state.hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  try {
    const timeout = await json(lookup(send, req))
    assert.equal(timeout.stats.rewrite, 'timeout')
    assert.equal(timeout.rendered, result.rendered)
  } finally { state.hold.release.resolve(); state.hold = undefined }
  console.log(`context digest bundle sha256=${runtime.localBuildSha256}`)
})

test('digest publication and ledger are fenced after ACL, deletion and session changes during inference', { timeout: 20_000 }, async t => {
  const { state, owner, send, enable } = await providerFixture(t)
  await enable()
  await put(owner, a, 'Fictional readable light.', acl(allowed))
  const gated = async (mutate, status = 409) => {
    const hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
    state.hold = hold
    const pending = lookup(send, { rewrite: true })
    try {
      await Promise.race([hold.entered.promise, pending.then(res => assert.fail(`Digest was not reached (${res.status})`))])
      await mutate()
    } finally { hold.release.resolve(); state.hold = undefined }
    const error = await json(pending, status)
    assert.doesNotMatch(JSON.stringify(error), /readable light|resources\/a\.md|digest:/u)
  }
  await gated(() => setAcl(owner, a, []))
  const hidden = await json(lookup(send))
  assert.deepEqual(names(hidden), [])
  assert.equal(hidden.stats.dedup.cooled, 0)
  await setAcl(owner, a, allowed)
  await gated(() => erase(owner, a))
  await put(owner, a, 'Fictional replacement.', acl(allowed))
  await gated(() => message(send))
  await gated(async () => { await json(send(`${sessions}/${sid}`, { method: 'DELETE' })); await session(send) })
  const accepted = await json(lookup(send))
  assert.deepEqual(names(accepted), [a])
  assert.deepEqual(names(await json(lookup(send))), [])
  await setAcl(owner, a, [])
  await setAcl(owner, a, allowed)
  assert.deepEqual(names(await json(lookup(send))), [a], 'revised ACL invalidates the previous projection')
})

test('client disconnect signalled by Workerd during digest does not record a served projection', { timeout: 12_000 }, async t => {
  const { runtime, state, owner, send, enable } = await providerFixture(t)
  await enable()
  await put(owner, a, 'Fictional readable light.', acl(allowed))
  const hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  state.hold = hold
  const local = await runtime.ready
  assert.equal(local.hostname, '127.0.0.1')
  const body = JSON.stringify({ mode: 'context', query: 'beacon', session_id: sid, rewrite: true, detail: 'full', dedup_turns: 2 })
  let socket
  const pending = new Promise((resolve, reject) => {
    const req = httpRequest(new URL(route, local), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-api-key': reader.key } }, resolve)
    req.once('socket', value => { socket = value })
    req.once('error', reject)
    req.end(body)
  })
  try {
    await Promise.race([hold.entered.promise, pending.then(res => assert.fail(`Digest was not reached (${res.status})`))])
    socket.resetAndDestroy()
    await assert.rejects(pending, { code: 'ECONNRESET' })
    // The provider remains held; wait beyond its admitted deadline so an
    // erroneous timeout fallback would have committed and cooled the URI.
    await new Promise(resolve => setTimeout(resolve, 3300))
    const result = await json(lookup(send))
    assert.equal(result.stats.dedup.status, 'new')
    assert.deepEqual(names(result), [a])
  } finally { hold.release.resolve(); state.hold = undefined }
})
