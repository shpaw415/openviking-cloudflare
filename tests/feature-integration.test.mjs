// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

test('a permitted URL import is searchable and downloadable through a real Gateway transfer', async t => {
  const user = testPrincipal('campaign-workspace', 'owner')
  const text = '# Orchard note\n\nA synthetic pear harvest record.\n'
  const source = 'https://documents.fixture.test/orchard-note.md'
  let fetched = 0
  const worker = await localWorker({ principals: [user], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_TEXT_SOURCES: JSON.stringify([source]), OPENVIKING_EDGE_GATEWAY_TRANSFERS: '1',
      OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET: randomBytes(32).toString('hex') },
    serviceBindings: { TEXT_SOURCE(req) {
      assert.equal(req.url, source)
      assert.equal(req.method, 'GET')
      assert.equal(req.headers.has('authorization') || req.headers.has('x-api-key') || req.headers.has('cookie'), false)
      fetched++
      return new Response(text, { headers: { 'content-type': 'text/markdown' } })
    } },
    outboundService() { throw Error('No external request expected in integration QA.') },
  })
  t.after(() => worker.dispose())
  const doCall = api(worker, user)
  const post = (path, body) => doCall(path, { method: 'POST', body })
  const result = async (response, status = 200) => {
    const r = await response
    assert.equal(r.status, status)
    return (await r.json()).result
  }
  const caps = await result(doCall('/api/v1/system/edge-capabilities'))
  assert.equal(caps.features.urlImport, true)
  const target = 'viking://user/owner/resources/orchard-note.md'
  const imported = await result(post('/api/v1/resources', { path: source, parent: 'viking://~/resources', wait: true,
    processing_mode: 'vectors_only' }))
  assert.equal(imported.root_uri, target)
  assert.equal(imported.status, 'success')
  const found = await result(post('/api/v1/search/find', { target_uri: 'viking://~/resources',
    query: 'synthetic pear harvest record', limit: 3 }))
  assert.ok(found.resources.some(item => item.uri === target))
  const ticket = await result(post('/gateway/transfers/tickets', { action: 'download', uri: target }), 201)
  assert.equal(ticket.method, 'GET')
  const path = new URL(ticket.url, 'http://localhost')
  assert.equal(path.origin === 'http://localhost' && path.pathname === '/gateway/downloads', true)
  const attachment = await doCall(path.pathname + path.search)
  assert.equal(attachment.status, 200)
  assert.equal(attachment.headers.get('content-type'), 'application/octet-stream')
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), Buffer.from(text, 'utf8'))
  assert.equal(fetched, 1)
})
