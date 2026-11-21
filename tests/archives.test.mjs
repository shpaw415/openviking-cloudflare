// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FormData } from 'miniflare'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'
import './archives/metadata.test.mjs'
import './archives/dav-preconditions.test.mjs'
import './archives/backup-scope.test.mjs'
import './archives/cli-defaults.test.mjs'

const root = 'viking://resources/notes'
const file = `${root}/guide.md`
const paths = (route, query) => `/api/v1/snapshot/${route}?${new URLSearchParams(query)}`
const command = (send, route, body) => send(`/api/v1/snapshot/${route}`, { method: 'POST', body })
const write = (send, uri, content, mode = 'create') => send('/api/v1/content/write', {
  method: 'POST', body: { uri, content, mode, wait: true },
})
const read = (send, uri) => send(`/api/v1/content/read?${new URLSearchParams({ uri })}`)
const mkdir = (send, uri) => send('/api/v1/fs/mkdir', { method: 'POST', body: { uri } })
const remove = (send, uri) => send(`/api/v1/fs?${new URLSearchParams({ uri, recursive: true })}`, { method: 'DELETE' })

async function result(response, expected = 200) {
  const raw = await response.text()
  assert.equal(response.status, expected, raw)
  const envelope = JSON.parse(raw)
  assert.equal(envelope.status, expected < 400 ? 'ok' : 'error')
  return envelope.result ?? envelope.error
}

async function workspace(t, embeddings = 'fixture') {
  const admin = testPrincipal('archive-fixture', 'owner', 'admin')
  const reader = testPrincipal('archive-fixture', 'reader')
  const foreign = testPrincipal('other-fixture', 'owner', 'admin')
  const agent = testPrincipal('archive-fixture', 'owner', 'admin', 'another-agent')
  const runtime = await localWorker({ principals: [admin, reader, foreign, agent], embeddings })
  t.after(() => runtime.dispose())
  const client = principal => {
    const send = api(runtime, principal)
    return (path, options) => options?.body instanceof FormData
      ? runtime.dispatchFetch(new URL(path, 'http://localhost'), { ...options, headers: { 'x-api-key': principal.key } })
      : send(path, options)
  }
  return { admin: client(admin), reader: client(reader), foreign: client(foreign), agent: client(agent), anon: api(runtime) }
}

test('snapshot captures a subtree immutably and keeps earlier snapshots on scoped commits', async t => {
  const { admin, reader, foreign } = await workspace(t)
  const outside = 'viking://resources/outside.md'
  await result(await admin('/api/v1/fs/mkdir', { method: 'POST', body: { uri: root } }))
  await result(await write(admin, file, '# Title\n\nold line\n'))
  await result(await write(admin, outside, 'outside v1\n'))
  const first = await result(await command(admin, 'commit', { message: 'v1', paths: ['viking://resources'] }))
  assert.equal(first.result, 'created')
  assert.match(first.commit_oid, /^[a-f0-9]{40}$/)
  assert.equal(first.changed, 2)
  await result(await write(admin, file, '# Title\n\nnew line', 'replace'))
  await result(await write(admin, outside, 'outside live only\n', 'replace'))
  const second = await result(await command(admin, 'commit', { message: 'v2', paths: [root] }))
  assert.equal(second.changed, 1)
  const old = await reader(paths('show', { target_ref: first.commit_oid, path: file }))
  assert.equal(old.status, 200)
  assert.match(old.headers.get('content-type'), /^application\/octet-stream/)
  assert.equal(old.headers.get('x-snapshot-commit-oid'), first.commit_oid)
  assert.equal(old.headers.get('x-snapshot-size'), '18')
  assert.equal(await old.text(), '# Title\n\nold line\n')
  assert.equal(await (await admin(paths('show', { target_ref: 'main', path: outside }))).text(), 'outside v1\n')
  const history = await result(await reader(paths('log', { paths: root })))
  assert.deepEqual(history.map(v => v.oid), [second.commit_oid, first.commit_oid])
  assert.deepEqual(history[0].parents, [first.commit_oid])
  assert.equal(history[1].committer.time_seconds, Number(old.headers.get('x-snapshot-time-seconds')))
  const diff = await result(await reader(paths('diff', { path: file, from: first.commit_oid, to: second.commit_oid })))
  assert.equal(diff.change_type, 'modified')
  assert.match(diff.diff_text, /-old line\n\+new line\n\\ No newline at end of file/)
  const page = await result(await reader(paths('diff-paths', {
    paths: 'viking://resources', from: first.commit_oid, to: second.commit_oid, limit: 1,
  })))
  assert.deepEqual(page.changes, [{ uri: file, change_type: 'modified' }])
  assert.equal(page.has_more, false)
  assert.equal((await foreign(paths('show', { target_ref: first.commit_oid, path: file }))).status, 404)
  assert.equal((await reader(paths('show', { target_ref: first.commit_oid }))).status, 403)
})

test('snapshot restore plans without mutation then advances HEAD and updates indexed files', async t => {
  const { admin } = await workspace(t)
  const extra = `${root}/new.md`, untracked = `${root}/unsaved.md`
  await result(await mkdir(admin, root))
  await result(await write(admin, file, 'sailing harbor compass'))
  const snap = message => command(admin, 'commit', { message, paths: [root] }).then(result)
  const first = await snap('v1')
  await result(await write(admin, file, 'v2 land mountain', 'replace'))
  await result(await write(admin, extra, 'orange kumquat only'))
  const second = await snap('v2')
  await result(await write(admin, untracked, 'not in either snapshot'))
  const input = { project_dir: root, source_commit: first.commit_oid }
  const preview = await result(await command(admin, 'restore', { ...input, dry_run: true }))
  assert.equal(preview.result, 'dry_run')
  assert.deepEqual(preview.diff.to_write.map(item => item.path), ['guide.md'])
  assert.deepEqual(preview.diff.to_delete, ['new.md'])
  assert.equal(await result(await read(admin, file)), 'v2 land mountain')
  const applied = await result(await command(admin, 'restore', input))
  assert.equal(applied.result, 'applied')
  assert.equal(applied.parent_commit, second.commit_oid)
  assert.notEqual(applied.new_commit_oid, first.commit_oid)
  assert.equal(await result(await read(admin, file)), 'sailing harbor compass')
  assert.equal((await read(admin, extra)).status, 404)
  assert.equal(await result(await read(admin, untracked)), 'not in either snapshot')
  const history = await result(await admin(paths('log', { paths: root })))
  assert.deepEqual(history[0].parents, [second.commit_oid])
  const found = await result(await admin('/api/v1/search/find', { method: 'POST', body: { query: 'boats harbor compass', target_uri: root } }))
  assert.equal(found.resources[0].uri, file)
  assert.ok(found.resources.every(hit => hit.uri !== extra))
  const gone = await result(await admin(paths('show', { target_ref: 'main', path: extra })), 404)
  assert.deepEqual(gone.details, { type: 'git_blob', resource: extra, reason: 'path_not_found', deleted_file: true })
})

test('snapshot versions paginate and a stale single-file restore leaves unsaved bytes alone', async t => {
  const { admin } = await workspace(t)
  await result(await mkdir(admin, root))
  await result(await write(admin, file, 'first'))
  const first = await result(await command(admin, 'commit', { message: 'first', paths: [file] }))
  await result(await write(admin, file, 'second', 'replace'))
  const second = await result(await command(admin, 'commit', { message: 'second', paths: [file] }))
  const versionPage = await result(await admin(paths('versions', { uri: file, limit: 1 })))
  assert.deepEqual(Object.keys(versionPage).sort(), ['next_before_snapshot', 'uri', 'versions'])
  assert.equal(versionPage.next_before_snapshot, second.commit_oid)
  const previous = await result(await admin(paths('versions', { uri: file, limit: 1, before_snapshot: versionPage.next_before_snapshot })))
  assert.equal(previous.versions[0].oid, first.commit_oid)
  assert.equal(previous.next_before_snapshot, null)
  await result(await write(admin, file, 'unsaved edit', 'replace'))
  const payload = { path: file, restore_commit_id: first.commit_oid }
  const stale = await result(await command(admin, 'restore', { ...payload, current_commit_id: second.commit_oid }), 409)
  assert.equal(stale.details.resource, 'VERSION_CONFLICT')
  assert.equal(await result(await read(admin, file)), 'unsaved edit')
  const dry = await result(await command(admin, 'restore', { ...payload, dry_run: true }))
  assert.deepEqual(dry, { uri: file, snapshot_id: null, result: 'dry_run' })
  const applied = await result(await command(admin, 'restore', payload))
  assert.equal(applied.result, 'created')
  assert.match(applied.snapshot_id, /^[a-f\d]{40}$/)
  assert.equal(await result(await read(admin, file)), 'first')
})

test('ignore rules are account-local and omit currently matched paths in scoped commits', async t => {
  const { admin, reader, foreign } = await workspace(t)
  const ignore = '/api/v1/snapshot/ignore'
  const ignored = `${root}/private/notes.txt`
  await result(await mkdir(admin, root))
  await result(await mkdir(admin, `${root}/private`))
  await result(await write(admin, ignored, 'keep live'))
  await result(await write(admin, file, 'track me'))
  const before = await result(await command(admin, 'commit', { message: 'track both', paths: [root] }))
  const rules = '/resources/**/private/\n# document intent\n'
  await result(await admin(ignore, { method: 'PUT', body: { content: rules } }))
  assert.equal(await result(await admin(ignore)), rules)
  assert.equal(await result(await foreign(ignore)), '')
  assert.equal((await reader(ignore)).status, 403)
  const after = await result(await command(admin, 'commit', { message: 'apply ignore', paths: [root] }))
  assert.equal(after.ignored, 1)
  assert.equal(after.changed, 1)
  assert.equal((await admin(paths('show', { target_ref: after.commit_oid, path: ignored }))).status, 404)
  assert.equal(await (await admin(paths('show', { target_ref: before.commit_oid, path: ignored }))).text(), 'keep live')
  assert.equal(await result(await read(admin, ignored)), 'keep live')
  await result(await admin(ignore, { method: 'DELETE' }))
  assert.equal(await result(await admin(ignore)), '')
})

test('snapshot reads respect current ACL and never assign historical bytes to a new resource identity', async t => {
  const { admin, reader } = await workspace(t)
  await result(await mkdir(admin, root))
  await result(await write(admin, file, 'public draft'))
  const { commit_oid } = await result(await command(admin, 'commit', { message: 'before ACL', paths: [root] }))
  const show = paths('show', { target_ref: commit_oid, path: file })
  assert.equal((await reader(show)).status, 200)
  await result(await admin('/api/v1/acl', { method: 'PUT', body: { uri: file, acl_mode: 'restricted', entries: [] } }))
  assert.equal((await reader(show)).status, 403)
  assert.equal((await command(reader, 'commit', { message: 'reader', paths: [root] })).status, 403)
  assert.equal((await packCommand(reader, 'export', { uri: root })).status, 403)
  const props = await reader('/webdav/resources/notes', { method: 'PROPFIND' })
  assert.equal(props.status, 207)
  assert.doesNotMatch(await props.text(), /guide\.md/)
  await result(await remove(admin, file))
  await result(await write(admin, file, 'new public resource'))
  assert.equal(await result(await read(reader, file)), 'new public resource')
  assert.equal((await reader(show)).status, 403)
  assert.equal(await (await admin(show)).text(), 'public draft')
})

test('snapshot survives a workerd restart and provider failure leaves HEAD, files and deletions unchanged', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'ov-archive-test-'))
  const principal = testPrincipal('archive-persist', 'owner', 'admin')
  let local = await localWorker({ principals: [principal], embeddings: 'fixture', persist: cache })
  t.after(async () => { await local.dispose(); await rm(cache, { recursive: true, force: true }) })
  const user = api(local, principal), extra = `${root}/extra.md`
  await result(await mkdir(user, root))
  await result(await write(user, file, 'first'))
  const first = await result(await command(user, 'commit', { message: 'first', paths: [root] }))
  await result(await write(user, file, 'second', 'replace'))
  await result(await write(user, extra, 'retain if restore fails'))
  const second = await result(await command(user, 'commit', { message: 'second', paths: [root] }))
  await local.dispose()
  local = await localWorker({ principals: [principal], embeddings: 'missing', persist: cache })
  const reopened = api(local, principal)
  assert.equal(await (await reopened(paths('show', { path: file, target_ref: first.commit_oid }))).text(), 'first')
  const payload = { project_dir: root, source_commit: first.commit_oid }
  assert.equal((await result(await command(reopened, 'restore', { ...payload, dry_run: true }))).result, 'dry_run')
  assert.equal((await result(await command(reopened, 'restore', payload), 503)).code, 'EMBEDDING_UNAVAILABLE')
  assert.equal(await result(await read(reopened, file)), 'second')
  assert.equal(await result(await read(reopened, extra)), 'retain if restore fails')
  assert.equal((await result(await reopened(paths('log', { paths: root }))))[0].oid, second.commit_oid)
})

test('snapshot refs stay within the selected user or agent mount and support raw memory reads', async t => {
  const { admin, agent, reader } = await workspace(t)
  const uri = 'viking://agent/notes.md'
  const footer = 'Visible\n\n<!-- MEMORY_FIELDS\n{"version":2}\n-->'
  await result(await write(admin, uri, footer))
  const revision = await result(await command(admin, 'commit', { message: 'agent draft', paths: [uri], branch: 'drafts' }))
  const byRef = paths('show', { path: uri, target_ref: revision.commit_oid })
  assert.equal(await (await admin(byRef)).text(), footer)
  assert.equal(await (await admin(paths('show', { path: uri, target_ref: 'drafts', raw: 'false' }))).text(), 'Visible')
  assert.equal((await agent(byRef)).status, 404)
  assert.equal((await reader(byRef)).status, 404)
  assert.equal((await admin(paths('show', { path: file, target_ref: revision.commit_oid }))).status, 404)
  assert.equal((await command(admin, 'commit', { message: 'mixed', paths: [uri, file] })).status, 400)
})

test('WebDAV authenticates every method and uses the live resource mount', async t => {
  const { admin, reader, foreign, anon } = await workspace(t)
  const dav = '/webdav/resources', space = `${dav}/notes`
  for (const method of ['OPTIONS', 'PROPFIND', 'GET', 'HEAD', 'PUT', 'COPY']) {
    assert.equal((await anon(dav, { method })).status, 401)
  }
  const options = await admin(dav, { method: 'OPTIONS' })
  assert.equal(options.status, 204)
  assert.equal(options.headers.get('dav'), '1')
  assert.match(options.headers.get('allow'), /\bCOPY\b/)
  assert.equal((await admin(space, { method: 'MKCOL' })).status, 201)
  assert.equal((await admin(`${space}/.obsidian`, { method: 'MKCOL' })).status, 201)
  const plain = '# Notes\nCafé\n'
  assert.equal((await admin(`${space}/guide.md`, { method: 'PUT', body: plain })).status, 201)
  assert.equal(await result(await read(admin, file)), plain)
  // Content-Length describes the chosen HTTP representation; disable compression for this assertion.
  const headers = { 'Accept-Encoding': 'identity' }
  const found = await reader(`${space}/guide.md`, { headers })
  assert.equal(found.status, 200)
  assert.equal(found.headers.get('content-length'), String(Buffer.byteLength(plain)))
  assert.equal(await found.text(), plain)
  const head = await reader(`${space}/guide.md`, { method: 'HEAD', headers })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(plain)))
  assert.equal(await head.text(), '')
  assert.equal((await reader(`${space}/guide.md`, { method: 'PUT', body: 'unauthorized' })).status, 403)
  assert.equal((await foreign(`${space}/guide.md`)).status, 404)
  const properties = await reader(space, { method: 'PROPFIND', headers: { Depth: '1' } })
  assert.equal(properties.status, 207)
  const xml = await properties.text()
  assert.match(xml, /<d:displayname>\.obsidian<\/d:displayname>/)
  assert.match(xml, /<d:href>\/webdav\/resources\/notes\/guide\.md<\/d:href>/)
  assert.doesNotMatch(xml, /\.abstract\.md|\.relations\.json/)
  assert.equal((await reader(`${space}/.abstract.md`)).status, 404)
  const copy = `${space}/copy.md`
  assert.equal((await admin(`${space}/guide.md`, { method: 'COPY', headers: { Destination: copy } })).status, 201)
  assert.equal((await admin(`${space}/guide.md`, { method: 'COPY', headers: { Destination: copy, Overwrite: 'F' } })).status, 412)
  assert.equal((await admin(copy, { method: 'MOVE', headers: { Destination: `${space}/moved.md` } })).status, 201)
  assert.equal((await admin(copy)).status, 404)
  assert.equal(await (await admin(`${space}/moved.md`)).text(), plain)
  assert.equal((await admin(`${space}/moved.md`, { method: 'DELETE' })).status, 204)
  assert.equal((await admin(`${space}/moved.md`)).status, 404)
})

test('WebDAV selects properties and honors file preconditions', async t => {
  const { admin } = await workspace(t)
  await result(await mkdir(admin, root))
  const path = '/webdav/resources/notes/guide.md'
  assert.equal((await admin(path, { method: 'PUT', body: 'old', headers: { 'If-None-Match': '*' } })).status, 201)
  const tag = (await admin(path, { method: 'HEAD' })).headers.get('etag')
  assert.ok(tag)
  assert.equal((await admin(path, { headers: { 'If-None-Match': tag } })).status, 304)
  assert.equal((await admin(path, { method: 'PUT', body: 'not permitted', headers: { 'If-None-Match': '*' } })).status, 412)
  const properties = await admin(path, { method: 'PROPFIND', headers: { Depth: '0', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:missing/></D:prop></D:propfind>' })
  assert.equal(properties.status, 207)
  assert.match(await properties.text(), /<d:getetag>&quot;.+?&quot;<\/d:getetag>.*<d:missing\/>.*404 Not Found/)
  assert.equal((await admin(path, { method: 'PUT', body: 'new', headers: { 'If-Match': tag } })).status, 204)
  assert.equal((await admin(path, { method: 'DELETE', headers: { 'If-Match': tag } })).status, 412)
  assert.equal(await result(await read(admin, file)), 'new')
})

const packCommand = (send, operation, body) => send(`/api/v1/pack/${operation}`, { method: 'POST', body })

function fixture(mode, input) {
  const path = fileURLToPath(new URL('./archives/ovpack_fixture.py', import.meta.url))
  const proc = spawnSync('python3', ['-I', '-B', path, mode], { input, timeout: 4000, maxBuffer: 512 * 1024 })
  assert.ifError(proc.error)
  assert.equal(proc.status, 0, proc.stderr.toString())
  return proc.stdout
}

async function stage(send, bytes) {
  const form = new FormData()
  form.set('file', new File([bytes], 'notes.ovpack', { type: 'application/zip' }))
  return (await result(await packCommand(send, 'temp_upload', form))).temp_file_id
}

test('ovpack v3 exports a native ZIP and imports an independent deflated v3 package', async t => {
  const { admin, reader, foreign, agent } = await workspace(t)
  const destination = 'viking://resources/inbox'
  await result(await mkdir(admin, root))
  await result(await mkdir(admin, destination))
  await result(await mkdir(admin, `${root}/empty`))
  await result(await write(admin, file, '# café\n'))
  const exportResponse = await packCommand(reader, 'export', { uri: root })
  assert.equal(exportResponse.status, 200)
  assert.equal(exportResponse.headers.get('content-type'), 'application/zip')
  assert.match(exportResponse.headers.get('content-disposition'), /attachment; filename="notes\.ovpack"/)
  const structure = JSON.parse(fixture('inspect', Buffer.from(await exportResponse.arrayBuffer())))
  assert.deepEqual(structure, { files: { 'guide.md': '# café\n' }, directories: ['', 'empty'] })
  const id = await stage(admin, fixture('create'))
  const request = { parent: destination, temp_file_id: id, vector_mode: 'recompute' }
  assert.equal((await packCommand(foreign, 'import', request)).status, 404)
  assert.equal((await packCommand(reader, 'import', request)).status, 404)
  assert.equal((await packCommand(agent, 'import', request)).status, 404)
  const imported = await result(await packCommand(admin, 'import', request))
  assert.equal(imported.uri, `${destination}/notes`)
  assert.equal(await result(await read(admin, `${imported.uri}/chapitre/café.md`)), 'texte marin\n')
  assert.equal((await packCommand(admin, 'import', request)).status, 404)
})

test('ovpack verifies digests before skip and overwrites the allowed subtree without leaving old resources', async t => {
  const { admin } = await workspace(t)
  const parent = 'viking://resources/inbox', destination = `${parent}/notes`
  await result(await mkdir(admin, parent))
  await result(await mkdir(admin, destination))
  const old = `${destination}/old.md`
  await result(await write(admin, old, 'old content'))
  const input = { parent, temp_file_id: await stage(admin, fixture('corrupt')), on_conflict: 'skip' }
  assert.equal((await result(await packCommand(admin, 'import', input), 400)).code, 'INVALID_ARGUMENT')
  assert.equal(await result(await read(admin, old)), 'old content')
  const good = { parent, temp_file_id: await stage(admin, fixture('create')) }
  await result(await packCommand(admin, 'import', good), 409)
  assert.equal((await result(await packCommand(admin, 'import', { ...good, on_conflict: 'skip' }))).uri, destination)
  assert.equal(await result(await read(admin, old)), 'old content')
  const replace = { ...good, temp_file_id: await stage(admin, fixture('create')), on_conflict: 'overwrite' }
  assert.equal((await result(await packCommand(admin, 'import', replace))).uri, destination)
  assert.equal((await read(admin, old)).status, 404)
  assert.equal(await result(await read(admin, `${destination}/chapitre/café.md`)), 'texte marin\n')
})
