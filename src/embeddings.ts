// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from './http.js'
import { legacyEmbedding } from './model-config.js'
import type { BoundModel, EmbeddingConfig } from './model-config.js'
import { modelEmbedding } from './model-runtime.js'

export { embeddingModel, embeddingDimensions } from './model-config.js'
const unavailable = () => new ApiError(503, 'EMBEDDING_UNAVAILABLE', 'The configured embedding provider is unavailable.')

export function embeddingVectors(data: unknown, count: number, dimension: number): number[][] {
  if (!isRecord(data) || !Array.isArray(data.data) || data.data.length !== count) throw unavailable()
  return data.data.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.length !== dimension ||
        !vector.every(value => typeof value === 'number' && Number.isFinite(value)) ||
        !vector.some(value => value !== 0)) throw unavailable()
    return vector as number[]
  })
}

export async function embed(binding: BoundModel | undefined, config: EmbeddingConfig, texts: string[], reserve: (count: number) => void,
  report?: (tokens: number) => void): Promise<number[][]> {
  if (!binding) throw unavailable()
  if (!texts.length || texts.length > 32 || texts.some(text => typeof text !== 'string' || text.length > 4096)) {
    throw new ApiError(400, 'INVALID_ARGUMENT', 'The embedding batch exceeds the Worker limits.')
  }
  reserve(texts.length)
  try {
    const data = await modelEmbedding(binding, config, texts)
    const vectors = embeddingVectors(data, texts.length, config.dimension)
    if (isRecord(data) && isRecord(data.usage)) {
      const count=data.usage.prompt_tokens??data.usage.total_tokens
      if(typeof count==='number'&&Number.isSafeInteger(count)&&count>=0&&count<=1_000_000)report?.(count)
    }
    return vectors
  } catch {
    throw unavailable()
  }
}

export function initEmbeddingSelection(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_embedding_selection (
    id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL CHECK(json_valid(model))
  )`)
}

export function workspaceEmbedding(sql: SqlStorage, account: string, selected: EmbeddingConfig): EmbeddingConfig {
  const pin = sql.exec<{ model: string }>('SELECT model FROM ov_edge_embedding_selection WHERE id=1').toArray()[0]
  if (pin) return JSON.parse(pin.model) as EmbeddingConfig
  // An instance upgraded from the fixed BGE runtime has no pin yet. Both vector tables
  // are considered before any new default is used; dimensions alone are not a model ID.
  const prior = sql.exec<{ present: number }>(`SELECT EXISTS (
    SELECT 1 FROM ov_edge_fs_entry WHERE account_id=? AND dimensions>0
    UNION ALL SELECT 1 FROM ov_edge_fs_file_level WHERE account_id=?
  ) AS present`, account, account).one()
  return prior.present ? legacyEmbedding : selected
}

export function pinEmbedding(sql: SqlStorage, config: EmbeddingConfig): void {
  const serialized = JSON.stringify(config)
  sql.exec('INSERT OR IGNORE INTO ov_edge_embedding_selection(id,model) VALUES (1,?)', serialized)
  if (sql.exec<{ model: string }>('SELECT model FROM ov_edge_embedding_selection WHERE id=1').one().model !== serialized) {
    throw unavailable() // A racing first successful call picked a different default; never mix vectors.
  }
}
