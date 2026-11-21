// SPDX-License-Identifier: AGPL-3.0-only
import { Workspace as ProductionWorkspace } from '../../src/worker.ts'
import { routeGateway } from '../../src/gateway.ts'

export { default, Control } from '../../src/worker.ts'

const utf8 = new TextEncoder()
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`
const done = 'data: [DONE]\n\n'

function fixtureStream(input, states) {
  const mode = /^(sse-[a-z-]+)\b/.exec(input.messages.at(-1).content)?.[1]
  if (mode === undefined) throw new Error('unrecognized SSE fixture')
  if (mode === 'sse-binding-unavailable') throw new Error('private fixture provider failure')
  const guarded = ['sse-held', 'sse-cancel', 'sse-reconfigure', 'sse-idle'].includes(mode)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const state = { released: !guarded, cancelled: false, tail: false, release }
  states.set(mode, state)
  const firstSse = utf8.encode(': keepalive\r\n\r\ndata: {"response":\r\ndata: "Marée 🌊"}\r\n\r\n')
  const split = firstSse.indexOf(0xf0) + 2
  const parts = mode === 'sse-bad' ? ['data: {not JSON}\n\n'] : mode === 'sse-empty' ? [done] :
    [firstSse.subarray(0, split), firstSse.subarray(split, -1), firstSse.subarray(-1)]
  const openingReads = parts.length
  if (mode === 'sse-eof') parts.push('data: {"response":"unframed"}')
  else if (mode === 'sse-error') parts.push('event: error\ndata: {"message":"private fixture detail"}\n\n')
  else if (mode === 'sse-big') parts.push(frame({ response: 'x'.repeat(66_000) }))
  else if (mode === 'sse-invalid-utf') parts.push(Uint8Array.of(0xc3, 0x28))
  else if (mode !== 'sse-bad' && mode !== 'sse-empty') {
    parts.push(frame({ choices: [{ delta: { content: ' haute' }, index: 0, finish_reason: null }] }))
    parts.push(frame({ choices: [{ delta: {}, index: 0,
      finish_reason: mode === 'sse-length' ? 'length' : mode === 'sse-no-usage' ? null : 'stop' }] }))
    if (mode !== 'sse-no-usage') parts.push(frame({ choices: [], usage: { prompt_tokens: 17, completion_tokens: 6 } }))
    parts.push(done)
  }
  let index = 0
  return new ReadableStream({
    async pull(controller) {
      if (index >= openingReads) {
        if (!state.released) await gate
        if (state.cancelled) return
        if (index < parts.length) state.tail = true
      }
      if (index >= parts.length) {
        if (!guarded) controller.close()
        else if (!state.cancelled) { // The good server may keep its connection open after [DONE].
          await new Promise(resolve => { state.drain = resolve })
        }
        return
      }
      const chunk = parts[index++]
      controller.enqueue(typeof chunk === 'string' ? utf8.encode(chunk) : chunk)
    },
    cancel() { state.cancelled = true; release(); state.drain?.() },
  }, { highWaterMark: 0 })
}

function vector(value) {
  if (value === 'fixture embedding failure') throw new Error('synthetic embedding failure')
  const packed = Array(768).fill(0)
  packed[0] = 0.001
  for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
    let key = 0
    for (const letter of word) key = (key * 31 + letter.charCodeAt(0)) >>> 0
    packed[1 + key % 767]++
  }
  return packed
}

const ai = {
  async run(model, input) {
    if (model === '@cf/baai/bge-base-en-v1.5') return { data: input.text.map(vector) }
    if (model !== '@cf/meta/llama-3.1-8b-instruct' || input.stream !== false) throw new Error('fixture configuration mismatch')
    const text = input.messages.at(-1).content
    if (text === 'fixture generation failure') throw new Error('synthetic provider detail should stay private')
    if (text === 'report fictional history') {
      return { response: JSON.stringify(input.messages), usage: { prompt_tokens: 23, completion_tokens: 5 } }
    }
    if (input.messages[0].role === 'system' && input.messages[0].content.startsWith('Extract atomic real-world events')) {
      const { transcript } = JSON.parse(text)
      const observed = transcript.some(item => item.role === 'user' && item.text === 'The synthetic marina cleanup was confirmed.')
      const response = JSON.stringify({ events: observed ? [{ page_id: 100, event_name: 'marina cleanup', goal: 'Coordinate volunteers',
        summary: 'The synthetic marina cleanup was confirmed.', ranges: '0' }] : [] })
      return { response, usage: { prompt_tokens: 31, completion_tokens: 14 } }
    }
    return { response: `Workers AI fixture (${input.max_tokens}): ${text}`, usage: { prompt_tokens: 17, completion_tokens: 6 } }
  },
}

const operatorModels = Object.freeze(['local/red', 'local/blue'])
const operator = {
  models: operatorModels,
  async generate(model, messages) {
    if (!operatorModels.includes(model)) throw new Error('fixture model not admitted')
    const input = messages.at(-1).content
    return { text: `Operator fixture ${model}: ${input}`, inputTokens: null, outputTokens: null }
  },
  async countTokens(model, messages) {
    if (!operatorModels.includes(model)) throw new Error('fixture model not admitted')
    // This fixture tokenizer's tokens are Unicode code points; no provider claim.
    return messages.reduce((total, message) => total + Array.from(message.content).length, 0)
  },
}

// Only the binding is substituted. The public fetch, RPC, authenticators,
// SQLite implementations and route dispatcher are those of production.
export class Workspace extends ProductionWorkspace {
  constructor(ctx, env) {
    const streams = new Map()
    const binding = { run: (model, input) => input.stream === true ? fixtureStream(input, streams) : ai.run(model, input) }
    super(ctx, env.TEST_GATEWAY_EMBEDDINGS === 'off' ? env : { ...env, AI: binding })
    this.streams = streams
    this.abortNotifications = 0
  }

  async workspaceContext(...args) {
    const context = await super.workspaceContext(...args)
    if (context.caller.accountId === 'operator-fixture') context.gatewayProvider = operator
    if (this.env.TEST_GATEWAY_STREAMING !== 'on') delete context.generateStream
    return context
  }

  fixtureStreamState(mode) {
    const state = this.streams.get(mode)
    return JSON.stringify(state ? { released: state.released, cancelled: state.cancelled, tail: state.tail } : null)
  }

  fixtureReleaseStream(mode) {
    const state = this.streams.get(mode)
    if (!state) return false
    state.released = true
    state.release()
    return true
  }

  fixtureQuota(user) {
    return this.ctx.storage.sql.exec('SELECT calls FROM ov_generation_budget WHERE subject=?', `user:${user}`).toArray()[0]?.calls ?? 0
  }

  cancelGateway(id, actor) {
    this.abortNotifications++
    this.lastAbortActor = JSON.stringify(actor)
    return super.cancelGateway(id, actor)
  }

  fixtureAborts() { return this.abortNotifications }
  fixtureAbortActor() { return this.lastAbortActor }

  fixtureArmPreAbort(actor) {
    const id = crypto.randomUUID()
    super.cancelGateway(id, actor)
    this.pendingPreAbort = id
  }

  dispatchScoped(request, url, context) {
    if (this.pendingPreAbort && url.pathname === '/gateway/v1/chat/completions') {
      context.gatewayRequestId = this.pendingPreAbort
      this.pendingPreAbort = undefined
      return routeGateway(request, url, context)
    }
    return super.dispatchScoped(request, url, context)
  }

  fixtureAgeResponse(id) {
    this.ctx.storage.sql.exec('UPDATE ov_gateway_responses SET created_at=? WHERE id=?', Date.now() - 25 * 3_600_000, id)
  }
}
