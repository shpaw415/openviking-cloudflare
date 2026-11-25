// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { admitGeneration, openGenerationStream, outputLimit } from '../generation.js'
import { isRecord, readJson } from '../http.js'
import type { BoundModel, VlmConfig } from '../model-config.js'
import { openOperatorChat, requireChatStream } from '../model-runtime.js'
import { GatewayError, bytes, maxOutputBytes, modelId } from './contract.js'
import type { Capability } from './media.js'
import { usageNumber } from './providers.js'
import { maxCalls, readCall, toolOutputError, validateCalls, wellFormed } from './tool-dto.js'
import type { Call } from './tool-dto.js'
import type { RichInput } from './wire-rich.js'

export type RichFinish = 'stop' | 'length' | 'content_filter' | 'tool_calls'
export type RichReply = { text: string; finish: RichFinish; calls: Call[]; inputTokens: number | null; outputTokens: number | null }
type ModelBinding = Extract<BoundModel, { kind: 'openai' }>
type Invoke = [model: string, input: RichInput, maxTokens: number, signal: AbortSignal, guard: () => void]
export type RichOperator = {
  model: string; capabilities: ReadonlySet<Capability>
  generate(...args: Invoke): Promise<RichReply>
  stream?(...args: Invoke): Promise<ReadableStream<Uint8Array>>
  secretGuard(text: string): void
}

export function richFinish(value: unknown): RichFinish | undefined {
  if (value === 'stop' || value === 'eos_token') return 'stop'
  if (value === 'length' || value === 'max_tokens') return 'length'
  if (value === 'content_filter' || value === 'tool_calls') return value
}

function configuredCapabilities(raw: string | undefined, binding: ModelBinding, config: VlmConfig) {
  if (!raw || raw.length > 8192) return
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 16) return
  const seen = new Set<string>()
  let match: ReadonlySet<Capability> | undefined
  for (const entry of parsed) {
    if (!isRecord(entry) || Object.keys(entry).length !== 3 || !modelId(entry.model) ||
        typeof entry.api_base !== 'string' || entry.api_base.length > 256 || !/^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9_-]+)*$/.test(entry.api_base) ||
        !Array.isArray(entry.capabilities) || !entry.capabilities.length || entry.capabilities.length > 3 ||
        entry.capabilities.some(value => value !== 'image' && value !== 'audio' && value !== 'tools') ||
        new Set(entry.capabilities).size !== entry.capabilities.length) return
    const identity = `${entry.api_base} ${entry.model}`
    if (seen.has(identity)) return
    seen.add(identity)
    if (entry.api_base === binding.base && entry.model === config.model) match = new Set<Capability>(entry.capabilities)
  }
  return match
}

const failed = () => new GatewayError(502, 'upstream_error', 'The generation binding could not complete the request.')
const timeout = () => new GatewayError(504, 'upstream_timeout', 'The generation binding did not answer in time.')

export function richOperator(ctx: WorkspaceContext, binding: ModelBinding, config: VlmConfig, inventory: string | undefined,
  allowStreaming: boolean): RichOperator | undefined {
  const capabilities = configuredCapabilities(inventory, binding, config)
  if (!capabilities) return
  const timeoutMs = Math.ceil((config.timeout ?? 20) * 1000)
  const secretGuard = (value: string) => { if (value.includes(binding.key)) throw failed() }
  const same = (model: string) => {
    if (model !== config.model) throw new GatewayError(409, 'gateway_configuration_changed', 'The admitted operator model changed.')
  }
  const dto = (input: RichInput) => input.rules.tools.length ? { tools: input.rules.tools, tool_choice: input.rules.choice,
    parallel_tool_calls: input.rules.parallel } : {}
  const open = (input: RichInput, max: number, stream: boolean, signal: AbortSignal, guard: () => void) =>
    openOperatorChat(binding, config, input.messages, max, stream, signal, () => {
      ctx.assertActive?.()
      guard()
      input.assertCurrent()
    }, dto(input))
  return {
    model: config.model, capabilities, secretGuard,
    async generate(model, input, limit, parent, guard) {
      same(model)
      const max = outputLimit(limit, config)
      await ctx.reauthorize?.()
      parent.throwIfAborted()
      ctx.assertActive?.()
      guard()
      const release = admitGeneration(ctx, config, input.inputBytes + max * 4)
      const lifecycle = new AbortController(), signal = lifecycle.signal
      const forward = () => lifecycle.abort(parent.reason)
      const timer = setTimeout(() => lifecycle.abort(timeout()), timeoutMs)
      parent.addEventListener('abort', forward, { once: true })
      if (parent.aborted) forward()
      let response: Response | undefined
      try {
        response = await open(input, max, false, signal, guard)
        signal.throwIfAborted()
        if (response.status !== 200) throw failed()
        const value = await readJson(response, 256 * 1024, signal)
        const choice: unknown = Array.isArray(value.choices) && value.choices.length === 1 ? value.choices[0] : undefined
        if (value.error != null || value.tool_calls != null || !isRecord(choice) || choice.index !== undefined && choice.index !== 0 ||
            !isRecord(choice.message) || choice.message.role !== 'assistant') throw failed()
        const message = choice.message, finish = richFinish(choice.finish_reason)
        if (finish === undefined || message.function_call != null || message.refusal != null || message.audio != null ||
            message.reasoning != null || message.reasoning_content != null || message.content != null && !wellFormed(message.content)) throw failed()
        const text = message.content as string | null | undefined ?? ''
        if (bytes(text) > maxOutputBytes) throw failed()
        secretGuard(text)
        let calls: Call[] = []
        if (message.tool_calls != null) {
          if (!Array.isArray(message.tool_calls) || message.tool_calls.length > maxCalls) throw toolOutputError()
          calls = message.tool_calls.map(item => {
            if (!isRecord(item) || item.type !== 'function' || !isRecord(item.function)) throw toolOutputError()
            if (wellFormed(item.function.arguments)) secretGuard(item.function.arguments)
            return readCall(input.rules, item.id, item.function.name, item.function.arguments, true, toolOutputError)
          })
        }
        if (!text.trim() && !calls.length) throw failed()
        validateCalls(calls, finish, input.rules, input.ids, secretGuard, text)
        const usage = isRecord(value.usage) ? value.usage : {}
        return { text, finish, calls, inputTokens: usageNumber(usage.prompt_tokens), outputTokens: usageNumber(usage.completion_tokens) }
      } catch (error) {
        if (response && !response.body?.locked) void response.body?.cancel().catch(() => {})
        if (signal.aborted) throw signal.reason
        if (error instanceof GatewayError) throw error
        throw failed()
      } finally {
        clearTimeout(timer)
        parent.removeEventListener('abort', forward)
        release()
      }
    },
    ...(allowStreaming && { async stream(model: string, input: RichInput, limit: number, signal: AbortSignal, guard: () => void) {
      same(model)
      const max = outputLimit(limit, config)
      await ctx.reauthorize?.()
      signal.throwIfAborted()
      ctx.assertActive?.()
      guard()
      const release = admitGeneration(ctx, config, input.inputBytes + max * 4)
      return openGenerationStream(ctx, true, timeoutMs, signal, async providerSignal =>
        requireChatStream(await open(input, max, true, providerSignal, guard)), release)
    } }),
  }
}
