// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { GatewayError, bytes, maxOutputBytes, within } from './contract.js'
import { usageNumber } from './providers.js'

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

export type Finish = 'stop' | 'length' | 'content_filter' | null
export type Usage = { inputTokens: number | null; outputTokens: number | null }
type Piece = { delta: string } | { finish: Finish; usage: Usage; text: string }

export async function* generationPieces(reader: ReadableStreamDefaultReader<Uint8Array>, wait: <T>(task: Promise<T>) => Promise<T>): AsyncGenerator<Piece> {
  const chunks: string[] = []
  let outputBytes = 0, hasText = false, finish: Finish = null
  const usage: Usage = { inputTokens: null, outputTokens: null }
  const read = async () => {
    try { return await within(12_000, () => wait(reader.read()), streamTimeout) }
    catch (error) { throw translateStreamFailure(error) }
  }
  for await (const frame of parse(read)) {
    if (frame.event === 'error') throw failed()
    if (frame.data.trim() === '[DONE]') {
      if (!hasText) throw incomplete()
      yield { finish, usage, text: chunks.join('') }
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
    let text: unknown = isNative ? value.response : undefined, reason: unknown = value.finish_reason
    if (Object.hasOwn(value, 'choices')) {
      if (isNative || !Array.isArray(value.choices) || value.choices.length > 1) throw badFrame()
      if (value.choices.length === 1) {
        const choice: unknown = value.choices[0]
        if (!isRecord(choice) || (choice.index !== undefined && choice.index !== 0) || !isRecord(choice.delta)) throw badFrame()
        const delta = choice.delta
        if (delta.tool_calls != null || delta.function_call != null || delta.refusal != null ||
            (delta.role != null && delta.role !== 'assistant')) throw badFrame()
        text = delta.content
        reason = choice.finish_reason
      } else if (!info) throw badFrame()
    } else if (!isNative && !info && reason == null) throw badFrame()
    if ((isNative || text != null) && (typeof text !== 'string' || /\p{Cs}/u.test(text))) throw badFrame()
    if (value.tool_calls != null || value.function_call != null || reason === 'tool_calls' || reason === 'function_call') throw badFrame()
    if (typeof text === 'string' && text.length) {
      if (finish !== null) throw badFrame()
      outputBytes += bytes(text)
      if (outputBytes > maxOutputBytes) throw tooLarge()
      chunks.push(text)
      hasText ||= !!text.trim()
    }
    if (reason != null) {
      const next: Finish = reason === 'stop' || reason === 'eos_token' ? 'stop' :
        reason === 'length' || reason === 'max_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : null
      if (finish !== null && next !== finish) throw badFrame()
      finish = next
    }
    if (typeof text === 'string' && text.length) yield { delta: text }
  }
}
