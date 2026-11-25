// SPDX-License-Identifier: AGPL-3.0-only
import { Settings, systemPatch } from '../control/settings.js'
import { isRecord } from '../http.js'
import type { Scope } from './backup-authority.js'
import { hasTable } from './backup-domain.js'
import { coldRequired, unsupported } from './instance-authority.js'

// A projection with a known consumer. Do not serialize model selection, raw
// startup configuration, providers, credentials or registry-owned user state.
function portable(value: unknown, scope: 'cluster' | 'account') {
  if (!isRecord(value) || Object.keys(value).some(k => !(['output_language_override', 'acl', 'agent_evolution'].includes(k)))) return unsupported()
  const normalized = systemPatch({}, value, scope, true)
  if (Object.keys(normalized).length !== Object.keys(value).length) return unsupported()
  return normalized
}

export function readInstanceSettings(input: unknown, scopes: Scope[]) {
  if (!isRecord(input) || Object.keys(input).length !== 2 || !Array.isArray(input.accounts) || input.accounts.length !== scopes.length) return unsupported()
  const cluster = portable(input.cluster, 'cluster')
  const accounts = scopes.map((scope, i) => {
    const row: unknown = (input.accounts as unknown[])[i]
    if (!isRecord(row) || Object.keys(row).length !== 2 || row.account_id !== scope.account) return unsupported()
    return { account_id: scope.account, settings: portable(row.settings, 'account') }
  })
  return { cluster, accounts }
}

export function captureInstanceSettings(sql: SqlStorage, scopes: Scope[]) {
  const store = new Settings(sql)
  // Unlike static deployment/model settings, custom templates are live
  // application state and cannot be represented by this profile.
  if (sql.exec('SELECT 1 FROM ov_control_templates LIMIT 1').toArray().length) return unsupported()
  return readInstanceSettings({ cluster: store.system(), accounts: scopes.map(s => ({ account_id: s.account, settings: store.system(s.account) })) }, scopes)
}

export function assertColdControl(sql: SqlStorage) {
  for (const table of ['ov_control_settings', 'ov_control_model_settings', 'ov_control_templates', 'ov_control_groups',
    'ov_control_memberships', 'ov_control_key_history', 'ov_control_gateway_index', 'ov_control_gateway_mount_workspaces',
    'ov_control_gateway_mount_pending', 'ov_control_data_account_pending', 'ov_control_data_member_fence']) {
    if (hasTable(sql, table) && sql.exec(`SELECT 1 FROM ${table} LIMIT 1`).toArray().length) coldRequired()
  }
}

export function publishInstanceSettings(sql: SqlStorage, config: ReturnType<typeof readInstanceSettings>) {
  const store = new Settings(sql)
  store.saveSystem('', config.cluster)
  for (const row of config.accounts) store.saveSystem(row.account_id, row.settings)
}
