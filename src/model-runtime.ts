// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMessage } from './context.js'
import { ApiError, isRecord, readJson } from './http.js'
import { openAIBase } from './model-config.js'
import type { BoundModel, EmbeddingConfig, VlmConfig } from './model-config.js'

type OpenAI = Extract<BoundModel, { kind: 'openai' }>
const httpOptions = (binding: OpenAI, body: object, signal: AbortSignal, accept: string): RequestInit => ({
  method: 'POST', redirect: 'manual', signal,
  headers: { accept, 'content-type': 'application/json', authorization: `Bearer ${binding.key}` },
  body: JSON.stringify(body),
})
const invoke = (ai: Ai, model: string, input: unknown) =>
  (ai as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(model, input)

async function post(binding: OpenAI, operation: 'chat/completions' | 'embeddings', body: object, timeout: number, limit: number,
  parent?: AbortSignal) {
  const deadline = AbortSignal.timeout(Math.ceil(timeout * 1000))
  const signal = parent ? AbortSignal.any([parent, deadline]) : deadline
  let response: Response | undefined
  try {
    signal.throwIfAborted()
    response = await fetch(`${binding.base}/${operation}`, httpOptions(binding, body, signal, 'application/json'))
    if (response.status !== 200) throw new Error('Model request failed.')
    return await readJson(response, limit, signal)
  } catch (error) {
    if (!response?.body?.locked) void response?.body?.cancel().catch(() => {})
    parent?.throwIfAborted()
    if (operation === 'chat/completions' && parent && deadline.aborted) throw new ApiError(504, 'GENERATION_TIMEOUT', 'Context model deadline exceeded.')
    throw error // Callers replace provider errors with a static message.
  }
}

export function workersChat(ai: Ai, config: VlmConfig, messages: ModelMessage[], max: number, stream: boolean) {
  return invoke(ai, config.model, { messages, max_tokens: max, stream,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }) })
}

function httpChatBody(binding: OpenAI, config: VlmConfig, messages: readonly object[], max: number, stream: boolean) {
  return {
    model: config.model, messages, stream,
    ...(binding.base === openAIBase ? { max_completion_tokens: max } : { max_tokens: max }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.reasoning_effort === undefined ? {} : { reasoning_effort: config.reasoning_effort }),
    ...(config.top_p === undefined ? {} : { top_p: config.top_p }),
    // Only the official endpoint is known to support this option. Other
    // compatible providers may send usage themselves; never retry without it.
    ...(stream && binding.base === openAIBase && { stream_options: { include_usage: true } }),
  }
}

/** Gateway-only typed payload is populated by the admitted operator adapter, never spread from client JSON. */
export function openOperatorChat(binding: OpenAI, config: VlmConfig, messages: readonly object[], max: number, stream: boolean,
  signal: AbortSignal, guard: () => void, options: { tools?: readonly object[]; tool_choice?: unknown; parallel_tool_calls?: boolean;
    modalities?: readonly string[]; audio?: { voice: string; format: 'wav' } }) {
  const init = httpOptions(binding, { ...httpChatBody(binding, config, messages, max, stream), ...options }, signal,
    stream ? 'text/event-stream' : 'application/json')
  signal.throwIfAborted()
  guard() // Last synchronous authority/attachment boundary before the only outbound request.
  return fetch(`${binding.base}/chat/completions`, init)
}

export function requireChatStream(response: Response): ReadableStream<Uint8Array> {
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
    void response.body?.cancel().catch(() => {})
    throw new Error('The provider did not return an SSE body.')
  }
  return response.body
}

export async function modelChatStream(binding: BoundModel, config: VlmConfig, messages: ModelMessage[], max: number, signal: AbortSignal): Promise<unknown> {
  if (binding.kind === 'workers_ai') return workersChat(binding.ai, config, messages, max, true)
  return requireChatStream(await fetch(`${binding.base}/chat/completions`,
    httpOptions(binding, httpChatBody(binding, config, messages, max, true), signal, 'text/event-stream')))
}

export async function modelChat(binding: BoundModel, config: VlmConfig, messages: ModelMessage[], max: number, signal?: AbortSignal): Promise<unknown> {
  if (binding.kind === 'workers_ai') return workersChat(binding.ai, config, messages, max, false)
  const data = await post(binding, 'chat/completions', httpChatBody(binding, config, messages, max, false), config.timeout ?? 20, 256 * 1024, signal)
  const choice: unknown = Array.isArray(data.choices) && data.choices.length === 1 ? data.choices[0] : undefined
  if (!isRecord(choice) || !isRecord(choice.message) || choice.message.role !== 'assistant' || choice.message.function_call != null ||
      (choice.message.tool_calls != null && !(Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 0)) ||
      typeof choice.message.content !== 'string' || choice.message.content.includes(binding.key)) {
    throw new Error('Unexpected chat response.')
  }
  return { response: choice.message.content, usage: data.usage }
}
function decodeFloat32(value: unknown, dimension: number): number[] {
  const bytes = dimension * Float32Array.BYTES_PER_ELEMENT
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(bytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Unexpected embedding encoding.')
  }
  const decoded = atob(value)
  if (decoded.length !== bytes || btoa(decoded) !== value) throw new Error('Unexpected embedding encoding.')
  const view = new DataView(Uint8Array.from(decoded, char => char.charCodeAt(0)).buffer)
  return Array.from({ length: dimension }, (_, i) => view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true))
}

export async function modelEmbedding(binding: BoundModel, config: EmbeddingConfig, texts: string[], timeout = 20, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  if (binding.kind === 'workers_ai') {
    const result = await invoke(binding.ai, config.model, { text: texts })
    signal?.throwIfAborted()
    return result
  }
  const encoding = config.encoding_format ?? 'float'
  const data = await post(binding, 'embeddings', {
    model: config.model, input: texts, encoding_format: encoding,
    ...(binding.base === openAIBase && /^text-embedding-3-/.test(config.model) ? { dimensions: config.dimension } : {}),
  }, timeout, 2 * 1024 * 1024, signal)
  signal?.throwIfAborted()
  if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('Unexpected embedding response.')
  const ordered = new Map<number, unknown>()
  for (const row of data.data as unknown[]) {
    if (!isRecord(row) || typeof row.index !== 'number' || !Number.isSafeInteger(row.index) ||
        row.index < 0 || row.index >= texts.length || ordered.has(row.index)) throw new Error('Unexpected embedding index.')
    ordered.set(row.index, encoding === 'base64' ? decodeFloat32(row.embedding, config.dimension) : row.embedding)
  }
  return { data: texts.map((_, i) => ordered.get(i)), usage: data.usage }
}
