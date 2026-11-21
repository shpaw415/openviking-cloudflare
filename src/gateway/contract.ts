// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, readJson } from '../http.js'

export const maxInputBytes = 49_152 // Same limit as the shared generation binding.
export const maxMessages = 48
export const maxOutputTokens = 2048
export const maxOutputBytes = 65_536
export const encoder = new TextEncoder()
export const bytes = (text: string) => encoder.encode(text).byteLength
export const protocols = ['chat', 'responses', 'anthropic'] as const
export type Protocol = typeof protocols[number]

export type Route = { kind: 'admin'; parts: string[] } | { kind: 'model'; endpoint: string } | { kind: 'transfer' }
const prefix = '/gateway'
const paths = ['/v1', '/api/v3', '/api/compatible/v1']
const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

export function gatewayPath(path: string): Route | undefined {
  const rest = path.slice(prefix.length)
  if (!path.startsWith(`${prefix}/`)) return undefined
  if (under(rest, '/admin')) return { kind: 'admin', parts: rest.slice('/admin/'.length).replace(/\/$/, '').split('/') }
  const base = paths.find(value => under(rest, value))
  if (base) return { kind: 'model', endpoint: rest.slice(base.length + 1).replace(/\/$/, '') }
  if (rest === '/uploads' || rest === '/downloads') return { kind: 'transfer' }
  return undefined
}

export class GatewayError extends ApiError {
  constructor(status: number, reason: string, detail: string, readonly extra?: Record<string, unknown>) {
    super(status, reason, detail)
  }
}

export const invalid = (detail: string, reason = 'invalid_request') => new GatewayError(400, reason, detail)
export const invalidConfig = (detail: string) => new GatewayError(422, 'invalid_configuration', detail)
export const forbidden = () => new GatewayError(403, 'forbidden', 'This operation requires an account administrator.')
export const missing = () => new GatewayError(404, 'not_found', 'Gateway object or route not found.')
export const unsupported = (detail: string, reason = 'not_implemented') => new GatewayError(501, reason, detail)
export const unconfigured = () => new GatewayError(503, 'generation_unavailable', 'No Gateway generation binding is configured.')
export const methodError = () => new GatewayError(405, 'gateway_http_405', 'Method not allowed on this Gateway route.')

export function safeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof ApiError) {
    if (error.status === 413) return new GatewayError(413, 'body_too_large', 'Gateway input exceeds its limit.')
    if (error.status === 415) return new GatewayError(415, 'content_type_unsupported', 'Expected a JSON body.')
    if (error.status === 429) return new GatewayError(429, 'rate_limited', 'The Gateway budget is exhausted.')
    if (error.status === 401 || error.status === 403) return new GatewayError(error.status, 'openviking_key_invalid', 'The credential no longer grants access.')
    if (error.status === 400) return invalid('Expected valid JSON and supported Gateway input.')
    if (error.code === 'AUTH_UNAVAILABLE') return new GatewayError(503, 'authorization_unavailable', 'Could not verify access.')
  }
  return new GatewayError(500, 'internal_error', 'The Gateway could not complete the request.')
}

export function json(value: unknown, headers?: HeadersInit, status = 200): Response {
  const safe = new Headers(headers)
  safe.set('Cache-Control', 'private, no-store')
  return Response.json(value, { status, headers: safe })
}

export function gatewayError(error: GatewayError, requestId?: string): Response {
  const headers = new Headers()
  if (error.status === 401) headers.set('WWW-Authenticate', 'Bearer')
  if (requestId) headers.set('x-openviking-request-id', requestId)
  if (error.code === 'gateway_overloaded') headers.set('Retry-After', '1')
  return json({ reason: error.code, detail: error.message, ...error.extra, ...(requestId && { request_id: requestId }) }, headers, error.status)
}

export function fields(body: Record<string, unknown>, allowed: readonly string[], error = invalid): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw error('Unknown or unsupported field.')
}

export async function body(request: Request, limit: number): Promise<Record<string, unknown>> {
  const encoding = request.headers.get('content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    throw new GatewayError(415, 'compressed_body_unsupported', 'Compressed bodies are not supported.')
  }
  return readJson(request, limit)
}

export function record(value: unknown, error = invalid): Record<string, unknown> {
  if (!isRecord(value)) throw error('Expected an object.')
  return value
}

export function objectId(value: string): string {
  // One canonical spelling; do not decode path components into another namespace.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw missing()
  return value
}

export function modelId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/.test(value) &&
    !value.includes('://') && !value.includes('//') && !value.split('/').some(part => part === '.' || part === '..')
}

export function displayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > 128 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) {
    throw invalidConfig('name must be a nonempty printable string of at most 128 bytes.')
  }
  return value.trim()
}

export function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function fit(text: string, cap: number): string {
  if (cap <= 0) return ''
  if (bytes(text) <= cap) return text
  const raw = encoder.encode(text).subarray(0, cap)
  return new TextDecoder().decode(raw).replace(/\uFFFD$/, '')
}

export async function within<T>(ms: number, task: () => Promise<T>, failure: () => GatewayError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([task(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(failure()), ms)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

export async function digest(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), byte =>
    byte.toString(16).padStart(2, '0')).join('')
}
