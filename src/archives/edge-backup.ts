// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { invalid, onlyKeys, ROOT } from '../fs/contract.js'
import { skillRow } from '../fs/skill-store.js'
import { initAddLocations } from '../mcp/settings.js'
import { restoreSessionHistory } from '../session/store.js'
import { initSessions } from '../sessions.js'
import { prepareBackupSkill } from '../skills.js'
import { decodeBackup, strictJson, type BackupEntry } from './backup-codec.js'
import { hasTable, type Domain } from './backup-domain.js'
import { captureSessions, readBackupSession, HISTORY_CAP, SESSION_BYTES, SESSION_CAP } from './backup-sessions.js'
import { captureSettings, readBackupSettings } from './backup-settings.js'
import { captureSkills, readBackupSkill, SKILL_CAP } from './backup-skills.js'
import { decoder, digest, encoder, fail, quota } from './common.js'
import { inspectZip, memberBytes, storedZip, ZIP_BYTES } from './zip.js'

export const edgeFilename = 'openviking-edge-backup.zip'
const kind = 'openviking.edge-backup', domainLimit = 384 * 1024
const paths = ['content.ovpack', 'domains.json'] as const
const domainsFor = (live: ReturnType<typeof captureDomains>) => ({ sessions: live.sessions, skills: live.skills.list, settings: live.settings })
type SessionData = ReturnType<typeof readBackupSession>['data']

function checkSessionCapacity(sessions: SessionData[]) {
  const messages = sessions.flatMap(item => [...item.messages, ...item.archives.flatMap(group => group.messages)])
  if (sessions.length > SESSION_CAP || messages.length > HISTORY_CAP ||
      encoder.encode(messages.map(message => JSON.stringify(message) + '\n').join('')).byteLength > SESSION_BYTES) {
    quota('Edge backup session capacity exceeded.')
  }
}

function checkSkillCapacity(count: number, bytes: number) {
  if (count > SKILL_CAP || bytes > 256 * 1024) quota('Edge backup skill capacity exceeded.')
}

export function captureDomains(d: Domain) {
  const sessions = captureSessions(d), skills = captureSkills(d), settings = captureSettings(d)
  return { sessions, skills, settings }
}

export async function encodeEdge(content: Uint8Array<ArrayBuffer>, live: ReturnType<typeof captureDomains>) {
  const domains = encoder.encode(JSON.stringify(domainsFor(live)))
  if (domains.length > domainLimit) quota('Edge backup domains exceed their aggregate cap.')
  const files = [{ name: paths[0], bytes: content }, { name: paths[1], bytes: domains }]
  const entries = await Promise.all(files.map(async f => ({ path: f.name, size: f.bytes.length, sha256: await digest(f.bytes) })))
  return storedZip([...files, { name: 'manifest.json', bytes: encoder.encode(JSON.stringify({ kind, format_version: 1, entries })) }])
}

function json(bytes: Uint8Array, depth?: number): unknown {
  let text: string
  try { text = decoder.decode(bytes) } catch { return invalid('Edge metadata must be UTF-8.') }
  return strictJson(text, depth)
}

export async function decodeEdge(d: Domain, zip: Uint8Array<ArrayBuffer>) {
  const members = inspectZip(zip), manifest = members.get('manifest.json')
  if (members.size !== 3 || !manifest) invalid('Expected an Edge backup v1 ZIP, not an OVPack.')
  const meta = json(await memberBytes(manifest, 2048))
  if (!isRecord(meta) || meta.kind !== kind || meta.format_version !== 1 || !Array.isArray(meta.entries) || meta.entries.length !== 2) {
    invalid('Expected an Edge backup v1 manifest.')
  }
  onlyKeys(meta, 'kind format_version entries')
  const descriptors = meta.entries
  const [content, domains] = await Promise.all(paths.map(async (path, i) => {
    const item: unknown = descriptors[i], entry = members.get(path)
    if (!isRecord(item) || !entry || item.path !== path || item.size !== entry.size) invalid('Edge backup member inventory does not match.')
    onlyKeys(item, 'path size sha256')
    const bytes = await memberBytes(entry, i ? domainLimit : ZIP_BYTES)
    if (await digest(bytes) !== item.sha256) invalid('Edge backup member digest does not match.')
    return bytes
  }))
  const data = json(domains, 12)
  if (!isRecord(data) || !Array.isArray(data.sessions) || !Array.isArray(data.skills) || !Array.isArray(data.settings)) invalid('Missing Edge backup domains.')
  onlyKeys(data, 'sessions skills settings')
  if (data.sessions.length > SESSION_CAP || data.skills.length > SKILL_CAP || data.settings.length > 32) quota('Edge backup domain count limit exceeded.')
  const entries = await decodeBackup(content)
  const sessions = data.sessions.map(value => readBackupSession(d, value))
  const skills = data.skills.map(value => readBackupSkill(d, value))
  const settings = data.settings.map(value => readBackupSettings(d, value))
  for (const records of [sessions, skills, settings]) if (new Set(records.map(record => record.data.uri)).size !== records.length) invalid('Duplicate Edge domain record.')
  checkSessionCapacity(sessions.map(item => item.data))
  checkSkillCapacity(skills.length, skills.reduce((total, item) => total + item.prepared.tree.bytes, 0))
  const directories = new Set(entries.filter(entry => entry.directory).map(entry => ROOT + entry.path))
  for (const { data: { resource_uri } } of settings) if (resource_uri !== null && !directories.has(resource_uri)) invalid('Edge settings refer to a directory not in the backup.')
  return { entries, sessions, settings, skills: await Promise.all(skills.map(async item => ({ ...item, ready: await prepareBackupSkill(item.fs, item.prepared) }))) }
}

function diff<T extends { uri: string }>(old: T[], want: { data: T }[], code?: string) {
  const byUri = new Map(old.map(item => [item.uri, item]))
  return want.map(item => {
    const before = byUri.get(item.data.uri)
    if (before && JSON.stringify(item.data) === JSON.stringify(before)) return null
    if (before && code) fail(409, code, 'A pre-existing private record differs from the backup. No changes were applied.')
    return before
  })
}

export function planDomains(d: Domain, incoming: Awaited<ReturnType<typeof decodeEdge>>, live: ReturnType<typeof captureDomains>, skip: boolean) {
  const sessionDiff = skip ? [] : diff(live.sessions, incoming.sessions, 'BACKUP_SESSION_CONFLICT')
  const skillDiff = skip ? [] : diff(live.skills.list, incoming.skills, 'BACKUP_SKILL_CONFLICT')
  const settingDiff = skip ? [] : diff(live.settings, incoming.settings)
  const sessions = incoming.sessions.filter((_, i) => i < sessionDiff.length && sessionDiff[i] !== null)
  const skills = incoming.skills.filter((_, i) => i < skillDiff.length && skillDiff[i] !== null)
  const settings = incoming.settings.flatMap((item, i) => i < settingDiff.length && settingDiff[i] !== null ? [{ item, before: settingDiff[i] }] : [])
  for (const skill of skills) if (hasTable(d.sql, 'ov_edge_fs_skill') && skillRow(skill.fs, skill.ready.path)) {
    fail(409, 'BACKUP_SKILL_CONFLICT', 'The skill URI already has a destination history.')
  }
  const allSessions = [...live.sessions, ...sessions.map(item => item.data)]
  checkSessionCapacity(allSessions)
  checkSkillCapacity(live.skills.list.length + skills.length,
    live.skills.bytes + skills.reduce((total, item) => total + item.ready.tree.bytes, 0))
  const settingValues = new Map(live.settings.map(item => [item.uri, item]))
  for (const { item } of settings) settingValues.set(item.data.uri, item.data)
  if (encoder.encode(JSON.stringify({ sessions: allSessions, skills: [...live.skills.list, ...skills.map(item => item.data)],
    settings: [...settingValues.values()] })).byteLength > domainLimit) quota('Merged Edge backup exceeds its domain byte cap.')
  const counts = { sessions: sessions.length, skills: skills.length, settings: settings.length }
  const growth = skills.map(({ fs, ready }) => ({ fs, space: ready.path.space, nodes: ready.tree.nodes.length + 1, bytes: ready.tree.bytes }))
  return { counts, growth, changed: !!(counts.sessions + counts.skills + counts.settings),
    stamp: JSON.stringify([domainsFor(live), live.skills.stamp]), publish: () => {
      if (sessions.length && !hasTable(d.sql, 'ov_sessions')) initSessions(d.fs().ctx)
      if (settings.length && !hasTable(d.sql, 'ov_edge_user_add_settings')) initAddLocations(d.fs().ctx)
      for (const item of sessions) restoreSessionHistory(d.sql, item.key, item.restore)
      for (const item of skills) item.ready.publish()
      for (const { item, before } of settings) item.publish(before)
    } }
}
