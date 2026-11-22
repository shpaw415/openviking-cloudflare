// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from './http.js'

export const generationModel = '@cf/meta/llama-3.1-8b-instruct'
export const embeddingModel = '@cf/baai/bge-base-en-v1.5'
export const embeddingDimensions = 768
export const configFileLimit = 16 * 1024
export const maxGenerationTokens = 2048

type Selection = { provider: 'workers_ai'; model: string } | { provider: 'openai'; model: string; api_base: string }
export type VlmConfig = Selection & { temperature?: number; max_tokens?: number; timeout?: number }
export type EmbeddingConfig = Selection & { dimension: number; input: 'text' }
export type ModelSettings = { vlm?: VlmConfig; embedding?: { dense: EmbeddingConfig }; default_search_limit?: number }
export type ModelEnv = { AI?: Ai; OPENVIKING_EDGE_GENERATION?: string; OPENVIKING_EDGE_PROVIDERS?: string }
export type BoundModel = { kind: 'workers_ai'; ai: Ai } | { kind: 'openai'; base: string; key: string }

const legacyVlm: VlmConfig = { provider: 'workers_ai', model: generationModel }
export const legacyEmbedding: EmbeddingConfig = { provider: 'workers_ai', model: embeddingModel, dimension: embeddingDimensions, input: 'text' }
export const openAIBase = 'https://api.openai.com/v1'
const bad = (message: string) => new ApiError(400, 'INVALID_ARGUMENT', message)
const unsupported = (message: string) => new ApiError(501, 'NOT_IMPLEMENTED', message)

function object(value: unknown, allowed: readonly string[], location: string): Record<string, unknown> {
  if (!isRecord(value)) throw bad(`${location} must be a JSON object.`)
  if (Object.hasOwn(value, 'api_key')) throw bad('Provider keys belong in the Workers secret, not in the configuration file.')
  if (Object.keys(value).some(key => !allowed.includes(key))) throw unsupported(`Unsupported field in ${location}.`)
  return value
}

function baseURL(value: unknown): string | undefined {
  // Exact HTTPS deployment inventory, without credentials, IPs, ports, queries or ambiguous paths.
  if (typeof value !== 'string' || value.length > 256 ||
      !/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value)) return
  const url = new URL(value)
  if (/\.(?:local|localhost|internal|lan|home|onion)$/.test(url.hostname)) return
  return url.href.replace(/\/$/, '')
}

function providerKey(env: ModelEnv, base: string): string | undefined {
  const raw = env.OPENVIKING_EDGE_PROVIDERS
  if (!raw || raw.length > 16_384) return
  try {
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries) || !entries.length || entries.length > 8) return
    const keys = new Map<string, string>()
    for (const entry of entries) {
      if (!isRecord(entry) || Object.keys(entry).length !== 2) return
      const admitted = baseURL(entry.api_base)
      if (!admitted || keys.has(admitted) || typeof entry.api_key !== 'string' || !/^[A-Za-z0-9._~+/=-]{16,2048}$/.test(entry.api_key)) return
      keys.set(admitted, entry.api_key)
    }
    return keys.get(base)
  } catch { return undefined }
}

export function bindModel(env: ModelEnv, model: Selection): BoundModel | undefined {
  if (model.provider === 'workers_ai') return env.AI ? { kind: 'workers_ai', ai: env.AI } : undefined
  const key = providerKey(env, model.api_base)
  return key ? { kind: 'openai', base: model.api_base, key } : undefined
}

export function selectedVlm(env: ModelEnv, settings: ModelSettings): VlmConfig | undefined {
  return settings.vlm ?? (env.OPENVIKING_EDGE_GENERATION === '1' ? legacyVlm : undefined)
}

function selection(value: Record<string, unknown>, env: ModelEnv): Selection {
  const { provider, model, api_base } = value
  if (typeof model !== 'string' || !/^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/.test(model) ||
      model.includes('//') || model.split('/').some(part => part === '.' || part === '..')) throw bad('A valid model name is required.')
  let selected: Selection
  if (provider === 'workers_ai') {
    if (!/^@cf\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(model) || api_base !== undefined) throw bad('Workers AI requires an @cf model and no api_base.')
    selected = { provider, model }
  } else if (provider === 'openai' || provider === 'openai-compatible' || provider === 'ollama') {
    const base = api_base === undefined && provider === 'openai' ? openAIBase : baseURL(api_base)
    if (!base) throw bad('This provider requires an approved HTTPS api_base.')
    selected = { provider: 'openai', model, api_base: base }
  } else throw unsupported('Supported providers: workers_ai, openai, openai-compatible and Ollama through its OpenAI API.')
  if (!bindModel(env, selected)) throw new ApiError(412, 'PROVIDER_NOT_CONFIGURED', 'Select a deployed Workers AI binding or an exact api_base in the Workers provider secret.')
  return selected
}

function bounded(value: unknown, min: number, max: number, name: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) {
    throw bad(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`)
  }
  return value
}

export function patchModels(current: ModelSettings, body: Record<string, unknown>, env: ModelEnv): ModelSettings {
  object(body, ['vlm', 'embedding', 'default_search_limit'], 'the configuration file')
  if (!Object.keys(body).length) throw bad('The configuration file is empty.')
  const result = { ...current }
  if (body.vlm === null) delete result.vlm
  else if (body.vlm !== undefined) {
    const value = object(body.vlm, ['provider', 'model', 'api_base', 'temperature', 'max_tokens', 'timeout'], 'vlm')
    const model: VlmConfig = selection(value, env)
    if (value.temperature !== undefined) model.temperature = bounded(value.temperature, 0, 2, 'vlm.temperature', false)
    if (value.max_tokens !== undefined) model.max_tokens = bounded(value.max_tokens, 1, maxGenerationTokens, 'vlm.max_tokens', true)
    if (value.timeout !== undefined) {
      if (model.provider !== 'openai') throw unsupported('vlm.timeout is only configurable for OpenAI-compatible HTTP providers.')
      model.timeout = bounded(value.timeout, 1, 25, 'vlm.timeout', false)
    }
    result.vlm = model
  }
  if (body.embedding === null) delete result.embedding
  else if (body.embedding !== undefined) {
    const { dense } = object(body.embedding, ['dense'], 'embedding')
    const value = object(dense, ['provider', 'model', 'api_base', 'dimension', 'input'], 'embedding.dense')
    if (value.input !== undefined && value.input !== 'text') throw unsupported('Only text embeddings are available on Edge.')
    const model = selection(value, env)
    const dimension = bounded(value.dimension, 1, 2048, 'embedding.dense.dimension', true)
    if (model.provider === 'workers_ai' && model.model === embeddingModel && dimension !== embeddingDimensions) throw bad('The default BGE model emits 768 coordinates.')
    if (model.provider === 'openai' && model.api_base === openAIBase && model.model === 'text-embedding-ada-002' && dimension !== 1536) {
      throw bad('This OpenAI embedding model emits 1536 coordinates.')
    }
    result.embedding = { dense: { ...model, dimension, input: 'text' } }
  }
  if (body.default_search_limit === null) delete result.default_search_limit
  else if (body.default_search_limit !== undefined) result.default_search_limit = bounded(body.default_search_limit, 1, 50, 'default_search_limit', true)
  return result
}
