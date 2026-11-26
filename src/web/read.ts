// SPDX-License-Identifier: AGPL-3.0-only
import { encoder, FILE_LIMIT, quota, textSize } from '../fs/contract.js'
import { ApiError, isRecord, readBytes } from '../http.js'
import { byteLimits, mediaHeader, mediaTypes, receiptHeader, snapshotOrigin } from './catalog.js'
import type { SnapshotKind, SnapshotRef, SnapshotSelection } from './catalog.js'
import { readFeed, readSitemap } from './feed.js'
import { extractHtml } from './html.js'
import { accountHeader, inventoryHeader, nativeLimits, nativeMedia, nativeRoute, revisionHeader, userHeader } from './native-catalog.js'
import type { NativeRef, NativeSelection } from './native-catalog.js'
import { sourceDenied } from './native-providers.js'
import { documentInputLimit, documentInputType } from '../documents.js'
import type { WorkspaceContext } from '../context.js'
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

async function gitDocument(json: string, file: string, expected?: string): Promise<string> {
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
  // SHA-1 confirms the Git blob representation. An independent SHA-256 pin
  // covers the complete snapshot reply or, for native Git, the exact blob.
  if (hex(await crypto.subtle.digest('SHA-1', gitBlob)) !== value.sha) throw badDocument()
  if (expected !== undefined && await sha256(bytes) !== expected) throw webUnavailable()
  return utf8(bytes)
}

function archivedText(json: string, kind: 'feishu' | 'tos'): string {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw badDocument() }
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.format !== `ov-${kind}-text-v1` ||
      typeof value.text !== 'string') throw badDocument()
  return value.text
}

type Document = { name: string; text: string; bytes: number }
type ReadResult = { documents: Document[]; bounded: boolean }

export function needsWebConversion(source: SnapshotSelection | NativeSelection) {
  return 'native' in source && ('objects' in source ? source.objects.some(item => item.object.root.binary) :
    'root' in source && !!source.root.binary)
}

export async function readWeb(binding: Fetcher, source: SnapshotSelection | NativeSelection, guard: () => Promise<void>, inventory?: string,
  convert?: WorkspaceContext['convertDocument']): Promise<ReadResult> {
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
  let remaining = totalBytes, binaryRemaining = 2 * documentInputLimit
  const read = async (kind: SnapshotKind, ref: Omit<SnapshotRef, 'sha256'> & { sha256?: string }) => {
    checkTime()
    await guard()
    checkTime()
    if (remaining <= 0) quota('The total approved document byte budget was reached.')
    if ((kind === 'live-html') !== (ref.sha256 === undefined)) throw webUnavailable()
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
      if ((length !== null && Number(length) !== bytes.byteLength) ||
          (ref.sha256 !== undefined && await sha256(bytes) !== ref.sha256)) throw webUnavailable()
      checkTime()
      remaining -= bytes.byteLength
      return utf8(bytes)
    } catch (error) {
      signal.throwIfAborted()
      throw error instanceof ApiError ? error : webUnavailable()
    } finally { void response?.body?.cancel().catch(() => {}) }
  }

  const document = (name: string, text: string): Document => {
    checkTime()
    if (!text.trim()) throw badDocument()
    return { name, text, bytes: textSize(text) }
  }
  const readNative = async (plan: NativeSelection, ref: NativeRef) => {
    if (!inventory) throw webUnavailable()
    checkTime()
    await guard()
    checkTime()
    const budget = ref.binary ? binaryRemaining : remaining
    if (budget <= 0) quota('The total approved document byte budget was reached.')
    const media = ref.binary ? documentInputType(ref.binary)! : nativeMedia[ref.kind]
    const target = nativeRoute(plan.revision, ref)
    let response: Response | undefined
    try {
      response = await binding.fetch(new Request(target, { method: 'GET', redirect: 'manual', signal, headers: {
        accept: media, [accountHeader]: plan.account, [userHeader]: plan.user, [receiptHeader]: ref.url, [inventoryHeader]: inventory,
      } }))
      checkTime()
      const headers = response.headers
      if (response.redirected || (response.url && response.url !== target) || headers.has('location') || headers.has('content-range')) throw webUnavailable()
      if (response.status === 403) throw headers.get('x-ov-web-denial') === 'robots' ? robotsDenied() : sourceDenied()
      if (response.status === 413) quota('The approved source exceeded its byte or document budget.')
      if (response.status === 415) throw badDocument()
      if (response.status === 504) throw deadlineExceeded()
      if (response.status !== 200 || headers.get(revisionHeader) !== plan.revision || headers.get(receiptHeader) !== ref.url ||
          headers.get(inventoryHeader) !== inventory) throw webUnavailable()
      if (headers.get('content-type') !== 'application/octet-stream' || headers.get(mediaHeader) !== media ||
          !/^(?:identity)?$/i.test(headers.get('content-encoding') ?? '')) throw badDocument()
      const bytes = await readBytes(response, Math.min(budget, ref.binary ? documentInputLimit : nativeLimits[ref.kind]), signal)
      checkTime()
      const length = headers.get('content-length')
      if (length === null || Number(length) !== bytes.byteLength) throw webUnavailable()
      if (ref.binary) binaryRemaining -= bytes.byteLength
      else remaining -= bytes.byteLength
      return bytes
    } catch (error) {
      signal.throwIfAborted()
      throw error instanceof ApiError ? error : webUnavailable()
    } finally { void response?.body?.cancel().catch(() => {}) }
  }
  const nativeRun = async (plan: NativeSelection): Promise<ReadResult> => {
    const open = async (ref: NativeRef) => utf8(await readNative(plan, ref))
    if ('objects' in plan || plan.mode === 'feishu-native' || plan.mode === 'tos-native') {
      const files = 'objects' in plan ? plan.objects.map(({ relative, object }) => ({ name: relative, ref: object.root })) :
        [{ name: plan.name, ref: plan.root }]
      if (!convert && files.some(item => item.ref.binary)) throw new ApiError(503, 'CONVERSION_UNAVAILABLE', 'The approved document converter is not mounted.')
      const fetched = []
      for (const { name, ref } of files) fetched.push({ name, ref, bytes: await readNative(plan, ref) })
      const documents = []
      for (const { name, ref, bytes } of fetched) {
        let text: string
        if (ref.binary) {
          await guard()
          checkTime()
          const result = await convert!(new File([bytes], ref.binary, { type: documentInputType(ref.binary) }))
          checkTime()
          if (!result) throw badDocument()
          text = result.content
        } else text = utf8(bytes)
        if (/[^\x09\x0a\x0d\x20-\x7e\u00a0-\u{10ffff}]/u.test(text)) throw badDocument()
        documents.push(document(name, text))
      }
      return { documents, bounded: false }
    }
    if ('site' in plan) {
      const policy = robotsPolicy(await open(plan.site.robots))
      const allowed = (ref: NativeRef) => policy(new URL(ref.url).pathname)
      const roster = new Map(plan.site.pages.filter(allowed).map(page => [page.url, page]))
      const documents: Document[] = []
      let bounded = false
      if (plan.mode === 'sitemap') {
        if (!allowed(plan.root)) throw robotsDenied()
        const maps = new Map(plan.site.maps.filter(allowed).map(map => [map.url, map]))
        const queue = [{ ref: plan.root, depth: 0 }], visited = new Set([plan.root.url]), pages = new Set<string>()
        for (let i = 0; queue.length && i < 4; i++) {
          const { ref, depth } = queue.shift()!
          const { index, addresses } = readSitemap(await open(ref))
          for (const address of addresses) {
            if (!index) { if (roster.has(address)) pages.add(address); continue }
            const child = maps.get(address)
            if (!child || visited.has(address)) continue
            if (depth >= maxDepth) { bounded = true; continue }
            visited.add(address)
            queue.push({ ref: child, depth: depth + 1 })
          }
        }
        if (queue.length || pages.size > maxPages) bounded = true
        for (const url of [...pages].slice(0, maxPages)) {
          const page = roster.get(url)!
          documents.push(document(page.name, (await extractHtml(await open(page), url, new Set())).text))
        }
      } else {
        if (!allowed(plan.page)) throw robotsDenied()
        const queue = [{ page: plan.page, depth: 0 }], seen = new Set([plan.page.url])
        const approved = new Set(plan.mode === 'site' ? roster.keys() : [])
        while (queue.length && documents.length < maxPages) {
          const { page, depth } = queue.shift()!
          const parsed = await extractHtml(await open(page), page.url, approved, true)
          documents.push(document(page.name, parsed.text))
          for (const link of parsed.links) {
            if (seen.has(link)) continue
            if (depth >= maxDepth) { bounded = true; continue }
            seen.add(link)
            queue.push({ page: roster.get(link)!, depth: depth + 1 })
          }
        }
        bounded ||= queue.length > 0
      }
      if (!documents.length) throw badDocument()
      return { documents, bounded }
    }
    if ('files' in plan) {
      const documents = []
      for (const file of plan.files) documents.push(document(file.name, await gitDocument(await open(file), file.file, file.blob_sha256)))
      return { documents, bounded: false }
    }
    if (plan.mode === 'feed') {
      const allowed = plan.mirror.length ? robotsPolicy(await open(plan.robots)) : undefined
      const pages = new Map(plan.mirror.filter(page => allowed?.(new URL(page.url).pathname)).map(page => [page.url, page]))
      const parsed = await readFeed(await open(plan.root), plan.format, plan.root.url, pages.size ? async href => {
        const page = pages.get(href)
        if (page) return document(page.name, (await extractHtml(await open(page), href, new Set())).text)
      } : undefined)
      checkTime()
      return parsed
    }
    throw webUnavailable()
  }
  const run = async (): Promise<ReadResult> => {
    if ('native' in source) return nativeRun(source)
    if (source.mode === 'git' || source.mode === 'git-collection') {
      const documents = []
      for (const file of source.mode === 'git' ? [source.git] : source.files) {
        documents.push(document(file.name, await gitDocument(await read('git', file), file.file)))
      }
      return { documents, bounded: false }
    }
    if ('archive' in source) {
      return { documents: [document(source.name, archivedText(await read(source.mode, source.archive), source.mode))], bounded: false }
    }
    if (source.mode === 'feed') {
      const parsed = await readFeed(await read(source.kind, source.feed), source.kind, source.feed.url)
      checkTime()
      return parsed
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
      const raw = await read(source.site.live ? 'live-html' : 'html', page)
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
