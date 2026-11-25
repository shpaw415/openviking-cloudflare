// SPDX-License-Identifier: AGPL-3.0-only
import { dataAuthorityUnavailable, mountDataAuthority } from '../data-authority.js'
import { ApiError, isRecord, ok } from '../http.js'
import { folderName, htmlUrl, snapshotId, textName } from '../web/catalog.js'
import type { WebMode } from '../web/catalog.js'
import { readWeb, sha256, webUnavailable } from '../web/read.js'
import { bool, conflict, encoder, exists, fromParts, invalid, nameOf, onlyKeys, resourcePath, str, transport, unsupported, writable } from './contract.js'
import { processingMode } from './content.js'
import { ensureParentPlan, nextResourceLeaf } from './import-target.js'
import { assertPendingClear, pendingFor, release, reserve } from './pending.js'
import { tagsOf } from './store.js'
import type { Filesystem, VectorIndex } from './store.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'

export function webImportMode(body: Record<string, unknown>): WebMode | undefined {
  if (body.add_type === 'git') return 'git'
  if (!isRecord(body.args)) return
  if (body.args.site === true) return 'site'
  if (body.args.web_mode === 'html') return 'html'
}

const noTasks = () => new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The document import task queue is unavailable.')

export async function importWeb(fs: Filesystem, body: Record<string, unknown>, mode: WebMode): Promise<Response> {
  onlyKeys(body, `path to to_uri uri parent create_parent reason wait timeout telemetry watch_interval strict processing_mode args${mode === 'git' ? ' add_type' : ''}`)
  transport(body)
  bool(body.strict, 'strict')
  if (body.watch_interval != null && body.watch_interval !== 0) unsupported('Web document imports cannot be scheduled as watches.')
  const sources = fs.ctx.webSources
  if (!sources?.has(mode)) unsupported('This web import mode is not mounted for this account.')
  if (!fs.ctx.loadDataAuthority) throw dataAuthorityUnavailable()
  const args = body.args
  if (mode === 'git' ? args != null && (!isRecord(args) || Object.keys(args).length !== 0) :
      !isRecord(args) || Object.keys(args).length !== 1) invalid('Web import does not accept source overrides.')
  const sourceKey = str(body.path, 'path', undefined, 1000)
  if (mode === 'git' ? !snapshotId.test(sourceKey) : !htmlUrl(sourceKey)) {
    invalid(mode === 'git' ? 'Use an operator-approved Git documentation alias.' : 'Use an exact approved HTTPS .html or .htm address.')
  }
  const source = sources.select(mode, sourceKey)
  if (!source) throw webUnavailable()
  if (!fs.ctx.hasEmbedding) throw embeddingUnavailable()

  const destinations = [body.to, body.to_uri, body.uri].filter(value => value != null && value !== '')
  if (new Set(destinations).size > 1) invalid('Supply one exact destination URI.')
  const toArg = str(destinations[0], 'to', '')
  const parentArg = str(body.parent ?? undefined, 'parent', '')
  if (toArg && parentArg) invalid('Specify to or parent, not both.')
  const to = toArg ? fs.path(toArg) : undefined
  const asDirectory = source.mode === 'site'
  const parent = to ? fs.parent(to) : fs.path(parentArg || 'viking://~/resources')
  if (to) {
    resourcePath(to)
    if (asDirectory ? !folderName.test(nameOf(to.uri)) : toArg.endsWith('/') || !textName.test(nameOf(to.uri))) {
      invalid(asDirectory ? 'The exact site destination must be a new resources folder.' : 'The exact document destination must be a visible .txt file.')
    }
  } else resourcePath(parent, true)
  const create = bool(body.create_parent, 'create_parent')
  const processing = processingMode(body.processing_mode)
  const reason = str(body.reason ?? undefined, 'reason', '', 512)
  const authority = await mountDataAuthority(fs.ctx)
  const sourceStamp = await sha256(new Uint8Array(encoder.encode(JSON.stringify(source))))
  authority.assertCurrent()
  const plan = () => {
    const parentPlan = ensureParentPlan(fs, parent, create)
    const leaf = to ? { path: to, warning: undefined } : nextResourceLeaf(fs, parent, source.name)
    const path = leaf.path
    writable(path, fs.caller)
    const previous = fs.entry(path, 'write')
    if (asDirectory && previous) exists()
    if (previous?.is_dir) conflict('The document destination is a directory.')
    const target = parentPlan.dirs[0] ?? path
    assertPendingClear(fs.ctx, target, true)
    const newEntries = parentPlan.dirs.length + (previous ? 0 : 1)
    fs.limits(path.space, newEntries)
    return { ...parentPlan, path, previous, target, newEntries, warning: leaf.warning,
      stamp: JSON.stringify([sourceStamp, path.uri, previous?.revision, parentPlan.anchor.uri, parentPlan.revision, parentPlan.dirs.map(dir => dir.uri)]) }
  }
  const before = plan()
  const checkPlan = () => {
    authority.assertCurrent()
    const current = plan()
    if (current.stamp !== before.stamp) conflict('The document import destination changed; submit it again.')
    return current
  }
  if (body.wait === false && !fs.ctx.taskId) {
    if (!fs.ctx.jobs) throw noTasks()
    const task = await fs.ctx.jobs.enqueue('add_resource', before.path.uri,
      { body: { ...body, wait: true }, dataAuthorityRevision: authority.revision }, {
        meta: { staged_atomic: true },
        onAccepted(task) {
          const fresh = checkPlan()
          reserve(fs.ctx, task.task_id, fresh.target, 'resource', fresh.stamp, { subtree: true })
        },
      })
    return ok({ status: 'accepted', task_id: task.task_id, root_uri: before.path.uri, uri: before.path.uri })
  }

  const assertReservation = () => {
    if (!fs.ctx.taskId) return
    if (!fs.ctx.finishJobInTransaction) throw noTasks()
    const [reservation, extra] = pendingFor(fs.ctx, 'resource')
    if (!reservation || extra || reservation.upload_id !== null || reservation.space !== before.target.space ||
        reservation.uri !== before.target.uri || reservation.stamp !== before.stamp) conflict('The document import reservation changed.')
  }
  const guard = async () => { await fs.ctx.reauthorize?.(); checkPlan(); assertReservation() }
  const prior = fs.ctx.assertActive
  fs.ctx.assertActive = () => { checkPlan(); assertReservation() }
  try {
    const { documents, bounded } = await readWeb(sources.binding, source, guard)
    const admitted = checkPlan()
    const additional = admitted.newEntries + (asDirectory ? documents.length : 0)
    const bytes = documents.reduce((sum, item) => sum + item.bytes, 0) - (admitted.previous?.bytes ?? 0)
    const staged = documents.map(document => {
      const path = asDirectory ? fromParts([...admitted.path.parts, document.name], fs.caller) : admitted.path
      writable(path, fs.caller)
      fs.acl.authorize(path, 'write')
      return { document, path }
    })
    fs.limits(admitted.path.space, additional, bytes)
    const indexed: Array<(typeof staged)[number] & { index: VectorIndex }> = []
    for (const item of staged) {
      await guard()
      indexed.push({ ...item, index: await documentIndex(fs.ctx, item.document.text) })
    }
    await guard()
    return fs.atomic(() => {
      const current = checkPlan()
      assertReservation()
      fs.limits(current.path.space, additional, bytes,
        indexed.reduce((sum, item) => sum + (item.index.vectors?.byteLength ?? 0), 0) - (current.previous?.vector_bytes ?? 0))
      for (const dir of current.dirs) fs.mkdir(dir, '')
      if (asDirectory) fs.mkdir(current.path, reason)
      for (const { path, document, index } of indexed) {
        const previous = current.previous
        fs.storeFile(path, document.text, document.bytes, index, previous ? tagsOf(previous) : [], previous,
          asDirectory ? '' : reason || previous?.description)
      }
      const warnings = [current.warning, bounded ? 'Only the bounded set of linked documents was imported.' : undefined,
        processing === 'semantic_and_vectors' ? 'Web import indexes documents without generating summaries.' : undefined].filter(Boolean)
      const root = current.path.uri
      const result = { status: 'success', root_uri: root, uri: root, changed: true, documents: indexed.map(item => item.path.uri),
        ...(warnings.length && { warnings }) }
      if (fs.ctx.taskId) {
        fs.ctx.finishJobInTransaction!(result)
        release(fs.ctx, fs.ctx.taskId)
      }
      return ok(result)
    })
  } finally { fs.ctx.assertActive = prior }
}
