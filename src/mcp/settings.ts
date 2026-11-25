// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { Filesystem } from '../filesystem.js'
import { ApiError, ok, readJson } from '../http.js'
import { invalid, onlyKeys, pathFor, quota, resourcePath, str } from '../fs/contract.js'

const route = '/api/v1/user-settings/add-locations'
type Settings = { resource_uri: string | null; skill_uri: string | null }

export function initAddLocations({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_user_add_settings (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, resource_uri TEXT, skill_uri TEXT,
    PRIMARY KEY (account_id,user_id)
  ) WITHOUT ROWID`)
}

export function addLocations({ caller, sql }: WorkspaceContext): Settings {
  return sql.exec<Settings>('SELECT resource_uri,skill_uri FROM ov_edge_user_add_settings WHERE account_id=? AND user_id=?',
    caller.accountId, caller.userId).toArray()[0] ?? { resource_uri: null, skill_uri: null }
}

/** A validated write in the caller's existing transaction. */
export function writeAddLocations(ctx: WorkspaceContext, before: Settings, { resource_uri, skill_uri }: Settings): void {
  const { accountId, userId } = ctx.caller
  if (resource_uri === null && skill_uri === null) {
    ctx.sql.exec('DELETE FROM ov_edge_user_add_settings WHERE account_id=? AND user_id=?', accountId, userId)
    return
  }
  if (before.resource_uri === null && before.skill_uri === null &&
      ctx.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_edge_user_add_settings WHERE account_id=?', accountId).one().n >= 1024) {
    quota('User add location quota reached for this account.')
  }
  ctx.sql.exec(`INSERT INTO ov_edge_user_add_settings(account_id,user_id,resource_uri,skill_uri) VALUES (?,?,?,?)
    ON CONFLICT(account_id,user_id) DO UPDATE SET resource_uri=excluded.resource_uri,skill_uri=excluded.skill_uri`, accountId, userId, resource_uri, skill_uri)
}

export function skillTarget(ctx: WorkspaceContext, raw: unknown): string {
  const { caller } = ctx
  const path = pathFor(raw, caller)
  if (path.uri !== `viking://user/${caller.userId}/skills` && path.uri !== 'viking://agent/skills') {
    invalid('skill_uri must be the caller’s private or the account-shared skill root.')
  }
  if (path.uri === 'viking://agent/skills' && caller.role !== 'admin') {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Only an account admin may install into the shared skill root.')
  }
  return path.uri
}

export async function routeAddLocations(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  if (url.pathname !== route) return
  const respond = () => {
    const { resource_uri, skill_uri } = addLocations(ctx)
    const value = { ...(resource_uri !== null && { resource_uri }), ...(skill_uri !== null && { skill_uri }) }
    return ok({ override: value, effective: value })
  }
  if (request.method === 'GET' || request.method === 'HEAD') return respond()
  if (request.method !== 'PATCH' && request.method !== 'DELETE') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET, PATCH, or DELETE.')
  const patch = request.method === 'DELETE' ? { resource_uri: null, skill_uri: null } : await readJson(request, 8192)
  onlyKeys(patch, 'resource_uri skill_uri')
  if (!Object.keys(patch).length) return respond()
  await ctx.reauthorize?.()
  ctx.storage.transactionSync(() => {
    ctx.assertActive?.()
    const before = addLocations(ctx)
    let resource = before.resource_uri
    if (patch.resource_uri !== undefined) {
      if (patch.resource_uri === null) resource = null
      else {
        const path = pathFor(str(patch.resource_uri, 'resource_uri').trim(), ctx.caller)
        resourcePath(path, true)
        const fs = new Filesystem(ctx)
        if (!fs.require(path, 'write').is_dir) invalid('resource_uri must identify an existing writable resource directory.')
        resource = path.uri
      }
    }
    const skill = patch.skill_uri === undefined ? before.skill_uri : patch.skill_uri === null ? null :
      skillTarget(ctx, str(patch.skill_uri, 'skill_uri').trim())
    writeAddLocations(ctx, before, { resource_uri: resource, skill_uri: skill })
  })
  return respond()
}
