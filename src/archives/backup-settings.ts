// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { ROOT, invalid, onlyKeys } from '../fs/contract.js'
import { skillTarget, writeAddLocations } from '../mcp/settings.js'
import { quota } from './common.js'
import { portablePath, topology } from './backup-codec.js'
import { hasTable, privateURI, type Domain } from './backup-domain.js'

export type BackupSettings = { uri: string; resource_uri: string | null; skill_uri: string | null }
export function readBackupSettings(d: Domain, value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 3) invalid('Invalid Edge user settings record.')
  onlyKeys(value, 'uri resource_uri skill_uri')
  const { uri, owner } = privateURI(d, value.uri), { resource_uri, skill_uri } = value
  const fs = d.fs(owner)
  if (resource_uri !== null && (typeof resource_uri !== 'string' ||
      (resource_uri !== `${uri}/resources` && !resource_uri.startsWith(`${uri}/resources/`)))) {
    return topology('Only private resource add locations are representable in an Edge backup.')
  }
  if (skill_uri !== null && skill_uri !== `${uri}/skills`) return topology('Only the private skill add location is representable.')
  if (resource_uri !== null) portablePath(resource_uri.slice(ROOT.length), true)
  if (skill_uri !== null) skillTarget(fs.ctx, skill_uri)
  if (resource_uri === null && skill_uri === null) invalid('Empty settings are not backup records.')
  const data: BackupSettings = { uri, resource_uri, skill_uri }
  return { data, publish: (before: BackupSettings | undefined) => {
    if (data.resource_uri !== null && !fs.require(fs.path(data.resource_uri), 'write').is_dir) invalid('Restored add location must be a directory.')
    writeAddLocations(fs.ctx, before ?? { resource_uri: null, skill_uri: null }, data)
  } }
}

export function captureSettings(d: Domain): BackupSettings[] {
  if (!hasTable(d.sql, 'ov_edge_user_add_settings')) return []
  const rows = d.sql.exec<{ user_id: string; resource_uri: string | null; skill_uri: string | null }>(`SELECT user_id,resource_uri,skill_uri
    FROM ov_edge_user_add_settings WHERE account_id=? ORDER BY user_id LIMIT 33`, d.scope.account).toArray()
  if (rows.length > 32) quota('Edge user settings limit exceeded.')
  return rows.map(({ user_id, resource_uri, skill_uri }) => {
    const { data } = readBackupSettings(d, { uri: `${ROOT}user/${user_id}`, resource_uri, skill_uri })
    if (resource_uri !== null) {
      const fs = d.fs(user_id)
      if (!fs.entry(fs.path(resource_uri), 'write')?.is_dir) topology('A private add location no longer resolves to a directory.')
    }
    return data
  })
}
