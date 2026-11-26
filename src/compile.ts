// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { embeddingModel } from './embeddings.js'
import { subtreeRevision } from './filesystem.js'
import { encoder, conflict, invalid, onlyKeys, queryString, quota, str, unsupported } from './fs/contract.js'
import { ApiError, isRecord, ok, readJson } from './http.js'
import { runArtifacts } from './compile/artifacts.js'
import { runMemory, submitMemory } from './compile/memory.js'
import { CompileFiles } from './compile/files.js'
import { unavailable } from './compile/generate.js'
import { actorScope, checkOwner, compileName, exampleRoot, paging, parseInputs, recipeMarkdown, recipes, rulesRoot, sha256, submissionKey, targetPath } from './compile/input.js'
import type { Inputs } from './compile/input.js'
import { initRules, ruleInputs, runRules, searchRules } from './compile/rules.js'
import { CompileState, configView, initState } from './compile/state.js'
import { acceptSlot, armEarlier, assertScheduledRun, currentCandidate, dueSlot, futureSlot, holdSchedule, identityOf,
  initCompileSchedules, peekDueCompileSchedule, resolveSchedule, slotIso } from './compile/schedule.js'
import type { Candidate, ScheduleIdentity } from './compile/schedule.js'

export { armCompileSchedule } from './compile/schedule.js'

export function initCompile(ctx: WorkspaceContext): void { initState(ctx); initRules(ctx) }

/** Pure read-only catalogue for the system Skills and content routes owned by Filesystem. */
export function compileExampleSkills(): Array<{ name: string; uri: string; description: string; content: string }> {
  return Array.from(recipes, ([name, description]) => ({
    name, uri: `${exampleRoot}/${name}`, description, content: recipeMarkdown(name, description),
  }))
}

function method(request: Request, expected: 'GET' | 'POST') {
  if (request.method !== expected && !(request.method === 'HEAD' && expected === 'GET')) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Use ${expected} for this route.`)
  }
}

function missing(): never { throw new ApiError(404, 'NOT_FOUND', 'Compile configuration, run or submission not found.') }
function queue(ctx: WorkspaceContext) {
  if (!ctx.generate) unavailable()
  if (!ctx.jobs) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'No active Compile task queue is configured.')
  return ctx.jobs
}

async function save(request: Request, state: CompileState, files: CompileFiles, update = false) {
  const body = await readJson(request, 24_576)
  if (isRecord(body.args)) checkOwner(body.args.owner_user_id, files.ctx)
  const name = body.compile_name !== undefined ? compileName(body.compile_name)
    : update && body.to !== undefined ? (state.byTarget(targetPath(body.to, files.ctx).uri) ?? missing()).name
      : compileName(undefined)
  const previous = update ? state.config(name) ?? missing() : undefined
  const input = parseInputs(body, files.ctx, update ? 'update' : 'create', previous ? JSON.parse(previous.inputs) as Inputs : undefined)
  if (input.update_schedule) input.update_schedule = resolveSchedule(input.update_schedule, state.actor, name)
  let credential: string | null = null
  if (input.auto_update) {
    credential = files.ctx.compileScheduleCredential ?? null
    if (!credential || !/^[a-f0-9]{64}$/u.test(credential) || !files.ctx.reauthorize) {
      throw new ApiError(412, 'FAILED_PRECONDITION', 'Automatic Compile requires a currently managed API key.')
    }
    queue(files.ctx)
  }
  const updatedBy = body.updated_by == null ? state.ctx.caller.userId : str(body.updated_by, 'updated_by', undefined, 128).trim()
  if (!updatedBy) invalid('updated_by must not be blank.')
  const signature = await sha256(JSON.stringify([input, updatedBy, crypto.randomUUID()]))
  await state.ctx.reauthorize?.()
  const record = await state.save(files, name, input, signature, updatedBy, previous, credential)
  return ok(update ? { ...configView(record, false, state.clock(name)), ...state.activity(record) } : { compile_name: name })
}

type ScheduledAdmission = { row: Candidate; slot: number; next: number; key: string }

function verifyAdmission(state: CompileState, files: CompileFiles, inputs: Inputs, scheduled?: ScheduledAdmission) {
  if (scheduled && (!currentCandidate(state.sql, scheduled.row) ||
      state.config(scheduled.row.name)?.signature !== scheduled.row.revision)) conflict('The Compile configuration or slot changed before admission.')
  const target = files.validate(inputs)
  files.checkTargetLayout(target)
  state.assertLayout(target.space, target.uri)
  if (scheduled) verifyScheduledAccess(files, inputs)
}

function verifyScheduledAccess(files: CompileFiles, inputs: Inputs) {
  const target = files.target(inputs.to)
  // Do not silently compile a smaller shared corpus after a descendant ACL is revoked.
  for (const uri of inputs.from) subtreeRevision(files.fs, uri)
  if (subtreeRevision(files.fs, target.uri) !== null) files.fs.storedEntries(target, 'write')
  files.skill(inputs.skill)
}

async function enqueueCompile(state: CompileState, files: CompileFiles, inputs: Inputs, name: string | null,
  key: string | null, intent: string | null, scheduled?: ScheduledAdmission) {
  const jobs = queue(state.ctx)
  verifyAdmission(state, files, inputs, scheduled)
  const refs = { from: inputs.from, to: inputs.to, skill: inputs.skill }
  const resource = inputs.from.join(', ')
  const scheduling = scheduled && { revision: scheduled.row.revision, slot: scheduled.slot }
  return jobs.enqueue('compile', resource.length <= 512 ? resource : (name ?? 'compile'),
    { v: 1, type: 'compile', inputs, name, requestKey: key, intent, ...(scheduling && { scheduling }) },
    { idempotencyKey: scheduled?.key ?? key ?? undefined,
      meta: { request: refs, ...(scheduled && { trigger: 'scheduled', scheduled_slot: slotIso(scheduled.slot,inputs.update_schedule?.timezone) }) },
      onAccepted: accepted => {
        if (scheduled) {
          verifyAdmission(state, files, inputs, scheduled)
          acceptSlot(state.sql, scheduled.row, scheduled.slot, scheduled.next)
        }
        state.reclaimHistory()
        state.accept(accepted, inputs, name, key, intent, scheduled?.slot)
      } })
}

/** Only the trusted account alarm invokes this. A null resolver result means revoked or mismatched. */
export async function runDueCompileSchedule(storage: DurableObjectStorage,
  resolve: (digest: string, identity: ScheduleIdentity) => Promise<WorkspaceContext | null>): Promise<void> {
  initCompileSchedules(storage.sql)
  const timestamp = Date.now()
  const row = peekDueCompileSchedule(storage.sql, timestamp)
  if (!row) return
  // Preserve the unclaimed slot if the alarm is interrupted while consulting current authority.
  await storage.transaction(tx => armEarlier(tx, Date.now() + 5000))
  const suspend = (reason: string, disable: boolean) => storage.transactionSync(() => {
    holdSchedule(storage.sql, row, reason, Date.now(), disable)
  })
  const identity = identityOf(row)
  let ctx: WorkspaceContext | null
  try {
    ctx = await resolve(row.credential, identity)
    if (!ctx || ctx.compileScheduleCredential !== row.credential || !ctx.reauthorize ||
        ctx.caller.accountId !== identity.accountId || ctx.caller.userId !== identity.userId || ctx.caller.agentId !== identity.agentId) {
      return suspend('COMPILE_CREDENTIAL_INVALID', true)
    }
    await ctx.reauthorize()
  } catch (error) {
    const revoked = error instanceof ApiError && (error.status === 401 || error.status === 403)
    return suspend(revoked ? 'COMPILE_CREDENTIAL_INVALID' : 'COMPILE_AUTH_RETRY', revoked)
  }
  const state = new CompileState(ctx), files = new CompileFiles(ctx)
  try {
    if (!currentCandidate(storage.sql, row)) return
    const saved = state.config(row.name)
    if (!saved || saved.signature !== row.revision) return suspend('COMPILE_SCHEDULE_INVALID', true)
    const input: Inputs = JSON.parse(saved.inputs)
    if (input.update_schedule?.timezone && !ctx.compileAdvancedSchedule) return suspend('COMPILE_SCHEDULE_MOUNT_REQUIRED',false)
    if (!input.auto_update || !input.update_schedule) return suspend('COMPILE_SCHEDULE_INVALID', true)
    const slot = dueSlot(input.update_schedule, timestamp), next = futureSlot(input.update_schedule, timestamp)
    if (slot < row.next_slot || row.last_slot !== null && slot <= row.last_slot) return suspend('COMPILE_SCHEDULE_INVALID', true)
    const key = 'schedule:' + await sha256(JSON.stringify([...state.actor, row.name, slot]))
    if (!currentCandidate(storage.sql, row)) return
    await enqueueCompile(state, files, input, row.name, null, null, { row, slot, next, key })
  } catch (error) {
    const denied = error instanceof ApiError && [401, 403, 404].includes(error.status)
    return suspend(denied ? 'COMPILE_SCHEDULE_ACCESS_DENIED' : 'COMPILE_SCHEDULE_RETRY', denied)
  }
}

async function submit(request: Request, state: CompileState, files: CompileFiles) {
  const ctx = state.ctx, body = await readJson(request, 24_576)
  if (body.skill === 'memory' && ctx.memoryCompile) {
    const supplied = request.headers.get('Idempotency-Key')
    return ok(await submitMemory(body,ctx,supplied===null?null:await sha256(submissionKey(supplied))),202)
  }
  const named = Object.hasOwn(body, 'compile_name')
  let name: string | null = null
  if (named) {
    onlyKeys(body, 'compile_name args')
    name = compileName(body.compile_name)
    if (body.args != null && !isRecord(body.args)) invalid('Named Compile args must be an object.')
    if (isRecord(body.args)) checkOwner(body.args.owner_user_id, ctx)
  }
  const inline = named ? null : parseInputs(body, ctx, 'execute')
  const supplied = request.headers.get('Idempotency-Key')
  const key = supplied === null ? null : await sha256(submissionKey(supplied))
  const intent = key === null ? null : await sha256(JSON.stringify(named ? { name } : inline))
  const prior = key === null ? undefined : state.submitted(key)
  if (prior) {
    if (intent !== prior.intent) conflict('Idempotency-Key refers to a different Compile submission.')
    // Recover a real task, never synthesize a pending/accepted response from run metadata.
    const task = ctx.jobs?.get(prior.task_id) ?? missing()
    return ok(task, 202)
  }
  queue(ctx)
  const inputs: Inputs = inline ?? JSON.parse((state.config(name!) ?? missing()).inputs)
  const task = await enqueueCompile(state, files, inputs, name, key, intent)
  const response = ok(task, 202)
  if (!named) response.headers.set('Deprecation', '@1794009600')
  return response
}

export async function routeCompile(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  const path = url.pathname, query = url.searchParams
  const state = new CompileState(ctx), files = new CompileFiles(ctx)
  switch (path) {
    case '/api/v1/compile/capabilities': {
      method(request, 'GET')
      const configured = !!ctx.generate && !!ctx.jobs
      return ok({ configured, can_create: configured, reason_code: configured ? null : 'NOT_CONFIGURED' })
    }
    case '/api/v1/compile/create': method(request, 'POST'); return save(request, state, files)
    case '/api/v1/compile/config/update': method(request, 'POST'); return save(request, state, files, true)
    case '/api/v1/compile': method(request, 'POST'); return submit(request, state, files)
    case '/api/v1/compile/config': {
      method(request, 'GET')
      const name = queryString(query, 'compile_name'), to = queryString(query, 'to')
      if (name !== undefined && to !== undefined) invalid('Use compile_name or to, not both.')
      const row = (to === undefined ? state.config(compileName(name)) : state.byTarget(targetPath(to, ctx).uri)) ?? missing()
      return ok({ ...configView(row, false, state.clock(row.name)), ...state.activity(row) })
    }
    case '/api/v1/compile/configs': {
      method(request, 'GET')
      const { limit, cursor } = paging(query)
      const { page, next } = state.configs(queryString(query, 'scope') ?? 'user', queryString(query, 'compile_name') ?? null, limit, cursor)
      const own = (row: typeof page[number]) => row.user_id === ctx.caller.userId && row.agent_id === ctx.caller.agentId
      const configs = page.map(row => ({ ...configView(row, !own(row), own(row) ? state.clock(row.name) : undefined), owner_user_id: row.user_id,
        executor_user_id: row.user_id, updated_by: own(row) ? row.updated_by : null }))
      // Additive aliases used by Studio at the pinned SHA; Python uses configs/compile_name.
      const targets = page.filter(own).map(row => ({ ...configView(row, false, state.clock(row.name)), ...state.activity(row) }))
      return ok({ configs, targets, next_cursor: next })
    }
    case '/api/v1/compile/runs': {
      method(request, 'GET')
      const { limit, cursor } = paging(query)
      return ok(state.history(compileName(queryString(query, 'compile_name')), limit, cursor))
    }
    case '/api/v1/compile/embeddings': {
      method(request, 'POST')
      const body = await readJson(request, 140_000)
      onlyKeys(body, 'target_uri texts expected_model')
      const path = files.path(str(body.target_uri, 'target_uri'))
      if (path.space === null || !['skill', 'resource'].includes(path.kind)) invalid('Expected a resource or Skill target.')
      files.ensureRead(path.uri)
      if (ctx.hasEmbedding === false) throw new ApiError(503, 'EMBEDDING_UNAVAILABLE', 'The Compile embedding provider is not configured.')
      const model = ctx.embeddingModel ?? embeddingModel
      if (body.expected_model != null && body.expected_model !== model) invalid('The Compile embedding model changed.')
      const texts = body.texts === undefined ? [] : body.texts
      if (!Array.isArray(texts) || texts.length > 32 || texts.some(text => !str(text, 'text', undefined, 4096).trim())) invalid('Expected up to 32 nonblank texts.')
      if (encoder.encode(JSON.stringify(texts)).length > 64_000) quota('Embedding input limit exceeded.')
      const vectors = texts.length ? await ctx.embed(texts as string[]) : []
      await ctx.reauthorize?.()
      files.ensureRead(path.uri)
      return ok({ model, vectors })
    }
    case '/api/v1/rules/compile': {
      method(request, 'POST')
      const input = ruleInputs(await readJson(request, 24_576), files), jobs = queue(ctx)
      const task = await jobs.enqueue('rule_compile', rulesRoot(ctx), { v: 1, type: 'rules', ...input },
        { meta: { request: { source_count: input.sources.length + input.uploads.length } } })
      return ok(task, 202)
    }
    case '/api/v1/rules/search': method(request, 'POST'); return ok(await searchRules(await readJson(request, 24_576), ctx))
  }
  const submission = /^\/api\/v1\/compile\/submissions\/([A-Za-z0-9%:._-]+)$/u.exec(path)
  if (submission) {
    method(request, 'GET')
    let key: string
    try { key = decodeURIComponent(submission[1]) } catch { return invalid('Invalid submission key.') }
    const record = state.submitted(await sha256(submissionKey(key))) ?? missing()
    return ok(ctx.jobs?.get(record.task_id) ?? missing())
  }
  const run = /^\/api\/v1\/compile\/runs\/([A-Za-z0-9_-]{1,128})(\/outputs)?$/u.exec(path)
  if (run) {
    method(request, 'GET')
    const name = compileName(queryString(query, 'compile_name'))
    const row = state.find(run[1])
    if (!row || row.config_name !== name) return missing()
    if (!run[2]) return ok(state.view(row))
    const { limit, cursor } = paging(query)
    return ok(state.outputs(files, row, limit, cursor))
  }
  return undefined
}

// Only the parent alarm calls this; taskId is injected from the claimed row, not the HTTP body.
export async function runCompile(payload: Record<string, unknown>, ctx: WorkspaceContext): Promise<unknown> {
  if (payload.v !== 1 || typeof payload.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(payload.taskId)) {
    return invalid('Invalid internal Compile task envelope.')
  }
  if (!ctx.assertActive || !ctx.finishJobInTransaction) {
    throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The Compile task lacks its transactional publication fence.')
  }
  if (payload.type === 'rules') {
    const { instruction, sources, uploads = [] } = payload
    if (!Array.isArray(sources) || !Array.isArray(uploads)) invalid('Invalid internal Rules task sources.')
    const inputs = ruleInputs({ instruction, sources: [...sources.map(resource_uri => ({ resource_uri })), ...uploads] }, new CompileFiles(ctx))
    return runRules(inputs, payload.taskId, ctx)
  }
  if (payload.type === 'memory') return runMemory(payload,ctx)
  if (payload.type !== 'compile' || !isRecord(payload.inputs)) return unsupported('Unknown Compile task envelope.')
  const { auto_update, update_schedule, ...raw } = payload.inputs
  if (typeof auto_update !== 'boolean') return invalid('Invalid internal Compile schedule.')
  // The stored parameters are frozen by admission, but revalidate URI/mount ownership under
  // the reconstructed caller; no untrusted actor information crosses the queue payload.
  const inputs = parseInputs({ ...raw, args: { ...(isRecord(raw.args) ? raw.args : {}), auto_update, update_schedule } }, ctx, 'create')
  const digest = (value: unknown) => value === null || typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
    ? value : invalid('Invalid internal Compile submission identity.')
  const name = payload.name === null ? null : compileName(payload.name)
  let slot: number | undefined
  if (payload.scheduling !== undefined) {
    if (!name || !inputs.auto_update || !ctx.compileScheduleCredential || !ctx.reauthorize || !isRecord(payload.scheduling)) {
      return invalid('Invalid scheduled Compile task envelope.')
    }
    const { revision, slot: planned } = payload.scheduling
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision) || typeof planned !== 'number' ||
        !Number.isSafeInteger(planned) || planned <= 0 || planned % 60_000) return invalid('Invalid Compile slot.')
    slot = planned
    const base = ctx, fs = new CompileFiles(base), active = base.assertActive!, reauthorize = base.reauthorize!
    const validate = () => {
      active()
      assertScheduledRun(base.sql, actorScope(base), name, revision, planned, base.compileScheduleCredential)
    }
    ctx = Object.assign(Object.create(base) as WorkspaceContext, {
      assertActive: validate,
      reauthorize: async () => { await reauthorize(); validate(); verifyScheduledAccess(fs, inputs) },
    })
    await ctx.reauthorize?.()
  }
  return runArtifacts({ taskId: payload.taskId, name, inputs, slot,
    requestKey: digest(payload.requestKey), intent: digest(payload.intent),
    createdAt: typeof payload.createdAt === 'number' && Number.isFinite(payload.createdAt) ? payload.createdAt : undefined }, ctx)
}
