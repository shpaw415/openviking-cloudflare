// SPDX-License-Identifier: AGPL-3.0-only
import { invalid, unsupported } from './protocol.js'
import type { StoredMessage } from './protocol.js'
import { sessionColumns, sessionForeignKey, sessionWhere } from './flight.js'
import type { SessionKey } from './flight.js'

export type Retention = { retention_mode: 'turn_budget'; keep_recent_turn_count: number; retained_message_token_budget: number; min_raw_tail_steps: number }
export function initRetention(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_retention (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,
    config TEXT NOT NULL, PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}) WITHOUT ROWID`)
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_session_checkpoints (
    account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,session_id TEXT NOT NULL,
    archive_no INTEGER NOT NULL,anchor TEXT NOT NULL,tokens INTEGER NOT NULL,tail_start INTEGER NOT NULL,
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}) WITHOUT ROWID`)
}

export function retentionOptions(body: Record<string, unknown>, enabled: boolean): Retention | undefined {
  const turnFields = ['keep_recent_turn_count','retained_message_token_budget','min_raw_tail_steps']
  if (body.retention_mode == null && turnFields.every(key => body[key] == null)) return
  if (!enabled) unsupported('Turn-budget retention is not mounted.')
  if (body.retention_mode !== 'turn_budget' || (body.keep_recent_count != null && body.keep_recent_count !== 0)) invalid('Use turn_budget without a nonzero message-count window.')
  const number = (key:string, fallback:number, min:number, max:number) => {
    const n = body[key] ?? fallback
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) invalid(`Invalid ${key}.`)
    return n
  }
  const window = body.session_window_context == null ? undefined : number('session_window_context',2048,1,1_000_000)
  const ratio = commitRatio(body.retained_token_ratio,'retained_token_ratio')
  if (ratio !== undefined && window === undefined) invalid('retained_token_ratio requires session_window_context.')
  return { retention_mode:'turn_budget', keep_recent_turn_count:number(turnFields[0], 3, 0, 10_000),
    retained_message_token_budget:number(turnFields[1], ratio === undefined ? 2048 : Math.max(1,Math.floor(window!*ratio)), 1, 1_000_000),
    min_raw_tail_steps:number(turnFields[2], 1, 0, 10_000) }
}

export function commitRatio(value:unknown,key:string):number|undefined {
  if (value==null) return
  if (typeof value!=='number' || !Number.isFinite(value) || value<=0 || value>1) invalid(`Invalid ${key}; expected a ratio in (0,1].`)
  return value
}
type Raw = {seq:number;payload:string;tokens:number}
type Checkpoint = {payload:string;tokens:number;tailStart:number}
export function planRetention(sql: SqlStorage, key: SessionKey, options: Retention): {keep:number;checkpoint?:Checkpoint} {
  if (!options.keep_recent_turn_count) return {keep:0}
  const groups: { rows:Raw[]; tokens:number; anchor:Raw|undefined }[] = []
  for (const row of sql.exec<Raw>(`SELECT seq,payload,tokens FROM ov_session_messages
    WHERE ${sessionWhere} AND archive_no IS NULL ORDER BY seq`, ...key)) {
    const message: StoredMessage = JSON.parse(row.payload)
    const anchor = message.role === 'user' && message.parts.some(p => p.type === 'text' || p.type === 'image_url') &&
      !message.parts.some(p => p.type === 'tool')
    if (anchor || !groups.length) groups.push({ rows:[], tokens:0, anchor:anchor?row:undefined })
    const group = groups.at(-1)!
    group.rows.push(row)
    group.tokens += row.tokens
  }
  let keep = 0, remaining = options.retained_message_token_budget
  for (let i=groups.length-1, turns=0; i>=0 && turns<options.keep_recent_turn_count; i--,turns++) {
    const group = groups[i]
    if (group.tokens > remaining) {
      if (!keep && group.anchor) {
        const steps:Raw[][]=[]
        for (const row of group.rows.slice(1)) {
          const msg:StoredMessage=JSON.parse(row.payload)
          // Conservatively keep tool calls and their transport results together.
          if (!steps.length || msg.role==='assistant' && !msg.parts.some(p=>p.type==='tool' && p.tool_output!==undefined)) steps.push([])
          steps.at(-1)!.push(row)
        }
        const floor=Math.min(steps.length,Math.max(1,options.min_raw_tail_steps))
        let free=remaining-group.anchor.tokens, stepsKept=0
        for (const step of steps.reverse()) {
          const cost=step.reduce((sum,row)=>sum+row.tokens,0)
          if (cost>free) break
          free-=cost;stepsKept++;keep+=step.length
        }
        if (free<0 || stepsKept<floor) invalid('The retained token budget cannot hold the newest anchor and mandatory raw steps.')
        const tailStart=keep ? group.rows.at(-keep)!.seq : group.anchor.seq+1
        return {keep,checkpoint:{payload:group.anchor.payload,tokens:group.anchor.tokens,tailStart}}
      }
      break
    }
    keep += group.rows.length
    remaining -= group.tokens
  }
  return {keep}
}

export function saveCheckpoint(sql:SqlStorage,key:SessionKey,n:number,checkpoint?:Checkpoint) {
  sql.exec(`DELETE FROM ov_session_checkpoints WHERE ${sessionWhere}`,...key)
  if (checkpoint) sql.exec(`INSERT INTO ov_session_checkpoints (${sessionColumns},archive_no,anchor,tokens,tail_start) VALUES(?,?,?,?,?,?,?,?)`,
    ...key,n,checkpoint.payload,checkpoint.tokens,checkpoint.tailStart)
}
export function activeCheckpoint(sql:SqlStorage,key:SessionKey) {
  return sql.exec<{archive_no:number;anchor:string;tokens:number;tail_start:number}>(`SELECT archive_no,anchor,tokens,tail_start FROM ov_session_checkpoints WHERE ${sessionWhere}`,...key).toArray()[0]
}

export function noteRetention(sql: SqlStorage, key: SessionKey, options?: Retention) {
  if (options) sql.exec(`INSERT OR REPLACE INTO ov_session_retention (${sessionColumns},config) VALUES(?,?,?,?,?)`, ...key, JSON.stringify(options))
  else sql.exec(`DELETE FROM ov_session_retention WHERE ${sessionWhere}`, ...key)
}

export function retentionState(sql: SqlStorage, key: SessionKey) {
  const row = sql.exec<{config:string}>(`SELECT config FROM ov_session_retention WHERE ${sessionWhere}`, ...key).toArray()[0]
  return row ? JSON.parse(row.config) as Retention : { retention_mode:'', keep_recent_turn_count:0, retained_message_token_budget:0, min_raw_tail_steps:1 }
}
