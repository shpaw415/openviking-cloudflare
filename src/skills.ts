// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, ok, readJson } from './http.js'
import { EXAMPLE_SKILLS, FILE_LIMIT, JSON_LIMIT, ROOT, SHARED_SKILLS, SYSTEM_COMPILE, bool, compare, conflict, denied, filename, fromParts, invalid, missing,
  nameOf, onlyKeys, queryBool, queryInt, queryString, quota, str, textFile, textSize, transport, unsupported } from './fs/contract.js'
import type { FsPath } from './fs/contract.js'
import { sha256 } from './fs/content.js'
import { consumeUpload, getUpload, uploadId } from './fs/resources.js'
import type { MultipartUpload } from './fs/resources.js'
import { excerpt, rankedHits } from './fs/search.js'
import { dataOnlySkill, defineSkill, skillNamePattern } from './fs/skill-format.js'
import type { SkillMetadata } from './fs/skill-format.js'
import { ownership, skillHistory, skillRow, skillRows, storeSkill } from './fs/skill-store.js'
import type { ManifestFile, SkillRow } from './fs/skill-store.js'
import { emptyIndex, type Filesystem, type Scoped, type VectorIndex } from './fs/store.js'
import { documentIndex } from './fs/vectors.js'
import { exampleSkills } from './fs/compile-catalog.js'

const prefix = '/api/v1/skills'
const shared = `${ROOT}agent/skills`
const own = `${ROOT}~/skills`
const manifestCap = 48
const packageCap = 256 * 1024
const payloadCap = 1024 * 1024
const child = (fs: Filesystem, path: FsPath, parts: string[]) => fromParts([...path.parts, ...parts], fs.caller) as Scoped

function scope(fs: Filesystem, input?: unknown): Scoped {
  const path = fs.path(input || own)
  if (path.space === SYSTEM_COMPILE) {
    if (path.uri !== EXAMPLE_SKILLS && !path.uri.startsWith(`${EXAMPLE_SKILLS}/`)) invalid('Expected the Compile example skill catalogue.')
    return fs.path(EXAMPLE_SKILLS) as Scoped
  }
  const length = path.parts[0] === 'agent' ? 2 : 3
  if (path.kind !== 'skill' || path.space === null) invalid('Expected the current private or account-shared skills root.')
  return fromParts(path.parts.slice(0, length), fs.caller) as Scoped
}

function roots(fs: Filesystem, input?: unknown): Scoped[] {
  return input ? [scope(fs, input)] : [scope(fs, own), scope(fs, shared)]
}

function manage(fs: Filesystem, path: Scoped): void {
  if (path.space === SYSTEM_COMPILE) denied('Compile example skills are read-only.')
  if (path.space === SHARED_SKILLS && fs.caller.role !== 'admin') denied('Only an account admin can modify shared skills.')
}

function packageOf(fs: Filesystem, path: FsPath): Scoped | undefined {
  if (path.kind !== 'skill') return
  const parts = path.parts.slice(0, path.parts[0] === 'agent' ? 3 : 4)
  if (path.parts.length <= parts.length) return
  const pkg = fromParts(parts, fs.caller) as Scoped
  return skillRow(fs, pkg)?.current_revision ? pkg : undefined
}

function wire(row: SkillRow, hit?: { uri: string }) {
  const meta = JSON.parse(row.metadata) as SkillMetadata
  return { type: 'skill', name: meta.name, uri: hit?.uri ?? row.uri, root_uri: row.uri, skill_md_uri: `${row.uri}/SKILL.md`,
    description: meta.description, tags: meta.tags, allowed_tools: meta.allowed_tools, ...ownership(row) }
}

function select(fs: Filesystem, name: string, target?: string, audit = false): { path: Scoped; row: SkillRow } {
  const choices = target ? [...roots(fs, target), ...(!audit ? roots(fs) : [])] : roots(fs)
  for (const path of choices.map(root => child(fs, root, [name]))) {
    const row = skillRow(fs, path)
    if (row && (audit || row.current_revision && fs.entry(path)?.is_dir)) return { path, row }
  }
  return missing()
}

function targetFields(target: unknown, allowed: string[]) { return target ? { root_uri: allowed[0] } : { root_uris: allowed } }

function list(fs: Filesystem, query: URLSearchParams): Response {
  const target = queryString(query, 'target_uri')
  const allowed = roots(fs, target)
  const limit = queryInt(query, 'node_limit', 1000, 0, 1000) || 1000
  const skills = allowed.map(root => root.space === SYSTEM_COMPILE ? exampleSkills(fs.ctx).slice(0, limit).map(example => {
    const uri = `${EXAMPLE_SKILLS}/${example.name}`
    return { type: 'skill', uri, root_uri: uri, skill_md_uri: `${uri}/SKILL.md`, name: example.name,
      description: example.description, tags: [], allowed_tools: [], read_only: true }
  }) : skillRows(fs, root, limit).map(row => wire(row))).flat()
  return ok({ ...targetFields(target, allowed.map(path => path.uri)), skills, total: skills.length })
}

function show(fs: Filesystem, name: string, query: URLSearchParams): Response {
  const { path, row } = select(fs, name, queryString(query, 'target_uri'))
  const level = queryInt(query, 'level', -1, 0, 2)
  const include = queryBool(query, 'include_content', level === -1)
  const files = queryBool(query, 'include_files', true)
  const integrity = queryBool(query, 'include_integrity')
  const source = queryBool(query, 'include_source')
  if (integrity && !files) invalid('include_integrity requires include_files.')
  const manifest = JSON.parse(row.manifest) as ManifestFile[]
  const contents = (leaf: string) => fs.read(`${path.uri}/${leaf}`)
  const result = { ...wire(row), metadata: (JSON.parse(row.metadata) as SkillMetadata).metadata, history: skillHistory(fs, path),
    ...((level === -1 || level === 0) && { abstract: contents('.abstract.md') }),
    ...((level === -1 || level === 1) && { overview: contents('.overview.md') }),
    ...((level === 2 || include) && { content: contents('SKILL.md'), content_sha256: manifest.find(file => file.path === 'SKILL.md')?.sha256 }),
    ...(files && { files: integrity ? manifest : manifest.map(({ size: _size, sha256: _sha, ...file }) => file) }),
    ...(integrity && { revision: row.current_revision }), ...(source && { source: JSON.parse(row.source) }) }
  return ok(result)
}

async function find(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  onlyKeys(body, 'query limit score_threshold level target_uri telemetry')
  transport(body)
  if (!str(body.query, 'query', '', 1024).trim()) invalid('A skill query must not be empty.')
  const target = body.target_uri ? fs.path(body.target_uri) : undefined
  if (target?.space === SYSTEM_COMPILE) unsupported('Compile example skills use an authored catalogue, not a semantic index.')
  const allowed = roots(fs, body.target_uri)
  const { hits } = await rankedHits(fs, { ...body, target_uri: target?.uri ?? allowed.map(path => path.uri), context_type: 'skill' },
    hit => packageOf(fs, hit)?.uri)
  const skills = hits.map(hit => {
    const path = packageOf(fs, fs.path(hit.uri))!
    return { ...wire(skillRow(fs, path)!, hit), score: hit.score, abstract: hit.abstract, match_reason: hit.match_reason, level: hit.level }
  })
  return ok({ ...targetFields(body.target_uri, allowed.map(path => path.uri)), skills, total: skills.length })
}

type PackageNode = { path: Scoped; rel: string; kind: string; content?: string }
function packageNodes(fs: Filesystem, dir: Scoped, definition: ReturnType<typeof defineSkill>) {
  const nodes = new Map<string, PackageNode>()
  const add = (parts: string[], node: Omit<PackageNode, 'path' | 'rel'>) => {
    const rel = parts.join('/')
    if (nodes.has(rel)) invalid('Duplicate or colliding skill file.')
    nodes.set(rel, { path: child(fs, dir, parts), rel, ...node })
  }
  add(['SKILL.md'], { kind: 'definition', content: definition.content })
  add(['.abstract.md'], { kind: 'summary', content: definition.report.description })
  add(['.overview.md'], { kind: 'summary', content: excerpt(definition.body.trim(), 4096) || definition.report.description })
  for (const [rel, value] of Object.entries(definition.files)) {
    const parts = rel.split('/').map(filename)
    if (parts.some(part => part.startsWith('.'))) invalid('Hidden paths are reserved in skill packages.')
    textFile(parts.at(-1)!)
    for (let depth = 1; depth < parts.length; depth++) {
      const dirs = parts.slice(0, depth)
      const existing = nodes.get(dirs.join('/'))
      if (!existing) add(dirs, { kind: 'directory' })
      else if (existing.content !== undefined) invalid('A skill file cannot also be a directory.')
    }
    add(parts, { kind: 'auxiliary', content: str(value, 'skill attachment', undefined, FILE_LIMIT) })
    if (nodes.size > manifestCap) quota('Skill package entry limit exceeded.')
  }
  const bytes = [...nodes.values()].reduce((n, node) => n + (node.content !== undefined ? textSize(node.content) : 0), 0)
  if (bytes > packageCap) quota('Skill package text limit exceeded.')
  return { bytes, nodes: [...nodes.values()].sort((a, b) => compare(a.rel, b.rel)) }
}

type Definition = ReturnType<typeof defineSkill>
type SkillTree = ReturnType<typeof packageNodes>

function publishSkill(fs: Filesystem, path: Scoped, before: SkillRow | undefined, definition: Definition, tree: SkillTree,
  manifest: ManifestFile[], revision: string, source: Record<string, unknown>, indexes?: Map<string, VectorIndex>) {
  fs.mkdir(path, definition.report.description)
  for (const node of tree.nodes) {
    if (node.content === undefined) fs.mkdir(node.path, '')
    else fs.storeFile(node.path, node.content, textSize(node.content), indexes ? indexes.get(node.rel)! : emptyIndex, [])
  }
  const { name, description, tags, allowed_tools, metadata } = definition.report
  return storeSkill(fs, path, before, { metadata: { name, description, tags, allowed_tools, metadata }, manifest, source, revision })
}

export function backupSkillTree(fs: Filesystem, uri: string, content: string, files: Record<string, string>) {
  const root = scope(fs, own), path = fs.path(uri) as Scoped
  const name = nameOf(path.uri)
  if (fs.parent(path).uri !== root.uri || path.uri !== uri || !skillNamePattern.test(name)) invalid('Expected a private skill package URI.')
  const definition = dataOnlySkill(content, name)
  definition.files = files
  return { path, definition, tree: packageNodes(fs, path, definition) }
}

/** Produce the same manifest as the normal Skills façade without provider I/O. */
export async function prepareBackupSkill(fs: Filesystem, prepared: ReturnType<typeof backupSkillTree>, source: 'backup'|'compile' = 'backup') {
  const { path, definition, tree } = prepared
  const manifest = await Promise.all(tree.nodes.map(async node => ({ name: nameOf(node.path.uri), path: node.rel, uri: node.path.uri,
    kind: node.kind, is_dir: node.content === undefined, ...(node.content !== undefined && {
      size: textSize(node.content), sha256: await sha256(node.content),
    }) })))
  const revision = await sha256(JSON.stringify(manifest.map(item => [item.path, item.is_dir, item.size, item.sha256])))
  return { tree, path, fs, publish: () => {
    if (fs.entry(path) || skillRow(fs, path)) conflict('A recovered skill cannot replace another package or its history.')
    publishSkill(fs, path, undefined, definition, tree, manifest, revision, { tracked: false, type: source })
  } }
}

async function install(fs: Filesystem, request: Request, updating?: string): Promise<Response> {
  const body = await readJson(request, payloadCap)
  onlyKeys(body, `data temp_file_id target_uri source_metadata wait timeout telemetry ${updating ? 'from_source' : 'skills list_only'}`)
  transport(body)
  if (bool(body.from_source, 'from_source')) unsupported('Remote skill source refresh is not available.')
  const preview = bool(body.list_only, 'list_only')
  if ((body.data == null) === (body.temp_file_id == null)) invalid('Supply exactly one of data and temp_file_id.')
  const id = body.temp_file_id != null ? uploadId(body.temp_file_id) : undefined
  // Scope the upload before other source or target inspection, for both preview
  // and install. A staged file is data, not an operating-system path.
  const staged = id ? getUpload(fs, id) : undefined
  if (preview && !staged) invalid('Listing a skill source requires a staged Markdown file.')
  if (body.skills != null && (!Array.isArray(body.skills) || body.skills.length)) invalid('Skill selection requires a directory or a Git source.')
  if (staged?.original_name != null) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Supply a staged Markdown skill, not a converted document.')
  if (body.source_metadata != null && !isRecord(body.source_metadata)) invalid('source_metadata must be an object.')
  const selected = updating ? select(fs, updating, str(body.target_uri ?? undefined, 'target_uri', '')) : undefined
  const root = selected ? fs.parent(selected.path) as Scoped : scope(fs, body.target_uri)
  manage(fs, root)
  const input = staged ? staged.body : body.data
  if (typeof input === 'string' && /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(input.trim())) unsupported('Remote skill sources are not fetched by Edge.')
  const definition = defineSkill(input)
  return installDefinition(fs, root, definition, { staged, id, preview, updating, selected, sourceMetadata: body.source_metadata })
}

type InstallOptions = { staged?: MultipartUpload; id?: string; preview: boolean; updating?: string;
  selected?: ReturnType<typeof select>; sourceMetadata?: unknown; transfer?: SkillTransfer }

async function installDefinition(fs: Filesystem, root: Scoped, definition: ReturnType<typeof defineSkill>,
  { staged, id, preview, updating, selected, sourceMetadata, transfer }: InstallOptions): Promise<Response> {
  const name = definition.report.name
  if (!definition.report.valid || !skillNamePattern.test(name)) invalid(definition.report.errors[0]?.message ?? 'Invalid skill name.')
  if (updating && name !== updating) invalid('The new Skill name must match the URL name.')
  const path = selected?.path ?? child(fs, root, [name])
  if (transfer) {
    if (path.uri !== transfer.uri) invalid('The skill name must match the ticket.')
    checkSkillTransfer(fs, transfer)
  }
  const tree = packageNodes(fs, path, definition)
  if (preview) {
    // This is the stock CLI's source inspection, not a publication or a
    // reservation. No provider, transaction or consumption is necessary.
    return ok({ skills: [{ name, description: definition.report.description, path: staged!.name }], total: 1 })
  }
  const before = selected?.row ?? skillRow(fs, path)
  const dirsBefore = fs.entry(path)
  if (!!before?.current_revision !== !!dirsBefore?.is_dir) conflict('The skill package and metadata do not agree.')
  const source = { tracked: true, type: 'api', source: transfer ? 'gateway_upload' : id ? 'temp_upload' : 'inline_content',
    operation: updating || before?.current_revision ? 'update' : 'add', skill_name: name,
    ...(staged && { original_filename: staged.name, upload_mode: 'local' }) }
  // For uploads, provenance comes only from the stored basename. The stock
  // client's source_metadata can contain its local absolute path; discard it.
  if (!staged && isRecord(sourceMetadata)) for (const key of ['type', 'source'] as const) {
    if (sourceMetadata[key] != null) source[key] = str(sourceMetadata[key], key, undefined, 256)
  }
  const oldRows = dirsBefore ? fs.storedEntries(path) : []
  fs.limits(path.space, tree.nodes.length + 1 - oldRows.length, tree.bytes - oldRows.reduce((n, row) => n + row.bytes, 0))
  const indexes = new Map<string, VectorIndex>(), manifest: ManifestFile[] = []
  for (const node of tree.nodes) {
    fs.ctx.assertActive?.()
    const item = { name: nameOf(node.path.uri), path: node.rel, uri: node.path.uri, is_dir: node.content === undefined, kind: node.kind }
    if (node.content === undefined) manifest.push(item)
    else {
      const size = textSize(node.content), hash = await sha256(node.content)
      indexes.set(node.rel, await documentIndex(fs.ctx, node.content))
      manifest.push({ ...item, size, sha256: hash })
    }
  }
  const revision = await sha256(JSON.stringify(manifest.map(item => [item.path, item.is_dir, item.size, item.sha256])))
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => {
    fs.ctx.assertActive?.()
    manage(fs, root)
    if (transfer) checkSkillTransfer(fs, transfer)
    if (id) getUpload(fs, id)
    if (skillRow(fs, path)?.stamp !== before?.stamp || fs.entry(path)?.revision !== dirsBefore?.revision) conflict('The skill package changed while indexing.')
    if (dirsBefore) fs.remove(path, true)
    const row = publishSkill(fs, path, before, definition, tree, manifest, revision, source, indexes)
    if (id) consumeUpload(fs, id)
    return ok({ status: 'success', uri: path.uri, root_uri: path.uri, name,
      auxiliary_files: manifest.filter(file => file.kind === 'auxiliary').length, ...ownership(row), ...(updating && { action: 'update' }) })
  })
}

export type SkillTransfer = { uri: string; preview: boolean; stamp: string }

function skillTransferStamp(fs: Filesystem, path: Scoped, preview: boolean): string {
  const row = skillRow(fs, path), dir = fs.entry(path)
  if (!preview && (dir || row?.current_revision)) conflict('The signed skill target already exists.')
  return JSON.stringify([row?.stamp ?? null, dir?.revision ?? null])
}

export function prepareSkillTransfer(fs: Filesystem, body: Record<string, unknown>): SkillTransfer {
  onlyKeys(body, 'target_uri skills list_only filename')
  if (body.filename !== undefined && body.filename !== 'SKILL.md') invalid('A signed skill upload requires SKILL.md.')
  const target = fs.path(body.target_uri ?? own)
  const root = scope(fs, target.uri)
  manage(fs, root)
  const selected = body.skills
  if (selected !== undefined && (!Array.isArray(selected) || selected.length !== 1)) invalid('Select exactly one skill name.')
  const name = target.uri === root.uri ? selected?.[0] : nameOf(target.uri)
  if (typeof name !== 'string' || !skillNamePattern.test(name) || selected !== undefined && selected[0] !== name) {
    invalid('Specify one skill name or its exact target_uri.')
  }
  const path = child(fs, root, [name])
  if (target.uri !== root.uri && target.uri !== path.uri) invalid('Expected the skills root or the exact skill package URI.')
  const preview = bool(body.list_only, 'list_only')
  return { uri: path.uri, preview, stamp: skillTransferStamp(fs, path, preview) }
}

export function checkSkillTransfer(fs: Filesystem, transfer: SkillTransfer): void {
  const path = fs.path(transfer.uri) as Scoped
  manage(fs, scope(fs, path.uri))
  if (skillTransferStamp(fs, path, transfer.preview) !== transfer.stamp) conflict('The signed skill target changed. Request a new ticket.')
}

export async function publishSkillTransfer(fs: Filesystem, transfer: SkillTransfer, upload: MultipartUpload): Promise<Response> {
  if (upload.name !== 'SKILL.md') invalid('A signed skill upload requires SKILL.md.')
  await fs.ctx.reauthorize?.()
  fs.ctx.assertActive?.()
  return installDefinition(fs, scope(fs, transfer.uri), defineSkill(upload.body), { staged: upload, preview: transfer.preview, transfer })
}

const method = (request: Request, ...allowed: string[]) => {
  if (!allowed.includes(request.method) && !(request.method === 'HEAD' && allowed.includes('GET'))) {
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Use ${allowed.join(' or ')} for this route.`)
  }
}

export async function routeSkills(fs: Filesystem, request: Request, url: URL): Promise<Response | undefined> {
  if (url.pathname === prefix) {
    method(request, 'GET', 'POST')
    return request.method === 'POST' ? install(fs, request) : list(fs, url.searchParams)
  }
  if (!url.pathname.startsWith(`${prefix}/`)) return
  const [segment, suffix, ...rest] = url.pathname.slice(prefix.length + 1).split('/')
  if (rest.length || suffix !== undefined && suffix !== 'audit') missing()
  if (suffix === undefined && segment === 'validate' && request.method === 'POST') {
    const body = await readJson(request, payloadCap)
    onlyKeys(body, 'data strict source_path skill_dir_name target_uri')
    const definition = defineSkill(body.data, bool(body.strict, 'strict'),
      body.skill_dir_name == null ? undefined : str(body.skill_dir_name, 'skill_dir_name', undefined, 160),
      body.source_path == null ? undefined : str(body.source_path, 'source_path', undefined, 1024))
    return ok(definition.report)
  }
  if (suffix === undefined && segment === 'find' && request.method === 'POST') return find(fs, request)
  let name: string
  try { name = decodeURIComponent(segment) } catch { return invalid('Invalid skill name.') }
  if (!skillNamePattern.test(name)) invalid('Invalid skill name.')
  const target = queryString(url.searchParams, 'target_uri')
  if (suffix === 'audit') {
    method(request, 'GET')
    const { path, row } = select(fs, name, target, true)
    return ok({ name, uri: path.uri, root_uri: path.uri, ...ownership(row), deleted: row.current_revision === null,
      events: skillHistory(fs, path, queryInt(url.searchParams, 'limit', 50, 1, 1000)) })
  }
  method(request, 'GET', 'PUT', 'DELETE')
  if (request.method === 'PUT') return install(fs, request, name)
  if (request.method !== 'DELETE') return show(fs, name, url.searchParams)
  const { path, row } = select(fs, name, target)
  manage(fs, path)
  return fs.atomic(() => {
    const count = fs.remove(path, true)
    storeSkill(fs, path, row, null)
    return ok({ name, uri: path.uri, root_uri: path.uri, estimated_deleted_count: count })
  })
}
