// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { aclSpec } from '../acl.js'
import type { AclEntry, AclSpec, DirectAcl } from '../acl.js'
import { absChild, compare, conflict, denied, filename, fromParts, inPath, invalid, missing, onlyKeys,
  parseTags, quota, relative, str, textFile, textSize, writable } from './contract.js'
import { tagsOf } from './store.js'
import type { Entry, Filesystem, Scoped, VectorIndex } from './store.js'
import { documentIndex } from './vectors.js'

export const SUBTREE_MAX_ENTRIES = 256
export const SUBTREE_MAX_BYTES = 2 * 1024 * 1024
const CAPTURE_MAX_ENTRIES = 512

export interface SubtreeEntry {
  path: string // Canonical relative URI, '' for the root.
  is_dir: boolean
  content?: string
  description: string
  tags: string[]
  acl?: AclSpec
}

export interface SubtreeCapture {
  version: 1
  root_uri: string
  revision: string | null
  entries: Array<SubtreeEntry & { acl?: DirectAcl; uri: string; bytes: number; node_id: string; revision: string; body?: string }>
  // Internal history authorization only. Neither this, nor entries[].acl,
  // belongs in a portable pack or ordinary file listing.
  guard: { account_id: string; space: string; entries: Array<{ path: string; node_id: string; read_acl?: AclEntry[] }> }
}

export interface SubtreeMutationPlan {
  expectedRevision: string | null
  entries: readonly SubtreeEntry[]
  delete?: readonly string[]
  replace?: boolean
}
export interface SubtreeMutationResult { uri: string; revision: string | null; restored_count: number }
declare const preparedBrand: unique symbol
export type PreparedSubtreeMutation = Readonly<{ uri: string; [preparedBrand]: true }>

function scope(fs: Filesystem, input: string): Scoped {
  const path = fs.path(input)
  if (path.space === null || path.managed) denied('A subtree must stay inside one writable filesystem mount.')
  return path as Scoped
}

function child(fs: Filesystem, path: Scoped, input: unknown): Scoped {
  const rel = str(input, 'subtree entry path', undefined, 1024)
  const target = rel ? fromParts([...path.parts, ...rel.split('/').map(filename)], fs.caller) : path
  if (target.space !== path.space || target.managed) denied('A subtree cannot cross a managed namespace or visibility mount.')
  return target as Scoped
}

function inspect(fs: Filesystem, root: Scoped, cap = SUBTREE_MAX_ENTRIES) {
  const head = fs.entry(root)
  if (!head) return { rows: [] as Entry[], revision: null }
  if (head.derived_from != null || head.derived_version != null) denied('Generated summaries are not independently archived.')
  const rows = fs.storedEntries(root).sort((a, b) => compare(a.uri, b.uri))
  if (rows.length + Number(root.builtin) > cap) quota('Subtree entry limit exceeded.')
  // Revisions are opaque and associated with sorted URI order, not a client hash.
  return { rows, revision: `v1:${rows.map(row => row.revision).join(',')}` }
}

export function subtreeRevision(fs: Filesystem, uri: string): string | null { return inspect(fs, scope(fs, uri)).revision }

export function captureSubtree(fs: Filesystem, uri: string,
  options: { allowMissing?: boolean; includeContent?: boolean; maxEntries?: number; maxBytes?: number } = {}): SubtreeCapture {
  const root = scope(fs, uri)
  const { rows, revision } = inspect(fs, root, Math.min(options.maxEntries ?? SUBTREE_MAX_ENTRIES, CAPTURE_MAX_ENTRIES))
  if (revision === null && !options.allowMissing) missing()
  if (root.builtin) rows.unshift(fs.require(root))
  if (rows.reduce((sum, row) => sum + row.bytes, 0) > Math.min(options.maxBytes ?? SUBTREE_MAX_BYTES, SUBTREE_MAX_BYTES)) quota('Subtree text limit exceeded.')
  const entries: SubtreeCapture['entries'] = [], guards: SubtreeCapture['guard']['entries'] = []
  for (const row of rows) {
    const path = fs.path(row.uri)
    const acl = path.space === 'shared' ? fs.acl.resolve(path) : undefined
    const rel = path.uri === root.uri ? '' : relative(path.uri, root.uri)
    const saved: SubtreeCapture['entries'][number] = { path: rel, is_dir: !!row.is_dir, description: row.description, tags: tagsOf(row),
      uri: row.uri, bytes: row.bytes, node_id: row.node_id, revision: row.revision }
    if (!row.is_dir && options.includeContent !== false) {
      saved.content = fs.content(path).body
      // Compatibility accessor for archive consumers, without duplicating text in JSON.
      Object.defineProperty(saved, 'body', { get: () => saved.content })
    }
    if (acl && !path.builtin) saved.acl = { acl_mode: acl.acl_mode, entries: acl.direct_entries }
    entries.push(saved)
    guards.push({ path: rel, node_id: row.node_id, ...(acl && { read_acl: acl.effective_entries }) })
  }
  return { version: 1, root_uri: root.uri, revision, entries, guard: { account_id: fs.account, space: root.space, entries: guards } }
}

/** Only pass a capture from trusted snapshot storage, never a client-asserted guard. */
export function authorizeHistoricalRead(fs: Filesystem, capture: SubtreeCapture): void {
  if (capture?.version !== 1 || capture.guard?.account_id !== fs.account) denied('Historical subtree is outside the current account.')
  const root = scope(fs, capture.root_uri)
  if (root.uri !== capture.root_uri || capture.guard.space !== root.space || !Array.isArray(capture.entries) ||
      !Array.isArray(capture.guard.entries) || !capture.entries.length || capture.entries.length > CAPTURE_MAX_ENTRIES ||
      capture.entries.length !== capture.guard.entries.length) denied('Historical subtree policy is unavailable.')
  const seen = new Set<string>()
  for (const [i, saved] of capture.guard.entries.entries()) {
    if (typeof saved?.node_id !== 'string' || saved.path !== capture.entries[i]?.path) denied('Historical subtree policy is unavailable.')
    const path = child(fs, root, saved.path)
    if (seen.has(path.uri)) denied('Historical subtree policy is unavailable.')
    seen.add(path.uri)
    if (path.space !== 'shared' || fs.caller.role === 'admin') continue
    const current = fs.entry(path)
    // Do not fall back to the parent ACL if the archived incarnation vanished.
    if (!Array.isArray(saved.read_acl) || !fs.acl.allowsGrants(saved.read_acl, 'read') || !current ||
        (!path.builtin && !saved.node_id) || current.node_id !== saved.node_id) denied('Historical resource is not readable.')
  }
  if (!seen.has(root.uri)) denied('Historical subtree policy is unavailable.')
}

type Upsert = { path: Scoped; entry: SubtreeEntry; bytes: number; previous?: Entry; acl?: AclSpec }
type Checked = { root: Scoped; removals: Scoped[]; upserts: Upsert[]; anchorRevision: string | undefined }
type Prepared = { fs: Filesystem; root: Scoped; plan: SubtreeMutationPlan; vectors: Map<string, VectorIndex>; anchorRevision: string | undefined }
const prepared = new WeakMap<PreparedSubtreeMutation, Prepared>()

function normalize(fs: Filesystem, root: Scoped, supplied: SubtreeMutationPlan): SubtreeMutationPlan {
  if (!isRecord(supplied) || (supplied.expectedRevision !== null && typeof supplied.expectedRevision !== 'string') ||
      !Array.isArray(supplied.entries) || (supplied.delete !== undefined && !Array.isArray(supplied.delete)) ||
      (supplied.replace !== undefined && typeof supplied.replace !== 'boolean')) invalid('Expected a subtree mutation with a compare-and-swap revision.')
  if (supplied.entries.length + (supplied.delete?.length ?? 0) > SUBTREE_MAX_ENTRIES) quota('Subtree mutation entry limit exceeded.')
  let bytes = 0
  const upserts = supplied.entries.map(value => {
    if (!isRecord(value) || typeof value.is_dir !== 'boolean') invalid('Invalid subtree entry.')
    onlyKeys(value, 'path is_dir content description tags acl')
    const path = child(fs, root, value.path)
    const rel = path.uri === root.uri ? '' : relative(path.uri, root.uri)
    const description = str(value.description, 'description', '', 512)
    const tags = parseTags(value.tags)
    const acl = aclSpec(value.acl)
    if (value.is_dir) {
      if (value.content !== undefined) invalid('A directory has no content field.')
      if (path.builtin && (description || tags.length || acl)) denied('Mount metadata is immutable.')
      return { path: rel, is_dir: true, description, tags, ...(acl && { acl }) }
    }
    writable(path, fs.caller)
    textFile(path.parts.at(-1)!)
    const content = str(value.content, 'content', undefined, SUBTREE_MAX_BYTES)
    bytes += textSize(content)
    if (bytes > SUBTREE_MAX_BYTES) quota('Subtree text limit exceeded.')
    return { path: rel, is_dir: false, content, description, tags, ...(acl && { acl }) }
  })
  const remove = (supplied.delete ?? []).map(value => {
    const target = child(fs, root, value)
    writable(target, fs.caller)
    return target.uri === root.uri ? '' : relative(target.uri, root.uri)
  })
  return { expectedRevision: supplied.expectedRevision, entries: upserts, delete: remove, replace: supplied.replace }
}

function checkPlan(fs: Filesystem, root: Scoped, plan: SubtreeMutationPlan): Checked {
  const state = inspect(fs, root)
  if (plan.expectedRevision !== state.revision) conflict('The subtree revision changed.')
  const old = new Map(state.rows.map(row => [row.uri, row]))
  const desired = new Map<string, { path: Scoped; entry: SubtreeEntry }>()
  for (const entry of plan.entries) {
    const path = child(fs, root, entry.path)
    if (desired.has(path.uri)) invalid('Duplicate subtree entry.')
    desired.set(path.uri, { path, entry })
  }
  const explicit = (plan.delete ?? []).map(rel => child(fs, root, rel))
  const removes = state.rows.filter(row => (plan.replace && !desired.has(row.uri)) || explicit.some(path => inPath(row.uri, path.uri)))
  const removed = new Set(removes.map(row => row.uri))
  for (const row of removes) fs.check(row.uri, 'manage')
  const removals = removes.filter(row => !removed.has(fs.parent(fs.path(row.uri)).uri)).map(row => fs.path(row.uri) as Scoped)
  const finalIsDir = (uri: string) => desired.has(uri) ? desired.get(uri)!.entry.is_dir :
    !removed.has(uri) && (uri === root.uri && root.builtin || !!old.get(uri)?.is_dir)
  for (const uri of [...old.keys(), ...desired.keys()]) {
    if (uri === root.uri || (removed.has(uri) && !desired.has(uri))) continue
    if (!finalIsDir(fs.parent(fs.path(uri)).uri)) conflict('A planned subtree node has no final directory parent.')
  }
  const upserts: Upsert[] = []
  for (const { path, entry } of desired.values()) {
    if (path.builtin) continue
    writable(path, fs.caller)
    fs.acl.authorize(path, 'write')
    const current = old.get(path.uri)
    const previous = removed.has(path.uri) ? undefined : current
    if (previous && !!previous.is_dir !== entry.is_dir) conflict('Changing node type requires a planned deletion first.')
    if (!previous) {
      let parent = fs.parent(path)
      while (desired.has(parent.uri) && (!old.has(parent.uri) || removed.has(parent.uri)) && !parent.builtin) parent = fs.parent(parent)
      fs.requireDir(parent, 'write')
    }
    let acl = entry.acl
    if (acl && previous && path.space === 'shared') {
      const old = fs.acl.resolve(path)
      if ((acl.acl_mode === undefined || acl.acl_mode === old.acl_mode) &&
          (acl.entries === undefined || JSON.stringify(acl.entries) === JSON.stringify(old.direct_entries))) acl = undefined
    }
    fs.acl.prepare(path, acl)
    upserts.push({ path, entry, bytes: entry.is_dir ? 0 : textSize(entry.content!), previous, acl })
  }
  upserts.sort((a, b) => a.path.parts.length - b.path.parts.length || compare(a.path.uri, b.path.uri))
  if (old.size - removed.size + upserts.filter(item => !item.previous).length + Number(root.builtin) > SUBTREE_MAX_ENTRIES) {
    quota('Subtree entry limit exceeded.')
  }
  fs.limits(root.space, upserts.filter(item => !item.previous).length - removed.size,
    upserts.reduce((sum, item) => sum + item.bytes - (item.previous?.bytes ?? 0), 0) - removes.reduce((sum, row) => sum + row.bytes, 0))
  const anchorRevision = state.revision === null && upserts.length ? fs.checkWriteParent(root.uri).revision : undefined
  return { root, removals, upserts, anchorRevision }
}

export function validateSubtreeMutation(fs: Filesystem, uri: string, supplied: SubtreeMutationPlan): void {
  const root = scope(fs, uri)
  checkPlan(fs, root, normalize(fs, root, supplied))
}

export async function prepareSubtreeMutation(fs: Filesystem, uri: string, supplied: SubtreeMutationPlan): Promise<PreparedSubtreeMutation> {
  const root = scope(fs, uri)
  const plan = normalize(fs, root, supplied)
  const checked = checkPlan(fs, root, plan)
  const vectors = new Map<string, VectorIndex>()
  for (const item of checked.upserts) {
    fs.ctx.assertActive?.()
    if (!item.entry.is_dir) vectors.set(item.path.uri, await documentIndex(fs.ctx, item.entry.content!))
  }
  await fs.ctx.reauthorize?.()
  fs.ctx.assertActive?.()
  const opaque = Object.freeze({ uri: root.uri }) as PreparedSubtreeMutation
  prepared.set(opaque, { fs, root, plan, vectors, anchorRevision: checked.anchorRevision })
  return opaque
}

export function commitSubtreeMutations(fs: Filesystem, plans: readonly PreparedSubtreeMutation[],
  after?: (result: SubtreeMutationResult[]) => void): SubtreeMutationResult[] {
  if (plans.length < 1 || plans.length > 16) invalid('Expected between 1 and 16 prepared subtrees.')
  const work = plans.map(plan => {
    const value = prepared.get(plan)
    if (!value || value.fs !== fs) invalid('Subtree plan is not prepared in this filesystem context.')
    return value
  })
  for (const [i, value] of work.entries()) {
    if (work.slice(0, i).some(other => inPath(value.root.uri, other.root.uri) || inPath(other.root.uri, value.root.uri))) invalid('Prepared subtrees overlap.')
  }
  const result = fs.atomic(() => {
    fs.ctx.assertActive?.()
    const checked = work.map(value => {
      const current = checkPlan(fs, value.root, value.plan)
      if (current.anchorRevision !== value.anchorRevision) conflict('The parent changed while indexing.')
      return current
    })
    for (const tree of checked) for (const path of tree.removals) fs.remove(path, true)
    const out = checked.map(({ root, upserts }, i) => {
      for (const { path, entry, bytes, previous } of upserts) {
        if (entry.is_dir) {
          if (!previous) fs.mkdir(path, entry.description)
          fs.updateDirectory(path, entry.description, entry.tags)
        } else fs.storeFile(path, entry.content!, bytes, work[i].vectors.get(path.uri)!, entry.tags, previous, entry.description)
      }
      const revision = inspect(fs, root).revision
      // Publish direct ACLs only after all descendants have been written, so a
      // restrictive ACL cannot turn its own authorized batch into a partial write.
      for (const { path, acl } of upserts) if (acl) fs.acl.apply(path, acl, false)
      return { uri: root.uri, revision, restored_count: upserts.length }
    })
    const callbackResult = after?.(out) as unknown
    if (typeof (callbackResult as PromiseLike<unknown> | undefined)?.then === 'function') invalid('Subtree transaction callback must be synchronous.')
    return out
  })
  for (const plan of plans) prepared.delete(plan)
  return result
}

export function commitSubtreeMutation(fs: Filesystem, plan: PreparedSubtreeMutation,
  after?: (result: SubtreeMutationResult) => void): SubtreeMutationResult {
  return commitSubtreeMutations(fs, [plan], after ? ([result]) => after(result) : undefined)[0]
}

export async function restoreSubtree(fs: Filesystem, uri: string, capture: SubtreeCapture,
  expectedRevision: string | null): Promise<SubtreeMutationResult> {
  if (fs.path(uri).uri !== capture.root_uri) invalid('A snapshot can only be restored to its original URI.')
  authorizeHistoricalRead(fs, capture)
  const entries = capture.entries.map(({ path, is_dir, content, description, tags, acl }) =>
    ({ path, is_dir, content, description, tags, acl }))
  const plan = await prepareSubtreeMutation(fs, uri, { expectedRevision, entries, replace: true })
  authorizeHistoricalRead(fs, capture)
  return commitSubtreeMutation(fs, plan)
}
