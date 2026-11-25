// SPDX-License-Identifier: AGPL-3.0-only
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export function ok(result: unknown, status = 200): Response {
  return Response.json({ status: 'ok', result }, { status })
}

export function apiError(error: unknown, requestId: string): Response {
  if (!(error instanceof ApiError)) {
    // Unhandled provider or SQL errors can include user data; only log a correlation id.
    console.error('OpenViking Edge request failed', requestId)
    error = new ApiError(500, 'INTERNAL_ERROR', 'Internal Worker error.')
  }
  const { status, code, message } = error as ApiError
  const headers = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined
  return Response.json({ status: 'error', error: { code, message } }, { status, headers })
}

export async function readBytes(request: Request | Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted()
  const taggedLength = request.headers.get('content-length')
  if (taggedLength !== null && (!/^\d+$/.test(taggedLength) || Number(taggedLength) > maxBytes)) {
    throw new ApiError(413, 'RESOURCE_EXHAUSTED', `Request body exceeds ${maxBytes} bytes.`)
  }
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        cancel()
        throw new ApiError(413, 'RESOURCE_EXHAUSTED', `Request body exceeds ${maxBytes} bytes.`)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const piece of chunks) {
    data.set(piece, offset)
    offset += piece.byteLength
  }
  return data
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function readJson(request: Request | Response, maxBytes = 512 * 1024, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (type !== 'application/json') {
    throw new ApiError(415, 'INVALID_ARGUMENT', 'Expected an application/json body.')
  }
  const raw = await readBytes(request, maxBytes, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw))
  } catch {
    throw new ApiError(400, 'INVALID_ARGUMENT', 'Invalid UTF-8 or JSON.')
  }
  if (!isRecord(parsed)) throw new ApiError(400, 'INVALID_ARGUMENT', 'Expected a JSON object.')
  return parsed
}
