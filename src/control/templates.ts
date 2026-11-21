// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { absent, bad, fields } from './input.js'
import { defaults, memoryTypes } from './template-defaults.js'
import type { MemoryTemplate, MemoryType } from './template-defaults.js'

const editable = {
  profile: ['content'], events: ['event_name', 'summary'], preferences: ['topic', 'content'], entities: ['category', 'name', 'content'],
} satisfies Record<MemoryType, string[]>
const lockedTypes = new Set(['skills', 'tools', 'cases', 'experiences', 'trajectories'])
const slots = ['event_name', 'goal', 'summary', 'ranges'] as const
const encoder = new TextEncoder()
const outputLimit = 64 * 1024

export function memoryType(value: string): MemoryType {
  if (lockedTypes.has(value)) throw bad('This memory template is not editable.')
  if (!(memoryTypes as readonly string[]).includes(value)) throw absent('Memory template', value)
  return value as MemoryType
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 64_000 ||
      /[\p{Cs}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value) || Array.from(value).length > 50_000) {
    throw bad('Template text must be nonempty, bounded Unicode without control characters.')
  }
  return value
}

function grammarError(): never { throw bad('Unsupported template syntax for the safe Edge renderer.') }

// Bounded interpreter, not Jinja: parse only an explicit set of tokens. Values
// are appended literally once, so they never introduce evaluations or directives.
function render(source: string, scope: 'description' | 'event', values: Map<string, string>): string {
  const tokens = /\{\{|\{%|\{#/g
  const conditions: { parent: boolean; yes: boolean; seenElse: boolean }[] = []
  const output: string[] = []
  let active = true, size = 0, cursor = 0, steps = 0
  const append = (piece: string) => {
    if (!active || !piece) return
    size += encoder.encode(piece).length
    if (size > outputLimit) throw bad('Rendered template exceeds 64 KiB.')
    output.push(piece)
  }
  for (;;) {
    const token = tokens.exec(source)
    if (!token) { append(source.slice(cursor)); break }
    if (++steps > 256 || token[0] === '{#') grammarError()
    append(source.slice(cursor, token.index))
    const expression = token[0] === '{{'
    const end = source.indexOf(expression ? '}}' : '%}', tokens.lastIndex)
    if (end < 0 || end - tokens.lastIndex > 96) grammarError()
    const command = source.slice(tokens.lastIndex, end).trim()
    if (expression) {
      if (scope === 'description') {
        if (command !== 'language') grammarError()
        append(values.get('language') ?? '')
      } else {
        const match = /^(event_name|goal|summary|ranges)(?:\s*\|\s*(lower|upper|trim))?$/.exec(command)
        if (!match) grammarError()
        const value = values.get(match[1]) ?? ''
        append(match[2] === 'lower' ? value.toLowerCase() : match[2] === 'upper' ? value.toUpperCase() : match[2] === 'trim' ? value.trim() : value)
      }
    } else {
      if (scope !== 'description') grammarError()
      const when = /^if\s+language\s*==\s*(['"])([A-Za-z0-9-]{2,40})\1$/.exec(command)
      if (when) {
        if (conditions.length >= 4) grammarError()
        const yes = values.get('language') === when[2]
        conditions.push({ parent: active, yes, seenElse: false })
        active = active && yes
      } else if (command === 'else') {
        const condition = conditions.at(-1)
        if (!condition || condition.seenElse) grammarError()
        condition.seenElse = true
        active = condition.parent && !condition.yes
      } else if (command === 'endif') {
        const condition = conditions.pop()
        if (!condition) grammarError()
        active = condition.parent
      } else grammarError()
    }
    cursor = end + 2
    tokens.lastIndex = cursor
  }
  if (conditions.length) grammarError()
  return output.join('')
}

type Override = { description?: string; content_template?: string; fields?: { name: string; description: string }[] }

function overrides(type: MemoryType, submitted: Record<string, unknown>): Override {
  const base = defaults[type]
  const changed: Override = {}
  for (const [name, value] of Object.entries(submitted)) {
    if (name === 'fields') continue
    if (!Object.hasOwn(base, name)) throw bad('Unknown memory template field.')
    if (value === base[name as keyof MemoryTemplate]) continue
    if (name === 'description') {
      changed.description = text(value)
      render(changed.description, 'description', new Map())
    } else if (name === 'content_template' && type === 'events') {
      changed.content_template = text(value)
      render(changed.content_template, 'event', new Map())
    } else throw bad('This memory template field is locked.')
  }
  const supplied = submitted.fields
  if (supplied !== undefined) {
    if (!Array.isArray(supplied) || supplied.length > base.fields.length) throw bad('Invalid memory template fields.')
    const seen = new Set<string>()
    const updates: NonNullable<Override['fields']> = []
    for (const field of supplied) {
      if (!isRecord(field) || typeof field.name !== 'string' || seen.has(field.name)) throw bad('Invalid or duplicate memory template field.')
      const original = base.fields.find(item => item.name === field.name)
      if (!original) throw bad('Unknown memory template field.')
      seen.add(original.name)
      for (const [key, value] of Object.entries(field)) {
        if (!Object.hasOwn(original, key)) throw bad('Unknown memory template field property.')
        if (value === original[key as keyof typeof original]) continue
        if (key !== 'description' || !editable[type].includes(original.name)) throw bad('This memory template field is locked.')
        const description = text(value)
        render(description, 'description', new Map())
        updates.push({ name: original.name, description })
      }
    }
    if (updates.length) changed.fields = updates
  }
  return changed
}

export class Templates {
  constructor(private sql: SqlStorage) {}

  static init(sql: SqlStorage): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS ov_control_templates (
      account_id TEXT NOT NULL REFERENCES ov_control_accounts(account_id), memory_type TEXT NOT NULL,
      config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) = 'object'), updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, memory_type)
    ) WITHOUT ROWID`)
  }

  publish(account: string, type: MemoryType, body?: Record<string, unknown>): void {
    const delta = body ? overrides(type, body) : {}
    if (!Object.keys(delta).length) {
      this.sql.exec('DELETE FROM ov_control_templates WHERE account_id = ? AND memory_type = ?', account, type)
    } else {
      this.sql.exec(`INSERT INTO ov_control_templates(account_id, memory_type, config, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id, memory_type) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at`,
      account, type, JSON.stringify(delta), new Date().toISOString())
    }
  }

  result(account: string, type: MemoryType) {
    const base = defaults[type]
    const row = this.sql.exec<{ config: string; updated_at: string }>(`
      SELECT config, updated_at FROM ov_control_templates WHERE account_id = ? AND memory_type = ?`, account, type).toArray()[0]
    let delta: Override = {}
    if (row) {
      try {
        const value: unknown = JSON.parse(row.config)
        if (!isRecord(value)) throw bad('Invalid template override.')
        delta = overrides(type, value)
      } catch { throw new ApiError(412, 'FAILED_PRECONDITION', 'The stored memory template cannot be validated.') }
    }
    const effective = { ...base, description: delta.description ?? base.description,
      content_template: delta.content_template ?? base.content_template,
      fields: base.fields.map(field => ({ ...field,
        description: delta.fields?.find(item => item.name === field.name)?.description ?? field.description,
      })),
    }
    return { memory_type: type, status: row ? 'custom' : 'system_default', updated_at: row?.updated_at ?? null,
      effective, defaults: base } as const
  }

  renderFor(account: string, type: MemoryType, language: string, event?: Record<string, unknown>) {
    if (!/^[A-Za-z0-9-]{0,40}$/.test(language)) throw bad('Invalid template language.')
    if (event !== undefined && (type !== 'events' || !isRecord(event))) throw bad('Expected event fields for the events template.')
    const { effective, updated_at } = this.result(account, type)
    const variables = new Map([['language', language]])
    const fieldsOut = effective.fields.map(item => ({ name: item.name, description: render(item.description, 'description', variables) }))
    let content: string | null = null
    if (event !== undefined) {
      fields(event, slots)
      const entries: [string, string][] = []
      for (const slot of slots) {
        const value = event[slot]
        if (value === undefined) continue
        if (typeof value !== 'string' || value.length > 8192 || /\p{Cs}/u.test(value)) throw bad('Invalid event field value.')
        entries.push([slot, value])
      }
      if (effective.content_template !== defaults.events.content_template && effective.content_template !== null) {
        content = render(effective.content_template, 'event', new Map(entries))
      }
    }
    return { memory_type: type, updated_at, description: render(effective.description, 'description', variables), fields: fieldsOut, content }
  }
}
