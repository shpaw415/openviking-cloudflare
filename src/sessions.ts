// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, ok, readJson } from './http.js'
import { edgeSessionDefaults } from './model-config.js'
import { acceptedArchive, bindRetryTask, commitArchive, commitAnchor, prepareRetry, readArchive, retryArchive, rotateArchive, runSealedArchive, sessionContent } from './session/archives.js'
import { assertIdle, currentFlight, initFlights, keyFor, ownerFor } from './session/flight.js'
import { autoState, setAutoPolicy, validateAutoPolicy } from './session/auto-policy.js'
import type { AutoPolicy } from './session/auto-policy.js'
import { maybeQueueAuto } from './session/auto-commit.js'
import { bindIdle } from './session/idle.js'
import { ensureAlarm } from './tasks.js'
import { planRetention } from './session/retention.js'
import { commitOptions, decodeSegment, encodeMessages, eventTags, invalid, isRecord, memoryPolicy, noTelemetry, optionalJson, unsupported } from './session/protocol.js'
import { memoryStats, sessionStats } from './session/stats.js'
import {
  appendRows, deleteSession, getSession, identity, initStore, insertSession, listSessions, newSessionId,
  queryBool, queryInt, requireMethod, requireSession, sessionConfig, sessionContext, sessionDetail, sessionId, sessionUri, setSessionTags,
} from './session/store.js'
import { initToolResults, insertToolResults, prepareToolResults, toolResults } from './session/tool-results.js'

const base = '/api/v1/sessions'

export function initSessions(ctx: WorkspaceContext): void {
  initStore(ctx)
  initFlights(ctx)
  initToolResults(ctx.sql)
}

export async function runSessionCommit(payload: Record<string, unknown>, ctx: WorkspaceContext): Promise<unknown> {
  const key = keyFor(ctx, sessionId(payload.session_id))
  await ctx.reauthorize?.()
  ctx.assertActive?.()
  if (payload.op === 'sealed' && typeof payload.archive_no === 'number' && Number.isSafeInteger(payload.archive_no) && payload.archive_no > 0) {
    return runSealedArchive(ctx, key, payload.archive_no)
  }
  if (!isRecord(payload.body)) invalid('Invalid commit job.')
  if (payload.op === 'retry' && typeof payload.archive_id === 'string') {
    return retryArchive(ctx, key, payload.archive_id, payload.body, typeof payload.job_id === 'string' ? payload.job_id : '')
  }
  if ((payload.op !== 'commit' && payload.op !== 'auto' && payload.op !== 'idle') || typeof payload.anchor !== 'string') invalid('Invalid commit job.')
  if (payload.op === 'idle' && !ctx.sessionIdleCredential) unsupported('Idle commit is not mounted.')
  return commitArchive(ctx, key, commitOptions(payload.body), payload.anchor, payload.op === 'idle' ? 'idle' : payload.op === 'auto')
}

function syncRequested(url: URL, body: Record<string, unknown>, defaultWait = false): boolean {
  if (body.wait !== undefined && typeof body.wait !== 'boolean') invalid('wait must be a boolean.')
  return queryBool(url, 'wait', body.wait === undefined ? defaultWait : body.wait)
}

function configInput(body: Record<string, unknown>, ctx: WorkspaceContext) {
  noTelemetry(body.telemetry)
  const auto = validateAutoPolicy(body.auto_commit_policy, ctx.sessionRuntime)
  if (auto && !ctx.jobs) unsupported('Automatic threshold commits require the durable job consumer.')
  return { tags: eventTags(body.memory_extraction_config, 'events'), auto }
}

function newSessionPolicy(ctx: WorkspaceContext): Partial<AutoPolicy> | undefined {
  const policy = ctx.memorySettings?.session_auto_commit
  if (!ctx.jobs || !policy?.enabled) return undefined
  const { enabled: _enabled, ...thresholds } = policy
  return thresholds
}

export async function routeSessions(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  const path = url.pathname.replace(/\/$/, '')
  if (path === '/api/v1/content/read') return sessionContent(request, url, ctx)
  if (path === '/api/v1/stats/memories') {
    requireMethod(request.method, 'GET')
    return ok(memoryStats(ctx, url.searchParams.get('category')))
  }
  if (path.startsWith('/api/v1/stats/sessions/') && path.split('/').length === 6) {
    requireMethod(request.method, 'GET')
    return ok(sessionStats(ctx.sql, keyFor(ctx, sessionId(decodeSegment(path.split('/')[5])))))
  }
  if (path !== base && !path.startsWith(`${base}/`)) return undefined

  const { sql, storage, caller } = ctx, owner = ownerFor(ctx)
  if (path === base) {
    requireMethod(request.method, 'GET', 'POST')
    if (request.method !== 'POST') return ok(listSessions(sql, owner).map(row => ({
      session_id: row.session_id, uri: sessionUri(owner[1], row.session_id), is_dir: true, mod_time: row.updated_at,
    })))
    const body = await optionalJson(request)
    const { tags, auto } = configInput(body, ctx)
    const policy = memoryPolicy(body.memory_policy)
    const id = body.session_id == null || body.session_id === '' ? newSessionId() : sessionId(body.session_id)
    const key = keyFor(ctx, id)
    if (auto?.idle_timeout_seconds) await ensureAlarm(storage, Date.now() + 1000)
    await ctx.reauthorize?.()
    return ok(storage.transactionSync(() => {
      if (getSession(sql, key)) throw new ApiError(409, 'ALREADY_EXISTS', 'Session already exists.')
      insertSession(sql, key, new Date().toISOString(), policy)
      if (tags) setSessionTags(sql, key, tags)
      const initial = auto === undefined ? newSessionPolicy(ctx) : auto
      if (initial !== undefined) setAutoPolicy(sql, key, initial)
      if (initial?.idle_timeout_seconds) bindIdle(ctx, key)
      return { session_id: id, uri: sessionUri(owner[1], id), user: identity(owner), ...sessionConfig(sql, key) }
    }))
  }

  const [idSegment, ...tail] = path.slice(base.length + 1).split('/')
  const id = sessionId(decodeSegment(idSegment)), key = keyFor(ctx, id)
  if (!tail.length) {
    requireMethod(request.method, 'GET', 'DELETE')
    if (request.method === 'DELETE') { deleteSession(ctx, key); return ok({ session_id: id }) }
    const session = request.method === 'GET' && queryBool(url, 'auto_create', false)
      ? storage.transactionSync(() => {
        const existing = getSession(sql, key)
        if (existing) return existing
        const created = insertSession(sql, key, new Date().toISOString(), null)
        const initial = newSessionPolicy(ctx)
        if (initial) setAutoPolicy(sql, key, initial)
        return created
      })
      : requireSession(sql, key)
    return ok(sessionDetail(sql, key, session))
  }
  if (tail[0] === 'messages' && (tail.length === 1 || (tail.length === 2 && tail[1] === 'batch'))) {
    requireMethod(request.method, 'POST')
    const batch = tail.length === 2
    const input = encodeMessages(await readJson(request, 512 * 1024), batch, caller.userId)
    const results = await prepareToolResults(input)
    if (ctx.sessionRuntime && autoState(sql, key).policy?.idle_timeout_seconds) await ensureAlarm(storage, Date.now() + 1000)
    await ctx.reauthorize?.()
    const result = storage.transactionSync(() => {
      // A sealed archive is immutable: native writes can safely append to the
      // active suffix while its semantic phase awaits the provider, not during chat.
      if (currentFlight(ctx, key)?.kind === 'bot') assertIdle(ctx, key)
      const existing = getSession(sql, key)
      const seq = results.length ? existing?.total_message_count ?? 0 : 0
      const result = appendRows(sql, key, input, batch)
      const initial = !existing ? newSessionPolicy(ctx) : undefined
      if (initial) setAutoPolicy(sql, key, initial)
      insertToolResults(sql, key, seq, results)
      return result
    })
    if (input.rows.length) await maybeQueueAuto(ctx, key)
    return ok(result)
  }
  if (tail.length === 1 && tail[0] === 'context') {
    requireMethod(request.method, 'GET')
    const cap = ctx.memorySettings?.edge_context_token_budget
    return ok(sessionContext(ctx, key, Math.min(queryInt(url, 'token_budget', edgeSessionDefaults.contextTokens), cap ?? Infinity)))
  }
  if (tail.length === 1 && tail[0] === 'commit') {
    requireMethod(request.method, 'POST')
    const body = await optionalJson(request), opts = commitOptions(body, ctx.sessionRuntime)
    await ctx.reauthorize?.()
    if (syncRequested(url, body)) return ok(await commitArchive(ctx, key, opts))
    assertIdle(ctx, key)
    const session = requireSession(sql, key)
    const keep = opts.retention ? planRetention(sql, key, opts.retention).keep : opts.keep
    if (session.message_count <= keep) return ok(await commitArchive(ctx, key, opts))
    if (!ctx.jobs) unsupported('The durable session task consumer is not mounted.')
    const archive = session.commit_count + 1, anchor = commitAnchor(sql, key, session)
    const task = await ctx.jobs.enqueue('session_commit', id, { session_id: id, op: 'sealed', archive_no: archive, anchor,
       options: { keep, reset: opts.reset, working: opts.working ?? null, tags: opts.tags ?? null,
         ...(opts.retention && { retention: opts.retention }), ...(opts.summaryTokens!==undefined && {summaryTokens:opts.summaryTokens}),
         ...(opts.reasoningEffort!==undefined&&{reasoningEffort:opts.reasoningEffort}) } }, {
      meta: { session_id: id }, idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
      onAccepted: owner => { rotateArchive(ctx, key, opts, anchor, false, owner.task_id) },
    })
    return ok({ ...acceptedArchive(ctx, key, archive, task.task_id), status: 'accepted', task_id: task.task_id })
  }
  if (tail[0] === 'archives') {
    if (tail.length === 2) {
      requireMethod(request.method, 'GET')
      return ok(await readArchive(ctx, key, decodeSegment(tail[1])))
    }
    if (tail.length === 3 && tail[2] === 'retry') {
      requireMethod(request.method, 'POST')
      const archive = decodeSegment(tail[1]), body = await optionalJson(request)
      if (syncRequested(url, body, !ctx.jobs)) return ok(await retryArchive(ctx, key, archive, body))
      if (!ctx.jobs) unsupported('The durable session task consumer is not mounted.')
      const { anchor, n, input: normalized } = await prepareRetry(ctx, key, archive, body)
      await ctx.reauthorize?.()
      const task = await ctx.jobs.enqueue('session_commit', id, { session_id: id, op: 'sealed', archive_no: n,
        retry: anchor, expected_messages_sha256: normalized.expected_messages_sha256 }, { meta: { session_id: id, archive_id: archive },
        idempotencyKey: request.headers.get('idempotency-key') ?? undefined,
        onAccepted: owner => bindRetryTask(ctx, key, n, normalized, anchor, owner.task_id) })
      return ok({ ...acceptedArchive(ctx, key, n, task.task_id), status: 'accepted', task_id: task.task_id })
    }
  }
  if (tail.length === 1 && tail[0] === 'config') {
    requireMethod(request.method, 'PATCH')
    const body = await optionalJson(request)
    if (Object.keys(body).some(key => !['auto_commit_policy', 'memory_extraction_config', 'telemetry'].includes(key))) invalid('Unknown session setting.')
    const { tags, auto } = configInput(body, ctx)
    if (ctx.sessionRuntime && auto !== undefined) await ensureAlarm(storage, Date.now() + 1000)
    await ctx.reauthorize?.()
    return ok(storage.transactionSync(() => {
      requireSession(sql, key)
      assertIdle(ctx, key)
      if (tags) setSessionTags(sql, key, tags)
      if (auto !== undefined) {
        setAutoPolicy(sql, key, auto)
        if (ctx.sessionRuntime || auto === null || auto.idle_timeout_seconds === 0) bindIdle(ctx, key)
      }
      return { session_id: id, ...sessionConfig(sql, key) }
    }))
  }
  if (tail[0] === 'tool-results' && (tail.length <= 2 || (tail.length === 3 && tail[2] === 'search'))) {
    requireMethod(request.method, 'GET')
    return toolResults(sql, key, url, tail.slice(1))
  }
  return undefined
}
