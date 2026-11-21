// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { harness, principal } from '../control/harness.mjs'
import { recordBundle } from './receipt.mjs'

const stale = 'Sat, 01 Jan 2000 00:00:00 GMT'

test('public WebDAV entry preserves conditional headers through the Worker and DO', async t => {
  const account = principal('dav-conditions-fixture', 'owner', 'admin')
  const { send, dir } = await harness(t, [account], { production: true })
  await recordBundle(t, dir)
  const uri = name => `/webdav/resources/${name}.txt`
  const request = (name, method, headers) => send(uri(name), { key: account.key, method, headers })
  const bytes = 'Note été\r\n'
  for (const name of ['read', 'stale', 'if', 'lock', 'client', 'fresh']) {
    const created = await send('/api/v1/content/write', { method: 'POST', key: account.key, body: {
      uri: `viking://resources/${name}.txt`, content: bytes, mode: 'create', defer_processing: true,
    } })
    assert.equal(created.status, 200, created.json?.error?.code)
  }

  await t.test('GET and HEAD apply If-Modified-Since without changing the representation', async () => {
    const original = await request('read', 'GET', { 'Accept-Encoding': 'identity' })
    assert.equal(original.status, 200)
    assert.equal(original.text, bytes)
    assert.equal(original.headers['content-length'], String(Buffer.byteLength(bytes)))
    assert.match(original.headers['last-modified'], /GMT$/)
    for (const method of ['GET', 'HEAD']) {
      const reply = await request('read', method, { 'If-Modified-Since': original.headers['last-modified'] })
      assert.equal(reply.status, 304)
      assert.equal(reply.text, '')
    }
  })

  await t.test('stale mutation is rejected and content stays byte-identical', async () => {
    const rejected = await request('stale', 'DELETE', { 'If-Unmodified-Since': stale })
    const unchanged = await request('stale', 'GET')
    assert.equal(rejected.status, 412)
    assert.equal(unchanged.status, 200)
    assert.equal(unchanged.text, bytes)
    assert.equal(rejected.headers.dav, '1')
  })

  await t.test('both unsupported DAV lock condition headers fail closed', async () => {
    const conditional = await request('if', 'DELETE', { If: '(<opaquelocktoken:fixture>)' })
    const lock = await request('lock', 'DELETE', { 'Lock-Token': '<opaquelocktoken:fixture>' })
    assert.deepEqual([conditional.status, lock.status], [501, 501])
    assert.equal((await request('if', 'GET')).text, bytes)
    assert.equal((await request('lock', 'GET')).text, bytes)
  })

  await t.test('libcurl independently sends a DAV method and preserves rejected bytes', async () => {
    const socket = join(dir, 'api.sock')
    const run = (...args) => spawnSync('/usr/bin/curl', ['-q', '--config', '-', '--unix-socket', socket,
      '--max-time', '5', '--silent', '--show-error', ...args, `http://localhost${uri('client')}`], {
      input: `header = "X-API-Key: ${account.key}"\n`, timeout: 6000, maxBuffer: 16384,
    })
    const refused = run('--output', '/dev/null', '--write-out', '%{http_code}', '--request', 'DELETE', '--header', `If-Unmodified-Since: ${stale}`)
    assert.equal(refused.status, 0)
    assert.equal(refused.stdout.toString('ascii'), '412')
    const beforeAndAfter = run('--header', 'Accept-Encoding: identity')
    assert.equal(beforeAndAfter.status, 0)
    assert.deepEqual(beforeAndAfter.stdout, Buffer.from(bytes, 'utf8'))
  })

  await t.test('a fresh date permits the intended mutation', async () => {
    const fresh = (await request('fresh', 'HEAD')).headers['last-modified']
    assert.match(fresh, /GMT$/)
    assert.equal((await request('fresh', 'DELETE', { 'If-Unmodified-Since': fresh })).status, 204)
    assert.equal((await request('fresh', 'GET')).status, 404)
  })
})
