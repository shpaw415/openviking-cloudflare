// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import { authenticate, authenticateApiKey, configuredPrincipals, controlFor, federatedAllows, hasCredentials, requireDataGrant, resolveDigest, resolveFederated, sameCaller, stripCredentialHeaders } from './auth.js'
import type { AuthGrant } from './auth.js'
import type { Caller, ControlCaller, Env, WorkspaceContext } from './context.js'
import { initEmbeddingBudget, reserveEmbeddingBudget } from './embedding-budget.js'
import { embed, embeddingModel } from './embeddings.js'
import { initFilesystem, routeFilesystem, runContentBatchJob } from './filesystem.js'
import { ApiError, apiError, isRecord, ok, readJson } from './http.js'
import { initSessions, routeSessions, runSessionCommit } from './sessions.js'
import { generation, generationModel, initGeneration, streamGeneration } from './generation.js'
import { auditRequest, initObservability, reportUsage, routeMetrics, routeObservability } from './observability.js'
import { initPolicies, routePolicies } from './policies.js'
import { routeBot } from './bot.js'
import { initBot } from './bot/store.js'
import { initEvolution, routeEvolution } from './bot/evolution.js'
import { initArchives, isWebDavPath, routeArchives, WEB_DAV_REQUEST_HEADERS } from './archives.js'
import { armCompileSchedule, compileExampleSkills, initCompile, routeCompile, runCompile, runDueCompileSchedule } from './compile.js'
import { initMcp, isMcpHttpPath, routeMcp } from './mcp.js'
import { oauthAllows, oauthFor, oauthRoute, oauthTokenDigest } from './oauth.js'
import { assertOidcActive } from './oidc.js'
import { assertJobRunning, claimJob, completeJob, finishJobInTransaction, initTasks, jobAccess, jobCounts, routeTasks, scheduleNextJob } from './tasks.js'
import { converter, initDocuments } from './documents.js'
import { routeStorageInspection } from './storage-inspection.js'
import { retrievalContext } from './session-search-context.js'
import { cancelGatewayStream, initGateway, isGatewayPath, routeGateway } from './gateway.js'
import type { JobKind } from './tasks.js'
import { claimWatch, identityForWatch, initWatches, prepareWatchRegistrar, remoteTextSource, revokeWatch, routeWatches, runRemoteImport, runWatch, scheduleWatch } from './watches.js'

export { Control } from './control.js'
export { OAuth } from './oauth.js'

const version = '0.1.0-alpha.1'
const upstream = '000f0765d7ec183886fbabbc22e69bc289cc429d'
const consumers: ReadonlyMap<JobKind, (payload: Record<string, unknown>, ctx: WorkspaceContext) => Promise<unknown>> = new Map([
  ['session_commit', runSessionCommit],
  ['compile', runCompile], ['rule_compile', runCompile],
  ['add_resource', runResourceJob], ['watch_sync',runWatch],
  ['content_batch_write',runContentBatchJob],
])
const availableJobs = new Set(consumers.keys())

async function runResourceJob(payload:Record<string, unknown>,ctx:WorkspaceContext) {
  if(!isRecord(payload.body)) return runRemoteImport(payload,ctx)
  const url=new URL('https://workspace.invalid/api/v1/resources')
  const response=await routeFilesystem(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload.body,wait:true})}),url,ctx)
  if(!response?.ok) throw new ApiError(409,'FAILED_PRECONDITION','The staged resource could not be published.')
  const value:unknown=await response.json()
  if(!isRecord(value)||value.status!=='ok') throw new ApiError(500,'INTERNAL_ERROR','Resource stage did not return its commit receipt.')
  return value.result
}
const csp = [
  "default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
  "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'",
  "font-src 'self' data:", "img-src 'self' data: blob:", "media-src 'self' blob:", "manifest-src 'self'",
  "worker-src 'self' blob:", "frame-src 'self' blob:",
].join('; ')

function isRead(request: Request): boolean {
  return request.method === 'GET' || request.method === 'HEAD'
}

function finish(request: Request, response: Response, id: string, isAsset = false): Response {
  const headers = new Headers(response.headers)
  if (!isAsset || response.status >= 400 || headers.get('content-type')?.includes('text/html')) {
    headers.set('Cache-Control', 'private, no-store')
  }
  if (/^attachment\b/i.test(headers.get('content-disposition') ?? '')) {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
  } else {
    headers.set('Content-Security-Policy', csp)
  }
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Request-ID', id)
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function workspace(env: Env, caller: Caller): DurableObjectStub<Workspace> {
  return env.WORKSPACES.getByName(`openviking:account:${caller.accountId}`)
}

async function ready(env: Env): Promise<Response> {
  let auth = 'not_configured'
  let filesystem = 'not_checked'
  try {
    const principals = configuredPrincipals(env)
    auth = 'ok'
    const candidate = principals.find(p => p.caller.role !== 'root')
    if (candidate) {
      const caller = requireDataGrant({ caller: candidate.caller, digest: '', managed: false })
      filesystem = await workspace(env, caller).probe(caller) ? 'ok' : 'unavailable'
    } else if (await controlFor(env)?.probe()) {
      filesystem = 'ok'
    } else {
      filesystem = 'unavailable'
    }
  } catch {
    if (auth === 'ok') filesystem = 'unavailable'
  }
  const healthy = auth === 'ok' && filesystem === 'ok'
  return Response.json({
    status: healthy ? 'ready' : 'not_ready',
    checks: {
      api_key_manager: auth,
      sqlite: filesystem,
      embedding: env.AI ? 'binding_present_not_probed' : 'not_configured',
    },
  }, { status: healthy ? 200 : 503 })
}

function capabilities(env: Env, caller: ControlCaller, readOnlyFederation=false): Response {
  const result={
    runtime: 'cloudflare-workers', upstream_commit: upstream, version, parity: 'partial',
    storage: 'durable-object-sqlite', unsupported_api_status: 501,
    embedding: { model: embeddingModel, binding_present: !!env.AI, probed: false },
    generation: { model: generationModel, configured: !!env.AI && env.OPENVIKING_EDGE_GENERATION === '1', probed: false },
    features: {
      control: !!env.CONTROL && caller.role !== 'user', packImport: caller.role !== 'root', packExport: caller.role !== 'root', searchProvenance: caller.role !== 'root',
      bot: caller.role !== 'root' && !!env.AI && env.OPENVIKING_EDGE_GENERATION === '1',
      compile: caller.role !== 'root' && !!env.AI && env.OPENVIKING_EDGE_GENERATION === '1',
      skills: caller.role !== 'root', snapshots: caller.role !== 'root', webdav: caller.role !== 'root',
      oauth: !!env.OAUTH && !!env.CONTROL && !!env.OPENVIKING_OAUTH_ISSUER && !!env.OPENVIKING_OAUTH_CLIENTS,
      watches: caller.role !== 'root' && !!remoteTextSource(env),
      privacyConfigs: caller.role !== 'root', tasks: caller.role !== 'root', audit: caller.role !== 'root' && env.OPENVIKING_EDGE_AUDIT !== '0',
      mcp: caller.role !== 'root' && ['read','read-write'].includes(env.OPENVIKING_EDGE_MCP ?? ''),
      documents: caller.role !== 'root' && !!env.AI && env.OPENVIKING_EDGE_DOCUMENT_CONVERSION === '1',
      gateway: caller.role !== 'root' && !!env.AI && env.OPENVIKING_EDGE_GENERATION === '1',
    },
  }
  if(readOnlyFederation) {
    // The health API keeps the historical auth_mode, but a restricted data
    // token must not make gated actions appear available in the UI.
    for(const flag of Object.keys(result.features) as (keyof typeof result.features)[]) result.features[flag]=false
    result.unsupported_api_status=403
    result.generation.configured=false
  }
  return ok(result)
}

async function delegated(request: Request, url: URL, env: Env, token: string): Promise<AuthGrant> {
  const grant = await oauthFor(env)?.resolveGrant(token)
  if (!grant) throw new ApiError(401, 'UNAUTHENTICATED', 'This OAuth grant is inactive or expired.')
  if (!oauthAllows(request,url,env,grant.scope)) throw new ApiError(403, 'PERMISSION_DENIED', 'This operation is outside the OAuth scope.')
  const authority = await resolveDigest(grant.keyDigest,env)
  if (!authority.managed) throw new ApiError(401, 'UNAUTHENTICATED', 'This grant is not tied to an active managed key.')
  requireDataGrant(authority)
  return { ...authority, oauth: token }
}

async function waitForTasks(request: Request, ctx: WorkspaceContext): Promise<Response> {
  const body = request.body ? await readJson(request, 1024) : {}
  const timeout = body.timeout ?? 15
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > 120) {
    throw new ApiError(400, 'INVALID_ARGUMENT', 'Invalid wait timeout.')
  }
  const deadline = Date.now() + Math.min(15_000, timeout * 1000)
  while (true) {
    const counts = jobCounts(ctx)
    if (!counts.pending && !counts.running && !counts.cancelling) {
      return ok({ durable_object: { processed: counts.completed, requeue_count: 0, error_count: counts.failed, errors: [] } })
    }
    if (Date.now() >= deadline) throw new ApiError(504, 'DEADLINE_EXCEEDED', 'Tasks are still active. Use the task status endpoints.')
    await new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now())))
  }
}

async function studio(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ASSETS) throw new ApiError(503, 'STUDIO_NOT_BUILT', 'Web Studio assets are not installed.')
  if (!isRead(request)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported.')
  if (url.pathname === '/studio') return new Response(null, { status: 308, headers: { Location: '/studio/' } })
  if (url.pathname.toLowerCase().endsWith('.map')) throw new ApiError(404, 'NOT_FOUND', 'Asset not found.')

  const fetchAsset = (pathname: string) => {
    const local = new URL(pathname, url.origin)
    return env.ASSETS!.fetch(local.toString(), { method: request.method })
  }
  if (url.pathname === '/studio/') return fetchAsset('/studio/index.html')
  const asset = await fetchAsset(url.pathname)
  if (asset.status !== 404 || url.pathname.startsWith('/studio/assets/') || /\.[^/]+$/.test(url.pathname) ||
      !request.headers.get('accept')?.includes('text/html')) return asset
  await asset.body?.cancel()
  return fetchAsset('/studio/index.html')
}

async function route(request: Request, url: URL, env: Env, id: string, execution?: ExecutionContext): Promise<Response> {
  const path = url.pathname
  if (path === '/' && isRead(request)) return new Response(null, { status: 307, headers: { Location: '/studio/' } })
  if (path === '/studio' || path.startsWith('/studio/')) return studio(request, url, env)
  const protocol = await oauthRoute(request, env)
  if (protocol) return protocol
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== url.origin) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Cross-origin requests are not accepted.')
  }
  if (path === '/health' && isRead(request)) {
    const caller = hasCredentials(request) ? (await authenticateApiKey(request, env)).caller : undefined
    return Response.json({
      status: 'ok', healthy: true, version, auth_mode: 'api_key',
      ...(caller && { account_id: caller.accountId, user_id: caller.userId, role: caller.role }),
    })
  }
  if (path === '/ready' && isRead(request)) return ready(env)
  if (!path.startsWith('/api/v1/') && path !== '/metrics' && !isMcpHttpPath(path) && !isGatewayPath(path) && !isWebDavPath(path) && !/^\/bot\/v1(?:\/|$)/.test(path)) {
    throw new ApiError(404, 'NOT_FOUND', 'Route not found.')
  }
  const token = await oauthTokenDigest(request)
  const grant = token ? await delegated(request,url,env,token) : await authenticate(request, env)
  if(grant.oidc&&!federatedAllows(request,path))throw new ApiError(403,'PERMISSION_DENIED','This operation requires an API key.')
  if (path === '/api/v1/system/edge-capabilities' && isRead(request)) return capabilities(env, grant.caller,!!grant.oidc)
  const gateway = isGatewayPath(path)
  if (gateway && ['x-openviking-upstream-url','x-openviking-upstream-key','x-openviking-gateway-management-key'].some(name => request.headers.has(name))) {
    throw new ApiError(403,'PERMISSION_DENIED','Client-supplied gateway egress settings are not accepted.')
  }
  const cleanRequest = stripCredentialHeaders(request,gateway ? ['x-openviking-context','x-openviking-session','x-openviking-actor-peer','content-encoding','upgrade']
    : isMcpHttpPath(path) ? ['mcp-protocol-version','mcp-session-id'] : isWebDavPath(path) ? WEB_DAV_REQUEST_HEADERS : [])
  if (path === '/api/v1/admin' || path.startsWith('/api/v1/admin/')) {
    const control = controlFor(env)
    if (!control) throw new ApiError(503, 'CONTROL_UNAVAILABLE', 'The control plane is not configured.')
    return control.dispatch(cleanRequest, grant.caller, configuredPrincipals(env).map(p => p.caller), grant.managed ? grant.digest : undefined)
  }
  if (grant.caller.role === 'root' && isRead(request) && (path === '/api/v1/system/status' || path === '/api/v1/debug/health')) {
    const initialized = await controlFor(env)?.probe() === true
    return ok(path.endsWith('/status') ? { initialized, user: grant.caller.userId } : { healthy: initialized, account_id: grant.caller.accountId })
  }
  const caller=requireDataGrant(grant)
  const target=workspace(env,caller)
  if(!gateway) return target.dispatch(cleanRequest,grant,id)
  // Hold the original event until we can forward a disconnect to the owning DO.
  // waitUntil called only *after* abort is too late if the event is already tearing down.
  let release!:()=>void
  const lifetime=new Promise<void>(resolve=>{release=resolve})
  if(execution)execution.waitUntil(lifetime)
  const force=setTimeout(release,46_000)
  const settle=()=>{clearTimeout(force);release()}
  let signalled=false
  const signal=()=>{
    if(signalled)return
    signalled=true
    void target.cancelGateway(id,{accountId:caller.accountId,userId:caller.userId,agentId:caller.agentId}).catch(()=>undefined).finally(settle)
  }
  const done=()=>{request.signal.removeEventListener('abort',signal);if(!signalled)settle()}
  const dispatched=target.dispatch(cleanRequest,grant,id)
  request.signal.addEventListener('abort',signal,{once:true})
  if(request.signal.aborted)signal()
  try {
    const response=await dispatched
    if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')) { done();return response }
    const reader=response.body.getReader()
    const stream=new ReadableStream<Uint8Array>({
      async pull(out){
        try{const part=await reader.read();if(part.done){done();out.close()}else out.enqueue(part.value)}
        catch(error){done();out.error(error)}
      },
      async cancel(reason){signal();done();try{await reader.cancel(reason)}catch{/* Peer already closed. */}}
    })
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers})
  } catch(error){done();throw error}
}

export default {
  async fetch(request: Request, env: Env, execution?: ExecutionContext): Promise<Response> {
    const id = crypto.randomUUID()
    try {
      const url = new URL(request.url)
      const asset = url.pathname.startsWith('/studio/')
      return finish(request, await route(request, url, env, id, execution), id, asset)
    } catch (error) {
      return finish(request, apiError(error, id), id)
    }
  },
} satisfies ExportedHandler<Env>

export class Workspace extends DurableObject<Env> {
  private initialized = false

  private initialize(context: WorkspaceContext): void {
    if (this.initialized) return
    context.storage.transactionSync(() => {
      initFilesystem(context)
      initSessions(context)
      initEmbeddingBudget(context.sql)
      initGeneration(context.sql)
      initTasks(context.sql)
      initPolicies(context)
      initObservability(context.sql)
      initBot(context)
      initEvolution(context.sql)
      initCompile(context)
      initWatches(context.sql)
      initArchives(context)
      initMcp(context)
      initDocuments(context.sql)
      initGateway(context)
    })
    this.initialized = true
  }

  private localContext(caller: Caller): WorkspaceContext {
    const storage = this.ctx.storage
    const context: WorkspaceContext = {
      sql: storage.sql,
      storage,
      caller,
      embed: texts => embed(this.env.AI, texts, count => reserveEmbeddingBudget(storage, caller.userId, count), count=>{
        try{reportUsage(context,{embedding:count})}catch{console.error('OpenViking Edge usage accounting unavailable')}
      }),
      hasEmbedding: !!this.env.AI,
      auditEnabled: this.env.OPENVIKING_EDGE_AUDIT !== '0',
      remoteText: remoteTextSource(this.env),
      compileExampleSkills: compileExampleSkills(),
      mcpMode: this.env.OPENVIKING_EDGE_MCP,
    }
    this.initialize(context)
    return context
  }

  private async workspaceContext(grant: AuthGrant, taskId?: string, request?: Request): Promise<WorkspaceContext> {
    const authority = requireDataGrant(grant)
    const caller: Caller = grant.oauth ? { ...authority,role:'user' } : authority
    const context = this.localContext(caller)
    const control = controlFor(this.env)
    const fixed = configuredPrincipals(this.env).filter(p => p.caller.accountId === caller.accountId && p.caller.role !== 'root')
    const directory = async () => {
      const [listed, groups] = await Promise.all([control?.principalsFor(caller.accountId, fixed.map(p=>p.caller)), control?.groupsFor(caller)])
      context.groups = groups ?? []
      context.aclPrincipals = { users: [...new Set([caller.userId, ...fixed.map(p => p.caller.userId), ...(listed?.users ?? [])])], groups: listed?.groups ?? [] }
    }
    context.reauthorize = async () => {
      if(grant.oidc) {
        const current=await resolveFederated(grant.oidc,this.env)
        if(!sameCaller(current,authority))throw new ApiError(403,'PERMISSION_DENIED','The federated identity changed.')
        await directory()
        assertOidcActive(grant.oidc)
        return
      }
      if (grant.oauth && !request) throw new ApiError(403,'PERMISSION_DENIED','A delegated grant cannot enqueue work.')
      const current = grant.oauth && request ? await delegated(request,new URL(request.url),this.env,grant.oauth) : await resolveDigest(grant.digest, this.env)
      if (!sameCaller(authority, current.caller) || current.managed !== grant.managed || current.digest !== grant.digest) {
        throw new ApiError(403, 'PERMISSION_DENIED', 'The credential no longer grants the original scope.')
      }
      await directory()
    }
    await context.reauthorize()
    if(grant.oidc)context.assertActive=()=>assertOidcActive(grant.oidc!)
    if(!grant.oidc&&!grant.oauth)context.sessionSearchContext=id=>retrievalContext(context,id)
    if (taskId) {
      context.assertActive = () => assertJobRunning(context.sql, taskId)
      context.taskId = taskId
      context.finishJobInTransaction = result => finishJobInTransaction(context.sql,taskId,result)
    }
    if (!grant.oauth&&!grant.oidc) {
      context.jobs = jobAccess(context, grant.digest, availableJobs)
      context.registerWatch = prepareWatchRegistrar(context,grant.digest)
      if (grant.managed) context.compileScheduleCredential = grant.digest
    }
    if (!grant.oauth && !grant.oidc && this.env.AI && this.env.OPENVIKING_EDGE_GENERATION === '1') {
      const invoke = generation(context, this.env.AI)
      context.generateStream = streamGeneration(context,this.env.AI)
      context.generate = async (messages, options) => {
        const result = await invoke(messages, options)
        try { reportUsage(context, {input:result.inputTokens,output:result.outputTokens}) }
        catch { console.error('OpenViking Edge usage accounting unavailable') }
        return result
      }
    }
    if (!grant.oauth && !grant.oidc && this.env.AI && this.env.OPENVIKING_EDGE_DOCUMENT_CONVERSION === '1') {
      context.convertDocument = converter(context,this.env.AI)
    }
    return context
  }

  probe(caller: Caller): boolean {
    const { sql } = this.localContext(caller)
    return sql.exec<{ available: number }>('SELECT 1 AS available').one().available === 1
  }

  cancelGateway(id:string,actor:Pick<Caller,'accountId'|'userId'|'agentId'>):void {
    if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))cancelGatewayStream(this.ctx.storage,id,actor)
  }

  async dispatch(request: Request, grant: AuthGrant, id: string): Promise<Response> {
    const start = Date.now()
    const url = new URL(request.url)
    let context: WorkspaceContext | undefined
    let response: Response
    let code: string | undefined
    try {
      context = await this.workspaceContext(grant, undefined, request)
      response = await this.dispatchScoped(request,url,context,id)
    } catch (error) {
      // Return expected API errors across the RPC boundary without losing their typed status.
      code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
      response = apiError(error, id)
    }
    if (context) {
      try { auditRequest(context,request,url.pathname,id,start,response.status,code) }
      catch { console.error('OpenViking Edge audit accounting unavailable',id) }
    }
    return response
  }

  private async dispatchScoped(request: Request, url: URL, context: WorkspaceContext, id: string): Promise<Response> {
    const caller = context.caller
    if(isGatewayPath(url.pathname))context.gatewayRequestId=id
    if (url.pathname === '/metrics') return routeMetrics(request,context)
    if (isRead(request) && url.pathname === '/api/v1/system/status') return ok({ initialized: true, user: caller.userId })
    if (isRead(request) && url.pathname === '/api/v1/debug/health') return ok({ healthy: this.probe(caller), account_id: caller.accountId })
    if (request.method === 'POST' && url.pathname === '/api/v1/system/wait') return waitForTasks(request,context)
    const response = await routeTasks(request,url,context) ?? await routeWatches(request,url,context) ?? routeObservability(request,url,context)
      ?? await routeStorageInspection(request,url,context) ?? await routePolicies(request,url,context) ?? routeEvolution(request,url,context)
      ?? await routeBot(request,url,context) ?? await routeCompile(request,url,context) ?? await routeMcp(request,url,context) ?? await routeGateway(request,url,context)
      ?? await routeArchives(request,url,context) ?? await routeSessions(request,url,context) ?? await routeFilesystem(request,url,context)
    if (response) return response
    throw new ApiError(501, 'NOT_IMPLEMENTED', 'This OpenViking operation has not been ported to Workers.')
  }

  async alarm(): Promise<void> {
    const storage = this.ctx.storage
    initTasks(storage.sql)
    initWatches(storage.sql)
    try {
      const watch = storage.transactionSync(() => claimWatch(storage.sql))
      if (watch) {
        // Re-arm the recurring clock before provider I/O, since alarms are not a reliable place to retry writes blindly.
        await scheduleWatch(storage)
        let authority:AuthGrant|undefined
        try {
          authority=await resolveDigest(watch.credential,this.env)
          if(!sameCaller(identityForWatch(watch),authority.caller)) authority=undefined
        } catch { authority=undefined }
        if(!authority) revokeWatch(storage.sql,watch)
        else {
          try { await runWatch({watch_id:watch.id,rev:watch.rev},await this.workspaceContext(authority)) }
          catch { /* runWatch persists a sanitized failure receipt after an admitted provider run. */ }
        }
      }
      await runDueCompileSchedule(storage,async(digest,identity)=>{
        let current:AuthGrant
        try { current=await resolveDigest(digest,this.env) } catch(error) {
          if(error instanceof ApiError&&(error.status===401||error.status===403))return null
          throw error
        }
        const caller=current.caller
        if(!current.managed||caller.role==='root'||caller.accountId!==identity.accountId||
          caller.userId!==identity.userId||caller.agentId!==identity.agentId)return null
        return this.workspaceContext(current)
      })
      const job = await claimJob(storage)
      if (!job) return
      let grant: AuthGrant
      try {
        grant = await resolveDigest(job.credential, this.env)
        if (!sameCaller(job.actor, grant.caller)) throw new Error('task identity no longer matches')
      } catch { completeJob(storage,job.taskId,null,'revoked'); return }
      const consumer = consumers.get(job.kind)
      if (!consumer) { completeJob(storage,job.taskId,null,'failed'); return }
      try {
        const context = await this.workspaceContext(grant, job.taskId)
        context.assertActive?.()
        const result = await consumer({...job.payload,taskId:job.taskId,createdAt:job.createdAt},context)
        completeJob(storage,job.taskId,result,'ok')
      } catch { completeJob(storage,job.taskId,null,'failed') }
    } finally { await scheduleNextJob(storage); await scheduleWatch(storage); await armCompileSchedule(storage) }
  }
}
