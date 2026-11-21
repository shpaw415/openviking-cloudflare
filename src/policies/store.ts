// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { byteLength, notFound, serializeValues } from './protocol.js'

const table = 'privacy_targets'
const versionsTable = 'privacy_versions'
const maxTargets = 128
const maxAccountTargets = 512
const maxVersions = 64
const maxOwnerBytes = 4 * 1024 * 1024
const maxAccountBytes = 16 * 1024 * 1024
const maxOwnerVersions = 512
const maxAccountVersions = 2048
const scope = 'account_id = ? AND owner_user_id = ?'
const targetScope = `${scope} AND category = ? AND target_key = ?`
const publicVersionColumns = 'category, target_key, version, created_at, created_by, fields, has_reason'
const quota = () => new ApiError(429, 'RESOURCE_EXHAUSTED', 'Privacy storage quota exceeded.')

type Target = {
  category: string
  target_key: string
  active_version: number
  latest_version: number
  created_at: string
  updated_at: string
  updated_by: string
  last_accessed_at: string
  label_bytes: number
  has_labels: number
}
type VersionMeta = {
  category: string
  target_key: string
  version: number
  created_at: string
  created_by: string
  fields: string
  has_reason: number
}
type FieldStates = [field: string, configured: boolean][]
const targetColumns = 'category, target_key, active_version, latest_version, created_at, updated_at, updated_by, last_accessed_at, label_bytes, has_labels'

export function initStore(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    account_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    category TEXT NOT NULL, target_key TEXT NOT NULL,
    active_version INTEGER NOT NULL CHECK (active_version > 0),
    latest_version INTEGER NOT NULL CHECK (latest_version >= active_version),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, last_accessed_at TEXT NOT NULL,
    labels_json TEXT NOT NULL, label_bytes INTEGER NOT NULL, has_labels INTEGER NOT NULL,
    PRIMARY KEY (account_id, owner_user_id, category, target_key)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ${versionsTable} (
    account_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    category TEXT NOT NULL, target_key TEXT NOT NULL, version INTEGER NOT NULL CHECK (version > 0),
    created_at TEXT NOT NULL, created_by TEXT NOT NULL,
    values_json TEXT NOT NULL, change_reason TEXT NOT NULL, fields TEXT NOT NULL, has_reason INTEGER NOT NULL,
    payload_bytes INTEGER NOT NULL,
    PRIMARY KEY (account_id, owner_user_id, category, target_key, version),
    FOREIGN KEY (account_id, owner_user_id, category, target_key)
      REFERENCES ${table}(account_id, owner_user_id, category, target_key) ON DELETE CASCADE
  ) WITHOUT ROWID`)
}

export function fieldStates(row: VersionMeta): FieldStates {
  return JSON.parse(row.fields) as FieldStates
}

export function publicSnapshot(row: VersionMeta) {
  return {
    version: row.version, category: row.category, target_key: row.target_key,
    created_at: row.created_at, created_by: row.created_by,
    values: Object.fromEntries(fieldStates(row).map(([field]) => [field, null])),
    change_reason: row.has_reason ? '[redacted]' : '',
    change_reason_redacted: Boolean(row.has_reason), redacted: true,
  }
}

function publicTarget(row: Target) {
  return {
    category: row.category, target_key: row.target_key, active_version: row.active_version,
    latest_version: row.latest_version, created_at: row.created_at, updated_at: row.updated_at,
    updated_by: row.updated_by, last_accessed_at: row.last_accessed_at,
    labels: {}, labels_redacted: Boolean(row.has_labels),
  }
}

export class PolicyStore {
  private readonly id: [string, string]
  constructor(private readonly ctx: WorkspaceContext) {
    this.id = [ctx.caller.accountId, ctx.caller.userId]
  }

  categories(): string[] {
    return this.ctx.sql.exec<{ category: string }>(`SELECT DISTINCT category FROM ${table} WHERE ${scope} ORDER BY category`,
      ...this.id).toArray().map(row => row.category)
  }

  targets(category: string): string[] {
    return this.ctx.sql.exec<{ target_key: string }>(`SELECT target_key FROM ${table} WHERE ${scope} AND category = ? ORDER BY target_key`,
      ...this.id, category).toArray().map(row => row.target_key)
  }

  activeTargets(category?: string): Iterable<VersionMeta> {
    return this.ctx.sql.exec<VersionMeta>(`SELECT v.category, v.target_key, v.version, v.created_at, v.created_by, v.fields, v.has_reason
      FROM ${table} t JOIN ${versionsTable} v USING(account_id, owner_user_id, category, target_key)
      WHERE t.account_id = ? AND t.owner_user_id = ? AND v.version = t.active_version
      ${category === undefined ? '' : 'AND t.category = ?'} ORDER BY t.category, t.target_key`,
      ...this.id, ...(category === undefined ? [] : [category]))
  }

  private target(category: string, target: string): Target | undefined {
    return this.ctx.sql.exec<Target>(`SELECT ${targetColumns} FROM ${table} WHERE ${targetScope}`,
      ...this.id, category, target).toArray()[0]
  }

  private requireTarget(category: string, target: string): Target {
    const row = this.target(category, target)
    if (!row) throw notFound()
    return row
  }

  version(category: string, target: string, version: number): VersionMeta {
    const row = this.ctx.sql.exec<VersionMeta>(`SELECT ${publicVersionColumns} FROM ${versionsTable}
      WHERE ${targetScope} AND version = ?`, ...this.id, category, target, version).toArray()[0]
    if (!row) throw notFound()
    return row
  }

  versions(category: string, target: string): number[] {
    this.requireTarget(category, target)
    return this.ctx.sql.exec<{ version: number }>(`SELECT version FROM ${versionsTable} WHERE ${targetScope} ORDER BY version`,
      ...this.id, category, target).toArray().map(row => row.version)
  }

  active(category: string, target: string): VersionMeta {
    return this.version(category, target, this.requireTarget(category, target).active_version)
  }

  current(category: string, target: string) {
    const row = this.requireTarget(category, target)
    return { meta: publicTarget(row), current: publicSnapshot(this.version(category, target, row.active_version)) }
  }

  private rawActive(row: Target): string {
    // Only the transactional mutation path can read confidential values.
    return this.ctx.sql.exec<{ values_json: string }>(`SELECT values_json FROM ${versionsTable}
      WHERE ${targetScope} AND version = ?`, ...this.id, row.category, row.target_key, row.active_version).one().values_json
  }

  private admit(row: Target | undefined, newVersionBytes: number | null, deltaLabels: number) {
    if (row && newVersionBytes !== null && row.latest_version >= maxVersions) throw quota()
    const { sql } = this.ctx
    for (const [ownerOnly, maxRows, historyLimit, byteLimit] of [
      [true, maxTargets, maxOwnerVersions, maxOwnerBytes],
      [false, maxAccountTargets, maxAccountVersions, maxAccountBytes],
    ] as const) {
      const filter = ownerOnly ? scope : 'account_id = ?'
      const args = ownerOnly ? this.id : [this.id[0]]
      const targets = sql.exec<{ n: number; bytes: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(label_bytes), 0) AS bytes
        FROM ${table} WHERE ${filter}`, ...args).one()
      const history = sql.exec<{ n: number; bytes: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(payload_bytes), 0) AS bytes
        FROM ${versionsTable} WHERE ${filter}`, ...args).one()
      if (targets.n + Number(!row) > maxRows || history.n + Number(newVersionBytes !== null) > historyLimit ||
          targets.bytes + deltaLabels + history.bytes + (newVersionBytes ?? 0) > byteLimit) throw quota()
    }
  }

  private publish(category: string, target: string, values: Record<string, unknown>, reason: string,
    labels: string | null, row: Target | undefined, previous: string | undefined) {
    const { sql } = this.ctx
    const payload = serializeValues(values, category)
    const now = new Date().toISOString()
    const owner = this.id[1]
    const args = [...this.id, category, target]
    const labelBytes = labels === null ? (row?.label_bytes ?? 0) : byteLength(labels)
    const hasLabels = labels === null ? (row?.has_labels ?? 0) : Number(labels !== '{}')
    const deltaLabels = labelBytes - (row?.label_bytes ?? 0)

    if (row && previous === payload) {
      if (deltaLabels > 0) this.admit(row, null, deltaLabels)
      sql.exec(`UPDATE ${table} SET updated_at = ?, updated_by = ?, last_accessed_at = ?,
        labels_json = COALESCE(?, labels_json), label_bytes = ?, has_labels = ? WHERE ${targetScope}`,
      now, owner, now, labels, labelBytes, hasLabels, ...args)
      return publicSnapshot(this.version(category, target, row.active_version))
    }

    const version = (row?.latest_version ?? 0) + 1
    const fields = JSON.stringify(Object.keys(values).sort().map(key => [key, values[key] !== null && values[key] !== '']))
    const snapshot = { version, category, target_key: target, created_at: now, created_by: owner, fields, has_reason: Number(reason.length > 0) }
    const bytes = byteLength(payload) + byteLength(fields) + byteLength(reason)
    this.admit(row, bytes, deltaLabels)
    if (!row) {
      sql.exec(`INSERT INTO ${table} (account_id, owner_user_id, category, target_key, active_version, latest_version,
        created_at, updated_at, updated_by, last_accessed_at, labels_json, label_bytes, has_labels)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...args, version, version, now, now, owner, now,
      labels ?? '{}', labelBytes, hasLabels)
    } else {
      sql.exec(`UPDATE ${table} SET active_version = ?, latest_version = ?, updated_at = ?, updated_by = ?,
        last_accessed_at = ?, labels_json = COALESCE(?, labels_json), label_bytes = ?, has_labels = ? WHERE ${targetScope}`,
      version, version, now, owner, now, labels, labelBytes, hasLabels, ...args)
    }
    sql.exec(`INSERT INTO ${versionsTable} (account_id, owner_user_id, category, target_key, version, created_at, created_by,
      values_json, change_reason, fields, has_reason, payload_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...args, version, now, owner, payload, reason, fields, snapshot.has_reason, bytes)
    return publicSnapshot(snapshot)
  }

  write(category: string, target: string, patch: boolean, command: { values: Record<string, unknown>; reason: string; labels: string | null }) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.target(category, target)
      const previous = row && this.rawActive(row)
      const values = patch && previous !== undefined ? { ...JSON.parse(previous), ...command.values } : command.values
      return this.publish(category, target, values, command.reason, command.labels, row, previous)
    })
  }

  activate(category: string, target: string, version: number) {
    return this.ctx.storage.transactionSync(() => {
      this.requireTarget(category, target)
      const snapshot = this.version(category, target, version)
      const now = new Date().toISOString()
      this.ctx.sql.exec(`UPDATE ${table} SET active_version = ?, updated_at = ?, updated_by = ?, last_accessed_at = ?
        WHERE ${targetScope}`, version, now, this.id[1], now, ...this.id, category, target)
      return publicSnapshot(snapshot)
    })
  }

  deleteField(category: string, target: string, field: string) {
    return this.ctx.storage.transactionSync(() => {
      const row = this.requireTarget(category, target)
      const previous = this.rawActive(row)
      const values = JSON.parse(previous) as Record<string, unknown>
      if (!Object.hasOwn(values, field)) throw notFound()
      delete values[field]
      const targetDeleted = Object.keys(values).length === 0
      let version: number | null = null
      if (targetDeleted) this.removeTarget(category, target)
      else version = this.publish(category, target, values, 'Field deleted', null, row, previous).version
      return { owner_user_id: this.id[1], category, target_key: target, field, deleted: true,
        scope: 'field', target_deleted: targetDeleted, active_version: version }
    })
  }

  private removeTarget(category: string, target: string): boolean {
    return this.ctx.sql.exec(`DELETE FROM ${table} WHERE ${targetScope}`, ...this.id, category, target).rowsWritten > 0
  }

  deleteTarget(category: string, target: string): boolean {
    return this.ctx.storage.transactionSync(() => this.removeTarget(category, target))
  }
}
