// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, readBytes } from '../http.js'
import { documentInputLimit, documentInputType } from '../documents.js'
import { mediaHeader, receiptHeader } from './catalog.js'
import { accountHeader, inventoryHeader, nativeCatalog, nativeLimits, nativeMedia, revisionHeader, userHeader } from './native-catalog.js'
import { decodeNative, feishuDocument, invalidNative, providerCredentials, sourceDenied, tosDocument, unavailableNative } from './native-providers.js'
import { robotsDenied, robotsPolicy } from './robots.js'

type Env = { OPENVIKING_EDGE_WEB_NATIVE_CATALOG?: string; WEB_NATIVE_CREDENTIALS?: string }
const deadline = () => new ApiError(504, 'DEADLINE_EXCEEDED', 'The approved document read exceeded its deadline.')
const acceptedMedia: Record<string, RegExp> = {
  'text/plain': /^text\/plain$/,
  'text/html': /^text\/html$/,
  'application/json': /^application\/(?:json|vnd\.github\+json)$/,
  'application/rss+xml': /^(?:application\/(?:rss\+xml|xml)|text\/xml)$/,
  'application/atom+xml': /^(?:application\/(?:atom\+xml|xml)|text\/xml)$/,
  'application/xml': /^(?:application\/xml|text\/xml)$/,
}

/** Deploy separately, without routes, workers.dev, assets, private networking,
 * or any application storage binding. Only the authenticated app mounts it. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = nativeCatalog(env.OPENVIKING_EDGE_WEB_NATIVE_CATALOG)
    const permit = config?.permits.get(request.url)
    const media = permit?.binary ? documentInputType(permit.binary)! : permit ? nativeMedia[permit.kind] : ''
    if (!config || !permit || request.method !== 'GET' || request.headers.get(accountHeader) !== permit.account ||
        (permit.user && request.headers.get(userHeader) !== permit.user) ||
        request.headers.get('accept') !== media || request.headers.get(receiptHeader) !== permit.url) {
      return new Response(null, { status: 404 })
    }
    const bytes = new TextEncoder().encode(env.OPENVIKING_EDGE_WEB_NATIVE_CATALOG!)
    const inventory = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
    if (request.headers.get(inventoryHeader) !== inventory) return new Response(null, { status: 404 })
    const abort = new AbortController()
    const abortIncoming = () => abort.abort(unavailableNative())
    request.signal.addEventListener('abort', abortIncoming, { once: true })
    if (request.signal.aborted) abortIncoming()
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = deadline(); abort.abort(error); reject(error) }, 7_500)
    })
    const get = async (url: string, accept: string, limit: number, headers?: Record<string, string>) => {
      abort.signal.throwIfAborted()
      const upstream = new Headers({ 'accept-encoding': 'identity', 'user-agent': 'OpenVikingEdgeImport', accept, ...headers })
      let response: Response | undefined
      try {
        // No caller headers or redirect handling cross this boundary. All
        // destinations are from a permit or one provider-specific derivation.
        response = await fetch(new Request(url, { method: 'GET', redirect: 'manual', cache: 'no-store', headers: upstream, signal: abort.signal }))
        abort.signal.throwIfAborted()
        const received = response.headers
        if (response.redirected || (response.url && response.url !== url) || received.has('location') || received.has('content-range')) {
          throw unavailableNative()
        }
        if ((permit.kind === 'feishu' || permit.kind === 'tos') && [401, 403].includes(response.status)) throw sourceDenied()
        if (response.status !== 200) throw unavailableNative()
        const type = received.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
        const allow = acceptedMedia[accept]
        if (!(allow?.test(type) || (!allow && permit.binary && (type === accept || type === 'application/octet-stream')) ||
              (permit.kind === 'tos' && !permit.binary && (type === 'application/octet-stream' || type === 'text/markdown'))) ||
            !/^(?:identity)?$/i.test(received.get('content-encoding') ?? '')) throw invalidNative()
        const bytes = await readBytes(response, limit, abort.signal)
        const length = received.get('content-length')
        if (length !== null && Number(length) !== bytes.byteLength) throw unavailableNative()
        return bytes
      } finally { void response?.body?.cancel().catch(() => {}) }
    }
    const read = async () => {
      if (permit.robots) {
        const robots = decodeNative(await get(permit.robots.url, 'text/plain', nativeLimits.robots))
        if (!robotsPolicy(robots)(new URL(permit.url).pathname)) throw robotsDenied()
      }
      if (permit.kind === 'feishu' || permit.kind === 'tos') {
        const credential = providerCredentials(env.WEB_NATIVE_CREDENTIALS, permit.id)
        if (permit.kind === 'feishu' && credential?.kind === 'feishu') return feishuDocument(get, permit.url, permit.target ?? null, credential, permit.wiki, permit.binary, permit.data)
        if (permit.kind === 'tos' && credential?.kind === 'tos' && permit.target) return tosDocument(get, permit.url, permit.target, credential, permit.binary)
        throw unavailableNative()
      }
      const headers = permit.kind === 'git' ? { 'x-github-api-version': '2022-11-28' } : undefined
      return get(permit.url, nativeMedia[permit.kind], nativeLimits[permit.kind], headers)
    }
    try {
      const bytes = await Promise.race([expired, read()])
      abort.signal.throwIfAborted()
      if (bytes.byteLength > (permit.binary ? documentInputLimit : nativeLimits[permit.kind])) throw new ApiError(413, 'RESOURCE_EXHAUSTED', 'The approved source exceeded its byte budget.')
      return new Response(bytes, { headers: { [revisionHeader]: config.revision, [inventoryHeader]: inventory,
        [receiptHeader]: permit.url, [mediaHeader]: media,
        'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength),
        'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
    } catch (error) {
      const safe = abort.signal.aborted ? abort.signal.reason : error
      const status = safe instanceof ApiError ? safe.status : 503
      return new Response(null, { status, headers: { 'cache-control': 'no-store',
        ...(safe instanceof ApiError && safe.code === 'ROBOTS_DENIED' && { 'x-ov-web-denial': 'robots' }) } })
    } finally {
      clearTimeout(timer ?? null)
      request.signal.removeEventListener('abort', abortIncoming)
    }
  },
}
