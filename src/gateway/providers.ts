// SPDX-License-Identifier: AGPL-3.0-only
import type { Generation, ModelMessage, WorkspaceContext } from '../context.js'
import { generationModel } from '../generation.js'
import { ApiError, isRecord } from '../http.js'
import { GatewayError, bytes, displayName, fields, integer, invalidConfig, maxOutputBytes, modelId, protocols,
  record, unconfigured, unsupported, within } from './contract.js'
import type { Protocol } from './contract.js'

// Trusted deployment-side interface. Do not construct it from request data.
export interface GatewayProvider {
  models: readonly string[]
  generate(model: string, messages: ModelMessage[], options: { maxTokens: number }): ReturnType<Generation>
  countTokens?(model: string, messages: ModelMessage[]): Promise<number>
}

export interface GatewayContext extends WorkspaceContext {
  gatewayProvider?: GatewayProvider
  workersAIModel?: string
  /** Text generation configured on the operator adapter is not a Workers AI route. */
  externalGeneration?: boolean
  /** Server-generated correlation ID; never copied from an HTTP header. */
  gatewayRequestId?: string
}

const bindingUris = { workers_ai: 'binding://workers-ai', operator: 'binding://operator' } as const
type Binding = keyof typeof bindingUris
export type Upstream = {
  name: string; protocol: Protocol; binding: Binding; models: string[]; aliases: Record<string, string>;
  priority: number; enabled: boolean
}
export type SavedUpstream = Upstream & { id: string; revision: number }

export function manifest(ctx: GatewayContext, binding: Binding): readonly string[] {
  if (binding === 'workers_ai') return ctx.externalGeneration ? [] : [ctx.workersAIModel ?? generationModel]
  const models = ctx.gatewayProvider?.models
  return Array.isArray(models) && models.length > 0 && models.length <= 32 && models.every(modelId) ? models : []
}

export function isBound(ctx: GatewayContext, binding: Binding): boolean {
  return binding === 'workers_ai' ? !ctx.externalGeneration && typeof ctx.generate === 'function' :
    manifest(ctx, binding).length > 0 && typeof ctx.gatewayProvider?.generate === 'function'
}

export function generationConfigured(ctx: GatewayContext): boolean {
  return isBound(ctx, 'workers_ai') || isBound(ctx, 'operator')
}

export function defaults(ctx: GatewayContext): SavedUpstream[] {
  const entries: SavedUpstream[] = []
  for (const binding of ['workers_ai', 'operator'] as const) {
    const models = manifest(ctx, binding)
    if (!models.length) continue
    for (const protocol of protocols) entries.push({ id: `${binding}-${protocol}`, revision: 0,
      name: binding === 'workers_ai' ? 'Workers AI' : 'Operator binding', binding, protocol,
      models: [...new Set(models)], aliases: {}, priority: binding === 'workers_ai' ? 0 : -1, enabled: true })
  }
  return entries
}

export function viewUpstream(ctx: GatewayContext, upstream: SavedUpstream) {
  return { ...upstream, base_url: bindingUris[upstream.binding], binding_configured: isBound(ctx, upstream.binding),
    append_endpoint_path: true, auth_mode: 'managed', key_header: 'authorization', has_api_key: false, vendor: 'generic',
    allow_gateway_tools: false, replay_reasoning: false, coding_plan: false, allow_coding_plan: false,
    cache_min_tokens: 1024, context_windows: {} }
}

const staticFields = { append_endpoint_path: true, auth_mode: 'managed', key_header: 'authorization', vendor: 'generic',
  allow_gateway_tools: false, replay_reasoning: false, coding_plan: false, allow_coding_plan: false, cache_min_tokens: 1024 } as const

export function parseUpstream(ctx: GatewayContext, value: Record<string, unknown>): Upstream {
  fields(value, ['name', 'protocol', 'binding', 'base_url', 'models', 'aliases', 'priority', 'enabled',
    'context_windows', 'api_key', 'headers', ...Object.keys(staticFields)], invalidConfig)
  const binding = value.binding === undefined ? (value.base_url === bindingUris.operator ? 'operator' : 'workers_ai') : value.binding
  if (binding !== 'workers_ai' && binding !== 'operator') throw invalidConfig('Expected a supported deployment binding.')
  if (value.base_url !== undefined && value.base_url !== bindingUris[binding]) throw invalidConfig('Only a fixed binding identifier is accepted as base_url.')
  if ((value.api_key !== undefined && value.api_key !== '') ||
      (value.headers !== undefined && Object.keys(record(value.headers, invalidConfig)).length !== 0)) {
    throw invalidConfig('Provider keys and headers cannot be supplied over HTTP.')
  }
  for (const [key, fixed] of Object.entries(staticFields)) {
    if (Object.hasOwn(value, key) && value[key] !== fixed) throw invalidConfig(`${key} cannot be configured for a binding.`)
  }
  if (value.context_windows !== undefined && Object.keys(record(value.context_windows, invalidConfig)).length) {
    throw unsupported('Provider context-window overrides are not available.', 'upstream_setting_unsupported')
  }
  const protocol = value.protocol
  if (!protocols.includes(protocol as Protocol)) throw invalidConfig('Expected chat, responses, or anthropic protocol.')
  const allowed = manifest(ctx, binding), models = value.models === undefined ? allowed : value.models
  if (!Array.isArray(models) || models.length < 1 || models.length > 32 ||
      models.some(model => !modelId(model) || !allowed.includes(model))) {
    throw invalidConfig('models must be a nonempty subset of the binding inventory.')
  }
  const aliased = value.aliases === undefined ? {} : record(value.aliases, invalidConfig)
  const pairs = Object.entries(aliased)
  if (pairs.length > 32 || pairs.some(([name, model]) => !modelId(name) || !modelId(model) ||
      Object.hasOwn(Object.prototype, name) || models.includes(name) || !models.includes(model))) {
    throw invalidConfig('Aliases must be distinct client model identifiers pointing at an allowed binding model.')
  }
  const priority = value.priority === undefined ? 0 : value.priority
  if (!integer(priority, -1000, 1000)) throw invalidConfig('priority must be an integer in -1000–1000.')
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') throw invalidConfig('enabled must be a boolean.')
  return { name: displayName(value.name), protocol: protocol as Protocol, binding, models: [...new Set<string>(models)],
    aliases: Object.fromEntries(pairs) as Record<string, string>, priority, enabled }
}

export function routedModel(ctx: GatewayContext, rule: Upstream, name: string): string | undefined {
  const target = Object.hasOwn(rule.aliases, name) ? rule.aliases[name] : name
  return rule.models.includes(target) && manifest(ctx, rule.binding).includes(target) ? target : undefined
}

export type Target = { rule: SavedUpstream; model: string }

export function resolveTarget(ctx: GatewayContext, upstreams: SavedUpstream[], protocol: Protocol, name: string): Target {
  const candidates = upstreams.filter(rule => rule.enabled && rule.protocol === protocol)
    .sort((a, b) => b.priority - a.priority || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0))
  for (const rule of candidates) {
    const model = routedModel(ctx, rule, name)
    if (!model) continue
    // No automatic fallback to a different provider if the winning route is down.
    if (!isBound(ctx, rule.binding)) throw unconfigured()
    return { rule, model }
  }
  throw new GatewayError(404, 'no_matching_upstream', 'No enabled route matches this protocol and model.')
}

export function listModels(ctx: GatewayContext, upstreams: SavedUpstream[]): string[] {
  return [...new Set(upstreams.flatMap(rule => !rule.enabled || !isBound(ctx, rule.binding) ? [] :
    [...rule.models, ...Object.keys(rule.aliases)].filter(name => {
      try { resolveTarget(ctx, upstreams, rule.protocol, name); return true } catch { return false }
    })))].sort()
}

export type Reply = Awaited<ReturnType<Generation>>
const timeout = () => new GatewayError(504, 'upstream_timeout', 'The generation binding did not answer in time.')
const providerFailure = () => new GatewayError(502, 'upstream_error', 'The generation binding could not complete the request.')
export const usageNumber = (value: unknown) => integer(value, 0, 1_000_000) ? value : null

export async function generate(ctx: GatewayContext, target: Target, messages: ModelMessage[], maxTokens: number, guard: () => void): Promise<Reply> {
  const prior = ctx.assertActive
  let live = true
  let timedOut = false
  const fence = () => {
    if (!live) throw timeout()
    prior?.()
    guard()
  }
  const operator = target.rule.binding === 'operator'
  ctx.assertActive = fence // The shared Workers AI binding checks this after its own reauthorization.
  try {
    let output: unknown
    try {
      output = await within(25_000, () => {
        fence()
        return operator ? ctx.gatewayProvider!.generate(target.model, messages, { maxTokens }) : ctx.generate!(messages, { maxTokens })
      }, () => { timedOut = true; return timeout() })
    } catch (error) {
      if (error instanceof GatewayError) throw error
      if (error instanceof ApiError && ['AUTH_UNAVAILABLE', 'RATE_LIMITED', 'UNAUTHENTICATED', 'PERMISSION_DENIED'].includes(error.code)) throw error
      throw providerFailure()
    }
    if (!isRecord(output) || typeof output.text !== 'string' || !output.text.trim() || bytes(output.text) > maxOutputBytes || /\p{Cs}/u.test(output.text)) {
      throw providerFailure()
    }
    await ctx.reauthorize?.()
    fence()
    return { text: output.text, inputTokens: usageNumber(output.inputTokens), outputTokens: usageNumber(output.outputTokens) }
  } finally {
    live = false
    // On timeout the in-flight shared call may still reach its second guard after reauthorization.
    // Leave the closed fence attached to this (per-request) context until it has gone away.
    // No other operation should use a timed-out context; the only consumer after success is capture.
    if (!timedOut && ctx.assertActive === fence) ctx.assertActive = prior
  }
}

export async function countTokens(ctx: GatewayContext, target: Target, messages: ModelMessage[], guard: () => void): Promise<number> {
  const binding = ctx.gatewayProvider
  if (target.rule.binding !== 'operator' || !binding?.countTokens) {
    throw unsupported('No exact input tokenizer is available for this binding.', 'token_count_unavailable')
  }
  guard()
  const amount = await within(15_000, async () => {
    try { return await binding.countTokens!(target.model, messages) } catch { throw providerFailure() }
  }, timeout)
  await ctx.reauthorize?.()
  guard()
  if (!integer(amount, 0, 1_000_000)) throw providerFailure()
  return amount
}
