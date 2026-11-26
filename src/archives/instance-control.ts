// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from '../context.js'
import { isRecord, ok, readBytes, readJson } from '../http.js'
import { aclSeal } from './backup-acl.js'
import { approvalMs, approvalToken, backupResponse } from './backup-authority.js'
import type { Scope } from './backup-authority.js'
import { hasTable } from './backup-domain.js'
import { attachment, digest, fail, invalid } from './common.js'
import { admitInstancePermit, captureProfile, hashId, instanceId, instanceMode, instanceMount, instancePermit, instanceScopes, offline,
  refused, rosterTag, signInstance, unsupported, verifyInstance, workspaceName, wrongStage } from './instance-authority.js'
import type { ControlCommand, InstanceProfile, MemberCall, Mount } from './instance-authority.js'
import { decodeInstance, encodeInstance, instanceFilename, memberLimit, zipInput } from './instance-codec.js'
import type { Member } from './instance-codec.js'
import { assertColdControl, captureInstanceSettings, publishInstanceSettings, readInstanceSettings } from './instance-settings.js'
import { attachmentsExpired, attachmentCountLimit } from './instance-attachments.js'

const table = 'ov_control_instance_restore'
const noStore = { 'cache-control': 'private, no-store' }
const receiptId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
type State = { destination: string; job: string; plans: string; receipts: string; released: number }
// Preserve the on-disk v1 string[] and approval input exactly. The v2 deadline
// is learned only from a verified Workspace plan, never from a client clock.
type Plan = string | [token: string, count: number, deadline: number | null]
function plansExpired(plans: Plan[]) {
  const now = Date.now()
  return plans.some(p => typeof p !== 'string' && p[2] !== null && p[2] <= now)
}
function requireLivePlans(plans: Plan[]) {
  if (plansExpired(plans)) attachmentsExpired()
}
const token = (p: Plan) => typeof p === 'string' ? p : p[0]

export class InstanceRecovery {
  #busy = false
  constructor(private storage: DurableObjectStorage, private env: Env, private id: string,
    private fixed: (account: string, users: string[]) => boolean) {}

  private get sql() { return this.storage.sql }

  private state(): State | undefined {
    return hasTable(this.sql, table) ? this.sql.exec<State>(`SELECT destination,job,plans,receipts,released FROM ${table} WHERE id=1`).toArray()[0] : undefined
  }

  /** Pure admission read; no data or identifiers are returned to clients. */
  serving(destination?: string, job?: string): boolean {
    const mode = instanceMode(this.env)
    if (mode?.mode === 'source') return false
    const row = this.state(), expected = destination ?? mode?.id
    if (!row) return expected === undefined && job === undefined
    return row.released === 1 && (!mode || mode.id === row.destination) && (expected === undefined || expected === row.destination) &&
      (job === undefined || job === row.job)
  }

  assertServing() { if (!this.serving()) offline() }

  private inventory(): Scope[] {
    const scopes = instanceScopes(this.env)
    // Include tombstones in the check: an active subset is not an exhaustive
    // account catalogue. No private Workspace is contacted if consent is incomplete.
    const db = this.sql.exec<{ account_id: string }>('SELECT account_id FROM ov_control_accounts ORDER BY account_id LIMIT ?', scopes.length + 1).toArray()
    if (db.length !== scopes.length || scopes.some((s, i) => db[i].account_id !== s.account || !this.fixed(s.account, s.users))) return unsupported()
    return scopes
  }

  private progress(row?: State): Response {
    if (!row) return ok({ phase: 'empty', completed: 0 })
    const receipts = JSON.parse(row.receipts) as string[], plans = JSON.parse(row.plans) as Plan[], total = plans.length
    const phase = row.released ? 'published' : plansExpired(plans) ? 'expired' : receipts.length === total ? 'awaiting_release' : 'staged'
    return ok({ phase, job: row.job, total, completed: receipts.length, receipts }, row.released ? 200 : 202)
  }

  private async member(mount: Mount, call: MemberCall, archive?: ArrayBuffer, seal?: string) {
    const target = this.env.WORKSPACES.getByName(workspaceName(call.account))
    const response = await target.instanceBackup(call, await instancePermit(mount, call), archive, seal)
    if (!response.ok) {
      const value = await readJson(response, 1024)
      const code = isRecord(value.error) && typeof value.error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(value.error.code)
        ? value.error.code : 'INSTANCE_BACKUP_MEMBER_FAILED'
      return fail(response.status, code, 'A workspace could not establish the requested backup stage. Nothing was released.')
    }
    return response
  }

  private async capture(mount: Mount, scopes: Scope[], live: () => void, profile: InstanceProfile) {
    const prior = this.state()
    if (prior && !prior.released) return wrongStage()
    const capture = crypto.randomUUID().replaceAll('-', '')
    const settings = captureInstanceSettings(this.sql, scopes)
    const members: Member[] = []
    for (const scope of scopes) {
      live()
      const response = await this.member(mount, { op: 'capture', account: scope.account, capture, ...(profile !== 'edge-v1' && { profile }) })
      const bytes = await readBytes(response, memberLimit(profile))
      const seal = response.headers.get('x-ovpack-seal')
      aclSeal(seal, scope.users.length)
      if (!bytes.byteLength || await digest(bytes) !== response.headers.get('x-ovpack-sha256')) return unsupported()
      members.push({ account_id: scope.account, workspace: this.env.WORKSPACES.idFromName(workspaceName(scope.account)).toString(),
        roster: await rosterTag(this.env, mount, scope), seal: seal!, bytes })
    }
    this.inventory()
    const bytes = await encodeInstance(mount, capture, settings, members, profile)
    live()
    return new Response(bytes, { headers: { ...noStore, 'content-type': 'application/zip', 'content-disposition': attachment(instanceFilename) } })
  }

  run(command: ControlCommand, permit: unknown, archive?: unknown, argument?: unknown): Promise<Response> {
    return backupResponse(async () => {
      const mount = instanceMount(this.env)
      if (mount.local.control !== this.id || !(command === 'capture' || command === 'evaluate' || command === 'begin' ||
        command === 'step' || command === 'status' || command === 'release') || (command === 'capture') !== (mount.mode === 'source')) return refused()
      const live = await admitInstancePermit(mount, command, permit)
      if (command === 'status') {
        const row = this.state()
        if (row && row.destination !== mount.local.id) return wrongStage()
        return this.progress(row)
      }
      if (this.#busy) return fail(409, 'INSTANCE_BACKUP_BUSY', 'An operator call is already in progress. Read status then retry.')
      this.#busy = true
      try {
        const scopes = this.inventory()
        if (command === 'capture') return await this.capture(mount, scopes, live, captureProfile(argument))
        const pack = await decodeInstance(this.env, mount, scopes, zipInput(archive))
        const { capture, job, accounts, profile } = pack
        const extra: Pick<MemberCall, 'profile'> = profile !== 'edge-v1' ? { profile } : {}
        const config = readInstanceSettings(pack.settings, scopes)
        const row = this.state()
        if (row && (row.destination !== mount.local.id || row.job !== job)) return wrongStage()
        if (command === 'evaluate' || command === 'begin') {
          if (row) return command === 'begin' ? this.progress(row) : wrongStage()
          const approval = command === 'begin' ? approvalToken(argument) : undefined
          assertColdControl(this.sql)
          const plans: Plan[] = []
          for (const { account, sha256, bytes, seal } of accounts) {
            live()
            // A member view can be offset within the full ZIP. Pass ONLY those bytes to its own Workspace.
            const response = await this.member(mount, { op: 'evaluate', account, capture, job, sha256, ...extra }, bytes.slice().buffer, seal)
            const { result } = await readJson(response, 2048)
            if (!isRecord(result) || result.dry_run !== true || !hashId(result.plan)) return unsupported()
            if (extra.profile) {
              const { attachment_count: count, attachment_deadline: deadline } = result
              if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > attachmentCountLimit ||
                  (count === 0 ? deadline !== null : typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 1)) return unsupported()
              plans.push([result.plan, count, deadline as number | null])
            } else plans.push(result.plan)
          }
          // An approval is bound to this exact verified inventory and all cold plans.
          // Once journaled, no expiring approval is needed to resume this immutable plan.
          if (!approval) {
            const expires_at = Date.now() + approvalMs
            const mac = await signInstance(mount, 'approve', job, plans, expires_at)
            live()
            requireLivePlans(plans)
            return ok({ dry_run: true, job, accounts: plans.length, approval: { expires_at, mac }, ...(extra.profile && {
              attachment_count: plans.reduce((sum, p) => sum + (typeof p === 'string' ? 0 : p[1]), 0),
            }) })
          }
          if (!await verifyInstance(mount, 'approve', approval.mac, job, plans, approval.expires_at)) return wrongStage()
          this.storage.transactionSync(() => {
            live()
            if (approval.expires_at <= Date.now() || this.state()) wrongStage()
            requireLivePlans(plans)
            this.inventory()
            assertColdControl(this.sql)
            this.sql.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY CHECK(id=1), destination TEXT NOT NULL, job TEXT NOT NULL,
              plans TEXT NOT NULL, receipts TEXT NOT NULL, released INTEGER NOT NULL CHECK(released IN (0,1)))`)
            this.sql.exec(`INSERT INTO ${table} VALUES (1,?,?,?,'[]',0)`, mount.local.id, job, JSON.stringify(plans))
          })
        } else {
          if (!row) return wrongStage()
          const plans = JSON.parse(row.plans) as Plan[], receipts = JSON.parse(row.receipts) as string[]
          if (plans.length !== accounts.length || receipts.length > plans.length || !plans.every(p =>
             extra.profile ? Array.isArray(p) && hashId(p[0]) : hashId(p))) return wrongStage()
          if (!row.released) requireLivePlans(plans)
          if (command === 'step') {
            if (typeof argument !== 'number' || !Number.isSafeInteger(argument) || argument < 0 || argument >= plans.length || argument > receipts.length) return wrongStage()
            if (argument < receipts.length) return this.progress(row)
            if (row.released) return wrongStage()
            assertColdControl(this.sql)
            const { account, sha256, bytes, seal } = accounts[argument]
            live()
            const response = await this.member(mount, { op: 'apply', account, capture, job, sha256, plan: token(plans[argument]), ...extra }, bytes.slice().buffer, seal)
            const { result } = await readJson(response, 1024)
            if (!isRecord(result) || typeof result.receipt !== 'string' || !receiptId.test(result.receipt)) return wrongStage()
            this.storage.transactionSync(() => {
              live()
              requireLivePlans(plans)
              this.inventory()
              this.checkCurrent(row)
              this.sql.exec(`UPDATE ${table} SET receipts=? WHERE id=1`, JSON.stringify([...receipts, result.receipt]))
            })
          } else {
            if (receipts.length !== plans.length) return wrongStage()
            if (row.released) return this.progress(row)
            for (const [i, { account, sha256 }] of accounts.entries()) {
              live()
              const response = await this.member(mount, { op: 'receipt', account, capture, job, sha256, plan: token(plans[i]), ...extra })
              const { result } = await readJson(response, 1024)
              if (!isRecord(result) || result.receipt !== receipts[i]) return wrongStage()
            }
            this.storage.transactionSync(() => {
              live()
              this.inventory()
              this.checkCurrent(row)
              assertColdControl(this.sql)
              publishInstanceSettings(this.sql, config)
              requireLivePlans(plans)
              this.sql.exec(`UPDATE ${table} SET released=1 WHERE id=1`)
            })
          }
        }
        await this.storage.sync()
        return this.progress(this.state())
      } finally { this.#busy = false }
    })
  }

  private checkCurrent(expected: State) {
    const row = this.state()
    if (!row || row.destination !== expected.destination || row.job !== expected.job || row.plans !== expected.plans ||
        row.receipts !== expected.receipts || row.released) wrongStage()
  }
}
