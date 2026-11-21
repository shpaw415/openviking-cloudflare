// SPDX-License-Identifier: AGPL-3.0-only
// Standalone assembly; no build/reconfiguration of the parent Worker.
import { Control as RealControl } from '../../src/control.js'
import type { ControlCaller } from '../../src/control.js'
import type { Caller } from '../../src/context.js'
import { ApiError, apiError, ok, readJson } from '../../src/http.js'

export class Control extends RealControl {
  constructor(state: DurableObjectState, env: { MODEL: string }) {
    const model = env.MODEL
    const ai = model === 'missing' ? undefined : { async run(name: string, input: unknown) {
      if (name === '@cf/baai/bge-base-en-v1.5' && JSON.stringify(input) === '{"text":["OpenViking Edge model probe."]}') {
        return model === 'fixture' ? { data: [Array.from({ length: 768 }, () => 0.5)] } : { data: [[1, 2, 3]] }
      }
      if (name === '@cf/meta/llama-3.1-8b-instruct' && JSON.stringify(input) === '{"messages":[{"role":"user","content":"Reply OK."}],"max_tokens":8,"stream":false}') {
        return model === 'fixture' ? { response: 'OK' } : { response: '' }
      }
      throw new Error('Unexpected model fixture invocation.')
    } }
    super(state, { AI: ai as unknown as Ai | undefined })
  }
}

export interface Bindings {
  CONTROL: DurableObjectNamespace<Control>
  ROOT: string
  FIXED: (Caller & { key: string })[]
}

export async function dispatch(request: Request, env: Bindings,
  handle?: (clean: Request, caller: Caller, control: DurableObjectStub<Control>) => Promise<Response>): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health') return ok(true)
      const direct = request.headers.get('x-api-key')
      const bearer = request.headers.get('authorization')
      const candidate = direct ?? /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(bearer ?? '')?.[1]
      if ((direct && bearer) || !candidate || !/^[A-Za-z0-9_-]{32,128}$/.test(candidate)) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'A valid API key is required.')
      }
      const registry = env.CONTROL.getByName('registry')
      const fixed = env.FIXED.map(({ accountId, userId, agentId, role }) => ({ accountId, userId, agentId, role }))
      const fixedIndex = env.FIXED.findIndex(item => item.key === candidate)
      let digest: string | undefined
      let caller: ControlCaller | null
      if (candidate === env.ROOT) {
        caller = { accountId: 'default', userId: 'edge-root', agentId: 'default', role: 'root' }
      } else if (fixedIndex >= 0) {
        caller = await registry.admitFixed(fixed[fixedIndex]) ? fixed[fixedIndex] : null
      } else {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(candidate))
        digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
        caller = await registry.resolve(digest)
      }
      if (!caller) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid API key is required.')
      const headers = new Headers()
      for (const name of ['content-type', 'content-length']) {
        const value = request.headers.get(name)
        if (value !== null) headers.set(name, value)
      }
      const forwarded = new Request(request, { headers })
      if (url.pathname.startsWith('/api/v1/admin/')) return registry.dispatch(forwarded, caller, fixed, digest)
      if (url.pathname === '/_control-test/managed-identity') {
        if (caller.role !== 'root') throw new ApiError(403, 'PERMISSION_DENIED', 'Root test fixture required.')
        if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Expected POST.')
        const { accountId, userId, agentId } = await readJson(forwarded, 1024)
        // Pass JSON values unchanged to exercise validation at the RPC boundary.
        return ok(await registry.resolveManagedIdentity(accountId as string, userId as string, agentId as string))
      }
      if (caller.role === 'root') throw new ApiError(403, 'PERMISSION_DENIED', 'Root has no data-plane identity.')
      const dataCaller: Caller = { ...caller, role: caller.role }
      if (url.pathname === '/_control-test/identity') return ok(dataCaller)
      if (url.pathname === '/_control-test/groups') return ok(await registry.groupsFor(dataCaller))
      if (url.pathname === '/_control-test/settings') return ok(await registry.runtimeFor(dataCaller))
      if (url.pathname === '/_control-test/template') {
        const event = await readJson(forwarded, 16 * 1024)
        return ok(await registry.renderMemoryTemplate(dataCaller, 'events', 'fr', event))
      }
      return handle ? await handle(forwarded, dataCaller, registry) : new Response(null, { status: 404 })
    } catch (error) {
      return apiError(error, 'control-test')
    }
}

export default { fetch: (request: Request, env: Bindings) => dispatch(request, env) }
