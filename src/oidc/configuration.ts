// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { jsonObject, localId, onlyFields, utf8, visibleAscii } from './encoding.js'
import { importKeys } from './keys.js'
import type { VerificationKey } from './keys.js'

export type OidcEnv = { OPENVIKING_EDGE_OIDC?: string }
export type OidcTarget = Readonly<{ accountId: string; userId: string }>

export interface Configuration {
  id: string
  issuer: string
  audience: string
  clientId: string
  trustedAudiences: ReadonlySet<string>
  tenantClaim: string
  keys: ReadonlyMap<string, VerificationKey>
  mappings: ReadonlyMap<string, OidcTarget>
  targets: ReadonlySet<string>
}

const reservedClaims = new Set(['iss', 'sub', 'aud', 'azp', 'exp', 'nbf', 'iat', 'jti', 'nonce', 'auth_time',
  'at_hash', 'c_hash', 'acr', 'amr', 'sid', 'cnf', 'role', 'roles', 'groups'])
const notConfigured = () => new ApiError(503, 'AUTH_NOT_CONFIGURED', 'OIDC authentication is not configured correctly.')
const invalid = () => new TypeError('Invalid OIDC configuration.')
export const tuple = (first: string, second: string) => JSON.stringify([first, second])

function exactIssuer(value: unknown): value is string {
  if (!visibleAscii(value, 1024) || !/^https:\/\/[^/]/u.test(value) || /[?#\\]/u.test(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && !!url.hostname && !value.slice(8).split('/', 1)[0].includes('@')
}

async function compile(raw: string): Promise<Configuration | null> {
  if (raw.length > 65_536 || utf8.encode(raw).byteLength > 65_536) throw invalid()
  const input = jsonObject(raw)
  if (input.enabled === false && onlyFields(input, ['enabled'])) return null
  if (input.enabled !== true || !onlyFields(input, ['enabled', 'issuer', 'audience', 'clientId', 'additionalAudiences', 'tenantClaim', 'jwks', 'mappings'])) throw invalid()
  const { issuer, tenantClaim } = input
  const audience = input.audience === undefined ? input.clientId : input.audience
  const clientId = input.clientId === undefined ? audience : input.clientId
  if (!exactIssuer(issuer) || !visibleAscii(audience, 512) || !visibleAscii(clientId, 512) ||
      !visibleAscii(tenantClaim, 256) || reservedClaims.has(tenantClaim)) throw invalid()

  const additional = input.additionalAudiences === undefined ? [] : input.additionalAudiences
  const trustedAudiences = new Set([audience])
  if (!Array.isArray(additional) || additional.length > 7) throw invalid()
  for (const item of additional) {
    if (!visibleAscii(item, 512) || trustedAudiences.has(item)) throw invalid()
    trustedAudiences.add(item)
  }

  if (!Array.isArray(input.mappings) || input.mappings.length === 0 || input.mappings.length > 256) throw invalid()
  const mappings = new Map<string, OidcTarget>()
  const targets = new Set<string>()
  for (const item of input.mappings) {
    if (!isRecord(item) || !onlyFields(item, ['sub', 'tenant', 'accountId', 'userId'])) throw invalid()
    const { sub, tenant, accountId, userId } = item
    if (!visibleAscii(sub, 255) || !visibleAscii(tenant, 255) || !localId(accountId) || !localId(userId)) throw invalid()
    const key = tuple(sub, tenant), target = tuple(accountId, userId)
    if (mappings.has(key) || targets.has(target)) throw invalid()
    targets.add(target)
    mappings.set(key, Object.freeze({ accountId, userId }))
  }

  const keys = await importKeys(input.jwks)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(raw)))
  const id = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
  return { id, issuer, audience, clientId, trustedAudiences, tenantClaim, keys, mappings, targets }
}

// Cache only a completed, bounded operator configuration, never credentials or
// live authority. No request can supply the cache key and no I/O promise is shared.
let cached: { raw: string; configuration: Configuration | null } | undefined
export async function configuration(env: OidcEnv): Promise<Configuration | null> {
  const raw = env.OPENVIKING_EDGE_OIDC
  if (raw === undefined) return null
  if (cached?.raw === raw) return cached.configuration
  try {
    if (typeof raw !== 'string') throw invalid()
    const configuration = await compile(raw)
    cached = { raw, configuration }
    return configuration
  } catch {
    throw notConfigured()
  }
}
