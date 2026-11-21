// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
// dispatchFetch uses Miniflare's Undici, not Node's global FormData implementation.
import { FormData, Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { api as mountedApi, localWorker, testPrincipal } from './support/local-worker.mjs'
import { replayOriginal } from './fs/replay-original.mjs'
import { gatedWorker, embeddingGate, mountedEndpoint } from './fs/async-worker.mjs'
let runtime

before(async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('./fs/worker.mjs', import.meta.url))],
    bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'],
  })
  runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      name: 'filesystem-fixture', host: '127.0.0.1', port: 0, cf: false, modules: true,
      script: outputFiles[0].text, compatibilityDate: '2026-11-19',
      durableObjects: { DB: { className: 'FilesystemFixture', useSQLite: true } },
    }), enableDevRegistry: false, telemetry: { enabled: false }, logRequests: false,
  })
})
after(async () => { await runtime?.dispose() })

const root = 'viking://'
const shared = `${root}resources`
const own = `${root}~/resources`

function workspace() {
  const id = randomUUID()
  function call(path, { method, query = {}, body, caller, embed } = {}) {
    const url = new URL(path.startsWith('/fixture/') ? path : `/api/v1${path}`, 'http://fixture.invalid')
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item)
    }
    const headers = { 'x-fixture-workspace': id }
    if (caller) headers['x-fixture-caller'] = caller
    if (embed) headers['x-fixture-embed'] = embed
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(body)
    }
    return runtime.dispatchFetch(url, { method: method ?? (body ? 'POST' : 'GET'), headers, body })
  }
  return call
}

async function json(response, status = 200) {
  const res = await response
  const result = await res.json()
  assert.equal(res.status, status, JSON.stringify(result))
  if (status === 200) assert.equal(result.status, 'ok')
  return result
}

test('Studio can browse real directories with pagination and canonical private roots', async () => {
  const api = workspace()
  const initial = await json(api('/fs/ls', { query: { uri: root, output: 'agent', sort_by: 'mtime' } }))
  assert.equal(initial.has_more, false)
  assert.deepEqual(initial.result.map(row => row.uri).sort(), [`${root}agent`, shared, `${root}user`].sort())
  assert.ok(initial.result.every(entry => entry.isDir && 'modTime' in entry))
  const path = `${own}/Caf%C3%A9`
  await json(api('/fs/mkdir', { body: { uri: path, description: 'Fictitious folder' } }))
  const canonical = `${root}user/alice/resources/Café`
  assert.equal((await json(api('/fs/stat', { query: { uri: `${path}/` } }))).result.uri, canonical)
  const tree = await json(api('/fs/tree', { query: { uri: `${root}~/`, level_limit: 3, limit: 1 } }))
  assert.equal(tree.has_more, true)
  assert.equal(tree.result.length, 1)
  const listing = await json(api('/fs/ls', { query: { uri: own, simple: true } }))
  assert.deepEqual(listing.result, [canonical])
})

const write = (api, uri, content, options = {}, extras = {}) => json(api('/content/write', {
  body: { uri, content, ...options }, ...extras,
}))
const read = async (api, uri, options = {}) => (await json(api('/content/read', { query: { uri, ...options } }))).result

const rule = (principal, level) => ({ principal, level })
test('ACL is inherited live, including multiple authenticated groups and restricted sidecars', async () => {
  const api = workspace()
  const dir = `${shared}/garden`, file = `${dir}/plot.md`, sidecar = `${dir}/.abstract.md`
  const mkdir = await json(api('/fs/mkdir', { body: { uri: dir, acl: { acl_mode: 'restricted', entries: [
    rule('group:readers', 'read'), rule('group:editors', 'write'), rule('user:carol', 'read'),
  ] } } }))
  assert.equal(mkdir.result.uri, dir)
  await write(api, file, 'sunflower', { tags: ['kind=flower'] }, { caller: 'member' })
  await write(api, sidecar, 'sunflower summary', { acl: { acl_mode: 'restricted', entries: [] } })
  const stat = (await json(api('/fs/stat', { caller: 'member', query: { uri: dir } }))).result
  assert.equal(stat.abstract, undefined)
  await json(api('/content/abstract', { caller: 'member', query: { uri: dir } }), 403)
  assert.equal((await json(api('/content/read', { caller: 'member', query: { uri: file } }))).result, 'sunflower')
  await json(api('/content/write', { caller: 'reader', embed: 'offline', body: { uri: file, content: 'revision' } }), 403)
  await json(api('/acl', { caller: 'member', query: { uri: dir } }), 403)
  await json(api('/acl/revoke', { body: { uri: dir, principal: 'user:carol' } }))
  await json(api('/fs/attrs', { caller: 'reader', query: { uri: file } }), 403)
  await json(api('/content/download', { caller: 'reader', query: { uri: file } }), 403)
  const listing = (await json(api('/fs/tree', { caller: 'reader', query: { uri: shared, include_tags: true } }))).result
  assert.deepEqual(listing, [])
  for (const [route, body] of [['/search/find', { query: 'botanical', read_content: true }],
    ['/search/glob', { pattern: '**/*.md' }], ['/search/grep', { pattern: 'sunflower' }]]) {
    const result = (await json(api(route, { caller: 'reader', body: { uri: shared, ...body,
      ...(route === '/search/find' && { uri: undefined }) } }))).result
    assert.equal(result.total ?? result.matches.length, 0)
  }
  const report = (await json(api('/acl', { query: { uri: file } }))).result
  assert.equal(report.acl_mode, 'inherit')
  assert.deepEqual(report.direct_entries, [])
  assert.ok(report.inherited_entries.some(entry => entry.principal === 'group:editors' && entry.level === 'write'))
  await json(api('/acl/grant', { body: { uri: file, principal: 'user:external', level: 'read' } }), 400)
  await json(api('/acl/grant', { body: { uri: file, principal: 'group:*', level: 'read' } }), 400)
})

test('ACL changes fence a pending write; transfer preserves destination ACL and removes stale source ACL', async () => {
  const api = workspace()
  const dir = `${shared}/protected`, file = `${dir}/entry.md`, leaf = `${dir}/inner`, pending = `${leaf}/entry.md`
  const acl = { acl_mode: 'restricted', entries: [rule('group:editors', 'write')] }
  await json(api('/fs/mkdir', { body: { uri: dir, acl } }))
  await json(api('/fs/mkdir', { body: { uri: leaf } }))
  await write(api, pending, 'sunflower')
  const slow = api('/content/write', { body: { uri: pending, content: 'volcano' }, caller: 'member', embed: 'paused' })
  try {
    let waiting = false
    for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
      waiting = await (await api('/fixture/gate')).json()
      if (!waiting) await delay(10)
    }
    assert.equal(waiting, true)
    await json(api('/acl/revoke', { body: { uri: dir, principal: 'group:editors' } }))
  } finally {
    await api('/fixture/gate', { method: 'POST' })
  }
  await json(slow, 403)
  assert.equal(await read(api, pending), 'sunflower')

  const source = `${shared}/source.md`, dest = `${shared}/destination.md`
  await write(api, source, 'sunflower', { acl: { acl_mode: 'restricted', entries: [rule('user:bob', 'read')] } })
  await write(api, dest, 'old destination', { acl: { acl_mode: 'restricted', entries: [rule('user:carol', 'read')] } })
  await json(api('/fs/mv', { body: { from_uri: source, to_uri: dest, overwrite: true } }))
  await json(api('/content/read', { caller: 'member', query: { uri: dest } }), 403)
  assert.equal((await json(api('/content/read', { caller: 'reader', query: { uri: dest } }))).result, 'sunflower')
  await write(api, source, 'new incarnation')
  assert.equal((await json(api('/acl', { query: { uri: source } }))).result.acl_mode, 'inherit')
  await write(api, file, 'sunflower', { acl: { acl_mode: 'restricted', entries: [rule('user:carol', 'read')] } })
  const found = (await json(api('/search/find', { caller: 'reader', body: { query: 'botanical', target_uri: dir } }))).result
  assert.deepEqual(found.resources.map(hit => hit.uri), [file])
  await json(api('/fs/ls', { caller: 'reader', query: { uri: dir } }), 403)
})

// PAR-01. Use real reads of only synthetic fixture data as the before/after
// oracle. Compare both the exact tree revision and the observable search index.
async function treeProof(api, base) {
  const revision = (await json(api('/fixture/subtree', { query: { uri: base } }))).result
  const listing = (await json(api('/fs/tree', { query: { uri: base, include_tags: true } }))).result
  const acl = []
  for (const item of listing) acl.push((await json(api('/acl', { query: { uri: item.uri } }))).result)
  const index = (await json(api('/search/find', { body: { query: 'botanical', target_uri: base,
    score_threshold: -1, read_content: true, level: [2] } }))).result
  return { revision, listing, acl, index }
}

const canManageTree = { acl_mode: 'restricted', entries: [rule('group:editors', 'manage')] }
const childReadOnly = { acl_mode: 'restricted', entries: [rule('group:readers', 'read')] }

for (const operation of ['delete', 'move', 'copy overwrite', 'move overwrite']) {
  test(`PAR-01 ${operation} is atomic when a descendant lacks manage`, async () => {
    const api = workspace()
    const base = `${shared}/audit-garden`, from = `${base}/source`, to = `${base}/destination`
    const overwrite = operation.endsWith('overwrite')
    const protectedLeaf = overwrite ? `${to}/destination-only.md` : `${from}/restricted.md`
    await json(api('/fs/mkdir', { body: { uri: base, acl: canManageTree } }))
    await json(api('/fs/mkdir', { body: { uri: from } }))
    if (overwrite) {
      await json(api('/fs/mkdir', { body: { uri: to } }))
      await write(api, `${to}/ordinary.md`, 'volcano')
    }
    await write(api, `${from}/ordinary.md`, 'sunflower')
    await write(api, protectedLeaf, 'sunflower archive', { acl: childReadOnly, tags: ['kind=sample'] })
    const before = await treeProof(api, base)
    const attempt = () => operation === 'delete'
      ? api('/fs', { method: 'DELETE', query: { uri: from, recursive: true }, caller: 'member' })
      : api(operation.startsWith('copy') ? '/fs/cp' : '/fs/mv', { body: { from_uri: from, to_uri: to, overwrite,
        ...(operation.startsWith('copy') && { recursive: true }) }, caller: 'member' })
    const result = await json(attempt(), 403)
    assert.equal(result.error.code, 'PERMISSION_DENIED')
    assert.deepEqual(await treeProof(api, base), before, 'A denied operation keeps the entire tree, ACLs and index unchanged')

    await json(api('/acl/grant', { body: { uri: protectedLeaf, principal: 'user:bob', level: 'manage' } }))
    await json(attempt())
    const after = await treeProof(api, base)
    assert.notEqual(after.revision, before.revision)
    assert.equal(after.listing.some(item => item.uri === protectedLeaf), false)
    const survivingUri = operation === 'delete' ? undefined : `${to}/ordinary.md`
    if (survivingUri) {
      assert.equal(await read(api, survivingUri), 'sunflower')
      assert.ok(after.index.resources.some(item => item.uri === survivingUri && item.score === 1))
    } else assert.equal(after.index.total, 0)
    if (operation.startsWith('move')) await json(api('/fs/stat', { query: { uri: from } }), 404)
  })
}

test('PAR-01 file overwrite preserves destination ACL with write, without requiring manage', async () => {
  const api = workspace()
  const base = `${shared}/audit-leaves`, from = `${base}/source.md`, to = `${base}/destination.md`
  await json(api('/fs/mkdir', { body: { uri: base, acl: canManageTree } }))
  await write(api, from, 'sunflower')
  await write(api, to, 'volcano', { acl: { acl_mode: 'restricted', entries: [rule('group:editors', 'write')] } })
  const report = (await json(api('/acl', { query: { uri: to } }))).result
  await json(api('/fs/cp', { caller: 'member', body: { from_uri: from, to_uri: to, overwrite: true } }))
  assert.equal(await read(api, from), 'sunflower')
  assert.equal(await read(api, to), 'sunflower')
  assert.deepEqual((await json(api('/acl', { query: { uri: to } }))).result, report)
  await json(api('/fs/mv', { caller: 'member', body: { from_uri: from, to_uri: to, overwrite: true } }))
  await json(api('/content/read', { query: { uri: from } }), 404)
  assert.equal(await read(api, to), 'sunflower')
  assert.deepEqual((await json(api('/acl', { query: { uri: to } }))).result, report)
})

test('subtree façade commits a guarded patch with its journal and refuses historical reads after deletion', async () => {
  const api = workspace()
  const uri = `${shared}/archive`, file = `${uri}/item.md`
  await json(api('/fs/mkdir', { body: { uri } }))
  await write(api, file, 'sunflower')
  const revision = (await json(api('/fixture/subtree', { query: { uri } }))).result
  const plan = { expectedRevision: revision, delete: ['item.md'], entries: [
    { path: 'item.md', is_dir: false, content: 'volcano', description: '', tags: ['type=demo'] },
  ] }
  await json(api('/fixture/subtree', { query: { uri }, body: { plan, dry_run: true }, embed: 'offline' }))
  assert.equal(await read(api, file), 'sunflower')
  await json(api('/fixture/subtree', { query: { uri }, body: { plan, fail: true } }), 409)
  assert.equal(await read(api, file), 'sunflower')
  await json(api('/fixture/subtree', { query: { uri }, body: { check: true }, caller: 'reader' }))
  const applied = (await json(api('/fixture/subtree', { query: { uri }, body: { plan } }))).result
  assert.notEqual(applied.revision, revision)
  assert.equal(await read(api, file), 'volcano')
  await json(api('/fixture/subtree', { query: { uri }, body: { plan } }), 409)
  await json(api('/fixture/subtree', { query: { uri }, body: { check: true }, caller: 'reader' }), 403)
  await json(api('/fixture/subtree', { query: { uri }, body: { check: true } }))
})

test('batch-write checks text revisions and reports skipped conflicts without losing valid writes', async () => {
  const api = workspace()
  const uri = `${own}/batch`, file = `${uri}/old.md`, next = `${uri}/next.md`
  await json(api('/fs/mkdir', { body: { uri } }))
  await write(api, file, 'sunflower')
  const expected = createHash('sha256').update('volcano').digest('hex')
  const body = { root_uri: uri, operations: [ { uri: file, mode: 'replace', expected_sha256: expected, content: 'rocks' },
    { uri: next, mode: 'append', content_base64: Buffer.from('géologie', 'utf8').toString('base64') } ] }
  await json(api('/content/batch-write', { body }), 409)
  await json(api('/content/read', { query: { uri: next } }), 404)
  const result = (await json(api('/content/batch-write', { body: { ...body, skip_conflicts: true } }))).result
  assert.deepEqual(result.created, [`${root}user/alice/resources/batch/next.md`])
  assert.equal(result.conflicts[0].code, 'CONFLICT')
  assert.equal(await read(api, next), 'géologie')
  assert.equal(await read(api, file), 'sunflower')
  const tags = (await json(api('/content/batch_set_tags', { body: { uris: [next, `${uri}/absent.md`, next], tags: ['kind=rock'] } }))).result
  assert.equal(tags.items.length, 1)
  assert.equal(tags.failed[0].error.code, 'NOT_FOUND')
})

test('directory index only seeds missing summaries and reindex publishes a deferred file', async () => {
  const api = workspace()
  const uri = `${own}/index`, note = `${uri}/unindexed.md`
  await json(api('/fs/mkdir', { body: { uri } }))
  const ensure = { uri, fallback_abstract: 'sunflower synopsis', wait: true }
  await json(api('/content/ensure_directory_index', { body: ensure, embed: 'offline' }), 503)
  await json(api('/content/abstract', { query: { uri } }), 404)
  const created = (await json(api('/content/ensure_directory_index', { body: ensure }))).result
  assert.equal(created.created_abstract, true)
  assert.deepEqual(created.indexed_levels, [0])
  const again = (await json(api('/content/ensure_directory_index', { body: { ...ensure, fallback_abstract: 'unused' }, embed: 'offline' }))).result
  assert.equal(again.created_abstract, false)
  assert.equal((await json(api('/content/abstract', { query: { uri } }))).result, 'sunflower synopsis')
  await write(api, note, 'volcano geology', { defer_processing: true }, { embed: 'offline' })
  const find = () => json(api('/search/find', { body: { query: 'geological', target_uri: note, score_threshold: 0.9 } }))
  assert.equal((await find()).result.total, 0)
  const reindex = (await json(api('/content/reindex', { body: { uri, mode: 'vectors_only', recursive: true } }))).result
  assert.equal(reindex.rebuilt_records, 1)
  assert.equal((await find()).result.total, 1)
})

test('portable predicates intersect with ACL before result/provenance and do not require an embedding for filter-only', async () => {
  const api = workspace()
  const file = `${shared}/plants.md`, secret = `${shared}/archive.md`
  await write(api, file, 'sunflower', { tags: ['field=garden'] })
  await write(api, secret, 'sunflower', { tags: ['field=garden'], acl: { acl_mode: 'restricted' } })
  const filter = { op: 'and', conds: [{ op: 'must', field: 'search_tags', conds: ['field=garden'] },
    { op: 'range', field: 'level', gte: 2 }] }
  const metadata = (await json(api('/search/find', { caller: 'member', embed: 'offline', body: {
    filter, include_provenance: true, read_content: true,
  } }))).result
  assert.equal(metadata.provenance, undefined)
  assert.deepEqual(metadata.resources.map(row => [row.uri, row.score, row.content]), [[file, 0, 'sunflower']])
  const result = (await json(api('/search/search', { caller: 'member', body: {
    query: 'botanical', target_uri: shared, since: '2w', filter, include_provenance: true,
  } }))).result
  assert.equal(result.provenance[0].query, 'botanical')
  assert.deepEqual(result.provenance[0].matched_contexts.map(row => [row.uri, row.tier]), [[file, 'L2']])
  assert.deepEqual(result.provenance[0].searched_directories, [shared])
  await json(api('/search/find', { body: { query: 'botanical', filter: { op: 'must', field: 'acl_direct_grants', conds: ['user:*'] } } }), 400)
})

test('search with session uses only that actor’s recent user turns and leaves an empty session equivalent to plain search', async () => {
  const actor = testPrincipal('fs-context-fixture', 'editor', 'user', 'main')
  const peer = testPrincipal(actor.accountId, actor.userId, 'user', 'another-agent')
  const principal2 = testPrincipal('fs-context-fixture', 'other-user')
  let calls = []
  const worker = await gatedWorker([actor, peer, principal2], async texts => {
    calls.push(...texts)
    return { data: texts.map(text => {
      const vector = Array(768).fill(0)
      if (/glacier/i.test(text)) vector[1] = 1
      else if (text === 'that note') { vector[0] = 1; vector[1] = 1 }
      else vector[0] = 1
      return vector
    }) }
  })
  const api = mountedEndpoint(worker, actor)
  try {
    await write(api, `${own}/a-garden.md`, 'sunflower observations')
    const relevant = (await write(api, `${own}/b-route.md`, 'glacier trail observations')).result.uri
    const session = (await json(api('/sessions', { body: {} }))).result.session_id
    const body = { query: 'that note', node_limit: 1, include_provenance: true }
    const plain = (await json(api('/search/search', { body }))).result
    assert.ok(plain.resources[0].uri.endsWith('/a-garden.md'))
    assert.deepEqual((await json(api('/search/search', { body: { ...body, session_id: session } }))).result, plain)
    await json(api(`/sessions/${session}/messages`, { body: { role: 'user', content: 'The subject is glacier trails.' } }))
    await json(api(`/sessions/${session}/messages`, { body: { role: 'assistant', content: 'auxiliary-only-fixture-sentinel' } }))
    const result = (await json(api('/search/search', { body: { ...body, session_id: session } }))).result
    assert.equal(result.resources[0].uri, relevant)
    assert.equal(result.provenance[0].query, 'that note')
    assert.ok(!JSON.stringify(result).includes('The subject is glacier trails.'))
    assert.ok(calls.some(input => input.includes('The subject is glacier trails.')))
    assert.ok(calls.every(input => !input.includes('auxiliary-only-fixture-sentinel')))
    calls = []
    for (const foreign of [peer, principal2]) await json(mountedEndpoint(worker, foreign)('/search/search', { body: { ...body, session_id: session } }), 404)
    await json(api('/search/search', { body: { ...body, session_id: 'absent-session' } }), 404)
    assert.deepEqual(calls, [])
  } finally { await worker.dispose() }
})

test('search with session does not publish stale results if that session is deleted during embedding', async () => {
  const actor = testPrincipal('fs-context-deletion', 'editor')
  const gate = embeddingGate(texts => texts.some(input => input.includes('session-deletion-fixture')))
  const worker = await gatedWorker([actor], gate.provider)
  const api = mountedEndpoint(worker, actor)
  try {
    const session = (await json(api('/sessions', { body: {} }))).result.session_id
    await json(api(`/sessions/${session}/messages`, { body: { role: 'user', content: 'session-deletion-fixture' } }))
    const pending = api('/search/search', { body: { query: 'botanical', session_id: session } })
    try {
      await waitAtProvider(gate)
      await json(api(`/sessions/${session}`, { method: 'DELETE' }))
    } finally { gate.release() }
    await json(pending, 404)
  } finally { gate.release(); await worker.dispose() }
})

test('skills retain inert definitions, distinct mounts, integrity hashes and an audit after removal', async () => {
  const api = workspace()
  const data = '---\nname: plant-notes\ndescription: A sunflower reference\nallowed-tools: Read\ntags: [garden, notes]\n---\n# Plant notes\n'
  const valid = (await json(api('/skills/validate', { body: { data, skill_dir_name: 'plant-notes', strict: true }, embed: 'offline' }))).result
  assert.equal(valid.valid, true)
  assert.deepEqual(valid.allowed_tools, ['Read'])
  const bad = (await json(api('/skills/validate', { body: { data, skill_dir_name: 'different', strict: true } }))).result
  assert.equal(bad.errors[0].rule, 'name_matches_directory')
  const sharedSkills = 'viking://agent/skills'
  const created = (await json(api('/skills', { body: { data }, caller: 'member' }))).result
  assert.equal(created.owner_user_id, 'bob')
  await json(api('/skills/plant-notes', { caller: 'reader' }), 404)
  await json(api('/skills', { body: { data, target_uri: sharedSkills }, caller: 'member', embed: 'offline' }), 403)
  await json(api('/skills', { body: { data, target_uri: sharedSkills } }))
  assert.equal((await json(api('/skills', { caller: 'member' }))).result.total, 2)
  assert.equal((await json(api('/skills', { caller: 'otherAccount' }))).result.total, 0)
  const found = (await json(api('/skills/find', { body: { query: 'botanical', level: [0], limit: 2 }, caller: 'member' }))).result
  assert.equal(found.total, 2)
  assert.ok(found.skills.every(item => item.uri.endsWith('/.abstract.md') && item.level === 0))
  const shown = (await json(api('/skills/plant-notes', { query: { include_integrity: true, include_source: true } }))).result
  assert.equal(shown.content, data)
  assert.equal(shown.source.type, 'api')
  assert.equal(shown.content_sha256, createHash('sha256').update(data).digest('hex'))
  await json(api('/content/write', { caller: 'member', body: { uri: `${sharedSkills}/plant-notes/SKILL.md`, content: data } }), 403)
  const options = { method: 'PUT', caller: 'member', body: { data: data.replace('sunflower reference', 'volcano reference') } }
  await json(api('/skills/plant-notes', { ...options, embed: 'offline' }), 503)
  assert.equal((await json(api('/skills/plant-notes/audit', { caller: 'member' }))).result.events.length, 1)
  await json(api('/skills/plant-notes', options))
  await json(api('/skills/plant-notes', { method: 'DELETE', caller: 'member' }))
  const audit = (await json(api('/skills/plant-notes/audit', { caller: 'member' }))).result
  assert.equal(audit.deleted, true)
  assert.deepEqual(audit.events.map(event => event.operation), ['create', 'update', 'delete'])
  assert.equal(audit.events[0].after_hash, audit.events[1].before_hash)
  assert.equal(audit.events[2].after_hash, null)
  assert.equal((await json(api('/skills/plant-notes', { caller: 'member' }))).result.root_uri, `${sharedSkills}/plant-notes`)
})

test('CLI skill file preview is read-only, then the actor installs its staged Markdown once', async () => {
  const actor = testPrincipal('fs-skill-stage', 'editor', 'user', 'main')
  const peers = [testPrincipal(actor.accountId, 'another'), testPrincipal(actor.accountId, actor.userId, 'user', 'another-agent'),
    testPrincipal('fs-skill-other', actor.userId, 'admin', 'main')]
  const model = embeddingGate(() => false)
  let calls = 0
  const worker = await gatedWorker([actor, ...peers], texts => { calls++; return model.provider(texts) })
  const api = mountedEndpoint(worker, actor)
  const name = 'cli_test_skill_fixture', leaf = 'candidate-note.md'
  const description = 'A test skill for CLI automation'
  const text = `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nLocal Markdown fixture.`
  try {
    const form = new FormData()
    form.set('file', new File([text], leaf, { type: 'application/octet-stream' }))
    const { temp_file_id } = (await json(api('/resources/temp_upload', { body: form }))).result
    const givenPath = `/fictional-client-directory/${leaf}`
    const body = { temp_file_id, source_metadata: { type: 'local', source: givenPath, path: givenPath } }
    const preview = { ...body, wait: false, list_only: true }
    assert.deepEqual((await json(api('/skills', { body: preview }))).result,
      { skills: [{ name, description, path: leaf }], total: 1 })
    assert.equal((await json(api('/skills'))).result.total, 0)
    for (const other of peers) {
      const foreign = mountedEndpoint(worker, other)
      for (const payload of [preview, { ...body, wait: true }]) {
        assert.equal((await json(foreign('/skills', { body: payload }), 404)).error.code, 'NOT_FOUND')
      }
    }
    assert.equal(calls, 0, 'preview and foreign inputs must not invoke embeddings')
    const installed = (await json(api('/skills', { body: { ...body, wait: true } }))).result
    assert.equal(installed.root_uri, `viking://user/editor/skills/${name}`)
    const shown = (await json(api(`/skills/${name}`, { query: { include_source: true, level: 2 } }))).result
    assert.equal(shown.content, text)
    assert.equal(shown.source.original_filename, leaf)
    assert.ok(!JSON.stringify(shown.source).includes(givenPath))
    await json(api('/skills', { body: preview }), 404)
    await json(api('/skills', { body: { ...body, wait: true } }), 404)
  } finally { await worker.dispose() }
})

test('CLI skill file validation and indexing failures do not consume the staged file', async () => {
  const api = workspace()
  const invalidStage = (await json(upload(api, 'invalid.md', '# No frontmatter', 'application/octet-stream'))).result.temp_file_id
  for (const list_only of [true, false, true]) {
    const reply = await json(api('/skills', { body: { temp_file_id: invalidStage, list_only }, embed: 'offline' }), 400)
    assert.equal(reply.error.code, 'INVALID_ARGUMENT')
  }
  const text = '---\nname: cli_retry_fixture\ndescription: A retry fixture for local Markdown.\n---\n# Retry fixture\n'
  const temp_file_id = (await json(upload(api, 'retry.md', text, 'application/octet-stream'))).result.temp_file_id
  await json(api('/skills', { body: { temp_file_id, wait: true }, embed: 'offline' }), 503)
  await json(api('/skills/cli_retry_fixture'), 404)
  await json(api('/skills', { body: { temp_file_id, list_only: true }, embed: 'offline' }))
  await json(api('/skills', { body: { temp_file_id, wait: true } }))
  await json(api('/skills', { body: { temp_file_id, wait: true } }), 404)
  await json(api('/skills', { body: { data: '/fictional-client-directory/not-uploaded.md' } }), 400)
})

test('Compile example skills share a read-only catalogue with the filesystem', async () => {
  const api = workspace()
  const target = 'viking://system/compile/example-skills'
  const skills = (await json(api('/skills', { caller: 'member', query: { target_uri: target } }))).result.skills
  const uri = `${target}/example-recipe/SKILL.md`
  assert.deepEqual(skills.map(skill => skill.skill_md_uri), [uri])
  assert.match(await read(api, uri), /Read sample prose\./)
  assert.equal((await json(api('/fs/stat', { query: { uri } }))).result.is_dir, false)
  await json(api('/content/write', { body: { uri, content: 'changed' } }), 403)
  await json(api('/skills', { body: { target_uri: target, data: { name: 'example-recipe', description: 'changed' } } }), 403)
})

for (const [family, name] of [
  ['skills', 'test_skills_api_list_empty_collection'],
  ['skills', 'test_skills_api_list_honors_node_limit'],
  ['skills', 'test_skills_api_validate_inline_skill'],
  ['filter', 'test_find_with_filter_parameter'],
]) {
  test(`upstream ${name}`, async () => {
    const api = workspace()
    await replayOriginal(api, family, name)
  })
}

test('upstream batch-write contracts on the mounted scheduler including the formerly red async case', async t => {
  const principal = testPrincipal('fs-upstream-async', 'fixtureadmin', 'admin')
  const gate = embeddingGate(texts => texts.some(text => text.startsWith('# Batch ')))
  const worker = await gatedWorker([principal], gate.provider)
  const api = mountedEndpoint(worker, principal)
  try {
    for (const name of ['test_batch_write_api_create_overwrites_and_batch_continues',
      'test_batch_write_api_missing_append_creates_file', 'test_batch_write_api_upserts_files']) {
      await t.test(`upstream ${name}`, async () => {
        const root = `viking://resources/${name}`
        await json(api('/fs/mkdir', { body: { uri: root } }))
        await write(api, `${root}/existing.md`, 'Original fixture content.')
        await replayOriginal((path, options) => {
          if (path === '/system/wait') gate.release()
          return api(path, options)
        }, 'batch', name, root)
      })
    }
  } finally { gate.release(); await worker.dispose() }
})

async function waitAtProvider(gate) {
  assert.equal(await Promise.race([gate.entered.then(() => true), delay(5000, false, { ref: false })]), true)
}

test('async batch has real overlap and wait fences and publishes no partial index on provider failure', async () => {
  const actor = testPrincipal('fs-batch-failure', 'editor')
  const gate = embeddingGate(texts => texts.includes('geology queued'))
  const worker = await gatedWorker([actor], async texts => {
    if (texts.includes('provider-failure')) throw new Error('Fictitious availability failure')
    return gate.provider(texts)
  })
  const api = mountedEndpoint(worker, actor)
  const uri = `${own}/queue`, first = `${uri}/a.md`, second = `${uri}/b.md`
  try {
    await json(api('/fs/mkdir', { body: { uri } }))
    await write(api, first, 'sunflower original')
    const batch = { root_uri: uri, wait: false, operations: [{ uri: first, content: 'geology queued' }, { uri: second, content: 'provider-failure' }] }
    const accepted = (await json(api('/content/batch-write', { body: batch }))).result
    assert.equal(accepted.vector_status, 'queued')
    await waitAtProvider(gate)
    assert.equal(await read(api, first), 'geology queued')
    assert.equal((await json(api(`/tasks/${accepted.task_id}`))).result.status, 'running')
    assert.equal((await json(api('/content/batch-write', { body: batch }), 409)).error.code, 'RESOURCE_BUSY')
    await json(api('/system/wait', { body: { timeout: 0 } }), 504)
    await write(api, `${uri}/unrelated.md`, 'sunflower sibling')
    gate.release()
    assert.equal((await json(api('/system/wait', { body: { timeout: 5 } }))).result.durable_object.error_count, 1)
    assert.equal((await json(api(`/tasks/${accepted.task_id}`))).result.status, 'failed')
    for (const target of [first, second]) {
      assert.equal((await json(api('/search/find', { body: { query: 'geology', target_uri: target, score_threshold: -1 } }))).result.total, 0)
    }
    await write(api, first, 'geology recovered')
    assert.equal((await json(api('/search/find', { body: { query: 'geology', target_uri: first } }))).result.total, 1)
  } finally { gate.release(); await worker.dispose() }
})

for (const ending of ['revocation', 'cancellation']) {
  test(`async staged import ${ending} leaves no file or index and releases its unconsumed token`, async () => {
    const owner = testPrincipal(`fs-upload-${ending}`, 'admin', 'admin')
    const actor = testPrincipal(owner.accountId, 'editor')
    const text = 'sunflower protected transfer'
    const gate = embeddingGate(texts => texts.includes(text))
    const worker = await gatedWorker([owner, actor], gate.provider)
    const admin = mountedEndpoint(worker, owner), api = mountedEndpoint(worker, actor)
    const dir = `${shared}/admitted`, parent = `${dir}/new-dir`, uri = `${parent}/note.md`
    try {
      await json(admin('/fs/mkdir', { body: { uri: dir, acl: { acl_mode: 'restricted', entries: [rule('user:editor', 'write')] } } }))
      const { temp_file_id } = (await json(upload(api, 'note.md', text))).result
      const body = { temp_file_id, parent, create_parent: true, wait: false }
      const accepted = (await json(api('/resources', { body }))).result
      assert.equal(accepted.status, 'accepted')
      assert.equal(accepted.root_uri, uri)
      await waitAtProvider(gate)
      await json(admin('/fs/stat', { query: { uri: parent } }), 404)
      await json(admin('/resources', { body }), 404)
      await json(api('/resources', { body: { ...body, parent: own } }), 409)
      await json(admin('/fs/mkdir', { body: { uri: parent } }), 409)
      if (ending === 'revocation') await json(admin('/acl/revoke', { body: { uri: dir, principal: 'user:editor' } }))
      else await json(api(`/tasks/${accepted.task_id}/cancel`, { method: 'POST' }))
      gate.release()
      await json(api('/system/wait', { body: { timeout: 5 } }))
      const task = (await json(api(`/tasks/${accepted.task_id}`))).result
      assert.equal(task.status, ending === 'revocation' ? 'failed' : 'cancelled')
      await json(admin('/fs/stat', { query: { uri: parent } }), 404)
      assert.equal((await json(admin('/search/find', { body: { query: 'botanical', target_uri: dir } }))).result.total, 0)
      const retry = (await json(api('/resources', { body: { temp_file_id, parent: own, wait: true } }))).result
      assert.equal(await read(api, retry.root_uri), text)
      await json(api('/resources', { body: { temp_file_id, parent: own, wait: true } }), 404)
    } finally { gate.release(); await worker.dispose() }
  })
}

test('text writes, line ranges and an inert download round-trip exact UTF-8', async () => {
  const api = workspace()
  const uri = `${shared}/Café.js`
  const text = 'first\r\n☕\n'
  assert.equal((await write(api, uri, text, { mode: 'create', wait: false })).result.uri, uri)
  await write(api, uri, 'last', { mode: 'append' })
  assert.equal(await read(api, uri), text + 'last')
  assert.equal(await read(api, uri, { offset: 1, limit: 1, raw: true }), '☕\n')
  const download = await api('/content/download', { query: { uri } })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Caf%C3%A9\.js$/)
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(await download.text(), text + 'last')
})

test('CLI create parents materializes the file and every authorized parent together', async () => {
  const api = workspace(), base = `${shared}/cli-log-paths`, target = `${base}/target.md`, child = `${base}/docs/guide.md`
  await json(api('/content/write', { body: { uri: target, mode: 'create', content: 'target', wait: false } }))
  await json(api('/content/write', { body: { uri: child, mode: 'create', content: 'sunflower guide', wait: false } }))
  for (const uri of [base, `${base}/docs`]) assert.equal((await json(api('/fs/stat', { query: { uri } }))).result.isDir, true)
  assert.equal(await read(api, target), 'target')
  assert.equal(await read(api, child), 'sunflower guide')
  const indexed = (await json(api('/search/find', { body: { query: 'botanical', target_uri: base } }))).result
  assert.deepEqual(indexed.resources.map(hit => hit.uri), [child])
  const ownDir = `${own}/private-cli/deep`
  await json(api('/content/write', { body: { uri: `${ownDir}/guide.md`, mode: 'create', content: 'Private notes' }, caller: 'member' }))
  await json(api('/fs/stat', { query: { uri: `${root}user/bob/resources/private-cli` } }), 403)
})

test('CLI create parents does not publish on quota, provider or permission failure', async () => {
  const api = workspace(), base = `${shared}/approved`, folder = `${base}/unpublished`
  await json(api('/fs/mkdir', { body: { uri: base, acl: { acl_mode: 'restricted', entries: [rule('user:bob', 'write')] } } }))
  const body = { uri: `${folder}/deep/notes.md`, mode: 'create', content: 'sunflower' }
  await json(api('/content/write', { body, caller: 'reader', embed: 'offline' }), 403)
  await json(api('/content/write', { body, caller: 'member', embed: 'offline' }), 503)
  await json(api('/fs/stat', { query: { uri: folder } }), 404)
  await json(api('/content/write', { body, caller: 'member' }))
  assert.equal(await read(api, body.uri), 'sunflower')
  // Incompatible dimensions fail at storeFile after the parent mutations have
  // been prepared inside transactionSync; none may survive that rollback.
  const rollbackDir = `${base}/rolled-back`
  const invalidIndex = await json(api('/content/write', { body: { ...body, uri: `${rollbackDir}/deep/notes.md` },
    caller: 'member', embed: 'different-shape' }), 503)
  assert.equal(invalidIndex.error.code, 'EMBEDDING_UNAVAILABLE')
  await json(api('/fs/stat', { query: { uri: rollbackDir } }), 404)
  assert.equal(await read(api, body.uri), 'sunflower')
  // One remaining private entry cannot fit two parents and a file.
  assert.equal(await (await api('/fixture/seed-private-capacity', { method: 'POST' })).json(), true)
  const ownDir = `${own}/no-space`
  await json(api('/content/write', { body: { ...body, uri: `${ownDir}/deep/sunflower.md` }, embed: 'offline' }), 413)
  await json(api('/fs/stat', { query: { uri: ownDir } }), 404)
})

test('CLI create parents refuses a concurrently changed tree or ACL and a retry uses the current tree', async () => {
  for (const changed of ['directory', 'acl']) {
    const api = workspace(), base = `${shared}/live-grant`, parent = `${base}/new`, child = `${parent}/leaf`
    await json(api('/fs/mkdir', { body: { uri: base, acl: { acl_mode: 'restricted', entries: [rule('user:bob', 'write')] } } }))
    const body = { uri: `${child}/guided.md`, mode: 'create', content: 'sunflower guide' }
    const pending = api('/content/write', { body, caller: 'member', embed: 'paused' })
    try {
      let waiting = false
      for (let i = 0; i < 50 && !waiting; i++) {
        waiting = await (await api('/fixture/gate')).json()
        if (!waiting) await delay(10)
      }
      assert.equal(waiting, true)
      await json(api('/fs/stat', { query: { uri: parent } }), 404)
      if (changed === 'directory') await json(api('/fs/mkdir', { body: { uri: parent } }))
      else await json(api('/acl/revoke', { body: { uri: base, principal: 'user:bob' } }))
    } finally { await api('/fixture/gate', { method: 'POST' }) }
    await json(pending, changed === 'directory' ? 409 : 403)
    await json(api('/fs/stat', { query: { uri: child } }), 404)
    if (changed === 'acl') {
      await json(api('/fs/stat', { query: { uri: parent } }), 404)
      await json(api('/acl/grant', { body: { uri: base, principal: 'user:bob', level: 'write' } }))
    }
    await json(api('/content/write', { body, caller: 'member' }))
    assert.equal(await read(api, body.uri), 'sunflower guide')
  }
})

test('a failed embedding leaves the prior file and enforces the aggregate append size', async () => {
  const api = workspace()
  const uri = `${own}/draft.md`
  await write(api, uri, 'sunflower', { mode: 'create' })
  await json(api('/content/write', { body: { uri, content: 'volcano' }, embed: 'offline' }), 503)
  await json(api('/content/write', { body: { uri, content: 'volcano' }, embed: 'invalid' }), 503)
  await json(api('/content/write', { body: { uri, content: 'volcano' }, embed: 'limited' }), 429)
  await json(api('/content/write', { body: { uri, content: '😀'.repeat(16_384), mode: 'append' } }), 413)
  assert.equal(await read(api, uri), 'sunflower')
})

test('copy, rename, tags and removal affect the same bounded subtree', async () => {
  const api = workspace()
  const source = `${shared}/map`
  const moved = `${shared}/atlas`
  const copy = `${shared}/backup`
  await json(api('/fs/mkdir', { body: { uri: source } }))
  await write(api, `${source}/readme.md`, 'sunflower')
  await json(api('/content/set_tags', { body: { uri: source, tags: ['topic=garden'], recursive: true } }))
  assert.deepEqual((await json(api('/fs/attrs', { query: { uri: `${source}/readme.md` } }))).result,
    { uri: `${source}/readme.md`, context_type: 'resource', attrs: { tags: ['topic=garden'] } })
  await json(api('/resources/cp', { body: { from_uri: source, to_uri: copy, recursive: true } }))
  await json(api('/resources/mv', { body: { from_uri: source, to_uri: moved } }))
  const page = await json(api('/fs/tree', { query: { uri: shared, tags: ['topic=garden'], include_tags: true } }))
  assert.equal(page.result.length, 4)
  assert.ok(page.result.every(item => item.tags[0] === 'topic=garden'))
  assert.equal(await read(api, `${moved}/readme.md`), 'sunflower')
  await json(api('/resources', { method: 'DELETE', query: { uri: moved } }), 409)
  assert.equal((await json(api('/resources', { method: 'DELETE', query: { uri: moved, recursive: true, wait: true } }))).result.estimated_deleted_count, 2)
  await json(api('/content/read', { query: { uri: `${moved}/readme.md` } }), 404)
  assert.equal(await read(api, `${copy}/readme.md`), 'sunflower')
})

function upload(api, filename, data, type = 'text/plain', options = {}) {
  const form = new FormData()
  form.set('file', new File([data], filename, { type }))
  form.set('telemetry', 'true')
  return api('/resources/temp_upload', { body: form, ...options })
}

const packText = '# Field Automation\n\nThe sunflower trial is tracked by a local script.'
const expectedL0 = 'Sunflower field records support automation.'
const expectedL1 = `# Field notes\n\n${expectedL0}\n\n## Contents\n\nThe fixture contains a field note.`

test('HTTP flat L0/L1 import publishes a document and both levels together without changing its root URI or ACL', async () => {
  const actor = testPrincipal('fs-flat-levels', 'editor', 'admin'), reader = testPrincipal(actor.accountId, 'reader')
  const gate = { started: Promise.withResolvers(), resume: Promise.withResolvers() }
  const model = embeddingGate(() => false)
  const worker = await gatedWorker([actor, reader], model.provider, async args => {
    assert.match(args.messages[0].content, /openviking_edge_directory_summary_v1/)
    assert.deepEqual(JSON.parse(args.messages[1].content).document, { name: 'fixture-flat.md', content: packText, truncated: false })
    gate.started.resolve()
    await gate.resume.promise
    return { response: JSON.stringify({ overview: expectedL1 }) }
  })
  const api = mountedEndpoint(worker, actor), other = mountedEndpoint(worker, reader)
  const uri = `${shared}/fixture-flat.md`
  try {
    const { temp_file_id } = (await json(upload(api, 'fixture-flat.md', packText))).result
    const pending = api('/resources', { body: { temp_file_id, wait: true } }) // stock request has no to/parent
    try {
      await waitAtProvider({ entered: gate.started.promise })
      await json(api('/fs/stat', { query: { uri } }), 404)
      await json(api('/content/overview', { query: { uri } }), 404)
    } finally { gate.resume.resolve() }
    assert.equal((await json(pending)).result.root_uri, uri)
    assert.equal((await json(api('/fs/stat', { query: { uri } }))).result.isDir, false)
    assert.equal(await read(api, uri), packText)
    assert.equal((await json(api('/content/abstract', { query: { uri } }))).result, expectedL0)
    assert.equal((await json(api('/content/overview', { query: { uri } }))).result, expectedL1)
    assert.equal((await json(other('/content/abstract', { query: { uri } }))).result, expectedL0)
    assert.deepEqual((await json(api('/fs/ls', { query: { uri: shared, simple: true, show_all_hidden: true } }))).result, [uri])
    assert.equal((await json(api('/search/find', { body: { query: 'botanical', target_uri: uri } }))).result.total, 1)
    const levels = () => ({ body: { query: 'botanical', target_uri: uri, level: [0, 1], read_content: true } })
    assert.deepEqual((await json(api('/search/find', levels()))).result.resources.map(item => [item.uri, item.level, item.content]),
      [[uri, 0, expectedL0], [uri, 1, expectedL1]])
    await json(api('/acl', { method: 'PUT', body: { uri, acl_mode: 'restricted', entries: [] } }))
    await json(other('/content/overview', { query: { uri } }), 403)
    assert.equal((await json(other('/search/find', levels()))).result.total, 0)
    assert.equal((await json(api('/content/overview', { query: { uri } }))).result, expectedL1)
  } finally { gate.resume.resolve(); await worker.dispose() }
})

test('HTTP flat L0/L1 reindex regenerates a real pair, fails atomically and does not accept the obsolete full mode', async () => {
  const actor = testPrincipal('fs-flat-reindex', 'editor', 'admin')
  const model = embeddingGate(() => false)
  let edition = 1, fail = false, generations = 0
  const worker = await gatedWorker([actor], texts => {
    if (fail && texts.some(text => text.startsWith('# Summary revision'))) throw new Error('Fictional failing embedding')
    return model.provider(texts)
  }, async () => {
    generations++
    return { response: JSON.stringify({ overview: `# Summary revision\n\nFictional document summary edition ${edition}.\n\n## Notes\n\nA synthetic resource.` }) }
  })
  const api = mountedEndpoint(worker, actor), uri = `${shared}/reindex-flat.md`
  const level = async name => (await json(api(`/content/${name}`, { query: { uri } }))).result
  const regenerate = () => api('/content/reindex', { body: { uri, mode: 'semantic_and_vectors', wait: true } })
  try {
    const { temp_file_id } = (await json(upload(api, 'reindex-flat.md', packText))).result
    assert.equal((await json(api('/resources', { body: { temp_file_id, wait: true } }))).result.root_uri, uri)
    assert.match(await level('abstract'), /edition 1/)
    await json(api('/content/reindex', { body: { uri, mode: 'full', wait: true } }), 400)
    assert.equal(generations, 1)
    edition = 2; fail = true
    await json(regenerate(), 503)
    assert.match(await level('abstract'), /edition 1/)
    assert.match(await level('overview'), /edition 1/)
    fail = false
    assert.equal((await json(regenerate())).result.rebuilt_records, 3)
    assert.match(await level('abstract'), /edition 2/)
    assert.match(await level('overview'), /edition 2/)
    assert.equal(await read(api, uri), packText)
    assert.equal(generations, 3)
    await write(api, uri, 'Changed source body.')
    await json(api('/content/abstract', { query: { uri } }), 404)
    assert.equal((await json(api('/search/find', { body: { query: 'botanical', target_uri: uri, level: [0, 1] } }))).result.total, 0)
  } finally { await worker.dispose() }
})

test('HTTP flat L0/L1 never fabricates analysis without a generation capability or in vectors-only mode', async () => {
  const api = workspace()
  for (const [name, mode, embed] of [['no-model.md', undefined, 'fixture'], ['vectors-only.md', 'vectors_only', 'invalid-generation']]) {
    const { temp_file_id } = (await json(upload(api, name, packText))).result
    const body = { temp_file_id, wait: true, ...(mode && { processing_mode: mode }) }
    const uri = (await json(api('/resources', { body, embed }))).result.root_uri
    assert.equal(uri, `${shared}/${name}`)
    assert.equal(await read(api, uri), packText)
    for (const level of ['abstract', 'overview']) await json(api(`/content/${level}`, { query: { uri } }), 404)
  }
  const failed = `${shared}/invalid-analysis.md`
  const { temp_file_id } = (await json(upload(api, 'invalid-analysis.md', packText))).result
  const body = { temp_file_id, wait: true }
  assert.equal((await json(api('/resources', { body, embed: 'invalid-generation' }), 502)).error.code, 'INVALID_MODEL_OUTPUT')
  await json(api('/fs/stat', { query: { uri: failed } }), 404)
  assert.equal((await json(api('/resources', { body, embed: 'generated' }))).result.root_uri, failed)
  assert.equal((await json(api('/content/overview', { query: { uri: failed } }))).result, expectedL1)
})

test('HTTP flat L0/L1 stays private and preserves the historical parent fallback only for GET', async () => {
  const api = workspace(), parent = `${own}/flat-with-parent`, named = 'private-seed.md'
  const caller = 'member'
  await json(api('/fs/mkdir', { caller, body: { uri: parent } }))
  await write(api, `${parent}/.abstract.md`, 'Authored directory abstract.', {}, { caller })
  await write(api, `${parent}/regular.md`, 'A file with no derived levels.', {}, { caller })
  const { temp_file_id } = (await json(upload(api, named, packText, 'text/plain', { caller }))).result
  const uri = (await json(api('/resources', { caller, embed: 'generated', body: { temp_file_id, parent, wait: true } }))).result.root_uri
  assert.equal(uri, `${root}user/bob/resources/flat-with-parent/${named}`)
  assert.equal((await json(api('/content/abstract', { caller, query: { uri } }))).result, expectedL0)
  await json(api('/content/abstract', { query: { uri } }), 403)
  await json(api('/content/abstract', { caller, query: { uri: `${parent}/missing.md` } }), 404)
  const regular = `${parent}/regular.md`
  assert.equal((await json(api('/content/abstract', { caller, query: { uri: regular } }))).result, 'Authored directory abstract.')
  const stat = (await json(api('/fs/stat', { caller, query: { uri: regular } }))).result
  assert.equal(stat.abstract, undefined)
  const listed = (await json(api('/fs/ls', { caller, query: { uri: parent, include_abstract: true } }))).result
  assert.ok(listed.every(row => row.abstract === undefined))
})

async function importPack(api, uri, options = {}) {
  const { caller, embed = 'generated', processing_mode = 'semantic_and_vectors' } = options
  const { temp_file_id } = (await json(upload(api, 'field.txt', packText, 'text/plain', { caller }))).result
  const body = { temp_file_id, to: uri, wait: true, processing_mode }
  return api('/resources', { body, caller, embed })
}

test('CLI pack semantic import materializes L1 and its deterministic L0, independently searchable', async () => {
  const api = workspace()
  const pack = `${shared}/test_pack`
  assert.equal((await json(importPack(api, pack))).result.root_uri, pack)
  const source = `${pack}/field.txt`
  assert.equal(await read(api, source), packText)
  assert.equal((await json(api('/content/abstract', { query: { uri: pack } }))).result, expectedL0)
  assert.equal((await json(api('/content/overview', { query: { uri: pack } }))).result, expectedL1)
  assert.equal((await json(api('/content/abstract', { query: { uri: source } }))).result, expectedL0)
  const hits = (await json(api('/search/find', { body: { query: 'sunflower', target_uri: pack, level: [0, 1], read_content: true } }))).result.resources
  assert.deepEqual(hits.map(hit => [hit.uri, hit.level, hit.content]), [
    [`${pack}/.abstract.md`, 0, expectedL0], [`${pack}/.overview.md`, 1, expectedL1],
  ])
  await json(importPack(api, `${shared}/vectors-only`, { embed: 'invalid-generation', processing_mode: 'vectors_only' }))
  await json(api('/content/overview', { query: { uri: `${shared}/vectors-only` } }), 404)
  const unavailable = (await json(importPack(api, `${shared}/no-generator`, { embed: 'fixture' }))).result
  assert.match(unavailable.warnings.join(' '), /No L0\/L1 generated/)
  await json(api('/content/abstract', { query: { uri: `${shared}/no-generator` } }), 404)
})

test('CLI pack summaries follow live source ACL and source version without rewriting from a poor view', async () => {
  const api = workspace()
  const pack = `${shared}/semantic-acl`, source = `${pack}/field.txt`, sidecar = `${pack}/.abstract.md`
  await json(importPack(api, pack))
  assert.equal((await json(api('/content/abstract', { caller: 'reader', query: { uri: pack } }))).result, expectedL0)
  await json(api('/acl', { method: 'PUT', body: { uri: source, acl_mode: 'restricted', entries: [] } }))
  const before = (await json(api('/fs/tree', { query: { uri: pack, show_all_hidden: true } }))).result
  await json(api('/content/write', { body: { uri: sidecar, content: 'Additional annotation', mode: 'append' } }), 409)
  await json(api('/content/abstract', { caller: 'reader', query: { uri: pack } }), 403)
  await json(api('/content/read', { caller: 'reader', query: { uri: sidecar } }), 403)
  await json(api('/content/download', { caller: 'reader', query: { uri: sidecar } }), 403)
  const stat = (await json(api('/fs/stat', { caller: 'reader', query: { uri: pack } }))).result
  assert.equal(stat.abstract, undefined)
  assert.equal(stat.overview, undefined)
  assert.deepEqual((await json(api('/fs/tree', { caller: 'reader', query: { uri: pack, show_all_hidden: true } }))).result, [])
  const hits = (await json(api('/search/find', { caller: 'reader', body: { query: 'sunflower', target_uri: pack,
    level: [0, 1], include_provenance: true, read_content: true } }))).result
  assert.equal(hits.total, 0)
  assert.equal(hits.provenance[0].matched_contexts.length, 0)
  assert.deepEqual((await json(api('/fs/tree', { query: { uri: pack, show_all_hidden: true } }))).result, before)
  assert.equal((await json(api('/content/abstract', { query: { uri: pack } }))).result, expectedL0)
  await json(api('/acl/grant', { body: { uri: source, principal: 'user:carol', level: 'read' } }))
  assert.equal((await json(api('/content/abstract', { caller: 'reader', query: { uri: pack } }))).result, expectedL0)
  const copied = `${shared}/semantic-copy`
  await json(api('/fs/cp', { body: { from_uri: pack, to_uri: copied, recursive: true } }))
  assert.equal(await read(api, `${copied}/field.txt`), packText)
  await json(api('/content/abstract', { query: { uri: copied } }), 404)
  await write(api, source, 'A new version of the field notes.')
  await json(api('/content/abstract', { query: { uri: pack } }), 404)
  assert.equal((await json(api('/search/find', { body: { query: 'sunflower', target_uri: pack, level: [0, 1] } }))).result.total, 0)
})

test('CLI pack analysis failure does not publish anything or consume its staged document', async () => {
  const api = workspace(), pack = `${shared}/failed-analysis`
  const { temp_file_id } = (await json(upload(api, 'field.txt', packText))).result
  const body = { temp_file_id, to: pack, wait: true }
  assert.equal((await json(api('/resources', { body, embed: 'invalid-generation' }), 502)).error.code, 'INVALID_MODEL_OUTPUT')
  await json(api('/fs/stat', { query: { uri: pack } }), 404)
  await json(api('/resources', { body, embed: 'generated' }))
  assert.equal((await json(api('/content/overview', { query: { uri: pack } }))).result, expectedL1)
})

test('CLI pack generation rechecks its destination ACL before publication', async () => {
  const api = workspace(), parent = `${shared}/acl-parent`, pack = `${parent}/restricted-pack`
  await json(api('/fs/mkdir', { body: { uri: parent, acl: { acl_mode: 'restricted', entries: [rule('user:bob', 'write')] } } }))
  const { temp_file_id } = (await json(upload(api, 'field.txt', packText, 'text/plain', { caller: 'member' }))).result
  const request = api('/resources', { caller: 'member', embed: 'paused-generation', body: { to: pack, temp_file_id } })
  try {
    let waiting = false
    for (let i = 0; i < 60 && !waiting; i++) {
      waiting = await (await api('/fixture/gate')).json()
      if (!waiting) await delay(10)
    }
    assert.equal(waiting, true)
    await json(api('/fs/stat', { query: { uri: pack } }), 404)
    await json(api('/acl/revoke', { body: { uri: parent, principal: 'user:bob' } }))
  } finally { await api('/fixture/gate', { method: 'POST' }) }
  await json(request, 403)
  await json(api('/fs/stat', { query: { uri: pack } }), 404)
  await json(api('/resources', { caller: 'member', body: { to: `${own}/retry`, temp_file_id, processing_mode: 'vectors_only' } }))
})

test('CLI pack analysis provider is mounted on the real Worker and async import publishes both levels together', async () => {
  const actor = testPrincipal('fs-pack-generating', 'fixtureadmin', 'admin')
  const gate = { entered: Promise.withResolvers(), unblock: Promise.withResolvers() }
  const l2 = '# CLI Test\n\nThis is a test file for CLI automation.'
  const l0 = 'This import contains a test file for CLI automation.'
  const l1 = `# CLI Test\n\n${l0}\n\n## Contents\n\nThe document is a text fixture.`
  const embeddings = embeddingGate(() => false)
  let calls = 0
  const worker = await gatedWorker([actor], embeddings.provider, async args => {
    assert.match(args.messages[0].content, /openviking_edge_directory_summary_v1/)
    assert.deepEqual(JSON.parse(args.messages[1].content), { document: { name: 'fixture.txt', content: l2, truncated: false } })
    calls++
    gate.entered.resolve()
    await gate.unblock.promise
    return { response: JSON.stringify({ overview: l1 }), usage: { prompt_tokens: 7, completion_tokens: 5 } }
  })
  const api = mountedEndpoint(worker, actor), pack = `${shared}/test_pack`
  try {
    const { temp_file_id } = (await json(upload(api, 'fixture.txt', l2))).result
    const { task_id } = (await json(api('/resources', { body: { temp_file_id, to: pack, wait: false } }))).result
    await waitAtProvider({ entered: gate.entered.promise })
    await json(api('/content/read', { query: { uri: `${pack}/fixture.txt` } }), 404)
    await json(api('/content/abstract', { query: { uri: pack } }), 404)
    await json(api('/content/overview', { query: { uri: pack } }), 404)
    gate.unblock.resolve()
    await json(api('/system/wait', { body: { timeout: 5 } }))
    assert.equal((await json(api(`/tasks/${task_id}`))).result.status, 'completed')
    assert.equal(await read(api, `${pack}/fixture.txt`), l2)
    assert.equal((await json(api('/content/abstract', { query: { uri: pack } }))).result, l0)
    assert.equal((await json(api('/content/overview', { query: { uri: pack } }))).result, l1)
    assert.equal(calls, 1, 'reads must not call the model')
  } finally { gate.unblock.resolve(); await worker.dispose() }
})

test('opt-in conversion stages only Markdown and accepts the original picker name on import', async () => {
  const api = workspace()
  const file = 'garden.pdf', input = 'x'.repeat(80_000)
  await json(upload(api, file, input, 'application/pdf'), 413)
  const staged = (await json(upload(api, file, input, 'application/pdf', { embed: 'convert' }))).result
  assert.equal(staged.filename, 'garden.md')
  assert.equal(staged.size, 16)
  const body = { temp_file_id: staged.temp_file_id, parent: own, source_name: file }
  const resource = (await json(api('/resources', { body }))).result
  assert.equal(await read(api, resource.root_uri), 'sunflower field\n')
  await json(api('/content/read', { query: { uri: `${own}/${file}` } }), 404)
  await json(api('/resources', { body }), 404)
})

test('native Studio multipart import is actor-bound, retryable, and single use', async () => {
  const api = workspace()
  const uploaded = (await json(upload(api, 'note.md', 'sunflower \n'))).result
  assert.equal(uploaded.filename, 'note.md')
  assert.equal(uploaded.size, 11)
  const body = {
    temp_file_id: uploaded.temp_file_id, source_name: 'note.md', parent: `${own}/New/Notes`,
    create_parent: true, tags: ['use=demo'], wait: true, telemetry: true, processing_mode: 'semantic_and_vectors',
  }
  for (const caller of ['member', 'secondAgent', 'otherAccount']) {
    await json(api('/resources', { body, caller }), 404)
  }
  await json(api('/resources', { body, embed: 'offline' }), 503)
  await json(api('/fs/stat', { query: { uri: `${own}/New` } }), 404)
  const imported = (await json(api('/resources', { body }))).result
  assert.equal(imported.status, 'success')
  assert.equal(imported.root_uri, `${root}user/alice/resources/New/Notes/note.md`)
  assert.equal(imported.task_id, undefined)
  assert.equal(await read(api, imported.root_uri), 'sunflower \n')
  await json(api('/resources', { body }), 404)
  await json(upload(api, 'image.svg', '<svg/>', 'image/svg+xml'), 415)
  await json(upload(api, 'note.txt', Uint8Array.of(0xff)), 415)
  await json(api('/resources', { body: { path: 'https://fictional.example.invalid/example.md' } }), 501)
})

test('find/search rank indexed content by cosine and respect all requested scopes', async () => {
  const api = workspace()
  await write(api, `${shared}/bed.md`, 'sunflower', { tags: ['kind=garden'] })
  await write(api, `${shared}/hill.md`, 'volcano', { tags: ['kind=hike'] })
  await write(api, `${root}~/memories/note.md`, 'sunflower', {}, { caller: 'member' })
  const body = { query: 'botanical', target_uri: `${shared}/`, score_threshold: 0.8,
    read_content: true, level: [2], context_type: ['resource'], tags: ['kind=garden'], telemetry: true }
  for (const route of ['/search/find', '/search/search']) {
    const { result } = await json(api(route, { body, caller: 'member' }))
    assert.deepEqual([result.total, result.memories.length, result.skills.length], [1, 0, 0])
    assert.equal(result.resources[0].uri, `${shared}/bed.md`)
    assert.equal(result.resources[0].score, 1)
    assert.equal(result.resources[0].content, 'sunflower')
    await json(api(route, { body, embed: 'offline' }), 503)
    await json(api(route, { body, embed: 'different-shape' }), 503)
  }
  const global = (await json(api('/search/find', { body: { query: 'botanical' } }))).result
  assert.deepEqual(global.resources.map(item => item.uri), [`${shared}/bed.md`])
  assert.equal(global.memories.length, 0)
  const privateHits = (await json(api('/search/find', { caller: 'member', body: { query: 'botanical', context_type: 'memory' } }))).result
  assert.equal(privateHits.memories[0].uri, `${root}user/bob/memories/note.md`)
})

test('grep returns matching lines and glob returns Viking URIs without using embeddings', async () => {
  const api = workspace()
  const dir = `${shared}/plants`
  await json(api('/fs/mkdir', { body: { uri: dir } }))
  const leaf = `${dir}/field.md`
  await write(api, leaf, 'ridge\r\nSUNFLOWER\nvalley', { tags: ['type=field'] })
  const { result } = await json(api('/search/grep', { body: { uri: shared, pattern: '^sunflower$',
    case_insensitive: true, node_limit: 3, before_context: 1, tags: ['type=field'] }, embed: 'offline' }))
  assert.deepEqual(result.matches.map(hit => [hit.uri, hit.line, hit.content]), [[leaf, 2, 'SUNFLOWER']])
  assert.deepEqual(result.matches[0].before_context, [{ line: 1, content: 'ridge' }])
  const glob = await json(api('/search/glob', { body: { uri: shared, pattern: '**/*.md', node_limit: 5 }, embed: 'offline' }))
  assert.deepEqual(glob.result.matches, [leaf])
})

test('other identities cannot enumerate, change, or copy out of private mounts', async () => {
  const api = workspace()
  const sharedNote = `${shared}/public.md`
  const ownerNote = `${root}user/alice/resources/private.md`
  const agentNote = `${root}agent/agent-only.md`
  await write(api, sharedNote, 'sunflower')
  await write(api, ownerNote, 'volcano')
  await write(api, agentNote, 'sunflower')
  assert.equal((await json(api('/content/read', { query: { uri: sharedNote }, caller: 'member' }))).result, 'sunflower')
  await json(api('/content/write', { body: { uri: sharedNote, content: 'try edit' }, caller: 'member' }), 403)
  await json(api('/content/read', { query: { uri: ownerNote }, caller: 'member' }), 403)
  await json(api('/content/read', { query: { uri: sharedNote }, caller: 'otherAccount' }), 404)
  await json(api('/content/read', { query: { uri: ownerNote }, caller: 'otherAccount' }), 404)
  await json(api('/content/read', { query: { uri: agentNote }, caller: 'secondAgent' }), 404)
  assert.equal((await json(api('/content/read', { query: { uri: ownerNote }, caller: 'secondAgent' }))).result, 'volcano')
  const tree = await json(api('/fs/tree', { query: { uri: root, level_limit: 6 }, caller: 'member' }))
  assert.ok(tree.result.some(row => row.uri === `${root}user/bob`))
  assert.ok(!tree.result.some(row => row.uri.includes('alice') || row.uri === agentNote))
  await json(api('/fs/cp', { body: { from_uri: ownerNote, to_uri: `${shared}/private.md` } }), 409)
  await json(api('/content/write', { body: { uri: `${root}~/skills/Example/SKILL.md`, content: 'note' } }), 403)
})

test('an index computed before a newer append is not committed over it', async () => {
  const api = workspace()
  const uri = `${own}/race.md`
  await write(api, uri, 'original')
  const slow = api('/content/write', { body: { uri, content: ' sunflower', mode: 'append' }, embed: 'paused' })
  try {
    let waiting = false
    for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
      waiting = await (await api('/fixture/gate')).json()
      if (!waiting) await delay(10)
    }
    assert.equal(waiting, true, 'the older request reached its embedding await')
    await write(api, uri, ' volcano', { mode: 'append' })
  } finally {
    await api('/fixture/gate', { method: 'POST' })
  }
  await json(slow, 409)
  assert.equal(await read(api, uri), 'original volcano')
  const stale = await json(api('/search/find', { body: { query: 'botanical', target_uri: uri } }))
  assert.equal(stale.result.total, 0)
})

test('URI grammar, current text sidecars and unported routes are explicit', async () => {
  const api = workspace()
  for (const uri of [`${own}//docs`, `${own}/%2e%2e`, `${own}/note%2fleaf`, `${own}/note%25.md`, `${own}/what?`, 'file:///fixture']) {
    const reply = await json(api('/fs/stat', { query: { uri } }), 400)
    assert.equal(reply.error.code, 'INVALID_URI')
  }
  const folder = `${own}/directory`
  await json(api('/fs/mkdir', { body: { uri: folder } }))
  await json(api('/content/abstract', { query: { uri: folder } }), 404)
  await write(api, `${folder}/.abstract.md`, 'Authored summary.', { processing_mode: 'vectors_only' })
  assert.equal((await json(api('/content/abstract', { query: { uri: folder } }))).result, 'Authored summary.')
  assert.deepEqual((await json(api('/fs/ls', { query: { uri: folder } }))).result, [])
  assert.equal((await json(api('/fs/ls', { query: { uri: folder, show_all_hidden: true } }))).result.length, 1)
  assert.equal((await json(api('/content/reindex', { body: { uri: folder } }))).result.status, 'completed')
})

test('the mounted Worker handles the actual onboarding probe and semantic Studio shapes', async () => {
  const admin = testPrincipal('fixture-home', 'alex', 'admin')
  const member = testPrincipal('fixture-home', 'sam')
  const worker = await localWorker({ principals: [admin, member], embeddings: 'fixture' })
  try {
    const send = mountedApi(worker, member)
    const probe = '/api/v1/fs/ls?uri=viking%3A%2F%2F&node_limit=1&output=agent'
    const listing = await json(send(probe))
    assert.equal(listing.result.length, 1)
    assert.equal(listing.has_more, true)
    await json(mountedApi(worker)(probe), 401)
    const forms = new FormData()
    forms.set('file', new File(['boat'], 'notes.md', { type: 'text/markdown' }))
    forms.set('telemetry', 'true')
    const lead = await json(worker.dispatchFetch('http://localhost/api/v1/resources/temp_upload', {
      method: 'POST', headers: { 'x-api-key': member.key }, body: forms,
    }))
    const body = { temp_file_id: lead.result.temp_file_id, parent: own, source_name: 'notes.md',
      strict: false, telemetry: true, wait: false, directly_upload_media: true }
    const accepted = (await json(send('/api/v1/resources', { method: 'POST', body }))).result
    assert.equal(accepted.status, 'accepted')
    assert.ok(accepted.task_id)
    await json(send('/api/v1/system/wait', { method: 'POST', body: { timeout: 5 } }))
    const task = (await json(send(`/api/v1/tasks/${accepted.task_id}`))).result
    assert.equal(task.status, 'completed')
    const uri = task.result.root_uri
    assert.equal(uri, accepted.root_uri)
    const { result } = await json(send('/api/v1/search/find', {
      method: 'POST', body: { query: 'sailing', read_content: true, telemetry: true, score_threshold: 0.8 },
    }))
    assert.equal(result.resources.length, 1)
    assert.equal(result.resources[0].uri, uri)
    assert.equal(result.resources[0].content, 'boat')
    assert.equal((await send(`/api/v1/content/download?uri=${encodeURIComponent(uri)}`)).headers.get('x-content-type-options'), 'nosniff')
    await json(mountedApi(worker, admin)(`/api/v1/content/read?uri=${encodeURIComponent(uri)}`), 403)
  } finally { await worker.dispose() }
})

test('missing real binding is a 503 from the mounted Worker, not an empty result', async () => {
  const owner = testPrincipal('fixture-home', 'alex', 'admin')
  const worker = await localWorker({ principals: [owner], embeddings: 'missing' })
  try {
    const send = mountedApi(worker, owner)
    const reply = await json(send('/api/v1/search/search', { method: 'POST', body: { query: 'sailing' } }), 503)
    assert.equal(reply.error.code, 'EMBEDDING_UNAVAILABLE')
    await json(send('/api/v1/content/write', { method: 'POST', body: { uri: `${shared}/note.md`, content: 'boat' } }), 503)
    const listing = await json(send(`/api/v1/fs/ls?uri=${encodeURIComponent(shared)}`))
    assert.deepEqual(listing.result, [])
  } finally { await worker.dispose() }
})

test('account entry quota rejects the whole import without consuming the upload', async () => {
  const api = workspace()
  assert.equal(await (await api('/fixture/seed-capacity', { method: 'POST' })).json(), true)
  const staged = (await json(upload(api, 'quota.md', 'sunflower'))).result.temp_file_id
  const parent = `${shared}/new-folder`
  const body = { temp_file_id: staged, parent, create_parent: true }
  await json(api('/resources', { body }), 413)
  await json(api('/fs/stat', { query: { uri: parent } }), 404)
  await json(api('/fs', { method: 'DELETE', query: { uri: `${shared}/fixture-1` } }))
  assert.equal((await json(api('/resources', { body }))).result.root_uri, `${parent}/quota.md`)
  assert.equal(await read(api, `${parent}/quota.md`), 'sunflower')
  await json(api('/fs/mkdir', { body: { uri: `${shared}/over-cap` } }), 413)
})

test('private quota is shared by the same user’s agents, not by other users', async () => {
  const api = workspace()
  assert.equal(await (await api('/fixture/seed-private-capacity', { method: 'POST' })).json(), true)
  await json(api('/fs/mkdir', { body: { uri: `${own}/last` } }))
  const limited = await json(api('/fs/mkdir', { body: { uri: `${root}agent/extra` }, caller: 'secondAgent' }), 413)
  assert.equal(limited.error.code, 'RESOURCE_EXHAUSTED')
  await json(api('/fs/mkdir', { body: { uri: `${own}/independent` }, caller: 'member' }))
  await json(api('/fs/mkdir', { body: { uri: `${shared}/independent` } }))
})
