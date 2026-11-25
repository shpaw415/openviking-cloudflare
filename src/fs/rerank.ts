// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { reserveModelBudget } from '../generation.js'
import { ApiError, isRecord, readJson } from '../http.js'
import { bindReranker } from '../model-config.js'
import type { ModelEnv, RerankConfig } from '../model-config.js'
import { estimateText } from '../session/protocol.js'

const utf8 = new TextEncoder()
const unavailable = () => new ApiError(503, 'RERANK_UNAVAILABLE', 'The configured ranking provider is unavailable.')

function head(input: string, maxBytes: number, maxTokens: number): string {
  // Shortlist text may be large; never encode more than the bounded UTF-16 prefix.
  const text = input.slice(0, maxBytes + 1)
  let low = 0, high = Math.min(maxBytes, text.length)
  while (low < high) {
    const n = Math.ceil((low + high) / 2), prefix = text.slice(0, n)
    if (utf8.encode(prefix).length <= maxBytes && estimateText(prefix) <= maxTokens) low = n
    else high = n - 1
  }
  if ((text.charCodeAt(low) & 0xfc00) === 0xdc00) low--
  return text.slice(0, low)
}

export function searchReranker(ctx: WorkspaceContext, env: ModelEnv, config: RerankConfig): NonNullable<WorkspaceContext['searchReranker']> {
  const binding = bindReranker(env, config)
  return { threshold: config.threshold, async score(query, documents, signal) {
    if (!binding) throw unavailable()
    const pairLimit = config.max_input_tokens || Infinity
    const prompt = head(query, 1024, Math.floor(pairLimit * 0.75))
    const textBudget = pairLimit - estimateText(prompt)
    const body = JSON.stringify({ model: config.model, query: prompt,
      documents: documents.map(text => head(text, 768, textBudget)), top_n: documents.length })
    // JSON escaping can expand UTF-8. Cap its serialized size too and charge the
    // same durable per-account/per-user model budget as generation.
    const size = utf8.encode(body).length
    if (size > 64 * 1024) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'The ranking shortlist exceeded its byte limit.')
    signal.throwIfAborted()
    ctx.assertActive?.()
    reserveModelBudget(ctx, size)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(config.timeout * 1000))])
    let response: Response | undefined
    try {
      response = await fetch(binding.endpoint, { method: 'POST', redirect: 'manual', signal: deadline,
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${binding.key}` }, body })
      if (response.status !== 200) throw unavailable()
      const { results } = await readJson(response, 16 * 1024, deadline)
      if (!Array.isArray(results) || results.length !== documents.length) throw unavailable()
      const ordered = new Map<number, number>()
      for (const item of results as unknown[]) {
        if (!isRecord(item)) throw unavailable()
        const index = item.index, score = item.relevance_score ?? item.relevance_scores
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= documents.length || ordered.has(index) ||
            typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw unavailable()
        ordered.set(index, score)
      }
      return documents.map((_, i) => ordered.get(i)!)
    } catch {
      if (!response?.body?.locked) void response?.body?.cancel().catch(() => {})
      throw unavailable()
    }
  } }
}
