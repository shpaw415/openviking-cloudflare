// SPDX-License-Identifier: AGPL-3.0-only
import { invalid } from './common.js'

type Match = (char: string) => boolean
type Token = '*' | Match

function component(pattern: string): (name: string) => boolean {
  const tokens: Token[] = []
  const chars = Array.from(pattern)
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]
    if (char === '*') {
      if (tokens.at(-1) !== '*') tokens.push('*')
    } else if (char === '?') tokens.push(() => true)
    else if (char === '[') {
      const end = chars.indexOf(']', i + 1)
      if (end <= i + 1) return invalid('Invalid bracket class in .ovgitignore.')
      let position = i + 1
      const negate = chars[position] === '!' || chars[position] === '^'
      if (negate) position++
      const ranges: [string, string][] = []
      while (position < end) {
        const first = chars[position++]
        const last = position + 1 < end && chars[position] === '-' ? (position += 2, chars[position - 1]) : first
        if (first > last) return invalid('Invalid range in .ovgitignore.')
        ranges.push([first, last])
      }
      if (!ranges.length) return invalid('Invalid bracket class in .ovgitignore.')
      tokens.push(value => ranges.some(([a, b]) => a <= value && value <= b) !== negate)
      i = end
    } else tokens.push(value => value === char)
  }
  if (!tokens.some(token => token === '*') && !/[?\[]/.test(pattern)) return name => name === pattern
  const memo = new Map<string, boolean>()
  return name => {
    const found = memo.get(name)
    if (found !== undefined) return found
    const input = Array.from(name)
    // The most recent star can absorb another character; no regex backtracking.
    let i = 0, j = 0, star = -1, consumed = 0
    while (j < input.length) {
      const token = tokens[i]
      if (token === '*') { star = i++; consumed = j }
      else if (token?.(input[j])) { i++; j++ }
      else if (star >= 0) { i = star + 1; j = ++consumed }
      else break
    }
    while (tokens[i] === '*') i++
    const result = j === input.length && i === tokens.length
    if (memo.size < 1024) memo.set(name, result)
    return result
  }
}

export function compileIgnore(source: string): (uri: string) => boolean {
  const rules: Array<(names: string[]) => boolean> = []
  for (const line of source.split('\n').map(line => line.trim())) {
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!') || line.includes('\\') || line.length > 256 || /\p{Cc}/u.test(line)) {
      invalid('Unsupported rule in .ovgitignore: negation, escapes, and control bytes are not accepted.')
    }
    if (rules.length >= 128) invalid('Too many effective rules in .ovgitignore.')
    const directoryOnly = line.endsWith('/')
    const pattern = line.replace(/^\//, '').replace(/\/$/, '')
    const pieces = pattern.split('/')
    if (pieces.some(part => !part || part === '.' || part === '..')) invalid('Invalid .ovgitignore path rule.')
    if (!line.startsWith('/') && pieces.length === 1) {
      const matches = component(pattern)
      rules.push(parts => parts.some((name, i) => (!directoryOnly || i < parts.length - 1) && matches(name)))
    } else {
      const tokens = pieces.map(piece => piece === '**' ? undefined : component(piece))
      rules.push(parts => {
        let states = new Set([0])
        for (let i = 0; i < tokens.length; i++) {
          const next = new Set<number>(), match = tokens[i]
          if (match) {
            for (const j of states) if (j < parts.length && match(parts[j])) next.add(j + 1)
          } else {
            const min = Math.min(...states) + (i === tokens.length - 1 && i > 0 ? 1 : 0)
            for (let j = min; j <= parts.length; j++) next.add(j)
          }
          if (!next.size) return false
          states = next
        }
        return !directoryOnly || [...states].some(end => end < parts.length)
      })
    }
  }
  return uri => {
    const parts = uri.slice('viking://'.length).split('/')
    return rules.some(matches => matches(parts))
  }
}
