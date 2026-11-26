// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const sha = (body, kind = 'sha256') => createHash(kind).update(body).digest('hex')
const account = 'harbor', origin = 'https://manual.fixture.test', host = 'https://web-source.invalid'
const reader = testPrincipal(account, 'reader'), peer = testPrincipal(account, 'peer')
const outside = testPrincipal('other', 'reader'), root = testPrincipal('control', 'root', 'root')
const home = 'viking://user/reader/resources', entry = origin + '/map.html'
const payloads = new Map()
function bind(kind, id, url, mime, body) {
  payloads.set(`/v1/${kind}/${id}`, { url, mime, body })
  return { id, sha256: sha(body) }
}
const robots = bind('robots', 'policy', origin + '/robots.txt', 'text/plain', 'User-agent: *\nDisallow: /closed.html$\n')
const pages = ['map', 'dunes', 'reed', 'shoal', 'closed'].map(word => ({ id: 'live-' + word, url: `${origin}/${word}.html`, name: `${word}.txt` }))
const pageBodies = ['<h1>Heron chart</h1><a href="dunes.html">Dunes</a><a href="closed.html">Closed</a><a href="unlisted.html">Out</a><a href="https://elsewhere.fixture.test/page.html">Elsewhere</a>',
  '<p>Cormorant dunes</p><a href="reed.html">Reed</a>', '<p>Egret marsh</p><a href="shoal.html">Shoal</a>', '<p>Tidal shoal</p>', '<p>Closed chapter</p>']
for (const [index, page] of pages.entries()) bind('live-html', page.id, page.url, 'text/html', pageBodies[index])
const rss = `<rss version="2.0"><channel>${Array.from({ length: 7 }, (_, index) => `<item><title>Buoy ${index + 1}</title><link>https://elsewhere.fixture.test/item.html</link><description><![CDATA[<p>Brackish currents</p><script>omit</script>]]></description></item>`).join('')}</channel></rss>`
const atom = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Tern &amp; gull</title><link rel="alternate" href="https://elsewhere.fixture.test/item.html"/><content type="html">&lt;p&gt;Breakwater &#233;&lt;/p&gt;</content></entry></feed>'
const feeds = [
  ['rss', 'approved-news', rss], ['atom', 'approved-atom', atom],
  ['rss', 'bad-shape', '<rss version="2.0"><channel><item><title>Incomplete</title></channel></rss>'],
  ['atom', 'unsupported-body', '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Marker</title><content type="xhtml"><div>Not supported</div></content></entry></feed>'],
].map(([kind, id, body]) => ({ account, kind, name: id, url: `${origin}/${id}.xml`,
  ...bind(kind, id, `${origin}/${id}.xml`, `application/${kind}+xml`, body) }))
const revision = 'b'.repeat(40), repository = 'fixture/shore-manual'
const gitTexts = ['# Quartz compass\n', '# Azimuth almanac\n']
const files = ['Compass', 'Almanac'].map((title, index) => {
  const file = `docs/${title}.md`, text = gitTexts[index], size = Buffer.byteLength(text)
  const body = JSON.stringify({ type: 'file', path: file, name: `${title}.md`, encoding: 'base64', content: Buffer.from(text).toString('base64'),
    size, sha: sha(`blob ${size}\0${text}`, 'sha1'), download_url: 'https://elsewhere.fixture.test/document.md' })
  const { id: collection, sha256 } = bind('git', `sealed-${index}`, `https://api.github.com/repos/${repository}/contents/${file}?ref=${revision}`, 'application/json', body)
  return { file, name: title.toLowerCase() + '.txt', collection, sha256 }
})
const archives = ['feishu', 'tos'].map(kind => ({ account, kind, alias: `${kind}-guide`, name: `${kind}.txt`,
  ...bind(kind, `sealed-${kind}`, `${host}/v1/${kind}/sealed-${kind}`, 'application/json',
    JSON.stringify({ format: `ov-${kind}-text-v1`, text: `${kind} working harbor ledger\n` })) }))
const wrongArchiveId = 'wrong-kind'
const wrongArchive = { account, kind: 'tos', alias: 'wrong-kind', name: 'wrong.txt',
  ...bind('tos', wrongArchiveId, `${host}/v1/tos/${wrongArchiveId}`, 'application/json',
    JSON.stringify({ format: 'ov-feishu-text-v1', text: 'Wrong archive.' })) }
const catalog = { version: 2, sites: [], git: [], feeds, archives: [...archives, wrongArchive],
  live_sites: [{ account, entry, name: 'live-map', explore: true, robots, pages }],
  git_collections: [{ account, alias: 'shore-manual', repository, revision, name: 'shore-docs', files }] }
const site = { path: entry, args: { site: true } }
const feed = path => ({ path, args: { web_mode: 'feed' } })
const git = { path: 'shore-manual', add_type: 'git', args: { web_mode: 'collection' } }
const archive = (kind, alias = `${kind}-guide`) => ({ path: alias, add_type: kind, to: `${home}/${kind}.txt` })
const readUri = (uri, endpoint = '/content/read') => `${endpoint}?uri=${encodeURIComponent(uri)}`
const log = []
let unbound = 0, worker, adapterScript, failPath
const noOutbound = () => { unbound++; return new Response(null, { status: 503 }) }
function intercept(request) {
  const url = new URL(request.url)
  log.push(url.pathname)
  assert.equal(url.origin, host)
  assert.equal(url.search, '')
  assert.equal(request.method, 'GET')
  for (const field of ['authorization', 'cookie', 'x-api-key', 'x-test-extra']) assert.equal(request.headers.get(field), null)
  const item = payloads.get(url.pathname)
  if (!item || url.pathname === failPath) return new Response(null, { status: 503 })
  assert.equal(request.headers.get('accept'), item.mime)
  return new Response(item.body, { headers: { 'content-type': 'application/octet-stream',
    'x-ov-web-source-url': item.url, 'x-ov-web-source-type': item.mime } })
}
async function start(options = {}) {
  const w = await localWorker({ principals: [reader, peer, outside, root], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_WEB_CATALOG: JSON.stringify(options.catalog ?? catalog) }, persist: options.persist,
    serviceBindings: { WEB_SOURCE: options.binding ?? intercept }, outboundService: noOutbound,
    privateWorkers: options.privateWorkers })
  assert.equal((await w.ready).hostname, '127.0.0.1')
  return w
}
async function send(w, endpoint, { method, body, actor = reader, expected = 200, code } = {}) {
  const reply = await api(w, actor)(`/api/v1${endpoint}`, { method, body, headers: { 'x-test-extra': 'not forwarded' } })
  const value = await reply.json()
  assert.equal(reply.status, expected, JSON.stringify(value.error))
  if (code) assert.equal(value.error?.code, code)
  return value.result
}
const add = (w, body, options) => send(w, '/resources', { method: 'POST', body, ...options })
const wait = w => send(w, '/system/wait', { method: 'POST', body: { timeout: 12 } })
const task = (w, id, options) => send(w, `/tasks/${id}`, options)
async function completed(w, body) {
  const accepted = await add(w, { ...body, wait: false })
  assert.equal(accepted.status, 'accepted')
  assert.ok(!('site_limit_reached' in accepted))
  await wait(w)
  const status = await task(w, accepted.task_id)
  assert.equal(status.status, 'completed', status.error)
  assert.equal(status.result.root_uri, accepted.root_uri)
  assert.equal(status.task_type, 'add_resource')
  return status
}
async function readFound(w, uri, text, query) {
  assert.equal(await send(w, readUri(uri)), text)
  const hits = await send(w, '/search/find', { method: 'POST', body: { target_uri: home, query, limit: 20 } })
  assert.ok(hits.resources.some(hit => hit.uri === uri))
  return sha(text)
}
before(async () => {
  worker = await start()
  const buildResult = await build({ entryPoints: ['src/web/snapshot-service.ts'], format: 'esm', bundle: true, write: false })
  adapterScript = buildResult.outputFiles[0].text
})
after(async () => { try { assert.equal(unbound, 0) } finally { await worker?.dispose() } })

test('F5-W01 exact live traversal, stored limit, same-task recovery across restart and key isolation', async t => {
  const persist = await mkdtemp(`${process.env.TMPDIR ?? '.work'}/web-f5-`)
  let w
  try {
    log.length = 0
    w = await start({ persist })
    const terminal = await completed(w, site)
    const uri = `${home}/live-map`
    assert.deepEqual(terminal.result.documents, ['map', 'dunes', 'reed'].map(name => `${uri}/${name}.txt`))
    assert.equal(terminal.result.site_limit_reached, true)
    assert.deepEqual(log, ['/v1/robots/policy', '/v1/live-html/live-map', '/v1/live-html/live-dunes', '/v1/live-html/live-reed'])
    await w.dispose()
    w = await start({ persist, binding: () => { assert.fail('A terminal read must not contact the binding') } })
    assert.deepEqual((await task(w, terminal.task_id)).result, terminal.result)
    await task(w, terminal.task_id, { actor: peer, expected: 404 })
    const digest = await readFound(w, `${uri}/reed.txt`, 'Egret marsh\nShoal', 'egret marsh')
    t.diagnostic(JSON.stringify({ build: w.localBuildSha256, same_task: terminal.task_id, uri, digest, site_limit_reached: true }))
  } finally { await w?.dispose(); await rm(persist, { recursive: true, force: true }) }
})

test('F5-W02 real private R2 adapter reads current HTML per request, without spraying links or snapshot fallback', async t => {
  const w = await start({ binding: 'private-reader', privateWorkers: [{ name: 'private-reader', modules: true, script: adapterScript,
    compatibilityDate: '2026-11-19', r2Buckets: ['WEB_SNAPSHOTS', 'WEB_LIVE_DOCUMENTS'], outboundService: noOutbound }] })
  try {
    const snapshots = await w.getR2Bucket('WEB_SNAPSHOTS', 'private-reader')
    const liveStore = await w.getR2Bucket('WEB_LIVE_DOCUMENTS', 'private-reader')
    const write = (bucket, key, text, sourceUrl) => bucket.put(key, text, { customMetadata: { sourceUrl } })
    await write(snapshots, 'robots/policy', payloads.get('/v1/robots/policy').body, origin + '/robots.txt')
    await write(snapshots, 'html/live-map', '<p>Stale snapshot only</p>', entry)
    await add(w, site, { expected: 503, code: 'SOURCE_UNAVAILABLE' })
    await write(liveStore, 'live-html/live-map', '<p>First edition</p>', entry)
    const first = await add(w, site)
    assert.equal(first.site_limit_reached, false)
    assert.equal(await send(w, readUri(`${first.root_uri}/map.txt`)), 'First edition')
    await write(liveStore, 'live-html/live-map', '<p>Second edition driftwood</p><a href="unlisted.html">More</a>', entry)
    const second = await add(w, site)
    assert.notEqual(second.root_uri, first.root_uri)
    assert.equal(second.site_limit_reached, false)
    const digest = await readFound(w, `${second.root_uri}/map.txt`, 'Second edition driftwood\nMore', 'edition driftwood')
    t.diagnostic(JSON.stringify({ first: first.root_uri, second: second.root_uri, digest, adapter: sha(adapterScript) }))
  } finally { await w.dispose() }
})

test('F5-W03 bounded RSS and Atom yield exact files, text and real search hits, never open a feed link', async t => {
  log.length = 0
  const news = await completed(worker, feed(feeds[0].url))
  const timeline = await completed(worker, feed(feeds[1].url))
  assert.equal(news.result.feed_limit_reached, true)
  assert.ok(!('site_limit_reached' in news.result))
  assert.deepEqual(news.result.documents, Array.from({ length: 6 }, (_, i) => `${home}/approved-news/entry-0${i + 1}.txt`))
  assert.equal(timeline.result.feed_limit_reached, false)
  assert.deepEqual(timeline.result.documents, [`${home}/approved-atom/entry-01.txt`])
  const digests = [await readFound(worker, news.result.documents[0], 'Buoy 1\n\nBrackish currents', 'brackish currents'),
    await readFound(worker, timeline.result.documents[0], 'Tern & gull\n\nBreakwater é', 'breakwater gull')]
  assert.deepEqual(log, ['/v1/rss/approved-news', '/v1/atom/approved-atom'])
  t.diagnostic(JSON.stringify({ tasks: [news.task_id, timeline.task_id], digests, rss_limit: true, atom_limit: false }))
})

test('F5-W04 GitHub Contents at one revision and two pinned documentary archives, atomic rollback on later file failure', async t => {
  log.length = 0
  failPath = '/v1/git/sealed-1'
  try { await add(worker, git, { expected: 503, code: 'SOURCE_UNAVAILABLE' }) } finally { failPath = undefined }
  await send(worker, readUri(`${home}/shore-docs`, '/fs/stat'), { expected: 404 })
  const collection = await completed(worker, git)
  assert.deepEqual(collection.result.documents, files.map(file => `${home}/shore-docs/${file.name}`))
  const digests = []
  for (const [i, uri] of collection.result.documents.entries()) digests.push(await readFound(worker, uri, gitTexts[i], gitTexts[i].trim()))
  for (const kind of ['feishu', 'tos']) {
    const completedArchive = await completed(worker, archive(kind))
    assert.deepEqual(completedArchive.result.documents, [`${home}/${kind}.txt`])
    assert.doesNotMatch(JSON.stringify(completedArchive), /sealed-|web-source\.invalid/)
    digests.push(await readFound(worker, completedArchive.result.documents[0], `${kind} working harbor ledger\n`, `${kind} ledger`))
  }
  assert.deepEqual(log, ['/v1/git/sealed-0', '/v1/git/sealed-1', '/v1/git/sealed-0', '/v1/git/sealed-1', '/v1/feishu/sealed-feishu', '/v1/tos/sealed-tos'])
  t.diagnostic(JSON.stringify({ task: collection.task_id, docs: collection.result.documents, digests }))
})

test('F5-W05 refused source shape, absent aliases and scoped capabilities make zero binding calls', async () => {
  log.length = 0
  const names = ['siteImport', 'htmlImport', 'feedImport', 'gitDocsCollectionImport', 'feishuArchiveImport', 'tosArchiveImport']
  for (const [actor, mounted] of [[reader, true], [outside, false], [root, false]]) {
    const result = await send(worker, '/system/edge-capabilities', { actor })
    assert.deepEqual(names.map(name => result.features[name]), names.map(() => mounted))
  }
  await add(worker, feed(origin + '/not-approved.xml'), { expected: 503, code: 'SOURCE_UNAVAILABLE' })
  await add(worker, { ...site, path: origin + '/unlisted.html' }, { expected: 503, code: 'SOURCE_UNAVAILABLE' })
  await add(worker, { path: origin + '/closed.html', args: { web_mode: 'html' } }, { actor: outside, expected: 501 })
  await add(worker, { ...git, path: files[0].collection }, { expected: 503, code: 'SOURCE_UNAVAILABLE' })
  await add(worker, { ...git, args: { web_mode: 'collection', ref: 'latest' } }, { expected: 400 })
  await add(worker, { ...archive('tos'), path: 'tos://fixture/unapproved' }, { expected: 400 })
  await add(worker, { ...archive('feishu'), args: { feishu_access_token: 'fixture-not-forwarded' } }, { expected: 400 })
  await add(worker, { ...archive('feishu'), to: undefined, parent: home }, { expected: 400 })
  assert.deepEqual(log, [])
})

test('F5-W06 malformed feed and wrong archive representation refuse without publication', async () => {
  for (const row of feeds.slice(2)) {
    await add(worker, feed(row.url), { expected: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
    await send(worker, readUri(`${home}/${row.name}`, '/fs/stat'), { expected: 404 })
  }
  await add(worker, { ...archive('tos', wrongArchive.alias), to: `${home}/wrong.txt` }, { expected: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
  await send(worker, readUri(`${home}/wrong.txt`, '/fs/stat'), { expected: 404 })
})
