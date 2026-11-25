// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, isRecord } from './http.js'
import { isId, LIMIT } from './control/input.js'

export const validRevision = (revision: unknown): revision is number => Number.isSafeInteger(revision) && (revision as number) >= 0
export const dataAuthorityUnavailable = () => new ApiError(503, 'AUTH_UNAVAILABLE', 'Could not verify current Data authority.')
export const dataAuthorityChanged = () => new ApiError(403, 'PERMISSION_DENIED', 'Data authority changed during this operation; submit it again with a current key.')

export type AuthorityRevision = Readonly<{ account: number; member: number }>
export type AuthorityAdvance = { scope: 'account'; revision: number } | { scope: 'members'; floors: ReadonlyArray<readonly [string, number]> }
type DataDirectory = { groups: string[]; principals: { users: string[]; groups: string[] } }
export type DataAuthorityGrant = ({ status: 'ok'; revision: AuthorityRevision } & DataDirectory) | { status: 'expired' | 'changed' }
export type DataAuthority = { readonly revision: AuthorityRevision; assertCurrent: () => void }

export const isAuthorityRevision = (value: unknown): value is AuthorityRevision =>
  isRecord(value) && Object.keys(value).length === 2 && validRevision(value.account) && validRevision(value.member)
export const sameAuthority = (a: AuthorityRevision, b: AuthorityRevision): boolean =>
  a.account === b.account && a.member === b.member

/** F2 plans recorded only the account epoch. They cannot outlive that epoch
 * or a subsequent member barrier. Earlier unversioned plans stay closed. */
export function storedAuthority(value: unknown): AuthorityRevision | undefined {
  if (validRevision(value)) return { account: value, member: 0 }
  if (isAuthorityRevision(value)) return value
}

// Keep the existing on-disk B2/B3 table: its credential revision is already
// independent of model configuration. A restart must never reset its floor.
export function initDataAuthorityFence(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_credential_fence (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)
  );
  CREATE TABLE IF NOT EXISTS ov_edge_data_member_fence (
    user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0)
  ) WITHOUT ROWID`)
}

export function authorityIsStale(sql: SqlStorage, user: string, revision: AuthorityRevision): boolean {
  return sql.exec<{ stale: number }>(`SELECT EXISTS(SELECT 1 FROM ov_gateway_credential_fence WHERE id=1 AND revision>?)
    OR EXISTS(SELECT 1 FROM ov_edge_data_member_fence WHERE user_id=? AND revision>?) AS stale`,
    revision.account, user, revision.member).one().stale === 1
}

export function authorityReceipt(change: AuthorityAdvance): string {
  return change.scope === 'account' ? `account:${change.revision}` : `members:${JSON.stringify(change.floors)}`
}

/** Only the private Control binding advances floors. All affected members in
 * a group edit move in the same Workspace transaction as each other. */
export function fenceDataAuthority(sql: SqlStorage, change: AuthorityAdvance): string {
  if (change?.scope === 'account' && validRevision(change.revision) && change.revision > 0) {
    sql.exec(`INSERT INTO ov_gateway_credential_fence (id,revision) VALUES (1,?)
      ON CONFLICT(id) DO UPDATE SET revision=max(revision,excluded.revision)`, change.revision)
    return authorityReceipt(change)
  }
  if (change?.scope !== 'members' || !Array.isArray(change.floors) || !change.floors.length || change.floors.length > LIMIT.members ||
      !change.floors.every((entry, i) => Array.isArray(entry) && entry.length === 2 && isId(entry[0]) &&
        validRevision(entry[1]) && entry[1] > 0 && (i === 0 || change.floors[i - 1][0] < entry[0]))) throw dataAuthorityUnavailable()
  sql.exec(`INSERT INTO ov_edge_data_member_fence (user_id,revision)
    SELECT json_extract(value, '$[0]'),json_extract(value, '$[1]') FROM json_each(?) WHERE true
    ON CONFLICT(user_id) DO UPDATE SET revision=max(revision,excluded.revision)`, JSON.stringify(change.floors))
  return authorityReceipt(change)
}

export async function mountDataAuthority(ctx: WorkspaceContext, expected?: AuthorityRevision): Promise<DataAuthority> {
  if (!ctx.loadDataAuthority) throw dataAuthorityUnavailable()
  if (ctx.dataAuthority) {
    if (expected && !sameAuthority(expected, ctx.dataAuthority.revision)) throw dataAuthorityChanged()
    ctx.dataAuthority.assertCurrent()
    return ctx.dataAuthority
  }
  const load = ctx.loadDataAuthority
  const user = ctx.caller.userId
  const snapshot = (current: DataAuthorityGrant, revision?: AuthorityRevision) => {
    if (current.status !== 'ok') throw dataAuthorityChanged()
    if (!isAuthorityRevision(current.revision)) throw dataAuthorityUnavailable()
    if ((revision && !sameAuthority(current.revision, revision)) || authorityIsStale(ctx.sql, user, current.revision)) throw dataAuthorityChanged()
    ctx.groups = current.groups
    ctx.aclPrincipals = current.principals
    return current.revision
  }
  const revision = snapshot(await load(expected), expected)
  const priorGuard = ctx.assertActive
  const assertCurrent = () => {
    if (authorityIsStale(ctx.sql, user, revision)) throw dataAuthorityChanged()
    priorGuard?.()
  }
  ctx.dataAuthority = { revision, assertCurrent }
  ctx.assertActive = assertCurrent
  ctx.reauthorize = async () => {
    assertCurrent()
    snapshot(await load(revision), revision)
    assertCurrent()
  }
  assertCurrent()
  return ctx.dataAuthority
}
