// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { GatewayError, bytes, maxOutputBytes, unsupported } from './contract.js'
import type { RichFinish, RichReply } from './operator-rich.js'
import { usageNumber } from './providers.js'
import { maxCalls, readCall, toolOutputError, validateCalls, wellFormed } from './tool-dto.js'
import type { Call } from './tool-dto.js'
import type { RichInput } from './wire-rich.js'
import { validStructuredOutput } from './native-options.js'

export type NativeProtocol = 'responses' | 'anthropic'
export type NativeInput = RichInput
export type OutputRules = Pick<NativeInput, 'rules' | 'ids' | 'options'>
export const upstreamFailure = () => new GatewayError(502, 'upstream_error', 'The generation binding could not complete the request.')

export function nativeBody(protocol: NativeProtocol, model: string, input: NativeInput, max: number, stream: boolean, count = false) {
  const { rules, options } = input
  if (protocol === 'responses') {
    const items: object[] = []
    let instructions: string | undefined
    for (const row of input.messages) {
      if (row.role === 'system' && row.gatewayRole === 'instructions') { instructions = row.content; continue }
      if (row.role === 'tool') items.push({ type: 'function_call_output', call_id: row.tool_call_id, output: row.content })
      else {
        const content = Array.isArray(row.content) ? row.content.map(part => {
          if (part.type === 'text') return { type: 'input_text', text: part.text }
          if (part.type === 'document') return { type: 'input_file', filename: part.filename, file_data: `data:text/plain;base64,${part.data}` }
          if (part.type !== 'image_url') throw unsupported('Native Responses does not support this media.', 'non_text_input_unsupported')
          return { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail ?? 'auto' }
        }) : row.content === null ? [] : [{ type: 'input_text', text: row.content }]
        const role = row.role === 'system' && row.gatewayRole === 'developer' ? 'developer' : row.role
        // Easy input messages can carry assistant text without inventing a provider-owned output item ID.
        if (content.length) items.push({ type: 'message', role, content: row.role === 'assistant' ? row.content : content })
        if ('tool_calls' in row) for (const call of row.tool_calls) items.push({ type: 'function_call', call_id: call.id, ...call.function })
      }
    }
    const choice = typeof rules.choice === 'object' ? { type: 'function', name: rules.choice.function.name } : rules.choice
    return { model, input: items, instructions, max_output_tokens: max, stream, store: false, ...options?.sampling,
      ...(options?.format && { text: { format: { type: 'json_schema', ...options.format, strict: true } } }),
      ...(rules.tools.length && { tools: rules.tools.map(tool => ({ type: 'function', ...tool.function, strict: tool.function.strict ?? false })),
        tool_choice: choice, parallel_tool_calls: rules.parallel }) }
  }
  const messages: { role: string; content: object[] }[] = []
  const system: object[] = []
  let resultGroup: object[] | undefined
  for (const row of input.messages) {
    if (row.role === 'system') { system.push({ type: 'text', text: row.content }); continue }
    if (row.role === 'tool') {
      if (!resultGroup) { resultGroup = []; messages.push({ role: 'user', content: resultGroup }) }
      resultGroup.push({ type: 'tool_result', tool_use_id: row.tool_call_id, content: row.nativeResult?.text ?? row.content,
        ...(row.nativeResult?.isError !== undefined && { is_error: row.nativeResult.isError }) })
      continue
    }
    resultGroup = undefined
    const content: object[] = Array.isArray(row.content) ? row.content.map(part => {
      if (part.type === 'text') return part
      if (part.type === 'document') return { type: 'document', title: part.filename,
        source: { type: 'text', media_type: 'text/plain', data: part.text } }
      if (part.type !== 'image_url') throw unsupported('Native Messages does not support this media.', 'non_text_input_unsupported')
      const [prefix, data] = part.image_url.url.split(',', 2)
      return { type: 'image', source: { type: 'base64', media_type: prefix.slice(5, -7), data } }
    }) : row.content === null ? [] : [{ type: 'text', text: row.content }]
    if ('tool_calls' in row) for (const call of row.tool_calls) content.push({ type: 'tool_use', id: call.id,
      name: call.function.name, input: JSON.parse(call.function.arguments) })
    messages.push({ role: row.role, content })
  }
  const choice = typeof rules.choice === 'object' ? { type: 'tool', name: rules.choice.function.name } :
    rules.choice === 'required' ? { type: 'any' } : { type: rules.choice ?? 'auto' }
  return { model, messages, ...(system.length && { system }), ...(!count && { max_tokens: max, stream, ...options?.sampling,
    ...(options?.stop && { stop_sequences: options.stop }),
    ...(options?.format && { output_config: { format: { type: 'json_schema', schema: options.format.schema } } }) }),
    ...(rules.tools.length && { tools: rules.tools.map(({ function: { name, description, parameters } }) => ({ name, description, input_schema: parameters })),
       ...(!count && { tool_choice: { ...choice, ...(rules.parallel !== undefined && { disable_parallel_tool_use: !rules.parallel }) } }) }) }
}

export function checkReply(text: string, calls: Call[], finish: RichFinish, usage: unknown, input: OutputRules,
  secret: (value: string) => void): RichReply {
  if ((!text.trim() && !calls.length) || bytes(text) > maxOutputBytes) throw upstreamFailure()
  secret(text)
  validateCalls(calls, finish, input.rules, input.ids, secret, text)
  const tokens = isRecord(usage) ? usage : {}
  return { text, calls, finish, inputTokens: usageNumber(tokens.input_tokens), outputTokens: usageNumber(tokens.output_tokens) }
}

export function readNativeReply(protocol: NativeProtocol, value: Record<string, unknown>, input: OutputRules,
  secret: (value: string) => void): RichReply {
  if (value.error != null) throw upstreamFailure()
  const calls: Call[] = [], text: string[] = []
  let finish: RichFinish = 'stop'
  let stopSequence: string | undefined
  const addText = (data: unknown) => { if (!wellFormed(data) || calls.length) throw upstreamFailure(); text.push(data) }
  const addCall = (id: unknown, name: unknown, args: unknown, encoded: boolean) => {
    if (calls.length >= maxCalls) throw toolOutputError()
    if (encoded && wellFormed(args)) secret(args)
    calls.push(readCall(input.rules, id, name, args, encoded, toolOutputError))
  }
  if (protocol === 'responses') {
    if (value.object !== 'response' || !Array.isArray(value.output) || !value.output.length || value.output.length > 32) throw upstreamFailure()
    if (value.status === 'incomplete' && isRecord(value.incomplete_details)) {
      if (value.incomplete_details.reason === 'max_output_tokens') finish = 'length'
      else if (value.incomplete_details.reason === 'content_filter') finish = 'content_filter'
      else throw upstreamFailure()
    } else if (value.status !== 'completed' || value.incomplete_details != null) throw upstreamFailure()
    for (const item of value.output) {
      if (!isRecord(item)) throw upstreamFailure()
      if (item.type === 'message' && item.role === 'assistant' && item.status === value.status && Array.isArray(item.content) &&
          item.content.length && item.content.length <= 32) {
        for (const part of item.content) {
          if (!isRecord(part) || part.type !== 'output_text' || part.annotations !== undefined &&
              (!Array.isArray(part.annotations) || part.annotations.length)) throw upstreamFailure()
          addText(part.text)
        }
      } else if (item.type === 'function_call' && item.status === 'completed') addCall(item.call_id, item.name, item.arguments, true)
      else throw upstreamFailure()
    }
    if (finish === 'stop' && calls.length) finish = 'tool_calls'
  } else {
    if (value.type !== 'message' || value.role !== 'assistant' || !Array.isArray(value.content) || !value.content.length ||
        value.content.length > 32 || value.stop_reason !== 'stop_sequence' && value.stop_sequence != null) throw upstreamFailure()
    switch (value.stop_reason) {
      case 'end_turn': finish = 'stop'; break
      case 'stop_sequence':
        if (typeof value.stop_sequence !== 'string' || !input.options?.stop?.includes(value.stop_sequence)) throw upstreamFailure()
        secret(value.stop_sequence)
        stopSequence = value.stop_sequence
        break
      case 'max_tokens': finish = 'length'; break
      case 'tool_use': finish = 'tool_calls'; break
      case 'refusal': finish = 'content_filter'; break
      default: throw upstreamFailure()
    }
    for (const part of value.content) {
      if (!isRecord(part)) throw upstreamFailure()
      if (part.type === 'text' && part.citations == null) addText(part.text)
      else if (part.type === 'tool_use') addCall(part.id, part.name, part.input, false)
      else throw upstreamFailure()
    }
  }
  const reply = checkReply(text.join(''), calls, finish, value.usage, input, secret)
  if (input.options?.format && (finish !== 'stop' || !validStructuredOutput(input.options, reply.text, secret))) throw upstreamFailure()
  return { ...reply, stopSequence }
}
