// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { jobIsActive } from '../tasks.js'
import type { FsPath } from './contract.js'

type Kind = 'batch_index' | 'resource'
type Intent = { uri: string; space: string; task_id: string; kind: Kind; stamp: string; upload_id: string | null }
const columns = 'uri,space,task_id,kind,stamp,upload_id'

export function initPending(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_pending (
    account_id TEXT NOT NULL, space TEXT NOT NULL, uri TEXT NOT NULL,
    task_id TEXT NOT NULL, kind TEXT NOT NULL, stamp TEXT NOT NULL,
    user_id TEXT NOT NULL, agent_id TEXT NOT NULL, upload_id TEXT,
    PRIMARY KEY(account_id,space,uri)
  ) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_fs_pending_task ON ov_edge_fs_pending(account_id,task_id)')
  sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ov_edge_fs_pending_upload
    ON ov_edge_fs_pending(account_id,user_id,agent_id,upload_id) WHERE upload_id IS NOT NULL`)
}

const busy = () => new ApiError(409, 'RESOURCE_BUSY', 'An active filesystem operation has reserved this path or upload.')

export function assertPendingClear(ctx: WorkspaceContext, path: FsPath, subtree = false) {
  if (path.space === null) return
  const rows = ctx.sql.exec<Intent>(`SELECT ${columns} FROM ov_edge_fs_pending WHERE account_id=? AND space=? AND (
    uri=? OR instr(?,uri||'/')=1 ${subtree ? "OR instr(uri,?||'/')=1" : ''})`, ctx.caller.accountId, path.space,
  path.uri, path.uri, ...(subtree ? [path.uri] : [])).toArray()
  for (const row of rows) if (row.task_id !== ctx.taskId && jobIsActive(ctx.sql, row.task_id)) throw busy()
}

export function assertUploadFree(ctx: WorkspaceContext, uploadId: string) {
  const { accountId, userId, agentId } = ctx.caller
  const row = ctx.sql.exec<Intent>(`SELECT ${columns} FROM ov_edge_fs_pending WHERE account_id=? AND user_id=? AND agent_id=? AND upload_id=?`,
    accountId, userId, agentId, uploadId).toArray()[0]
  if (row && row.task_id !== ctx.taskId && jobIsActive(ctx.sql, row.task_id)) throw busy()
}

export function reserve(ctx: WorkspaceContext, taskId: string, path: FsPath & { space: string }, kind: Kind, stamp: string,
  options: { uploadId?: string; subtree?: boolean } = {}) {
  const { accountId, userId, agentId } = ctx.caller
  assertPendingClear(ctx, path, options.subtree)
  if (options.uploadId) assertUploadFree(ctx, options.uploadId)
  // Cleanup at admission only. Cancelled or terminal task rows never block new work.
  const old = ctx.sql.exec<{ task_id: string }>('SELECT DISTINCT task_id FROM ov_edge_fs_pending WHERE account_id=?', accountId).toArray()
  for (const row of old) if (!jobIsActive(ctx.sql, row.task_id)) release(ctx, row.task_id)
  ctx.sql.exec(`INSERT INTO ov_edge_fs_pending(account_id,space,uri,task_id,kind,stamp,user_id,agent_id,upload_id)
    VALUES(?,?,?,?,?,?,?,?,?)`, accountId, path.space, path.uri, taskId, kind, stamp, userId, agentId, options.uploadId ?? null)
}

export function release(ctx: WorkspaceContext, taskId: string) {
  ctx.sql.exec('DELETE FROM ov_edge_fs_pending WHERE account_id=? AND task_id=?', ctx.caller.accountId, taskId)
}

export function pendingFor(ctx: WorkspaceContext, kind: Kind): Intent[] {
  const { accountId, userId, agentId } = ctx.caller
  return ctx.sql.exec<Intent>(`SELECT ${columns} FROM ov_edge_fs_pending WHERE account_id=? AND task_id=? AND kind=?
    AND user_id=? AND agent_id=? ORDER BY uri`, accountId, ctx.taskId ?? '', kind, userId, agentId).toArray()
}
