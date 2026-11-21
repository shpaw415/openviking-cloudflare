// SPDX-License-Identifier: AGPL-3.0-only
// Observer only in the extra handoff test; actual dispatch and the directory are unchanged.
import production, { Workspace as RealWorkspace } from '../../src/worker.js'
import { authenticate } from '../../src/auth.js'
import type { AuthGrant } from '../../src/auth.js'
import type { Env } from '../../src/context.js'
import { ok } from '../../src/http.js'

export { Control, OAuth } from '../../src/worker.js'
export class Workspace extends RealWorkspace {
  #release?: () => void
  waiting() { return !!this.#release }
  release() { this.#release?.() }

  override async dispatch(request: Request, grant: AuthGrant, id: string): Promise<Response> {
    if (grant.oidc) {
      if (grant.digest !== '' || grant.managed || grant.oauth || Object.keys(grant).sort().join() !== 'caller,digest,managed,oidc' ||
          Object.keys(grant.oidc).sort().join() !== 'caller,configurationId,expiresAt,kind,validFrom' ||
          [...request.headers.keys()].some(key => key === 'authorization' || key === 'x-api-key' || key.startsWith('x-openviking-'))) {
        return new Response(null, { status: 500 })
      }
      if (request.headers.get('prefer') === 'fixture-oidc-pause') {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Fixture gate timeout.')), 4000)
          this.#release = () => { clearTimeout(timer); resolve() }
        }).finally(() => { this.#release = undefined })
      }
    }
    return super.dispatch(request, grant, id)
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path !== '/__observe-oidc-north') return production.fetch(request, env, ctx)
    if ((await authenticate(request, env)).caller.role !== 'root') return new Response(null, { status: 403 })
    const workspace = (env.WORKSPACES as unknown as DurableObjectNamespace<Workspace>).getByName('openviking:account:north')
    if (request.method === 'POST') { await workspace.release(); return new Response(null, { status: 204 }) }
    return ok(await workspace.waiting())
  },
}
