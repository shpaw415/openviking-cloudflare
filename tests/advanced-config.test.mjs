// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('bootstrap', 'root', 'root')
const member = testPrincipal('fixture', 'reader')
const peer = testPrincipal('fixture', 'peer')
const config = '/api/v1/admin/configuration/import'
const find = '/api/v1/search/find'
const search = '/api/v1/search/search'
const sessions = '/api/v1/sessions'
const rerankURL = 'https://ranking.example.test/v1/reranks'
const modelURL = 'https://models.example.test/v1'
const secret = () => randomBytes(32).toString('hex')
const inventory = (...entries) => ({ OPENVIKING_EDGE_PROVIDERS: JSON.stringify(entries.map(([api_base, api_key]) => ({ api_base, api_key }))) })
const post = (send, path, body) => send(path, { method: 'POST', body })
const put = async (send, uri, content) => result(await post(send, '/api/v1/content/write', { uri, content, wait: true }))

async function result(response, status = 200, ...hidden) {
  const wire = await response.text()
  assert.ok(hidden.every(key => !wire.includes(key)), 'response did not reveal a fixture secret')
  const payload = JSON.parse(wire)
  assert.equal(response.status, status, payload.error?.code)
  return response.ok ? payload.result : payload.error
}

test('the opted-in reranker consumes a bounded visible shortlist, changes rank, and applies its own threshold', { timeout: 20_000 }, async t => {
  const key = secret(), requests = []
  const runtime = await localWorker({ principals: [root, member, peer], embeddings: 'fixture', vars: inventory([rerankURL, key]),
    async outboundService(req) {
      const body = await req.json()
      requests.push({ url: req.url, bearer: req.headers.get('authorization') === `Bearer ${key}`, dataKey: req.headers.has('x-api-key'), body })
      return Response.json({ results: body.documents.map((text, index) => ({ index, relevance_score: text.includes('Preferred') ? 0.9 : 0.3 })).reverse() })
    } })
  t.after(() => runtime.dispose())
  const admin = api(runtime, root), reader = api(runtime, member)
  const dir = 'viking://~/resources'
  await put(reader, `${dir}/a.txt`, 'sailing compass')
  await put(reader, `${dir}/b.txt`, `Preferred sailing compass ${'œ🙂 '.repeat(200)}`)
  await put(api(runtime, peer), `${dir}/private.txt`, 'sailing compass only Peer may read')
  const lookup = (path, extras = {}) => post(reader, path, { query: 'sailing compass', context_type: ['resource'], level: 2, ...extras })
  const names = data => data.resources.map(item => item.uri.split('/').at(-1))
  assert.deepEqual(names(await result(await lookup(find))), ['a.txt', 'b.txt'])

  const rerank = { provider: 'openai', model: 'fixture-rank', api_base: rerankURL, max_input_tokens: 128, threshold: 0.2, timeout: 1 }
  await result(await post(reader, config, { rerank }), 403, key)
  await result(await post(admin, config, { rerank: { ...rerank, api_base: `${rerankURL}/different` } }), 412, key)
  for (const diff of [{ threshold: -1 }, { timeout: 11 }, { max_input_tokens: 127 }]) {
    await result(await post(admin, config, { rerank: { ...rerank, ...diff } }), 400, key)
  }
  const preview = await result(await post(admin, `${config}?dry_run=true&if_revision=0`, { rerank }), 200, key)
  assert.equal(preview.effective.rerank.configured, true)
  assert.equal((await result(await admin(config))).revision, 0)
  assert.deepEqual(names(await result(await lookup(search))), ['a.txt', 'b.txt'])
  assert.equal(requests.length, 0)

  assert.equal((await result(await post(admin, `${config}?if_revision=0`, { rerank }), 200, key)).revision, 1)
  const reordered = await result(await lookup(find, { include_provenance: true }))
  assert.deepEqual(names(reordered), ['b.txt', 'a.txt'])
  assert.deepEqual(reordered.resources.map(item => [item.score, item.match_reason]), [[0.9, 'provider_rerank'], [0.3, 'provider_rerank']])
  assert.equal(reordered.provenance[0].matched_contexts[0].match_reason, 'provider_rerank')
  assert.deepEqual(requests.map(({ url, bearer, dataKey }) => ({ url, bearer, dataKey })), [{ url: rerankURL, bearer: true, dataKey: false }])
  const { body } = requests[0]
  assert.deepEqual(Object.keys(body).sort(), ['documents', 'model', 'query', 'top_n'])
  assert.equal(body.model, rerank.model)
  assert.equal(body.query, 'sailing compass')
  assert.equal(body.top_n, 2)
  assert.equal(body.documents[0], 'sailing compass')
  assert.match(body.documents[1], /^Preferred sailing compass/u)
  assert.ok(!body.documents[1].includes('\ufffd') && body.documents[1].length < 250)
  await result(await post(admin, `${config}?if_revision=0`, { rerank: null }), 409)
  assert.equal((await result(await post(admin, `${config}?if_revision=1`, { rerank: { ...rerank, threshold: 0.5 } }))).revision, 2)
  assert.deepEqual(names(await result(await lookup(search))), ['b.txt'])
  const gated = await result(await lookup(find, { score_threshold: 0.95 }))
  assert.equal(requests.at(-1).body.top_n, 1) // the cosine gate removes b before dispatch
  assert.deepEqual(names(gated), []) // the remaining a falls under the rerank threshold
  await result(await post(admin, `${config}?if_revision=2`, { rerank: null }))
  assert.deepEqual(names(await result(await lookup(search))), ['a.txt', 'b.txt'])
})

test('rerank timeout, incomplete scores and changed snapshots cannot publish old rankings', { timeout: 20_000 }, async t => {
  const key = secret()
  let started = Promise.withResolvers(), release = Promise.withResolvers()
  let mode = 'incomplete', calls = 0
  const runtime = await localWorker({ principals: [root, member], embeddings: 'fixture', vars: inventory([rerankURL, key]),
    async outboundService(req) {
      calls++
      await req.json()
      if (mode === 'timeout') return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })
      if (mode === 'incomplete') return Response.json({ results: [] })
      started.resolve()
      await release.promise
      return Response.json({ results: [{ index: 0, relevance_score: 0.99 }] })
    } })
  t.after(() => { release.resolve(); return runtime.dispose() })
  const admin = api(runtime, root), reader = api(runtime, member)
  await put(reader, 'viking://~/resources/light.txt', 'sailing compass')
  const lookup = () => post(reader, find, { query: 'sailing compass', target_uri: 'viking://~/resources', level: 2 })
  const rerank = { provider: 'openai', model: 'fixture-rank', api_base: rerankURL, timeout: 0.1 }
  await result(await post(admin, config, { rerank }))
  assert.equal((await result(await lookup(), 503, key)).code, 'RERANK_UNAVAILABLE')
  mode = 'timeout'
  assert.equal((await result(await lookup(), 503, key)).code, 'RERANK_UNAVAILABLE')
  assert.equal(calls, 2)
  mode = 'valid'
  await result(await post(admin, config, { rerank: { ...rerank, timeout: 3 } }))
  const gatedLookup = async () => {
    started = Promise.withResolvers()
    release = Promise.withResolvers()
    const pending = lookup()
    await Promise.race([started.promise, pending.then(res => assert.fail(`search escaped the provider gate: ${res.status}`))])
    return { pending }
  }
  const trial = await gatedLookup()
  await result(await post(admin, `${config}?dry_run=true&if_revision=2`, { rerank: null }))
  release.resolve()
  assert.equal((await result(await trial.pending)).resources[0].match_reason, 'provider_rerank')

  const edited = await gatedLookup()
  await put(reader, 'viking://~/resources/light.txt', 'sailing compass for the fictional lighthouse')
  release.resolve()
  assert.equal((await result(await edited.pending, 409, key)).code, 'CONFLICT')

  const oldRevision = await gatedLookup()
  await result(await post(admin, `${config}?if_revision=2`, { rerank: null }))
  release.resolve()
  await result(await oldRevision.pending, 409, key)
  assert.equal((await result(await lookup())).resources[0].match_reason, 'cosine_similarity')
  assert.equal(calls, 5)
})

test('session context budgets change the history actually sent to the embedding provider', async t => {
  const requests = [], key = secret()
  const runtime = await localWorker({ principals: [root, member, peer], vars: inventory([modelURL, key]), async outboundService(req) {
    const body = await req.json()
    requests.push(body.input)
    return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })) })
  } })
  t.after(() => runtime.dispose())
  const admin = api(runtime, root), reader = api(runtime, member)
  await result(await post(admin, config, { embedding: { dense: { provider: 'openai-compatible', api_base: modelURL, model: 'fixture-vector', dimension: 2 } } }))
  await put(reader, 'viking://~/resources/light.txt', 'Fictional lighthouse')
  const id = 'planner-fixture'
  await result(await post(reader, sessions, { session_id: id }))
  for (const [role, content] of [['user', 'older signal'], ['assistant', 'not the user'], ['user', `latest signal ${'🙂'.repeat(70)}`]]) {
    await result(await post(reader, `${sessions}/${id}/messages`, { role, content }))
  }
  const lookup = () => post(reader, search, { session_id: id, query: 'lighthouse', include_provenance: true })
  const count = value => value.provenance[0].thinking_trace.statistics.session_messages_used
  assert.equal(count(await result(await lookup())), 2)
  assert.match(requests.at(-1)[1], /older signal\nlatest signal/u)
  assert.doesNotMatch(requests.at(-1)[1], /not the user/u)
  await result(await post(admin, config, { retrieval: { session_context_messages: 1 } }))
  assert.equal(count(await result(await lookup())), 1)
  assert.doesNotMatch(requests.at(-1)[1], /older signal/u)
  const long = requests.at(-1)[1]
  await result(await post(admin, config, { retrieval: { session_context_messages: 1, session_context_chars: 65 } }))
  assert.equal(count(await result(await lookup())), 1)
  const recent = requests.at(-1)[1].split('\n\nCurrent query:\n')[0].split('\n')[1]
  assert.match(recent, /^latest signal/u)
  assert.ok(recent.length <= 65 && !/\p{Cs}/u.test(recent) && requests.at(-1)[1].length < long.length)
  const before = requests.length
  await result(await post(api(runtime, peer), search, { session_id: id, query: 'lighthouse' }), 404)
  assert.equal(requests.length, before)
  await result(await post(admin, config, { retrieval: { enable_intent: false, session_context_messages: 1 } }), 400)
  await result(await post(admin, config, { retrieval: { session_context_chars: 1025 } }), 400)
  await result(await post(admin, config, { retrieval: null }))
  assert.equal(count(await result(await lookup())), 2)
})

test('session archive settings cap real extraction and context, and disabling extraction leaves the archive intact', async t => {
  const calls = [], key = secret()
  const runtime = await localWorker({ principals: [root, member], embeddings: 'fixture', vars: inventory([modelURL, key]), async outboundService(req) {
    const body = await req.json()
    calls.push(body)
    const content = body.messages[0].content.includes('event_name')
      ? JSON.stringify({ events: [{ page_id: 100, event_name: 'Lighthouse painted', goal: 'Preserve a local decision', summary: 'The lighthouse was painted on the fictional island.', ranges: '0' }] })
      : 'The fictional lighthouse remains white.'
    return Response.json({ choices: [{ message: { role: 'assistant', content } }] })
  } })
  t.after(() => runtime.dispose())
  const admin = api(runtime, root), reader = api(runtime, member)
  const vlm = { provider: 'openai-compatible', api_base: modelURL, model: 'fixture-chat' }
  await result(await post(admin, config, { vlm, memory: { edge_extraction_max_tokens: 128, edge_context_token_budget: 12 } }))
  const id = 'budget-fixture', path = `${sessions}/${id}`
  const add = content => post(reader, `${path}/messages`, { role: 'user', content }).then(result)
  await result(await post(reader, sessions, { session_id: id }))
  await add('Lighthouse painted white on a fictional island.')
  await add('The newest note.')
  const context = () => reader(`${path}/context?token_budget=10000`).then(result)
  assert.equal((await context()).messages.length, 1)
  assert.equal((await result(await post(reader, `${path}/commit?wait=true`, {}))).memories_extracted, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].max_tokens, 128)
  assert.equal(JSON.parse(calls[0].messages[1].content).transcript[0].text, 'Lighthouse painted white on a fictional island.')

  await result(await post(admin, `${config}?if_revision=1`, { memory: { extraction_enabled: false } }))
  await add('Another fictional event.')
  const plain = await result(await post(reader, `${path}/commit?wait=true`, { enable_working_memory: true }))
  assert.equal(plain.memories_extracted, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].max_tokens, 512, 'working recap has a separate budget')
  assert.doesNotMatch(calls[1].messages[0].content, /event_name/u)
  const archive = await result(await reader(`${path}/archives/archive_002`))
  assert.equal(archive.status, 'completed')
  assert.equal(archive.messages.length, 1)
  assert.equal(archive.overview, 'The fictional lighthouse remains white.')
  await result(await post(admin, `${config}?if_revision=2`, { vlm: null }))
  await add('Archive without a provider.')
  assert.equal((await result(await post(reader, `${path}/commit?wait=true`, {}))).archived, true)
  assert.equal(calls.length, 2)
  await result(await post(admin, config, { memory: { edge_extraction_max_tokens: 1537 } }), 400)
  await result(await post(admin, config, { memory: { extraction_output_format: 'python' } }), 501)
})

test('new sessions inherit durable message and token triggers, without changing existing or explicitly disabled sessions', { timeout: 20_000 }, async t => {
  const runtime = await localWorker({ principals: [root, member] })
  t.after(() => runtime.dispose())
  const admin = api(runtime, root), reader = api(runtime, member)
  const create = (id, options = {}) => post(reader, sessions, { session_id: id, ...options }).then(result)
  const append = (id, content) => post(reader, `${sessions}/${id}/messages`, { role: 'user', content }).then(result)
  const details = id => reader(`${sessions}/${id}`).then(result)
  const wait = () => post(reader, '/api/v1/system/wait', { timeout: 5 }).then(result)
  const memory = session_auto_commit => ({ memory: { extraction_enabled: false, session_auto_commit } })
  const changes = memory({ enabled: true, message_count_threshold: 2, pending_token_threshold: 0 })
  assert.equal((await create('before')).auto_commit_policy, null)
  await result(await post(admin, `${config}?dry_run=true&if_revision=0`, changes))
  assert.equal((await create('preview')).auto_commit_policy, null)
  await result(await post(admin, `${config}?if_revision=0`, changes))
  const id = 'count-trigger'
  const created = await create(id)
  assert.equal(created.auto_commit_policy.message_count_threshold, 2)
  assert.equal(created.auto_commit_policy.pending_token_threshold, 0)
  assert.equal((await create('explicit-off', { auto_commit_policy: null })).auto_commit_policy, null)
  for (const content of ['First note.', 'Second note.']) await append(id, content)
  await wait()
  assert.equal((await details(id)).message_count, 2)
  await append(id, 'Third note.')
  await wait()
  assert.equal((await details(id)).message_count, 0)
  assert.equal((await result(await reader(`${sessions}/${id}/archives/archive_001`))).messages.length, 3)

  await result(await post(admin, `${config}?if_revision=1`, memory({ enabled: true, message_count_threshold: 0, pending_token_threshold: 12 })))
  await append('tokens-trigger', 'Short note.') // implicit creation through the real append transaction
  await wait()
  assert.equal((await details('tokens-trigger')).message_count, 1)
  await append('tokens-trigger', 'A sufficiently long note about a fictional island and its lighthouse.')
  await wait()
  assert.equal((await details('tokens-trigger')).message_count, 0)
  assert.equal((await result(await reader(`${sessions}/tokens-trigger/archives/archive_001`))).messages.length, 2)
  for (const unchanged of ['before', 'preview', 'explicit-off']) assert.equal((await details(unchanged)).auto_commit_policy, null)
  await result(await post(admin, config, memory({ enabled: true, message_count_threshold: 0, pending_token_threshold: 0 })), 400)
  await result(await post(admin, config, memory({ enabled: true, idle_backend: 'redis' })), 501)
  await result(await post(admin, config, memory({ enabled: false })))
  assert.equal((await result(await reader(`${sessions}/autocreate?auto_create=true`))).auto_commit_policy, null)
  assert.equal((await details(id)).auto_commit_policy.message_count_threshold, 2)
})

test('HTTP VLM top_p reaches JSON and SSE and max_concurrent holds a slot until the stream finishes', { timeout: 20_000 }, async t => {
  const key = secret(), calls = [], release = Promise.withResolvers(), other = testPrincipal('independent', 'reader')
  const vars = { ...inventory([modelURL, key]), OPENVIKING_EDGE_OPERATOR_STREAMING: '1' }
  const runtime = await localWorker({ principals: [root, member, peer, other], vars, embeddings: 'fixture', async outboundService(req) {
    const body = await req.json()
    calls.push(body)
    assert.equal(req.url, `${modelURL}/chat/completions`)
    if (!body.stream) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Fixture reply' } }] })
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({ async start(controller) {
      // This new F4 fixture ends the held delta on a public text boundary.
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"First fixture delta!"},"finish_reason":null}]}\n\n'))
      await release.promise
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
      controller.close()
    } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  t.after(() => { release.resolve(); return runtime.dispose() })
  const admin = api(runtime, root)
  const vlm = { provider: 'openai-compatible', api_base: modelURL, model: 'fixture-chat', top_p: 0.55, max_concurrent: 1 }
  const chat = (principal, stream = false) => post(api(runtime, principal), '/gateway/v1/chat/completions',
    { model: vlm.model, messages: [{ role: 'user', content: 'Fictional prompt.' }], stream })
  await result(await post(admin, config, { vlm: { ...vlm, top_p: 1.1 } }), 400)
  await result(await post(admin, config, { vlm: { ...vlm, max_concurrent: 0 } }), 400)
  await result(await post(admin, config, { vlm: { provider: 'workers_ai', model: '@cf/meta/llama-3.1-8b-instruct', top_p: 0.55 } }), 501)
  await result(await post(admin, `${config}?if_revision=0`, { vlm }))
  const first = await chat(member, true)
  assert.equal(first.status, 200)
  const reader = first.body.getReader(), decoder = new TextDecoder()
  let prefix = ''
  while (!prefix.includes('First fixture delta')) {
    const { value, done } = await reader.read()
    assert.equal(done, false)
    prefix += decoder.decode(value, { stream: true })
  }
  const blocked = await chat(peer)
  assert.equal(blocked.status, 429)
  await blocked.body.cancel()
  assert.equal(calls.length, 1)
  const independent = await chat(other)
  assert.equal(independent.status, 200)
  await independent.text()
  release.resolve()
  let tail = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    tail += decoder.decode(value, { stream: true })
  }
  assert.match(tail, /\[DONE\]/u)
  const after = await chat(peer)
  assert.equal(after.status, 200)
  await after.text()
  assert.deepEqual(calls.map(item => [item.stream, item.top_p]), [[true, 0.55], [false, 0.55], [false, 0.55]])
  await result(await post(admin, `${config}?if_revision=1`, { vlm: { ...vlm, top_p: null } }))
  const reset = await chat(peer)
  assert.equal(reset.status, 200)
  await reset.text()
  assert.equal(calls.at(-1).top_p, undefined)
})

test('dense encoding and batch size reach the provider, remain pinned after restart and never mix partial vectors', { timeout: 20_000 }, async t => {
  const key = secret(), calls = [], dir = await mkdtemp(join(tmpdir(), 'ov-f4-models-'))
  const established = testPrincipal('established', 'reader'), newSpace = testPrincipal('after-reset', 'reader')
  let runtime, invalidWire = false
  t.after(async () => { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }) })
  const launch = () => localWorker({ principals: [root, member, established, newSpace], embeddings: 'fixture', persist: dir, vars: inventory([modelURL, key]), async outboundService(req) {
    const body = await req.json()
    assert.equal(req.url, `${modelURL}/embeddings`)
    assert.equal(req.headers.get('authorization') === `Bearer ${key}`, true)
    calls.push(body)
    const data = body.input.map((text, index) => {
      const coordinates = text.includes('harbor') ? [1, 0] : [0, 1]
      if (body.encoding_format === 'float') return { index, embedding: coordinates }
      const bytes = Buffer.alloc(8)
      coordinates.forEach((value, i) => bytes.writeFloatLE(value, i * 4))
      if (invalidWire && text === 'invalid fixture') bytes.writeFloatLE(NaN, 0)
      return { index, embedding: bytes.toString('base64') }
    }).reverse()
    return Response.json({ data, usage: { prompt_tokens: body.input.length } })
  } })
  runtime = await launch()
  let admin = api(runtime, root), reader = api(runtime, member)
  const dense = { provider: 'openai-compatible', api_base: modelURL, model: 'fixture-vector', dimension: 2 }
  const edit = (overrides, revision) => post(admin, `${config}?if_revision=${revision}`, { embedding: { dense: { ...dense, ...overrides } } })
  const uri = 'viking://~/resources/route.txt'
  const texts = ['harbor light', 'woods', 'harbor buoy', 'mountain', 'harbor coast']
  const compile = (send, input = texts) => post(send, '/api/v1/compile/embeddings', { target_uri: uri, expected_model: dense.model, texts: input })
  await result(await edit({}, 0))
  await put(api(runtime, established), uri, 'harbor route')
  await result(await edit({ batch_size: 33 }, 1), 400)
  await result(await edit({ encoding_format: 'other' }, 1), 400)
  await result(await post(admin, config, { embedding: { dense: { provider: 'workers_ai', model: '@cf/baai/bge-base-en-v1.5', dimension: 768, encoding_format: 'base64' } } }), 501)
  await result(await edit({ provider: undefined, backend: dense.provider, batch_size: 2, encoding_format: 'base64' }, 1), 200, key)
  await put(reader, uri, 'harbor route')
  calls.length = 0
  assert.deepEqual((await result(await compile(reader))).vectors, [[1, 0], [0, 1], [1, 0], [0, 1], [1, 0]])
  assert.deepEqual(calls.map(call => [call.encoding_format, call.input]), [['base64', texts.slice(0, 2)], ['base64', texts.slice(2, 4)], ['base64', texts.slice(4)]])
  invalidWire = true
  await result(await compile(reader, ['harbor light', 'woods', 'invalid fixture']), 503, key)
  invalidWire = false
  assert.equal((await result(await post(reader, find, { query: 'harbor', target_uri: uri }))).total, 1)
  await result(await edit({ encoding_format: 'float' }, 2))
  await runtime.dispose()
  runtime = await launch()
  admin = api(runtime, root)
  reader = api(runtime, member)
  assert.equal((await result(await admin(config))).revision, 3)
  await put(api(runtime, newSpace), uri, 'harbor route')
  calls.length = 0
  for (const principal of [established, member, newSpace]) assert.equal((await result(await compile(api(runtime, principal)))).vectors.length, 5)
  assert.deepEqual(calls.map(call => [call.encoding_format, call.input.length]), [['float', 5], ['base64', 2], ['base64', 2], ['base64', 1], ['float', 5]])
})
