// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from './http.js'

// The committed vector store has this model contract; changing it requires reindexing.
export const embeddingModel = '@cf/baai/bge-base-en-v1.5'
export const embeddingDimensions = 768
const unavailable = () => new ApiError(503, 'EMBEDDING_UNAVAILABLE', 'The configured embedding provider is unavailable.')

export async function embed(ai: Ai | undefined, texts: string[], reserve: (count: number) => void, report?: (tokens: number) => void): Promise<number[][]> {
  if (!ai) throw unavailable()
  if (!texts.length || texts.length > 32 || texts.some(text => typeof text !== 'string' || text.length > 4096)) {
    throw new ApiError(400, 'INVALID_ARGUMENT', 'The embedding batch exceeds the Worker limits.')
  }
  reserve(texts.length)
  try {
    const data: unknown = await ai.run(embeddingModel, { text: texts })
    if (!isRecord(data) || !Array.isArray(data.data) || data.data.length !== texts.length) throw unavailable()
    const vectors=data.data.map((vector: unknown) => {
      if (!Array.isArray(vector) || vector.length !== embeddingDimensions ||
          !vector.every(value => typeof value === 'number' && Number.isFinite(value)) ||
          !vector.some(value => value !== 0)) throw unavailable()
      return vector as number[]
    })
    if(isRecord(data.usage)) {
      const count=data.usage.prompt_tokens??data.usage.total_tokens
      if(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=1_000_000)report?.(count)
    }
    return vectors
  } catch {
    throw unavailable()
  }
}
