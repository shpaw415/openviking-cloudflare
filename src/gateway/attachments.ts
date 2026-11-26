// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller } from '../context.js'
import { filename } from '../fs/contract.js'
import { ApiError } from '../http.js'
import { ensureAlarm } from '../tasks.js'
import { decodePlainDocument } from './media.js'

export const maxAttachmentBytes = 1024 * 1024 // Below the SQLite row limit, including metadata.
export const maxAttachmentRetention = 7 * 86_400
export const maxAttachmentsPerAgent = 16
export const attachmentTable = 'ov_edge_gateway_attachment'
export type AttachmentOwner = Pick<Caller, 'accountId' | 'userId' | 'agentId'>
export type AttachmentDraft = { filename: string; contentType: string; size: number }
export type AttachmentInfo = AttachmentDraft & { expiresAt: number; revision: string }
export type Attachment = AttachmentInfo & { bytes: ArrayBuffer }
export type AttachmentSnapshot = AttachmentDraft & { id: string; userId: string; agentId: string; expiresAt: number; bytes: ArrayBuffer }

type Format = { extensions: readonly string[]; matches: (bytes: Uint8Array) => boolean }
const ascii = (bytes: Uint8Array, text: string, offset = 0) =>
  bytes.length >= offset + text.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
const prefix = (bytes: Uint8Array, ...signature: number[]) => signature.every((byte, i) => bytes[i] === byte)
// A shallow format admission check, not a decoder, safety scan or decompressor.
const formats = new Map<string, Format>([
  ['text/plain', { extensions: ['txt'], matches: b => decodePlainDocument(b) !== undefined }],
  ['image/png', { extensions: ['png'], matches: b => prefix(b, 137, 80, 78, 71, 13, 10, 26, 10) }],
  ['image/jpeg', { extensions: ['jpg', 'jpeg'], matches: b => prefix(b, 255, 216, 255) }],
  ['image/gif', { extensions: ['gif'], matches: b => ascii(b, 'GIF87a') || ascii(b, 'GIF89a') }],
  ['image/webp', { extensions: ['webp'], matches: b => ascii(b, 'RIFF') && ascii(b, 'WEBP', 8) }],
  ['audio/wav', { extensions: ['wav'], matches: b => ascii(b, 'RIFF') && ascii(b, 'WAVE', 8) }],
  ['audio/mpeg', { extensions: ['mp3'], matches: b => (b.length >= 10 && ascii(b, 'ID3') && b[3] >= 2 && b[3] <= 4) ||
    (b.length >= 4 && b[0] === 255 && (b[1] & 0xe6) === 0xe2 && (b[1] & 0x18) !== 0x08 &&
      (b[2] & 0xf0) !== 0xf0 && (b[2] & 0x0c) !== 0x0c) }],
  ['audio/flac', { extensions: ['flac'], matches: b => ascii(b, 'fLaC') }],
  ['application/pdf', { extensions: ['pdf'], matches: b => b.length >= 8 && ascii(b, '%PDF-') &&
    (b[5] === 49 || b[5] === 50) && b[6] === 46 && b[7] >= 48 && b[7] <= 57 }],
  ['application/zip', { extensions: ['zip'], matches: b => (b.length >= 30 && prefix(b, 80, 75, 3, 4)) ||
    (b.length >= 22 && prefix(b, 80, 75, 5, 6)) }],
  ['application/gzip', { extensions: ['gz', 'tgz'], matches: b => b.length >= 18 && prefix(b, 31, 139, 8) && !(b[3] & 0xe0) }],
])

const invalid = (detail: string) => new ApiError(400, 'INVALID_ARGUMENT', detail)
const sizeLimit = () => new ApiError(413, 'RESOURCE_EXHAUSTED', 'Attachment size exceeds its limit.')
const wrongFormat = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Attachment type, filename extension or byte signature is unsupported.')
const missing = () => new ApiError(404, 'attachment_not_found', 'Attachment not found or expired.')
const changed = () => new ApiError(409, 'transfer_revision_changed', 'The signed attachment revision changed. Request a new ticket.')
const scope = ({ accountId, userId, agentId }: AttachmentOwner) => [accountId, userId, agentId] as const
const owned = 'account_id=? AND user_id=? AND agent_id=? AND id=? AND expires_at>?'
const metadata = 'filename, content_type AS contentType, size, expires_at AS expiresAt, revision'

export function gatewayAttachmentId(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^att_[a-f0-9]{32}$/u.test(value)) throw invalid('Invalid attachment_id.')
  return value
}

export function validateAttachmentDraft(rawName: unknown, contentType: unknown, size: unknown): AttachmentDraft {
  const name = filename(rawName)
  if (name.startsWith('.') || /[<>"|*]/u.test(name)) throw invalid('Expected a safe attachment filename.')
  const format = typeof contentType === 'string' ? formats.get(contentType) : undefined
  if (!format || !format.extensions.includes(name.split('.').slice(1).at(-1)?.toLowerCase() ?? '')) throw wrongFormat()
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) throw invalid('Expected the exact positive attachment size in bytes.')
  if (size > maxAttachmentBytes) throw sizeLimit()
  return { filename: name, contentType: contentType as string, size }
}

export function validateAttachmentBytes(draft: AttachmentDraft, bytes: ArrayBuffer): void {
  if (!(bytes instanceof ArrayBuffer)) throw invalid('Expected attachment bytes.')
  if (bytes.byteLength > maxAttachmentBytes) throw sizeLimit()
  if (bytes.byteLength !== draft.size) throw invalid('The attachment size does not match the signed size.')
  if (!formats.get(draft.contentType)?.matches(new Uint8Array(bytes))) throw wrongFormat()
}

export function initGatewayAttachments(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_gateway_attachment (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    id TEXT NOT NULL, revision TEXT NOT NULL, filename TEXT NOT NULL, content_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size BETWEEN 1 AND ${maxAttachmentBytes}), expires_at INTEGER NOT NULL,
    body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body)=size), PRIMARY KEY (account_id,id)
  ) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_gateway_attachment_expiry ON ov_edge_gateway_attachment (expires_at)')
  sql.exec(`CREATE INDEX IF NOT EXISTS ov_edge_gateway_attachment_quota
    ON ov_edge_gateway_attachment (account_id,user_id,agent_id,expires_at,size)`)
}

export function assertAttachmentCapacity(sql: SqlStorage, owner: AttachmentOwner, bytes: number, now = Date.now()): void {
  const row = sql.exec<{ tenant: number; actor: number; member: number; total: number; userBytes: number }>(`SELECT
    count(*) AS tenant, count(*) FILTER(WHERE user_id=? AND agent_id=?) AS actor,
    count(*) FILTER(WHERE user_id=?) AS member, coalesce(sum(size),0) AS total,
    coalesce(sum(size) FILTER(WHERE user_id=?),0) AS userBytes
    FROM ov_edge_gateway_attachment WHERE account_id=? AND expires_at>?`,
    owner.userId, owner.agentId, owner.userId, owner.userId, owner.accountId, now).one()
  if (row.actor >= maxAttachmentsPerAgent || row.member >= 32 || row.tenant >= 128 ||
      row.userBytes + bytes > 8 * maxAttachmentBytes || row.total + bytes > 32 * maxAttachmentBytes) {
    throw new ApiError(429, 'attachment_quota', 'Attachment quota is full; delete an attachment or wait for expiry.')
  }
}

export function attachmentInfo(sql: SqlStorage, owner: AttachmentOwner, id: string, expected?: string): AttachmentInfo {
  const row = sql.exec<AttachmentInfo>(`SELECT ${metadata} FROM ov_edge_gateway_attachment WHERE ${owned}`,
    ...scope(owner), id, Date.now()).toArray()[0]
  if (!row) throw missing()
  if (expected !== undefined && row.revision !== expected) throw changed()
  return row
}

export function readAttachment(sql: SqlStorage, owner: AttachmentOwner, id: string, expected?: string): Attachment {
  // Check ownership, expiry and revision before loading the BLOB. No suspension point.
  const info = attachmentInfo(sql, owner, id, expected)
  const { body } = sql.exec<{ body: ArrayBuffer }>('SELECT body FROM ov_edge_gateway_attachment WHERE account_id=? AND id=?',
    owner.accountId, id).one()
  return { ...info, bytes: body }
}

/** Backup-only projection, called inside the named Workspace's snapshot transaction.
 * Expired rows are already invisible to their owners. Prove the entire live
 * scope and quota before reading a BLOB. Neither tickets nor revisions are read. */
export function snapshotGatewayAttachments(sql: SqlStorage, account: string, owns: (user: string, agent: string) => boolean,
  countLimit: number, byteLimit: number, now: number): AttachmentSnapshot[] {
  if (sql.exec(`SELECT 1 FROM ${attachmentTable} WHERE account_id!=? AND expires_at>? LIMIT 1`, account, now).toArray().length) {
    throw new ApiError(409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE', 'A live attachment is outside its workspace scope.')
  }
  const rows = sql.exec<Omit<AttachmentSnapshot, 'bytes'>>(`SELECT id,user_id AS userId,agent_id AS agentId,filename,
    content_type AS contentType,size,expires_at AS expiresAt FROM ${attachmentTable}
    WHERE account_id=? AND expires_at>? ORDER BY id LIMIT ?`, account, now, countLimit + 1).toArray()
  if (rows.length > countLimit) throw sizeLimit()
  let total = 0
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!owns(row.userId, row.agentId)) throw new ApiError(409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE', 'An attachment owner is not a provisioned seat.')
    gatewayAttachmentId(row.id)
    if (validateAttachmentDraft(row.filename, row.contentType, row.size).filename !== row.filename ||
        !Number.isSafeInteger(row.expiresAt) || row.expiresAt > now + maxAttachmentRetention * 1000) throw invalid('Nonportable attachment metadata.')
    const seat = JSON.stringify([row.userId, row.agentId]), n = (counts.get(seat) ?? 0) + 1
    if ((total += row.size) > byteLimit || n > maxAttachmentsPerAgent) throw sizeLimit()
    counts.set(seat, n)
  }
  return rows.map(row => {
    const { body } = sql.exec<{ body: ArrayBuffer }>(`SELECT body FROM ${attachmentTable} WHERE ${owned}`,
      account, row.userId, row.agentId, row.id, now).one()
    validateAttachmentBytes(row, body)
    return { ...row, bytes: body }
  })
}

/** Private storage primitive. Call only on the admitted owner's Workspace and
 * inside its transactionSync, after arming the absolute deadline. No upsert. */
export function insertGatewayAttachment(sql: SqlStorage, owner: AttachmentOwner, id: string,
  unvalidated: AttachmentDraft & { expiresAt: number }, bytes: ArrayBuffer): AttachmentInfo {
  const now = Date.now(), { expiresAt } = unvalidated
  gatewayAttachmentId(id)
  if (!scope(owner).every(part => typeof part === 'string' && part.length >= 1 && part.length <= 48 && !/[^A-Za-z0-9_-]/u.test(part))) {
    throw invalid('Invalid attachment owner scope.')
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + maxAttachmentRetention * 1000) {
    throw invalid('Attachment expiry must be an absolute future timestamp within the retention limit.')
  }
  const draft = validateAttachmentDraft(unvalidated.filename, unvalidated.contentType, unvalidated.size)
  validateAttachmentBytes(draft, bytes)
  assertAttachmentCapacity(sql, owner, draft.size, now)
  const revision = crypto.randomUUID()
  sql.exec('DELETE FROM ov_edge_gateway_attachment WHERE expires_at<=?', now)
  const inserted = sql.exec(`INSERT INTO ov_edge_gateway_attachment
    (account_id,user_id,agent_id,id,revision,filename,content_type,size,expires_at,body) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_id,id) DO NOTHING RETURNING id`, ...scope(owner), id, revision,
    draft.filename, draft.contentType, draft.size, expiresAt, bytes).toArray()
  if (inserted.length !== 1) throw changed()
  return { ...draft, expiresAt, revision }
}

export function deleteAttachment(sql: SqlStorage, owner: AttachmentOwner, id: string, revision: string): void {
  attachmentInfo(sql, owner, id, revision)
  const removed = sql.exec(`DELETE FROM ov_edge_gateway_attachment WHERE ${owned} AND revision=? RETURNING id`,
    ...scope(owner), id, Date.now(), revision).toArray()
  if (removed.length !== 1) throw missing()
}

/** Arm before inserting. A future private restore arms the earliest absolute expiry in its batch. */
export function armGatewayAttachmentPurge(storage: DurableObjectStorage, expiresAt: number): Promise<void> {
  return ensureAlarm(storage, expiresAt)
}

export async function sweepGatewayAttachments(storage: DurableObjectStorage, restoredAccount?: string): Promise<void> {
  const next = storage.transactionSync(() => {
    const sql = storage.sql
    if (restoredAccount !== undefined) {
      // The standby owner is the named receipt, not an ambient principal. Do
      // not initialize storage or sweep other account rows on this path.
      sql.exec(`DELETE FROM ${attachmentTable} WHERE account_id=? AND expires_at<=?`, restoredAccount, Date.now())
      return sql.exec<{ next: number | null }>(`SELECT min(expires_at) AS next FROM ${attachmentTable} WHERE account_id=?`, restoredAccount).one().next
    }
    initGatewayAttachments(sql)
    sql.exec('DELETE FROM ov_edge_gateway_attachment WHERE expires_at<=?', Date.now())
    return sql.exec<{ next: number | null }>('SELECT min(expires_at) AS next FROM ov_edge_gateway_attachment').one().next
  })
  if (next !== null) await armGatewayAttachmentPurge(storage, next)
}
