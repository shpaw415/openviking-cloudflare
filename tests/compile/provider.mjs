// SPDX-License-Identifier: AGPL-3.0-only
// Workerd-side fixture: only the AI provider is replaced. No networking or tools.
const response = (value) => ({ response: JSON.stringify(value), usage: { prompt_tokens: 14, completion_tokens: 12 } })

export const ai = {
  async run(model, request) {
    if (model === '@cf/baai/bge-base-en-v1.5') {
      if (request.text.some(text => text.includes('fixture refused this embedding'))) throw new Error('broken test embedding')
      if (request.text.some(text => text.includes('fixture slow scheduled index'))) await new Promise(resolve => setTimeout(resolve, 1400))
      else if (request.text.some(text => text.includes('fixture slow index'))) await new Promise(resolve => setTimeout(resolve, 700))
      return { data: request.text.map(text => {
        const vector = Array(768).fill(0)
        vector[0] = 0.00001
        for (const term of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          const word = /^(boat|boats|sailing|maritime)$/u.test(term) ? 'marine' : term
          let hash = 0
          for (const char of word) hash = (31 * hash + char.charCodeAt(0)) >>> 0
          vector[1 + hash % 767]++
        }
        return vector
      }) }
    }
    if (model !== '@cf/meta/llama-3.1-8b-instruct' || request.max_tokens !== 2048 || request.stream !== false ||
        request.messages[0]?.role !== 'system' || request.messages[1]?.role !== 'user') throw new Error('Unexpected provider request')
    const material = JSON.parse(request.messages[1].content)
    if (material.kind === 'rule-judge') {
      return response({ scores: material.rules.map(item => ({ id: item.id,
        applies: material.task_context.includes('sailing') ? 0.94 : 0.1,
        exception: material.task_context.includes('emergency') ? 0.99 : 0 })) })
    }
    if (material.kind === 'rule-compile') {
      const source = material.documents[0]
      const text = material.instruction || source.text
      const target = material.rules[0]
      const evidence_spans = [text.includes('fixture bad evidence') ? 'Absent from source' : text.slice(0, 250)]
      if (target && /pause|restore|archive/i.test(text)) {
        const operation = /pause/i.test(text) ? 'PAUSE' : /restore/i.test(text) ? 'RESTORE' : 'ARCHIVE'
        return response({ mutations: [{ operation, target_ids: [target.atomic_id], evidence_spans }] })
      }
      return response({ mutations: [{ operation: 'NEW', evidence_spans, applicability_evidence: evidence_spans[0],
        scenario: { scenario_id: 'sailing', name: 'Sailing', description: 'Marine boat sailing safety checks' },
        record: { name: 'departure', description: 'Boat departure checks', content: 'Check the boat before sailing.',
          applies_when: 'Preparing to sail', exception: 'Emergency departure' } }], reason: 'Source supports a departure check.' })
    }
    if (material.kind !== 'artifact-compile' || !material.documents?.length || !material.skill?.text) throw new Error('Invalid compile scope')
    const evidence = material.documents[0]
    if (material.instruction === 'fixture invalid JSON') return { response: 'Not JSON' }
    const index = { path: 'index.md', content: `# Sailing guide\n\nThe ${evidence.text.includes('Saturday') ? 'Saturday' : 'Friday'} boat guide links [checks](topics/checks.md).`,
      citations: [{ uri: evidence.uri, quote: evidence.text.split('\n')[0] }] }
    const second = { path: 'topics/checks.md', content: '# Sailing checks\n\nCarry out the marine safety check.', citations: index.citations }
    if (material.instruction === 'fixture invalid citation') second.citations = [{ uri: evidence.uri, quote: 'invented' }]
    if (material.instruction === 'fixture index failure') second.content = 'fixture refused this embedding'
    if (material.instruction === 'fixture cancellation') second.content = '# Sailing checks\n\nfixture slow index'
    if (material.instruction === 'fixture scheduled cancellation') second.content = '# Sailing checks\n\nfixture slow scheduled index'
    return response({ artifacts: [index, second] })
  },
}
