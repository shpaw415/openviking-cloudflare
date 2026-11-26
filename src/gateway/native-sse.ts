// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { GatewayError, bytes, integer, maxOutputBytes } from './contract.js'
import { readNativeReply, upstreamFailure } from './native-dto.js'
import type { NativeProtocol, OutputRules } from './native-dto.js'
import { protectStreamText, sourceFrames } from './sse-source.js'
import type { PieceSource } from './sse-source.js'
import { callId, maxArgumentBytes, wellFormed } from './tool-dto.js'

const invalidFrame = () => new GatewayError(502, 'invalid_stream', 'The provider sent an unsupported or malformed stream event.')
const record = (value: unknown) => { if (!isRecord(value)) throw invalidFrame(); return value }

function responses() {
  let id: string | undefined, seq = 0, active: string | undefined, type: unknown, part = 0, partState = 0, segment = '', args = ''
  const items: Record<string, unknown>[] = []
  const parts: string[] = []
  let argumentsDone = false
  return (event: Record<string, unknown>) => {
    if (event.sequence_number !== seq++) throw invalidFrame()
    switch (event.type) {
      case 'response.created': {
        const response = record(event.response)
        if (seq !== 1 || !callId(response.id) || response.object !== 'response' || response.status !== 'in_progress') throw invalidFrame()
        id = response.id
        return {}
      }
      case 'response.in_progress': {
        const response = record(event.response)
        if (seq !== 2 || !id || response.id !== id || response.status !== 'in_progress') throw invalidFrame()
        return {}
      }
      case 'response.output_item.added': {
        const item = record(event.item)
        if (!id || active || items.length >= 32 || event.output_index !== items.length || !callId(item.id) ||
            items.some(previous => previous.id === item.id) || !['message', 'function_call'].includes(item.type as string) ||
            item.type === 'message' && item.role !== 'assistant') throw invalidFrame()
        active = item.id; type = item.type; part = 0; partState = 0; parts.length = 0; args = ''; argumentsDone = false
        return {}
      }
      case 'response.completed': case 'response.incomplete': {
        const reply = record(event.response)
        if (!id || active || reply.id !== id || reply.status !== (event.type === 'response.completed' ? 'completed' : 'incomplete') ||
            !Array.isArray(reply.output) || reply.output.length !== items.length || reply.output.some((item, index) => {
              const saved = items[index], final = record(item)
              if (final.type !== saved.type || final.id !== saved.id || final.status !== saved.status) return true
              if (final.type === 'function_call') return final.call_id !== saved.call_id || final.name !== saved.name || final.arguments !== saved.arguments
              return !Array.isArray(final.content) || !Array.isArray(saved.content) || final.content.length !== saved.content.length ||
                final.content.some((part, i) => record(part).text !== record((saved.content as unknown[])[i]).text)
            })) throw invalidFrame()
        return { reply }
      }
    }
    if (!active || event.output_index !== items.length) throw invalidFrame()
    if (event.type === 'response.output_item.done') {
      const item = record(event.item)
      if (item.id !== active || item.type !== type || partState !== 0 ||
          (type === 'message' ? !Array.isArray(item.content) || !parts.length || item.content.length !== parts.length ||
            item.content.some((part, i) => record(part).type !== 'output_text' || record(part).text !== parts[i]) :
            !argumentsDone || item.arguments !== args)) throw invalidFrame()
      items.push(item); active = undefined
      return {}
    }
    if (event.item_id !== active) throw invalidFrame()
    if (type === 'function_call') {
      if (argumentsDone) throw invalidFrame()
      if (event.type === 'response.function_call_arguments.done' && event.arguments === args) { argumentsDone = true; return {} }
      if (event.type !== 'response.function_call_arguments.delta' || !wellFormed(event.delta) || bytes(args + event.delta) > maxArgumentBytes) throw invalidFrame()
      args += event.delta
      return {}
    }
    if (event.content_index !== part || part >= 32 || items.some(item => item.type === 'function_call')) throw invalidFrame()
    switch (event.type) {
      case 'response.content_part.added': {
        const data = record(event.part)
        if (partState || data.type !== 'output_text' || data.text !== '') throw invalidFrame()
        partState = 1; segment = ''
        return {}
      }
      case 'response.output_text.delta':
        if (partState !== 1 || !wellFormed(event.delta)) throw invalidFrame()
        segment += event.delta
        return { delta: event.delta }
      case 'response.output_text.done':
        if (partState !== 1 || event.text !== segment) throw invalidFrame()
        partState = 2; return {}
      case 'response.content_part.done': {
        const data = record(event.part)
        if (partState !== 2 || data.type !== 'output_text' || data.text !== segment) throw invalidFrame()
        parts.push(segment); part++; partState = 0
        return {}
      }
      default: throw invalidFrame()
    }
  }
}

function messages(secret: (text: string) => void) {
  let started = false, ended = false, hasCalls = false, stop: unknown, sequence: unknown, usage: Record<string, unknown> = {}
  let block: Record<string, unknown> | undefined, fragments = ''
  const content: Record<string, unknown>[] = []
  return (event: Record<string, unknown>) => {
    switch (event.type) {
      case 'message_start': {
        const message = record(event.message)
        if (started || message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content) ||
            message.content.length || message.stop_reason != null || message.stop_sequence != null) throw invalidFrame()
        started = true; usage = isRecord(message.usage) ? { input_tokens: message.usage.input_tokens } : {}
        return {}
      }
      case 'content_block_start': {
        const part = record(event.content_block)
        if (!started || ended || block || content.length >= 32 || event.index !== content.length) throw invalidFrame()
        if (part.type === 'tool_use') {
          if (!isRecord(part.input) || Object.keys(part.input).length) throw invalidFrame()
          hasCalls = true
        } else if (part.type !== 'text' || hasCalls || !wellFormed(part.text) || part.citations != null) throw invalidFrame()
        block = part; fragments = ''
        return { delta: part.type === 'text' ? part.text as string : undefined }
      }
      case 'content_block_delta': {
        const data = record(event.delta)
        if (!block || event.index !== content.length) throw invalidFrame()
        if (block.type === 'text' && data.type === 'text_delta' && wellFormed(data.text)) {
          block.text = (block.text as string) + data.text
          return { delta: data.text }
        }
        if (block.type !== 'tool_use' || data.type !== 'input_json_delta' || !wellFormed(data.partial_json) ||
            bytes(fragments + data.partial_json) > maxArgumentBytes) throw invalidFrame()
        fragments += data.partial_json
        return {}
      }
      case 'content_block_stop':
        if (!block || event.index !== content.length) throw invalidFrame()
        if (block.type === 'tool_use' && fragments) {
          secret(fragments)
          try { block.input = JSON.parse(fragments) } catch { throw invalidFrame() }
        }
        content.push(block); block = undefined
        return {}
      case 'message_delta': {
        const delta = record(event.delta)
        if (!started || ended || block || !content.length || !wellFormed(delta.stop_reason) ||
            (delta.stop_reason === 'stop_sequence' ? !wellFormed(delta.stop_sequence) : delta.stop_sequence != null)) throw invalidFrame()
        stop = delta.stop_reason; sequence = delta.stop_sequence; ended = true
        if (isRecord(event.usage) && integer(event.usage.output_tokens, 0, 1_000_000)) usage = { ...usage, output_tokens: event.usage.output_tokens }
        return {}
      }
      case 'message_stop':
        if (!ended) throw invalidFrame()
        return { reply: { type: 'message', role: 'assistant', stop_reason: stop, stop_sequence: sequence, content, usage } }
      case 'ping': return {}
      default: throw invalidFrame()
    }
  }
}

export function nativePieces(protocol: NativeProtocol, input: OutputRules, key: string): PieceSource {
  return async function* (reader, wait) {
    const secret = (text: string) => { if (text.includes(key)) throw upstreamFailure() }
    const parse = protocol === 'responses' ? responses() : messages(secret)
    const filter = protectStreamText(key)
    let size = 0, text = ''
    for await (const frame of sourceFrames(reader, wait)) {
      if (frame.event === 'error') throw upstreamFailure()
      let event: Record<string, unknown>
      try { event = record(JSON.parse(frame.data)) } catch { throw invalidFrame() }
      if (['error', 'response.failed'].includes(event.type as string)) throw upstreamFailure()
      if (typeof event.type !== 'string' || frame.event !== event.type) throw invalidFrame()
      const { delta, reply } = parse(event)
      if (delta) {
        size += bytes(delta)
        if (size > maxOutputBytes) throw invalidFrame()
        text += delta
        for (const safe of filter(delta)) yield { delta: safe }
      }
      if (reply) {
        const parsed = readNativeReply(protocol, reply, input, secret)
        if (text !== parsed.text) throw invalidFrame()
        for (const safe of filter('', true)) yield { delta: safe }
        if (parsed.calls.length) yield { calls: parsed.calls, text }
        const { finish, calls, inputTokens, outputTokens, stopSequence } = parsed
        yield { finish, text, calls, stopSequence, usage: { inputTokens, outputTokens } }
        return
      }
    }
  }
}
