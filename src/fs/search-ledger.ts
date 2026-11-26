// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { keyFor, sessionColumns, sessionForeignKey, sessionWhere } from '../session/flight.js'
import { requireSession, sessionId } from '../session/store.js'
import { conflict, encoder } from './contract.js'
import type { Filesystem } from './store.js'

type Pin = [uri: string, revision: string]
export type ContextPins = Pin[]
type Served = [uri: string, turn: number, pins: ContextPins]
const maxBytes = 64 * 1024
const maxUris = 500

export function initContextRecall({ sql }: WorkspaceContext) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_context_recall (
    account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
    incarnation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, authority TEXT NOT NULL DEFAULT '',
    served TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(served) AND length(cast(served AS blob))<=65536),
    PRIMARY KEY (${sessionColumns}), ${sessionForeignKey}
  ) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS ov_edge_context_recall_session AFTER INSERT ON ov_sessions BEGIN
    INSERT INTO ov_edge_context_recall (${sessionColumns},incarnation)
      VALUES (new.account_id,new.user_id,new.agent_id,new.session_id,lower(hex(randomblob(16))));
  END`)
}

// Stamp only readable sources and read-dependent ancestors. A hidden ancestor
// gets no readable revision, and its ACL is still enforced by previewEntry.
export function pinSource(fs: Filesystem, pins: ContextPins, uri: string) {
  const pin = (at: string) => {
    const node = fs.previewEntry(fs.path(at))
    if (!pins.some(([name]) => name === at)) pins.push([at, node?.revision ?? ''])
    return node
  }
  const node = pin(uri)
  const path = fs.path(uri)
  for (const source of [path, ...(node?.derived_from ? [fs.path(node.derived_from)] : [])]) {
    if (source.uri !== uri) pin(source.uri)
    if (source.space !== 'shared') continue
    for (let parent = fs.parent(source); !parent.builtin; parent = fs.parent(parent)) pin(parent.uri)
  }
  return node
}

export function pinsCurrent(fs: Filesystem, pins: ContextPins) {
  return pins.every(([uri, revision]) => (fs.previewEntry(fs.path(uri))?.revision ?? '') === revision)
}

export function recallSession(ctx: WorkspaceContext, id: string) {
  const key = keyFor(ctx, sessionId(id))
  const current = () => {
    const row = requireSession(ctx.sql, key)
    const state = ctx.sql.exec<{ incarnation: string; revision: number; authority: string; served: string }>(
      `SELECT incarnation,revision,authority,served FROM ov_edge_context_recall WHERE ${sessionWhere}`, ...key).toArray()[0]
    return { stamp: JSON.stringify([state?.incarnation, row.created_at, row.total_message_count, row.commit_count]),
      turn: Math.max(row.total_message_count, row.message_count), state }
  }
  const start = current()
  return {
    check: () => {
      if (current().stamp !== start.stamp) conflict('The session changed while assembling context; retry.')
    },
    ledger(turns: number) {
      const { turn, state } = current()
      const revision = state?.revision ?? 0
      const authority = JSON.stringify([ctx.caller.role, ctx.dataAuthority!.revision.account, ctx.dataAuthority!.revision.member])
      const kept: Served[] = state?.authority === authority ? JSON.parse(state.served) : []
      const check = () => {
        const fresh = current()
        if (fresh.stamp !== start.stamp || (fresh.state?.revision ?? 0) !== revision) {
          conflict('The session or recall ledger changed while assembling context; retry.')
        }
      }
      return {
        turn, status: state?.authority === authority && revision > 0 ? 'ok' : 'new', check,
        recent: new Map(kept.filter(([, at]) => at <= turn && turn - at < turns).map(([uri, , pins]) => [uri, pins])),
        record(served: Array<{ uri: string; pins: ContextPins }>) {
          if (!served.length) return
          const now = new Set(served.map(entry => entry.uri))
          const rows: Served[] = served.map(({ uri, pins }) => [uri, turn, pins])
          rows.push(...kept.filter(([uri, at]) => !now.has(uri) && at <= turn && turn - at <= turns * 4))
          const encoded: string[] = []
          let size = 2
          for (const row of rows.slice(0, maxUris)) {
            const json = JSON.stringify(row)
            size += encoder.encode(json).byteLength + 1
            if (size > maxBytes) break
            encoded.push(json)
          }
          ctx.sql.exec(`INSERT INTO ov_edge_context_recall (${sessionColumns},incarnation,revision,authority,served)
            VALUES (?,?,?,?,?,1,?,?) ON CONFLICT (${sessionColumns}) DO UPDATE SET
            revision=revision+1, authority=excluded.authority, served=excluded.served`, ...key,
          state?.incarnation ?? crypto.randomUUID(), authority, `[${encoded.join(',')}]`)
        },
      }
    },
  }
}
