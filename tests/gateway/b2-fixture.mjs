// SPDX-License-Identifier: AGPL-3.0-only
// Private test entry, never in the deployment bundle. Holds fake producers or
// test-only RPC boundaries while exercising the real routing and SQLite state.
import worker, { Workspace as BaseWorkspace, Control as BaseControl } from '../../src/worker.ts'
import { generate as generationModel } from './b2-model.mjs'

function gates() {
  const held = new Map()
  return {
    async hold(name) {
      let release
      const waiting = new Promise(resolve => { release = resolve })
      held.set(name, release)
      try { await waiting } finally { held.delete(name) }
    },
    release: name => held.get(name)?.(),
    held: name => held.has(name),
  }
}
const placeholder = { run() { throw new Error('parent fixture must not invoke AI') } }
export default { fetch: (request, env, ctx) => worker.fetch(request, { ...env, AI: placeholder }, ctx) }
export class Control extends BaseControl {
  constructor(ctx, env) { super(ctx, { ...env, AI: placeholder }) }
}

export class Workspace extends BaseWorkspace {
  constructor(ctx, env) {
    const gate = gates(), calls = { generation: 0, cancelled: false, tail: false, temperature: null }
    super(ctx, { ...env, AI: { run: (model, input) => generationModel(model, input, calls, gate) } })
    this.gate = gate
    this.calls = calls
  }
  async workspaceContext(grant, task, request) {
    const context = await super.workspaceContext(grant, task, request)
    if (context.gatewayKey && request?.headers.get('x-openviking-session') === 'held-admission') await this.gate.hold('mount')
    return context
  }
  async fenceGatewayModel(account, revision) {
    if (this.fenceMode === 'hold') await this.gate.hold('fence')
    const receipt = await super.fenceGatewayModel(account, revision)
    if (this.fenceMode === 'unavailable') throw new Error('fixture unavailable after local fence')
    return receipt
  }
  fixtureMode(mode) { this.fenceMode = mode }
  fixtureRelease(name) { this.gate.release(name) }
  fixtureHeld(name) { return this.gate.held(name) }
  fixtureCounts() { return this.calls }
  fixtureWritten() {
    const sql = this.ctx.storage.sql
    return [sql.exec('SELECT count(*) AS count FROM ov_gateway_responses').one().count,
      sql.exec('SELECT count(*) AS count FROM ov_sessions').one().count,
      sql.exec('SELECT count(*) AS count FROM ov_gateway_state').one().count]
  }
  fixtureFloor() {
    return this.ctx.storage.sql.exec('SELECT revision FROM ov_gateway_model_fence WHERE id=1').one().revision
  }
  fixtureLegacy(account, user, id) {
    const sql = this.ctx.storage.sql
    // Pre-B2 schema, before the real Workspace initialization/migration.
    sql.exec(`CREATE TABLE ov_gateway_responses (
      account_id TEXT NOT NULL, user_id TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
      route TEXT NOT NULL, history TEXT NOT NULL, response TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (account_id,user_id,agent_id,id)
    ) WITHOUT ROWID`)
    sql.exec('INSERT INTO ov_gateway_responses VALUES (?,?,?,?,?,?,?,?,?)', account, user, 'default', id, Date.now(),
      JSON.stringify(['responses', 'workers_ai', '@cf/meta/llama-3.1-8b-instruct']),
      JSON.stringify([{ role: 'user', content: 'Legacy fixture' }, { role: 'assistant', content: 'Fixture reply' }]),
      JSON.stringify({ id, model: 'harbor', object: 'response' }), 100)
  }
}
