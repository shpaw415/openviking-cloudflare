// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'

export const ROOT = 'viking://'
export const SHARED_SKILLS = 'shared-skills'
export const SYSTEM_COMPILE = 'system-compile'
export const EXAMPLE_SKILLS = `${ROOT}system/compile/example-skills`
export const FILE_LIMIT = 64 * 1024
export const WRITE_LIMIT = FILE_LIMIT * 6 + 8192 // JSON escapes may use six bytes per character.
export const JSON_LIMIT = 16 * 1024
export const MAX_DEPTH = 20
export const PAGE_LIMIT = 1000
export const encoder = new TextEncoder()

export function invalid(message: string): never { throw new ApiError(400, 'INVALID_ARGUMENT', message) }
export function invalidUri(): never { throw new ApiError(400, 'INVALID_URI', 'Invalid Viking URI or path segment.') }
export function unsupported(message: string): never { throw new ApiError(501, 'NOT_IMPLEMENTED', message) }
export function missing(): never { throw new ApiError(404, 'NOT_FOUND', 'Viking entry was not found.') }
export function denied(message: string): never { throw new ApiError(403, 'PERMISSION_DENIED', message) }
export function conflict(message: string): never { throw new ApiError(409, 'CONFLICT', message) }
export function exists(): never { throw new ApiError(409, 'ALREADY_EXISTS', 'The destination already exists.') }
export function quota(message: string): never { throw new ApiError(413, 'RESOURCE_EXHAUSTED', message) }

export function str(value: unknown, field: string, fallback?: string, max = 4096): string {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.length > max || /\p{Cs}/u.test(value)) invalid(`${field} must be a bounded string.`)
  return value
}

export function bool(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean.`)
  return value
}

export function int(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(`${field} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function choice<T extends string>(value: unknown, field: string, choices: readonly T[], fallback: T): T {
  const selected = str(value, field, fallback)
  if (!choices.includes(selected as T)) invalid(`Unsupported value for ${field}.`)
  return selected as T
}

export function onlyKeys(body: Record<string, unknown>, keys: string): void {
  const known = keys.split(' ')
  if (Object.keys(body).some(key => !known.includes(key))) invalid('The request contains an unknown field.')
}

// Studio requests telemetry even for a synchronous local import. It is transport-only here.
export function transport(body: Record<string, unknown>): void {
  bool(body.wait, 'wait')
  if (body.timeout != null && (typeof body.timeout !== 'number' || !Number.isFinite(body.timeout) || body.timeout < 0)) {
    invalid('timeout must be a nonnegative number.')
  }
  if (body.telemetry !== undefined && typeof body.telemetry !== 'boolean' && (
    body.telemetry === null || typeof body.telemetry !== 'object' || Array.isArray(body.telemetry) ||
    !Object.values(body.telemetry).every(value => typeof value === 'boolean')
  )) invalid('Invalid telemetry options.')
}

export function queryString(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key)
  if (values.length > 1) invalid(`${key} must not be repeated.`)
  return values[0]
}

export function queryBool(query: URLSearchParams, key: string, fallback = false): boolean {
  const value = queryString(query, key)
  if (value === undefined) return fallback
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(value.toLowerCase())) return false
  return invalid(`${key} must be a boolean.`)
}

export function queryInt(query: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const value = queryString(query, key)
  if (value !== undefined && !/^-?\d{1,12}$/.test(value)) invalid(`${key} must be an integer.`)
  return int(value === undefined ? undefined : Number(value), key, fallback, min, max)
}

export function parseTags(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 16) invalid('Expected up to 16 k=v tags.')
  const tags = value.map((item: unknown) => {
    const tag = str(item, 'tag').trim()
    const equals = tag.indexOf('=')
    const key = tag.slice(0, equals).trim()
    const val = tag.slice(equals + 1).trim()
    if (equals < 1 || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,47}$/.test(key) || !val ||
        encoder.encode(val).length > 128 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(val)) invalid('Expected a bounded k=v tag.')
    return `${key}=${val}`
  })
  return uniqueTags(tags)
}

function uniqueTags(tags: string[]): string[] {
  return [...new Map(tags.map(tag => [tag.slice(0, tag.indexOf('=')), tag])).values()].sort()
}

export function tagMode(value: unknown, field = 'tag_mode') {
  return choice(value, field, ['replace', 'append', 'clear'] as const, 'replace')
}

export function mergeTags(current: string[], tags: string[], mode: ReturnType<typeof tagMode>): string[] {
  if (mode === 'clear') return []
  if (mode === 'replace') return tags
  const merged = uniqueTags([...current, ...tags])
  if (merged.length > 16) invalid('An entry can have at most 16 tags.')
  return merged
}

export const tagMatch = (current: string[], wanted: string[]) => wanted.every(tag => current.includes(tag))

export type ContextKind = 'memory' | 'resource' | 'skill'
export type Caller = WorkspaceContext['caller']
export type FsPath = {
  uri: string
  parts: string[]
  space: string | null
  builtin: boolean
  managed: boolean
  kind: ContextKind
}

const userRoots = ['memories', 'resources', 'skills']
const managedUser = ['skills', 'peers', 'privacy', 'sessions', 'tools']
export const spaces = (caller: Caller): [string, string, string] => [
  'shared', JSON.stringify(['user', caller.userId]), JSON.stringify(['agent', caller.userId, caller.agentId]),
]

function checkedSegment(segment: string): string {
  const normal = segment.normalize('NFC')
  if (!normal || normal !== normal.trim() || normal === '.' || normal === '..' ||
      /[/\\%?#:\uFFFD\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(normal) || encoder.encode(normal).length > 160) invalidUri()
  return normal
}

export function filename(value: unknown): string {
  if (typeof value !== 'string' || value.length > 160) invalidUri()
  return checkedSegment(value)
}

export function partsOf(uri: string): string[] { return uri === ROOT ? [] : uri.slice(ROOT.length).split('/') }
export function uriOf(parts: string[]): string {
  const uri = ROOT + parts.join('/')
  if (parts.length > MAX_DEPTH || encoder.encode(uri).length > 1024) invalidUri()
  return uri
}

export function fromParts(parts: string[], caller: Caller): FsPath {
  const uri = uriOf(parts)
  const [head, second, third] = parts
  const [shared, user, agent] = spaces(caller)
  if (head === undefined || (head === 'user' && second === undefined)) {
    return { uri, parts, space: null, builtin: true, managed: true, kind: 'resource' }
  }
  if (head === 'resources') {
    return { uri, parts, space: shared, builtin: parts.length === 1, managed: false, kind: 'resource' }
  }
  if (head === 'agent') {
    return { uri, parts, space: second === 'skills' ? SHARED_SKILLS : agent, builtin: !second || (second === 'skills' && parts.length === 2),
      managed: second === 'skills' || second === 'tools', kind: second === 'skills' ? 'skill' : 'resource' }
  }
  if (head === 'user') {
    if (second !== caller.userId) denied('Only the caller’s private user space is accessible.')
    return { uri, parts, space: user, builtin: !third || (userRoots.includes(third) && parts.length === 3),
      managed: managedUser.includes(third), kind: third === 'memories' ? 'memory' : third === 'skills' ? 'skill' : 'resource' }
  }
  if (head === 'system' && parts.length <= 5 && (!second || second === 'compile') &&
      (!third || third === 'example-skills') && (parts.length !== 5 || parts[4] === 'SKILL.md')) {
    return { uri, parts, space: SYSTEM_COMPILE, builtin: true, managed: true, kind: third ? 'skill' : 'resource' }
  }
  return invalidUri()
}

export function pathFor(input: unknown, caller: Caller): FsPath {
  if (typeof input !== 'string' || input.length > 4096 || !input.startsWith(ROOT)) invalidUri()
  if (input === ROOT) return fromParts([], caller)
  const tail = input.slice(ROOT.length).replace(/\/$/, '')
  if (!tail) return invalidUri()
  const parts = tail.split('/').map(part => {
    let decoded: string
    try { decoded = decodeURIComponent(part) } catch { return invalidUri() }
    return checkedSegment(decoded)
  })
  if (parts[0] === '~') parts.splice(0, 1, 'user', caller.userId)
  return fromParts(parts, caller)
}

export function roots(caller: Caller): FsPath[] {
  return [[], ['resources'], ['user'], ['user', caller.userId],
    ...userRoots.map(root => ['user', caller.userId, root]), ['agent'], ['agent', 'skills']]
    .map(parts => fromParts(parts, caller))
}

export function writable(path: FsPath, caller: Caller): asserts path is FsPath & { space: string } {
  if (path.builtin || path.managed || path.space === null) denied('This namespace is managed or read-only.')
  // Shared write/manage authority is resolved by Filesystem against current ACLs.
  if (path.parts[0] === 'user' && path.parts[1] !== caller.userId) denied('Only the caller’s private user space is accessible.')
}

export function resourcePath(path: FsPath, parent = false): void {
  if (path.parts[0] === 'resources' && (parent || path.parts.length > 1)) return
  if (path.parts[0] === 'user' && path.parts[2] === 'resources' && (parent || path.parts.length > 3)) return
  invalid('Resource imports require a shared or private resources destination.')
}

export function sharedChild(path: FsPath): void {
  if (path.parts[0] !== 'resources' || path.parts.length < 2) invalid('Expected a child of viking://resources.')
}

export const absChild = (uri: string, base: string) => uri.startsWith(base === ROOT ? ROOT : `${base}/`) && uri !== base
export const inPath = (uri: string, base: string) => uri === base || absChild(uri, base)
export const nameOf = (uri: string) => uri === ROOT ? ROOT : uri.slice(uri.lastIndexOf('/') + 1)
export const relative = (uri: string, base: string) => uri === base ? nameOf(uri) : uri.slice(base.length + (base === ROOT ? 0 : 1))
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function textFile(name: string): void {
  if (!/\.(md|txt|json|ya?ml|toml|py|js|ts|csv|tsv|rst|log)$/i.test(name)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only supported textual file extensions are accepted.')
  }
}

export function textSize(content: string): number {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cs}]/u.test(content)) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected UTF-8 text, not binary or control bytes.')
  }
  const bytes = encoder.encode(content).byteLength
  if (bytes > FILE_LIMIT) quota(`File exceeds ${FILE_LIMIT} UTF-8 bytes.`)
  return bytes
}

// Lines retain their endings so an unrestricted read round-trips the original bytes.
export function linesOf(content: string): string[] { return content.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [] }
