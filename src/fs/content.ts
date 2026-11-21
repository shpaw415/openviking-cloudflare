// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, ok, readJson } from '../http.js'
import type { WorkspaceContext } from '../context.js'
import { aclSpec } from '../acl.js'
import {
  JSON_LIMIT, SYSTEM_COMPILE, WRITE_LIMIT, absChild, bool, choice, conflict, encoder, exists, fromParts, invalid, linesOf, mergeTags, missing, nameOf,
  onlyKeys, parseTags, pathFor, queryBool, queryInt, quota, str, tagMode, textFile, textSize, transport, unsupported, writable,
} from './contract.js'
import type { FsPath } from './contract.js'
import { Filesystem, emptyIndex, tagsOf } from './store.js'
import type { Entry, Scoped, VectorIndex } from './store.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'
import { assertPendingClear, pendingFor, release, reserve } from './pending.js'
import { summaryText } from './analysis.js'
import { readFileLevels } from './file-levels.js'

export const processingMode = (value: unknown) => choice(value, 'processing_mode',
  ['semantic_and_vectors', 'vectors_only'] as const, 'semantic_and_vectors')

function writeParents(fs: Filesystem, path: Scoped, existing: boolean, create: boolean) {
  let anchor = fs.parent(path)
  const dirs: Scoped[] = []
  const [mount, , section] = path.parts
  const rootDepth = mount === 'resources' || mount === 'agent' ? 1 :
    mount === 'user' && (section === 'resources' || section === 'memories') ? 3 : undefined
  if (!create || rootDepth === undefined) return { anchor, revision: fs.fileParent(path, existing).revision, dirs }

  for (;;) {
    if (anchor.space !== path.space || anchor.kind !== path.kind || anchor.parts.length < rootDepth || anchor.managed) {
      missing() // A write cannot materialize a mount, managed namespace or foreign ancestor.
    }
    const row = fs.entry(anchor, 'write')
    if (row) {
      if (!row.is_dir) conflict('A parent path is not a directory.')
      return { anchor, revision: row.revision, dirs: dirs.reverse() }
    }
    writable(anchor, fs.caller)
    assertPendingClear(fs.ctx, anchor, true)
    dirs.push(anchor)
    anchor = fs.parent(anchor)
  }
}

export async function write(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, WRITE_LIMIT)
  onlyKeys(body, 'uri content mode wait use_snapshot timeout telemetry processing_mode tags tag_mode acl resolve_conflicts defer_processing')
  transport(body)
  if (bool(body.use_snapshot, 'use_snapshot') || bool(body.resolve_conflicts, 'resolve_conflicts')) {
    unsupported('Snapshot-backed writes and conflict history resolution require the archive integration.')
  }
  const deferred = bool(body.defer_processing, 'defer_processing')
  if (deferred && (body.tags != null || body.tag_mode === 'clear' || body.acl != null)) invalid('Deferred writes do not accept tags or ACL updates.')
  const processing = processingMode(body.processing_mode)
  const mode = choice(body.mode, 'mode', ['replace', 'append', 'create'] as const, 'replace')
  const path = pathFor(body.uri, fs.caller)
  writable(path, fs.caller)
  textFile(nameOf(path.uri))
  const spec = aclSpec(body.acl)
  fs.acl.prepare(path, spec)
  const previous = fs.entry(path, 'write')
  assertPendingClear(fs.ctx, path)
  if (mode === 'create' && previous) exists()
  if (previous?.is_dir) conflict('The target is a directory.')
  if (mode === 'append' && !previous) missing()
  if (mode === 'append' && (previous?.derived_from != null || previous?.derived_version != null)) {
    conflict('A generated summary cannot be appended to as authored content.')
  }
  const parents = writeParents(fs, path, !!previous, mode === 'create')
  const input = str(body.content, 'content', undefined, WRITE_LIMIT)
  const text = mode === 'append' ? fs.content(path).body + input : input
  const bytes = textSize(text)
  const tagPatch = tagMode(body.tag_mode)
  const oldTags = previous ? tagsOf(previous) : []
  const tags = body.tags != null || tagPatch === 'clear' ? mergeTags(oldTags, parseTags(body.tags), tagPatch) : oldTags
  fs.limits(path.space, (previous ? 0 : 1) + parents.dirs.length, bytes - (previous?.bytes ?? 0))
  // Durable Objects can interleave requests at this await. Re-plan without
  // writes before publishing any ancestor, even when the leaf is still absent.
  const index = deferred ? emptyIndex : await documentIndex(fs.ctx, text)
  await fs.ctx.reauthorize?.()
  fs.atomic(() => {
    fs.ctx.assertActive?.()
    if (fs.entry(path, 'write')?.revision !== previous?.revision) {
      conflict('The path changed while indexing; reload and retry.')
    }
    const current = writeParents(fs, path, !!previous, mode === 'create')
    if (current.anchor.uri !== parents.anchor.uri || current.revision !== parents.revision || current.dirs.length !== parents.dirs.length) {
      conflict('The parent chain changed while indexing; reload and retry.')
    }
    fs.acl.prepare(path, spec)
    assertPendingClear(fs.ctx, path)
    fs.limits(path.space, (previous ? 0 : 1) + current.dirs.length, bytes - (previous?.bytes ?? 0),
      (index.vectors?.byteLength ?? 0) - (previous?.vector_bytes ?? 0))
    for (const dir of current.dirs) fs.mkdir(dir, '')
    fs.storeFile(path, text, bytes, index, tags, previous, previous?.description, spec)
  })
  return ok({ uri: path.uri, updated: true,
    ...(deferred ? { semantic_status: 'deferred', vector_status: 'deferred' } :
      processing === 'semantic_and_vectors' && { warnings: ['Edge stores vectors only; no L0/L1 summaries were generated.'] }),
  })
}

const BATCH_WRITE_BYTES = 1024 * 1024
const BATCH_TEXT_BYTES = 256 * 1024
type WireFailure = { uri: string; code: string; message: string }

function batchText(op: Record<string, unknown>): string {
  if ((op.content == null) === (op.content_base64 == null)) invalid('Supply exactly one of content and content_base64.')
  if (op.content != null) return str(op.content, 'content', undefined, WRITE_LIMIT)
  const encoded = str(op.content_base64, 'content_base64', undefined, 88_000)
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid('Invalid padded base64 content.')
  try {
    const binary = atob(encoded)
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, x => x.charCodeAt(0)))
  } catch {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Base64 content must decode to supported UTF-8 text.')
  }
}

export const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
  n => n.toString(16).padStart(2, '0')).join('')

export async function batchWrite(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, BATCH_WRITE_BYTES)
  onlyKeys(body, 'root_uri operations wait use_snapshot timeout telemetry skip_conflicts defer_processing processing_mode')
  transport(body)
  if (bool(body.use_snapshot, 'use_snapshot')) unsupported('Snapshot-backed batch writes require the archive integration.')
  const deferred = bool(body.defer_processing, 'defer_processing')
  const wait = bool(body.wait, 'wait', true)
  const skip = bool(body.skip_conflicts, 'skip_conflicts')
  const processing = processingMode(body.processing_mode)
  const root = fs.path(body.root_uri)
  writable(root, fs.caller)
  const rootEntry = fs.require(root, 'write')
  if (!rootEntry.is_dir) invalid('root_uri must name an existing directory.')
  if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 64) invalid('Expected between 1 and 64 batch-write operations.')
  const seen = new Set<string>()
  const operations = body.operations.map(value => {
    if (!isRecord(value)) invalid('Invalid batch-write operation.')
    onlyKeys(value, 'uri content content_base64 mode expected_sha256 if_absent resolve_conflicts tags tag_mode acl')
    const path = fs.path(value.uri)
    if (path.space !== root.space || path.kind !== root.kind || !absChild(path.uri, root.uri)) invalid('A target is outside root_uri.')
    if (seen.has(path.uri)) invalid('Duplicate canonical batch-write target.')
    seen.add(path.uri)
    writable(path, fs.caller)
    textFile(nameOf(path.uri))
    fs.acl.authorize(path, 'write')
    assertPendingClear(fs.ctx, path)
    if (bool(value.resolve_conflicts, 'resolve_conflicts')) unsupported('Conflict history resolution requires the archive integration.')
    const acl = aclSpec(value.acl)
    const patch = tagMode(value.tag_mode)
    const tags = value.tags != null || patch === 'clear' ? parseTags(value.tags) : undefined
    if (deferred && (acl || tags)) invalid('Deferred batch writes do not accept tags or ACL updates.')
    fs.acl.prepare(path, acl)
    const mode = choice(value.mode, 'mode', ['replace', 'append', 'create', 'upsert'] as const, 'replace')
    const expected = value.expected_sha256 == null ? undefined : str(value.expected_sha256, 'expected_sha256', undefined, 64)
    const absent = bool(value.if_absent, 'if_absent')
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) invalid('expected_sha256 must be a lowercase SHA-256 digest.')
    if (absent && (expected !== undefined || mode === 'append')) invalid('if_absent cannot be combined with expected_sha256 or append.')
    return { path: path as Scoped, mode, expected, absent, acl, patch, tags, input: batchText(value) }
  })

  let totalBytes = 0
  // Resolve all authorization, structure, and source content before the first await.
  const work = operations.map(operation => {
    const { path, mode, expected, absent, input } = operation
    const previous = fs.entry(path, 'write')
    const parent = fs.fileParent(path, !!previous)
    const generated = previous?.derived_from != null || previous?.derived_version != null
    const problem = previous?.is_dir ? 'The target is a directory.' : absent && previous ? 'The target already exists.' :
      generated && mode === 'append' ? 'A generated summary cannot be appended to as authored content.' :
      expected !== undefined && !previous ? 'Expected content no longer exists.' : undefined
    if (problem && !skip) conflict(problem)
    const original = !problem && previous && (expected !== undefined || mode === 'append') ? fs.content(path).body : undefined
    const text = mode === 'append' ? (original ?? '') + input : input
    const bytes = textSize(text)
    const tags = previous ? tagsOf(previous) : []
    if ((totalBytes += bytes) > BATCH_TEXT_BYTES) quota('Batch write text limit exceeded.')
    return { operation, previous, parent, original, text, bytes, problem, tags }
  })
  // Complete the CAS checks before charging for any vectors, even for later files.
  const conflicts: WireFailure[] = [], unchangedWork: typeof work = []
  const recordConflict = (uri: string, message: string) => {
    if (!skip) conflict(message)
    conflicts.push({ uri, code: 'CONFLICT', message })
  }
  const pending: typeof work = []
  for (const item of work) {
    const { path, mode, expected, acl, tags } = item.operation
    if (item.problem) { recordConflict(path.uri, item.problem); continue }
    if (expected !== undefined && await sha256(item.original!) !== expected) {
      recordConflict(path.uri, 'Content revision changed.'); continue
    }
    if (skip && expected !== undefined && mode !== 'append' && item.original === item.text && !acl && !tags && !deferred && item.previous!.dimensions) {
      unchangedWork.push(item); continue
    }
    pending.push(item)
  }
  fs.limits(root.space, pending.filter(item => !item.previous).length,
    pending.reduce((sum, item) => sum + item.bytes - (item.previous?.bytes ?? 0), 0))
  const publish = (indexes: VectorIndex[], taskId?: string) => {
    fs.ctx.assertActive?.()
    if (fs.require(root, 'write').revision !== rootEntry.revision) conflict('The batch root changed while indexing.')
    const stillCurrent = (item: typeof work[number]) => {
      const { path, acl } = item.operation
      fs.acl.prepare(path, acl)
      if (fs.entry(path, 'write')?.revision !== item.previous?.revision || fs.fileParent(path, !!item.previous).revision !== item.parent.revision) {
        recordConflict(path.uri, 'The target or its parent changed while indexing.')
        return false
      }
      assertPendingClear(fs.ctx, path)
      return true
    }
    const unchanged = unchangedWork.filter(stillCurrent).map(item => item.operation.path.uri)
    const prepared = pending.flatMap((item, i) => stillCurrent(item) ? [{ ...item, index: indexes[i] }] : [])
    if (taskId && !prepared.length) conflict('No batch targets remain unchanged from admission.')
    const created: string[] = [], updated: string[] = []
    for (const { operation: { path, patch, tags, acl }, previous, text, bytes, index, tags: oldTags } of prepared) {
      const row = fs.storeFile(path, text, bytes, index, tags ? mergeTags(oldTags, tags, patch) : oldTags, previous, previous?.description, acl)
      if (taskId) reserve(fs.ctx, taskId, path, 'batch_index', row.revision)
      ;(previous ? updated : created).push(path.uri)
    }
    return { root_uri: root.uri, created: created.sort(), updated: updated.sort(), unchanged: unchanged.sort(), ...(skip && { conflicts }),
      vector_status: deferred ? 'deferred' : taskId ? 'queued' : 'complete', semantic_status: deferred ? 'deferred' : 'skipped', queue_status: null,
      ...(taskId && { task_id: taskId }),
      ...(processing === 'semantic_and_vectors' && !deferred && { warnings: ['No summaries were generated.'] }) }
  }
  if (!wait && !deferred && pending.length) {
    if (!fs.ctx.jobs) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'Filesystem indexing requires an active task queue.')
    if (fs.ctx.hasEmbedding === false && pending.some(item => item.text.trim())) throw embeddingUnavailable()
    await fs.ctx.reauthorize?.()
    let receipt: ReturnType<typeof publish> | undefined
    await fs.ctx.jobs.enqueue('content_batch_write', root.uri, { root_uri: root.uri }, {
      onAccepted: task => { receipt = publish(pending.map(() => emptyIndex), task.task_id) },
    })
    if (!receipt) throw new ApiError(500, 'INTERNAL_ERROR', 'The batch acceptance transaction did not run.')
    return ok(receipt)
  }
  const indexes: VectorIndex[] = []
  for (const item of pending) {
    fs.ctx.assertActive?.()
    indexes.push(deferred ? emptyIndex : await documentIndex(fs.ctx, item.text))
  }
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => ok(publish(indexes)))
}

export async function runContentBatchJob(payload: Record<string, unknown>, ctx: WorkspaceContext): Promise<unknown> {
  if (!ctx.taskId || !ctx.finishJobInTransaction || !ctx.assertActive) {
    throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The durable batch consumer is not mounted.')
  }
  const fs = new Filesystem(ctx)
  const root = fs.path(payload.root_uri)
  writable(root, fs.caller)
  const rootRevision = fs.require(root, 'write').revision
  const reserved = pendingFor(ctx, 'batch_index')
  if (!reserved.length || reserved.length > 64) conflict('The batch reservation is missing.')
  ctx.assertActive()
  const work = reserved.map(row => {
    const path = fs.path(row.uri)
    writable(path, fs.caller)
    if (path.space !== row.space || path.space !== root.space || !absChild(path.uri, root.uri)) conflict('The batch reservation does not match its scope.')
    const entry = fs.require(path, 'write')
    if (entry.is_dir || entry.revision !== row.stamp) conflict('A queued batch target changed.')
    return { path, entry, text: fs.content(path).body }
  })
  const indexes: VectorIndex[] = []
  for (const item of work) {
    ctx.assertActive()
    indexes.push(await documentIndex(ctx, item.text))
  }
  await ctx.reauthorize?.()
  return fs.atomic(() => {
    ctx.assertActive!()
    if (fs.require(root, 'write').revision !== rootRevision) conflict('The batch root changed while indexing.')
    for (const { path, entry } of work) if (fs.require(path, 'write').revision !== entry.revision) conflict('A queued batch target changed.')
    for (const [i, { path }] of work.entries()) fs.putIndex(path, indexes[i])
    const result = { root_uri: root.uri, indexed_count: indexes.filter(index => index.dimensions > 0).length, vector_status: 'complete' }
    ctx.finishJobInTransaction!(result)
    release(ctx, ctx.taskId!)
    return result
  })
}

export function read(fs: Filesystem, path: FsPath, query: URLSearchParams): Response {
  queryBool(query, 'raw') // Exact authored text; this port has no generated memory-field projection.
  const offset = queryInt(query, 'offset', 0, 0, 1_000_000)
  const limit = queryInt(query, 'limit', -1, -1, 1_000_000)
  const { body } = fs.content(path)
  if (offset === 0 && limit === -1) return ok(body)
  return ok(linesOf(body).slice(offset, limit === -1 ? undefined : offset + limit).join(''))
}

export function download(fs: Filesystem, path: FsPath): Response {
  const { body } = fs.content(path)
  const fileName = encodeURIComponent(nameOf(path.uri)).replace(/['()*]/g,
    char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return new Response(body, { headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${fileName}`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Frame-Options': 'DENY',
  } })
}

export function summaryPath(fs: Filesystem, path: FsPath, level: 'abstract' | 'overview'): FsPath | undefined {
  if (path.space === null || path.space === SYSTEM_COMPILE) return
  // A valid 1024-byte/depth-20 directory may not have room for a sidecar.
  try { return fromParts([...path.parts, `.${level}.md`], fs.caller) }
  catch (error) {
    if (error instanceof ApiError && error.code === 'INVALID_URI') return
    throw error
  }
}

export function summary(fs: Filesystem, path: FsPath, level: 'abstract' | 'overview', entry?: Entry): string | undefined {
  if (!(entry ?? fs.require(path)).is_dir) {
    if (entry) return // Listings/stat do not adopt their file's directory fallback.
    const exact = readFileLevels(fs, path, level === 'abstract' ? 0 : 1)[0]
    if (exact) return exact.body
    return summary(fs, fs.parent(path), level)
  }
  const sidecar = summaryPath(fs, path, level)
  if (!sidecar) return
  const meta = entry ? fs.previewEntry(sidecar) : fs.entry(sidecar)
  if (meta && !meta.is_dir) return summaryText(fs.content(sidecar).body)
}

export async function setTags(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri tags mode recursive telemetry')
  transport(body)
  const path = pathFor(body.uri, fs.caller)
  const mode = tagMode(body.mode, 'mode')
  const requested = mode === 'clear' ? [] : parseTags(body.tags)
  const recursive = bool(body.recursive, 'recursive')
  return ok(patchTags(fs, path, requested, mode, recursive))
}

function patchTags(fs: Filesystem, path: FsPath, requested: string[], mode: ReturnType<typeof tagMode>, recursive: boolean) {
  writable(path, fs.caller)
  return fs.atomic(() => {
    const entry = fs.require(path, 'write')
    const affected = recursive && entry.is_dir ? fs.storedEntries(path, 'write') : [entry]
    // Stage the entire patch before changing the first entry.
    const changes = affected.map(row => [row, mergeTags(tagsOf(row), requested, mode)] as const)
    for (const [row, tags] of changes) fs.updateTags(path, row, tags)
    return { uri: path.uri, tags: mergeTags(tagsOf(entry), requested, mode), updated_count: changes.length }
  })
}

export async function batchSetTags(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uris tags mode recursive telemetry')
  transport(body)
  if (!Array.isArray(body.uris) || body.uris.length < 1 || body.uris.length > 50) invalid('Expected between 1 and 50 URIs.')
  const mode = tagMode(body.mode, 'mode')
  const tags = mode === 'clear' ? [] : parseTags(body.tags)
  const recursive = bool(body.recursive, 'recursive')
  const items: Array<ReturnType<typeof patchTags>> = [], failed: Array<{ uri: string; error: Omit<WireFailure, 'uri'> }> = []
  const seen = new Set<string>()
  for (const value of body.uris) {
    let uri = str(value, 'uri')
    try {
      const path = fs.path(uri)
      uri = path.uri
      if (seen.has(uri)) continue
      seen.add(uri)
      items.push(patchTags(fs, path, tags, mode, recursive))
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      if (failed.some(item => item.uri === uri)) continue
      failed.push({ uri, error: { code: error.code, message: error.message } })
    }
  }
  return ok({ items, failed })
}
