// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, readJson } from '../http.js'

export const byteLength = (value: string) => new TextEncoder().encode(value).byteLength
const maxValueBytes = 1024 * 1024
const maxLabelsBytes = 64 * 1024
const maxBodyBytes = maxValueBytes + maxLabelsBytes + 16 * 1024
const maxStringBytes = 64 * 1024
const maxFieldBytes = 255
const identifierPattern = '[A-Za-z0-9_.@-]+'
const identifier = new RegExp(`^${identifierPattern}$`)

export class PrivacyInputError extends ApiError {
  constructor(message: string, readonly details: Record<string, number | string>) {
    super(400, 'INVALID_ARGUMENT', message)
  }
}

function invalid(field: string, reason: string, bounds: Record<string, number> = {}): never {
  // Never include a raw value or a user-provided JSON key/path in error details.
  throw new PrivacyInputError(`Invalid Privacy ${field}: ${reason}.`, { field, reason, ...bounds })
}

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Privacy target, version, or field not found.')
export const denied = (message: string) => new ApiError(403, 'PERMISSION_DENIED', message)

export function segment(value: string, field: 'category' | 'target_key' | 'owner_user_id'): string {
  const reason = !value ? 'must not be empty'
    : value !== value.trim() ? 'must not contain leading or trailing whitespace'
    : value.length > 255 ? 'must not exceed 255 characters'
    : value === '.' || value === '..' ? "must not be '.' or '..'"
    : !identifier.test(value) ? "may contain only ASCII letters, digits, '_', '-', '.', and '@'"
    : value.indexOf('@') !== value.lastIndexOf('@') ? "must contain at most one '@'"
    : null
  if (reason) throw new PrivacyInputError(`Invalid Privacy ${field}: ${reason}.`, {
    field, reason, allowed_pattern: identifierPattern, max_characters: 255,
  })
  return value
}

export function decoded(value: string): string {
  try { return decodeURIComponent(value) } catch { return invalid('path or selector', 'invalid percent encoding') }
}

export function name(value: unknown, field: 'field' | 'values' | 'labels' = 'field'): string {
  if (typeof value !== 'string' || !value) invalid(field, 'expected a non-empty field name')
  if (/[\x00-\x1f\x7f\p{Cs}]/u.test(value)) invalid(field, 'invalid field name characters')
  if (byteLength(value) > maxFieldBytes) invalid(field, 'field name too large', { max_bytes: maxFieldBytes })
  return value
}

// All inputs come from JSON.parse. Bound recursion, then canonicalize recursively
// for a retry with a different object-key order to remain version-idempotent.
function canonical(value: unknown, field: 'values' | 'labels', depth: number): unknown {
  if (depth > 16) invalid(field, 'maximum nesting depth exceeded', { max_depth: 16 })
  if (typeof value === 'string') {
    if (/\p{Cs}/u.test(value)) invalid(field, 'invalid Unicode string')
    if (byteLength(value) > maxStringBytes) invalid(field, 'string value too large', { max_bytes: maxStringBytes })
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) invalid(field, 'collection too large', { max_items: 4096 })
    return value.map(item => canonical(item, field, depth + 1))
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    if (keys.length > 4096) invalid(field, 'collection too large', { max_items: 4096 })
    return Object.fromEntries(keys.map(key => [name(key, field), canonical(value[key], field, depth + 1)]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) invalid(field, 'non-finite number')
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return invalid(field, 'unsupported JSON value')
}

function serialized(object: Record<string, unknown>, field: 'values' | 'labels', maxBytes: number, maxFields: number): string {
  if (Object.keys(object).length > maxFields) invalid(field, 'too many fields', { max_fields: maxFields })
  const payload = JSON.stringify(canonical(object, field, 1))
  if (byteLength(payload) > maxBytes) invalid(field, 'serialized payload too large', { max_bytes: maxBytes })
  return payload
}

export function serializeValues(values: Record<string, unknown>, category: string): string {
  return serialized(values, 'values', maxValueBytes, category === 'session' ? 1024 : 128)
}

async function body(request: Request, keys: readonly string[], limit = 8 * 1024) {
  const parsed = await readJson(request, limit)
  if (Object.keys(parsed).some(key => !keys.includes(key))) invalid('request', 'unexpected JSON member')
  return parsed
}

export async function writeCommand(request: Request) {
  const input = await body(request, ['values', 'change_reason', 'labels'], maxBodyBytes)
  const { values, change_reason: reason = '', labels } = input
  if (!isRecord(values)) invalid('values', 'expected object')
  if (typeof reason !== 'string' || /\p{Cs}/u.test(reason)) invalid('change_reason', 'expected a valid Unicode string')
  if (reason.length > 2048 || [...reason].length > 1024) invalid('change_reason', 'too long', { max_characters: 1024 })
  if (labels !== undefined && labels !== null && !isRecord(labels)) invalid('labels', 'expected object or null')
  return { values, reason, labels: isRecord(labels) ? serialized(labels, 'labels', maxLabelsBytes, 64) : null }
}

export function versionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return invalid('version', 'expected a positive integer')
  }
  return value
}

export async function activateCommand(request: Request): Promise<number> {
  return versionNumber((await body(request, ['version'])).version)
}

export async function scanCommand(request: Request) {
  const { uri, fix = false, node_limit: limit = 1000 } = await body(request, ['uri', 'fix', 'node_limit'])
  if (typeof uri !== 'string' || !uri || [...uri].length > 2048) invalid('uri', 'expected 1 to 2048 characters')
  if (typeof fix !== 'boolean') invalid('fix', 'expected a boolean')
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    invalid('node_limit', 'expected an integer between 1 and 1000')
  }
  return { uri, fix, limit }
}

type Selector = { category: string; target: string; field?: string }
const ownerReference = /^\{\{[ \t]*ov_privacy:([^\s:{}]+):viking:\/\/~\/privacy\/([^/\s]+)\/([^#\s]+)#\/values\/([^}\s]+)[ \t]*\}\}$/
const selectorUri = /^viking:\/\/(~|user\/([^/]+))\/privacy\/([^/]+)\/([^#]+)(?:#\/values\/(.+))?$/

export async function select(request: Request, owner: string, requireField: boolean): Promise<Selector> {
  const { selector } = await body(request, ['selector'])
  if (typeof selector !== 'string' || !selector || [...selector].length > 2048) invalid('selector', 'expected 1 to 2048 characters')
  const ref = ownerReference.exec(selector)
  const uri = ref ? null : selectorUri.exec(selector)
  const tokens = ref ? ref.slice(1) : uri ? uri.slice(2) : null
  if (!tokens || (requireField && !tokens[3])) invalid('selector', 'expected an owner-bound Privacy field reference or Privacy URI of the required scope')
  const [selectedOwner = owner, category, target, field] = tokens
  if (segment(selectedOwner, 'owner_user_id') !== owner) throw denied('Privacy references are for their owner only.')
  return { category: segment(decoded(category), 'category'), target: segment(decoded(target), 'target_key'),
    ...(field !== undefined && { field: name(decoded(field)) }) }
}

// RFC 3986 segment encoding (same escaping as urllib.parse.quote with safe='').
const encode = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
export const reference = (owner: string, category: string, target: string, field: string) =>
  `{{ov_privacy:${owner}:viking://~/privacy/${encode(category)}/${encode(target)}#/values/${encode(field)}}}`

export function query(url: URL, parameter: 'category' | 'field' | 'reveal'): string | null {
  const values = url.searchParams.getAll(parameter)
  if (values.length > 1) invalid(parameter, 'expected a single parameter')
  return values[0] ?? null
}

export function requireNoReveal(url: URL): void {
  const value = query(url, 'reveal')?.toLowerCase()
  if (value === undefined || ['0', 'false', 'off', 'n', 'no', 'f'].includes(value)) return
  if (['1', 'true', 'on', 'y', 'yes', 't'].includes(value)) throw denied('Privacy values cannot be revealed by HTTP.')
  invalid('reveal', 'expected a boolean')
}
