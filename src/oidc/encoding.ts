// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'

export const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function base64url(value: unknown, limit: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value.length || value.length > limit || /[^A-Za-z0-9_-]/u.test(value)) {
    throw new TypeError('Invalid OIDC encoding.')
  }
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  // atob alone accepts non-zero unused bits; JWS and JWK use canonical base64url.
  if (btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '') !== value) {
    throw new TypeError('Invalid OIDC encoding.')
  }
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

export function jsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError('Expected an OIDC JSON object.')

  // Native JSON.parse checks the grammar. Scan only structural tokens and
  // strings to reject duplicate member names, including escaped spellings.
  const stack: (Set<string> | null)[] = []
  const colon = /[ \t\r\n]*:/y
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/gsu)) {
    const token = match[0]
    if (token === '{' || token === '[') {
      if (stack.length === 24) throw new TypeError('OIDC JSON is too deeply nested.')
      stack.push(token === '{' ? new Set() : null)
    } else if (token === '}' || token === ']') {
      stack.pop()
    } else {
      const object = stack.at(-1)
      colon.lastIndex = match.index + token.length
      if (object && colon.test(text)) {
        const key = JSON.parse(token) as string
        if (object.has(key)) throw new TypeError('Duplicate OIDC JSON member.')
        object.add(key)
      }
    }
  }
  return parsed
}

export const jwtObject = (segment: string, limit: number) => jsonObject(decoder.decode(base64url(segment, limit)))
export const onlyFields = (object: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(object).every(key => fields.includes(key))
export const visibleAscii = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[^!-~]/u.test(value)
export const localId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 48 && !/[^A-Za-z0-9_-]/u.test(value)
