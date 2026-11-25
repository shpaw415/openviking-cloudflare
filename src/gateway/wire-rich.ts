// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMessage } from '../context.js'
import { GatewayError, bytes, fields, invalid, maxInputBytes, maxMessages, record, unsupported } from './contract.js'
import type { Protocol } from './contract.js'
import { mediaReader } from './media.js'
import type { Capability, ChatPart, MediaPart, ReadGatewayAttachment } from './media.js'
import { badHistory, callId, chatCall, maxCalls, maxToolPayload, readCall, toolRules, toolsUnsupported, wellFormed } from './tool-dto.js'
import type { Call, ToolRules } from './tool-dto.js'

type ToolMessage = { role: 'tool'; tool_call_id: string; content: string }
type CallMessage = { role: 'assistant'; content: string | null; tool_calls: ReturnType<typeof chatCall>[] }
type ChatMessage<T> = ModelMessage | { role: 'user'; content: T[] } | ToolMessage | CallMessage
export type RichInput = { messages: ChatMessage<ChatPart>[]; rules: ToolRules; ids: ReadonlySet<string>; inputBytes: number; assertCurrent(): void }
export type RichHistory = { resolve(read: ReadGatewayAttachment | undefined, guard: () => void): Promise<RichInput> }

export function inputText(value: unknown): string {
  if (!wellFormed(value)) throw invalid('Expected well-formed text.')
  return value
}

export function richHistory(raw: Record<string, unknown>, protocol: Protocol, input: unknown, system: string | undefined,
  capabilities: ReadonlySet<Capability>, localReferences: boolean): RichHistory {
  const rules = toolRules(raw, protocol, capabilities.has('tools'))
  const media = mediaReader(protocol, capabilities, localReferences)
  const messages: ChatMessage<MediaPart>[] = []
  const ids = new Set<string>(), awaiting = new Set<string>()
  let textBytes = 0, payloadBytes = 0, canCall = false
  const add = (message: typeof messages[number]) => {
    messages.push(message)
    if (messages.length > maxMessages) throw new GatewayError(413, 'body_too_large', 'Gateway history exceeds 48 messages or 48 KiB of text.')
  }
  const text = (value: unknown) => {
    const safe = inputText(value)
    textBytes += bytes(safe)
    if (textBytes > maxInputBytes) throw new GatewayError(413, 'body_too_large', 'Gateway history exceeds 48 messages or 48 KiB of text.')
    return safe
  }
  const payload = (length: number) => {
    payloadBytes += length
    if (payloadBytes > maxToolPayload) throw new GatewayError(413, 'tool_limit', 'Function history exceeds its payload budget.')
  }
  function readContent(value: unknown, role: ModelMessage['role']): string | MediaPart[] {
    if (typeof value === 'string') return text(value)
    const bad = () => unsupported('This role or protocol does not admit these content blocks.', 'non_text_input_unsupported')
    if (!Array.isArray(value) || !value.length || value.length > 32) throw bad()
    const label = protocol === 'responses' ? (role === 'assistant' ? 'output_text' : 'input_text') : 'text'
    const parts = value.map((entry): MediaPart => {
      const part = record(entry)
      if (part.type === label) {
        fields(part, ['type', 'text', ...(label === 'output_text' ? ['annotations', 'logprobs'] : [])])
        if ([part.annotations, part.logprobs].some(value => value !== undefined && (!Array.isArray(value) || value.length))) throw bad()
        return { type: 'text', text: text(part.text) }
      }
      if (role !== 'user') throw bad()
      return media.parse(part)
    })
    if (parts.every(part => part.type === 'text')) {
      text('\n'.repeat(parts.length - 1))
      return parts.map(part => part.text).join('\n')
    }
    return parts
  }
  function pushCall(parts: Call[], prose: string | null) {
    if (!rules.tools.length) throw toolsUnsupported()
    if (!canCall || awaiting.size || !parts.length || parts.length > maxCalls) throw badHistory()
    for (const call of parts) {
      if (ids.has(call.id) || ids.size >= 24) throw badHistory()
      ids.add(call.id)
      awaiting.add(call.id)
      payload(bytes(call.arguments))
    }
    add({ role: 'assistant', content: prose, tool_calls: parts.map(chatCall) })
    canCall = false
  }
  function pushResult(id: unknown, value: unknown, isError?: unknown) {
    if (!rules.tools.length) throw toolsUnsupported()
    if (!callId(id) || !awaiting.delete(id) || !wellFormed(value) || isError !== undefined && typeof isError !== 'boolean') throw badHistory()
    const content = isError ? `[Client reported tool error]\n${value}` : value
    const length = bytes(content)
    if (length > 8 * 1024) throw new GatewayError(413, 'tool_limit', 'A function result exceeds its payload budget.')
    payload(length)
    add({ role: 'tool', tool_call_id: id, content })
    canCall = awaiting.size === 0
  }
  function ordinary(entry: Record<string, unknown>, role: ModelMessage['role']) {
    if (awaiting.size) throw badHistory()
    const content = readContent(entry.content, role)
    if (role === 'user' && Array.isArray(content)) add({ role, content })
    else if (typeof content === 'string') add({ role, content })
    else throw badHistory()
    canCall = role === 'user'
  }
  if (system !== undefined) add({ role: 'system', content: text(system) })
  const entries = typeof input === 'string' && protocol === 'responses' ? [{ role: 'user', content: input }] : input
  if (!Array.isArray(entries) || !entries.length || entries.length > maxMessages) throw invalid('Expected 1–48 messages or input items.')
  const rows = entries.map(item => record(item))
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i]
    if (protocol === 'responses' && entry.type === 'function_call_output') {
      fields(entry, ['type', 'call_id', 'output'], badHistory)
      pushResult(entry.call_id, entry.output)
      continue
    }
    // Responses output can contain a prose item immediately before the call items.
    if (protocol === 'responses' && (entry.type === 'function_call' || entry.role === 'assistant' && rows[i + 1]?.type === 'function_call')) {
      let prose: string | null = null
      if (entry.type !== 'function_call') {
        fields(entry, ['type', 'role', 'content', 'id', 'status'], badHistory)
        if (entry.type !== undefined && entry.type !== 'message' || entry.status !== undefined && entry.status !== 'completed' ||
            entry.id !== undefined && !callId(entry.id)) throw badHistory()
        const value = readContent(entry.content, 'assistant')
        if (typeof value !== 'string') throw badHistory()
        prose = value
        i++
      }
      const calls: Call[] = []
      while (rows[i]?.type === 'function_call') {
        const item = rows[i++]
        fields(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'], badHistory)
        if (item.status !== undefined && item.status !== 'completed' || item.id !== undefined && !callId(item.id)) throw badHistory()
        calls.push(readCall(rules, item.call_id, item.name, item.arguments, true))
      }
      pushCall(calls, prose)
      i--
      continue
    }
    if (protocol === 'chat' && entry.role === 'tool') {
      fields(entry, ['role', 'tool_call_id', 'content'], badHistory)
      pushResult(entry.tool_call_id, entry.content)
      continue
    }
    if (protocol === 'chat' && entry.role === 'assistant' && Object.hasOwn(entry, 'tool_calls')) {
      fields(entry, ['role', 'content', 'tool_calls'], badHistory)
      if (!Array.isArray(entry.tool_calls) || !entry.tool_calls.length || entry.tool_calls.length > maxCalls) throw badHistory()
      pushCall(entry.tool_calls.map(value => {
        const item = record(value, badHistory)
        fields(item, ['id', 'type', 'function'], badHistory)
        if (item.type !== 'function') throw toolsUnsupported()
        const spec = record(item.function, badHistory)
        fields(spec, ['name', 'arguments'], badHistory)
        return readCall(rules, item.id, spec.name, spec.arguments, true)
      }), entry.content == null ? null : text(entry.content))
      continue
    }
    if (protocol === 'anthropic' && Array.isArray(entry.content)) {
      const blocks = entry.content.map(item => record(item))
      if (blocks.length > 32) throw invalid('Too many content blocks.')
      if (blocks.some(block => block.type === 'tool_use' || block.type === 'tool_result')) {
        fields(entry, ['role', 'content'], badHistory)
        if (entry.role === 'assistant') {
          const calls: Call[] = [], prose: string[] = []
          for (const block of blocks) {
            if (block.type === 'text' && !calls.length) { fields(block, ['type', 'text'], badHistory); prose.push(text(block.text)) }
            else {
              fields(block, ['type', 'id', 'name', 'input'], badHistory)
              if (block.type !== 'tool_use') throw badHistory()
              calls.push(readCall(rules, block.id, block.name, block.input, false))
            }
          }
          if (prose.length > 1) text('\n'.repeat(prose.length - 1))
          pushCall(calls, prose.length ? prose.join('\n') : null)
        } else if (entry.role === 'user') {
          for (const block of blocks) {
            fields(block, ['type', 'tool_use_id', 'content', 'is_error'], badHistory)
            if (block.type !== 'tool_result') throw badHistory()
            pushResult(block.tool_use_id, block.content, block.is_error)
          }
        } else throw badHistory()
        continue
      }
    }
    if (protocol === 'responses') {
      fields(entry, ['role', 'type', 'content', 'id', 'status'])
      if (entry.type !== undefined && entry.type !== 'message' || entry.status !== undefined && entry.status !== 'completed' ||
          entry.id !== undefined && !callId(entry.id)) throw invalid('Expected a complete message, function call or function result.')
    } else fields(entry, ['role', 'content'])
    const role = entry.role === 'developer' ? 'system' : entry.role
    if (role !== 'user' && role !== 'assistant' && (role !== 'system' || protocol === 'anthropic')) throw invalid('Unsupported message role.')
    ordinary(entry, role)
  }
  const last = messages.at(-1)
  if (awaiting.size) throw badHistory()
  if (last?.role !== 'tool' && (last?.role !== 'user' || typeof last.content === 'string' && !last.content.trim())) {
    throw invalid('A final user message or complete function result is required.')
  }
  return { async resolve(read, guard) {
    const ready: RichInput['messages'] = []
    for (const entry of messages) {
      if (entry.role === 'user' && Array.isArray(entry.content)) {
        const parts: ChatPart[] = []
        for (const part of entry.content) parts.push(part.type === 'attachment' ? await media.resolve(part, read, guard) : part)
        ready.push({ role: 'user', content: parts })
      } else ready.push(entry as ChatMessage<ChatPart>)
    }
    const outboundBytes = bytes(JSON.stringify(ready)) + bytes(JSON.stringify(rules))
    if (outboundBytes > 288 * 1024) throw new GatewayError(413, 'body_too_large', 'The projected Gateway turn exceeds its wire budget.')
    return { messages: ready, rules, ids, inputBytes: outboundBytes, assertCurrent: media.assertCurrent }
  } }
}
