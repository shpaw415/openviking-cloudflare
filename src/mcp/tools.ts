// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '../http.js'
import { Filesystem } from '../filesystem.js'
import { FILE_LIMIT, MAX_DEPTH, PAGE_LIMIT, bool, choice, conflict, encoder, int, invalid, onlyKeys, parseTags, pathFor, quota, str, textSize, unsupported } from '../fs/contract.js'
import { asObject, filesystem, toolResult } from './common.js'
import type { Data, McpContext, ToolResult } from './common.js'
import { addLocations, skillTarget } from './settings.js'

type Run = (ctx: McpContext, args: Data) => Promise<ToolResult> | ToolResult
type Property = { type: string; [key: string]: unknown }
type Tool = {
  name: string; description: string
  inputSchema: { type: 'object'; properties: Record<string, Property>; required: string[]; additionalProperties: false }
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: false }
}
const string: Property = { type: 'string' }
const boolean: Property = { type: 'boolean' }
const integer: Property = { type: 'integer' }
const number: Property = { type: 'number' }
const object: Property = { type: 'object' }
const array = (items: Property): Property => ({ type: 'array', items })
const defs = new Map<string, { tool: Tool; run: Run }>()
function define(name: string, description: string, properties: Record<string, Property>, required: string[], run: Run, readOnly = true) {
  const tool: Tool = { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false } }
  defs.set(name, { tool, run })
}

export function toolCatalog(mutations = false): Tool[] {
  return [...defs.values()].map(({ tool }) => tool).filter(tool => mutations || tool.annotations.readOnlyHint)
    .map(tool => tool.name === 'search' && mutations ? { ...tool,
      annotations: { ...tool.annotations, readOnlyHint: false, idempotentHint: false } } : tool)
}

export async function callTool(ctx: McpContext, name: string, args: Data, allowMutation = ctx.mcpMode === 'read-write'): Promise<ToolResult> {
  ctx.requestSignal?.throwIfAborted()
  const item = defs.get(name)
  if (!item) throw new ApiError(404, 'NOT_FOUND', 'This tool is not available on the edge.')
  if (!item.tool.annotations.readOnlyHint && (!allowMutation || ctx.mcpMode !== 'read-write')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'The MCP policy does not allow this mutation.')
  }
  onlyKeys(args, Object.keys(item.tool.inputSchema.properties).join(' '))
  if (item.tool.inputSchema.required.some(key => !Object.hasOwn(args, key))) invalid('A required tool argument is missing.')
  if (name === 'search' && int(args.dedup_turns ?? undefined, 'dedup_turns', 0, 0, 100) > 0 && (!allowMutation || ctx.mcpMode !== 'read-write')) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'MCP recall ledger updates require read-write policy.')
  }
  return item.run(ctx, args)
}

define('read', 'Read stored Viking text by exact URI; nothing in a file is evaluated or executed.', {
  uri: string, uris: array(string), offset: integer, limit: integer,
}, [], async (ctx, args) => {
  if (args.uri != null && args.uris != null) invalid('Supply uri or uris, not both.')
  const raw = args.uri ?? args.uris
  const inputs = Array.isArray(raw) ? raw : [raw]
  if (inputs.length < 1 || inputs.length > 4) invalid('Supply between one and four file URIs.')
  const paths = inputs.map(uri => pathFor(uri, ctx.caller).uri)
  const offset = int(args.offset, 'offset', 0, 0, 1_000_000)
  const limit = int(args.limit, 'limit', -1, -1, 1_000_000)
  const pages = []
  for (const uri of paths) {
    const { value } = await filesystem<string>(ctx, 'GET /api/v1/content/read', { uri, offset, limit, raw: true })
    pages.push(paths.length === 1 ? value : `=== ${uri} ===\n${value}`)
  }
  return toolResult(pages.join('\n\n'), true)
})

type DirEntry = { uri: string; name: string; isDir: boolean; rel_path: string; abstract?: string; tags?: string[] }
const tagText = (tags?: string[]) => tags?.length ? ` [tags: ${tags.join(', ')}]` : ''
const sortField: Property = { type: 'string', enum: ['name', 'mtime'] }
const sortOrder: Property = { type: 'string', enum: ['asc', 'desc'] }
const tagsFields = { tags: array(string), include_tags: boolean }
const tagsArgs = (a: Data) => ({ tags: parseTags(a.tags), include_tags: bool(a.include_tags, 'include_tags') })

define('list', 'List one page of readable Viking entries.', {
  uri: string, recursive: boolean, offset: integer, limit: integer,
  sort_by: sortField, sort_order: sortOrder, ...tagsFields,
}, [], async (ctx, args) => {
  const uri = pathFor(args.uri ?? 'viking://', ctx.caller).uri
  const recursive = bool(args.recursive, 'recursive')
  const { value, hasMore } = await filesystem<DirEntry[]>(ctx, 'GET /api/v1/fs/ls', {
    ...tagsArgs(args), uri, recursive, output: 'original', limit: int(args.limit ?? undefined, 'limit', 100, 1, PAGE_LIMIT),
    offset: int(args.offset, 'offset', 0, 0, 100_000), sort_by: choice(args.sort_by ?? undefined, 'sort_by', ['name', 'mtime'], 'name'),
    sort_order: choice(args.sort_order, 'sort_order', ['asc', 'desc'], 'asc'),
  })
  const lines = value.map(item => `[${item.isDir ? 'dir' : 'file'}] ${recursive ? item.uri : item.name}${tagText(item.tags)}`)
  if (hasMore) lines.push('(more entries available; use offset and limit to view the next page)')
  return toolResult(lines.join('\n') || `(no entries under ${uri})`)
})

define('tree', 'Show one page of a readable Viking directory tree.', {
  uri: string, level_limit: integer, node_limit: integer, include_abstract: boolean, offset: integer, limit: integer, ...tagsFields,
}, [], async (ctx, args) => {
  const uri = pathFor(args.uri ?? 'viking://', ctx.caller).uri
  const nodeLimit = int(args.node_limit, 'node_limit', 1000, 1, PAGE_LIMIT)
  const { value, hasMore } = await filesystem<DirEntry[]>(ctx, 'GET /api/v1/fs/tree', {
    ...tagsArgs(args), uri, level_limit: int(args.level_limit, 'level_limit', 3, 0, MAX_DEPTH), output: 'original',
    offset: int(args.offset, 'offset', 0, 0, 100_000), limit: int(args.limit ?? undefined, 'limit', nodeLimit, 1, PAGE_LIMIT),
    include_abstract: bool(args.include_abstract, 'include_abstract'), abs_limit: 1024,
  })
  const lines = value.map(item => {
    const depth = item.uri === uri ? 0 : item.rel_path.split('/').length - 1
    const abstract = item.abstract?.replace(/\s+/gu, ' ').trim()
    return `${'  '.repeat(depth)}${item.name}${item.isDir ? '/' : ''}${tagText(item.tags)}${abstract ? ` — ${abstract}` : ''}`
  })
  if (value[0]?.uri !== uri) lines.unshift(uri)
  if (hasMore) lines.push('(more entries available; use offset and limit to view the next page)')
  return toolResult(lines.join('\n'))
})

define('glob', 'Match Viking paths with the bounded filesystem glob.', { uri: string, pattern: string, node_limit: integer }, ['pattern'], async (ctx, args) => {
  const { value } = await filesystem<{ matches: string[]; limit_reached: boolean }>(ctx, 'POST /api/v1/search/glob', {
    ...args, node_limit: int(args.node_limit, 'node_limit', 100, 1, 256),
  })
  const lines = [`Found ${value.matches.length} match(es):`, ...value.matches.map(uri => `  ${uri}`)]
  if (value.limit_reached) lines.push('(more matches may exist)')
  return toolResult(lines.join('\n'))
})

define('grep', 'Search stored text by line using literals, escaped punctuation, dot or line anchors.', {
  uri: string, pattern: array(string), case_insensitive: boolean, node_limit: integer, ...tagsFields,
}, ['uri', 'pattern'], async (ctx, args) => {
  const patterns: unknown[] = Array.isArray(args.pattern) ? args.pattern : [args.pattern]
  if (patterns.length < 1 || patterns.length > 4) invalid('Supply between one and four grep patterns.')
  const lines: string[] = []
  let more = false
  for (const pattern of patterns) {
    const { value } = await filesystem<{ matches: { uri: string; line: number; content: string; tags?: string[] }[]; limit_reached: boolean }>(
      ctx, 'POST /api/v1/search/grep', { ...args, pattern, node_limit: int(args.node_limit, 'node_limit', 10, 1, 16) })
    lines.push(...value.matches.map(item => `${item.uri}:${item.line}${tagText(item.tags)}: ${item.content}`))
    more ||= value.limit_reached
  }
  if (more) lines.push('(more matches may exist; narrow the scope or pattern)')
  return toolResult(lines.join('\n') || 'No matches found.')
})

const searchProperties = { query: string, target_uri: string, limit: integer, min_score: number, level: array(integer),
  context_type: array(string), tags: array(string), read_content: boolean, events_time_decay_protection: string }
type Hit = { uri: string; context_type: string; score: number; tags: string[]; abstract: string; content?: string }
type SearchResult = { memories: Hit[]; resources: Hit[]; skills: Hit[] }

function retrieval(search: boolean): Run {
  return async (ctx, args) => {
    const { min_score, search_type, mode, session_id, detail_by_category, ...common } = args
    if (search && (search_type != null && search_type !== 'semantic' || mode != null && mode !== 'list' || session_id)) {
      if (!ctx.mcpLive || !ctx.prepareMcpSearch) unsupported('Advanced MCP search is not enabled by the operator.')
      const scoped = await ctx.prepareMcpSearch()
      let finish: (() => void) | undefined
      scoped.deferSearchPublication = callback => { finish = callback }
      if (args.target_uri != null) common.target_uri = str(args.target_uri, 'target_uri')
      const { value } = await filesystem<SearchResult | Data>(scoped, 'POST /api/v1/search/search', {
        ...common, search_type, mode, session_id, score_threshold: min_score,
        ...(detail_by_category != null && { detail: asObject(detail_by_category, 'detail_by_category') }),
        ...(args.rewrite === 'off' && { rewrite: false }),
      })
      const formatted = mode === 'context' ? toolResult(value as Data) : formatSearch(value as SearchResult)
      ctx.publishMcpSearch = () => {
        ctx.requestSignal?.throwIfAborted()
        scoped.assertActive?.()
        scoped.dataAuthority?.assertCurrent()
        finish?.()
      }
      return formatted
    }
    if (detail_by_category != null) invalid('detail_by_category requires context mode.')
    if (args.target_uri != null) common.target_uri = str(args.target_uri, 'target_uri')
    const { value } = await filesystem<SearchResult>(ctx, search ? 'POST /api/v1/search/search' : 'POST /api/v1/search/find', {
      ...common, score_threshold: min_score ?? (search ? undefined : 0.35),
    })
    return formatSearch(value)
  }
}

function formatSearch(value: SearchResult): ToolResult {
    const hits = [...value.memories, ...value.resources, ...value.skills].sort((a, b) => b.score - a.score)
    if (!hits.length) return toolResult('No matching context found.')
    const text = hits.map(hit => `- [${hit.context_type} ${Math.round(hit.score * 100)}%] ${hit.uri}${tagText(hit.tags)}\n    ${hit.abstract}${
      hit.content !== undefined ? `\n\n    ${hit.content}` : ''}`)
    return toolResult(`Found ${hits.length} item(s):\n\n${text.join('\n')}`)
}

define('find', 'Find ranked Viking text by similarity without a session.', searchProperties, ['query'], retrieval(false))
define('search', 'Search authorized Viking text. Operator-mounted context search reuses Data budgets and authority. Positive dedup_turns updates the recall ledger and requires read-write policy.', {
  ...searchProperties, search_type: string, mode: string, session_id: string,
  query_expansion: string, max_tokens: integer, quotas: object, purpose: string, detail: string,
  detail_by_category: object, dedup_turns: integer, exclude_uris: array(string), peer_scope: string,
  other_peer_penalty: number, rewrite: string, rewrite_max_bullets: integer,
}, ['query'], retrieval(true))

define('health', 'Check the authenticated workspace SQLite runtime.', {}, [], ctx => {
  if (ctx.sql.exec<{ running: number }>('SELECT 1 AS running').one().running !== 1) throw new ApiError(503, 'UNAVAILABLE', 'Workspace is unavailable.')
  return toolResult('OpenViking is healthy (workspace initialized, storage: Durable Object SQLite).')
})

define('list_users', 'List user identifiers in the authenticated account; credentials are not available.', {
  query: string, limit: integer, page: integer, include_credentials: boolean,
}, [], (ctx, args) => {
  if (bool(args.include_credentials, 'include_credentials')) throw new ApiError(403, 'PERMISSION_DENIED', 'MCP never discloses credentials.')
  const query = str(args.query, 'query', '', 128).toLowerCase()
  const limit = int(args.limit, 'limit', 100, 1, 100), page = int(args.page, 'page', 1, 1, 10_000)
  const users = [...new Set(ctx.aclPrincipals?.users ?? [ctx.caller.userId])].filter(id => id.toLowerCase().includes(query)).sort()
  return toolResult({ users: users.slice((page - 1) * limit, page * limit).map(user_id => ({ user_id })), total: users.length })
})

define('list_groups', 'List grantable group identifiers without membership or credentials.', {}, [], ctx => toolResult({
  groups: [...new Set(ctx.aclPrincipals?.groups ?? [])].sort().map(group_id => ({ group_id })),
}))

define('get_acl', 'Read ACLs of a managed shared resource.', { uri: string }, ['uri'], async (ctx, args) => {
  const uri = pathFor(args.uri, ctx.caller).uri
  return toolResult((await filesystem<Data>(ctx, 'GET /api/v1/acl', { uri })).value)
})

define('set_acl', 'Set ACLs on a shared resource that the caller manages.', { uri: string, acl: object }, ['uri', 'acl'], async (ctx, args) => {
  const acl = asObject(args.acl, 'acl')
  onlyKeys(acl, 'entries acl_mode')
  if (!Object.keys(acl).length) invalid('No ACL changes were supplied.')
  await ctx.reauthorize?.()
  return toolResult((await filesystem<Data>(ctx, 'PUT /api/v1/acl', { ...acl, uri: args.uri })).value)
}, false)

define('write', 'Write explicit text to one Viking URI. Edge create and append enforce existence.', {
  uri: string, content: string, mode: { type: 'string', enum: ['replace', 'append', 'create'] }, wait: boolean,
  timeout: number, acl: object, resolve_conflicts: boolean, use_snapshot: boolean, defer_processing: boolean,
}, ['uri', 'content'], async (ctx, args) => {
  const mode = choice(args.mode, 'mode', ['replace', 'append', 'create'], 'replace')
  const content = str(args.content, 'content', undefined, FILE_LIMIT)
  const { value } = await filesystem<{ uri: string; warnings?: string[]; vector_status?: string }>(ctx, 'POST /api/v1/content/write', { ...args, mode, content })
  const bytes = encoder.encode(content).byteLength
  return toolResult(`Wrote ${bytes} bytes to ${value.uri} (mode=${mode}).${value.vector_status === 'deferred' ?
    '\nIndexing: deferred.' : value.warnings?.length ? `\n${value.warnings.join(' ')}` : ''}`)
}, false)

define('edit', 'Replace exact text in an existing Viking document without overwriting a concurrent edit.', {
  uri: string, old_string: string, new_string: string, replace_all: boolean, wait: boolean, timeout: number,
}, ['uri', 'old_string', 'new_string'], async (ctx, args) => {
  const path = pathFor(args.uri, ctx.caller)
  const old = str(args.old_string, 'old_string', undefined, FILE_LIMIT)
  const replacement = str(args.new_string, 'new_string', undefined, FILE_LIMIT)
  const replaceAll = bool(args.replace_all, 'replace_all')
  const wait = bool(args.wait, 'wait')
  const timeout = args.timeout
  if (timeout != null && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0)) invalid('Invalid timeout.')
  if (!old) invalid('old_string must not be empty.')

  const fs = new Filesystem(ctx)
  const before = fs.require(path, 'write').revision
  const assertRevision = () => {
    ctx.assertActive?.()
    if (fs.entry(path, 'write')?.revision !== before) conflict('The file changed; read it again before editing.')
  }
  const { value: current } = await filesystem<string>(ctx, 'GET /api/v1/content/read', { uri: path.uri, raw: true })
  assertRevision()
  let count = 0
  for (let offset = 0; (offset = current.indexOf(old, offset)) !== -1; offset += old.length) count++
  if (!count) invalid('old_string did not match the stored text.')
  if (count > 1 && !replaceAll) invalid('old_string is ambiguous; disambiguate it or set replace_all=true.')
  if (old === replacement) return toolResult(`No changes: ${path.uri} already matches the requested edit.`)
  if (current.length + count * (replacement.length - old.length) > FILE_LIMIT) quota('The edited text exceeds the file limit.')
  const updated = current.replaceAll(old, () => replacement)
  const scoped = Object.assign(Object.create(ctx) as McpContext, { assertActive: assertRevision })
  const bytes = textSize(updated)
  await filesystem(scoped, 'POST /api/v1/content/write', { uri: path.uri, content: updated, mode: 'replace', wait, timeout })
  return toolResult(`Edited ${path.uri} (${bytes} bytes written).`)
}, false)

define('forget', 'Delete an exact Viking URI. Confirm with the user before sending this irreversible request.', {
  uri: string, recursive: boolean,
}, ['uri'], async (ctx, args) => {
  const path = pathFor(args.uri, ctx.caller)
  const recursive = bool(args.recursive, 'recursive')
  // Keep the MCP surface fail-closed independently of filesystem PAR-01.
  if (recursive && path.parts[0] === 'resources' && ctx.caller.role !== 'admin') {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Only account admins may recursively remove shared resources via MCP.')
  }
  await ctx.reauthorize?.()
  await filesystem(ctx, 'DELETE /api/v1/fs', { uri: path.uri, recursive })
  return toolResult(`Deleted: ${path.uri}`)
}, false)

define('add_resource', 'Import the same identity\'s staged upload or an operator-approved mounted source. No arbitrary network destinations.', {
  temp_file_id: string, to: string, parent: string, description: string, processing_mode: string,
  tags: array(string), tag_mode: string, args: object, acl: object, path: string, watch_interval: number, add_type: string,
}, [], async (ctx, args) => {
  const { path, watch_interval, add_type, description, to, parent, ...upload } = args
  const remote = path != null && path !== '' || add_type != null && add_type !== '' || watch_interval != null && watch_interval !== 0
  if (remote && !ctx.mcpLive) {
    unsupported('The MCP edge can only import an authenticated, staged text upload by temp_file_id.')
  }
  const explicitTo = str(to ?? undefined, 'to', '')
  const explicitParent = str(parent ?? undefined, 'parent', '')
  if (!remote && !upload.temp_file_id) invalid('Supply a temp_file_id obtained from the authenticated upload endpoint.')
  // If visibility has not been chosen, use the caller's private root rather than implicitly publishing to the tenant.
  const target = explicitTo ? explicitParent : explicitParent || addLocations(ctx).resource_uri || 'viking://~/resources'
  const result = await filesystem<{ root_uri: string; warnings?: string[] }>(ctx, 'POST /api/v1/resources', {
    ...upload, ...(explicitTo && { to: explicitTo }), ...(target && { parent: target }),
    ...(remote && { path, add_type, watch_interval }),
    reason: str(description ?? undefined, 'description', '', 512), create_parent: !!explicitParent, wait: true,
  })
  return toolResult(`Resource added: ${result.value.root_uri}${result.value.warnings?.length ? `\n${result.value.warnings.join(' ')}` : ''}`)
}, false)

define('add_skill', 'Install explicit SKILL.md text as data in an authorized Viking skill root. No execution or external sources.', {
  data: string, target_uri: string, path: string, skills: array(string), list_only: boolean,
}, [], async (ctx, args) => {
  if (str(args.path ?? undefined, 'path', '') || bool(args.list_only, 'list_only') ||
      args.skills != null && (!Array.isArray(args.skills) || args.skills.length)) {
    unsupported('Only inline SKILL.md data can be installed by MCP on the edge.')
  }
  const data = str(args.data, 'data', undefined, FILE_LIMIT)
  const target = str(args.target_uri ?? undefined, 'target_uri', '') || addLocations(ctx).skill_uri || 'viking://~/skills'
  const target_uri = skillTarget(ctx, target)
  const { value } = await filesystem<{ root_uri: string }>(ctx, 'POST /api/v1/skills', {
    data, target_uri, wait: true, source_metadata: { type: 'mcp', source: 'inline_content' },
  })
  return toolResult(`Skill installed: ${value.root_uri}`)
}, false)
