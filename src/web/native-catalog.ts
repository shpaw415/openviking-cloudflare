// SPDX-License-Identifier: AGPL-3.0-only
import { isId } from '../control/input.js'
import { isRecord } from '../http.js'
import { documentInputType } from '../documents.js'

export const nativeOrigin = 'https://web-native.invalid'
export const revisionHeader = 'x-ov-web-revision'
export const inventoryHeader = 'x-ov-web-inventory-sha256'
export const accountHeader = 'x-ov-web-account'
export const userHeader = 'x-ov-web-user'
export const token = /^[A-Za-z0-9_-]{1,128}$/
export const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const digest = /^[0-9a-f]{64}$/
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/
const folder = /^[A-Za-z0-9_-]{1,160}$/
const textName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,155}\.txt$/
const publicHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
export const keyPath = (raw: unknown): raw is string => typeof raw === 'string' && raw.length <= 256 &&
  /\.(?:md|txt)$/i.test(raw) && raw.split('/').every(part => segment.test(part))

export function exactPublicUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 1000 || /[?#]/.test(raw)) return
  try {
    const url = new URL(raw)
    if (url.href === raw && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        url.hostname.length <= 253 && publicHost.test(url.hostname) &&
        !/(?:^|\.)(?:localhost|internal|local|lan|home|arpa|onion)(?:\.|$)/.test(url.hostname) &&
        (url.pathname === '/' || url.pathname.slice(1).replace(/\/$/, '').split('/').every(part => segment.test(part)))) return url
  } catch { /* malformed */ }
}

export const shape = (value: unknown, fields: string): value is Record<string, unknown> => {
  const names = fields.split(' ')
  return isRecord(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key))
}
export const match = (value: unknown, regex: RegExp): value is string => typeof value === 'string' && regex.test(value)
export const list = (value: unknown, max: number): value is unknown[] => Array.isArray(value) && value.length <= max
export function configJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length > 48 * 1024) return
  try { return JSON.parse(raw) } catch { /* invalid config */ }
}

export const nativeLimits = { robots: 16 * 1024, html: 64 * 1024, rss: 64 * 1024, atom: 64 * 1024,
  sitemap: 64 * 1024, git: 96 * 1024, feishu: 64 * 1024, tos: 64 * 1024 } as const
export const nativeMedia = { robots: 'text/plain', html: 'text/html', rss: 'application/rss+xml', atom: 'application/atom+xml',
  sitemap: 'application/xml', git: 'application/json', feishu: 'text/plain', tos: 'text/plain' } as const
export type NativeKind = keyof typeof nativeLimits
export type NativeRef = { kind: NativeKind; url: string; id: string; binary?: string }
type Page = NativeRef & { kind: 'html'; name: string }
type GitFile = NativeRef & { kind: 'git'; file: string; name: string; blob_sha256: string }
type Site = { robots: NativeRef; pages: Page[]; maps: NativeRef[] }
export type ProviderMode = 'feishu-native' | 'tos-native' | 'feishu-tree' | 'tos-collection'
export type NativeMode = 'html' | 'site' | 'feed' | 'sitemap' | 'git' | 'git-collection' | ProviderMode
type WikiNode = { space: string; parent: string | null }
export type TableProjection = { range: string; height: number; width: number } | { table: string; columns: string[] }
type ObjectPlan = { mode: 'feishu-native' | 'tos-native'; root: NativeRef; target: string | null; wiki?: WikiNode; data?: TableProjection }
type Plan = { mode: 'html' | 'site'; page: Page; site: Site } |
  { mode: 'sitemap'; root: NativeRef; site: Site } |
  { mode: 'feed'; root: NativeRef; robots: NativeRef; format: 'rss' | 'atom'; mirror: Page[] } |
  { mode: 'git' | 'git-collection'; files: GitFile[] } |
  ObjectPlan | { mode: 'feishu-tree' | 'tos-collection'; objects: { relative: string; object: ObjectPlan }[] }
export type NativeSelection = Plan & { native: true; name: string; account: string; user: string; revision: string; watch?: true }
type Row = { key: string; user?: string; account: string; name: string; plan: Plan; watch?: true }
type ReadPermit = NativeRef & { account: string; user?: string; robots?: NativeRef; target?: string | null; wiki?: WikiNode; data?: TableProjection }
export type NativeCatalog = { revision: string; rows: Row[]; permits: Map<string, ReadPermit> }
export function nativeRoute(revision: string, ref: NativeRef) {
  return `${nativeOrigin}/v1/${revision}/${ref.kind}/${ref.id}`
}

export function nativeCatalog(raw: unknown): NativeCatalog | undefined {
  const config = configJson(raw)
  if (!(shape(config, 'version revision sites feeds git connectors') || shape(config, 'version revision sites feeds git connectors groups')) ||
      config.version !== 1 || !match(config.revision, digest) ||
      !list(config.sites, 32) || !list(config.feeds, 32) || !list(config.git, 32) || !list(config.connectors, 32)) return
  const revision = config.revision
  const rows: Row[] = [], permits = new Map<string, ReadPermit>()
  const add = (row: Row) => {
    if (rows.some(prior => prior.account === row.account && prior.user === row.user && prior.plan.mode === row.plan.mode && prior.key === row.key)) return false
    rows.push(row)
    return true
  }
  const permit = (ref: NativeRef, account: string, user?: string, robots?: NativeRef, target?: string | null, wiki?: WikiNode, data?: TableProjection) => {
    const route = nativeRoute(revision, ref)
    const next = { ...ref, account, user, robots, target, wiki, data }
    const existing = permits.get(route)
    if (existing && JSON.stringify(existing) !== JSON.stringify(next)) return false
    permits.set(route, next)
    return true
  }
  const policy = (id: unknown, origin: string): NativeRef | undefined => match(id, slug) ?
    { kind: 'robots', id, url: `${origin}/robots.txt` } : undefined
  for (const row of config.sites) {
    if (!shape(row, 'account entry name explore robots pages sitemaps sitemap_entry') || !isId(row.account) ||
        !match(row.name, folder) || typeof row.explore !== 'boolean' || !list(row.pages, 24) || !row.pages.length ||
        !list(row.sitemaps, 8)) return
    const entry = exactPublicUrl(row.entry), robots = entry && policy(row.robots, entry.origin)
    if (!entry || !robots || !permit(robots, row.account)) return
    const pages: Page[] = [], maps: NativeRef[] = []
    for (const item of row.pages) {
      if (!shape(item, 'id url name') || !match(item.id, slug) || !match(item.name, textName)) return
      const url = exactPublicUrl(item.url)
      if (!url || url.pathname === '/robots.txt' || url.origin !== entry.origin || pages.some(p => p.url === url.href || p.name === item.name)) return
      const page: Page = { kind: 'html', id: item.id, url: url.href, name: item.name }
      if (!permit(page, row.account, undefined, robots)) return
      pages.push(page)
    }
    for (const item of row.sitemaps) {
      if (!shape(item, 'id url') || !match(item.id, slug)) return
      const url = exactPublicUrl(item.url)
      if (!url || !url.pathname.endsWith('.xml') || url.origin !== entry.origin || maps.some(m => m.url === url.href)) return
      const ref: NativeRef = { kind: 'sitemap', id: item.id, url: url.href }
      if (!permit(ref, row.account, undefined, robots)) return
      maps.push(ref)
    }
    const page = pages.find(p => p.url === entry.href), root = maps.find(m => m.url === row.sitemap_entry)
    if (!page || (maps.length ? !root : row.sitemap_entry !== null)) return
    const site = { robots, pages, maps }
    for (const p of pages) {
      if (!add({ key: p.url, account: row.account, name: p.name, plan: { mode: 'html', page: p, site } })) return
    }
    if (row.explore && !add({ key: page.url, account: row.account, name: row.name, plan: { mode: 'site', page, site } })) return
    if (root && !add({ key: root.url, account: row.account, name: row.name, plan: { mode: 'sitemap', root, site } })) return
  }
  for (const row of config.feeds) {
    if (!(shape(row, 'account id url name kind robots') || shape(row, 'account id url name kind robots mirror')) ||
        !isId(row.account) || !match(row.id, slug) || !match(row.name, folder) ||
        (row.kind !== 'rss' && row.kind !== 'atom')) return
    const url = exactPublicUrl(row.url), robots = url && policy(row.robots, url.origin)
    if (!url || url.pathname === '/robots.txt' || !robots || !permit(robots, row.account)) return
    const root = { kind: row.kind, id: row.id, url: url.href } as const
    const mirror: Page[] = []
    if (Object.hasOwn(row, 'mirror')) {
      if (!list(row.mirror, 24)) return
      for (const address of row.mirror) {
        const page = rows.find(item => item.account === row.account && item.key === address && item.plan.mode === 'html')?.plan
        if (page?.mode !== 'html' || page.page.name.startsWith('entry-') || new URL(page.page.url).origin !== url.origin ||
            page.site.robots.id !== robots.id || mirror.some(p => p.url === page.page.url || p.name === page.page.name)) return
        mirror.push(page.page)
      }
    }
    if (!permit(root, row.account, undefined, robots) ||
        !add({ key: url.href, account: row.account, name: row.name, plan: { mode: 'feed', root, robots, format: row.kind, mirror } })) return
  }
  for (const row of config.git) {
    if (!shape(row, 'account alias name repository commit collection files') || !isId(row.account) || !match(row.alias, slug) ||
        typeof row.collection !== 'boolean' || !match(row.name, row.collection ? folder : textName) || !list(row.files, 6) ||
        !row.files.length || (!row.collection && row.files.length !== 1) || !match(row.commit, /^[0-9a-f]{40}$/) ||
        !match(row.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/)) return
    const files: GitFile[] = []
    for (const item of row.files) {
      if (!shape(item, 'id file name blob_sha256') || !match(item.id, slug) || !keyPath(item.file) || !match(item.name, textName) ||
          !match(item.blob_sha256, digest) || files.some(f => f.id === item.id || f.name === item.name || f.file === item.file)) return
      const file: GitFile = { kind: 'git', id: item.id, url: `https://api.github.com/repos/${row.repository}/contents/${item.file}?ref=${row.commit}`,
        name: item.name, file: item.file, blob_sha256: item.blob_sha256 }
      if (!permit(file, row.account)) return
      files.push(file)
    }
    if (!add({ key: row.alias, account: row.account, name: row.name,
      plan: { mode: row.collection ? 'git-collection' : 'git', files } })) return
  }
  for (const row of config.connectors) {
    const required = 'account user id alias name kind source target'.split(' ')
    if (!isRecord(row) || !required.every(key => Object.hasOwn(row, key)) ||
        Object.keys(row).some(key => !required.includes(key) && !['wiki','binary','watch','data'].includes(key)) ||
        (Object.hasOwn(row, 'watch') && typeof row.watch !== 'boolean') || !isId(row.account) || !isId(row.user) ||
        !match(row.id, slug) || !match(row.alias, slug) || !match(row.name, textName) ||
        (row.kind !== 'feishu' && row.kind !== 'tos')) return
    const source = connectorSource(row.kind, row.source)
    if (!source) return
    const wikiUrl = row.kind === 'feishu' && new URL(source).pathname.startsWith('/wiki/')
    if (row.kind === 'tos' ? !match(row.target, /^[a-z]{2}(?:-[a-z0-9]{1,16}){1,3}$/) :
        wikiUrl ? !match(row.target, /^(?:doc|docx|file|sheet|bitable)\/[A-Za-z0-9_-]{1,128}$/) : row.target !== null) return
    const docType = row.kind === 'feishu' ? wikiUrl ? (row.target as string).split('/')[0] : new URL(source).pathname.split('/')[1] : ''
    let data: TableProjection | undefined
    if (docType === 'sheet' || docType === 'sheets') {
      if (!shape(row.data, 'range') || typeof row.data.range !== 'string') return
      const range = /^([A-Za-z0-9_-]{1,64})!([A-Z]{1,2})([1-9]\d{0,5}):([A-Z]{1,2})([1-9]\d{0,5})$/.exec(row.data.range)
      if (!range) return
      const column = (name:string) => [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)
      const height = Number(range[5]) - Number(range[3]) + 1, width = column(range[4]) - column(range[2]) + 1
      if (height < 1 || height > 200 || width < 1 || width > 20) return
      data = { range: row.data.range, height, width }
    } else if (docType === 'bitable' || docType === 'base') {
      if (!shape(row.data, 'table columns') || !match(row.data.table, /^tbl[A-Za-z0-9_-]{1,125}$/) || !list(row.data.columns, 20) ||
          !row.data.columns.length || !row.data.columns.every(key => match(key, /^[\p{L}\p{N}_. -]{1,96}$/u)) || new Set(row.data.columns).size !== row.data.columns.length) return
      data = { table: row.data.table, columns: row.data.columns as string[] }
    } else if (Object.hasOwn(row, 'data')) return
    let wiki: WikiNode | undefined
    if (Object.hasOwn(row, 'wiki')) {
      if (!wikiUrl || !shape(row.wiki, 'space parent') || !match(row.wiki.space, token) ||
          (row.wiki.parent !== null && !match(row.wiki.parent, token))) return
      wiki = { space: row.wiki.space, parent: row.wiki.parent }
    }
    let binary: string | undefined
    const needsBinary = row.kind === 'tos' ? !/\.(?:txt|md)$/i.test(source) : typeof row.target === 'string' && row.target.startsWith('file/')
    if (needsBinary || Object.hasOwn(row, 'binary')) {
      if (!needsBinary || !match(row.binary, segment) || !documentInputType(row.binary) ||
          (row.kind === 'tos' && row.binary !== source.split('/').at(-1))) return
      binary = row.binary
    }
    const root: NativeRef = { kind: row.kind, id: row.id, url: source, ...(binary && { binary }) }
    const target = row.target as string | null
    const plan: ObjectPlan = { mode: row.kind === 'feishu' ? 'feishu-native' : 'tos-native', root, target, ...(wiki && { wiki }), ...(data && { data }) }
    const fields = { account: row.account, user: row.user, name: row.name, plan, ...(row.watch === true && { watch: true as const }) }
    if (!permit(root, row.account, row.user, undefined, target, wiki, data) || !add({ key: row.alias, ...fields }) || !add({ key: source, ...fields })) return
  }
  const groups = Object.hasOwn(config, 'groups') ? config.groups : []
  if (!list(groups, 32)) return
  for (const group of groups) {
    if (!shape(group, 'account user alias name kind objects watch') || !isId(group.account) || !isId(group.user) ||
        !match(group.alias, slug) || !match(group.name, folder) || (group.kind !== 'feishu' && group.kind !== 'tos') ||
        typeof group.watch !== 'boolean' || !list(group.objects, 16) || !group.objects.length) return
    const objects: { relative: string; object: ObjectPlan }[] = []
    for (const item of group.objects) {
      if (!shape(item, 'id relative') || !match(item.id, slug) || typeof item.relative !== 'string' || item.relative.length > 480) return
      const relative = item.relative, parts = relative.split('/'), leaf = parts.pop()
      if (!match(leaf, textName) || parts.length > 6 || !parts.every(part => folder.test(part))) return
      const row = rows.find(row => row.account === group.account && row.user === group.user &&
        (row.plan.mode === 'feishu-native' || row.plan.mode === 'tos-native') && row.plan.root.id === item.id && row.plan.root.kind === group.kind)
      if (!row || (row.plan.mode !== 'feishu-native' && row.plan.mode !== 'tos-native') ||
          objects.some(other => other.object.root.url === (row.plan as ObjectPlan).root.url || other.relative === relative)) return
      objects.push({ relative, object: row.plan })
    }
    if (group.kind === 'feishu') {
      const first = objects[0], wiki = first.object.wiki
      if (!wiki || wiki.parent !== null || first.relative.includes('/')) return
      for (const item of objects.slice(1)) {
        const check = item.object.wiki
        const parent = check?.parent && objects.find(other => other.object.root.url === new URL(`/wiki/${check.parent}`, first.object.root.url).href)
        if (!check || check.space !== wiki.space || !parent || !item.relative.includes('/') || new URL(item.object.root.url).origin !== new URL(first.object.root.url).origin ||
            item.relative.slice(0, item.relative.lastIndexOf('/')) !== parent.relative.slice(0, -4)) return
      }
    }
    if (new Set(objects.map(item => item.object.root.id)).size !== objects.length ||
        !add({ key: group.alias, account: group.account, user: group.user, name: group.name,
          plan: { mode: group.kind === 'feishu' ? 'feishu-tree' : 'tos-collection', objects }, ...(group.watch && { watch: true }) })) return
  }
  return { revision, rows, permits }
}

export function connectorSource(kind: 'feishu' | 'tos', raw: unknown): string | undefined {
  if (kind === 'feishu') {
    const url = exactPublicUrl(raw)
    if (url && /\.(?:feishu\.cn|larksuite\.com)$/.test(url.hostname) && /^\/(?:doc|docx|wiki|sheets|base)\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) return url.href
  } else if (typeof raw === 'string' && raw.length <= 320) {
    const syntax = /^tos:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/(.+)$/.exec(raw)
    if (syntax) {
      const key = syntax[2], leaf = key.split('/').at(-1)!
      if (key.length <= 256 && key.split('/').every(part => segment.test(part)) &&
          (/\.(?:txt|md)$/i.test(leaf) || (leaf.includes('.') && documentInputType(leaf)))) return raw
    }
  }
}
