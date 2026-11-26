// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const origin = 'http://127.0.0.1:8824'
const key = process.env.OPENVIKING_CLI_TEST_API_KEY
assert.ok(key && process.env.OPENVIKING_URL === origin && process.env.CLI_ADMITTED_PORT === '8824')
const sdk = pathToFileURL(resolve(process.env.CLI_PIN_SOURCE, '../typescript/dist/index.js'))
const { OpenVikingClient, OpenVikingError } = await import(sdk)
const uri = `viking://resources/client-ts-${randomUUID()}.txt`
const text = 'Fictional topaz lantern near the fjord. Écho.\n'
const query = 'topaz lantern fjord'
const message = 'Synthetic session note for the TypeScript SDK.'
const hash = value => createHash('sha256').update(value).digest('hex')
let wire = []
let failures = 0
const client = apiKey => new OpenVikingClient({ baseUrl: origin, apiKey, timeoutMs: 5000,
  async fetch(input, init = {}) {
    const url = new URL(input)
    assert.equal(url.origin, origin)
    const response = await fetch(url, { ...init, redirect: 'error' })
    const row = [init.method ?? 'GET', url.pathname, response.status]
    if (response.status >= 400) row.push((await response.clone().json()).error?.code)
    wire.push(row)
    return response
  },
})
const api = client(key)
const anonymous = client(undefined)

async function check(name, action) {
  wire = []
  try {
    const evidence = await action()
    console.log('SDK_NODE ' + JSON.stringify({ name, vote: 'pass', wire, evidence }))
  } catch (error) {
    ++failures
    console.log('SDK_NODE ' + JSON.stringify({ name, vote: 'fail', wire, error: error.name, code: error.code,
      diagnostic: error instanceof assert.AssertionError ? error.message : undefined }))
  }
}

async function rejects(action, status, code) {
  await assert.rejects(action, error => error instanceof OpenVikingError && error.statusCode === status && error.code === code)
  assert.deepEqual(wire.at(-1).slice(2), [status, code])
}

await check('health', async () => {
  assert.equal(await anonymous.health(), true)
  assert.deepEqual(wire, [['GET', '/health', 200]])
})
try {
  await check('filesystem', async () => {
    await rejects(() => api.stat(uri), 404, 'NOT_FOUND')
    await api.write(uri, text, { mode: 'create', wait: true })
    const meta = await api.stat(uri)
    assert.equal(meta.isDir, false)
    const actual = await api.read(uri)
    assert.equal(actual, text)
    assert.deepEqual(wire.slice(1), [['POST', '/api/v1/content/write', 200], ['GET', '/api/v1/fs/stat', 200],
      ['GET', '/api/v1/content/read', 200]])
    return { uri, bytes: Buffer.byteLength(actual), sha256: hash(actual) }
  })
  await check('search', async () => {
    const found = await api.find(query, { targetUri: 'viking://resources', limit: 5 })
    const hit = found.resources.find(row => row.uri === uri)
    assert.ok(hit && Number.isFinite(hit.score) && hit.score > 0)
    assert.deepEqual(wire, [['POST', '/api/v1/search/find', 200]])
    return { hit_uri: hit.uri, score: hit.score }
  })
  await check('optional-download', async () => {
    const bytes = await api.downloadBytes(uri)
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual(Buffer.from(bytes), Buffer.from(text))
    assert.deepEqual(wire, [['GET', '/api/v1/content/download', 200]])
    return { bytes: bytes.length, sha256: hash(bytes) }
  })
  await check('auth-denial', async () => {
    await rejects(() => anonymous.stat(uri), 401, 'UNAUTHENTICATED')
    assert.deepEqual(wire, [['GET', '/api/v1/fs/stat', 401, 'UNAUTHENTICATED']])
  })
} finally {
  await check('file-delete', async () => {
    await api.remove(uri, { wait: true })
    await rejects(() => api.stat(uri), 404, 'NOT_FOUND')
    assert.deepEqual(wire, [['DELETE', '/api/v1/fs', 200], ['GET', '/api/v1/fs/stat', 404, 'NOT_FOUND']])
  })
}
await check('session', async () => {
  const { session_id: id } = await api.createSession()
  assert.ok(typeof id === 'string' && id)
  const path = `/api/v1/sessions/${id}`
  try {
    assert.equal((await api.getSession(id)).session_id, id)
    await api.addMessage(id, { role: 'user', content: message })
    const ctx = await api.getSessionContext(id, 1000)
    assert.equal(ctx.messages.length, 1)
    assert.equal(ctx.messages[0].role, 'user')
    assert.equal(ctx.messages[0].parts[0].text, message)
  } finally {
    await api.deleteSession(id)
  }
  await rejects(() => api.getSession(id), 404, 'NOT_FOUND')
  assert.deepEqual(wire, [['POST', '/api/v1/sessions', 200], ['GET', path, 200], ['POST', `${path}/messages`, 200],
    ['GET', `${path}/context`, 200], ['DELETE', path, 200], ['GET', path, 404, 'NOT_FOUND']])
  return { session_id: id, message_text_sha256: hash(message) }
})
process.exitCode = failures ? 1 : 0
