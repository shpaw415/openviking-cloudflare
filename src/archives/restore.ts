// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson } from '../http.js'
import {
  captureSubtree, commitSubtreeMutation, prepareSubtreeMutation, subtreeRevision, validateSubtreeMutation,
  type Filesystem, type SubtreeEntry, type SubtreeMutationPlan,
} from '../filesystem.js'
import { ArchiveError, bool, conflict, fields, forbidden, invalid, notFound, relative, text, under } from './common.js'
import { captureAt, commitAuthor, defaultSnapshotScope, fileChanges, fullOid, guardFor, historicalRead, scope,
  visibleRevisionId } from './snapshot.js'
import { branchName, SnapshotStore, type FileRef, type Revision } from './snapshot-store.js'

const VERSION_CONFLICT = () => new ArchiveError(409, 'CONFLICT', 'The requested file version is no longer current.',
  { resource: 'VERSION_CONFLICT' })

function carry(fs: Filesystem, next: { tree: FileRef[] }, writes: readonly string[]): void {
  const wanted = new Set(writes)
  for (const ref of next.tree) if (wanted.has(ref[0])) {
    const capture = captureSubtree(fs, ref[0])
    ref[3] = guardFor(capture, 0)
  }
}

function anchor(fs: Filesystem, uri: string): void {
  const path = scope(fs, uri)
  if (fs.entry(path)) fs.entry(path, 'write')
  else fs.checkWriteParent(uri)
}

async function restoreFile(fs: Filesystem, body: Record<string, unknown>, dry: boolean): Promise<Response> {
  if (body.project_dir != null || body.source_commit != null) invalid('path cannot be combined with project_dir or source_commit.')
  if (body.branch != null && body.branch !== 'main') invalid('Single-file restore uses the main branch.')
  const path = scope(fs, body.path)
  if (path.builtin) invalid('A file path is required.')
  const sourceId = fullOid(body.restore_commit_id, 'restore_commit_id')
  const expected = body.current_commit_id == null ? undefined : fullOid(body.current_commit_id, 'current_commit_id')
  const store = new SnapshotStore(fs.ctx, path.space)
  const head = store.head('main') ?? notFound('Snapshot ref not found.')
  const previous = store.files(head)
  const current = previous.get(path.uri)
  const live = captureAt(fs, path.uri)
  const file = live?.entries[0]
  if (file?.is_dir) conflict('The target is a collection, not a file.')
  const lastFileRevision = () => {
    for (const commit of store.walk(head)) if (fileChanges(commit).includes(path.uri)) return commit
    return undefined
  }
  const last = expected ? lastFileRevision() : undefined
  if (expected) {
    if (last?.oid !== expected || file?.content !== (current && store.blob(current).body)) throw VERSION_CONFLICT()
  }
  const from = store.resolve(sourceId)
  const source = store.files(from).get(path.uri) ?? notFound('Snapshot file not found.')
  historicalRead(fs, path.uri, source, current)
  const blob = store.blob(source)
  const plan: SubtreeMutationPlan = { expectedRevision: live?.revision ?? null, entries: [{ path: '', is_dir: false,
    content: blob.body, description: file?.description ?? '', tags: file?.tags ?? [] }] }
  validateSubtreeMutation(fs, path.uri, plan)
  if (dry) return ok({ uri: path.uri, snapshot_id: expected ? visibleRevisionId(fs, store, last) : null, result: 'dry_run' })
  if (file?.content === blob.body && current?.[1] === source[1] && current[3].node_id === live?.guard.entries[0].node_id) {
    return ok({ uri: path.uri, snapshot_id: visibleRevisionId(fs, store, last ?? lastFileRevision() ?? head), result: 'noop' })
  }
  const resultTree = new Map(previous)
  resultTree.set(path.uri, [...source])
  const next = await store.prepare(resultTree, previous, head,
    text(body.message ?? `Restore ${path.uri}`, 'message'), ...commitAuthor(body))
  if (!next.changes.includes(path.uri)) next.changes.push(path.uri)
  try {
    const prepared = await prepareSubtreeMutation(fs, path.uri, plan)
    historicalRead(fs, path.uri, source, current)
    commitSubtreeMutation(fs, prepared, () => {
      carry(fs, next, [path.uri])
      store.publish('main', head, next, [])
    })
  } catch (error) {
    if (expected && (error as { status?: number })?.status === 409) throw VERSION_CONFLICT()
    throw error
  }
  return ok({ uri: path.uri, snapshot_id: visibleRevisionId(fs, store, store.at(next.oid)), result: 'created' })
}

function restorePlan(fs: Filesystem, uri: string, store: SnapshotStore, head: Revision, source: Revision) {
  const previous = store.files(head), original = store.files(source), files = new Map(previous)
  const targets = Array.from(new Set([...previous.keys(), ...original.keys()])).filter(target => under(target, uri)).sort()
  const live = captureAt(fs, uri)
  if (live?.entries[0] && !live.entries[0].is_dir) conflict('project_dir must designate a directory.')
  const liveEntries = new Map((live?.entries ?? []).map(entry => [entry.path, entry]))
  const writes: Array<{ uri: string; oid: string }> = []
  const deletes: string[] = [], unchanged: string[] = []
  const entries = new Map<string, SubtreeEntry>()
  for (const target of targets) {
    const before = previous.get(target), after = original.get(target)
    historicalRead(fs, target, before, after)
    const local = relative(target, uri)
    if (!local) conflict('project_dir must designate a directory in both snapshots.')
    if (before?.[1] === after?.[1]) { unchanged.push(target); continue }
    if (!after) {
      if (liveEntries.get(local)?.is_dir) conflict('A tracked file was replaced with a live collection.')
      deletes.push(target)
      files.delete(target)
      continue
    }
    const old = liveEntries.get(local), blob = store.blob(after)
    if (old?.is_dir) conflict('A tracked file would replace a live collection.')
    writes.push({ uri: target, oid: blob.oid })
    files.set(target, [...after])
    entries.set(local, { path: local, is_dir: false, content: blob.body, description: old?.description ?? '', tags: old?.tags ?? [] })
    const parts = local.split('/'); parts.pop()
    while (parts.length) {
      const parent = parts.join('/')
      const existing = liveEntries.get(parent)
      if (existing?.is_dir) break
      if (existing && !previous.has(`${uri}/${parent}`)) conflict('A live file prevents creating a restored collection.')
      if (!entries.has(parent)) entries.set(parent, { path: parent, is_dir: true, description: '', tags: [] })
      parts.pop()
    }
  }
  if (!live && writes.length) entries.set('', { path: '', is_dir: true, description: '', tags: [] })
  const deletionPaths = deletes.map(target => relative(target, uri))
  const plan: SubtreeMutationPlan = { expectedRevision: live?.revision ?? null, entries: [...entries.values()], delete: deletionPaths }
  if (!plan.entries.length && !deletes.length) anchor(fs, uri)
  validateSubtreeMutation(fs, uri, plan)
  return { files, previous, writes, deletes, unchanged, plan, targets, original }
}

export async function routeRestore(request: Request, fs: Filesystem): Promise<Response> {
  const body = await readJson(request, 64 * 1024)
  fields(body, 'project_dir source_commit path restore_commit_id current_commit_id branch dry_run message author_name author_email')
  const dry = bool(body.dry_run, 'dry_run')
  if (body.path != null) return restoreFile(fs, body, dry)
  if (body.restore_commit_id != null || body.current_commit_id != null) invalid('File restore IDs require path.')
  const scopeRequired = 'Snapshot restore requires an explicit project_dir.'
  const root = body.project_dir != null ? scope(fs, body.project_dir)
    : dry ? defaultSnapshotScope(fs, scopeRequired) : forbidden(scopeRequired)
  const branch = branchName(text(body.branch ?? 'main', 'branch', 80))
  const store = new SnapshotStore(fs.ctx, root.space)
  const head = store.head(branch) ?? notFound('Snapshot ref not found.')
  const source = store.resolve(text(body.source_commit, 'source_commit', 80))
  const { plan, writes, deletes, unchanged, previous, files, targets, original } = restorePlan(fs, root.uri, store, head, source)
  const headAndSource = () => ({ head: visibleRevisionId(fs, store, head), source: visibleRevisionId(fs, store, source) })
  if (dry) return ok({ result: 'dry_run', ...headAndSource(), diff: {
    to_write: writes.map(({ uri, oid }) => ({ path: relative(uri, root.uri), oid })),
    to_delete: deletes.map(uri => relative(uri, root.uri)), unchanged: unchanged.map(uri => relative(uri, root.uri)),
  } })
  if (!writes.length && !deletes.length) return ok({ result: 'noop', ...headAndSource() })
  const next = await store.prepare(files, previous, head, text(body.message ?? `Restore ${root.uri}`, 'message'), ...commitAuthor(body))
  const prepared = await prepareSubtreeMutation(fs, root.uri, plan)
  if (subtreeRevision(fs, root.uri) !== plan.expectedRevision) conflict('The workspace changed during restore.')
  for (const target of targets) historicalRead(fs, target, previous.get(target), original.get(target))
  commitSubtreeMutation(fs, prepared, () => {
    carry(fs, next, writes.map(write => write.uri))
    store.publish(branch, head, next, [])
  })
  const archivePath = (uri: string) => uri.slice('viking://'.length)
  return ok({ result: 'applied', source_commit: visibleRevisionId(fs, store, source),
    parent_commit: visibleRevisionId(fs, store, head), new_commit_oid: visibleRevisionId(fs, store, store.at(next.oid)),
    written: writes.length, deleted: deletes.length, unchanged: unchanged.length,
    written_paths: writes.map(item => archivePath(item.uri)), deleted_paths: deletes.map(archivePath) })
}
