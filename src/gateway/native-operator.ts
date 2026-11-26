// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { admitGeneration, openGenerationStream, outputLimit } from '../generation.js'
import { isRecord, readJson } from '../http.js'
import { openAIBase, providerKey } from '../model-config.js'
import type { ModelEnv, VlmConfig } from '../model-config.js'
import { requireChatStream } from '../model-runtime.js'
import { GatewayError, bytes, digest, integer, modelId } from './contract.js'
import type { Capability } from './media.js'
import { nativeBody, readNativeReply, upstreamFailure } from './native-dto.js'
import type { NativeInput, NativeProtocol, OutputRules } from './native-dto.js'
import { nativePieces } from './native-sse.js'
import type { PieceSource } from './sse-source.js'
import type { RichOperator } from './operator-rich.js'

type NativeRoute = RichOperator & { pieces(input: OutputRules): PieceSource; scope: string;
  count?(model: string, input: NativeInput, signal: AbortSignal, guard: () => void): Promise<number> }
export type NativeRoutes = Partial<Record<NativeProtocol, NativeRoute | null>>
export const emptyNativeInput = (messages: NativeInput['messages'], assertCurrent: () => void, options?: NativeInput['options']): NativeInput =>
  ({ messages, rules: { tools: [] }, ids: new Set<string>(), inputBytes: bytes(JSON.stringify(messages)), assertCurrent, options })

const bases = { responses: openAIBase, anthropic: 'https://api.anthropic.com/v1' } as const
const shared = ['image', 'tools', 'document', 'sampling', 'structured', 'local_read']
const inventory = { responses: shared, anthropic: [...shared, 'stop_sequences', 'count_tokens'] }
const closed = () => ({ responses: null, anthropic: null })
const timedOut = () => new GatewayError(504, 'upstream_timeout', 'The generation binding did not answer in time.')

/** No request fields influence this inventory. An entry can narrow the existing credential inventory,
 * never add a destination to it. The native adapter is never wired to general generation. */
export async function nativeOperators(ctx: WorkspaceContext, env: ModelEnv, raw: string | undefined, config: VlmConfig | undefined,
  streaming: boolean): Promise<NativeRoutes | undefined> {
  if (raw === undefined) return
  if (!raw || raw.length > 4096) return closed()
  let entries: unknown
  try { entries = JSON.parse(raw) } catch { return closed() }
  if (!Array.isArray(entries) || entries.length > 2) return closed()
  const routes: NativeRoutes = {}
  for (const row of entries) {
    if (!isRecord(row) || Object.keys(row).some(key => !['protocol', 'api_base', 'model', 'capabilities'].includes(key)) ||
        (row.protocol !== 'responses' && row.protocol !== 'anthropic') || Object.hasOwn(routes, row.protocol) ||
        row.api_base !== bases[row.protocol] || !modelId(row.model) || row.model.startsWith('@cf/') ||
        row.capabilities !== undefined && (!Array.isArray(row.capabilities) || row.capabilities.length > inventory[row.protocol].length ||
          row.capabilities.some(cap => !inventory[row.protocol as NativeProtocol].includes(cap)) || new Set(row.capabilities).size !== row.capabilities.length)) return closed()
    const { protocol, model } = row, base = bases[protocol]
    const key = providerKey(env, base)
    routes[protocol] = key ? operator(ctx, protocol, model, key, await digest(`native-v1:${protocol}:${base}`),
      new Set<Capability>(row.capabilities as Capability[] | undefined), config, streaming) : null
  }
  return routes
}

function operator(ctx: WorkspaceContext, protocol: NativeProtocol, model: string, key: string, scope: string,
  capabilities: ReadonlySet<Capability>, config: VlmConfig | undefined, streaming: boolean): NativeRoute {
  // Reuse the generation ceilings and the common account/user admission, not the VLM's provider/model.
  const limits: VlmConfig = config ?? { provider: 'workers_ai', model }
  const timeout = Math.ceil((limits.timeout ?? 20) * 1000)
  const endpoint = `${bases[protocol]}/${protocol === 'responses' ? 'responses' : 'messages'}`
  const secretGuard = (text: string) => { if (text.includes(key)) throw upstreamFailure() }
  async function prepare(selected: string, input: NativeInput, limit: number, stream: boolean, parent: AbortSignal, guard: () => void, count = false) {
    if (selected !== model) throw new GatewayError(409, 'gateway_configuration_changed', 'The admitted operator model changed.')
    const max = count ? 0 : outputLimit(limit, limits)
    const data = nativeBody(protocol, model, input, max, stream, count)
    const body = JSON.stringify(data)
    const wireBytes = bytes(body)
    if (wireBytes > 288 * 1024) throw new GatewayError(413, 'body_too_large', 'The projected Gateway turn exceeds its wire budget.')
    await ctx.reauthorize?.()
    const current = (signal: AbortSignal) => {
      parent.throwIfAborted(); signal.throwIfAborted(); ctx.assertActive?.(); guard(); input.assertCurrent()
    }
    current(parent)
    const release = admitGeneration(ctx, limits, Math.max(input.inputBytes, wireBytes) + max * 4)
    const headers = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json',
      ...(protocol === 'responses' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key, 'anthropic-version': '2023-06-01' }) }
    return { release, open(signal: AbortSignal) {
      current(signal)
      return fetch(count ? `${endpoint}/count_tokens` : endpoint, { method: 'POST', redirect: 'manual', headers, signal, body })
    } }
  }
  async function jsonCall<T>(selected: string, input: NativeInput, limit: number, parent: AbortSignal, guard: () => void,
    read: (value: Record<string, unknown>) => T, count = false): Promise<T> {
      const call = await prepare(selected, input, limit, false, parent, guard, count)
      const lifecycle = new AbortController(), signal = lifecycle.signal
      const forward = () => lifecycle.abort(parent.reason)
      const timer = setTimeout(() => lifecycle.abort(timedOut()), timeout)
      parent.addEventListener('abort', forward, { once: true })
      if (parent.aborted) forward()
      let reply: Response | undefined
      try {
        reply = await call.open(signal)
        signal.throwIfAborted()
        if (reply.status !== 200) throw upstreamFailure()
        const parsed = read(await readJson(reply, count ? 4096 : 256 * 1024, signal))
        signal.throwIfAborted()
        return parsed
      } catch (error) {
        if (reply && !reply.body?.locked) void reply.body?.cancel().catch(() => {})
        if (signal.aborted) throw signal.reason
        if (error instanceof GatewayError) throw error
        throw upstreamFailure()
      } finally { clearTimeout(timer); parent.removeEventListener('abort', forward); call.release() }
  }
  return {
    model, scope, capabilities, secretGuard, pieces: input => nativePieces(protocol, input, key),
    generate: (selected, input, limit, signal, guard) => jsonCall(selected, input, limit, signal, guard,
      value => readNativeReply(protocol, value, input, secretGuard)),
    ...(protocol === 'anthropic' && capabilities.has('count_tokens') && { count: (selected, input, signal, guard) =>
      jsonCall(selected, input, 0, signal, guard, value => {
        if (value.error != null || !integer(value.input_tokens, 0, 1_000_000)) throw upstreamFailure()
        return value.input_tokens
      }, true) }),
    ...(streaming && { async stream(selected: string, input: NativeInput, limit: number, signal: AbortSignal, guard: () => void) {
      const call = await prepare(selected, input, limit, true, signal, guard)
      return openGenerationStream(ctx, true, timeout, signal, async providerSignal => requireChatStream(await call.open(providerSignal)), call.release)
    } }),
  }
}
