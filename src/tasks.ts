// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, WorkspaceContext } from './context.js'
import { ApiError, ok } from './http.js'

export type JobKind = 'session_commit' | 'add_resource' | 'compile' | 'rule_compile' | 'watch_sync' | 'content_batch_write'
type Status = 'pending' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
const kinds = new Set<JobKind>(['session_commit', 'add_resource', 'compile', 'rule_compile', 'watch_sync', 'content_batch_write'])
const statuses = new Set<Status>(['pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled'])
const encoder = new TextEncoder()
const retentionMs = 7 * 86_400_000
const busyLeaseMs = 10 * 60_000
const wakeDelayMs = 200
const maxRecords = 512, maxActive = 24, maxActorActive = 8
const maxPayload = 256 * 1024, maxResult = 128 * 1024, maxMeta = 4096
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const clean = (value: string, max: number) => value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)

export interface PublicTask {
  task_id: string
  task_type: JobKind
  status: Status
  resource_id: string
  created_at: number
  updated_at: number
  created_at_iso: string
  updated_at_iso: string
  processing_seconds: number | null
  stage: string | null
  result: unknown
  error: string | null
  meta: Record<string, unknown>
  execution_events?: unknown[]
}

export interface JobAccess {
  enqueue(kind: JobKind, resourceId: string, payload: Record<string, unknown>, options?: {
    idempotencyKey?: string
    meta?: Record<string, unknown>
    onAccepted?: (task: PublicTask) => void
  }): Promise<PublicTask>
  get(taskId: string): PublicTask | null
}

export type ClaimedJob = {
  taskId: string; kind: JobKind; resourceId: string
  actor: Caller; credential: string; payload: Record<string, unknown>; createdAt: number
}

type TaskRow = {
  task_id: string; kind: JobKind; account: string; user_id: string; agent: string; role: Caller['role']; credential: string | null
  resource_id: string; created: number; updated: number; started: number | null; status: Status;
  stage: string | null; due: number; payload: string | null; result_json: string | null; error: string | null;
  meta_json: string; events_json: string; idempotency_key: string | null; payload_hash: string
}
type TaskSummary = Omit<TaskRow, 'payload' | 'credential'>

const columns = 'task_id, kind, account, user_id, agent, role, resource_id, created, updated, started, status, stage, due, result_json, error, meta_json, events_json, idempotency_key, payload_hash'
const scope = 'account = ? AND user_id = ? AND agent = ?'
const active = "('pending','running','cancelling')"
const terminal = "('completed','failed','cancelled')"

export function initTasks(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_jobs (
    task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, account TEXT NOT NULL, user_id TEXT NOT NULL, agent TEXT NOT NULL,
    role TEXT NOT NULL, credential TEXT, resource_id TEXT NOT NULL, created INTEGER NOT NULL,
    updated INTEGER NOT NULL, due INTEGER NOT NULL, started INTEGER, status TEXT NOT NULL,
    stage TEXT, payload TEXT, result_json TEXT, error TEXT, meta_json TEXT NOT NULL, events_json TEXT NOT NULL,
    idempotency_key TEXT, payload_hash TEXT NOT NULL,
    UNIQUE(account, user_id, agent, kind, idempotency_key)
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_jobs_discovery ON ov_jobs(account,user_id,agent,created,task_id)')
  sql.exec('CREATE INDEX IF NOT EXISTS ov_jobs_due ON ov_jobs(status,due,task_id)')
}

function timeoutError(message: string): never { throw new ApiError(409, 'FAILED_PRECONDITION', message) }
function bad(message: string): never { throw new ApiError(400, 'INVALID_ARGUMENT', message) }
function missing(): never { throw new ApiError(404, 'NOT_FOUND', 'Task not found or expired.') }
function ids(caller: Caller): [string, string, string] { return [caller.accountId, caller.userId, caller.agentId] }

function wire(row: TaskSummary, events = false): PublicTask {
  return {
    task_id: row.task_id, task_type: row.kind, status: row.status, resource_id: row.resource_id,
    created_at: row.created / 1000, updated_at: row.updated / 1000,
    created_at_iso: new Date(row.created).toISOString(), updated_at_iso: new Date(row.updated).toISOString(),
    processing_seconds: row.started === null ? null : Math.max(0, (row.updated - row.started) / 1000),
    stage: row.stage, result: row.result_json === null ? null : JSON.parse(row.result_json),
    error: row.error, meta: JSON.parse(row.meta_json),
    ...(events && { execution_events: JSON.parse(row.events_json) }),
  }
}

function event(name: Status, now: number, error?: string) {
  return { stage: name, status: name, timestamp: now / 1000, timestamp_iso: new Date(now).toISOString(), ...(error && { error }) }
}

function record(row: TaskSummary, state: Status, now: number, error?: string): string {
  const entries = JSON.parse(row.events_json) as unknown[]
  return JSON.stringify([...entries.slice(-15), event(state, now, error)])
}

function taskFor(sql: SqlStorage, caller: Caller, id: string): TaskSummary | undefined {
  return sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE ${scope} AND task_id=? AND (updated>=? OR status IN ${active})`,
    ...ids(caller), id, Date.now() - retentionMs).toArray()[0]
}

function boundedJson(value: unknown, limit: number): string {
  let out: string
  try { out = JSON.stringify(value ?? null) } catch { return bad('Task data is not serializable.') }
  if (encoder.encode(out).byteLength > limit) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'Task data exceeds its byte limit.')
  return out
}

function trimResult(value: unknown, depth = 0): unknown {
  if (depth > 10) return null
  if (Array.isArray(value)) return value.slice(0, 512).map(item => trimResult(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    // Task logs are a separate response surface. Never copy credential fields into them.
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:password|credential|secret|authorization|api.?key|token|hash|signature)/i.test(key))
      .slice(0, 256).map(([key, item]) => [key, trimResult(item, depth + 1)]))
  }
  return typeof value === 'string' ? value.slice(0, 8192) : value
}

async function hash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(digest, x => x.toString(16).padStart(2, '0')).join('')
}

export async function ensureAlarm(storage: DurableObjectStorage, time: number) {
  await storage.transaction(async txn => {
    const previous = await txn.getAlarm()
    if (previous === null || previous > time) await txn.setAlarm(time)
  })
}

export function jobAccess(ctx: WorkspaceContext, credential: string, enabled: ReadonlySet<JobKind>): JobAccess {
  return {
    get(id) { const row = taskFor(ctx.sql, ctx.caller, id); return row ? wire(row) : null },
    async enqueue(kind, resourceId, payload, options = {}) {
      if (!kinds.has(kind) || !enabled.has(kind)) throw new ApiError(501, 'NOT_IMPLEMENTED', 'This job type has no Worker consumer.')
      if (!resourceId || !clean(resourceId, 512)) bad('Invalid task resource identifier.')
      const key = options.idempotencyKey ?? null
      if (key !== null && (!key || !clean(key, 160))) bad('Invalid idempotency key.')
      const payloadJson = boundedJson(payload, maxPayload)
      const metaJson = boundedJson(trimResult(options.meta ?? {}), maxMeta)
      const digest = await hash(`${resourceId}\n${payloadJson}`)
      const due = Date.now() + wakeDelayMs
      // Install the durable wake before accepting a job. If the insert fails it is harmless.
      await ensureAlarm(ctx.storage, due)
      await ctx.reauthorize?.()
      const row = ctx.storage.transactionSync(() => {
        // URL imports enter with a durable Data lease. Validate it in the
        // transaction that owns both the job and its destination reservation.
        ctx.dataAuthority?.assertCurrent()
        const sql = ctx.sql
        const now = Date.now()
        sql.exec(`DELETE FROM ov_jobs WHERE status IN ${terminal} AND updated<?`, now - retentionMs)
        if (key !== null) {
          const found = sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE ${scope} AND kind=? AND idempotency_key=?`,
            ...ids(ctx.caller), kind, key).toArray()[0]
          if (found) {
            if (found.payload_hash !== digest) throw new ApiError(409, 'CONFLICT', 'Idempotency key refers to different task data.')
            return found
          }
        }
        const pending = sql.exec<{ all_count: number; actor_count: number }>(`SELECT COUNT(*) AS all_count,
          COALESCE(SUM(user_id=?),0) AS actor_count FROM ov_jobs WHERE status IN ${active}`, ctx.caller.userId).one()
        if (pending.all_count >= maxActive || pending.actor_count >= maxActorActive) {
          throw new ApiError(429, 'RATE_LIMITED', 'Too many active tasks.')
        }
        if (sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM ov_jobs').one().n >= maxRecords) {
          sql.exec(`DELETE FROM ov_jobs WHERE task_id=(SELECT task_id FROM ov_jobs WHERE status IN ${terminal} ORDER BY updated,task_id LIMIT 1)`)
        }
        const id = crypto.randomUUID()
        sql.exec(`INSERT INTO ov_jobs(task_id,kind,account,user_id,agent,role,credential,resource_id,created,updated,due,
          status,stage,payload,meta_json,events_json,idempotency_key,payload_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending','pending',?,?,?,?,?)`,
        id, kind, ...ids(ctx.caller), ctx.caller.role, credential, resourceId, now, now, due, payloadJson, metaJson,
        JSON.stringify([event('pending', now)]), key, digest)
        const inserted = taskFor(sql, ctx.caller, id)!
        options.onAccepted?.(wire(inserted))
        return inserted
      })
      return wire(row)
    },
  }
}

export async function claimJob(storage: DurableObjectStorage): Promise<ClaimedJob | null> {
  const sql = storage.sql
  storage.transactionSync(() => {
    const now = Date.now()
    for (const row of sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE status IN ('running','cancelling') AND started<=?`,
      now - busyLeaseMs).toArray()) {
      setTerminal(sql, row, 'failed', now, null, 'Execution interrupted; inspect durable output before retrying.')
    }
  })
  // An idle alarm doesn't create a periodic wake. Only an actual candidate needs a recovery alarm.
  if (!sql.exec<{ task_id: string }>("SELECT task_id FROM ov_jobs WHERE status='pending' AND due<=? LIMIT 1", Date.now()).toArray().length) return null
  await ensureAlarm(storage, Date.now() + busyLeaseMs)
  return storage.transactionSync(() => {
    const now = Date.now()
    const row = sql.exec<TaskRow>(`SELECT * FROM ov_jobs WHERE status='pending' AND due<=? ORDER BY due,task_id LIMIT 1`, now).toArray()[0]
    if (!row) return null
    if (row.credential === null || row.payload === null || !kinds.has(row.kind)) {
      setTerminal(sql, row, 'failed', now, null, 'Task could not be recovered.')
      return null
    }
    sql.exec("UPDATE ov_jobs SET status='running',stage='running',updated=?,started=?,events_json=? WHERE task_id=?", now, now, record(row, 'running', now), row.task_id)
    return { taskId: row.task_id, kind: row.kind, resourceId: row.resource_id,
      actor: { accountId: row.account, userId: row.user_id, agentId: row.agent, role: row.role },
      credential: row.credential, payload: JSON.parse(row.payload), createdAt: row.created / 1000 }
  })
}

export function assertJobRunning(sql: SqlStorage, taskId: string): void {
  const row = sql.exec<{ status: Status }>('SELECT status FROM ov_jobs WHERE task_id = ?', taskId).toArray()[0]
  if (row?.status !== 'running') throw new ApiError(409, 'TASK_CANCELLED', 'Task is no longer active.')
}

/** Internal only: used by filesystem admission to detect pending writers without exposing their identity or output. */
export function jobIsActive(sql: SqlStorage, taskId: string): boolean {
  if (!tokenPattern.test(taskId)) return false
  return sql.exec<{ task_id: string }>(`SELECT task_id FROM ov_jobs WHERE task_id=? AND status IN ${active}`,taskId).toArray().length === 1
}

function setTerminal(sql: SqlStorage, row: TaskSummary, status: 'completed' | 'failed' | 'cancelled', now: number, json: string | null, error?: string) {
  sql.exec('UPDATE ov_jobs SET status=?,stage=?,updated=?,result_json=?,error=?,events_json=?,payload=NULL,credential=NULL WHERE task_id=?',
    status, status, now, json, error ?? null, record(row, status, now, error), row.task_id)
}

export function completeJob(storage: DurableObjectStorage, id: string, result: unknown, code: 'ok' | 'failed' | 'revoked'): void {
  storage.transactionSync(() => {
    const sql = storage.sql
    const row = sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE task_id=? AND status IN ('running','cancelling')`, id).toArray()[0]
    if (!row) return
    const now = Date.now()
    if (row.status === 'cancelling' && code !== 'ok') {
      setTerminal(sql, row, 'cancelled', now, null)
    } else if (code === 'ok') {
      setCompleted(sql,row,result,now)
    } else {
      setTerminal(sql, row, 'failed', now, null, code === 'revoked' ? 'Task credential is no longer authorized.' : 'Worker task failed; see resource status before retrying.')
    }
  })
}

function setCompleted(sql:SqlStorage,row:TaskSummary,result:unknown,now:number) {
  let json:string
  try { json = boundedJson(trimResult(result), maxResult) } catch { json = '{"result_truncated":true}' }
  setTerminal(sql,row,'completed',now,json)
}

export function finishJobInTransaction(sql: SqlStorage, id: string, result: unknown): void {
  const row=sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE task_id=? AND status='running'`,id).toArray()[0]
  if(!row) throw new ApiError(409,'TASK_CANCELLED','Task is no longer active.')
  setCompleted(sql,row,result,Date.now())
}

export async function scheduleNextJob(storage: DurableObjectStorage): Promise<void> {
  const row = storage.sql.exec<{ due: number | null }>(`SELECT MIN(CASE WHEN status='pending' THEN due ELSE started+? END) AS due
    FROM ov_jobs WHERE status IN ${active}`, busyLeaseMs).one()
  if (row.due !== null) await ensureAlarm(storage, Math.max(Date.now() + 50, row.due))
  // No deletion here: another input event may have just armed a new alarm.
}

const parseBool = (v: string | null) => v === null || v === 'false' || v === '0' ? false : v === 'true' || v === '1' ? true : bad('Invalid boolean option.')
function cancel(ctx: WorkspaceContext, id: string): PublicTask {
  return ctx.storage.transactionSync(() => {
    const row = taskFor(ctx.sql, ctx.caller, id)
    if (!row) return missing()
    if (row.status === 'pending') setTerminal(ctx.sql, row, 'cancelled', Date.now(), null)
    else if (row.status === 'running') {
      const stagedAtomic = row.kind === 'add_resource' && JSON.parse(row.meta_json).staged_atomic === true
      if (row.kind === 'add_resource' && !stagedAtomic || row.kind === 'watch_sync') {
        return timeoutError('This resource operation has already started and cannot be cancelled safely.')
      }
      const now = Date.now()
      ctx.sql.exec("UPDATE ov_jobs SET status='cancelling',stage='cancelling',updated=?,events_json=? WHERE task_id=?",
        now, record(row, 'cancelling', now), id)
    } else if (row.status !== 'cancelling' && row.status !== 'cancelled') return timeoutError('Task is already finished.')
    return wire(taskFor(ctx.sql, ctx.caller, id)!)
  })
}

const encoded = (s: string) => btoa(s).replace(/=+$/u, '').replace(/\+/g, '-').replace(/\//g, '_')
function decode(s: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(s)) throw new Error('invalid encoding')
    return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')))
  } catch { return bad('Invalid task cursor.') }
}

async function list(ctx: WorkspaceContext, url: URL): Promise<Response> {
  const qp = url.searchParams
  const lim = qp.get('limit') ?? '50'
  if (!/^\d{1,3}$/u.test(lim) || Number(lim) < 1 || Number(lim) > 200) bad('Invalid task list limit.')
  const limit = Number(lim)
  const fields = { kind: qp.get('task_type'), status: qp.get('status'), resource: qp.get('resource_id'), query: qp.get('q') }
  if (fields.kind !== null && !clean(fields.kind, 64) || fields.status !== null && !statuses.has(fields.status as Status) ||
      fields.resource !== null && !clean(fields.resource, 512) || fields.query !== null && !clean(fields.query, 200)) bad('Invalid task filter.')
  const internal = parseBool(qp.get('include_internal'))
  const pagination = qp.get('pagination')
  if (pagination !== null && pagination !== 'cursor') bad('Invalid task pagination.')
  const cursor = qp.get('cursor')
  if (cursor !== null && pagination !== 'cursor') bad('Cursor pagination was not selected.')
  const binding = pagination ? await hash(JSON.stringify([ids(ctx.caller), ctx.caller.role, fields, internal])) : null
  const constraints = [scope, `(updated>=? OR status IN ${active})`]
  const args: (string | number)[] = [...ids(ctx.caller), Date.now() - retentionMs]
  for (const [field, value] of [['kind', fields.kind], ['status', fields.status], ['resource_id', fields.resource]] as const) {
    if (value !== null) { constraints.push(`${field}=?`); args.push(value) }
  }
  if (fields.query) {
    constraints.push('(instr(lower(resource_id),lower(?))>0 OR instr(task_id,?)>0)')
    args.push(fields.query, fields.query)
  }
  if (cursor !== null) {
    const parsed = decode(cursor)
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== binding || !Number.isSafeInteger(parsed[1]) ||
        typeof parsed[2] !== 'string' || !tokenPattern.test(parsed[2])) bad('Task cursor is outside this filter.')
    constraints.push('(created<? OR (created=? AND task_id<?))')
    args.push(parsed[1], parsed[1], parsed[2])
  }
  const rows = ctx.sql.exec<TaskSummary>(`SELECT ${columns} FROM ov_jobs WHERE ${constraints.join(' AND ')} ORDER BY created DESC, task_id DESC LIMIT ?`,
    ...args, limit + (pagination ? 1 : 0)).toArray()
  const selected = rows.slice(0, limit)
  const items = selected.map(r => wire(r))
  if (!pagination) return ok(items)
  const last = selected.at(-1), more = rows.length > limit
  return ok({ items, has_more: more, next_cursor: more && last ? encoded(JSON.stringify([binding, last.created, last.task_id])) : null })
}

export async function routeTasks(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  if (url.pathname === '/api/v1/tasks') {
    if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET to list tasks.')
    return list(ctx, url)
  }
  const match = /^\/api\/v1\/tasks\/([^/]+)(\/cancel)?$/u.exec(url.pathname)
  if (!match) return undefined
  const id = match[1]
  if (!tokenPattern.test(id)) return missing()
  if (match[2] && request.method === 'POST') return ok(cancel(ctx, id))
  if (!match[2] && ['GET', 'HEAD'].includes(request.method)) {
    const row = taskFor(ctx.sql, ctx.caller, id)
    if (!row) return missing()
    return ok(wire(row, parseBool(url.searchParams.get('include_events'))))
  }
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported method for task route.')
}

export function jobCounts(ctx: WorkspaceContext) {
  const data = ctx.sql.exec<{ status: Status; n: number }>(`SELECT status,COUNT(*) AS n FROM ov_jobs WHERE ${scope} GROUP BY status`, ...ids(ctx.caller)).toArray()
  const counts: Record<Status, number> = { pending: 0, running: 0, cancelling: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const row of data) counts[row.status] = row.n
  return counts
}
