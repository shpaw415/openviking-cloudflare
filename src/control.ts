// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import type { Caller, ControlCaller, Env } from './context.js'
import type { KeyAuthority } from './gateway/keys.js'
import { GatewayError, within } from './gateway/contract.js'
import { authorityReceipt, isAuthorityRevision, sameAuthority, validRevision } from './data-authority.js'
import type { AuthorityAdvance, AuthorityRevision, DataAuthorityGrant } from './data-authority.js'
import { ApiError, apiError, isRecord, ok, readBytes, readJson } from './http.js'
import { LIMIT, absent, bad, boolParam, digestPattern, directory, fields, forbidden, hasCallerShape, id, memberIds, newKey, rejectSeed, role, unavailable } from './control/input.js'
import { fixedCallers, Registry } from './control/registry.js'
import type { ModelProbeBinding } from './control/provider.js'
import { probeActiveModel, probeKind, probeModel } from './control/provider.js'
import { configurationPatch, evolution, Settings, systemPatch, userPatch } from './control/settings.js'
import { memoryTypes } from './control/template-defaults.js'
import { memoryType, Templates } from './control/templates.js'
import { bindModel, bindReranker, configFileLimit, edgeSearchDefaults, edgeSessionDefaults, legacyEmbedding, patchModels, selectedVlm } from './model-config.js'
import type { ModelSettings } from './model-config.js'
import { InstanceRecovery } from './archives/instance-control.js'
import type { ControlCommand } from './archives/instance-authority.js'

export type { ControlCaller } from './context.js'

const prefix = '/api/v1/admin/'
const readBody = (request: Request) => readJson(request, LIMIT.body)
const methodError = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed on this route.')
const fenceUnavailable = () => new GatewayError(503, 'GATEWAY_FENCE_UNAVAILABLE',
  'The Gateway model change has not been committed. Retry the same import after the workspaces can acknowledge it.')
type PendingMount = { revision: number; data: string }
type AuthorityMutation<T> = { scope: 'account' | readonly string[]; commit: () => T }
export type GatewayMount = { status: 'ok'; revision: number; credentialRevision: AuthorityRevision; settings: ModelSettings; groups: string[];
  principals: { users: string[]; groups: string[] } } | { status: 'changed' | 'expired' | 'authority_changed' }

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

export class Control extends DurableObject<Env> {
  #registry = new Registry(this.ctx.storage)
  #settings = new Settings(this.#registry.sql)
  #templates = new Templates(this.#registry.sql)
  #mountSql = this.#initMountStore()
  #instance = new InstanceRecovery(this.ctx.storage, this.env, this.ctx.id.toString(), (account, users) => this.#backupFixedTopology(account, users))
  #changingMount = false
  // Serialize conflicting registry writes, not the request queue of the DO.
  // A member with a slow Workspace ACK must not block anyone else's grants.
  #authorityWrites = new Set<string>()
  #rotatingDigests = new Set<string>()

  resolve(digestHex: string): Caller | null {
    this.#instance.assertServing()
    return this.#registry.resolve(digestHex)
  }

  instanceServing(destination?: string, job?: string): boolean { return this.#instance.serving(destination, job) }

  instanceArchive(command: ControlCommand, permit: unknown, archive?: unknown, argument?: unknown): Promise<Response> {
    return this.#instance.run(command, permit, archive, argument)
  }

  #gatewayIndex() {
    const { sql } = this.#registry
    sql.exec(`CREATE TABLE IF NOT EXISTS ov_control_gateway_index (
      digest TEXT PRIMARY KEY CHECK(length(digest)=64), account_id TEXT NOT NULL
    ) WITHOUT ROWID`)
    sql.exec('CREATE INDEX IF NOT EXISTS ov_control_gateway_account ON ov_control_gateway_index(account_id)')
    return sql
  }

  /** Private locator only. The owning Workspace still authenticates the digest. */
  gatewayAccount(digest: string): string | null {
    this.#instance.assertServing()
    if (!digestPattern.test(digest)) return null
    return this.#gatewayIndex().exec<{ account_id: string }>(`SELECT g.account_id FROM ov_control_gateway_index g
      JOIN ov_control_accounts a ON a.account_id=g.account_id AND a.deleted=0 WHERE g.digest=?`, digest).toArray()[0]?.account_id ?? null
  }

  /** Called by the authenticated, single-issuer Workspace; prune interrupted issues or retired locators. */
  registerGatewayDigest(issuer: KeyAuthority, owner: KeyAuthority, fixed: Caller[], digest: string, live: string[]): boolean {
    this.#instance.assertServing()
    const account = id(issuer.caller.accountId, 'account_id')
    if (owner.caller.accountId !== account || (issuer.caller.role !== 'admin' &&
        (owner.caller.userId !== issuer.caller.userId || owner.caller.agentId !== issuer.caller.agentId))) return false
    if (!digestPattern.test(digest) || !Array.isArray(live) || live.length >= 128 || !live.every(known => digestPattern.test(known))) throw bad('Invalid Gateway index update.')
    const sql = this.#gatewayIndex()
    const locals = fixedCallers(fixed).filter(item => item.accountId === account)
    return this.#registry.tx(() => {
      if (!sql.exec('SELECT 1 FROM ov_control_accounts WHERE account_id=? AND deleted=0', account).toArray().length) return false
      try {
        for (const grant of [issuer, owner]) {
          if (!hasCallerShape(grant.caller) || (grant.caller.role !== 'admin' && grant.caller.role !== 'user') || !digestPattern.test(grant.digest)) return false
          if (this.#authorityPending(account, grant.caller.userId)) return false
          this.#registry.admitted(grant.caller, locals, grant.managed ? grant.digest : undefined)
        }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
        throw error
      }
      const retained = new Set(live)
      for (const row of sql.exec<{ digest: string }>('SELECT digest FROM ov_control_gateway_index WHERE account_id=?', account).toArray()) {
        if (!retained.has(row.digest)) sql.exec('DELETE FROM ov_control_gateway_index WHERE account_id=? AND digest=?', account, row.digest)
      }
      sql.exec('INSERT INTO ov_control_gateway_index VALUES (?,?)', digest, account)
      return true
    })
  }

  /** Private lookup for a tuple already authenticated and mapped by the parent. */
  resolveManagedIdentity(accountId: string, userId: string, agentId: string): Caller | null {
    this.#instance.assertServing()
    return this.#registry.resolveManagedIdentity(accountId, userId, agentId)
  }

  probe(): boolean { return this.#instance.serving() && this.#registry.sql.exec<{ n: number }>('SELECT 1 AS n').one().n === 1 }

  /** Read-only topology gate for the private backup binding. Fixed seats must
   * have been provisioned independently; do not reserve or read any keys here. */
  backupFixedTopology(accountId: string, users: string[]): boolean {
    this.#instance.assertServing()
    return this.#backupFixedTopology(accountId, users)
  }

  #backupFixedTopology(accountId: string, users: string[]): boolean {
    const account = id(accountId, 'account_id')
    if (!Array.isArray(users) || users.length < 1 || users.length > 32) return false
    const { sql } = this.#registry
    if (!sql.exec("SELECT 1 FROM ov_control_accounts WHERE account_id=? AND origin='fixed' AND deleted=0", account).toArray().length) return false
    const rows = sql.exec<{ user_id: string; origin: string; deleted: number }>(`SELECT user_id,origin,deleted FROM ov_control_users
      WHERE account_id=? ORDER BY user_id LIMIT 33`, account).toArray()
    return rows.length === users.length && rows.every((row, i) => row.origin === 'fixed' && !row.deleted && row.user_id === users[i]) &&
      !sql.exec("SELECT 1 FROM ov_control_settings WHERE account_id=? AND user_id!='' LIMIT 1", account).toArray().length
  }

  /** Private DO RPC: operational defaults only, never a deployment secret. */
  modelSettings(): ModelSettings { return this.#settings.models().settings }

  #initMountStore() {
    const { sql } = this.#registry
    sql.exec(`CREATE TABLE IF NOT EXISTS ov_control_gateway_mount_workspaces (
      account_id TEXT PRIMARY KEY REFERENCES ov_control_accounts(account_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ov_control_gateway_mount_pending (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))
    );
    CREATE TABLE IF NOT EXISTS ov_control_gateway_credential_fence (
      account_id TEXT PRIMARY KEY REFERENCES ov_control_accounts(account_id), revision INTEGER NOT NULL CHECK(revision>=0)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ov_control_data_member_fence (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      pending INTEGER NOT NULL CHECK(pending IN (0,1)), PRIMARY KEY (account_id,user_id),
      FOREIGN KEY (account_id,user_id) REFERENCES ov_control_users(account_id,user_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS ov_control_data_account_pending (
      account_id TEXT PRIMARY KEY REFERENCES ov_control_accounts(account_id), revision INTEGER NOT NULL CHECK(revision>0)
    ) WITHOUT ROWID`)
    return sql
  }

  /** Private DO RPC. One authoritative read of the grant, directory and mount.
   * Enrollment must commit with the snapshot, before an import can freeze it. */
  gatewayModelGrant(digest: string, owner: KeyAuthority, fixed: Caller[], expected?: number): GatewayMount {
    return this.#gatewayMount(digest, owner, fixed, expected)
  }

  /** Only an authenticated ordinary Data requester can receive this mount. */
  gatewayDataGrant(owner: KeyAuthority, fixed: Caller[], expected?: number): GatewayMount {
    return this.#gatewayMount(null, owner, fixed, expected)
  }

  /** Binding-only: the directory and the credential/group revision are read
   * together. This grant neither reads nor enrolls model configuration. */
  dataAuthorityGrant(owner: KeyAuthority, fixed: Caller[], expected?: AuthorityRevision): DataAuthorityGrant {
    this.#instance.assertServing()
    const account = owner.caller.accountId
    const locals = fixedCallers(fixed).filter(item => item.accountId === account)
    return this.#registry.tx(() => {
      if (!this.#admittedData(owner, locals)) return { status: 'expired' }
      const revision = this.#dataRevision(account, owner.caller.userId, expected === undefined)
      if (!revision || expected !== undefined && (!isAuthorityRevision(expected) || !sameAuthority(revision, expected))) return { status: 'changed' }
      return { status: 'ok', revision, groups: this.#registry.groupsFor(owner.caller), principals: this.#registry.principals(account, locals) }
    })
  }

  #admittedData(owner: KeyAuthority, locals: Caller[]): boolean {
    if (!hasCallerShape(owner.caller) || owner.caller.role !== 'admin' && owner.caller.role !== 'user' ||
        typeof owner.managed !== 'boolean' || !digestPattern.test(owner.digest)) return false
    if (!owner.managed && !locals.some(item => item.userId === owner.caller.userId &&
        item.agentId === owner.caller.agentId && item.role === owner.caller.role)) return false
    try { this.#registry.admitted(owner.caller, locals, owner.managed ? owner.digest : undefined) }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false
      throw error
    }
    return this.#registry.active(owner.caller)
  }

  #accountRevision(account: string): number | undefined {
    return this.#mountSql.exec<{ revision: number }>('SELECT revision FROM ov_control_gateway_credential_fence WHERE account_id=?', account).toArray()[0]?.revision
  }

  #authorityPending(account: string, user: string): boolean {
    return this.#mountSql.exec<{ pending: number }>(`SELECT EXISTS(SELECT 1 FROM ov_control_data_account_pending WHERE account_id=?)
      OR EXISTS(SELECT 1 FROM ov_control_data_member_fence WHERE account_id=? AND user_id=? AND pending=1) AS pending`,
      account, account, user).one().pending === 1
  }

  #dataRevision(account: string, user: string, enroll: boolean): AuthorityRevision | undefined {
    if (this.#authorityPending(account, user)) return undefined
    const sql = this.#mountSql
    if (enroll) sql.exec('INSERT OR IGNORE INTO ov_control_gateway_credential_fence VALUES (?,0)', account)
    const accountRevision = this.#accountRevision(account)
    const member = sql.exec<{ revision: number }>('SELECT revision FROM ov_control_data_member_fence WHERE account_id=? AND user_id=?', account, user).toArray()[0]?.revision ?? 0
    return validRevision(accountRevision) && validRevision(member) ? { account: accountRevision, member } : undefined
  }

  #gatewayMount(digest: string | null, owner: KeyAuthority, fixed: Caller[], expected?: number): GatewayMount {
    this.#instance.assertServing()
    const account = owner.caller.accountId
    const locals = fixedCallers(fixed).filter(item => item.accountId === account)
    const sql = this.#mountSql
    return this.#registry.tx(() => {
      if ((digest !== null && this.gatewayAccount(digest) !== account) || !this.#admittedData(owner, locals)) return { status: 'expired' }
      const { revision, settings } = this.#settings.models()
      if (!validRevision(revision) || sql.exec('SELECT 1 FROM ov_control_gateway_mount_pending WHERE id=1').toArray().length ||
          (expected !== undefined && expected !== revision)) return { status: 'changed' }
      const credentialRevision = this.#dataRevision(account, owner.caller.userId, expected === undefined)
      if (!credentialRevision) return { status: 'authority_changed' }
      if (expected === undefined) {
        sql.exec('INSERT OR IGNORE INTO ov_control_gateway_mount_workspaces VALUES (?)', account)
      }
      else if (!sql.exec('SELECT 1 FROM ov_control_gateway_mount_workspaces WHERE account_id=?', account).toArray().length) {
        return { status: 'changed' }
      }
      return { status: 'ok', revision, credentialRevision, settings, groups: this.#registry.groupsFor(owner.caller),
        principals: this.#registry.principals(account, locals) }
    })
  }

  #requireIdleAuthorityWriter(account: string): void {
    if (this.#authorityWrites.has(account)) throw new ApiError(409, 'CONFLICT', 'An authority change is already in progress in this account.')
  }

  #requireUnreservedDigest(digest: string): void {
    if (this.#rotatingDigests.has(digest)) throw new ApiError(503, 'KEY_ISSUANCE_UNAVAILABLE', 'A new credential could not be allocated.')
  }

  /** Prepare the registry mutation and reserve its inputs and epoch together.
   * Grant reads for other members stay available during the ACK. If the ACK
   * is lost, no registry change or history entry commits: only affected grants
   * remain frozen, even after restart, until an authorized effective retry. */
  async #changeDataAuthority<T>(account: string, write: <U>(op: () => U) => U,
    prepare: () => AuthorityMutation<T>, reservedDigest?: string): Promise<T> {
    const unavailable = () => new ApiError(503, 'GATEWAY_FENCE_UNAVAILABLE', 'The authority change has not been committed. Retry when the Workspace can acknowledge it.')
    this.#requireIdleAuthorityWriter(account)
    if (reservedDigest) this.#requireUnreservedDigest(reservedDigest)
    this.#authorityWrites.add(account)
    if (reservedDigest) this.#rotatingDigests.add(reservedDigest)
    const sql = this.#mountSql
    try {
      const plan = write(() => {
        const { scope, commit } = prepare()
        const before = this.#accountRevision(account)
        if (before === undefined || scope !== 'account' && scope.length === 0) return { done: true as const, result: commit() }
        let advance: AuthorityAdvance
        if (scope === 'account') {
          const revision = before + 1
          if (!validRevision(revision)) throw unavailable()
          sql.exec('UPDATE ov_control_gateway_credential_fence SET revision=? WHERE account_id=?', revision, account)
          sql.exec(`INSERT INTO ov_control_data_account_pending VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision`, account, revision)
          advance = { scope: 'account', revision }
        } else {
          const floors = [...new Set(scope)].sort().map(user => {
            const row = sql.exec<{ revision: number }>('SELECT revision FROM ov_control_data_member_fence WHERE account_id=? AND user_id=?', account, user).toArray()[0]
            const revision = (row?.revision ?? 0) + 1
            if (!validRevision(revision)) throw unavailable()
            return [user, revision] as const
          })
          sql.exec(`INSERT INTO ov_control_data_member_fence(account_id,user_id,revision,pending)
            SELECT ?,json_extract(value,'$[0]'),json_extract(value,'$[1]'),1 FROM json_each(?) WHERE true
            ON CONFLICT(account_id,user_id) DO UPDATE SET revision=excluded.revision,pending=1`, account, JSON.stringify(floors))
          advance = { scope: 'members', floors }
        }
        return { done: false as const, advance, commit }
      })
      if (plan.done) return plan.result
      const workspace = this.env.WORKSPACES.getByName(`openviking:account:${account}`)
      try {
        const receipt = await within(4_000, () => workspace.fenceGatewayCredentials(account, plan.advance),
          () => new GatewayError(503, 'GATEWAY_FENCE_UNAVAILABLE', 'The Workspace did not acknowledge the authority change.'))
        if (receipt !== authorityReceipt(plan.advance)) throw unavailable()
      } catch { throw unavailable() }
      return write(() => {
        const result = plan.commit()
        const { advance } = plan
        if (advance.scope === 'account') {
          sql.exec('DELETE FROM ov_control_data_account_pending WHERE account_id=? AND revision=?', account, advance.revision)
        } else {
          sql.exec(`UPDATE ov_control_data_member_fence SET pending=0 WHERE account_id=? AND (user_id,revision) IN
            (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`, account, JSON.stringify(advance.floors))
        }
        return result
      })
    } finally {
      this.#authorityWrites.delete(account)
      if (reservedDigest) this.#rotatingDigests.delete(reservedDigest)
    }
  }

  /** Freeze admissions, fence every enrolled Workspace, then commit. A partial
   * fence is never unwound; after interruption only the same import can resume. */
  async #importModels(match: string | null, dryRun: boolean, body: Record<string, unknown>, write: <T>(op: () => T) => T) {
    const sql = this.#mountSql
    const conflict = () => new ApiError(409, 'CONFLICT', 'Configuration revision changed or another model import is pending.')
    const plan = write(() => {
      const current = this.#settings.models()
      if (match !== null && Number(match) !== current.revision) throw conflict()
      const settings = patchModels(current.settings, body, this.env)
      const data = JSON.stringify(settings)
      if (dryRun) return { ...current, settings }
      const pending = sql.exec<PendingMount>('SELECT revision,data FROM ov_control_gateway_mount_pending WHERE id=1').toArray()[0]
      if (!pending && data === JSON.stringify(current.settings)) return current
      const revision = current.revision + 1
      if (!validRevision(revision) || this.#changingMount || (pending && (pending.revision !== revision || pending.data !== data))) throw conflict()
      sql.exec('INSERT OR IGNORE INTO ov_control_gateway_mount_pending VALUES (1,?,?)', revision, data)
      const accounts = sql.exec<{ account_id: string }>('SELECT account_id FROM ov_control_gateway_mount_workspaces ORDER BY account_id').toArray()
      // Includes suspended/deleted tenants if they once received this mount.
      if (accounts.length > LIMIT.accounts) throw fenceUnavailable()
      return { revision, settings, data, accounts }
    })
    if (!('accounts' in plan)) return plan
    this.#changingMount = true
    try {
      const deadline = Date.now() + 10_000
      for (let i = 0; i < plan.accounts.length; i += 16) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw fenceUnavailable()
        try {
          await within(remaining, async () => {
            await Promise.all(plan.accounts.slice(i, i + 16).map(async ({ account_id }) => {
              const workspace = this.env.WORKSPACES.getByName(`openviking:account:${account_id}`)
              if (await workspace.fenceGatewayModel(account_id, plan.revision) !== plan.revision) throw fenceUnavailable()
            }))
          }, fenceUnavailable)
        } catch { throw fenceUnavailable() }
      }
      return write(() => {
        const pending = sql.exec<PendingMount>('SELECT revision,data FROM ov_control_gateway_mount_pending WHERE id=1').one()
        if (pending.revision !== plan.revision || pending.data !== plan.data ||
            this.#settings.models().revision !== plan.revision - 1) throw conflict()
        this.#settings.saveModels(plan.revision, plan.settings)
        sql.exec('DELETE FROM ov_control_gateway_mount_workspaces; DELETE FROM ov_control_gateway_mount_pending WHERE id=1')
        return { revision: plan.revision, settings: plan.settings }
      })
    } finally { this.#changingMount = false }
  }

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
    this.#instance.assertServing()
    const account = id(accountId, 'account_id')
    const fixed = fixedIdentities === undefined ? [] : fixedCallers(fixedIdentities).filter(item => item.accountId === account)
    return this.#registry.tx(() => {
      if (fixed.length) this.#registry.reserveFixed(fixed)
      return this.#registry.principals(account, fixed)
    })
  }

  /** Called only after the outer Worker verifies a current fixed credential. */
  admitFixed(caller: Caller): boolean {
    this.#instance.assertServing()
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
      this.#instance.assertServing()
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
        this.#instance.assertServing()
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
            default_search_limit: settings.default_search_limit ?? edgeSearchDefaults.limit,
            default_search_score_threshold: settings.default_search_score_threshold ?? edgeSearchDefaults.score,
            retrieval: { use_session_context: settings.retrieval?.enable_intent ?? edgeSearchDefaults.sessionContext, intent_planner: false,
              ...(settings.retrieval?.session_context_messages !== undefined && { session_context_messages: settings.retrieval.session_context_messages }),
              ...(settings.retrieval?.session_context_chars !== undefined && { session_context_chars: settings.retrieval.session_context_chars }) },
            rerank: settings.rerank ? { ...settings.rerank, configured: !!bindReranker(this.env, settings.rerank) } : null,
            memory: { extraction_enabled: settings.memory?.extraction_enabled ?? true,
              edge_extraction_max_tokens: settings.memory?.edge_extraction_max_tokens ?? edgeSessionDefaults.extractionTokens,
              edge_context_token_budget: settings.memory?.edge_context_token_budget ?? null,
              session_auto_commit: settings.memory?.session_auto_commit?.enabled ? { enabled: true,
                message_count_threshold: settings.memory.session_auto_commit.message_count_threshold ?? edgeSessionDefaults.messageThreshold,
                pending_token_threshold: settings.memory.session_auto_commit.pending_token_threshold ?? edgeSessionDefaults.pendingTokenThreshold,
              } : { enabled: false } },
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
        const { revision, settings } = await this.#importModels(match, dryRun, body, write)
        return view(revision, settings, dryRun)
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
        this.#requireUnreservedDigest(digest)
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
      await this.#changeDataAuthority(account, write, () => {
        if (registry.account(account).origin !== 'managed') throw forbidden()
        return { scope: 'account', commit: () => registry.revoke(account) }
      })
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
        return ok(write(() => { this.#requireIdleAuthorityWriter(account); return registry.createGroup(account, group) }))
      }
      if (path.length === 4) {
        if (verb !== 'DELETE') throw methodError()
        await this.#changeDataAuthority(account, write, () => {
          registry.listMembers(account, user, fixed)
          // Deletion changes the account's ACL-principal catalogue as well
          // as memberships, including for ACL authors outside the group.
          return { scope: 'account', commit: () => registry.deleteGroup(account, user) }
        })
        return ok({ deleted: true })
      }
      if (path.length !== 5 || action !== 'members') throw absent()
      if (verb === 'GET') return ok({ group_id: user, members: registry.listMembers(account, user, fixed) })
      if (verb !== 'PUT' && verb !== 'DELETE') throw methodError()
      const members = memberIds(await readBody(request))
      const add = verb === 'PUT'
      const changed = await this.#changeDataAuthority(account, write, () => {
        const { changed, commit } = registry.prepareMembers(account, user, members, fixed, add)
        return { scope: changed, commit }
      })
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
        this.#requireIdleAuthorityWriter(account)
        this.#requireUnreservedDigest(digest)
        registry.register(account, userId, newRole, digest)
        this.#settings.saveUser(account, userId, userConfig)
      })
      return ok({ account_id: account, user_id: userId, user_key: key })
    }
    if (path.length === 4) {
      manager(caller)
      if (verb === 'GET') return ok(registry.member(account, user, fixed))
      if (verb !== 'DELETE') throw methodError()
      await this.#changeDataAuthority(account, write, () => {
        registry.writableUser(account, user)
        return { scope: [user], commit: () => registry.revoke(account, user) }
      })
      return ok({ account_id: account, user_id: user, status: 'revoked', data_retained: true }, 202)
    }
    if (path.length !== 5) throw absent()
    if (action === 'role') {
      manager(caller)
      if (verb !== 'PUT') throw methodError()
      const body = await readBody(request)
      fields(body, ['role'])
      const newRole = role(body.role)
      await this.#changeDataAuthority(account, write, () => ({
        scope: registry.writableUser(account, user).role === newRole ? [] : [user],
        commit: () => registry.changeRole(account, user, newRole),
      }))
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
    await this.#changeDataAuthority(account, write, () => ({ scope: [user], commit: registry.prepareRotation(account, user, digest, previous) }), digest)
    return ok({ user_key: key })
  }
}

function uniqueFixedUsers(fixed: Caller[]): Caller[] {
  return [...new Map(fixed.map(item => [`${item.accountId}/${item.userId}`, item])).values()]
}
