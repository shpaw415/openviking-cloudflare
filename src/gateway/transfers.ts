// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthGrant } from '../auth.js'
import type { Env, WorkspaceContext } from '../context.js'
import { ApiError, ok, readJson } from '../http.js'
import { download } from '../fs/content.js'
import { onlyKeys } from '../fs/contract.js'
import { checkResourceTransfer, prepareResourceTransfer, publishResourceTransfer, readMultipartUpload } from '../fs/resources.js'
import type { ResourceTransfer } from '../fs/resources.js'
import { Filesystem } from '../fs/store.js'
import { checkSkillTransfer, prepareSkillTransfer, publishSkillTransfer } from '../skills.js'
import type { SkillTransfer } from '../skills.js'
import { GatewayError, encoder, integer, invalid, methodError, unsupported } from './contract.js'
import type { TransferOperation } from './contract.js'
import { mountDataAuthority, sameAuthority, storedAuthority } from '../data-authority.js'
import type { AuthorityRevision, DataAuthority } from '../data-authority.js'
import { armGatewayAttachmentPurge, assertAttachmentCapacity, attachmentInfo, deleteAttachment, gatewayAttachmentId,
  insertGatewayAttachment, maxAttachmentRetention, readAttachment, validateAttachmentBytes, validateAttachmentDraft } from './attachments.js'
import type { AttachmentDraft, AttachmentInfo } from './attachments.js'
import { readAttachmentMultipart } from './attachment-multipart.js'

export const transferTicketHeader = 'x-openviking-transfer-ticket'
const paths = { upload: '/gateway/uploads', download: '/gateway/downloads', delete: '/gateway/transfers/attachments' } as const
const methods = { issue: 'POST', upload: 'POST', download: 'GET', delete: 'DELETE' } as const
const ttl = 600
const maxBodyTime = 30_000
const payloadLimit = 8 * 1024
const ticketPattern = /^v1\.([a-f0-9]{32})\.([a-f0-9]{64})$/u
const invalidTicket = () => new GatewayError(401, 'invalid_transfer_ticket', 'The transfer ticket is invalid, expired or already used.')
const changed = () => new GatewayError(409, 'transfer_revision_changed', 'The signed file revision changed. Request a new ticket.')
const uploading = new WeakMap<DurableObjectStorage, number>()
type Action = Exclude<TransferOperation, 'issue'>
type Scope = [account: string, user: string, agent: string, role: string, digest: string, managed: number, origin: string]
type LegacyPlan = { kind: 'download'; uri: string; revision: string } | ({ kind: 'resource' } & ResourceTransfer) |
  ({ kind: 'skill' } & SkillTransfer)
type AttachmentTarget = { attachmentId: string; revision: string }
type AttachmentPlan = { kind: 'attachment_upload'; attachmentId: string; draft: AttachmentDraft; retention: number } |
  ({ kind: 'attachment_read' } & AttachmentTarget) | ({ kind: 'attachment_delete' } & AttachmentTarget)
type Plan = LegacyPlan | AttachmentPlan
type Stored = { expires_at: number; plan: string }
type SignedPlan = { authorityRevision: AuthorityRevision; target: Plan }

export function initGatewayTransfers(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_gateway_transfer (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, role TEXT NOT NULL,
    credential TEXT NOT NULL, managed INTEGER NOT NULL, origin TEXT NOT NULL,
    id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('upload','download')),
    expires_at INTEGER NOT NULL, plan TEXT NOT NULL, spent INTEGER NOT NULL DEFAULT 0 CHECK(spent IN (0,1)),
    PRIMARY KEY (account_id,id)
  ) WITHOUT ROWID`)
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/../g)!, byte => Number.parseInt(byte, 16))
}

function signingSecret(env: Env): Uint8Array<ArrayBuffer> {
  const value = env.OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET
  if (env.OPENVIKING_EDGE_GATEWAY_TRANSFERS !== '1' || typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw unsupported('Signed Gateway transfers are not available.', 'signed_transfer_unavailable')
  }
  const bytes = unhex(value)
  // Reject obvious placeholders. Entropy still comes exclusively from the operator's random source.
  if (new Set(bytes).size < 16) throw unsupported('Signed Gateway transfers are not available.', 'signed_transfer_unavailable')
  return bytes
}

export function gatewayTransfersConfigured(env: Env): boolean {
  try { signingSecret(env); return true } catch { return false }
}

async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', signingSecret(env), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

const signatureInput = (scope: Scope, id: string, action: Action, expiry: number, plan: string) =>
  encoder.encode(JSON.stringify(['openviking-edge/gateway-transfer/v1', scope, id, action, expiry, plan]))
const matching = 'account_id=? AND user_id=? AND agent_id=? AND role=? AND credential=? AND managed=? AND origin=? AND id=? AND action=?'
// Retain the F3 ledger and its v1 tickets unchanged. The stored bucket classifies
// mutations; the MAC binds the exact route action (so DELETE is never a POST).
const ticketBucket = (action: Action) => action === 'delete' ? 'upload' : action
const actionForPlan = (plan: Plan): Action => {
  switch (plan.kind) {
    case 'attachment_delete': return 'delete'
    case 'attachment_read': case 'download': return 'download'
    default: return 'upload'
  }
}
const isAttachment = (plan: Plan): plan is AttachmentPlan => 'attachmentId' in plan

function checkLegacyPlan(fs: Filesystem, plan: LegacyPlan): void {
  if (plan.kind === 'resource') {
    checkResourceTransfer(fs, plan)
    return
  }
  if (plan.kind === 'skill') {
    checkSkillTransfer(fs, plan)
    return
  }
  const entry = fs.require(fs.path(plan.uri), 'read')
  if (entry.is_dir || entry.revision !== plan.revision) throw changed()
}

function prepareAttachment(fs: Filesystem, action: Action, options: Record<string, unknown>): AttachmentPlan {
  if (action === 'upload') {
    onlyKeys(options, 'kind filename content_type size retention_seconds')
    const { filename, content_type, size, retention_seconds: retention = 86_400 } = options
    if (!integer(retention, 1, maxAttachmentRetention)) throw invalid('retention_seconds must be an integer from 1 to 604800.')
    const draft = validateAttachmentDraft(filename, content_type, size)
    return { kind: 'attachment_upload', attachmentId: `att_${crypto.randomUUID().replaceAll('-', '')}`, draft, retention }
  }
  onlyKeys(options, 'kind attachment_id')
  const attachmentId = gatewayAttachmentId(options.attachment_id)
  const { revision } = attachmentInfo(fs.sql, fs.caller, attachmentId)
  return { kind: action === 'delete' ? 'attachment_delete' : 'attachment_read', attachmentId, revision }
}

function checkPlan(fs: Filesystem, plan: Plan): void {
  if (!isAttachment(plan)) return checkLegacyPlan(fs, plan)
  if (plan.kind === 'attachment_upload') return assertAttachmentCapacity(fs.sql, fs.caller, plan.draft.size)
  attachmentInfo(fs.sql, fs.caller, plan.attachmentId, plan.revision)
}

function attachmentDownload(fs: Filesystem, plan: AttachmentTarget): Response {
  const file = readAttachment(fs.sql, fs.caller, plan.attachmentId, plan.revision)
  const name = encodeURIComponent(file.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return new Response(file.bytes, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
  } })
}

function wireAttachment(attachmentId: string, info: AttachmentInfo) {
  return { attachment_id: attachmentId, filename: info.filename, content_type: info.contentType,
    size: info.size, expires_at: new Date(info.expiresAt).toISOString() }
}

/** In-Workspace read only. No HTTP or DO RPC bypass. Call assertCurrent at the
 * point of use (including after waits); consumers must also check their own
 * provider/model authorization. Cloning avoids overwriting that caller's lease. */
export async function readPrivateGatewayAttachment(env: Env, ctx: WorkspaceContext, id: unknown) {
  signingSecret(env)
  if (!ctx.loadDataAuthority) throw new ApiError(403, 'PERMISSION_DENIED', 'Attachments require direct Data authority.')
  const attachmentId = gatewayAttachmentId(id), data = { ...ctx }
  const authority = await mountDataAuthority(data)
  await data.reauthorize?.()
  authority.assertCurrent()
  const owner = { ...data.caller }
  const { revision, ...file } = readAttachment(data.sql, owner, attachmentId)
  return { ...file, assertCurrent: () => {
    authority.assertCurrent()
    attachmentInfo(data.sql, owner, attachmentId, revision)
  } }
}

function deadline(ms: number, error: ApiError) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(error), Math.max(0, ms))
  return { signal: controller.signal, close: () => clearTimeout(timer) }
}

async function issue(request: Request, fs: Filesystem, key: CryptoKey, scope: Scope, authority: DataAuthority): Promise<Response> {
  const timeout = deadline(maxBodyTime, new GatewayError(408, 'transfer_body_timeout', 'The transfer request exceeded its body deadline.'))
  let body: Record<string, unknown>
  try { body = await readJson(request, payloadLimit, timeout.signal) }
  finally { timeout.close() }
  const { action, ttl_seconds: duration = ttl, ticket_transport: transport = 'query', ...options } = body
  if (action !== 'upload' && action !== 'download' && action !== 'delete') throw invalid('Select upload, download or attachment deletion.')
  if (!integer(duration, 1, ttl)) throw invalid('ttl_seconds must be an integer from 1 to 600.')
  if (transport !== 'query' && transport !== 'header') throw invalid('ticket_transport must be query or header.')
  await fs.ctx.reauthorize?.()
  authority.assertCurrent()
  let target: Plan
  if (options.kind === 'attachment') target = prepareAttachment(fs, action, options)
  else if (action === 'delete') throw invalid('Deletion requires kind: attachment.')
  else if (action === 'download') {
    onlyKeys(options, 'uri')
    const path = fs.path(options.uri), entry = fs.require(path, 'read')
    if (entry.is_dir) throw invalid('Only one file can be downloaded.')
    target = { kind: 'download', uri: path.uri, revision: entry.revision }
  } else {
    const { kind = 'resource', ...params } = options
    if (kind === 'resource') target = { kind, ...prepareResourceTransfer(fs, params) }
    else if (kind === 'skill') target = { kind, ...prepareSkillTransfer(fs, params) }
    else throw invalid('Select resource, skill or attachment for an upload.')
  }

  const id = crypto.randomUUID().replaceAll('-', '')
  const expiry = Date.now() + duration * 1000
  const plan = JSON.stringify({ authorityRevision: authority.revision, target } satisfies SignedPlan)
  const mac = await crypto.subtle.sign('HMAC', key, signatureInput(scope, id, action, expiry, plan))
  const ticket = `v1.${id}.${Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, '0')).join('')}`
  await fs.ctx.reauthorize?.()
  fs.atomic(() => {
    authority.assertCurrent()
    const now = Date.now()
    if (now >= expiry) throw invalidTicket()
    checkPlan(fs, target)
    // Keep spent rows (without their plans) in the same issuance window. A
    // small or failed transfer cannot free a slot for unbounded staging.
    fs.sql.exec('DELETE FROM ov_edge_gateway_transfer WHERE account_id=? AND expires_at<=?', fs.account, now)
    const count = fs.sql.exec<{ account: number; user: number; actor: number }>(`SELECT count(*) AS account,
      coalesce(sum(user_id=?),0) AS user, coalesce(sum(user_id=? AND agent_id=?),0) AS actor
      FROM ov_edge_gateway_transfer WHERE account_id=?`, scope[1], scope[1], scope[2], fs.account).one()
    if (count.actor >= 16 || count.user >= 32 || count.account >= 128) {
      throw new GatewayError(429, 'transfer_ticket_limit', 'The transfer ticket quota is full; wait for tickets to expire.')
    }
    fs.sql.exec(`INSERT INTO ov_edge_gateway_transfer (account_id,user_id,agent_id,role,credential,managed,origin,id,action,expires_at,plan)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ...scope, id, ticketBucket(action), expiry, plan)
  })
  const subject = isAttachment(target) ? { attachment_id: target.attachmentId } : { uri: target.uri }
  return ok({ method: methods[action], ...subject, expires_at: new Date(expiry).toISOString(),
    ...(transport === 'header' ? { url: paths[action], ticket, ticket_header: transferTicketHeader } : { url: `${paths[action]}?token=${ticket}` }),
  }, 201)
}

async function redeem(request: Request, url: URL, fs: Filesystem, key: CryptoKey, scope: Scope, action: Action, authority: DataAuthority): Promise<Response> {
  const value = request.headers.get(transferTicketHeader)
  const query = url.searchParams.getAll('token')
  if ([...url.searchParams.keys()].some(name => name !== 'token') || query.length > 1 || (value !== null && query.length)) {
    throw invalid('Supply a single transfer ticket and no other query parameters.')
  }
  const parsed = ticketPattern.exec(value ?? query[0] ?? '')
  if (!parsed) throw invalidTicket()
  const [, id, hex] = parsed
  const lookup = [...scope, id, ticketBucket(action)] as const
  const row = fs.sql.exec<Stored>(`SELECT expires_at,plan FROM ov_edge_gateway_transfer
    WHERE ${matching} AND spent=0 AND expires_at>?`, ...lookup, Date.now()).toArray()[0]
  if (!row || !await crypto.subtle.verify('HMAC', key, unhex(hex), signatureInput(scope, id, action, row.expires_at, row.plan))) {
    throw invalidTicket()
  }
  // Only parse this record after authenticating our own stored issuance. A
  // pre-fence ticket cannot acquire a fresh lease; ask for a new ticket instead.
  const signed = JSON.parse(row.plan) as SignedPlan
  const revision = storedAuthority(signed.authorityRevision)
  if (!revision || !sameAuthority(revision, authority.revision) || !signed.target || actionForPlan(signed.target) !== action) throw invalidTicket()
  const plan = signed.target
  await fs.ctx.reauthorize?.()
  const authorityUntil = Math.min(row.expires_at, Date.now() + maxBodyTime)
  const active = () => {
    authority.assertCurrent()
    if (Date.now() >= row.expires_at) throw invalidTicket()
    if (Date.now() >= authorityUntil) throw new GatewayError(408, 'transfer_body_timeout', 'The transfer exceeded its processing deadline.')
  }
  // Bound live buffering/provider work even if callers request very short TTLs.
  const storage = fs.ctx.storage
  const running = uploading.get(storage) ?? 0
  if (action === 'upload' && running >= 8) throw new GatewayError(429, 'transfer_inflight_limit', 'Too many uploads are already in progress.')
  const admitted = fs.atomic(() => {
    active()
    // A concurrent request may have verified the same MAC while suspended.
    // The durable claim wins before any byte is read or sent to a provider.
    const won = fs.sql.exec(`UPDATE ov_edge_gateway_transfer SET spent=1,plan=''
      WHERE ${matching} AND spent=0 AND expires_at>? RETURNING id`, ...lookup, Date.now()).toArray()
    if (won.length !== 1) throw invalidTicket()
    // Attachment proofs are spent even when the signed object is missing,
    // expired, or has been restored to a new revision since issuance.
    if (isAttachment(plan)) return undefined
    checkLegacyPlan(fs, plan)
    // No await between the final ACL/revision check and reading attachment bytes.
    return plan.kind === 'download' ? download(fs, fs.path(plan.uri)) : undefined
  })
  if (admitted) return admitted
  if (plan.kind === 'attachment_read' || plan.kind === 'attachment_delete') {
    if (plan.kind === 'attachment_delete' && request.body !== null) throw invalid('Attachment deletion accepts no request body.')
    return fs.atomic(() => {
      active()
      if (plan.kind === 'attachment_read') return attachmentDownload(fs, plan)
      deleteAttachment(fs.sql, fs.caller, plan.attachmentId, plan.revision)
      return ok({ attachment_id: plan.attachmentId, deleted: true })
    })
  }
  if (plan.kind === 'download') throw invalidTicket()
  uploading.set(storage, running + 1)
  const timeout = deadline(authorityUntil - Date.now(), new GatewayError(408, 'transfer_body_timeout', 'The transfer exceeded its body deadline.'))
  const previousGuard = fs.ctx.assertActive
  fs.ctx.assertActive = () => { active(); checkPlan(fs, plan) }
  try {
    if (plan.kind === 'attachment_upload') {
      fs.ctx.assertActive()
      const bytes = await readAttachmentMultipart(request, plan.draft, timeout.signal)
      validateAttachmentBytes(plan.draft, bytes) // Validate before scheduling any persistent wake.
      const expiresAt = Date.now() + plan.retention * 1000
      await armGatewayAttachmentPurge(storage, expiresAt)
      await fs.ctx.reauthorize?.()
      return fs.atomic(() => {
        active()
        const info = insertGatewayAttachment(fs.sql, fs.caller, plan.attachmentId, { ...plan.draft, expiresAt }, bytes)
        return ok(wireAttachment(plan.attachmentId, info))
      })
    }
    const upload = await readMultipartUpload(request, undefined, timeout.signal)
    await fs.ctx.reauthorize?.()
    fs.ctx.assertActive()
    return await (plan.kind === 'resource' ? publishResourceTransfer(fs, plan, upload) : publishSkillTransfer(fs, plan, upload))
  } finally {
    fs.ctx.assertActive = previousGuard
    timeout.close()
    const left = (uploading.get(storage) ?? 1) - 1
    if (left) uploading.set(storage, left)
    else uploading.delete(storage)
  }
}

export async function routeGatewayTransfer(request: Request, url: URL, operation: TransferOperation, env: Env,
  context: WorkspaceContext, grant: AuthGrant): Promise<Response> {
  const key = await signingKey(env)
  if (request.method !== methods[operation]) throw methodError()
  if ((request.headers.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity') {
    throw new GatewayError(415, 'compressed_body_unsupported', 'Compressed bodies are not supported.')
  }
  const { accountId, userId, agentId, role } = context.caller
  const scope: Scope = [accountId, userId, agentId, role, grant.digest, Number(grant.managed), url.origin]
  const authority = await mountDataAuthority(context)
  const fs = new Filesystem(context)
  if (operation !== 'issue') return redeem(request, url, fs, key, scope, operation, authority)
  if (url.search || request.headers.has(transferTicketHeader)) throw invalid('Ticket issuance accepts only its JSON body.')
  return issue(request, fs, key, scope, authority)
}
