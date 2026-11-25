// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import { authenticate, authenticateApiKey, configuredPrincipals, controlFor, credentialDigest, dedicatedGatewayCredential, federatedAllows, gatewayCredentialPattern, hasCredentials, requireDataGrant, resolveDigest, resolveFederated, sameCaller, stripCredentialHeaders } from './auth.js'
import type { AuthGrant } from './auth.js'
import type { Caller, ControlCaller, Env, WorkspaceContext } from './context.js'
import { initEmbeddingBudget, reserveEmbeddingBudget } from './embedding-budget.js'
import { embed, initEmbeddingSelection, pinEmbedding, workspaceEmbedding } from './embeddings.js'
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
import { admitPermit, backupResponse, zipBuffer } from './archives/backup-authority.js'
import { captureBackup, restoreBackup } from './archives/backup-workspace.js'
import { assertInstanceServing, maintainStandbyAttachments, workspaceInstanceBackup } from './archives/instance-workspace.js'
import { instanceMode } from './archives/instance-authority.js'
import { armCompileSchedule, compileExampleSkills, initCompile, routeCompile, runCompile, runDueCompileSchedule } from './compile.js'
import { initMcp, isMcpHttpPath, routeMcp } from './mcp.js'
import { oauthAllows, oauthFor, oauthRoute, oauthTokenDigest } from './oauth.js'
import { assertOidcActive } from './oidc.js'
import { assertJobRunning, claimJob, completeJob, finishJobInTransaction, initTasks, jobAccess, jobCounts, routeTasks, scheduleNextJob } from './tasks.js'
import { converter, initDocuments } from './documents.js'
import { routeStorageInspection } from './storage-inspection.js'
import { retrievalContext } from './session-search-context.js'
import { cancelGatewayStream, initGateway, isDedicatedGatewayRoute, isGatewayPath, routeGateway } from './gateway.js'
import { invalidateGatewayCredentials, invalidateGatewayStreams } from './gateway/stream.js'
import { protectStreamText } from './gateway/sse-source.js'
import { richOperator } from './gateway/operator-rich.js'
import type { GatewayContext } from './gateway.js'
import { deleteKeyDigest, disabledKeys, invalidGatewayKey, keyByDigest, keyOwner } from './gateway/keys.js'
import type { KeyAuthority } from './gateway/keys.js'
import { GatewayError, digest, gatewayError, gatewayPath, within } from './gateway/contract.js'
import { assertCredentialRevision, assertModelRevision, credentialChanged, fenceModelRevision,
  initModelFence, modelAuthorityUnavailable, modelChanged } from './gateway/model-authority.js'
import { dataAuthorityChanged, dataAuthorityUnavailable, fenceDataAuthority, initDataAuthorityFence, mountDataAuthority, sameAuthority, storedAuthority } from './data-authority.js'
import type { AuthorityAdvance, AuthorityRevision } from './data-authority.js'
import { gatewayTransfersConfigured, initGatewayTransfers, readPrivateGatewayAttachment, routeGatewayTransfer, transferTicketHeader } from './gateway/transfers.js'
import { initGatewayAttachments, sweepGatewayAttachments } from './gateway/attachments.js'
import { bindModel, legacyEmbedding, selectedVlm } from './model-config.js'
import type { EmbeddingConfig, ModelSettings } from './model-config.js'
import { searchReranker } from './fs/rerank.js'
import type { JobKind } from './tasks.js'
import { claimWatch, identityForWatch, initWatches, prepareWatchRegistrar, remoteTextSource, revokeWatch, routeWatches, runWatch, scheduleWatch } from './watches.js'
import { boundUrlSource } from './url-source.js'
import { isOneShotUrlImport } from './fs/url-import.js'
import { webImportMode } from './fs/web-import.js'
import { boundWebSources } from './web/catalog.js'

export { Control } from './control.js'
export { OAuth } from './oauth.js'
export { BackupOperator } from './archives/backup-operator.js'
export { InstanceBackupOperator } from './archives/instance-operator.js'

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
  if (!isRecord(payload.body)) throw new ApiError(409, 'FAILED_PRECONDITION', 'The queued import must be submitted again.')
  if (isOneShotUrlImport(payload.body) || webImportMode(payload.body)) {
    const revision = storedAuthority(payload.dataAuthorityRevision)
    if (!revision) throw dataAuthorityChanged()
    await mountDataAuthority(ctx, revision)
  }
  const url=new URL('https://workspace.invalid/api/v1/resources')
  const response=await routeFilesystem(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload.body,wait:true})}),url,ctx)
  if(!response?.ok) throw new ApiError(409,'FAILED_PRECONDITION','The queued resource could not be published.')
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

function workspace(env: Env, caller: Pick<Caller, 'accountId'>): DurableObjectStub<Workspace> {
  return env.WORKSPACES.getByName(`openviking:account:${caller.accountId}`)
}

async function gatewayGrant(request: Request, path: string, raw: string, env: Env, id: string): Promise<AuthGrant> {
  if (!isDedicatedGatewayRoute(path, request.method)) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A valid API key is required for this route.')
  }
  if (!gatewayCredentialPattern.test(raw)) throw invalidGatewayKey()
  configuredPrincipals(env)
  const control = controlFor(env)
  if (!control || !env.AI) throw invalidGatewayKey()
  const digest = await credentialDigest(raw)
  let owner: KeyAuthority | null = null
  try {
    const accountId = await control.gatewayAccount(digest)
    if (accountId) owner = await workspace(env, { accountId }).gatewayOwner(accountId, digest)
  } catch {
    throw new GatewayError(503, 'authorization_unavailable', 'Could not verify the Gateway credential.', { request_id: id })
  }
  if (!owner) throw invalidGatewayKey()
  return { caller: { ...owner.caller, role: 'user' }, digest: owner.digest, managed: owner.managed, gatewayDigest: digest }
}

async function verifyKeyAuthority(owner: KeyAuthority, env: Env): Promise<void> {
  let current: AuthGrant
  try { current = await resolveDigest(owner.digest, env) }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    throw new GatewayError(401, 'openviking_key_invalid', 'The OpenViking credential behind this key is no longer active.')
  }
  if (!sameCaller(owner.caller, current.caller) || current.managed !== owner.managed) {
    throw new GatewayError(401, 'openviking_key_invalid', 'The OpenViking identity behind this key changed.')
  }
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
      filesystem = await workspace(env, caller).probe() ? 'ok' : 'unavailable'
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

async function capabilities(env: Env, grant: AuthGrant): Promise<Response> {
  const { caller } = grant
  const control = controlFor(env)
  const settings = await control?.modelSettings() ?? {}
  const vlm = selectedVlm(env, settings)
  const boundGeneration = vlm ? bindModel(env, vlm) : undefined
  const generationEnabled = !!boundGeneration
  const embeddingDefault = settings.embedding?.dense ?? legacyEmbedding
  const { role } = caller
  const embedding = role === 'root' ? embeddingDefault
    : await workspace(env, caller).embeddingSelection({ ...caller, role }, embeddingDefault)
  const embeddingMounted = !!bindModel(env, embedding)
  const webSources = (role === 'user' || role === 'admin') && !grant.oidc && !grant.oauth && !grant.gatewayDigest &&
    control && env.WORKSPACES && embeddingMounted ? boundWebSources(env, caller.accountId) : undefined
  const result={
    runtime: 'cloudflare-workers', upstream_commit: upstream, version, parity: 'partial',
    storage: 'durable-object-sqlite', unsupported_api_status: 501,
    embedding: { model: embedding.model, provider: embedding.provider, dimension: embedding.dimension, binding_present: embeddingMounted, probed: false },
    generation: { model: vlm?.model ?? generationModel, configured: generationEnabled, probed: false },
    features: {
      control: !!env.CONTROL && caller.role !== 'user', packImport: caller.role !== 'root', packExport: caller.role !== 'root', searchProvenance: caller.role !== 'root',
      bot: caller.role !== 'root' && generationEnabled,
      compile: caller.role !== 'root' && generationEnabled,
      skills: caller.role !== 'root', snapshots: caller.role !== 'root', webdav: caller.role !== 'root',
      oauth: !!env.OAUTH && !!env.CONTROL && !!env.OPENVIKING_OAUTH_ISSUER && !!env.OPENVIKING_OAUTH_CLIENTS,
      watches: caller.role !== 'root' && !!remoteTextSource(env),
      urlImport: (role === 'user' || role === 'admin') && !grant.oidc && !grant.oauth && !grant.gatewayDigest &&
        !!control && !!env.WORKSPACES && embeddingMounted && !!boundUrlSource(env),
      htmlImport: webSources?.has('html') === true,
      siteImport: webSources?.has('site') === true,
      gitDocsImport: webSources?.has('git') === true,
      privacyConfigs: caller.role !== 'root', tasks: caller.role !== 'root', audit: caller.role !== 'root' && env.OPENVIKING_EDGE_AUDIT !== '0',
      monitoring: role !== 'root' && !!env.WORKSPACES,
      mcp: caller.role !== 'root' && ['read','read-write'].includes(env.OPENVIKING_EDGE_MCP ?? ''),
      documents: caller.role !== 'root' && !!env.AI && env.OPENVIKING_EDGE_DOCUMENT_CONVERSION === '1',
      gateway: caller.role !== 'root' && generationEnabled,
      gatewayKeys: caller.role !== 'root' && !!env.CONTROL && boundGeneration?.kind === 'workers_ai',
    },
  }
  if(grant.oidc) {
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
  // Anonymous liveness is not readiness. No auth, consumer or data mount is
  // entered while the instance is in maintenance, including the standby prefix.
  if (!(path === '/health' && isRead(request) && !hasCredentials(request))) await assertInstanceServing(env)
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
  const dedicated = dedicatedGatewayCredential(request)
  const token = dedicated ? null : await oauthTokenDigest(request)
  let grant: AuthGrant
  if (dedicated) {
    try { grant = await gatewayGrant(request, path, dedicated, env, id) }
    catch (error) { if (error instanceof GatewayError) return gatewayError(error, id); throw error }
  } else grant = token ? await delegated(request,url,env,token) : await authenticate(request, env)
  if(grant.oidc&&!federatedAllows(request,path))throw new ApiError(403,'PERMISSION_DENIED','This operation requires an API key.')
  if (path === '/api/v1/system/edge-capabilities' && isRead(request)) return capabilities(env, grant)
  const gateway = isGatewayPath(path)
  const transfer = gateway && gatewayPath(path)?.kind === 'transfer'
  if (gateway && ['x-openviking-upstream-url','x-openviking-upstream-key','x-openviking-gateway-management-key'].some(name => request.headers.has(name))) {
    throw new ApiError(403,'PERMISSION_DENIED','Client-supplied gateway egress settings are not accepted.')
  }
  const cleanRequest = stripCredentialHeaders(request,transfer ? ['content-encoding', transferTicketHeader]
    : gateway ? ['x-openviking-context','x-openviking-session','x-openviking-actor-peer','content-encoding','upgrade']
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
  if(!gateway || transfer) return target.dispatch(cleanRequest,grant,id)
  if (!grant.gatewayDigest && !grant.oauth && !grant.oidc && env.CONTROL && env.AI &&
      (path === '/gateway/admin' || path.startsWith('/gateway/admin/'))) grant.gatewayKeysMounted = true
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
      initEmbeddingSelection(context.sql)
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
      initGatewayTransfers(context.sql)
      initGatewayAttachments(context.sql)
      initModelFence(context.sql)
      initDataAuthorityFence(context.sql)
    })
    this.initialized = true
  }

  private localContext(caller: Caller): GatewayContext {
    const storage = this.ctx.storage
    const context: WorkspaceContext = {
      sql: storage.sql,
      storage,
      caller,
      embed: async () => { throw new ApiError(503, 'EMBEDDING_UNAVAILABLE', 'No embedding context was admitted.') },
      auditEnabled: this.env.OPENVIKING_EDGE_AUDIT !== '0',
      remoteText: remoteTextSource(this.env),
      compileExampleSkills: compileExampleSkills(),
      mcpMode: this.env.OPENVIKING_EDGE_MCP,
    }
    this.initialize(context)
    return context
  }

  /** Private DO RPC used by the authenticated capability route, without any provider I/O. */
  async embeddingSelection(caller: Caller, configured: EmbeddingConfig): Promise<EmbeddingConfig> {
    await this.assertServing()
    return workspaceEmbedding(this.localContext(caller).sql, caller.accountId, configured)
  }

  /** Called only through the private binding after the public Worker resolves the locator. */
  async gatewayOwner(accountId: string, digest: string): Promise<KeyAuthority | null> {
    if (!this.isAccountWorkspace(accountId) || !/^[a-f0-9]{64}$/.test(digest)) return null
    await this.assertServing()
    const ctx = this.localContext({ accountId, userId: '', agentId: '', role: 'user' })
    const row = keyByDigest(ctx.sql, accountId, digest)
    return row ? keyOwner(row) : null
  }

  private isAccountWorkspace(accountId: string): boolean {
    return /^[A-Za-z0-9_-]{1,48}$/.test(accountId) &&
      this.ctx.id.toString() === this.env.WORKSPACES.idFromName(`openviking:account:${accountId}`).toString()
  }

  private assertServing(): Promise<void> { return assertInstanceServing(this.env, this.ctx.storage.sql) }

  instanceBackup(command: unknown, permit: unknown, archive?: unknown, seal?: unknown): Promise<Response> {
    return workspaceInstanceBackup(this.ctx.storage, this.env, this.ctx.id.toString(), command, permit, archive, seal)
  }

  /** Internal RPC only. Never call from the default HTTP/Data dispatcher. */
  captureBackup(rawPermit: unknown, options: unknown): Promise<Response> {
    return backupResponse(async () => {
      await this.assertServing()
      const { scope, permit } = await admitPermit(this.env, account => this.isAccountWorkspace(account), rawPermit, 'capture')
      return captureBackup(this.ctx.storage, this.env, scope, permit, options)
    })
  }

  /** Evaluation and apply use different internal permits. Neither one expands a Data grant. */
  restoreBackup(rawPermit: unknown, op: 'evaluate' | 'apply', archive: unknown, seal: unknown,
    options: unknown, approval?: unknown): Promise<Response> {
    return backupResponse(async () => {
      await this.assertServing()
      if (op !== 'evaluate' && op !== 'apply') throw new ApiError(403, 'PERMISSION_DENIED', 'Invalid backup operation.')
      const { scope, permit } = await admitPermit(this.env, account => this.isAccountWorkspace(account), rawPermit, op)
      return restoreBackup(this.ctx.storage, this.env, this.ctx.id.toString(), scope, permit,
        op === 'evaluate', zipBuffer(archive), seal, options, approval)
    })
  }

  /** Private Control → Workspace barrier. No network/provider await precedes
   * the fence, and SQLite and all productive boundaries share this actor. */
  async fenceGatewayModel(accountId: string, revision: number): Promise<number> {
    if (!this.isAccountWorkspace(accountId)) throw modelAuthorityUnavailable()
    await this.assertServing()
    const { sql, storage } = this.localContext({ accountId, userId: '', agentId: '', role: 'user' })
    storage.transactionSync(() => fenceModelRevision(sql, revision))
    invalidateGatewayStreams(storage, accountId, revision)
    await storage.sync()
    return revision
  }

  async fenceGatewayCredentials(accountId: string, advance: AuthorityAdvance): Promise<string> {
    if (!this.isAccountWorkspace(accountId)) throw dataAuthorityUnavailable()
    await this.assertServing()
    const { sql, storage } = this.localContext({ accountId, userId: '', agentId: '', role: 'user' })
    const receipt = storage.transactionSync(() => fenceDataAuthority(sql, advance))
    invalidateGatewayCredentials(storage, accountId, advance)
    await storage.sync()
    return receipt
  }

  private async workspaceContext(grant: AuthGrant, taskId?: string, request?: Request, sealsArchive = false): Promise<GatewayContext> {
    const authority = requireDataGrant(grant)
    const caller: Caller = grant.oauth ? { ...authority,role:'user' } : authority
    const context = this.localContext(caller)
    const control = controlFor(this.env)
    const fixed = configuredPrincipals(this.env).filter(p => p.caller.accountId === caller.accountId && p.caller.role !== 'root')
    const gatewayDigest = grant.gatewayDigest
    const ownedKey = gatewayDigest ? keyByDigest(context.sql, caller.accountId, gatewayDigest) : undefined
    const owner = ownedKey && keyOwner(ownedKey)
    const fixedCallers = fixed.map(item => requireDataGrant({ caller: item.caller, digest: '', managed: false }))
    let mount: { revision: number; credentialRevision: AuthorityRevision; settings: ModelSettings } | undefined
    const route = request && gatewayPath(new URL(request.url).pathname)
    const searchRequest = !grant.oauth && !grant.oidc && !gatewayDigest && !taskId && request?.method === 'POST' &&
      /^\/api\/v1\/search\/(?:find|search)\/?$/.test(new URL(request.url).pathname)
    const searchSettings = searchRequest ? await control?.modelSettings() : undefined
    const dataMount = !grant.oauth && !grant.oidc && !taskId && (route?.kind === 'model' || (route?.kind === 'admin' &&
      (route.parts.join('/') === 'access' || /^upstreams\/[A-Za-z0-9_-]{1,64}\/test$/.test(route.parts.join('/')))))
    const modelOwner = owner ?? (dataMount || searchSettings?.rerank ? { caller, digest: grant.digest, managed: grant.managed } : undefined)
    if (gatewayDigest && (!request || taskId || grant.oauth || grant.oidc || !owner || !control ||
        !isDedicatedGatewayRoute(new URL(request.url).pathname, request.method) ||
        !sameCaller(caller, { ...owner.caller, role: 'user' }) || owner.digest !== grant.digest || owner.managed !== grant.managed)) {
      throw invalidGatewayKey()
    }
    const directory = async (principal = caller) => {
      const [listed, groups] = await Promise.all([control?.principalsFor(caller.accountId, fixed.map(p=>p.caller)), control?.groupsFor(principal)])
      context.groups = groups ?? []
      context.aclPrincipals = { users: [...new Set([caller.userId, ...fixed.map(p => p.caller.userId), ...(listed?.users ?? [])])], groups: listed?.groups ?? [] }
    }
    const keyStillActive = () => {
      if (gatewayDigest && !keyByDigest(context.sql, caller.accountId, gatewayDigest)) throw invalidGatewayKey()
    }
    const stillMounted = () => {
      keyStillActive()
      if (!mount) throw modelAuthorityUnavailable()
      assertCredentialRevision(context.sql, caller.userId, mount.credentialRevision)
      assertModelRevision(context.sql, mount.revision)
    }
    context.reauthorize = async () => {
      if (modelOwner && control) {
        if (mount) stillMounted()
        else keyStillActive()
        let current
        try {
          if (!modelOwner.managed) await within(4_000, () => verifyKeyAuthority(modelOwner, this.env), modelAuthorityUnavailable)
          current = await within(4_000, () => gatewayDigest
            ? control.gatewayModelGrant(gatewayDigest, modelOwner, fixedCallers, mount?.revision)
            : control.gatewayDataGrant(modelOwner, fixedCallers, mount?.revision), modelAuthorityUnavailable)
        }
        catch (error) {
          if (ownedKey && error instanceof GatewayError && error.code === 'openviking_key_invalid') deleteKeyDigest(context.sql, caller.accountId, ownedKey.digest)
          throw error instanceof GatewayError ? error : modelAuthorityUnavailable()
        }
        if (current.status === 'expired') {
          if (ownedKey) deleteKeyDigest(context.sql, caller.accountId, ownedKey.digest)
          throw credentialChanged()
        }
        if (current.status === 'authority_changed') throw credentialChanged()
        if (current.status !== 'ok' || (mount && current.revision !== mount.revision)) throw modelChanged()
        assertCredentialRevision(context.sql, caller.userId, current.credentialRevision)
        if (mount && !sameAuthority(current.credentialRevision, mount.credentialRevision)) throw credentialChanged()
        assertModelRevision(context.sql, current.revision)
        keyStillActive()
        mount ??= current
        context.aclPrincipals = current.principals
        context.groups = current.groups
        return
      }
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
    if (mount) {
      stillMounted()
      context.gatewayModelRevision = mount.revision
      context.gatewayCredentialRevision = mount.credentialRevision
      context.assertGatewayMount = stillMounted
      context.assertActive = stillMounted
    }
    if (ownedKey) {
      context.gatewayKey = ownedKey
      delete context.remoteText
    }
    if(grant.oidc)context.assertActive=()=>assertOidcActive(grant.oidc!)
    if(!grant.oidc&&!grant.oauth&&!ownedKey)context.sessionSearchContext=id=>retrievalContext(context,id)
    if (taskId) {
      context.assertActive = () => assertJobRunning(context.sql, taskId)
      context.taskId = taskId
      context.finishJobInTransaction = result => finishJobInTransaction(context.sql,taskId,result)
    }
    if (!grant.oauth&&!grant.oidc&&!ownedKey) {
      context.jobs = jobAccess(context, grant.digest, availableJobs)
      context.registerWatch = prepareWatchRegistrar(context,grant.digest)
      context.urlSource = boundUrlSource(this.env)
      if (grant.managed) context.compileScheduleCredential = grant.digest
    }
    if (control && !grant.oauth && !grant.oidc && !gatewayDigest && this.isAccountWorkspace(caller.accountId)) {
      context.webSources = boundWebSources(this.env, caller.accountId)
      const dataOwner = { caller, digest: grant.digest, managed: grant.managed }
      context.loadDataAuthority = async expected => {
        try {
          if (!grant.managed) await within(4_000, () => verifyKeyAuthority(dataOwner, this.env), modelAuthorityUnavailable)
          return await within(4_000, () => control.dataAuthorityGrant(dataOwner, fixedCallers, expected), modelAuthorityUnavailable)
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw dataAuthorityChanged()
          throw dataAuthorityUnavailable()
        }
      }
    }
    let archiveSettings: ModelSettings | undefined
    if (control && !grant.oauth && !grant.oidc && !gatewayDigest && this.isAccountWorkspace(caller.accountId) && (
      sealsArchive || request?.method === 'POST' && /^\/api\/v1\/sessions\/[^/]+\/commit\/?$/.test(new URL(request.url).pathname))) {
      const snapshot = await within(4_000, () => control.gatewayDataGrant({ caller, digest: grant.digest, managed: grant.managed },
        fixedCallers), modelAuthorityUnavailable)
      if (snapshot.status === 'expired' || snapshot.status === 'authority_changed') throw credentialChanged()
      if (snapshot.status !== 'ok') throw new ApiError(409, 'CONFLICT', 'The archive policy changed; submit a new commit.')
      const { revision, credentialRevision } = snapshot
      const check = () => {
        assertCredentialRevision(context.sql, caller.userId, credentialRevision)
        try { assertModelRevision(context.sql, revision) }
        catch (error) {
          if (error instanceof GatewayError && error.code === 'gateway_configuration_changed') {
            throw new ApiError(409, 'CONFLICT', 'The archive policy changed; submit a new commit.')
          }
          throw error
        }
      }
      check()
      context.assertArchiveSettingsCurrent = check
      archiveSettings = snapshot.settings
    }
    const settings = mount?.settings ?? archiveSettings ?? searchSettings ?? await control?.modelSettings() ?? {}
    const embedding = workspaceEmbedding(context.sql, caller.accountId, settings.embedding?.dense ?? legacyEmbedding)
    const configuredEmbeddingBinding = bindModel(this.env, embedding)
    const embeddingBinding = ownedKey && configuredEmbeddingBinding?.kind !== 'workers_ai' ? undefined : configuredEmbeddingBinding
    context.embeddingModel = embedding.model
    context.hasEmbedding = !!embeddingBinding
    context.defaultSearchLimit = settings.default_search_limit
    context.defaultSearchScore = settings.default_search_score_threshold
    context.useSearchSessionContext = settings.retrieval?.enable_intent
    context.retrievalSettings = settings.retrieval
    context.memorySettings = settings.memory
    if (searchRequest && mount && settings.rerank) context.searchReranker = searchReranker(context, this.env, settings.rerank)
    context.embed = async texts => {
      if (embeddingBinding?.kind === 'openai') await context.reauthorize?.()
      context.assertActive?.()
      let usage: number | undefined
      const vectors = await embed(embeddingBinding, embedding, texts,
        count => reserveEmbeddingBudget(context.storage, caller.userId, count), count => { usage = count }, async () => {
          await context.reauthorize?.()
          context.assertActive?.()
        })
      await context.reauthorize?.()
      context.assertActive?.()
      pinEmbedding(context.sql, embedding)
      if (usage !== undefined) {
        try { reportUsage(context, { embedding: usage }) }
        catch { console.error('OpenViking Edge usage accounting unavailable') }
      }
      return vectors
    }
    const vlm = selectedVlm(this.env, settings)
    const binding = vlm ? bindModel(this.env, vlm) : undefined
    if (ownedKey && binding?.kind !== 'workers_ai') throw disabledKeys()
    if (grant.gatewayKeysMounted && control && binding?.kind === 'workers_ai' && !grant.oidc && !grant.oauth && !ownedKey) {
      const env = this.env
      context.gatewayKeyAdmin = {
        issuer: { caller, digest: grant.digest, managed: grant.managed },
        async resolve(raw) {
          let resolved: AuthGrant
          try { resolved = await resolveDigest(await credentialDigest(raw), env) }
          catch (error) {
            if (error instanceof ApiError && error.status === 401) throw new GatewayError(401, 'openviking_http_401', 'The supplied OpenViking credential was not accepted.')
            throw error
          }
          if (resolved.caller.role === 'root') throw new GatewayError(403, 'root_key_not_allowed', 'Root cannot back a Gateway key.')
          return { ...resolved, caller: requireDataGrant(resolved) }
        },
        verify: owner => verifyKeyAuthority(owner, env),
        register: async (owner, digest, live) => {
          const issuer = { caller, digest: grant.digest, managed: grant.managed }
          if (!await control.registerGatewayDigest(issuer, owner, fixedCallers, digest, live)) {
            throw new GatewayError(403, 'forbidden', 'Gateway key issuance is no longer authorized.')
          }
        },
      }
    }
    if (!grant.oauth && !grant.oidc && vlm && binding) {
      const invoke = generation(context, binding, vlm)
      context.generate = async (messages, options) => {
        const result = await invoke(messages, options)
        if (mount || context.dataAuthority) { await context.reauthorize?.(); context.assertActive?.() }
        try { reportUsage(context, {input:result.inputTokens,output:result.outputTokens}) }
        catch { console.error('OpenViking Edge usage accounting unavailable') }
        return result
      }
      if (binding.kind === 'workers_ai') {
        context.workersAIModel = vlm.model
        context.generateStream = streamGeneration(context, binding, vlm)
      } else {
        context.externalGeneration = true
        const generate = context.generate
        const stream = this.env.OPENVIKING_EDGE_OPERATOR_STREAMING === '1' && control && context.assertGatewayMount
          ? streamGeneration(context, binding, vlm) : undefined
        const rich = !ownedKey && control && context.assertGatewayMount && route?.kind === 'model'
          ? richOperator(context, binding, vlm, this.env.OPENVIKING_EDGE_GATEWAY_CAPABILITIES, !!stream) : undefined
        if (rich && context.loadDataAuthority && gatewayTransfersConfigured(this.env)) {
          context.readPrivateGatewayAttachment = id => readPrivateGatewayAttachment(this.env, context, id)
        }
        const check = (model: string) => { if (model !== vlm.model) throw modelChanged() }
        context.gatewayProvider = {
          models: [vlm.model],
          responseScope: route?.kind === 'model' && (route.endpoint === 'responses' || route.endpoint.startsWith('responses/'))
            ? await digest(binding.base) : undefined,
          async generate(model, messages, options) { check(model); return generate(messages, options) },
          ...(rich && { rich }),
          ...(stream && {
            async generateStream(model, messages, options) { check(model); return stream(messages, options) },
            streamTextFilter: () => protectStreamText(binding.key),
          }),
        }
      }
    }
    if (!grant.oauth && !grant.oidc && !ownedKey && this.env.AI && this.env.OPENVIKING_EDGE_DOCUMENT_CONVERSION === '1') {
      context.convertDocument = converter(context,this.env.AI)
    }
    return context
  }

  async probe(): Promise<boolean> {
    await this.assertServing()
    // Liveness of SQLite is not permission to initialize a cold restore target.
    const { sql } = this.ctx.storage
    return sql.exec<{ available: number }>('SELECT 1 AS available').one().available === 1
  }

  async cancelGateway(id:string,actor:Pick<Caller,'accountId'|'userId'|'agentId'>):Promise<void> {
    await this.assertServing()
    if(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))cancelGatewayStream(this.ctx.storage,id,actor)
  }

  async dispatch(request: Request, grant: AuthGrant, id: string): Promise<Response> {
    const start = Date.now()
    const url = new URL(request.url)
    let context: GatewayContext | undefined
    let response: Response
    let code: string | undefined
    try {
      await this.assertServing()
      const route = gatewayPath(url.pathname)
      if (route?.kind === 'transfer' && (grant.gatewayDigest || grant.oauth || grant.oidc)) {
        throw new ApiError(403, 'PERMISSION_DENIED', 'Transfers require a direct tenant API key.')
      }
      context = await this.workspaceContext(grant, undefined, request)
      if (route?.kind === 'transfer') {
        response = await routeGatewayTransfer(request, url, route.operation, this.env, context, grant)
      } else if (grant.gatewayDigest) {
        if (!isDedicatedGatewayRoute(url.pathname, request.method)) throw invalidGatewayKey()
        context.gatewayRequestId = id
        response = (await routeGateway(request, url, context)) ?? gatewayError(invalidGatewayKey(), id)
      } else response = await this.dispatchScoped(request,url,context,id)
      if (response.ok && (context.assertGatewayMount || context.dataAuthority)) {
        // Last local boundary before the DO hands the response to the Worker.
        try { context.assertGatewayMount?.(); context.dataAuthority?.assertCurrent() }
        catch (error) { void response.body?.cancel().catch(() => {}); throw error }
      }
    } catch (error) {
      // Return expected API errors across the RPC boundary without losing their typed status.
      code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR'
      response = isGatewayPath(url.pathname) && error instanceof GatewayError ? gatewayError(error, id) : apiError(error, id)
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
    if (isRead(request) && url.pathname === '/api/v1/debug/health') return ok({ healthy: await this.probe(), account_id: caller.accountId })
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
    try { await this.assertServing() }
    catch (error) {
      if (!(error instanceof ApiError && error.code === 'INSTANCE_MAINTENANCE')) throw error
      // Defer a pre-existing source alarm; never run a consumer in maintenance.
      if (instanceMode(this.env)?.mode === 'source') await storage.setAlarm(Date.now() + 60_000)
      else await maintainStandbyAttachments(storage)
      return
    }
    initTasks(storage.sql)
    initWatches(storage.sql)
    try {
      await sweepGatewayAttachments(storage)
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
        const sealsArchive = job.kind === 'session_commit' && (job.payload.op === 'commit' || job.payload.op === 'auto')
        const context = await this.workspaceContext(grant, job.taskId, undefined, sealsArchive)
        context.assertActive?.()
        const result = await consumer({...job.payload,taskId:job.taskId,createdAt:job.createdAt},context)
        // One-shot URL imports finalize content, reservation and the success
        // receipt in the same protected transaction. Never supply a fallback success.
        if (context.dataAuthority) completeJob(storage,job.taskId,null,'failed')
        else completeJob(storage,job.taskId,result,'ok')
      } catch { completeJob(storage,job.taskId,null,'failed') }
    } finally { await scheduleNextJob(storage); await scheduleWatch(storage); await armCompileSchedule(storage) }
  }
}
