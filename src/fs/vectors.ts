// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { emptyIndex } from './store.js'
import type { VectorIndex } from './store.js'

const SPAN = 1024
const BATCH = 16
const MAX_DIMENSIONS = 2048

export const embeddingUnavailable = () => new ApiError(503, 'EMBEDDING_UNAVAILABLE',
  'The configured embedding provider is unavailable or incompatible with the stored index.')

function normalize(value: unknown): Float32Array<ArrayBuffer> {
  if (!Array.isArray(value) || !value.length || value.length > MAX_DIMENSIONS) throw embeddingUnavailable()
  let peak = 0
  for (const coordinate of value) {
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) throw embeddingUnavailable()
    peak = Math.max(peak, Math.abs(coordinate))
  }
  if (peak === 0) throw embeddingUnavailable()
  let squared = 0
  for (const coordinate of value) squared += (coordinate / peak) ** 2
  const norm = Math.sqrt(squared)
  return Float32Array.from(value, coordinate => coordinate / peak / norm)
}

async function embed(ctx: WorkspaceContext, texts: string[], signal?: AbortSignal): Promise<Float32Array<ArrayBuffer>[]> {
  try {
    signal?.throwIfAborted()
    const response: unknown = await ctx.embed(texts, signal)
    signal?.throwIfAborted()
    if (!Array.isArray(response) || response.length !== texts.length) throw embeddingUnavailable()
    return Array.from(response, normalize)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof ApiError && error.status === 429 && error.code === 'RATE_LIMITED') throw error
    if (ctx.dataAuthority && error instanceof ApiError && ([401, 403, 409].includes(error.status) || error.code === 'AUTH_UNAVAILABLE')) throw error
    throw embeddingUnavailable()
  }
}

export async function documentIndex(ctx: WorkspaceContext, text: string): Promise<VectorIndex> {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + SPAN, text.length)
    // Never split a surrogate pair. Prefer a nearby word boundary when possible.
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf(' ', end - 1), text.lastIndexOf('\n', end - 1))
      if (boundary > start + SPAN * 0.75) end = boundary + 1
      else if ((text.charCodeAt(end) & 0xfc00) === 0xdc00) end--
    }
    const chunk = text.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    start = end
  }
  if (!chunks.length) return emptyIndex
  const vectors: Float32Array<ArrayBuffer>[] = []
  for (let i = 0; i < chunks.length; i += BATCH) vectors.push(...await embed(ctx, chunks.slice(i, i + BATCH)))
  const dimensions = vectors[0].length
  if (vectors.some(vector => vector.length !== dimensions)) throw embeddingUnavailable()
  const packed = new Float32Array(vectors.length * dimensions)
  vectors.forEach((vector, i) => packed.set(vector, i * dimensions))
  return { dimensions, vectors: packed.buffer }
}

export async function queryVector(ctx: WorkspaceContext, query: string, context = '', signal?: AbortSignal) {
  if (!context) return (await embed(ctx, [query], signal))[0]
  const [raw, qualified] = await embed(ctx, [query, `Recent user context:\n${context}\n\nCurrent query:\n${query}`], signal)
  if (raw.length !== qualified.length) throw embeddingUnavailable()
  // Keep the request primary; recent history can disambiguate it but cannot
  // replace it with a new retrieval plan or select targets/provenance fields.
  return normalize(Array.from(raw, (value, i) => 0.65 * value + 0.35 * qualified[i]))
}

export function cosine(query: Float32Array, packed: ArrayBuffer, dimensions: number): number {
  if (dimensions !== query.length) throw embeddingUnavailable()
  const stored = new Float32Array(packed)
  let best = -1
  for (let i = 0; i < stored.length; i += dimensions) {
    let dot = 0
    for (let j = 0; j < dimensions; j++) dot += query[j] * stored[i + j]
    best = Math.max(best, dot)
  }
  return Math.min(best, 1)
}
