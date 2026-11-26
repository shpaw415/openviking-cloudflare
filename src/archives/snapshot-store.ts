// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import type { SubtreeCapture } from '../filesystem.js'
import { conflict, digest, encoder, forbidden, invalid, notFound, quota } from './common.js'

export const SNAPSHOT_FILES = 256
export const SNAPSHOT_BYTES = 2 * 1024 * 1024
const HISTORY_COMMITS = 512
const HISTORY_BYTES = 32 * 1024 * 1024
const AUTHOR_COMMITS = 96
const AUTHOR_BYTES = 6 * 1024 * 1024

export const SHA40 = /^[a-f0-9]{40}$/
const prefixOid = /^[a-f0-9]{7,40}$/
const COLUMNS = 'oid, parent_oid, tree_oid, message, author_name, author_email, time_seconds, changes'
export const portableHiddenTable = 'ov_edge_snapshot_portable_hidden'
export type Revision = {
  oid: string; parent_oid: string | null; tree_oid: string; message: string
  author_name: string; author_email: string; time_seconds: number; changes: string
}
export type HistoryGuard = SubtreeCapture['guard']['entries'][number]
export type FileRef = [uri: string, key: string, bytes: number, guard: HistoryGuard]
export type Blob = { key: string; oid: string; bytes: number; body: string }

export function initSnapshotStore({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_snapshot_commit (
    account TEXT NOT NULL, mount TEXT NOT NULL, owner TEXT NOT NULL, oid TEXT NOT NULL,
    parent_oid TEXT, tree_oid TEXT NOT NULL, message TEXT NOT NULL, author_name TEXT NOT NULL,
    author_email TEXT NOT NULL, time_seconds INTEGER NOT NULL, changes TEXT NOT NULL,
    tree TEXT NOT NULL, storage_bytes INTEGER NOT NULL,
    PRIMARY KEY (account, mount, oid)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_snapshot_head (
    account TEXT NOT NULL, mount TEXT NOT NULL, branch TEXT NOT NULL, oid TEXT NOT NULL,
    PRIMARY KEY (account, mount, branch)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_snapshot_blob (
    account TEXT NOT NULL, mount TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT NOT NULL,
    oid TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY (account, mount, digest)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_snapshot_ignore (
    account TEXT PRIMARY KEY, content TEXT NOT NULL
  ) WITHOUT ROWID`)
}

export function branchName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,79}$/.test(value) || prefixOid.test(value) || value.includes('..') ||
      value.split('/').some(piece => !piece || piece.startsWith('.') || piece.endsWith('.') || piece.endsWith('.lock'))) {
    return invalid('Invalid snapshot branch name.')
  }
  return value
}

export async function identifyBlob(body: string): Promise<Blob> {
  const bytes = encoder.encode(body)
  const header = encoder.encode(`blob ${bytes.byteLength}\0`)
  const framed = new Uint8Array(header.byteLength + bytes.byteLength)
  framed.set(header)
  framed.set(bytes, header.byteLength)
  const [key, oid] = await Promise.all([digest(bytes), digest(framed, 'SHA-1')])
  return { key, oid, body, bytes: bytes.byteLength }
}

export function wireRevision(row: Revision, visibleParent: string | undefined) {
  const actor = { name: row.author_name, email: row.author_email, time_seconds: row.time_seconds, tz_offset_seconds: 0 }
  return { oid: row.oid, tree: row.tree_oid, parents: visibleParent ? [visibleParent] : [],
    author: actor, committer: actor, message: row.message }
}

export class SnapshotStore {
  constructor(readonly ctx: WorkspaceContext, readonly mount: string) {}
  get sql() { return this.ctx.sql }
  get keys() { return [this.ctx.caller.accountId, this.mount] as const }

  at(oid: string): Revision | undefined {
    return this.sql.exec<Revision>(`SELECT ${COLUMNS} FROM ov_edge_snapshot_commit
      WHERE account=? AND mount=? AND oid=?`, ...this.keys, oid).toArray()[0]
  }

  head(branch: string): Revision | undefined {
    const found = this.sql.exec<{ oid: string }>('SELECT oid FROM ov_edge_snapshot_head WHERE account=? AND mount=? AND branch=?',
      ...this.keys, branch).toArray()[0]
    return found && this.at(found.oid)
  }

  private limitPortableHistory() {
    return this.mount === 'shared' && this.ctx.caller.role !== 'admin' &&
      !!this.sql.exec('SELECT 1 FROM sqlite_schema WHERE type=\'table\' AND name=?', portableHiddenTable).toArray().length
  }

  hiddenPortable(oid: string): boolean {
    return this.limitPortableHistory() && !!this.sql.exec(`SELECT 1 FROM ${portableHiddenTable} WHERE account=? AND oid=?`, this.keys[0], oid).toArray().length
  }

  // A mutation must not derive a tree, version comparison or new commit from
  // imported shared history. A hidden branch is occupied, not an empty base.
  assertWritableHistory(...revisions: Revision[]): void {
    if (!revisions.length || !this.limitPortableHistory()) return
    // UNION deduplicates OIDs. The indexed traversal stays within one mount
    // (and the account's bounded history), even if inputs share ancestors.
    const roots = revisions.map(() => '(?)').join(',')
    if (this.sql.exec(`WITH RECURSIVE lineage(oid) AS (
      VALUES ${roots}
      UNION
      SELECT c.parent_oid FROM lineage l JOIN ov_edge_snapshot_commit c ON c.oid=l.oid
        WHERE c.account=? AND c.mount=? AND c.parent_oid IS NOT NULL
    ) SELECT 1 FROM lineage l JOIN ${portableHiddenTable} h ON h.oid=l.oid WHERE h.account=? LIMIT 1`,
    ...revisions.map(row => row.oid), ...this.keys, this.keys[0]).toArray().length) {
      notFound('Snapshot ref not found.')
    }
  }

  assertWritableHead(branch: string): Revision | undefined {
    const head = this.head(branch)
    if (head) this.assertWritableHistory(head)
    return head
  }

  // Commit can create a missing branch (including main). Reserve the entire
  // shared namespace, independently of any head or portable-state lookup.
  assertCommitAuthority(): void {
    if (this.mount === 'shared' && this.ctx.caller.role !== 'admin') {
      forbidden('Committing snapshots to shared branches requires an administrator.')
    }
  }

  resolve(ref: string): Revision {
    const visible = (row?: Revision) => row && !this.hiddenPortable(row.oid) ? row : notFound('Snapshot ref not found.')
    const heads = 'refs/heads/'
    if (ref.startsWith(heads)) return visible(this.head(branchName(ref.slice(heads.length))))
    if (ref.startsWith('refs/')) return notFound('Snapshot ref not found.')
    if (SHA40.test(ref)) return visible(this.at(ref))
    if (prefixOid.test(ref)) {
      const exclude = this.limitPortableHistory() ? `AND NOT EXISTS (SELECT 1 FROM ${portableHiddenTable} h WHERE h.account=c.account AND h.oid=c.oid)` : ''
      const rows = this.sql.exec<Revision>(`SELECT ${COLUMNS} FROM ov_edge_snapshot_commit c
        WHERE account=? AND mount=? AND oid>=? AND oid<? ${exclude} LIMIT 2`, ...this.keys, ref, `${ref}g`).toArray()
      if (rows.length === 2) conflict('Ambiguous snapshot ref.')
      return rows[0] ?? notFound('Snapshot ref not found.')
    }
    return visible(this.head(branchName(ref)))
  }

  *walk(start: Revision): Generator<Revision> {
    let next: Revision | undefined = start
    while (next) {
      yield next
      next = next.parent_oid ? this.at(next.parent_oid) : undefined
    }
  }

  files(revision?: Revision): Map<string, FileRef> {
    if (!revision) return new Map()
    const { tree } = this.sql.exec<{ tree: string }>('SELECT tree FROM ov_edge_snapshot_commit WHERE account=? AND mount=? AND oid=?',
      ...this.keys, revision.oid).one()
    return new Map((JSON.parse(tree) as FileRef[]).map(ref => [ref[0], ref]))
  }

  blob(ref: FileRef): Blob {
    const row = this.sql.exec<{ oid: string; body: string }>('SELECT oid, body FROM ov_edge_snapshot_blob WHERE account=? AND mount=? AND digest=?',
      ...this.keys, ref[1]).toArray()[0]
    if (!row) throw new Error('Missing indexed snapshot blob')
    return { ...row, key: ref[1], bytes: ref[2] }
  }

  async prepare(files: Map<string, FileRef>, previous: Map<string, FileRef>, parent: Revision | undefined,
    message: string, authorName: string, authorEmail: string) {
    if (files.size > SNAPSHOT_FILES || Array.from(files.values()).reduce((sum, file) => sum + file[2], 0) > SNAPSHOT_BYTES) {
      quota('Snapshot tree exceeds the file or byte limit.')
    }
    for (const uri of files.keys()) {
      let parentUri = uri.slice(0, uri.lastIndexOf('/'))
      while (parentUri.startsWith('viking://')) {
        if (files.has(parentUri)) conflict('Select the whole changed parent when a file becomes a collection.')
        parentUri = parentUri.slice(0, parentUri.lastIndexOf('/'))
      }
    }
    const tree = Array.from(files.values()).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    const changes = new Set([...previous.keys(), ...files.keys()])
    for (const uri of changes) {
      const a = previous.get(uri), b = files.get(uri)
      if (a?.[1] === b?.[1] && a?.[3].node_id === b?.[3].node_id) changes.delete(uri)
    }
    const time = Math.floor(Date.now() / 1000)
    const treeOid = (await digest(encoder.encode(`ov-edge-tree\0${JSON.stringify(tree.map(file => file.slice(0, 3)))}`))).slice(0, 40)
    const oid = (await digest(encoder.encode(JSON.stringify(['ov-edge-snapshot', this.keys, treeOid,
      parent?.oid ?? null, time, message, authorName, authorEmail, crypto.randomUUID()])))).slice(0, 40)
    return { tree, changes: Array.from(changes).sort(), time, treeOid, oid, message, authorName, authorEmail }
  }

  // Invoked inside the workspace/FS transaction. No awaits and no write before guards.
  publish(branch: string, expectedHead: Revision | undefined, next: Awaited<ReturnType<SnapshotStore['prepare']>>, blobs: Blob[]): void {
    this.assertWritableHeadMatches(branch, expectedHead)
    const jsonChanges = JSON.stringify(next.changes)
    const jsonTree = JSON.stringify(next.tree)
    const metadataBytes = encoder.encode(jsonTree + jsonChanges + next.message + next.authorName + next.authorEmail).byteLength
    if (metadataBytes > 1024 * 1024) quota('Snapshot metadata exceeds the row limit.')
    const unique = new Map(blobs.map(blob => [blob.key, blob]))
    for (const key of unique.keys()) {
      if (this.sql.exec('SELECT 1 FROM ov_edge_snapshot_blob WHERE account=? AND mount=? AND digest=?', ...this.keys, key).toArray().length) {
        unique.delete(key)
      }
    }
    const extra = metadataBytes + Array.from(unique.values()).reduce((sum, blob) => sum + blob.bytes + 128, 0)
    const owner = this.ctx.caller.userId
    this.capacity(extra, HISTORY_COMMITS, HISTORY_BYTES)
    this.capacity(extra, AUTHOR_COMMITS, AUTHOR_BYTES, owner)
    for (const blob of unique.values()) {
      this.sql.exec('INSERT INTO ov_edge_snapshot_blob (account,mount,owner,digest,oid,body,size) VALUES (?,?,?,?,?,?,?)',
        ...this.keys, owner, blob.key, blob.oid, blob.body, blob.bytes)
    }
    this.sql.exec(`INSERT INTO ov_edge_snapshot_commit
      (account,mount,owner,oid,parent_oid,tree_oid,message,author_name,author_email,time_seconds,changes,tree,storage_bytes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...this.keys, owner, next.oid, expectedHead?.oid ?? null, next.treeOid,
      next.message, next.authorName, next.authorEmail, next.time, jsonChanges, jsonTree, metadataBytes)
    this.sql.exec(`INSERT INTO ov_edge_snapshot_head (account,mount,branch,oid) VALUES (?,?,?,?)
      ON CONFLICT(account,mount,branch) DO UPDATE SET oid=excluded.oid`, ...this.keys, branch, next.oid)
  }

  assertWritableHeadMatches(branch: string, expected?: Revision): void {
    if (this.assertWritableHead(branch)?.oid !== expected?.oid) conflict('Snapshot branch changed; retry from the latest revision.')
  }

  private capacity(extra: number, maxCommits: number, maxBytes: number, owner?: string): void {
    const where = owner === undefined ? 'account=?' : 'account=? AND owner=?'
    const bindings = owner === undefined ? [this.keys[0]] : [this.keys[0], owner]
    const revisions = this.sql.exec<{ count: number; size: number }>(`SELECT count(*) AS count,
      coalesce(sum(storage_bytes),0) AS size FROM ov_edge_snapshot_commit WHERE ${where}`, ...bindings).one()
    const blobs = this.sql.exec<{ size: number }>(`SELECT coalesce(sum(size+128),0) AS size
      FROM ov_edge_snapshot_blob WHERE ${where}`, ...bindings).one()
    if (revisions.count >= maxCommits || revisions.size + blobs.size + extra > maxBytes) quota('Snapshot history quota exceeded.')
  }
}
