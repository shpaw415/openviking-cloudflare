// SPDX-License-Identifier: AGPL-3.0-only
import { filename } from '../fs/contract.js'
import { ApiError } from '../http.js'
import { encoder, invalid, unsupported } from './contract.js'
import type { AttachmentDraft } from './attachments.js'

const formOverhead = 8 * 1024
const quota = () => new ApiError(413, 'RESOURCE_EXHAUSTED', 'Attachment exceeds its signed size or multipart limit.')

async function boundedBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted()
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw quota()
  if (!request.body) throw invalid('An attachment body is required.')
  // One fixed-size buffer, even if the sender divides the transfer into many chunks.
  const buffer = new Uint8Array(limit), reader = request.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        if (length !== null && Number(length) !== offset) throw invalid('Incomplete attachment body.')
        return buffer.subarray(0, offset)
      }
      if (offset + value.byteLength > limit) { cancel(); throw quota() }
      buffer.set(value, offset)
      offset += value.byteLength
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ApiError) throw error
    throw invalid('Incomplete attachment body.')
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export async function readAttachmentMultipart(request: Request, draft: AttachmentDraft, signal: AbortSignal): Promise<ArrayBuffer> {
  const type = request.headers.get('content-type') ?? ''
  const boundary = /^multipart\/form-data\s*;\s*boundary=(?:([A-Za-z0-9_.+'-]{1,70})|"([A-Za-z0-9_.,+'()/:=?-]{1,70})")$/iu.exec(type)
  if (!boundary) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a single multipart attachment with a valid boundary.')
  const data = await boundedBody(request, draft.size + formOverhead, signal)
  const end = encoder.encode(`\r\n--${boundary[1] ?? boundary[2]}--`)
  const endsAt = (length: number) => length >= end.length && end.every((byte, index) => byte === data[length - end.length + index])
  const crlf = data.at(-2) === 13 && data.at(-1) === 10
  if (!endsAt(data.length) && !(crlf && endsAt(data.length - 2))) throw invalid('Incomplete multipart attachment.')
  let form: FormData
  try { form = await new Response(data, { headers: { 'Content-Type': type } }).formData() }
  catch { throw invalid('Invalid multipart attachment.') }
  const parts = form.getAll('file'), file = parts[0]
  if (parts.length !== 1 || typeof file === 'string') throw invalid('Exactly one multipart file part is required.')
  for (const key of form.keys()) {
    if (!['file', 'telemetry', 'upload_mode'].includes(key) || form.getAll(key).length !== 1) throw invalid('Unexpected or repeated multipart field.')
  }
  const mode = form.get('upload_mode'), telemetry = form.get('telemetry')
  if (mode !== null && mode !== 'local') throw unsupported('Only private local attachment storage is supported.')
  if (telemetry !== null && (typeof telemetry !== 'string' || !['true', 'false', '1', '0'].includes(telemetry))) {
    throw invalid('Invalid multipart telemetry flag.')
  }
  if (filename(file.name) !== draft.filename) throw invalid('The attachment filename does not match the signed filename.')
  if (file.type !== draft.contentType && file.type !== 'application/octet-stream') {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The multipart file media type does not match the signed type.')
  }
  if (file.size > draft.size || data.byteLength - file.size > formOverhead) throw quota()
  if (file.size !== draft.size) throw invalid('The attachment size does not match the signed size.')
  signal.throwIfAborted()
  return file.arrayBuffer()
}
