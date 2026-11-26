// SPDX-License-Identifier: AGPL-3.0-only
import { textSize } from '../fs/contract.js'
import { htmlUrl } from './catalog.js'
import { exactPublicUrl } from './native-catalog.js'

const invisible = 'head,script,style,template,noscript,iframe,frame,frameset,object,embed,svg,math,form,input,button,select,textarea,xmp,plaintext,[hidden],[inert],[aria-hidden="true"]'
const block = 'address,article,aside,blockquote,br,div,dl,dt,dd,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,p,pre,section,td,th,tr'
const entities: Readonly<Record<string, string>> = { amp: '&', lt: '‹', gt: '›', quot: '"', apos: "'", nbsp: ' ' }

function textEntities(text: string): string {
  return text.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (raw, entity: string) => {
    if (!entity.startsWith('#')) return Object.hasOwn(entities, entity.toLowerCase()) ? entities[entity.toLowerCase()] : raw
    const hex = entity[1].toLowerCase() === 'x'
    const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd'
  })
}

function hrefFor(raw: string, page: URL, native: boolean): string | undefined {
  // Ignore arbitrary protocols, queries, fragments, <base>, dotted traversal,
  // and network-path references. Only the exact catalogue key can authorize it.
  const path = raw.startsWith('./') ? raw.slice(2) : raw
  if (path.length > 1000 || !/^(?:https:\/\/)?[A-Za-z0-9_./-]+$/.test(path) ||
      path.startsWith('//') || path.split('/').some(part => part === '.' || part === '..')) return
  try {
    const link = (native ? exactPublicUrl : htmlUrl)(path.startsWith('https://') ? path : new URL(path, page).href)
    if (link?.origin === page.origin) return link.href
  } catch { /* An invalid link is not an import destination. */ }
}

export async function extractHtml(input: string, url: string, approved: ReadonlySet<string>, native = false) {
  // The intermediate response is never served. A separate extraction pass
  // makes omitted descendants unavailable even to document-level callbacks.
  const pruned = new HTMLRewriter().on(invisible, { element: el => { el.remove() } })
    .transform(new Response(input, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const chunks: string[] = []
  const links = new Set<string>()
  const page = new URL(url)
  const newLine = () => { chunks.push('\n') }
  const extraction = new HTMLRewriter()
    .on(block, { element(el) { newLine(); if (!['br', 'hr'].includes(el.tagName)) el.onEndTag(newLine) } })
    .on('a[href]', { element(el) {
      if (!approved.size || el.hasAttribute('download')) return
      const link = hrefFor(el.getAttribute('href') ?? '', page, native)
      if (link && approved.has(link)) links.add(link)
    } })
    .onDocument({ text: chunk => { chunks.push(chunk.text) } })
  await extraction.transform(pruned).arrayBuffer()
  const text = textEntities(chunks.join('')).replace(/[<>]/g, char => char === '<' ? '‹' : '›')
    .split(/\r\n|\r|\n/).map(line => line.replace(/[\t\f\p{Zs}]+/gu, ' ').trim()).filter(Boolean).join('\n')
  return { text, bytes: textSize(text), links }
}
