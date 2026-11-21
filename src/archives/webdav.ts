// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, readBytes } from '../http.js'
import { commitSubtreeMutation, prepareSubtreeMutation, subtreeRevision, type Entry, type Filesystem } from '../filesystem.js'
import { FILE_LIMIT } from '../fs/contract.js'
import { attachment, DAV_ROOT, decoder, encoder, fail, forbidden, internal, invalid, leaf, notFound,
  notImplemented, quota, RESOURCES, sidecar, under } from './common.js'
import { entityTag, modification, multistatus, selectProps } from './dav-props.js'

const METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, COPY, MOVE'
const MAX_PROPERTIES_ENTRIES = 256

function response(status: number, body: BodyInit | null = null, init?: HeadersInit): Response {
  const headers = new Headers(init)
  headers.set('Allow', METHODS)
  headers.set('DAV', '1')
  headers.set('MS-Author-Via', 'DAV')
  return new Response(body, { status, headers })
}

const reserved = (part: string) => internal(part) || sidecar(part)

function davPath(fs: Filesystem, path: string): string {
  if (path === DAV_ROOT || path === `${DAV_ROOT}/`) return RESOURCES
  if (!path.startsWith(`${DAV_ROOT}/`)) invalid('Destination must stay under /webdav/resources.')
  const result = fs.path(`${RESOURCES}/${path.slice(DAV_ROOT.length + 1)}`)
  if (result.parts.slice(1).some(reserved)) notFound('Resource not found.')
  return result.uri
}

function href(uri: string, directory = false): string {
  const suffix = uri.slice(RESOURCES.length).split('/').map(encodeURIComponent).join('/')
  return `${DAV_ROOT}${suffix}${directory ? '/' : ''}`
}

function destination(fs: Filesystem, url: URL, header: string | null): string {
  if (!header || header.length > 4096 || /[?#\\\s\p{Cc}]/u.test(header)) return invalid('Destination must be a same-origin WebDAV path.')
  if (header.startsWith('/') && !header.startsWith('//')) return davPath(fs, header)
  const match = /^(https?:\/\/[^/]+)(\/.*)$/i.exec(header)
  if (!match) return invalid('Destination must be a same-origin WebDAV path.')
  let origin: URL
  try { origin = new URL(match[1]) } catch { return invalid('Invalid WebDAV destination origin.') }
  if (origin.origin !== url.origin || origin.username || origin.password) forbidden('External WebDAV destinations are not accepted.')
  return davPath(fs, match[2])
}

function ifMatch(tag: string | undefined, condition: string, exists: boolean, weak = false): boolean {
  if (condition.trim() === '*') return exists
  return !!tag && condition.split(',').some(raw => (weak ? raw.trim().replace(/^W\//, '') : raw.trim()) === tag)
}

function preconditions(request: Request, row: Entry | undefined, reading = false): boolean {
  const tag = row && entityTag(row)
  const strong = request.headers.get('If-Match'), weak = request.headers.get('If-None-Match')
  const modified = row?.updated_at ? Math.floor(row.updated_at / 1000) * 1000 : undefined
  const oldest = Date.parse(request.headers.get('If-Unmodified-Since') ?? '')
  if ((strong !== null && !ifMatch(tag, strong, !!row)) || (strong === null && modified !== undefined && oldest < modified)) {
    fail(412, 'PRECONDITION_FAILED', 'The resource revision does not meet the requested precondition.')
  }
  if (weak !== null && ifMatch(tag, weak, !!row, true)) {
    if (reading) return true
    fail(412, 'PRECONDITION_FAILED', 'The resource already matches the requested exclusion.')
  }
  return reading && weak === null && modified !== undefined && modified <= Date.parse(request.headers.get('If-Modified-Since') ?? '')
}

function existing(fs: Filesystem, uri: string) { return fs.entry(fs.path(uri)) }

function requireParent(fs: Filesystem, uri: string): void {
  try { fs.checkWriteParent(uri) } catch (error) {
    if (error instanceof ApiError && error.status === 404) fail(409, 'CONFLICT', 'Parent collection does not exist.')
    throw error
  }
}

async function put(request: Request, fs: Filesystem, uri: string): Promise<Response> {
  if (uri === RESOURCES) fail(405, 'METHOD_NOT_ALLOWED', 'PUT requires a file.')
  fs.check(uri, 'write')
  const data = await readBytes(request, FILE_LIMIT)
  let content: string
  try { content = decoder.decode(data) } catch { return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected UTF-8 text.') }
  await fs.ctx.reauthorize?.()
  const old = existing(fs, uri)
  if (old?.is_dir) fail(405, 'METHOD_NOT_ALLOWED', 'PUT is only supported for files.')
  preconditions(request, old)
  if (!old) requireParent(fs, uri)
  const plan = await prepareSubtreeMutation(fs, uri, { expectedRevision: subtreeRevision(fs, uri), entries: [{
    path: '', is_dir: false, content, description: old?.description ?? '', tags: old ? JSON.parse(old.tags) as string[] : [],
  }] })
  commitSubtreeMutation(fs, plan)
  return response(old ? 204 : 201, null, { ...(old ? {} : { Location: href(uri) }) })
}

async function handle(request: Request, url: URL, fs: Filesystem): Promise<Response> {
  if (url.search) invalid('WebDAV does not accept query parameters or query credentials.')
  const uri = davPath(fs, url.pathname)
  if (request.headers.has('If') || request.headers.has('Lock-Token')) notImplemented('WebDAV lock tokens are not supported.')
  switch (request.method) {
    case 'OPTIONS':
      fs.check(uri, 'read')
      return response(204)
    case 'PROPFIND': {
      const depth = request.headers.get('depth')?.trim() ?? '1'
      if (depth !== '0' && depth !== '1') forbidden('Only WebDAV depth 0 and 1 are supported.')
      const selection = await selectProps(request)
      await fs.ctx.reauthorize?.()
      const row = fs.stat(uri)
      const children = row.is_dir && depth === '1' ? fs.list(uri).filter(child => !reserved(leaf(child.uri))) : []
      if (children.length >= MAX_PROPERTIES_ENTRIES) quota('WebDAV property listing exceeds its entry limit.')
      const out = multistatus([row, ...children], selection, child => href(child.uri, !!child.is_dir))
      if (encoder.encode(out).byteLength > 512 * 1024) quota('WebDAV property response exceeds its byte limit.')
      return response(207, out, { 'content-type': 'application/xml; charset=utf-8' })
    }
    case 'GET':
    case 'HEAD': {
      const row = fs.stat(uri)
      if (row.is_dir) fail(405, 'METHOD_NOT_ALLOWED', 'GET is only supported for files.')
      const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'content-disposition': attachment(leaf(uri)) })
      const time = modification(row), tag = entityTag(row)
      if (time) headers.set('last-modified', time)
      if (tag) headers.set('etag', tag)
      if (preconditions(request, row, true)) return response(304, null, headers)
      const data = request.method === 'HEAD' ? null : encoder.encode(fs.read(uri))
      headers.set('content-length', String(data?.byteLength ?? row.bytes))
      return response(200, data, headers)
    }
    case 'PUT':
      return put(request, fs, uri)
    case 'MKCOL': {
      if (uri === RESOURCES) fail(405, 'METHOD_NOT_ALLOWED', 'Cannot create the WebDAV mount root.')
      if ((await readBytes(request, 1024)).byteLength) fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'MKCOL does not accept a body.')
      await fs.ctx.reauthorize?.()
      const old = existing(fs, uri)
      preconditions(request, old)
      if (old) fail(405, 'METHOD_NOT_ALLOWED', 'Collection already exists.')
      requireParent(fs, uri)
      fs.createDirectory(uri)
      return response(201, null, { Location: href(uri, true) })
    }
    case 'DELETE': {
      if (uri === RESOURCES) fail(405, 'METHOD_NOT_ALLOWED', 'Cannot delete the WebDAV mount root.')
      const row = fs.stat(uri)
      preconditions(request, row)
      fs.deleteUri(uri, !!row.is_dir)
      return response(204)
    }
    case 'COPY':
    case 'MOVE': {
      const to = destination(fs, url, request.headers.get('destination'))
      if (uri === RESOURCES || to === RESOURCES) fail(405, 'METHOD_NOT_ALLOWED', 'Cannot transfer the WebDAV mount root.')
      if (under(to, uri) || under(uri, to)) invalid('WebDAV transfer paths cannot overlap.')
      const overwrite = request.headers.get('overwrite')?.trim().toUpperCase() ?? 'T'
      if (overwrite !== 'T' && overwrite !== 'F') invalid('Overwrite must be T or F.')
      const source = fs.stat(uri)
      preconditions(request, source)
      const copy = request.method === 'COPY'
      const depth = request.headers.get('depth')?.trim().toLowerCase() ?? 'infinity'
      if (source.is_dir && depth !== 'infinity') notImplemented('Collection transfers require Depth: infinity.')
      if (!source.is_dir && depth !== '0' && depth !== 'infinity') invalid('Invalid WebDAV transfer depth.')
      const target = existing(fs, to)
      if (target && overwrite === 'F') fail(412, 'PRECONDITION_FAILED', 'The destination already exists.')
      if (!target) requireParent(fs, to)
      const result = fs.copyMove(uri, to, { copy, recursive: true, overwrite: overwrite === 'T' })
      return response(result.overwritten ? 204 : 201, null, result.overwritten ? undefined : { Location: href(to, !!source.is_dir) })
    }
    default:
      return response(405, 'WebDAV method not supported.', { 'content-type': 'text/plain; charset=utf-8' })
  }
}

export async function routeDav(request: Request, url: URL, fs: Filesystem): Promise<Response> {
  try { return await handle(request, url, fs) } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return response(error.status, request.method === 'HEAD' ? null : error.message, { 'content-type': 'text/plain; charset=utf-8' })
  }
}
