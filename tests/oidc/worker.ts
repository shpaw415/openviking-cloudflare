// SPDX-License-Identifier: AGPL-3.0-only
// Isolated verifier contract; the separate integration tests run src/worker.ts directly.
import type { Caller } from '../../src/context.js'
import { apiError, ok } from '../../src/http.js'
import { assertOidcActive, authenticateOidc, oidcConfigured, reauthorizeOidc } from '../../src/oidc.js'
import type { OidcEnv, OidcGrant, ResolveOidcUser } from '../../src/oidc.js'

export { Control, OAuth, Workspace } from '../../src/worker.js'

type FixtureEnv = OidcEnv & { OIDC_FIXTURE_PROFILES: string }
const start = 1_800_000_000_000
let tick = start
Date.now = () => tick

function profile(env: FixtureEnv, name: string): OidcEnv {
  if (name === 'absent') return {}
  if (name === 'main') return { OPENVIKING_EDGE_OIDC: env.OPENVIKING_EDGE_OIDC }
  const values = JSON.parse(env.OIDC_FIXTURE_PROFILES) as Record<string, string>
  if (!Object.hasOwn(values, name)) throw new Error('Unknown fixture profile.')
  return { OPENVIKING_EDGE_OIDC: values[name] }
}

function resolver(mode: string): ResolveOidcUser | undefined {
  if (mode === 'missing') return undefined
  return async target => {
    const caller: Caller = { ...target, agentId: 'default', role: 'user' }
    switch (mode) {
      case 'down': throw new Error('fixture-directory-private-diagnostic')
      case 'revoked': return null
      case 'wrong': caller.accountId = 'mismatch'; break
      case 'fixed': return { managed: false, caller } as unknown as Awaited<ReturnType<ResolveOidcUser>>
      case 'root': return { managed: true, caller: { ...caller, role: 'root' } } as unknown as Awaited<ReturnType<ResolveOidcUser>>
      case 'admin': caller.role = 'admin'; break
      case 'agent': caller.agentId = 'changed'; break
      case 'bad-agent': caller.agentId = 'default\n'; break
      case 'late': await scheduler.wait(1); tick += 1000; break
    }
    return { managed: true, caller }
  }
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health') return ok(true)
      const [, name, operation, mode = 'live'] = url.pathname.split('/')
      const options = profile(env, name)
      if (operation === 'configuration') return ok(await oidcConfigured(options))
      const grant = await authenticateOidc(request, options, resolver(operation === 'admit' ? mode : 'live'))
      if (!grant) return ok(null)
      if (Object.keys(grant).sort().join() !== 'caller,configurationId,expiresAt,kind,validFrom' ||
          Object.keys(grant.caller).sort().join() !== 'accountId,agentId,role,userId') return new Response(null, { status: 500 })
      if (operation === 'fence') {
        tick += 1000
        assertOidcActive(grant)
      }
      if (operation === 'reauthorize') {
        const receipt: OidcGrant = structuredClone(grant)
        return ok(await reauthorizeOidc(receipt, mode === 'stale-policy' ? profile(env, 'rotated') : options, resolver(mode)))
      }
      return ok(grant.caller)
    } catch (error) {
      return apiError(error, crypto.randomUUID())
    } finally { tick = start }
  },
}
