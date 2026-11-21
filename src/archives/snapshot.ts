// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, ok, readJson } from '../http.js'
import { spaces, type FsPath } from '../fs/contract.js'
import { authorizeHistoricalRead, captureSubtree, subtreeRevision, type Filesystem, type SubtreeCapture } from '../filesystem.js'
import {
  ArchiveError, allowed, attachment, encoder, fields, flag, forbidden, internal, invalid, leaf, notFound,
  numberParam, param, RESOURCES, sidecar, text, under, conflict, quota,
} from './common.js'
import { compileIgnore } from './ignore.js'
import { routeRestore } from './restore.js'
import {
  branchName, identifyBlob, SHA40, SNAPSHOT_BYTES, SNAPSHOT_FILES, SnapshotStore, wireRevision,
  type FileRef, type HistoryGuard, type Revision,
} from './snapshot-store.js'
import { changeType, unified, withoutMemoryFields } from './text-diff.js'

const IGNORE_LIMIT = 64 * 1024
const BODY_LIMIT = 64 * 1024
const MAX_PATHS = 32

export function scope(fs: Filesystem, value: unknown): FsPath & { space: string } {
  const path = fs.path(value)
  if (!path.space || path.managed || path.parts.some(internal)) return invalid('An explicit, unmanaged snapshot path is required.')
  return path as FsPath & { space: string }
}

// Edge has no data-plane ROOT. Defaults for a tenant admin are deliberately
// confined to the existing shared mount; never enumerate or infer private mounts.
export function defaultSnapshotScope(fs: Filesystem, message: string): FsPath & { space: string } {
  if (fs.caller.role !== 'admin') return forbidden(message)
  const path = scope(fs, RESOURCES)
  fs.check(path.uri, 'read')
  return path
}

function scopes(fs: Filesystem, given: unknown[], emptyAllowed = false) {
  if (!emptyAllowed && !given.length) return forbidden('Snapshot operation requires explicit paths.')
  if (given.length > MAX_PATHS) return invalid(`Provide at most ${MAX_PATHS} snapshot paths.`)
  const paths = given.map(value => scope(fs, value))
  const space = paths[0]?.space ?? spaces(fs.caller)[1]
  if (paths.some(path => path.space !== space)) invalid('Snapshot paths must share a filesystem mount.')
  const roots: string[] = []
  for (const uri of paths.map(path => path.uri).sort()) {
    if (!roots.some(root => under(uri, root))) roots.push(uri)
  }
  const selected = (uri: string) => roots.some(root => under(uri, root))
  return { roots, selected, store: new SnapshotStore(fs.ctx, space) }
}

export function historicalRead(fs: Filesystem, uri: string, ...refs: Array<FileRef | undefined>): void {
  const path = scope(fs, uri)
  fs.check(path.uri, 'read')
  if (path.space !== 'shared' || fs.caller.role === 'admin') return
  for (const ref of refs) if (ref) {
    authorizeHistoricalRead(fs, { version: 1, root_uri: path.uri, revision: '',
      entries: [{ uri: path.uri, path: '', is_dir: false, bytes: ref[2], node_id: ref[3].node_id, revision: '', description: '', tags: [] }],
      guard: { account_id: fs.account, space: path.space, entries: [ref[3]] } })
  }
}

export function guardFor(capture: SubtreeCapture, index: number): HistoryGuard {
  return { ...capture.guard.entries[index], path: '' }
}

export function captureAt(fs: Filesystem, uri: string, includeContent = true): SubtreeCapture | undefined {
  const capture = captureSubtree(fs, uri, { allowMissing: true, includeContent })
  if (capture.revision === null) return undefined
  for (const entry of capture.entries) fs.check(entry.uri, 'read')
  return capture
}

export function commitAuthor(body: Record<string, unknown>) {
  return [text(body.author_name ?? 'viking-bot', 'author_name', 160),
    text(body.author_email ?? 'bot@openviking.local', 'author_email', 256)] as const
}

export function fullOid(value: unknown, field: string): string {
  const id = text(value, field, 40)
  return SHA40.test(id) ? id : invalid(`${field} must be a full snapshot ID.`)
}

function ignoreSource(fs: Filesystem): string {
  return fs.ctx.sql.exec<{ content: string }>('SELECT content FROM ov_edge_snapshot_ignore WHERE account=?', fs.account).toArray()[0]?.content ?? ''
}

async function ignoreRoute(request: Request, fs: Filesystem): Promise<Response> {
  allowed(request, 'GET', 'PUT', 'DELETE')
  if (fs.caller.role !== 'admin') forbidden('Managing snapshot ignore requires an administrator.')
  if (request.method === 'GET' || request.method === 'HEAD') return ok(ignoreSource(fs))
  if (request.method === 'DELETE') {
    fs.ctx.sql.exec('DELETE FROM ov_edge_snapshot_ignore WHERE account=?', fs.account)
  } else {
    const body = await readJson(request, IGNORE_LIMIT * 6 + 1024)
    fields(body, 'content')
    const content = text(body.content, 'content', IGNORE_LIMIT)
    if (encoder.encode(content).byteLength > IGNORE_LIMIT) invalid('Snapshot ignore file exceeds 64 KiB.')
    await fs.ctx.reauthorize?.()
    fs.ctx.sql.exec(`INSERT INTO ov_edge_snapshot_ignore (account,content) VALUES (?,?)
      ON CONFLICT(account) DO UPDATE SET content=excluded.content`, fs.account, content)
  }
  return ok(null)
}

async function commit(request: Request, fs: Filesystem): Promise<Response> {
  const body = await readJson(request, BODY_LIMIT)
  fields(body, 'message paths branch author_name author_email')
  const message = text(body.message, 'message')
  const branch = branchName(text(body.branch ?? 'main', 'branch', 80))
  const author = commitAuthor(body)
  const paths = body.paths ?? [defaultSnapshotScope(fs, 'Snapshot commit requires explicit paths.').uri]
  if (!Array.isArray(paths)) return invalid('paths must be an array.')
  const { roots, selected, store } = scopes(fs, paths, true)
  const head = store.head(branch)
  const previous = store.files(head)
  const rules = ignoreSource(fs), ignored = compileIgnore(rules)
  const captures = new Map<string, SubtreeCapture | undefined>()
  const live: { uri: string; body: string; guard: HistoryGuard }[] = []
  let length = 0, nodes = 0
  for (const root of roots) {
    const capture = captureAt(fs, root)
    captures.set(root, capture)
    if (!capture) continue
    for (const [i, entry] of capture.entries.entries()) {
      if (++nodes > 512) quota('Snapshot selection exceeds 512 nodes.')
      if (entry.is_dir) continue
      const uri = entry.uri, path = fs.path(uri)
      if (path.managed || path.parts.some(internal)) continue
      const body = entry.content!
      length += encoder.encode(body).byteLength
      if (length > SNAPSHOT_BYTES) quota('Snapshot selection exceeds the byte limit.')
      live.push({ uri, body, guard: guardFor(capture, i) })
    }
  }
  let excluded = 0
  const files = new Map(previous)
  for (const [uri, prior] of previous) if (selected(uri)) {
    historicalRead(fs, uri, prior)
    files.delete(uri)
  }
  const selectedEntries = live.filter(entry => {
    if (ignored(entry.uri)) { excluded++; return false }
    return true
  })
  if (files.size + selectedEntries.length > SNAPSHOT_FILES) quota('Snapshot selection exceeds the file limit.')
  const blobs = await Promise.all(selectedEntries.map(async entry => {
    const blob = await identifyBlob(entry.body)
    return { ref: [entry.uri, blob.key, blob.bytes, entry.guard] satisfies FileRef, blob }
  }))
  for (const { ref } of blobs) files.set(ref[0], ref)
  const next = await store.prepare(files, previous, head, message, ...author)
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => {
    store.assertHead(branch, head)
    if (rules !== ignoreSource(fs)) conflict('Snapshot ignore rules changed while capturing.')
    for (const [root, saved] of captures) {
      if (subtreeRevision(fs, root) !== (saved?.revision ?? null)) conflict('Filesystem changed while capturing the snapshot.')
      for (const entry of saved?.entries ?? []) fs.check(entry.uri, 'read')
    }
    for (const [uri, prior] of previous) if (selected(uri)) historicalRead(fs, uri, prior)
    // Do not expose a branch ref through an unrelated restricted no-op.
    if (!next.changes.length && head && !canReadRevisionMetadata(fs, store, head)) {
      forbidden('The current snapshot metadata is not visible.')
    }
    if (!next.changes.length && head) return ok({ result: 'noop', commit_oid: head.oid, ignored: excluded })
    store.publish(branch, head, next, blobs.map(item => item.blob))
    return ok({ result: 'created', commit_oid: next.oid, changed: next.changes.length, ignored: excluded })
  })
}

function show(fs: Filesystem, query: URLSearchParams, headOnly: boolean): Response {
  const value = param(query, 'path')
  if (value === undefined) {
    const { space } = defaultSnapshotScope(fs, 'Snapshot show requires an explicit path.')
    const store = new SnapshotStore(fs.ctx, space)
    const selected = store.resolve(text(param(query, 'target_ref'), 'target_ref', 80))
    if (!canReadRevisionMetadata(fs, store, selected)) forbidden('The snapshot metadata is not visible.')
    return ok(publicRevision(fs, store, selected))
  }
  const path = scope(fs, value)
  const store = new SnapshotStore(fs.ctx, path.space)
  const raw = flag(query, 'raw', true)
  historicalRead(fs, path.uri)
  const selected = store.resolve(text(param(query, 'target_ref'), 'target_ref', 80))
  const ref = store.files(selected).get(path.uri)
  if (!ref) {
    const parent = selected.parent_oid ? store.files(store.at(selected.parent_oid)).get(path.uri) : undefined
    historicalRead(fs, path.uri, parent)
    throw new ArchiveError(404, 'NOT_FOUND', 'Snapshot file not found.',
      { type: 'git_blob', resource: path.uri, reason: 'path_not_found', deleted_file: !!parent })
  }
  historicalRead(fs, path.uri, ref)
  const blob = store.blob(ref)
  const data = encoder.encode(raw ? blob.body : withoutMemoryFields(blob.body))
  const revealRevision = canReadRevisionMetadata(fs, store, selected)
  return new Response(headOnly ? null : data, { headers: {
    'content-type': 'application/octet-stream', 'content-disposition': attachment(leaf(path.uri)),
    'x-snapshot-oid': blob.oid, 'x-snapshot-size': String(data.byteLength),
    ...(revealRevision && { 'x-snapshot-commit-oid': selected.oid, 'x-snapshot-time-seconds': String(selected.time_seconds) }),
  } })
}

function baseAndHead(store: SnapshotStore, query: URLSearchParams) {
  const to = store.resolve(text(param(query, 'to'), 'to', 80))
  const from = param(query, 'from')
  const before = from === undefined ? undefined : store.resolve(text(from, 'from', 80))
  return { before, to, older: store.files(before), newer: store.files(to) }
}

function diff(fs: Filesystem, query: URLSearchParams): Response {
  const path = scope(fs, param(query, 'path'))
  const store = new SnapshotStore(fs.ctx, path.space)
  const raw = flag(query, 'raw', true)
  historicalRead(fs, path.uri)
  const { before, to, older, newer } = baseAndHead(store, query)
  const a = older.get(path.uri), b = newer.get(path.uri)
  historicalRead(fs, path.uri, a, b)
  const content = (ref: FileRef | undefined) => {
    if (!ref) return undefined
    const body = store.blob(ref).body
    return raw ? body : withoutMemoryFields(body)
  }
  const old = content(a), fresh = content(b)
  // No base was requested is distinct from a base whose metadata is unreadable.
  return ok({ path: path.uri, from_commit: before ? visibleRevisionId(fs, store, before) : '',
    to_commit: visibleRevisionId(fs, store, to),
    change_type: changeType(old, fresh), diff_text: old === fresh ? '' : unified(path.uri, old, fresh) })
}

function diffPaths(fs: Filesystem, query: URLSearchParams): Response {
  const { store, roots, selected } = scopes(fs, query.getAll('paths'))
  const offset = numberParam(query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
  const limit = numberParam(query, 'limit', 100, 1, 1000)
  for (const root of roots) historicalRead(fs, root)
  const { older, newer } = baseAndHead(store, query)
  const changes = []
  for (const uri of Array.from(new Set([...older.keys(), ...newer.keys()])).sort()) {
    if (!selected(uri) || sidecar(leaf(uri))) continue
    const a = older.get(uri), b = newer.get(uri), change_type = changeType(a?.[1], b?.[1])
    if (change_type === 'unchanged') continue
    historicalRead(fs, uri, a, b)
    changes.push({ uri, change_type })
  }
  const hasMore = offset + limit < changes.length
  return ok({ changes: changes.slice(offset, offset + limit), offset, limit, total: changes.length,
    has_more: hasMore, next_offset: hasMore ? offset + limit : null })
}

export function fileChanges(row: Revision): string[] { return JSON.parse(row.changes) as string[] }

function canReadRevisionMetadata(fs: Filesystem, store: SnapshotStore, revision: Revision, changes = fileChanges(revision)): boolean {
  if (store.mount !== 'shared' || fs.caller.role === 'admin') return true
  const current = store.files(revision)
  const prior = store.files(revision.parent_oid ? store.at(revision.parent_oid) : undefined)
  try {
    for (const uri of changes) historicalRead(fs, uri, current.get(uri), prior.get(uri))
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return false
    throw error
  }
}

/** A readable blob or a known ref does not confer permission to publish revision metadata. */
export function visibleRevisionId(fs: Filesystem, store: SnapshotStore, revision: Revision | undefined): string | undefined {
  return revision && canReadRevisionMetadata(fs, store, revision) ? revision.oid : undefined
}

function publicRevision(fs: Filesystem, store: SnapshotStore, revision: Revision) {
  const parent = revision.parent_oid ? store.at(revision.parent_oid) : undefined
  return wireRevision(revision, visibleRevisionId(fs, store, parent))
}

function history(fs: Filesystem, query: URLSearchParams): Response {
  const paths = query.getAll('paths'), implicit = paths.length === 0
  const { roots, selected, store } = scopes(fs, implicit ? [defaultSnapshotScope(fs, 'Snapshot log requires explicit paths.').uri] : paths)
  const limit = numberParam(query, 'limit', 20, 1, 500)
  let offset = numberParam(query, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
  for (const uri of roots) {
    historicalRead(fs, uri)
    if (!implicit && fs.entry(fs.path(uri))?.is_dir) {
      // A live directory commits/logs as a tree, not as a filtered listing.
      captureAt(fs, uri, false)
    }
  }
  const start = store.resolve(text(param(query, 'branch') ?? 'main', 'branch', 80))
  const output: ReturnType<typeof wireRevision>[] = []
  for (const row of store.walk(start)) {
    const changes = fileChanges(row)
    if ((!implicit && !changes.some(selected)) || !canReadRevisionMetadata(fs, store, row, changes)) continue
    if (offset > 0) { offset--; continue }
    output.push(publicRevision(fs, store, row))
    if (output.length === limit) break
  }
  return ok(output)
}

function versions(fs: Filesystem, query: URLSearchParams): Response {
  const path = scope(fs, param(query, 'uri'))
  const store = new SnapshotStore(fs.ctx, path.space)
  const limit = numberParam(query, 'limit', 20, 1, 100)
  const arg = param(query, 'before_snapshot')
  const cursor = arg === undefined ? undefined : fullOid(arg, 'before_snapshot')
  historicalRead(fs, path.uri)
  const root = store.head('main'), result: ReturnType<typeof wireRevision>[] = []
  let found = !cursor
  if (root) for (const row of store.walk(root)) {
    const changes = fileChanges(row)
    if (!changes.includes(path.uri) || !store.files(row).has(path.uri) || !canReadRevisionMetadata(fs, store, row, changes)) continue
    if (!found) { found = row.oid === cursor; continue }
    result.push(publicRevision(fs, store, row))
    if (result.length > limit) break
  }
  if (!found) notFound('Snapshot cursor not found for this file.')
  const more = result.length > limit
  if (more) result.pop()
  return ok({ uri: path.uri, versions: result, next_before_snapshot: more ? result.at(-1)!.oid : null })
}

export function routeSnapshot(request: Request, url: URL, fs: Filesystem, part: string): Response | Promise<Response> | undefined {
  const query = url.searchParams
  switch (part) {
    case '/commit': allowed(request, 'POST'); return commit(request, fs)
    case '/restore': allowed(request, 'POST'); return routeRestore(request, fs)
    case '/log': allowed(request, 'GET'); return history(fs, query)
    case '/show': allowed(request, 'GET'); return show(fs, query, request.method === 'HEAD')
    case '/versions': allowed(request, 'GET'); return versions(fs, query)
    case '/diff': allowed(request, 'GET'); return diff(fs, query)
    case '/diff-paths': allowed(request, 'GET'); return diffPaths(fs, query)
    case '/ignore': return ignoreRoute(request, fs)
    default: return undefined
  }
}
