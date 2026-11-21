// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { Filesystem } from './filesystem.js'
import { ArchiveError, DAV_ROOT, PACK_PREFIX, SNAPSHOT_PREFIX } from './archives/common.js'
import { initPack, routePack } from './archives/pack.js'
import { routeSnapshot } from './archives/snapshot.js'
import { initSnapshotStore } from './archives/snapshot-store.js'
import { routeDav } from './archives/webdav.js'

// Only the public DAV route may forward these extra headers past credential stripping.
// Preserve unsupported DAV conditions so the handler can reject them before any mutation.
export const WEB_DAV_REQUEST_HEADERS = ['if-modified-since', 'if-unmodified-since', 'if', 'lock-token'] as const

export function isWebDavPath(pathname: string): boolean {
  return pathname === DAV_ROOT || pathname.startsWith(`${DAV_ROOT}/`)
}

export function initArchives(ctx: WorkspaceContext): void {
  initSnapshotStore(ctx)
  initPack(ctx)
}

// This adapter must run only after the parent has selected an authenticated workspace.
export async function routeArchives(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  const path = url.pathname
  try {
    if (path.startsWith(`${SNAPSHOT_PREFIX}/`)) return await routeSnapshot(request, url, new Filesystem(ctx), path.slice(SNAPSHOT_PREFIX.length))
    if (path.startsWith(`${PACK_PREFIX}/`)) return await routePack(request, url, new Filesystem(ctx), path.slice(PACK_PREFIX.length))
    if (isWebDavPath(path)) return routeDav(request, url, new Filesystem(ctx))
    return undefined
  } catch (error) {
    if (!(error instanceof ArchiveError)) throw error
    return Response.json({ status: 'error', error: { code: error.code, message: error.message, details: error.details } }, { status: error.status })
  }
}
