// SPDX-License-Identifier: AGPL-3.0-only
import { configuredPrincipals, controlFor } from '../auth.js'
import type { Env } from '../context.js'
import { ApiError, apiError, isRecord } from '../http.js'
import { encoder, fail, forbidden, invalid, quota } from './common.js'
import { ownerId, strictJson, topology } from './backup-codec.js'
import { ZIP_BYTES } from './zip.js'

export const backupAccountId = /^[A-Za-z0-9_-]{1,48}$/
const hex64 = /^[a-f0-9]{64}$/
const permitMs = 30_000
export const approvalMs = 5 * 60_000
export type Operation = 'capture' | 'evaluate' | 'apply'
export type Permit = { account: string; expires_at: number; mac: string }
export type Approval = { expires_at: number; mac: string }
export type Scope = { account: string; realm: string; users: string[]; sessionOwners: string[]; key: string }

const disabled = (): never => forbidden('This operation requires a private operator binding and a named backup opt-in.')
const badConfig = (): never => fail(503, 'BACKUP_POLICY_UNAVAILABLE', 'The backup authority is not configured correctly.')

export function backupOptIns(env: Env): Map<string, string> {
  if (!env.OPENVIKING_EDGE_BACKUP_POLICY) return disabled()
  const { OPENVIKING_EDGE_BACKUP_KEY: key } = env
  if (env.OPENVIKING_EDGE_BACKUP_POLICY.length > 8192 || !key || !hex64.test(key)) return badConfig()
  let policy: unknown
  try { policy = strictJson(env.OPENVIKING_EDGE_BACKUP_POLICY) } catch { return badConfig() }
  if (!Array.isArray(policy) || policy.length > 32) return badConfig()
  const realms = new Map<string, string>(), realmIds = new Set<string>()
  for (const rule of policy) {
    if (!isRecord(rule) || Object.keys(rule).length !== 2 || typeof rule.account_id !== 'string' || !backupAccountId.test(rule.account_id) ||
        typeof rule.scope_id !== 'string' || !/^[a-f0-9]{32}$/.test(rule.scope_id) || realms.has(rule.account_id) || realmIds.has(rule.scope_id)) return badConfig()
    realms.set(rule.account_id, rule.scope_id); realmIds.add(rule.scope_id)
  }
  return realms
}

export function scopeFor(env: Env, target: unknown): Scope {
  if (typeof target !== 'string' || !backupAccountId.test(target)) return invalid('A backup target must be one explicit account ID.')
  const realm = backupOptIns(env).get(target)
  if (!realm) return disabled()
  const key = env.OPENVIKING_EDGE_BACKUP_KEY!
  const principals = configuredPrincipals(env)
  if (principals.some(p => p.key === key)) return badConfig()
  const locals = principals.filter(p => p.caller.accountId === target && p.caller.role !== 'root')
  const users = [...new Set(locals.map(p => p.caller.userId))].sort()
  if (!locals.some(p => p.caller.role === 'admin') || users.some(user => !ownerId.test(user))) topology('Backup requires a pre-provisioned fixed account with compatible owners.')
  const sessionOwners = [...new Set(locals.filter(p => p.caller.agentId === 'default').map(p => p.caller.userId))].sort()
  return { account: target, realm, users, sessionOwners, key }
}

export async function assertFixedDirectory(env: Env, scope: Scope): Promise<void> {
  const control = controlFor(env) as unknown as { backupFixedTopology(account: string, users: string[]): Promise<boolean> } | null
  if (!control) return topology('Backup requires the fixed Control directory.')
  let accepted: boolean
  try { accepted = await control.backupFixedTopology(scope.account, scope.users) }
  catch { return fail(503, 'BACKUP_POLICY_UNAVAILABLE', 'The backup account topology could not be verified.') }
  if (!accepted) topology('Backup requires a provisioned fixed account without managed or retired seats or Control-owned user settings.')
}

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g)!, pair => Number.parseInt(pair, 16))
export const hexOf = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
type SigningScope = Pick<Scope, 'account' | 'realm' | 'key'>
async function signature(scope: SigningScope, label: string, payload: readonly unknown[], mac?: string): Promise<string | boolean> {
  const key = await crypto.subtle.importKey('raw', bytesOf(scope.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const data = encoder.encode(JSON.stringify(['openviking:backup:v1', label, scope.account, scope.realm, ...payload]))
  if (mac !== undefined) return hex64.test(mac) && crypto.subtle.verify('HMAC', key, bytesOf(mac), data)
  return hexOf(new Uint8Array(await crypto.subtle.sign('HMAC', key, data)))
}
export const sign = (scope: SigningScope, label: string, ...payload: unknown[]) => signature(scope, label, payload) as Promise<string>
export const verifies = (scope: SigningScope, label: string, mac: string, ...payload: unknown[]) => signature(scope, label, payload, mac) as Promise<boolean>

function timedMac(value: unknown, period: number): Approval | undefined {
  if (!isRecord(value) || typeof value.mac !== 'string' || !hex64.test(value.mac) || typeof value.expires_at !== 'number' ||
      !Number.isSafeInteger(value.expires_at) || value.expires_at > Date.now() + period) return
  return { mac: value.mac, expires_at: value.expires_at }
}

export function assertPermitLive(permit: Permit): void {
  if (permit.expires_at <= Date.now()) disabled()
}

export async function admitPermit(env: Env, namedWorkspace: (account: string) => boolean, raw: unknown, operation: Operation): Promise<{ scope: Scope; permit: Permit }> {
  const timed = timedMac(raw, permitMs)
  if (!isRecord(raw) || typeof raw.account !== 'string' || !timed || Object.keys(raw).length !== 3) return disabled()
  const permit = { account: raw.account, ...timed }
  assertPermitLive(permit)
  const scope = scopeFor(env, permit.account)
  if (!namedWorkspace(scope.account) || !await verifies(scope, `rpc:${operation}`, permit.mac, permit.expires_at, scope.users, scope.sessionOwners)) return disabled()
  return { scope, permit }
}

export async function issuePermit(scope: Scope, operation: Operation): Promise<Permit> {
  const expires_at = Date.now() + permitMs
  return { account: scope.account, expires_at, mac: await sign(scope, `rpc:${operation}`, expires_at, scope.users, scope.sessionOwners) }
}

export function approvalToken(value: unknown): Approval {
  const token = timedMac(value, approvalMs)
  if (!token || !isRecord(value) || Object.keys(value).length !== 2) return invalid('Apply requires a backup evaluation receipt.')
  return token
}

export function zipBuffer(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || !value.byteLength) return invalid('A nonempty backup ZIP is required.')
  if (value.byteLength > ZIP_BYTES) quota('Backup ZIP exceeds its byte limit.')
  return value
}

export async function backupResponse(run: () => Promise<Response>): Promise<Response> {
  try { return await run() }
  catch (error) {
    const response = apiError(error instanceof ApiError ? error : undefined, crypto.randomUUID())
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }
}
