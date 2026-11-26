// SPDX-License-Identifier: AGPL-3.0-only
import { textSize } from '../fs/contract.js'
import { ApiError } from '../http.js'
import { extractHtml } from './html.js'

const maxEntries = 6
const atomNamespace = 'http://www.w3.org/2005/Atom'
const xmlName = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?'
const invalidFeed = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The approved feed is not a supported RSS or Atom document.')
const characters = (text: string) => !/[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(text)

function entities(text: string): string {
  return text.replace(/&(?:(amp|lt|gt|apos|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});)?/g, (_, value?: string) => {
    if (!value) throw invalidFeed()
    switch (value) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'apos': return "'"
      case 'quot': return '"'
      default: {
        const hex = value.startsWith('#x')
        const cp = Number.parseInt(value.slice(hex ? 2 : 1), hex ? 16 : 10)
        if (cp > 0x10ffff) throw invalidFeed()
        const decoded = String.fromCodePoint(cp)
        if (!characters(decoded)) throw invalidFeed()
        return decoded
      }
    }
  })
}

type Element = { name: string; attributes: Map<string, string>; children: Element[]; text: string }

/** A bounded UTF-8 XML subset, not a general XML parser. There is no external
 * entity resolution, stylesheet, XPath, namespace resolution or fetch hook. */
function feedTree(raw: string): Element {
  const input = raw.replace(/\r\n?/g, '\n')
  if (!characters(input)) throw invalidFeed()
  const declaration = /^<\?xml[ \t\n]+version=(?:"1\.0"|'1\.0')(?:[ \t\n]+encoding=(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[ \t\n]+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\n]*\?>/
  const tag = new RegExp(`<(/?)(${xmlName})`, 'y')
  const attr = new RegExp(`[ \\t\\n]+(${xmlName})[ \\t\\n]*=[ \\t\\n]*(?:"([^"<]*)"|'([^'<]*)')`, 'y')
  const endTag = /[ \t\n]*(\/?)>/y
  const stack: Element[] = []
  let root: Element | undefined, at = declaration.exec(input)?.[0].length ?? 0, elements = 0
  while (at < input.length) {
    const current = stack.at(-1)
    if (input[at] !== '<') {
      const end = input.indexOf('<', at)
      const chunk = input.slice(at, at = end < 0 ? input.length : end)
      if (chunk.includes(']]>') || (!current && /[^ \t\n]/.test(chunk))) throw invalidFeed()
      if (current) current.text += entities(chunk)
    } else if (input.startsWith('<!--', at)) {
      const end = input.indexOf('--', at + 4)
      if (end < 0 || !input.startsWith('-->', end)) throw invalidFeed()
      at = end + 3
    } else if (current && input.startsWith('<![CDATA[', at)) {
      const end = input.indexOf(']]>', at + 9)
      if (end < 0) throw invalidFeed()
      current.text += input.slice(at + 9, end)
      at = end + 3
    } else {
      tag.lastIndex = at
      const match = tag.exec(input)
      if (!match) throw invalidFeed()
      const [, closing, name] = match
      attr.lastIndex = tag.lastIndex
      const attributes = new Map<string, string>()
      at = tag.lastIndex
      if (!closing) for (let field = attr.exec(input); field; field = attr.exec(input)) {
        if (attributes.has(field[1]) || attributes.size === 24) throw invalidFeed()
        attributes.set(field[1], entities(field[2] ?? field[3]))
        at = attr.lastIndex
      }
      endTag.lastIndex = at
      const ending = endTag.exec(input)
      if (!ending) throw invalidFeed()
      at = endTag.lastIndex
      if (closing) {
        if (ending[1] || current?.name !== name) throw invalidFeed()
        stack.pop()
      } else {
        if (++elements > 2_048 || stack.length >= 20 || (!current && root)) throw invalidFeed()
        const child = { name, attributes, children: [], text: '' }
        if (current) current.children.push(child)
        else root = child
        if (!ending[1]) stack.push(child)
      }
    }
  }
  if (!root || stack.length) throw invalidFeed()
  return root
}

export function readSitemap(raw: string) {
  const invalid = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The approved sitemap is not a supported XML document.')
  let root: Element
  try { root = feedTree(raw) } catch { throw invalid() }
  const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9'
  if ((root.name !== 'urlset' && root.name !== 'sitemapindex') || root.attributes.get('xmlns') !== ns || root.text.trim()) throw invalid()
  const index = root.name === 'sitemapindex'
  const namespace = (el: Element) => !el.attributes.has('xmlns') || el.attributes.get('xmlns') === ns
  const addresses = []
  for (const entry of root.children) {
    if (entry.name !== (index ? 'sitemap' : 'url') || !namespace(entry)) continue
    const loc = entry.children.filter(el => el.name === 'loc' && namespace(el))
    if (loc.length !== 1 || loc[0].children.length || !loc[0].text.trim()) throw invalid()
    addresses.push(loc[0].text.trim())
  }
  return { index, addresses }
}

export async function readFeed(raw: string, kind: 'rss' | 'atom', url: string,
  mirror?: (href: string) => Promise<{ name: string; text: string; bytes: number } | undefined>) {
  const root = feedTree(raw)
  const ns = kind === 'atom' ? atomNamespace : undefined
  if (root.name !== (kind === 'atom' ? 'feed' : 'rss') || root.attributes.get('xmlns') !== ns ||
      (kind === 'rss' && root.attributes.get('version') !== '2.0')) throw invalidFeed()
  // Only direct children in the admitted default namespace have meaning.
  const named = (parent: Element, name: string) => parent.children.filter(child => child.name === name &&
    (!child.attributes.has('xmlns') || child.attributes.get('xmlns') === ns))
  const field = (parent: Element, name: string) => {
    const items = named(parent, name)
    if (items.length > 1) throw invalidFeed()
    return items[0] as Element | undefined
  }
  const channel = kind === 'rss' ? field(root, 'channel') : root
  if (!channel) throw invalidFeed()
  const entries = named(channel, kind === 'rss' ? 'item' : 'entry')
  if (!entries.length) throw invalidFeed()
  const content = async (item: Element | undefined, htmlDefault = false) => {
    if (!item) return ''
    const type = item.attributes.get('type') ?? (htmlDefault ? 'html' : 'text')
    if (item.children.length || item.attributes.has('src') || (type !== 'text' && type !== 'html')) throw invalidFeed()
    if (type === 'html') return (await extractHtml(item.text, url, new Set())).text
    return item.text.trim()
  }
  const documents = []
  const mirrored = new Set<string>()
  for (const [position, entry] of entries.slice(0, maxEntries).entries()) {
    if (mirror) {
      const links = named(entry, 'link')
      const candidates = (kind === 'rss' ? links.filter(link => !link.children.length).map(link => link.text.trim()) :
        links.filter(link => [undefined, 'alternate'].includes(link.attributes.get('rel'))).map(link => link.attributes.get('href')))
        .filter((value): value is string => !!value)
      // A single canonical candidate can select an approved page. Preserve the
      // inline rendering otherwise, including duplicate article URLs.
      if (candidates.length === 1 && !mirrored.has(candidates[0])) {
        const article = await mirror(candidates[0])
        if (article) {
          mirrored.add(candidates[0])
          documents.push(article)
          continue
        }
      }
    }
    const title = await content(field(entry, 'title'))
    const body = kind === 'rss' ? await content(field(entry, 'description'), true) :
      await content(field(entry, 'content') ?? field(entry, 'summary'))
    const text = [title, body].filter(Boolean).join('\n\n')
    if (!text) throw invalidFeed()
    documents.push({ name: `entry-${String(position + 1).padStart(2, '0')}.txt`, text, bytes: textSize(text) })
  }
  return { documents, bounded: entries.length > maxEntries }
}
