// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import type { Caller, ControlCaller } from './context.js'
import { ApiError, apiError, isRecord, ok, readBytes, readJson } from './http.js'
import { LIMIT, absent, bad, boolParam, directory, fields, forbidden, hasCallerShape, id, memberIds, newKey, rejectSeed, role, unavailable } from './control/input.js'
import { fixedCallers, Registry } from './control/registry.js'
import type { ModelProbeBinding } from './control/provider.js'
import { probeActiveModel, probeKind, probeModel } from './control/provider.js'
import { configurationPatch, evolution, Settings, systemPatch, userPatch } from './control/settings.js'
import { memoryTypes } from './control/template-defaults.js'
import { memoryType, Templates } from './control/templates.js'
import { bindModel, configFileLimit, legacyEmbedding, patchModels, selectedVlm } from './model-config.js'
import type { ModelEnv, ModelSettings } from './model-config.js'

export type { ControlCaller } from './context.js'

const prefix = '/api/v1/admin/'
const readBody = (request: Request) => readJson(request, LIMIT.body)
const methodError = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed on this route.')

function root(caller: ControlCaller): void { if (caller.role !== 'root') throw forbidden() }
function manager(caller: ControlCaller): void { if (caller.role === 'user') throw forbidden() }
function accountAccess(caller: ControlCaller, account: string): void {
  if (caller.role !== 'root' && caller.accountId !== account) throw forbidden()
}
function selfOrManager(caller: ControlCaller, user: string): void {
  if (caller.role === 'user' && caller.userId !== user) throw forbidden()
}
function paths(path: string): string[] {
  if (!path.startsWith(prefix) || path.length > 1024) throw absent()
  const raw = path.slice(prefix.length).replace(/\/$/, '')
  if (!raw || raw.split('/').length > 7) throw absent()
  try {
    return raw.split('/').map(segment => id(decodeURIComponent(segment), 'Path segment'))
  } catch {
    throw bad('Invalid control-plane path.')
  }
}

async function optionalRotationBody(request: Request): Promise<void> {
  const bytes = await readBytes(request, LIMIT.body)
  if (!bytes.length) return
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'INVALID_ARGUMENT', 'Expected an application/json body.')
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) } catch { throw bad('Invalid UTF-8 or JSON.') }
  if (value === null) return
  if (!isRecord(value)) throw bad('Expected a JSON object.')
  fields(value, ['seed'])
  rejectSeed(value.seed)
}

export class Control extends DurableObject<ModelEnv> {
  #registry = new Registry(this.ctx.storage)
  #settings = new Settings(this.#registry.sql)
  #templates = new Templates(this.#registry.sql)

  resolve(digestHex: string): Caller | null { return this.#registry.resolve(digestHex) }

  /** Private lookup for a tuple already authenticated and mapped by the parent. */
  resolveManagedIdentity(accountId: string, userId: string, agentId: string): Caller | null {
    return this.#registry.resolveManagedIdentity(accountId, userId, agentId)
  }

  probe(): boolean { return this.#registry.sql.exec<{ n: number }>('SELECT 1 AS n').one().n === 1 }

  /** Private DO RPC: operational defaults only, never a deployment secret. */
  modelSettings(): ModelSettings { return this.#settings.models().settings }

  groupsFor(caller: Caller): string[] { return this.#registry.groupsFor(caller) }

  /** Resolved preferences, for use by the authenticated Workspace only. */
  runtimeFor(caller: Caller): { resource_parent: string | null; skill_parent: string | null; output_language: string } | null {
    if (!this.#registry.active(caller)) return null
    const { add_targets } = this.#settings.userResult(caller.accountId, caller.userId)
    return { resource_parent: add_targets.resource_uri, skill_parent: add_targets.skill_uri,
      output_language: this.#settings.effectiveLanguage(caller.accountId) }
  }

  /** Internal renderer: only the authenticated caller's account, no tools or provider invocation. */
  renderMemoryTemplate(caller: Caller, type: string, language: string, event?: Record<string, unknown>) {
    if (!this.#registry.active(caller)) throw forbidden()
    return this.#templates.renderFor(caller.accountId, memoryType(type), language, event)
  }

  // The binding caller can pass current key-free fixed identities or merge them itself.
  principalsFor(accountId: string, fixedIdentities?: ControlCaller[]): { users: string[]; groups: string[] } {
    const account = id(accountId, 'account_id')
    const fixed = fixedIdentities === undefined ? [] : fixedCallers(fixedIdentities).filter(item => item.accountId === account)
    return this.#registry.tx(() => {
      if (fixed.length) this.#registry.reserveFixed(fixed)
      return this.#registry.principals(account, fixed)
    })
  }

  /** Called only after the outer Worker verifies a current fixed credential. */
  admitFixed(caller: Caller): boolean {
    if (!hasCallerShape(caller) || (caller.role !== 'admin' && caller.role !== 'user')) return false
    try { this.#registry.tx(() => this.#registry.reserveFixed([caller])); return true } catch (error) {
      if (error instanceof ApiError) return false
      throw error
    }
  }

  async dispatch(request: Request, caller: ControlCaller, fixedIdentities: ControlCaller[], expectedDigest?: string): Promise<Response> {
    const correlation = crypto.randomUUID()
    let response: Response
    try {
      const url = new URL(request.url)
      const path = paths(url.pathname)
      const fixed = fixedCallers(fixedIdentities)
      const registry = this.#registry
      registry.tx(() => {
        registry.reserveFixed(fixed)
        registry.admitted(caller, fixed, expectedDigest)
      })
      // Recheck after body / Web Crypto awaits, in the same synchronous
      // transaction as each mutation. No permission derived from the request.
      const write = <T>(operation: () => T): T => registry.tx(() => {
        registry.admitted(caller, fixed, expectedDigest)
        return operation()
      })
      response = await this.#route(request, url.searchParams, path, caller, fixed, write)
    } catch (error) {
      response = apiError(error, correlation)
    }
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store')
    return new Response(response.body, { status: response.status, headers })
  }

  async #route(request: Request, params: URLSearchParams, path: string[], caller: ControlCaller,
    fixed: Caller[], write: <T>(operation: () => T) => T): Promise<Response> {
    const registry = this.#registry
    const [section, account, collection, user, action] = path
    const verb = request.method
    if (section === 'migrate' && path.length === 1) {
      root(caller)
      if (verb !== 'POST') throw methodError()
      throw bad('Data migration is not currently supported.')
    }
    if (section === 'configuration') {
      root(caller)
      if (path.length === 2 && account === 'import') {
        if (verb !== 'GET' && verb !== 'POST') throw methodError()
        if ([...params.keys()].some(key => verb !== 'POST' || (key !== 'dry_run' && key !== 'if_revision') || params.getAll(key).length > 1)) {
          throw bad('Invalid configuration import options.')
        }
        const view = (revision: number, settings: ModelSettings, dry_run: boolean) => {
          const vlm = selectedVlm(this.env, settings)
          const embedding = settings.embedding?.dense ?? legacyEmbedding
          return ok({ revision, dry_run, settings, effective: {
            vlm: vlm ? { ...vlm, configured: !!bindModel(this.env, vlm) } : null,
            embedding: { ...embedding, configured: !!bindModel(this.env, embedding), scope: 'new_workspaces' },
            default_search_limit: settings.default_search_limit ?? 10,
          } })
        }
        if (verb === 'GET') {
          const current = this.#settings.models()
          return view(current.revision, current.settings, false)
        }
        const dryRun = boolParam(params, 'dry_run', false)
        const match = params.get('if_revision')
        if (match !== null && (!/^\d+$/.test(match) || !Number.isSafeInteger(Number(match)))) throw bad('Invalid configuration revision.')
        const body = await readJson(request, configFileLimit)
        return write(() => {
          const current = this.#settings.models()
          if (match !== null && Number(match) !== current.revision) throw new ApiError(409, 'CONFLICT', 'Configuration revision changed.')
          const settings = patchModels(current.settings, body, this.env)
          const changed = JSON.stringify(settings) !== JSON.stringify(current.settings)
          const revision = !dryRun && changed ? current.revision + 1 : current.revision
          if (!dryRun && changed) this.#settings.saveModels(revision, settings)
          return view(revision, settings, dryRun)
        })
      }
      if (path.length === 2 && account === 'test-model') {
        if (verb !== 'POST') throw methodError()
        const body = await readBody(request)
        if (body.active === true) {
          fields(body, ['kind', 'active'])
          if (body.kind !== 'embedding' && body.kind !== 'vlm') throw bad('Select the embedding or vlm model.')
          return ok(await probeActiveModel(this.env, this.modelSettings(), body.kind, () => write(() => registry.reserveProbe())))
        }
        const kind = probeKind(body)
        const ai = this.env.AI as unknown as ModelProbeBinding | undefined
        return ok(await probeModel(ai, kind, () => write(() => registry.reserveProbe())))
      }
      if (path.length !== 1) throw absent()
      if (verb !== 'GET' && verb !== 'PATCH') throw methodError()
      const source = params.get('source') ?? 'runtime'
      if (source === 'file') throw unavailable('A Worker does not expose its startup file or deployment secrets.')
      if (source !== 'runtime') throw bad('source must be runtime or file.')
      if (verb === 'PATCH') {
        if (boolParam(params, 'dry_run', false)) throw bad('dry_run requires source=file.')
        const patch = configurationPatch(await readBody(request))
        write(() => this.#settings.saveSystem('', systemPatch(this.#settings.system(), patch, 'cluster', true)))
      }
      return ok({ settings: this.#settings.system() })
    }
    if ((section === 'restart' || section === 'metric-inventory') && path.length === 1) {
      root(caller)
      if (verb !== (section === 'restart' ? 'POST' : 'GET')) throw methodError()
      throw unavailable('This operation is not available on the Worker control plane.')
    }
    if (section === 'agent-evolution' && path.length === 1) {
      manager(caller)
      const accountId = caller.accountId
      if (verb !== 'GET' && verb !== 'PUT') throw methodError()
      if (verb === 'PUT') {
        const update = evolution(await readBody(request))
        write(() => {
          registry.account(accountId)
          this.#settings.saveSystem(accountId, { ...this.#settings.system(accountId), agent_evolution: update })
        })
      } else registry.account(accountId)
      return ok({ account_id: accountId, enabled: false })
    }
    if (section !== 'accounts') throw absent()
    if (path.length === 1) {
      root(caller)
      if (verb === 'GET') {
        const filter = directory(params)
        return ok(filter.page(registry.accounts(uniqueFixedUsers(fixed)).filter(item => filter.matches(item.account_id))))
      }
      if (verb !== 'POST') throw methodError()
      const body = await readBody(request)
      fields(body, ['account_id', 'admin_user_id', 'seed', 'settings', 'user_config'])
      const accountId = id(body.account_id, 'account_id')
      const userId = id(body.admin_user_id, 'admin_user_id')
      rejectSeed(body.seed)
      const settings = systemPatch({}, body.settings, 'account', true)
      const userConfig = userPatch({}, body.user_config, true)
      const { key, digest } = await newKey()
      write(() => {
        registry.create(accountId, userId, digest)
        this.#settings.saveSystem(accountId, settings)
        this.#settings.saveUser(accountId, userId, userConfig)
      })
      return ok({ account_id: accountId, admin_user_id: userId, user_key: key })
    }
    accountAccess(caller, account)
    if (path.length === 2) {
      root(caller)
      if (verb === 'GET') return ok(registry.accounts(uniqueFixedUsers(fixed), account)[0])
      if (verb !== 'DELETE') throw methodError()
      write(() => registry.revoke(account))
      return ok({ account_id: account, status: 'revoked', data_retained: true }, 202)
    }
    if ((collection === 'settings' || collection === 'configuration') && path.length === 3) {
      manager(caller)
      registry.account(account)
      if (verb !== 'GET' && verb !== 'PATCH') throw methodError()
      const legacy = collection === 'settings'
      if (!legacy && params.has('path')) throw unavailable('TTL path policy resolution is not available on Edge.')
      if (verb === 'PATCH') {
        const body = await readBody(request)
        const patch = legacy ? body : configurationPatch(body)
        write(() => {
          registry.account(account)
          const updated = systemPatch(this.#settings.system(account), patch, 'account', caller.role === 'root', legacy)
          this.#settings.saveSystem(account, updated)
        })
      }
      return ok(legacy ? this.#settings.legacyResult(account) : { account_id: account,
        settings: { ...this.#settings.system(account), agent_evolution: { enabled: false } },
      })
    }
    if (collection === 'memory-templates' && (path.length === 3 || path.length === 4)) {
      manager(caller)
      registry.account(account)
      if (path.length === 3) {
        if (verb !== 'GET') throw methodError()
        return ok({ account_id: account, templates: memoryTypes.map(type => this.#templates.result(account, type)) })
      }
      const type = memoryType(user)
      if (verb === 'PUT' || verb === 'DELETE') {
        const body = verb === 'PUT' ? await readBody(request) : undefined
        write(() => {
          registry.account(account)
          this.#templates.publish(account, type, body)
        })
      } else if (verb !== 'GET') throw methodError()
      return ok({ account_id: account, ...this.#templates.result(account, type) })
    }
    if (collection === 'groups') {
      manager(caller)
      if (path.length === 3) {
        if (verb === 'GET') return ok(registry.listGroups(account, fixed))
        if (verb !== 'POST') throw methodError()
        const body = await readBody(request)
        fields(body, ['group_id'])
        const group = id(body.group_id, 'group_id')
        return ok(write(() => registry.createGroup(account, group)))
      }
      if (path.length === 4) {
        if (verb !== 'DELETE') throw methodError()
        write(() => registry.deleteGroup(account, user))
        return ok({ deleted: true })
      }
      if (path.length !== 5 || action !== 'members') throw absent()
      if (verb === 'GET') return ok({ group_id: user, members: registry.listMembers(account, user, fixed) })
      if (verb !== 'PUT' && verb !== 'DELETE') throw methodError()
      const members = memberIds(await readBody(request))
      const add = verb === 'PUT'
      const changed = write(() => registry.updateMembers(account, user, members, fixed, add))
      return ok(add ? { added: changed } : { removed: changed })
    }
    if (collection !== 'users') throw absent()
    if (path.length === 3) {
      if (verb === 'GET') {
        const filter = directory(params)
        const roles = params.get('role')?.toLowerCase()
        const include = boolParam(params, 'include_credentials', true)
        const summary = boolParam(params, 'include_summary', false)
        const all = registry.directory(account, fixed)
        const matches = all.filter(row => (!roles || row.role === roles) && filter.matches(row.user_id))
        const users = filter.page(matches).map(item => ({ ...item,
          ...(!include && (caller.role !== 'user' || caller.userId === item.user_id) && { api_key_available: false }),
        }))
        return ok(summary ? { users, total: matches.length, account_total: all.length,
          manager_count: all.filter(item => item.role === 'admin').length,
          ...(caller.role !== 'user' && { key_count: 0 }),
        } : users)
      }
      if (verb !== 'POST') throw methodError()
      manager(caller)
      const body = await readBody(request)
      fields(body, ['user_id', 'role', 'seed', 'user_config'])
      const userId = id(body.user_id, 'user_id')
      if (typeof body.role === 'string' && body.role.toLowerCase() === 'global' && caller.role !== 'root') throw forbidden()
      const newRole = role(body.role === undefined ? 'user' : body.role)
      rejectSeed(body.seed)
      const userConfig = userPatch({}, body.user_config, true)
      const { key, digest } = await newKey()
      write(() => {
        registry.register(account, userId, newRole, digest)
        this.#settings.saveUser(account, userId, userConfig)
      })
      return ok({ account_id: account, user_id: userId, user_key: key })
    }
    if (path.length === 4) {
      manager(caller)
      if (verb === 'GET') return ok(registry.member(account, user, fixed))
      if (verb !== 'DELETE') throw methodError()
      write(() => registry.revoke(account, user))
      return ok({ account_id: account, user_id: user, status: 'revoked', data_retained: true }, 202)
    }
    if (path.length !== 5) throw absent()
    if (action === 'role') {
      manager(caller)
      if (verb !== 'PUT') throw methodError()
      const body = await readBody(request)
      fields(body, ['role'])
      const newRole = role(body.role)
      write(() => registry.changeRole(account, user, newRole))
      return ok({ account_id: account, user_id: user, role: newRole })
    }
    if (action === 'settings') {
      selfOrManager(caller, user)
      if (verb !== 'GET' && verb !== 'PATCH') throw methodError()
      if (verb === 'PATCH') {
        const patch = await readBody(request)
        write(() => {
          registry.member(account, user, fixed)
          this.#settings.saveUser(account, user, userPatch(this.#settings.user(account, user), patch))
        })
      } else registry.member(account, user, fixed)
      return ok(this.#settings.userResult(account, user))
    }
    if (action !== 'key') throw absent()
    selfOrManager(caller, user)
    if (verb !== 'POST') throw methodError()
    const previous = registry.writableUser(account, user).digest
    await optionalRotationBody(request)
    const { key, digest } = await newKey()
    write(() => registry.rotate(account, user, digest, previous))
    return ok({ user_key: key })
  }
}

function uniqueFixedUsers(fixed: Caller[]): Caller[] {
  return [...new Map(fixed.map(item => [`${item.accountId}/${item.userId}`, item])).values()]
}
