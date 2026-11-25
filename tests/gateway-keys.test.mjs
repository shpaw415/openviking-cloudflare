// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const keys = '/gateway/admin/keys'
const model = '@cf/meta/llama-3.1-8b-instruct'
const chat = '/gateway/v1/chat/completions'
const call = { method: 'POST', body: { model: 'harbor', messages: [{ role: 'user', content: 'A fictional harbor.' }] } }
const draft = { name: 'Synthetic client', policy_id: 'restricted', upstream_ids: ['harbor'], models: ['harbor'] }

async function checked(pending, status = 200, reason) {
  const response = await pending
  const body = await response.json()
  assert.equal(response.status, status, `HTTP ${response.status}, category ${body.reason ?? body.error?.code ?? 'none'}`)
  if (reason) assert.equal(body.reason ?? body.error?.code, reason)
  return body
}

async function install(admin) {
  await checked(admin('/gateway/admin/policies/restricted', { method: 'PUT', body: { name: 'Restricted' } }))
  await checked(admin('/gateway/admin/upstreams/harbor', { method: 'PUT', body: { name: 'Harbor', protocol: 'chat', models: [model], aliases: { harbor: model } } }))
}

async function* files(path) {
  for (const e of await readdir(path, { withFileTypes: true })) {
    if (e.isDirectory()) yield* files(join(path, e.name))
    else if (e.isFile()) yield join(path, e.name)
  }
}

test('dedicated key is issued once, model-scoped, persisted and revoked independently', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'ov-gateway-keys-'))
  const user = testPrincipal('a-fixture', 'alice'), admin = testPrincipal('a-fixture', 'owner', 'admin')
  const peer = testPrincipal('a-fixture', 'bob'), other = testPrincipal('b-fixture', 'alice', 'admin')
  const root = testPrincipal('fixture-root', 'root', 'root')
  const start = () => localWorker({ persist, principals: [user, admin, peer, other, root], embeddings: 'fixture',
    vars: { OPENVIKING_EDGE_GENERATION: '1' }, outboundService() { throw new Error('Unexpected egress') } })
  let runtime = await start()
  try {
    await install(api(runtime, admin))
    const alice = api(runtime, user)
    const issued = await checked(alice(keys, { method: 'POST', body: draft }))
    assert.ok(/^ovgw_[A-Za-z0-9_-]{43}$/.test(issued.key), 'correct format')
    assert.ok(issued.prefix === issued.key.slice(0, 12), 'public prefix')
    assert.equal(issued.user_id, 'alice')
    const id = `${keys}/${issued.id}`
    const listed = await checked(alice(keys))
    assert.deepEqual(listed.map(k => k.id), [issued.id])
    assert.ok(!Object.hasOwn(listed[0], 'key') && !Object.hasOwn(listed[0], 'openviking_key'))
    assert.equal((await checked(alice(id))).id, issued.id)
    await checked(api(runtime, other)(id), 404)
    await checked(api(runtime, peer)(id, { method: 'DELETE' }), 404)
    await checked(alice(`${keys}?account_id=b-fixture`), 403, 'other_account')
    await checked(api(runtime, root)(keys), 403)
    const dedicated = () => api(runtime, { key: issued.key })
    await checked(dedicated()('/api/v1/fs/ls'), 401)
    await checked(dedicated()(keys), 401)
    await checked(dedicated()(chat, { ...call, body: { ...call.body, model } }), 403, 'model_not_allowed')
    assert.deepEqual((await checked(dedicated()('/gateway/api/v3/models'))).data.map(x => x.id), ['harbor'])
    await checked(dedicated()(chat, call))
    await checked(alice(chat, { ...call, body: { ...call.body, model } }))
    await runtime.dispose()
    runtime = undefined
    let persisted = false
    const hash = createHash('sha256').update(issued.key).digest('hex')
    for await (const path of files(persist)) {
      const bytes = await readFile(path)
      assert.ok(!bytes.includes(issued.key) && !bytes.includes(user.key), 'no credential bytes in SQLite')
      persisted ||= bytes.includes(hash)
    }
    assert.ok(persisted, 'the issued digest exists on disk')
    runtime = await start()
    await checked(dedicated()(chat, { ...call, headers: { authorization: `Bearer ${issued.key}` } }))
    await checked(api(runtime, admin)(id, { method: 'DELETE' }))
    await runtime.dispose()
    runtime = await start()
    await checked(dedicated()(chat, call), 401, 'gateway_key_invalid')
    assert.deepEqual(await checked(api(runtime, user)(keys)), [])
    await checked(api(runtime, user)(chat, call))
  } finally {
    await runtime?.dispose()
    await rm(persist, { recursive: true, force: true })
  }
})
