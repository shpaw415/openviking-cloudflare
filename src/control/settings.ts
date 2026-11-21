// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { bad, fields, forbidden, unavailable } from './input.js'

type SystemSettings = {
  output_language_override?: string
  acl?: { enabled: true }
  agent_evolution?: { enabled: false }
}
type AddTargets = { resource_uri?: string; skill_uri?: string }
type UserSettings = { add_targets?: AddTargets }
const restricted = new Set(['vlm', 'query_planner', 'embedding', 'vectordb', 'parser_api'])
const supported = ['output_language_override', 'acl', 'agent_evolution'] as const
const langTag = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw bad('Configuration must be a JSON object.')
  return value
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw bad(`${name} must be a boolean.`)
  return value
}

export function evolution(value: unknown): { enabled: false } {
  const patch = object(value)
  fields(patch, ['enabled'])
  if (bool(patch.enabled, 'enabled')) throw unavailable('Agent Evolution is not available in this runtime.')
  return { enabled: false }
}

export function configurationPatch(body: Record<string, unknown>): unknown {
  fields(body, ['settings', 'revision', 'content'])
  if (body.content != null || body.revision != null) throw bad('Startup file content and revision are not part of Edge runtime configuration.')
  return body.settings === undefined ? {} : body.settings
}

export function systemPatch(current: SystemSettings, input: unknown, scope: 'cluster' | 'account',
  root: boolean, legacy = false): SystemSettings {
  if (input === undefined || input === null) return current
  const patch = object(input)
  if (!root && Object.keys(patch).some(key => restricted.has(key))) throw forbidden()
  if (legacy) fields(patch, ['acl', 'agent_evolution'])
  if (Object.keys(patch).some(key => !(supported as readonly string[]).includes(key))) {
    throw unavailable('One or more fields are not supported; secrets and provider configuration are not writable here.')
  }
  const result = { ...current }
  for (const field of supported) {
    if (!Object.hasOwn(patch, field) || (legacy && patch[field] === null)) continue
    const value = patch[field]
    if (field === 'acl' || field === 'agent_evolution') {
      if (scope !== 'account') throw unavailable('This field can be configured only at account scope on Edge.')
      if (value === null) { delete result[field]; continue }
      const flag = object(value)
      fields(flag, ['enabled'])
      if (!Object.hasOwn(flag, 'enabled') || flag.enabled === null) {
        if (!legacy) { if (flag.enabled === null) delete result[field]; continue }
        if (field === 'agent_evolution') throw bad('enabled is required.')
      }
      if (field === 'acl') {
        const enabled = flag.enabled === undefined ? false : bool(flag.enabled, 'enabled')
        if (!enabled) throw new ApiError(412, 'FAILED_PRECONDITION', 'Resource ACL enforcement cannot be disabled.')
        result.acl = { enabled: true }
      } else {
        result.agent_evolution = evolution(flag)
      }
    } else if (value === null) {
      delete result.output_language_override
    } else {
      if (typeof value !== 'string' || (value !== '' && !langTag.test(value))) throw bad('output_language_override must be a language tag or empty.')
      result.output_language_override = value
    }
  }
  return result
}

function target(value: unknown, kind: keyof AddTargets): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('viking://')) throw bad('Invalid add target URI.')
  const path = value.slice(9).replace(/\/$/, '')
  const parts = path.split('/')
  if (parts.length > 20 || parts.some(part => part === '.' || part === '..' ||
      !/^[\p{L}\p{M}\p{N}_.~ -]{1,160}$/u.test(part) || new TextEncoder().encode(part).length > 160)) throw bad('Invalid add target URI.')
  if (kind === 'skill_uri') {
    if (path !== '~/skills' && path !== 'agent/skills') throw bad('Skill target must be the current user or agent skills root.')
  } else {
    if (parts[0] !== 'resources' && !(parts[0] === '~' && parts[1] === 'resources')) {
      throw bad('Resource target must be shared or in the current user alias.')
    }
  }
  return `viking://${parts.map(part => part.normalize('NFC')).join('/')}`
}

export function userPatch(current: UserSettings, input: unknown, initial = false): UserSettings {
  if (input == null && initial) return current
  const patch = object(input)
  fields(patch, ['add_targets', 'ttl', 'memory_policy', 'privacy', ...(initial ? ['agent_evolution'] : [])])
  if (['ttl', 'memory_policy', 'privacy'].some(key => patch[key] != null &&
    !(key === 'privacy' && Object.keys(object(patch[key])).length === 0))) {
    throw unavailable('TTL, memory policy and privacy overrides require an integrated data-plane consumer.')
  }
  if (!Object.hasOwn(patch, 'add_targets')) return current
  if (patch.add_targets === null) return {}
  const values = object(patch.add_targets)
  fields(values, ['resource_uri', 'skill_uri'])
  const updated = { ...current.add_targets }
  for (const key of ['resource_uri', 'skill_uri'] as const) {
    if (!Object.hasOwn(values, key)) continue
    if (values[key] === null) delete updated[key]
    else updated[key] = target(values[key], key)
  }
  return Object.keys(updated).length ? { add_targets: updated } : {}
}

export class Settings {
  constructor(private sql: SqlStorage) {}

  static init(sql: SqlStorage): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS ov_control_settings (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
      PRIMARY KEY (account_id, user_id)
    ) WITHOUT ROWID`)
  }

  private get<T>(account: string, user: string): T {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM ov_control_settings WHERE account_id = ? AND user_id = ?`, account, user).toArray()[0]
    return (row ? JSON.parse(row.data) : {}) as T
  }

  private put(account: string, user: string, settings: object): void {
    if (!Object.keys(settings).length) {
      this.sql.exec('DELETE FROM ov_control_settings WHERE account_id = ? AND user_id = ?', account, user)
    } else {
      this.sql.exec(`INSERT INTO ov_control_settings(account_id, user_id, data) VALUES (?, ?, ?)
        ON CONFLICT(account_id, user_id) DO UPDATE SET data=excluded.data`, account, user, JSON.stringify(settings))
    }
  }

  system(account = ''): SystemSettings { return this.get(account, '') }
  saveSystem(account: string, settings: SystemSettings): void { this.put(account, '', settings) }
  user(account: string, user: string): UserSettings { return this.get(account, user) }
  saveUser(account: string, user: string, settings: UserSettings): void { this.put(account, user, settings) }

  userResult(account: string, user: string) {
    const config = this.user(account, user)
    const expand = (uri: string | undefined) => uri?.replace(/^viking:\/\/~\//, `viking://user/${user}/`) ?? null
    return { account_id: account, user_id: user, add_targets: {
      resource_uri: expand(config.add_targets?.resource_uri), skill_uri: expand(config.add_targets?.skill_uri),
    }, memory_policy: null, ttl: null, privacy: { mode: 'off', restore: false, custom_rules: [], never_mask: [] } }
  }

  legacyResult(account: string) {
    const { acl, agent_evolution } = this.system(account)
    return { account_id: account, settings: { acl: { enabled: true }, agent_evolution: { enabled: false } },
      overrides: { ...(acl && { acl }), ...(agent_evolution && { agent_evolution }) } }
  }

  effectiveLanguage(account: string): string { return this.system(account).output_language_override ?? this.system().output_language_override ?? '' }
}
