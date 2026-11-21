// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, readBytes, readJson } from '../http.js'

export const OAUTH_SCOPE = 'workspace:read'
export const PENDING_TTL = 300
export const CODE_TTL = 90
export const TOKEN_TTL = 600
export const verifyPath = '/api/v1/auth/oauth-verify'
export const infoPrefix = '/api/v1/auth/oauth/pending/'
export const statusPath = '/oauth/authorize/page/status'
export const authorizationMetadata = '/.well-known/oauth-authorization-server'
export const protectedMetadata = '/.well-known/oauth-protected-resource'
const clientPattern = /^[A-Za-z0-9._~-]{1,96}$/
const challengePattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/
const statePattern = /^[A-Za-z0-9._~-]{22,256}$/
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/
export const idPattern = /^[A-Za-z0-9_-]{43}$/
export const codePattern = /^ovac_[A-Za-z0-9_-]{43}$/
export const tokenPattern = /^ovat_[A-Za-z0-9_-]{43}$/
export const digestPattern = /^[a-f0-9]{64}$/
const encoder = new TextEncoder()

export class OAuthError extends Error {
  constructor(readonly status: number, readonly code: string, description: string) { super(description) }
}

export const unavailable = () => new OAuthError(503, 'temporarily_unavailable', 'Authorization service is unavailable.')
export const invalidRequest = () => new OAuthError(400, 'invalid_request', 'Invalid authorization protocol parameters.')
export const invalidGrant = () => new OAuthError(400, 'invalid_grant', 'The authorization code is not usable.')
export const wrongMethod = () => new OAuthError(405, 'invalid_request', 'Method not allowed.')
export const notFound = () => new OAuthError(404, 'not_found', 'OAuth route not available.')
export const unavailableFlow = () => new OAuthError(410, 'expired', 'Authorization is no longer available.')
export const forbidden = () => new OAuthError(403, 'access_denied', 'Managed approval from the originating browser is required.')

export function response(result: unknown, status = 200, headers?: HeadersInit): Response {
  const final = new Headers(headers)
  final.set('Cache-Control', 'private, no-store')
  final.set('Pragma', 'no-cache')
  final.set('Referrer-Policy', 'no-referrer')
  final.set('X-Content-Type-Options', 'nosniff')
  return result === undefined ? new Response(null, { status, headers: final }) : Response.json(result, { status, headers: final })
}

export function protocolError(error: unknown): Response {
  if (error instanceof OAuthError) {
    return response({ error: error.code, error_description: error.message, ...(error.code === 'expired' && { status: 'expired' }) }, error.status)
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return response({ error: 'invalid_client', error_description: 'A valid managed API key is required.' }, 401,
      { 'WWW-Authenticate': 'Bearer' })
    if (error.status === 413 || error.status === 415 || error.status === 400) return protocolError(invalidRequest())
  }
  // No request IDs with request-derived values, raw errors, URLs or bodies.
  const safe = unavailable()
  return response({ error: safe.code, error_description: safe.message }, safe.status)
}

function endpoint(input: unknown): URL {
  if (typeof input !== 'string' || input.length > 2048 || /[\x00-\x20\x7f?#\\]/.test(input)) throw unavailable()
  let parsed: URL
  try { parsed = new URL(input) } catch { throw unavailable() }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname)
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password) throw unavailable()
  return parsed
}

type Options = { OPENVIKING_OAUTH_ISSUER?: string; OPENVIKING_OAUTH_CLIENTS?: string }
type Client = { name: string; redirects: ReadonlySet<string> }
export type Configuration = { issuer: string; resource: string; secure: boolean; clients: ReadonlyMap<string, Client> }

export function configuration(env: Options): Configuration | null {
  const issuer = env.OPENVIKING_OAUTH_ISSUER
  const configuredClients = env.OPENVIKING_OAUTH_CLIENTS
  if (issuer === undefined && configuredClients === undefined) return null
  if (issuer === undefined || configuredClients === undefined || configuredClients.length > 32 * 1024) throw unavailable()
  const origin = endpoint(issuer)
  if (origin.origin !== issuer) throw unavailable()
  let input: unknown
  try { input = JSON.parse(configuredClients) } catch { throw unavailable() }
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) throw unavailable()
  const clients = new Map<string, Client>()
  for (const item of input) {
    if (!isRecord(item) || Object.keys(item).some(key => !['client_id', 'client_name', 'redirect_uris'].includes(key))) throw unavailable()
    const { client_id: id, client_name: name, redirect_uris: redirects } = item
    if (typeof id !== 'string' || !clientPattern.test(id) || clients.has(id) ||
        typeof name !== 'string' || !name || name.length > 96 || /\p{C}/u.test(name) ||
        !Array.isArray(redirects) || redirects.length < 1 || redirects.length > 8) throw unavailable()
    const allowed = new Set<string>()
    for (const redirect of redirects) {
      const url = endpoint(redirect)
      // Registered receivers are exact, canonical, and not server endpoints.
      if (url.href !== redirect || url.origin === issuer || (url.protocol === 'http:' && !url.port) || allowed.has(redirect)) throw unavailable()
      allowed.add(redirect)
    }
    clients.set(id, { name, redirects: allowed })
  }
  return { issuer, resource: `${issuer}/api/v1`, secure: origin.protocol === 'https:', clients }
}

function fields(params: URLSearchParams, allowed: readonly string[]): Record<string, string> {
  const input: Record<string, string> = Object.create(null)
  for (const [key, value] of params) {
    if (!allowed.includes(key) || Object.hasOwn(input, key) || !value || value.length > 2048) throw invalidRequest()
    input[key] = value
  }
  return input
}

export type Intent = { client_id: string; redirect_uri: string; challenge: string; state: string; resource: string }

export function registered(config: Configuration, clientId: string, redirect: string, resource: string): boolean {
  return resource === config.resource && config.clients.get(clientId)?.redirects.has(redirect) === true
}

export function intent(url: URL, config: Configuration): Intent {
  if (url.search.length > 8192) throw invalidRequest()
  const params = fields(url.searchParams, ['response_type', 'client_id', 'redirect_uri', 'code_challenge',
    'code_challenge_method', 'state', 'resource', 'scope'])
  if (params.response_type !== 'code' || params.code_challenge_method !== 'S256' ||
      !challengePattern.test(params.code_challenge ?? '') || !statePattern.test(params.state ?? '')) throw invalidRequest()
  if (params.scope !== OAUTH_SCOPE) throw new OAuthError(400, 'invalid_scope', 'Only workspace:read is supported.')
  if (params.resource !== config.resource) throw new OAuthError(400, 'invalid_target', 'The approved resource must be specified.')
  if (!registered(config, params.client_id, params.redirect_uri, params.resource)) throw invalidRequest()
  return { client_id: params.client_id, redirect_uri: params.redirect_uri, challenge: params.code_challenge,
    state: params.state, resource: params.resource }
}

export async function tokenCommand(request: Request) {
  if (new URL(request.url).search || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw invalidRequest()
  }
  const bytes = await readBytes(request, 8 * 1024)
  let form: URLSearchParams
  try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) } catch { throw invalidRequest() }
  const { grant_type, client_id, redirect_uri, code, code_verifier, resource } = fields(form,
    ['grant_type', 'client_id', 'redirect_uri', 'code', 'code_verifier', 'resource'])
  if (grant_type !== 'authorization_code') throw new OAuthError(400, 'unsupported_grant_type', 'Only authorization_code is supported.')
  if (!codePattern.test(code ?? '') || !verifierPattern.test(code_verifier ?? '') || !client_id || !redirect_uri) throw invalidGrant()
  return { client_id, redirect_uri, code, code_verifier, resource }
}

export async function consentCommand(request: Request): Promise<{ pending: string; decision: 'approve' | 'deny' }> {
  const { pending_id, decision, ...unknown } = await readJson(request, 1024)
  if (Object.keys(unknown).length || typeof pending_id !== 'string' || !idPattern.test(pending_id) ||
      (decision !== 'approve' && decision !== 'deny')) throw invalidRequest()
  return { pending: pending_id, decision }
}

export function pendingQuery(url: URL): string {
  if (url.search.length > 128) throw invalidRequest()
  const { pending } = fields(url.searchParams, ['pending'])
  if (!idPattern.test(pending ?? '')) throw unavailableFlow()
  return pending
}

export function requireOrigin(request: Request, config: Configuration, consent: boolean): void {
  const origin = request.headers.get('origin')
  if ((origin !== null || consent) && origin !== config.issuer) throw forbidden()
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') throw forbidden()
}

const cookieName = (config: Configuration) => `${config.secure ? '__Host-' : ''}ov-oauth-flow`
export function cookie(config: Configuration, value: string, seconds: number): string {
  return `${cookieName(config)}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${config.secure ? '; Secure' : ''}`
}

export function flowCookie(request: Request, config: Configuration): string | null {
  const cookies = request.headers.get('cookie') ?? ''
  if (cookies.length > 8192) return null
  const prefix = `${cookieName(config)}=`
  const values = cookies.split(';').map(item => item.trim()).filter(item => item.startsWith(prefix))
  return values.length === 1 ? values[0].slice(prefix.length) : null
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
const sha256 = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
export const digest = async (value: string) => Array.from(await sha256(value), byte => byte.toString(16).padStart(2, '0')).join('')
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!challengePattern.test(challenge)) return false
  const proposed = base64url(await sha256(verifier))
  return crypto.subtle.timingSafeEqual(encoder.encode(proposed), encoder.encode(challenge))
}
