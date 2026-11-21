// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { routeFilesystem } from '../filesystem.js'
import { ApiError, isRecord } from '../http.js'
import { invalid, quota } from '../fs/contract.js'

export type McpContext = WorkspaceContext & { readonly mcpMode?: string }
export const protocolVersions: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26']
export const serverInfo = { name: 'openviking', version: '0.1.0-alpha.1' }
export const mcpEnabled = (ctx: McpContext) => ctx.mcpMode === 'read' || ctx.mcpMode === 'read-write'
export function requireMcp(ctx: McpContext) {
  if (!mcpEnabled(ctx)) throw new ApiError(503, 'MCP_DISABLED', 'MCP is not enabled by the deployment policy.')
}

export type Data = Record<string, unknown>
export const asObject = (value: unknown, label: string): Data => isRecord(value) ? value : invalid(`${label} must be an object.`)

type Operation =
  | 'GET /api/v1/fs/ls' | 'GET /api/v1/fs/tree'
  | 'GET /api/v1/content/read' | 'GET /api/v1/acl' | 'PUT /api/v1/acl' | 'DELETE /api/v1/fs'
  | 'POST /api/v1/content/write' | 'POST /api/v1/resources' | 'POST /api/v1/skills'
  | 'POST /api/v1/search/glob' | 'POST /api/v1/search/grep' | 'POST /api/v1/search/find' | 'POST /api/v1/search/search'

export async function filesystem<T>(ctx: WorkspaceContext, operation: Operation, fields: Data = {}): Promise<{ value: T; hasMore: boolean }> {
  const [method, path] = operation.split(' ')
  const url = new URL(path, 'https://workspace.invalid')
  const input: RequestInit = { method }
  if (method === 'GET' || method === 'DELETE') {
    for (const [key, value] of Object.entries(fields)) {
      if (value == null) continue
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item))
    }
  } else {
    input.headers = { 'Content-Type': 'application/json' }
    input.body = JSON.stringify(fields)
  }

  // In-process dispatch to the existing authenticated data plane. No fetch, no
  // forwarding of credential headers, and no tool-supplied route or identity.
  const response = await routeFilesystem(new Request(url, input), url, ctx)
  if (!response) throw new ApiError(501, 'NOT_IMPLEMENTED', 'The requested data operation is not mounted.')
  const wire: unknown = await response.json()
  if (!isRecord(wire) || !response.ok || wire.status !== 'ok' || !Object.hasOwn(wire, 'result')) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'The local data operation did not return a result.')
  }
  return { value: wire.result as T, hasMore: wire.has_more === true }
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Data
  isError?: true
}

const encoder = new TextEncoder()
export function toolResult(value: string | Data, plain = false): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (encoder.encode(text).byteLength > 256 * 1024) quota('MCP result is too large; reduce the page or line range.')
  return { content: [{ type: 'text', text }], ...(plain ? {} : {
    structuredContent: typeof value === 'string' ? { result: value } : value,
  }) }
}

export function toolError(error: unknown): ToolResult {
  const { code, message } = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'The data operation failed.')
  const text = `${code}: ${message}`
  return { content: [{ type: 'text', text }], structuredContent: { result: text, error: { code, message } }, isError: true }
}
