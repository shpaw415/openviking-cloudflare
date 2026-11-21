// SPDX-License-Identifier: AGPL-3.0-only
import { invalid, quota } from '../fs/contract.js'
import { asObject } from './common.js'
import type { Data } from './common.js'

const key = /^([A-Za-z_][A-Za-z0-9_-]{0,63}):(?: +(.+)|$)/u
const sequence = /^-(?: +(.+)|$)/u
const malformed = (): never => invalid('Expected a flat asset manifest in JSON or the supported YAML subset.')

// Visit only unquoted characters; do not interpret any tags or references.
function unquoted(text: string, visit: (pos: number) => boolean): void {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"' || ch === "'" && quote === "'" && text[i + 1] === "'") i++
      else if (ch === quote) quote = ''
    } else if ((ch === '"' || ch === "'") && (i === 0 || /[ :,\[]/u.test(text[i - 1]))) quote = ch
    else if (!visit(i)) return
  }
  if (quote) malformed()
}

function comment(line: string): string {
  let end = line.length
  unquoted(line, i => {
    if (line[i] !== '#' || i > 0 && line[i - 1] !== ' ') return true
    end = i
    return false
  })
  return line.slice(0, end).trimEnd()
}

function atom(value: string): unknown {
  if (!value || value === '~' || /^(null)$/iu.test(value)) return null
  if (value.startsWith('"')) {
    try { return JSON.parse(value) as string } catch { return malformed() }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) return malformed()
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (/^(true|false)$/iu.test(value)) return value.toLowerCase() === 'true'
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value)) return Number(value)
  if (/^[&*!|>%?@`]|[\[\]{},]|:(?: |$)/u.test(value)) return malformed()
  return value
}

function scalar(value: string): unknown {
  if (value === '{}') return Object.create(null) as Data
  if (!value.startsWith('[')) return atom(value)
  if (!value.endsWith(']')) return malformed()
  const items = value.slice(1, -1).trim()
  if (!items) return []
  const pieces: unknown[] = []
  let start = 0
  unquoted(items, i => {
    if (items[i] === ',') {
      const word = items.slice(start, i).trim()
      if (!word || pieces.length >= 128) return malformed()
      pieces.push(atom(word))
      start = i + 1
    }
    return true
  })
  if (!items.slice(start).trim()) return malformed()
  return [...pieces, atom(items.slice(start).trim())]
}

export function parseManifest(raw: string): Data {
  const text = raw.replace(/^\ufeff/u, '')
  if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(text)) return malformed()
  if (text.trimStart().startsWith('{')) {
    let json: unknown
    try { json = JSON.parse(text) } catch { return malformed() }
    return asObject(json, 'Manifest')
  }
  const lines = text.split(/\r\n|\n|\r/u)
  if (lines.length > 2048) quota('The asset manifest has too many lines.')
  const rows: { indent: number; text: string }[] = []
  let started = false
  for (const line of lines) {
    const trimmed = comment(line.trimStart())
    if (!trimmed) continue
    if (!started && trimmed === '---' && line.startsWith('---')) { started = true; continue }
    started = true
    const indent = /^ */u.exec(line)![0].length
    if (indent > 48 || !line.slice(indent).startsWith(trimmed)) return malformed()
    const item = /^(- +)(.+)$/u.exec(trimmed)
    if (item && key.test(item[2])) rows.push({ indent, text: '-' }, { indent: indent + item[1].length, text: item[2] })
    else rows.push({ indent, text: trimmed })
  }
  if (!rows.length || rows[0].indent !== 0) return malformed()
  let i = 0
  function node(indent: number, depth: number): unknown {
    if (depth > 8) return malformed()
    if (sequence.test(rows[i].text)) {
      const items: unknown[] = []
      while (rows[i]?.indent === indent) {
        const item = sequence.exec(rows[i].text)
        if (!item) break
        i++
        items.push(item[1] ? scalar(item[1]) : rows[i]?.indent > indent ? node(rows[i].indent, depth + 1) : malformed())
      }
      return items
    }
    const fields: Data = Object.create(null)
    while (rows[i]?.indent === indent) {
      const field = key.exec(rows[i++].text)
      if (!field || Object.hasOwn(fields, field[1])) return malformed()
      const next = rows[i]
      fields[field[1]] = field[2] ? scalar(field[2]) : next && (next.indent > indent || next.indent === indent && sequence.test(next.text)) ?
        node(next.indent, depth + 1) : null
    }
    return fields
  }
  const document = node(0, 0)
  if (i !== rows.length) return malformed()
  return asObject(document, 'Manifest')
}
