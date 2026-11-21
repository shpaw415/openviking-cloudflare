// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { SUBTREE_MAX_BYTES, SUBTREE_MAX_ENTRIES, type SubtreeEntry } from '../filesystem.js'
import { FILE_LIMIT, textFile, textSize } from '../fs/contract.js'
import { decoder, digest, encoder, internal, invalid, notImplemented, quota } from './common.js'
import { canonicalParts, inspectZip, memberBytes, storedZip, type Member } from './zip.js'

const KIND = 'openviking.ovpack'
const MANIFEST = '_ovpack/manifest.json'
const RECORDS = '_ovpack/index_records.jsonl'
const METADATA_BYTES = 384 * 1024
const SHA256 = /^[0-9a-fA-F]{64}$/

type FileDigest = { path: string; sha256: string; size: number }
type Root = { name: string; uri: string; scope: 'resources' | 'user'; user_id?: string }
type Payload = { root: Root; entries: SubtreeEntry[] }

export function contentParts(path: string): string[] {
  const parts = canonicalParts(path)
  if (parts.some(internal)) invalid('Reserved filesystem metadata is not portable.')
  return parts
}

export function sourceRoot(uri: string): Root {
  if (!uri.startsWith('viking://') || uri === 'viking://') return invalid('OVPack requires a resources or user source URI.')
  const parts = contentParts(uri.slice('viking://'.length).replace(/\/$/, ''))
  const name = parts.at(-1)!
  const canonical = `viking://${parts.join('/')}`
  if (parts[0] === 'resources') return { name, uri: canonical, scope: 'resources' }
  if (parts[0] === 'user' && parts.length >= 3 && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(parts[1]) &&
      ['resources', 'memories'].includes(parts[2])) return { name, uri: canonical, scope: 'user', user_id: parts[1] }
  return invalid('Only shared resources and unmanaged private resources/memories are portable.')
}

function canonicalDigest(value: unknown): string {
  return typeof value === 'string' && SHA256.test(value) ? value.toLowerCase() : invalid('Missing or invalid OVPack SHA-256 digest.')
}

function codePointOrder(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (delta) return delta
  }
  return x.length - y.length
}

function contentDigest(files: FileDigest[]): Promise<string> {
  // Same JSON field order, separators and Unicode order as Python v3.
  const json = JSON.stringify(files.sort((a, b) => codePointOrder(a.path, b.path)).map(({ path, sha256, size }) => ({ path, sha256, size })))
  return digest(encoder.encode(json))
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(decoder.decode(bytes)) } catch { return invalid('Invalid OVPack metadata JSON.') }
}

function member(members: Map<string, Member>, name: string): Member {
  const result = members.get(name)
  if (!result) return invalid('OVPack ZIP members do not match the manifest.')
  members.delete(name)
  return result
}

async function validateIndex(bytes: Uint8Array<ArrayBuffer>, records: Record<string, unknown>, expected: Map<string, SubtreeEntry>, root: Root) {
  if (records.path !== RECORDS || !Number.isSafeInteger(records.count) || (records.count as number) < 0 ||
      (records.count as number) > SUBTREE_MAX_ENTRIES * 3 || await digest(bytes) !== canonicalDigest(records.sha256)) {
    invalid('OVPack index record length, path or digest does not match.')
  }
  let content: string
  try { content = decoder.decode(bytes) } catch { return invalid('Invalid UTF-8 OVPack index metadata.') }
  const lines = content ? content.replace(/\r?\n$/, '').split(/\r?\n/) : []
  if (lines.length !== records.count) invalid('OVPack index record count does not match.')
  const unique = new Set<string>()
  for (const line of lines) {
    const parsed = parseJson(encoder.encode(line))
    if (!isRecord(parsed) || typeof parsed.record_id !== 'string' || !parsed.record_id || unique.has(parsed.record_id) ||
        typeof parsed.path !== 'string' || !expected.has(parsed.path) || !Number.isSafeInteger(parsed.level) ||
        parsed.kind !== (expected.get(parsed.path)!.is_dir ? 'directory' : 'file') ||
        (parsed.text != null && typeof parsed.text !== 'string') || (parsed.scalars != null && !isRecord(parsed.scalars)) ||
        (parsed.user_id != null && parsed.user_id !== root.user_id) || parsed.dense_ref != null) return invalid('Invalid OVPack index record.')
    unique.add(parsed.record_id)
    const scalar = isRecord(parsed.scalars) ? parsed.scalars.context_type : undefined
    const contextType = root.scope === 'user' && root.uri.slice('viking://'.length).split('/')[2] === 'memories' ? 'memory' : 'resource'
    if (scalar != null && scalar !== contextType) invalid('OVPack index context type does not match its source path.')
  }
}

export async function decodePack(bytes: Uint8Array<ArrayBuffer>): Promise<Payload> {
  const members = inspectZip(bytes)
  const [name] = members.keys().next().value!.split('/')
  const manifestMember = member(members, `${name}/${MANIFEST}`)
  const manifest = parseJson(await memberBytes(manifestMember, METADATA_BYTES))
  if (!isRecord(manifest) || manifest.kind !== KIND || manifest.format_version !== 3 || !isRecord(manifest.root) ||
      !Array.isArray(manifest.entries) || !isRecord(manifest.index)) return invalid('Expected a native OVPack v3 manifest.')
  if (manifest.root.package_type === 'backup') invalid('A backup OVPack cannot be imported as a resource package.')
  if (manifest.root.package_type != null || manifest.scopes != null) invalid('Unsupported OVPack package type.')
  if (typeof manifest.root.uri !== 'string') return invalid('Invalid OVPack root URI.')
  const root = sourceRoot(manifest.root.uri)
  if (name !== root.name || manifest.root.name !== name || manifest.root.scope !== root.scope ||
      (manifest.root.user_id != null && manifest.root.user_id !== root.user_id)) invalid('OVPack root does not match its ZIP namespace.')
  if (manifest.index.dense != null) notImplemented('This Worker accepts only portable OVPack packages without a dense vector snapshot.')
  if (!isRecord(manifest.index.records)) return invalid('OVPack index record metadata is missing.')
  if (manifest.entries.length > SUBTREE_MAX_ENTRIES) quota('OVPack subtree has too many entries.')
  for (const path of [`${name}/`, `${name}/_ovpack/`]) {
    const folder = members.get(path)
    if (folder) { await memberBytes(folder, 0); members.delete(path) }
  }
  const indexBytes = await memberBytes(member(members, `${name}/${RECORDS}`), METADATA_BYTES)
  const files: FileDigest[] = [], expected = new Map<string, SubtreeEntry>()
  let total = 0
  for (const entry of manifest.entries) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || (entry.kind !== 'file' && entry.kind !== 'directory') || expected.has(entry.path) ||
        (entry.user_id != null && entry.user_id !== root.user_id)) return invalid('Invalid or duplicate OVPack manifest entry.')
    const path = entry.path
    if (path) contentParts(path)
    const isDir = entry.kind === 'directory'
    if (!isDir && !path) invalid('An OVPack resource package must be rooted in a directory.')
    const memberName = `${name}/files/${path}${isDir && path ? '/' : ''}`
    const packed = member(members, memberName)
    const node: SubtreeEntry = { path, is_dir: isDir, description: '', tags: [] }
    if (isDir) {
      if ((entry.size != null && entry.size !== 0) || entry.sha256 != null) invalid('Invalid OVPack directory metadata.')
      await memberBytes(packed, 0)
    } else {
      textFile(path)
      if (entry.size !== packed.size) invalid('OVPack file size does not match the manifest.')
      total += packed.size
      if (total > SUBTREE_MAX_BYTES) quota('OVPack exceeds the total expanded content limit.')
      const raw = await memberBytes(packed, FILE_LIMIT)
      const sha256 = canonicalDigest(entry.sha256)
      if (await digest(raw) !== sha256) invalid('OVPack file SHA-256 does not match the manifest.')
      files.push({ path, size: raw.byteLength, sha256 })
      try { node.content = decoder.decode(raw) } catch { return invalid('OVPack file must contain UTF-8 text.') }
      textSize(node.content)
    }
    expected.set(path, node)
  }
  if (members.size || !expected.get('')?.is_dir) invalid('OVPack ZIP members do not match the manifest.')
  for (const path of expected.keys()) {
    if (path && !expected.get(path.slice(0, Math.max(0, path.lastIndexOf('/'))))?.is_dir) invalid('OVPack file has no declared parent directory.')
  }
  if (await contentDigest(files) !== canonicalDigest(manifest.content_sha256)) invalid('OVPack content SHA-256 does not match.')
  await validateIndex(indexBytes, manifest.index.records, expected, root)
  return { root, entries: [...expected.values()] }
}

export async function encodePack(root: Root, entries: SubtreeEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  const empty = new Uint8Array(0)
  const items = [{ name: `${root.name}/`, bytes: empty }, { name: `${root.name}/_ovpack/`, bytes: empty }]
  const files: FileDigest[] = [], manifestEntries: Record<string, unknown>[] = []
  for (const entry of entries) {
    const { path, is_dir: isDir } = entry
    if (path) contentParts(path)
    const raw = isDir ? empty : encoder.encode(entry.content!)
    const wire: Record<string, unknown> = { path, kind: isDir ? 'directory' : 'file', ...(root.user_id && { user_id: root.user_id }) }
    if (!isDir) {
      textFile(path)
      const sha256 = await digest(raw)
      files.push({ path, size: raw.byteLength, sha256 })
      wire.size = raw.byteLength
      wire.sha256 = sha256
    }
    manifestEntries.push(wire)
    items.push({ name: `${root.name}/files/${path}${isDir && path ? '/' : ''}`, bytes: raw })
  }
  const metadata = encoder.encode(JSON.stringify({ kind: KIND, format_version: 3, root, entries: manifestEntries,
    content_sha256: await contentDigest(files), index: { records: { path: RECORDS, count: 0, sha256: await digest(empty) } } }))
  if (metadata.byteLength > METADATA_BYTES) quota('OVPack manifest exceeds its byte limit.')
  items.push({ name: `${root.name}/${RECORDS}`, bytes: empty }, { name: `${root.name}/${MANIFEST}`, bytes: metadata })
  return storedZip(items)
}
