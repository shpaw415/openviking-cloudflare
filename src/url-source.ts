// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from './context.js'
import { FILE_LIMIT, invalid, quota, textSize } from './fs/contract.js'
import { ApiError } from './http.js'

const fileExtension = /\.(md|txt|csv|json)$/i
const segment = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,159}$/
const labels = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const privateHost = /(?:^|\.)(?:localhost|internal|local|lan|home|arpa)(?:\.|$)/
const sourceTimeout = () => new ApiError(504, 'DEADLINE_EXCEEDED', 'The approved text source did not respond in time.')
export const urlSourceUnavailable = () => new ApiError(503, 'SOURCE_UNAVAILABLE', 'This text URL is not approved or the text source is unavailable.')
const badText = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a supported, non-empty UTF-8 text document.')

export function urlFileName(name: string): string {
  if (name.startsWith('.') || !fileExtension.test(name)) invalid('Use a visible .md, .txt, .csv or .json file name.')
  return name
}

export function documentUrl(raw: unknown): URL {
  let url: URL | undefined
  if (typeof raw === 'string' && raw.length <= 1000) {
    try { url = new URL(raw) } catch { /* checked below */ }
  }
  if (!url || url.href !== raw || url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.search || url.hash || url.hostname.length > 253 || !labels.test(url.hostname) || privateHost.test(url.hostname) ||
      !url.pathname.slice(1).split('/').every(part => segment.test(part)) || !fileExtension.test(url.pathname)) {
    return invalid('Use an exact, approved HTTPS text document URL with no credentials, parameters or fragment.')
  }
  // A bare ? or # is not exposed by URL.search/hash. Do not accept even those delimiters.
  if (url.href.includes('?') || url.href.includes('#')) invalid('URL parameters and fragments are not supported.')
  return url
}

export type UrlSource = { allows: (href: string) => boolean; read: (href: string) => Promise<string> }

/** Operator-owned binding, deliberately not a general-purpose network transport. */
export function boundUrlSource(env: Env): UrlSource | undefined {
  const binding = env.TEXT_SOURCE
  const config = env.OPENVIKING_EDGE_TEXT_SOURCES
  if (typeof binding?.fetch !== 'function' || !config || config.length > 32_000) return
  let urls: Set<string>
  try {
    const value: unknown = JSON.parse(config)
    if (!Array.isArray(value) || !value.length || value.length > 64 || !value.every(item => typeof item === 'string')) return
    // A legacy watch-only entry need not be a visible canonical text file URL.
    urls = new Set(value.flatMap(raw => {
      try { return [documentUrl(raw).href] } catch { return [] }
    }))
  } catch { return }
  if (!urls.size) return
  return { allows: href => urls.has(href), async read(href) {
    if (!urls.has(href)) throw urlSourceUnavailable()
    return readBoundText(binding, href)
  } }
}

async function readBoundText(binding: Fetcher, href: string): Promise<string> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = sourceTimeout()
      reject(error)
      abort.abort(error)
    }, 8_000)
  })
  const download = async () => {
    const response = await binding.fetch(new Request(href, {
      method: 'GET', redirect: 'manual', signal: abort.signal,
      headers: { Accept: 'text/plain, text/markdown, text/csv, application/json' },
    }))
    const stream = response.body
    const discard = () => { void stream?.cancel().catch(() => {}) }
    if (abort.signal.aborted || response.status !== 200 || response.redirected || response.headers.has('location') ||
        response.headers.has('content-range') || (response.url && response.url !== href)) {
      discard()
      throw urlSourceUnavailable()
    }
    const mime = /^(text\/(?:plain|markdown|x-markdown|csv)|application\/json)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
      .exec(response.headers.get('content-type')?.trim() ?? '')?.[1].toLowerCase()
    if (!mime || !stream || !/^(?:identity)?$/i.test(response.headers.get('content-encoding') ?? '')) {
      discard()
      throw badText()
    }
    const length = response.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > FILE_LIMIT)) {
      discard()
      quota(`The source exceeds ${FILE_LIMIT} bytes.`)
    }
    const reader = stream.getReader()
    const cancel = () => { void reader.cancel().catch(() => {}) }
    abort.signal.addEventListener('abort', cancel, { once: true })
    const bytes = new Uint8Array(FILE_LIMIT)
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        abort.signal.throwIfAborted()
        if (done) break
        if (size + value.byteLength > FILE_LIMIT) quota(`The source exceeds ${FILE_LIMIT} bytes.`)
        bytes.set(value, size)
        size += value.byteLength
      }
    } finally {
      abort.signal.removeEventListener('abort', cancel)
      cancel()
      reader.releaseLock()
    }
    if (length !== null && size !== Number(length)) throw urlSourceUnavailable()
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size)) } catch { throw badText() }
    textSize(text)
    if (!text.trim()) throw badText()
    if (mime === 'application/json' || href.toLowerCase().endsWith('.json')) checkJsonText(text)
    return text
  }
  try { return await Promise.race([expired, download()]) }
  catch (error) { if (error instanceof ApiError) throw error; throw urlSourceUnavailable() }
  finally { clearTimeout(timer) }
}

export function checkJsonText(text: string): void {
  try { JSON.parse(text) } catch { throw badText() }
}
