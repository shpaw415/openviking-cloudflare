// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { ensureAlarm } from '../tasks.js'
import { autoDecision } from './auto-commit.js'
import { autoState } from './auto-policy.js'
import type { AutoPolicy } from './auto-policy.js'
import { sessionColumns, sessionForeignKey, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { getSession } from './store.js'
import type { SessionRow } from './store.js'

export function initIdle(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_idle_receipt (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,
    accepted_at TEXT NOT NULL,PRIMARY KEY (${sessionColumns}),${sessionForeignKey}) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_idle (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    credential TEXT NOT NULL, role TEXT NOT NULL, revision TEXT NOT NULL,
    used_seq INTEGER NOT NULL DEFAULT -1, retry_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}) WITHOUT ROWID`)
}

export function bindIdle(ctx: WorkspaceContext, key: SessionKey): void {
  const { policy, revision } = autoState(ctx.sql, key)
  if (!policy?.idle_timeout_seconds) {
    ctx.sql.exec(`DELETE FROM ov_session_idle WHERE ${sessionWhere}`, ...key)
    return
  }
  if (!ctx.sessionIdleCredential || !revision || !ctx.jobs) {
    throw new ApiError(412, 'FAILED_PRECONDITION', 'Idle commit requires the mounted scheduler and a managed API key.')
  }
  ctx.sql.exec(`INSERT OR REPLACE INTO ov_session_idle (${sessionColumns},credential,role,revision) VALUES(?,?,?,?,?,?,?)`,
    ...key, ctx.sessionIdleCredential, ctx.caller.role, revision)
}

export function idleDue(row: SessionRow, policy: AutoPolicy, last: string): number {
  if (!policy.idle_timeout_seconds || !row.last_message_at) return Infinity
  return Math.max(Date.parse(row.last_message_at) + policy.idle_timeout_seconds * 1000,
    last ? Date.parse(last) + policy.min_commit_interval_seconds * 1000 : 0)
}

type IdleRow = {account_id:string; user_id:string; agent_id:string; session_id:string; credential:string;
  role:Caller['role']; revision:string; total_message_count:number; due:number}

// The number of enrolled rows is bounded by the account session quota. The
// join does not read messages, credentials never leave the scheduler.
function next(sql: SqlStorage) {
  return sql.exec<IdleRow>(`SELECT i.*, s.total_message_count, max(i.retry_at,
      CAST(round(unixepoch(s.last_message_at,'subsec')*1000) AS INTEGER) + 1000*json_extract(p.policy,'$.idle_timeout_seconds'),
      coalesce(CAST(round(unixepoch(p.last_auto_commit_at,'subsec')*1000) AS INTEGER) + 1000*json_extract(p.policy,'$.min_commit_interval_seconds'),0)) AS due
    FROM ov_session_idle i JOIN ov_sessions s USING (${sessionColumns}) JOIN ov_session_auto_commit p USING (${sessionColumns})
    WHERE i.revision=p.revision AND s.last_message_at!='' AND i.used_seq<s.total_message_count
      AND json_extract(p.policy,'$.idle_timeout_seconds')>0 AND s.message_count>s.keep_recent_count
      AND s.message_count>json_extract(p.policy,'$.keep_recent_count')
    ORDER BY due,i.account_id,i.user_id,i.agent_id,i.session_id LIMIT 1`).toArray()[0]
}

export async function armIdle(storage: DurableObjectStorage): Promise<void> {
  const row = next(storage.sql)
  if (row) await ensureAlarm(storage, Math.max(Date.now() + 200, row.due))
}

export async function runDueIdle(storage: DurableObjectStorage,
  resolve: (digest: string, actor: Caller) => Promise<WorkspaceContext | null>): Promise<void> {
  const row = next(storage.sql)
  if (!row || row.due > Date.now()) return
  const key: SessionKey = [row.account_id, row.user_id, row.agent_id, row.session_id]
  await ensureAlarm(storage, Date.now() + 5000)
  const retry = () => storage.sql.exec(`UPDATE ov_session_idle SET retry_at=? WHERE ${sessionWhere} AND revision=?`,
    Date.now()+30_000, ...key, row.revision)
  try {
    const ctx = await resolve(row.credential, { accountId: key[0], userId: key[1], agentId: key[2], role: row.role })
    if (!ctx?.jobs || ctx.sessionIdleCredential !== row.credential) {
      storage.sql.exec(`DELETE FROM ov_session_idle WHERE ${sessionWhere} AND revision=?`, ...key, row.revision)
      return
    }
    const decision = () => {
      const current = getSession(storage.sql, key)
      if (current?.total_message_count !== row.total_message_count || autoState(storage.sql,key).revision !== row.revision) return
      return autoDecision(storage.sql,key,current,true)
    }
    const planned = decision()
    if (!planned) return
    await ctx.jobs.enqueue('session_commit',key[3], {session_id:key[3],op:'idle',body:{},anchor:planned.anchor}, {
      meta: {session_id:key[3],trigger:'idle_timeout'},
      onAccepted: task => {
        if (decision()?.anchor !== planned.anchor) throw new ApiError(409,'CONFLICT','The idle session changed.')
        const changed = storage.sql.exec(`UPDATE ov_session_idle SET used_seq=?,retry_at=0 WHERE ${sessionWhere}
          AND revision=? AND used_seq<? RETURNING session_id`, row.total_message_count,...key,row.revision,row.total_message_count).toArray()
        if (!changed.length) throw new ApiError(409,'CONFLICT','This idle sequence was already admitted.')
        storage.sql.exec(`INSERT OR REPLACE INTO ov_session_idle_receipt (${sessionColumns},accepted_at) VALUES (?,?,?,?,?)`,
          ...key,new Date(task.created_at*1000).toISOString())
      },
    })
  } catch (error) {
    if (error instanceof ApiError && [401,403].includes(error.status)) {
      storage.sql.exec(`DELETE FROM ov_session_idle WHERE ${sessionWhere} AND revision=?`, ...key, row.revision)
    } else retry()
  }
}

export function lastIdleAccepted(sql: SqlStorage,key:SessionKey):string {
  return sql.exec<{accepted_at:string}>(`SELECT accepted_at FROM ov_session_idle_receipt WHERE ${sessionWhere}`,...key).toArray()[0]?.accepted_at ?? ''
}
