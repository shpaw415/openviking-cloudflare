// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import type { Caller, Env } from './context.js'
import { authenticate, controlFor, hasCredentials, requireDataGrant, sameCaller } from './auth.js'
import { ApiError } from './http.js'
import { IntentCapsules } from './oauth/intents.js'
import { authorizationMetadata, configuration, consentCommand, cookie, digest, digestPattern, forbidden,
  infoPrefix, intent, invalidGrant, invalidRequest, notFound, OAuthError, OAUTH_SCOPE, pendingQuery,
  PENDING_TTL, pkceMatches, protectedMetadata, protocolError, random, registered, requireOrigin, response, statusPath,
  TOKEN_TTL, tokenCommand, tokenPattern, unavailable, unavailableFlow, verifyPath, wrongMethod } from './oauth/protocol.js'
import type { Configuration } from './oauth/protocol.js'
import { callerBinding, OAuthStore, sameBinding } from './oauth/store.js'
import type { Code, Token } from './oauth/store.js'

export { OAUTH_SCOPE }

export type OAuthEnv = Env & {
  OAUTH?: DurableObjectNamespace
  OPENVIKING_OAUTH_ISSUER?: string
  OPENVIKING_OAUTH_CLIENTS?: string
}
export type ManagedOAuth = { caller: Caller; digest: string }
export type OAuthGrant = { keyDigest: string; scope: string[] }
type OAuthClient = {
  dispatch(request: Request, managed?: ManagedOAuth): Promise<Response>
  resolveGrant(tokenDigest: string): Promise<OAuthGrant | null>
}

export function oauthFor(env: OAuthEnv): OAuthClient | null {
  return env.OAUTH ? env.OAUTH.getByName('openviking:oauth:v1') as unknown as OAuthClient : null
}

const neverMounted = new Set(['/register', '/revoke', '/oauth/authorize/page'])
const protocolRoutes = new Set([authorizationMetadata, protectedMetadata, `${protectedMetadata}/api/v1`,
  '/authorize', '/token', statusPath, verifyPath])

export async function oauthTokenDigest(request: Request): Promise<string | null> {
  const authorization = request.headers.get('authorization')
  if (!authorization || !/^Bearer +ovat_/i.test(authorization)) return null
  const token = /^Bearer (ovat_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1]
  if (!token || !tokenPattern.test(token) || request.headers.has('x-api-key')) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A valid OAuth access token is required.')
  }
  return digest(token)
}

const readRoutes = new Set(['/api/v1/fs/ls', '/api/v1/fs/tree', '/api/v1/fs/stat', '/api/v1/fs/attrs',
  '/api/v1/content/read', '/api/v1/content/abstract', '/api/v1/content/overview', '/api/v1/content/download'])
const pureSearchRoutes = new Set(['/api/v1/search/grep', '/api/v1/search/glob'])

export function oauthAllows(request: Request, url: URL, env: OAuthEnv, scopes: readonly string[]): boolean {
  if (!env.OAUTH || !env.CONTROL || scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) return false
  if (configuration(env)?.issuer !== url.origin || url.searchParams.has('access_token') || url.searchParams.has('token')) return false
  if (request.method === 'GET' || request.method === 'HEAD') return readRoutes.has(url.pathname)
  // Semantic find also runs a metered provider; session search may mutate. Both
  // stay outside the OAuth grant instead of inheriting a general search prefix.
  return request.method === 'POST' && pureSearchRoutes.has(url.pathname)
}

async function resolveKey(env: OAuthEnv, keyDigest: string): Promise<Caller | null> {
  const control = controlFor(env)
  if (!digestPattern.test(keyDigest) || !control) return null
  try { return await control.resolve(keyDigest) } catch { throw unavailable() }
}

const stillRegistered = (row: Code | Token, config: Configuration) =>
  registered(config, row.client_id, row.redirect_uri, row.resource)

async function requireStudio(env: OAuthEnv, config: Configuration): Promise<void> {
  if (!env.ASSETS) throw unavailable()
  // This is a local static-assets binding. Never fetch the configured issuer
  // through the network or include the caller's query parameters/cookies.
  const asset = await env.ASSETS.fetch(new URL('/studio/index.html', config.issuer).href, { method: 'HEAD' })
  if (asset.status !== 200 || !/^text\/html\b/i.test(asset.headers.get('content-type') ?? '')) throw unavailable()
}

// Call this before generic API authentication. It authenticates only the
// approval action, via the existing API-key manager. The raw key never crosses
// to the OAuth DO. Every other protocol endpoint rejects credential headers.
export async function oauthRoute(request: Request, env: OAuthEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  if (neverMounted.has(path)) return protocolError(notFound())
  if (!protocolRoutes.has(path) && !path.startsWith(infoPrefix)) return null
  try {
    const config = env.OAUTH && env.CONTROL ? configuration(env) : null
    const stub = config ? oauthFor(env) : null
    if (!config || !stub || url.origin !== config.issuer) throw notFound()
    if (path === authorizationMetadata || path === protectedMetadata || path === `${protectedMetadata}/api/v1`) {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw wrongMethod()
      if (url.search) throw invalidRequest()
      await requireStudio(env, config)
      if (request.method === 'HEAD') return response(undefined)
      return path === authorizationMetadata ? response({
        issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`, token_endpoint: `${config.issuer}/token`,
        response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [OAUTH_SCOPE], authorization_response_iss_parameter_supported: true,
      }) : response({ resource: config.resource, authorization_servers: [config.issuer],
        bearer_methods_supported: ['header'], scopes_supported: [OAUTH_SCOPE] })
    }

    let managed: ManagedOAuth | undefined
    if (path === verifyPath) {
      if (request.method !== 'POST') throw wrongMethod()
      requireOrigin(request, config, true)
      if (await oauthTokenDigest(request)) throw new ApiError(401, 'UNAUTHENTICATED', 'A managed API key is required.')
      const grant = await authenticate(request, env)
      if (!grant.managed) throw forbidden()
      managed = { caller: requireDataGrant(grant), digest: grant.digest }
    } else if (hasCredentials(request)) throw invalidRequest()
    if (path === '/authorize' && request.method === 'GET') {
      intent(url, config)
      await requireStudio(env, config)
    }

    const headers = new Headers()
    for (const name of ['content-type', 'content-length', 'origin', 'sec-fetch-site', 'cookie']) {
      const value = request.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    return await stub.dispatch(new Request(request, { headers }), managed)
  } catch (error) {
    return protocolError(error)
  }
}

export class OAuth extends DurableObject<OAuthEnv> {
  readonly #store = new OAuthStore(this.ctx.storage)
  readonly #capsules = new IntentCapsules((epoch, create) => this.#store.intentKey(epoch, create))

  async resolveGrant(tokenDigest: string): Promise<OAuthGrant | null> {
    const config = configuration(this.env)
    if (!config || !this.env.CONTROL || !digestPattern.test(tokenDigest)) return null
    const token = this.#store.token(tokenDigest)
    if (!token || !stillRegistered(token, config)) return null
    const current = await resolveKey(this.env, token.key_digest)
    if (!current || !sameBinding(token, current) || token.expires_at <= Date.now()) return null
    return { keyDigest: token.key_digest, scope: [OAUTH_SCOPE] }
  }

  async dispatch(request: Request, authenticatedManaged?: ManagedOAuth): Promise<Response> {
    try {
      const url = new URL(request.url)
      const config = configuration(this.env)
      if (!config || !this.env.CONTROL || url.origin !== config.issuer) throw notFound()
      const path = url.pathname
      switch (path) {
        case '/authorize':
          if (request.method !== 'GET') throw wrongMethod()
          return await this.#authorize(url, config)
        case '/token':
          if (request.method !== 'POST') throw wrongMethod()
          return await this.#exchange(request, config)
        case verifyPath:
          if (request.method !== 'POST') throw wrongMethod()
          return await this.#decide(request, url, config, authenticatedManaged)
        case statusPath:
          if (request.method !== 'GET') throw wrongMethod()
          return await this.#status(request, config, pendingQuery(url))
        default:
          if (!path.startsWith(infoPrefix)) throw notFound()
          if (request.method !== 'GET') throw wrongMethod()
          if (url.search) throw invalidRequest()
          return await this.#info(request, config, path.slice(infoPrefix.length))
      }
    } catch (error) {
      return protocolError(error)
    }
  }

  async #authorize(url: URL, config: Configuration): Promise<Response> {
    const input = intent(url, config)
    const pending = random()
    const sealed = await this.#capsules.seal(input, config, pending)
    const location = new URL('/studio/oauth/consent', config.issuer)
    location.searchParams.set('pending', pending)
    return response(undefined, 302, { Location: location.href, 'Set-Cookie': cookie(config, sealed, PENDING_TTL) })
  }

  async #info(request: Request, config: Configuration, pending: string): Promise<Response> {
    requireOrigin(request, config, false)
    const input = await this.#capsules.open(request, config, pending)
    const row = input && this.#store.receipt(await digest(pending), input.expiresAt)
    if (!input || input.expiresAt <= Date.now() || (row && row.stage !== 'approved')) {
      throw new OAuthError(404, 'expired', 'Authorization is no longer available.')
    }
    return response({ client_id: input.client_id, client_name: config.clients.get(input.client_id)!.name,
      redirect_host: new URL(input.redirect_uri).host, scopes: [OAUTH_SCOPE] })
  }

  async #decide(request: Request, url: URL, config: Configuration, managed?: ManagedOAuth): Promise<Response> {
    requireOrigin(request, config, true)
    if (url.search) throw invalidRequest()
    if (!managed) throw forbidden()
    const { pending, decision } = await consentCommand(request)
    const input = await this.#capsules.open(request, config, pending)
    if (!input) throw unavailableFlow()
    const handle = await digest(pending)
    const who = await resolveKey(this.env, managed.digest)
    if (!who || !sameCaller(who, managed.caller)) throw forbidden()
    this.#store.decide(handle, input.expiresAt, callerBinding(managed.digest, who), decision)
    if (decision === 'deny') return response({ status: 'denied' }, 200, { 'Set-Cookie': cookie(config, '', 0) })
    return response({ status: 'approved' })
  }

  async #status(request: Request, config: Configuration, pending: string): Promise<Response> {
    requireOrigin(request, config, false)
    const input = await this.#capsules.open(request, config, pending)
    if (!input) throw unavailableFlow()
    const handle = await digest(pending)
    if (input.expiresAt <= Date.now()) throw unavailableFlow()
    const row = this.#store.receipt(handle, input.expiresAt)
    if (!row) return response({ status: 'pending' })
    if (row.stage !== 'approved') throw unavailableFlow()
    const code = `ovac_${random()}`
    const codeHash = await digest(code)
    const caller = await resolveKey(this.env, row.key_digest)
    if (!caller || !sameBinding(row, caller)) throw unavailableFlow()
    this.#store.issueCode(handle, input, codeHash)
    const redirect = new URL(input.redirect_uri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', input.state)
    redirect.searchParams.set('iss', config.issuer)
    return response({ status: 'approved', redirect_url: redirect.href }, 200, { 'Set-Cookie': cookie(config, '', 0) })
  }

  async #exchange(request: Request, config: Configuration): Promise<Response> {
    const input = await tokenCommand(request)
    if (!registered(config, input.client_id, input.redirect_uri, input.resource)) throw invalidGrant()
    const codeHash = await digest(input.code)
    const row = this.#store.code(codeHash)
    if (!row || row.client_id !== input.client_id || row.redirect_uri !== input.redirect_uri || row.resource !== input.resource ||
        !await pkceMatches(input.code_verifier, row.challenge)) throw invalidGrant()
    const token = `ovat_${random()}`
    const tokenHash = await digest(token)
    const caller = await resolveKey(this.env, row.key_digest)
    if (!caller || !sameBinding(row, caller)) throw invalidGrant()
    this.#store.issueToken(codeHash, tokenHash)
    return response({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL, scope: OAUTH_SCOPE })
  }
}
