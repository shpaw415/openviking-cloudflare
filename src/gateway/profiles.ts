// SPDX-License-Identifier: AGPL-3.0-only
import { GatewayError, bytes, displayName, fields, integer, invalid, invalidConfig, record, unsupported } from './contract.js'

export const kinds = ['memory', 'resource', 'skill'] as const
export const buckets = ['events', 'entities', 'preferences', 'experiences', 'resources', 'skills'] as const
export type Bucket = typeof buckets[number]
type Kind = typeof kinds[number]

// Keep the upstream policy field names. Inactive settings round-trip with the
// fixed values below; requesting an unavailable capability fails on write.
export const defaultProfile = {
  name: 'Default', recall: false, profile: false, soul: false, profile_max_tokens: 4000,
  capture: false, context_types: ['memory'] as Kind[], quotas: {} as Partial<Record<Bucket, number>>,
  max_tokens: 1600, session_max_tokens: 30_000, score_threshold: 0.35, recall_timeout: 2,
  query_max_chars: 1024, recall_peer_scope: 'actor', show_recall: false,
  commit_tokens: 20_000, keep_recent_messages: 10, capture_memory_types: [] as string[], idle_seconds: 600,
  compaction: false, compaction_threshold: 0.9, summary_max_tokens: 8000, context_window: null as number | null,
  gateway_tools: false, disabled_tools: [] as string[], show_tool_calls: false,
  tool_max_rounds: null, tool_timeout_seconds: 30, tool_result_bytes: 65536, tool_total_seconds: null,
  tool_total_tokens: null, agent_windows: false, window_soft_ratio: 0.7, window_hard_ratio: 0.85,
  client_overrides: false,
}

export type Profile = typeof defaultProfile
export type SavedProfile = Profile & { id: string; revision: number }
const profileFields = Object.keys(defaultProfile)
const toggle = ['recall', 'profile', 'capture', 'show_recall', 'client_overrides'] as const
const ints = {
  profile_max_tokens: [0, 4000], max_tokens: [64, 4096], session_max_tokens: [0, 100_000],
  query_max_chars: [3, 1024], commit_tokens: [1, 1_000_000], keep_recent_messages: [0, 1000],
} as const
const inactive = ['soul', 'idle_seconds', 'compaction', 'compaction_threshold', 'summary_max_tokens', 'context_window',
  'gateway_tools', 'show_tool_calls', 'tool_max_rounds', 'tool_timeout_seconds', 'tool_result_bytes', 'tool_total_seconds',
  'tool_total_tokens', 'agent_windows', 'window_soft_ratio', 'window_hard_ratio', 'recall_peer_scope'] as const

export function parseProfile(body: Record<string, unknown>): Profile {
  fields(body, [...profileFields, 'id', 'revision'], invalidConfig) // Storage metadata is never trusted on PUT.
  const out = { ...defaultProfile }
  if (Object.hasOwn(body, 'name')) out.name = displayName(body.name)
  for (const key of toggle) if (Object.hasOwn(body, key)) {
    const value = body[key]
    if (typeof value !== 'boolean') throw invalidConfig(`${key} must be a boolean.`)
    out[key] = value
  }
  for (const key of Object.keys(ints) as Array<keyof typeof ints>) if (Object.hasOwn(body, key)) {
    const [min, max] = ints[key], value = body[key]
    if (!integer(value, min, max)) throw invalidConfig(`${key} must be an integer in ${min}–${max}.`)
    out[key] = value
  }
  for (const key of ['score_threshold', 'recall_timeout'] as const) if (Object.hasOwn(body, key)) {
    const value = body[key], limits = key === 'score_threshold' ? [0, 1] : [0.05, 10]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < limits[0] || value > limits[1]) {
      throw invalidConfig(`${key} is out of range.`)
    }
    out[key] = value
  }
  if (Object.hasOwn(body, 'context_types')) {
    const value = body.context_types
    if (!Array.isArray(value) || value.length > kinds.length || value.some(kind => !kinds.includes(kind))) {
      throw invalidConfig('context_types must name memory, resource or skill.')
    }
    out.context_types = [...new Set<Kind>(value)]
  }
  if (Object.hasOwn(body, 'quotas')) {
    const quotas = record(body.quotas, invalidConfig)
    fields(quotas, buckets, invalidConfig)
    const parsed: Profile['quotas'] = {}
    for (const [bucket, value] of Object.entries(quotas)) {
      if (!integer(value, 0, 12)) throw invalidConfig('Recall quotas must be integers in 0–12.')
      parsed[bucket as Bucket] = value
    }
    out.quotas = parsed
  }
  if (Object.hasOwn(body, 'capture_memory_types')) {
    const value = body.capture_memory_types
    if (!Array.isArray(value) || value.length > 1 || value.some(kind => kind !== 'events')) {
      throw unsupported('Only raw capture ([]) and owner event extraction (["events"]) are available.', 'profile_setting_unsupported')
    }
    out.capture_memory_types = [...value]
  }
  if (Object.hasOwn(body, 'disabled_tools') && (!Array.isArray(body.disabled_tools) || body.disabled_tools.length)) {
    throw unsupported('Gateway tools are always disabled.', 'profile_setting_unsupported')
  }
  for (const key of inactive) if (Object.hasOwn(body, key) && body[key] !== defaultProfile[key]) {
    throw unsupported(`${key} is not configurable on this Gateway.`, 'profile_setting_unsupported')
  }
  return out
}

const overrideFields = ['recall', 'profile', 'capture', 'context_types', 'max_tokens', 'session_max_tokens',
  'profile_max_tokens', 'score_threshold', 'recall_timeout', 'query_max_chars', 'show_recall'] as const

export function resolveProfile(saved: Profile, header: string | null): { policy: Profile; keys: string[] } {
  if (header === null) return { policy: saved, keys: [] }
  if (!saved.client_overrides) throw new GatewayError(403, 'context_override_not_allowed', 'The account profile does not accept context overrides.')
  const bad = () => invalid('Expected a bounded JSON context override with supported fields.', 'context_override_invalid')
  if (bytes(header) > 2048) throw bad()
  let override: Record<string, unknown>, merged: Profile
  try {
    override = record(JSON.parse(header))
    fields(override, overrideFields)
    merged = parseProfile({ ...saved, ...override })
  } catch { throw bad() }
  if (['recall', 'profile', 'capture'].some(key => merged[key as typeof toggle[number]] && !saved[key as typeof toggle[number]]) ||
      merged.context_types.some(type => !saved.context_types.includes(type)) ||
      merged.max_tokens > saved.max_tokens || merged.session_max_tokens > saved.session_max_tokens ||
      merged.profile_max_tokens > saved.profile_max_tokens || merged.score_threshold < saved.score_threshold ||
      merged.recall_timeout > saved.recall_timeout || merged.query_max_chars > saved.query_max_chars) {
    throw new GatewayError(403, 'context_override_not_allowed', 'Context overrides may only narrow the account policy.')
  }
  return { policy: merged, keys: Object.keys(override).sort() }
}
