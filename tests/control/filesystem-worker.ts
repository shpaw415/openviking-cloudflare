// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import type { Caller, WorkspaceContext } from '../../src/context.js'
import { initFilesystem, routeFilesystem } from '../../src/filesystem.js'
import { apiError } from '../../src/http.js'
import { dispatch } from './worker.js'
import type { Bindings } from './worker.js'

export { Control } from './worker.js'

export default {
  fetch(request: Request, env: Bindings & { WORKSPACES: DurableObjectNamespace<TestWorkspace> }) {
    return dispatch(request, env, async (request, caller, registry) => {
      const fixed = env.FIXED.map(({ accountId, userId, agentId, role }) => ({ accountId, userId, agentId, role }))
      const [groups, principals] = await Promise.all([registry.groupsFor(caller), registry.principalsFor(caller.accountId, fixed)])
      return env.WORKSPACES.getByName(caller.accountId).files(request, caller, groups, principals)
    })
  },
}

export class TestWorkspace extends DurableObject {
  async files(request: Request, caller: Caller, groups: string[], aclPrincipals: { users: string[]; groups: string[] }): Promise<Response> {
    try {
      const context: WorkspaceContext = {
        sql: this.ctx.storage.sql, storage: this.ctx.storage, caller, groups, aclPrincipals,
        embed: () => { throw new Error('Control tests do not embed data') },
      }
      this.ctx.storage.transactionSync(() => initFilesystem(context))
      return await routeFilesystem(request, new URL(request.url), context) ?? new Response(null, { status: 404 })
    } catch (error) {
      return apiError(error, 'control-test-files')
    }
  }
}
