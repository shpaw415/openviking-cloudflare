// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { GatewayError, missing } from './contract.js'
import type { Protocol } from './contract.js'
import { defaultProfile } from './profiles.js'
import type { Profile, SavedProfile } from './profiles.js'
import { defaults } from './providers.js'
import type { GatewayContext, SavedUpstream, Upstream } from './providers.js'
import { initResponses } from './responses.js'

const account = (ctx: WorkspaceContext) => ctx.caller.accountId
const owner = (ctx: WorkspaceContext) => [account(ctx), ctx.caller.userId, ctx.caller.agentId] as const
type ObjectKind = 'policy' | 'upstream'
type Row = { id: string; revision: number; payload: string }
type State = { conversation: string; session_id: string | null; recall_spent: number }
const stateKey = 'account_id=? AND user_id=? AND agent_id=? AND protocol=? AND name_hash=?'
const logLimit = 10_000
const retentionDays = 7
const second = () => Date.now() / 1000

export function initStore({ sql }: WorkspaceContext): void {
  initResponses(sql)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_objects (
    account_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('policy','upstream')), id TEXT NOT NULL,
    revision INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(account_id,kind,id)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_config (
    account_id TEXT NOT NULL PRIMARY KEY, object_epoch INTEGER NOT NULL
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_state (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, protocol TEXT NOT NULL, name_hash TEXT NOT NULL,
    conversation TEXT NOT NULL, session_id TEXT, recall_spent INTEGER NOT NULL,
    PRIMARY KEY(account_id,user_id,agent_id,protocol,name_hash)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_log (
    seq INTEGER PRIMARY KEY, account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    time REAL NOT NULL, payload TEXT NOT NULL
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_gateway_log_account ON ov_gateway_log(account_id,seq DESC)')
  sql.exec('CREATE INDEX IF NOT EXISTS ov_gateway_log_user ON ov_gateway_log(account_id,user_id,seq DESC)')
  sql.exec('CREATE INDEX IF NOT EXISTS ov_gateway_log_age ON ov_gateway_log(account_id,time)')
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_budget (
    account_id TEXT NOT NULL, subject TEXT NOT NULL, day INTEGER NOT NULL, calls INTEGER NOT NULL, units INTEGER NOT NULL,
    PRIMARY KEY(account_id,subject)
  ) WITHOUT ROWID`)
}

function rows(ctx: WorkspaceContext, kind: ObjectKind): Row[] {
  return ctx.sql.exec<Row>('SELECT id,revision,payload FROM ov_gateway_objects WHERE account_id=? AND kind=? ORDER BY id',
    account(ctx), kind).toArray()
}

export function profileList(ctx: WorkspaceContext): SavedProfile[] {
  return rows(ctx, 'policy').map(({ id, revision, payload }) => ({ ...JSON.parse(payload) as Profile, id, revision }))
}

export function profileFor(ctx: WorkspaceContext): Profile {
  return profileList(ctx).find(item => item.id === 'default') ?? defaultProfile
}

export function upstreamList(ctx: GatewayContext): SavedUpstream[] {
  const stored = rows(ctx, 'upstream').map(({ id, revision, payload }) => ({ ...JSON.parse(payload) as Upstream, id, revision }))
  return stored.length ? stored : defaults(ctx)
}

export function epoch(ctx: WorkspaceContext): number {
  return ctx.sql.exec<{ object_epoch: number }>('SELECT object_epoch FROM ov_gateway_config WHERE account_id=?', account(ctx))
    .toArray()[0]?.object_epoch ?? 0
}

function touchConfig(ctx: WorkspaceContext): void {
  ctx.sql.exec(`INSERT INTO ov_gateway_config VALUES (?,1) ON CONFLICT(account_id) DO UPDATE SET object_epoch=object_epoch+1`, account(ctx))
}

export function save<T extends Profile | Upstream>(ctx: WorkspaceContext, kind: ObjectKind, id: string, value: T): T & { id: string; revision: number } {
  return ctx.storage.transactionSync(() => {
    const { sql } = ctx, who = account(ctx)
    const existing = sql.exec<{ revision: number }>('SELECT revision FROM ov_gateway_objects WHERE account_id=? AND kind=? AND id=?', who, kind, id).toArray()[0]
    if (!existing && sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_gateway_objects WHERE account_id=? AND kind=?', who, kind).one().n >= 32) {
      throw new GatewayError(413, 'object_limit', 'This account reached its Gateway object limit.')
    }
    const revision = (existing?.revision ?? 0) + 1
    sql.exec(`INSERT INTO ov_gateway_objects VALUES (?,?,?,?,?) ON CONFLICT(account_id,kind,id)
      DO UPDATE SET revision=excluded.revision,payload=excluded.payload`, who, kind, id, revision, JSON.stringify(value))
    touchConfig(ctx)
    return { ...value, id, revision }
  })
}

export function remove(ctx: WorkspaceContext, kind: ObjectKind, id: string): void {
  ctx.storage.transactionSync(() => {
    if (!ctx.sql.exec('DELETE FROM ov_gateway_objects WHERE account_id=? AND kind=? AND id=?', account(ctx), kind, id).rowsWritten) {
      throw missing()
    }
    touchConfig(ctx)
  })
}

export function conversation(ctx: WorkspaceContext, protocol: Protocol, hash: string): State | undefined {
  return ctx.sql.exec<State>(`SELECT conversation,session_id,recall_spent FROM ov_gateway_state WHERE ${stateKey}`,
    ...owner(ctx), protocol, hash).toArray()[0]
}

export function checkConversationLimit(ctx: WorkspaceContext): void {
  const usage = ctx.sql.exec<{ user: number; total: number }>(`SELECT count(*) AS total,
    count(*) FILTER (WHERE user_id=?) AS user FROM ov_gateway_state WHERE account_id=?`, ctx.caller.userId, account(ctx)).one()
  if (usage.user >= 256 || usage.total >= 2048) throw new GatewayError(429, 'conversation_limit', 'The scoped Gateway conversation limit was reached.')
}

// Use this in the same transaction as the associated session write.
export function saveConversation(ctx: WorkspaceContext, protocol: Protocol, hash: string, state: State): void {
  ctx.sql.exec(`INSERT INTO ov_gateway_state VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(account_id,user_id,agent_id,protocol,name_hash)
    DO UPDATE SET conversation=excluded.conversation,session_id=excluded.session_id,recall_spent=excluded.recall_spent`,
  ...owner(ctx), protocol, hash, state.conversation, state.session_id, state.recall_spent)
}

type Slot = { account: string; user: string; key: string | null; cancelled: boolean }
const active = new WeakMap<DurableObjectStorage, Set<Slot>>()

export function enter(ctx: WorkspaceContext, key: string | null) {
  let slots = active.get(ctx.storage)
  if (!slots) { slots = new Set(); active.set(ctx.storage, slots) }
  const user = ctx.caller.userId
  const tenant = [...slots].filter(slot => slot.account === account(ctx))
  if (key && tenant.some(slot => slot.user === user && slot.key === key && !slot.cancelled)) {
    throw new GatewayError(409, 'conversation_busy', 'A request is already active in this conversation.')
  }
  if (tenant.length >= 8 || tenant.filter(slot => slot.user === user).length >= 2) {
    throw new GatewayError(503, 'gateway_overloaded', 'The scoped Gateway request limit was reached.')
  }
  const slot = { account: account(ctx), user, key, cancelled: false }
  slots.add(slot)
  return {
    guard: () => {
      if (slot.cancelled) throw new GatewayError(409, 'gateway_state_deleted', 'Gateway state was removed while the request was active.')
    },
    done: () => { slots.delete(slot) },
    deleted: () => slot.cancelled,
  }
}

export function reserve(ctx: WorkspaceContext, units: number): void {
  const day = Math.floor(Date.now() / 86_400_000)
  ctx.storage.transactionSync(() => {
    // The shared Workers AI binding still enforces its own budget on all features.
    // These reservations also bound optional operator adapters and count requests.
    ctx.sql.exec('DELETE FROM ov_gateway_budget WHERE account_id=? AND day<?', account(ctx), day)
    for (const [subject, maxCalls, maxUnits] of [['tenant', 768, 4_194_304], [`user:${ctx.caller.userId}`, 160, 1_048_576]] as const) {
      const old = ctx.sql.exec<{ calls: number; units: number }>('SELECT calls,units FROM ov_gateway_budget WHERE account_id=? AND subject=?',
        account(ctx), subject).toArray()[0]
      const calls = (old?.calls ?? 0) + 1, total = (old?.units ?? 0) + units
      if (calls > maxCalls || total > maxUnits) throw new GatewayError(429, 'rate_limited', 'The daily Gateway budget was reached.')
      ctx.sql.exec(`INSERT INTO ov_gateway_budget VALUES (?,?,?,?,?) ON CONFLICT(account_id,subject)
        DO UPDATE SET day=excluded.day,calls=excluded.calls,units=excluded.units`, account(ctx), subject, day, calls, total)
    }
  })
}

export type Metrics = {
  request_id: string; received_at: number; method: 'GET' | 'POST' | 'other'; endpoint: 'messages' | 'count_tokens' | 'chat' | 'responses' | 'other';
  kind: 'user' | 'count' | 'passthrough'; status: number; model?: string; protocol?: Protocol; upstream_id?: string;
  session?: string; session_source?: 'header' | 'new'; upstream_attempted?: boolean; input_tokens?: number; output_tokens?: number;
  upstream_status?: number; duration_ms?: number; recall_ms?: number; recall_count?: number; recall_reason?: string;
  context_override?: string[]; capture_status?: 'active' | 'failed' | 'disabled'; capture_reason?: string;
  capture_messages?: number; openviking_session?: string; degradation?: string; error_reason?: string; total_ms?: number;
  stream?: boolean; first_chunk_ms?: number; stream_error?: string; client_disconnected?: boolean;
}
type Log = Metrics & { event: 'request'; schema: 2; time: number; user_id: string; openviking_account: string }
const after = () => second() - retentionDays * 86400

export function writeLog(ctx: WorkspaceContext, metrics: Metrics): void {
  if (ctx.auditEnabled === false) return
  const scope = account(ctx), time = second()
  const log: Log = { ...metrics, event: 'request', schema: 2, time,
    user_id: ctx.caller.userId, openviking_account: scope, total_ms: Math.round((time - metrics.received_at) * 1000) }
  ctx.storage.transactionSync(() => {
    const { sql } = ctx
    sql.exec('DELETE FROM ov_gateway_log WHERE account_id=? AND time<?', scope, after())
    sql.exec('INSERT INTO ov_gateway_log(account_id,user_id,agent_id,time,payload) VALUES (?,?,?,?,?)', ...owner(ctx), time, JSON.stringify(log))
    sql.exec(`DELETE FROM ov_gateway_log WHERE account_id=? AND seq < COALESCE((SELECT seq FROM ov_gateway_log
      WHERE account_id=? ORDER BY seq DESC LIMIT 1 OFFSET ?),0)`, scope, scope, logLimit - 1)
  })
}

export function logs(ctx: WorkspaceContext, limit: number): Log[] {
  if (ctx.auditEnabled === false) throw new GatewayError(503, 'logs_disabled', 'Gateway request logs are disabled by the operator.')
  const query = 'SELECT payload FROM ov_gateway_log WHERE account_id=? AND time>=?'
  const rows = ctx.caller.role === 'admin'
    ? ctx.sql.exec<{ payload: string }>(`${query} ORDER BY seq DESC LIMIT ?`, account(ctx), after(), limit)
    : ctx.sql.exec<{ payload: string }>(`${query} AND user_id=? ORDER BY seq DESC LIMIT ?`, account(ctx), after(), ctx.caller.userId, limit)
  return rows.toArray().map(row => JSON.parse(row.payload) as Log)
}

export function overview(ctx: GatewayContext, available: boolean) {
  const sample = logs(ctx, logLimit), recalled = sample.filter(record => record.recall_ms !== undefined)
  const issues = new Map<string, boolean>(), degradations: Record<string, number> = {}
  for (const row of sample) {
    if (row.session && (row.capture_messages || row.capture_status === 'failed') && !issues.has(row.session)) {
      issues.set(row.session, row.capture_status === 'failed')
    }
    if (row.degradation) degradations[row.degradation] = (degradations[row.degradation] ?? 0) + 1
  }
  const sum = (name: 'input_tokens' | 'output_tokens' | 'recall_count' | 'recall_ms', rows = sample) =>
    rows.reduce((total, row) => total + (row[name] ?? 0), 0)
  return { requests: sample.length, last_request_at: sample[0]?.time ?? null, output_tokens: sum('output_tokens'),
    input_tokens: sum('input_tokens'), usage_unknown_requests: sample.filter(row => row.upstream_attempted && row.status === 200 &&
      row.kind !== 'count' && (row.input_tokens === undefined || row.output_tokens === undefined)).length,
    cache: { first_call: null, continuation: null }, cache_alerts: null, cache_metrics_available: false, degradations,
    recall_count: sum('recall_count'), recall_requests: recalled.length, recall_ms: recalled.length ? sum('recall_ms', recalled) / recalled.length : 0,
    capture_issues: { failed: [...issues.values()].filter(Boolean).length }, sample_limit: logLimit, log_retention_days: retentionDays,
    openviking: { status: 'ok' }, generation: available ? 'binding_present_not_probed' : 'not_configured' }
}

export function deleteUserState(ctx: WorkspaceContext, user: string): void {
  ctx.storage.transactionSync(() => {
    ctx.sql.exec('DELETE FROM ov_gateway_responses WHERE account_id=? AND user_id=?', account(ctx), user)
    ctx.sql.exec('DELETE FROM ov_gateway_state WHERE account_id=? AND user_id=?', account(ctx), user)
    ctx.sql.exec('DELETE FROM ov_gateway_log WHERE account_id=? AND user_id=?', account(ctx), user)
  })
  for (const slot of active.get(ctx.storage) ?? []) {
    if (slot.account === account(ctx) && slot.user === user) slot.cancelled = true
  }
}
