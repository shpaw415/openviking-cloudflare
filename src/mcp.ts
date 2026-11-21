// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import type { McpContext } from './mcp/common.js'
import { isMcpHttpPath, routeTransport } from './mcp/transport.js'
import { initRegistry, routeRegistry } from './mcp/registry.js'
import { initAddLocations, routeAddLocations } from './mcp/settings.js'
import { routeAssets } from './mcp/assets.js'

export { isMcpHttpPath } from './mcp/transport.js'
export type { McpContext } from './mcp/common.js'

export function initMcp(ctx: WorkspaceContext): void {
  initRegistry(ctx)
  initAddLocations(ctx)
}

export async function routeMcp(request: Request, url: URL, ctx: McpContext): Promise<Response | undefined> {
  if (isMcpHttpPath(url.pathname)) return routeTransport(request, ctx)
  return await routeRegistry(request, url, ctx) ?? await routeAddLocations(request, url, ctx) ?? await routeAssets(request, url, ctx)
}
