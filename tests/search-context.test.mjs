// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('bootstrap', 'root', 'root')
const editor = testPrincipal('fixture', 'editor', 'admin')
const reader = testPrincipal('fixture', 'reader')
const peer = testPrincipal('fixture', 'peer')
const other = testPrincipal('different', 'reader')
const search = '/api/v1/search/search'
const config = '/api/v1/admin/configuration/import'
const post = (send, path, body) => send(path, { method: 'POST', body })
const put = (send, uri, content, acl) => json(post(send, '/api/v1/content/write', { uri, content, acl, wait: true }))

async function json(pending, status = 200) {
  const response = await pending
  const data = await response.json()
  assert.equal(response.status, status, data.error?.message)
  return response.ok ? data.result : data.error
}

test('context assembles deterministic tiers and budget from the authorized SQLite index', { timeout: 20_000 }, async t => {
  const runtime = await localWorker({ principals: [root, editor, reader, peer, other], embeddings: 'fixture' })
  t.after(() => runtime.dispose())
  const send = api(runtime, reader)
  const privateFile = 'viking://user/reader/resources/lighthouse.md'
  const text = `# Lighthouse\n\nA fictional lighthouse on a quiet coast.\n\n## Lantern\n\n${'The lighthouse lamp éclairait la côte. '.repeat(30)}\n\nFinal marker.`
  await put(send, privateFile, text)
  await put(api(runtime, other), 'viking://~/resources/other-account.md', 'lighthouse account marker')
  await put(api(runtime, peer), 'viking://~/resources/peer.md', 'lighthouse peer marker')
  await put(api(runtime, editor), 'viking://resources/hidden.md', 'lighthouse restricted marker', { acl_mode: 'restricted', entries: [] })
  const lookup = (extra = {}) => json(post(send, search, { mode: 'context', query: 'lighthouse', score_threshold: 0.1, ...extra }))
  const overview = await lookup({ detail: 'overview', max_tokens: 512 })
  assert.deepEqual(overview.entries.map(({ uri, category, detail, origin }) => [uri, category, detail, origin]),
    [[privateFile, 'resources', 'overview', 'self']])
  assert.match(overview.entries[0].text, /## Lantern/u)
  assert.doesNotMatch(overview.rendered, /Final marker|peer marker|account marker|restricted marker/u)
  assert.match(overview.rendered, /^<memory uri="viking:\/\/user\/reader\/resources\/lighthouse.md" type="resources" score="[\d.]+" detail="overview">/u)
  assert.equal(overview.digest, '')
  assert.deepEqual(await lookup({ detail: 'overview', max_tokens: 512 }), overview)
  const compact = await lookup({ detail: 'full', max_tokens: 64 })
  assert.notEqual(compact.entries[0].detail, 'full')
  assert.ok(compact.stats.used_tokens <= 64)
  const full = await lookup({ detail: { resources: 'full' }, max_tokens: 2048 })
  assert.equal(full.entries[0].text, text)
  assert.ok(full.stats.used_tokens > compact.stats.used_tokens)
  const excluded = await lookup({ exclude_uris: ['viking://~/resources'] })
  assert.deepEqual(excluded.entries, [])
  assert.equal(excluded.rendered, '')
  const list = await json(post(send, search, { query: 'lighthouse', score_threshold: 0.1, level: 2 }))
  assert.deepEqual(list.resources.map(hit => hit.uri), [privateFile])
  assert.ok(!Object.hasOwn(list, 'rendered'))
  console.log(`context fixture bundle sha256=${runtime.localBuildSha256}`)
})

test('purposes and explicit quotas select different indexed categories; committed configuration sets the flat limit', { timeout: 20_000 }, async t => {
  const runtime = await localWorker({ principals: [root, reader], embeddings: 'fixture' })
  t.after(() => runtime.dispose())
  const send = api(runtime, reader), admin = api(runtime, root)
  for (const [category, count] of Object.entries({ resources: 3, events: 3, entities: 3, preferences: 1, experiences: 1 })) {
    const dir = category === 'resources' ? category : `memories/${category}`
    if (category !== 'resources') await json(post(send, '/api/v1/fs/mkdir', { uri: `viking://~/${dir}` }))
    for (let i = 0; i < count; i++) {
      await put(send, `viking://~/${dir}/entry-${i}.md`, `Beacon fixture ${category} number ${i}.`)
    }
  }
  const lookup = extra => json(post(send, search, { mode: 'context', query: 'beacon', max_tokens: 3000, ...extra }))
  assert.equal((await lookup({})).entries.length, 10)
  const chat = await lookup({ purpose: 'chat', limit: 1, level: 0 })
  const coding = await lookup({ purpose: 'coding', limit: 1 })
  assert.deepEqual(chat.stats.ignored, ['level', 'limit'])
  assert.equal(chat.entries.filter(item => item.category === 'resources').length, 2) // one unused skill slot backfills
  assert.equal(coding.entries.filter(item => item.category === 'resources').length, 3)
  assert.deepEqual((await lookup({ purpose: 'coding', quotas: { events: 1, resources: 0 }, limit: 4 })).entries.map(item => item.category), ['events'])
  await json(post(admin, `${config}?dry_run=true&if_revision=0`, { default_search_limit: 2 }))
  assert.equal((await lookup({})).entries.length, 10)
  await json(post(admin, `${config}?if_revision=0`, { default_search_limit: 2 }))
  assert.equal((await lookup({})).entries.length, 2)
  assert.equal((await lookup({ purpose: 'coding' })).entries.length, 10)
})

test('expansion is opt-in, changes recall and never sends private session or file text to a planner', { timeout: 20_000 }, async t => {
  const base = 'https://search-fixture.example.test/v1'
  const calls = [], key = randomBytes(32).toString('hex')
  let planned = { queries: ['lighthouse'] }, hold
  const runtime = await localWorker({ principals: [root, editor, reader, peer], vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: key }]),
  }, async outboundService(req) {
    const body = await req.json()
    assert.equal(req.headers.get('authorization') === `Bearer ${key}`, true)
    assert.equal(req.headers.has('x-api-key'), false)
    calls.push(body)
    if (req.url === `${base}/embeddings`) return Response.json({ data: body.input.map((term, index) => ({
      index, embedding: term.includes('lighthouse') ? [0, 1] : [1, 0],
    })) })
    assert.equal(req.url, `${base}/chat/completions`)
    if (hold) {
      hold.entered.resolve()
      await hold.release.promise
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(planned) } }] })
  } })
  t.after(async () => { hold?.release.resolve(); await runtime.dispose() })
  const send = api(runtime, reader), admin = api(runtime, root)
  const provider = { provider: 'openai-compatible', api_base: base }
  const vlm = { ...provider, model: 'fixture-chat' }
  await json(post(admin, config, { embedding: { dense: { ...provider, model: 'fixture-vector', dimension: 2 } } }))
  const uri = 'viking://~/resources/beacon.md'
  await put(send, uri, 'lighthouse private resource narrative')
  await json(post(send, '/api/v1/sessions', { session_id: 'owned-fixture' }))
  await json(post(send, '/api/v1/sessions/owned-fixture/messages', { role: 'user', content: 'private session narrative' }))
  const request = extra => ({ mode: 'context', query: 'beacon', session_id: 'owned-fixture', ...extra })
  const lookup = (extra, status) => json(post(send, search, request(extra)), status)
  const optIn = { query_expansion: 'auto' }
  calls.length = 0
  await json(post(admin, `${config}?dry_run=true`, { vlm }))
  assert.equal((await lookup(optIn)).stats.query_expansion, 'off')
  assert.deepEqual(calls.splice(0).map(call => call.input), [['beacon']])
  await json(post(admin, config, { vlm }))
  assert.deepEqual((await lookup()).entries, [])
  assert.deepEqual(calls.splice(0).map(call => call.input), [['beacon']])
  const expanded = await lookup(optIn)
  assert.equal(expanded.stats.query_expansion, 'used')
  assert.deepEqual(expanded.entries.map(item => item.uri), ['viking://user/reader/resources/beacon.md'])
  assert.equal(calls[0].max_tokens, 128)
  assert.deepEqual(JSON.parse(calls[0].messages[1].content), { query: 'beacon' })
  assert.deepEqual(calls.slice(1).map(call => call.input), [['beacon'], ['lighthouse']])
  assert.doesNotMatch(JSON.stringify(calls), /private session narrative|private resource narrative/u)
  calls.length = 0
  planned = { queries: ['lighthouse'], category: 'resources' }
  const invalid = await lookup(optIn)
  assert.equal(invalid.stats.query_expansion, 'failed')
  assert.deepEqual(invalid.entries, [])
  assert.deepEqual(calls.splice(0).slice(1).map(call => call.input), [['beacon']])
  await lookup({ ...optIn, session_id: 'missing' }, 404)
  await json(post(api(runtime, peer), search, request(optIn)), 404)
  await json(post(admin, search, request(optIn)), 403)
  await lookup({ ...optIn, target_uri: 'viking://resources' }, 400)
  await lookup({ ...optIn, quotas: { events: 50, resources: 1 } }, 400)
  await lookup({ ...optIn, rewrite: true }, 501)
  assert.equal(calls.length, 0, 'rejected requests did not reach a provider')
  planned = { queries: ['lighthouse'] }
  const dedup = { ...optIn, dedup_turns: 1, detail: 'full' }
  const firstTurn = await lookup(dedup)
  assert.deepEqual(firstTurn.entries.map(item => item.uri), ['viking://user/reader/resources/beacon.md'])
  assert.match(firstTurn.rendered, /lighthouse private resource narrative/u)
  const sameTurn = await lookup(dedup)
  assert.deepEqual(sameTurn.entries, [])
  assert.deepEqual(sameTurn.stats.dedup, { turns: 1, status: 'ok', cooled: 1, turn: 1 })
  const dedupCalls = calls.splice(0)
  assert.equal(dedupCalls.length, 6)
  for (const i of [0, 3]) {
    assert.deepEqual(JSON.parse(dedupCalls[i].messages[1].content), { query: 'beacon' })
    assert.deepEqual(dedupCalls.slice(i + 1, i + 3).map(call => call.input), [['beacon'], ['lighthouse']])
  }
  assert.doesNotMatch(JSON.stringify(dedupCalls), /private session narrative|private resource narrative/u)
  assert.deepEqual((await lookup({ ...optIn, quotas: {} })).entries, [])
  assert.equal(calls.length, 0)
  hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  planned = { queries: ['lighthouse'] }
  const pending = post(send, search, request(optIn))
  try {
    await Promise.race([hold.entered.promise, pending.then(response => assert.fail(`Planner boundary not reached (${response.status})`))])
    await json(post(admin, config, { vlm: null }))
  } finally { hold.release.resolve() }
  await json(pending, 409)
  assert.equal(calls.length, 1, 'obsolete plan did not reach the embedding provider')
})

test('a context response uses current ACL and refuses retirement while the actual provider is held', { timeout: 20_000 }, async t => {
  const base = 'https://search-held.example.test/v1'
  const key = randomBytes(32).toString('hex')
  let hold, embeddings = 0
  const runtime = await localWorker({ principals: [root, editor, reader], vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: key }]),
  }, async outboundService(req) {
    assert.equal(req.url, `${base}/embeddings`)
    embeddings++
    const body = await req.json()
    if (hold) {
      const { entered, release } = hold
      entered.resolve()
      await release.promise
    }
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })
  } })
  t.after(async () => { hold?.release.resolve(); await runtime.dispose() })
  const admin = api(runtime, root), owner = api(runtime, editor), send = api(runtime, reader)
  const groups = '/api/v1/admin/accounts/fixture/groups'
  const membership = `${groups}/reviewers/members`
  const editMembership = method => json(owner(membership, { method, body: { user_ids: ['reader'] } }))
  await json(post(owner, groups, { group_id: 'reviewers' }))
  await editMembership('PUT')
  await json(post(admin, config, { embedding: { dense: {
    provider: 'openai-compatible', api_base: base, model: 'fixture-vector', dimension: 2,
  } } }))
  const uri = 'viking://resources/docket.md'
  const acl = entries => ({ acl_mode: 'restricted', entries })
  const rules = [{ principal: 'group:reviewers', level: 'read' }]
  await put(owner, uri, 'Fictional docket visible to reviewers.', acl(rules))
  const lookup = () => post(send, search, { mode: 'context', query: 'docket', detail: 'full' })
  assert.equal((await json(lookup())).entries[0].uri, uri)
  const gated = async (mutate, status) => {
    hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
    const pending = lookup()
    try {
      await Promise.race([hold.entered.promise, pending.then(res => assert.fail(`Provider boundary not reached (${res.status})`))])
      await mutate()
    } finally { hold.release.resolve(); hold = undefined }
    return json(pending, status)
  }
  const setAcl = entries => json(owner('/api/v1/acl', { method: 'PUT', body: { uri, ...acl(entries) } }))
  const afterAcl = await gated(() => setAcl([]), 200)
  assert.deepEqual(afterAcl.entries, [])
  assert.equal(afterAcl.rendered, '')
  await setAcl(rules)
  const afterMember = await gated(() => editMembership('DELETE'), 403)
  assert.equal(afterMember.code, 'PERMISSION_DENIED')
  assert.doesNotMatch(JSON.stringify(afterMember), /docket/u)
  assert.equal(embeddings, 4)
})
