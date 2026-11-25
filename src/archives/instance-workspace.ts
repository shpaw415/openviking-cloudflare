// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from '../context.js'
import { isRecord, ok } from '../http.js'
import { armGatewayAttachmentPurge, attachmentTable, sweepGatewayAttachments } from '../gateway/attachments.js'
import { backupAccountId, backupResponse, scopeFor, zipBuffer } from './backup-authority.js'
import { hasTable } from './backup-domain.js'
import { captureBackup, restoreBackup } from './backup-workspace.js'
import { digest, fail } from './common.js'
import { admitInstancePermit, coldRequired, controlName, hashId, instanceId, instanceMode, instanceMount, instanceSeats, memberSeal,
  offline, refused, withAttachments, workspaceName, wrongStage } from './instance-authority.js'
import type { MemberCall } from './instance-authority.js'
import { attachmentArchiveBytes, attachmentsExpired } from './instance-attachments.js'

const table = 'ov_edge_instance_restore_receipt'
const attachmentReceipt = 'ov_edge_instance_attachment_deadline'
type Receipt = { destination: string; job: string; account: string; sha256: string; plan: string; receipt: string }
function receiptOf(sql: SqlStorage): Receipt | undefined {
  return hasTable(sql, table) ? sql.exec<Receipt>(`SELECT destination,job,account,sha256,plan,receipt FROM ${table} WHERE id=1`).toArray()[0] : undefined
}

/** Standby housekeeping only, anchored by a real restore commit. No init of
 * jobs/watches or unrelated schemas, and no new scheduler. */
export async function maintainStandbyAttachments(storage: DurableObjectStorage) {
  const { sql } = storage
  const committed = hasTable(sql, attachmentReceipt) && hasTable(sql, attachmentTable) ? receiptOf(sql) : undefined
  if (committed) await sweepGatewayAttachments(storage, committed.account)
}

/** The named mount is blocked even with a fresh DB. A committed prefix stays
 * offline on the same code/namespace even if deployment variables are omitted. */
export async function assertInstanceServing(env: Env, sql?: SqlStorage): Promise<void> {
  const mode = instanceMode(env), recovery = sql && receiptOf(sql)
  if (mode?.mode === 'source' || (mode && recovery && recovery.destination !== mode.id)) return offline()
  // An unpublished journal can exist before the first Workspace commit and
  // after configuration is removed. The bound Control remains authoritative.
  if (!mode && !recovery && !env.CONTROL && !env.OPENVIKING_EDGE_INSTANCE_BACKUP_KEY) return
  const ctl = env.CONTROL?.getByName(controlName) as unknown as { instanceServing(destination?: string, job?: string): Promise<boolean> } | undefined
  let online = false
  try { online = await ctl?.instanceServing(recovery?.destination ?? mode?.id, recovery?.job) === true } catch { /* closed */ }
  if (!online) offline()
}

function cold(sql: SqlStorage) {
  // Even a previously initialized workspace with no user files is not cold.
  if (sql.exec("SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' LIMIT 1").toArray().length) coldRequired()
}

function assertInstancePortable(sql: SqlStorage, carriesAttachments: boolean) {
  const hasRows = (name: string, filter = '') => hasTable(sql, name) && sql.exec(`SELECT 1 FROM ${name} ${filter} LIMIT 1`).toArray().length > 0
  // This living domain is intentionally refused ahead of capture; no bytes or ticket fields are read.
  if (!carriesAttachments && hasRows(attachmentTable)) fail(409, 'INSTANCE_BACKUP_ATTACHMENTS_UNSUPPORTED', 'This backup version cannot represent private Gateway attachments.')
  const outside = ['ov_edge_snapshot_commit', 'ov_edge_snapshot_head', 'ov_edge_snapshot_blob', 'ov_edge_snapshot_ignore', 'ov_watches',
    'ov_edge_compile_config', 'ov_edge_compiled_rule', 'ov_edge_compile_artifact', 'ov_gateway_objects', 'ov_gateway_state', 'ov_edge_mcp_registry']
  if (outside.some(name => hasRows(name)) || hasRows('ov_edge_compile_schedule', 'WHERE wake_at IS NOT NULL') ||
      hasRows('ov_edge_fs_entry', `WHERE space!='shared' AND substr(space,1,8)!='["user",'`) ||
      hasRows('ov_jobs', "WHERE status IN ('pending','running','cancelling')")) {
    fail(409, 'INSTANCE_BACKUP_DOMAIN_UNSUPPORTED', 'A workspace contains application state outside the portable instance profile.')
  }
}

export function workspaceInstanceBackup(storage: DurableObjectStorage, env: Env, id: string, raw: unknown, permit: unknown,
  archive?: unknown, seal?: unknown): Promise<Response> {
  return backupResponse(async () => {
    const mount = instanceMount(env)
    if (!isRecord(raw) || typeof raw.account !== 'string' || !backupAccountId.test(raw.account) || !instanceId(raw.capture) ||
        env.WORKSPACES.idFromName(workspaceName(raw.account)).toString() !== id) return refused()
    if (Object.hasOwn(raw, 'profile') && raw.profile !== withAttachments) return refused()
    const carriesAttachments = raw.profile === withAttachments
    const extra: Pick<MemberCall, 'profile'> = carriesAttachments ? { profile: withAttachments } : {}
    const additional = Number(carriesAttachments)
    let call: MemberCall
    if (raw.op === 'capture') {
      if (mount.mode !== 'source' || Object.keys(raw).length !== 3 + additional) return refused()
      call = { account: raw.account, op: raw.op, capture: raw.capture, ...extra }
    } else {
      const { op, job, sha256, plan } = raw
      if (mount.mode !== 'standby' || (op !== 'evaluate' && op !== 'apply' && op !== 'receipt') ||
          !hashId(job) || !hashId(sha256) || Object.keys(raw).length !== (op === 'evaluate' ? 5 : 6) + additional ||
          (op === 'evaluate' ? plan !== undefined : !hashId(plan))) return refused()
      call = { account: raw.account, op, capture: raw.capture, job, sha256, plan: plan as string | undefined, ...extra }
    }
    const live = await admitInstancePermit(mount, call, permit)
    const scope = scopeFor(env, call.account), signing = memberSeal(mount, call.capture, call.profile)
    const roster = carriesAttachments ? instanceSeats(env, scope.account) : undefined
    const seats = roster && { account: scope.account, owns: (user: string, agent: string) => roster.some(s => s.userId === user && s.agentId === agent) }
    const sql = storage.sql
    if (call.op === 'capture') return captureBackup(storage, env, scope, undefined, { profile: 'edge-v1' }, {
      seal: signing, live, seats, check: () => assertInstancePortable(sql, carriesAttachments),
    })

    const { job, sha256, plan } = call
    const existing = receiptOf(sql)
    if (existing) {
      if (call.op === 'evaluate' || existing.job !== job || existing.sha256 !== sha256 || existing.plan !== plan ||
          existing.account !== scope.account || existing.destination !== mount.local.id) return wrongStage()
      if (carriesAttachments) {
        if (!hasTable(sql, attachmentReceipt)) return wrongStage()
        const { deadline, count } = sql.exec<{ deadline: number | null; count: number }>(`SELECT deadline,count FROM ${attachmentReceipt} WHERE id=1`).one()
        if (deadline != null) {
          if (deadline <= Date.now()) return attachmentsExpired()
          if (!hasTable(sql, attachmentTable)) return wrongStage()
          const current = sql.exec<{ deadline: number; count: number }>(`SELECT min(expires_at) AS deadline,count(*) AS count FROM ${attachmentTable}
            WHERE account_id=?`, scope.account).one()
          if (current.deadline !== deadline || current.count !== count) return wrongStage()
          // Re-establish the ordinary alarm even after a lost ACK or reboot.
          await armGatewayAttachmentPurge(storage, deadline)
          if (deadline <= Date.now()) return attachmentsExpired()
        }
      }
      await storage.sync()
      live()
      return ok({ receipt: existing.receipt })
    }
    if (call.op === 'receipt') return wrongStage()
    const bytes = carriesAttachments ? archive : zipBuffer(archive)
    if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > attachmentArchiveBytes) return refused()
    if (await digest(new Uint8Array(bytes)) !== sha256) return refused()
    return restoreBackup(storage, env, id, scope, undefined, call.op === 'evaluate', bytes, seal,
      { profile: 'edge-v1', on_conflict: 'overwrite', vector_mode: 'deferred' }, undefined, {
        seal: signing, live, plan, seats, cold: () => cold(sql), commit: (deadline, count) => {
          sql.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY CHECK(id=1), destination TEXT NOT NULL, job TEXT NOT NULL,
            account TEXT NOT NULL, sha256 TEXT NOT NULL, plan TEXT NOT NULL, receipt TEXT NOT NULL)`)
          const receipt = crypto.randomUUID()
          sql.exec(`INSERT INTO ${table} VALUES (1,?,?,?,?,?,?)`, mount.local.id, job, scope.account, sha256, plan!, receipt)
          if (carriesAttachments) {
            sql.exec(`CREATE TABLE ${attachmentReceipt} (id INTEGER PRIMARY KEY CHECK(id=1), deadline INTEGER, count INTEGER NOT NULL)`)
            sql.exec(`INSERT INTO ${attachmentReceipt} VALUES (1,?,?)`, deadline, count)
          }
          return receipt
        },
      })
  })
}
