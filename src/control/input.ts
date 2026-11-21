// SPDX-License-Identifier: AGPL-3.0-only
import type { ControlCaller } from '../context.js'
import { ApiError } from '../http.js'

export const LIMIT = {
  accounts: 256, users: 1024, fixed: 32, groups: 128, members: 1000, memberships: 8192,
  keysPerAccount: 16_384, keysPerUser: 1024, body: 64 * 1024, page: 1000,
} as const
export const digestPattern = /^[a-f0-9]{64}$/
export const forbidden = () => new ApiError(403, 'PERMISSION_DENIED', 'This operation is not allowed for this identity.')
export const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'A valid API key is required.')
export const bad = (message: string) => new ApiError(400, 'INVALID_ARGUMENT', message)
export const absent = (kind = 'Route', id?: string) => new ApiError(404, 'NOT_FOUND', `${kind} not found${id ? `: ${id}` : '.'}`)
export const conflict = (kind: string) => new ApiError(409, 'ALREADY_EXISTS', `${kind} identifier is already in use or permanently reserved.`)
export const exhausted = () => new ApiError(413, 'RESOURCE_EXHAUSTED', 'The control-plane quota is exhausted.')
export const unavailable = (message: string) => new ApiError(501, 'NOT_IMPLEMENTED', message)
export const invalidFixed = () => new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Fixed identity configuration is inconsistent with the registry.')

export function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value)
}

export function id(value: unknown, field: string): string {
  if (!isId(value)) throw bad(`${field} must contain 1–48 ASCII letters, digits, underscores or hyphens.`)
  return value
}

export function hasCallerShape(value: ControlCaller): boolean {
  return !!value && isId(value.accountId) && isId(value.userId) && isId(value.agentId) &&
    (value.role === 'root' || value.role === 'admin' || value.role === 'user')
}

export function role(value: unknown): 'user' | 'admin' {
  const normalized = typeof value === 'string' && value.toLowerCase()
  if (normalized !== 'user' && normalized !== 'admin') throw bad('Only user and admin roles can be assigned.')
  return normalized
}

export function fields(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw bad('Unexpected request fields.')
}

export function rejectSeed(seed: unknown): void {
  if (seed !== undefined && seed !== null) throw bad('Seeded credentials are not supported; keys are generated randomly.')
}

export function memberIds(body: Record<string, unknown>): string[] {
  fields(body, ['user_ids'])
  const values = body.user_ids
  if (!Array.isArray(values) || !values.length || values.length > LIMIT.members) {
    throw bad('user_ids must contain 1–1000 user identifiers.')
  }
  return [...new Set(values.map(value => id(value, 'user_id')))]
}

export function boolParam(query: URLSearchParams, key: string, fallback: boolean): boolean {
  const value = query.get(key)?.toLowerCase()
  if (value === undefined) return fallback
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(value)) return true
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(value)) return false
  throw bad(`Invalid ${key} query parameter.`)
}

function directoryTerm(query: URLSearchParams, key: string): string | null {
  const value = query.get(key)
  if (value !== null && value.length > 128) throw bad(`Invalid ${key} query parameter.`)
  return value
}

// Greedy matching over bounded identifiers, without user-controlled regex backtracking.
function wildcard(pattern: string, name: string): boolean {
  let p = 0, n = 0, star = -1, retry = 0
  while (n < name.length) {
    if (pattern[p] === '?' || pattern[p] === name[n]) { p++; n++ }
    else if (pattern[p] === '*') { star = p++; retry = n }
    else if (star >= 0) { p = star + 1; n = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

export function directory(query: URLSearchParams) {
  const take = directoryTerm(query, 'limit')
  const skip = directoryTerm(query, 'page') ?? '1'
  const takeNumber = take === null ? null : Number(take)
  const page = Number(skip)
  if (!/^\d+$/.test(skip) || !Number.isSafeInteger(page) || page < 1 || page > 1_000_000 ||
      (take !== null && (!/^\d+$/.test(take) || takeNumber! < 1 || takeNumber! > LIMIT.page))) {
    throw bad('Invalid directory pagination.')
  }
  const name = directoryTerm(query, 'name')
  const text = directoryTerm(query, 'query')?.trim().toLowerCase()
  return {
    matches: (value: string) => (!name || wildcard(name, value)) && (!text || value.toLowerCase().includes(text)),
    page: <T>(rows: T[]): T[] => takeNumber === null ? rows : rows.slice((page - 1) * takeNumber, page * takeNumber),
  }
}

const encoder = new TextEncoder()
function hex(data: Uint8Array): string {
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function newKey(): Promise<{ key: string; digest: string }> {
  const key = hex(crypto.getRandomValues(new Uint8Array(32)))
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key))))
  return { key, digest }
}
