// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '../http.js'

export const SNAPSHOT_PREFIX = '/api/v1/snapshot'
export const PACK_PREFIX = '/api/v1/pack'
export const DAV_ROOT = '/webdav/resources'
export const RESOURCES = 'viking://resources'
const utf8 = new TextEncoder()
export const encoder = { encode: (body: string): Uint8Array<ArrayBuffer> => utf8.encode(body) as Uint8Array<ArrayBuffer> }
export const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const under = (uri: string, base: string) => uri === base || uri.startsWith(`${base}/`)
export const leaf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1)
export const relative = (uri: string, root: string) => uri === root ? '' : uri.slice(root.length + 1)
export const internal = (name: string) => ['.relations.json', '.path.ovlock', '.sync_log.json', '.redirect.json'].includes(name)
  || name.startsWith('.exact.ovlock.')
export const sidecar = (name: string) => name === '.abstract.md' || name === '.overview.md'

export function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message) }
export const invalid = (message: string): never => fail(400, 'INVALID_ARGUMENT', message)
export const forbidden = (message: string): never => fail(403, 'PERMISSION_DENIED', message)
export const quota = (message: string): never => fail(413, 'RESOURCE_EXHAUSTED', message)
export const conflict = (message: string): never => fail(409, 'CONFLICT', message)
export const notFound = (message: string): never => fail(404, 'NOT_FOUND', message)
export const notImplemented = (message: string): never => fail(501, 'NOT_IMPLEMENTED', message)

export class ArchiveError extends ApiError {
  constructor(status: number, code: string, message: string, readonly details: Record<string, unknown>) {
    super(status, code, message)
  }
}

export function allowed(request: Request, ...methods: string[]): void {
  if (!methods.includes(request.method) && !(request.method === 'HEAD' && methods.includes('GET'))) {
    fail(405, 'METHOD_NOT_ALLOWED', `Use ${methods.join(' or ')} for this operation.`)
  }
}

export function fields(input: Record<string, unknown>, keys: string): void {
  const key = Object.keys(input).find(name => !keys.split(' ').includes(name))
  if (key !== undefined) invalid(`Unexpected field ${JSON.stringify(key.slice(0, 64))}.`)
}

export function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /\p{Cs}/u.test(value)) return invalid(`${field} must be a bounded string.`)
  return value
}

export function bool(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') return invalid(`${field} must be a boolean.`)
  return value
}

export function param(query: URLSearchParams, key: string): string | undefined {
  const all = query.getAll(key)
  if (all.length > 1) invalid(`${key} must not be repeated.`)
  return all[0]
}

export function flag(query: URLSearchParams, key: string, initial: boolean): boolean {
  const value = param(query, key)?.toLowerCase()
  if (value === undefined) return initial
  if (['true', '1', 'yes', 'on', 't', 'y'].includes(value)) return true
  if (['false', '0', 'no', 'off', 'f', 'n'].includes(value)) return false
  return invalid(`${key} must be a boolean.`)
}

export function numberParam(query: URLSearchParams, key: string, initial: number, min: number, max: number): number {
  const value = param(query, key)
  if (value === undefined) return initial
  const n = Number(value)
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) return invalid(`${key} is out of range.`)
  return n
}

export async function digest(bytes: Uint8Array<ArrayBuffer>, algorithm = 'SHA-256'): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest(algorithm, bytes))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function attachment(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, ch =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase())}`
}
