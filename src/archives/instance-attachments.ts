// SPDX-License-Identifier: AGPL-3.0-only
import { attachmentTable, gatewayAttachmentId, initGatewayAttachments, insertGatewayAttachment, maxAttachmentBytes, maxAttachmentRetention,
  maxAttachmentsPerAgent, snapshotGatewayAttachments, validateAttachmentBytes, validateAttachmentDraft } from '../gateway/attachments.js'
import type { AttachmentSnapshot } from '../gateway/attachments.js'
import { isRecord } from '../http.js'
import { strictJson } from './backup-codec.js'
import { hasTable } from './backup-domain.js'
import { decoder, digest, encoder, fail, invalid, quota } from './common.js'
import { inspectZip, memberBytes, storedZip, ZIP_BYTES } from './zip.js'

const maxCount = 32, maxBytes = 2 * maxAttachmentBytes, jsonBytes = 24 * 1024
export const attachmentCountLimit = maxCount
const edgePath = 'workspace.edge.zip', jsonPath = 'attachments.json'
const limits = { bytes: ZIP_BYTES + maxBytes + jsonBytes + 8192, entries: maxCount + 2,
  expanded: ZIP_BYTES + maxBytes + jsonBytes, storedOnly: true }
export const attachmentArchiveBytes = limits.bytes
export const attachmentsExpired = (): never => fail(409, 'INSTANCE_BACKUP_ATTACHMENT_EXPIRED', 'A packaged attachment has expired; this recovery cannot be released.')
const badInventory = (): never => invalid('Invalid instance attachment inventory.')
export type AttachmentSeats = { account: string; owns: (user: string, agent: string) => boolean }
type Bytes = Uint8Array<ArrayBuffer>
export const attachmentPath = (id: string) => `attachments/${id}.bin`

export function captureAttachments(sql: SqlStorage, seats: AttachmentSeats) {
  if (!hasTable(sql, attachmentTable)) return []
  return snapshotGatewayAttachments(sql, seats.account, seats.owns, maxCount, maxBytes, Date.now())
}

export async function wrapAttachments(edge: Bytes, items: AttachmentSnapshot[]) {
  const records = await Promise.all(items.map(async item => ({ id: item.id, user_id: item.userId, agent_id: item.agentId,
    filename: item.filename, content_type: item.contentType, size: item.size, expires_at: item.expiresAt,
    sha256: await digest(new Uint8Array(item.bytes)) })))
  const data = encoder.encode(JSON.stringify(records))
  if (data.length > jsonBytes) quota('Attachment inventory exceeds its byte limit.')
  return storedZip([{ name: edgePath, bytes: edge }, { name: jsonPath, bytes: data },
    ...items.map(({ id, bytes }) => ({ name: attachmentPath(id), bytes: new Uint8Array(bytes) }))], limits)
}

export async function unwrapAttachments(zip: Bytes, seats: AttachmentSeats) {
  const members = inspectZip(zip, limits), edge = members.get(edgePath), inventory = members.get(jsonPath)
  if (!edge || !inventory) return badInventory()
  let text: string
  try { text = decoder.decode(await memberBytes(inventory, jsonBytes)) } catch { return badInventory() }
  const records = strictJson(text, 4)
  if (!Array.isArray(records) || records.length > maxCount || members.size !== records.length + 2) return badInventory()
  let total = 0, previous = ''
  const now = Date.now(), counts = new Map<string, number>()
  const descriptors = records.map((raw: unknown) => {
    if (!isRecord(raw) || Object.keys(raw).length !== 8 || typeof raw.user_id !== 'string' || typeof raw.agent_id !== 'string' ||
        typeof raw.sha256 !== 'string' || raw.sha256.length !== 64 || /[^a-f0-9]/u.test(raw.sha256) ||
        typeof raw.expires_at !== 'number' || !Number.isSafeInteger(raw.expires_at) || raw.expires_at > now + maxAttachmentRetention * 1000) return badInventory()
    if (!seats.owns(raw.user_id, raw.agent_id)) return fail(409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE', 'An attachment owner is not a provisioned seat.')
    if (raw.expires_at <= now) return attachmentsExpired()
    const id = gatewayAttachmentId(raw.id), member = members.get(attachmentPath(id))
    const info = validateAttachmentDraft(raw.filename, raw.content_type, raw.size)
    if (id <= previous || !member || member.size !== info.size || raw.filename !== info.filename) return badInventory()
    previous = id
    const seat = JSON.stringify([raw.user_id, raw.agent_id]), n = (counts.get(seat) ?? 0) + 1
    if ((total += info.size) > maxBytes || n > maxAttachmentsPerAgent) quota('Attachment backup quota exceeded.')
    counts.set(seat, n)
    return { id, member, info, userId: raw.user_id, agentId: raw.agent_id, expiresAt: raw.expires_at, sha256: raw.sha256 }
  })
  const items: AttachmentSnapshot[] = []
  for (const { id, member, info, userId, agentId, expiresAt, sha256 } of descriptors) {
    const bytes = await memberBytes(member, maxAttachmentBytes)
    if (await digest(bytes) !== sha256) return badInventory()
    const body = bytes.slice().buffer
    validateAttachmentBytes(info, body)
    items.push({ id, ...info, userId, agentId, expiresAt, bytes: body })
  }
  return { edge: await memberBytes(edge, ZIP_BYTES), items,
    deadline: items.length ? Math.min(...items.map(item => item.expiresAt)) : null }
}

/** Caller has verified the archive, the exact roster and a cold Workspace.
 * Must share the restore transaction with all domains and the receipt. */
export function publishAttachments(sql: SqlStorage, seats: AttachmentSeats, items: AttachmentSnapshot[]) {
  if (!items.length) return
  initGatewayAttachments(sql)
  for (const item of items) {
    if (!seats.owns(item.userId, item.agentId)) return fail(409, 'INSTANCE_BACKUP_ATTACHMENT_SCOPE', 'An attachment owner is not a provisioned seat.')
    if (item.expiresAt <= Date.now()) return attachmentsExpired()
    insertGatewayAttachment(sql, { accountId: seats.account, userId: item.userId, agentId: item.agentId }, item.id, item, item.bytes)
  }
}
