// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { conflict, denied, nameOf, textSize } from './contract.js'
import type { FsPath } from './contract.js'
import type { Entry, Filesystem, Scoped, VectorIndex } from './store.js'
import { generateDirectorySummary } from './analysis.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'
import { assertPendingClear } from './pending.js'

export type FileLevel = 0 | 1
export type PreparedLevel = { level: FileLevel; body: string; bytes: number; index: VectorIndex }
type StoredLevel = { level: FileLevel; body: string; bytes: number; dimensions: number; vectors: ArrayBuffer }

export function initFileLevels(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_file_level (
    account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    level INTEGER NOT NULL CHECK(level IN (0,1)), source_version TEXT NOT NULL,
    body TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0),
    dimensions INTEGER NOT NULL CHECK(dimensions > 0), vectors BLOB NOT NULL,
    PRIMARY KEY(account_id,space,uri,level),
    FOREIGN KEY(account_id,space,uri) REFERENCES ov_edge_fs_entry(account_id,space,uri) ON DELETE CASCADE,
    CHECK(length(vectors) > 0 AND length(vectors) % (4 * dimensions) = 0)
  ) WITHOUT ROWID`)
}

const sourceVersion = (entry: Entry) => entry.content_version || entry.node_id || entry.revision

export function admitsFileLevels(path: FsPath): boolean {
  return !path.builtin && !path.managed && path.kind === 'resource' && !nameOf(path.uri).startsWith('.') &&
    (path.parts[0] === 'resources' || path.parts[0] === 'user' && path.parts[2] === 'resources')
}

export async function prepareLevels(ctx: WorkspaceContext, name: string, source: string, afterGenerate?: () => Promise<void>) {
  const texts = await generateDirectorySummary(ctx, name, source)
  await afterGenerate?.()
  const result: PreparedLevel[] = []
  for (const level of [0, 1] as const) {
    ctx.assertActive?.()
    const body = texts[level]
    result.push({ level, body, bytes: textSize(body), index: await documentIndex(ctx, body) })
  }
  return result
}

function rowsForVersion(fs: Filesystem, path: FsPath, version: string, level?: FileLevel): StoredLevel[] {
  return fs.sql.exec<StoredLevel>(`SELECT level,body,bytes,dimensions,vectors FROM ov_edge_fs_file_level
    WHERE account_id=? AND space=? AND uri=? AND source_version=? ${level === undefined ? '' : 'AND level=?'} ORDER BY level`,
  fs.account, path.space, path.uri, version, ...(level === undefined ? [] : [level])).toArray()
}

export function readFileLevels(fs: Filesystem, path: FsPath, level?: FileLevel): StoredLevel[] {
  if (!admitsFileLevels(path)) return []
  const source = fs.require(path)
  if (source.is_dir || !source.dimensions) return []
  // Preserve the previous parent read boundary on every new document-level
  // read, in addition to the current source permission and mount membership.
  if (!fs.acl.allows(fs.parent(path), 'read')) denied('Parent read permission is required for this summary.')
  return rowsForVersion(fs, path, sourceVersion(source), level).filter(row => row.dimensions === source.dimensions)
}

export function clearFileLevels(fs: Filesystem, path: Scoped, subtree = false): void {
  fs.sql.exec(`DELETE FROM ov_edge_fs_file_level WHERE account_id=? AND space=? AND
    ${subtree ? '(uri=? OR (uri>=? AND uri<?))' : 'uri=?'}`, fs.account, path.space, path.uri,
  ...(subtree ? [`${path.uri}/`, `${path.uri}0`] : []))
}

// Called within the source publication or reindex transaction, never from GET.
export function publishFileLevels(fs: Filesystem, path: Scoped, source: Entry, levels: PreparedLevel[]): void {
  assertPendingClear(fs.ctx, path)
  const current = fs.require(path, 'write')
  if (!admitsFileLevels(path) || current.is_dir || sourceVersion(current) !== sourceVersion(source)) conflict('The analysis source changed while preparing its levels.')
  fs.acl.authorize(fs.parent(path), 'read')
  if (levels.length !== 2 || levels.some((item, i) => item.level !== i || !item.index.vectors || item.index.dimensions !== current.dimensions)) {
    throw embeddingUnavailable()
  }
  clearFileLevels(fs, path)
  fs.limits(path.space, 2, levels.reduce((n, item) => n + item.bytes, 0), levels.reduce((n, item) => n + item.index.vectors!.byteLength, 0))
  for (const item of levels) fs.sql.exec(`INSERT INTO ov_edge_fs_file_level
    (account_id,space,uri,level,source_version,body,bytes,dimensions,vectors) VALUES (?,?,?,?,?,?,?,?,?)`,
  fs.account, path.space, path.uri, item.level, sourceVersion(current), item.body, item.bytes, item.index.dimensions, item.index.vectors)
}
