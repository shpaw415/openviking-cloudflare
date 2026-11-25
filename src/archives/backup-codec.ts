// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { FILE_LIMIT, ROOT, invalid, onlyKeys, parseTags, str, textFile, textSize, uriOf } from '../fs/contract.js'
import { SUBTREE_MAX_BYTES, SUBTREE_MAX_ENTRIES } from '../fs/subtree.js'
import { compare, decoder, digest, encoder, fail, internal, quota } from './common.js'
import { canonicalDigest, contentDigest, KIND, MANIFEST, member, METADATA_BYTES, RECORDS, type FileDigest } from './pack-codec.js'
import { canonicalParts, inspectZip, memberBytes, storedZip } from './zip.js'

export const backupRoot = { name: 'openviking-backup', uri: ROOT, scope: 'root', package_type: 'backup' } as const
export const backupScopes = ['resources', 'user'] as const
export const backupEntries = SUBTREE_MAX_ENTRIES
export const ownerId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/
const prefix = backupRoot.name + '/'
const empty = new Uint8Array(0)
export type BackupEntry = { path: string; directory: boolean; owner?: string; content?: string; description: string; tags: string[] }
export const topology = (message: string): never => fail(501, 'BACKUP_TOPOLOGY_UNSUPPORTED', message)
const indexUnsupported = (): never => fail(501, 'BACKUP_INDEX_UNSUPPORTED', 'Only portable descriptions and tags are supported in backup index records.')

export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')))
export const sortEntries = <T extends BackupEntry>(entries: T[]): T[] => entries.sort((a, b) => compare(a.path, b.path))
export const directoryEntry = (path: string, owner?: string): BackupEntry => ({ path, owner, directory: true, description: '', tags: [] })
export const excludedFile = (path: string) => path.split('/').at(-1) === '.relations.json' || /^resources\/\.watch_tasks\.json(?:\.bak|\.tmp)?$/.test(path)

export function portablePath(path: string, directory: boolean): { owner?: string; virtual: boolean } {
  if (!path) return { virtual: true }
  const parts = canonicalParts(path)
  uriOf(parts)
  canonicalParts(prefix + 'files/' + path)
  if (parts.some(internal) || excludedFile(path)) topology('Backup contains reserved storage metadata.')
  let virtual = parts.length === 1, owner: string | undefined
  if (parts[0] === 'user') {
    if (parts.length > 1) {
      owner = parts[1]
      if (!ownerId.test(owner)) topology('Backup owner cannot be represented in this workspace.')
    }
    if (parts.length >= 3 && parts[2] !== 'resources' && parts[2] !== 'memories') {
      topology('Backup contains a managed or unsupported user domain.')
    }
    virtual = parts.length <= 3
  } else if (parts[0] !== 'resources') topology('Backup contains a scope outside resources and user.')
  if (virtual && !directory) topology('Backup virtual roots must be directories.')
  if (!directory) {
    const name = parts.at(-1)!
    if (/\.(?:js|ts|py)$/i.test(name) || /^(?:skill\.md|credentials\.json|ov\.conf|\.env(?:\..*)?)$/i.test(name)) {
      topology('Backup contains a file type reserved for code or credentials.')
    }
    textFile(name)
  }
  return { owner, virtual }
}

function pathInZip(path: string, directory: boolean): string {
  return `${prefix}files/${path}${directory && path ? '/' : ''}`
}

// Parse bounded JSON without accepting duplicate (including escaped equivalent)
// property names. Workerd JSON.parse alone would silently apply last-key-wins.
export function strictJson(input: string, maxDepth = 8): unknown {
  const token = /[\x20\t\r\n]*(?:("(?:[^"\\\x00-\x1F]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")|([{}\[\]:,])|(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?))/y
  const whitespace = /[\x20\t\r\n]*/y
  let at = 0
  const bad = () => invalid('Invalid or ambiguous backup metadata JSON.')
  const read = () => {
    token.lastIndex = at
    const found = token.exec(input) ?? bad()
    at = token.lastIndex
    return [found[1], found[2]]
  }
  const peek = () => { whitespace.lastIndex = at; whitespace.exec(input); return input[whitespace.lastIndex] }
  const take = (want: string) => { if (read()[1] !== want) bad() }
  function value(depth: number): void {
    if (depth > maxDepth) bad()
    const [, punct] = read()
    if (punct === '{') {
      const keys = new Set<string>()
      if (peek() !== '}') for (;;) {
        const [quoted] = read()
        if (quoted === undefined) return bad()
        const key = JSON.parse(quoted) as string
        if (keys.has(key) || keys.size >= 32) bad()
        keys.add(key)
        take(':'); value(depth + 1)
        if (peek() !== ',') break
        take(',')
      }
      take('}')
    } else if (punct === '[') {
      let count = 0
      if (peek() !== ']') for (;;) {
        if (++count > backupEntries) quota('Backup metadata array exceeds its entry limit.')
        value(depth + 1)
        if (peek() !== ',') break
        take(',')
      }
      take(']')
    } else if (punct !== undefined) bad()
  }
  value(0)
  if (peek() !== undefined) bad()
  return JSON.parse(input)
}

function utf8(bytes: Uint8Array): string {
  try { return decoder.decode(bytes) } catch { return invalid('Backup members must be valid UTF-8.') }
}

function tree(entries: Map<string, BackupEntry>) {
  for (const mount of ['', ...backupScopes]) if (!entries.get(mount)?.directory) topology('Backup must contain both complete scope roots.')
  for (const path of entries.keys()) if (path && !entries.get(parentOf(path))?.directory) invalid('Backup entry has no declared directory parent.')
}

function scalars(value: Record<string, unknown>, entry: BackupEntry) {
  if (Object.keys(value).some(key => !['description', 'tags', 'context_type', 'level'].includes(key))) indexUnsupported()
  const context = entry.owner && entry.path.split('/')[2] === 'memories' ? 'memory' : 'resource'
  const level = entry.directory ? 0 : 2
  if ((Object.hasOwn(value, 'context_type') && value.context_type !== context) ||
      (Object.hasOwn(value, 'level') && value.level !== level)) invalid('Backup index context does not match the entry.')
  const description = str(value.description, 'Backup description', '', 512)
  if (/[\p{Cc}\p{Cf}]/u.test(description)) invalid('Backup description contains control characters.')
  const tags = parseTags(value.tags)
  if (Object.hasOwn(value, 'tags') && (!Array.isArray(value.tags) || JSON.stringify(tags) !== JSON.stringify(value.tags))) {
    invalid('Backup tags must match the canonical Edge tag representation.')
  }
  return { description, tags }
}

export async function encodeBackup(entries: BackupEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length > backupEntries) quota('Backup entry limit exceeded.')
  tree(new Map(entries.map(entry => [entry.path, entry])))
  const items = [{ name: prefix, bytes: empty }, { name: prefix + '_ovpack/', bytes: empty }]
  const files: FileDigest[] = [], metadata = [], records = []
  for (const entry of entries) {
    const { path, directory, owner, description, tags } = entry
    const kind = directory ? 'directory' : 'file'
    const bytes = directory ? empty : encoder.encode(entry.content!)
    const identifiers = owner ? { user_id: owner } : {}
    const size = bytes.byteLength
    if (directory) metadata.push({ path, kind, ...identifiers, ...(path && { size }) })
    else {
      const sha256 = await digest(bytes)
      files.push({ path, size, sha256 })
      metadata.push({ path, kind, size, sha256, ...identifiers })
    }
    if (description || tags.length) {
      scalars({ description, tags }, entry)
      records.push(JSON.stringify({ record_id: `r${records.length + 1}`, path, kind, level: directory ? 0 : 2,
        ...identifiers, scalars: { ...(description && { description }), ...(tags.length && { tags }) } }))
    }
    items.push({ name: pathInZip(path, directory), bytes })
  }
  const index = encoder.encode(records.length ? records.join('\n') + '\n' : '')
  const manifest = encoder.encode(JSON.stringify({ kind: KIND, format_version: 3, root: backupRoot, scopes: backupScopes,
    entries: metadata, content_sha256: await contentDigest(files),
    index: { records: { path: RECORDS, count: records.length, sha256: await digest(index) } } }))
  if (manifest.byteLength > METADATA_BYTES || index.byteLength > METADATA_BYTES) quota('Backup metadata exceeds its byte limit.')
  return storedZip([...items, { name: prefix + RECORDS, bytes: index }, { name: prefix + MANIFEST, bytes: manifest }])
}

export async function decodeBackup(bytes: Uint8Array<ArrayBuffer>): Promise<BackupEntry[]> {
  const members = inspectZip(bytes)
  const meta = strictJson(utf8(await memberBytes(member(members, prefix + MANIFEST), METADATA_BYTES)))
  if (!isRecord(meta) || meta.kind !== KIND || meta.format_version !== 3 || !isRecord(meta.root) ||
      meta.root.name !== backupRoot.name || meta.root.uri !== ROOT || meta.root.scope !== 'root' || meta.root.package_type !== 'backup' ||
      !Array.isArray(meta.entries) || !isRecord(meta.index) || !isRecord(meta.index.records)) invalid('Expected a native OVPack v3 backup.')
  onlyKeys(meta, 'kind format_version root scopes entries content_sha256 index')
  onlyKeys(meta.root, 'name uri scope package_type')
  const scopes = meta.scopes
  if (!Array.isArray(scopes) || scopes.length !== 2 || !backupScopes.every(scope => scopes.includes(scope))) {
    topology('Backup must declare resources and user, without any other scope.')
  }
  if (Object.hasOwn(meta.index, 'dense')) indexUnsupported()
  onlyKeys(meta.index, 'records')
  const records = meta.index.records
  onlyKeys(records, 'path count sha256')
  if (records.path !== RECORDS || typeof records.count !== 'number' || !Number.isSafeInteger(records.count) || records.count < 0 ||
      records.count > backupEntries || meta.entries.length > backupEntries) invalid('Invalid backup entry or index count.')
  for (const dir of [prefix, prefix + '_ovpack/']) if (members.has(dir)) await memberBytes(member(members, dir), 0)
  const index = await memberBytes(member(members, prefix + RECORDS), METADATA_BYTES)
  if (await digest(index) !== canonicalDigest(records.sha256)) invalid('Backup index SHA-256 does not match.')
  let total = 0
  const entries = new Map<string, BackupEntry>(), files: FileDigest[] = []
  for (const raw of meta.entries) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || entries.has(raw.path) || (raw.kind !== 'directory' && raw.kind !== 'file')) {
      invalid('Invalid or duplicate backup entry.')
    }
    const path = raw.path, directory = raw.kind === 'directory'
    const { owner } = portablePath(path, directory)
    onlyKeys(raw, directory ? 'path kind user_id size' : 'path kind user_id size sha256')
    if (raw.user_id !== owner) invalid('Backup user_id must match the explicit owner path.')
    const packed = member(members, pathInZip(path, directory))
    const entry = { ...directoryEntry(path, owner), directory }
    if (directory) {
      if (raw.size !== undefined && raw.size !== 0) invalid('Invalid backup directory size.')
      await memberBytes(packed, 0)
    } else {
      const size = packed.size, sha256 = canonicalDigest(raw.sha256)
      if (raw.size !== size) invalid('Backup file size does not match.')
      if ((total += size) > SUBTREE_MAX_BYTES) quota('Backup expanded content limit exceeded.')
      const body = await memberBytes(packed, FILE_LIMIT)
      if (await digest(body) !== sha256) invalid('Backup file SHA-256 does not match.')
      entry.content = utf8(body)
      if (textSize(entry.content) !== size) invalid('Backup file is not round-trippable as UTF-8.')
      files.push({ path, size, sha256 })
    }
    entries.set(path, entry)
  }
  if (members.size || await contentDigest(files) !== canonicalDigest(meta.content_sha256)) invalid('Backup content or ZIP inventory does not match.')
  tree(entries)
  const lines = index.length ? utf8(index).replace(/\r?\n$/, '').split(/\r?\n/) : []
  if (lines.length !== records.count) invalid('Backup index record count does not match.')
  const seenIds = new Set<string>(), seenPaths = new Set<string>()
  for (const line of lines) {
    const record = strictJson(line)
    if (!isRecord(record) || typeof record.path !== 'string' || typeof record.record_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,48}$/.test(record.record_id) || seenIds.has(record.record_id) || seenPaths.has(record.path)) {
      invalid('Invalid or duplicate backup index record.')
    }
    if (Object.hasOwn(record, 'vector') || Object.hasOwn(record, 'text')) indexUnsupported()
    onlyKeys(record, 'record_id path kind level user_id scalars')
    const entry = entries.get(record.path)
    if (!entry || record.user_id !== entry.owner || record.kind !== (entry.directory ? 'directory' : 'file') ||
        record.level !== (entry.directory ? 0 : 2) || portablePath(entry.path, entry.directory).virtual || !isRecord(record.scalars)) {
      invalid('Backup index record does not match an admissible entry.')
    }
    Object.assign(entry, scalars(record.scalars, entry))
    seenIds.add(record.record_id); seenPaths.add(record.path)
  }
  return sortEntries([...entries.values()])
}
