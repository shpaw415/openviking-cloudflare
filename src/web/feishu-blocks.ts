// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { list, match, token } from './native-catalog.js'
const invalidNative = () => new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The approved source did not provide a supported document.')

/** Bounded projection of the Docx/block DTO into inert documentary text. */
export function renderFeishuBlocks(blocks: Map<string, Record<string, unknown>>) {
  const counts = new Map<unknown, number>(), cells = new Set<string>(), childOfCell = new Set<string>()
  const children = (block: Record<string, unknown>) => {
    const ids = block.children ?? []
    if (!list(ids, 300) || !ids.every(id => match(id, token) && blocks.has(id)) || new Set(ids).size !== ids.length) throw invalidNative()
    return ids as string[]
  }
  const text = (block: Record<string, unknown>): string => {
    const kind = block.block_type as number
    if (kind === 22) return '---'
    if ([23, 24, 34].includes(kind)) return '' // Structural containers; descendants are present in the flat blocks result.
    const name = kind === 1 ? 'page' : kind === 2 ? 'text' : kind >= 3 && kind <= 11 ? `heading${kind - 2}` :
      ({ 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote', 17: 'todo', 19: 'callout' } as Record<number, string>)[kind]
    const rich = name ? block[name] : undefined
    if (!isRecord(rich) || !list(rich.elements, 256)) throw invalidNative()
    const line = rich.elements.map(element => {
      if (!isRecord(element)) throw invalidNative()
      if (isRecord(element.text_run) && typeof element.text_run.content === 'string') return element.text_run.content
      if (isRecord(element.equation) && typeof element.equation.content === 'string') return element.equation.content
      if (isRecord(element.mention_doc) && typeof element.mention_doc.title === 'string') return element.mention_doc.title
      if (isRecord(element.mention_user)) return '[user mention]' // No directory lookup or emission of an internal member ID.
      throw invalidNative()
    }).join('')
    if (!line.trim()) return ''
    if (kind >= 3 && kind <= 11) return `${'#'.repeat(kind - 2)} ${line}`
    if (kind === 12 || kind === 15) return `${kind === 12 ? '-' : '>'} ${line}`
    if (kind === 13) {
      const n = (counts.get(block.parent_id) ?? 0) + 1
      counts.set(block.parent_id, n)
      return `${n}. ${line}`
    }
    if (kind === 14) return line.split('\n').map(part => '    ' + part).join('\n')
    if (kind === 17) return `- [${isRecord(rich.style) && rich.style.done === true ? 'x' : ' '}] ${line}`
    return line
  }
  const tables = new Map<string, string>()
  for (const [id, block] of blocks) {
    if (block.block_type !== 31) continue
    const dim = isRecord(block.table) ? block.table.property : undefined
    const entries = isRecord(block.table) && Array.isArray(block.table.cells) ? block.table.cells : children(block)
    if (!isRecord(dim) || typeof dim.row_size !== 'number' || typeof dim.column_size !== 'number' ||
        !Number.isInteger(dim.row_size) || !Number.isInteger(dim.column_size) || dim.row_size < 1 || dim.column_size < 1 ||
        dim.row_size * dim.column_size !== entries.length || entries.length > 100 ||
        !entries.every(cell => match(cell, token))) throw invalidNative()
    const rows: string[] = [], values: string[] = []
    for (const cell of entries as string[]) {
      const item = blocks.get(cell)
      if (!item || item.block_type !== 32 || cells.has(cell) || (item.parent_id != null && item.parent_id !== id)) throw invalidNative()
      cells.add(cell)
      const parts = children(item).map(child => {
        const content = blocks.get(child)!
        if (childOfCell.has(child) || (content.parent_id != null && content.parent_id !== cell) || children(content).length) throw invalidNative()
        childOfCell.add(child)
        return text(content).replace(/[\n\r\t]+/g, ' ').replace(/\|/g, '\\|')
      })
      values.push(parts.join(' '))
      if (values.length === dim.column_size) {
        rows.push(`| ${values.join(' | ')} |`)
        if (rows.length === 1) rows.push(`| ${values.map(() => '---').join(' | ')} |`)
        values.length = 0
      }
    }
    tables.set(id, rows.join('\n'))
  }
  return [...blocks.entries()].filter(([id]) => !cells.has(id) && !childOfCell.has(id))
    .map(([id, block]) => tables.get(id) ?? text(block)).filter(Boolean).join('\n\n')
}
