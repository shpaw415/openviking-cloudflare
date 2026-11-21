// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMessage, WorkspaceContext } from '../context.js'
import { GatewayError, bytes, invalid, maxInputBytes, maxMessages } from './contract.js'
import type { Target } from './providers.js'

const age = 86_400_000
const scope = 'account_id=? AND user_id=? AND agent_id=?'
const owner = (ctx: WorkspaceContext) => [ctx.caller.accountId, ctx.caller.userId, ctx.caller.agentId] as const
const unknownResponse = () => new GatewayError(404, 'response_unknown', 'The response was not found or is no longer retained.')
const limited = () => new GatewayError(429, 'response_storage_limit', 'Delete stored responses or retry after retention expiry.')
export const responseId = (value: unknown): value is string => typeof value === 'string' && /^resp_[a-f0-9]{32}$/.test(value)

export function initResponses(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_gateway_responses (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    id TEXT NOT NULL, created_at INTEGER NOT NULL, route TEXT NOT NULL,
    history TEXT NOT NULL, response TEXT NOT NULL, bytes INTEGER NOT NULL,
    PRIMARY KEY (account_id,user_id,agent_id,id)
  ) WITHOUT ROWID`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_gateway_responses_expiry ON ov_gateway_responses(account_id,created_at)')
}

type Stored = { id: string; created_at: number; route: string; history: string; response: string }
function load(ctx: WorkspaceContext, id: string): Stored {
  const row = ctx.sql.exec<Stored>(`SELECT id,created_at,route,history,response FROM ov_gateway_responses
    WHERE ${scope} AND id=? AND created_at>?`, ...owner(ctx), id, Date.now() - age).toArray()[0]
  if (!row) throw unknownResponse()
  return row
}

export function inspectResponse(ctx: WorkspaceContext, id: string): unknown { return JSON.parse(load(ctx, id).response) }

export function forgetResponse(ctx: WorkspaceContext, id: string): { id: string; object: 'response.deleted'; deleted: true } {
  if (!ctx.sql.exec(`DELETE FROM ov_gateway_responses WHERE ${scope} AND id=? AND created_at>?`, ...owner(ctx), id, Date.now() - age).rowsWritten) {
    throw unknownResponse()
  }
  return { id, object: 'response.deleted', deleted: true }
}

const routeIdentity = (target: Target) => JSON.stringify([target.rule.id, target.rule.binding, target.model])

export function resume(ctx: WorkspaceContext, id: string, target: Target, current: ModelMessage[]) {
  const previous = load(ctx, id), route = routeIdentity(target)
  if (previous.route !== route) throw new GatewayError(403, 'response_upstream_disallowed', 'The previous response belongs to another model route.')
  const history = JSON.parse(previous.history) as ModelMessage[]
  // The previous request's instructions are not inherited by this response.
  const instructions = current.filter(message => message.role === 'system')
  const messages = [...instructions, ...history, ...current.filter(message => message.role !== 'system')]
  const inputBytes = messages.reduce((size, message) => size + bytes(message.content), 0)
  if (messages.length > maxMessages || inputBytes > maxInputBytes) {
    throw new GatewayError(413, 'body_too_large', 'The resumed history exceeds Gateway limits; start a new response.')
  }
  return { messages, inputBytes, guard: () => {
    if (!ctx.sql.exec(`SELECT 1 FROM ov_gateway_responses WHERE ${scope} AND id=? AND created_at>?`, ...owner(ctx), id, Date.now() - age).toArray().length) {
      throw unknownResponse()
    }
  } }
}

export function checkResponseQuota(ctx: WorkspaceContext, addBytes = 0): void {
  const [a, u, agent] = owner(ctx), filter = 'user_id=? AND agent_id=?'
  const { n, b, user_n, user_b, actor_n, actor_b } = ctx.sql.exec<{ n: number; b: number; user_n: number; user_b: number; actor_n: number; actor_b: number }>(
    `SELECT count(*) n, COALESCE(sum(bytes),0) b, count(*) FILTER(WHERE user_id=?) user_n,
      COALESCE(sum(bytes) FILTER(WHERE user_id=?),0) user_b, count(*) FILTER(WHERE ${filter}) actor_n,
      COALESCE(sum(bytes) FILTER(WHERE ${filter}),0) actor_b
    FROM ov_gateway_responses WHERE account_id=? AND created_at>?`, u, u, u, agent, u, agent, a, Date.now() - age).one()
  if (n >= 128 || user_n >= 32 || actor_n >= 16 || b + addBytes > 4 * 1024 * 1024 ||
      user_b + addBytes > 1024 * 1024 || actor_b + addBytes > 512 * 1024 || addBytes > 256 * 1024) throw limited()
}

export function retainResponse(ctx: WorkspaceContext, target: Target, id: string, messages: ModelMessage[], answer: string, wire: unknown, guard: () => void): void {
  if (!responseId(id) || !wire || typeof wire !== 'object') throw invalid('Invalid response retention state.')
  const history = JSON.stringify([...messages.filter(message => message.role !== 'system'), { role: 'assistant', content: answer }])
  const response = JSON.stringify(wire)
  const size = bytes(history) + bytes(response)
  ctx.storage.transactionSync(() => {
    guard()
    checkResponseQuota(ctx, size)
    const now = Date.now()
    ctx.sql.exec('DELETE FROM ov_gateway_responses WHERE account_id=? AND created_at<=?', ctx.caller.accountId, now - age)
    ctx.sql.exec('INSERT INTO ov_gateway_responses VALUES (?,?,?,?,?,?,?, ?,?)', ...owner(ctx), id, now,
      routeIdentity(target), history, response, size)
  })
}
