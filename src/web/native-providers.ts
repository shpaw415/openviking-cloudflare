// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { configJson, list, match, shape, slug, token } from './native-catalog.js'
import type { TableProjection } from './native-catalog.js'
import { documentInputLimit, documentInputType } from '../documents.js'
import { renderFeishuBlocks } from './feishu-blocks.js'

export const sourceDenied = () => new ApiError(403, 'SOURCE_DENIED', 'The approved source did not authorize this document read.')
export const invalidNative = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The approved source did not provide a supported document.')
export const unavailableNative = () => new ApiError(503, 'SOURCE_UNAVAILABLE', 'This approved document source is not available.')

type Feishu = { kind: 'feishu'; bearer: string }
type Tos = { kind: 'tos'; access: string; secret: string; session: string | null }
export function providerCredentials(raw: unknown, id: string): Feishu | Tos | undefined {
  const config = configJson(raw)
  if (!list(config, 32)) return
  const headerValue = /^[A-Za-z0-9._~+\/=-]{8,4096}$/
  const ids = new Set<string>()
  let credential: Feishu | Tos | undefined
  for (const entry of config) {
    if (!isRecord(entry) || !match(entry.id, slug) || ids.has(entry.id)) return
    ids.add(entry.id)
    let parsed: Feishu | Tos
    if (entry.kind === 'feishu' && shape(entry, 'id kind bearer') && match(entry.bearer, headerValue)) {
      parsed = { kind: 'feishu', bearer: entry.bearer }
    } else if (entry.kind === 'tos' && shape(entry, 'id kind access secret session') && match(entry.access, token) &&
        match(entry.secret, headerValue) && (entry.session === null || match(entry.session, headerValue))) {
      parsed = { kind: 'tos', access: entry.access, secret: entry.secret, session: entry.session }
    } else return
    if (entry.id === id) credential = parsed
  }
  return credential
}

type Get = (url: string, accept: string, limit: number, headers?: Record<string, string>) => Promise<Uint8Array<ArrayBuffer>>
const bodyLimit = 96 * 1024
export function decodeNative(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw invalidNative() }
}
function excludeCredential(bytes: Uint8Array, values: (string | null)[]) {
  const scan = new TextDecoder().decode(bytes)
  if (values.some(value => value && scan.includes(value))) throw invalidNative()
  return bytes
}

export async function feishuDocument(get: Get, source: string, target: string | null, credential: Feishu,
  wiki?: { space: string; parent: string | null }, filename?: string, projection?: TableProjection) {
  const src = new URL(source)
  const domain = src.hostname.endsWith('.feishu.cn') ? 'https://open.feishu.cn/open-apis' : 'https://open.larksuite.com/open-apis'
  const headers = { authorization: `Bearer ${credential.bearer}` }
  let remaining = 192 * 1024
  const json = async (path: string) => {
    if (remaining <= 0) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'The source byte budget was reached.')
    const raw = await get(domain + path, 'application/json', Math.min(bodyLimit, remaining), headers)
    remaining -= raw.byteLength
    const text = decodeNative(raw)
    if (text.includes(credential.bearer)) throw invalidNative()
    let value: unknown
    try { value = JSON.parse(text) } catch { throw invalidNative() }
    if (!isRecord(value) || !Number.isSafeInteger(value.code)) throw invalidNative()
    if (value.code !== 0) throw sourceDenied()
    if (!isRecord(value.data)) throw invalidNative()
    return value.data
  }
  let [, kind, id] = src.pathname.split('/')
  const wikiId = kind === 'wiki' ? id : undefined
  const verifyNode = async () => {
    if (!target) throw unavailableNative()
    const [approvedKind, approvedId] = target.split('/')
    const { node } = await json(`/wiki/v2/spaces/get_node?token=${wikiId}`)
    if (!isRecord(node) || node.node_token !== wikiId || node.obj_type !== approvedKind || node.obj_token !== approvedId ||
        (wiki && (node.space_id !== wiki.space || (wiki.parent !== null && node.parent_node_token !== wiki.parent)))) throw sourceDenied()
    return [approvedKind, approvedId]
  }
  if (wikiId) [kind, id] = await verifyNode()
  if (kind === 'sheets') kind = 'sheet'
  if (kind === 'base') kind = 'bitable'
  const authorize = async () => {
    const { auth_result } = await json(`/drive/v1/permissions/${id}/members/auth?type=${kind}&action=view`)
    if (auth_result !== true) throw sourceDenied()
  }
  await authorize()
  let output: Uint8Array<ArrayBuffer>
  if (kind === 'doc') {
    const { content } = await json(`/doc/v2/${id}/raw_content`)
    if (typeof content !== 'string') throw invalidNative()
    output = new Uint8Array(encode(content))
  } else if (kind === 'file' && filename) {
    output = await get(domain + `/drive/v1/files/${id}/download`, documentInputType(filename)!, documentInputLimit, headers)
  } else if (kind === 'sheet' && projection && 'range' in projection) {
    const { valueRange } = await json(`/sheets/v2/spreadsheets/${id}/values/${encodeURIComponent(projection.range)}`)
    if (!isRecord(valueRange) || valueRange.range !== projection.range || !list(valueRange.values, projection.height)) throw invalidNative()
    const rows = valueRange.values.map(row => {
      if (!list(row, projection.width)) throw invalidNative()
      return row.map(tableValue).join('\t')
    })
    output = new Uint8Array(encode(rows.join('\n')))
  } else if (kind === 'bitable' && projection && 'table' in projection) {
    const rows = [projection.columns.join('\t')], seen = new Set<string>(), cursors = new Set<string>()
    let cursor = ''
    for (let i = 0; ; i++) {
      const data = await json(`/bitable/v1/apps/${id}/tables/${projection.table}/records?page_size=100&field_names=${encodeURIComponent(JSON.stringify(projection.columns))}${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`)
      if (!list(data.items, 100) || typeof data.has_more !== 'boolean') throw invalidNative()
      for (const item of data.items) {
        if (!isRecord(item) || !isRecord(item.fields) || !match(item.record_id, token) || seen.has(item.record_id)) throw invalidNative()
        const fields = item.fields
        seen.add(item.record_id)
        rows.push(projection.columns.map(column => Object.hasOwn(fields, column) ? tableValue(fields[column]) : '').join('\t'))
      }
      if (!data.has_more) break
      if (i >= 2) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'The approved table exceeds its record budget.')
      if (!match(data.page_token, /^[A-Za-z0-9_+=\/-]{1,256}$/) || cursors.has(data.page_token)) throw invalidNative()
      cursor = data.page_token
      cursors.add(cursor)
    }
    output = new Uint8Array(encode(rows.join('\n')))
  } else {
    // Keep page tokens within the one approved operation on the same DOCX.
    // Traverse only if the server supplied another distinct, bounded cursor.
    const blocks = new Map<string, Record<string, unknown>>(), cursors = new Set<string>()
    let cursor = ''
    for (let page = 0; ; ++page) {
      const data = await json(`/docx/v1/documents/${id}/blocks?page_size=100&document_revision_id=-1${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ''}`)
      if (!list(data.items, 100) || typeof data.has_more !== 'boolean') throw invalidNative()
      for (const block of data.items) {
        if (!isRecord(block) || !match(block.block_id, token) || blocks.has(block.block_id) || !Number.isInteger(block.block_type)) throw invalidNative()
        blocks.set(block.block_id, block)
      }
      if (!data.has_more) break
      if (page >= 2) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'The document exceeds the block page budget.')
      if (!match(data.page_token, /^[A-Za-z0-9_+=\/-]{1,256}$/) || cursors.has(data.page_token)) throw invalidNative()
      cursor = data.page_token
      cursors.add(cursor)
    }
    output = new Uint8Array(encode(renderFeishuBlocks(blocks)))
  }
  await authorize()
  if (wikiId && wiki) await verifyNode()
  return excludeCredential(output, [credential.bearer])
}

function tableValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value.replace(/[\t\r\n]+/g, ' ')
  if (list(value, 32) && value.every(part => isRecord(part) && typeof part.text === 'string' &&
      (part.type === undefined || ['text','url'].includes(String(part.type))))) {
    return value.map(part => (part as {text:string}).text).join('').replace(/[\t\r\n]+/g, ' ')
  }
  throw invalidNative()
}

const encode = (value: string) => new TextEncoder().encode(value)
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('')
async function hmac(key: BufferSource, value: string) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', imported, encode(value))
}

export async function tosDocument(get: Get, source: string, region: string, credential: Tos, filename?: string) {
  const [, bucket, key] = /^tos:\/\/([^/]+)\/(.+)$/.exec(source)!
  const host = `${bucket}.tos-${region}.volces.com`, path = `/${key}`
  const dateTime = new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''), date = dateTime.slice(0, 8)
  const payload = 'UNSIGNED-PAYLOAD', algo = 'TOS4-HMAC-SHA256', service = 'tos', terminal = 'request'
  const values = { host, 'x-tos-content-sha256': payload, 'x-tos-date': dateTime,
    ...(credential.session ? { 'x-tos-security-token': credential.session } : {}) }
  const names = Object.keys(values).sort() as (keyof typeof values)[]
  const signed = names.join(';')
  const canonical = ['GET', path, '', names.map(name => `${name}:${values[name]}\n`).join(''), signed, payload].join('\n')
  const scope = `${date}/${region}/${service}/${terminal}`
  const data = [algo, dateTime, scope, hex(await crypto.subtle.digest('SHA-256', encode(canonical)))].join('\n')
  const dayKey = await hmac(encode(credential.secret), date)
  const regionKey = await hmac(dayKey, region)
  const serviceKey = await hmac(regionKey, service)
  const signature = hex(await hmac(await hmac(serviceKey, terminal), data))
  // Do not set Host explicitly. The HTTPS target fixes the HTTP host signed above.
  const { host: _host, ...headers } = values
  const bytes = await get(`https://${host}${path}`, filename ? documentInputType(filename)! : 'text/plain', filename ? documentInputLimit : 64 * 1024, {
    ...headers, authorization: `${algo} Credential=${credential.access}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  })
  return excludeCredential(bytes, [credential.access, credential.secret, credential.session, signature])
}
