// SPDX-License-Identifier: AGPL-3.0-only
import type { GatewayError, Protocol } from './contract.js'
import type { Finish, Usage } from './sse-source.js'
import type { ResponseMeta } from './wire.js'

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const event = (type: string, value: Record<string, unknown> = {}) => `event: ${type}\n${data({ type, ...value })}`

export function sseWire(protocol: Protocol, model: string, requestId: string, note: string, includeUsage: boolean, meta?: ResponseMeta) {
  const nonce = requestId.replace(/-/g, '')
  const created = Math.floor(Date.now() / 1000)
  const id = protocol === 'chat' ? `chatcmpl-${nonce}` : protocol === 'responses' ? `resp_${nonce}` : `msg_${nonce}`
  const itemId = `msg_${nonce}_0`
  const prefix = note ? `${note}\n\n` : ''
  let sequence_number = 0
  const responsesEvent = (name: string, value: Record<string, unknown>) => event(name, { sequence_number: sequence_number++, ...value })
  const chat = (delta: Record<string, unknown>, finish_reason: Finish = null) => data({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...(includeUsage && { usage: null }) })
  const part = (text: string) => ({ type: 'output_text', text, annotations: [] })
  const item = (content: ReturnType<typeof part>[], status: 'in_progress' | 'completed' | 'incomplete') => ({ id: itemId,
    type: 'message', role: 'assistant', status, content })
  const response = (status: string, output: ReturnType<typeof item>[], usage: Usage | null, incomplete_details: { reason: string } | null = null) => ({
    id, object: 'response', created_at: created, status, model, output, error: null, incomplete_details, ...meta,
    usage: usage && usage.inputTokens !== null && usage.outputTokens !== null ? {
      input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens,
    } : null,
  })
  const indices = { item_id: itemId, output_index: 0, content_index: 0 }
  const delta = (text: string): string => {
    if (protocol === 'chat') return chat({ content: text })
    if (protocol === 'responses') return responsesEvent('response.output_text.delta', { ...indices, delta: text, logprobs: [] })
    return event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
  }
  return {
    opening() {
      let out: string
      if (protocol === 'chat') out = chat({ role: 'assistant', content: '' })
      else if (protocol === 'responses') out = responsesEvent('response.created', { response: response('in_progress', [], null) }) +
        responsesEvent('response.in_progress', { response: response('in_progress', [], null) }) +
        responsesEvent('response.output_item.added', { output_index: 0, item: item([], 'in_progress') }) +
        responsesEvent('response.content_part.added', { ...indices, part: part('') })
      else out = event('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: null, output_tokens: null } } }) +
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      return out + (prefix ? delta(prefix) : '')
    },
    delta,
    snapshot(text: string, usage: Usage) { return response('completed', [item([part(prefix + text)], 'completed')], usage) },
    finish(text: string, reason: Finish, usage: Usage) {
      if (protocol === 'chat') {
        const actual = includeUsage && usage.inputTokens !== null && usage.outputTokens !== null ? data({ id,
          object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens } }) : ''
        return chat({}, reason) + actual + 'data: [DONE]\n\n'
      }
      if (protocol === 'anthropic') return event('content_block_stop', { index: 0 }) +
        event('message_delta', { delta: { stop_reason: reason === 'stop' ? 'end_turn' : reason === 'length' ? 'max_tokens' :
          reason === 'content_filter' ? 'refusal' : null, stop_sequence: null },
        usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } }) + event('message_stop')
      const status = reason === 'length' || reason === 'content_filter' ? 'incomplete' : 'completed'
      const final = part(prefix + text), finalItem = item([final], status)
      return responsesEvent('response.output_text.done', { ...indices, text: final.text, logprobs: [] }) +
        responsesEvent('response.content_part.done', { ...indices, part: final }) +
        responsesEvent('response.output_item.done', { output_index: 0, item: finalItem }) +
        responsesEvent(`response.${status}`, { response: response(status, [finalItem], usage,
          status === 'incomplete' ? { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' } : null) })
    },
    fail(error: GatewayError) {
      if (protocol === 'responses') return responsesEvent('error', { code: error.code, message: error.message, param: null, request_id: requestId })
      if (protocol === 'anthropic') return event('error', { error: { type: 'api_error', message: error.message },
        code: error.code, request_id: requestId })
      return data({ error: { type: 'gateway_error', code: error.code, message: error.message }, request_id: requestId })
    },
  }
}
