// SPDX-License-Identifier: AGPL-3.0-only
import { encoder, FILE_LIMIT, quota, textSize } from '../fs/contract.js'
import { ApiError, isRecord, readBytes } from '../http.js'
import { byteLimits, mediaHeader, mediaTypes, receiptHeader, snapshotOrigin } from './catalog.js'
import type { SnapshotKind, SnapshotRef, WebSelection } from './catalog.js'
import { extractHtml } from './html.js'
import { robotsDenied, robotsPolicy } from './robots.js'

export const maxPages = 6, maxDepth = 2
const totalBytes = 192 * 1024
const timeoutMs = 8_000
export const webUnavailable = () => new ApiError(503, 'SOURCE_UNAVAILABLE', 'This approved document source is not available.')
const badDocument = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The approved source is not a supported, non-empty document.')
const deadlineExceeded = () => new ApiError(504, 'DEADLINE_EXCEEDED', 'The approved document read exceeded its deadline.')

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, '0')).join('')
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => hex(await crypto.subtle.digest('SHA-256', bytes))

function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) } catch { throw badDocument() }
}

async function gitDocument(json: string, file: string): Promise<string> {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw badDocument() }
  if (!isRecord(value) || value.type !== 'file' || value.path !== file || value.name !== file.split('/').at(-1) ||
      value.encoding !== 'base64' || typeof value.content !== 'string' || typeof value.sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(value.sha) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) ||
      value.size < 1 || value.size > FILE_LIMIT || value.submodule_git_url != null || value.target != null) throw badDocument()
  const base64 = value.content.replace(/[\r\n]/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw badDocument()
  let binary: string
  try { binary = atob(base64) } catch { throw badDocument() }
  if (binary.length !== value.size || btoa(binary) !== base64) throw badDocument()
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  const prefix = encoder.encode(`blob ${bytes.byteLength}\0`)
  const gitBlob = new Uint8Array(prefix.length + bytes.length)
  gitBlob.set(prefix)
  gitBlob.set(bytes, prefix.length)
  // SHA-1 is a consistency check for Git's blob format, not the trust root.
  // The complete provider response already matched the catalogue's SHA-256.
  if (hex(await crypto.subtle.digest('SHA-1', gitBlob)) !== value.sha) throw badDocument()
  return utf8(bytes)
}

type Document = { name: string; text: string; bytes: number }
type ReadResult = { documents: Document[]; bounded: boolean }

export async function readWeb(binding: Fetcher, source: WebSelection, guard: () => Promise<void>): Promise<ReadResult> {
  const abort = new AbortController()
  const signal = abort.signal
  const until = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const checkTime = () => {
    if (Date.now() >= until && !signal.aborted) abort.abort(deadlineExceeded())
    signal.throwIfAborted()
  }
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const error = deadlineExceeded(); abort.abort(error); reject(error) }, timeoutMs)
  })
  let remaining = totalBytes
  const read = async (kind: SnapshotKind, ref: SnapshotRef) => {
    checkTime()
    await guard()
    checkTime()
    if (remaining <= 0) quota('The total approved document byte budget was reached.')
    const target = `${snapshotOrigin}/v1/${kind}/${ref.id}`
    let response: Response | undefined
    try {
      response = await binding.fetch(new Request(target, { method: 'GET', redirect: 'manual', signal,
        headers: { accept: mediaTypes[kind] } }))
      checkTime()
      const headers = response.headers
      if (response.status !== 200 || response.redirected || headers.has('location') || headers.has('content-range') ||
          (response.url && response.url !== target) || headers.get(receiptHeader) !== ref.url) throw webUnavailable()
      if (headers.get('content-type') !== 'application/octet-stream' || headers.get(mediaHeader) !== mediaTypes[kind] ||
          !/^(?:identity)?$/i.test(headers.get('content-encoding') ?? '')) throw badDocument()
      const bytes = await readBytes(response, Math.min(remaining, byteLimits[kind]), signal)
      checkTime()
      const length = headers.get('content-length')
      if ((length !== null && Number(length) !== bytes.byteLength) || await sha256(bytes) !== ref.sha256) throw webUnavailable()
      checkTime()
      remaining -= bytes.byteLength
      return utf8(bytes)
    } catch (error) {
      signal.throwIfAborted()
      throw error instanceof ApiError ? error : webUnavailable()
    } finally { void response?.body?.cancel().catch(() => {}) }
  }

  const run = async (): Promise<ReadResult> => {
    if (source.mode === 'git') {
      const body = await gitDocument(await read('git', source.git), source.git.file)
      checkTime()
      if (!body.trim()) throw badDocument()
      return { documents: [{ name: source.name, text: body, bytes: textSize(body) }], bounded: false }
    }
    const robots = await read('robots', source.site.robots)
    textSize(robots)
    const policy = robotsPolicy(robots)
    if (!policy(new URL(source.page.url).pathname)) throw robotsDenied()
    const pages = new Map(source.site.pages.filter(page => policy(new URL(page.url).pathname)).map(page => [page.url, page]))
    const approved: ReadonlySet<string> = new Set(source.mode === 'site' ? pages.keys() : [])
    const queue = [{ page: source.page, depth: 0 }]
    const seen = new Set([source.page.url])
    const documents: Document[] = []
    let bounded = false
    while (queue.length && documents.length < maxPages) {
      const { page, depth } = queue.shift()!
      const raw = await read('html', page)
      let parsed: Awaited<ReturnType<typeof extractHtml>>
      try { parsed = await extractHtml(raw, page.url, approved) }
      catch (error) { throw error instanceof ApiError ? error : badDocument() }
      checkTime()
      if (!parsed.text) throw badDocument()
      documents.push({ name: page.name, text: parsed.text, bytes: parsed.bytes })
      for (const link of parsed.links) {
        if (seen.has(link)) continue
        if (depth >= maxDepth) { bounded = true; continue }
        seen.add(link)
        queue.push({ page: pages.get(link)!, depth: depth + 1 })
      }
    }
    return { documents, bounded: bounded || queue.length > 0 }
  }
  try { return await Promise.race([deadline, run()]) } finally { clearTimeout(timer ?? null) }
}
