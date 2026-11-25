// SPDX-License-Identifier: AGPL-3.0-only
import { configuredPrincipals } from '../auth.js'
import type { Env } from '../context.js'
import { isRecord } from '../http.js'
import { approvalToken, backupOptIns, scopeFor, sign, verifies } from './backup-authority.js'
import type { Scope } from './backup-authority.js'
import { strictJson } from './backup-codec.js'
import { fail, invalid } from './common.js'

export const INSTANCE_ACCOUNTS = 8
export const instanceId = (v: unknown): v is string => typeof v === 'string' && v.length === 32 && /^[a-f0-9]+$/.test(v)
export const hashId = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]+$/.test(v)
export const controlName = 'openviking:control:v1'
export const workspaceName = (account: string) => `openviking:account:${account}`
export const offline = (): never => fail(503, 'INSTANCE_MAINTENANCE', 'This instance is not serving requests.')
export const refused = (): never => fail(403, 'INSTANCE_BACKUP_AUTHORITY', 'An independent operator mount for this instance operation is required.')
export const unsupported = (): never => fail(409, 'INSTANCE_BACKUP_INVENTORY', 'The complete provisioned and opted-in instance inventory cannot be established.')
export const coldRequired = (): never => fail(409, 'INSTANCE_BACKUP_NOT_COLD', 'Recovery requires a fresh, unserved target. No live merge is supported.')
export const wrongStage = (): never => fail(409, 'INSTANCE_BACKUP_STAGE', 'The recovery stage or recorded package does not match. Read the durable status before retrying.')

export type Endpoint = { id: string; control: string }
export type Pair = { source: Endpoint; destination: Endpoint }
export type Mount = Pair & { mode: 'source' | 'standby'; local: Endpoint; key: string }
export type ControlCommand = 'capture' | 'evaluate' | 'begin' | 'step' | 'status' | 'release'
export const withAttachments = 'edge-v1-attachments'
export type InstanceProfile = 'edge-v1' | typeof withAttachments
type MemberScope = { account: string; capture: string; profile?: typeof withAttachments }
export type MemberCall = MemberScope & ({ op: 'capture' } | { op: 'evaluate' | 'apply' | 'receipt'; job: string; sha256: string; plan?: string })

export function captureProfile(value: unknown): InstanceProfile {
  if (value === undefined || value === 'edge-v1') return 'edge-v1'
  if (value === withAttachments) return value
  return invalid('Unknown instance capture profile.')
}

export function instanceKey(env: Env): string {
  const key = env.OPENVIKING_EDGE_INSTANCE_BACKUP_KEY
  if (!hashId(key) || key === env.OPENVIKING_EDGE_BACKUP_KEY || configuredPrincipals(env).some(p => p.key === key)) return refused()
  return key
}

export function instanceMode(env: Env): { id: string; peerId: string; peerControl: string; mode: Mount['mode'] } | undefined {
  if (env.OPENVIKING_EDGE_INSTANCE_BACKUP === undefined) return undefined
  const config = env.OPENVIKING_EDGE_INSTANCE_BACKUP
  let v: unknown
  try { if (config.length <= 512) v = strictJson(config, 2) } catch { return offline() }
  if (!isRecord(v) || Object.keys(v).length !== 4 || !instanceId(v.instance_id) || !instanceId(v.peer_id) ||
      v.instance_id === v.peer_id || !hashId(v.peer_control) || (v.mode !== 'source' && v.mode !== 'standby')) return offline()
  return { id: v.instance_id, peerId: v.peer_id, peerControl: v.peer_control, mode: v.mode }
}

export function instanceMount(env: Env): Mount {
  const conf = instanceMode(env), key = instanceKey(env)
  if (!conf || !env.CONTROL || !env.WORKSPACES) return refused()
  const control = env.CONTROL.idFromName(controlName).toString()
  if (!hashId(control) || control === conf.peerControl) return refused()
  const local = { id: conf.id, control }, peer = { id: conf.peerId, control: conf.peerControl }
  return conf.mode === 'source' ? { mode: conf.mode, key, local, source: local, destination: peer }
    : { mode: conf.mode, key, local, source: peer, destination: local }
}

export function instanceScopes(env: Env) {
  const optIns = [...backupOptIns(env).keys()].sort()
  const configured = [...new Set(configuredPrincipals(env).filter(p => p.caller.role !== 'root').map(p => p.caller.accountId))].sort()
  if (!optIns.length || optIns.length > INSTANCE_ACCOUNTS || JSON.stringify(optIns) !== JSON.stringify(configured)) return unsupported()
  return optIns.map(account => scopeFor(env, account))
}

function pairFields(m: Pair) { return [m.source.id, m.source.control, m.destination.id, m.destination.control] }
function pairKey(m: Mount) { return { key: m.key, account: 'instance', realm: m.source.id } }
export function signInstance(m: Mount, label: string, ...data: unknown[]) {
  return sign(pairKey(m), `instance:v1:${label}`, ...pairFields(m), ...data)
}
export function verifyInstance(m: Mount, label: string, mac: string, ...data: unknown[]) {
  return verifies(pairKey(m), `instance:v1:${label}`, mac, ...pairFields(m), ...data)
}

/** Bind the effective fixed seats without copying a registry, role assignments or any credential fingerprints. */
export function instanceSeats(env: Env, account: string) {
  return configuredPrincipals(env).filter(p => p.caller.accountId === account && p.caller.role !== 'root').map(({ caller }) => caller)
}
export function rosterTag(env: Env, m: Mount, scope: Scope) {
  const seats = [...new Set(instanceSeats(env, scope.account).map(p => JSON.stringify([p.userId, p.agentId, p.role])))].sort()
  return signInstance(m, 'roster', scope.account, scope.realm, seats)
}

type Rpc = ControlCommand | MemberCall
const permitTtl = 30_000
function rpcFields(m: Mount, call: Rpc) {
  return [m.local.id, typeof call === 'string' ? [call] : [call.op, call.account, call.capture,
    ...(call.op === 'capture' ? [] : [call.job, call.sha256, call.plan ?? null]), ...(call.profile ? [call.profile] : [])]]
}
export async function instancePermit(m: Mount, call: Rpc) {
  const expires_at = Date.now() + permitTtl
  return { expires_at, mac: await signInstance(m, 'rpc', expires_at, ...rpcFields(m, call)) }
}

export async function admitInstancePermit(m: Mount, call: Rpc, raw: unknown): Promise<() => void> {
  // The parser also bounds lengths and rejects extra fields.
  const { mac, expires_at } = approvalToken(raw)
  if (expires_at > Date.now() + permitTtl || !await verifyInstance(m, 'rpc', mac, expires_at, ...rpcFields(m, call))) return refused()
  const live = () => { if (expires_at <= Date.now()) refused() }
  live()
  return live
}

/** A compatibility-shaped seal with independent key AND context. It is never a F3 archive or permit MAC. */
export function memberSeal(m: Mount, capture: string, profile?: typeof withAttachments) {
  if (!instanceId(capture)) return invalid('Invalid instance capture identifier.')
  return { key: m.key, label: `instance-member:${profile ? 'v2' : 'v1'}:${pairFields(m).join(':')}:${capture}` }
}
