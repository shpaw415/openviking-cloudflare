// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const origin = 'https://manuals.fixture.test', feedOrigin = 'https://archive.fixture.test'
const reader = testPrincipal('web-test', 'reader')
const admin = testPrincipal('web-test', 'owner', 'admin')
const peer = testPrincipal('web-test', 'peer')
const other = testPrincipal('other-web-test', 'reader')
const root = testPrincipal('control', 'operator', 'root')
const revision = 'a'.repeat(40)
const gitUrl = `https://api.github.com/repos/example/field-guide/contents/docs/Compass.md?ref=${revision}`
const sha = (body, algorithm = 'sha256') => createHash(algorithm).update(body).digest('hex')
const pin = (id, body) => ({ id, sha256: sha(body) })
const page = (id, body) => ({ id, url: `${origin}/docs/${id}.html`, name: `${id}.txt`, body })
const guide = page('guide', `<!doctype html><html><head><title>Head noise</title><base href="${feedOrigin}/">
  <style>Style noise</style></head><body><main><h1>Coastal compass &amp; navigation</h1>
  <script>Script noise</script><template>Template noise <a href="template.html">hidden link</a></template>
  <p hidden>Hidden noise</p><p>Contour bearings &#233; &lt;example&gt;.</p>
  <a href="signals.html">Signals</a> <a href="charts.html">Charts</a> <a href="restricted.html">Closed document</a>
  <a href="unlisted.html">Unlisted document</a> <a href="${feedOrigin}/external.html">External document</a>
  <a href="unused.html" download>Download only</a></main></body></html>`)
const signals = page('signals', '<h1>Tern harbor signals</h1><p>Horizon flags.</p><a href="guide.html">Back</a><a href="detail.html">Details</a>')
const charts = page('charts', '<h1>Cobalt harbor charts</h1>')
const detail = page('detail', '<h1>Sandpiper landmarks</h1><a href="beyond.html">Other landmarks</a>')
const notRead = ['template', 'restricted', 'unused', 'beyond'].map(id => page(id, '<h1>Never selected</h1>'))
const robots = 'User-agent: *\nDisallow: /docs/restricted.html$\nSitemap: https://archive.fixture.test/map.xml\n'
const notes = '# Starboard orientation\n\nThe albatross notebook is a synthetic Git document.\n'
const gitFixture = JSON.stringify({ type: 'file', name: 'Compass.md', path: 'docs/Compass.md', size: Buffer.byteLength(notes),
  sha: sha(Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(notes)}\0`), Buffer.from(notes)]), 'sha1'), encoding: 'base64',
  content: Buffer.from(notes).toString('base64').replace(/.{1,60}/g, '$&\n'), download_url: 'https://archive.fixture.test/unused' })
const row = (pages = [guide, signals, charts, detail, ...notRead], { policy = robots, account = 'web-test', explore = true } = {}) =>
  ({ account, entry: pages[0].url, name: 'field-manual', explore, robots: pin('policy', policy),
    pages: pages.map(({ id, url, name, body }) => ({ ...pin(id, body), url, name })) })
const repo = { account: 'web-test', alias: 'seabird-docs', collection: 'sealed-compass', sha256: sha(gitFixture),
  repository: 'example/field-guide', revision, file: 'docs/Compass.md', name: 'compass.txt' }
const catalog = { version: 1, sites: [row()], git: [repo] }
const media = { html: 'text/html', robots: 'text/plain', git: 'application/json' }
const sourceResponse = (ref, kind, body, headers = {}) => new Response(body, { headers: { 'x-ov-web-source-url': ref,
  'x-ov-web-source-type': media[kind], 'content-type': 'application/octet-stream', ...headers } })
const snapshot = new Map([['/v1/robots/policy', [origin + '/robots.txt', 'robots', robots]],
  ...[guide, signals, charts, detail, ...notRead].map(p => ['/v1/html/' + p.id, [p.url, 'html', p.body]]),
  ['/v1/git/sealed-compass', [gitUrl, 'git', gitFixture]]])
const pathOf = (endpoint, uri) => `${endpoint}?uri=${encodeURIComponent(uri)}`
const caps = '/system/edge-capabilities'
const html = (path = guide.url, body = {}) => ({ path, args: { web_mode: 'html' }, ...body })
const site = (body = {}) => ({ path: guide.url, args: { site: true }, ...body })
const git = (body = {}) => ({ path: 'seabird-docs', add_type: 'git', ...body })
const scope = { htmlImport: true, siteImport: true, gitDocsImport: true, urlImport: false }
const featureKeys = Object.keys(scope)
const falseScope = Object.fromEntries(featureKeys.map(name => [name, false]))
let worker, serviceScript, outside = 0
const refuseOutbound = async () => { outside++; return new Response(null, { status: 503 }) }
const send = (w, endpoint, options, as = reader) => api(w, as)('/api/v1' + endpoint, options)
const post = (w, endpoint, body, as) => send(w, endpoint, { method: 'POST', body }, as)
const add = (w, body, as) => post(w, '/resources', body, as)
async function result(response, status = 200, error) {
  const json = await response.json()
  assert.equal(response.status, status, JSON.stringify(json.error ?? {}))
  assert.equal(json.status, status < 300 ? 'ok' : 'error')
  if (error) assert.equal(json.error?.code, error)
  return json.result
}
async function flags(w, actor) {
  const { features } = await result(await send(w, caps, undefined, actor))
  return Object.fromEntries(featureKeys.map(name => [name, features[name]]))
}

async function start(config = catalog, { binding = 'snapshot-reader', embeddings = 'fixture', persist } = {}) {
  const runtime = await localWorker({ principals: [reader, peer, admin, other, root], embeddings, persist,
    vars: { OPENVIKING_EDGE_WEB_CATALOG: JSON.stringify(config) },
    ...(binding && { serviceBindings: { WEB_SOURCE: binding } }),
    privateWorkers: binding === 'snapshot-reader' ? [{ name: 'snapshot-reader', modules: true,
      script: serviceScript, compatibilityDate: '2026-11-19', r2Buckets: ['WEB_SNAPSHOTS'], outboundService: refuseOutbound }] : [],
    outboundService: refuseOutbound })
  assert.equal((await runtime.ready).hostname, '127.0.0.1')
  return runtime
}
async function seed(runtime) {
  const bucket = await runtime.getR2Bucket('WEB_SNAPSHOTS', 'snapshot-reader')
  for (const [path, [sourceUrl, , body]] of snapshot) {
    await bucket.put(path.slice('/v1/'.length), body, { customMetadata: { sourceUrl } })
  }
}
before(async () => {
  const compiled = await build({ entryPoints: ['src/web/snapshot-service.ts'], bundle: true, write: false, format: 'esm' })
  serviceScript = compiled.outputFiles[0].text
  worker = await start()
  await seed(worker)
})
after(async () => { try { assert.equal(outside, 0, 'Only private bindings may be used') } finally { await worker?.dispose() } })

async function found(w, parent, needle, uri, actor) {
  const hits = await result(await post(w, '/search/find', { query: needle, target_uri: parent, limit: 10 }, actor))
  assert.ok(hits.resources.some(hit => hit.uri === uri))
}
async function completed(w, request, as = reader) {
  const admitted = await result(await add(w, { ...request, wait: false }, as))
  assert.equal(admitted.status, 'accepted')
  await result(await post(w, '/system/wait', { timeout: 12 }, as))
  const task = await result(await send(w, '/tasks/' + admitted.task_id, undefined, as))
  assert.equal(task.status, 'completed', task.error ?? '')
  assert.equal(task.resource_id, admitted.root_uri)
  assert.equal(task.result.root_uri, admitted.root_uri)
  return { uri: admitted.root_uri, task }
}

test('per-mode booleans are tied to the real key, catalogue and embedding mount', async () => {
  for (const actor of [reader, admin]) assert.deepEqual(await flags(worker, actor), scope)
  for (const actor of [root, other]) assert.deepEqual(await flags(worker, actor), falseScope)
  await result(await send(worker, caps, undefined, null), 401, 'UNAUTHENTICATED')
  await result(await add(worker, html(), root), 403)
  for (const [config, options, expected] of [
    [{ ...catalog, sites: [row(undefined, { explore: false })], git: [] }, {}, { ...falseScope, htmlImport: true }],
    [catalog, { binding: null }, falseScope], [catalog, { embeddings: 'missing' }, falseScope],
    [{ ...catalog, sites: [row([guide, { ...signals, url: feedOrigin + '/external.html' }])] }, {}, falseScope],
  ]) {
    const runtime = await start(config, options)
    try { assert.deepEqual(await flags(runtime, reader), expected) } finally { await runtime.dispose() }
  }
})

test('HTML: real Workerd binding, R2 snapshots, inert extraction, private file and index', async t => {
  const { uri, task } = await completed(worker, html())
  assert.equal(uri, 'viking://user/reader/resources/guide.txt')
  const reply = await send(worker, pathOf('/content/read', uri))
  assert.match(reply.headers.get('content-type'), /^application\/json/)
  assert.equal(reply.headers.get('x-content-type-options'), 'nosniff')
  const text = await result(reply)
  assert.match(text, /Coastal compass & navigation\nContour bearings é ‹example›\./)
  assert.doesNotMatch(text, /(?:Script|Style|Template|Head|Hidden) noise|<[^>]+>/)
  await found(worker, 'viking://~/resources', 'coastal compass navigation', uri)
  await result(await send(worker, pathOf('/content/read', uri), undefined, peer), 403)
  t.diagnostic(JSON.stringify({ mode: 'html', worker_sha256: worker.localBuildSha256, source_sha256: sha(serviceScript),
    post: 200, terminal: task.status, uri, read: 200, sha256: sha(text), find: 200 }))
})

test('site: only approved reachable same-origin pages, robots and depth, one committed directory', async t => {
  const { uri, task } = await completed(worker, site({ to: 'viking://~/resources/harbor' }))
  assert.equal(uri, 'viking://user/reader/resources/harbor')
  assert.deepEqual(task.result.documents, ['guide', 'signals', 'charts', 'detail'].map(name => `${uri}/${name}.txt`))
  assert.match(task.result.warnings.join(' '), /bounded/)
  const entries = await result(await send(worker, pathOf('/fs/ls', uri)))
  assert.equal(entries.length, 4)
  await found(worker, uri, 'sandpiper landmarks', `${uri}/detail.txt`)
  await result(await add(worker, site({ to: uri })), 409, 'ALREADY_EXISTS')
  await result(await add(worker, html(notRead[1].url)), 403, 'ROBOTS_DENIED')
  t.diagnostic(JSON.stringify({ mode: 'site', post: 200, terminal: task.status, uri, documents: task.result.documents,
    find: 200, blocked_by_robots: 403, conflict: 409 }))
})

test('git: sealed alias reads the exact GitHub Contents record, normalizes and indexes the document', async t => {
  const { uri, task } = await completed(worker, git())
  assert.equal(uri, 'viking://user/reader/resources/compass.txt')
  assert.equal(await result(await send(worker, pathOf('/content/read', uri))), notes)
  await found(worker, 'viking://~/resources', 'albatross notebook', uri)
  await result(await add(worker, git({ path: repo.collection })), 503, 'SOURCE_UNAVAILABLE')
  t.diagnostic(JSON.stringify({ mode: 'git', post: 200, terminal: task.status, uri, read: 200, sha256: sha(notes), find: 200 }))
})

test('an exact document replacement keeps its ACL; a write to the restricted file is refused', async () => {
  const to = 'viking://resources/shared-compass.txt'
  await completed(worker, html(guide.url, { to }), admin)
  await result(await send(worker, '/acl', { method: 'PUT', body: { uri: to, acl_mode: 'restricted',
    entries: [{ principal: 'user:reader', level: 'read' }] } }, admin))
  await result(await add(worker, git({ to })), 403, 'PERMISSION_DENIED')
  await completed(worker, git({ to }), admin)
  const acl = await result(await send(worker, pathOf('/acl', to), undefined, admin))
  assert.equal(acl.acl_mode, 'restricted')
  assert.equal(await result(await send(worker, pathOf('/content/read', to))), notes)
  await result(await send(worker, pathOf('/content/read', to), undefined, peer), 403)
})

test('site reserves its subtree and an authorized cancellation during a later read publishes nothing', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const observed = []
  const w = await start(catalog, { binding: async request => {
    const target = new URL(request.url)
    observed.push(target.pathname)
    assert.equal(target.origin, 'https://web-source.invalid')
    assert.equal(request.method, 'GET')
    for (const name of ['cookie', 'authorization', 'x-api-key', 'x-fixture-owner']) assert.equal(request.headers.get(name), null)
    if (target.pathname === '/v1/html/signals') { entered.resolve(); await release.promise }
    return sourceResponse(...snapshot.get(target.pathname))
  } })
  try {
    const parent = 'viking://~/resources/new-site', to = `${parent}/manual`
    const first = await result(await send(w, '/resources', { method: 'POST', body: site({ to, create_parent: true, wait: false }),
      headers: { 'x-fixture-owner': 'not forwarded' } }))
    try {
      await Promise.race([entered.promise, delay(4_000).then(() => assert.fail('Second document was not requested'))])
      await result(await send(w, '/tasks/' + first.task_id, undefined, peer), 404)
      await result(await send(w, pathOf('/fs/stat', parent)), 404)
      await result(await post(w, '/fs/mkdir', { uri: parent }), 409, 'RESOURCE_BUSY')
      await result(await post(w, `/tasks/${first.task_id}/cancel`, {}))
    } finally { release.resolve() }
    await result(await post(w, '/system/wait', { timeout: 10 }))
    assert.equal((await result(await send(w, '/tasks/' + first.task_id))).status, 'cancelled')
    assert.deepEqual(observed, ['/v1/robots/policy', '/v1/html/guide', '/v1/html/signals'])
    await result(await send(w, pathOf('/fs/stat', parent)), 404)
    await result(await post(w, '/fs/mkdir', { uri: parent }))
  } finally { release.resolve(); await w.dispose() }
})

test('source shape, mounts, exact approval and ACL refusals have no binding calls', async () => {
  let calls = 0
  const w = await start(catalog, { binding: () => { calls++; return new Response(null, { status: 503 }) } })
  try {
    const closed = 'viking://resources/closed'
    await result(await post(w, '/fs/mkdir', { uri: closed }, admin))
    await result(await send(w, '/acl', { method: 'PUT', body: { uri: closed, acl_mode: 'restricted', entries: [] } }, admin))
    for (const [request, status, error] of [
      [{ path: guide.url }, 400, 'INVALID_ARGUMENT'],
      [html(origin + '/docs/absent.html'), 503, 'SOURCE_UNAVAILABLE'], [html(guide.url + '?preview'), 400, 'INVALID_ARGUMENT'],
      [site({ path: signals.url }), 503, 'SOURCE_UNAVAILABLE'], [site({ watch_interval: 60 }), 501, 'NOT_IMPLEMENTED'],
      [site({ args: { site: true, depth: 1 } }), 400, 'INVALID_ARGUMENT'], [git({ args: { branch: 'other' } }), 400, 'INVALID_ARGUMENT'],
      [html(guide.url, { parent: closed }), 403, 'PERMISSION_DENIED'], [git({ parent: 'viking://user/peer/resources' }), 403, 'PERMISSION_DENIED'],
      [git({ parent: 'viking://resources', to: 'viking://resources/wrong.txt' }), 400, 'INVALID_ARGUMENT'],
    ]) await result(await add(w, request), status, error)
    await result(await add(w, html(), other), 501, 'NOT_IMPLEMENTED')
    assert.equal(calls, 0)
  } finally { await w.dispose() }
})

test('invalid private responses roll back and never cause a redirect or fallback', async () => {
  let response, calls = []
  const w = await start(catalog, { binding: request => {
    const path = new URL(request.url).pathname
    calls.push(path)
    return path === '/v1/html/guide' ? response() : sourceResponse(...snapshot.get(path))
  } })
  const to = 'viking://~/resources/rolled-back/page.txt'
  try {
    for (const [reply, status, code] of [
      [() => Response.redirect('https://web-source.invalid/v1/html/charts'), 503, 'SOURCE_UNAVAILABLE'],
      [() => sourceResponse(charts.url, 'html', guide.body), 503, 'SOURCE_UNAVAILABLE'],
      [() => sourceResponse(guide.url, 'html', '<p>Different fixture bytes</p>'), 503, 'SOURCE_UNAVAILABLE'],
      [() => sourceResponse(guide.url, 'html', guide.body, { 'x-ov-web-source-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
      [() => sourceResponse(guide.url, 'html', 'a'.repeat(65537)), 413, 'RESOURCE_EXHAUSTED'],
    ]) {
      calls = []; response = reply
      await result(await add(w, html(guide.url, { to, create_parent: true })), status, code)
      assert.deepEqual(calls, ['/v1/robots/policy', '/v1/html/guide'])
      await result(await send(w, pathOf('/fs/stat', 'viking://~/resources/rolled-back')), 404)
    }
  } finally { await w.dispose() }
})

test('the member floor retires a site job even when the same ACL grant has already been restored', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const observed = []
  const w = await start(catalog, { binding: async request => {
    const path = new URL(request.url).pathname
    observed.push(path)
    if (path === '/v1/html/guide') { entered.resolve(); await release.promise }
    return sourceResponse(...snapshot.get(path))
  } })
  try {
    const groups = '/admin/accounts/web-test/groups'
    const members = groups + '/editors/members'
    const parent = 'viking://resources/editor-guides'
    await result(await post(w, groups, { group_id: 'editors' }, admin))
    const membership = method => send(w, members, { method, body: { user_ids: ['reader'] } }, admin)
    await result(await membership('PUT'))
    await result(await post(w, '/fs/mkdir', { uri: parent,
      acl: { acl_mode: 'restricted', entries: [{ principal: 'group:editors', level: 'write' }] } }, admin))
    const accepted = await result(await add(w, site({ parent, wait: false })))
    assert.equal(accepted.status, 'accepted')
    try {
      await Promise.race([entered.promise, delay(4_000).then(() => assert.fail('Source read was not reached'))])
      await result(await membership('DELETE'))
      await result(await membership('PUT'))
    } finally { release.resolve() }
    await result(await post(w, '/system/wait', { timeout: 10 }))
    assert.equal((await result(await send(w, '/tasks/' + accepted.task_id))).status, 'failed')
    assert.deepEqual(observed, ['/v1/robots/policy', '/v1/html/guide'])
    await result(await send(w, pathOf('/fs/stat', accepted.root_uri), undefined, admin), 404)
    const fresh = await completed(w, site({ parent }))
    assert.equal(fresh.uri, accepted.root_uri)
  } finally { release.resolve(); await w.dispose() }
})

test('page count clamps actual reads, aggregate wire bytes fail the whole directory', async () => {
  const fanout = Array.from({ length: 7 }, (_, i) => page(`fixture-${i}`, `<h1>Field entry ${i}</h1>`))
  const first = { ...guide, body: `<h1>Page limits</h1>${fanout.map(p => `<a href="${p.id}.html">${p.id}</a>`).join('')}` }
  const big = '<!--' + 'a'.repeat(63_000) + '-->'
  for (const heavy of [false, true]) {
    const pages = [first, ...fanout].map(p => heavy ? { ...p, body: p.body + big } : p)
    const calls = []
    const w = await start({ ...catalog, sites: [row(pages)] }, { binding: request => {
      const path = new URL(request.url).pathname
      calls.push(path)
      if (path === '/v1/robots/policy') return sourceResponse(...snapshot.get(path))
      const value = pages.find(p => path === '/v1/html/' + p.id)
      return sourceResponse(value.url, 'html', value.body)
    } })
    try {
      const to = 'viking://~/resources/limits'
      if (heavy) {
        await result(await add(w, site({ to })), 413, 'RESOURCE_EXHAUSTED')
        assert.equal(calls.length, 5)
        await result(await send(w, pathOf('/fs/stat', to)), 404)
      } else {
        const receipt = await result(await add(w, site({ to })))
        assert.equal(receipt.documents.length, 6)
        assert.match(receipt.warnings.join(' '), /bounded/)
        assert.deepEqual(calls, ['/v1/robots/policy', ...pages.slice(0, 6).map(p => '/v1/html/' + p.id)])
      }
    } finally { await w.dispose() }
  }
})

test('the single document-read deadline also bounds a body that stalls', { timeout: 14_000 }, async () => {
  let close
  const w = await start(catalog, { binding: request => {
    const path = new URL(request.url).pathname
    if (path !== '/v1/html/guide') return sourceResponse(...snapshot.get(path))
    return sourceResponse(guide.url, 'html', new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('<h1>Opening segment</h1>'))
      close = () => { try { controller.close() } catch { /* Already cancelled. */ } }
    } }))
  } })
  try {
    const to = 'viking://~/resources/slow.txt'
    await result(await add(w, html(guide.url, { to })), 504, 'DEADLINE_EXCEEDED')
    await result(await send(w, pathOf('/fs/stat', to)), 404)
  } finally { close?.(); await w.dispose() }
})

test('a pinned but invalid Git representation still cannot be indexed', async () => {
  const malformed = JSON.stringify({ ...JSON.parse(gitFixture), path: 'docs/Different.md' })
  const w = await start({ ...catalog, git: [{ ...repo, sha256: sha(malformed) }] },
    { binding: () => sourceResponse(gitUrl, 'git', malformed) })
  try {
    const to = 'viking://~/resources/wrong.txt'
    await result(await add(w, git({ to })), 415, 'UNSUPPORTED_MEDIA_TYPE')
    await result(await send(w, pathOf('/fs/stat', to)), 404)
  } finally { await w.dispose() }
})

test('a completed site receipt and its index survive a Worker restart without another source read', async t => {
  const persist = await mkdtemp(`${process.env.TMPDIR ?? '.work'}/web-restart-`)
  let w
  try {
    w = await start(catalog, { persist })
    await seed(w)
    const { uri, task } = await completed(w, site())
    await w.dispose()
    w = await start(catalog, { binding: null, persist })
    assert.deepEqual(await flags(w, reader), falseScope)
    const previous = await result(await send(w, '/tasks/' + task.task_id))
    assert.deepEqual(previous.result, task.result)
    await found(w, uri, 'horizon flags', `${uri}/signals.txt`)
    t.diagnostic(JSON.stringify({ after_restart: true, same_task: previous.status, root_uri: uri, find: 200 }))
  } finally { await w?.dispose(); await rm(persist, { recursive: true, force: true }) }
})
