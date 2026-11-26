// SPDX-License-Identifier: AGPL-3.0-only
import { sessionColumns, sessionForeignKey, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { invalid, isRecord, unsupported } from './protocol.js'
import { edgeSessionDefaults } from '../model-config.js'

const defaults = { pending_token_threshold: edgeSessionDefaults.pendingTokenThreshold, message_count_threshold: edgeSessionDefaults.messageThreshold,
  idle_timeout_seconds: 0, keep_recent_count: 0, min_commit_interval_seconds: 0 }
export type AutoPolicy = Record<keyof typeof defaults, number>
const maxima: AutoPolicy = { pending_token_threshold: 1_000_000, message_count_threshold: 1_000,
  idle_timeout_seconds: 604_800, keep_recent_count: 1_000, min_commit_interval_seconds: 604_800 }
type PolicyRow = { policy: string | null, revision: string, last_auto_commit_at: string }

export function initAutoPolicy(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_auto_commit (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,
    policy TEXT,revision TEXT NOT NULL,last_auto_commit_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
}

export function validateAutoPolicy(value: unknown, idleAvailable = false): Partial<AutoPolicy> | null | undefined {
  if (value === undefined || value === null) return value
  if (!isRecord(value)) invalid('auto_commit_policy must be an object or null.')
  const out: Partial<AutoPolicy> = {}
  for (const [key, n] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key) || typeof n !== 'number' || !Number.isSafeInteger(n)) {
      invalid('Invalid auto_commit_policy field; fields must be recognized integers.')
    }
    const field = key as keyof AutoPolicy
    if (field === 'idle_timeout_seconds' && n !== 0) {
      if (n < 300) invalid('idle_timeout_seconds must be 0 or at least 300.')
      if (!idleAvailable) unsupported('Idle auto-commit needs a mounted durable delayed scheduler.')
    }
    out[field] = Math.max(0, Math.min(maxima[field], n))
  }
  return out
}

export function autoState(sql: SqlStorage, key: SessionKey) {
  const row = sql.exec<PolicyRow>(`SELECT policy,revision,last_auto_commit_at FROM ov_session_auto_commit WHERE ${sessionWhere}`,
    ...key).toArray()[0]
  return { policy: row?.policy ? JSON.parse(row.policy) as AutoPolicy : null, revision: row?.revision,
    last: row?.last_auto_commit_at ?? '' }
}

export function setAutoPolicy(sql: SqlStorage, key: SessionKey, update: Partial<AutoPolicy> | null): void {
  const current = autoState(sql, key)
  const next = update === null ? null : JSON.stringify({ ...defaults, ...current.policy, ...update })
  sql.exec(`INSERT INTO ov_session_auto_commit (${sessionColumns},policy,revision) VALUES (?,?,?,?,?,?)
    ON CONFLICT (${sessionColumns}) DO UPDATE SET policy=excluded.policy,revision=excluded.revision`, ...key, next, crypto.randomUUID())
}

export function noteAutoSuccess(sql: SqlStorage, key: SessionKey, at: string): void {
  sql.exec(`UPDATE ov_session_auto_commit SET last_auto_commit_at=? WHERE ${sessionWhere}`, at, ...key)
}
