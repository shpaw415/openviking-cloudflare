// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from '../context.js'
import { isId } from '../control/input.js'
import { isRecord } from '../http.js'

export const snapshotOrigin = 'https://web-source.invalid'
export const snapshotId = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const snapshotRoute = /^\/v1\/(html|robots|git)\/([a-z0-9][a-z0-9_-]{0,63})$/
export const receiptHeader = 'x-ov-web-source-url'
export const mediaHeader = 'x-ov-web-source-type'
export const byteLimits = { html: 64 * 1024, robots: 16 * 1024, git: 96 * 1024 } as const
export const mediaTypes = { html: 'text/html', robots: 'text/plain', git: 'application/json' } as const
export type SnapshotKind = keyof typeof byteLimits
type Pin = { id: string; sha256: string }
export type SnapshotRef = Pin & { url: string }
type Page = SnapshotRef & { name: string }
type Site = { origin: string; robots: SnapshotRef; pages: Page[]; entry: string; name: string; explore: boolean }
type Git = SnapshotRef & { file: string; name: string }
export type WebMode = 'html' | 'site' | 'git'
export type WebSelection = { mode: 'html' | 'site'; page: Page; site: Site; name: string } | { mode: 'git'; git: Git; name: string }
export type WebSources = { binding: Fetcher; has: (mode: WebMode) => boolean; select: (mode: WebMode, key: string) => WebSelection | undefined }

const host = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const nonPublic = /(?:^|\.)(?:localhost|internal|local|lan|home|arpa|onion)(?:\.|$)/
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/
export const textName = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,155}\.txt$/
export const folderName = /^[A-Za-z0-9_-][A-Za-z0-9_-]{0,159}$/

export function htmlUrl(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > 1000 || /[?#]/.test(raw)) return
  let url: URL
  try { url = new URL(raw) } catch { return }
  if (url.href === raw && url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      url.hostname.length <= 253 && host.test(url.hostname) && !nonPublic.test(url.hostname) &&
      url.pathname.slice(1).split('/').every(part => segment.test(part)) && /\.html?$/i.test(url.pathname)) return url
}

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

function siteRecord(value: unknown): Site | undefined {
  if (!keys(value, 'account entry name explore robots pages') || !isId(value.account) ||
      !matches(value.name, snapshotId) || typeof value.explore !== 'boolean' ||
      !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 24) return
  const entry = htmlUrl(value.entry), robots = pin(value.robots)
  if (!entry || !robots) return
  const pages: Page[] = []
  const names = new Set<string>(), urls = new Set<string>()
  for (const raw of value.pages) {
    const pinned = pin(raw, 'url id sha256 name')
    if (!pinned || !isRecord(raw) || !matches(raw.name, textName)) return
    const url = htmlUrl(raw.url)
    if (!url || url.origin !== entry.origin || urls.has(url.href) || names.has(raw.name)) return
    urls.add(url.href)
    names.add(raw.name)
    pages.push({ ...pinned, url: url.href, name: raw.name })
  }
  if (!urls.has(entry.href)) return
  return { origin: entry.origin, robots: { ...robots, url: entry.origin + '/robots.txt' }, pages,
    entry: entry.href, name: value.name, explore: value.explore }
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

export function boundWebSources(env: Env, account: string): WebSources | undefined {
  const binding = env.WEB_SOURCE
  const raw = env.OPENVIKING_EDGE_WEB_CATALOG
  if (typeof binding?.fetch !== 'function' || !raw || raw.length > 48 * 1024) return
  let config: unknown
  try { config = JSON.parse(raw) } catch { return }
  if (!keys(config, 'version sites git') || config.version !== 1 || !Array.isArray(config.sites) || config.sites.length > 32 ||
      !Array.isArray(config.git) || config.git.length > 32) return
  const html = new Map<string, WebSelection>(), site = new Map<string, WebSelection>(), git = new Map<string, WebSelection>()
  for (const rawSite of config.sites) {
    const row = siteRecord(rawSite)
    if (!row) return
    if (rawSite.account !== account) continue
    for (const page of row.pages) {
      if (html.has(page.url)) return
      html.set(page.url, { mode: 'html', page, site: row, name: page.name })
      if (row.explore && page.url === row.entry) site.set(page.url, { mode: 'site', page, site: row, name: row.name })
    }
  }
  for (const rawGit of config.git) {
    const row = gitRecord(rawGit)
    if (!row) return
    if (rawGit.account !== account) continue
    if (git.has(row.alias)) return
    git.set(row.alias, { mode: 'git', git: row.git, name: row.git.name })
  }
  const modes = { html, site, git }
  return { binding, has: mode => modes[mode].size > 0, select: (mode, key) => modes[mode].get(key) }
}
