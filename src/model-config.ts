// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from './http.js'
import { isProviderCredential } from './provider-credential.js'

export const generationModel = '@cf/meta/llama-3.1-8b-instruct'
export const embeddingModel = '@cf/baai/bge-base-en-v1.5'
export const embeddingDimensions = 768
export const configFileLimit = 16 * 1024
export const maxGenerationTokens = 2048
export const embeddingBatchLimit = 32
export const edgeSearchDefaults = { limit: 10, score: 0.1, sessionContext: true } as const
export const searchSessionLimits = { messages: 4, chars: 1024, perMessageChars: 256 } as const
export const edgeSessionDefaults = { contextTokens: 128_000, extractionTokens: 1536, messageThreshold: 100, pendingTokenThreshold: 150_000 } as const
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

type Selection = { provider: 'workers_ai'; model: string } | { provider: 'openai'; model: string; api_base: string }
export type VlmConfig = Selection & { temperature?: number; max_tokens?: number; timeout?: number; reasoning_effort?: ReasoningEffort;
  top_p?: number; max_concurrent?: number }
export type EmbeddingConfig = Selection & { dimension: number; input: 'text'; batch_size?: number; encoding_format?: 'float' | 'base64' }
export type RerankConfig = { provider: 'openai'; model: string; api_base: string; timeout: number; threshold: number; max_input_tokens: number }
export type RetrievalSettings = { enable_intent?: false; session_context_messages?: number; session_context_chars?: number;
  edge_context_rewrite?: boolean; recall_rewrite_timeout_s?: number; apply_rerank_to_context?: boolean }
export type MemorySettings = {
  extraction_enabled?: boolean
  edge_context_token_budget?: number
  edge_extraction_max_tokens?: number
  session_auto_commit?: { enabled: boolean; message_count_threshold?: number; pending_token_threshold?: number }
}
export type ModelSettings = { vlm?: VlmConfig; embedding?: { dense: EmbeddingConfig }; default_search_limit?: number;
  default_search_score_threshold?: number; retrieval?: RetrievalSettings; rerank?: RerankConfig; memory?: MemorySettings }
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

export function providerKey(env: ModelEnv, base: string): string | undefined {
  const raw = env.OPENVIKING_EDGE_PROVIDERS
  if (!raw || raw.length > 16_384) return
  try {
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries) || !entries.length || entries.length > 8) return
    const keys = new Map<string, string>()
    for (const entry of entries) {
      if (!isRecord(entry) || Object.keys(entry).length !== 2) return
      const admitted = baseURL(entry.api_base)
      if (!admitted || keys.has(admitted) || !isProviderCredential(entry.api_key)) return
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

export function bindReranker(env: ModelEnv, config: RerankConfig): { endpoint: string; key: string } | undefined {
  const key = providerKey(env, config.api_base)
  return key ? { endpoint: config.api_base, key } : undefined
}

export function selectedVlm(env: ModelEnv, settings: ModelSettings): VlmConfig | undefined {
  return settings.vlm ?? (env.OPENVIKING_EDGE_GENERATION === '1' ? legacyVlm : undefined)
}

function modelName(model: unknown): string {
  if (typeof model !== 'string' || !/^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/.test(model) ||
      model.includes('//') || model.split('/').some(part => part === '.' || part === '..')) throw bad('A valid model name is required.')
  return model
}

function selection(value: Record<string, unknown>, env: ModelEnv): Selection {
  const { provider, api_base } = value, model = modelName(value.model)
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

function selectProfile(value: Record<string, unknown>, env: ModelEnv, name: string): Selection {
  if (value.backend !== undefined && value.provider !== undefined && value.backend !== value.provider) throw bad(`${name}.backend and ${name}.provider must match.`)
  return selection({ ...value, provider: value.provider ?? value.backend }, env)
}

function bounded(value: unknown, min: number, max: number, name: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value)) {
    throw bad(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`)
  }
  return value
}

function memorySettings(raw: unknown): MemorySettings {
  const value = object(raw, ['extraction_enabled', 'edge_context_token_budget', 'edge_extraction_max_tokens', 'session_auto_commit'], 'memory')
  if (!Object.keys(value).length) throw bad('Use memory:null to reset memory settings.')
  const result: MemorySettings = {}
  if (value.extraction_enabled !== undefined) {
    if (typeof value.extraction_enabled !== 'boolean') throw bad('memory.extraction_enabled must be a boolean.')
    result.extraction_enabled = value.extraction_enabled
  }
  if (value.edge_context_token_budget !== undefined) result.edge_context_token_budget =
    bounded(value.edge_context_token_budget, 0, edgeSessionDefaults.contextTokens, 'memory.edge_context_token_budget', true)
  if (value.edge_extraction_max_tokens !== undefined) result.edge_extraction_max_tokens =
    bounded(value.edge_extraction_max_tokens, 1, edgeSessionDefaults.extractionTokens, 'memory.edge_extraction_max_tokens', true)
  if (value.session_auto_commit !== undefined) {
    const section = 'memory.session_auto_commit'
    const auto = object(value.session_auto_commit, ['enabled', 'message_count_threshold', 'pending_token_threshold'], section)
    if (typeof auto.enabled !== 'boolean') throw bad(`${section}.enabled must be a boolean.`)
    const policy: NonNullable<MemorySettings['session_auto_commit']> = { enabled: auto.enabled }
    if (auto.message_count_threshold !== undefined) policy.message_count_threshold =
      bounded(auto.message_count_threshold, 0, edgeSessionDefaults.messageThreshold, `${section}.message_count_threshold`, true)
    if (auto.pending_token_threshold !== undefined) policy.pending_token_threshold =
      bounded(auto.pending_token_threshold, 0, edgeSessionDefaults.pendingTokenThreshold, `${section}.pending_token_threshold`, true)
    if ((!auto.enabled && Object.keys(policy).length > 1) || (policy.message_count_threshold === 0 && policy.pending_token_threshold === 0)) {
      throw bad(`${section}: thresholds require an enabled policy with at least one active trigger.`)
    }
    result.session_auto_commit = policy
  }
  if (result.extraction_enabled === false && result.edge_extraction_max_tokens !== undefined) {
    throw bad('An extraction token budget requires extraction to be enabled.')
  }
  return result
}

export function patchModels(current: ModelSettings, body: Record<string, unknown>, env: ModelEnv): ModelSettings {
  object(body, ['vlm', 'embedding', 'default_search_limit', 'default_search_score_threshold', 'retrieval', 'rerank', 'memory'], 'the configuration file')
  if (!Object.keys(body).length) throw bad('The configuration file is empty.')
  const result = { ...current }
  if (body.vlm === null) delete result.vlm
  else if (body.vlm !== undefined) {
    const value = object(body.vlm, ['provider', 'backend', 'model', 'api_base', 'temperature', 'max_tokens', 'timeout', 'reasoning_effort', 'top_p', 'max_concurrent'], 'vlm')
    const model: VlmConfig = selectProfile(value, env, 'vlm')
    if (value.temperature != null) model.temperature = bounded(value.temperature, 0, 2, 'vlm.temperature', false)
    if (value.max_tokens != null) model.max_tokens = bounded(value.max_tokens, 1, maxGenerationTokens, 'vlm.max_tokens', true)
    if (value.timeout !== undefined) {
      if (model.provider !== 'openai') throw unsupported('vlm.timeout is only configurable for OpenAI-compatible HTTP providers.')
      model.timeout = bounded(value.timeout, 1, 25, 'vlm.timeout', false)
    }
    if (value.reasoning_effort != null) {
      if (model.provider !== 'openai') throw unsupported('vlm.reasoning_effort requires a compatible HTTP chat model.')
      if (!reasoningEfforts.includes(value.reasoning_effort as ReasoningEffort)) throw bad('Unsupported vlm.reasoning_effort value.')
      model.reasoning_effort = value.reasoning_effort as ReasoningEffort
    }
    if (value.top_p != null) {
      if (model.provider !== 'openai') throw unsupported('vlm.top_p requires a compatible HTTP chat model.')
      model.top_p = bounded(value.top_p, 0, 1, 'vlm.top_p', false)
    }
    if (value.max_concurrent !== undefined) model.max_concurrent = bounded(value.max_concurrent, 1, 8, 'vlm.max_concurrent', true)
    result.vlm = model
  }
  if (body.embedding === null) delete result.embedding
  else if (body.embedding !== undefined) {
    const { dense } = object(body.embedding, ['dense'], 'embedding')
    const value = object(dense, ['provider', 'backend', 'model', 'api_base', 'dimension', 'input', 'batch_size', 'encoding_format'], 'embedding.dense')
    if (value.input !== undefined && value.input !== 'text') throw unsupported('Only text embeddings are available on Edge.')
    const model = selectProfile(value, env, 'embedding.dense')
    const dimension = bounded(value.dimension, 1, 2048, 'embedding.dense.dimension', true)
    if (model.provider === 'workers_ai' && model.model === embeddingModel && dimension !== embeddingDimensions) throw bad('The default BGE model emits 768 coordinates.')
    if (model.provider === 'openai' && model.api_base === openAIBase && model.model === 'text-embedding-ada-002' && dimension !== 1536) {
      throw bad('This OpenAI embedding model emits 1536 coordinates.')
    }
    const selected: EmbeddingConfig = { ...model, dimension, input: 'text' }
    if (value.batch_size !== undefined || value.encoding_format !== undefined) {
      if (model.provider !== 'openai') throw unsupported('Embedding batch_size and encoding_format require compatible HTTP embeddings.')
      if (value.batch_size !== undefined) selected.batch_size = bounded(value.batch_size, 1, embeddingBatchLimit, 'embedding.dense.batch_size', true)
      if (value.encoding_format !== undefined) {
        if (value.encoding_format !== 'float' && value.encoding_format !== 'base64') throw bad('embedding.dense.encoding_format must be float or base64.')
        selected.encoding_format = value.encoding_format
      }
    }
    result.embedding = { dense: selected }
  }
  if (body.default_search_limit === null) delete result.default_search_limit
  else if (body.default_search_limit !== undefined) result.default_search_limit = bounded(body.default_search_limit, 1, 50, 'default_search_limit', true)
  if (body.default_search_score_threshold === null) delete result.default_search_score_threshold
  else if (body.default_search_score_threshold !== undefined) {
    result.default_search_score_threshold = bounded(body.default_search_score_threshold, 0, 1, 'default_search_score_threshold', false)
  }
  if (body.retrieval === null) delete result.retrieval
  else if (body.retrieval !== undefined) {
    const value = object(body.retrieval, ['enable_intent', 'session_context_messages', 'session_context_chars',
      'edge_context_rewrite', 'recall_rewrite_timeout_s', 'apply_rerank_to_context'], 'retrieval')
    if (!Object.keys(value).length) throw bad('Use retrieval:null to reset retrieval settings.')
    if (value.enable_intent !== undefined && typeof value.enable_intent !== 'boolean') throw bad('retrieval.enable_intent must be a boolean.')
    if (value.enable_intent) throw unsupported('Edge does not run the upstream LLM intent planner. Use false or reset retrieval to null for local session context.')
    const retrieval: RetrievalSettings = {}
    if (value.enable_intent === false) retrieval.enable_intent = false
    if (value.session_context_messages !== undefined) retrieval.session_context_messages =
      bounded(value.session_context_messages, 1, searchSessionLimits.messages, 'retrieval.session_context_messages', true)
    if (value.session_context_chars !== undefined) retrieval.session_context_chars =
      bounded(value.session_context_chars, 64, searchSessionLimits.chars, 'retrieval.session_context_chars', true)
    if (value.edge_context_rewrite !== undefined) {
      if (typeof value.edge_context_rewrite !== 'boolean') throw bad('retrieval.edge_context_rewrite must be a boolean.')
      retrieval.edge_context_rewrite = value.edge_context_rewrite
    }
    if (value.apply_rerank_to_context !== undefined) {
      if (typeof value.apply_rerank_to_context !== 'boolean') throw bad('retrieval.apply_rerank_to_context must be a boolean.')
      retrieval.apply_rerank_to_context = value.apply_rerank_to_context
    }
    if (value.recall_rewrite_timeout_s !== undefined) retrieval.recall_rewrite_timeout_s =
      bounded(value.recall_rewrite_timeout_s, 0.1, 3, 'retrieval.recall_rewrite_timeout_s', false)
    if (retrieval.enable_intent === false && (retrieval.session_context_chars !== undefined || retrieval.session_context_messages !== undefined)) {
      throw bad('Session context budgets require local session context, not raw-query mode.')
    }
    result.retrieval = retrieval
  }
  if (body.memory === null) delete result.memory
  else if (body.memory !== undefined) result.memory = memorySettings(body.memory)
  if (body.rerank === null) delete result.rerank
  else if (body.rerank !== undefined) {
    const value = object(body.rerank, ['provider', 'model', 'api_base', 'timeout', 'threshold', 'max_input_tokens'], 'rerank')
    if (value.provider !== 'openai') throw unsupported('Reranking requires the compatible HTTP rank protocol.')
    const api_base = baseURL(value.api_base)
    if (!api_base || new URL(api_base).pathname === '/') throw bad('rerank.api_base must be the full approved HTTPS endpoint.')
    const config: RerankConfig = { provider: 'openai', model: modelName(value.model), api_base,
      timeout: value.timeout === undefined ? 3 : bounded(value.timeout, 0.1, 10, 'rerank.timeout', false),
      threshold: value.threshold === undefined ? 0.1 : bounded(value.threshold, 0, 1, 'rerank.threshold', false),
      max_input_tokens: value.max_input_tokens === undefined || value.max_input_tokens === 0 ? 0 :
        bounded(value.max_input_tokens, 128, 1024, 'rerank.max_input_tokens', true),
    }
    if (!bindReranker(env, config)) throw new ApiError(412, 'PROVIDER_NOT_CONFIGURED', 'Register the exact rerank endpoint in the Workers provider secret.')
    result.rerank = config
  }
  return result
}
