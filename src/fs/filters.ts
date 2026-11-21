// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { inPath, invalid, onlyKeys, partsOf, str } from './contract.js'
import type { ContextKind } from './contract.js'
import type { Filesystem } from './store.js'

export type SearchRecord = { uri: string; context_type: ContextKind; level: number; category: string;
  search_tags: string[]; created_at: number; updated_at: number; size: number }
type Predicate = (row: SearchRecord) => boolean
const fields = ['uri', 'context_type', 'level', 'category', 'search_tags', 'created_at', 'updated_at', 'size'] as const
const timeFields = ['created_at', 'updated_at']
const rangeKeys = ['gt', 'gte', 'lt', 'lte'] as const
const scales = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export function timeBound(value: unknown, field: string, now: number, upper = false): number | undefined {
  if (value == null || value === '') return
  const time = str(value, field, undefined, 45).trim()
  if (!time) return
  const relative = /^(\d{1,9})([smhdw])$/.exec(time)
  if (relative) {
    const stamp = now - Number(relative[1]) * scales[relative[2] as keyof typeof scales]
    if (!Number.isSafeInteger(stamp) || Math.abs(stamp) > 8.64e15) invalid(`Invalid ${field} datetime.`)
    return stamp
  }
  const day = /^\d{4}-\d\d-\d\d$/.test(time)
  if (!day && !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)?$/.test(time)) invalid(`Invalid ${field} datetime.`)
  const stamp = Date.parse(day || /(?:Z|[+-]\d\d:\d\d)$/.test(time) ? time : `${time.replace(' ', 'T')}Z`)
  const date = Date.parse(time.slice(0, 10))
  if (!Number.isFinite(stamp) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== time.slice(0, 10)) {
    invalid(`Invalid ${field} datetime.`)
  }
  return stamp + (day && upper ? scales.d - 1 : 0)
}

export function portableFilter(fs: Filesystem, input: unknown, now: number): Predicate | undefined {
  if (input == null || isRecord(input) && !Object.keys(input).length) return
  let count = 0
  function compile(value: unknown, depth: number): Predicate {
    if (depth > 6 || ++count > 48 || !isRecord(value)) invalid('Search filter exceeds its shape or size limits.')
    if (!Object.hasOwn(value, 'op')) {
      if (!Object.keys(value).length || Object.keys(value).length > fields.length) invalid('Expected public metadata filter fields.')
      const terms = Object.entries(value).map(([field, term]) => compile({ op: 'must', field,
        conds: Array.isArray(term) ? term : [term], ...(field === 'uri' && { para: '-d=0' }) }, depth + 1))
      return row => terms.every(test => test(row))
    }
    const op = value.op
    if (op === 'and' || op === 'or') {
      onlyKeys(value, 'op conds')
      if (!Array.isArray(value.conds) || !value.conds.length || value.conds.length > 24) invalid('Expected filter child predicates.')
      const parts = value.conds.map(item => compile(item, depth + 1))
      return op === 'and' ? row => parts.every(test => test(row)) : row => parts.some(test => test(row))
    }
    const field = value.field === 'type' ? 'context_type' : value.field === 'tags' ? 'search_tags' : value.field as keyof SearchRecord
    if (!fields.includes(field)) invalid('Unsupported or non-public search filter field.')
    if (op === 'must' || op === 'must_not') {
      onlyKeys(value, 'op field conds para')
      if (!Array.isArray(value.conds) || !value.conds.length || value.conds.length > 24) invalid('Expected bounded filter terms.')
      let test: Predicate
      if (field === 'uri') {
        const para = value.para === undefined ? '-d=-1' : str(value.para, 'para', undefined, 12)
        if (!/^-d=(?:-1|[0-9]|1[0-9]|20)$/.test(para)) invalid('URI filters accept -d=-1 for a subtree, or -d=0..20.')
        const maxDepth = Number(para.slice(3))
        const targets = value.conds.map(item => fs.path(item))
        test = row => targets.some(target => inPath(row.uri, target.uri) &&
          (maxDepth < 0 || partsOf(row.uri).length - target.parts.length === maxDepth))
      } else {
        if (value.para !== undefined) invalid('para is supported only for URI depth filters.')
        const conds = value.conds.map(item => {
          if (timeFields.includes(field)) return timeBound(item, field, now) ?? invalid('Invalid time filter term.')
          if (field === 'level' || field === 'size') {
            if (!Number.isSafeInteger(item) || item < 0) invalid('Numeric filter term expected.')
            return item as number
          }
          return str(item, field, undefined, 256)
        })
        test = row => {
          const found = row[field]
          return Array.isArray(found) ? found.some(item => conds.includes(item)) : conds.includes(found)
        }
      }
      return op === 'must' ? test : row => !test(row)
    }
    if (op === 'range' || op === 'range_out' || op === 'time_range') {
      onlyKeys(value, 'op field gt gte lt lte')
      if (op === 'time_range' ? !timeFields.includes(field) : field !== 'level' && field !== 'size') invalid('A range filter needs a compatible numeric or time field.')
      const bounds = rangeKeys.flatMap(k => {
        if (value[k] === undefined) return []
        const bound = op === 'time_range' ? timeBound(value[k], k, now, k === 'lte') : value[k]
        if (typeof bound !== 'number' || !Number.isFinite(bound)) invalid('Invalid range bound.')
        return [[k, bound] as const]
      })
      if (!bounds.length) invalid('A range filter needs at least one bound.')
      const test: Predicate = row => bounds.every(([key, bound]) => {
        const found = row[field] as number
        return key === 'gt' ? found > bound : key === 'gte' ? found >= bound : key === 'lt' ? found < bound : found <= bound
      })
      return op === 'range_out' ? row => !test(row) : test
    }
    if (op === 'prefix' || op === 'contains') {
      const argument = op === 'prefix' ? 'prefix' : 'substring'
      onlyKeys(value, `op field ${argument}`)
      if (field !== 'uri' && field !== 'category' && field !== 'search_tags' && field !== 'context_type') invalid('Expected a public string field.')
      const term = str(value[argument], argument, undefined, 1024)
      if (!term) invalid('Text predicate cannot be empty.')
      const match = (text: string) => op === 'prefix' ? text.startsWith(term) : text.includes(term)
      return row => {
        const current = row[field]
        return Array.isArray(current) ? current.some(match) : match(current)
      }
    }
    return invalid('Unsupported portable filter operator.')
  }
  return compile(input, 0)
}
