// SPDX-License-Identifier: AGPL-3.0-only
import { quota } from './contract.js'
import type { Filesystem, Scoped } from './store.js'
import type { SkillMetadata } from './skill-format.js'

export function initSkillStorage(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_skill (
    account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    owner_user_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, current_revision TEXT,
    stamp TEXT NOT NULL, metadata TEXT NOT NULL, manifest TEXT NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY(account_id,space,uri)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_skill_event (
    event_id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    actor_user_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, operation TEXT NOT NULL,
    before_hash TEXT, after_hash TEXT, request_id TEXT NOT NULL
  )`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_edge_fs_skill_events_by_uri
    ON ov_edge_fs_skill_event(account_id,space,uri,event_id)`)
}

export type SkillRow = {
  uri: string; owner_user_id: string; created_by: string; created_at: number; updated_by: string; updated_at: number;
  current_revision: string | null; stamp: string; metadata: string; manifest: string; source: string
}

export function skillRow(fs: Filesystem, path: Scoped): SkillRow | undefined {
  return fs.sql.exec<SkillRow>(`SELECT uri, owner_user_id, created_by, created_at, updated_by, updated_at, current_revision, stamp,
    metadata, manifest, source FROM ov_edge_fs_skill WHERE account_id=? AND space=? AND uri=?`, fs.account, path.space, path.uri).toArray()[0]
}

export function skillRows(fs: Filesystem, root: Scoped, limit: number): SkillRow[] {
  return fs.sql.exec<SkillRow>(`SELECT uri, owner_user_id, created_by, created_at, updated_by, updated_at, current_revision, stamp,
    metadata, '' AS manifest, '' AS source FROM ov_edge_fs_skill WHERE account_id=? AND space=? AND current_revision IS NOT NULL
    AND uri>=? AND uri<? ORDER BY uri LIMIT ?`, fs.account, root.space, `${root.uri}/`, `${root.uri}0`, limit).toArray()
}

export function ownership(row: SkillRow) {
  return { owner_user_id: row.owner_user_id, created_by: row.created_by, created_at: new Date(row.created_at).toISOString(),
    updated_by: row.updated_by, updated_at: new Date(row.updated_at).toISOString(), current_revision: row.current_revision }
}

type Event = { actor_user_id: string; occurred_at: number; operation: string; before_hash: string | null; after_hash: string | null; request_id: string }
export function skillHistory(fs: Filesystem, path: Scoped, limit = 1000) {
  return fs.sql.exec<Event>(`SELECT actor_user_id,occurred_at,operation,before_hash,after_hash,request_id FROM ov_edge_fs_skill_event
    WHERE account_id=? AND space=? AND uri=? ORDER BY event_id DESC LIMIT ?`, fs.account, path.space, path.uri, limit)
    .toArray().reverse().map(row => ({ ...row, occurred_at: new Date(row.occurred_at).toISOString() }))
}

export type ManifestFile = { name: string; path: string; uri: string; is_dir: boolean; kind: string; size?: number; sha256?: string }
export function storeSkill(fs: Filesystem, path: Scoped, old: SkillRow | undefined,
  next: { metadata: SkillMetadata; manifest: ManifestFile[]; source: Record<string, unknown>; revision: string } | null): SkillRow {
  const event = next ? old?.current_revision ? 'update' : 'create' : 'delete'
  if (next) {
    const keys = fs.sql.exec<{ count: number }>('SELECT count(*) AS count FROM ov_edge_fs_skill WHERE account_id=?', fs.account).one().count
    if (!old && keys >= 512) quota('Skill ownership history quota exceeded.')
    const events = fs.sql.exec<{ count: number }>('SELECT count(*) AS count FROM ov_edge_fs_skill_event WHERE account_id=?', fs.account).one().count
    // Deletion never loses the audit event; the package count bounds those extra events.
    if (events >= 8192) quota('Skill audit event quota exceeded.')
  }
  const user = fs.caller.userId, now = Date.now(), stamp = crypto.randomUUID(), revision = next?.revision ?? null
  const owner = old?.owner_user_id ?? user, creator = old?.created_by ?? user, created = old?.created_at ?? now
  const meta = next ? JSON.stringify(next.metadata) : old!.metadata
  const manifest = JSON.stringify(next?.manifest ?? [])
  const source = next ? JSON.stringify(next.source) : '{}'
  const row = fs.sql.exec<SkillRow>(`INSERT INTO ov_edge_fs_skill
    (account_id, space, uri, owner_user_id, created_by, created_at, updated_by, updated_at, current_revision, stamp, metadata, manifest, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,space,uri) DO UPDATE SET updated_by=excluded.updated_by,
      updated_at=excluded.updated_at,current_revision=excluded.current_revision,stamp=excluded.stamp,metadata=excluded.metadata,
      manifest=excluded.manifest,source=excluded.source
    RETURNING uri, owner_user_id, created_by, created_at, updated_by, updated_at, current_revision, stamp,metadata,manifest,source`,
  fs.account, path.space, path.uri, owner, creator, created, user, now, revision, stamp, meta, manifest, source).one()
  fs.sql.exec(`INSERT INTO ov_edge_fs_skill_event(account_id,space,uri,actor_user_id,occurred_at,operation,before_hash,after_hash,request_id)
    VALUES (?,?,?,?,?,?,?,?,?)`, fs.account, path.space, path.uri, user, now, event, old?.current_revision ?? null, revision, stamp)
  return row
}
