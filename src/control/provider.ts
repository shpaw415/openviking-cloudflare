// SPDX-License-Identifier: AGPL-3.0-only
import { embeddingDimensions, embeddingModel } from '../embeddings.js'
import { generationModel } from '../generation.js'
import { ApiError, isRecord } from '../http.js'
import { bad, fields } from './input.js'

export type ModelProbeBinding = { run(model: string, input: unknown): Promise<unknown> }

export function probeKind(body: Record<string, unknown>): 'embedding' | 'vlm' {
  fields(body, ['kind', 'config', 'fallback', 'thinking', 'mode'])
  const { kind, config, fallback, thinking, mode } = body
  if ((kind !== 'embedding' && kind !== 'vlm') || !isRecord(config) ||
    (fallback !== undefined && (!isRecord(fallback) || Object.keys(fallback).length)) ||
    (thinking !== undefined && thinking !== null && thinking !== false) || (mode !== undefined && mode !== 'dense')) {
    throw bad('Only a bound Edge model can be probed; fallback, thinking and sparse modes are not supported.')
  }
  fields(config, kind === 'embedding' ? ['provider', 'model', 'dimension'] : ['provider', 'model'])
  if (config.provider !== 'workers_ai' || config.model !== (kind === 'embedding' ? embeddingModel : generationModel) ||
      (config.dimension !== undefined && config.dimension !== embeddingDimensions)) {
    throw bad('Model probe must target the deployment-allowlisted Workers AI model.')
  }
  return kind
}

export async function probeModel(ai: ModelProbeBinding | undefined, kind: 'embedding' | 'vlm', reserve: () => void) {
  if (!ai) throw new ApiError(503, 'MODEL_PROBE_UNAVAILABLE', 'No approved model binding is configured.')
  reserve()
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      kind === 'embedding' ? ai.run(embeddingModel, { text: ['OpenViking Edge model probe.'] })
        : ai.run(generationModel, { messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 8, stream: false }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Probe timed out.')), 5000) }),
    ])
    const ms = Math.max(0, Date.now() - started)
    if (isRecord(response)) {
      if (kind === 'vlm' && typeof response.response === 'string' && response.response.length <= 1024 && response.response.trim()) return { ok: true, ms }
      if (kind === 'embedding' && Array.isArray(response.data) && response.data.length === 1) {
        const [vector] = response.data
        if (Array.isArray(vector) && vector.length === embeddingDimensions && vector.every(Number.isFinite) && vector.some(value => value !== 0)) return { ok: true, ms }
      }
    }
    return { ok: false, ms, error: 'The bound model returned an invalid response.' }
  } catch {
    return { ok: false, ms: Math.max(0, Date.now() - started), error: 'The bound model did not complete the probe.' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
