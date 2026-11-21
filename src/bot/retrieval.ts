// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { pathFor } from '../fs/contract.js'
import { Filesystem } from '../fs/store.js'
import { callFilesystem } from '../session/filesystem.js'
import { isRecord } from '../session/protocol.js'

export type Source = { uri: string, abstract: string, revision: string, nodeId: string, experience: boolean }

export async function retrieve(ctx: WorkspaceContext, message: string, guard: () => void): Promise<Source[]> {
  const input = message.trim()
  const query = input.slice(0, (input.charCodeAt(1024) & 0xfc00) === 0xdc00 ? 1023 : 1024)
  const fs = new Filesystem(ctx)
  const target_uri = ['viking://~/memories', 'viking://~/resources', 'viking://resources']
    .filter(uri => fs.acl.allows(pathFor(uri, ctx.caller), 'read'))
  if (!target_uri.length) return []
  const response = await callFilesystem(ctx, '/api/v1/search/find', { query, target_uri, level: 2, limit: 4, score_threshold: 0.35 })
  guard()
  if (!isRecord(response)) throw new ApiError(503, 'FILESYSTEM_UNAVAILABLE', 'Invalid search response.')
  const sources: Source[] = []
  for (const hits of [response.memories, response.resources]) {
    if (!Array.isArray(hits)) throw new ApiError(503, 'FILESYSTEM_UNAVAILABLE', 'Invalid search response.')
    for (const hit of hits) {
      if (sources.length >= 4 || !isRecord(hit) || typeof hit.uri !== 'string' || typeof hit.abstract !== 'string') continue
      const path = pathFor(hit.uri, ctx.caller)
      if (!fs.acl.allows(path, 'read')) continue
      const entry = fs.entry(path)
      if (!entry?.dimensions || entry.is_dir) continue
      // Bind the submitted bytes to a fresh, authorized entry. The search
      // response body was awaited and its snippet may describe an older file.
      const body = fs.content(path).body
      const abstract = body.slice(0, (body.charCodeAt(256) & 0xfc00) === 0xdc00 ? 255 : 256)
      if (!abstract.trim() || abstract !== hit.abstract) continue
      const [root, actor, kind, sub, ...rest] = path.parts
      const experience = root === 'user' && actor === ctx.caller.userId && kind === 'memories' && sub === 'experiences' &&
        rest.length > 0 && rest.every(part => !part.startsWith('.'))
      sources.push({ uri: path.uri, abstract, revision: entry.revision, nodeId: entry.node_id, experience })
    }
  }
  return sources
}

export function verifySources(ctx: WorkspaceContext, sources: Source[]): void {
  const fs = new Filesystem(ctx)
  for (const source of sources) {
    const path = pathFor(source.uri, ctx.caller)
    const entry = fs.acl.allows(path, 'read') ? fs.entry(path) : undefined
    if (!entry || entry.revision !== source.revision || entry.node_id !== source.nodeId) {
      throw new ApiError(409, 'CONTEXT_CHANGED', 'A retrieved source changed during generation; please retry.')
    }
  }
}
