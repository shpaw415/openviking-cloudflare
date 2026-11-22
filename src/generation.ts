// SPDX-License-Identifier: AGPL-3.0-only
import type { Generation, GenerationStream, ModelMessage, WorkspaceContext } from './context.js'
import { ApiError, isRecord } from './http.js'
import { maxGenerationTokens } from './model-config.js'
import type { BoundModel, VlmConfig } from './model-config.js'
import { modelChat, workersChat } from './model-runtime.js'

export { generationModel } from './model-config.js'
const encoder = new TextEncoder()
const bad = () => new ApiError(400, 'INVALID_ARGUMENT', 'Generation input is invalid or too large.')
const unavailable = () => new ApiError(503, 'GENERATION_UNAVAILABLE', 'The configured generation provider is unavailable.')

export function initGeneration(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_generation_budget (
    subject TEXT PRIMARY KEY, window_day INTEGER NOT NULL, calls INTEGER NOT NULL, units INTEGER NOT NULL
  )`)
}

function reserve(ctx: WorkspaceContext, units: number): void {
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

async function authorizeInput(ctx: WorkspaceContext, messages: ModelMessage[], max: number) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 48 || !Number.isSafeInteger(max) || max < 1 || max > maxGenerationTokens) throw bad()
    let bytes = 0
    const input = messages.map(msg => {
      if (!msg || !['system', 'user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') throw bad()
      bytes += encoder.encode(msg.content).byteLength
      if (bytes > 49_152) throw bad()
      return { role: msg.role, content: msg.content }
    })
    await ctx.reauthorize?.()
    ctx.assertActive?.()
    // Account in input bytes plus a conservative output allowance, not fake provider tokens.
    reserve(ctx, bytes + max * 4)
    return input
}

function outputLimit(requested: number | undefined, config: VlmConfig): number {
  const max = requested ?? 512
  if (!Number.isSafeInteger(max) || max < 1 || max > maxGenerationTokens) throw bad()
  return Math.min(max, config.max_tokens ?? max)
}

export function generation(ctx: WorkspaceContext, binding: BoundModel, config: VlmConfig): Generation {
  return async (messages, options = {}) => {
    const max = outputLimit(options.maxTokens, config)
    const input = await authorizeInput(ctx,messages,max)
    let output: unknown
    try { output = await modelChat(binding, config, input, max) } catch { throw unavailable() }
    if (!isRecord(output) || typeof output.response !== 'string' || !output.response.trim() || encoder.encode(output.response).byteLength > 65_536) throw unavailable()
    const usage = isRecord(output.usage) ? output.usage : {}
    const metric = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1_000_000 ? x : null
    return { text: output.response, inputTokens: metric(usage.prompt_tokens), outputTokens: metric(usage.completion_tokens) }
  }
}

/** Return the real binding byte stream, enforcing resource and authorization bounds. */
export function streamGeneration(ctx: WorkspaceContext, ai: Ai, config: VlmConfig): GenerationStream {
  return async (messages, options = {}) => {
    const max = outputLimit(options.maxTokens, config)
    if(options.signal?.aborted)throw new ApiError(409,'INTERRUPTED','Generation interrupted.')
    const input = await authorizeInput(ctx,messages,max)
    let provider:unknown
    try{provider=await workersChat(ai,config,input,max,true)}catch{throw unavailable()}
    if(!(provider instanceof ReadableStream))throw unavailable()
    const reader=provider.getReader(),started=Date.now()
    let lastCheck=started,bytes=0,terminated=false,timer:ReturnType<typeof setTimeout>|undefined
    let abortListener: (()=>void)|undefined
    const close=async(reason?:unknown) => {
      if(terminated)return
      terminated=true
      if(timer!==undefined)clearTimeout(timer)
      if(abortListener)options.signal?.removeEventListener('abort',abortListener)
      try {await reader.cancel(reason)}catch{/* The provider may already have closed. */}
      reader.releaseLock()
    }
    return new ReadableStream<Uint8Array>({
      start(controller) {
        const interrupt=(error:ApiError)=>{
          if(terminated)return
          controller.error(error)
          void close(error)
        }
        timer=setTimeout(()=>interrupt(new ApiError(504,'DEADLINE_EXCEEDED','Generation stream expired.')),45_000)
        abortListener=()=>interrupt(new ApiError(409,'INTERRUPTED','Generation interrupted.'))
        options.signal?.addEventListener('abort',abortListener,{once:true})
        if(options.signal?.aborted)abortListener()
      },
      async pull(controller){
        if(terminated)return
        try{
          const part=await reader.read()
          if(terminated)return
          if(part.done){controller.close();await close();return}
          if(!(part.value instanceof Uint8Array))throw unavailable()
          bytes+=part.value.byteLength
          if(bytes>256*1024)throw new ApiError(413,'RESOURCE_EXHAUSTED','Generation stream exceeded its byte limit.')
          if(Date.now()-lastCheck>=2000){await ctx.reauthorize?.();lastCheck=Date.now()}
          ctx.assertActive?.()
          if(!terminated)controller.enqueue(part.value)
        }catch(error){if(!terminated){controller.error(error);await close(error)}}
      },
      async cancel(){await close()}
    })
  }
}
