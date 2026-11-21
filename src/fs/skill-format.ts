// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, isRecord } from '../http.js'
import { FILE_LIMIT, invalid, str, textSize } from './contract.js'

export const skillNamePattern = /^[a-zA-Z0-9_-]{1,64}$/
export type SkillMetadata = { name: string; description: string; tags: string[]; allowed_tools: string[]; metadata: Record<string, unknown> }

function scalar(value: string, depth = 0): unknown {
  if (depth > 4 || /^[&*!]/.test(value)) invalid('Unsupported frontmatter scalar.')
  if (!value) return ''
  if (value[0] === '"' || value[0] === '[' || value[0] === '{') {
    try { return JSON.parse(value) } catch {
      // Standard YAML flow sequences of bare scalars are common in SKILL.md.
      if (/^\[[^\[\]{}]*\]$/.test(value)) {
        const contents = value.slice(1, -1).trim()
        return contents ? contents.split(',').map(part => scalar(part.trim(), depth + 1)) : []
      }
      invalid('Unsupported frontmatter flow syntax.')
    }
  }
  if (value[0] === "'") {
    if (!/^'(?:[^']|'')*'$/.test(value)) invalid('Invalid frontmatter quote.')
    return value.slice(1, -1).replaceAll("''", "'")
  }
  const plain = value.split(/\s+#/, 1)[0].trimEnd()
  if (plain === 'true' || plain === 'false') return plain === 'true'
  if (plain === 'null' || plain === '~') return null
  if (/^-?\d+(?:\.\d+)?$/.test(plain) && Number.isFinite(Number(plain))) return Number(plain)
  return plain
}

function frontmatter(input: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]{0,8192}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(input)
  if (!match) invalid('A bounded YAML frontmatter block is required.')
  const lines = match[1].split(/\r?\n/).map(text => ({ text, spaces: /^ */.exec(text)![0].length }))
  if (lines.length > 180 || lines.some(line => /^ *\t/.test(line.text))) invalid('Unsupported indentation in frontmatter.')
  let i = 0
  const skip = () => { while (i < lines.length && /^(?:\s*#.*|\s*)$/.test(lines[i].text)) i++ }
  function block(indent: number, depth: number): unknown {
    if (depth > 6) invalid('Frontmatter nesting is too deep.')
    const array = lines[i]?.text.slice(indent).startsWith('- ')
    const list: unknown[] = [], map: Record<string, unknown> = Object.create(null)
    for (;;) {
      skip()
      const line = lines[i]
      if (!line || line.spaces < indent) return array ? list : map
      if (line.spaces !== indent) invalid('Invalid frontmatter indentation.')
      const text = line.text.slice(indent)
      i++
      if (array) {
        if (!text.startsWith('- ')) invalid('Expected a frontmatter list item.')
        list.push(scalar(text.slice(2).trim()))
        continue
      }
      const pair = /^([a-zA-Z0-9_.-]+):(?:[ \t]+(.*)|$)/.exec(text)
      if (!pair || Object.hasOwn(map, pair[1])) invalid('Expected unique frontmatter keys.')
      const value = pair[2]?.trim()
      if (value && /^[|>][-+]?$/.test(value)) {
        const bits: string[] = []
        let offset = lines[i]?.spaces ?? 0
        while (i < lines.length && (!lines[i].text.trim() || lines[i].spaces > indent)) {
          if (offset <= indent && lines[i].text.trim()) offset = lines[i].spaces
          bits.push(lines[i++].text.slice(offset))
        }
        map[pair[1]] = bits.join(value.startsWith('>') ? ' ' : '\n').trimEnd()
      } else if (!value || value.startsWith('#')) {
        skip()
        map[pair[1]] = lines[i]?.spaces > indent ? block(lines[i].spaces, depth + 1) : ''
      } else map[pair[1]] = scalar(value)
    }
  }
  skip()
  const values = block(0, 0)
  if (!isRecord(values)) invalid('Skill frontmatter must be a mapping.')
  return { values, body: input.slice(match[0].length) }
}

function stringList(input: unknown, tools: boolean): string[] {
  if (input == null || input === '') return []
  const list = typeof input === 'string' && tools ? input.match(/[^\s()]+(?:\([^()\r\n]*\))?/g) ?? [] : input
  if (!Array.isArray(list) || list.length > 32) invalid('Expected a bounded list of skill tags or tool declarations.')
  return [...new Set(list.map(item => str(item, 'skill metadata item', undefined, 256).trim()).filter(Boolean))]
}

type Issue = { rule: string; message: string; field?: string }

export function defineSkill(input: unknown, strict = false, directory?: string, sourcePath?: string) {
  const errors: Issue[] = [], warnings: Issue[] = []
  const report: SkillMetadata = { name: '', description: '', tags: [], allowed_tools: [], metadata: {} }
  let body = '', content = '', files: Record<string, unknown> = {}
  try {
    const inline = typeof input === 'string'
    let data: Record<string, unknown>, full: string | undefined
    if (inline) {
      full = str(input, 'SKILL.md', undefined, FILE_LIMIT)
      textSize(full)
      ;({ values: data, body } = frontmatter(full))
    } else if (isRecord(input)) {
      data = input
      body = str(input.content ?? undefined, 'skill content', '', FILE_LIMIT)
      if (/^\uFEFF?---\r?\n/.test(body)) {
        full = body
        const parsed = frontmatter(body)
        if (input.name != null && input.name !== parsed.values.name) invalid('Structured name does not match the frontmatter name.')
        data = { ...parsed.values, ...input }
        body = parsed.body
        // Structured overrides are normalized into one consistent definition.
        full = undefined
      }
      if (Object.hasOwn(input, 'inputSchema')) {
        if (!isRecord(input.inputSchema)) invalid('MCP inputSchema must be an object.')
        const name = typeof data.name === 'string' ? data.name.replaceAll('_', '-') : data.name
        data = { ...data, name }
        if (!body) body = `# ${name}\n\n${typeof data.description === 'string' ? data.description : ''}\n\n## Input schema\n\n\`\`\`json\n${JSON.stringify(input.inputSchema, null, 2)}\n\`\`\`\n`
      }
      if (input.files !== undefined) {
        if (!isRecord(input.files)) invalid('Skill files must map relative paths to UTF-8 text.')
        files = input.files
      }
    } else invalid('Expected SKILL.md text or a structured Skill definition.')
    if (data['allowed-tools'] !== undefined && data.allowed_tools !== undefined) invalid('Duplicate allowed tool declarations.')
    if (inline && data.allowed_tools !== undefined) invalid('Use allowed-tools in SKILL.md frontmatter.')
    report.name = typeof data.name === 'string' ? data.name.trim() : ''
    report.description = typeof data.description === 'string' ? data.description.trim() : ''
    report.tags = stringList(data.tags, false)
    report.allowed_tools = stringList(data['allowed-tools'] ?? data.allowed_tools, true)
    if (data.metadata != null && !isRecord(data.metadata)) invalid('Skill metadata must be an object.')
    report.metadata = (data.metadata ?? {}) as Record<string, unknown>
    const extended = strict ? errors : warnings
    if (!report.name) errors.push({ rule: 'name_required', field: 'name', message: 'name is required' })
    else if (!skillNamePattern.test(report.name)) extended.push({ rule: 'name_format', field: 'name', message: 'name must be 1–64 ASCII letters, digits, underscores or hyphens' })
    if (!report.description) errors.push({ rule: 'description_required', field: 'description', message: 'description is required' })
    else if (report.description.length > 1024) extended.push({ rule: 'description_max_length', field: 'description', message: 'description exceeds 1024 characters' })
    if (directory !== undefined && report.name && directory !== report.name) {
      extended.push({ rule: 'name_matches_directory', field: 'name', message: 'Skill name does not match its directory.' })
    }
    const yaml = { name: report.name, description: report.description, ...(data.tags !== undefined && { tags: report.tags }),
      ...((data['allowed-tools'] !== undefined || data.allowed_tools !== undefined) && { 'allowed-tools': report.allowed_tools }),
      ...(data.metadata !== undefined && { metadata: report.metadata }) }
    content = full ?? `---\n${Object.entries(yaml).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${body}`
    textSize(content)
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.status === 413) throw error
    errors.push({ rule: 'frontmatter_format', message: error.message })
  }
  const lines = body ? body.replace(/\r?\n$/, '').split(/\r\n|\n|\r/).length : 0
  if (lines > 500) warnings.push({ rule: 'body_max_lines', message: 'Skill body exceeds 500 lines.' })
  return { report: { valid: !errors.length, strict, ...report, body_lines: lines, errors, warnings,
    ...(sourcePath !== undefined && { source_path: sourcePath }) }, body, content, files }
}
