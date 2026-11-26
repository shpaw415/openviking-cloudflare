// SPDX-License-Identifier: AGPL-3.0-only
import { dataAuthorityUnavailable, mountDataAuthority } from '../data-authority.js'
import { ApiError, isRecord, ok } from '../http.js'
import { feedUrl, folderName, htmlUrl, snapshotId, textName } from '../web/catalog.js'
import type { WebMode } from '../web/catalog.js'
import { connectorSource, exactPublicUrl } from '../web/native-catalog.js'
import type { ProviderMode } from '../web/native-catalog.js'
import { needsWebConversion, readWeb, sha256, webUnavailable } from '../web/read.js'
import { bool, conflict, encoder, exists, fromParts, invalid, nameOf, onlyKeys, resourcePath, str, transport, unsupported, writable } from './contract.js'
import { processingMode } from './content.js'
import { ensureParentPlan, nextResourceLeaf } from './import-target.js'
import { assertPendingClear, pendingFor, release, reserve } from './pending.js'
import { tagsOf } from './store.js'
import type { Filesystem, VectorIndex } from './store.js'
import { subtreeRevision } from './subtree.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'

export function webImportMode(body: Record<string, unknown>): WebMode | undefined {
  if (body.add_type === 'git') return isRecord(body.args) && body.args.web_mode === 'collection' ? 'git-collection' : 'git'
  if (body.add_type === 'feishu' || body.add_type === 'tos') {
    if (isRecord(body.args)) {
      if (body.args.web_mode === 'native') return `${body.add_type}-native`
      if (body.add_type === 'feishu' && body.args.web_mode === 'tree') return 'feishu-tree'
      if (body.add_type === 'tos' && body.args.web_mode === 'collection') return 'tos-collection'
    }
    return body.add_type
  }
  if (!isRecord(body.args)) return
  if (body.args.sitemap === true || body.args.site === true && typeof body.path === 'string' && /\.xml$/i.test(body.path)) return 'sitemap'
  if (body.args.site === true) return 'site'
  if (body.args.web_mode === 'html') return 'html'
  if (body.args.web_mode === 'feed' || body.args.feed === true) return 'feed'
}

const noTasks = () => new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The document import task queue is unavailable.')
export const providerCollection = (mode: WebMode) => mode === 'feishu-tree' || mode === 'tos-collection'
export const providerMode = (mode: unknown): mode is ProviderMode => mode === 'feishu-native' || mode === 'tos-native' ||
  mode === 'feishu-tree' || mode === 'tos-collection'
const conversionMissing = () => new ApiError(503, 'CONVERSION_UNAVAILABLE', 'The approved document converter is not mounted.')
export const webPlanStamp = (value: unknown) => sha256(new Uint8Array(encoder.encode(JSON.stringify(value))))
export function watchSelection(fs: Filesystem, mode: ProviderMode, key: string) {
  if (!snapshotId.test(key)) invalid('A provider watch uses an operator-approved alias.')
  const selected = fs.ctx.webSources?.select(mode, key)
  if (!selected || !('native' in selected.source) || !selected.source.watch) throw webUnavailable()
  if (needsWebConversion(selected.source) && !fs.ctx.convertDocument) throw conversionMissing()
  return selected.source
}
type WatchImport = { stamp: string; revision: string | null; finish: (revision: string, result: unknown) => void }

export async function importWeb(fs: Filesystem, body: Record<string, unknown>, mode: WebMode, watch?: WatchImport): Promise<Response> {
  const archive = mode === 'feishu' || mode === 'tos'
  const connector = mode === 'feishu-native' ? 'feishu' : mode === 'tos-native' ? 'tos' : undefined
  const aliasMode = archive || mode === 'git' || mode === 'git-collection' || providerCollection(mode)
  onlyKeys(body, `path to to_uri uri parent create_parent reason wait timeout telemetry watch_interval strict processing_mode args${aliasMode || connector ? ' add_type' : ''}`)
  transport(body)
  bool(body.strict, 'strict')
  if (body.watch_interval != null && body.watch_interval !== 0) {
    if (providerMode(mode) && fs.ctx.registerWatch && !fs.ctx.taskId && !watch) {
      const registration = await fs.ctx.registerWatch(body)
      if (registration) return registration
    }
    unsupported('This document import cannot be scheduled as a watch.')
  }
  const sources = fs.ctx.webSources
  if (!sources?.has(mode)) unsupported('This web import mode is not mounted for this account.')
  if (!fs.ctx.loadDataAuthority) throw dataAuthorityUnavailable()
  const args = body.args
  if (mode === 'git' || archive ? args != null && (!isRecord(args) || Object.keys(args).length !== 0) :
      !isRecord(args) || Object.keys(args).length !== 1) invalid('Web import does not accept source overrides.')
  const sourceKey = str(body.path, 'path', undefined, 1000)
  const publicAddress = mode === 'sitemap' || (mode === 'html' || mode === 'site' || mode === 'feed') && sources.hasNative(mode) ?
    exactPublicUrl(sourceKey) : mode === 'feed' ? feedUrl(sourceKey) : htmlUrl(sourceKey)
  if (aliasMode ? !snapshotId.test(sourceKey) : connector ? !snapshotId.test(sourceKey) && !connectorSource(connector, sourceKey) : !publicAddress) {
    invalid(aliasMode ? 'Use an operator-approved documentation alias.' : 'Use an exact approved HTTPS document address for this mode.')
  }
  const selected = sources.select(mode, sourceKey)
  if (!selected) throw webUnavailable()
  const { source, binding, manifest } = selected
  if (!fs.ctx.hasEmbedding) throw embeddingUnavailable()
  if (needsWebConversion(source) && !fs.ctx.convertDocument) throw conversionMissing()

  const destinations = [body.to, body.to_uri, body.uri].filter(value => value != null && value !== '')
  if (new Set(destinations).size > 1) invalid('Supply one exact destination URI.')
  const toArg = str(destinations[0], 'to', '')
  const parentArg = str(body.parent ?? undefined, 'parent', '')
  if (toArg && parentArg) invalid('Specify to or parent, not both.')
  const to = toArg ? fs.path(toArg) : undefined
  const asDirectory = mode === 'site' || mode === 'feed' || mode === 'git-collection' || mode === 'sitemap' || providerCollection(mode)
  if (archive && !to) invalid('An approved documentary archive requires an exact resource destination.')
  if (providerMode(mode) && to?.parts[0] !== 'user') invalid('A native connector requires an exact destination in your private resources.')
  const parent = to ? fs.parent(to) : fs.path(parentArg || 'viking://~/resources')
  if (to) {
    resourcePath(to)
    if (asDirectory ? !folderName.test(nameOf(to.uri)) : toArg.endsWith('/') || !textName.test(nameOf(to.uri))) {
      invalid(asDirectory ? 'The exact collection destination must be a new resources folder.' : 'The exact document destination must be a visible .txt file.')
    }
  } else resourcePath(parent, true)
  const create = bool(body.create_parent, 'create_parent')
  const processing = processingMode(body.processing_mode)
  const reason = str(body.reason ?? undefined, 'reason', '', 512)
  const authority = await mountDataAuthority(fs.ctx)
  const inventory = manifest === undefined ? undefined : await sha256(new Uint8Array(encoder.encode(manifest)))
  const sourceStamp = await sha256(new Uint8Array(encoder.encode(JSON.stringify(inventory ? [source, inventory] : source))))
  if (watch && await webPlanStamp(watchSelection(fs, mode as ProviderMode, sourceKey)) !== watch.stamp) conflict('The registered provider selection changed.')
  authority.assertCurrent()
  const plan = () => {
    const parentPlan = ensureParentPlan(fs, parent, create)
    const leaf = to ? { path: to, warning: undefined } : nextResourceLeaf(fs, parent, source.name)
    const path = leaf.path
    writable(path, fs.caller)
    const previous = fs.entry(path, 'write')
    if (watch && subtreeRevision(fs, path.uri) !== watch.revision) conflict('The watched destination changed outside this watch.')
    if (asDirectory && previous && !watch) exists()
    if (previous && !!previous.is_dir !== asDirectory) conflict('The document destination has a different type.')
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
    if (!fs.ctx.taskId || watch) return
    if (!fs.ctx.finishJobInTransaction) throw noTasks()
    const [reservation, extra] = pendingFor(fs.ctx, 'resource')
    if (!reservation || extra || reservation.upload_id !== null || reservation.space !== before.target.space ||
        reservation.uri !== before.target.uri || reservation.stamp !== before.stamp) conflict('The document import reservation changed.')
  }
  const guard = async () => { await fs.ctx.reauthorize?.(); checkPlan(); assertReservation() }
  const prior = fs.ctx.assertActive
  fs.ctx.assertActive = () => { checkPlan(); assertReservation() }
  try {
    const { documents, bounded } = await readWeb(binding, source, guard, inventory, fs.ctx.convertDocument)
    const admitted = checkPlan()
    const subdirs = new Map<string, ReturnType<typeof fs.path>>()
    const staged = documents.map(document => {
      const relative = document.name.split('/')
      const path = asDirectory ? fromParts([...admitted.path.parts, ...relative], fs.caller) : admitted.path
      for (let i = 1; i < relative.length; i++) {
        const dir = fromParts([...admitted.path.parts, ...relative.slice(0, i)], fs.caller)
        fs.acl.authorize(dir, 'write')
        const old = fs.entry(dir, 'write')
        if (old && !old.is_dir) conflict('A document collection directory is occupied.')
        if (!old) subdirs.set(dir.uri, dir)
      }
      writable(path, fs.caller)
      fs.acl.authorize(path, 'write')
      const previous = asDirectory ? fs.entry(path, 'write') : admitted.previous
      if (previous?.is_dir) conflict('A document collection file is occupied.')
      return { document, path, previous, same: !!(watch && previous && fs.read(path.uri) === document.text) }
    })
    const updates = staged.filter(item => !item.same)
    const additional = admitted.newEntries + subdirs.size + (asDirectory ? staged.filter(item => !item.previous).length : 0)
    const bytes = updates.reduce((sum, item) => sum + item.document.bytes - (item.previous?.bytes ?? 0), 0)
    fs.limits(admitted.path.space, additional, bytes)
    const indexed: Array<(typeof staged)[number] & { index: VectorIndex }> = []
    for (const item of updates) {
      await guard()
      indexed.push({ ...item, index: await documentIndex(fs.ctx, item.document.text) })
    }
    await guard()
    return fs.atomic(() => {
      const current = checkPlan()
      assertReservation()
      fs.limits(current.path.space, additional, bytes,
        indexed.reduce((sum, item) => sum + (item.index.vectors?.byteLength ?? 0) - (item.previous?.vector_bytes ?? 0), 0))
      for (const dir of current.dirs) fs.mkdir(dir, '')
      if (asDirectory && !current.previous) fs.mkdir(current.path, reason)
      for (const dir of subdirs.values()) { writable(dir, fs.caller); fs.mkdir(dir, '') }
      for (const { path, document, index, previous } of indexed) {
        fs.acl.authorize(path, 'write')
        fs.storeFile(path, document.text, document.bytes, index, previous ? tagsOf(previous) : [], previous,
          asDirectory ? '' : reason || previous?.description)
      }
      const warnings = [current.warning, bounded && (mode === 'site' || mode === 'sitemap') ? 'Only the bounded set of linked documents was imported.' : undefined,
        processing === 'semantic_and_vectors' ? 'Web import indexes documents without generating summaries.' : undefined].filter(Boolean)
      const root = current.path.uri
      const result = { status: 'success', root_uri: root, uri: root, changed: updates.length > 0, documents: staged.map(item => item.path.uri),
        ...(mode === 'site' && { site_limit_reached: bounded }),
        ...(mode === 'sitemap' && { sitemap_limit_reached: bounded }),
        ...(mode === 'feed' && { feed_limit_reached: bounded }),
        ...(warnings.length && { warnings }) }
      if (watch) watch.finish(subtreeRevision(fs, root)!, result)
      else if (fs.ctx.taskId) {
        fs.ctx.finishJobInTransaction!(result)
        release(fs.ctx, fs.ctx.taskId)
      }
      return ok(result)
    })
  } finally { fs.ctx.assertActive = prior }
}
