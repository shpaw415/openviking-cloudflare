// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { aclSeal } from './backup-acl.js'
import type { Scope } from './backup-authority.js'
import { strictJson } from './backup-codec.js'
import { decoder, digest, encoder, invalid } from './common.js'
import { hashId, INSTANCE_ACCOUNTS, instanceId, rosterTag, signInstance, unsupported, verifyInstance, withAttachments } from './instance-authority.js'
import type { Endpoint, InstanceProfile, Mount } from './instance-authority.js'
import { attachmentArchiveBytes } from './instance-attachments.js'
import type { Env } from '../context.js'
import { inspectZip, memberBytes, storedZip, ZIP_BYTES } from './zip.js'

export const instanceFilename = 'openviking-instance-backup.zip'
const kind = 'openviking.instance-backup'
const manifestLimit = 64 * 1024
const settingsLimit = 16 * 1024
const manifestPath = 'inventory.json', settingsPath = 'configuration.json', sealPath = 'inventory.hmac'
const limits = (perAccount: number) => ({ bytes: INSTANCE_ACCOUNTS * perAccount + manifestLimit + settingsLimit + 8192,
  entries: INSTANCE_ACCOUNTS + 3, expanded: INSTANCE_ACCOUNTS * perAccount + manifestLimit + settingsLimit + 64, storedOnly: true })
const legacyLimits = limits(ZIP_BYTES), attachmentLimits = limits(attachmentArchiveBytes)
export const memberLimit = (profile: InstanceProfile) => profile === withAttachments ? attachmentArchiveBytes : ZIP_BYTES
export const instanceBytes = attachmentLimits.bytes
export const zipInput = (value: unknown) => {
  if (!(value instanceof ArrayBuffer) || !value.byteLength || value.byteLength > instanceBytes) return invalid('A bounded instance ZIP is required.')
  return new Uint8Array(value)
}
type Bytes = Uint8Array<ArrayBuffer>
type Descriptor = { path: string; size: number; sha256: string }
export type Member = { account_id: string; workspace: string; roster: string; seal: string; bytes: Bytes }
const memberPath = (account: string) => `accounts/${account}.zip`
const descriptor = async (path: string, bytes: Bytes): Promise<Descriptor> => ({ path, size: bytes.byteLength, sha256: await digest(bytes) })

export async function encodeInstance(m: Mount, capture: string, settings: unknown, members: Member[], profile: InstanceProfile) {
  const config = encoder.encode(JSON.stringify(settings))
  if (config.length > settingsLimit) return unsupported()
  const accounts = await Promise.all(members.map(async ({ account_id, workspace, roster, seal, bytes }) => ({
    account_id, workspace, roster, seal, ...await descriptor(memberPath(account_id), bytes),
  })))
  const data = encoder.encode(JSON.stringify({ kind, format_version: profile === withAttachments ? 2 : 1, profile, capture,
    source: m.source, destination: m.destination, configuration: await descriptor(settingsPath, config), accounts }))
  if (data.length > manifestLimit) return unsupported()
  const signature = await signInstance(m, 'inventory', await digest(data))
  return storedZip([{ name: manifestPath, bytes: data }, { name: sealPath, bytes: encoder.encode(signature) },
    { name: settingsPath, bytes: config }, ...members.map(({ account_id, bytes }) => ({ name: memberPath(account_id), bytes }))],
    profile === withAttachments ? attachmentLimits : legacyLimits)
}

function json(bytes: Bytes) { return strictJson(decoder.decode(bytes), 10) }
function sameEndpoint(raw: unknown, expected: Endpoint): boolean {
  return isRecord(raw) && Object.keys(raw).length === 2 && raw.id === expected.id && raw.control === expected.control
}

export async function decodeInstance(env: Env, m: Mount, scopes: Scope[], bytes: Bytes) {
  const members = inspectZip(bytes, attachmentLimits)
  if (members.size !== scopes.length + 3) return unsupported()
  async function read(path: string, limit: number) {
    const member = members.get(path)
    if (!member) return unsupported()
    return memberBytes(member, limit)
  }
  const data = await read(manifestPath, manifestLimit), job = await digest(data)
  const mac = decoder.decode(await read(sealPath, 64))
  if (!hashId(mac) || !await verifyInstance(m, 'inventory', mac, job)) return unsupported()
  const meta = json(data)
  if (!isRecord(meta) || Object.keys(meta).length !== 8 || meta.kind !== kind ||
      !instanceId(meta.capture) || !sameEndpoint(meta.source, m.source) || !sameEndpoint(meta.destination, m.destination) ||
      !Array.isArray(meta.accounts) || meta.accounts.length !== scopes.length) return unsupported()
  const { profile } = meta
  if (!((profile === 'edge-v1' && meta.format_version === 1 && bytes.byteLength <= legacyLimits.bytes) ||
        (profile === withAttachments && meta.format_version === 2))) return unsupported()
  const sourceMounts = new Set<string>()
  async function checked(raw: Record<string, unknown>, path: string, max: number) {
    if (raw.path !== path || !hashId(raw.sha256) || !Number.isSafeInteger(raw.size) || raw.size === 0) return unsupported()
    const bytes = await read(path, max)
    if (raw.size !== bytes.length || raw.sha256 !== await digest(bytes)) return unsupported()
    return { bytes, sha256: raw.sha256 }
  }
  if (!isRecord(meta.configuration) || Object.keys(meta.configuration).length !== 3) return unsupported()
  const settings = json((await checked(meta.configuration, settingsPath, settingsLimit)).bytes)
  const accounts = []
  for (const [i, scope] of scopes.entries()) {
    const raw: unknown = meta.accounts[i]
    if (!isRecord(raw) || Object.keys(raw).length !== 7 || raw.account_id !== scope.account || !hashId(raw.workspace) ||
        sourceMounts.has(raw.workspace) || raw.workspace === env.WORKSPACES.idFromName(`openviking:account:${scope.account}`).toString() ||
        raw.roster !== await rosterTag(env, m, scope) || typeof raw.seal !== 'string') return unsupported()
    sourceMounts.add(raw.workspace)
    aclSeal(raw.seal, scope.users.length)
    accounts.push({ account: scope.account, seal: raw.seal, ...await checked(raw, memberPath(scope.account), memberLimit(profile)) })
  }
  return { capture: meta.capture, job, settings, accounts, profile }
}
