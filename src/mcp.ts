// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import type { McpContext } from './mcp/common.js'
import { isMcpHttpPath, routeTransport } from './mcp/transport.js'
import { initRegistry, routeRegistry } from './mcp/registry.js'
import { initAddLocations, routeAddLocations } from './mcp/settings.js'
import { routeAssets } from './mcp/assets.js'
import { initLive, readLive } from './mcp/live.js'

export { isMcpHttpPath } from './mcp/transport.js'
export type { McpContext } from './mcp/common.js'

export function initMcp(ctx: WorkspaceContext): void {
  initRegistry(ctx)
  initLive(ctx.sql)
  initAddLocations(ctx)
}

export async function routeMcp(request: Request, url: URL, ctx: McpContext): Promise<Response | undefined> {
  if (ctx.mcpLive && ['GET','HEAD'].includes(request.method) && url.pathname === '/api/v1/content/read') return readLive(request,url,ctx)
  if (isMcpHttpPath(url.pathname)) return routeTransport(request, ctx)
  return await routeRegistry(request, url, ctx) ?? await routeAddLocations(request, url, ctx) ?? await routeAssets(request, url, ctx)
}
