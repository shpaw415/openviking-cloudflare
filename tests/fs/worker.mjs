// SPDX-License-Identifier: AGPL-3.0-only
// Test-only entry point. Never included in the application Worker.
import { DurableObject } from 'cloudflare:workers'
import { initFilesystem, routeFilesystem } from '../../src/filesystem.js'
import * as facade from '../../src/filesystem.js'
import { ApiError, apiError } from '../../src/http.js'

const principals = {
  admin: { accountId: 'fixture-account', userId: 'alice', agentId: 'studio', role: 'admin' },
  member: { accountId: 'fixture-account', userId: 'bob', agentId: 'studio', role: 'user' },
  reader: { accountId: 'fixture-account', userId: 'carol', agentId: 'studio', role: 'user' },
  secondAgent: { accountId: 'fixture-account', userId: 'alice', agentId: 'another', role: 'user' },
  otherAccount: { accountId: 'other-fixture', userId: 'alice', agentId: 'studio', role: 'admin' },
}

export class FilesystemFixture extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
    state.storage.transactionSync(() => initFilesystem(this.context(principals.admin)))
  }

  context(caller, embedding = 'fixture') {
    const storage = this.state.storage
    return {
      caller, storage, sql: storage.sql,
      compileExampleSkills: [{ name: 'example-recipe', description: 'Summarize a sample.',
        content: '---\nname: example-recipe\ndescription: Summarize a sample.\n---\nRead sample prose.\n' }],
      groups: caller.userId === 'bob' ? ['editors', 'readers', 'readers'] : [],
      aclPrincipals: { users: caller.accountId === principals.admin.accountId ? ['alice', 'bob', 'carol'] : ['alice'],
        groups: caller.accountId === principals.admin.accountId ? ['editors', 'readers'] : [] },
      ...(['generated', 'invalid-generation', 'paused-generation'].includes(embedding) && { generate: async (messages, options) => {
        if (!messages[0].content.includes('openviking_edge_directory_summary_v1') || options?.maxTokens > 1024) {
          throw new Error('Unexpected directory analysis fixture contract')
        }
        const data = JSON.parse(messages[1].content)
        if (!data.document?.content.includes('sunflower')) throw new Error('Wrong staged analysis input')
        if (embedding === 'paused-generation') await new Promise(resolve => { this.resumeEmbedding = resolve })
        return { text: JSON.stringify(embedding === 'invalid-generation' ? { overview: '# Heading only' } : {
          overview: '# Field notes\n\nSunflower field records support automation.\n\n## Contents\n\nThe fixture contains a field note.',
        }), inputTokens: null, outputTokens: null }
      } }),
      ...(embedding === 'convert' && { convertDocument: async file => {
        if (file.name !== 'garden.pdf' || file.type !== 'application/pdf' || file.size !== 80_000) throw new Error('Wrong document fixture')
        return { filename: 'garden.md', content: 'sunflower field\n' }
      } }),
      // Deliberately tiny, deterministic test vectors. The real Worker calls Workers AI.
      embed: async (texts) => {
        if (embedding === 'offline') throw new Error('Fixture provider unavailable')
        if (embedding === 'limited') throw new ApiError(429, 'RATE_LIMITED', 'Fixture budget exhausted')
        if (embedding === 'invalid') return texts.map(() => [0, 0, 0])
        if (embedding === 'different-shape') return texts.map(() => [1, 0, 0, 0])
        if (embedding === 'paused') {
          await new Promise(resolve => { this.resumeEmbedding = resolve })
        }
        return texts.map((text) => {
          if (/sunflower|botanical/i.test(text)) return [5, 0, 0]
          if (/volcano|geological/i.test(text)) return [0, 3, 0]
          return [0, 0, 2]
        })
      },
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/fixture/gate') {
      if (request.method === 'POST' && this.resumeEmbedding) {
        const resume = this.resumeEmbedding
        this.resumeEmbedding = undefined
        resume()
        return Response.json(true)
      }
      return Response.json(!!this.resumeEmbedding)
    }
    if (url.pathname === '/fixture/seed-capacity' && request.method === 'POST') {
      // Populate only the account being tested, one entry below the workspace cap.
      this.state.storage.sql.exec(`WITH RECURSIVE slots(i) AS (
        SELECT 1 UNION ALL SELECT i+1 FROM slots WHERE i<1499
      ) INSERT INTO ov_edge_fs_entry(account_id,space,uri,is_dir,created_at,updated_at,revision)
      SELECT ?, 'shared', 'viking://resources/fixture-' || i, 1, 1, 1, 'test-' || i FROM slots`, principals.admin.accountId)
      return Response.json(true)
    }
    if (url.pathname === '/fixture/seed-private-capacity' && request.method === 'POST') {
      const { accountId, userId, agentId } = principals.admin
      this.state.storage.sql.exec(`WITH RECURSIVE slots(i) AS (
        SELECT 1 UNION ALL SELECT i+1 FROM slots WHERE i<399
      ) INSERT INTO ov_edge_fs_entry(account_id,space,uri,is_dir,created_at,updated_at,revision)
      SELECT ?, ?, 'viking://agent/fixture-' || i, 1, 1, 1, 'test-' || i FROM slots`,
      accountId, JSON.stringify(['agent', userId, agentId]))
      return Response.json(true)
    }
    const caller = principals[request.headers.get('x-fixture-caller') ?? 'admin']
    try {
      const context = this.context(caller, request.headers.get('x-fixture-embed'))
      if (url.pathname === '/fixture/subtree') {
        if (!Object.hasOwn(facade, 'captureSubtree')) throw new ApiError(501, 'NOT_IMPLEMENTED', 'Subtree façade is absent.')
        const fs = new facade.Filesystem(context)
        const uri = url.searchParams.get('uri')
        if (request.method === 'GET') {
          this.capture = facade.captureSubtree(fs, uri)
          return Response.json({ status: 'ok', result: this.capture.revision })
        }
        const { check, plan, fail, dry_run } = await request.json()
        if (check) {
          facade.authorizeHistoricalRead(fs, this.capture)
          return Response.json({ status: 'ok', result: true })
        }
        if (dry_run) {
          facade.validateSubtreeMutation(fs, uri, plan)
          return Response.json({ status: 'ok', result: true })
        }
        const prepared = await facade.prepareSubtreeMutation(fs, uri, plan)
        const result = facade.commitSubtreeMutation(fs, prepared, () => {
          if (fail) throw new ApiError(409, 'FIXTURE_ROLLBACK', 'Fixture journal failed.')
        })
        return Response.json({ status: 'ok', result })
      }
      return await routeFilesystem(request, url, context) ??
        Response.json({ forwarded: true }, { status: 501 })
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      return apiError(error, 'fixture')
    }
  }
}

export default {
  fetch(request, env) {
    // Deliberately send different account identities to the same DO to test the SQL guard.
    return env.DB.getByName(request.headers.get('x-fixture-workspace')).fetch(request)
  },
}
