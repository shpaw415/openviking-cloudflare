// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, ok } from '../http.js'
import { mountDataAuthority } from '../data-authority.js'
import { checkJsonText, documentUrl, urlFileName, urlSourceUnavailable } from '../url-source.js'
import { bool, conflict, filename, invalid, nameOf, onlyKeys, resourcePath, str, textSize, transport, unsupported, writable } from './contract.js'
import { processingMode } from './content.js'
import { ensureParentPlan, nextResourceLeaf } from './import-target.js'
import { assertPendingClear, pendingFor, release, reserve } from './pending.js'
import { tagsOf } from './store.js'
import type { Filesystem } from './store.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'

export const isOneShotUrlImport = (body: Record<string, unknown>) =>
  typeof body.path === 'string' && /^https?:\/\//i.test(body.path) && (body.watch_interval == null || body.watch_interval === 0)

export async function importUrl(fs: Filesystem, body: Record<string, unknown>): Promise<Response> {
  onlyKeys(body, 'path to to_uri uri parent create_parent reason wait timeout telemetry watch_interval strict processing_mode args')
  transport(body)
  bool(body.strict, 'strict') // A single document is always all-or-nothing.
  const url = documentUrl(body.path)
  const source = fs.ctx.urlSource
  if (!source) unsupported('One-time URL import is not mounted on this server.')
  if (!source.allows(url.href)) throw urlSourceUnavailable()
  if (!fs.ctx.hasEmbedding) throw embeddingUnavailable()
  if (body.args != null && (!isRecord(body.args) || Object.keys(body.args).some(key => key !== 'parse_mode') ||
      ![undefined, 'default', 'no_split'].includes(body.args.parse_mode as string | undefined))) {
    unsupported('URL import preserves one text body; crawler, connector and parser options are not available.')
  }
  const destinations = [body.to, body.to_uri, body.uri].filter(value => value != null && value !== '')
  if (new Set(destinations).size > 1) invalid('Supply one exact destination URI.')
  const toArg = str(destinations[0], 'to', '')
  const parentArg = str(body.parent ?? undefined, 'parent', '')
  if (toArg && parentArg) invalid('Specify to or parent, not both.')
  const to = toArg ? fs.path(toArg) : undefined
  const parent = to ? fs.parent(to) : fs.path(parentArg || 'viking://resources')
  if (to) {
    resourcePath(to)
    if (toArg.endsWith('/')) invalid('The exact URL import destination must be a text file, not a directory.')
    urlFileName(nameOf(to.uri))
  } else resourcePath(parent, true)
  const name = filename(nameOf(url.pathname))
  const create = bool(body.create_parent, 'create_parent')
  const processing = processingMode(body.processing_mode)
  const reason = str(body.reason ?? undefined, 'reason', '', 512)
  const authority = await mountDataAuthority(fs.ctx)
  const planImport = () => {
    const plan = ensureParentPlan(fs, parent, create)
    const leaf = to ? { path: to, warning: undefined } : nextResourceLeaf(fs, parent, name)
    const path = leaf.path
    writable(path, fs.caller)
    const previous = fs.entry(path, 'write')
    if (previous?.is_dir) conflict('The URL import target is a directory.')
    const target = plan.dirs[0] ?? path
    assertPendingClear(fs.ctx, target, true)
    fs.limits(path.space, plan.dirs.length + (previous ? 0 : 1))
    return { ...plan, ...leaf, path, target, previous,
      stamp: JSON.stringify([path.uri, previous?.revision, plan.anchor.uri, plan.revision, plan.dirs.map(dir => dir.uri)]) }
  }
  const before = planImport()
  const checkPlan = () => {
    const fresh = planImport()
    if (fresh.stamp !== before.stamp) conflict('The URL import destination changed; retry the import.')
    return fresh
  }
  if (body.wait === false && !fs.ctx.taskId) {
    if (!fs.ctx.jobs) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The URL import task queue is unavailable.')
    const task = await fs.ctx.jobs.enqueue('add_resource', before.path.uri, {
      body: { ...body, wait: true }, dataAuthorityRevision: authority.revision,
    }, {
      meta: { staged_atomic: true },
      onAccepted(task) {
        const plan = checkPlan()
        reserve(fs.ctx, task.task_id, plan.target, 'resource', plan.stamp, { subtree: true })
      },
    })
    return ok({ status: 'accepted', task_id: task.task_id, root_uri: before.path.uri, uri: before.path.uri })
  }
  if (fs.ctx.taskId) {
    if (!fs.ctx.finishJobInTransaction || !fs.ctx.assertActive) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The URL import consumer is not mounted.')
    fs.ctx.assertActive()
    const [reservation, extra] = pendingFor(fs.ctx, 'resource')
    if (!reservation || extra || reservation.upload_id !== null || reservation.uri !== before.target.uri ||
        reservation.space !== before.target.space || reservation.stamp !== before.stamp) conflict('The URL import reservation changed.')
  }
  const previousGuard = fs.ctx.assertActive
  // Recheck the local ACL and destination too, in the same turn as each
  // provider call (including each batch from documentIndex).
  fs.ctx.assertActive = () => { authority.assertCurrent(); checkPlan() }
  try {
    await fs.ctx.reauthorize?.()
    fs.ctx.assertActive()
    const text = await source.read(url.href)
    await fs.ctx.reauthorize?.()
    authority.assertCurrent()
    const admitted = checkPlan()
    if (before.path.uri.toLowerCase().endsWith('.json')) checkJsonText(text)
    const bytes = textSize(text)
    fs.limits(admitted.path.space, admitted.dirs.length + (admitted.previous ? 0 : 1), bytes - (admitted.previous?.bytes ?? 0))
    const changed = !admitted.previous?.dimensions || admitted.previous.derived_from != null ||
      (reason !== '' && reason !== admitted.previous.description) || fs.read(admitted.path.uri) !== text
    const index = changed ? await documentIndex(fs.ctx, text) : undefined
    await fs.ctx.reauthorize?.()
    return fs.atomic(() => {
      authority.assertCurrent()
      const plan = checkPlan()
      if (index) {
        for (const dir of plan.dirs) fs.mkdir(dir, '')
        fs.storeFile(plan.path, text, bytes, index, plan.previous ? tagsOf(plan.previous) : [], plan.previous, reason || plan.previous?.description)
      }
      const warnings = [plan.warning, processing === 'semantic_and_vectors' ? 'URL import indexes the document without generating summaries.' : undefined].filter(Boolean)
      const result = { status: 'success', uri: plan.path.uri, root_uri: plan.path.uri, changed, ...(warnings.length && { warnings }) }
      if (fs.ctx.taskId) {
        fs.ctx.finishJobInTransaction!(result)
        release(fs.ctx, fs.ctx.taskId)
      }
      return ok(result)
    })
  } finally { fs.ctx.assertActive = previousGuard }
}
