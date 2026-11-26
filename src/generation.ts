// SPDX-License-Identifier: AGPL-3.0-only
import type { Generation, GenerationStream, ModelMessage, WorkspaceContext } from './context.js'
import { ApiError, isRecord } from './http.js'
import { maxGenerationTokens } from './model-config.js'
import type { BoundModel, VlmConfig } from './model-config.js'
import { modelChat, modelChatStream } from './model-runtime.js'

export { generationModel } from './model-config.js'
const encoder = new TextEncoder()
const bad = () => new ApiError(400, 'INVALID_ARGUMENT', 'Generation input is invalid or too large.')
const unavailable = () => new ApiError(503, 'GENERATION_UNAVAILABLE', 'The configured generation provider is unavailable.')
const activeGenerations = new WeakMap<DurableObjectStorage, { calls: number }>()

export function initGeneration(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_generation_budget (
    subject TEXT PRIMARY KEY, window_day INTEGER NOT NULL, calls INTEGER NOT NULL, units INTEGER NOT NULL
  )`)
}

export function reserveModelBudget(ctx: WorkspaceContext, units: number): void {
  const day = Math.floor(Date.now() / 86_400_000)
  ctx.storage.transactionSync(() => {
    // Explicit per-user subquota; rotating an API key doesn't reset it.
    for (const [subject, callCap, unitsCap] of [['_account', 768, 4_194_304], [`user:${ctx.caller.userId}`, 160, 1_048_576]] as const) {
      const previous = ctx.sql.exec<{ window_day: number; calls: number; units: number }>(
        'SELECT window_day,calls,units FROM ov_generation_budget WHERE subject=?', subject).toArray()[0]
      const calls = (previous?.window_day === day ? previous.calls : 0) + 1
      const used = (previous?.window_day === day ? previous.units : 0) + units
      if (calls > callCap || used > unitsCap) throw new ApiError(429, 'RATE_LIMITED', 'Daily generation budget exhausted.')
      ctx.sql.exec(`INSERT INTO ov_generation_budget VALUES(?,?,?,?) ON CONFLICT(subject)
        DO UPDATE SET window_day=excluded.window_day,calls=excluded.calls,units=excluded.units`, subject, day, calls, used)
    }
  })
}

async function authorizeInput(ctx: WorkspaceContext, messages: ModelMessage[], max: number, signal?: AbortSignal) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 48 || !Number.isSafeInteger(max) || max < 1 || max > maxGenerationTokens) throw bad()
    let bytes = 0
    const input = messages.map(msg => {
      if (!msg || !['system', 'user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') throw bad()
      bytes += encoder.encode(msg.content).byteLength
      if (bytes > 49_152) throw bad()
      return { role: msg.role, content: msg.content }
    })
    await ctx.reauthorize?.()
    signal?.throwIfAborted()
    ctx.assertActive?.()
    return { input, units: bytes + max * 4 }
}

/** Called after authority checks, in the same synchronous turn as provider admission. */
export function admitGeneration(ctx: WorkspaceContext, config: VlmConfig, units: number): () => void {
  const active = activeGenerations.get(ctx.storage) ?? { calls: 0 }
  if (config.max_concurrent !== undefined && active.calls >= config.max_concurrent) {
    throw new ApiError(429, 'RATE_LIMITED', 'The workspace generation concurrency limit is reached.')
  }
  // Quotas account in bytes plus a conservative output allowance, not fake provider tokens.
  reserveModelBudget(ctx, units)
  active.calls++
  activeGenerations.set(ctx.storage, active)
  let released = false
  return () => { if (!released) { released = true; active.calls-- } }
}

export function outputLimit(requested: number | undefined, config: VlmConfig): number {
  const max = requested ?? 512
  if (!Number.isSafeInteger(max) || max < 1 || max > maxGenerationTokens) throw bad()
  return Math.min(max, config.max_tokens ?? max)
}

export function generation(ctx: WorkspaceContext, binding: BoundModel, config: VlmConfig): Generation {
  return async (messages, options = {}) => {
    if (options.reasoningEffort !== undefined && (binding.kind !== 'openai' || config.reasoning_effort === undefined || !ctx.sessionReasoning)) {
      throw new ApiError(503, 'SESSION_REASONING_UNAVAILABLE', 'The configured session model does not admit reasoning overrides.')
    }
    const max = outputLimit(options.maxTokens, config)
    const { input, units } = await authorizeInput(ctx, messages, max, options.signal)
    // The async authorizeInput return is itself a yield. This check and the
    // binding call must stay in the same Workspace turn.
    ctx.assertActive?.()
    options.signal?.throwIfAborted()
    const release = admitGeneration(ctx, config, units)
    let output: unknown
    try {
      const effective = options.reasoningEffort === undefined ? config : { ...config, reasoning_effort: options.reasoningEffort }
      output = await modelChat(binding, effective, input, max, options.signal)
    }
    catch (error) {
      options.signal?.throwIfAborted()
      if (error instanceof ApiError && error.code === 'GENERATION_TIMEOUT') throw error
      throw unavailable()
    }
    finally { release() }
    if (!isRecord(output) || typeof output.response !== 'string' || !output.response.trim() || encoder.encode(output.response).byteLength > 65_536) throw unavailable()
    const usage = isRecord(output.usage) ? output.usage : {}
    const metric = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000 ? x : null
    return { text: output.response, inputTokens: metric(usage.prompt_tokens), outputTokens: metric(usage.completion_tokens) }
  }
}

/** Return only the binding's SSE bytes; translation and termination belong to the Gateway. */
export function streamGeneration(ctx: WorkspaceContext, binding: BoundModel, config: VlmConfig): GenerationStream {
  return async (messages, options = {}) => {
    const max = outputLimit(options.maxTokens, config)
    options.signal?.throwIfAborted()
    const { input, units } = await authorizeInput(ctx, messages, max, options.signal)
    ctx.assertActive?.()
    options.signal?.throwIfAborted()
    const external = binding.kind === 'openai'
    const release = admitGeneration(ctx, config, units)
    return openGenerationStream(ctx, external, external ? Math.ceil((config.timeout ?? 20) * 1000) : 45_000,
      options.signal, signal => modelChatStream(binding, config, input, max, signal), release)
  }
}

export async function openGenerationStream(ctx: WorkspaceContext, external: boolean, timeout: number, parent: AbortSignal | undefined,
  open: (signal: AbortSignal) => Promise<unknown>, release: () => void): Promise<ReadableStream<Uint8Array>> {
    if (parent?.aborted) { release(); throw parent.reason }
    const lifecycle = new AbortController(), { signal } = lifecycle
    const started = Date.now()
    const forwardAbort = () => lifecycle.abort(parent?.reason)
    const timer = setTimeout(() => lifecycle.abort(new ApiError(504, 'DEADLINE_EXCEEDED', 'Generation stream expired.')), timeout)
    parent?.addEventListener('abort', forwardAbort, { once: true })
    const cleanup = () => { clearTimeout(timer); parent?.removeEventListener('abort', forwardAbort); release() }
    let reader: ReadableStreamDefaultReader<unknown>
    try {
      const provider = await open(signal)
      if (!(provider instanceof ReadableStream) || provider.locked) throw unavailable()
      if (signal.aborted) {
        void provider.cancel().catch(() => {})
        throw signal.reason
      }
      reader = provider.getReader()
    } catch (error) {
      cleanup()
      if (signal.aborted) throw signal.reason
      if (error instanceof ApiError) throw error
      if (external) throw new ApiError(502, 'UPSTREAM_ERROR', 'The configured streaming provider did not open an SSE response.')
      throw unavailable()
    }
    let lastCheck = started, bytes = 0, terminated = false
    let out: ReadableStreamDefaultController<Uint8Array>
    const aborted = () => {
      if (!terminated) { out.error(signal.reason); close() }
    }
    function close() {
      if (terminated) return
      terminated = true
      cleanup()
      signal.removeEventListener('abort', aborted)
      // Abort the HTTP request and release pending reads without holding the slot.
      if (external) lifecycle.abort()
      void reader.cancel().catch(() => {}).finally(() => { try { reader.releaseLock() } catch { /* Already closed. */ } })
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      },
      async pull(controller) {
        if (terminated) return
        try {
          const part = await reader.read()
          if (terminated) return
          if (part.done) { controller.close(); close(); return }
          if (!(part.value instanceof Uint8Array)) throw unavailable()
          bytes += part.value.byteLength
          if (bytes > 256 * 1024) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'Generation stream exceeded its byte limit.')
          if (Date.now() - lastCheck >= 2000) { await ctx.reauthorize?.(); lastCheck = Date.now() }
          ctx.assertActive?.()
          if (!terminated) controller.enqueue(part.value)
        } catch (error) { if (!terminated) { controller.error(error); close() } }
      },
      cancel() { close() },
    }, { highWaterMark: 0 })
}
