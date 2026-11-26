// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { before, test } from 'node:test'
import { build } from 'esbuild'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const hash = (text, algorithm = 'sha256') => createHash(algorithm).update(text).digest('hex')
const account = 'estuary', reader = testPrincipal(account, 'reader'), peer = testPrincipal(account, 'peer')
const administrator = testPrincipal(account, 'manager', 'admin')
const other = testPrincipal('neighbor', 'reader'), root = testPrincipal('control', 'root', 'root')
const home = 'viking://user/reader/resources'
const origin = 'https://manual.fixture.test', at = path => origin + path
const base = 'https://open.feishu.cn/open-apis', revision = 'a'.repeat(64), commit = 'c'.repeat(40)
const perm = id => `${base}/drive/v1/permissions/${id}/members/auth?type=${id === 'Legacy' ? 'doc' : 'docx'}&action=view`
const blocks = `${base}/docx/v1/documents/ApprovedDoc/blocks?page_size=100&document_revision_id=-1`
const moreBlocks = blocks + '&page_token=next%3D'
const wiki = `${base}/wiki/v2/spaces/get_node?token=ApprovedWiki`
const legacyContent = `${base}/doc/v2/Legacy/raw_content`
const robots = at('/robots.txt'), sitemap = at('/index.xml'), childMap = at('/section.xml')
const feishuSource = 'https://manual.feishu.cn/wiki/ApprovedWiki'
const tosSource = 'tos://estuary-fixture/guides/tides.txt', tos = 'https://estuary-fixture.tos-cn-beijing.volces.com/guides/tides.txt'
const bearer = 'fixture-provider-bearer', access = 'FIXTUREACCESS', secret = 'fixture-tos-signing-secret', session = 'fixture-tos-session'
const gitDocs = ['# Magnesite log\n', '# Azimuth ledger\n']
const gitFiles = ['First', 'Second'].map((stem, i) => ({ id: `git-${i}`, file: `docs/${stem}.md`, name: `${stem}.txt`, blob_sha256: hash(gitDocs[i]) }))
const gitUrl = index => `https://api.github.com/repos/fixture/estuary/contents/${gitFiles[index].file}?ref=${commit}`
const pages = ['/guide/', '/page', '/closed', '/wide', '/slow'].map((path, i) => ({ id: `page-${i}`, url: at(path), name: `page-${i}.txt` }))
const feed = (kind, url) => ({ account, id: `${kind}-feed`, url, name: `${kind}-feed`, kind, robots: 'shared-robots' })
const manifest = { version: 1, revision, sites: [{ account, entry: pages[0].url, name: 'estuary-guide', explore: true, robots: 'shared-robots', pages,
  sitemaps: [{ id: 'index', url: sitemap }, { id: 'section', url: childMap }], sitemap_entry: sitemap }],
feeds: [feed('rss', at('/news')), { ...feed('atom', at('/timeline.xml')), mirror: [pages[1].url, pages[2].url] }],
git: [{ account, alias: 'estuary-git', name: 'estuary-git', repository: 'fixture/estuary', commit, collection: true, files: gitFiles },
  { account, alias: 'git-one', name: 'First.txt', repository: 'fixture/estuary', commit, collection: false, files: gitFiles.slice(0, 1) }],
connectors: [{ account, user: reader.userId, kind: 'feishu', id: 'wiki-doc', alias: 'field-wiki', name: 'wiki.txt', source: feishuSource, target: 'docx/ApprovedDoc' },
  { account, user: reader.userId, kind: 'feishu', id: 'legacy-doc', alias: 'field-doc', name: 'doc.txt', source: 'https://manual.feishu.cn/doc/Legacy', target: null },
  { account, user: reader.userId, kind: 'tos', id: 'object', alias: 'field-object', name: 'object.txt', source: tosSource, target: 'cn-beijing' }] }
const vault = [{ id: 'wiki-doc', kind: 'feishu', bearer }, { id: 'legacy-doc', kind: 'feishu', bearer }, { id: 'object', kind: 'tos', access, secret, session }]
const headers = { 'x-test-extra': 'must stay here', cookie: 'fixture=not-forwarded' }
const xml = (kind, values) => `<${kind} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${values.map(url => (kind === 'urlset' ? `<url><loc>${url}</loc></url>` : `<sitemap><loc>${url}</loc></sitemap>`)).join('')}</${kind}>`
const block = (id, content, key = 'text', block_type = 2) => ({ block_id: id, block_type, [key]: { elements: [{ text_run: { content } }] } })
const body = (contentType, text) => new Response(text, { headers: { 'content-type': contentType } })
const text = value => body('text/plain; charset=utf-8', value)
const json = value => Response.json(value)
const feishu = data => json({ code: 0, msg: 'success', data })
const html = value => body('text/html; charset=utf-8', value)
const hmac = (key, value) => createHmac('sha256', key).update(value).digest()
function verifySignature(request, path = '/guides/tides.txt') {
  const stamp = request.headers.get('x-tos-date')
  assert.match(stamp, /^\d{8}T\d{6}Z$/)
  assert.equal(request.headers.get('x-tos-security-token'), session)
  assert.equal(request.headers.get('x-tos-content-sha256'), 'UNSIGNED-PAYLOAD')
  const date = stamp.slice(0, 8), region = 'cn-beijing'
  const canonical = `GET\n${path}\n\nhost:estuary-fixture.tos-cn-beijing.volces.com\nx-tos-content-sha256:UNSIGNED-PAYLOAD\nx-tos-date:${stamp}\nx-tos-security-token:${session}\n\nhost;x-tos-content-sha256;x-tos-date;x-tos-security-token\nUNSIGNED-PAYLOAD`
  const derived = [date, region, 'tos', 'request'].reduce(hmac, secret)
  const scope = `${date}/${region}/tos/request`
  const expected = hmac(derived, `TOS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`).toString('hex')
  assert.ok(request.headers.get('authorization') === `TOS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-tos-content-sha256;x-tos-date;x-tos-security-token, Signature=${expected}`, 'TOS4 signature mismatch')
}

function network(extra = async () => undefined) {
  const log = [], failures = [], appCalls = []
  const state = { guide: 'First lantern edition', wiki: 'Seagrass handbook', object: 'First highwater note', rss: 'First buoy report',
    blocked: false, wikiChanged: false, deny: false, denyLast: false, tosDenied: false, badGit: false, redirect: false }
  let authReads = 0
  async function requests(request) {
    const { url } = request
    log.push(url)
    assert.equal(request.method, 'GET')
    assert.equal(request.headers.get('user-agent'), 'OpenVikingEdgeImport')
    assert.equal(request.headers.get('accept-encoding'), 'identity')
    for (const name of ['cookie', 'x-api-key', 'x-test-extra', 'x-ov-web-source-url', 'x-ov-web-user', 'x-ov-web-account', 'x-ov-web-inventory-sha256']) assert.equal(request.headers.has(name), false)
    if (url.startsWith(base + '/')) assert.ok(request.headers.get('authorization') === `Bearer ${bearer}`, 'Feishu bearer mismatch')
    else if (url.startsWith('https://estuary-fixture.tos-cn-beijing.volces.com/')) verifySignature(request, new URL(url).pathname)
    else assert.equal(request.headers.has('authorization'), false)
    if (url === robots) return text(`User-agent: *\nDisallow: /closed$\n${state.blocked ? 'Disallow: /guide/$\n' : ''}Sitemap: https://elsewhere.fixture.test/sitemap.xml\n`)
    if (url === pages[0].url) return state.redirect ? Response.redirect('https://elsewhere.fixture.test/follow') :
      html(`<h1>${state.guide}</h1><a href="/page">Go</a><a href="/closed">Closed</a><a href="/unlisted">Other</a><script>skip me</script>`)
    if (url === pages[1].url) return html('<p>Marsh survey</p>')
    if (url === pages[3].url) return html('x'.repeat(64 * 1024 + 1))
    if (url === pages[4].url) {
      await new Promise(resolve => setTimeout(resolve, 8_400))
      return html('<p>Delayed text</p>')
    }
    if (url === sitemap) return body('text/xml', xml('sitemapindex', [childMap, at('/missing.xml'), 'https://elsewhere.fixture.test/foreign.xml']))
    if (url === childMap) return body('application/xml', xml('urlset', [pages[1].url, pages[2].url, at('/unlisted'), pages[1].url]))
    if (url === manifest.feeds[0].url) return body('application/rss+xml', `<rss version="2.0"><channel><item><title>News</title><description>${state.rss}</description><link>${at('/unlisted')}</link></item></channel></rss>`)
    if (url === manifest.feeds[1].url) return body('application/atom+xml', `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Calendar</title><content>Widgeon flight</content></entry><entry><link href="${pages[1].url}"/></entry><entry><title>Closed item</title><link href="${pages[2].url}"/></entry></feed>`)
    for (const [index, doc] of gitDocs.entries()) if (url === gitUrl(index)) {
      assert.equal(request.headers.get('x-github-api-version'), '2022-11-28')
      const value = state.badGit && index === 1 ? 'Changed bytes under old commit' : doc, size = Buffer.byteLength(value)
      return json({ type: 'file', name: gitFiles[index].file.split('/').at(-1), path: gitFiles[index].file, size,
        sha: hash(`blob ${size}\0${value}`, 'sha1'), encoding: 'base64', content: Buffer.from(value).toString('base64'),
        download_url: 'https://elsewhere.fixture.test/ignored.md' })
    }
    const replacement = await extra(request, state)
    if (replacement) return replacement
    if (url === wiki) return feishu({ node: { node_token: 'ApprovedWiki', obj_type: 'docx', obj_token: state.wikiChanged ? 'UnapprovedDoc' : 'ApprovedDoc', space_id: 'Scope1' } })
    if (url === perm('ApprovedDoc')) return feishu({ auth_result: !state.deny && !(state.denyLast && ++authReads > 1) })
    if (url === perm('Legacy')) return feishu({ auth_result: true })
    if (url === blocks) return feishu({ items: [block('page', state.wiki, 'page', 1)], has_more: true, page_token: 'next=' })
    if (url === moreBlocks) return feishu({ items: [block('line', 'Sediment analysis')], has_more: false })
    if (url === legacyContent) return feishu({ content: 'Limestone annex\n' })
    if (url === tos) return state.tosDenied ? new Response('fixture details not published', { status: 403 }) : text(state.object)
    assert.fail(`Unexpected provider destination: ${url}`)
  }
  const outbound = async request => {
    try { return await requests(request) } catch (error) { failures.push(error); return new Response(null, { status: 503 }) }
  }
  const appOutbound = request => { appCalls.push(request.url); return new Response(null, { status: 503 }) }
  return { state, log, outbound, appOutbound, assert() { assert.deepEqual(failures, []); assert.deepEqual(appCalls, []) } }
}

let adapter
before(async () => {
  adapter = (await build({ entryPoints: ['src/web/native-service.ts'], platform: 'browser', bundle: true, format: 'esm', write: false })).outputFiles[0].text
})
async function start(fixture, { persist, appManifest = manifest, privateManifest = appManifest, mounted = true, conversion = false, secrets = vault } = {}) {
  const w = await localWorker({ principals: [reader, peer, other, root, administrator], embeddings: 'fixture', persist, outboundService: fixture.appOutbound,
    vars: { OPENVIKING_EDGE_WEB_NATIVE_CATALOG: JSON.stringify(appManifest), ...(conversion && { OPENVIKING_EDGE_DOCUMENT_CONVERSION: '1' }) },
    serviceBindings: mounted ? { WEB_NATIVE_SOURCE: 'web-native-fixture' } : undefined,
    privateWorkers: mounted ? [{ name: 'web-native-fixture', modules: true, script: adapter, compatibilityDate: '2026-11-19',
      bindings: { OPENVIKING_EDGE_WEB_NATIVE_CATALOG: JSON.stringify(privateManifest), WEB_NATIVE_CREDENTIALS: JSON.stringify(secrets) },
      outboundService: fixture.outbound }] : [],
  })
  assert.equal((await w.ready).hostname, '127.0.0.1')
  return w
}
async function send(w, path, { method, input, actor = reader, expected = 200, code } = {}) {
  const response = await api(w, actor)('/api/v1' + path, { method, headers, body: input })
  const value = await response.json()
  assert.equal(response.status, expected, JSON.stringify(value.error))
  if (code) assert.equal(value.error?.code, code)
  assert.doesNotMatch(JSON.stringify(value), /fixture-provider-bearer|FIXTUREACCESS|fixture-tos-signing-secret|fixture-tos-session|web-native\.invalid/)
  return value.result
}
const add = (w, input, options) => send(w, '/resources', { method: 'POST', input: { processing_mode: 'vectors_only', ...input }, ...options })
const ref = (uri, path = '/content/read') => `${path}?uri=${encodeURIComponent(uri)}`
const native = (kind, path, name) => ({ add_type: kind, path, to: `${home}/${name}.txt`, args: { web_mode: 'native' } })
const rawHTML = path => ({ path, args: { web_mode: 'html' } })
const site = { path: pages[0].url, args: { site: true } }
const map = { path: sitemap, args: { sitemap: true }, to: `${home}/sitemap-result` }
const git = { path: 'estuary-git', add_type: 'git', args: { web_mode: 'collection' } }
const addFeed = (kind, args) => ({ path: manifest.feeds[kind].url, args })
async function verify(w, uri, expected, query) {
  assert.equal(await send(w, ref(uri)), expected)
  const hits = await send(w, '/search/find', { method: 'POST', input: { target_uri: home, query, limit: 20 } })
  assert.ok(hits.resources.some(hit => hit.uri === uri))
  return hash(expected)
}
async function completed(w, input) {
  const accepted = await add(w, { ...input, wait: false })
  assert.equal(accepted.status, 'accepted')
  await send(w, '/system/wait', { method: 'POST', input: { timeout: 12 } })
  const task = await send(w, `/tasks/${accepted.task_id}`)
  assert.equal(task.status, 'completed', task.error)
  assert.equal(task.result.root_uri, accepted.root_uri)
  return task
}

test('WN01: native HTML/site and recursive sitemap read only admitted origin URLs, with fresh HTML and durable task', async t => {
  const fixture = network()
  const persist = await mkdtemp(`${process.env.TMPDIR ?? '.work'}/web-native-`)
  let w
  try {
    w = await start(fixture, { persist })
    const siteJob = await completed(w, site)
    assert.deepEqual(siteJob.result.documents, ['page-0', 'page-1'].map(n => `${siteJob.result.root_uri}/${n}.txt`))
    assert.equal(siteJob.result.site_limit_reached, false)
    assert.deepEqual(fixture.log, [robots, robots, pages[0].url, robots, pages[1].url])
    const old = await verify(w, siteJob.result.documents[0], 'First lantern edition\nGoClosedOther', 'first lantern')
    fixture.state.guide = 'Seasonal driftwood edition'
    const fresh = await add(w, { ...rawHTML(pages[0].url), to: `${home}/fresh.txt` })
    const latest = await verify(w, fresh.uri, 'Seasonal driftwood edition\nGoClosedOther', 'seasonal driftwood')
    fixture.log.length = 0
    const mapped = await completed(w, map)
    assert.equal(mapped.result.sitemap_limit_reached, false)
    assert.deepEqual(mapped.result.documents, [`${home}/sitemap-result/page-1.txt`])
    const chapter = await verify(w, mapped.result.documents[0], 'Marsh survey', 'marsh survey')
    assert.deepEqual(fixture.log, [robots, robots, sitemap, robots, childMap, robots, pages[1].url])
    await w.dispose()
    fixture.log.length = 0
    w = await start(fixture, { persist })
    assert.deepEqual((await send(w, `/tasks/${mapped.task_id}`)).result, mapped.result)
    await send(w, `/tasks/${mapped.task_id}`, { actor: peer, expected: 404 })
    await verify(w, mapped.result.documents[0], 'Marsh survey', 'marsh survey')
    assert.deepEqual(fixture.log, [])
    fixture.assert()
    t.diagnostic(JSON.stringify({ worker: w.localBuildSha256, adapter: hash(adapter), task: mapped.task_id, old, latest, chapter }))
  } finally { await w?.dispose(); await rm(persist, { recursive: true, force: true }) }
})

test('WN02: live RSS and Atom with no link traversal; pinned Git Contents bytes and atomic rollback', async t => {
  const f = network(), w = await start(f)
  try {
    const rss = await add(w, addFeed(0, { feed: true }))
    f.state.rss = 'Second navigation bulletin'
    const fresh = await add(w, addFeed(0, { web_mode: 'feed' }))
    const atom = await completed(w, addFeed(1, { web_mode: 'feed' }))
    assert.equal(fresh.feed_limit_reached, false)
    assert.deepEqual(f.log, [robots, manifest.feeds[0].url, robots, manifest.feeds[0].url, robots, robots, manifest.feeds[1].url, robots, pages[1].url])
    await verify(w, rss.documents[0], 'News\n\nFirst buoy report', 'first buoy')
    await verify(w, fresh.documents[0], 'News\n\nSecond navigation bulletin', 'second navigation')
    await verify(w, atom.result.documents[0], 'Calendar\n\nWidgeon flight', 'widgeon flight')
    assert.deepEqual(atom.result.documents.map(uri => uri.split('/').at(-1)), ['entry-01.txt', pages[1].name, 'entry-03.txt'])
    await verify(w, atom.result.documents[1], 'Marsh survey', 'marsh survey')
    f.log.length = 0
    f.state.badGit = true
    await add(w, git, { expected: 503, code: 'SOURCE_UNAVAILABLE' })
    await send(w, ref(`${home}/estuary-git`, '/fs/stat'), { expected: 404 })
    f.state.badGit = false
    const docs = await completed(w, git)
    const digests = []
    for (const [i, uri] of docs.result.documents.entries()) digests.push(await verify(w, uri, gitDocs[i], gitDocs[i]))
    const one = await add(w, { path: 'git-one', add_type: 'git', to: `${home}/standalone.txt` })
    await verify(w, one.uri, gitDocs[0], 'magnesite log')
    assert.deepEqual(f.log, [gitUrl(0), gitUrl(1), gitUrl(0), gitUrl(1), gitUrl(0)])
    f.assert()
    t.diagnostic(JSON.stringify({ git: docs.task_id, digests, atom: atom.task_id, updated: fresh.documents[0] }))
  } finally { await w.dispose() }
})

test('WN03: Feishu wiki identity, ACL and DOCX cursor plus legacy raw_content; signed TOS GetObject and replacement', async t => {
  const f = network(), w = await start(f)
  try {
    const wikiImport = native('feishu', feishuSource, 'wiki')
    const first = await completed(w, wikiImport)
    assert.deepEqual(f.log, [wiki, perm('ApprovedDoc'), blocks, moreBlocks, perm('ApprovedDoc')])
    await verify(w, first.result.uri, 'Seagrass handbook\n\nSediment analysis', 'sediment analysis')
    f.state.wiki = 'Benthos revised handbook'
    const second = await add(w, { ...wikiImport, path: 'field-wiki' })
    const wikiDigest = await verify(w, second.uri, 'Benthos revised handbook\n\nSediment analysis', 'benthos revised')
    f.log.length = 0
    const legacy = await add(w, native('feishu', 'field-doc', 'legacy'))
    await verify(w, legacy.uri, 'Limestone annex\n', 'limestone annex')
    const old = await add(w, native('tos', tosSource, 'object'))
    await verify(w, old.uri, 'First highwater note', 'first highwater')
    f.state.object = 'Second neap tide bulletin'
    const updated = await completed(w, native('tos', 'field-object', 'object'))
    const tosDigest = await verify(w, updated.result.uri, f.state.object, 'neap tide')
    assert.deepEqual(f.log, [perm('Legacy'), legacyContent, perm('Legacy'), tos, tos])
    await send(w, ref(updated.result.uri), { actor: peer, expected: 403 })
    f.assert()
    t.diagnostic(JSON.stringify({ wiki: first.task_id, tos: updated.task_id, wikiDigest, tosDigest }))
  } finally { await w.dispose() }
})

test('WN04: native admission, actor-scoped capabilities, robots, provider ACL, Wiki retarget and redirects fail without publication', async () => {
  const f = network(), w = await start(f)
  const connector = native('feishu', 'field-wiki', 'denied')
  try {
    for (const [actor, publicMounted, privateMounted] of [[reader, true, true], [peer, true, false], [other, false, false], [root, false, false]]) {
      const { features } = await send(w, '/system/edge-capabilities', { actor })
      for (const feature of ['liveOriginImport', 'liveGitDocsImport', 'liveFeedImport', 'sitemapImport']) assert.equal(features[feature], publicMounted)
      for (const feature of ['feishuNativeImport', 'tosNativeImport']) assert.equal(features[feature], privateMounted)
      assert.equal(features.feishuArchiveImport, false)
      assert.equal(features.tosArchiveImport, false)
    }
    await add(w, rawHTML(at('/unlisted')), { expected: 503, code: 'SOURCE_UNAVAILABLE' })
    await add(w, { ...connector, to: 'viking://resources/leak.txt' }, { expected: 400 })
    await add(w, { ...connector, args: { web_mode: 'native', feishu_access_token: 'not-forwarded' } }, { expected: 400 })
    await add(w, { ...connector, connector_auth_config: { token: 'not-forwarded' } }, { expected: 400 })
    await add(w, native('tos', 'tos://estuary-fixture/guides/unknown.txt', 'denied'), { expected: 503 })
    await add(w, connector, { actor: peer, expected: 501 })
    await add(w, connector, { actor: other, expected: 501 })
    assert.deepEqual(f.log, [])
    f.state.wikiChanged = true
    await add(w, connector, { expected: 403, code: 'SOURCE_DENIED' })
    assert.deepEqual(f.log.splice(0), [wiki])
    f.state.wikiChanged = false
    f.state.deny = true
    await add(w, connector, { expected: 403, code: 'SOURCE_DENIED' })
    assert.deepEqual(f.log.splice(0), [wiki, perm('ApprovedDoc')])
    f.state.deny = false
    f.state.denyLast = true
    await add(w, connector, { expected: 403, code: 'SOURCE_DENIED' })
    assert.deepEqual(f.log.splice(0), [wiki, perm('ApprovedDoc'), blocks, moreBlocks, perm('ApprovedDoc')])
    f.state.tosDenied = true
    await add(w, native('tos', tosSource, 'denied'), { expected: 403, code: 'SOURCE_DENIED' })
    assert.deepEqual(f.log.splice(0), [tos])
    f.state.blocked = true
    await add(w, site, { expected: 403, code: 'ROBOTS_DENIED' })
    assert.deepEqual(f.log.splice(0), [robots])
    f.state.blocked = false
    f.state.redirect = true
    await add(w, site, { expected: 503, code: 'SOURCE_UNAVAILABLE' })
    assert.deepEqual(f.log.splice(0), [robots, robots, pages[0].url])
    await send(w, ref(`${home}/denied.txt`, '/fs/stat'), { expected: 404 })
    await send(w, ref(`${home}/estuary-guide`, '/fs/stat'), { expected: 404 })
    f.assert()
  } finally { await w.dispose() }
})

test('WN05: provider byte/deadline and split mount fail closed, with no path created', async t => {
  const f = network(), w = await start(f)
  try {
    await add(w, rawHTML(pages[3].url), { expected: 413, code: 'RESOURCE_EXHAUSTED' })
    const start = performance.now()
    await add(w, rawHTML(pages[4].url), { expected: 504, code: 'DEADLINE_EXCEEDED' })
    t.diagnostic(`deadline elapsed ms: ${Math.round(performance.now() - start)}`)
    for (const i of [3, 4]) await send(w, ref(`${home}/page-${i}.txt`, '/fs/stat'), { expected: 404 })
    assert.deepEqual(f.log, [robots, robots, pages[3].url, robots, robots, pages[4].url])
    f.assert()
  } finally { await w.dispose() }
  f.log.length = 0
  const split = await start(f, { privateManifest: { ...manifest, connectors: [] } })
  try { await add(split, site, { expected: 503, code: 'SOURCE_UNAVAILABLE' }) } finally { await split.dispose() }
  const absent = await start(f, { mounted: false })
  try {
    assert.equal((await send(absent, '/system/edge-capabilities')).features.liveOriginImport, false)
    await add(absent, site, { expected: 501 })
  } finally { await absent.dispose() }
  assert.deepEqual(f.log, [])
  f.assert()
})

const childNode = `${base}/wiki/v2/spaces/get_node?token=ChildNode`, fileNode = `${base}/wiki/v2/spaces/get_node?token=PdfNode`
const filePermission = `${base}/drive/v1/permissions/FileToken/members/auth?type=file&action=view`
const download = `${base}/drive/v1/files/FileToken/download`
const pdf = 'https://estuary-fixture.tos-cn-beijing.volces.com/guides/scan.pdf'
const atlas = 'https://estuary-fixture.tos-cn-beijing.volces.com/guides/atlas.md'
const sheetAcl = `${base}/drive/v1/permissions/SheetKey/members/auth?type=sheet&action=view`
const sheetData = `${base}/sheets/v2/spreadsheets/SheetKey/values/Sheet1!A1%3AB2`
const tableAcl = `${base}/drive/v1/permissions/BaseKey/members/auth?type=bitable&action=view`
const tableData = `${base}/bitable/v1/apps/BaseKey/tables/tblapproved/records?page_size=100&field_names=%5B%22Mineral%22%2C%22Depth%22%5D`
const userFields = { account, user: reader.userId }
const richManifest = { ...manifest, connectors: [
  { ...manifest.connectors[0], wiki: { space: 'Scope1', parent: null } },
  { ...manifest.connectors[1], id: 'tree-child', alias: 'tree-child', source: 'https://manual.feishu.cn/wiki/ChildNode',
    target: 'doc/Legacy', wiki: { space: 'Scope1', parent: 'ApprovedWiki' } },
  { ...manifest.connectors[1], id: 'drive-pdf', alias: 'drive-pdf', source: 'https://manual.feishu.cn/wiki/PdfNode',
    target: 'file/FileToken', wiki: { space: 'Scope1', parent: 'ApprovedWiki' }, binary: 'scan.pdf' },
  { ...manifest.connectors[1], id: 'sheet', alias: 'survey-sheet', source: 'https://manual.feishu.cn/sheets/SheetKey', data: { range: 'Sheet1!A1:B2' } },
  { ...manifest.connectors[1], id: 'base', alias: 'survey-base', source: 'https://manual.feishu.cn/base/BaseKey', data: { table: 'tblapproved', columns: ['Mineral', 'Depth'] } },
  { ...manifest.connectors[2], watch: true },
  { ...manifest.connectors[2], id: 'atlas', alias: 'atlas', source: 'tos://estuary-fixture/guides/atlas.md' },
  { ...manifest.connectors[2], id: 'pdf', alias: 'pdf', source: 'tos://estuary-fixture/guides/scan.pdf', binary: 'scan.pdf' },
], groups: [
  { ...userFields, alias: 'wiki-tree', name: 'wiki-tree', kind: 'feishu', watch: true, objects: [
    { id: 'wiki-doc', relative: 'root.txt' }, { id: 'tree-child', relative: 'root/legacy.txt' }, { id: 'drive-pdf', relative: 'root/scan.txt' },
  ] },
  { ...userFields, alias: 'tos-library', name: 'tos-library', kind: 'tos', watch: true, objects: [
    { id: 'object', relative: 'tides.txt' }, { id: 'atlas', relative: 'survey/atlas.txt' }, { id: 'pdf', relative: 'survey/scan.txt' },
  ] },
  { ...userFields, alias: 'tos-notes', name: 'tos-notes', kind: 'tos', watch: true, objects: [
    { id: 'object', relative: 'tides.txt' }, { id: 'atlas', relative: 'survey/atlas.txt' },
  ] },
] }
const richVault = [vault[0], vault[2], ...['tree-child', 'drive-pdf', 'sheet', 'base'].map(id => ({ ...vault[0], id })), ...['atlas', 'pdf'].map(id => ({ ...vault[2], id }))]
const mount = { appManifest: richManifest, secrets: richVault }
const richFixture = () => network((request, state) => {
  const url = request.url
  if (url === childNode) return feishu({ node: { node_token: 'ChildNode', obj_type: 'doc', obj_token: 'Legacy', space_id: 'Scope1',
    parent_node_token: state.moveChild ? 'UnapprovedParent' : 'ApprovedWiki' } })
  if (url === fileNode) return feishu({ node: { node_token: 'PdfNode', obj_type: 'file', obj_token: 'FileToken', space_id: 'Scope1', parent_node_token: 'ApprovedWiki' } })
  if (url === download || url === pdf) {
    assert.equal(request.headers.get('accept'), 'application/pdf')
    return body('application/pdf', state.badPdf ? 'not a pdf' : '%PDF-1.7\nSynthetic local file only')
  }
  if (url === filePermission) return feishu({ auth_result: true })
  if (url === sheetAcl || url === tableAcl) return feishu({ auth_result: true })
  if (url === sheetData) return feishu({ valueRange: { range: state.badRange ? 'Foreign!A1:B2' : 'Sheet1!A1:B2', values: [['Feldspar', 43], ['Apatite', 12]] } })
  if (url === tableData) return feishu({ items: [{ record_id: 'row1', fields: { Mineral: [{ type: 'text', text: 'Aragonite' }], Depth: 8,
    NonAdmitted: 'Do not publish this' } }], has_more: true, page_token: 'next=' })
  if (url === `${tableData}&page_token=next%3D`) return feishu({ items: [{ record_id: 'row2', fields: { Mineral: 'Dolomite', Depth: 3 } }], has_more: false })
  if (url === moreBlocks) return feishu({ has_more: false, items: [
    { block_id: 'table', block_type: 31, table: { property: { row_size: 1, column_size: 2 }, cells: ['ca', 'cb'] } },
    { block_id: 'ca', block_type: 32, parent_id: 'table', children: ['cl'] },
    { block_id: 'cb', block_type: 32, parent_id: 'table', children: ['cr'] },
    { ...block('cl', 'Calcite'), parent_id: 'ca' }, { ...block('cr', '2.4 meters'), parent_id: 'cb' },
    { block_id: 'todo', block_type: 17, todo: { elements: [{ equation: { content: 'Delta H' } }], style: { done: true } } },
  ] })
  if (url === atlas) {
    if (state.holdAtlas) return state.holdAtlas.then(() => text('Held sediment map'))
    return state.denyAtlas ? new Response(null, { status: 403 }) : text(state.atlas ?? 'First sediment map')
  }
})
const groupRequest = (kind, alias, name = alias) => ({ add_type: kind, path: alias,
  args: { web_mode: kind === 'feishu' ? 'tree' : 'collection' }, to: `${home}/${name}` })

test('WN06: Wiki hierarchy and rich projection, binary conversion fences, and atomic multi-object TOS collection', async t => {
  const f = richFixture()
  let w = await start(f, mount)
  const tree = groupRequest('feishu', 'wiki-tree'), library = groupRequest('tos', 'tos-library')
  try {
    await add(w, tree, { expected: 503, code: 'CONVERSION_UNAVAILABLE' })
    await add(w, library, { expected: 503, code: 'CONVERSION_UNAVAILABLE' })
    assert.deepEqual(f.log, [])
    await w.dispose()
    w = await start(f, { ...mount, conversion: true })
    f.state.moveChild = true
    await add(w, tree, { expected: 403, code: 'SOURCE_DENIED' })
    assert.deepEqual(f.log.splice(0), [wiki, perm('ApprovedDoc'), blocks, moreBlocks, perm('ApprovedDoc'), wiki, childNode])
    await send(w, ref(tree.to, '/fs/stat'), { expected: 404 })
    f.state.moveChild = false
    const imported = await completed(w, tree)
    const [rich, legacy, converted] = imported.result.documents
    assert.deepEqual([rich, legacy, converted], ['root.txt','root/legacy.txt','root/scan.txt'].map(path => `${tree.to}/${path}`))
    await verify(w, rich, 'Seagrass handbook\n\n| Calcite | 2.4 meters |\n| --- | --- |\n\n- [x] Delta H', 'calcite meters')
    await verify(w, legacy, 'Limestone annex\n', 'limestone annex')
    const signature = await verify(w, converted, '# Converted document\n\nFixture-only Markdown.', 'fixture only markdown')
    assert.deepEqual(f.log.splice(0), [wiki, perm('ApprovedDoc'), blocks, moreBlocks, perm('ApprovedDoc'), wiki,
      childNode, perm('Legacy'), legacyContent, perm('Legacy'), childNode, fileNode, filePermission, download, filePermission, fileNode])
    f.state.badPdf = true
    await add(w, library, { expected: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
    assert.deepEqual(f.log.splice(0), [tos, atlas, pdf])
    await send(w, ref(library.to, '/fs/stat'), { expected: 404 })
    f.state.badPdf = false
    const items = await completed(w, library)
    assert.deepEqual(items.result.documents, ['tides.txt','survey/atlas.txt','survey/scan.txt'].map(path => `${library.to}/${path}`))
    await verify(w, items.result.documents[1], 'First sediment map', 'sediment map')
    await verify(w, items.result.documents[2], '# Converted document\n\nFixture-only Markdown.', 'fixture only markdown')
    assert.deepEqual(f.log.splice(0), [tos, atlas, pdf])
    f.assert()
    t.diagnostic(JSON.stringify({ worker: w.localBuildSha256, adapter: hash(adapter), tree: imported.task_id, library: items.task_id, signature }))
  } finally { await w.dispose() }
})

test('WN07: provider watch survives restart, refreshes all files, and stops on provider denial, destination edit and member floor', async t => {
  const f = richFixture(), persist = await mkdtemp(`${process.env.TMPDIR ?? '.work'}/web-native-watch-`)
  const input = groupRequest('tos', 'tos-notes'), path = `${input.to}/survey/atlas.txt`
  let w
  try {
    w = await start(f, { ...mount, persist })
    const watch = await add(w, { ...input, watch_interval: 5 })
    assert.equal(watch.source_type, 'tos')
    assert.equal(watch.scheduled, true)
    assert.equal((await send(w, '/system/edge-capabilities')).features.providerWatches, true)
    assert.equal((await send(w, '/system/edge-capabilities', { actor: peer })).features.providerWatches, false)
    assert.deepEqual(f.log, [])
    const endpoint = `/watches/${watch.task_id}`
    await send(w, endpoint, { actor: peer, expected: 404 })
    const trigger = async () => {
      await send(w, endpoint + '/trigger', { method: 'POST', input: {} })
      await send(w, '/system/wait', { method: 'POST', input: { timeout: 12 } })
      return send(w, endpoint)
    }
    const first = await trigger()
    assert.equal(first.last_status, 'completed', first.last_error)
    await verify(w, path, 'First sediment map', 'sediment map')
    await w.dispose()
    w = await start(f, { ...mount, persist })
    f.state.atlas = 'Updated pyrite map'
    f.state.object = 'Changed field notes'
    const second = await trigger()
    assert.equal(second.last_status, 'completed', second.last_error)
    const digest = await verify(w, path, f.state.atlas, 'pyrite map')
    await verify(w, `${input.to}/tides.txt`, f.state.object, 'changed field notes')
    const unchanged = await trigger()
    assert.equal((await send(w, `/tasks/${unchanged.last_task_id}`)).result.changed, false)
    f.state.object = 'Content that must not partially replace the collection'
    f.state.denyAtlas = true
    assert.equal((await trigger()).last_status, 'failed')
    await verify(w, `${input.to}/tides.txt`, 'Changed field notes', 'changed field notes')
    await send(w, '/content/write', { method: 'POST', input: { uri: path, content: 'Manual override', mode: 'replace' } })
    const before = f.log.length
    assert.equal((await trigger()).last_status, 'failed')
    assert.equal(f.log.length, before)
    assert.equal(await send(w, ref(path)), 'Manual override')
    const membership = '/admin/accounts/estuary/groups/importers/members'
    await send(w, '/admin/accounts/estuary/groups', { actor: administrator, method: 'POST', input: { group_id: 'importers' } })
    await send(w, membership, { actor: administrator, method: 'PUT', input: { user_ids: [reader.userId] } })
    const secondWatch = await send(w, '/watches', { method: 'POST', input: { ...groupRequest('tos', 'tos-notes', 'revoked'), watch_interval: 5 } })
    await send(w, membership, { actor: administrator, method: 'DELETE', input: { user_ids: [reader.userId] } })
    await send(w, `/watches/${secondWatch.task_id}/trigger`, { method: 'POST', input: {}, expected: 403, code: 'PERMISSION_DENIED' })
    assert.equal(f.log.length, before)
    f.assert()
    t.diagnostic(JSON.stringify({ watch: watch.task_id, first: first.last_task_id, refreshed: second.last_task_id, digest }))
  } finally { await w?.dispose(); await rm(persist, { recursive: true, force: true }) }
})

test('WN08: a scheduled Workerd provider alarm fires across restart without a trigger', { timeout: 78_000 }, async t => {
  const f = richFixture(), persist = await mkdtemp(`${process.env.TMPDIR ?? '.work'}/web-native-alarm-`)
  let w
  try {
    w = await start(f, { ...mount, persist })
    const input = groupRequest('tos', 'tos-notes', 'timed')
    const scheduled = await add(w, { ...input, watch_interval: 1 })
    const due = Date.parse(scheduled.next_execution_time)
    assert.deepEqual(f.log, [])
    await w.dispose()
    w = await start(f, { ...mount, persist })
    const endpoint = `/watches/${scheduled.task_id}`
    let watch
    while (Date.now() < due + 10_000) {
      watch = await send(w, endpoint)
      if (watch.last_status) break
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    assert.equal(watch?.last_status, 'completed', watch?.last_error)
    assert.equal(watch.last_task_id, null)
    assert.ok(Date.parse(watch.last_execution_time) >= due)
    await verify(w, `${input.to}/survey/atlas.txt`, 'First sediment map', 'sediment map')
    assert.deepEqual(f.log, [tos, atlas])
    f.assert()
    t.diagnostic(JSON.stringify({ alarm: scheduled.task_id, due, actual: Date.parse(watch.last_execution_time), worker: w.localBuildSha256 }))
  } finally { await w?.dispose(); await rm(persist, { recursive: true, force: true }) }
})

test('WN09: Feishu Sheet exact range and Bitable exact table/fields are indexed, mismatched ranges fail', async t => {
  const f = richFixture(), w = await start(f, mount)
  try {
    const req = native('feishu', 'survey-sheet', 'sheet')
    f.state.badRange = true
    await add(w, req, { expected: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
    await send(w, ref(req.to, '/fs/stat'), { expected: 404 })
    assert.deepEqual(f.log.splice(0), [sheetAcl, sheetData])
    f.state.badRange = false
    const sheet = await add(w, req)
    const one = await verify(w, sheet.uri, 'Feldspar\t43\nApatite\t12', 'feldspar apatite')
    const table = await completed(w, native('feishu', 'survey-base', 'base'))
    const two = await verify(w, table.result.uri, 'Mineral\tDepth\nAragonite\t8\nDolomite\t3', 'aragonite dolomite')
    assert.deepEqual(f.log, [sheetAcl, sheetData, sheetAcl, tableAcl, tableData, tableData + '&page_token=next%3D', tableAcl])
    f.assert()
    t.diagnostic(JSON.stringify({ sheet: one, table: two, task: table.task_id }))
  } finally { await w.dispose() }
})
