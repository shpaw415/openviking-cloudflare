// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, ControlCaller, Env } from './context.js'
import { ApiError, isRecord } from './http.js'
import { authenticateOidc, reauthorizeOidc } from './oidc.js'
import type { OidcGrant, ResolveOidcUser } from './oidc.js'

interface Principal {
  key: string
  caller: ControlCaller
}

export interface AuthGrant {
  caller: ControlCaller
  digest: string
  managed: boolean
  oauth?: string
  oidc?: OidcGrant
}

type ControlClient = {
  resolve(digest: string): Promise<Caller | null>
  resolveManagedIdentity(accountId: string,userId: string,agentId: string): Promise<Caller | null>
  dispatch(request: Request, caller: ControlCaller, fixed: ControlCaller[], credentialDigest?: string): Promise<Response>
  groupsFor(caller: Caller): Promise<string[]>
  principalsFor(accountId: string, fixed?: ControlCaller[]): Promise<{ users: string[], groups: string[] }>
  admitFixed(caller: Caller): Promise<boolean>
  probe(): Promise<boolean>
}

export function controlFor(env: Env): ControlClient | null {
  return env.CONTROL ? env.CONTROL.getByName('openviking:control:v1') as unknown as ControlClient : null
}

const credentialPattern = /^[A-Za-z0-9_-]{32,128}$/
const idPattern = /^[A-Za-z0-9_-]{1,48}$/
const encoder = new TextEncoder()
const configurationError = () => new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Worker API keys are not configured.')
const authError = () => new ApiError(401, 'UNAUTHENTICATED', 'A valid API key is required.')

export function configuredPrincipals(env: Env): Principal[] {
  if (!env.OPENVIKING_EDGE_KEYS || env.OPENVIKING_EDGE_KEYS.length > 16_384) throw configurationError()
  let data: unknown
  try {
    data = JSON.parse(env.OPENVIKING_EDGE_KEYS)
  } catch {
    throw configurationError()
  }
  if (!Array.isArray(data) || data.length === 0 || data.length > 32) throw configurationError()
  const used = new Set<string>()
  return data.map((item: unknown) => {
    if (!isRecord(item)) throw configurationError()
    const { key, accountId, userId, agentId, role } = item
    if (typeof key !== 'string' || !credentialPattern.test(key) || used.has(key) ||
        typeof accountId !== 'string' || !idPattern.test(accountId) ||
        typeof userId !== 'string' || !idPattern.test(userId) ||
        typeof agentId !== 'string' || !idPattern.test(agentId) ||
        (role !== 'admin' && role !== 'user' && role !== 'root')) throw configurationError()
    used.add(key)
    return { key, caller: { accountId, userId, agentId, role } }
  })
}

export function hasCredentials(request: Request): boolean {
  return request.headers.has('x-api-key') || request.headers.has('authorization')
}

export function extractCredential(request: Request): string {
  const authorization = request.headers.get('authorization')
  const apiKey = request.headers.get('x-api-key')
  if (authorization !== null && apiKey !== null) throw authError()
  const candidate = authorization === null ? apiKey : /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(authorization)?.[1]
  if (!candidate || !credentialPattern.test(candidate)) throw authError()
  return candidate
}

export async function credentialDigest(raw: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)))
  return Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('')
}

export async function resolveDigest(digest: string, env: Env): Promise<AuthGrant> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw authError()
  const principals = configuredPrincipals(env)
  const digests = await Promise.all(principals.map(({ key }) => crypto.subtle.digest('SHA-256', encoder.encode(key))))
  const actual = Uint8Array.from(digest.match(/../g)!.map(v => Number.parseInt(v, 16)))
  let caller: ControlCaller | undefined
  for (let index = 0; index < principals.length; index++) {
    if (crypto.subtle.timingSafeEqual(actual, digests[index])) caller = principals[index].caller
  }
  const control = controlFor(env)
  if (caller) {
    if (control && validDataCaller(caller)) {
      let admitted = false
      try { admitted = await control.admitFixed(caller) } catch {
        throw new ApiError(503, 'AUTH_UNAVAILABLE', 'The credentials store is unavailable.')
      }
      if (!admitted) throw authError()
    }
    return { caller, digest, managed: false }
  }
  if (!control) throw authError()
  let resolved: Caller | null
  try { resolved = await control.resolve(digest) } catch {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'The managed credentials store is unavailable.')
  }
  if (!resolved || !validDataCaller(resolved)) throw authError()
  return { caller: resolved, digest, managed: true }
}

function validDataCaller(caller: ControlCaller): caller is Caller {
  return (caller.role === 'user' || caller.role === 'admin') && [caller.accountId, caller.userId, caller.agentId].every(id => typeof id === 'string' && idPattern.test(id))
}

export async function authenticate(request: Request, env: Env): Promise<AuthGrant> {
  const oidc=await authenticateOidc(request,env,oidcResolver(env))
  if(oidc) return {caller:oidc.caller,digest:'',managed:false,oidc}
  return authenticateApiKey(request,env)
}

export async function authenticateApiKey(request: Request, env: Env): Promise<AuthGrant> {
  configuredPrincipals(env)
  // Match upstream api_key mode: old clients send default account/user hints.
  // They are ignored, and the allow-list below keeps them out of the Durable Object.
  return await resolveDigest(await credentialDigest(extractCredential(request)), env)
}

function oidcResolver(env:Env):ResolveOidcUser|undefined {
  const directory=controlFor(env)
  if(!directory)return undefined
  return async identity=>{
    const caller=await directory.resolveManagedIdentity(identity.accountId,identity.userId,'default')
    return caller?{caller,managed:true}:null
  }
}

export function resolveFederated(grant:OidcGrant,env:Env):Promise<Caller> {
  return reauthorizeOidc(grant,env,oidcResolver(env))
}

export function federatedAllows(request:Request,path:string):boolean {
  if(request.method==='GET'||request.method==='HEAD') {
    return /^\/api\/v1\/(?:fs\/(?:ls|tree|stat|attrs)|content\/(?:read|abstract|overview|download)|system\/(?:status|edge-capabilities))$/u.test(path)
  }
  return request.method==='POST'&&/^\/api\/v1\/search\/(?:grep|glob)$/u.test(path)
}

export function requireDataGrant(grant: AuthGrant): Caller {
  if (!validDataCaller(grant.caller)) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Root credentials are reserved for the control plane.')
  }
  return grant.caller
}

export function sameCaller(a: ControlCaller, b: ControlCaller): boolean {
  return a.accountId === b.accountId && a.userId === b.userId && a.agentId === b.agentId && a.role === b.role
}

export function stripCredentialHeaders(request: Request, extra: readonly string[] = []): Request {
  const headers = new Headers()
  for (const name of ['accept', 'content-type', 'content-length', 'idempotency-key', 'destination', 'depth', 'overwrite', 'if-match', 'if-none-match', 'range', 'prefer', ...extra]) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Request(request, { headers })
}
