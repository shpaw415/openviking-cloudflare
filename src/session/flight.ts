// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError } from '../http.js'
import { timeout } from './generation.js'

export const ownerWhere = 'account_id = ? AND user_id = ? AND agent_id = ?'
export const sessionWhere = `${ownerWhere} AND session_id = ?`
export const sessionColumns = 'account_id,user_id,agent_id,session_id'
export const sessionForeignKey = `FOREIGN KEY (${sessionColumns}) REFERENCES ov_sessions (${sessionColumns}) ON DELETE CASCADE`
export type Owner = [accountId: string, userId: string, agentId: string]
export type SessionKey = [...Owner, sessionId: string]
export const ownerFor = ({ caller }: WorkspaceContext): Owner => [caller.accountId, caller.userId, caller.agentId]
export const keyFor = (ctx: WorkspaceContext, id: string): SessionKey => [...ownerFor(ctx), id]

type Flight = { token: string, epoch: string, kind: 'archive' | 'bot', deadline: number }
const epochs = new WeakMap<DurableObjectStorage, string>()
function epoch(storage: DurableObjectStorage): string {
  let value = epochs.get(storage)
  if (!value) { value = crypto.randomUUID(); epochs.set(storage, value) }
  return value
}

export function initFlights({ sql }: WorkspaceContext): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_flights (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    token TEXT NOT NULL, epoch TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('archive','bot')), deadline INTEGER NOT NULL,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID`)
}

export function currentFlight(ctx: WorkspaceContext, key: SessionKey): Flight | undefined {
  return ctx.sql.exec<Flight>(`SELECT token,epoch,kind,deadline FROM ov_session_flights
    WHERE ${sessionWhere} AND epoch=? AND deadline>?`, ...key, epoch(ctx.storage), Date.now()).toArray()[0]
}

export function assertIdle(ctx: WorkspaceContext, key: SessionKey): void {
  if (currentFlight(ctx, key)) throw new ApiError(409, 'CONFLICT', 'A turn or archive operation is active in this session.')
}

// Called in the same synchronous transaction as the input/rotation write.
export function acquire(ctx: WorkspaceContext, key: SessionKey, kind: Flight['kind']): Flight {
  assertIdle(ctx, key)
  const instance = epoch(ctx.storage), now = Date.now()
  const count = ctx.sql.exec<{ account: number, user: number }>(`SELECT count(*) AS account,
    count(*) FILTER (WHERE user_id=?) AS user FROM ov_session_flights WHERE account_id=? AND epoch=? AND deadline>?`,
  key[1], key[0], instance, now).one()
  if (count.account >= 8 || count.user >= 2) throw new ApiError(429, 'RATE_LIMITED', 'Too many concurrent generation operations.')
  const flight = { token: crypto.randomUUID(), epoch: instance, kind, deadline: now + 50_000 }
  ctx.sql.exec(`INSERT INTO ov_session_flights (${sessionColumns},token,epoch,kind,deadline) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT (${sessionColumns}) DO UPDATE SET token=excluded.token, epoch=excluded.epoch,
      kind=excluded.kind, deadline=excluded.deadline`, ...key, flight.token, flight.epoch, kind, flight.deadline)
  return flight
}

export function assertFlight(ctx: WorkspaceContext, key: SessionKey, flight: Flight): void {
  if (Date.now() >= flight.deadline) throw timeout()
  if (currentFlight(ctx, key)?.token !== flight.token) throw new ApiError(409, 'CONFLICT', 'This operation no longer owns the session.')
}

// A timed-out request may record its own failure, but never change a successor's state.
export function release(ctx: WorkspaceContext, key: SessionKey, flight: Pick<Flight, 'token'>): boolean {
  return ctx.sql.exec(`DELETE FROM ov_session_flights WHERE ${sessionWhere} AND token=?`, ...key, flight.token).rowsWritten === 1
}
