// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, ok, readJson } from './http.js'
import { aclSpec, routeAcl } from './acl.js'
import {
  JSON_LIMIT, MAX_DEPTH, PAGE_LIMIT, ROOT, absChild, bool, choice, fromParts, invalid, missing, onlyKeys, parseTags, pathFor,
  partsOf, queryBool, queryInt, queryString, relative, sharedChild, str, tagMatch, unsupported, writable,
} from './fs/contract.js'
import type { FsPath } from './fs/contract.js'
import { Filesystem, ordered, tagsOf, wireEntry } from './fs/store.js'
import type { Entry } from './fs/store.js'
import { batchSetTags, batchWrite, download, read, setTags, summary, write } from './fs/content.js'
import { addResource, tempUpload } from './fs/resources.js'
import { glob, grep, semantic } from './fs/search.js'
import { ensureDirectoryIndex, reindex } from './fs/indexing.js'
import { routeSkills } from './skills.js'

export { initFilesystem } from './fs/store.js'
export { Filesystem } from './fs/store.js'
export { runContentBatchJob } from './fs/content.js'
export type { Entry } from './fs/store.js'
export { SUBTREE_MAX_ENTRIES, SUBTREE_MAX_BYTES, captureSubtree, subtreeRevision, authorizeHistoricalRead, validateSubtreeMutation, prepareSubtreeMutation,
  commitSubtreeMutation, commitSubtreeMutations, restoreSubtree } from './fs/subtree.js'
export type { SubtreeEntry, SubtreeCapture, SubtreeMutationPlan, PreparedSubtreeMutation, SubtreeMutationResult } from './fs/subtree.js'

function extraFields(fields: unknown): string[] {
  if (fields == null) return []
  if (!Array.isArray(fields) || fields.length > 3 || fields.some(field => field !== 'count')) {
    unsupported('Only the count listing extra field is implemented.')
  }
  return fields as string[]
}

function isHidden(relativePath: string): boolean { return relativePath.split('/').some(name => name.startsWith('.')) }

function listTree(fs: Filesystem, path: FsPath, query: URLSearchParams, tree: boolean): Response {
  const dir = fs.require(path)
  const simple = !tree && queryBool(query, 'simple')
  const recursive = tree || queryBool(query, 'recursive')
  const depth = recursive ? queryInt(query, 'level_limit', 3, 0, MAX_DEPTH) : 1
  const nodeLimit = queryInt(query, 'node_limit', PAGE_LIMIT, 1, PAGE_LIMIT)
  const limit = queryInt(query, 'limit', nodeLimit, 1, PAGE_LIMIT)
  const offset = queryInt(query, 'offset', 0, 0, 100_000)
  const orderBy = choice(queryString(query, 'sort_by'), 'sort_by', ['name', 'mtime'] as const, 'name')
  const order = choice(queryString(query, 'sort_order'), 'sort_order', ['asc', 'desc'] as const, 'asc')
  const output = choice(queryString(query, 'output'), 'output', ['original', 'agent'] as const, 'agent')
  const hidden = queryBool(query, 'show_all_hidden')
  const directoriesOnly = tree && queryBool(query, 'directories_only')
  const includeTags = queryBool(query, 'include_tags')
  const includeAbstract = queryBool(query, 'include_abstract', output === 'agent')
  const includeOverview = queryBool(query, 'include_overview')
  const absLimit = queryInt(query, 'abs_limit', 256, 0, 4000)
  const overviewLimit = queryInt(query, 'overview_limit', 4000, 1, 4000)
  const fields = extraFields(query.getAll('extra_fields'))
  const wanted = parseTags(query.getAll('tags'))

  const byParent = new Map<string, Entry[]>()
  const counts = new Map<string, number>()
  for (const entry of dir.is_dir ? fs.entries(path) : []) {
    if (!absChild(entry.uri, path.uri)) continue
    const parent = partsOf(entry.uri).slice(0, -1).join('/')
    if (fields.includes('count')) counts.set(parent, (counts.get(parent) ?? 0) + 1)
    const rel = relative(entry.uri, path.uri)
    if ((!hidden && isHidden(rel)) || rel.split('/').length > depth) continue
    const siblings = byParent.get(parent)
    if (siblings) siblings.push(entry)
    else byParent.set(parent, [entry])
  }
  const entries: Entry[] = []
  function visit(parent: string) {
    for (const entry of ordered(byParent.get(parent) ?? [], orderBy, order)) {
      entries.push(entry)
      if (entry.is_dir) visit(entry.uri.slice(ROOT.length))
    }
  }
  if (dir.is_dir) visit(path.parts.join('/'))
  else entries.push(dir)
  const matching = entries.filter(entry => (!directoriesOnly || !!entry.is_dir) && tagMatch(tagsOf(entry), wanted))
  const page = matching.slice(offset, offset + limit)
  const result = page.map(entry => {
    if (simple && !fields.length) return entry.uri
    const target = fromParts(partsOf(entry.uri), fs.caller)
    const count = fields.includes('count') && entry.is_dir ? (counts.get(target.parts.join('/')) ?? 0) : undefined
    const abstract = includeAbstract ? summary(fs, target, 'abstract', entry)?.slice(0, absLimit) : undefined
    const overview = includeOverview ? summary(fs, target, 'overview', entry)?.slice(0, overviewLimit) : undefined
    return { ...wireEntry(entry, path.uri, includeTags, count), abstract, overview }
  })
  return Response.json({ status: 'ok', result, has_more: offset + limit < matching.length })
}

function stat(fs: Filesystem, path: FsPath) {
  const entry = fs.require(path)
  return { ...wireEntry(entry, path.uri), is_dir: !!entry.is_dir, size_bytes: entry.bytes,
    abstract: summary(fs, path, 'abstract', entry)?.slice(0, 256),
    overview: summary(fs, path, 'overview', entry)?.slice(0, 4000),
    ...(entry.updated_at && { mod_time: new Date(entry.updated_at).toISOString() }) }
}

async function mkdir(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'uri description acl')
  const acl = aclSpec(body.acl)
  const path = pathFor(body.uri, fs.caller)
  writable(path, fs.caller)
  const description = str(body.description ?? undefined, 'description', '', 512)
  fs.atomic(() => fs.mkdir(path, description, acl))
  return ok({ uri: path.uri })
}

async function transfer(fs: Filesystem, request: Request, path: string): Promise<Response> {
  const copy = path.endsWith('/cp')
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, copy ? 'from_uri to_uri recursive overwrite' : 'from_uri to_uri overwrite')
  const from = pathFor(body.from_uri, fs.caller)
  const to = pathFor(body.to_uri, fs.caller)
  if (path.startsWith('/api/v1/resources/')) { sharedChild(from); sharedChild(to) }
  writable(from, fs.caller)
  writable(to, fs.caller)
  const recursive = bool(body.recursive, 'recursive')
  fs.atomic(() => fs.transfer(from, to, copy, recursive, bool(body.overwrite, 'overwrite')))
  return ok({ from: from.uri, to: to.uri, ...(copy && { recursive }) })
}

function remove(fs: Filesystem, query: URLSearchParams, sharedOnly: boolean): Response {
  const path = pathFor(queryString(query, 'uri'), fs.caller)
  if (sharedOnly) sharedChild(path)
  writable(path, fs.caller)
  const recursive = queryBool(query, 'recursive')
  queryBool(query, 'wait') // Always transactional and complete on return.
  const count = fs.atomic(() => fs.remove(path, recursive))
  return ok({ uri: path.uri, estimated_deleted_count: count })
}

export async function routeFilesystem(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  const fs = new Filesystem(ctx)
  const query = url.searchParams
  switch (url.pathname) {
    case '/api/v1/fs/ls':
    case '/api/v1/fs/tree':
      checkMethod(request, 'GET')
      return listTree(fs, pathFor(queryString(query, 'uri'), fs.caller), query, url.pathname.endsWith('/tree'))
    case '/api/v1/fs/stat':
      checkMethod(request, 'GET')
      return ok(stat(fs, pathFor(queryString(query, 'uri'), fs.caller)))
    case '/api/v1/fs/mkdir':
      checkMethod(request, 'POST')
      return mkdir(fs, request)
    case '/api/v1/fs/attrs': {
      checkMethod(request, 'GET')
      const path = pathFor(queryString(query, 'uri'), fs.caller)
      const entry = fs.require(path)
      return ok({ uri: entry.uri, context_type: path.kind, attrs: { tags: tagsOf(entry) } })
    }
    case '/api/v1/content/read':
      checkMethod(request, 'GET')
      return read(fs, pathFor(queryString(query, 'uri'), fs.caller), query)
    case '/api/v1/content/abstract':
    case '/api/v1/content/overview': {
      checkMethod(request, 'GET')
      const path = pathFor(queryString(query, 'uri'), fs.caller)
      return ok(summary(fs, path, url.pathname.endsWith('/abstract') ? 'abstract' : 'overview') ?? missing())
    }
    case '/api/v1/content/download':
      checkMethod(request, 'GET')
      if (query.has('token')) unsupported('Signed downloads are not implemented; use authenticated requests.')
      return download(fs, pathFor(queryString(query, 'uri'), fs.caller))
    case '/api/v1/content/write':
      checkMethod(request, 'POST')
      return write(fs, request)
    case '/api/v1/content/batch-write':
      checkMethod(request, 'POST')
      return batchWrite(fs, request)
    case '/api/v1/content/batch_set_tags':
      checkMethod(request, 'POST')
      return batchSetTags(fs, request)
    case '/api/v1/content/ensure_directory_index':
      checkMethod(request, 'POST')
      return ensureDirectoryIndex(fs, request)
    case '/api/v1/content/reindex':
      checkMethod(request, 'POST')
      return reindex(fs, request)
    case '/api/v1/fs/attrs/set_tags':
    case '/api/v1/content/set_tags':
      checkMethod(request, 'POST')
      return setTags(fs, request)
    case '/api/v1/fs/mv':
    case '/api/v1/fs/cp':
    case '/api/v1/resources/mv':
    case '/api/v1/resources/cp':
      checkMethod(request, 'POST')
      return transfer(fs, request, url.pathname)
    case '/api/v1/fs':
      checkMethod(request, 'DELETE')
      return remove(fs, query, false)
    case '/api/v1/resources':
      checkMethod(request, 'DELETE', 'POST')
      return request.method === 'DELETE' ? remove(fs, query, true) : addResource(fs, request)
    case '/api/v1/resources/temp_upload':
      checkMethod(request, 'POST')
      return tempUpload(fs, request, url)
    case '/api/v1/search/find':
    case '/api/v1/search/search':
      checkMethod(request, 'POST')
      return semantic(fs, request, url.pathname.endsWith('/search'))
    case '/api/v1/search/grep':
      checkMethod(request, 'POST')
      return grep(fs, request)
    case '/api/v1/search/glob':
      checkMethod(request, 'POST')
      return glob(fs, request)
    default:
      return await routeAcl(request, url, fs) ?? await routeSkills(fs, request, url)
  }
}

function checkMethod(request: Request, ...methods: string[]): void {
  if (!methods.includes(request.method) && !(methods.includes('GET') && request.method === 'HEAD')) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Use ${methods.join(' or ')} for this route.`)
  }
}
