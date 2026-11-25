// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, ok, readJson } from '../http.js'
import {
  JSON_LIMIT, MAX_DEPTH, ROOT, bool, choice, compare, conflict, inPath, int, invalid, linesOf, onlyKeys, parseTags, pathFor,
  relative, str, tagMatch, transport, unsupported,
} from './contract.js'
import type { ContextKind, FsPath } from './contract.js'
import { tagsOf, wireEntry } from './store.js'
import type { Filesystem, Entry } from './store.js'
import { cosine, queryVector } from './vectors.js'
import { sidecarLevel } from './indexing.js'
import { summaryText } from './analysis.js'
import { admitsFileLevels, readFileLevels } from './file-levels.js'
import type { FileLevel } from './file-levels.js'
import { portableFilter, timeBound } from './filters.js'
import type { SearchRecord } from './filters.js'
import { edgeSearchDefaults } from '../model-config.js'

const contextTypes = ['resource', 'memory', 'skill'] as const
const maxHits = 50
type Candidate = { entry: Entry; path: FsPath; record: SearchRecord; score: number; group?: string; fileLevel?: FileLevel }

function optionalList(value: unknown, label: string, max: number): unknown[] {
  if (value == null || value === '') return []
  const list: unknown[] = Array.isArray(value) ? value : [value]
  if (list.length > max) invalid(`Too many ${label} values.`)
  return list
}

function levels(value: unknown): number[] {
  return optionalList(typeof value === 'string' ? value.split(',') : value, 'level', 3).map(item => {
    if (typeof item === 'string' && /^[012]$/.test(item.trim())) item = Number(item)
    return int(item, 'level', -1, 0, 2)
  })
}

export function excerpt(text: string, cap: number): string {
  const end = (text.charCodeAt(cap) & 0xfc00) === 0xdc00 ? cap - 1 : cap
  return text.slice(0, end)
}

export async function semantic(fs: Filesystem, request: Request, search: boolean): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  const common = 'query image_url target_uri context_type limit node_limit score_threshold filter include_provenance tags since until time_field level read_content telemetry events_time_decay_protection'
  onlyKeys(body, search ? common + ' search_type session_id args mode query_expansion max_tokens quotas purpose detail dedup_turns exclude_uris peer_scope other_peer_penalty rewrite rewrite_max_bullets' : common)
  transport(body)
  if (body.image_url != null || body.events_time_decay_protection != null ||
      (search && (Object.keys(body).some(key => ['query_expansion', 'max_tokens', 'quotas', 'purpose', 'detail', 'dedup_turns',
        'exclude_uris', 'peer_scope', 'other_peer_penalty', 'rewrite', 'rewrite_max_bullets'].includes(key)) ||
         (body.search_type != null && body.search_type !== 'semantic') || (body.mode != null && body.mode !== 'list') || body.args != null))) {
    unsupported('Only text semantic and metadata-only list search is implemented here.')
  }
  const { query, hits, searched, eligible, sessionUsed } = await rankedHits(fs, body, undefined, request.signal)
  return ok({ memories: hits.filter(hit => hit.context_type === 'memory'), resources: hits.filter(hit => hit.context_type === 'resource'),
    skills: hits.filter(hit => hit.context_type === 'skill'), total: hits.length,
    ...(query && bool(body.include_provenance, 'include_provenance') && { provenance: [{ query, searched_directories: searched,
      matched_contexts: hits.map(({ uri, level, context_type, score, match_reason }) => ({ uri, tier: `L${level}`, context_type, score, match_reason })),
      thinking_trace: { statistics: { eligible_records: eligible, returned_records: hits.length,
        ...(sessionUsed > 0 && { session_messages_used: sessionUsed }) } },
    }] }) })
}

export async function rankedHits(fs: Filesystem, body: Record<string, unknown>, groupFor?: (path: FsPath) => string | undefined, signal?: AbortSignal) {
  const query = str(body.query, 'query', '', 1024).trim()
  const roots = optionalList(body.target_uri, 'target_uri', 8).map(uri => pathFor(uri, fs.caller))
  if (!roots.length) roots.push(pathFor(ROOT, fs.caller))
  const selected = optionalList(body.context_type, 'context_type', 3)
    .flatMap(item => str(item, 'context_type', undefined, 128).split(',').map(part => part.trim().toLowerCase()).filter(Boolean))
  if (selected.some(type => !contextTypes.includes(type as ContextKind))) invalid('Unknown context_type.')
  const requested = levels(body.level)
  const fallback = int(body.limit, 'limit', fs.ctx.defaultSearchLimit ?? edgeSearchDefaults.limit, 1, maxHits)
  const limit = int(body.node_limit ?? undefined, 'node_limit', fallback, 1, maxHits)
  const threshold = body.score_threshold ?? fs.ctx.defaultSearchScore ?? edgeSearchDefaults.score
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) invalid('score_threshold must be between -1 and 1.')
  const min: number = threshold
  const timeField = choice(body.time_field ?? undefined, 'time_field', ['created_at', 'updated_at'] as const, 'updated_at')
  const now = Date.now()
  const since = timeBound(body.since, 'since', now)
  const until = timeBound(body.until, 'until', now, true)
  if (since !== undefined && until !== undefined && since > until) invalid('since must not be after until.')
  const wanted = parseTags(body.tags)
  const filter = portableFilter(fs, body.filter, now)
  if (!query && !filter && !wanted.length && !selected.length && since === undefined && until === undefined) invalid('A nonempty query or metadata filter is required.')
  bool(body.include_provenance, 'include_provenance')
  const readContent = bool(body.read_content, 'read_content')
  const requestedSession = str(body.session_id ?? undefined, 'session_id', '', 128)
  if (requestedSession && !query) invalid('A text query is required when using session context.')
  const session = fs.ctx.useSearchSessionContext === false ? '' : requestedSession
  const sessionContext = () => {
    if (!fs.ctx.sessionSearchContext) unsupported('Session context is unavailable for this identity.')
    const result = fs.ctx.sessionSearchContext(session)
    if (typeof result?.text !== 'string' || result.text.length > 1024 || !Number.isSafeInteger(result.usedMessages) || result.usedMessages < 0) {
      throw new ApiError(503, 'SESSION_CONTEXT_UNAVAILABLE', 'The session retrieval context is invalid.')
    }
    return result
  }
  if (session) await fs.ctx.reauthorize?.()
  const history = session ? sessionContext() : undefined
  const context = history?.text.trim() ?? ''
  const vector = query ? await queryVector(fs.ctx, query, context) : undefined
  if (vector) await fs.ctx.reauthorize?.()
  const checkHistory = () => {
    if (!history) return
    const fresh = sessionContext()
    if (fresh.text !== history.text || fresh.usedMessages !== history.usedMessages) conflict('The session changed while searching; retry with its current context.')
  }
  checkHistory()

  const candidates: Candidate[] = []
  const seen = new Set<string>()
  let eligible = 0
  for (const root of roots) {
    for (const entry of fs.entries(root, true)) {
      if (entry.is_dir || !entry.dimensions || seen.has(entry.uri)) continue
      seen.add(entry.uri)
      const path = pathFor(entry.uri, fs.caller)
      if (selected.length && !selected.includes(path.kind)) continue
      const level = sidecarLevel(entry.uri)
      if (level === 2 && path.parts.at(-1)!.startsWith('.')) continue
      const group = groupFor?.(path)
      if (groupFor && !group) continue
      const category = path.kind === 'memory' && path.parts.length > 4 ? path.parts[3] : ''
      function add(logical: Entry, hitLevel: number, bytes: number, scoreForVector: () => number, fileLevel?: FileLevel) {
        if ((since !== undefined && logical[timeField] < since) || (until !== undefined && logical[timeField] > until)) return
        const record: SearchRecord = { uri: logical.uri, context_type: path.kind, level: hitLevel, category,
          search_tags: tagsOf(logical), size: bytes, created_at: logical.created_at, updated_at: logical.updated_at }
        if (!tagMatch(record.search_tags, wanted) || filter && !filter(record)) return
        eligible++
        const score = vector ? scoreForVector() : 0
        if (!vector || score >= min) candidates.push({ entry, path, record, score, group, fileLevel })
      }
      // Keep the historical default ranking/hit count. An explicit level
      // selection reads the document's own derived records (no new viking URI).
      if (level === 2 && admitsFileLevels(path) && (requested.includes(0) || requested.includes(1)) &&
          fs.acl.allows(fs.parent(path), 'read')) {
        for (const item of readFileLevels(fs, path)) if (requested.includes(item.level)) {
          add(entry, item.level, item.bytes, () => cosine(vector!, item.vectors, item.dimensions), item.level)
        }
      }
      if (requested.length && !requested.includes(level)) continue
      let logical = entry
      if (level !== 2) {
        const parent = fs.parent(path)
        if (!fs.acl.allows(parent, 'read')) continue
        const directory = fs.entry(parent)
        if (!directory?.is_dir) continue
        logical = directory
      }
      add(logical, level, entry.bytes, () => cosine(vector!, fs.vector(path), entry.dimensions))
    }
  }
  const grouped = new Set<string>()
  let ranked = candidates.sort((a, b) => b.score - a.score || (!vector ? b.record.updated_at - a.record.updated_at : 0) ||
    compare(a.entry.uri, b.entry.uri) || a.record.level - b.record.level).filter(item => {
    if (!item.group) return true
    if (grouped.has(item.group)) return false
    grouped.add(item.group)
    return true
  })
  const textFor = ({ path, fileLevel }: Pick<Candidate, 'path' | 'fileLevel'>) => {
    if (fileLevel === undefined) return fs.content(path).body
    return readFileLevels(fs, path, fileLevel)[0]?.body ?? conflict('The indexed file level no longer exists.')
  }
  const reranker = signal && vector && ranked.length ? fs.ctx.searchReranker : undefined
  if (reranker && signal) {
    const shortlist = ranked.slice(0, maxHits)
    const documents = shortlist.map(textFor)
    const scores = await reranker.score(query, documents, signal)
    await fs.ctx.reauthorize?.()
    fs.ctx.assertActive?.()
    checkHistory()
    // Provider ranking is bound to the readable bytes in the shortlist, not to
    // whatever may occupy the URI after returning from HTTP.
    for (const [i, item] of shortlist.entries()) {
      const current = fs.previewEntry(item.path)
      if (current?.revision !== item.entry.revision || (item.record.level < 2 && !fs.acl.allows(fs.parent(item.path), 'read')) ||
          (item.fileLevel !== undefined && textFor(item) !== documents[i])) {
        conflict('The ranked candidates changed while searching; retry with current content and permissions.')
      }
    }
    ranked = shortlist.map((item, index) => ({ ...item, score: scores[index] }))
      .filter(item => item.score > reranker.threshold).sort((a, b) => b.score - a.score)
  }
  ranked = ranked.slice(0, limit)
  const hits = ranked.map(({ entry, path, record, score, fileLevel }) => {
    const text = textFor({ path, fileLevel })
    return { uri: vector ? entry.uri : record.uri, context_type: path.kind, level: record.level, score,
      abstract: excerpt(record.level < 2 ? summaryText(text) : text, 256),
      overview: null, category: record.category, match_reason: reranker ? 'provider_rerank' : vector ? (context ? 'cosine_similarity_session' : 'cosine_similarity') : 'metadata_filter', tags: record.search_tags,
      ...(readContent && { content: text }) }
  })
  const searched = [...new Set(roots.filter(root => fs.previewEntry(root)?.is_dir).map(root => root.uri))]
  return { query, hits, searched, eligible, sessionUsed: context ? history!.usedMessages : 0 }
}

function patternScope(fs: Filesystem, body: Record<string, unknown>, defaultRoot?: string) {
  const path = pathFor(body.uri ?? defaultRoot, fs.caller)
  const limit = int(body.node_limit ?? undefined, 'node_limit', 256, 1, 256)
  const tags = parseTags(body.tags)
  const include = bool(body.include_tags, 'include_tags')
  const entries = fs.entries(path).filter(entry =>
    !relative(entry.uri, path.uri).split('/').some(part => part.startsWith('.') && entry.uri !== path.uri) &&
    tagMatch(tagsOf(entry), tags)).sort((a, b) => compare(a.uri, b.uri))
  return { path, entries, limit, include }
}

function linePattern(input: unknown, insensitive: boolean): RegExp {
  const pattern = str(input, 'pattern', undefined, 128)
  if (!pattern || /[\r\n]/.test(pattern)) invalid('A nonempty single-line grep pattern is required.')
  // Admit only bounded-width constructs. No groups, alternation, repetitions or lookaround.
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      const escaped = pattern[++i]
      if (!escaped || !'\\.^$*+?()[]{}|'.includes(escaped)) unsupported('grep supports literals, escaped punctuation, dot and line anchors only.')
    } else if ('*+?()[]{}|'.includes(char)) {
      unsupported('grep supports literals, escaped punctuation, dot and line anchors only.')
    }
  }
  return new RegExp(pattern, insensitive ? 'iu' : 'u')
}

export async function grep(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri exclude_uri pattern case_insensitive node_limit level_limit tags include_tags before_context after_context')
  const { path, entries, limit, include } = patternScope(fs, body)
  const matcher = linePattern(body.pattern, bool(body.case_insensitive, 'case_insensitive'))
  const exclude = body.exclude_uri == null || body.exclude_uri === '' ? undefined : pathFor(body.exclude_uri, fs.caller)
  const depth = int(body.level_limit, 'level_limit', 10, 0, MAX_DEPTH)
  const before = int(body.before_context, 'before_context', 0, 0, 5)
  const after = int(body.after_context, 'after_context', 0, 0, 5)
  const matches: Array<Record<string, unknown>> = []
  let bytes = 0
  let filesScanned = 0
  let capped = false
  // Bound work as well as result size. Pattern complexity is fixed-width by construction.
  const scanBudget = 2 * 1024 * 1024
  scan: for (const entry of entries) {
    if (entry.is_dir || (exclude && inPath(entry.uri, exclude.uri))) continue
    if (entry.uri !== path.uri && relative(entry.uri, path.uri).split('/').length > depth) continue
    if (bytes + entry.bytes > scanBudget) { capped = true; break }
    bytes += entry.bytes
    filesScanned++
    const target = pathFor(entry.uri, fs.caller)
    const lines = linesOf(fs.content(target).body).map(line => line.replace(/\r\n$|[\r\n]$/g, ''))
    for (let i = 0; i < lines.length; i++) {
      if (!matcher.test(lines[i])) continue
      if (matches.length >= limit) { capped = true; break scan }
      const context = (start: number, end: number) => lines.slice(start, end)
        .map((line, offset) => ({ line: start + offset + 1, content: excerpt(line, 256) }))
      matches.push({ uri: entry.uri, line: i + 1, content: excerpt(lines[i], 4096),
        ...(before > 0 && { before_context: context(Math.max(0, i - before), i) }),
        ...(after > 0 && { after_context: context(i + 1, i + 1 + after) }),
        ...(include && { tags: tagsOf(entry) }) })
    }
  }
  return ok({ matches, count: matches.length, match_count: matches.length, files_scanned: filesScanned, limit_reached: capped })
}

// Greedy wildcard with a single retry point; matching is bounded by the pattern and segment sizes.
function component(pattern: string[], name: string): boolean {
  const chars = Array.from(name)
  let p = 0, c = 0, star = -1, retry = 0
  while (c < chars.length) {
    if (pattern[p] === '*') { star = p++; retry = c }
    else if (pattern[p] === '?' || pattern[p] === chars[c]) { p++; c++ }
    else if (star >= 0) { p = star + 1; c = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}

function globPattern(input: unknown): (path: string) => boolean {
  const pattern = str(input, 'pattern', undefined, 256)
  const parts = pattern.split('/')
  if (!pattern || parts.length > MAX_DEPTH || parts.some(part => !part || part === '.' || part === '..') ||
      /[\\:\p{Cc}\p{Cf}]/u.test(pattern)) invalid('Expected a relative glob pattern.')
  if (/[\[\]{}]/.test(pattern)) unsupported('Glob supports *, ?, and ** segments only.')
  const tokens = parts.map(part => Array.from(part.normalize('NFC')))
  return (path: string) => {
    const components = path.split('/')
    let row = new Array<boolean>(components.length + 1).fill(false)
    row[0] = true
    for (let p = 0; p < parts.length; p++) {
      const next = new Array<boolean>(components.length + 1).fill(false)
      if (parts[p] === '**') next[0] = row[0]
      for (let c = 1; c <= components.length; c++) {
        next[c] = parts[p] === '**' ? (row[c] || next[c - 1]) : (row[c - 1] && component(tokens[p], components[c - 1]))
      }
      row = next
    }
    return row[components.length]
  }
}

export async function glob(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri pattern node_limit extra_fields tags include_tags')
  const { path, entries, limit, include } = patternScope(fs, body, ROOT)
  const matcher = globPattern(body.pattern)
  if (body.extra_fields != null && (!Array.isArray(body.extra_fields) || body.extra_fields.length)) {
    unsupported('Additional glob entry fields are not implemented.')
  }
  const matches = entries.filter(entry => (entry.uri !== path.uri || !entry.is_dir) && matcher(relative(entry.uri, path.uri)))
  return ok({ matches: matches.slice(0, limit).map(entry =>
    include || body.extra_fields != null ? wireEntry(entry, path.uri, include) : entry.uri + (entry.is_dir ? '/' : '')),
  count: Math.min(matches.length, limit), limit_reached: matches.length > limit })
}
