// SPDX-License-Identifier: AGPL-3.0-only
import { byteLimits, mediaHeader, mediaTypes, receiptHeader, snapshotOrigin, snapshotRoute } from './catalog.js'
import type { SnapshotKind } from './catalog.js'

/** Optional private service entrypoint. Dedicated stores are provisioned out
 * of band; only live HTML has a separate, mutable document channel. */
export default {
  async fetch(request: Request, env: { WEB_SNAPSHOTS?: Pick<R2Bucket, 'get'>; WEB_LIVE_DOCUMENTS?: Pick<R2Bucket, 'get'> }): Promise<Response> {
    const target = new URL(request.url)
    const match = snapshotRoute.exec(target.pathname)
    const refused = () => new Response(null, { status: 404 })
    if (request.method !== 'GET' || target.href !== snapshotOrigin + target.pathname || !match) return refused()
    const kind = match[1] as SnapshotKind
    if (request.headers.get('accept') !== mediaTypes[kind]) return refused()
    const store = kind === 'live-html' ? env.WEB_LIVE_DOCUMENTS : env.WEB_SNAPSHOTS
    const object = await store?.get(`${kind}/${match[2]}`)
    if (!object) return refused()
    const url = object.customMetadata?.sourceUrl
    if (!url || !/^https:\/\/[\x21-\x7e]{1,1000}$/.test(url) || object.size > byteLimits[kind]) {
      void object.body.cancel().catch(() => {})
      return refused()
    }
    // This raw channel belongs exclusively to the service binding. Never expose
    // the original media type even if this response is accidentally displayed.
    return new Response(object.body, { headers: {
      [receiptHeader]: url, [mediaHeader]: mediaTypes[kind],
      'content-type': 'application/octet-stream', 'content-length': String(object.size),
      'content-disposition': 'attachment', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store',
    } })
  },
}
