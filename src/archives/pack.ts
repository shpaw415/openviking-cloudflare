// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ok, readBytes, readJson } from '../http.js'
import { commitSubtreeMutation, prepareSubtreeMutation, subtreeRevision, type Filesystem } from '../filesystem.js'
import { filename } from '../fs/contract.js'
import { allowed, attachment, bool, conflict, fields, forbidden, internal, invalid, notFound, notImplemented,
  quota, RESOURCES, text } from './common.js'
import { decodePack, encodePack, sourceRoot } from './pack-codec.js'
import { captureAt } from './snapshot.js'
import { ZIP_BYTES } from './zip.js'

const TTL = 30 * 60 * 1000
const ACTOR_SLOTS = 4
const USER_SLOTS = 8
const USER_BYTES = 3_000_000
const ACCOUNT_BYTES = 8_000_000
const ACCOUNT_SLOTS = 32
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const packMedia = new Set(['application/zip', 'application/octet-stream', 'application/vnd.openviking.ovpack', 'application/x-zip-compressed'])

export function initPack({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_pack_upload (
    account TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL,
    name TEXT NOT NULL, body BLOB NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (account,user_id,agent_id,id)
  ) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_pack_expiry ON ov_edge_pack_upload(account,expires_at)')
}

const actor = (fs: Filesystem) => [fs.account, fs.caller.userId, fs.caller.agentId] as const

async function stage(fs: Filesystem, request: Request, url: URL): Promise<Response> {
  if (url.search) invalid('Use an authenticated, local OVPack upload without a query token.')
  const contentType = request.headers.get('content-type')
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType) || contentType.length > 512) return invalid('Expected a multipart OVPack upload.')
  const data = await readBytes(request, ZIP_BYTES + 8192)
  let form: FormData
  try { form = await new Response(data, { headers: { 'content-type': contentType } }).formData() }
  catch { return invalid('Invalid multipart OVPack upload.') }
  const parts = form.getAll('file')
  if (parts.length !== 1 || typeof parts[0] === 'string' || !parts[0]) return invalid('Expected one multipart file.')
  for (const key of form.keys()) if (!['file', 'telemetry', 'upload_mode'].includes(key) || form.getAll(key).length !== 1) {
    invalid('Unexpected or repeated multipart field.')
  }
  if (form.has('upload_mode') && form.get('upload_mode') !== 'local') notImplemented('Only private local OVPack staging is supported.')
  if (form.has('telemetry') && !['true', 'false', '0', '1'].includes(String(form.get('telemetry')))) invalid('Invalid telemetry flag.')
  const file = parts[0], name = filename(file.name)
  if (!name.toLowerCase().endsWith('.ovpack') || (file.type && !packMedia.has(file.type.toLowerCase()))) invalid('Expected an .ovpack ZIP file.')
  if (file.size > ZIP_BYTES) quota('OVPack upload exceeds its ZIP body limit.')
  const bytes = await file.arrayBuffer()
  // A stage never claims the package was validated/imported. Validation runs on import, before any FS mutation.
  const id = crypto.randomUUID()
  await fs.ctx.reauthorize?.()
  fs.atomic(() => {
    const { sql } = fs.ctx, now = Date.now()
    sql.exec('DELETE FROM ov_edge_pack_upload WHERE account=? AND expires_at<=?', fs.account, now)
    const totals = (where: string, ...bindings: string[]) => sql.exec<{ slots: number; bytes: number }>(
      `SELECT count(*) AS slots, coalesce(sum(size),0) AS bytes FROM ov_edge_pack_upload WHERE ${where}`, ...bindings).one()
    const account = totals('account=?', fs.account)
    const user = totals('account=? AND user_id=?', fs.account, fs.caller.userId)
    const key = totals('account=? AND user_id=? AND agent_id=?', ...actor(fs))
    if (account.slots >= ACCOUNT_SLOTS || user.slots >= USER_SLOTS || key.slots >= ACTOR_SLOTS || account.bytes + bytes.byteLength > ACCOUNT_BYTES ||
        user.bytes + bytes.byteLength > USER_BYTES) quota('OVPack staging quota exceeded.')
    sql.exec(`INSERT INTO ov_edge_pack_upload (account,user_id,agent_id,id,name,body,size,expires_at)
      VALUES (?,?,?,?,?,?,?,?)`, ...actor(fs), id, name, bytes, bytes.byteLength, now + TTL)
  })
  return ok({ temp_file_id: id, filename: name, size: bytes.byteLength })
}

async function exportPackage(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, 16 * 1024)
  fields(body, 'uri include_vectors')
  const uri = fs.path(body.uri)
  if (uri.managed || !uri.space) invalid('The selected OVPack collection is not portable.')
  if (bool(body.include_vectors, 'include_vectors')) notImplemented('Dense vector snapshot export is not implemented.')
  const root = sourceRoot(uri.uri)
  const captured = captureAt(fs, uri.uri) ?? notFound('OVPack source does not exist.')
  if (!captured.entries[0].is_dir) invalid('Export OVPack from a directory.')
  const entries = captured.entries.filter(entry => !entry.path.split('/').some(internal))
  const bytes = await encodePack(root, entries)
  await fs.ctx.reauthorize?.()
  if (subtreeRevision(fs, uri.uri) !== captured.revision) conflict('The collection changed during OVPack export.')
  for (const entry of entries) fs.check(entry.path ? `${uri.uri}/${entry.path}` : uri.uri, 'read')
  return new Response(bytes, { headers: { 'content-type': 'application/zip', 'content-disposition': attachment(`${root.name}.ovpack`) } })
}

async function importPackage(fs: Filesystem, request: Request): Promise<Response> {
  const body = await readJson(request, 16 * 1024)
  fields(body, 'temp_file_id parent on_conflict vector_mode')
  const id = text(body.temp_file_id, 'temp_file_id', 36)
  if (!UUID.test(id)) invalid('Invalid OVPack upload ID.')
  const policy = body.on_conflict ?? 'fail', vectors = body.vector_mode ?? 'auto'
  if (policy !== 'fail' && policy !== 'overwrite' && policy !== 'skip') invalid('Unsupported OVPack conflict policy.')
  if (vectors !== 'auto' && vectors !== 'recompute' && vectors !== 'require') invalid('Unsupported OVPack vector mode.')
  if (vectors === 'require') notImplemented('Dense vector snapshot import is not implemented.')
  const where = 'account=? AND user_id=? AND agent_id=? AND id=?'
  const keys = [...actor(fs), id] as const
  const staged = fs.ctx.sql.exec<{ body: ArrayBuffer }>(`SELECT body FROM ov_edge_pack_upload WHERE ${where} AND expires_at>?`, ...keys, Date.now()).toArray()[0]
    ?? notFound('OVPack upload not found or expired.')
  const parent = fs.path(body.parent)
  if (parent.managed && parent.uri !== 'viking://') invalid('The OVPack destination must be an unmanaged collection.')
  const { root, entries } = await decodePack(new Uint8Array(staged.body))
  const isTop = root.uri === RESOURCES
  if (isTop !== (parent.uri === 'viking://')) invalid('Only a top-level resource pack uses the account root parent.')
  if (isTop && policy === 'overwrite') notImplemented('Replacing the shared resources mount through OVPack is disabled.')
  if (!isTop && !fs.stat(parent.uri).is_dir) conflict('OVPack destination parent is not a directory.')
  const uri = isTop ? RESOURCES : fs.path(`${parent.uri}/${root.name}`).uri
  const destination = sourceRoot(uri)
  if (destination.scope !== root.scope) invalid('OVPack cannot cross visibility scopes.')
  if (root.scope === 'user') {
    const src = root.uri.slice('viking://'.length).split('/'), dst = uri.slice('viking://'.length).split('/')
    if (src[2] !== dst[2] || src.length !== dst.length) invalid('Private OVPack destination must match the source context and depth.')
  }
  const current = fs.entry(fs.path(uri))
  const consume = () => {
    const active = fs.ctx.sql.exec(`SELECT 1 FROM ov_edge_pack_upload WHERE ${where} AND expires_at>?`, ...keys, Date.now()).toArray().length
    if (!active) notFound('OVPack upload not found or expired.')
    fs.ctx.sql.exec(`DELETE FROM ov_edge_pack_upload WHERE ${where}`, ...keys)
  }
  if (current) {
    if (policy === 'fail') conflict('The OVPack destination already exists.')
    if (policy === 'skip') {
      await fs.ctx.reauthorize?.()
      fs.atomic(() => { fs.stat(uri); consume() })
      return ok({ uri })
    }
    fs.check(uri, 'manage')
  } else fs.checkWriteParent(uri)
  // Compare each existing type, including nested paths. ACL/quotas and indexing are owned by FS.
  const capture = current ? captureAt(fs, uri) : undefined
  const old = new Map((capture?.entries ?? []).map(entry => [entry.path, entry]))
  const deletePaths = entries.filter(entry => old.has(entry.path) && old.get(entry.path)!.is_dir !== entry.is_dir).map(entry => entry.path)
  const prepared = await prepareSubtreeMutation(fs, uri, {
    expectedRevision: capture?.revision ?? null, entries, replace: !!current, delete: deletePaths,
  })
  if (current) fs.check(uri, 'manage')
  commitSubtreeMutation(fs, prepared, consume)
  return ok({ uri })
}

export function routePack(request: Request, url: URL, fs: Filesystem, part: string): Promise<Response> | undefined {
  if (!['/temp_upload', '/export', '/import', '/backup', '/restore'].includes(part)) return undefined
  allowed(request, 'POST')
  switch (part) {
    case '/temp_upload': return stage(fs, request, url)
    case '/export': return exportPackage(fs, request)
    case '/import': return importPackage(fs, request)
    default:
      if (fs.caller.role !== 'admin') forbidden('Account backup and restore require an administrator.')
      return notImplemented('Account-wide backup/restore cannot access other mounts in this Worker.')
  }
}
