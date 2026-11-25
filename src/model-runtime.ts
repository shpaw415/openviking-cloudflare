// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMessage } from './context.js'
import { isRecord, readJson } from './http.js'
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

async function post(binding: OpenAI, operation: 'chat/completions' | 'embeddings', body: object, timeout: number, limit: number) {
  const response = await fetch(`${binding.base}/${operation}`,
    httpOptions(binding, body, AbortSignal.timeout(Math.ceil(timeout * 1000)), 'application/json'))
  try {
    if (response.status !== 200) throw new Error('Model request failed.')
    return await readJson(response, limit)
  } catch (error) {
    if (!response.body?.locked) void response.body?.cancel().catch(() => {})
    throw error // Callers replace provider errors with a static message.
  }
}

export function workersChat(ai: Ai, config: VlmConfig, messages: ModelMessage[], max: number, stream: boolean) {
  return invoke(ai, config.model, { messages, max_tokens: max, stream,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }) })
}

function httpChatBody(binding: OpenAI, config: VlmConfig, messages: ModelMessage[], max: number, stream: boolean) {
  return {
    model: config.model, messages, stream,
    ...(binding.base === openAIBase ? { max_completion_tokens: max } : { max_tokens: max }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.reasoning_effort === undefined ? {} : { reasoning_effort: config.reasoning_effort }),
    // Only the official endpoint is known to support this option. Other
    // compatible providers may send usage themselves; never retry without it.
    ...(stream && binding.base === openAIBase && { stream_options: { include_usage: true } }),
  }
}

export async function modelChatStream(binding: BoundModel, config: VlmConfig, messages: ModelMessage[], max: number, signal: AbortSignal): Promise<unknown> {
  if (binding.kind === 'workers_ai') return workersChat(binding.ai, config, messages, max, true)
  const response = await fetch(`${binding.base}/chat/completions`,
    httpOptions(binding, httpChatBody(binding, config, messages, max, true), signal, 'text/event-stream'))
  if (response.status !== 200 || !response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'text/event-stream') {
    void response.body?.cancel().catch(() => {})
    throw new Error('The provider did not return an SSE body.')
  }
  return response.body
}

export async function modelChat(binding: BoundModel, config: VlmConfig, messages: ModelMessage[], max: number): Promise<unknown> {
  if (binding.kind === 'workers_ai') return workersChat(binding.ai, config, messages, max, false)
  const data = await post(binding, 'chat/completions', httpChatBody(binding, config, messages, max, false), config.timeout ?? 20, 256 * 1024)
  const choice: unknown = Array.isArray(data.choices) && data.choices.length === 1 ? data.choices[0] : undefined
  if (!isRecord(choice) || !isRecord(choice.message) || choice.message.role !== 'assistant' || choice.message.function_call != null ||
      (choice.message.tool_calls != null && !(Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length === 0)) ||
      typeof choice.message.content !== 'string' || choice.message.content.includes(binding.key)) {
    throw new Error('Unexpected chat response.')
  }
  return { response: choice.message.content, usage: data.usage }
}
export async function modelEmbedding(binding: BoundModel, config: EmbeddingConfig, texts: string[], timeout = 20): Promise<unknown> {
  if (binding.kind === 'workers_ai') return invoke(binding.ai, config.model, { text: texts })
  const data = await post(binding, 'embeddings', {
    model: config.model, input: texts, encoding_format: 'float',
    ...(binding.base === openAIBase && /^text-embedding-3-/.test(config.model) ? { dimensions: config.dimension } : {}),
  }, timeout, 2 * 1024 * 1024)
  if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('Unexpected embedding response.')
  const ordered = new Map<number, unknown>()
  for (const row of data.data as unknown[]) {
    if (!isRecord(row) || typeof row.index !== 'number' || !Number.isSafeInteger(row.index) ||
        row.index < 0 || row.index >= texts.length || ordered.has(row.index)) throw new Error('Unexpected embedding index.')
    ordered.set(row.index, row.embedding)
  }
  return { data: texts.map((_, i) => ordered.get(i)), usage: data.usage }
}
