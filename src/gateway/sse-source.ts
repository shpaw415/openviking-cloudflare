// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { breaksProviderCredential, isProviderCredential, maxProviderCredentialLength } from '../provider-credential.js'
import { GatewayError, bytes, integer, maxOutputBytes, within } from './contract.js'
import { usageNumber } from './providers.js'
import { maxArgumentBytes, maxCalls, maxToolPayload, readCall, toolOutputError, validateCalls, wellFormed } from './tool-dto.js'
import type { Call, ToolRules } from './tool-dto.js'

const maxWireBytes = 256 * 1024
const maxEventBytes = 96 * 1024
export const streamTimeout = () => new GatewayError(504, 'upstream_timeout', 'The generation stream timed out.')
const badFrame = () => new GatewayError(502, 'invalid_stream', 'The provider sent an unsupported or malformed stream event.')
const incomplete = () => new GatewayError(502, 'stream_incomplete', 'The provider closed without a valid stream terminator.')
const tooLarge = () => new GatewayError(502, 'stream_limit', 'The provider stream exceeded its response limit.')
const failed = () => new GatewayError(502, 'upstream_error', 'The generation binding could not complete the stream.')

export function translateStreamFailure(error: unknown): unknown {
  if (error instanceof GatewayError) return error
  if (error instanceof ApiError) {
    if (error.code === 'DEADLINE_EXCEEDED') return streamTimeout()
    if (error.code === 'RESOURCE_EXHAUSTED') return tooLarge()
    if (error.code === 'GENERATION_UNAVAILABLE') return new GatewayError(503, 'generation_unavailable', 'The generation binding did not supply a stream.')
    if ([401, 403, 429].includes(error.status) || error.code === 'AUTH_UNAVAILABLE') return error
  }
  return failed()
}

type Frame = { event: string; data: string }

// SSE lines, not transport chunks, bound the parser. Streaming UTF-8 decoding
// and CR suppression also work across distinct provider reads.
async function* parse(read: () => Promise<ReadableStreamReadResult<Uint8Array>>): AsyncGenerator<Frame> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  let line = '', afterCR = false, total = 0, eventLength = 0, frames = 0, reads = 0, event = ''
  let data: string[] = []
  while (true) {
    const part = await read()
    if (part.done) {
      try { decoder.decode() } catch { throw badFrame() }
      throw incomplete() // Unlike a clean terminator, EOF cannot authorize a save or completion.
    }
    if (!(part.value instanceof Uint8Array)) throw badFrame()
    total += part.value.byteLength
    if (total > maxWireBytes || ++reads > 16_384) throw tooLarge()
    let chunk: string
    try { chunk = decoder.decode(part.value, { stream: true }) } catch { throw badFrame() }
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]
      if (afterCR) {
        afterCR = false
        if (char === '\n') { start = i + 1; continue }
      }
      if (char !== '\r' && char !== '\n') continue
      afterCR = char === '\r'
      line += chunk.slice(start, i)
      start = i + 1
      eventLength += bytes(line) + 1
      if (eventLength > maxEventBytes) throw tooLarge()
      if (!line) {
        const frame = (data.length || event === 'error') ? { event, data: data.join('\n') } : null
        data = []
        event = ''
        eventLength = 0
        if (frame) {
          if (++frames > 4096) throw tooLarge()
          yield frame
        }
      } else if (line[0] !== ':') {
        const split = line.indexOf(':')
        const field = split === -1 ? line : line.slice(0, split)
        const value = split === -1 ? '' : line.slice(split + (line[split + 1] === ' ' ? 2 : 1))
        if (field === 'data') data.push(value)
        else if (field === 'event') event = value
      }
      line = ''
    }
    line += chunk.slice(start)
    if (line.length > maxEventBytes) throw tooLarge()
  }
}

export type Finish = 'stop' | 'length' | 'content_filter' | 'tool_calls' | null
export type Usage = { inputTokens: number | null; outputTokens: number | null }
export type Piece = { delta: string } | { calls: Call[]; text: string } | { finish: Finish; usage: Usage; text: string; calls: Call[] }
export type StreamTools = { rules: ToolRules; ids: ReadonlySet<string>; secret: (value: string) => void }
export type TextFilter = (delta: string, final?: boolean) => string[]

/** Buffer arguments per tool only. A parsed, declared call is eligible for
 * projection at the upstream call boundary; [DONE] still owes the terminal. */
function toolFragments(config: StreamTools) {
  const parts = new Map<number, { id: string; name: string; args: string; size: number; typed: boolean }>()
  let total = 0
  const append = (prior: string, fragment: unknown, limit: number) => {
    if (fragment === undefined || fragment === null) return prior
    if (!wellFormed(fragment) || prior.length + fragment.length > limit) throw toolOutputError()
    return prior + fragment
  }
  return {
    add(value: unknown) {
      if (!Array.isArray(value) || value.length > maxCalls || value.length && (!config.rules.tools.length || config.rules.choice === 'none')) throw toolOutputError()
      const indexes = new Set<number>()
      for (const delta of value) {
        if (!isRecord(delta) || !integer(delta.index, 0, maxCalls - 1) || indexes.has(delta.index) ||
            delta.type != null && delta.type !== 'function' || delta.function != null && !isRecord(delta.function) ||
            Object.keys(delta).some(key => !['index', 'id', 'type', 'function'].includes(key))) throw toolOutputError()
        indexes.add(delta.index)
        let part = parts.get(delta.index)
        if (!part) { part = { id: '', name: '', args: '', size: 0, typed: false }; parts.set(delta.index, part) }
        part.typed ||= delta.type === 'function'
        part.id = append(part.id, delta.id, 128)
        if (isRecord(delta.function)) {
          const spec = delta.function
          if (Object.keys(spec).some(key => !['name', 'arguments'].includes(key))) throw toolOutputError()
          part.name = append(part.name, spec.name, 64)
          if (spec.arguments != null) {
            if (!wellFormed(spec.arguments)) throw toolOutputError()
            const size = bytes(spec.arguments)
            if ((part.size += size) > maxArgumentBytes || (total += size) > maxToolPayload) throw toolOutputError()
            part.args += spec.arguments
          }
        }
      }
    },
    make(finish: Exclude<Finish, null>, text: string) {
      const calls: Call[] = []
      for (let index = 0; index < parts.size; index++) {
        const part = parts.get(index)
        if (!part?.typed) throw toolOutputError()
        config.secret(part.args)
        calls.push(readCall(config.rules, part.id, part.name, part.args, true, toolOutputError))
      }
      validateCalls(calls, finish, config.rules, config.ids, config.secret, text)
      return calls
    },
  }
}

/** Publish whole frames up to a public lexical boundary or a fixed lookahead.
 * The literal matcher can reject a stream, but cannot change the release
 * schedule for innocent text. A boundary is unsafe until the published
 * grammar excludes all future matches crossing it, not just today's key. */
export function protectStreamText(secret: string): TextFilter {
  if (!isProviderCredential(secret)) throw failed()
  const prefix = Array<number>(secret.length).fill(0)
  for (let i = 1, j = 0; i < secret.length; i++) {
    while (j && secret[i] !== secret[j]) j = prefix[j - 1]
    if (secret[i] === secret[j]) j++
    prefix[i] = j
  }
  let matched = 0, received = 0, boundary = 0, head = 0, closed = false
  let pending: { text: string; end: number }[] = []
  return (delta: string, final = false) => {
    if (closed) throw failed()
    for (let i = 0; i < delta.length; i++) {
      if (breaksProviderCredential(delta[i])) boundary = received + i + 1
      while (matched && delta[i] !== secret[matched]) matched = prefix[matched - 1]
      if (delta[i] === secret[matched]) matched++
      if (matched === secret.length) { closed = true; pending = []; throw failed() }
    }
    if (delta) {
      received += delta.length
      pending.push({ text: delta, end: received })
    }
    if (final) closed = true
    const ready: string[] = [], safeThrough = final ? received : Math.max(boundary, received - maxProviderCredentialLength + 1)
    while (head < pending.length && pending[head].end <= safeThrough) ready.push(pending[head++].text)
    if (head === pending.length) { pending = []; head = 0 }
    else if (head > 32 && head * 2 >= pending.length) { pending = pending.slice(head); head = 0 }
    return ready
  }
}

export async function* generationPieces(reader: ReadableStreamDefaultReader<Uint8Array>, wait: <T>(task: Promise<T>) => Promise<T>,
  external = false, filter?: TextFilter, tools?: StreamTools): AsyncGenerator<Piece> {
  const chunks: string[] = []
  let outputBytes = 0, hasText = false, finish: Finish = null
  const fragments = tools && toolFragments(tools)
  let calls: Call[] = []
  let filterClosed = false
  const usage: Usage = { inputTokens: null, outputTokens: null }
  const read = async () => {
    try { return await within(12_000, () => wait(reader.read()), streamTimeout) }
    catch (error) { throw translateStreamFailure(error) }
  }
  for await (const frame of parse(read)) {
    if (frame.event === 'error') throw failed()
    if (frame.data.trim() === '[DONE]') {
      if ((!hasText && !calls.length) || (external && finish === null)) throw incomplete()
      if (!filterClosed && filter) for (const delta of filter('', true)) yield { delta }
      yield { finish, usage, text: chunks.join(''), calls }
      return
    }
    let value: unknown
    try { value = JSON.parse(frame.data) } catch { throw badFrame() }
    if (!isRecord(value)) throw badFrame()
    if (value.error != null || value.type === 'error') throw failed()
    const info = isRecord(value.usage) ? value.usage : null
    if (info) {
      usage.inputTokens = usageNumber(info.prompt_tokens) ?? usage.inputTokens
      usage.outputTokens = usageNumber(info.completion_tokens) ?? usage.outputTokens
    }
    const isNative = Object.hasOwn(value, 'response')
    if (external && (isNative || !Object.hasOwn(value, 'choices'))) throw badFrame()
    let text: unknown = isNative ? value.response : undefined, reason: unknown = value.finish_reason
    if (Object.hasOwn(value, 'choices')) {
      if (isNative || !Array.isArray(value.choices) || value.choices.length > 1) throw badFrame()
      if (value.choices.length === 1) {
        const choice: unknown = value.choices[0]
        if (!isRecord(choice) || (choice.index !== undefined && choice.index !== 0) || !isRecord(choice.delta)) throw badFrame()
        const delta = choice.delta
        if ((delta.tool_calls != null && !fragments && !(external && Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0)) ||
            delta.function_call != null || delta.refusal != null ||
            (delta.role != null && delta.role !== 'assistant') ||
            tools && (delta.audio != null || delta.reasoning != null || delta.reasoning_content != null)) throw badFrame()
        if (fragments && delta.tool_calls != null) {
          if (finish !== null) throw badFrame()
          fragments.add(delta.tool_calls)
        }
        text = delta.content
        reason = choice.finish_reason
      } else if (!info) throw badFrame()
    } else if (!isNative && !info && reason == null) throw badFrame()
    if ((isNative || text != null) && (typeof text !== 'string' || /\p{Cs}/u.test(text))) throw badFrame()
    if (value.tool_calls != null || value.function_call != null || !fragments && reason === 'tool_calls' || reason === 'function_call') throw badFrame()
    if (typeof text === 'string' && text.length) {
      if (finish !== null) throw badFrame()
      outputBytes += bytes(text)
      if (outputBytes > maxOutputBytes) throw tooLarge()
      chunks.push(text)
      hasText ||= !!text.trim()
    }
    const priorFinish = finish
    if (reason != null) {
      const next: Finish = reason === 'stop' || reason === 'eos_token' ? 'stop' :
        reason === 'length' || reason === 'max_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' :
          fragments && reason === 'tool_calls' ? 'tool_calls' : null
      if (external && next === null) throw badFrame()
      if (finish !== null && next !== finish) throw badFrame()
      finish = next
    }
    if (fragments && priorFinish === null && finish !== null) calls = fragments.make(finish, chunks.join(''))
    if (typeof text === 'string' && text.length) {
      for (const delta of filter ? filter(text) : [text]) yield { delta }
    }
    if (calls.length && priorFinish === null) {
      filterClosed = true
      if (filter) for (const delta of filter('', true)) yield { delta }
      yield { calls, text: chunks.join('') }
    }
  }
}
