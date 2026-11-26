// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMessage } from '../context.js'
import { GatewayError, bytes, fields, integer, invalid, maxInputBytes, maxMessages, maxOutputTokens, modelId, record, unsupported } from './contract.js'
import type { Protocol } from './contract.js'
import type { Reply } from './providers.js'
import { responseId } from './responses.js'
import type { AudioRequest, Capability } from './media.js'
import type { RichReply } from './operator-rich.js'
import { chatCall, messagesCall, responsesCall } from './tool-dto.js'
import { richHistory } from './wire-rich.js'
import type { RichHistory } from './wire-rich.js'
import { nativeOptionFields, nativeOptions, optionUnavailable } from './native-options.js'
import type { NativeOptions } from './native-options.js'

type Endpoint = 'chat' | 'responses' | 'messages' | 'count_tokens'
const endpoints = new Map<string, Endpoint>([['chat/completions', 'chat'], ['responses', 'responses'],
  ['messages', 'messages'], ['messages/count_tokens', 'count_tokens']])
export const modelEndpoint = (path: string) => endpoints.get(path)
export const protocolFor = (endpoint: Endpoint): Protocol => endpoint === 'count_tokens' || endpoint === 'messages' ? 'anthropic' : endpoint
export type ResponseMeta = { store: boolean; previous_response_id: string | null }
export type Turn = { model: string; maxTokens: number; stream: boolean; includeUsage: boolean; response?: ResponseMeta; options?: NativeOptions; audio?: AudioRequest } &
  ({ rich?: undefined; messages: ModelMessage[]; userText: string; inputBytes: number } | { rich: RichHistory })

const common = ['model', 'stream', 'tools', 'tool_choice']
const multipart = () => unsupported('Only text messages and text blocks are supported.', 'non_text_input_unsupported')
const tools = () => unsupported('Tool calls and execution are not supported by this Gateway.', 'tools_unsupported')

function text(value: unknown): string {
  if (typeof value !== 'string' || /\p{Cs}/u.test(value)) throw invalid('Expected well-formed text.')
  return value
}

function content(value: unknown, types: readonly string[]): string {
  if (typeof value === 'string') return text(value)
  if (!Array.isArray(value) || !value.length || value.length > 32) throw multipart()
  return value.map(item => {
    const part = record(item)
    if (part.type === 'tool_use' || part.type === 'tool_result') throw tools()
    if (typeof part.type !== 'string' || !types.includes(part.type)) throw multipart()
    fields(part, ['type', 'text'])
    return text(part.text)
  }).join('\n')
}

function history(value: unknown, protocol: Protocol, native: boolean): ModelMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > maxMessages) throw invalid('Expected 1–48 messages.')
  return value.map(item => {
    const entry = record(item)
    if (entry.role === 'tool' || entry.tool_calls !== undefined || entry.function_call !== undefined ||
        entry.type === 'function_call' || entry.type === 'function_call_output') throw tools()
    fields(entry, protocol === 'responses' ? ['role', 'content', 'type'] : ['role', 'content'])
    if (entry.type !== undefined && entry.type !== 'message') throw multipart()
    const role = entry.role
    const system = protocol !== 'anthropic' && (role === 'system' || role === 'developer')
    if (!system && role !== 'user' && role !== 'assistant') throw invalid('Unsupported message role.')
    return { role: system ? 'system' : role as 'user' | 'assistant', content: content(entry.content,
      protocol === 'responses' ? role === 'assistant' ? ['output_text'] : ['input_text'] : ['text']),
      ...(native && role === 'developer' && { gatewayRole: 'developer' }) }
  })
}

export function normalizeTurn(raw: Record<string, unknown>, endpoint: Endpoint, rich?: ReadonlySet<Capability>, localReferences = false,
  native?: ReadonlySet<Capability>): Turn {
  const protocol = protocolFor(endpoint)
  if (raw.model == null || raw.model === '') throw invalid('A model identifier is required.', 'model_missing')
  if (!modelId(raw.model)) throw invalid('Invalid model identifier.')
  if (raw.stream !== undefined && typeof raw.stream !== 'boolean') throw invalid('stream must be a boolean.')
  const stream = raw.stream === true
  if (stream && endpoint === 'count_tokens') throw invalid('Input token counts do not stream.')
  const optionFields = endpoint === 'count_tokens' ? [] : nativeOptionFields(protocol)
  const hasOptions = optionFields.some(key => Object.hasOwn(raw, key))
  if (hasOptions && !native) throw optionUnavailable()
  const options = hasOptions ? nativeOptions(raw, protocol, native!, stream) : undefined
  if (!rich && ((raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length)) ||
      (raw.tool_choice !== undefined && raw.tool_choice !== 'none') || raw.parallel_tool_calls !== undefined)) throw tools()
  const commonFields = rich && protocol !== 'anthropic' ? [...common, 'parallel_tool_calls'] : common
  const maximum = (a: string, b?: string) => {
    if (b && raw[a] !== undefined && raw[b] !== undefined) throw invalid('Specify only one output token limit.')
    const amount = raw[a] !== undefined ? raw[a] : b === undefined ? undefined : raw[b]
    if (amount === undefined && endpoint !== 'messages') return 512
    if (!integer(amount, 1, maxOutputTokens)) throw invalid('Output token limit must be 1–2048.')
    return amount
  }
  let input: unknown, system: string | undefined, maxTokens = 512, includeUsage = false, response: ResponseMeta | undefined, audio: AudioRequest | undefined
  if (protocol === 'chat') {
    if (raw.functions !== undefined || raw.function_call !== undefined) throw tools()
    if (raw.n !== undefined && raw.n !== 1 || raw.response_format !== undefined &&
        !(record(raw.response_format).type === 'text' && Object.keys(record(raw.response_format)).length === 1)) {
      throw unsupported('Only one plain-text completion is supported.', 'output_format_unsupported')
    }
    if (raw.modalities !== undefined || raw.audio !== undefined) {
      const fail = () => unsupported('WAV output requires an enabled Chat model, JSON, and no tools.', 'audio_output_unsupported')
      if (!rich?.has('audio_output') || stream || raw.tools !== undefined || raw.tool_choice !== undefined || raw.parallel_tool_calls !== undefined) throw fail()
      if (!Array.isArray(raw.modalities) || raw.modalities.length !== 2 || !['text', 'audio'].every(value => (raw.modalities as unknown[]).includes(value))) throw fail()
      const spec = record(raw.audio, fail)
      fields(spec, ['voice', 'format'], fail)
      if (spec.format !== 'wav' || typeof spec.voice !== 'string' || !['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].includes(spec.voice)) throw fail()
      audio = { voice: spec.voice, format: 'wav' }
    }
    fields(raw, [...commonFields, 'messages', 'max_tokens', 'max_completion_tokens', 'n', 'response_format', 'stream_options', 'modalities', 'audio'])
    if (raw.stream_options !== undefined) {
      if (!stream) throw invalid('stream_options requires stream:true.')
      const options = record(raw.stream_options)
      fields(options, ['include_usage'])
      if (options.include_usage !== undefined && typeof options.include_usage !== 'boolean') throw invalid('include_usage must be a boolean.')
      includeUsage = options.include_usage === true
    }
    maxTokens = maximum('max_tokens', 'max_completion_tokens')
    input = raw.messages
  } else if (protocol === 'responses') {
    if (raw.conversation != null) throw unsupported('Managed Responses conversations are not available; use previous_response_id or text history.', 'response_storage_unsupported')
    if (raw.store !== undefined && typeof raw.store !== 'boolean') throw invalid('store must be a boolean.')
    if (raw.previous_response_id != null && !responseId(raw.previous_response_id)) throw invalid('Invalid previous_response_id.')
    response = { store: raw.store === true, previous_response_id: raw.previous_response_id ?? null }
    if (raw.background !== undefined && raw.background !== false) throw unsupported('Background generation is not available.')
    fields(raw, [...commonFields, ...optionFields, 'input', 'instructions', 'max_output_tokens', 'store', 'previous_response_id', 'conversation', 'background'])
    maxTokens = maximum('max_output_tokens')
    input = raw.input
    if (raw.instructions !== undefined && raw.instructions !== null) system = text(raw.instructions)
  } else {
    fields(raw, [...common, ...optionFields, 'messages', 'system', ...(endpoint === 'messages' ? ['max_tokens'] : [])])
    if (endpoint === 'messages') maxTokens = maximum('max_tokens')
    input = raw.messages
    if (raw.system !== undefined) system = content(raw.system, ['text'])
  }
  const base = { model: raw.model, maxTokens, stream, includeUsage, response, options, audio }
  if (rich) return { ...base, rich: richHistory(raw, protocol, input, system, rich, localReferences, !!native) }
  const messages: (ModelMessage & { gatewayRole?: 'instructions' })[] = protocol === 'responses' && typeof input === 'string'
    ? [{ role: 'user', content: text(input) }] : history(input, protocol, !!native)
  if (system !== undefined) messages.unshift({ role: 'system', content: system, ...(native && protocol === 'responses' && { gatewayRole: 'instructions' }) })
  const userText = messages.at(-1)?.role === 'user' ? messages.at(-1)!.content : ''
  if (!userText.trim()) throw invalid('A final nonempty user message is required.')
  const inputBytes = messages.reduce((size, message) => size + bytes(message.content), 0)
  if (inputBytes > maxInputBytes || messages.length > maxMessages) {
    throw new GatewayError(413, 'body_too_large', 'Gateway history exceeds 48 messages or 48 KiB of text.')
  }
  return { ...base, messages, userText, inputBytes }
}

export function render(protocol: Protocol, model: string, reply: Reply, requestId: string, note: string, meta?: ResponseMeta) {
  const id = requestId.replace(/-/g, '')
  const now = Math.floor(Date.now() / 1000)
  const { inputTokens: input, outputTokens: output, text } = reply
  const total = input === null || output === null ? null : input + output
  if (protocol === 'chat') return { id: `chatcmpl-${id}`, object: 'chat.completion', created: now, model,
    choices: [{ index: 0, message: { role: 'assistant', content: note ? `${note}\n\n${text}` : text }, finish_reason: null, logprobs: null }],
    ...(total === null ? {} : { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: total } }) }
  if (protocol === 'anthropic') return { id: `msg_${id}`, type: 'message', role: 'assistant', model,
    content: [...(note ? [{ type: 'text', text: note }] : []), { type: 'text', text }], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output } }
  const part = (value: string, index: number) => ({ type: 'message', id: `msg_${id}_${index}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }] })
  return { id: `resp_${id}`, object: 'response', created_at: now, status: 'completed', model,
    output: [...(note ? [part(note, 0)] : []), part(text, note ? 1 : 0)], error: null, incomplete_details: null, ...meta,
    usage: total === null ? null : { input_tokens: input, output_tokens: output, total_tokens: total } }
}

export function renderRich(protocol: Protocol, model: string, reply: RichReply, requestId: string, meta?: ResponseMeta, note = '') {
  const id = requestId.replace(/-/g, ''), now = Math.floor(Date.now() / 1000)
  const { text, calls, finish, inputTokens: input, outputTokens: output } = reply
  const counted = input !== null && output !== null
  if (protocol === 'chat') return { id: `chatcmpl-${id}`, object: 'chat.completion', created: now, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(reply.audio && { audio: { ...reply.audio, id: `audio_${id}` } }),
      ...(calls.length && { tool_calls: calls.map(chatCall) }) },
      finish_reason: finish, logprobs: null }], ...(counted && { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } }) }
  if (protocol === 'anthropic') return { id: `msg_${id}`, type: 'message', role: 'assistant', model,
    content: [...(note ? [{ type: 'text', text: note }] : []), ...(text ? [{ type: 'text', text }] : []), ...calls.map(messagesCall)], stop_sequence: reply.stopSequence ?? null,
    stop_reason: reply.stopSequence ? 'stop_sequence' : finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn',
    ...(input !== null || output !== null ? { usage: { ...(input !== null && { input_tokens: input }), ...(output !== null && { output_tokens: output }) } } : {}) }
  const incomplete = finish === 'length' || finish === 'content_filter', status = incomplete ? 'incomplete' : 'completed'
  const parts = [note, text].filter(Boolean).map((part, index) => ({ type: 'message', id: `msg_${id}_${index}`, role: 'assistant', status,
    content: [{ type: 'output_text', text: part, annotations: [] }] }))
  return { id: `resp_${id}`, object: 'response', created_at: now, status, model,
    output: [...parts, ...calls.map((call, index) => responsesCall(call, id, parts.length + index))], ...meta, error: null,
    incomplete_details: incomplete ? { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
    ...(counted && { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } }) }
}
