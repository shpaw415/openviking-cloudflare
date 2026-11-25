// SPDX-License-Identifier: AGPL-3.0-only
import { filename } from '../fs/contract.js'
import { decoder, encoder, invalid, quota } from './common.js'

export const ZIP_BYTES = 1_500_000 // Below the Durable Object SQLite per-row limit.
export const ZIP_ENTRIES = 261 // 256 entries in the tree plus container/metadata members.
const ZIP_EXPANDED_BYTES = 2 * 1024 * 1024 + 2 * 384 * 1024
type ZipLimits = { bytes: number; entries: number; expanded: number; storedOnly?: boolean }
const packLimits: ZipLimits = { bytes: ZIP_BYTES, entries: ZIP_ENTRIES, expanded: ZIP_EXPANDED_BYTES }
const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const UTF8 = 0x800

const crcTable = new Uint32Array(256)
for (let i = 0; i < crcTable.length; i++) {
  let c = i
  for (let bit = 0; bit < 8; bit++) c = (c & 1 ? 0xedb88320 : 0) ^ (c >>> 1)
  crcTable[i] = c
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function canonicalParts(raw: string): string[] {
  if (!raw || encoder.encode(raw).byteLength > 1400) return invalid('Invalid OVPack member path length.')
  const parts = raw.split('/')
  if (parts.length > 22 || parts.some(piece => filename(piece) !== piece)) return invalid('OVPack paths must be canonical.')
  return parts
}

function decodeName(bytes: Uint8Array, flags: number): string {
  if (!(flags & UTF8) && bytes.some(byte => byte > 0x7f)) invalid('Non-ASCII ZIP names must be marked UTF-8.')
  let name: string
  try { name = decoder.decode(bytes) } catch { return invalid('ZIP names must be UTF-8.') }
  canonicalParts(name.endsWith('/') ? name.slice(0, -1) : name)
  return name
}

type Bytes = Uint8Array<ArrayBuffer>
export type Member = { name: string; method: number; size: number; crc: number; compressed: Bytes }

/** Read a deliberately narrow ZIP32 container into bounded, inert members. Never extract to an OS path. */
export function inspectZip(bytes: Bytes, limits = packLimits): Map<string, Member> {
  if (bytes.byteLength > limits.bytes) quota('Archive ZIP body exceeds the byte limit.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (i: number) => view.getUint16(i, true)
  const u32 = (i: number) => view.getUint32(i, true)
  const end = bytes.byteLength - 22
  const malformed = (): never => invalid('Malformed or unsupported OVPack ZIP container.')
  if (end < 0 || u32(end) !== END || u16(end + 4) || u16(end + 6) || u16(end + 20)) return malformed()
  const files = u16(end + 10)
  if (!files || files !== u16(end + 8)) return malformed()
  if (files > limits.entries) quota('Archive contains too many ZIP members.')
  let central = u32(end + 16)
  const centralStart = central
  if (central >= end || central + u32(end + 12) !== end) return malformed()
  const members = new Map<string, Member>()
  const ranges: [number, number][] = []
  let expanded = 0
  for (let i = 0; i < files; i++) {
    if (central + 46 > end || u32(central) !== CENTRAL) return malformed()
    const flags = u16(central + 8), method = u16(central + 10), crc = u32(central + 16)
    const packed = u32(central + 20), size = u32(central + 24), length = u16(central + 28)
    const attrs = u32(central + 38), at = u32(central + 42)
    const mode = (attrs >>> 16) & 0xf000
    if (!length || length > 1401 || central + 46 + length > end || (flags & ~(UTF8 | (method === 8 ? 6 : 0))) ||
        (method !== 0 && (limits.storedOnly || method !== 8)) || (method === 0 && packed !== size) || u16(central + 6) > 20 ||
        u16(central + 30) || u16(central + 32) || u16(central + 34) || at + 30 + length > centralStart) return malformed()
    const raw = bytes.subarray(central + 46, central + 46 + length)
    const name = decodeName(raw, flags)
    const directory = name.endsWith('/')
    if (members.has(name) || (mode && mode !== (directory ? 0x4000 : 0x8000)) ||
        (attrs & 8) || (!directory && (attrs & 16)) || (directory && size)) return malformed()
    if (u32(at) !== LOCAL || u16(at + 4) > 20 || u16(at + 6) !== flags || u16(at + 8) !== method ||
        u32(at + 14) !== crc || u32(at + 18) !== packed || u32(at + 22) !== size ||
        u16(at + 26) !== length || u16(at + 28) !== 0 || raw.some((b, j) => b !== bytes[at + 30 + j])) return malformed()
    const start = at + 30 + length, finish = start + packed
    if (finish > centralStart) return malformed()
    expanded += size
    if (expanded > limits.expanded) quota('Archive exceeds the expanded byte limit.')
    ranges.push([at, finish]); members.set(name, { name, method, size, crc, compressed: bytes.subarray(start, finish) })
    central += 46 + length
  }
  let next = 0
  for (const [at, finish] of ranges.sort((a, b) => a[0] - b[0])) {
    if (at !== next) return malformed()
    next = finish
  }
  if (central !== end || next !== centralStart) return malformed()
  return members
}

export async function memberBytes(member: Member, limit: number): Promise<Bytes> {
  if (member.size > limit) quota('OVPack member exceeds its expanded byte limit.')
  if (member.method === 0) {
    if (crc32(member.compressed) !== member.crc) invalid('OVPack ZIP member CRC does not match.')
    return member.compressed
  }
  // Feed the native inflater in small chunks, including on inputs whose declared size is false.
  let at = 0
  const stream = new ReadableStream<Bytes>({ pull(controller) {
    if (at >= member.compressed.byteLength) { controller.close(); return }
    controller.enqueue(member.compressed.subarray(at, at += Math.min(1024, member.compressed.byteLength - at)))
  } })
  const reader = stream.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const bytes = new Uint8Array(member.size)
  let length = 0
  try {
    for (;;) {
      let block: ReadableStreamReadResult<Uint8Array>
      try { block = await reader.read() } catch { return invalid('Invalid compressed OVPack member.') }
      if (block.done) break
      if (length + block.value.byteLength > bytes.byteLength) {
        void reader.cancel().catch(() => {})
        return invalid('OVPack member expands beyond its declared size.')
      }
      bytes.set(block.value, length)
      length += block.value.byteLength
    }
  } finally { reader.releaseLock() }
  if (length !== bytes.byteLength || crc32(bytes) !== member.crc) invalid('OVPack ZIP data size or CRC does not match.')
  return bytes
}

export function storedZip(entries: readonly { name: string; bytes: Bytes }[], limits = packLimits): Bytes {
  const items = entries.map(entry => ({ ...entry, label: encoder.encode(entry.name) }))
  const localSize = items.reduce((sum, { label, bytes }) => sum + 30 + label.byteLength + bytes.byteLength, 0)
  const centralSize = items.reduce((sum, { label }) => sum + 46 + label.byteLength, 0)
  if (!items.length || items.length > limits.entries || localSize + centralSize + 22 > limits.bytes) quota('Archive export exceeds the ZIP size or entry limit.')
  const result = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(result.buffer)
  const u16 = (at: number, n: number) => view.setUint16(at, n, true)
  const u32 = (at: number, n: number) => view.setUint32(at, n, true)
  let l = 0, c = localSize
  for (const { name, label, bytes } of items) {
    const crc = crc32(bytes)
    const attrs = name.endsWith('/') ? ((0o40755 << 16) | 16) >>> 0 : (0o100644 << 16) >>> 0
    u32(l, LOCAL); u16(l + 4, 20); u16(l + 6, UTF8); u16(l + 12, 33)
    u32(l + 14, crc); u32(l + 18, bytes.byteLength); u32(l + 22, bytes.byteLength)
    u16(l + 26, label.byteLength)
    result.set(label, l + 30); result.set(bytes, l + 30 + label.byteLength)
    u32(c, CENTRAL); u16(c + 4, 0x314); u16(c + 6, 20); u16(c + 8, UTF8); u16(c + 14, 33)
    u32(c + 16, crc); u32(c + 20, bytes.byteLength); u32(c + 24, bytes.byteLength)
    u16(c + 28, label.byteLength); u32(c + 38, attrs); u32(c + 42, l); result.set(label, c + 46)
    l += 30 + label.byteLength + bytes.byteLength; c += 46 + label.byteLength
  }
  u32(c, END); u16(c + 8, items.length); u16(c + 10, items.length); u32(c + 12, centralSize); u32(c + 16, localSize)
  return result
}
