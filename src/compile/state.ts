// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { compare, conflict, denied, invalid, quota } from '../fs/contract.js'
import { actorScope, compileName } from './input.js'
import type { Inputs } from './input.js'
import type { CompileFiles, Digest } from './files.js'
import type { PublicTask } from '../tasks.js'
import { armEarlier, clockFor, initCompileSchedules, slotIso, storeSchedule } from './schedule.js'
import type { Clock } from './schedule.js'

const local = 'account_id=? AND user_id=? AND agent_id=?'
const retention = 7 * 86400
export type Config = { name: string; user_id: string; agent_id: string; space: string; signature: string; target: string;
  inputs: string; created: number; last_run: number | null; updated_by: string }
type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type Run = { task_id: string; config_name: string; target: string; params: string; status: RunStatus; trigger: 'initial' | 'manual' | 'scheduled';
  created: number; started: number | null; finished: number | null; meta: string | null; result: string | null; error: string | null;
  intent: string | null; request_key: string | null; output_set: string | null; baseline: string | null }
export type Baseline = { signature: string; snapshot: string; targetRevision: string | null; sources: Digest[] }
export type Artifact = { uri: string; sha256: string; sources: Array<Digest & { quote: string }>; change_type: 'added' | 'modified' | 'deleted' }
type OutputRecord = { uri: string; revision: string; snapshot: string; owner: string }

export function initState({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_compile_config (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
    space TEXT NOT NULL, target TEXT NOT NULL, signature TEXT NOT NULL, inputs TEXT NOT NULL,
    created REAL NOT NULL, last_run REAL, updated_by TEXT NOT NULL,
    PRIMARY KEY(account_id,user_id,agent_id,name)
  ) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_compile_run (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
    config_name TEXT NOT NULL, target TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL, trigger TEXT NOT NULL,
    created REAL NOT NULL, started REAL, finished REAL, meta TEXT, result TEXT, error TEXT, intent TEXT, request_key TEXT,
    output_set TEXT, baseline TEXT,
    PRIMARY KEY(account_id,user_id,agent_id,task_id), UNIQUE(account_id,user_id,agent_id,request_key)
  ) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_compile_runs_order ON ov_edge_compile_run(account_id,user_id,agent_id,config_name,created DESC,task_id DESC)')
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_compile_artifact (
    account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    revision TEXT NOT NULL, snapshot TEXT NOT NULL, owner TEXT NOT NULL,
    PRIMARY KEY(account_id,space,uri)
  ) WITHOUT ROWID`)
  initCompileSchedules(sql)
}

const configColumns = 'name,user_id,agent_id,space,signature,target,inputs,created,last_run,updated_by'
const now = () => Date.now() / 1000

export class CompileState {
  constructor(readonly ctx: WorkspaceContext) {}
  get sql() { return this.ctx.sql }
  get actor() { return actorScope(this.ctx) }

  config(name: string): Config | undefined {
    return this.sql.exec<Config>(`SELECT ${configColumns} FROM ov_edge_compile_config WHERE ${local} AND name=?`, ...this.actor, name).toArray()[0]
  }

  byTarget(target: string): Config | undefined {
    const rows = this.sql.exec<Config>(`SELECT ${configColumns} FROM ov_edge_compile_config WHERE ${local} AND target=? LIMIT 2`, ...this.actor, target).toArray()
    if (rows.length > 1) conflict('Several configurations use this destination; send compile_name.')
    return rows[0]
  }

  clock(name: string): Clock | undefined { return clockFor(this.sql, this.actor, name) }

  async save(files: CompileFiles, name: string, inputs: Inputs, signature: string, updatedBy: string,
    previous?: Config, credential: string | null = null): Promise<Config> {
    return this.ctx.storage.transaction(async transaction => {
      const current = this.config(name)
      if (!previous && current) throw new ApiError(409, 'ALREADY_EXISTS', 'This Compile configuration already exists.')
      if (previous && current?.signature !== previous.signature) conflict('The configuration changed while it was being edited.')
      const path = files.validate(inputs)
      if (!previous && this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_edge_compile_config WHERE account_id=?', this.actor[0]).one().n >= 256) {
        quota('Workspace Compile configuration limit reached.')
      }
      this.assertLayout(path.space, path.uri)
      files.tagTarget(path)
      this.sql.exec(`INSERT INTO ov_edge_compile_config(account_id,user_id,agent_id,name,space,target,signature,inputs,created,updated_by)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,user_id,agent_id,name) DO UPDATE SET
        signature=excluded.signature,inputs=excluded.inputs,updated_by=excluded.updated_by`,
      ...this.actor, name, path.space, path.uri, signature, JSON.stringify(inputs), now(), updatedBy)
      const old: Inputs | undefined = current ? JSON.parse(current.inputs) : undefined
      const unchanged = !!old?.auto_update && JSON.stringify(old.update_schedule) === JSON.stringify(inputs.update_schedule)
      const clock = storeSchedule(this.sql, this.actor, name, signature, credential, inputs.update_schedule, unchanged, Date.now())
      if (clock !== null) await armEarlier(transaction, Math.max(clock, Date.now() + 50))
      return this.config(name)!
    })
  }

  assertLayout(space: string, target: string): void {
    const overlap = this.sql.exec<{ overlap: number }>(`SELECT 1 as overlap FROM ov_edge_compile_config
      WHERE account_id=? AND space=? AND target<>? AND ((target>=? AND target<?) OR substr(?,1,length(target)+1)=target||'/') LIMIT 1`,
    this.actor[0], space, target, `${target}/`, `${target}0`, target).toArray()[0]
    if (overlap) conflict('Compile destination overlaps an existing Compile configuration.')
  }

  configs(scope: string, name: string | null, limit: number, cursor: string | null) {
    const mine = scope === 'user'
    if (!mine && scope !== 'account') invalid('scope must be user or account.')
    if (!mine && this.ctx.caller.role !== 'admin') denied('Account Compile listing requires ADMIN.')
    if (name !== null) compileName(name)
    const clauses = [mine ? local : 'account_id=?']
    const bindings: SqlStorageValue[] = mine ? this.actor : [this.actor[0]]
    if (name !== null) { clauses.push('name=?'); bindings.push(name) }
    if (cursor !== null) {
      if (mine) { clauses.push('name>?'); bindings.push(compileName(cursor)) }
      else {
        const tuple = cursor.split(':')
        if (tuple.length !== 3 || !tuple.slice(1).every(part => /^[A-Za-z0-9_-]{1,48}$/u.test(part))) invalid('Invalid account cursor.')
        clauses.push('(name,user_id,agent_id)>(?,?,?)')
        bindings.push(compileName(tuple[0]), tuple[1], tuple[2])
      }
    }
    const results = this.sql.exec<Config>(`SELECT ${configColumns} FROM ov_edge_compile_config WHERE ${clauses.join(' AND ')}
      ORDER BY name,user_id,agent_id LIMIT ?`, ...bindings, limit + 1).toArray()
    const page = results.slice(0, limit), last = page.at(-1)
    const next = results.length > limit && last ? (mine ? last.name : `${last.name}:${last.user_id}:${last.agent_id}`) : null
    page.sort((a, b) => (b.last_run ?? 0) - (a.last_run ?? 0))
    return { page, next }
  }

  submitted(key: string): Run | undefined {
    return this.sql.exec<Run>(`SELECT * FROM ov_edge_compile_run WHERE ${local} AND request_key=? AND created>=?`,
      ...this.actor, key, now() - retention).toArray()[0]
  }

  find(taskId: string): Run | undefined {
    return this.sql.exec<Run>(`SELECT * FROM ov_edge_compile_run WHERE ${local} AND task_id=?`, ...this.actor, taskId).toArray()[0]
  }

  accept(task: Pick<PublicTask, 'task_id' | 'created_at'>, inputs: Inputs, name: string | null, key: string | null,
    intent: string | null, slot: number | null = null): Run {
    const db = this.sql
    const previous = this.find(task.task_id)
    if (previous) return previous
    // Clear only expired key bindings (individual histories may outlive job status).
    if (key !== null) db.exec(`UPDATE ov_edge_compile_run SET request_key=NULL WHERE ${local} AND request_key=? AND created<?`,
      ...this.actor, key, now() - retention)
    const config = name ? this.config(name) : undefined
    const trigger = config?.last_run === null ? 'initial' : slot === null ? 'manual' : 'scheduled'
    db.exec(`INSERT INTO ov_edge_compile_run(account_id,user_id,agent_id,task_id,config_name,target,params,status,trigger,created,intent,request_key,meta)
      VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)`, ...this.actor, task.task_id, name ?? '', inputs.to, JSON.stringify(inputs),
    trigger, task.created_at, intent, key, slot === null ? null : JSON.stringify({ scheduled_slot: slotIso(slot) }))
    if (name && config && (config.last_run === null || config.last_run < task.created_at)) {
      db.exec(`UPDATE ov_edge_compile_config SET last_run=? WHERE ${local} AND name=?`, task.created_at, ...this.actor, name)
    }
    return this.find(task.task_id)!
  }

  reclaimHistory() {
    // Keep active rows until a reasonable recovery window elapses; the parent tracks job leases.
    this.sql.exec(`DELETE FROM ov_edge_compile_run WHERE account_id=? AND created<?`, this.actor[0], now() - retention)
    const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_edge_compile_run WHERE account_id=?', this.actor[0]).one().n
    if (count >= 1024) quota('Workspace Compile history limit reached; retry after retention expiry.')
  }

  view(run: Run) {
    const task = ['queued', 'running', 'cancelling'].includes(run.status) ? this.ctx.jobs?.get(run.task_id) : undefined
    const status = !task || task.status === 'pending' ? run.status : task.status
    const finished = run.finished ?? (task && ['failed', 'cancelled'].includes(status) ? task.updated_at : null)
    return { task_id: run.task_id, actor: this.actor[1], status, created_at: run.created, started_at: run.started,
      finished_at: finished, params: JSON.parse(run.params), result: run.result ? JSON.parse(run.result) : null,
      error: run.error ?? task?.error ?? null,
      meta: { trigger: run.trigger, mode: null, base_snapshot: null, start_snapshot: null, finish_snapshot: null,
        skill_snapshot_id: null, ...JSON.parse(run.meta ?? '{}') } }
  }

  activity(config: Config) {
    const latest = this.sql.exec<Run>(`SELECT * FROM ov_edge_compile_run WHERE ${local} AND config_name=?
      ORDER BY created DESC,task_id DESC LIMIT 1`, ...this.actor, config.name).toArray()[0]
    const run = latest ? this.view(latest) : null
    const running = !!run && ['queued', 'running', 'cancelling'].includes(run.status)
    const initialized = !!this.latest(config.name)?.baseline
    const clock = this.clock(config.name)
    return { status: run?.status ?? 'configured', initialized, running, next_run_at: slotIso(clock?.next_slot ?? null),
      last_error: clock?.error ?? run?.error ?? null, last_run: run }
  }

  history(name: string, limit: number, cursor: string | null) {
    const mark = cursor ? this.find(cursor) : null
    if (cursor !== null && (!mark || mark.config_name !== name)) invalid('Invalid Compile run cursor.')
    const bound: SqlStorageValue[] = mark ? [mark.created, mark.task_id] : []
    const rows = this.sql.exec<Run>(`SELECT * FROM ov_edge_compile_run WHERE ${local} AND config_name=? AND created>=?
      ${mark ? 'AND (created,task_id)<(?,?)' : ''} ORDER BY created DESC,task_id DESC LIMIT ?`,
    ...this.actor, name, now() - retention, ...bound, limit + 1).toArray()
    const runs = rows.slice(0, limit).map(run => this.view(run))
    return { runs, next_cursor: rows.length > limit ? runs.at(-1)!.task_id : null }
  }

  start(run: Run, metadata: Record<string, unknown>) {
    this.sql.exec(`UPDATE ov_edge_compile_run SET status='running',started=COALESCE(started,?),meta=? WHERE ${local} AND task_id=?`,
      now(), JSON.stringify(metadata), ...this.actor, run.task_id)
  }

  finish(run: Run, result: unknown, meta: Record<string, unknown>, outputs: Artifact[], baseline: Baseline | null) {
    this.sql.exec(`UPDATE ov_edge_compile_run SET status='completed',finished=?,result=?,meta=?,output_set=?,baseline=?
      WHERE ${local} AND task_id=?`, now(), JSON.stringify(result), JSON.stringify(meta), JSON.stringify(outputs),
    baseline ? JSON.stringify(baseline) : null, ...this.actor, run.task_id)
  }

  fail(run: Run, error: unknown): void {
    // Do not echo provider text or raw SQL. Errors carry a fixed diagnostic category.
    const code = error instanceof ApiError ? error.code : 'COMPILE_FAILED'
    this.sql.exec(`UPDATE ov_edge_compile_run SET status=?,finished=?,error=? WHERE ${local} AND task_id=? AND status!='completed'`,
      code === 'TASK_CANCELLED' ? 'cancelled' : 'failed', now(), code, ...this.actor, run.task_id)
  }

  latest(name: string): Run | undefined {
    return this.sql.exec<Run>(`SELECT * FROM ov_edge_compile_run WHERE ${local} AND config_name=? AND status='completed'
      AND baseline IS NOT NULL ORDER BY finished DESC,task_id DESC LIMIT 1`, ...this.actor, name).toArray()[0]
  }

  recordedOutput(space: string, uri: string): OutputRecord | undefined {
    return this.sql.exec<OutputRecord>('SELECT uri,revision,snapshot,owner FROM ov_edge_compile_artifact WHERE account_id=? AND space=? AND uri=?',
      this.actor[0], space, uri).toArray()[0]
  }

  recordOutput(space: string, uri: string, revision: string, snapshot: string, owner: string) {
    this.sql.exec(`INSERT INTO ov_edge_compile_artifact(account_id,space,uri,revision,snapshot,owner) VALUES(?,?,?,?,?,?)
      ON CONFLICT(account_id,space,uri) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,owner=excluded.owner`,
    this.actor[0], space, uri, revision, snapshot, owner)
  }

  clearOutput(space: string, uri: string) {
    this.sql.exec('DELETE FROM ov_edge_compile_artifact WHERE account_id=? AND space=? AND uri=?', this.actor[0], space, uri)
  }

  outputs(files: CompileFiles, run: Run, limit: number, cursor: string | null) {
    const snapshot = (JSON.parse(run.meta ?? '{}') as { finish_snapshot?: string }).finish_snapshot
    const items: Artifact[] = JSON.parse(run.output_set ?? '[]')
    const page = items.filter(item => item.change_type !== 'deleted' && (!cursor || item.uri > cursor) && files.canRead(item.uri))
      .sort((a, b) => compare(a.uri, b.uri)).slice(0, limit + 1)
    const outputs = page.slice(0, limit).map(item => {
      const path = files.path(item.uri), entry = files.entry(item.uri)
      const latest = path.space !== null ? this.recordedOutput(path.space, item.uri) : undefined
      return { uri: item.uri, snapshot_id: snapshot, latest_snapshot_id: latest && entry?.revision === latest.revision ? latest.snapshot : null,
        change_type: item.change_type, provenance: { sha256: item.sha256,
          sources: item.sources.filter(source => files.canRead(source.uri)) } }
    })
    return { outputs, next_cursor: page.length > limit ? outputs.at(-1)!.uri : null }
  }
}

export function configView(row: Config, redact = false, clock?: Clock) {
  const inputs: Inputs = JSON.parse(row.inputs)
  return { compile_name: row.name,
    ...(redact ? { ...inputs, from: [], to: null, skill: null, instruction: null, args: {} } : inputs),
    task_first_create_time: row.created, last_run_time: row.last_run,
    last_triggered_slot: slotIso(clock?.last_slot ?? null), next_triggered_slot: slotIso(clock?.next_slot ?? null),
    ...(clock?.error && { schedule_error: clock.error }) }
}
