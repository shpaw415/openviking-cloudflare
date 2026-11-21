// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller } from '../context.js'
import { conflict, invalid } from '../fs/contract.js'
import type { Schedule } from './input.js'

export type ScheduleIdentity = Pick<Caller, 'accountId' | 'userId' | 'agentId'>
export type Clock = { last_slot: number | null; next_slot: number | null; error: string | null }
export type Candidate = Clock & { account_id: string; user_id: string; agent_id: string; name: string; revision: string;
  credential: string; next_slot: number; wake_at: number; failures: number }
type Plan = { revision: string; credential: string | null; last_slot: number | null; next_slot: number | null }
type ResolvedSchedule = { frequency: 'daily'; hour: number; minute: number } |
  { frequency: 'weekly'; weekday: number; hour: number; minute: number }
type Subject = readonly [string, string, string]
type AlarmStore = Pick<DurableObjectTransaction, 'getAlarm' | 'setAlarm'>

const minute = 60_000, hour = 60 * minute, day = 24 * hour, offset = 8 * hour
const table = 'ov_edge_compile_schedule'
const scope = 'account_id=? AND user_id=? AND agent_id=? AND name=?'
const candidateFence = `${scope} AND revision=? AND next_slot=? AND wake_at=? AND credential=?`

export function initCompileSchedules(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL, revision TEXT NOT NULL,
    credential TEXT, last_slot INTEGER, next_slot INTEGER, wake_at INTEGER, failures INTEGER NOT NULL DEFAULT 0,
    error TEXT, PRIMARY KEY(account_id,user_id,agent_id,name),
    CHECK ((credential IS NULL) = (next_slot IS NULL)), CHECK ((wake_at IS NULL) = (next_slot IS NULL))
  ) WITHOUT ROWID`)
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_edge_compile_schedule_wake ON ${table}(wake_at) WHERE wake_at IS NOT NULL`)
}

function stableSeed(value: string) {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  return hash >>> 0
}

export function resolveSchedule(plan: Schedule, subject: Subject, name: string): ResolvedSchedule {
  const seed = JSON.stringify([...subject, name]); const spread = stableSeed(seed) % 240
  const times = { hour: plan.hour ?? (plan.minute !== undefined ? 0 : Math.floor(spread / 60)), minute: plan.minute ?? spread % 60 }
  return plan.frequency === 'weekly' ? { frequency: 'weekly', weekday: plan.weekday ?? 1 + stableSeed('weekday:' + seed) % 7, ...times }
    : { frequency: 'daily', ...times }
}

function complete(plan: Schedule): ResolvedSchedule {
  if (plan.hour === undefined || plan.minute === undefined || plan.frequency === 'weekly' && plan.weekday === undefined) {
    invalid('The stored Compile schedule has unresolved time components.')
  }
  return plan as ResolvedSchedule
}

export function dueSlot(value: Schedule, now: number): number {
  const plan = complete(value)
  let localDay = Math.floor((now + offset) / day)
  if (plan.frequency === 'weekly') {
    const weekday = new Date(localDay * day).getUTCDay() || 7
    localDay -= (weekday - plan.weekday + 7) % 7
  }
  const mark = localDay * day + plan.hour * hour + plan.minute * minute - offset
  return mark <= now ? mark : mark - (plan.frequency === 'weekly' ? 7 : 1) * day
}

export function futureSlot(value: Schedule, now: number): number {
  return dueSlot(value, now) + day * (value.frequency === 'weekly' ? 7 : 1)
}

export function slotIso(value: number | null): string | null {
  return value === null ? null : new Date(value + offset).toISOString().slice(0, 19) + '+08:00'
}

export async function armEarlier(store: AlarmStore, time: number) {
  const old = await store.getAlarm()
  if (old === null || old > time) await store.setAlarm(time)
}

export async function armCompileSchedule(storage: DurableObjectStorage): Promise<void> {
  initCompileSchedules(storage.sql)
  const next = storage.sql.exec<{ wake_at: number }>(`SELECT wake_at FROM ${table} WHERE wake_at IS NOT NULL ORDER BY wake_at LIMIT 1`).toArray()[0]
  if (next) await storage.transaction(tx => armEarlier(tx, Math.max(next.wake_at, Date.now() + 50)))
}

export function clockFor(sql: SqlStorage, subject: Subject, name: string): Clock | undefined {
  return sql.exec<Clock>(`SELECT last_slot,next_slot,error FROM ${table} WHERE ${scope}`, ...subject, name).toArray()[0]
}

/** Called inside the same storage transaction as the settings update. */
export function storeSchedule(sql: SqlStorage, subject: Subject, name: string, revision: string,
  credential: string | null, rule: Schedule | null, unchanged: boolean, now: number): number | null {
  const before = clockFor(sql, subject, name)
  if (!credential && !before && !rule) return null
  if (credential && !rule) return invalid('update_schedule is required when auto_update is true.')
  const next = credential && rule ? ((unchanged && before?.next_slot) || futureSlot(rule, now)) : null
  const plan: Plan = { revision, credential, next_slot: next,
    last_slot: next !== null && !(unchanged && before?.next_slot) ? null : before?.last_slot ?? null }
  sql.exec(`INSERT INTO ${table}(account_id,user_id,agent_id,name,revision,credential,last_slot,next_slot,wake_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,user_id,agent_id,name) DO UPDATE SET revision=excluded.revision,
    credential=excluded.credential,last_slot=excluded.last_slot,next_slot=excluded.next_slot,wake_at=excluded.wake_at,failures=0,error=NULL`,
  ...subject, name, plan.revision, plan.credential, plan.last_slot, plan.next_slot, plan.next_slot)
  return next
}

export function peekDueCompileSchedule(sql: SqlStorage, now: number): Candidate | undefined {
  return sql.exec<Candidate>(`SELECT account_id,user_id,agent_id,name,revision,credential,last_slot,next_slot,wake_at,failures,error FROM ${table}
    WHERE wake_at IS NOT NULL AND wake_at<=? ORDER BY wake_at,account_id,user_id,agent_id,name LIMIT 1`, now).toArray()[0]
}

export function identityOf(row: Candidate): ScheduleIdentity {
  return { accountId: row.account_id, userId: row.user_id, agentId: row.agent_id }
}

function bound(row: Candidate): [string, string, string, string, string, number, number, string] {
  return [row.account_id, row.user_id, row.agent_id, row.name, row.revision, row.next_slot, row.wake_at, row.credential]
}

export function currentCandidate(sql: SqlStorage, row: Candidate): boolean {
  return !!sql.exec<{ same: number }>(`SELECT 1 AS same FROM ${table} WHERE ${candidateFence}`, ...bound(row)).toArray()[0]
}

/** Part of Jobs.onAccepted; rollback of either update leaves the original slot due. */
export function acceptSlot(sql: SqlStorage, row: Candidate, slot: number, next: number) {
  const result = sql.exec<{ name: string }>(`UPDATE ${table} SET last_slot=?,next_slot=?,wake_at=?,error=NULL,failures=0
    WHERE ${candidateFence} RETURNING name`, slot, next, next, ...bound(row)).toArray()
  if (!result.length) conflict('The Compile schedule changed before admission.')
}

export function holdSchedule(sql: SqlStorage, row: Candidate, error: string, now: number, disable: boolean) {
  if (disable) {
    const result = sql.exec<{ name: string }>(`UPDATE ${table} SET credential=NULL,next_slot=NULL,wake_at=NULL,error=?
      WHERE ${candidateFence} RETURNING name`, error, ...bound(row)).toArray()
    if (result.length) sql.exec(`UPDATE ov_edge_compile_config SET inputs=json_set(inputs,'$.auto_update',json('false'))
      WHERE ${scope} AND signature=?`, row.account_id, row.user_id, row.agent_id, row.name, row.revision)
  } else {
    const delay = Math.min(15 * minute, (2 ** Math.min(row.failures, 4)) * minute)
    sql.exec(`UPDATE ${table} SET wake_at=?,failures=min(failures+1,5),error=? WHERE ${candidateFence}`,
      now + delay, error, ...bound(row))
  }
}

export function assertScheduledRun(sql: SqlStorage, subject: Subject, name: string, revision: string, slot: number, digest: string | undefined) {
  const found = sql.exec<{ same: number }>(`SELECT 1 AS same FROM ${table} WHERE ${scope} AND revision=? AND last_slot=? AND credential=?`,
    ...subject, name, revision, slot, digest ?? null).toArray()[0]
  if (!found) conflict('The Compile schedule was changed, disabled, or lost authorization before publication.')
}
