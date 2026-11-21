// SPDX-License-Identifier: AGPL-3.0-only
import { readBytes } from '../http.js'
import type { Entry } from '../filesystem.js'
import { decoder, invalid, leaf } from './common.js'

const NS = 'DAV:'
const IDENT = '[A-Za-z_][A-Za-z0-9_.-]{0,79}'
const TAG = new RegExp(`^(\\/?)(${IDENT}(?::${IDENT})?)([^<>]*?)(\\/?)>`, 'u')
const DECLARATION = new RegExp(`^\\s+xmlns(?::(${IDENT}))?\\s*=\\s*(?:"([^"<>&]{1,256})"|'([^'<>&]{1,256})')`, 'u')

type Property = { ns: string; name: string }
type Selection = 'allprop' | 'propname' | Property[]

export const modification = (row: Entry) => row.updated_at ? new Date(row.updated_at).toUTCString() : undefined
export const entityTag = (row: Entry) => !row.is_dir && row.revision ? `"${row.revision}"` : undefined
const xml = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]!))

export async function selectProps(request: Request): Promise<Selection> {
  const bytes = await readBytes(request, 8192)
  if (!bytes.byteLength) return 'allprop'
  let text: string
  try { text = decoder.decode(bytes).trim().replace(/^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?\s*\?>/i, '').trim() }
  catch { return invalid('PROPFIND body must be UTF-8 XML.') }
  if (!text) return 'allprop'
  const stack: Array<{ name: string; namespace: Map<string, string> }> = []
  let root = false, selection: Selection | undefined
  const bad = (): never => invalid('Expected a bounded DAV:propfind property request.')
  while (text) {
    if (!text.startsWith('<')) return bad()
    const tag = TAG.exec(text.slice(1))
    if (!tag) return bad()
    text = text.slice(tag[0].length + 1).trimStart()
    const [, end, qualified, attrs, empty] = tag
    if (end) {
      if (empty || attrs.trim() || stack.pop()?.name !== qualified) return bad()
      continue
    }
    if (stack.length > 2) return bad()
    const namespace = new Map(stack.at(-1)?.namespace)
    const declared = new Set<string>()
    let attributes = attrs
    while (attributes.trim()) {
      const found = DECLARATION.exec(attributes)
      if (!found || declared.has(found[1] ?? '')) return bad()
      const prefix = found[1] ?? ''
      const ns = found[2] ?? found[3]
      if (/[\s\p{Cc}\p{Cf}]/u.test(ns) || prefix === 'xmlns' || prefix === 'xml') return bad()
      namespace.set(prefix, ns)
      declared.add(prefix)
      attributes = attributes.slice(found[0].length)
    }
    const parts = qualified.split(':')
    const local = parts.at(-1)!
    const ns = namespace.get(parts.length === 2 ? parts[0] : '')
    if (!ns) return bad()
    if (stack.length === 0) {
      if (root || ns !== NS || local !== 'propfind' || empty) return bad()
      root = true
    } else if (stack.length === 1) {
      if (selection !== undefined || ns !== NS) return bad()
      if (local === 'allprop' || local === 'propname') selection = local
      else if (local === 'prop') selection = []
      else return bad()
    } else {
      if (!Array.isArray(selection) || selection.length === 64) return bad()
      if (!selection.some(prop => prop.ns === ns && prop.name === local)) selection.push({ ns, name: local })
    }
    if (!empty) stack.push({ name: qualified, namespace })
  }
  if (!root || stack.length || !selection) return bad()
  return selection
}

function element(property: Property, value: string | undefined): string {
  const prefix = property.ns === NS ? 'd' : 'p'
  const attr = prefix === 'p' ? ` xmlns:p="${xml(property.ns)}"` : ''
  const key = `${prefix}:${property.name}`
  return value ? `<${key}${attr}>${value}</${key}>` : `<${key}${attr}/>`
}

export function multistatus(rows: Entry[], selection: Selection, href: (row: Entry) => string): string {
  const response = rows.map(row => {
    const props = new Map<string, string>([
      ['displayname', xml(leaf(row.uri))],
      ['resourcetype', row.is_dir ? '<d:collection/>' : ''],
      ['getcontenttype', row.is_dir ? 'httpd/unix-directory' : 'text/plain; charset=utf-8'],
    ])
    if (!row.is_dir) props.set('getcontentlength', String(row.bytes))
    const date = modification(row), tag = entityTag(row)
    if (date) props.set('getlastmodified', date)
    if (tag) props.set('getetag', xml(tag))
    const good: string[] = [], absent: string[] = []
    if (Array.isArray(selection)) {
      for (const property of selection) {
        const value = property.ns === NS ? props.get(property.name) : undefined
        if (value === undefined) absent.push(element(property, undefined))
        else good.push(element(property, value))
      }
    } else for (const [name, value] of props) good.push(element({ ns: NS, name }, selection === 'propname' ? undefined : value))
    const status = (items: string[], code: string) =>
      `<d:propstat><d:prop>${items.join('')}</d:prop><d:status>HTTP/1.1 ${code}</d:status></d:propstat>`
    return `<d:response><d:href>${xml(href(row))}</d:href>${(good.length || !absent.length) ? status(good, '200 OK') : ''}${
      absent.length ? status(absent, '404 Not Found') : ''}</d:response>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:">${response.join('')}</d:multistatus>`
}
