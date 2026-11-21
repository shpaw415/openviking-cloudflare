// SPDX-License-Identifier: AGPL-3.0-only
import { DurableObject } from 'cloudflare:workers'
import { initBot, routeBot } from '../../src/bot.js'
import { initEvolution, routeEvolution } from '../../src/bot/evolution.js'
import { initFilesystem, routeFilesystem } from '../../src/filesystem.js'
import { initSessions, routeSessions } from '../../src/sessions.js'
import { ApiError, apiError } from '../../src/http.js'

const principals = {
  alice: { accountId: 'demo', userId: 'alice', agentId: 'web', role: 'user' },
  agent: { accountId: 'demo', userId: 'alice', agentId: 'cli', role: 'user' },
  bob: { accountId: 'demo', userId: 'bob', agentId: 'web', role: 'admin' },
  elsewhere: { accountId: 'other', userId: 'alice', agentId: 'web', role: 'user' },
}

export class BotFixture extends DurableObject {
  pending = new Map()

  async fetch(request) {
    const storage = this.ctx.storage, sql = storage.sql, url = new URL(request.url)
    const caller = principals[request.headers.get('test-principal') ?? 'alice']
    const context = { caller, storage, sql, embed: async texts => texts.map(text => /harbor|marina|tide/i.test(text) ? [1, 0] : [0, 1]) }
    if (this.env.MODE !== 'no-model') context.generate = async (messages, options) => {
      if (messages.length !== 2 || messages[0].role !== 'system' || messages[1].role !== 'user' || options.maxTokens > 1536) throw Error('Unexpected provider input')
      const data = JSON.parse(messages[1].content)
      if (messages[0].content.startsWith('Extract atomic')) {
        return { text: JSON.stringify({ events: [{ page_id: 100, event_name: 'harbor_cleanup', goal: 'shore safety',
          summary: 'The harbor crew confirmed a cleanup at low tide.', ranges: '0' }] }), inputTokens: 16, outputTokens: 16 }
      }
      const { question, history, sources } = data
      if (question.startsWith('Hold ')) {
        await new Promise(resolve => this.pending.set(question, resolve))
      }
      if (question === 'Temporary failure') throw new ApiError(429, 'RATE_LIMITED', 'Fixture quota.')
      if (question === 'Large output') return { text: 'a'.repeat(20 * 1024), inputTokens: 8, outputTokens: 8 }
      const source = sources[0]?.text
      const text = `${question}${source ? `\nEvidence: ${source}` : ''}${question === 'Continue?' ? `\nPrior question: ${history[0]?.text}` : ''}`
      return { text, inputTokens: 25, outputTokens: question === 'Unknown usage' ? null : 5 }
    }
    if (!this.initialized) {
      storage.transactionSync(() => { initFilesystem(context); initSessions(context); initBot(context); initEvolution(sql) })
      this.initialized = true
    }
    // Only the fixture can pause/release the synthetic provider; never a product route.
    if (url.pathname === '/fixture/model') {
      const name = url.searchParams.get('question')
      if (request.method === 'POST') {
        this.pending.get(name)?.()
        this.pending.delete(name)
      }
      return Response.json({ pending: this.pending.has(name) })
    }
    try {
      return routeEvolution(request, url, context) ?? await routeBot(request, url, context) ?? await routeSessions(request, url, context) ??
        await routeFilesystem(request, url, context) ?? new Response(null, { status: 404 })
    } catch (error) { return apiError(error, 'bot-test') }
  }
}

export default {
  fetch(request, env) { return env.BOT_SQL.getByName('one-shared-fixture').fetch(request) },
}
