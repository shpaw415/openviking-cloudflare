// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord, readBytes } from '../http.js'
import { WRITE_LIMIT } from '../fs/contract.js'
import { mcpEnabled, protocolVersions, serverInfo, toolError } from './common.js'
import type { Data, McpContext } from './common.js'
import { callTool, toolCatalog } from './tools.js'

type Id = string | number | null

export const isMcpHttpPath = (path: string) => path === '/mcp' || path === '/mcp/'

function respond(id: Id, payload: Data, status = 200, options: { sse?: boolean; headers?: HeadersInit } = {}) {
  const headers = new Headers(options.headers)
  headers.set('Cache-Control', 'private, no-store')
  headers.set('Vary', 'Accept')
  headers.set('X-Content-Type-Options', 'nosniff')
  const message = { jsonrpc: '2.0', id, ...payload }
  if (options.sse) {
    headers.set('Content-Type', 'text/event-stream; charset=utf-8')
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, { status, headers })
  }
  return Response.json(message, { status, headers })
}

function error(id: Id, code: number, message: string, status = 200, sse = false) {
  return respond(id, { error: { code, message } }, status, { sse })
}

function negotiation(request: Request): 'json' | 'sse' | undefined {
  const header = request.headers.get('Accept')
  if (header === null) return 'json'
  if (header.length > 1024) return
  const allowed = new Map<string, number>()
  for (const item of header.toLowerCase().split(',')) {
    const [mediaType, ...attributes] = item.split(';').map(part => part.trim())
    const quality = attributes.find(part => part.startsWith('q='))?.slice(2)
    allowed.set(mediaType, quality === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(quality) ? Number(quality) : 0)
  }
  const q = (name: string) => allowed.get(name) ?? allowed.get(`${name.split('/')[0]}/*`) ?? allowed.get('*/*') ?? 0
  const json = q('application/json'), sse = q('text/event-stream')
  return json > 0 && json >= sse ? 'json' : sse > 0 ? 'sse' : undefined
}

export async function routeTransport(request: Request, ctx: McpContext): Promise<Response> {
  const signal = ctx.requestSignal ?? request.signal
  signal.throwIfAborted()
  if (!mcpEnabled(ctx)) return error(null, -32003, 'MCP is not enabled by the deployment policy.', 503)
  if (request.method !== 'POST') return respond(null, { error: { code: -32600, message: 'MCP is stateless; use POST.' } }, 405, { headers: { Allow: 'POST' } })
  const format = negotiation(request)
  if (!format) return error(null, -32600, 'Accept application/json or text/event-stream.', 406)
  const sse = format === 'sse'
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return error(null, -32600, 'Expected an application/json body.', 415)
  }
  const requestedVersion = request.headers.get('MCP-Protocol-Version')
  if (requestedVersion !== null && !protocolVersions.includes(requestedVersion)) return error(null, -32600, 'Unsupported MCP protocol version.', 400)

  let bytes: Uint8Array
  try { bytes = await readBytes(request, WRITE_LIMIT + 16 * 1024, signal) }
  catch (cause) {
    if (cause instanceof ApiError) return error(null, -32600, cause.message, cause.status)
    throw cause
  }
  signal.throwIfAborted()
  let message: unknown
  try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) }
  catch { return error(null, -32700, 'Invalid JSON.', 400) }
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      message.method.length > 100 || !message.method || Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) {
    return error(null, -32600, 'Expected a single JSON-RPC request.', 400)
  }
  if (!Object.hasOwn(message, 'id')) {
    // Stateless receipt only. A notification must never run a named tool.
    return new Response(null, { status: 202, headers: { 'Cache-Control': 'private, no-store' } })
  }
  const id = message.id
  if (!(typeof id === 'string' && id.length <= 128 || typeof id === 'number' && Number.isSafeInteger(id))) {
    return error(null, -32600, 'Invalid JSON-RPC request id.', 400)
  }
  const params = message.params === undefined ? {} : message.params
  const invalidParams = () => error(id, -32602, 'Invalid MCP method parameters.', 200, sse)
  if (!isRecord(params)) return invalidParams()
  const reply = (result: unknown) => respond(id, { result }, 200, { sse })

  switch (message.method) {
    case 'initialize':
      if (typeof params.protocolVersion !== 'string' || params.protocolVersion.length > 32 ||
          !isRecord(params.capabilities) || !isRecord(params.clientInfo) || typeof params.clientInfo.name !== 'string' ||
          typeof params.clientInfo.version !== 'string') return invalidParams()
      return reply({ protocolVersion: protocolVersions.includes(params.protocolVersion) ? params.protocolVersion : protocolVersions[0],
        serverInfo, capabilities: { tools: { listChanged: false } } })
    case 'ping': return reply({})
    case 'tools/list':
      if (params.cursor !== undefined) return invalidParams()
      return reply({ tools: toolCatalog(ctx.mcpMode === 'read-write') })
    case 'tools/call': {
      if (typeof params.name !== 'string' || params.name.length > 128 || !params.name ||
          (params.arguments !== undefined && !isRecord(params.arguments))) return invalidParams()
      try {
        const result = await callTool(ctx, params.name, (params.arguments as Data | undefined) ?? {})
        signal.throwIfAborted()
        return reply(result)
      }
      catch (cause) {
        signal.throwIfAborted()
        if (!(cause instanceof ApiError)) return error(id, -32603, 'The data operation failed.', 200, sse)
        return reply(toolError(cause))
      }
    }
    default: return error(id, -32601, 'MCP method not found.', 200, sse)
  }
}
