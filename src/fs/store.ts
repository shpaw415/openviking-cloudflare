// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { ResourceAcl, initAcl } from '../acl.js'
import type { AclLevel, AclSpec, DirectAcl } from '../acl.js'
import {
  ROOT, SHARED_SKILLS, SYSTEM_COMPILE, absChild, compare, conflict, denied, exists, fromParts, inPath, missing, nameOf, pathFor,
  quota, relative, roots, spaces, str, textFile, textSize, writable,
} from './contract.js'
import type { FsPath } from './contract.js'
import { documentIndex } from './vectors.js'
import { initSkillStorage } from './skill-store.js'
import { exampleEntries } from './compile-catalog.js'
import { assertPendingClear, initPending } from './pending.js'
import { clearFileLevels, initFileLevels } from './file-levels.js'

export const ACCOUNT_ENTRIES = 1500
export const ACCOUNT_BYTES = 16 * 1024 * 1024
export const ACCOUNT_VECTOR_BYTES = 24 * 1024 * 1024
const PRIVATE_ENTRIES = 400
const PRIVATE_BYTES = 4 * 1024 * 1024
const PRIVATE_VECTOR_BYTES = 6 * 1024 * 1024

export function initFilesystem({ sql }: WorkspaceContext): void {
  // The caller may already be inside transactionSync. No actor-specific roots are written here.
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_entry (
    account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    is_dir INTEGER NOT NULL CHECK (is_dir IN (0,1)),
    body TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
    dimensions INTEGER NOT NULL DEFAULT 0, vectors BLOB,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision TEXT NOT NULL, node_id TEXT NOT NULL DEFAULT '',
    content_version TEXT NOT NULL DEFAULT '', derived_from TEXT, derived_version TEXT,
    PRIMARY KEY (account_id, space, uri),
    CHECK ((dimensions = 0 AND vectors IS NULL) OR (dimensions > 0 AND length(vectors) > 0
      AND length(vectors) % (4 * dimensions) = 0)),
    CHECK (is_dir = 0 OR (bytes = 0 AND vectors IS NULL))
  ) WITHOUT ROWID`)
  // Existing edge alpha data has no stable creation/incarnation identifier.
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(ov_edge_fs_entry)').toArray().map(column => column.name))
  if (!columns.has('node_id')) {
    sql.exec("ALTER TABLE ov_edge_fs_entry ADD COLUMN node_id TEXT NOT NULL DEFAULT ''")
    sql.exec('UPDATE ov_edge_fs_entry SET node_id=revision')
  }
  if (!columns.has('content_version')) sql.exec("ALTER TABLE ov_edge_fs_entry ADD COLUMN content_version TEXT NOT NULL DEFAULT ''")
  if (!columns.has('derived_from')) sql.exec('ALTER TABLE ov_edge_fs_entry ADD COLUMN derived_from TEXT')
  if (!columns.has('derived_version')) sql.exec('ALTER TABLE ov_edge_fs_entry ADD COLUMN derived_version TEXT')
  initFileLevels(sql)
  initAcl(sql)
  initSkillStorage(sql)
  initPending(sql)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_upload (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    id TEXT NOT NULL, name TEXT NOT NULL, original_name TEXT, body TEXT NOT NULL, bytes INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, user_id, agent_id, id)
  ) WITHOUT ROWID`)
  if (!sql.exec<{ name: string }>('PRAGMA table_info(ov_edge_fs_upload)').toArray().some(column => column.name === 'original_name')) {
    sql.exec('ALTER TABLE ov_edge_fs_upload ADD COLUMN original_name TEXT')
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_edge_fs_upload_expiry ON ov_edge_fs_upload(account_id, expires_at)`)
}

export const metadata = `uri, is_dir, bytes, description, tags, dimensions, coalesce(length(vectors),0) AS vector_bytes,
  created_at, updated_at, revision, node_id, content_version, derived_from, derived_version`

export type Entry = {
  uri: string
  is_dir: number
  bytes: number
  description: string
  tags: string
  dimensions: number
  vector_bytes: number
  created_at: number
  updated_at: number
  revision: string
  node_id: string
  content_version?: string
  derived_from?: string | null
  derived_version?: string | null
}

type Content = { body: string; is_dir: number }
type SummaryDependency = { uri: string; version: string }
type Derivation = Pick<Entry, 'derived_from' | 'derived_version'>
export type VectorIndex = { dimensions: number; vectors: ArrayBuffer | null }
export const emptyIndex: VectorIndex = { dimensions: 0, vectors: null }
export const tagsOf = (entry: Entry): string[] => JSON.parse(entry.tags) as string[]

export type Scoped = FsPath & { space: string }
type Usage = { entries: number; bytes: number; vector_bytes: number }
function usageQuery(filter = ''): string {
  return `SELECT count(*) AS entries, coalesce(sum(bytes),0) AS bytes, coalesce(sum(vector_bytes),0) AS vector_bytes FROM (
    SELECT bytes,length(vectors) AS vector_bytes FROM ov_edge_fs_entry WHERE account_id=? ${filter}
    UNION ALL SELECT bytes,length(vectors) AS vector_bytes FROM ov_edge_fs_file_level WHERE account_id=? ${filter})`
}

function virtual(path: FsPath): Entry {
  return { uri: path.uri, is_dir: 1, bytes: 0, description: '', tags: '[]', dimensions: 0,
    vector_bytes: 0, created_at: 0, updated_at: 0, revision: '', node_id: '' }
}

function range(base: string): [string, string, string] { return [base, `${base}/`, `${base}0`] }
const within = '(uri = ? OR (uri >= ? AND uri < ?))'

export class Filesystem {
  readonly acl: ResourceAcl
  constructor(readonly ctx: WorkspaceContext) { this.acl = new ResourceAcl(ctx) }
  get caller() { return this.ctx.caller }
  get sql() { return this.ctx.sql }
  get account() { return this.caller.accountId }

  atomic<T>(run: () => T): T { return this.ctx.storage.transactionSync(run) }

  path(uri: unknown): FsPath { return pathFor(uri, this.caller) }

  check(uri: string, action: AclLevel): void {
    const path = this.path(uri)
    if (action !== 'read') writable(path, this.caller)
    this.acl.authorize(path, action)
    if (action === 'read') this.requireReadableSummary(path)
  }

  checkWriteParent(uri: string): Entry {
    const path = this.path(uri)
    writable(path, this.caller)
    return this.fileParent(path, false)
  }

  stat(uri: string): Entry { return this.require(this.path(uri)) }

  list(uri: string, recursive = false): Entry[] {
    const path = this.path(uri)
    this.requireDir(path)
    return this.entries(path).filter(entry => absChild(entry.uri, path.uri) && (recursive || !relative(entry.uri, path.uri).includes('/')))
  }

  read(uri: string): string { return this.content(this.path(uri)).body }

  createDirectory(uri: string, description = ''): Entry {
    const path = this.path(uri)
    writable(path, this.caller)
    return this.atomic(() => this.mkdir(path, str(description, 'description', '', 512)))
  }

  async putText(uri: string, text: string, options: { mode?: 'create' | 'replace' | 'append'; expectedRevision?: string | null } = {}): Promise<Entry> {
    const path = this.path(uri)
    writable(path, this.caller)
    textFile(nameOf(path.uri))
    const previous = this.entry(path, 'write')
    assertPendingClear(this.ctx, path)
    const parentBefore = this.fileParent(path, !!previous)
    if (previous?.is_dir) conflict('The target is a directory.')
    if (options.expectedRevision !== undefined && (previous?.revision ?? null) !== options.expectedRevision) conflict('The file revision changed.')
    if (options.mode === 'create' && previous) exists()
    if (options.mode === 'append' && !previous) missing()
    if (options.mode === 'append' && (previous?.derived_from != null || previous?.derived_version != null)) {
      conflict('A generated summary cannot be appended to as authored content.')
    }
    const final = options.mode === 'append' ? this.content(path).body + text : text
    const bytes = textSize(final)
    this.limits(path.space, previous ? 0 : 1, bytes - (previous?.bytes ?? 0))
    const index = await documentIndex(this.ctx, final)
    await this.ctx.reauthorize?.()
    return this.atomic(() => {
      this.ctx.assertActive?.()
      const current = this.entry(path, 'write')
      if (current?.revision !== previous?.revision || this.fileParent(path, !!previous).revision !== parentBefore.revision) {
        conflict('The path changed while indexing.')
      }
      return this.storeFile(path, final, bytes, index, previous ? tagsOf(previous) : [], previous, previous?.description)
    })
  }

  deleteUri(uri: string, recursive = false): number {
    const path = this.path(uri)
    writable(path, this.caller)
    return this.atomic(() => this.remove(path, recursive))
  }

  copyMove(fromUri: string, toUri: string, { copy, recursive = false, overwrite = false }:
    { copy: boolean; recursive?: boolean; overwrite?: boolean }): { overwritten: boolean } {
    const from = this.path(fromUri), to = this.path(toUri)
    writable(from, this.caller)
    writable(to, this.caller)
    return { overwritten: this.atomic(() => this.transfer(from, to, copy, recursive, overwrite)) }
  }

  entry(path: FsPath, action: AclLevel = 'read'): Entry | undefined {
    this.acl.authorize(path, action)
    const row = this.rawEntry(path)
    if (row && action === 'read') {
      const status = this.summaryAccess(path, row)
      if (status === 'denied') denied('Source read permission is required for this directory summary.')
      if (status === 'stale') return
    }
    return row
  }

  private summaryAccess(path: FsPath, row: Derivation): 'readable' | 'denied' | 'stale' {
    if (row.derived_from == null && row.derived_version == null) return 'readable'
    if (!row.derived_from || !row.derived_version) return 'stale'
    const source = this.path(row.derived_from)
    const parent = this.parent(path)
    if (source.space !== path.space || source.uri === path.uri || this.parent(source).uri !== parent.uri) return 'stale'
    if (!this.acl.allows(parent, 'read') || !this.acl.allows(source, 'read')) return 'denied'
    const record = this.sql.exec<{ content_version: string }>(`SELECT content_version FROM ov_edge_fs_entry
      WHERE account_id=? AND space=? AND uri=? AND is_dir=0 AND derived_from IS NULL AND derived_version IS NULL`,
    this.account, source.space, source.uri).toArray()[0]
    return record?.content_version === row.derived_version ? 'readable' : 'stale'
  }

  private requireReadableSummary(path: FsPath): void {
    const name = path.parts.at(-1)
    if (name !== '.abstract.md' && name !== '.overview.md') return
    const row = this.sql.exec<Derivation>(`SELECT derived_from,derived_version FROM ov_edge_fs_entry
      WHERE account_id=? AND space=? AND uri=?`, this.account, path.space, path.uri).toArray()[0]
    if (!row) return
    const status = this.summaryAccess(path, row)
    if (status === 'denied') denied('Source read permission is required for this directory summary.')
    if (status === 'stale') missing()
  }

  // A preview must omit a protected or stale level, but never repair it on GET.
  previewEntry(path: FsPath): Entry | undefined {
    if (!this.acl.allows(path, 'read')) return
    const row = this.rawEntry(path)
    if (row && this.summaryAccess(path, row) === 'readable') return row
  }

  private rawEntry(path: FsPath): Entry | undefined {
    if (path.space === SYSTEM_COMPILE) {
      const row = exampleEntries(this.ctx).find(item => item.uri === path.uri)
      if (!row) return
      const { body: _body, ...metadata } = row
      return metadata
    }
    if (path.builtin) return virtual(path)
    return this.sql.exec<Entry>(`SELECT ${metadata} FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?`,
      this.account, path.space, path.uri).toArray()[0]
  }

  require(path: FsPath, action: AclLevel = 'read'): Entry { return this.entry(path, action) ?? missing() }

  content(path: FsPath): Content {
    this.acl.authorize(path, 'read')
    this.requireReadableSummary(path)
    if (path.space === SYSTEM_COMPILE) {
      const row = exampleEntries(this.ctx).find(item => item.uri === path.uri) ?? missing()
      if (row.is_dir) conflict('The target is a directory.')
      return { body: row.body!, is_dir: 0 }
    }
    if (path.builtin) conflict('The target is a directory.')
    const entry = this.sql.exec<Content>(`SELECT body, is_dir FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?`,
      this.account, path.space, path.uri).toArray()[0] ?? missing()
    if (entry.is_dir) conflict('The target is a directory.')
    return entry
  }

  requireDir(path: FsPath, action: AclLevel = 'read'): void {
    if (!this.require(path, action).is_dir) conflict('A parent path is not a directory.')
  }

  parent(path: FsPath): FsPath { return fromParts(path.parts.slice(0, -1), this.caller) }

  // Read no parent content and expose no parent metadata over the wire. This is
  // the structural/CAS guard after authorizing an existing direct file grant.
  fileParent(path: FsPath, existing: boolean): Entry {
    const parent = this.parent(path)
    const row = (existing ? this.rawEntry(parent) : this.entry(parent, 'write')) ?? missing()
    if (!row.is_dir) conflict('A parent path is not a directory.')
    return row
  }

  entries(path: FsPath, forSearch = false): Entry[] {
    if (path.space === SYSTEM_COMPILE) {
      if (!forSearch) this.require(path)
      return exampleEntries(this.ctx).filter(row => inPath(row.uri, path.uri)).map(({ body: _body, ...row }) => row)
    }
    if (!forSearch) this.require(path)
    const read = this.acl.reader()
    const visible = (row: Entry): boolean => {
      if (!read(row.uri)) return false
      if ((row.derived_from != null || row.derived_version != null) && this.summaryAccess(this.path(row.uri), row) !== 'readable') return false
      if (!forSearch && row.uri.startsWith('viking://resources/')) {
        // A directory walk cannot skip an unreadable intermediate directory.
        for (let uri = row.uri.slice(0, row.uri.lastIndexOf('/')); absChild(uri, path.uri);
          uri = uri.slice(0, uri.lastIndexOf('/'))) if (!read(uri)) return false
      }
      return true
    }
    if (path.space === null) {
      // Bare /user exposes only the current user's mount, even to an account admin.
      const [shared, user, agent] = spaces(this.caller)
      const rows = path.uri === ROOT
        ? this.sql.exec<Entry>(`SELECT ${metadata} FROM ov_edge_fs_entry WHERE account_id=? AND space IN (?,?,?,?)`,
          this.account, shared, user, agent, SHARED_SKILLS).toArray()
        : this.sql.exec<Entry>(`SELECT ${metadata} FROM ov_edge_fs_entry WHERE account_id=? AND space=?`,
          this.account, user).toArray()
      return [...roots(this.caller).filter(root => inPath(root.uri, path.uri)).map(virtual), ...rows.filter(visible)]
    }
    const mounts = path.uri === `${ROOT}agent` ? [path.space, SHARED_SKILLS] : [path.space]
    return [...roots(this.caller).filter(root => root.space !== null && mounts.includes(root.space) && inPath(root.uri, path.uri)).map(virtual),
      ...mounts.flatMap(space => this.rawEntries({ ...path, space })).filter(visible)]
  }

  private rawEntries(path: Scoped): Entry[] {
    return this.sql.exec<Entry>(`SELECT ${metadata} FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND ${within}`,
      this.account, path.space, ...range(path.uri)).toArray()
  }

  storedEntries(path: Scoped, action: AclLevel = 'read'): Entry[] {
    this.acl.authorize(path, action)
    // Captures/portable copies include authored rows only. Mutation preflights
    // still see the actual generated rows they can touch or remove.
    const rows = this.rawEntries(path).filter(row => action !== 'read' || row.derived_from == null && row.derived_version == null)
    for (const row of rows) this.acl.authorize(this.path(row.uri), action)
    return rows
  }

  vector(path: FsPath): ArrayBuffer {
    this.acl.authorize(path, 'read')
    this.requireReadableSummary(path)
    return this.sql.exec<{ vectors: ArrayBuffer }>(`SELECT vectors FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?`,
      this.account, path.space, path.uri).one().vectors
  }

  clearIndex(path: Scoped): void {
    this.acl.authorize(path, 'write')
    assertPendingClear(this.ctx, path)
    this.sql.exec(`UPDATE ov_edge_fs_entry SET dimensions=0,vectors=NULL WHERE account_id=? AND space=? AND uri=?`,
      this.account, path.space, path.uri)
  }

  putIndex(path: Scoped, index: VectorIndex): void {
    const entry = this.require(path, 'write')
    assertPendingClear(this.ctx, path)
    if (entry.is_dir) conflict('A directory index belongs to its summary sidecar.')
    this.limits(path.space, 0, 0, (index.vectors?.byteLength ?? 0) - entry.vector_bytes)
    this.checkDimensions(index.dimensions)
    this.sql.exec(`UPDATE ov_edge_fs_entry SET dimensions=?,vectors=?,revision=? WHERE account_id=? AND space=? AND uri=?`,
      index.dimensions, index.vectors, crypto.randomUUID(), this.account, path.space, path.uri)
  }

  private checkDimensions(dimensions: number): void {
    if (!dimensions) return
    const mismatch = this.sql.exec<{ uri: string }>(`SELECT uri FROM ov_edge_fs_entry
      WHERE account_id=? AND dimensions>0 AND dimensions!=? LIMIT 1`, this.account, dimensions).toArray()[0]
    if (mismatch) throw new ApiError(503, 'EMBEDDING_UNAVAILABLE', 'The embedding provider returned an incompatible vector shape.')
  }

  limits(space: string, count: number, bytes = 0, vectors = 0): void {
    if (count <= 0 && bytes <= 0 && vectors <= 0) return
    const usage = this.sql.exec<Usage>(usageQuery(), this.account, this.account).one()
    if (usage.entries + count > ACCOUNT_ENTRIES || usage.bytes + bytes > ACCOUNT_BYTES ||
        usage.vector_bytes + vectors > ACCOUNT_VECTOR_BYTES) quota('Workspace file or index quota exceeded.')
    const [shared, user] = spaces(this.caller)
    if (space === shared || space === SHARED_SKILLS) return
    // Aggregate the private user mount and all its agent mounts, so switching keys/agents cannot reset capacity.
    const agentPrefix = JSON.stringify(['agent', this.caller.userId]).slice(0, -1) + ','
    const args = [this.account, user, agentPrefix, agentPrefix] as const
    const mine = this.sql.exec<Usage>(usageQuery('AND (space=? OR substr(space,1,length(?))=?)'), ...args, ...args).one()
    if (mine.entries + count > PRIVATE_ENTRIES || mine.bytes + bytes > PRIVATE_BYTES ||
        mine.vector_bytes + vectors > PRIVATE_VECTOR_BYTES) quota('Private file or index quota exceeded.')
  }

  mkdir(path: Scoped, description: string, spec?: AclSpec): Entry {
    if (this.entry(path, 'write')) exists()
    this.requireDir(this.parent(path), 'write')
    this.acl.prepare(path, spec)
    assertPendingClear(this.ctx, path, true)
    this.limits(path.space, 1)
    const now = Date.now()
    const row = this.sql.exec<Entry>(`INSERT INTO ov_edge_fs_entry (account_id,space,uri,is_dir,description,created_at,updated_at,revision,node_id)
      VALUES (?,?,?,1,?,?,?,?,?) RETURNING ${metadata}`, this.account, path.space, path.uri, description, now, now, crypto.randomUUID(), crypto.randomUUID()).one()
    if (spec) this.acl.apply(path, spec, false)
    return row
  }

  // No await from the first compare to the last write: caller holds transactionSync.
  storeFile(path: Scoped, body: string, bytes: number, index: VectorIndex, tags: string[], previous?: Entry, description = '',
    spec?: AclSpec, dependency?: SummaryDependency): Entry {
    this.acl.authorize(path, 'write')
    this.acl.prepare(path, spec)
    assertPendingClear(this.ctx, path)
    // The target has its own ACL; an existing, directly shared file may be
    // writable even though its parent directory cannot be listed.
    this.fileParent(path, !!previous)
    if (dependency) {
      const leaf = path.parts.at(-1)
      const source = this.path(dependency.uri)
      if ((leaf !== '.abstract.md' && leaf !== '.overview.md') || source.space !== path.space || source.uri === path.uri ||
          this.parent(source).uri !== this.parent(path).uri || !dependency.version || this.rawEntry(source)?.content_version !== dependency.version) {
        conflict('The generated summary source is invalid or stale.')
      }
    }
    if (previous) clearFileLevels(this, path)
    this.limits(path.space, previous ? 0 : 1, bytes - (previous?.bytes ?? 0), (index.vectors?.byteLength ?? 0) - (previous?.vector_bytes ?? 0))
    this.checkDimensions(index.dimensions)
    const now = Date.now()
    const row = this.sql.exec<Entry>(`INSERT INTO ov_edge_fs_entry
      (account_id,space,uri,is_dir,body,bytes,description,tags,dimensions,vectors,created_at,updated_at,revision,node_id,content_version,derived_from,derived_version)
      VALUES (?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,space,uri) DO UPDATE SET
        body=excluded.body, bytes=excluded.bytes, description=excluded.description, tags=excluded.tags, dimensions=excluded.dimensions,
        vectors=excluded.vectors, updated_at=excluded.updated_at, revision=excluded.revision,
        content_version=excluded.content_version,derived_from=excluded.derived_from,derived_version=excluded.derived_version RETURNING ${metadata}`,
      this.account, path.space, path.uri, body, bytes, description, JSON.stringify(tags), index.dimensions,
      index.vectors, previous?.created_at ?? now, now, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
      dependency?.uri ?? null, dependency?.version ?? null).one()
    if (spec) this.acl.apply(path, spec, false)
    return row
  }

  updateTags(path: Scoped, entry: Entry, tags: string[]): void {
    const target = this.path(entry.uri)
    this.acl.authorize(target, 'write')
    assertPendingClear(this.ctx, target)
    this.sql.exec(`UPDATE ov_edge_fs_entry SET tags=?, updated_at=?, revision=? WHERE account_id=? AND space=? AND uri=?`,
      JSON.stringify(tags), Date.now(), crypto.randomUUID(), this.account, path.space, entry.uri)
  }

  updateDirectory(path: Scoped, description: string, tags: string[]): void {
    if (!this.require(path, 'write').is_dir || path.builtin) conflict('Expected a stored directory.')
    assertPendingClear(this.ctx, path)
    this.sql.exec(`UPDATE ov_edge_fs_entry SET description=?,tags=?,updated_at=?,revision=?
      WHERE account_id=? AND space=? AND uri=?`, description, JSON.stringify(tags), Date.now(), crypto.randomUUID(),
    this.account, path.space, path.uri)
  }

  remove(path: Scoped, recursive: boolean): number {
    this.require(path, 'manage')
    const rows = this.storedEntries(path, 'manage')
    if (rows.length > 1 && !recursive) conflict('Directory is not empty; recursive=true is required.')
    assertPendingClear(this.ctx, path, true)
    this.sql.exec(`DELETE FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND ${within}`,
      this.account, path.space, ...range(path.uri))
    return rows.length
  }

  transfer(from: Scoped, to: Scoped, copy: boolean, recursive: boolean, overwrite = false): boolean {
    // A rename/copy must never implicitly publish private data or change its owner.
    if (from.space !== to.space || from.kind !== to.kind) conflict('Transfers across visibility or context scopes are not supported.')
    if (inPath(to.uri, from.uri) || inPath(from.uri, to.uri)) conflict('Source and destination subtrees must not overlap.')
    const source = this.require(from, copy ? 'read' : 'manage')
    if (source.derived_from != null || source.derived_version != null) conflict('Generated summaries cannot be transferred as independent files.')
    if (copy && source.is_dir && !recursive) conflict('Copying a directory requires recursive=true.')
    if (!source.is_dir) textFile(nameOf(to.uri))
    const destination = this.entry(to, 'write')
    const replaceFile = destination && !destination.is_dir && !source.is_dir
    if (destination) {
      if (!replaceFile) this.acl.authorize(to, 'manage')
      if (!overwrite) exists()
    } else this.requireDir(this.parent(to), 'write')
    // Return only after checking every source row. A move removes each of
    // these paths; membership in a managed subtree does not override their ACLs.
    const sourceRows = this.storedEntries(from, copy ? 'read' : 'manage')
    const generated = sourceRows.filter(row => row.derived_from != null || row.derived_version != null)
    const rows = sourceRows.filter(row => row.derived_from == null && row.derived_version == null)
    if (!copy) assertPendingClear(this.ctx, from, true)
    if (replaceFile) {
      assertPendingClear(this.ctx, to)
      clearFileLevels(this, to)
      if (copy) this.limits(to.space, 0, source.bytes - destination.bytes, source.vector_bytes - destination.vector_bytes)
      // A simple file replacement is not a delete. Keep the destination's own
      // ACL and incarnation; only write on that file is necessary.
      this.sql.exec(`UPDATE ov_edge_fs_entry SET (body,bytes,description,tags,dimensions,vectors) = (
          SELECT body,bytes,description,tags,dimensions,vectors FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?
        ),updated_at=?,revision=?,content_version=?,derived_from=NULL,derived_version=NULL WHERE account_id=? AND space=? AND uri=?`,
      this.account, from.space, from.uri, Date.now(), crypto.randomUUID(), crypto.randomUUID(), this.account, to.space, to.uri)
      if (!copy) this.sql.exec('DELETE FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?', this.account, from.space, from.uri)
      return true
    }

    // A tree overwrite removes every old destination row, including paths
    // absent from the new tree. Check all removals, not just matching paths.
    const overwritten = destination ? this.storedEntries(to, 'manage') : []
    assertPendingClear(this.ctx, to, true)
    // Revalidate every re-rooted URI (including depth/byte limits) before the first mutation.
    const targets = rows.map(row => {
      const suffix = row.uri === from.uri ? [] : relative(row.uri, from.uri).split('/')
      const target = fromParts([...to.parts, ...suffix], this.caller)
      writable(target, this.caller)
      return target
    })
    const policies = new Map<string, DirectAcl>()
    if (destination && to.space === 'shared') {
      const planned = new Map(targets.map(target => [target.uri, target]))
      for (const row of overwritten) {
        const target = planned.get(row.uri)
        if (!target) continue
        const report = this.acl.resolve(target)
        policies.set(row.uri, { acl_mode: report.acl_mode, entries: report.direct_entries })
      }
    }
    if (copy) this.limits(to.space, rows.length - overwritten.length,
      rows.reduce((n, row) => n + row.bytes, 0) - overwritten.reduce((n, row) => n + row.bytes, 0),
      rows.reduce((n, row) => n + row.vector_bytes, 0) - overwritten.reduce((n, row) => n + row.vector_bytes, 0))
    if (destination) {
      this.sql.exec(`DELETE FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND ${within}`,
        this.account, to.space, ...range(to.uri))
    }
    const now = Date.now()
    // Source ACLs belong to the old URI, not to the destination.
    if (!copy && from.space === 'shared') this.sql.exec(`DELETE FROM ov_edge_fs_acl WHERE account_id=? AND space=? AND ${within}`,
      this.account, from.space, ...range(from.uri))
    if (!copy) clearFileLevels(this, from, true)
    // A move authorizes every removed derivative but does not detach it from
    // its source authority and republish it on another path.
    for (const row of generated) this.sql.exec('DELETE FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?',
      this.account, from.space, row.uri)
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const revision = crypto.randomUUID()
      const target = targets[i], incarnation = crypto.randomUUID()
      if (copy) {
        this.sql.exec(`INSERT INTO ov_edge_fs_entry
          (account_id,space,uri,is_dir,body,bytes,description,tags,dimensions,vectors,created_at,updated_at,revision,node_id)
          SELECT account_id,space,?,is_dir,body,bytes,description,tags,dimensions,vectors,?,?,?,?
          FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?`,
          target.uri, now, now, revision, incarnation, this.account, from.space, row.uri)
      } else {
        this.sql.exec(`UPDATE ov_edge_fs_entry SET uri=?,updated_at=?,revision=?,node_id=? WHERE account_id=? AND space=? AND uri=?`,
          target.uri, now, revision, incarnation, this.account, from.space, row.uri)
      }
      const policy = policies.get(target.uri)
      if (policy) this.acl.apply(target, policy)
    }
    return !!destination
  }
}

export const ordered = (entries: Entry[], by: 'name' | 'mtime', order: 'asc' | 'desc') => entries.sort((a, b) => {
  const direction = order === 'desc' ? -1 : 1
  return b.is_dir - a.is_dir || direction * ((by === 'mtime' ? a.updated_at - b.updated_at : 0) ||
    compare(nameOf(a.uri), nameOf(b.uri)) || compare(a.uri, b.uri))
})

export function wireEntry(entry: Entry, base: string, includeTags = false, count?: number) {
  const mtime = entry.updated_at ? new Date(entry.updated_at).toISOString() : ''
  return {
    uri: entry.uri, name: nameOf(entry.uri), isDir: !!entry.is_dir, size: entry.bytes,
    modTime: mtime, rel_path: relative(entry.uri, base),
    ...(entry.description && { description: entry.description }),
    ...(includeTags && { tags: tagsOf(entry) }),
    ...(count !== undefined && { count }),
  }
}
