// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, ok, readBytes, readJson } from '../http.js'
import { aclSpec } from '../acl.js'
import type { WorkspaceContext } from '../context.js'
import {
  FILE_LIMIT, JSON_LIMIT, bool, conflict, exists, filename, fromParts, invalid, missing,
  nameOf, onlyKeys, parseTags, pathFor, quota, resourcePath, str, tagMode, textFile, textSize, transport, unsupported, writable,
} from './contract.js'
import type { FsPath } from './contract.js'
import { processingMode } from './content.js'
import type { Filesystem, VectorIndex } from './store.js'
import { documentIndex, embeddingUnavailable } from './vectors.js'
import { assertPendingClear, assertUploadFree, pendingFor, release, reserve } from './pending.js'
import { summaryNames } from './analysis.js'
import { admitsFileLevels, prepareLevels, publishFileLevels } from './file-levels.js'
import { ensureParentPlan, nextResourceLeaf } from './import-target.js'
import { importUrl, isOneShotUrlImport } from './url-import.js'

const UPLOAD_TTL = 30 * 60 * 1000
const TEMP_SLOTS = 16
const USER_TEMP_SLOTS = 32
const USER_TEMP_BYTES = 1024 * 1024
const ACCOUNT_TEMP_SLOTS = 128
const ACCOUNT_TEMP_BYTES = 4 * 1024 * 1024
const FORM_OVERHEAD = 8192
const CONVERT_LIMIT = 1024 * 1024
const documentExtension = /\.(?:pdf|docx|xlsx|pptx|png|jpe?g)$/i
const safeMime = /^(?:text\/(?:plain|markdown|x-markdown|csv|tab-separated-values|yaml|x-yaml|x-python|javascript|typescript|x-rst)|application\/(?:octet-stream|json|yaml|x-yaml|toml|javascript|typescript))$/i

export type MultipartUpload = { name: string; original_name: string | null; body: string; bytes: number }
type Uploaded = MultipartUpload & { expires_at: number }
const mediaError = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload one supported UTF-8 text file.')
const identity = (fs: Filesystem) => [fs.account, fs.caller.userId, fs.caller.agentId] as const

export async function readMultipartUpload(request: Request, ctx?: WorkspaceContext, signal?: AbortSignal): Promise<MultipartUpload> {
  const type = request.headers.get('content-type')
  if (!type || !/^multipart\/form-data\s*;/i.test(type)) throw mediaError()
  const convert = ctx?.convertDocument
  const data = await readBytes(request, (convert ? CONVERT_LIMIT : FILE_LIMIT) + FORM_OVERHEAD, signal)
  let form: FormData
  try { form = await new Response(data, { headers: { 'Content-Type': type } }).formData() }
  catch { return invalid('Invalid multipart upload.') }
  const parts = form.getAll('file')
  if (parts.length !== 1 || typeof parts[0] === 'string') invalid('Exactly one multipart file part is required.')
  for (const key of form.keys()) {
    if (!['file', 'telemetry', 'upload_mode'].includes(key) || form.getAll(key).length !== 1) invalid('Unexpected or repeated multipart field.')
  }
  const mode = form.get('upload_mode')
  if (mode !== null && mode !== 'local') unsupported('Only private edge staging is implemented for temp_upload.')
  const telemetry = form.get('telemetry')
  if (telemetry !== null && !['true', 'false', '1', '0'].includes(String(telemetry))) invalid('Invalid multipart telemetry flag.')
  const file = parts[0]
  let name = filename(file.name)
  let originalName: string | null = null
  let body: string
  if (convert && documentExtension.test(name)) {
    if (file.size > CONVERT_LIMIT || data.byteLength - file.size > FORM_OVERHEAD) quota('Document multipart limit exceeded.')
    await ctx?.reauthorize?.()
    const result = await convert(file.name === name ? file : new File([file], name, { type: file.type }))
    if (!result) throw mediaError()
    originalName = name
    name = filename(result.filename)
    if (!/\.md$/i.test(name)) throw new ApiError(503, 'CONVERSION_UNAVAILABLE', 'The converter did not return a Markdown filename.')
    body = str(result.content, 'converted document', undefined, FILE_LIMIT * 2)
  } else {
    textFile(name)
    if (file.type && !safeMime.test(file.type.split(';', 1)[0].trim())) throw mediaError()
    if (file.size > FILE_LIMIT || data.byteLength - file.size > FORM_OVERHEAD) quota(`File exceeds ${FILE_LIMIT} UTF-8 bytes or the multipart limit.`)
    const bytes = await file.arrayBuffer()
    try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw mediaError() }
  }
  return { name, original_name: originalName, body, bytes: textSize(body) }
}

export async function tempUpload(fs: Filesystem, request: Request, url: URL): Promise<Response> {
  if (url.searchParams.has('token')) unsupported('Signed uploads are not implemented; use authenticated requests.')
  const { name, original_name: originalName, body, bytes: size } = await readMultipartUpload(request, fs.ctx)
  const id = crypto.randomUUID()
  await fs.ctx.reauthorize?.()
  fs.atomic(() => {
    const now = Date.now()
    fs.sql.exec('DELETE FROM ov_edge_fs_upload WHERE account_id=? AND expires_at<=?', fs.account, now)
    const actor = fs.sql.exec<{ count: number }>(`SELECT count(*) AS count FROM ov_edge_fs_upload
      WHERE account_id=? AND user_id=? AND agent_id=?`, ...identity(fs)).one()
    const user = fs.sql.exec<{ count: number; bytes: number }>(`SELECT count(*) AS count,
      coalesce(sum(bytes),0) AS bytes FROM ov_edge_fs_upload WHERE account_id=? AND user_id=?`, fs.account, fs.caller.userId).one()
    const account = fs.sql.exec<{ count: number; bytes: number }>(`SELECT count(*) AS count,
      coalesce(sum(bytes),0) AS bytes FROM ov_edge_fs_upload WHERE account_id=?`, fs.account).one()
    if (actor.count >= TEMP_SLOTS || user.count >= USER_TEMP_SLOTS || user.bytes + size > USER_TEMP_BYTES ||
        account.count >= ACCOUNT_TEMP_SLOTS || account.bytes + size > ACCOUNT_TEMP_BYTES) {
      quota('Temporary upload quota exceeded; consume an upload or wait for expiry.')
    }
    fs.sql.exec(`INSERT INTO ov_edge_fs_upload (account_id,user_id,agent_id,id,name,original_name,body,bytes,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, ...identity(fs), id, name, originalName, body, size, now + UPLOAD_TTL)
  })
  return ok({ temp_file_id: id, filename: name, size })
}

export function getUpload(fs: Filesystem, id: string): Uploaded {
  const upload = fs.sql.exec<Uploaded>(`SELECT name,original_name,body,bytes,expires_at FROM ov_edge_fs_upload
    WHERE account_id=? AND user_id=? AND agent_id=? AND id=? AND expires_at>?`, ...identity(fs), id, Date.now()).toArray()[0] ?? missing()
  assertUploadFree(fs.ctx, id)
  return upload
}

export function uploadId(value: unknown): string {
  const id = str(value, 'temp_file_id', undefined, 36)
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) invalid('Invalid temp_file_id.')
  return id
}

export function consumeUpload(fs: Filesystem, id: string): void {
  fs.sql.exec('DELETE FROM ov_edge_fs_upload WHERE account_id=? AND user_id=? AND agent_id=? AND id=?', ...identity(fs), id)
}

function destination(fs: Filesystem, to: FsPath | undefined, parent: FsPath | undefined,
  asDirectory: boolean, name: string, create: boolean, exactName: boolean) {
  if (to) {
    writable(to, fs.caller)
    if (fs.entry(to, 'write')) exists()
    const path = asDirectory ? fromParts([...to.parts, name], fs.caller) : to
    writable(path, fs.caller)
    textFile(nameOf(path.uri))
    const plan = ensureParentPlan(fs, fs.parent(to), create)
    if (asDirectory) plan.dirs.push(to)
    return { ...plan, path, warning: undefined }
  }
  if (!parent) return invalid('Missing resources parent.')
  const plan = ensureParentPlan(fs, parent, create)
  if (!exactName) return { ...plan, ...nextResourceLeaf(fs, parent, name) }
  const path = fromParts([...parent.parts, name], fs.caller)
  writable(path, fs.caller)
  if (fs.entry(path, 'write')) return exists()
  return { ...plan, path, warning: undefined }
}

function importOptions(fs: Filesystem, body: Record<string, unknown>) {
  const toArg = str(body.to ?? undefined, 'to', '')
  const parentArg = str(body.parent ?? undefined, 'parent', '')
  if (toArg && parentArg) invalid('Specify to or parent, not both.')
  const to = toArg ? fs.path(toArg) : undefined
  const parent = to ? undefined : fs.path(parentArg || 'viking://resources')
  if (to) resourcePath(to)
  if (parent) resourcePath(parent, true)
  const asDirectory = !!to && (toArg.endsWith('/') || !nameOf(to.uri).includes('.'))
  const processing = processingMode(body.processing_mode)
  const mode = tagMode(body.tag_mode)
  const tags = mode === 'clear' ? [] : parseTags(body.tags)
  const reason = str(body.reason ?? undefined, 'reason', '', 512)
  const spec = aclSpec(body.acl)
  return { to, parent, asDirectory, processing, tags, reason, spec }
}

type ImportOptions = ReturnType<typeof importOptions>
function planImport(fs: Filesystem, options: ImportOptions, name: string, bytes: number,
  analyze: boolean, create: boolean, exactName = false) {
  const { to, parent, asDirectory, spec } = options
  const plan = destination(fs, to, parent, asDirectory, name, create, exactName)
  const root = asDirectory ? to! : plan.path
  const target = plan.dirs[0] ?? plan.path
  fs.acl.authorize(plan.path, 'write')
  fs.acl.prepare(root, spec)
  assertPendingClear(fs.ctx, target, true)
  const levels = analyze && asDirectory ? summaryNames.map(name => {
    const path = fromParts([...root.parts, name], fs.caller)
    writable(path, fs.caller)
    fs.acl.authorize(path, 'write')
    return path
  }) : []
  fs.limits(plan.path.space, plan.dirs.length + 1 + (analyze ? 2 : 0), bytes)
  return { ...plan, root, target, levels,
    stamp: JSON.stringify([root.uri, plan.path.uri, plan.anchor.uri, plan.revision, plan.dirs.map(path => path.uri)]) }
}

type ImportPlan = ReturnType<typeof planImport>
type Summaries = Awaited<ReturnType<typeof prepareLevels>>
function publishImport(fs: Filesystem, options: ImportOptions, plan: ImportPlan, upload: MultipartUpload,
  index: VectorIndex, summaries: Summaries) {
  const { to, reason, tags, spec, asDirectory, processing } = options
  fs.limits(plan.path.space, plan.dirs.length + 1 + summaries.length,
    upload.bytes + summaries.reduce((bytes, item) => bytes + item.bytes, 0),
    (index.vectors?.byteLength ?? 0) + summaries.reduce((bytes, item) => bytes + (item.index.vectors?.byteLength ?? 0), 0))
  for (const dir of plan.dirs) fs.mkdir(dir, dir.uri === to?.uri ? reason : '')
  const materialized = fs.storeFile(plan.path, upload.body, upload.bytes, index, tags, undefined, reason)
  if (summaries.length && asDirectory) {
    if (!materialized.content_version) throw new ApiError(500, 'INTERNAL_ERROR', 'The analyzed document version was not recorded.')
    const dependency = { uri: materialized.uri, version: materialized.content_version }
    for (const item of summaries) fs.storeFile(plan.levels[item.level], item.body, item.bytes, item.index, [], undefined, '', undefined, dependency)
  } else if (summaries.length) publishFileLevels(fs, plan.path, materialized, summaries)
  if (spec) fs.acl.apply(plan.root, spec)
  const warnings: string[] = []
  if (plan.warning) warnings.push(plan.warning)
  if (processing === 'semantic_and_vectors' && !summaries.length) warnings.push('No L0/L1 generated; enabled generation and an eligible staged text import are required.')
  return { status: 'success', root_uri: plan.root.uri, ...(warnings.length && { warnings }) }
}

export type ResourceTransfer = { uri: string; name: string; input: Record<string, unknown>; stamp: string }

/** Resolve one create-only target through the resource facade; never stage a file in SQLite. */
export function prepareResourceTransfer(fs: Filesystem, body: Record<string, unknown>): ResourceTransfer {
  onlyKeys(body, 'filename to parent reason processing_mode tags tag_mode parse_mode acl')
  if (body.parse_mode !== undefined && body.parse_mode !== 'default' && body.parse_mode !== 'no_split') {
    unsupported('Only default and no_split are supported for signed text imports.')
  }
  const { filename: requested, ...input } = body
  const name = filename(requested)
  textFile(name)
  const options = importOptions(fs, input)
  const plan = planImport(fs, options, name, 0, false, false, true)
  return { uri: plan.root.uri, name, input, stamp: plan.stamp }
}

export function checkResourceTransfer(fs: Filesystem, transfer: ResourceTransfer, options = importOptions(fs, transfer.input),
  bytes = 0, analyze = false): ImportPlan {
  const plan = planImport(fs, options, transfer.name, bytes, analyze, false, true)
  if (plan.stamp !== transfer.stamp) conflict('The signed resource destination changed. Request a new ticket.')
  return plan
}
export async function publishResourceTransfer(fs: Filesystem, transfer: ResourceTransfer, upload: MultipartUpload): Promise<Response> {
  if (upload.name !== transfer.name) invalid('The upload filename does not match the ticket.')
  const options = importOptions(fs, transfer.input)
  const analyze = options.processing === 'semantic_and_vectors' && !!fs.ctx.generate &&
    !upload.name.startsWith('.') && !!upload.body.trim()
  const check = () => { fs.ctx.assertActive?.(); return checkResourceTransfer(fs, transfer, options, upload.bytes, analyze) }
  await fs.ctx.reauthorize?.()
  const before = check()
  const summaries = analyze && (options.asDirectory || admitsFileLevels(before.path)) ?
    await prepareLevels(fs.ctx, nameOf(before.path.uri), upload.body, async () => { await fs.ctx.reauthorize?.(); check() }) : []
  const index = await documentIndex(fs.ctx, upload.body)
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => ok(publishImport(fs, options, check(), upload, index, summaries)))
}

export async function addResource(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, JSON_LIMIT)
  if (typeof body.path === 'string' && /^https?:\/\//i.test(body.path)) {
    if (body.temp_file_id != null) invalid('Supply a URL or a staged upload, not both.')
    if (isOneShotUrlImport(body)) return importUrl(fs, body)
    if (fs.ctx.registerWatch) {
      onlyKeys(body, 'path to to_uri uri reason instruction wait timeout telemetry watch_interval processing_mode')
      transport(body)
      processingMode(body.processing_mode)
      const destinations = [body.to, body.to_uri, body.uri].filter(value => value != null)
      if (new Set(destinations).size > 1) invalid('Supply one remote import destination.')
      const uri = destinations[0] ?? invalid('Remote textual inputs require an exact destination URI.')
      const path = fs.path(uri)
      resourcePath(path)
      fs.checkWriteParent(path.uri)
      // Watch is still a separate operation with an exact destination and schedule.
      const result = await fs.ctx.registerWatch({ ...body, to_uri: path.uri })
      if (result) return result
    }
  }
  onlyKeys(body, 'path temp_file_id add_type to parent create_parent reason instruction wait timeout strict internal_task source_name ignore_dirs include exclude directly_upload_media preserve_structure args connector_auth_config telemetry watch_interval is_active processing_mode tags tag_mode acl')
  transport(body)
  bool(body.strict, 'strict')
  bool(body.directly_upload_media, 'directly_upload_media')
  const preserve = bool(body.preserve_structure ?? undefined, 'preserve_structure')
  const active = bool(body.is_active, 'is_active', true)
  const internal = bool(body.internal_task, 'internal_task')
  if (body.path != null || body.add_type != null || body.connector_auth_config != null ||
      body.ignore_dirs || body.include || body.exclude || body.instruction || preserve ||
      (body.watch_interval != null && body.watch_interval !== 0) || !active || internal) {
    unsupported('Only a staged text file can be imported. Remote sources, connectors, parser instructions and watches are not supported.')
  }
  if (body.args != null) {
    if (typeof body.args !== 'object' || Array.isArray(body.args)) invalid('args must be an object.')
    const args = body.args as Record<string, unknown>
    if (Object.keys(args).some(key => key !== 'parse_mode') ||
        (args.parse_mode !== undefined && args.parse_mode !== 'default' && args.parse_mode !== 'no_split')) {
      unsupported('Only the exact text body can be imported; no external parser options are available.')
    }
  }
  const id = uploadId(body.temp_file_id)
  // Check the token under actor scope before resolving a destination. Unknown and foreign ids look identical.
  const upload = getUpload(fs, id)
  const options = importOptions(fs, body)
  const { to, asDirectory, processing } = options
  const wait = bool(body.wait, 'wait', true)
  const requestedName = body.source_name == null ? upload.name : filename(body.source_name)
  const name = requestedName === upload.original_name ? upload.name : requestedName
  textFile(name)
  const create = bool(body.create_parent, 'create_parent')
  // Leave the default name, type and async admission contract unchanged. The
  // original synchronous upload without `to` analyzes its actual flat leaf.
  const flatAnalysis = !to && body.wait === true && !fs.ctx.taskId
  const analyze = processing === 'semantic_and_vectors' && (asDirectory || flatAnalysis) && !!fs.ctx.generate &&
    !name.startsWith('.') && !!upload.body.trim()
  const plan = () => planImport(fs, options, name, upload.bytes, analyze, create)
  const before = plan()
  const checkPlan = () => {
    const fresh = plan()
    if (fresh.stamp !== before.stamp) conflict('The import destination changed; retry the upload.')
    return fresh
  }
  if (!wait && !fs.ctx.taskId) {
    if (!fs.ctx.jobs) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'Staged import requires an active task queue.')
    if (fs.ctx.hasEmbedding === false && upload.body.trim()) throw embeddingUnavailable()
    await fs.ctx.reauthorize?.()
    const job = await fs.ctx.jobs.enqueue('add_resource', before.root.uri, { body: { ...body, wait: true } }, {
      meta: { staged_atomic: true },
      onAccepted(task) {
        getUpload(fs, id)
        const fresh = checkPlan()
        reserve(fs.ctx, task.task_id, fresh.target, 'resource', fresh.stamp, { uploadId: id, subtree: true })
      },
    })
    return ok({ status: 'accepted', task_id: job.task_id, root_uri: before.root.uri, uri: before.root.uri })
  }
  if (fs.ctx.taskId) {
    if (!fs.ctx.finishJobInTransaction || !fs.ctx.assertActive) throw new ApiError(503, 'TASK_QUEUE_UNAVAILABLE', 'The staged import consumer is not mounted.')
    fs.ctx.assertActive()
    const [reserved, extra] = pendingFor(fs.ctx, 'resource')
    if (!reserved || extra || reserved.upload_id !== id || reserved.uri !== before.target.uri ||
        reserved.space !== before.target.space || reserved.stamp !== before.stamp) conflict('The import reservation no longer matches the destination.')
  }
  let summaries: Awaited<ReturnType<typeof prepareLevels>> = []
  if (analyze) {
    // The only input is the caller's own, still staged upload; no existing
    // descendants (including hidden or restricted entries) enter the prompt.
    await fs.ctx.reauthorize?.()
    fs.ctx.assertActive?.()
    getUpload(fs, id)
    checkPlan()
    if (asDirectory || admitsFileLevels(before.path)) {
      summaries = await prepareLevels(fs.ctx, nameOf(before.path.uri), upload.body, async () => {
        await fs.ctx.reauthorize?.()
        fs.ctx.assertActive?.()
        getUpload(fs, id)
        checkPlan()
      })
    }
  }
  const index = await documentIndex(fs.ctx, upload.body)
  await fs.ctx.reauthorize?.()
  return fs.atomic(() => {
    fs.ctx.assertActive?.()
    getUpload(fs, id)
    const result = publishImport(fs, options, checkPlan(), upload, index, summaries)
    consumeUpload(fs, id)
    if (fs.ctx.taskId) {
      fs.ctx.finishJobInTransaction!(result)
      release(fs.ctx, fs.ctx.taskId)
    }
    return ok(result)
  })
}
