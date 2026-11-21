// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, ok, readJson } from '../http.js'
import { bool, compare, encoder, exists, int, invalid, missing, onlyKeys, pathFor, queryString, quota, str, unsupported } from '../fs/contract.js'
import { embeddingUnavailable } from '../fs/vectors.js'
import { asObject, protocolVersions, requireMcp, serverInfo, toolError } from './common.js'
import type { Data, McpContext } from './common.js'
import { callTool, toolCatalog } from './tools.js'

const base = '/api/v1/mcps'
const shared = 'viking://agent/tools'
const address = 'viking://builtin/openviking-data'
const readAllowlist = new Set(['health', 'list', 'tree', 'read', 'find', 'search', 'grep', 'glob'])
const reserved = new Set(['validate', 'find', 'invoke', 'status', 'mount', 'mounts', 'batch-mount', 'batch-unmount'])
const local = () => toolCatalog().filter(tool => readAllowlist.has(tool.name))
type Tool = ReturnType<typeof local>[number]
type Definition = { tool: Tool; revision: string; input_revision: string }
type Registration = { scope: string; name: string; catalog: string; created_at: number; updated_at: number }
type Root = { uri: string; scope: string }

export function initRegistry({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_mcp_registry (
    account_id TEXT NOT NULL, scope TEXT NOT NULL, name TEXT NOT NULL,
    catalog TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id,scope,name)
  ) WITHOUT ROWID`)
}

const denied = (message: string) => new ApiError(403, 'PERMISSION_DENIED', message)
const privateRoot = (ctx: McpContext) => ({ uri: `viking://user/${ctx.caller.userId}/tools`, scope: `user:${ctx.caller.userId}` })
const sharedRoot: Root = { uri: shared, scope: 'account' }

function root(ctx: McpContext, requested: unknown, update = false): Root {
  const own = privateRoot(ctx)
  const uri = requested == null ? own.uri : pathFor(requested, ctx.caller).uri
  if (uri === shared) {
    if (update && ctx.caller.role !== 'admin') throw denied('An account admin must modify the shared catalog.')
    return sharedRoot
  }
  if (uri !== own.uri) invalid('Expected the current user tools root or viking://agent/tools.')
  return own
}

function mutation(ctx: McpContext): void {
  if (ctx.mcpMode !== 'read-write') throw denied('The MCP policy does not allow registry writes.')
}

function serverName(value: unknown): string {
  const name = str(value, 'name', undefined, 64)
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name) || reserved.has(name)) invalid('Invalid or reserved MCP server name.')
  return name
}

function checkedRegistration(body: Data) {
  onlyKeys(body, 'name url headers target_uri wait')
  const name = serverName(body.name)
  if (body.headers !== undefined && Object.keys(asObject(body.headers, 'headers')).length) {
    throw denied('MCP registry entries cannot carry client-supplied headers.')
  }
  if (str(body.url, 'url', undefined, 256) !== address) throw denied('The requested service is not in the built-in allowlist.')
  bool(body.wait, 'wait') // All local registry changes are synchronous publication.
  return name
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
  })
}

async function hash(value: unknown) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(stableJson(value))))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

// Only immutable source-defined declarations are hashed/cached; never tenant content or caller context.
let catalog: Definition[] | undefined
async function definitions(): Promise<Definition[]> {
  return catalog ??= await Promise.all(local().sort((a, b) => compare(a.name, b.name)).map(async tool => ({
    tool, revision: await hash(tool), input_revision: await hash({ name: tool.name, inputSchema: tool.inputSchema }),
  })))
}

function row(ctx: McpContext, root: Root, name: string): Registration | undefined {
  return ctx.sql.exec<Registration>('SELECT * FROM ov_edge_mcp_registry WHERE account_id=? AND scope=? AND name=?',
    ctx.caller.accountId, root.scope, name).toArray()[0]
}

function visible(ctx: McpContext, requested: unknown) {
  const roots = requested == null ? [privateRoot(ctx), sharedRoot] : [root(ctx, requested)]
  const items = roots.flatMap(at => ctx.sql.exec<Registration>(`SELECT * FROM ov_edge_mcp_registry
    WHERE account_id=? AND scope=? ORDER BY name`, ctx.caller.accountId, at.scope).toArray().map(entry => ({ at, entry })))
  return { items, roots: requested == null ? { root_uris: roots.map(at => at.uri) } : { root_uri: roots[0].uri } }
}

const stored = (row: Registration) => JSON.parse(row.catalog) as Definition[]
function summary(entry: Registration, at: Root, count = stored(entry).length) {
  return { name: entry.name, url: address, root_uri: at.uri, header_names: [], tool_count: count,
    created_at: new Date(entry.created_at).toISOString(), updated_at: new Date(entry.updated_at).toISOString() }
}
const toolUri = (at: Root, name: string, tool: string) => `${at.uri}/${name}/${tool}.json`

function diff(previous: Definition[], next: Definition[]) {
  const before = new Map(previous.map(item => [item.tool.name, item.revision]))
  const after = new Map(next.map(item => [item.tool.name, item.revision]))
  return { added: [...after.keys()].filter(name => !before.has(name)), removed: [...before.keys()].filter(name => !after.has(name)),
    changed: [...after.keys()].filter(name => before.has(name) && before.get(name) !== after.get(name)),
    unchanged: [...after.keys()].filter(name => before.get(name) === after.get(name)) }
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length || left.length > 2048) throw embeddingUnavailable()
  let dot = 0, a = 0, b = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]
    a += left[i] ** 2
    b += right[i] ** 2
  }
  if (a === 0 || b === 0 || !Number.isFinite(dot) || !Number.isFinite(a * b)) throw embeddingUnavailable()
  return Math.min(1, dot / Math.sqrt(a * b))
}

async function find(ctx: McpContext, body: Data) {
  onlyKeys(body, 'query limit target_uri')
  const query = str(body.query, 'query', undefined, 1024).trim()
  if (!query) invalid('Tool search requires a nonempty query.')
  const limit = int(body.limit, 'limit', 10, 1, 100)
  const current = await definitions()
  const before = visible(ctx, body.target_uri)
  if (!before.items.length) return ok({ tools: [], total: 0, ...before.roots })
  const vectors = await ctx.embed([query, ...current.map(item => `${item.tool.name} ${item.tool.description}`)])
  if (vectors.length !== current.length + 1) throw embeddingUnavailable()
  const scores = new Map(current.map((item, i) => [item.revision, cosine(vectors[0], vectors[i + 1])]))
  await ctx.reauthorize?.()
  const visibleNow = visible(ctx, body.target_uri)
  const matches = visibleNow.items.flatMap(({ entry, at }) => stored(entry).flatMap(({ tool, revision, input_revision }) => {
    const score = scores.get(revision)
    return score === undefined || score < 0.35 ? [] : [{ uri: toolUri(at, entry.name, tool.name), server: entry.name,
      name: tool.name, description: tool.description, tool, revision, input_revision, score }]
  })).sort((a, b) => b.score - a.score || compare(a.uri, b.uri)).slice(0, limit)
  return ok({ tools: matches, total: matches.length, ...visibleNow.roots })
}

async function invoke(ctx: McpContext, body: Data) {
  onlyKeys(body, 'uri arguments')
  const path = pathFor(body.uri, ctx.caller)
  const name = path.parts.at(-2), leaf = path.parts.at(-1)
  if (path.parts.length < 4 || !name || !leaf || !/^[A-Za-z0-9_.-]{1,128}\.json$/u.test(leaf)) invalid('Expected a registered tool URI.')
  const at = root(ctx, `viking://${path.parts.slice(0, -2).join('/')}`)
  const server = serverName(name)
  const tool = leaf.slice(0, -5)
  const args = body.arguments === undefined ? {} : asObject(body.arguments, 'arguments')
  const current = (await definitions()).find(item => item.tool.name === tool)
  const entry = row(ctx, at, server) ?? missing()
  const registered = stored(entry).find(item => item.tool.name === tool) ?? missing()
  if (!current || registered.revision !== current.revision) {
    throw new ApiError(409, 'CONFLICT', 'The registered catalog is out of date; synchronize it before invocation.')
  }
  try { return ok(await callTool(ctx, tool, args, false)) }
  catch (error) {
    if (!(error instanceof ApiError)) throw error
    return ok(toolError(error))
  }
}

export async function routeRegistry(request: Request, url: URL, ctx: McpContext): Promise<Response | undefined> {
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return
  requireMcp(ctx)
  const suffix = url.pathname.slice(base.length)
  const method = request.method === 'HEAD' ? 'GET' : request.method
  const queryRoot = () => queryString(url.searchParams, 'target_uri')
  const parse = () => readJson(request, 32 * 1024)
  if (suffix === '/mount' || suffix === '/mounts' || suffix === '/batch-mount' || suffix === '/batch-unmount') {
    unsupported('MCP tool mounts and evaluated Live Context are not supported.')
  }
  if (suffix === '' && method === 'GET') {
    const found = visible(ctx, queryRoot())
    return ok({ servers: found.items.map(({ at, entry }) => summary(entry, at)), total: found.items.length, ...found.roots })
  }
  if ((suffix === '' || suffix === '/validate') && method === 'POST') {
    if (!suffix) mutation(ctx)
    const body = await parse()
    const name = checkedRegistration(body), at = root(ctx, body.target_uri, !suffix)
    const tools = await definitions()
    const protocol_version = protocolVersions[0]
    if (suffix) return ok({ name, valid: true, protocol_version, server_info: serverInfo, tool_count: tools.length })
    await ctx.reauthorize?.()
    return ctx.storage.transactionSync(() => {
      ctx.assertActive?.()
      if (row(ctx, at, name)) exists()
      const account = ctx.caller.accountId
      const count = ctx.sql.exec<{ total: number; scoped: number }>(`SELECT count(*) AS total, coalesce(sum(scope=?),0) AS scoped
        FROM ov_edge_mcp_registry WHERE account_id=?`, at.scope, account).one()
      if (count.total >= 32 || count.scoped >= 8) quota('The MCP registry quota is reached.')
      const timestamp = Date.now(), catalog = JSON.stringify(tools)
      ctx.sql.exec('INSERT INTO ov_edge_mcp_registry VALUES (?,?,?,?,?,?)', account, at.scope, name, catalog, timestamp, timestamp)
      return ok({ ...summary({ scope: at.scope, name, catalog, created_at: timestamp, updated_at: timestamp }, at, tools.length), protocol_version })
    })
  }
  if (suffix === '/find' && method === 'POST') return find(ctx, await parse())
  if (suffix === '/invoke' && method === 'POST') return invoke(ctx, await parse())
  if (suffix === '/status' && method === 'GET') {
    const at = root(ctx, queryRoot()), name = serverName(queryString(url.searchParams, 'name'))
    const current = await definitions()
    const tools = stored(row(ctx, at, name) ?? missing())
    const changes = diff(tools, current)
    const stale = changes.added.length || changes.changed.length || changes.removed.length
    return ok({ name, root_uri: at.uri, status: stale ? 'error' : 'running', protocol_version: protocolVersions[0], tool_count: tools.length,
      ...(stale ? { error: 'The pinned local catalog needs synchronization.' } : {}) })
  }
  const match = /^\/([A-Za-z0-9_-]{1,64})(\/sync)?$/u.exec(suffix)
  if (match && !reserved.has(match[1])) {
    const [, name, sync] = match
    if (sync && method === 'POST') {
      mutation(ctx)
      const body = request.body ? await parse() : {}
      onlyKeys(body, 'target_uri wait')
      bool(body.wait, 'wait')
      const at = root(ctx, body.target_uri, true)
      const tools = await definitions()
      await ctx.reauthorize?.()
      return ctx.storage.transactionSync(() => {
        ctx.assertActive?.()
        const previous = row(ctx, at, name) ?? missing()
        const changes = diff(stored(previous), tools)
        ctx.sql.exec('UPDATE ov_edge_mcp_registry SET catalog=?,updated_at=? WHERE account_id=? AND scope=? AND name=?',
          JSON.stringify(tools), Date.now(), ctx.caller.accountId, at.scope, name)
        return ok({ name, root_uri: at.uri, synced: true, protocol_version: protocolVersions[0], tool_count: tools.length,
          changes, affected_mounts: [] })
      })
    }
    if (!sync && method === 'GET') {
      const at = root(ctx, queryRoot()), entry = row(ctx, at, name) ?? missing(), tools = stored(entry)
      return ok({ ...summary(entry, at, tools.length), tools: tools.map(item => ({ ...item, kind: 'mcp_tool',
        server: name, address, uri: toolUri(at, name, item.tool.name) })) })
    }
    if (!sync && method === 'DELETE') {
      mutation(ctx)
      const at = root(ctx, queryRoot(), true)
      await ctx.reauthorize?.()
      return ctx.storage.transactionSync(() => {
        ctx.assertActive?.()
        if (!row(ctx, at, name)) missing()
        ctx.sql.exec('DELETE FROM ov_edge_mcp_registry WHERE account_id=? AND scope=? AND name=?', ctx.caller.accountId, at.scope, name)
        return ok({ name, root_uri: at.uri, removed: true })
      })
    }
  }
  if (match || suffix === '') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Unsupported MCP registry method.')
  throw new ApiError(404, 'NOT_FOUND', 'MCP registry route not found.')
}
