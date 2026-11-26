// SPDX-License-Identifier: AGPL-3.0-only
import { int, invalid, onlyKeys, quota } from './contract.js'
import { isRecord } from '../http.js'

// Local BM25 over the authorized SQLite snapshot, with no separate index that
// could retain stale bodies or mix corpus statistics across visibility scopes.
const words = (text: string) => text.normalize('NFC').toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)

export function keywordSearch(query: string, args: unknown, limit: number) {
  const terms = [...new Set(Array.from(words(query), match => match[0]))]
  if (!terms.length || terms.length > 64) invalid('Keyword search requires one to 64 distinct words.')
  if (args != null && !isRecord(args)) invalid('args must be an object.')
  const options = args ?? {}
  onlyKeys(options, 'bm25_k1 bm25_b post_process_input_limit')
  const k = Object.hasOwn(options, 'bm25_k1') ? options.bm25_k1 : 1.2
  const b = Object.hasOwn(options, 'bm25_b') ? options.bm25_b : 0.75
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) invalid('args.bm25_k1 must be positive and finite.')
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0 || b > 1) invalid('args.bm25_b must be between 0 and 1.')
  const window = int(options.post_process_input_limit, 'args.post_process_input_limit', 2_000_000, limit, 2_000_000)
  const offsets = new Map(terms.map((term, i) => [term, i]))
  const frequencies = new Uint32Array(terms.length)
  let corpus = 0, size = 0, bytes = 0
  return {
    window,
    collect(body: () => string, storedBytes: number) {
      if (bytes + storedBytes > 8 * 1024 * 1024 || corpus >= 4096) quota('Keyword scan exceeds its local budget; narrow the search scope.')
      bytes += storedBytes
      const counts = new Uint32Array(terms.length)
      let length = 0
      for (const match of words(body())) {
        length++
        const index = offsets.get(match[0])
        if (index !== undefined) {
          if (!counts[index]) frequencies[index]++
          counts[index]++
        }
      }
      size += length
      corpus++
      if (!counts.some(Boolean)) return undefined
      return () => {
        let score = 0
        const relative = length * corpus / Math.max(1, size)
        const lengthFactor = 1 - b + b * relative
        for (let i = 0; i < counts.length; i++) if (counts[i]) {
          const tf = counts[i], df = frequencies[i]
          // Algebraically equivalent weights, without overflow for large k1.
          const weight = tf / (tf / (1 + k) + (k / (1 + k)) * lengthFactor)
          score += Math.log1p((corpus - df + 0.5) / (df + 0.5)) * weight
        }
        return score / (1 + score)
      }
    },
  }
}
