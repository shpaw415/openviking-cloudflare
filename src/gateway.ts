// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { GatewayError, body, bytes, digest, fields, forbidden, gatewayError, gatewayPath, invalid, invalidConfig, json, methodError,
  missing, modelId, objectId, safeError, unconfigured, unsupported } from './gateway/contract.js'
import { publishTurn } from './gateway/capture.js'
import { disabledKeys, inspectKey, invalidGatewayKey, issueKey, keySpec, listKeys, resetKeyCapture, revokeKey } from './gateway/keys.js'
import { parseProfile, resolveProfile } from './gateway/profiles.js'
import { countTokens, generate, generationConfigured, isBound, listModels, parseUpstream, resolveTarget, routedModel, streamSource,
  viewUpstream } from './gateway/providers.js'
import type { GatewayContext } from './gateway/providers.js'
import { augment, recallNote } from './gateway/recall.js'
import { checkResponseQuota, forgetResponse, inspectResponse, responseId, responseProvenance, resume, retainResponse, routeIdentity } from './gateway/responses.js'
import { checkConversationLimit, conversation, deleteUserState, enter, epoch, initStore, logs, overview, profileFor,
  profileList, remove, reserve, resetConversation, save, upstreamList, writeLog } from './gateway/store.js'
import type { Metrics } from './gateway/store.js'
import { checkStreamAdmission, invalidateGatewayRouting, streamTurn } from './gateway/stream.js'
import { modelEndpoint, normalizeTurn, protocolFor, render } from './gateway/wire.js'

export type { GatewayContext, GatewayProvider } from './gateway/providers.js'
export type { GatewayStreamActor } from './gateway/stream.js'
export { cancelGatewayStream } from './gateway/stream.js'
export const gatewayVersion = '0.2.0'
export const isGatewayPath = (path: string) => gatewayPath(path) !== undefined
export function isDedicatedGatewayRoute(path: string, method: string): boolean {
  const route = gatewayPath(path)
  if (route?.kind !== 'model') return false
  const endpoint = route.endpoint
  if (endpoint === 'models') return method === 'GET' || method === 'HEAD'
  if (endpoint.startsWith('responses/') && responseId(endpoint.slice('responses/'.length))) return ['GET', 'HEAD', 'DELETE'].includes(method)
  return method === 'POST' && modelEndpoint(endpoint) !== undefined
}
export const initGateway = (ctx: WorkspaceContext) => initStore(ctx)

const modelBodyLimit = 304 * 1024 // Allow JSON escapes for 48 KiB of decoded text.
const adminBodyLimit = 16 * 1024
const deniedEgressHeaders = ['x-openviking-upstream-url', 'x-openviking-upstream-key', 'x-openviking-gateway-management-key']
const requireMethod = (method: string, ...allowed: string[]) => { if (!allowed.includes(method)) throw methodError() }
const requireAdmin = (ctx: WorkspaceContext) => { if (ctx.caller.role !== 'admin') throw forbidden() }

function queryScope(url: URL, allowed: string[] = []): void {
  const seen = new Set<string>()
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw invalid('Unknown or repeated Gateway query field.')
    seen.add(key)
  }
}

function configGuard(ctx: GatewayContext, revision: number): () => void {
  return () => {
    if (epoch(ctx) !== revision) throw new GatewayError(409, 'gateway_configuration_changed', 'The Gateway configuration changed during this request; try again.')
  }
}

async function manage(request: Request, url: URL, parts: string[], ctx: GatewayContext): Promise<Response> {
  const [section, id, action, ...tail] = parts
  const method = request.method === 'HEAD' ? 'GET' : request.method
  queryScope(url, ['account_id', ...(section === 'logs' && parts.length === 1 ? ['limit'] : [])])
  if (url.searchParams.has('account_id') && url.searchParams.get('account_id') !== ctx.caller.accountId) {
    throw new GatewayError(403, 'other_account', 'Gateway management is limited to the authenticated account.')
  }
  const available = generationConfigured(ctx)
  const keyAdmin = ctx.gatewayKeyAdmin
  if (parts.length === 1) {
    switch (section) {
      case 'access':
        requireMethod(method, 'GET')
        return json({ managed: false, can_write_objects: ctx.caller.role === 'admin', can_import_vlm: false,
          can_issue_for_others: !!keyAdmin && ctx.caller.role === 'admin', role: ctx.caller.role, account_id: ctx.caller.accountId, user_id: ctx.caller.userId,
          warnings: available ? [] : ['generation_unavailable'],
          edge: { version: gatewayVersion, generation_configured: available, dedicated_gateway_keys: !!keyAdmin, tools: false,
             streaming: upstreamList(ctx).some(rule => rule.enabled && rule.models.some(model => !!streamSource(ctx, { rule, model }))),
            capture: true, recall: ctx.hasEmbedding !== false, logs: ctx.auditEnabled !== false } })
      case 'guides':
        requireMethod(method, 'GET')
        return json({ base_url: `${url.origin}/gateway`, public_url_configured: false })
      case 'logs': {
        requireMethod(method, 'GET')
        const raw = url.searchParams.get('limit') ?? '200'
        if (!/^-?\d{1,7}$/.test(raw)) throw invalid('limit must be an integer.')
        return json(logs(ctx, Math.max(1, Math.min(Number(raw), 1000))))
      }
      case 'overview':
        requireMethod(method, 'GET')
        return json(overview(ctx, available))
      case 'tools':
        requireMethod(method, 'GET')
        throw unsupported('Gateway tools are not available.', 'tools_unsupported')
      case 'keys':
        requireMethod(method, 'GET', 'POST')
        if (!keyAdmin) throw disabledKeys()
        if (method === 'GET') return json(listKeys(ctx))
        return json(await issueKey(ctx, keyAdmin, await body(request, adminBodyLimit), spec => {
          if (!profileList(ctx).some(profile => profile.id === spec.policy_id)) throw invalid('Unknown context profile.', 'unknown_policy')
          const routes = upstreamList(ctx).filter(rule => rule.binding === 'workers_ai' && spec.upstream_ids.includes(rule.id))
          if (routes.length !== spec.upstream_ids.length) throw invalid('Unknown or unsupported upstream.', 'unknown_upstream')
          const models = listModels(ctx, routes)
          if (!models.length || spec.models.some(model => !models.includes(model))) throw invalid('The selected upstreams must serve the requested models.', 'model_not_allowed')
        }))
      case 'policies':
        requireMethod(method, 'GET')
        return json(profileList(ctx))
      case 'upstreams':
        requireMethod(method, 'GET')
        return json(upstreamList(ctx).map(rule => ({ ...viewUpstream(ctx, rule),
          ...(keyAdmin && rule.binding === 'workers_ai' && { routable_models: listModels(ctx, [rule]) }) })))
    }
  }
  if (section === 'account' && id === 'data' && parts.length === 2) throw forbidden()
  if (section === 'users' && action === 'data' && parts.length === 3) {
    requireMethod(method, 'DELETE')
    requireAdmin(ctx)
    const user = objectId(id)
    await ctx.reauthorize?.()
    deleteUserState(ctx, user)
    return json({ deleted: true })
  }
  if (section === 'keys') {
    if (parts.length === 2) requireMethod(method, 'GET', 'DELETE')
    else if (parts.length === 4 && action === 'capture' && tail[0] === 'reset') requireMethod(method, 'POST')
    else throw missing()
    const keyId = objectId(id)
    if (!keyAdmin) throw disabledKeys()
    if (parts.length === 4) return json(await resetKeyCapture(ctx, keyAdmin, keyId, await body(request, adminBodyLimit),
      (caller, protocol, label, hash) => resetConversation(ctx, caller, protocol, label, hash)))
    await ctx.reauthorize?.()
    return json(method === 'GET' ? inspectKey(ctx, keyId) : revokeKey(ctx, keyId))
  }
  if (section !== 'policies' && section !== 'upstreams' || parts.length < 2) throw missing()
  const identifier = objectId(id)
  if (section === 'upstreams' && identifier === 'import-vlm' && parts.length === 2) {
    requireMethod(method, 'POST')
    throw unsupported('The Edge Gateway uses operator bindings, not server VLM settings.', 'vlm_import_unavailable')
  }
  if (section === 'upstreams' && action === 'test' && parts.length === 3) {
    requireMethod(method, 'POST')
    requireAdmin(ctx)
    const parsed = await body(request, adminBodyLimit)
    fields(parsed, ['model'], invalidConfig)
    const rule = upstreamList(ctx).find(item => item.id === identifier)
    if (!rule) throw missing()
    if (!isBound(ctx, rule.binding)) throw unconfigured()
    if (parsed.model === undefined) throw unsupported('This binding has no connection-only probe. Specify a model for a bounded generation test.', 'connection_test_unavailable')
    if (!modelId(parsed.model)) throw invalidConfig('Invalid model identifier.')
    const model = routedModel(ctx, rule, parsed.model)
    if (!model) throw new GatewayError(404, 'no_matching_upstream', 'This model is not allowlisted on the selected binding.')
    if (!rule.enabled) throw new GatewayError(409, 'upstream_disabled', 'Enable this route before testing it.')
    const admission = enter(ctx, null), configStillCurrent = configGuard(ctx, epoch(ctx))
    try {
      const guard = () => { admission.guard(); configStillCurrent() }
      await ctx.reauthorize?.()
      guard()
      reserve(ctx, 256)
      await generate(ctx, { rule, model }, [{ role: 'user', content: 'Reply with the single word ready.' }], 16, guard)
      return json({ ok: true, kind: 'model', status: 200, reason: 'passed', url: viewUpstream(ctx, rule).base_url })
    } finally { admission.done() }
  }
  if (parts.length !== 2) throw missing()
  requireMethod(method, 'GET', 'PUT', 'DELETE')
  const policy = section === 'policies'
  if (method === 'GET') {
    const item = policy ? profileList(ctx).find(row => row.id === identifier) : upstreamList(ctx).find(row => row.id === identifier)
    if (!item) throw missing()
    return json('binding' in item ? viewUpstream(ctx, item) : item)
  }
  requireAdmin(ctx)
  if (method === 'DELETE') {
    await ctx.reauthorize?.()
    remove(ctx, policy ? 'policy' : 'upstream', identifier)
    invalidateGatewayRouting(ctx.storage, ctx.caller.accountId)
    return json({ deleted: true })
  }
  const parsed = await body(request, adminBodyLimit)
  await ctx.reauthorize?.()
  const updated = policy ? save(ctx, 'policy', identifier, parseProfile(parsed)) :
    viewUpstream(ctx, save(ctx, 'upstream', identifier, parseUpstream(ctx, parsed)))
  invalidateGatewayRouting(ctx.storage, ctx.caller.accountId)
  return json(updated)
}

async function modelRoute(request: Request, endpoint: string, ctx: GatewayContext, metrics: Metrics,
  deferLog: () => void, recordLog: () => void): Promise<Response> {
  const requestHeaders = { 'x-openviking-request-id': metrics.request_id }
  const binding = ctx.gatewayKey && keySpec(ctx.gatewayKey)
  const upstreams = () => upstreamList(ctx).filter(rule => !binding || (rule.binding === 'workers_ai' && binding.upstream_ids.includes(rule.id)))
  const allowedModel = (model: string) => !binding?.models.length || binding.models.includes(model)
  const currentProfile = () => {
    const saved = binding ? profileList(ctx).find(item => item.id === binding.policy_id) : profileFor(ctx)
    if (!saved) throw new GatewayError(403, 'policy_unavailable', 'The bound Gateway profile is not available.')
    const { id, revision, ...profile } = saved
    const { policy, keys } = resolveProfile(profile, request.headers.get('x-openviking-context'))
    return { policy, keys, provenance: responseProvenance(id, revision, policy, ctx.gatewayKey?.digest) }
  }
  const checkStoredRoute = binding ? (name: unknown, route: string) => {
    if (modelId(name) && allowedModel(name)) {
      try { if (routeIdentity(resolveTarget(ctx, upstreams(), 'responses', name)) === route) return }
      catch { /* A retained object never widens the key's current routing scope. */ }
    }
    throw new GatewayError(403, 'response_upstream_disallowed', 'The retained response is outside this key’s current routing scope.')
  } : undefined
  if (endpoint === 'models') {
    requireMethod(request.method, 'GET', 'HEAD')
    if (!generationConfigured(ctx)) throw unconfigured()
    if (binding) { await ctx.reauthorize?.(); ctx.assertActive?.() }
    const data = listModels(ctx, upstreams()).filter(allowedModel).map(id => ({ id, object: 'model', owned_by: 'openviking-gateway' }))
    return json({ object: 'list', data }, requestHeaders)
  }
  if (endpoint === 'responses' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    metrics.error_reason = 'websocket_unsupported'
    return new Response(null, { status: 426, headers: { ...requestHeaders, Upgrade: 'HTTP/1.1', 'Cache-Control': 'private, no-store' } })
  }
  if (endpoint.startsWith('responses/')) {
    const id = endpoint.slice('responses/'.length)
    if (id.includes('/')) throw unsupported('Responses subresources and background execution are not available.', 'response_storage_unsupported')
    requireMethod(request.method, 'GET', 'HEAD', 'DELETE')
    if (!responseId(id)) throw new GatewayError(404, 'response_unknown', 'The response was not found or is no longer retained.')
    await ctx.reauthorize?.()
    ctx.assertActive?.()
    const scope = checkStoredRoute ? { provenance: currentProfile().provenance, checkRoute: checkStoredRoute } : undefined
    return json(request.method === 'DELETE' ? forgetResponse(ctx, id, scope) : inspectResponse(ctx, id, scope), requestHeaders)
  }
  const kind = modelEndpoint(endpoint)
  if (!kind) throw missing()
  requireMethod(request.method, 'POST')
  if (!generationConfigured(ctx)) throw unconfigured()
  if (request.headers.has('x-openviking-actor-peer')) throw unsupported('Peer selection is not available for Gateway recall.', 'peer_scope_unsupported')
  const name = request.headers.get('x-openviking-session')
  if (name !== null && (!/^[A-Za-z0-9_@.-]{1,128}$/.test(name) || name === '.' || name === '..')) {
    throw invalid('Invalid X-OpenViking-Session identifier.', 'session_invalid')
  }
  const turn = normalizeTurn(await body(request, modelBodyLimit), kind)
  if (!allowedModel(turn.model)) throw new GatewayError(403, 'model_not_allowed', 'This model is not allowed for this Gateway key.')
  const session = name === null || kind === 'count_tokens' ? null : await digest(name)
  await ctx.reauthorize?.()
  ctx.assertActive?.()
  const protocol = protocolFor(kind)
  const target = resolveTarget(ctx, upstreams(), protocol, turn.model)
  const source = turn.stream ? streamSource(ctx, target) : undefined
  if (turn.stream && !source) {
    throw unsupported('The selected model binding has no native streaming contract.', 'streaming_unavailable')
  }
  if (turn.stream) checkStreamAdmission(ctx.storage, metrics.request_id, ctx.caller)
  const { policy, keys, provenance } = currentProfile()
  const scope = checkStoredRoute ? { provenance, checkRoute: checkStoredRoute } : undefined
  const previous = turn.response?.previous_response_id ? resume(ctx, turn.response.previous_response_id, target, turn.messages, scope) : null
  if (turn.response?.store) checkResponseQuota(ctx)
  // Only names already present in account configuration enter metadata logs.
  metrics.model = turn.model
  metrics.upstream_id = target.rule.id
  metrics.protocol = protocol
  if (keys.length) metrics.context_override = keys
  const configStillCurrent = configGuard(ctx, epoch(ctx))
  const admission = enter(ctx, session === null ? null : `${ctx.caller.agentId}:${protocol}:${session}`)
  // The bound generation closure calls ctx.assertActive itself; don't recurse via that public field.
  const parentGuard = ctx.assertActive
  const lease = () => { admission.guard(); configStillCurrent(); parentGuard?.() }
  let transferred = false
  try {
    if (kind === 'count_tokens') {
      if (target.rule.binding !== 'operator' || !ctx.gatewayProvider?.countTokens) {
        throw unsupported('No exact input tokenizer is available for this binding.', 'token_count_unavailable')
      }
      reserve(ctx, turn.inputBytes)
      metrics.upstream_attempted = true
      const amount = await countTokens(ctx, target, turn.messages, lease)
      metrics.upstream_status = 200
      return json({ input_tokens: amount }, requestHeaders)
    }
    const state = session ? conversation(ctx, protocol, session) : undefined
    if (session && !state && (policy.capture || policy.profile || policy.recall)) checkConversationLimit(ctx)
    if (state) metrics.session = state.conversation
    metrics.session_source = session === null ? 'new' : 'header'
    const original = previous?.messages ?? turn.messages
    const inbound = await augment(ctx, original, previous?.inputBytes ?? turn.inputBytes, policy, !state, state?.recall_spent ?? 0, metrics, lease)
    await ctx.reauthorize?.()
    const guard = () => { lease(); previous?.guard(); inbound.check() }
    guard()
    if (turn.stream) checkStreamAdmission(ctx.storage, metrics.request_id, ctx.caller)
    reserve(ctx, inbound.input.reduce((sum, message) => sum + bytes(message.content), 0) + turn.maxTokens * 4)
    const started = Date.now()
    metrics.upstream_attempted = true
    const publish = (text: string, activeGuard = guard, snapshot?: unknown) => {
      if (turn.response?.store) {
        retainResponse(ctx, target, provenance, `resp_${metrics.request_id.replace(/-/g, '')}`, original, text, snapshot, activeGuard)
      }
      return publishTurn(ctx, policy, { protocol, name: session, user: turn.userText,
        assistant: text, recallCost: inbound.spent }, metrics, activeGuard)
    }
    if (source) {
      const external = target.rule.binding === 'operator'
      const response = await streamTurn({ ctx, request, protocol, model: turn.model, note: recallNote(policy, metrics), response: turn.response,
        includeUsage: turn.includeUsage, messages: inbound.input, maxTokens: turn.maxTokens, metrics, guard, publish, modelRevision: ctx.gatewayModelRevision,
        source, external, credentialRevision: ctx.gatewayCredentialRevision, textFilter: external ? ctx.gatewayProvider?.streamTextFilter?.() : undefined,
        release() {
          if (admission.deleted()) metrics.error_reason = 'gateway_state_deleted'
          admission.done()
          recordLog()
        } })
      transferred = true
      deferLog()
      return response
    }
    const reply = await generate(ctx, target, inbound.input, turn.maxTokens, guard)
    metrics.duration_ms = Date.now() - started
    metrics.upstream_status = 200
    if (reply.inputTokens !== null) metrics.input_tokens = reply.inputTokens
    if (reply.outputTokens !== null) metrics.output_tokens = reply.outputTokens
    const rendered = render(protocol, turn.model, reply, metrics.request_id, recallNote(policy, metrics), turn.response)
    if (binding) { await ctx.reauthorize?.(); guard() }
    const capture = await publish(reply.text, guard, rendered)
    await ctx.reauthorize?.()
    guard()
    const headers = new Headers({ ...requestHeaders, 'x-openviking-recall': metrics.recall_reason ?? 'disabled',
      'x-openviking-capture': capture })
    if (metrics.openviking_session) headers.set('x-openviking-captured-session', metrics.openviking_session)
    return json(rendered, headers)
  } catch (error) {
    if (admission.deleted()) metrics.error_reason = 'gateway_state_deleted'
    throw error
  } finally { if (!transferred) admission.done() }
}

/** Receives a request already authenticated and scrubbed by the public Worker. */
export async function routeGateway(request: Request, url: URL, ctx: GatewayContext): Promise<Response | undefined> {
  const route = gatewayPath(url.pathname)
  if (!route || route.kind === 'transfer') return undefined
  const model = route.kind === 'model'
  const endpoint = model ? modelEndpoint(route.endpoint) : undefined
  const metrics: Metrics = { request_id: ctx.gatewayRequestId ?? crypto.randomUUID(), received_at: Date.now() / 1000,
    method: request.method === 'GET' || request.method === 'POST' ? request.method : 'other', endpoint: endpoint ?? 'other',
    kind: endpoint === 'count_tokens' ? 'count' : endpoint ? 'user' : 'passthrough', status: 500 }
  const data = ctx.caller.role === 'admin' || ctx.caller.role === 'user'
  let deferred = false
  const record = () => {
    if (data && route.kind === 'model' && route.endpoint !== 'models' && metrics.error_reason !== 'gateway_state_deleted' && metrics.error_reason !== 'openviking_key_invalid') {
      try { writeLog(ctx, metrics) } catch { console.error('OpenViking Edge Gateway metadata accounting unavailable') }
    }
  }
  try {
    if (!data) throw new GatewayError(403, 'root_key_not_allowed', 'Gateway requires a tenant data credential.')
    if (ctx.gatewayKey) {
      if (!isDedicatedGatewayRoute(url.pathname, request.method)) throw invalidGatewayKey()
      metrics.credential_id = ctx.gatewayKey.digest
    }
    if (deniedEgressHeaders.some(header => request.headers.has(header))) {
      throw new GatewayError(403, 'upstream_override_not_allowed', 'Client-supplied provider or Gateway management credentials are not accepted.')
    }
    if (route.kind === 'admin') return await manage(request, url, route.parts, ctx)
    queryScope(url)
    const response = await modelRoute(request, route.endpoint, ctx, metrics, () => { deferred = true }, record)
    metrics.status = response.status
    return response
  } catch (error) {
    const safe = safeError(error)
    metrics.error_reason ??= safe.code
    metrics.status = safe.status
    return gatewayError(safe, model ? metrics.request_id : undefined)
  } finally {
    if (!deferred) record()
  }
}
