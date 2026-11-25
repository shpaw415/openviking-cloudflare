// SPDX-License-Identifier: AGPL-3.0-only
import { GatewayError } from './contract.js'
import { authorityIsStale, isAuthorityRevision, validRevision } from '../data-authority.js'
import type { AuthorityRevision } from '../data-authority.js'
export { validRevision } from '../data-authority.js'

export const modelChanged = () => new GatewayError(409, 'gateway_configuration_changed',
  'The Gateway model configuration changed or is being updated; start a new request.')
export const modelAuthorityUnavailable = () => new GatewayError(503, 'authorization_unavailable',
  'Could not verify the Gateway model configuration.')
export const credentialChanged = () => new GatewayError(401, 'openviking_key_invalid',
  'The Gateway authorization changed during this request; start a new request with an active credential.')

export function initModelFence(sql: SqlStorage): void {
  // One bound tenant per Workspace actor. No clock or in-memory invalidation is
  // authoritative: a restart must still reject a snapshot below this floor.
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_model_fence (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)
  )`)
}

export function assertModelRevision(sql: SqlStorage, revision: number): void {
  if (!validRevision(revision)) throw modelAuthorityUnavailable()
  const floor = sql.exec<{ revision: number }>('SELECT revision FROM ov_gateway_model_fence WHERE id=1').toArray()[0]?.revision ?? 0
  if (revision < floor) throw modelChanged()
}

export function fenceModelRevision(sql: SqlStorage, revision: number): void {
  if (!validRevision(revision) || revision === 0) throw modelAuthorityUnavailable()
  sql.exec(`INSERT INTO ov_gateway_model_fence (id,revision) VALUES (1,?)
    ON CONFLICT(id) DO UPDATE SET revision=max(revision,excluded.revision)`, revision)
}

export function assertCredentialRevision(sql: SqlStorage, user: string, revision: AuthorityRevision): void {
  if (!isAuthorityRevision(revision)) throw modelAuthorityUnavailable()
  if (authorityIsStale(sql, user, revision)) throw credentialChanged()
}
