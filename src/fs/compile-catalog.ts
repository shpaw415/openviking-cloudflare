// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { EXAMPLE_SKILLS, compare, textSize } from './contract.js'
import { skillNamePattern } from './skill-format.js'
import type { Entry } from './store.js'

export type CompileExampleSkill = { name: string; description: string; content: string }

export function exampleSkills(ctx: WorkspaceContext): readonly CompileExampleSkill[] {
  const items = ctx.compileExampleSkills
  if (!items || items.length > 32) throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'The Compile example skill catalogue is not available.')
  const seen = new Set<string>()
  for (const item of items) {
    if (!skillNamePattern.test(item.name) || seen.has(item.name) || !item.content.trim() || !item.description.trim()) {
      throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'The Compile example skill catalogue is invalid.')
    }
    seen.add(item.name)
  }
  return [...items].sort((a, b) => compare(a.name, b.name))
}

export function exampleEntries(ctx: WorkspaceContext): Array<Entry & { body?: string }> {
  const item = (uri: string, description = '', body?: string): Entry & { body?: string } => ({ uri, description, body,
    is_dir: Number(body === undefined), bytes: body === undefined ? 0 : textSize(body), tags: '[]', dimensions: 0, vector_bytes: 0,
    created_at: 0, updated_at: 0, revision: '', node_id: '' })
  return [item('viking://system'), item('viking://system/compile'), item(EXAMPLE_SKILLS), ...exampleSkills(ctx).flatMap(skill => {
    const dir = `${EXAMPLE_SKILLS}/${skill.name}`
    return [item(dir, skill.description), item(`${dir}/SKILL.md`, '', skill.content)]
  })]
}
