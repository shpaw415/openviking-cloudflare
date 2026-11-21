// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { prepareSubtreeMutation, subtreeRevision } from '../filesystem.js'
import type { SubtreeEntry } from '../fs/subtree.js'
import { SHARED_SKILLS, compare, conflict, denied, encoder, fromParts, inPath, invalid, mergeTags, quota, relative } from '../fs/contract.js'
import type { FsPath } from '../fs/contract.js'
import { Filesystem, tagsOf } from '../fs/store.js'
import type { Entry } from '../fs/store.js'
import { exampleRoot, recipeMarkdown, recipes, sha256, targetPath } from './input.js'
import type { Inputs } from './input.js'

type MutablePath = FsPath & { space: string }
export type Document = { uri: string; text: string; revision: string }
export type Digest = { uri: string; sha256: string }
const sourceBudget = 20_000
const maximumFiles = 24

// All URIs go through the FS path classifier and/or facade first. No storage
// table for files, vectors, or ACLs is accessed by Compile.
export class CompileFiles {
  readonly fs: Filesystem
  constructor(readonly ctx: WorkspaceContext) { this.fs = new Filesystem(ctx) }

  get caller() { return this.ctx.caller }
  get acl() { return this.fs.acl }
  path(uri: string) { return this.fs.path(uri) }

  entry(uri: string): Entry | undefined {
    const path = this.path(uri)
    return this.fs.entry(path)
  }

  canRead(uri: string): boolean {
    return this.acl.allows(this.path(uri), 'read')
  }

  ensureRead(uri: string, directory?: boolean): Entry {
    const path = this.path(uri)
    const item = this.fs.require(path)
    if (directory !== undefined && !!item.is_dir !== directory) {
      invalid(directory ? 'Expected a source directory.' : 'Expected a plain-text file.')
    }
    return item
  }

  directory(uri: string): Entry[] {
    const root = this.path(uri)
    this.ensureRead(uri, true)
    return this.fs.entries(root).filter(entry => entry.uri !== uri)
  }

  read(uri: string, root?: FsPath, maxBytes = sourceBudget): Document {
    const item = this.ensureRead(uri, false)
    if (item.bytes > maxBytes) quota('The input text exceeds the Compile budget.')
    const path = this.path(uri)
    if (root?.space === 'shared') this.publicSource(path)
    return { uri: path.uri, text: this.fs.read(path.uri), revision: item.revision }
  }

  private publicSource(path: FsPath): void {
    if (path.space === SHARED_SKILLS) return // Account-readable Skill definitions, not private agent files.
    if (path.space !== 'shared') denied('Shared Compile output requires account-readable shared source files.')
    for (let depth = 1; depth <= path.parts.length; depth++) {
      const ancestor = fromParts(path.parts.slice(0, depth), this.caller)
      if (!this.acl.resolve(ancestor).effective_entries.some(entry => entry.principal === 'user:*')) {
        denied('Shared Compile output requires account-readable shared sources and their directories.')
      }
    }
  }

  skill(uri: string): Document {
    if (uri.startsWith(exampleRoot + '/')) {
      const name = uri.slice(exampleRoot.length + 1)
      const description = recipes.get(name)
      if (!description) invalid('Unknown built-in Compile Skill.')
      return { uri: uri + '/SKILL.md', text: recipeMarkdown(name, description), revision: 'native-v1' }
    }
    this.ensureRead(uri, true)
    const doc = this.read(`${uri}/SKILL.md`, undefined, 8192)
    if (!doc.text.trim()) invalid('The Compile Skill is empty.')
    return doc
  }

  target(uri: string): MutablePath {
    const path = targetPath(uri, this.ctx)
    this.fs.check(path.uri, 'write')
    const existing = this.fs.entry(path)
    if (existing && !existing.is_dir) invalid('The Compile destination must be a directory.')
    return path
  }

  validate(inputs: Inputs): MutablePath {
    const target = this.target(inputs.to)
    for (const uri of inputs.from) {
      this.ensureRead(uri, true)
      if (target.space === 'shared') this.publicSource(this.path(uri))
    }
    this.skill(inputs.skill)
    return target
  }

  checkTargetLayout(path: MutablePath): void {
    this.target(path.uri)
    const read = this.acl.reader()
    for (let depth = 1; depth < path.parts.length; depth++) {
      const parent = fromParts(path.parts.slice(0, depth), this.caller)
      if (parent.space !== path.space || !read(parent.uri)) continue
      const item = this.fs.entry(parent)
      if (item && tagsOf(item).includes('compile_target=true')) conflict('Compile target overlaps an existing Compile directory.')
    }
    if (this.fs.entry(path) && this.directory(path.uri).some(item => item.is_dir && tagsOf(item).includes('compile_target=true'))) {
      conflict('Compile target overlaps an existing Compile directory.')
    }
  }

  tagTarget(path: MutablePath): void {
    this.checkTargetLayout(path)
    for (let depth = 1; depth <= path.parts.length; depth++) {
      const parent = fromParts(path.parts.slice(0, depth), this.caller)
      if (parent.space !== path.space || parent.builtin) continue
      if (!this.fs.entry(parent)) {
        this.fs.check(parent.uri, 'write')
        this.fs.mkdir(parent as MutablePath, '')
      }
    }
    const current = this.fs.require(path)
    if (!current.is_dir) invalid('The Compile destination must be a directory.')
    const previous = tagsOf(current)
    if (!previous.includes('compile_target=true')) {
      this.fs.updateTags(path, current, mergeTags(previous, ['compile_target=true'], 'append'))
    }
  }

  corpus(roots: string[], allowFiles: boolean, target?: FsPath): Document[] {
    const selected = new Set<string>()
    const visibleText = (uri: string, root: string) => !uri.slice(root.length + 1).split('/').some(part => part.startsWith('.')) &&
      !/\.(?:js|ts|py)$/iu.test(uri)
    for (const root of roots) {
      const entry = this.ensureRead(root, allowFiles ? undefined : true)
      const group = entry.is_dir ? this.directory(root).filter(file => !file.is_dir && visibleText(file.uri, root)) : [entry]
      if (!group.length) invalid('A source has no readable text files.')
      if (!entry.is_dir && !visibleText(root, '')) invalid('A source is not a supported text document.')
      group.forEach(file => selected.add(file.uri))
      if (selected.size > maximumFiles) quota('Compile accepts at most 24 text source files.')
    }
    let remaining = sourceBudget
    const documents = [...selected].sort(compare).map(uri => {
      const doc = this.read(uri, target, remaining)
      remaining -= encoder.encode(doc.text).length
      return doc
    }).filter(doc => doc.text.trim())
    if (roots.length && !documents.length) invalid('Source material is blank.')
    return documents
  }

  checkDocuments(documents: Document[], target?: FsPath): void {
    for (const doc of documents) {
      if (doc.uri.startsWith(exampleRoot + '/')) continue
      const current = this.entry(doc.uri)
      if (current?.revision !== doc.revision) conflict('An input changed before publication.')
      if (target?.space === 'shared') this.publicSource(this.path(doc.uri))
    }
  }

  checkCorpus(roots: string[], original: Document[], allowFiles: boolean, target?: FsPath): void {
    const current = this.corpus(roots, allowFiles, target)
    if (current.length !== original.length || current.some((doc, i) => doc.uri !== original[i].uri || doc.revision !== original[i].revision)) {
      conflict('The source corpus changed before publication.')
    }
  }

  subtree(uri: string): Entry[] {
    const root = this.entry(uri)
    if (!root) return []
    if (!root.is_dir) invalid('Expected a destination directory.')
    return [root, ...this.directory(uri)].sort((a, b) => compare(a.uri, b.uri))
  }

  guardSubtree(uri: string, initial: Entry[]): void {
    const current = this.subtree(uri)
    if (current.length !== initial.length || current.some((item, i) => item.uri !== initial[i].uri || item.revision !== initial[i].revision)) {
      conflict('The destination changed during generation; retry the job.')
    }
  }

  async prepare(rootUri: string, writes: ReadonlyMap<string, string>, deletes: string[] = [], markTarget = false) {
    // When a parent is missing, begin at the first nonexistent ancestor. The
    // plan touches only the necessary ancestor directories and scoped outputs.
    let anchor = this.path(rootUri)
    while (!this.fs.entry(this.fs.parent(anchor))) anchor = this.fs.parent(anchor)
    const expectedRevision = subtreeRevision(this.fs, anchor.uri)
    const entries = new Map<string, SubtreeEntry>()
    const localPath = (uri: string) => uri === anchor.uri ? '' : relative(uri, anchor.uri)
    const directories = (end: FsPath) => {
      for (let n = anchor.parts.length; n <= end.parts.length; n++) {
        const path = fromParts(end.parts.slice(0, n), this.caller)
        const row = this.fs.entry(path)
        if (row && !row.is_dir) conflict('An artifact parent exists as a file.')
        const isTarget = markTarget && path.uri === rootUri
        if (row && (!isTarget || tagsOf(row).includes('compile_target=true'))) continue
        const tags = row ? tagsOf(row) : []
        entries.set(path.uri, { path: localPath(path.uri), is_dir: true, description: row?.description ?? '',
          tags: isTarget ? mergeTags(tags, ['compile_target=true'], 'append') : tags })
      }
    }
    for (const [uri, content] of writes) {
      if (uri === rootUri || !inPath(uri, rootUri)) invalid('The proposed output is outside the compilation target.')
      const path = this.path(uri)
      directories(this.fs.parent(path))
      const old = this.fs.entry(path)
      if (old?.is_dir || entries.get(uri)?.is_dir) conflict('An artifact would replace a directory.')
      entries.set(uri, { path: localPath(uri), is_dir: false, content, description: old?.description ?? '', tags: old ? tagsOf(old) : [] })
    }
    if (markTarget) directories(this.path(rootUri))
    for (const uri of deletes) if (uri === rootUri || !inPath(uri, rootUri)) invalid('Invalid artifact deletion.')
    return prepareSubtreeMutation(this.fs, anchor.uri, { expectedRevision, entries: [...entries.values()], delete: deletes.map(localPath) })
  }
}

export async function digests(docs: Document[]): Promise<Digest[]> {
  return Promise.all(docs.map(async ({ uri, text }) => ({ uri, sha256: await sha256(text) })))
}

export function relativeOutput(path: unknown, root: string): string {
  if (typeof path !== 'string') invalid('An artifact path must be relative to the destination.')
  const parts = path.split('/')
  if (parts.length > 5 || !parts.every(part => /^[\p{L}\p{N}_-][\p{L}\p{N}_. -]{0,79}$/u.test(part) && part.trim() === part) ||
      !/\.(md|txt)$/iu.test(path)) invalid('Only bounded relative .md and .txt artifact paths are accepted.')
  const uri = `${root}/${parts.map(part => part.normalize('NFC')).join('/')}`
  if (!inPath(uri, root) || encoder.encode(uri).length > 1024) invalid('Artifact path leaves the destination or exceeds the FS limit.')
  return uri
}
