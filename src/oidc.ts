// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller } from './context.js'
import { ApiError } from './http.js'
import { configuration, tuple } from './oidc/configuration.js'
import type { Configuration, OidcEnv, OidcTarget } from './oidc/configuration.js'
import { jwtObject, localId, onlyFields, visibleAscii } from './oidc/encoding.js'
import { verifySignature } from './oidc/keys.js'

export type { OidcEnv, OidcTarget }
export type OidcCaller = Readonly<Omit<Caller, 'role'> & { role: 'user' }>
/** Trusted parent adapter only: read the active managed directory, not an API credential or claims. */
export type ResolveOidcUser = (target: OidcTarget) => Promise<{ managed: true; caller: Caller } | null>
type TimeWindow = Readonly<{ validFrom: number; expiresAt: number }>
/** Ephemeral, internal RPC only. Not self-authenticating and never accepted on an HTTP interface. */
export type OidcGrant = TimeWindow & Readonly<{ kind: 'oidc'; caller: OidcCaller; configurationId: string }>

const unauthenticated = () => new ApiError(401, 'UNAUTHENTICATED', 'A valid OIDC bearer is required.')
const unavailable = () => new ApiError(503, 'AUTH_UNAVAILABLE', 'The OIDC identity directory is unavailable.')
const numericDate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const tokenLimit = 8192

function extract(request: Request): string | null {
  const header = request.headers.get('Authorization')
  // Do not parse configuration or invoke the resolver for opaque API keys or
  // OAuth bearers. Once a dotted bearer is seen, errors never mean fallback.
  if (!header || !/^Bearer(?:[ \t]|$)/i.test(header) || !header.includes('.')) return null
  if (header.length > tokenLimit + 7 || request.headers.has('X-API-Key')) throw unauthenticated()
  const params = new URL(request.url).searchParams
  if (['access_token', 'id_token', 'token'].some(name => params.has(name))) throw unauthenticated()
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header)
  if (!match || match[0] !== header) throw unauthenticated()
  return match[1]
}

function claimsWindow(claims: Record<string, unknown>): TimeWindow {
  const { exp, nbf = 0, iat = 0 } = claims
  if (!numericDate(exp) || !numericDate(nbf) || !numericDate(iat)) throw unauthenticated()
  return { validFrom: Math.max(nbf, iat), expiresAt: exp }
}

function validateWindow(window: TimeWindow): void {
  const now = Math.floor(Date.now() / 1000)
  if (!numericDate(window.validFrom) || !numericDate(window.expiresAt) || window.validFrom > now || window.expiresAt <= now) {
    throw unauthenticated()
  }
}

function audienceMatches(claims: Record<string, unknown>, config: Configuration): boolean {
  const audience = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
  if (!Array.isArray(audience) || audience.length < 1 || audience.length > config.trustedAudiences.size) return false
  const values = new Set<string>()
  for (const value of audience) {
    if (typeof value !== 'string' || !config.trustedAudiences.has(value) || values.has(value)) return false
    values.add(value)
  }
  if (!values.has(config.audience)) return false
  return Object.hasOwn(claims, 'azp') || values.size > 1 || config.clientId !== config.audience
    ? claims.azp === config.clientId : true
}

async function verifiedIdentity(token: string, config: Configuration): Promise<{ target: OidcTarget; window: TimeWindow }> {
  try {
    const [head, body, signature] = token.split('.')
    const header = jwtObject(head, 1024)
    if (!onlyFields(header, ['alg', 'kid', 'typ']) || !visibleAscii(header.kid, 128) ||
        (Object.hasOwn(header, 'typ') && header.typ !== 'JWT')) throw unauthenticated()
    const key = config.keys.get(header.kid)
    if (!key || key.alg !== header.alg || !await verifySignature(key, signature, `${head}.${body}`)) throw unauthenticated()

    const claims = jwtObject(body, tokenLimit)
    if (claims.iss !== config.issuer || !audienceMatches(claims, config) || Object.hasOwn(claims, 'cnf')) throw unauthenticated()
    const window = claimsWindow(claims)
    validateWindow(window)
    const sub = claims.sub, tenant = claims[config.tenantClaim]
    if (!visibleAscii(sub, 255) || !Object.hasOwn(claims, config.tenantClaim) || !visibleAscii(tenant, 255)) throw unauthenticated()
    const target = config.mappings.get(tuple(sub, tenant))
    if (!target) throw unauthenticated()
    return { target, window }
  } catch {
    // No token, headers, key id, parser error, or directory details in the denial.
    throw unauthenticated()
  }
}

async function currentUser(target: OidcTarget, resolve: ResolveOidcUser | undefined): Promise<OidcCaller> {
  if (!resolve) throw unavailable()
  let result: Awaited<ReturnType<ResolveOidcUser>>
  try { result = await resolve(Object.freeze({ accountId: target.accountId, userId: target.userId })) } catch { throw unavailable() }
  const caller = result?.caller
  if (result?.managed !== true || caller?.role !== 'user' || caller.accountId !== target.accountId ||
      caller.userId !== target.userId || !localId(caller.agentId)) throw unauthenticated()
  return Object.freeze({ accountId: caller.accountId, userId: caller.userId, agentId: caller.agentId, role: 'user' })
}

/** A readiness probe for the operator configuration only, not for routes or the directory. */
export async function oidcConfigured(env: OidcEnv): Promise<boolean> {
  return (await configuration(env)) !== null
}

export async function authenticateOidc(request: Request, env: OidcEnv, resolve?: ResolveOidcUser): Promise<OidcGrant | null> {
  const token = extract(request)
  if (token === null) return null
  const config = await configuration(env)
  if (!config) throw unauthenticated()
  const { window, target } = await verifiedIdentity(token, config)
  const caller = await currentUser(target, resolve)
  validateWindow(window)
  return Object.freeze({ kind: 'oidc', caller, configurationId: config.id, ...window })
}

/** For the synchronous publication fence, in addition to a fresh directory read after I/O. */
export function assertOidcActive(grant: OidcGrant): void {
  if (grant?.kind !== 'oidc' || grant.caller?.role !== 'user' || !localId(grant.caller.accountId) ||
      !localId(grant.caller.userId) || !localId(grant.caller.agentId)) throw unauthenticated()
  validateWindow(grant)
}

/** Invoke on internal dispatch and again after awaited work, before accessing or publishing data. */
export async function reauthorizeOidc(grant: OidcGrant, env: OidcEnv, resolve?: ResolveOidcUser): Promise<OidcCaller> {
  assertOidcActive(grant)
  const config = await configuration(env)
  if (!config || config.id !== grant.configurationId || !config.targets.has(tuple(grant.caller.accountId, grant.caller.userId))) {
    throw unauthenticated()
  }
  const current = await currentUser(grant.caller, resolve)
  assertOidcActive(grant)
  if (current.agentId !== grant.caller.agentId) throw unauthenticated()
  return current
}
