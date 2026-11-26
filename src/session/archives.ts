// SPDX-License-Identifier: AGPL-3.0-only
import { noteRetention, planRetention, saveCheckpoint } from './retention.js'
import type { WorkspaceContext } from '../context.js'
import { ApiError, ok } from '../http.js'
import { pathFor } from '../fs/contract.js'
import { edgeSessionDefaults } from '../model-config.js'
import { eventsPrompt, eventDocument, overviewPrompt, parseEvents, transcript } from './extraction.js'
import { callFilesystem, guardedFilesystem } from './filesystem.js'
import { acquire, assertFlight, assertIdle, currentFlight, release, sessionColumns, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'
import { beforeDeadline, generateText, requireGenerator, sha256 } from './generation.js'
import { decodeSegment, invalid, noTelemetry } from './protocol.js'
import type { commitOptions, StoredMessage } from './protocol.js'
import { addUsage, latestOverview, queryInt, requireMethod, requireSession, sessionConfig, sessionId, sessionUri } from './store.js'
import type { SessionRow } from './store.js'
import { autoDecision } from './auto-commit.js'
import { autoState, noteAutoSuccess } from './auto-policy.js'

type Flight = ReturnType<typeof acquire>
type Options = { extract: boolean, working: boolean, tags: string[], extractMaxTokens?: number, summaryTokens?:number,
  reasoningEffort?:ReturnType<typeof commitOptions>['reasoningEffort'] }
type Plan = { overview: string, events: ReturnType<typeof parseEvents> }
type Work = { job_id: string, flight_token: string, options: string, sealed_at: string, status: 'pending' | 'failed' | 'completed',
  failure: string | null, plan: string | null, overview: string, task_id: string | null }
const archiveWhere = `${sessionWhere} AND archive_no=?`

const archiveId = (n: number) => `archive_${String(n).padStart(3, '0')}`
const archiveUri = (key: SessionKey, n: number) => `${sessionUri(key[1], key[3])}/history/${archiveId(n)}`
function numberFor(id: string): number {
  const n = Number(id.slice(8))
  if (!/^archive_\d{3,6}$/.test(id) || n < 1 || id !== archiveId(n)) throw new ApiError(404, 'NOT_FOUND', 'Archive not found.')
  return n
}
function workFor(sql: SqlStorage, key: SessionKey, n: number): Work | undefined {
  return sql.exec<Work>(`SELECT job_id,flight_token,options,sealed_at,status,failure,plan,overview,task_id
    FROM ov_session_semantic_archives WHERE ${archiveWhere}`, ...key, n).toArray()[0]
}
function archiveRows(sql: SqlStorage, key: SessionKey, n: number) {
  return sql.exec<{ payload: string }>(`SELECT payload FROM ov_session_messages WHERE ${archiveWhere} ORDER BY seq`, ...key, n)
}
const jsonl = (rows: Array<{ payload: string }>) => rows.length ? rows.map(r => r.payload).join('\n') + '\n' : ''
function receiptUris(sql: SqlStorage, key: SessionKey, n: number): string[] {
  return sql.exec<{ uri: string }>(`SELECT uri FROM ov_session_memory_receipts WHERE ${archiveWhere} ORDER BY page_id`, ...key, n)
    .toArray().map(row => row.uri)
}

function snapshot(ctx: WorkspaceContext, key: SessionKey, id: string) {
  const n = numberFor(id), { sql } = ctx
  requireSession(sql, key)
  if (!sql.exec(`SELECT 1 FROM ov_session_archives WHERE ${archiveWhere}`, ...key, n).toArray().length) {
    throw new ApiError(404, 'NOT_FOUND', 'Archive not found.')
  }
  return { n, work: workFor(sql, key, n), rows: archiveRows(sql, key, n).toArray() }
}

export async function readArchive(ctx: WorkspaceContext, key: SessionKey, id: string) {
  const { n, work, rows } = snapshot(ctx, key, id)
  const owner = work?.status === 'pending' ? archiveOwner(ctx, key, work) : undefined
  const lost = owner === 'lost', cancelled = owner === 'cancelled'
  const created = work ? receiptUris(ctx.sql, key, n) : []
  return { archive_id: id, status: cancelled ? 'failed' : work?.status ?? 'completed', abstract: '', overview: work?.overview ?? '',
    messages_sha256: await sha256(jsonl(rows)), messages: rows.map(row => JSON.parse(row.payload) as StoredMessage),
    ...(work && { memories_extracted: created.length, memory_uris: created }),
    ...(work?.task_id && { task_id: work.task_id }),
    ...(lost && { recovery: 'ownerless_ready' }),
    ...(cancelled || work?.failure ? { failure: { code: cancelled ? 'TASK_CANCELLED' : work?.failure } } : {}) }
}

function archiveOwner(ctx: WorkspaceContext, key: SessionKey, work: Pick<Work, 'flight_token' | 'task_id'>): 'active' | 'cancelled' | 'lost' {
  if (currentFlight(ctx, key)?.token === work.flight_token) return 'active'
  if (work.task_id) {
    if (!ctx.jobs) return 'active' // An authorization without JobAccess cannot claim an unknown owner's archive.
    const task = ctx.jobs.get(work.task_id)
    if (task?.status === 'cancelled') return 'cancelled'
    if (task && ['pending', 'running', 'cancelling'].includes(task.status)) return 'active'
  }
  return 'lost'
}

export function hasActiveArchiveTask(ctx: WorkspaceContext, key: SessionKey): boolean {
  const pending = ctx.sql.exec<Pick<Work, 'flight_token' | 'task_id'>>(`SELECT flight_token,task_id FROM ov_session_semantic_archives
    WHERE ${sessionWhere} AND status='pending' LIMIT 8`, ...key).toArray()
  return pending.some(work => archiveOwner(ctx, key, work) === 'active')
}

function archiveOptions(ctx: WorkspaceContext, key: SessionKey, policy: string | null, opts: ReturnType<typeof commitOptions>): Options {
  const configured = policy ? JSON.parse(policy) : null
  return { extract: ctx.memorySettings?.extraction_enabled !== false && (configured?.self?.enabled ?? true) && (configured?.memory_types ?? ['events']).includes('events'),
    working: !opts.reset && (opts.working ?? configured?.working_memory?.enabled ?? false), summaryTokens:opts.summaryTokens,reasoningEffort:opts.reasoningEffort,
    tags: opts.tags ?? sessionConfig(ctx.sql, key).memory_extraction_config.events.tags,
    ...(ctx.memorySettings?.edge_extraction_max_tokens !== undefined && { extractMaxTokens: ctx.memorySettings.edge_extraction_max_tokens }) }
}

export function commitAnchor(sql: SqlStorage, key: SessionKey, row: SessionRow): string {
  const head = sql.exec<{ id: string }>(`SELECT json_extract(payload,'$.id') AS id FROM ov_session_messages
    WHERE ${sessionWhere} AND seq=?`, ...key, row.total_message_count).toArray()[0]?.id
  return JSON.stringify([head, row.created_at, row.message_count, row.commit_count, row.total_message_count,
    row.memory_policy, sessionConfig(sql, key).memory_extraction_config.events.tags, autoState(sql, key).revision ?? null])
}

// Runs inside the same SQLite transaction as either the task admission or the
// synchronous commit. For queued work the lease is acquired by the consumer.
export function rotateArchive(ctx: WorkspaceContext, key: SessionKey, opts: ReturnType<typeof commitOptions>, expected?: string,
   auto: boolean | 'idle' = false, acceptedTask?: string) {
  const { sql } = ctx
    const session = requireSession(sql, key)
    ctx.assertActive?.()
    if (auto) {
      const decision = autoDecision(sql, key, session, auto === 'idle')
      if (!decision || decision.anchor !== expected || currentFlight(ctx, key)) {
        const result = { session_id: key[3], status: 'skipped', reason: 'auto_policy_not_due_or_session_changed', archived: false }
        ctx.finishJobInTransaction?.(result)
        return { flight: undefined, n: 0, result }
      }
      opts = { ...opts, keep: decision.keep }
    }
    assertIdle(ctx, key)
    if (!auto && expected !== undefined && commitAnchor(sql, key, session) !== expected) {
      throw new ApiError(409, 'CONFLICT', 'The session changed after job submission; review and submit a new commit.')
    }
    ctx.assertArchiveSettingsCurrent?.()
    const retainedPlan = opts.retention ? planRetention(sql,key,opts.retention) : undefined
    if (retainedPlan) opts = { ...opts, keep: retainedPlan.keep }
    const options = archiveOptions(ctx, key, session.memory_policy, opts)
    if (options.reasoningEffort!==undefined && (!ctx.sessionReasoning||!options.working)) {
      throw new ApiError(412,'FAILED_PRECONDITION','Reasoning effort requires enabled Working Memory and a compatible operator-configured model.')
    }
    const now = new Date().toISOString(), retained = Math.min(opts.keep, session.message_count)
    const archived = session.message_count > retained, cutoff = session.total_message_count - retained
    let count = session.commit_count, n = 0, flight: Flight | undefined
    const appendArchive = (boundary: boolean) => {
      sql.exec(`INSERT INTO ov_session_archives (${sessionColumns},archive_no,context_reset) VALUES (?,?,?,?,?,?)`, ...key, ++count, boundary ? 1 : 0)
    }
    if (archived) {
      if (options.extract || options.working || acceptedTask) {
        if (hasActiveArchiveTask(ctx, key)) {
          throw new ApiError(409, 'CONFLICT', 'Another task owns an archive in this session.')
        }
        const incomplete = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ov_session_semantic_archives
          WHERE ${sessionWhere} AND status!='completed'`, ...key).one().n
        if (incomplete >= 8) throw new ApiError(409, 'FAILED_PRECONDITION', 'Resolve unfinished archives before committing more.')
        const lines = options.extract || options.working ? transcript(sql.exec<{ payload: string }>(`SELECT payload FROM ov_session_messages WHERE ${sessionWhere}
          AND archive_no IS NULL AND seq<=? ORDER BY seq`, ...key, cutoff), key[1], now) : []
        options.extract &&= lines.some(line => line.role === 'user')
        options.working &&= lines.length > 0
        if (options.extract || options.working) {
          requireGenerator(ctx) // No seal when a required provider isn't mounted at all.
          if (!acceptedTask) flight = acquire(ctx, key, 'archive')
        }
      }
      appendArchive(false)
      n = count
      sql.exec(`UPDATE ov_session_messages SET archive_no=? WHERE ${sessionWhere} AND archive_no IS NULL AND seq<=?`, n, ...key, cutoff)
      if (flight || acceptedTask) sql.exec(`INSERT INTO ov_session_semantic_archives
        (${sessionColumns},archive_no,job_id,flight_token,options,sealed_at,status,task_id) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`,
      ...key, n, crypto.randomUUID(), flight?.token ?? '', JSON.stringify(options), now, acceptedTask ?? null)
    }
    if (opts.reset) {
      const previous = sql.exec<{ context_reset: number }>(`SELECT context_reset FROM ov_session_archives WHERE ${archiveWhere}`, ...key, count).toArray()[0]
      if (previous?.context_reset !== 1) appendArchive(true)
    }
    sql.exec(`UPDATE ov_sessions SET updated_at=?,last_commit_at=?,message_count=?,keep_recent_count=?,commit_count=? WHERE ${sessionWhere}`,
      now, archived ? now : session.last_commit_at, retained, opts.keep, count, ...key)
    if (!auto) noteRetention(sql, key, opts.retention)
    if (archived || opts.reset) saveCheckpoint(sql,key,n,retainedPlan?.checkpoint)
    const result = { session_id: key[3], status: archived ? 'completed' : 'skipped',
      task_id: null, archive_uri: archived ? archiveUri(key, n) : null, archived, effective_enable_working_memory: archived && options.working,
      ...(opts.reset ? { reset_context: true } : {}),
      ...(archived ? {} : { reason: session.message_count ? 'all_within_keep_window' : 'no_messages' }) }
    if (!flight && !acceptedTask) {
      if (auto && archived) noteAutoSuccess(sql, key, now)
      ctx.finishJobInTransaction?.(result)
    }
    return { flight, n, result }
}

export async function commitArchive(ctx: WorkspaceContext, key: SessionKey, opts: ReturnType<typeof commitOptions>, expected?: string, auto: boolean | 'idle' = false) {
  const rotation = ctx.storage.transactionSync(() => rotateArchive(ctx, key, opts, expected, auto))
  if (!rotation.flight) return rotation.result
  return processArchive(ctx, key, rotation.n, rotation.flight, rotation.result, !!auto)
}

export function acceptedArchive(ctx: WorkspaceContext, key: SessionKey, n: number, taskId: string) {
  const row = workFor(ctx.sql, key, n)
  if (!row || row.task_id !== taskId) throw new ApiError(409, 'FAILED_PRECONDITION', 'The queued archive no longer belongs to this task.')
  const options: Options = JSON.parse(row.options)
  return { session_id: key[3], archive_id: archiveId(n), archive_uri: archiveUri(key, n), archived: true,
    effective_enable_working_memory: options.working }
}

export async function runSealedArchive(ctx: WorkspaceContext, key: SessionKey, n: number) {
  if (!ctx.taskId) throw new ApiError(409, 'FAILED_PRECONDITION', 'An authenticated task owner is required.')
  const task = ctx.taskId
  const { base, flight } = ctx.storage.transactionSync(() => {
    ctx.assertActive?.()
    const base = acceptedArchive(ctx, key, n, task)
    const row = workFor(ctx.sql, key, n)!
    if (row.status !== 'pending') throw retryPrecondition()
    const flight = acquire(ctx, key, 'archive')
    ctx.sql.exec(`UPDATE ov_session_semantic_archives SET flight_token=? WHERE ${archiveWhere} AND task_id=?`,
      flight.token, ...key, n, task)
    return { base, flight }
  })
  return processArchive(ctx, key, n, flight, { ...base, status: 'completed', task_id: task })
}

async function processArchive<T extends object>(ctx: WorkspaceContext, key: SessionKey, n: number, flight: Flight, base: T, auto = false) {
  const { sql, storage } = ctx
  const guard = () => { ctx.assertActive?.(); assertFlight(ctx, key, flight) }
  const reauthorize = async () => {
    if (ctx.reauthorize) await beforeDeadline(ctx.reauthorize, flight.deadline)
    guard()
  }
  const fsContext: WorkspaceContext = { ...ctx, assertActive: guard, reauthorize }
  try {
    await reauthorize()
    const work = workFor(sql, key, n)!
    const opts: Options = JSON.parse(work.options)
    const lines = opts.extract || opts.working ? transcript(archiveRows(sql, key, n), key[1], work.sealed_at) : []
    let plan: Plan
    if (work.plan) plan = JSON.parse(work.plan)
    else {
      const data = (previous?: string) => JSON.stringify({ ...(previous && { previous }), transcript: lines })
      const run = async (system: string, content: string, maxTokens: number, maxBytes: number) => {
        guard()
        const g = await generateText(ctx, [{ role: 'system', content: system }, { role: 'user', content }], maxTokens, maxBytes, flight.deadline,
          undefined,system===overviewPrompt?opts.reasoningEffort:undefined)
        await reauthorize()
        storage.transactionSync(() => { guard(); addUsage(sql, key, g) })
        return g.text
      }
      const events = opts.extract ? parseEvents(await run(eventsPrompt, data(), opts.extractMaxTokens ?? edgeSessionDefaults.extractionTokens, 12 * 1024), lines) : []
      const overview = opts.working ? (await run(overviewPrompt, data(latestOverview(sql, key, n)), opts.summaryTokens??512, 3072)).trim() : ''
      plan = { events, overview }
      // Validate every document before the first publication, then persist
      // the exact model selection. Retries don't regenerate a partial plan.
      for (const event of events) eventDocument(event, lines, work.job_id)
      storage.transactionSync(() => {
        guard()
        sql.exec(`UPDATE ov_session_semantic_archives SET plan=? WHERE ${archiveWhere}`, JSON.stringify(plan), ...key, n)
      })
    }
    const directories = new Set<string>()
    for (const event of plan.events) {
      guard()
      if (sql.exec(`SELECT 1 FROM ov_session_memory_receipts WHERE ${archiveWhere} AND page_id=?`, ...key, n, event.page_id).toArray().length) continue
      const doc = eventDocument(event, lines, work.job_id)
      const segments = doc.base.slice('viking://~/memories/'.length).split('/')
      for (let i = 1; i <= segments.length; i++) {
        const uri = 'viking://~/memories/' + segments.slice(0, i).join('/')
        if (directories.has(uri)) continue
        try { await beforeDeadline(() => callFilesystem(guardedFilesystem(ctx, guard), '/api/v1/fs/mkdir', { uri }), flight.deadline) }
        catch (error) { if (!(error instanceof ApiError && error.code === 'ALREADY_EXISTS')) throw error }
        await reauthorize()
        directories.add(uri)
      }
      const path = pathFor(doc.uri, ctx.caller)
      const guarded = guardedFilesystem(fsContext, guard, () => {
        sql.exec(`INSERT INTO ov_session_memory_receipts (${sessionColumns},archive_no,page_id,uri) VALUES (?,?,?,?,?,?,?)`,
          ...key, n, event.page_id, path.uri)
      })
      await beforeDeadline(() => callFilesystem(guarded, '/api/v1/content/write', {
        uri: doc.uri, content: doc.content, mode: 'create', wait: true, tags: opts.tags, processing_mode: 'vectors_only',
      }), flight.deadline)
      if (!sql.exec(`SELECT 1 FROM ov_session_memory_receipts WHERE ${archiveWhere} AND page_id=?`, ...key, n, event.page_id).toArray().length) {
        throw new ApiError(503, 'FILESYSTEM_UNAVAILABLE', 'The filesystem did not record a transactional publication receipt.')
      }
    }
    await reauthorize()
    return storage.transactionSync(() => {
      guard()
      const memory_uris = receiptUris(sql, key, n)
      sql.exec(`UPDATE ov_session_semantic_archives SET status='completed',failure=NULL,plan=NULL,overview=? WHERE ${archiveWhere}`,
        plan.overview, ...key, n)
      if (auto) noteAutoSuccess(sql, key, new Date().toISOString())
      release(ctx, key, flight)
      const result = { ...base, memories_extracted: memory_uris.length, memory_uris }
      ctx.finishJobInTransaction?.(result)
      return result
    })
  } catch (error) {
    let cause = error
    try { ctx.assertActive?.() } catch (inactive) { cause = inactive }
    const failure = cause instanceof ApiError ? cause.code : 'INTERNAL_ERROR'
    storage.transactionSync(() => {
      if (release(ctx, key, flight)) sql.exec(`UPDATE ov_session_semantic_archives SET status='failed',failure=?
        WHERE ${archiveWhere} AND flight_token=?`, failure, ...key, n, flight.token)
    })
    if (cause instanceof ApiError) throw new ApiError(cause.status, cause.code, `Archive ${archiveId(n)} sealed; semantic processing did not complete.`)
    throw cause
  }
}

const retryPrecondition = () => new ApiError(409, 'FAILED_PRECONDITION', 'The archive is complete, changed, or not eligible for retry.')
const retryAnchor = (work: Work) => `${work.job_id}:${work.flight_token}`

function checkRetry(ctx: WorkspaceContext, key: SessionKey, work: Work | undefined, body: Record<string, unknown>, expectedJob?: string): Work {
  if (!work || work.status === 'completed' || (expectedJob !== undefined && expectedJob !== retryAnchor(work))) throw retryPrecondition()
  const owner = work.status === 'pending' ? archiveOwner(ctx, key, work) : undefined
  if (owner === 'active') throw new ApiError(409, 'CONFLICT', 'A task owns this archive.')
  if ((owner === 'lost' && body.allow_ownerless_ready !== true) ||
      ((owner === 'cancelled' || work.failure === 'TASK_CANCELLED') && body.allow_cancelled_failure !== true)) throw retryPrecondition()
  return work
}

export async function prepareRetry(ctx: WorkspaceContext, key: SessionKey, id: string, body: Record<string, unknown>, expectedJob?: string) {
  noTelemetry(body.telemetry)
  const hash = body.expected_messages_sha256
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) invalid('expected_messages_sha256 must be a lowercase SHA-256 digest.')
  for (const flag of ['allow_ownerless_ready', 'allow_cancelled_failure']) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') invalid(`${flag} must be boolean.`)
  }
  const { n, work, rows } = snapshot(ctx, key, id)
  assertIdle(ctx, key)
  const attempt = checkRetry(ctx, key, work, body, expectedJob)
  if (await sha256(jsonl(rows)) !== hash) throw new ApiError(409, 'FAILED_PRECONDITION', 'The archive hash does not match.')
  return { n, anchor: retryAnchor(attempt), input: { expected_messages_sha256: hash,
    allow_ownerless_ready: body.allow_ownerless_ready === true, allow_cancelled_failure: body.allow_cancelled_failure === true } }
}

export async function retryArchive(ctx: WorkspaceContext, key: SessionKey, id: string, body: Record<string, unknown>, expectedJob?: string) {
  const { n, anchor } = await prepareRetry(ctx, key, id, body, expectedJob)
  await ctx.reauthorize?.()
  const flight = ctx.storage.transactionSync(() => {
    ctx.assertActive?.()
    assertIdle(ctx, key)
    const current = checkRetry(ctx, key, workFor(ctx.sql, key, n), body, anchor)
    const options: Options = JSON.parse(current.options)
    if (!current.plan && (options.extract || options.working)) requireGenerator(ctx)
    const lease = acquire(ctx, key, 'archive')
    ctx.sql.exec(`UPDATE ov_session_semantic_archives SET status='pending',failure=NULL,flight_token=?,task_id=? WHERE ${archiveWhere}`,
      lease.token, ctx.taskId ?? null, ...key, n)
    return lease
  })
  return processArchive(ctx, key, n, flight, { status: 'completed', session_id: key[3], archive_id: id,
    archive_uri: archiveUri(key, n), task_id: null })
}

// Called from JobAccess.onAccepted (same transaction as task INSERT). A
// queued retry is already an owner before the alarm begins executing it.
export function bindRetryTask(ctx: WorkspaceContext, key: SessionKey, n: number, body: Record<string, unknown>,
  anchor: string, taskId: string): void {
  ctx.assertActive?.()
  assertIdle(ctx, key)
  const current = checkRetry(ctx, key, workFor(ctx.sql, key, n), body, anchor)
  const options: Options = JSON.parse(current.options)
  if (!current.plan && (options.extract || options.working)) requireGenerator(ctx)
  ctx.sql.exec(`UPDATE ov_session_semantic_archives SET status='pending',failure=NULL,flight_token='',task_id=? WHERE ${archiveWhere}`,
    taskId, ...key, n)
}

// Original Studio uses these virtual names for archive history and memory diff.
// This is a narrow read-only namespace; mount before the general FS router.
export function sessionContent(request: Request, url: URL, ctx: WorkspaceContext): Response | undefined {
  const uri = url.searchParams.get('uri')
  const match = /^viking:\/\/(?:user\/([^/]+)|~)\/sessions\/([^/]+)\/history\/(archive_\d+)\/(messages\.jsonl|memory_diff\.json)$/.exec(uri ?? '')
  if (!match) return undefined
  requireMethod(request.method, 'GET')
  if (match[1] && decodeSegment(match[1]) !== ctx.caller.userId) throw new ApiError(404, 'NOT_FOUND', 'Archive not found.')
  const key: SessionKey = [ctx.caller.accountId, ctx.caller.userId, ctx.caller.agentId, sessionId(decodeSegment(match[2]))]
  const n = numberFor(match[3]), { sql } = ctx
  if (!sql.exec(`SELECT 1 FROM ov_session_archives WHERE ${archiveWhere}`, ...key, n).toArray().length) {
    throw new ApiError(404, 'NOT_FOUND', 'Archive not found.')
  }
  const offset = queryInt(url, 'offset', 0), limit = queryInt(url, 'limit', -1, -1)
  if (match[4] === 'messages.jsonl') {
    const rows = sql.exec<{ payload: string }>(`SELECT payload FROM ov_session_messages WHERE ${archiveWhere} ORDER BY seq LIMIT ? OFFSET ?`,
      ...key, n, limit, offset).toArray()
    return ok(jsonl(rows))
  }
  const uris = receiptUris(sql, key, n)
  if (!uris.length) throw new ApiError(404, 'NOT_FOUND', 'No memory changes were recorded for this archive.')
  const diff = JSON.stringify({ archive_uri: archiveUri(key, n),
    summary: { adds: uris.length, updates: 0, deletes: 0 },
    operations: { adds: uris.map(uri => ({ uri, memory_type: 'events' })), updates: [], deletes: [] } })
  return ok(offset > 0 || limit === 0 ? '' : diff)
}
