// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const script = fileURLToPath(new URL('../scripts/admin.mjs', import.meta.url))

test('the admin CLI previews and applies the advanced Edge projection with a redacted receipt', { timeout: 30_000 }, async t => {
  const root = testPrincipal('bootstrap', 'root', 'root'), member = testPrincipal('demo', 'reader')
  const secret = randomBytes(32).toString('hex'), base = 'https://models.example.test/v1', rank = `${base}/reranks`
  let outbound = 0
  const runtime = await localWorker({ principals: [root, member], embeddings: 'fixture', vars: {
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([base, rank].map(api_base => ({ api_base, api_key: secret }))),
  }, outboundService() { outbound++; return new Response(null, { status: 599 }) } })
  t.after(() => runtime.dispose())
  const { origin } = await runtime.ready
  const dir = await mkdtemp(join(tmpdir(), 'ov-f4-cli-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'ov.edge.conf'), credential = join(dir, 'root.key')
  await writeFile(credential, `${root.key}\n`, { mode: 0o600 })
  const run = (command, ...args) => new Promise(resolve => {
    execFile(process.execPath, [script, command, '--url', origin, '--key-file', credential, ...args], { timeout: 15_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }))
  })
  const read = (out, code = 0) => {
    assert.equal([root.key, secret, base].some(value => `${out.stdout}${out.stderr}`.includes(value)), false)
    assert.equal(out.code, code, out.stderr)
    return code === 0 ? JSON.parse(out.stdout) : undefined
  }
  const body = { vlm: { backend: 'openai-compatible', api_base: base, model: 'cli-chat', top_p: 0.4, max_concurrent: 2, reasoning_effort: 'low' },
    embedding: { dense: { backend: 'openai-compatible', api_base: base, model: 'cli-embedding', dimension: 2, batch_size: 2, encoding_format: 'base64' } },
    retrieval: { session_context_messages: 2 }, rerank: { provider: 'openai', model: 'cli-rank', api_base: rank, threshold: 0.6, timeout: 2, max_input_tokens: 256 },
    memory: { extraction_enabled: false, edge_context_token_budget: 0, session_auto_commit: { enabled: true, message_count_threshold: 6 } },
    default_search_score_threshold: 0.3 }
  const save = data => writeFile(file, JSON.stringify(data), { mode: 0o600 })
  await save({ ...body, rerank: { ...body.rerank, api_key: secret } })
  const flags = ['--file', file]
  read(await run('import-config', ...flags, '--dry-run', '--revision', '0'), 2)
  await save(body)
  const dry = read(await run('import-config', ...flags, '--dry-run', '--revision', '0'))
  assert.equal(dry.revision, 0)
  assert.equal(dry.dry_run, true)
  assert.equal(dry.vlm.top_p, 0.4)
  assert.equal(dry.vlm.max_concurrent, 2)
  assert.equal(dry.vlm.reasoning_effort, 'low')
  assert.equal(dry.default_embedding.encoding_format, 'base64')
  assert.equal(dry.default_embedding.batch_size, 2)
  assert.equal(dry.rerank.threshold, 0.6)
  assert.equal(dry.rerank.timeout, 2)
  assert.equal(dry.rerank.max_input_tokens, 256)
  assert.equal(dry.retrieval.session_context_messages, 2)
  assert.equal(dry.memory.edge_context_token_budget, 0)
  assert.equal(dry.default_search_score_threshold, 0.3)
  assert.equal(read(await run('show-config')).rerank, null)
  const applied = read(await run('import-config', ...flags, '--apply', '--revision', '0'))
  assert.deepEqual(applied, { ...dry, revision: 1, dry_run: false })
  assert.deepEqual(read(await run('show-config')), applied)
  read(await run('import-config', ...flags, '--apply', '--revision', '0'), 1)
  const send = api(runtime, member)
  const message = await send('/api/v1/sessions/cli-fixture/messages', { method: 'POST', body: { role: 'user', content: 'Fictional CLI note.' } })
  assert.equal(message.status, 200)
  await message.text()
  const response = await send('/api/v1/sessions/cli-fixture/context')
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).result.messages, [])
  assert.equal(outbound, 0)
})
