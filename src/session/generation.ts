// SPDX-License-Identifier: AGPL-3.0-only
import type { Generation as Generate, ModelMessage as GenerationMessage, WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'

export type Generation = { text: string, inputTokens: number | null, outputTokens: number | null }

const encoder = new TextEncoder()
export const byteLength = (value: string) => encoder.encode(value).byteLength
export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('')
}

export function generator(ctx: WorkspaceContext): Generate | undefined {
  return ctx.generate
}

export function requireGenerator(ctx: WorkspaceContext): Generate {
  const generate = generator(ctx)
  if (!generate) throw new ApiError(503, 'GENERATION_UNAVAILABLE', 'Text generation is not configured.')
  return generate
}

export function timeout(): ApiError {
  return new ApiError(504, 'DEADLINE_EXCEEDED', 'The operation did not complete before its deadline.')
}

export function interrupted(): ApiError {
  return new ApiError(409, 'INTERRUPTED', 'The turn was interrupted.')
}

// This bounds our wait, not upstream execution. Every consequential write must still be fenced.
export async function beforeDeadline<T>(start: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  const remaining = deadline - Date.now()
  if (signal?.aborted) throw interrupted()
  if (remaining <= 0) throw timeout()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeout()), remaining)
    stop = () => reject(interrupted())
    signal?.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([Promise.resolve().then(start), abort])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (stop) signal?.removeEventListener('abort', stop)
  }
}

export async function generateText(ctx: WorkspaceContext, messages: GenerationMessage[], maxTokens: number,
  maxBytes: number, deadline: number, signal?: AbortSignal, reasoningEffort?: import('../model-config.js').ReasoningEffort): Promise<Generation> {
  const generate = requireGenerator(ctx)
  const result = await beforeDeadline(async () => {
    try { return await generate(messages, { maxTokens,...(reasoningEffort!==undefined&&{reasoningEffort}) }) }
    catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(503, 'GENERATION_UNAVAILABLE', 'Text generation failed.')
    }
  }, deadline, signal)
  if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > maxBytes ||
      byteLength(result.text) > maxBytes || /\p{Cs}/u.test(result.text)) {
    throw new ApiError(502, 'INVALID_MODEL_OUTPUT', 'The model did not return bounded text.')
  }
  const known = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null
  return { text: result.text, inputTokens: known(result.inputTokens), outputTokens: known(result.outputTokens) }
}
