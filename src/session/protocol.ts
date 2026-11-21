// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, readBytes } from '../http.js'
import { parseTags } from '../fs/contract.js'
import { byteLength } from './generation.js'

export function invalid(message: string): never {
  throw new ApiError(400, 'INVALID_ARGUMENT', message)
}

export function unsupported(message: string): never {
  throw new ApiError(501, 'NOT_IMPLEMENTED', message)
}

export function quota(message: string): never {
  throw new ApiError(413, 'RESOURCE_EXHAUSTED', message)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeSegment(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    invalid('Malformed path segment.')
  }
}

export async function optionalJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, 16 * 1024)
  if (bytes.byteLength === 0) return {}
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'INVALID_ARGUMENT', 'Expected an application/json body.')
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    invalid('Invalid UTF-8 or JSON.')
  }
  if (!isRecord(value)) invalid('Expected a JSON object.')
  return value
}

export function noTelemetry(value: unknown): void {
  if (value !== undefined && value !== false) unsupported('Session operation telemetry is not available on Workers.')
}

export function memoryPolicy(value: unknown): string | null {
  if (value == null) return null
  if (!isRecord(value) || Object.keys(value).some(key => !['self', 'peer', 'working_memory', 'memory_types'].includes(key))) {
    invalid('Invalid memory_policy.')
  }
  const enabled = (name: string, fallback: boolean): boolean => {
    const target = value[name]
    if (target == null) return fallback
    if (!isRecord(target) || Object.keys(target).some(key => key !== 'enabled') ||
        (target.enabled !== undefined && typeof target.enabled !== 'boolean')) {
      invalid(`memory_policy.${name} must contain at most an enabled boolean.`)
    }
    return target.enabled ?? fallback
  }
  const policy = { self: { enabled: enabled('self', true) }, peer: { enabled: enabled('peer', false) },
    working_memory: { enabled: enabled('working_memory', false) } }
  const types = value.memory_types
  if (types != null && (!Array.isArray(types) || types.some(type => typeof type !== 'string' || !type))) {
    invalid('memory_policy.memory_types must be an array of non-empty strings.')
  }
  if ((Array.isArray(types) && types.some(type => type !== 'events')) ||
      (policy.peer.enabled && !Array.isArray(types)) || (policy.peer.enabled && Array.isArray(types) && types.length)) {
    unsupported('Only owner-scoped event extraction is supported; peer writes and other memory types are unavailable.')
  }
  return JSON.stringify({ ...policy, ...(Array.isArray(types) && { memory_types: [...new Set(types)] }) })
}

// Absent/null inherits; [] deliberately overrides or clears the stored tags.
export function eventTags(value: unknown, key: 'event' | 'events'): string[] | undefined {
  if (value == null) return
  if (!isRecord(value) || Object.keys(value).some(name => name !== key)) invalid('Invalid extraction configuration.')
  const event = value[key]
  if (event == null) return
  if (!isRecord(event) || Object.keys(event).some(name => name !== 'tags')) invalid('Invalid event extraction configuration.')
  const tags = event.tags
  if (tags == null) return
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) invalid('Event tags must be an array of strings.')
  return parseTags(tags)
}

export function commitOptions(body: Record<string, unknown>) {
  noTelemetry(body.telemetry)
  const tags = eventTags(body.extraction_metadata, 'event')
  const keep = body.keep_recent_count === undefined ? 0 : body.keep_recent_count
  if (typeof keep !== 'number' || !Number.isSafeInteger(keep) || keep < 0 || keep > 10_000) {
    invalid('keep_recent_count must be an integer between 0 and 10000.')
  }
  const reset = body.reset_context === undefined ? false : body.reset_context
  if (typeof reset !== 'boolean') invalid('reset_context must be a boolean.')
  if (body.enable_working_memory != null && typeof body.enable_working_memory !== 'boolean') {
    invalid('enable_working_memory must be a boolean or null.')
  }
  if (reset && (keep !== 0 || body.retention_mode != null)) invalid('reset_context requires keep_recent_count=0 and no retention_mode.')
  if ([
    'memory_policy', 'retention_mode', 'keep_recent_turn_count', 'retained_message_token_budget', 'min_raw_tail_steps',
    'session_window_context', 'summary_token_ratio', 'retained_token_ratio', 'reasoning_effort',
  ].some(name => body[name] != null)) unsupported('Turn-budget and model-specific retention options are not available on Workers.')
  return { keep, reset, tags, working: body.enable_working_memory as boolean | null | undefined }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(`${field} must be a string.`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value == null ? undefined : string(value, field)
}

export function userUriPart(userId: string): string {
  return encodeURIComponent(userId).replace(/%40/g, '@')
}

// Reference fields are data, never authority to read a file (or to fetch a URL).
function referenceUri(value: string, userId: string): string {
  if (!value.startsWith('viking://')) invalid('Expected a viking:// reference.')
  const parts = value.slice('viking://'.length).replace(/\/$/, '').split('/')
  const decoded = parts.map(decodeSegment)
  if (decoded.some(part => !part || part === '.' || part === '..' || /[/\\%?#\x00-\x1f\x7f]/.test(part))) {
    invalid('Invalid viking:// reference.')
  }
  switch (parts[0]) {
    case '~': return ['viking://user', userUriPart(userId), ...parts.slice(1)].join('/')
    case 'user':
      if (decoded[1] !== userId) throw new ApiError(403, 'PERMISSION_DENIED', 'User reference is outside this namespace.')
      return ['viking://user', userUriPart(userId), ...parts.slice(2)].join('/')
    case 'resources':
    case 'agent': return `viking://${parts.join('/')}`
    default: return invalid('Unsupported viking:// reference namespace.')
  }
}

function imageReference(value: string, userId: string): string {
  if (value.startsWith('viking://')) return referenceUri(value, userId)
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/.test(value)) return value
  let url: URL
  try { url = new URL(value) } catch { invalid('Expected a valid image_url.') }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    invalid('Unsupported image_url format.')
  }
  return value
}

function validateToolInput(value: unknown, depth = 0): void {
  if (depth > 32) invalid('tool_input nesting exceeds 32 levels.')
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('tool_input contains a non-finite number.')
  if (Array.isArray(value)) {
    for (const item of value) validateToolInput(item, depth + 1)
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) validateToolInput(item, depth + 1)
  }
}

export type Part =
  | { type: 'text', text: string }
  | { type: 'context', uri: string, context_type: string, abstract: string }
  | { type: 'image_url', image_url: { url: string, detail?: string } }
  | ({ type: 'tool', tool_id: string, tool_name: string, tool_input?: Record<string, unknown>, tool_output?: string }
    & Record<string, unknown>)

const toolStrings = [
  'tool_output', 'tool_output_ref', 'tool_output_sha256', 'tool_output_storage_uri',
  'tool_output_mime_type', 'tool_output_source_ref', 'tool_output_externalization_error',
  'tool_output_group_id', 'tool_output_externalized_reason',
] as const
const toolIntegerFields = [
  'prompt_tokens', 'completion_tokens', 'tool_output_original_chars', 'tool_output_preview_chars',
  'tool_output_source_offset', 'tool_output_source_limit', 'tool_output_group_original_chars',
  'tool_output_group_budget_chars',
] as const

function part(value: unknown, userId: string): Part {
  if (!isRecord(value)) invalid('Each part must be an object.')
  switch (value.type === undefined ? 'text' : value.type) {
    case 'text': return { type: 'text', text: string(value.text === undefined ? '' : value.text, 'text') }
    case 'context': {
      const uri = string(value.uri === undefined ? '' : value.uri, 'uri')
      const type = value.context_type === undefined ? 'memory' : value.context_type
      if (type !== 'memory' && type !== 'resource' && type !== 'skill') invalid('Invalid context_type.')
      return { type: 'context', uri: uri ? referenceUri(uri, userId) : '', context_type: type,
        abstract: string(value.abstract === undefined ? '' : value.abstract, 'abstract') }
    }
    case 'image_url': {
      const image = isRecord(value.image_url) ? value.image_url : { url: value.image_url }
      const url = imageReference(string(image.url, 'image_url.url'), userId)
      const detail = optionalString(image.detail, 'image_url.detail')
      return { type: 'image_url', image_url: detail === undefined ? { url } : { url, detail } }
    }
    case 'tool': {
      const field = (name: string, fallback = '') => string(value[name] === undefined ? fallback : value[name], name)
      const uri = field('tool_uri'), skill = field('skill_uri')
      const tool: Part = { type: 'tool', tool_id: field('tool_id'), tool_name: field('tool_name'),
        tool_uri: uri ? referenceUri(uri, userId) : '', skill_uri: skill ? referenceUri(skill, userId) : '',
        tool_status: field('tool_status', 'pending') }
      if (value.tool_input != null) {
        if (!isRecord(value.tool_input)) invalid('tool_input must be an object.')
        validateToolInput(value.tool_input)
        tool.tool_input = value.tool_input
      }
      for (const name of toolStrings) {
        const text = field(name)
        if (text && !(name === 'tool_output_mime_type' && text === 'text/plain')) {
          tool[name] = name === 'tool_output_storage_uri' ? referenceUri(text, userId) : text
        }
      }
      for (const name of ['duration_ms', ...toolIntegerFields]) {
        const num = value[name]
        if (num == null) continue
        if (typeof num !== 'number' || (name === 'duration_ms' ? !Number.isFinite(num) : !Number.isSafeInteger(num))) {
          invalid(`${name} must be a ${name === 'duration_ms' ? 'finite number' : 'safe integer'}.`)
        }
        tool[name] = num
      }
      if (value.tool_output_truncated !== undefined && typeof value.tool_output_truncated !== 'boolean') {
        invalid('tool_output_truncated must be a boolean.')
      }
      if (value.tool_output_truncated === true) tool.tool_output_truncated = true
      return tool
    }
    default: return invalid('Unknown message part type.')
  }
}

const cjk = /[\u1100-\u11ff\u3000-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef\u{20000}-\u{2ebef}]/u

function tokenUnits(text: string): number {
  if (/^[\x00-\x7f]*$/.test(text)) return text.length
  let units = 0
  for (const char of text) units += cjk.test(char) ? 6 : char.length === 2 ? 8 : 1
  return units
}

function estimateTokens(parts: Part[]): number {
  let units = 0
  for (const p of parts) {
    if (p.type === 'text') units += tokenUnits(p.text)
    if (p.type === 'context') units += tokenUnits(p.abstract)
    if (p.type === 'tool') {
      units += tokenUnits(p.tool_id) + tokenUnits(p.tool_name) + tokenUnits(p.tool_output ?? '')
      if (p.tool_input && Object.keys(p.tool_input).length) units += tokenUnits(JSON.stringify(p.tool_input))
    }
  }
  return Math.ceil(units / 4)
}

export type StoredMessage = {
  id: string, role: string, created_at: string, parts: Part[], peer_id?: string, turn_id?: string,
  message_kind?: string, interrupted?: boolean,
}
export type EncodedMessage = { payload: string, tokens: number }
export const estimateText = (text: string) => Math.ceil(tokenUnits(text) / 4)
export const messageText = (message: StoredMessage) => message.parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n')

export function encodeMessages(body: Record<string, unknown>, batch: boolean, userId: string) {
  noTelemetry(body.telemetry)
  const specs = batch ? body.messages : [body]
  if (!Array.isArray(specs) || specs.length > 100) invalid('messages must be an array of at most 100 entries.')
  const rows: EncodedMessage[] = []
  let bytes = 0
  for (const input of specs) {
    if (!isRecord(input)) invalid('Each message must be an object.')
    noTelemetry(input.telemetry)
    const role = string(input.role, 'role')
    const content = optionalString(input.content, 'content')
    let parts: Part[]
    if (input.parts == null) {
      if (content === undefined) invalid('Either content or parts is required.')
      parts = [{ type: 'text', text: content }]
    } else {
      if (!Array.isArray(input.parts) || input.parts.length > 64) invalid('parts must be an array of at most 64 entries.')
      parts = input.parts.map(p => part(p, userId))
    }
    const peer = optionalString(input.peer_id, 'peer_id')?.trim()
    if (peer && (peer.length > 255 || /[^a-zA-Z0-9_.@-]/.test(peer) || peer === '.' || peer === '..' || /@.*@/.test(peer))) {
      invalid('Invalid peer_id.')
    }
    const turn = optionalString(input.turn_id, 'turn_id')
    const kind = optionalString(input.message_kind, 'message_kind')
    if (kind !== undefined && !['user_query', 'assistant_step', 'tool_transport', 'checkpoint'].includes(kind)) {
      invalid('Invalid message_kind.')
    }
    const sources = input.source_message_ids
    if (sources != null && (!Array.isArray(sources) || sources.some(id => typeof id !== 'string'))) {
      invalid('source_message_ids must be an array of strings.')
    }
    if (input.interrupted !== undefined && typeof input.interrupted !== 'boolean') invalid('interrupted must be a boolean.')
    const created = optionalString(input.created_at, 'created_at') || new Date().toISOString()
    const split = role === 'user' && parts.length > 1 && parts.every(p => p.type === 'tool')
    for (const group of split ? parts.map(p => [p]) : [parts]) {
      const payload = JSON.stringify({
        id: `msg_${crypto.randomUUID().replace(/-/g, '')}`, role, parts: group, created_at: created,
        ...(peer ? { peer_id: peer } : {}), ...(turn === undefined ? {} : { turn_id: turn }),
        ...(split || kind !== undefined ? { message_kind: kind ?? 'tool_transport' } : {}),
        ...(sources == null ? {} : { source_message_ids: sources }),
        ...(role === 'assistant' && input.interrupted === true ? { interrupted: true } : {}),
      })
      const size = byteLength(payload) + 1 // JSONL newline
      if (size > 64 * 1024) quota('One stored message exceeds 64 KiB.')
      bytes += size
      if (bytes > 1024 * 1024 || rows.length === 256) quota('Expanded append exceeds 1 MiB or 256 stored messages.')
      rows.push({ payload, tokens: estimateTokens(group) })
    }
  }
  return { rows, bytes }
}
