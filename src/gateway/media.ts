// SPDX-License-Identifier: AGPL-3.0-only
import { GatewayError, fields, integer, invalid, record, unsupported } from './contract.js'
import type { Protocol } from './contract.js'

export type Capability = 'image' | 'audio' | 'tools'
type Detail = 'auto' | 'low' | 'high'
export type ChatPart = { type: 'text'; text: string } |
  { type: 'image_url'; image_url: { url: string; detail?: Detail } } |
  { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }
type AttachmentPart = { type: 'attachment'; id: string; kind: 'image' | 'audio'; detail?: Detail }
export type MediaPart = ChatPart | AttachmentPart
export type ReadGatewayAttachment = (id: string) => Promise<{
  filename: string; contentType: string; size: number; expiresAt: number; bytes: ArrayBuffer; assertCurrent(): void
} | null | undefined>

const invalidMedia = () => invalid('Expected valid, bounded inline image or audio bytes.', 'media_invalid')
const unsupportedMedia = () => unsupported('This model or protocol does not admit this inline media form.', 'non_text_input_unsupported')
const limited = () => new GatewayError(413, 'media_limit', 'Inline media exceeds the block or turn budget.')
const blockLimit = 64 * 1024, totalLimit = 128 * 1024
const b64Limit = Math.ceil(blockLimit / 3) * 4
const dimensions = (width: number, height: number) => integer(width, 1, 2048) && integer(height, 1, 2048)
const tag = (data: string, start: number, value: string) => data.startsWith(value, start)

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  for (let i = 0; i < 8; i++) index = (index >>> 1) ^ (index & 1 ? 0xedb88320 : 0)
  return index
})

function png(raw: string, data: DataView): boolean {
  if (!tag(raw, 0, '\x89PNG\r\n\x1a\n') || data.byteLength < 57) return false
  let offset = 8, count = 0, idat = false, palette = false, color = -1
  while (offset + 12 <= data.byteLength && ++count <= 128) {
    const size = data.getUint32(offset), type = raw.slice(offset + 4, offset + 8), start = offset + 8, end = start + size
    if (end + 4 > data.byteLength) return false
    let crc = 0xffffffff
    for (let i = offset + 4; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ data.getUint8(i)) & 255]
    if ((~crc >>> 0) !== data.getUint32(end)) return false
    if (count === 1) {
      if (type !== 'IHDR' || size !== 13 || !dimensions(data.getUint32(start), data.getUint32(start + 4))) return false
      color = data.getUint8(start + 9)
      const depths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])
      if (!depths.get(color)?.includes(data.getUint8(start + 8)) || data.getUint16(start + 10) !== 0 || data.getUint8(start + 12) > 1) return false
    } else if (type === 'IEND') return idat && size === 0 && end + 4 === data.byteLength
    else if (type === 'IDAT') {
      if (color === 3 && !palette) return false
      idat ||= size !== 0
    } else if (type === 'PLTE') {
      if (idat || palette || !size || size % 3 || size > 768 || color === 0 || color === 4) return false
      palette = true
    // Reject animation and embedded metadata/extra payload chunks. Only common color/alpha chunks before pixels.
    } else if (idat || !['tRNS', 'gAMA', 'sRGB', 'cHRM', 'pHYs'].includes(type)) return false
    offset = end + 4
  }
  return false
}

function jpeg(raw: string, data: DataView): boolean {
  if (raw.length < 32 || !tag(raw, 0, '\xff\xd8') || !tag(raw, raw.length - 2, '\xff\xd9')) return false
  let offset = 2, hasFrame = false, hasScan = false, scanning = false, segments = 0
  while (offset < raw.length) {
    if (scanning) {
      offset = raw.indexOf('\xff', offset)
      if (offset < 0 || offset + 1 >= raw.length) return false
      const marker = data.getUint8(offset + 1)
      if (marker === 0 || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue }
      if (marker === 0xff) { offset++; continue }
      scanning = false
    }
    if (data.getUint8(offset++) !== 0xff) return false
    while (offset < raw.length && data.getUint8(offset) === 0xff) offset++
    if (offset >= raw.length || ++segments > 256) return false
    const marker = data.getUint8(offset++)
    if (marker === 0xd9) return hasScan && offset === raw.length
    if (offset + 2 > raw.length) return false
    const length = data.getUint16(offset)
    if (length < 2 || offset + length > raw.length) return false
    if (marker === 0xc0 || marker === 0xc2) {
      if (hasFrame || length < 11 || data.getUint8(offset + 2) !== 8 ||
          !dimensions(data.getUint16(offset + 5), data.getUint16(offset + 3))) return false
      const channels = data.getUint8(offset + 7)
      if (channels !== 1 && channels !== 3 || length !== 8 + 3 * channels) return false
      hasFrame = true
    } else if (marker === 0xda) {
      if (!hasFrame || length < 8 || length !== 6 + 2 * data.getUint8(offset + 2)) return false
      hasScan = scanning = true
    } else if (![0xc4, 0xdb, 0xdd].includes(marker) && !(marker === 0xe0 && length >= 16 && tag(raw, offset + 2, 'JFIF\x00'))) return false
    offset += length
  }
  return false
}

function wav(raw: string, data: DataView): boolean {
  if (raw.length < 46 || !tag(raw, 0, 'RIFF') || !tag(raw, 8, 'WAVEfmt ') || !tag(raw, 36, 'data')) return false
  const u32 = (i: number) => data.getUint32(i, true), u16 = (i: number) => data.getUint16(i, true)
  const channels = u16(22), rate = u32(24), align = channels * 2, size = u32(40)
  return u32(4) === raw.length - 8 && u32(16) === 16 && u16(20) === 1 && (channels === 1 || channels === 2) &&
    integer(rate, 8000, 48000) && u32(28) === rate * align && u16(32) === align && u16(34) === 16 &&
    size === raw.length - 44 && size > 0 && size % align === 0
}

export function mediaReader(protocol: Protocol, capabilities: ReadonlySet<Capability>, references: boolean) {
  let size = 0, blocks = 0
  const count = () => { if (++blocks > 4) throw limited() }
  function decode(value: unknown, format: 'image/png' | 'image/jpeg' | 'wav'): string {
    if (typeof value !== 'string' || !value) throw invalidMedia()
    if (value.length > b64Limit) throw limited()
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw invalidMedia()
    let raw: string
    try { raw = atob(value) } catch { throw invalidMedia() }
    if (btoa(raw) !== value) throw invalidMedia() // Reject ambiguous padding/alphabet.
    size += raw.length
    if (raw.length > blockLimit || size > totalLimit) throw limited()
    const data = new DataView(Uint8Array.from(raw, c => c.charCodeAt(0)).buffer)
    if (!(format === 'image/png' ? png(raw, data) : format === 'image/jpeg' ? jpeg(raw, data) : wav(raw, data))) throw invalidMedia()
    return value
  }
  function checkDetail(detail: unknown): Detail | undefined {
    if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') throw invalidMedia()
    return detail
  }
  function image(mime: unknown, data: unknown, hint?: unknown): ChatPart {
    if (mime !== 'image/png' && mime !== 'image/jpeg') throw unsupportedMedia()
    const detail = checkDetail(hint)
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${decode(data, mime)}`, ...(detail !== undefined && { detail }) } }
  }
  function attachment(id: unknown, kind: 'image' | 'audio', hint?: unknown): AttachmentPart {
    if (!references || typeof id !== 'string' || !/^att_[0-9a-f]{32}$/.test(id)) throw unsupportedMedia()
    const detail = checkDetail(hint)
    count()
    return { type: 'attachment', kind, id, detail }
  }
  function dataURL(url: unknown, detail?: unknown): MediaPart {
    // A private attachment ID is not a URL, file path, tenant mount or transfer ticket.
    if (typeof url !== 'string') throw invalidMedia()
    if (url.startsWith('att_')) return attachment(url, 'image', detail)
    const match = /^data:(image\/(?:png|jpeg));base64,/.exec(url)
    if (!match) throw unsupportedMedia()
    count()
    return image(match[1], url.slice(match[0].length), detail)
  }
  function parse(part: Record<string, unknown>): MediaPart {
    if (protocol === 'chat' && part.type === 'input_audio' && capabilities.has('audio')) {
      fields(part, ['type', 'input_audio'], invalidMedia)
      const audio = record(part.input_audio, invalidMedia)
      if (audio.format !== 'wav') throw unsupportedMedia()
      if (Object.hasOwn(audio, 'file_id')) {
        fields(audio, ['file_id', 'format'], invalidMedia)
        return attachment(audio.file_id, 'audio')
      }
      fields(audio, ['data', 'format'], invalidMedia)
      count()
      return { type: 'input_audio', input_audio: { data: decode(audio.data, 'wav'), format: 'wav' } }
    }
    if (!capabilities.has('image')) throw unsupportedMedia()
    if (protocol === 'chat' && part.type === 'image_url') {
      fields(part, ['type', 'image_url'], invalidMedia)
      const input = record(part.image_url, invalidMedia)
      fields(input, ['url', 'detail'], invalidMedia)
      return dataURL(input.url, input.detail)
    }
    if (protocol === 'responses' && part.type === 'input_image') {
      if (Object.hasOwn(part, 'file_id')) {
        fields(part, ['type', 'file_id', 'detail'], invalidMedia)
        return attachment(part.file_id, 'image', part.detail)
      }
      fields(part, ['type', 'image_url', 'detail'], unsupportedMedia)
      return dataURL(part.image_url, part.detail)
    }
    if (protocol === 'anthropic' && part.type === 'image') {
      fields(part, ['type', 'source'], invalidMedia)
      const input = record(part.source, invalidMedia)
      if (input.type === 'file') {
        fields(input, ['type', 'file_id'], invalidMedia)
        return attachment(input.file_id, 'image')
      }
      if (input.type !== 'base64') throw unsupportedMedia()
      fields(input, ['type', 'media_type', 'data'], invalidMedia)
      count()
      return image(input.media_type, input.data)
    }
    throw unsupportedMedia()
  }
  const receipts: Array<() => void> = []
  return { parse, async resolve(part: AttachmentPart, read: ReadGatewayAttachment | undefined, guard: () => void): Promise<ChatPart> {
    if (!read) throw unsupportedMedia()
    guard()
    const unavailable = () => new GatewayError(404, 'attachment_unavailable', 'The private attachment is not available to this request.')
    let file: Awaited<ReturnType<ReadGatewayAttachment>>
    try { file = await read(part.id) } catch { throw unavailable() }
    guard()
    if (!file || !(file.bytes instanceof ArrayBuffer) || file.size !== file.bytes.byteLength || typeof file.assertCurrent !== 'function') throw unavailable()
    if (file.size > blockLimit || file.size + size > totalLimit) throw limited()
    const type = file.contentType
    if (part.kind === 'audio' ? type !== 'audio/wav' && type !== 'audio/x-wav' : type !== 'image/png' && type !== 'image/jpeg') throw unsupportedMedia()
    const base64 = btoa(Array.from(new Uint8Array(file.bytes), b => String.fromCharCode(b)).join(''))
    const verified: ChatPart = part.kind === 'audio' ? { type: 'input_audio', input_audio: { data: decode(base64, 'wav'), format: 'wav' } } :
      image(type, base64, part.detail)
    receipts.push(() => file.assertCurrent())
    return verified
  }, assertCurrent() {
    for (const check of receipts) {
      try { check() } catch { throw new GatewayError(409, 'attachment_changed', 'A private attachment is no longer current.') }
    }
  } }
}
