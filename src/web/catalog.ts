// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, Env } from '../context.js'
import { isId } from '../control/input.js'
import { isRecord } from '../http.js'
import { nativeCatalog } from './native-catalog.js'
import type { NativeMode, NativeSelection } from './native-catalog.js'

export const snapshotOrigin = 'https://web-source.invalid'
export const snapshotId = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const snapshotRoute = /^\/v1\/(html|robots|git|rss|atom|feishu|tos|live-html)\/([a-z0-9][a-z0-9_-]{0,63})$/
export const receiptHeader = 'x-ov-web-source-url'
export const mediaHeader = 'x-ov-web-source-type'
export const byteLimits = { html: 64 * 1024, robots: 16 * 1024, git: 96 * 1024, rss: 64 * 1024,
  atom: 64 * 1024, feishu: 96 * 1024, tos: 96 * 1024, 'live-html': 64 * 1024 } as const
export const mediaTypes = { html: 'text/html', robots: 'text/plain', git: 'application/json', rss: 'application/rss+xml',
  atom: 'application/atom+xml', feishu: 'application/json', tos: 'application/json', 'live-html': 'text/html' } as const
export type SnapshotKind = keyof typeof byteLimits
type Pin = { id: string; sha256: string }
export type SnapshotRef = Pin & { url: string }
type Page = Omit<SnapshotRef, 'sha256'> & { sha256?: string; name: string }
type Site = { origin: string; robots: SnapshotRef; pages: Page[]; entry: string; name: string; explore: boolean; live?: true }
type Git = SnapshotRef & { file: string; name: string }
type SnapshotMode = 'html' | 'site' | 'git' | 'git-collection' | 'feed' | 'feishu' | 'tos'
export type WebMode = SnapshotMode | NativeMode
export type SnapshotSelection = { mode: 'html' | 'site'; page: Page; site: Site; name: string } |
  { mode: 'git'; git: Git; name: string } | { mode: 'git-collection'; files: Git[]; name: string } |
  { mode: 'feed'; kind: 'rss' | 'atom'; feed: SnapshotRef; name: string } |
  { mode: 'feishu' | 'tos'; archive: SnapshotRef; name: string }
export type WebSources = { has: (mode: WebMode) => boolean; hasNative: (mode: NativeMode) => boolean; hasProviderWatch: boolean;
  select: (mode: WebMode, key: string) => { binding: Fetcher; source: SnapshotSelection | NativeSelection; manifest?: string } | undefined }

const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const nonPublic = /(?:^|\.)(?:localhost|internal|local|lan|home|arpa|onion)(?:\.|$)/
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/
export const textName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,155}\.txt$/
export const folderName = /^[A-Za-z0-9_-][A-Za-z0-9_-]{0,159}$/

function documentUrl(raw: unknown, suffix: RegExp): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 1000 || /[?#]/.test(raw)) return
  let url: URL
  try { url = new URL(raw) } catch { return }
  if (url.href === raw && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.hostname.length <= 253 && host.test(url.hostname) && !nonPublic.test(url.hostname) &&
      url.pathname.slice(1).split('/').every(part => segment.test(part)) && suffix.test(url.pathname)) return url
}
export const htmlUrl = (raw: unknown) => documentUrl(raw, /\.html?$/i)
export const feedUrl = (raw: unknown) => documentUrl(raw, /\.(?:rss|atom|xml)$/i)

const keys = (value: unknown, names: string): value is Record<string, unknown> => {
  const list = names.split(' ')
  return isRecord(value) && Object.keys(value).length === list.length && list.every(name => Object.hasOwn(value, name))
}
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)
function pin(value: unknown, fields = 'id sha256'): Pin | undefined {
  if (keys(value, fields) && matches(value.id, snapshotId) && matches(value.sha256, /^[a-f0-9]{64}$/)) {
    return { id: value.id, sha256: value.sha256 }
  }
}

function siteRecord(value: unknown, live: boolean): Site | undefined {
  if (!keys(value, 'account entry name explore robots pages') || !isId(value.account) ||
      !matches(value.name, snapshotId) || typeof value.explore !== 'boolean' ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 24) return
  const entry = htmlUrl(value.entry), robots = pin(value.robots)
  if (!entry || !robots) return
  const pages: Page[] = []
  const names = new Set<string>(), urls = new Set<string>()
  for (const raw of value.pages) {
    const ref = live ? keys(raw, 'url id name') && matches(raw.id, snapshotId) && { id: raw.id } : pin(raw, 'url id sha256 name')
    if (!ref || !isRecord(raw) || !matches(raw.name, textName)) return
    const url = htmlUrl(raw.url)
    if (!url || url.origin !== entry.origin || urls.has(url.href) || names.has(raw.name)) return
    urls.add(url.href)
    names.add(raw.name)
    pages.push({ ...ref, url: url.href, name: raw.name })
  }
  if (!urls.has(entry.href)) return
  // Keep the serialized F4 plan for already-reserved snapshot tasks.
  return { origin: entry.origin, robots: { ...robots, url: entry.origin + '/robots.txt' }, pages,
    entry: entry.href, name: value.name, explore: value.explore, ...(live && { live: true }) }
}

function gitRecord(value: unknown): { alias: string; git: Git } | undefined {
  if (!keys(value, 'account alias collection sha256 repository revision file name') || !isId(value.account) ||
      !matches(value.alias, snapshotId) || !matches(value.collection, snapshotId) || !matches(value.sha256, /^[a-f0-9]{64}$/) ||
      !matches(value.revision, /^[a-f0-9]{40}$/) || !matches(value.name, textName) ||
      !matches(value.repository, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/) ||
      typeof value.file !== 'string' || value.file.length > 256 || !/\.(md|txt)$/i.test(value.file) ||
      !value.file.split('/').every(part => segment.test(part))) return
  // Receipt identity only, not a request destination. The collection ID is
  // resolved here; neither a repository URL nor a provider revision is client input.
  return { alias: value.alias, git: { id: value.collection, sha256: value.sha256, name: value.name, file: value.file,
    url: `https://api.github.com/repos/${value.repository}/contents/${value.file}?ref=${value.revision}` } }
}

function gitCollection(value: unknown): Extract<SnapshotSelection, { files: Git[] }> | undefined {
  if (!keys(value, 'account alias repository revision name files') || !isId(value.account) ||
      !matches(value.name, folderName) || !Array.isArray(value.files) || !value.files.length || value.files.length > 6) return
  const files: Git[] = []
  for (const record of value.files) {
    if (!keys(record, 'collection sha256 file name')) return
    const file = gitRecord({ ...record, account: value.account, alias: value.alias, repository: value.repository, revision: value.revision })?.git
    if (!file || files.some(other => other.file === file.file || other.id === file.id || other.name === file.name)) return
    files.push(file)
  }
  return { mode: 'git-collection', files, name: value.name }
}

function boundSnapshots(env: Env, account: string) {
  const binding = env.WEB_SOURCE
  const raw = env.OPENVIKING_EDGE_WEB_CATALOG
  if (typeof binding?.fetch !== 'function' || !raw || raw.length > 48 * 1024) return
  let config: unknown
  try { config = JSON.parse(raw) } catch { return }
  if (!isRecord(config)) return
  const v2 = config.version === 2
  if (!(v2 ? keys(config, 'version sites git live_sites feeds git_collections archives') :
      config.version === 1 && keys(config, 'version sites git'))) return
  const rows = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.length <= 32 && value.every(isRecord)
  const live = v2 ? config.live_sites : [], feeds = v2 ? config.feeds : []
  const collections = v2 ? config.git_collections : [], archives = v2 ? config.archives : []
  if (!rows(config.sites) || !rows(config.git) || !rows(live) || !rows(feeds) || !rows(collections) || !rows(archives)) return
  const modeMap = () => new Map<string, SnapshotSelection>()
  const modes: Record<SnapshotMode, Map<string, SnapshotSelection>> = { html: modeMap(), site: modeMap(), git: modeMap(),
    'git-collection': modeMap(), feed: modeMap(), feishu: modeMap(), tos: modeMap() }
  const bind = (accountId: unknown, key: string, source: SnapshotSelection) => {
    if (accountId !== account) return true
    const selected = modes[source.mode]
    if (selected.has(key)) return false
    selected.set(key, source)
    return true
  }
  for (const [items, mutable] of [[config.sites, false], [live, true]] as const) for (const rawSite of items) {
    const row = siteRecord(rawSite, mutable)
    if (!row) return
    for (const page of row.pages) {
      if (!bind(rawSite.account, page.url, { mode: 'html', page, site: row, name: page.name })) return
      if (row.explore && page.url === row.entry && !bind(rawSite.account, page.url, { mode: 'site', page, site: row, name: row.name })) return
    }
  }
  for (const rawGit of config.git) {
    const row = gitRecord(rawGit)
    if (!row) return
    if (!bind(rawGit.account, row.alias, { mode: 'git', git: row.git, name: row.git.name })) return
  }
  for (const raw of collections) {
    const row = gitCollection(raw)
    if (!row || typeof raw.alias !== 'string' || !bind(raw.account, raw.alias, row)) return
  }
  for (const raw of feeds) {
    const ref = pin(raw, 'account url id sha256 name kind'), url = feedUrl(raw.url)
    if (!ref || !url || !isId(raw.account) || !matches(raw.name, folderName) || (raw.kind !== 'rss' && raw.kind !== 'atom') ||
        !bind(raw.account, url.href, { mode: 'feed', kind: raw.kind, feed: { ...ref, url: url.href }, name: raw.name })) return
  }
  for (const raw of archives) {
    const ref = pin(raw, 'account alias id sha256 name kind')
    if (!ref || !isId(raw.account) || !matches(raw.alias, snapshotId) || !matches(raw.name, textName) ||
        (raw.kind !== 'feishu' && raw.kind !== 'tos')) return
    const archive = { ...ref, url: `${snapshotOrigin}/v1/${raw.kind}/${ref.id}` }
    if (!bind(raw.account, raw.alias, { mode: raw.kind, archive, name: raw.name })) return
  }
  const get = (mode: WebMode) => Object.hasOwn(modes, mode) ? modes[mode as SnapshotMode] : undefined
  return { binding, has: (mode: WebMode) => !!get(mode)?.size, select: (mode: WebMode, key: string) => get(mode)?.get(key) }
}

export function boundWebSources(env: Env, caller: Pick<Caller, 'accountId' | 'userId'>): WebSources | undefined {
  const snapshots = boundSnapshots(env, caller.accountId)
  const native = nativeCatalog(env.OPENVIKING_EDGE_WEB_NATIVE_CATALOG)
  const nativeBinding = env.WEB_NATIVE_SOURCE
  const mounted = typeof nativeBinding?.fetch === 'function' ? nativeBinding : undefined
  const rows = native?.rows.filter(row => row.account === caller.accountId && (!row.user || row.user === caller.userId)) ?? []
  if (!snapshots && !mounted) return
  const hasNative = (mode: NativeMode) => !!mounted && rows.some(row => row.plan.mode === mode)
  return {
    hasNative,
    hasProviderWatch: !!mounted && rows.some(row => row.watch && (env.OPENVIKING_EDGE_DOCUMENT_CONVERSION === '1' && !!env.AI ||
      !('objects' in row.plan ? row.plan.objects.some(item => item.object.root.binary) : 'root' in row.plan && row.plan.root.binary))),
    has: mode => snapshots?.has(mode) === true || hasNative(mode as NativeMode),
    select(mode, key) {
      const row = rows.find(row => row.key === key && row.plan.mode === mode)
      if (row) return mounted && { binding: mounted, manifest: env.OPENVIKING_EDGE_WEB_NATIVE_CATALOG, source: { ...row.plan, native: true, name: row.name,
        account: caller.accountId, user: caller.userId, revision: native!.revision, ...(row.watch && { watch: true }) } }
      const snapshot = snapshots?.select(mode, key)
      if (snapshots && snapshot) return { binding: snapshots.binding, source: snapshot }
    },
  }
}

/** Optional future internal preflight for Plans: an approval descriptor, not
 * a network probe. Consume only in a direct Data context with a live lease. */
export function approvedGitPreflight(sources: WebSources | undefined, alias: string, collection: boolean) {
  if (!snapshotId.test(alias)) return
  const selected = sources?.select(collection ? 'git-collection' : 'git', alias)?.source
  if (!selected || !('native' in selected) || !('files' in selected)) return
  return { alias, collection, revision: selected.revision, document_count: selected.files.length }
}
