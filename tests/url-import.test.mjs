// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const origin = 'https://documents.fixture.test'
const guide = origin + '/handbook/compass.md'
const catalog = origin + '/catalog.json'
const table = origin + '/table.csv'
const readme = origin + '/readme.txt'
const approve = { OPENVIKING_EDGE_TEXT_SOURCES: JSON.stringify([guide, catalog, table, readme]) }
const admin = testPrincipal('url-test', 'maintainer', 'admin')
const user = testPrincipal('url-test', 'reader')
const peer = testPrincipal('other-test', 'reader')
const root = testPrincipal('control', 'operator', 'root')
const content = '# Compass log\n\nTern harbor compass, synthetic entry.\n'
const markdown = body => new Response(body, { headers: { 'content-type': 'text/markdown; charset=UTF-8' } })
const hash = value => createHash('sha256').update(value).digest('hex')
const caps = '/system/edge-capabilities'
const byUri = (path, uri) => `${path}?uri=${encodeURIComponent(uri)}`
const taskPath = id => `/tasks/${id}`
const principals = [admin, user, peer, root]

let runtime, reply, outgoing = [], fallback = 0
const send = (path, options, principal = user, worker = runtime) => api(worker, principal)('/api/v1' + path, options)
const method = (path, verb, body, principal) => send(path, { method: verb, body }, principal)
const post = (path, body, principal) => method(path, 'POST', body, principal)
const add = (options = {}, principal, path = guide) => post('/resources', { path, ...options }, principal)

async function result(response, code = 200, error) {
  const json = await response.json()
  assert.equal(response.status, code, json.error?.code)
  assert.equal(json.status, code < 300 ? 'ok' : 'error')
  if (error) assert.equal(json.error?.code, error)
  return json.result
}

const binding = async request => {
  outgoing.push({ url: request.url, method: request.method,
    forbidden: ['authorization', 'cookie', 'x-api-key', 'x-openviking-account', 'x-fixture-client'].some(name => request.headers.has(name)) })
  if (reply) return reply(request)
  if (request.url === guide) return markdown(content)
  if (request.url === catalog) return Response.json({ topic: 'seabird atlas' })
  if (request.url === table) return new Response('name,count\ntern,2\n', { headers: { 'content-type': 'text/csv' } })
  if (request.url === readme) return new Response('Un balisage côtier.\n', { headers: { 'content-type': 'text/plain' } })
  throw new Error('No fixture registered for this request')
}

async function worker({ vars = approve, mounted = true, embeddings = 'fixture' } = {}) {
  const value = await localWorker({ principals, embeddings, vars, serviceBindings: mounted ? { TEXT_SOURCE: binding } : undefined,
    outboundService: async () => { fallback++; return new Response(null, { status: 503 }) } })
  await value.ready
  return value
}
before(async () => { runtime = await worker() })
after(async () => { try { assert.equal(fallback, 0, 'No test should reach the outbound transport') } finally { await runtime?.dispose() } })

test('URL capability is an actual boolean for data keys, false without mount, approved text URLs or embeddings', async () => {
  for (const [actor, expected] of [[user, true], [admin, true], [root, false]]) {
    const { features } = await result(await send(caps, undefined, actor))
    assert.equal(features.urlImport, expected)
  }
  await result(await send(caps, undefined, null), 401, 'UNAUTHENTICATED')
  await result(await add({}, root), 403)
  for (const [options, http, error] of [
    [{ mounted: false }, 501, 'NOT_IMPLEMENTED'],
    [{ vars: {} }, 501, 'NOT_IMPLEMENTED'],
    [{ vars: { OPENVIKING_EDGE_TEXT_SOURCES: JSON.stringify([origin + '/']) } }, 501, 'NOT_IMPLEMENTED'],
    [{ embeddings: 'missing' }, 503, 'EMBEDDING_UNAVAILABLE'],
  ]) {
    const inactive = await worker(options)
    const beforeCount = outgoing.length
    try {
      assert.equal((await result(await send(caps, undefined, user, inactive))).features.urlImport, false)
      await result(await send('/resources', { method: 'POST', body: { path: guide } }, user, inactive), http, error)
      assert.equal(outgoing.length, beforeCount)
    } finally { await inactive.dispose() }
  }
})

test('HTTP demo: approved URL -> inferred flat URI -> exact content -> indexed search', async t => {
  const beforeCount = outgoing.length
  const created = await result(await send('/resources', { method: 'POST', body: { path: guide, wait: true, args: { parse_mode: 'no_split' } },
    headers: { 'x-openviking-account': 'ignored', 'x-fixture-client': 'not propagated' } }, admin))
  const uri = 'viking://resources/compass.md'
  assert.equal(created.status, 'success')
  assert.equal(created.root_uri, uri)
  assert.equal(created.changed, true)
  assert.deepEqual(outgoing.slice(beforeCount), [{ url: guide, method: 'GET', forbidden: false }])
  const read = await result(await send(byUri('/content/read', uri)))
  assert.equal(read, content)
  const found = await result(await post('/search/find', { target_uri: 'viking://resources', query: 'tern harbor compass', limit: 2 }))
  assert.ok(found.resources.some(hit => hit.uri === uri))
  await result(await send(byUri('/content/read', uri), undefined, peer), 404)
  t.diagnostic(JSON.stringify({ worker_sha256: runtime.localBuildSha256, post: 200, root_uri: uri, read: 200,
    utf8_sha256: hash(read), find: 200, hit: uri, other_account_read: 404 }))
  const second = await result(await add({ parent: 'viking://resources/', processing_mode: 'vectors_only' }, admin))
  assert.equal(second.root_uri, 'viking://resources/compass_1.md')
  assert.match(second.warnings.join(' '), /Name already used/)
  assert.equal(await result(await send(byUri('/content/read', uri))), content)
})

test('existing to/to_uri/uri file remains a fenced replacement and keeps its ACL', async () => {
  const target = 'viking://resources/update.md'
  const spec = { uri: target, acl_mode: 'restricted', entries: [{ principal: 'user:reader', level: 'read' }] }
  assert.equal((await result(await add({ to: target }, admin))).root_uri, target)
  await result(await method('/acl', 'PUT', spec, admin))
  assert.equal((await result(await add({ to_uri: target }, admin))).changed, false)
  const updated = '# Revised compass notes\n'
  reply = () => markdown(updated)
  try { assert.equal((await result(await add({ uri: target }, admin))).changed, true) } finally { reply = undefined }
  assert.equal(await result(await send(byUri('/content/read', target))), updated)
  assert.equal((await result(await send(byUri('/acl', target), undefined, admin))).acl_mode, 'restricted')
  const calls = outgoing.length
  await result(await add({ to: target }), 403)
  assert.equal(outgoing.length, calls)
})

test('one-shot URL async import reserves its URI and publishes the private file, folders and task result', async t => {
  const started = Promise.withResolvers()
  const resume = Promise.withResolvers()
  const parent = 'viking://~/resources/new/records'
  const uri = 'viking://user/reader/resources/new/records/catalog.json'
  const prefix = 'viking://~/resources/new'
  reply = async () => { started.resolve(); await resume.promise; return Response.json({ topic: 'seabird atlas' }) }
  let accepted
  try {
    accepted = await result(await add({ parent, create_parent: true, wait: false, processing_mode: 'vectors_only' }, user, catalog))
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.root_uri, uri)
    await Promise.race([started.promise, delay(3500).then(() => assert.fail('task did not enter source I/O'))])
    const active = await result(await send(taskPath(accepted.task_id)))
    assert.equal(active.status, 'running')
    assert.equal(active.resource_id, uri)
    await result(await send(taskPath(accepted.task_id), undefined, admin), 404)
    await result(await send(byUri('/fs/stat', prefix)), 404)
    await result(await post('/fs/mkdir', { uri: prefix }), 409, 'RESOURCE_BUSY')
  } finally { resume.resolve(); reply = undefined }
  await result(await post('/system/wait', { timeout: 10 }))
  const task = await result(await send(taskPath(accepted.task_id)))
  assert.equal(task.status, 'completed')
  assert.equal(task.task_type, 'add_resource')
  assert.equal(task.result.root_uri, uri)
  const read = await result(await send(byUri('/content/read', uri)))
  assert.equal(read, '{"topic":"seabird atlas"}')
  const found = await result(await post('/search/find', { target_uri: parent, query: 'seabird atlas', limit: 2 }))
  assert.ok(found.resources.some(hit => hit.uri === uri))
  t.diagnostic(JSON.stringify({ post: 200, initial: 'accepted', intermediate: 'running', task_get: 200, terminal: 'completed',
    root_uri: uri, read: 200, utf8_sha256: hash(read), find: 200, hit: uri }))
})

test('approved CSV and UTF-8 text are read through the same facade; watch still only schedules', async () => {
  for (const [source, name, expected] of [[table, 'table.csv', 'name,count\ntern,2\n'], [readme, 'readme.txt', 'Un balisage côtier.\n']]) {
    const saved = await result(await add({}, admin, source))
    assert.equal(saved.root_uri, 'viking://resources/' + name)
    assert.equal(await result(await send(byUri('/content/read', saved.root_uri))), expected)
  }
  const calls = outgoing.length
  const dest = 'viking://resources/scheduled.md'
  const scheduled = await result(await add({ to: dest, watch_interval: 60 }, admin))
  assert.equal(scheduled.scheduled, true)
  assert.equal(outgoing.length, calls)
  await result(await send(byUri('/fs/stat', dest)), 404)
  await result(await method(`/watches/${scheduled.watch_task_id}`, 'DELETE', undefined, admin))
})

test('invalid URL, controls and destinations fail before reading the source', async () => {
  const calls = outgoing.length
  for (const [path, options, code] of [
    [origin + '/not-approved.md', {}, 503], [origin + '/', {}, 400], [origin + '/handbook/', {}, 400],
    ['http://documents.fixture.test/handbook/compass.md', {}, 400], [guide + '#heading', {}, 400],
    [guide + '?sample=one', {}, 400], [guide + '?', {}, 400],
    [origin + '/index.html', {}, 400], [guide, { headers: {} }, 400], [guide, { args: { site: true } }, 501],
    [guide, { to: 'viking://agent/skills/sample.md' }, 400], [guide, { to: 'viking://resources/folder/' }, 400],
    [guide, { parent: 'viking://user/someone/resources' }, 403], [guide, { parent: 'viking://~/resources/absent' }, 404],
    [guide, { parent: 'viking://resources', to: 'viking://resources/ambiguous.md' }, 400],
    [guide, { temp_file_id: 'synthetic-upload-id' }, 400],
  ]) await result(await add(options, user, path), code)
  const parent = 'viking://resources/closed'
  await result(await post('/fs/mkdir', { uri: parent }, admin))
  await result(await method('/acl', 'PUT', { uri: parent, acl_mode: 'restricted', entries: [] }, admin))
  await result(await add({ parent }, user), 403)
  assert.equal(outgoing.length, calls)
})

test('synthetic redirects, disallowed content and invalid bytes never leave a partial directory', async () => {
  const parent = 'viking://~/resources/rejected/new'
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(32_768).fill(65))
    controller.enqueue(new Uint8Array(32_769).fill(65))
    controller.close()
  } })
  for (const [fixture, code, error] of [
    [() => Response.redirect(origin + '/readme.txt'), 503, 'SOURCE_UNAVAILABLE'],
    [() => new Response('partial', { status: 206, headers: { 'content-type': 'text/plain' } }), 503, 'SOURCE_UNAVAILABLE'],
    [() => new Response('<p>not a text document</p>', { headers: { 'content-type': 'text/html' } }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [() => markdown(new Uint8Array([0xc3, 0x28])), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [() => markdown(''), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [() => markdown(stream), 413, 'RESOURCE_EXHAUSTED'],
  ]) {
    const calls = outgoing.length
    reply = fixture
    try { await result(await add({ parent, create_parent: true }), code, error) } finally { reply = undefined }
    assert.equal(outgoing.length, calls + 1, 'Just the approved request, no second fetch')
    await result(await send(byUri('/fs/stat', 'viking://~/resources/rejected')), 404)
  }
  reply = () => markdown('not JSON')
  try { await result(await add({ parent, create_parent: true }, user, catalog), 415) } finally { reply = undefined }
  await result(await send(byUri('/fs/stat', parent)), 404)
})

test('the total source deadline also stops a body that does not finish', { timeout: 13_000 }, async () => {
  let closeBody
  reply = () => markdown(new ReadableStream({ start(controller) {
    closeBody = () => { try { controller.close() } catch { /* already cancelled */ } }
    controller.enqueue(new TextEncoder().encode(content))
  } }))
  const target = 'viking://~/resources/slow.md'
  try { await result(await add({ to: target }), 504, 'DEADLINE_EXCEEDED') }
  finally { reply = undefined; closeBody?.() }
  await result(await send(byUri('/fs/stat', target)), 404)
})

test('cancellation and rotated credentials fence real jobs during source I/O', async () => {
  const account = '/admin/accounts/url-rotation'
  const { user_key: ownerKey } = await result(await post('/admin/accounts', { account_id: 'url-rotation', admin_user_id: 'owner' }, root))
  const owner = { key: ownerKey }
  const { user_key: memberKey } = await result(await post(account + '/users', { user_id: 'editor' }, owner))
  const editor = { key: memberKey }
  for (const mode of ['cancel', 'rotate']) {
    const started = Promise.withResolvers(), resume = Promise.withResolvers()
    const to = `viking://~/resources/${mode}.md`
    reply = async () => { started.resolve(); await resume.promise; return markdown(content) }
    let submitted, reader = editor
    try {
      submitted = await result(await add({ to, wait: false }, editor))
      await Promise.race([started.promise, delay(3500).then(() => assert.fail('task did not enter source I/O'))])
      if (mode === 'cancel') await result(await post(taskPath(submitted.task_id) + '/cancel', {}, editor))
      else {
        const { user_key: key } = await result(await post(account + '/users/editor/key', {}, editor))
        reader = { key }
        await result(await send(caps, undefined, editor), 401)
      }
    } finally { resume.resolve(); reply = undefined }
    await result(await post('/system/wait', { timeout: 10 }, reader))
    const terminal = await result(await send(taskPath(submitted.task_id), undefined, reader))
    assert.equal(terminal.status, mode === 'cancel' ? 'cancelled' : 'failed')
    await result(await send(byUri('/fs/stat', to), undefined, reader), 404)
  }
})
