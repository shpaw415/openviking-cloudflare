// SPDX-License-Identifier: AGPL-3.0-only
import { leaf } from './common.js'

export const changeType = (oldKey: string | undefined, newKey: string | undefined) =>
  oldKey === newKey ? 'unchanged' : oldKey === undefined ? 'added' : newKey === undefined ? 'deleted' : 'modified'

export function withoutMemoryFields(content: string): string {
  const end = content.lastIndexOf('\n-->')
  const start = content.lastIndexOf('<!--', end)
  if (start < 0 || content.slice(end + 4).trim()) return content
  const header = /^<!--\s*MEMORY_FIELDS[ \t\r]*\n/.exec(content.slice(start))
  return header ? content.slice(0, start).trimEnd() : content
}

type Edit = { sign: ' ' | '-' | '+'; line: string }
const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Bounded LCS inside the changed middle. For a large middle, one valid replacement hunk. */
function editScript(a: string[], b: string[]): Edit[] {
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) first++
  let tail = 0
  while (tail < a.length - first && tail < b.length - first && a[a.length - tail - 1] === b[b.length - tail - 1]) tail++
  const edits = a.slice(0, first).map((line): Edit => ({ sign: ' ', line }))
  const x = a.slice(first, a.length - tail)
  const y = b.slice(first, b.length - tail)
  const width = y.length + 1
  if ((x.length + 1) * width <= 262_144) {
    const lcs = new Uint32Array((x.length + 1) * width)
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * width + j] = x[i] === y[j] ? 1 + lcs[(i + 1) * width + j + 1]
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
    for (let i = 0, j = 0; i < x.length || j < y.length;) {
      if (i < x.length && j < y.length && x[i] === y[j]) edits.push({ sign: ' ', line: x[i++] }), j++
      else if (j === y.length || (i < x.length && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        edits.push({ sign: '-', line: x[i++] })
      } else edits.push({ sign: '+', line: y[j++] })
    }
  } else {
    for (const line of x) edits.push({ sign: '-', line })
    for (const line of y) edits.push({ sign: '+', line })
  }
  for (const line of a.slice(a.length - tail)) edits.push({ sign: ' ', line })
  return edits
}

const range = (first: number, count: number) => count === 1 ? String(first + 1) : `${first + (count ? 1 : 0)},${count}`

export function unified(uri: string, oldBody: string | undefined, newBody: string | undefined): string {
  const edits = editScript(lines(oldBody ?? ''), lines(newBody ?? ''))
  const groups: Array<[number, number]> = []
  edits.forEach(({ sign }, index) => {
    if (sign === ' ') return
    const start = Math.max(0, index - 3), end = Math.min(edits.length, index + 4)
    const current = groups.at(-1)
    if (current && current[1] >= start) current[1] = end
    else groups.push([start, end])
  })
  if (!groups.length) return ''
  const name = leaf(uri)
  const output = [`--- ${oldBody === undefined ? '/dev/null' : `a/${name}`}\n+++ ${newBody === undefined ? '/dev/null' : `b/${name}`}\n`]
  let i = 0, old = 0, fresh = 0
  for (const [start, end] of groups) {
    while (i < start) { old += Number(edits[i].sign !== '+'); fresh += Number(edits[i++].sign !== '-') }
    const a = old, b = fresh
    const hunk: string[] = []
    for (; i < end; i++) {
      const { sign, line } = edits[i]
      old += Number(sign !== '+'); fresh += Number(sign !== '-')
      hunk.push(sign + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'))
    }
    output.push(`@@ -${range(a, old - a)} +${range(b, fresh - b)} @@\n`, hunk.join(''))
  }
  return output.join('')
}
