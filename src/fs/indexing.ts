// SPDX-License-Identifier: AGPL-3.0-only
import { ok, readJson } from '../http.js'
import { JSON_LIMIT, SYSTEM_COMPILE, bool, compare, conflict, denied, invalid, mergeTags, nameOf,
  onlyKeys, parseTags, quota, str, tagMode, textSize, transport, writable } from './contract.js'
import type { FsPath } from './contract.js'
import { processingMode, summaryPath } from './content.js'
import { tagsOf } from './store.js'
import type { Entry, Filesystem, Scoped, VectorIndex } from './store.js'
import { documentIndex } from './vectors.js'
import { summaryText } from './analysis.js'
import { admitsFileLevels, prepareLevels, publishFileLevels } from './file-levels.js'
import { assertPendingClear } from './pending.js'

export function sidecarLevel(uri: string): 0 | 1 | 2 {
  const name = nameOf(uri)
  return name === '.abstract.md' ? 0 : name === '.overview.md' ? 1 : 2
}

export async function ensureDirectoryIndex(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri fallback_abstract wait telemetry')
  transport(body)
  const fallback = str(body.fallback_abstract, 'fallback_abstract')
  if (!fallback.trim()) invalid('fallback_abstract must not be empty.')
  textSize(fallback)
  const root = fs.path(body.uri)
  writable(root, fs.caller)
  const directory = fs.require(root, 'write')
  if (!directory.is_dir) invalid('directory index target must be a directory.')
  const paths = (['abstract', 'overview'] as const).map(name => summaryPath(fs, root, name) as Scoped | undefined)
  if (!paths[0] || !paths[1]) invalid('Directory URI cannot accommodate its sidecars.')
  const sidecars = paths.map((path, level) => {
    const target = path!
    const previous = fs.entry(target)
    if (previous?.is_dir) invalid('Directory summary is not a file.')
    const text = previous && summaryText(fs.content(target).body)
    if (text !== undefined && !text.trim()) invalid('Directory summary is empty.')
    return { level, target, previous, text }
  })
  const created = sidecars.every(item => item.previous === undefined)
  const selected = sidecars.filter(item => item.previous || (created && item.level === 0))
  for (const item of selected) if (!item.previous?.dimensions) fs.acl.authorize(item.target, 'write')
  const indexes = new Map<number, VectorIndex>()
  for (const item of selected) if (!item.previous?.dimensions) {
    fs.ctx.assertActive?.()
    indexes.set(item.level, await documentIndex(fs.ctx, item.text ?? fallback))
  }
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => {
    fs.ctx.assertActive?.()
    if (fs.require(root, 'write').revision !== directory.revision || sidecars.some(item =>
      fs.entry(item.target)?.revision !== item.previous?.revision)) conflict('Directory summaries changed while indexing.')
    for (const item of selected) {
      const index = indexes.get(item.level)
      if (!index) continue
      if (!item.previous) fs.storeFile(item.target, fallback, textSize(fallback), index, [])
      else fs.putIndex(item.target, index)
    }
    return ok({ uri: root.uri, created_abstract: created, indexed_levels: selected.map(item => item.level), vector_status: 'complete' })
  })
}

export async function reindex(fs: Filesystem, request: Request): Promise<Response> {
  const start = Date.now()
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri mode force wait recursive tags tag_mode')
  transport(body)
  const mode = processingMode(body.mode ?? 'vectors_only')
  const force = bool(body.force, 'force')
  const recursive = bool(body.recursive, 'recursive', true)
  const patch = tagMode(body.tag_mode)
  const tags = body.tags != null || patch === 'clear' ? parseTags(body.tags) : undefined
  const path = fs.path(body.uri)
  if (fs.caller.role !== 'admin' && path.parts[0] !== 'user') denied('A standard user may only reindex their own user namespace.')
  if (path.space === null || path.space === SYSTEM_COMPILE || path.managed && path.kind !== 'skill') invalid('Target is not a supported reindex scope.')
  const root = path as Scoped
  const inventory = () => {
    const entry = fs.require(root, 'write')
    const items = !entry.is_dir ? [entry] : recursive ? fs.storedEntries(root, 'write') :
      [entry, ...(['abstract', 'overview'] as const).flatMap(level => {
        const target = summaryPath(fs, root, level)
        const sidecar = target && fs.entry(target, 'write')
        return sidecar ? [sidecar] : []
      })]
    const rows = items.sort((a, b) => compare(a.uri, b.uri))
    return { entry, rows, stamp: `${entry.revision}:${rows.map(item => item.revision).join(',')}` }
  }
  const before = inventory()
  const candidates = before.rows.filter(row => !row.is_dir && !(root.kind === 'skill' && nameOf(row.uri) === '.source.json') &&
    (row.derived_from == null && row.derived_version == null || !!fs.previewEntry(fs.path(row.uri))))
  let levels: Awaited<ReturnType<typeof prepareLevels>> = []
  if (mode === 'semantic_and_vectors' && fs.ctx.generate && !before.entry.is_dir && admitsFileLevels(root)) {
    assertPendingClear(fs.ctx, root)
    fs.acl.authorize(fs.parent(root), 'read')
    const source = fs.content(root).body
    if (source.trim()) levels = await prepareLevels(fs.ctx, nameOf(root.uri), source, async () => {
      await fs.ctx.reauthorize?.()
      fs.ctx.assertActive?.()
      fs.acl.authorize(fs.parent(root), 'read')
      if (inventory().stamp !== before.stamp) conflict('The analysis source changed while generating.')
    })
  }
  const changes = candidates.filter(row => force || !row.dimensions || levels.length > 0)
  if (changes.length > 256 || changes.reduce((n, row) => n + row.bytes, 0) > 2 * 1024 * 1024) quota('Reindex a smaller subtree.')
  const inputs = changes.map(row => {
    const target = fs.path(row.uri) as Scoped
    const content = fs.content(target).body
    const level = sidecarLevel(target.uri)
    const text = level < 2 ? summaryText(content) : content
    if (level < 2 && !text.trim()) invalid('Directory summary is empty.')
    return { target, text, derived: row.derived_from != null || row.derived_version != null }
  })
  const indexed: Array<{ target: Scoped; index: VectorIndex; derived: boolean }> = []
  for (const input of inputs) {
    fs.ctx.assertActive?.()
    indexed.push({ target: input.target, index: await documentIndex(fs.ctx, input.text), derived: input.derived })
  }
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => {
    fs.ctx.assertActive?.()
    if (inventory().stamp !== before.stamp) conflict('The reindex scope changed while embedding.')
    for (const item of indexed) if (item.derived) fs.require(item.target)
    for (const { target } of indexed) fs.clearIndex(target)
    for (const { target, index } of indexed) fs.putIndex(target, index)
    if (levels.length) publishFileLevels(fs, root, before.entry, levels)
    if (tags) {
      // Directory summary records derive their tags from the canonical directory.
      const target = fs.require(root, 'write')
      if (root.builtin || root.managed) writable(root, fs.caller)
      fs.updateTags(root, target, mergeTags(tagsOf(target), tags, patch))
    }
    return ok({ status: 'completed', uri: root.uri, object_type: root.kind, mode,
      scanned_records: candidates.length, rebuilt_records: indexed.filter(item => item.index.dimensions > 0).length + levels.length,
      deleted_records: changes.filter((row, i) => row.dimensions > 0 && !indexed[i].index.dimensions).length,
      unsupported_records: 0, failed_records: 0, duration_ms: Date.now() - start,
      warnings: mode === 'semantic_and_vectors' && !levels.length ? ['Existing summaries were preserved; no new semantic summaries were generated.'] : [] })
  })
}
