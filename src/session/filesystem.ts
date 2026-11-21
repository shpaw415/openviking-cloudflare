// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { routeFilesystem } from '../filesystem.js'
import { ApiError } from '../http.js'
import { isRecord } from './protocol.js'

export async function callFilesystem(ctx: WorkspaceContext, path: string, body: Record<string, unknown>): Promise<unknown> {
  // This URL never goes to fetch. The callee gets the same authenticated context,
  // not a synthetic admin identity or an authorization header.
  const url = new URL(path, 'https://internal.invalid')
  const response = await routeFilesystem(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) }), url, ctx)
  if (!response?.ok) throw new ApiError(503, 'FILESYSTEM_UNAVAILABLE', 'The internal filesystem operation is not available.')
  const payload: unknown = await response.json()
  if (!isRecord(payload) || payload.status !== 'ok' || !('result' in payload)) {
    throw new ApiError(503, 'FILESYSTEM_UNAVAILABLE', 'Invalid response from the internal filesystem.')
  }
  return payload.result
}

// Adapter for the existing FS contract: its final mutation is a single
// transactionSync on this DO (after embeddings). Fence that very transaction,
// and attach a receipt inside it. Never hold a SQLite transaction across IO.
export function guardedFilesystem(ctx: WorkspaceContext, guard: () => void, applied?: () => void): WorkspaceContext {
  const storage = new Proxy(ctx.storage, {
    get(target, field) {
      if (field === 'transactionSync') return <T>(run: () => T): T => target.transactionSync(() => {
        guard()
        const result = run()
        applied?.()
        return result
      })
      const value = Reflect.get(target, field, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ...ctx, storage }
}
