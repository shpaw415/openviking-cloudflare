// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const base = 'https://api.openai.com/v1', model = 'fixture-local-read-fence', uri = 'viking://resources/fence.txt'
const before = 'Avant révision.', after = 'Après révision.'
const actor = testPrincipal('local-read-fence', 'operator', 'admin'), reader = testPrincipal(actor.accountId, 'reader')

async function fixture(t) {
  const key = randomBytes(24).toString('hex'), calls = []
  const gate = Promise.withResolvers(), atSelection = Promise.withResolvers()
  const mf = await localWorker({ principals: [actor, reader], embeddings: 'fixture', vars: {
    OPENVIKING_EDGE_OPERATOR_STREAMING: '1',
    OPENVIKING_EDGE_PROVIDERS: JSON.stringify([{ api_base: base, api_key: key }]),
    OPENVIKING_EDGE_GATEWAY_NATIVE: JSON.stringify([{ api_base: base, protocol: 'responses', model, capabilities: ['local_read'] }]),
  }, outboundService: async req => {
    assert.equal(req.url, `${base}/responses`)
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.get('authorization'), `Bearer ${key}`)
    const body = await req.json()
    calls.push(body)
    assert.equal(body.stream, false)
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'openviking_read' })
    assert.equal(JSON.stringify(body).includes(before), false)
    atSelection.resolve()
    await gate.promise
    return Response.json({ object: 'response', status: 'completed', output: [{ type: 'function_call', status: 'completed',
      name: 'openviking_read', call_id: 'read_fixture', arguments: JSON.stringify({ uri }) }] })
  } })
  t.after(async () => { gate.resolve(); await mf.dispose() })
  assert.equal((await mf.ready).hostname, '127.0.0.1')
  return { calls, selected: atSelection.promise, release: gate.resolve, admin: api(mf, actor), member: api(mf, reader) }
}

for (const change of ['ACL', 'révision']) {
  test(`no native SSE continuation when ${change} changes while the local reader selection is blocked`, { timeout: 12000 }, async t => {
    const f = await fixture(t)
    const acl = { acl_mode: 'restricted', entries: [{ principal: `user:${reader.userId}`, level: 'read' }] }
    const write = (text, mode) => f.admin('/api/v1/content/write', { method: 'POST', body: { uri, content: text, mode,
      processing_mode: 'vectors_only', ...(mode === 'create' && { acl }) } })
    const observe = () => f.member(`/api/v1/content/read?${new URLSearchParams({ uri })}`)
    assert.equal((await write(before, 'create')).status, 200)
    assert.equal((await (await observe()).json()).result, before)
    const pending = f.member('/gateway/v1/responses', { method: 'POST', body: { model, input: 'Lire la balise.', stream: true },
      headers: { 'x-openviking-allow-read': uri } })
    try {
      const phase = await Promise.race([f.selected.then(() => 'selected'), pending.then(res => `unexpected HTTP ${res.status}`)])
      assert.equal(phase, 'selected')
      if (change === 'ACL') {
        const revoke = await f.admin('/api/v1/acl', { method: 'PUT', body: { uri, ...acl, entries: [] } })
        assert.equal(revoke.status, 200)
        assert.equal((await observe()).status, 403)
      } else {
        assert.equal((await write(after, 'replace')).status, 200)
        assert.equal((await (await observe()).json()).result, after, 'the reader remains authorized on a different revision')
      }
    } finally { f.release() }
    const denied = await pending
    assert.equal(denied.status, 404)
    assert.match(denied.headers.get('content-type'), /^application\/json/)
    assert.equal((await denied.json()).reason, 'local_tool_resource_unavailable')
    assert.equal(f.calls.length, 1, 'only the first selection reached the provider; no continuation')
  })
}
