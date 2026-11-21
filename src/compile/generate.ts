// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, isRecord } from '../http.js'
import { encoder, quota } from '../fs/contract.js'

export function unavailable(): never {
  throw new ApiError(503, 'GENERATION_UNAVAILABLE', 'Compile requires a Workers AI generation binding.')
}

export function badOutput(message = 'The generation provider returned an invalid compilation plan.'): never {
  throw new ApiError(422, 'INVALID_GENERATION', message)
}

export async function generateObject(ctx: WorkspaceContext, system: string, data: object) {
  if (!ctx.generate) unavailable()
  const content = JSON.stringify(data)
  if (encoder.encode(content).length + encoder.encode(system).length > 46_000) quota('Compilation material exceeds the model request budget.')
  ctx.assertActive?.()
  const reply = await ctx.generate([{ role: 'system', content: system }, { role: 'user', content }], { maxTokens: 2048 })
  ctx.assertActive?.()
  if (typeof reply.text !== 'string' || !reply.text.trim() || encoder.encode(reply.text).length > 36_000) badOutput()
  let value: unknown
  try { value = JSON.parse(reply.text.trim().replace(/^```(?:json)?\s*([\s\S]+?)\s*```$/u, '$1')) } catch { badOutput() }
  if (!isRecord(value)) badOutput()
  return value
}

export function modelText(value: unknown, cap: number, optional = false): string {
  if (value == null && optional) return ''
  if (typeof value !== 'string' || (!optional && !value.trim()) || encoder.encode(value).length > cap ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cs}\p{Bidi_Control}]/u.test(value)) badOutput()
  return value.trim()
}
