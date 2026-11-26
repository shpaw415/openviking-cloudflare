// SPDX-License-Identifier: AGPL-3.0-only
import { bytes, fields, invalid, record, unsupported } from './contract.js'
import type { Protocol } from './contract.js'
import type { Capability } from './media.js'
import { matchesOutput, outputSchema, wellFormed } from './tool-dto.js'

export type NativeOptions = {
  sampling?: { temperature?: number; top_p?: number }
  stop?: string[]
  format?: { schema: ReturnType<typeof outputSchema>; name?: string; description?: string }
}

export function nativeOptionFields(protocol: Protocol): string[] {
  if (protocol === 'chat') return []
  return ['temperature', 'top_p', ...(protocol === 'responses' ? ['text'] : ['stop_sequences', 'output_config'])]
}

export const optionUnavailable = () => unsupported('The selected native model has not enabled this protocol option.', 'native_option_unsupported')

export function nativeOptions(raw: Record<string, unknown>, protocol: Protocol, capabilities: ReadonlySet<Capability>, stream: boolean): NativeOptions {
  const out: NativeOptions = {}
  const bad = () => invalid('Invalid native generation option.', 'native_option_invalid')
  if (raw.temperature !== undefined || raw.top_p !== undefined) {
    if (!capabilities.has('sampling')) throw optionUnavailable()
    if (protocol === 'anthropic' && raw.temperature !== undefined && raw.top_p !== undefined) throw bad()
    const sampling: NonNullable<NativeOptions['sampling']> = {}
    for (const key of ['temperature', 'top_p'] as const) {
      const val = raw[key]
      if (val === undefined) continue
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > (key === 'temperature' && protocol === 'responses' ? 2 : 1)) throw bad()
      sampling[key] = val
    }
    out.sampling = sampling
  }
  if (protocol === 'anthropic' && raw.stop_sequences !== undefined) {
    if (!capabilities.has('stop_sequences')) throw optionUnavailable()
    const stop = raw.stop_sequences
    if (!Array.isArray(stop) || !stop.length || stop.length > 4 || new Set(stop).size !== stop.length ||
        stop.some(s => !wellFormed(s) || !s.length || bytes(s) > 128)) throw bad()
    out.stop = stop
  }
  const rawFormat = protocol === 'responses' ? raw.text : raw.output_config
  if (rawFormat !== undefined) {
    if (!capabilities.has('structured')) throw optionUnavailable()
    const envelope = record(rawFormat, bad)
    fields(envelope, ['format'], bad)
    const format = record(envelope.format, bad)
    if (protocol === 'responses' && format.type === 'text') { fields(format, ['type'], bad); return out }
    if (stream || raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length) ||
        raw.store === true || raw.previous_response_id != null) throw optionUnavailable()
    if (format.type !== 'json_schema') throw bad()
    fields(format, protocol === 'responses' ? ['type', 'schema', 'name', 'description', 'strict'] : ['type', 'schema'], bad)
    if (protocol === 'responses' && (typeof format.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name) ||
        format.strict !== true || format.description !== undefined && (!wellFormed(format.description) || bytes(format.description) > 512))) throw bad()
    let schema: ReturnType<typeof outputSchema>
    try { schema = outputSchema(format.schema) } catch { throw bad() }
    out.format = { schema, ...(protocol === 'responses' && { name: format.name as string, description: format.description as string | undefined }) }
  }
  return out
}

export const validStructuredOutput = (options: NativeOptions | undefined, text: string, secret: (value: string) => void) =>
  !options?.format || matchesOutput(options.format.schema, text, secret)
