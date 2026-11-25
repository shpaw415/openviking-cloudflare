// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { FILE_LIMIT, invalid, onlyKeys, str, textSize } from '../fs/contract.js'
import { skillRow } from '../fs/skill-store.js'
import { backupSkillTree } from '../skills.js'
import { compare, quota } from './common.js'
import { topology } from './backup-codec.js'
import { hasTable, privateURI, type Domain } from './backup-domain.js'
import { canonicalParts } from './zip.js'

export const SKILL_CAP = 16
const incompatible = (): never => topology('Private skill is not a lossless, data-only package.')
export type BackupSkill = { uri: string; content: string; files: { path: string; text: string }[] }

export function readBackupSkill(d: Domain, value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.files) || value.files.length > 32) invalid('Invalid Edge skill record.')
  onlyKeys(value, 'uri content files')
  const { uri, owner } = privateURI(d, value.uri, 'skills')
  const content = str(value.content, 'Static skill text', undefined, FILE_LIMIT)
  const files = new Map<string, string>()
  for (const file of value.files) {
    if (!isRecord(file)) invalid('Expected a data-only skill attachment.')
    onlyKeys(file, 'path text')
    const path = str(file.path, 'Skill relative path', undefined, 1024)
    const parts = canonicalParts(path)
    if (!/\.(md|txt)$/i.test(parts.at(-1)!) || parts.some(part => part.startsWith('.') || /^skill\.md$/i.test(part)) || files.has(path)) incompatible()
    files.set(path, str(file.text, 'Static attachment text', undefined, FILE_LIMIT))
  }
  const fs = d.fs(owner)
  const data: BackupSkill = { uri, content, files: [...files].sort(([a], [b]) => compare(a, b)).map(([path, text]) => ({ path, text })) }
  return { data, fs, prepared: backupSkillTree(fs, uri, content, Object.fromEntries(files)) }
}

export function captureSkills(d: Domain) {
  const { sql, scope: { account } } = d
  const owned = new Set<string>()
  if (!hasTable(sql, 'ov_edge_fs_skill')) return { list: [] as BackupSkill[], owned, stamp: [] as string[], bytes: 0 }
  const keys = sql.exec<{ uri: string; space: string }>(`SELECT uri,space FROM ov_edge_fs_skill WHERE account_id=? AND uri GLOB 'viking://user/*'
    AND current_revision IS NOT NULL ORDER BY uri LIMIT ?`, account, SKILL_CAP + 1).toArray()
  if (keys.length > SKILL_CAP) quota('Edge backup skill limit exceeded.')
  let total = 0
  const stamp: string[] = []
  const list = keys.map(({ uri, space }) => {
    const { owner } = privateURI(d, uri, 'skills'), fs = d.fs(owner)
    const path = fs.path(uri) as ReturnType<typeof backupSkillTree>['path']
    if (path.space !== space) incompatible()
    const row = skillRow(fs, path) ?? incompatible()
    if (row.owner_user_id !== owner) incompatible()
    const manifest: unknown = JSON.parse(row.manifest)
    if (!Array.isArray(manifest) || manifest.length > 48) return incompatible()
    const files = manifest.filter(item => item.kind === 'auxiliary').map(item => {
      const rel = canonicalParts(item.path).join('/')
      return { path: rel, text: fs.read(`${uri}/${rel}`) }
    })
    const { data, prepared } = readBackupSkill(d, { uri, content: fs.read(`${uri}/SKILL.md`), files })
    if ((total += prepared.tree.bytes) > 256 * 1024) quota('Edge backup skill aggregate bytes exceeded.')
    const entries = fs.storedEntries(path), meta = JSON.parse(row.metadata)
    const { name, description, tags } = prepared.definition.report
    if (meta.name !== name || meta.description !== description || JSON.stringify(meta.tags) !== JSON.stringify(tags) ||
        !Array.isArray(meta.allowed_tools) || meta.allowed_tools.length || !isRecord(meta.metadata) || Object.keys(meta.metadata).length ||
        entries.length !== prepared.tree.nodes.length + 1 || manifest.length !== prepared.tree.nodes.length) incompatible()
    const byUri = new Map(entries.map(entry => [entry.uri, entry]))
    if (!byUri.get(uri)?.is_dir || byUri.get(uri)?.description !== description) incompatible()
    for (const node of prepared.tree.nodes) {
      const row = byUri.get(node.path.uri)
      if (!row || !!row.is_dir !== (node.content === undefined) || row.description || row.tags !== '[]' ||
          (node.content !== undefined && (row.bytes !== textSize(node.content) || fs.read(node.path.uri) !== node.content))) incompatible()
    }
    if (byUri.get(uri)?.tags !== '[]') incompatible()
    entries.forEach(entry => owned.add(entry.uri)); stamp.push(row.stamp)
    return data
  })
  return { list, owned, stamp, bytes: total }
}
