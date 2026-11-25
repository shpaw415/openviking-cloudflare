// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, WorkspaceContext } from '../context.js'
import { GatewayError, digest, displayName, fields, forbidden, invalid, missing, modelId, objectId, protocols, unsupported } from './contract.js'
import type { Protocol } from './contract.js'

export type KeyAuthority = { caller: Caller; digest: string; managed: boolean }
type KeySpec = { name: string; policy_id: string; upstream_ids: string[]; models: string[] }
type PublicKey = KeySpec & { id: string; revision: number; user_id: string; prefix: string; created_at: number }
export type GatewayKeyRow = {
  digest: string; account_id: string; user_id: string; agent_id: string; role: Caller['role'];
  backing_digest: string; managed: number; prefix: string; created_at: number; spec: string;
}
export interface GatewayKeyAdmin {
  issuer: KeyAuthority;
  resolve(raw: string): Promise<KeyAuthority>;
  verify(owner: KeyAuthority): Promise<void>;
  register(owner: KeyAuthority, digest: string, live: string[]): Promise<void>;
}
export const invalidGatewayKey = () => new GatewayError(401, 'gateway_key_invalid', 'The Gateway key is invalid or revoked.')
export const disabledKeys = () => unsupported('Dedicated Gateway keys are not available.', 'gateway_keys_unavailable')
const table = 'ov_gateway_keys'
const busy = new WeakSet<DurableObjectStorage>()

export function initKeys(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    digest TEXT NOT NULL CHECK(length(digest)=64), account_id TEXT NOT NULL, user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')),
    backing_digest TEXT NOT NULL CHECK(length(backing_digest)=64), managed INTEGER NOT NULL CHECK(managed IN (0,1)),
    prefix TEXT NOT NULL CHECK(length(prefix)=12), created_at REAL NOT NULL, spec TEXT NOT NULL,
    PRIMARY KEY(account_id,digest)
  ) WITHOUT ROWID`)
}

export function keyByDigest(sql: SqlStorage, account: string, id: string): GatewayKeyRow | undefined {
  return sql.exec<GatewayKeyRow>(`SELECT * FROM ${table} WHERE account_id=? AND digest=?`, account, id).toArray()[0]
}

export function keyOwner(row: GatewayKeyRow): KeyAuthority {
  return { caller: { accountId: row.account_id, userId: row.user_id, agentId: row.agent_id, role: row.role },
    digest: row.backing_digest, managed: row.managed === 1 }
}

export const keySpec = (row: GatewayKeyRow): KeySpec => JSON.parse(row.spec) as KeySpec
function publicKey(row: GatewayKeyRow): PublicKey {
  return { ...keySpec(row), id: row.digest, revision: 1, user_id: row.user_id, prefix: row.prefix, created_at: row.created_at }
}

const all = (ctx: WorkspaceContext) => ctx.sql.exec<GatewayKeyRow>(
  `SELECT * FROM ${table} WHERE account_id=? ORDER BY created_at DESC,digest`, ctx.caller.accountId).toArray()
const visible = (ctx: WorkspaceContext, row: GatewayKeyRow) => ctx.caller.role === 'admin' || row.user_id === ctx.caller.userId
export const listKeys = (ctx: WorkspaceContext) => all(ctx).filter(row => visible(ctx, row)).map(publicKey)
function findKey(ctx: WorkspaceContext, id: string) {
  const row = keyByDigest(ctx.sql, ctx.caller.accountId, id)
  if (row && !visible(ctx, row)) throw missing()
  return row
}

export function inspectKey(ctx: WorkspaceContext, id: string) {
  const row = findKey(ctx, id)
  if (!row) throw missing()
  return publicKey(row)
}

export function revokeKey(ctx: WorkspaceContext, id: string) {
  if (findKey(ctx, id)) deleteKeyDigest(ctx.sql, ctx.caller.accountId, id)
  return { deleted: true }
}

/** Called only after ownership is established, including invalidation of a backing grant. */
export function deleteKeyDigest(sql: SqlStorage, account: string, digest: string) {
  sql.exec(`DELETE FROM ${table} WHERE account_id=? AND digest=?`, account, digest)
}

export function revokeUserKeys(ctx: WorkspaceContext, user: string) {
  ctx.sql.exec(`DELETE FROM ${table} WHERE account_id=? AND user_id=?`, ctx.caller.accountId, user)
}

export function assertKeyObjectUnused(ctx: WorkspaceContext, kind: 'policy' | 'upstream', id: string) {
  const keyCount = all(ctx).filter(row => {
    const spec = keySpec(row)
    return kind === 'policy' ? spec.policy_id === id : spec.upstream_ids.includes(id)
  }).length
  if (keyCount) throw new GatewayError(409, 'in_use', 'Gateway keys still use this object.', { key_count: keyCount })
}

export async function issueKey(ctx: WorkspaceContext, admin: GatewayKeyAdmin, data: Record<string, unknown>, validate: (spec: KeySpec) => void) {
  fields(data, ['name','policy_id','upstream_ids','models','user_id','openviking_key','default_peer_id'])
  if (data.default_peer_id !== undefined && data.default_peer_id !== null && data.default_peer_id !== '') {
    throw unsupported('Peer selection is not available for Gateway recall.', 'peer_scope_unsupported')
  }
  const ids = data.upstream_ids, models = data.models === undefined ? [] : data.models
  if (typeof data.policy_id !== 'string' || !Array.isArray(ids) || ids.length < 1 || ids.length > 32 || !ids.every(item => typeof item === 'string') ||
      !Array.isArray(models) || models.length > 64 || !models.every(modelId)) throw invalid('Expected a profile and a bounded list of upstreams and models.')
  const spec = { name: displayName(data.name), policy_id: objectId(data.policy_id), upstream_ids: [...new Set(ids.map(objectId))], models: [...new Set(models)] }
  const wanted = data.user_id
  if (wanted !== undefined && wanted !== null && (typeof wanted !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(wanted))) throw invalid('Invalid user identifier.')
  if (ctx.caller.role !== 'admin' && wanted != null && wanted !== ctx.caller.userId) throw forbidden()
  const raw = data.openviking_key ?? ''
  if (typeof raw !== 'string' || (raw && (!/^[A-Za-z0-9_-]{32,128}$/.test(raw) || raw.startsWith('ovgw_')))) throw invalid('Expected a current OpenViking data credential.')
  if (!raw && wanted != null && wanted !== ctx.caller.userId) throw new GatewayError(409, 'user_key_unreadable', 'Supply the intended user’s current OpenViking key.')
  if (busy.has(ctx.storage)) throw new GatewayError(409, 'conflict', 'Another Gateway key is being issued. Retry shortly.')
  busy.add(ctx.storage)
  try {
    const owner = raw ? await admin.resolve(raw) : admin.issuer
    if (owner.caller.accountId !== ctx.caller.accountId) throw new GatewayError(403, 'other_account', 'The owner is outside this account.')
    if ((wanted != null && owner.caller.userId !== wanted) || (ctx.caller.role !== 'admin' &&
      (owner.caller.userId !== ctx.caller.userId || owner.caller.agentId !== ctx.caller.agentId))) throw forbidden()
    const live = all(ctx)
    if (live.length >= 128 || live.filter(row => row.user_id === owner.caller.userId).length >= 16) throw new GatewayError(429, 'key_limit', 'The scoped Gateway key limit was reached.')
    validate(spec)
    const secret = 'ovgw_' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const id = await digest(secret)
    // Check fixed credentials from the current bindings, then atomically check
    // both managed grants in Control's locator transaction. An index entry
    // cannot admit on its own; Workspace still has to commit the usable row.
    await Promise.all([ctx.reauthorize?.(), admin.verify(owner)])
    await admin.register(owner, id, live.map(row => row.digest))
    const saved = ctx.storage.transactionSync(() => {
      validate(spec)
      const row: GatewayKeyRow = { digest: id, account_id: owner.caller.accountId, user_id: owner.caller.userId,
        agent_id: owner.caller.agentId, role: owner.caller.role, backing_digest: owner.digest, managed: Number(owner.managed),
        prefix: secret.slice(0, 12), created_at: Date.now() / 1000, spec: JSON.stringify(spec) }
      ctx.sql.exec(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?,?,?)`, row.digest, row.account_id, row.user_id, row.agent_id,
        row.role, row.backing_digest, row.managed, row.prefix, row.created_at, row.spec)
      return publicKey(row)
    })
    return { ...saved, key: secret }
  } finally { busy.delete(ctx.storage) }
}

export async function resetKeyCapture(ctx: WorkspaceContext, admin: GatewayKeyAdmin, id: string, data: Record<string, unknown>, reset: (caller: Caller, protocol: Protocol, label: string, hash: string) => void) {
  fields(data, ['session', 'protocol'])
  if (typeof data.session !== 'string' || !/^[A-Za-z0-9_@.-]{1,128}$/.test(data.session) || !protocols.includes(data.protocol as Protocol)) {
    throw invalid('Expected a Gateway session identifier and protocol.')
  }
  const hash = await digest(data.session)
  await ctx.reauthorize?.()
  const row = findKey(ctx, id)
  if (!row) throw missing()
  await admin.verify(keyOwner(row))
  await ctx.reauthorize?.()
  if (!findKey(ctx, id)) throw missing()
  reset(keyOwner(row).caller, data.protocol as Protocol, data.session, hash)
  return { status: 'ready', message: 'The next captured turn will start a fresh OpenViking session.' }
}
