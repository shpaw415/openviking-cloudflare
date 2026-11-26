// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, isRecord } from '../http.js'
import { ROOT, bool, choice, compare, conflict, encoder, inPath, int, invalid, pathFor, unsupported } from './contract.js'
import type { FsPath } from './contract.js'
import { summaryText } from './analysis.js'
import { admitsFileLevels, readFileLevels } from './file-levels.js'
import type { Filesystem } from './store.js'
import type { SearchCandidate } from './search.js'
import { pinSource } from './search-ledger.js'
import type { ContextPins } from './search-ledger.js'

const memoryBuckets = ['events', 'entities', 'preferences', 'experiences'] as const
const buckets = [...memoryBuckets, 'resources', 'skills'] as const
type Bucket = typeof buckets[number]
type Category = Bucket | 'memories'
const tiers = ['abstract', 'overview', 'full'] as const
type Detail = typeof tiers[number]
type Tier = Detail | 'uri'
const purposes = {
  chat: { events: 3, entities: 3, preferences: 1, experiences: 1, resources: 1, skills: 1 },
  coding: { events: 1, entities: 2, preferences: 1, experiences: 1, resources: 3, skills: 2 },
}
type Entry = { uri: string; category: Category; score: number; detail: Tier; text: string; origin: 'self' }

export function contextOptions(fs: Filesystem, body: Record<string, unknown>) {
  if (body.target_uri != null || bool(body.read_content, 'read_content') || body.args != null) {
    invalid('target_uri, read_content and args are only supported in list mode.')
  }
  if (body.image_url != null || body.events_time_decay_protection != null ||
      (body.search_type != null && body.search_type !== 'semantic' && body.search_type !== 'keywords')) {
    unsupported('Context assembly supports text and metadata search only.')
  }
  const dedup = int(body.dedup_turns ?? undefined, 'dedup_turns', 0, 0, 100)
  const peerScope = choice(body.peer_scope ?? undefined, 'peer_scope', ['actor', 'all'], 'all')
  if (body.rewrite !== undefined && body.rewrite !== false && body.rewrite !== true && body.rewrite !== 'auto') invalid('Invalid rewrite mode.')
  const maxBullets = int(body.rewrite_max_bullets ?? undefined, 'rewrite_max_bullets', 6, 1, 20)
  const rewrite = body.rewrite === true ? 'required' : body.rewrite === 'auto' ? 'auto' : 'off'
  if (body.other_peer_penalty != null) unsupported('Scoring other peers is unavailable in this Edge workspace.')
  const expansion = choice(body.query_expansion ?? undefined, 'query_expansion', ['off', 'auto'], 'off') === 'auto'
  const maxTokens = int(body.max_tokens ?? undefined, 'max_tokens', 1600, 64, 32_000)
  const purpose = body.purpose == null ? null : choice(body.purpose, 'purpose', ['chat', 'coding'], 'chat')
  let quotas: Partial<Record<Bucket, number>> | null = purpose ? purposes[purpose] : null
  if (body.quotas != null) {
    if (!isRecord(body.quotas)) invalid('quotas must be an object.')
    const values = body.quotas
    if (Object.keys(values).some(key => !buckets.includes(key as Bucket))) invalid('Unknown quota category.')
    quotas = Object.fromEntries(buckets.filter(key => Object.hasOwn(values, key)).map(key => [key, int(values[key], 'quota', 0, 0, 50)]))
  }
  const width = quotas ? Object.values(quotas).reduce((sum, quota) => sum + quota, 0) : undefined
  if (width !== undefined && width > 50) invalid('Combined category quotas cannot exceed 50.')
  const tiersByCategory = new Map<Category, Detail>()
  let detail: Detail | null = null
  if (isRecord(body.detail)) {
    for (const [key, value] of Object.entries(body.detail)) {
      if (key !== 'memories' && !buckets.includes(key as Bucket)) invalid('Unknown detail category.')
      tiersByCategory.set(key as Category, choice(value, 'detail tier', tiers, 'abstract'))
    }
  } else if (body.detail != null && body.detail !== 'auto') {
    detail = choice(body.detail, 'detail', tiers, 'abstract')
  }
  if (body.exclude_uris != null && (!Array.isArray(body.exclude_uris) || body.exclude_uris.length > 200)) invalid('Expected up to 200 exclude_uris.')
  const excluded = Array.isArray(body.exclude_uris) ? body.exclude_uris.map(uri => pathFor(uri, fs.caller).uri) : []
  const ignored = [...(body.level != null ? ['level'] : []), ...(quotas && (body.limit != null || body.node_limit != null) ? ['limit'] : [])]
  return { quotas, width, expansion, maxTokens, detail, tiersByCategory, excluded, ignored, peerScope, purpose, dedup, rewrite, maxBullets }
}

type Options = ReturnType<typeof contextOptions>

function category(path: FsPath): Category {
  if (path.kind !== 'memory') return path.kind === 'skill' ? 'skills' : 'resources'
  const folder = path.parts[3]
  return memoryBuckets.includes(folder as typeof memoryBuckets[number]) ? folder as Category : 'memories'
}

function logicalUri(fs: Filesystem, path: FsPath, level: number) {
  if (path.kind === 'skill') return `${ROOT}${path.parts.slice(0, path.parts[0] === 'agent' ? 3 : 4).join('/')}/SKILL.md`
  return level < 2 ? fs.parent(path).uri : path.uri
}

export function contextSource(fs: Filesystem, path: FsPath, level: number, options: Options) {
  const [, , root, name] = path.parts
  // Never let context discovery pull in hidden state (sessions, privacy,
  // peers, tools), or infer category/ownership from an arbitrary string.
  if (path.parts[0] === 'user' && (!['memories', 'resources', 'skills'].includes(root) ||
      path.parts.length < 4 || (root === 'memories' && name === 'profile.md'))) return false
  if (path.parts[0] === 'agent' && path.parts[1] !== 'skills') return false
  if (level < 2 && path.kind !== 'skill' && path.parts.length <= (path.parts[0] === 'resources' ? 2 : 4)) return false
  const kind = category(path)
  if (options.quotas && (kind === 'memories' || !options.quotas[kind])) return false
  const logical = logicalUri(fs, path, level)
  if (path.kind === 'skill' && (encoder.encode(logical).byteLength > 1024 || fs.previewEntry(fs.path(logical))?.is_dir !== 0)) return false
  return !options.excluded.some(exclusion => inPath(logical, exclusion) || inPath(path.uri, exclusion))
}

function select(fs: Filesystem, ranked: readonly SearchCandidate[], options: Options, limit: number) {
  const seen = new Set<string>(), first = [], spare = []
  const counts = new Map<Category, number>()
  const width = options.width ?? limit
  if (width === 0) return []
  for (const hit of ranked) {
    const uri = logicalUri(fs, hit.path, hit.record.level)
    if (seen.has(uri)) continue
    seen.add(uri)
    const kind = category(hit.path)
    const item = { uri, kind, hit }
    const count = counts.get(kind) ?? 0
    if (!options.quotas || (kind !== 'memories' && count < (options.quotas[kind] ?? 0))) {
      counts.set(kind, count + 1)
      first.push(item)
    } else if (spare.length < width) spare.push(item)
    if (first.length === width) break
  }
  return [...first, ...spare.slice(0, width - first.length)].sort((a, b) => b.hit.score - a.hit.score || compare(a.uri, b.uri))
}

const prefix = (text: string, limit: number) => text.slice(0, /[\udc00-\udfff]/u.test(text[limit] ?? '') ? limit - 1 : limit)
const attr = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
const render = (entry: Entry) => {
  const head = `<memory uri="${attr(entry.uri)}" type="${entry.category}" score="${entry.score.toFixed(2)}" detail="${entry.detail}"`
  return entry.text ? `${head}>\n${entry.text.replace(/<(\/?)(memory)(?=[\s/>])/giu, '<\\$1$2')}\n</memory>` : `${head} />`
}

// Same quarter-token approximation as the pin, not model-specific accounting.
function tokens(text: string) {
  let units = 0
  for (const char of text) {
    const cp = char.codePointAt(0)!
    const wide = cp >= 0x1100 && (cp <= 0x11ff || cp >= 0x3000 && cp <= 0x30ff || cp >= 0x3130 && cp <= 0x318f ||
      cp >= 0x31f0 && cp <= 0x31ff || cp >= 0x3400 && cp <= 0x4dbf || cp >= 0x4e00 && cp <= 0x9fff ||
      cp >= 0xac00 && cp <= 0xd7af || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff00 && cp <= 0xffef || cp >= 0x20000 && cp <= 0x2ebef)
    units += wide ? 6 : cp > 0xffff ? 8 : 1
  }
  return Math.ceil(units / 4)
}

function overview(text: string, kind: Category) {
  if (kind === 'events') {
    const summary = /^#{1,3}[ \t]+Summary[ \t]*\r?\n([\s\S]*?)(?=^#{1,3}[ \t]|(?![\s\S]))/imu.exec(text)?.[1].trim()
    if (summary) return prefix(summary, 2048)
  }
  const headings = [...text.matchAll(/^#{1,3}[ \t]+[^\r\n]+/gmu)].slice(0, 24).map(match => prefix(match[0], 120)).join('\n')
  const paragraph = text.split(/\r?\n\s*\r?\n/u).map(block => block.split(/\r?\n/u).filter(line => !line.trimStart().startsWith('#')).join('\n').trim()).find(Boolean)
  return [headings, paragraph && prefix(paragraph, 400)].filter(Boolean).join('\n\n')
}

function projection(fs: Filesystem, { uri, kind, hit }: ReturnType<typeof select>[number], options: Options, trackSources: boolean) {
    const path = fs.path(uri), pins: ContextPins = []
    const preview = (at: FsPath) => trackSources ? pinSource(fs, pins, at.uri) : fs.previewEntry(at)
    // All projections (including package/sidecar reads) retain current ACL.
    const node = preview(path)
    if (!node) return
    if (trackSources && (hit.path.uri === uri ? node : preview(hit.path))?.revision !== hit.entry.revision) {
      conflict('The selected ranking source changed while assembling context; retry.')
    }
    const base = { uri, category: kind, score: hit.score, origin: 'self' as const }
    const sidecarText = (directory: FsPath, name: string) => {
      const uri = `${directory.uri}/${name}`
      if (encoder.encode(uri).byteLength > 1024 || options.excluded.some(exclusion => inPath(uri, exclusion))) return ''
      const sidecar = fs.path(uri)
      const node = fs.previewEntry(sidecar)
      if (node?.is_dir !== 0 || node.derived_from && options.excluded.some(exclusion => inPath(node.derived_from!, exclusion))) return ''
      preview(sidecar)
      return summaryText(fs.content(sidecar).body).trim()
    }
    let raw: string | undefined
    const file = () => {
      if (raw !== undefined) return raw
      const body = fs.content(path).body
      return raw = (kind === 'skills' ? summaryText(body) : kind === 'resources' ? body :
        body.split(/\n[ \t]*<!--[ \t]*MEMORY_FIELDS\b/u, 1)[0]).trim()
    }
    const textFor = (tier: Tier) => {
      if (tier === 'uri') return ''
      if (node.is_dir) return tier === 'full' ? '' : sidecarText(path, tier === 'overview' ? '.overview.md' : '.abstract.md')
      if (kind === 'skills' && tier !== 'full') return sidecarText(fs.parent(path), tier === 'overview' ? '.overview.md' : '.abstract.md')
      if (tier === 'full') return file()
      const parent = fs.parent(path)
      const derived = admitsFileLevels(path) && fs.acl.allows(parent, 'read')
        ? readFileLevels(fs, path, tier === 'overview' ? 1 : 0)[0]?.body.trim() : undefined
      if (derived && trackSources && !parent.builtin) preview(parent)
      return derived || (tier === 'overview' ? overview(file(), kind) : kind === 'resources' ? '' : prefix(file(), 256))
    }
    return { pins, base, textFor, bytes: node.bytes }
}

/** The configured reranker gets only the safe abstract surface, never raw
 * resource/skill text as a substitute for an absent generated abstract. */
export function rerankContextPool(fs: Filesystem, ranked: SearchCandidate[], options: Options, limit: number) {
  const doubled = options.quotas && Object.fromEntries(Object.entries(options.quotas).map(([key, n]) => [key, n * 2]))
  const width = Math.min(50, (options.width ?? limit) * 2)
  const pool = select(fs, ranked, { ...options, quotas: doubled, width }, limit)
  return pool.flatMap(candidate => {
    const source = projection(fs, candidate, options, true)
    const text = source?.textFor('abstract')
    return text ? [{ ...candidate, text, pins: source!.pins }] : []
  })
}

export function assembleContext(fs: Filesystem, ranked: readonly SearchCandidate[], options: Options, limit: number, expansion: string,
  trackSources: boolean) {
  fs.ctx.assertActive?.()
  const candidates = select(fs, ranked, options, limit)
  const perEntry = Math.max(1, Math.floor(options.maxTokens / Math.max(1, candidates.length)) * 2)
  const slots: Array<{ entry: Entry; cost: number; source: NonNullable<ReturnType<typeof projection>>; ceiling: Tier }> = []
  const seen = new Set<string>()
  let used = 0, dropped = 0, deduped = 0
  for (const candidate of candidates) {
    const { kind } = candidate
    const source = projection(fs, candidate, options, trackSources)
    if (!source) continue
    const pin = options.tiersByCategory.get(kind) ?? options.tiersByCategory.get(kind !== 'resources' && kind !== 'skills' ? 'memories' : kind) ?? options.detail
    const cap = pin ?? (kind === 'events' ? 'overview' : 'abstract')
    const ceiling = !pin && kind === 'events' ? 'full' : cap
    const order: Tier[] = cap === 'full' ? ['full', 'overview', 'abstract', 'uri'] : cap === 'overview' ? ['overview', 'abstract', 'uri'] : ['abstract', 'uri']
    let placed = false
    for (const tier of order) {
      if (tier === 'full' && source.bytes > perEntry * 8) continue
      const text = source.textFor(tier)
      if (!text && tier !== 'uri') continue
      const entry = { ...source.base, detail: tier, text }
      const cost = tokens(render(entry)), separator = slots.length ? 1 : 0
      if ((tier !== 'uri' && cost > perEntry) || used + cost + separator > options.maxTokens) continue
      if (text && seen.has(text)) { deduped++; placed = true; break }
      if (text) seen.add(text)
      slots.push({ entry, source, cost, ceiling })
      used += cost + separator
      placed = true
      break
    }
    if (!placed) dropped++
  }
  const floor = used, depth: Tier[] = ['uri', ...tiers]
  const upgrade = (tier: Detail, cap: boolean) => {
    let count = 0
    for (const slot of slots) {
      if (depth.indexOf(tier) <= depth.indexOf(slot.entry.detail) || depth.indexOf(tier) > depth.indexOf(slot.ceiling)) continue
      if (tier === 'full' && slot.source.bytes > options.maxTokens * 8) continue
      const text = slot.source.textFor(tier)
      if (!text || text !== slot.entry.text && seen.has(text)) continue
      const entry = { ...slot.entry, detail: tier, text }
      const cost = tokens(render(entry))
      if (cap && cost > perEntry || used - slot.cost + cost > options.maxTokens) continue
      seen.delete(slot.entry.text)
      seen.add(text)
      used += cost - slot.cost
      slot.entry = entry
      slot.cost = cost
      count++
    }
    return count
  }
  const overviewUpgrades = upgrade('overview', true), fullUpgrades = upgrade('full', true)
  const spare = upgrade('full', false) + upgrade('abstract', false) + upgrade('overview', false)
  const entries = slots.map(slot => slot.entry), fragments = entries.map(render)
  const projections = slots.map(slot => slot.source.pins)
  const sources = trackSources ? slots.filter(slot => slot.entry.text).map(slot => ({ uri: slot.entry.uri, pins: slot.source.pins })) : []
  const tierCounts: Partial<Record<Tier, number>> = {}
  for (const { detail } of entries) tierCounts[detail] = (tierCounts[detail] ?? 0) + 1
  const result = { entries, rendered: fragments.join('\n'), digest: '', stats: {
    max_tokens: options.maxTokens, used_tokens: used, per_entry_cap: perEntry, returned: entries.length, dropped, deduped,
    fill: { floor_tokens: floor, overview_upgrades: overviewUpgrades, full_upgrades: fullUpgrades, spare_upgrades: spare },
    candidates: candidates.length, tier_counts: tierCounts, purpose: options.purpose, quotas: options.quotas,
    detail: options.tiersByCategory.size ? Object.fromEntries(options.tiersByCategory) : options.detail,
    origins: { actor_peer: 0, self: entries.length, other_peer: 0 }, peer_scope: options.peerScope, query_expansion: expansion, rewrite: 'off',
    ...(options.ignored.length && { ignored: options.ignored }),
  } }
  return { result, sources, projections }
}

export async function planQueries(ctx: WorkspaceContext, query: string, check: () => Promise<void>, signal?: AbortSignal) {
  const queries = [query]
  if (!ctx.searchQueryGeneration) return { queries, status: 'off' }
  const raw = await ctx.searchQueryGeneration(query, signal).catch(error => {
    if (error instanceof ApiError && ['GENERATION_UNAVAILABLE', 'GENERATION_TIMEOUT'].includes(error.code)) return null
    throw error
  })
  await check()
  if (raw === undefined) return { queries, status: 'off' }
  if (!raw) return { queries, status: 'failed' }
  let data: unknown
  if (raw.length <= 2048) try { data = JSON.parse(raw) } catch { /* fail closed to original query */ }
  if (!isRecord(data) || Object.keys(data).length !== 1 || !Array.isArray(data.queries) || data.queries.length > 2 ||
      data.queries.some(term => typeof term !== 'string' || !term.trim() || term.length > 200 || !/^[\p{L}\p{N}\p{M}\p{Zs}'’-]+$/u.test(term))) {
    return { queries, status: 'failed' }
  }
  for (const value of data.queries) {
    const term = value.trim()
    if (!queries.includes(term)) queries.push(term)
  }
  return { queries, status: queries.length > 1 ? 'used' : 'off' }
}

export async function rewriteContext(ctx: WorkspaceContext, query: string, entries: Entry[], options: Options,
  check: () => Promise<void>, checkSelection: () => void, signal?: AbortSignal) {
  const generate = ctx.searchDigestGeneration
  let digest = '', status = 'off'
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null
  if (options.rewrite === 'off' || !generate) return { digest, status, usage }
  const readable = entries.filter(entry => entry.text)
  if (!readable.length) return { digest, status: 'empty', usage }
  const data = { query, rendered: readable.map(render).join('\n'), max_bullets: options.maxBullets }
  // Do not silently truncate/project a second, differently authorized input.
  if (encoder.encode(JSON.stringify(data)).byteLength > 48_000) return { digest, status: 'failed', usage }
  const result = await generate(data, Math.min(options.maxTokens, 2048), checkSelection, signal).catch(error => {
    if (!(error instanceof ApiError)) throw error
    if (error.code === 'GENERATION_TIMEOUT') status = 'timeout'
    else if (error.code === 'GENERATION_UNAVAILABLE') status = 'failed'
    else throw error
  })
  await check()
  checkSelection()
  if (!result) return { digest, status: status === 'off' ? 'failed' : status, usage }
  if (result.inputTokens !== null && result.outputTokens !== null) {
    usage = { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens }
  }
  const raw = result.text.trim()
  if (/^NO_RELEVANT_MEMORY$/iu.test(raw)) return { digest, status: 'no_relevant', usage }
  const allowed = new Set(readable.map(entry => entry.uri))
  const bullets = new Set<string>()
  for (const line of raw.split(/\r?\n/u)) {
    const bullet = line.trim().replace(/^\*\s+/u, '- ')
    if (!/^-\s+/u.test(bullet) || bullet.length > 500 || /[<>\p{Cc}\p{Cf}]|(?:https?|ftp|data|javascript):/iu.test(bullet)) continue
    const citations = bullet.match(/viking:\/\/[^\s<>"')\]]+/gu) ?? []
    if (!citations.length || citations.some(uri => !allowed.has(uri))) continue
    const next = [...bullets, bullet]
    if (tokens(`OpenViking memory digest:\n${next.join('\n')}`) > options.maxTokens) continue
    bullets.add(bullet)
    if (bullets.size === options.maxBullets) break
  }
  if (bullets.size) digest = `OpenViking memory digest:\n${[...bullets].join('\n')}`
  return { digest, status: digest ? 'ok' : 'failed', usage }
}

export { logicalUri as contextResultUri }
