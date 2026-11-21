// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller } from '../context.js'
import type { OpenIntent } from './intents.js'
import { CODE_TTL, TOKEN_TTL, OAuthError, invalidGrant, unavailableFlow } from './protocol.js'
import type { Intent } from './protocol.js'

type KeyBinding = {
  key_digest: string; account_id: string; user_id: string; agent_id: string; key_role: Caller['role'];
}
type ClientBinding = Pick<Intent, 'client_id' | 'redirect_uri' | 'resource'>
type RecordTime = { expires_at: number }
type Receipt = RecordTime & KeyBinding & { stage: 'approved' | 'denied' | 'used' }
export type Code = Omit<Intent, 'state'> & KeyBinding & RecordTime
export type Token = ClientBinding & KeyBinding & RecordTime

export function callerBinding(keyDigest: string, caller: Caller): KeyBinding {
  return { key_digest: keyDigest, account_id: caller.accountId, user_id: caller.userId, agent_id: caller.agentId, key_role: caller.role }
}

function identity(row: KeyBinding) {
  return [row.key_digest, row.account_id, row.user_id, row.agent_id, row.key_role] as const
}

export function sameBinding(row: KeyBinding, caller: Caller): boolean {
  return row.account_id === caller.accountId && row.user_id === caller.userId && row.agent_id === caller.agentId && row.key_role === caller.role
}

const bound = ['key_digest', 'account_id', 'user_id', 'agent_id', 'key_role'].map(field => `${field} TEXT NOT NULL`).join(', ')
const client = 'client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT NOT NULL'
const columns = 'client_id, redirect_uri, resource'
const keyColumns = 'key_digest, account_id, user_id, agent_id, key_role'
const keysTable = 'oauth_intent_keys'
const receiptsTable = 'oauth_intent_receipts'
const codesTable = 'oauth_codes'
const grantsTable = 'oauth_grants'
const quotas = {
  [receiptsTable]: { owner: 8, account: 32, total: 512 },
  [codesTable]: { owner: 8, account: 32, total: 256 },
  [grantsTable]: { owner: 16, account: 64, total: 1024 },
} as const
type AdmissionTable = keyof typeof quotas
const limited = () => new OAuthError(429, 'temporarily_unavailable', 'Authorization capacity is temporarily exhausted.')

export class OAuthStore {
  readonly #sql: SqlStorage
  constructor(private readonly storage: DurableObjectStorage) {
    this.#sql = storage.sql
    storage.transactionSync(() => {
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${keysTable} (epoch INTEGER PRIMARY KEY, material BLOB NOT NULL CHECK(length(material) = 32)) WITHOUT ROWID`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${receiptsTable} (digest TEXT PRIMARY KEY, ${bound},
        stage TEXT NOT NULL CHECK (stage IN ('approved','denied','used')), expires_at INTEGER NOT NULL) WITHOUT ROWID`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${codesTable} (digest TEXT PRIMARY KEY,
        ${client}, challenge TEXT NOT NULL, ${bound}, expires_at INTEGER NOT NULL) WITHOUT ROWID`)
      this.#sql.exec(`CREATE TABLE IF NOT EXISTS ${grantsTable} (digest TEXT PRIMARY KEY,
        ${client}, ${bound}, expires_at INTEGER NOT NULL) WITHOUT ROWID`)
      for (const table of Object.keys(quotas)) {
        this.#sql.exec(`CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table}(expires_at)`)
        this.#sql.exec(`CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(account_id, user_id)`)
      }
    })
  }

  intentKey(epoch: number, create: boolean): ArrayBuffer | undefined {
    const existing = this.#sql.exec<{ material: ArrayBuffer }>(`SELECT material FROM ${keysTable} WHERE epoch = ?`, epoch).toArray()[0]
    if (existing || !create) return existing?.material
    // One lazy key write per hour, independent of the number of clients or
    // intents. Reads and invalid cookies never generate key material.
    return this.storage.transactionSync(() => {
      const newest = this.#sql.exec<{ epoch: number }>(`SELECT epoch FROM ${keysTable} ORDER BY epoch DESC LIMIT 1`).toArray()[0]
      if (newest && newest.epoch >= epoch) return undefined
      const material = crypto.getRandomValues(new Uint8Array(32)).buffer
      this.#sql.exec(`DELETE FROM ${keysTable} WHERE epoch < ?`, epoch - 1)
      this.#sql.exec(`INSERT INTO ${keysTable} (epoch, material) VALUES (?, ?)`, epoch, material)
      return material
    })
  }

  private admit(table: AdmissionTable, binding: KeyBinding, now: number) {
    // Only after a managed decision, an already-approved code mint, or a
    // validated exchange. Scopes aggregate across the owner's key versions.
    this.#sql.exec(`DELETE FROM ${table} WHERE expires_at <= ?`, now)
    const { owner, account, total } = quotas[table]
    if (this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ? AND user_id = ?`,
      binding.account_id, binding.user_id).one().n >= owner ||
      this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, binding.account_id).one().n >= account ||
      this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n >= total) throw limited()
  }

  receipt(handle: string, expiresAt: number, now = Date.now()): Receipt | undefined {
    return this.#sql.exec<Receipt>(`SELECT ${keyColumns}, stage, expires_at FROM ${receiptsTable}
      WHERE digest = ? AND expires_at = ? AND expires_at > ?`, handle, expiresAt, now).toArray()[0]
  }

  decide(handle: string, expiresAt: number, binding: KeyBinding, decision: 'approve' | 'deny'): void {
    this.storage.transactionSync(() => {
      const now = Date.now()
      if (expiresAt <= now || this.receipt(handle, expiresAt, now)) throw unavailableFlow()
      this.admit(receiptsTable, binding, now)
      const changed = this.#sql.exec<{ admitted: number }>(`INSERT INTO ${receiptsTable} (digest, ${keyColumns}, stage, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING RETURNING 1 AS admitted`, handle, ...identity(binding),
      decision === 'approve' ? 'approved' : 'denied', expiresAt).toArray()
      if (changed.length !== 1) throw unavailableFlow()
    })
  }

  issueCode(handle: string, input: OpenIntent, codeHash: string): void {
    this.storage.transactionSync(() => {
      const now = Date.now()
      const row = this.receipt(handle, input.expiresAt, now)
      if (!row || row.stage !== 'approved') throw unavailableFlow()
      this.admit(codesTable, row, now)
      this.#sql.exec(`INSERT INTO ${codesTable} (digest, ${columns}, challenge, ${keyColumns}, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, codeHash, input.client_id, input.redirect_uri, input.resource,
      input.challenge, ...identity(row), now + CODE_TTL * 1000)
      // Keep the receipt until the capsule expires, even after code exchange.
      this.#sql.exec(`UPDATE ${receiptsTable} SET stage = 'used' WHERE digest = ?`, handle)
    })
  }

  code(codeHash: string, now = Date.now()): Code | undefined {
    return this.#sql.exec<Code>(`SELECT ${columns}, challenge, ${keyColumns}, expires_at
      FROM ${codesTable} WHERE digest = ? AND expires_at > ?`, codeHash, now).toArray()[0]
  }

  issueToken(codeHash: string, tokenHash: string): void {
    this.storage.transactionSync(() => {
      const now = Date.now()
      const row = this.code(codeHash, now)
      if (!row) throw invalidGrant()
      this.admit(grantsTable, row, now)
      this.#sql.exec(`INSERT INTO ${grantsTable} (digest, ${columns}, ${keyColumns}, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tokenHash, row.client_id, row.redirect_uri, row.resource,
      ...identity(row), now + TOKEN_TTL * 1000)
      this.#sql.exec(`DELETE FROM ${codesTable} WHERE digest = ?`, codeHash)
    })
  }

  token(tokenHash: string): Token | undefined {
    return this.#sql.exec<Token>(`SELECT ${columns}, ${keyColumns}, expires_at FROM ${grantsTable}
      WHERE digest = ? AND expires_at > ?`, tokenHash, Date.now()).toArray()[0]
  }
}
