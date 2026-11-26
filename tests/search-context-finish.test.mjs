// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('bootstrap', 'root', 'root')
const editor = testPrincipal('fixture', 'editor', 'admin')
const reader = testPrincipal('fixture', 'reader')
const other = testPrincipal('foreign', 'reader')
const search = '/api/v1/search/search', recall = '/api/v1/search/recall', config = '/api/v1/admin/configuration/import'
async function json(reply, status = 200) {
  const response = await reply, body = await response.json()
  assert.equal(response.status, status, body.error?.message)
  return response.ok ? body.result : body.error
}
const req = (send, route, body) => send(route, { method: 'POST', body })
const post = (send, route, body, status) => json(req(send, route, body), status)
const put = (send, uri, content, more) => post(send, '/api/v1/content/write', { uri, content, wait: true, ...more })
const restricted = entries => ({ acl_mode: 'restricted', entries })
const readGrant = [{ principal: 'user:reader', level: 'read' }]
const first = 'viking://resources/a.md', second = 'viking://resources/b.md', hidden = 'viking://resources/hidden.md'
const uris = result => result.entries.map(entry => entry.uri)

test('keyword search ranks and rereads SQLite text with no embedding or reranker', { timeout: 15_000 }, async t => {
  const worker = await localWorker({ principals: [root, editor, reader, other] })
  t.after(() => worker.dispose())
  const send = api(worker, reader), owner = api(worker, editor)
  const write = (uri, content) => put(owner, uri, content, { defer_processing: true })
  await write(first, 'Écume écume écume.')
  await write(second, 'Une seule écume dans le texte de ce document fictif.')
  await write(hidden, 'Écume confidentielle.')
  await json(owner('/api/v1/acl', { method: 'PUT', body: { uri: hidden, ...restricted([]) } }))
  await put(api(worker, other), 'viking://~/resources/sibling.md', 'Écume autre compte.', { defer_processing: true })
  const look = (body = {}, status) => post(send, search, { query: 'E\u0301CUME', search_type: 'keywords', include_provenance: true, ...body }, status)
  const initial = await look({ read_content: true, level: 2 })
  assert.deepEqual(initial.resources.map(row => row.uri), [first, second])
  assert.ok(initial.resources[0].score > initial.resources[1].score)
  assert.equal(initial.resources[0].content, 'Écume écume écume.')
  assert.equal(initial.provenance[0].matched_contexts[0].match_reason, 'keyword_bm25')
  const adjusted = await look({ args: { bm25_k1: 0.5, bm25_b: 0, post_process_input_limit: 2 }, node_limit: 2 })
  assert.notEqual(adjusted.resources[0].score, initial.resources[0].score)
  assert.equal((await look({ query: 'cume' })).total, 0)
  assert.deepEqual(uris(await look({ mode: 'context', exclude_uris: [first], detail: 'full' })), [second])
  await look({ args: { bm25_b: true } }, 400)
  await look({ args: { post_process_input_limit: 1 }, node_limit: 2 }, 400)
  await look({ mode: 'context', args: {} }, 400)
  await look({ image_url: 'https://image.example.test/image.png' }, 400)
  await look({ session_id: 'missing' }, 404)
  await write(first, 'Remplacement sans le mot recherché.')
  assert.deepEqual((await look()).resources.map(row => row.uri), [second])
  await json(owner('/api/v1/acl', { method: 'PUT', body: { uri: hidden, ...restricted(readGrant) } }))
  assert.deepEqual(new Set((await look()).resources.map(row => row.uri)), new Set([second, hidden]))
  console.log(`keyword SQLite bundle sha256=${worker.localBuildSha256}`)
})

test('breadth then depth respects pins and budget; deprecated recall folds into the live ledger', { timeout: 15_000 }, async t => {
  const worker = await localWorker({ principals: [reader], embeddings: 'fixture' })
  t.after(() => worker.dispose())
  const send = api(worker, reader), event = 'viking://user/reader/memories/events/storm.md'
  await post(send, '/api/v1/fs/mkdir', { uri: 'viking://~/memories/events' })
  await put(send, event, `# Summary\nBeacon summary.\n\n# Details\n${'Fictional storm report aboard the beacon vessel. '.repeat(18)}\nFINAL TAIL`)
  const scoped = { query: 'beacon', mode: 'context', context_type: 'memory', score_threshold: -1 }
  const small = await post(send, search, { ...scoped, max_tokens: 75 })
  const large = await post(send, search, { ...scoped, max_tokens: 1000 })
  assert.equal(small.entries[0].detail, 'overview')
  assert.equal(large.entries[0].detail, 'full')
  assert.match(large.rendered, /FINAL TAIL/u)
  assert.equal(large.stats.fill.full_upgrades, 1)
  assert.ok(small.stats.used_tokens <= 75 && large.stats.used_tokens <= 1000)
  assert.doesNotMatch((await post(send, search, { ...scoped, detail: 'overview', max_tokens: 1000 })).rendered, /FINAL TAIL/u)
  await post(send, '/api/v1/sessions', { session_id: 'legacy' })
  const response = await req(send, recall, { query: 'beacon', session_id: 'legacy', max_chars: 400, min_score: -1, render: false })
  assert.equal(response.headers.get('Deprecation'), 'true')
  assert.equal(response.headers.get('Link'), '</api/v1/search/search>; rel="successor-version"')
  const result = await json(response)
  assert.deepEqual(uris(result), [event])
  assert.equal(result.rendered, '')
  assert.equal(result.stats.max_tokens, 100)
  assert.deepEqual(result.stats.deprecated.aliases_used, ['max_chars', 'min_score', 'render'])
  assert.deepEqual(uris(await post(send, search, { ...scoped, session_id: 'legacy', dedup_turns: 5 })), [])
  await post(send, recall, { query: 'beacon', render: 'false' }, 400)
  await post(send, recall, { query: 'beacon', session_id: 'absent' }, 404)
  console.log(`depth and recall bundle sha256=${worker.localBuildSha256}`)
})

test('configured contextual rerank changes the winner and checks ACL after the outbound wait', { timeout: 18_000 }, async t => {
  const base = 'https://context-finish.example.test/v1', endpoint = `${base}/rerank`, calls = []
  const key = randomBytes(32).toString('hex')
  let hold, badReply = false
  const worker = await localWorker({ principals: [root, editor, reader], vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: key }, { api_base: endpoint, api_key: key }]),
  }, async outboundService(request) {
    assert.ok(request.headers.get('authorization') === `Bearer ${key}`)
    const dto = await request.json()
    if (request.url === `${base}/embeddings`) return Response.json({ data: dto.input.map((_, index) => ({ index, embedding: [1, 0] })) })
    assert.equal(request.url, endpoint)
    calls.push(dto)
    if (hold) { hold.entered.resolve(); await hold.release.promise }
    if (badReply) return Response.json({ results: [] })
    return Response.json({ results: dto.documents.map((body, index) => ({ index, relevance_score: body.includes('Preferred') ? 0.96 : 0.2 })) })
  } })
  t.after(async () => { hold?.release.resolve(); await worker.dispose() })
  const admin = api(worker, root), owner = api(worker, editor), send = api(worker, reader)
  await post(admin, config, { embedding: { dense: { provider: 'openai-compatible', api_base: base, model: 'fixture', dimension: 2 } },
    rerank: { provider: 'openai', api_base: endpoint, model: 'local-rank' } })
  await post(send, '/api/v1/fs/mkdir', { uri: 'viking://~/memories/entities' })
  const dir = 'viking://user/reader/memories/entities', a = `${dir}/a.md`, b = `${dir}/b.md`
  await put(send, a, 'First authorized abstract.')
  await put(send, b, 'Preferred authorized abstract.')
  await put(send, `${dir}/excluded.md`, 'Outside excluded body')
  await put(owner, hidden, 'Outside restricted body', { acl: restricted([]) })
  const body = { mode: 'context', query: 'Abstract', limit: 1, detail: 'full', include_provenance: true, exclude_uris: [`${dir}/excluded.md`] }
  const lookup = () => post(send, search, body)
  assert.deepEqual(uris(await lookup()), [a])
  await post(admin, `${config}?dry_run=true`, { retrieval: { apply_rerank_to_context: true } })
  assert.deepEqual(uris(await lookup()), [a])
  assert.equal(calls.length, 0)
  await post(admin, config, { retrieval: { apply_rerank_to_context: true } })
  const ranked = await lookup()
  assert.deepEqual(uris(ranked), [b])
  assert.equal(ranked.provenance[0].matched_contexts[0].score, 0.96)
  assert.deepEqual(ranked.stats.rerank, { used: true, candidates: 2 })
  assert.deepEqual(calls, [{ model: 'local-rank', query: 'Abstract', documents: ['First authorized abstract.', 'Preferred authorized abstract.'], top_n: 2 }])
  badReply = true
  assert.deepEqual(uris(await lookup()), [a])
  badReply = false
  // Remove the selected source after the exact request has reached the reranker.
  hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  const pending = req(send, search, body)
  try {
    await Promise.race([hold.entered.promise, pending.then(res => assert.fail(`Rerank not reached (${res.status})`))])
    await json(send(`/api/v1/fs?uri=${encodeURIComponent(b)}`, { method: 'DELETE' }))
  } finally { hold.release.resolve(); hold = undefined }
  assert.equal((await json(pending, 409)).code, 'CONFLICT')
  assert.deepEqual(uris(await lookup()), [a])

  const folder = 'viking://resources/public-dossier'
  await post(owner, '/api/v1/fs/mkdir', { uri: folder })
  await put(owner, `${folder}/.abstract.md`, 'Authorized directory abstract only.')
  await put(owner, `${folder}/notes.md`, 'Do not transmit the raw resource notes.')
  const setFolder = entries => json(owner('/api/v1/acl', { method: 'PUT', body: { uri: folder, ...restricted(entries) } }))
  await setFolder(readGrant)
  hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  const filtered = { ...body, filter: { uri: folder } }
  const awaiting = req(send, search, filtered)
  try {
    await Promise.race([hold.entered.promise, awaiting.then(res => assert.fail(`Directory rerank not reached (${res.status})`))])
    assert.deepEqual(calls.at(-1).documents, ['Authorized directory abstract only.'])
    await setFolder([])
  } finally { hold.release.resolve(); hold = undefined }
  const denied = await json(awaiting, 409)
  assert.doesNotMatch(JSON.stringify(denied), /directory abstract|public-dossier/u)
  const noCall = calls.length
  assert.deepEqual(uris(await post(send, search, filtered)), [])
  assert.equal(calls.length, noCall)
  console.log(`contextual rerank bundle sha256=${worker.localBuildSha256}`)
})
