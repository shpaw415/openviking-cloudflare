// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { api, localMcp, testPrincipal } from './mcp/local.mjs'

const alice = testPrincipal('mcp-one', 'alice', 'admin', 'main')
const bob = testPrincipal('mcp-one', 'bob')
const other = testPrincipal('mcp-two', 'alice', 'admin', 'main')
const principals = [alice, bob, other]
const accept = 'application/json, text/event-stream'
const version = '2025-11-25'
const init = { protocolVersion: version, clientInfo: { name: 'native-test', version: '1' }, capabilities: {} }

function rpc(send, method, params, { id = 4, headers = {}, path = '/mcp' } = {}) {
  return send(path, { method: 'POST', headers: { Accept: accept, ...headers }, body: {
    jsonrpc: '2.0', method, ...(params !== undefined && { params }), ...(id !== false && { id }),
  } })
}

test('MCP negotiates, requires authentication, and does not open a persistent stream', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read' })
  const send = api(worker, alice)
  const hello = await rpc(send, 'initialize', init, { id: 'hello' })
  assert.equal(hello.status, 200)
  assert.equal(hello.headers.get('mcp-session-id'), null)
  assert.equal(hello.headers.get('cache-control'), 'private, no-store')
  const data = await hello.json()
  assert.equal(data.id, 'hello')
  assert.equal(data.result.protocolVersion, version)
  assert.equal(data.result.serverInfo.name, 'openviking')
  assert.deepEqual(data.result.capabilities, { tools: { listChanged: false } })
  const ack = await rpc(send, 'notifications/initialized', undefined, { id: false, headers: { 'MCP-Protocol-Version': version } })
  assert.equal(ack.status, 202)
  assert.equal(await ack.text(), '')
  const sse = await rpc(send, 'ping', undefined, { path: '/mcp/', headers: { Accept: 'text/event-stream' } })
  assert.match(sse.headers.get('content-type'), /^text\/event-stream/u)
  assert.equal(await sse.text(), 'event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{}}\n\n')
  const unauth = await rpc(api(worker), 'initialize', init)
  assert.equal(unauth.status, 401)
  assert.match(unauth.headers.get('www-authenticate') ?? '', /^Bearer/u)
  assert.equal((await rpc(send, 'ping', undefined, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403)
  const get = await send('/mcp')
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST')
  const list = await (await rpc(send, 'tools/list')).json()
  assert.ok(list.result.tools.some(tool => tool.name === 'read' && tool.annotations.readOnlyHint))
  assert.ok(!list.result.tools.some(tool => tool.name === 'write'))
})

async function call(send, name, args = {}) {
  const response = await rpc(send, 'tools/call', { name, arguments: args })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.ok(body.result, JSON.stringify(body.error))
  return body.result
}

const textOf = result => result.content.map(block => block.text).join('\n')
const uriParam = uri => `?uri=${encodeURIComponent(uri)}`

test('MCP reads authorized text literally, and cannot read a different private user or tenant', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read' })
  const send = api(worker, alice)
  const uri = 'viking://~/resources/log.md'
  const content = 'notes\r\nA harbor and a boat\r\n'
  assert.equal((await send('/api/v1/content/write', { method: 'POST', body: { uri, content } })).status, 200)
  assert.equal(textOf(await call(send, 'read', { uri })), content)
  assert.equal(textOf(await call(send, 'read', { uris: [uri], offset: 1, limit: 1 })), 'A harbor and a boat\r\n')
  assert.match(textOf(await call(send, 'list', { uri: 'viking://~/resources' })), /\[file\] log\.md/u)
  assert.equal((await call(api(worker, bob), 'read', { uri: 'viking://user/alice/resources/log.md' })).isError, true)
  assert.equal((await call(api(worker, other), 'read', { uri })).isError, true)
  assert.equal((await call(send, 'write', { uri, content: 'must not replace' })).isError, true)
  assert.equal((await (await send('/api/v1/content/read' + uriParam(uri))).json()).result, content)
})

test('Named mutations publish to the filesystem only under read-write and honor shared ACL', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read-write' })
  const send = api(worker, alice), member = api(worker, bob)
  const uri = 'viking://resources/private-note.md'
  const acl = { acl_mode: 'restricted', entries: [] }
  const original = 'A boat near the harbor\nA boat near the harbor\n'
  assert.equal((await call(send, 'write', { uri, content: original, acl })).isError, undefined)
  assert.equal((await call(member, 'get_acl', { uri })).isError, true)
  assert.equal((await call(member, 'read', { uri })).isError, true)
  assert.equal((await call(member, 'write', { uri, content: 'not allowed' })).isError, true)
  assert.equal((await call(send, 'edit', { uri, old_string: 'boat', new_string: 'fleet' })).isError, true)
  assert.equal(textOf(await call(send, 'read', { uri })), original)
  assert.match(textOf(await call(send, 'edit', { uri, old_string: 'boat', new_string: '$fleet', replace_all: true })), /Edited/u)
  assert.equal(textOf(await call(send, 'read', { uri })), original.replaceAll('boat', '$fleet'))
  const listed = await call(send, 'get_acl', { uri })
  assert.deepEqual(listed.structuredContent.direct_entries, [])
  const readGrant = { acl_mode: 'restricted', entries: [{ principal: 'user:bob', level: 'read' }] }
  assert.notEqual((await call(send, 'set_acl', { uri, acl: readGrant })).isError, true)
  assert.equal(textOf(await call(member, 'read', { uri })), original.replaceAll('boat', '$fleet'))
  const folder = 'viking://resources/shared-folder'
  const aclForFolder = { acl_mode: 'restricted', entries: [{ principal: 'user:bob', level: 'manage' }] }
  assert.equal((await send('/api/v1/fs/mkdir', { method: 'POST', body: { uri: folder, acl: aclForFolder } })).status, 200)
  assert.equal((await call(member, 'forget', { uri: folder, recursive: true })).structuredContent.error.code, 'PERMISSION_DENIED')
  assert.equal((await send('/api/v1/fs/stat' + uriParam(folder))).status, 200)
  assert.match(textOf(await call(send, 'forget', { uri })), /^Deleted:/u)
  assert.equal((await send('/api/v1/content/read' + uriParam(uri))).status, 404)
})

test('MCP retrieval runs the Viking index, grep and glob under the same ACL', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read-write' })
  const send = api(worker, alice), member = api(worker, bob)
  const base = 'viking://resources'
  for (const [name, content, acl] of [
    ['sailing.md', 'a sailing voyage'], ['trees.md', 'trees and wood'], ['hidden.md', 'harbor private', { acl_mode: 'restricted', entries: [] }],
  ]) assert.notEqual((await call(send, 'write', { uri: `${base}/${name}`, content, acl })).isError, true)
  for (const name of ['find', 'search']) {
    const result = textOf(await call(member, name, { query: 'boat in harbor', target_uri: base, read_content: true }))
    assert.match(result, /sailing\.md[\s\S]*a sailing voyage/u)
    assert.doesNotMatch(result, /hidden\.md|trees\.md/u)
  }
  assert.match(textOf(await call(member, 'grep', { uri: base, pattern: ['sailing', '^trees'] })), /sailing\.md[\s\S]*trees\.md/u)
  assert.doesNotMatch(textOf(await call(member, 'glob', { uri: base, pattern: '*.md' })), /hidden/u)
  assert.match(textOf(await call(member, 'tree', { uri: base, limit: 1 })), /sailing\.md[\s\S]*more entries/u)
  assert.equal((await call(member, 'find', { query: 'harbor', events_time_decay_protection: 'permanent' })).structuredContent.error.code, 'NOT_IMPLEMENTED')
})

test('The MCP registry persists private and account catalogs and only invokes fixed read-only data tools', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read-write' })
  const send = api(worker, alice), member = api(worker, bob), tenant = api(worker, other)
  const root = '/api/v1/mcps'
  const url = 'viking://builtin/openviking-data'
  const post = (client, path, body) => client(root + path, { method: 'POST', body })
  const result = async (response, status = 200) => {
    assert.equal(response.status, status)
    return (await response.json()).result
  }
  const valid = await result(await post(send, '/validate', { name: 'notes', url }))
  assert.equal(valid.valid, true)
  assert.equal((await post(send, '', { name: 'remote', url: 'https://example.invalid/mcp' })).status, 403)
  assert.equal((await post(send, '', { name: 'with-header', url, headers: { 'X-Test': 'fixture' } })).status, 403)
  await result(await post(send, '', { name: 'notes', url }))
  assert.equal((await post(send, '', { name: 'notes', url })).status, 409)
  const shared = { name: 'common', url, target_uri: 'viking://agent/tools' }
  assert.equal((await post(member, '', shared)).status, 403)
  await result(await post(send, '', shared))
  const listed = await result(await member(root))
  assert.deepEqual(listed.servers.map(server => server.name), ['common'])
  assert.equal((await result(await tenant(root))).total, 0)
  assert.equal((await member(root + '/notes?target_uri=viking%3A%2F%2Fuser%2Falice%2Ftools')).status, 403)
  const tools = (await result(await send(root + '/notes'))).tools
  assert.ok(tools.every(item => item.tool.annotations.readOnlyHint && /^[a-f0-9]{64}$/u.test(item.revision)))
  const healthUri = tools.find(item => item.tool.name === 'health').uri
  assert.match(textOf(await result(await post(send, '/invoke', { uri: healthUri }))), /SQLite/u)
  assert.equal((await post(member, '/invoke', { uri: healthUri })).status, 403)
  assert.equal((await post(send, '/invoke', { uri: healthUri.replace('health.json', 'write.json') })).status, 404)
  assert.equal((await result(await send(root + '/status?name=notes'))).status, 'running')
  assert.equal((await result(await post(send, '/notes/sync', {}))).changes.unchanged.length, valid.tool_count)
  assert.ok((await result(await post(send, '/find', { query: 'read stored text' }))).tools.some(item => item.name === 'read'))
  assert.equal((await send(root + '/notes', { method: 'DELETE' })).status, 200)
  assert.equal((await post(send, '/invoke', { uri: healthUri })).status, 404)
  assert.equal((await post(send, '/mount', {})).status, 501)
})

test('Per-user add locations are applied to named staged uploads and can be removed', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read-write' })
  const send = api(worker, alice), member = api(worker, bob), tenant = api(worker, other)
  const settings = '/api/v1/user-settings/add-locations'
  const location = 'viking://~/resources/inbox'
  assert.equal((await send('/api/v1/fs/mkdir', { method: 'POST', body: { uri: location } })).status, 200)
  const patch = await send(settings, { method: 'PATCH', body: { resource_uri: location } })
  assert.equal(patch.status, 200)
  const setting = await patch.json()
  assert.equal(setting.result.effective.resource_uri, 'viking://user/alice/resources/inbox')
  assert.deepEqual((await (await member(settings)).json()).result.override, {})
  assert.deepEqual((await (await tenant(settings)).json()).result.override, {})
  const boundary = 'mcp-local-staging-boundary'
  const form = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="staged.md"', 'Content-Type: text/plain',
    '', 'A harbor log.', `--${boundary}--`, ''].join('\r\n')
  const upload = await send('/api/v1/resources/temp_upload', { method: 'POST', body: form,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } })
  assert.equal(upload.status, 200)
  const temp_file_id = (await upload.json()).result.temp_file_id
  assert.equal((await call(member, 'add_resource', { temp_file_id })).isError, true)
  assert.match(textOf(await call(send, 'add_resource', { temp_file_id })), /inbox\/staged\.md/u)
  assert.equal(textOf(await call(send, 'read', { uri: `${location}/staged.md` })), 'A harbor log.')
  assert.equal((await call(send, 'add_resource', { path: 'https://example.invalid/doc.md' })).structuredContent.error.code, 'NOT_IMPLEMENTED')
  assert.equal((await send(settings, { method: 'PATCH', body: { resource_uri: 'viking://user/bob/resources' } })).status, 403)
  assert.equal((await send(settings, { method: 'DELETE' })).status, 200)
  assert.deepEqual((await (await send(settings)).json()).result.override, {})
})

test('Asset resolution joins flat YAML catalog inputs without calling or probing the source', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, vectors: false })
  const send = api(worker, alice), base = '/api/v1/openviking-assets'
  const manifest_yaml = 'assets: [manual]\n'
  const catalog_yaml = `protocol: openviking-assets/1
defaults:
  git:
    auth_ref: repo-reader
    watch_interval: 1440
catalog:
- name: manual
  connector: git
  to: "viking://~/resources/Reference"
  params:
    repo_url: https://Example.invalid/catalog/manual.git
    branch: main
`
  const post = (name, body) => send(`${base}/${name}`, { method: 'POST', body })
  const response = await post('resolve', { manifest_yaml, catalog_yaml, manifest_label: 'plan.yml', catalog_label: 'catalog.yml' })
  assert.equal(response.status, 200)
  const expectedId = createHash('sha1').update('git\nexample.invalid/catalog/manual\nmain').digest('hex').slice(0, 12)
  assert.deepEqual((await response.json()).result, { protocol: 'openviking-assets/1', manifest: 'plan.yml', catalog: 'catalog.yml', assets: [{
    name: 'manual', connector: 'git', to: 'viking://user/alice/resources/Reference', repo_url: 'https://Example.invalid/catalog/manual.git',
    branch: 'main', commit: null, auth_ref: 'repo-reader', watch_interval: 1440, locator: 'example.invalid/catalog/manual', git_ref: 'main', asset_id: expectedId,
  }] })
  assert.equal((await send('/api/v1/fs/stat' + uriParam('viking://~/resources/Reference'))).status, 404)
  assert.equal((await post('resolve', { manifest_yaml: `${manifest_yaml}include: [other.yml]\n`, catalog_yaml })).status, 400)
  assert.equal((await post('resolve', { manifest_yaml, catalog_yaml: catalog_yaml.replace('defaults:', 'defaults: &preset') })).status, 400)
  assert.equal((await post('resolve', { manifest_yaml, catalog_yaml: catalog_yaml.replace('~/resources', 'user/bob/resources') })).status, 403)
  assert.equal((await post('preflight', { name: 'manual', connector: 'git', repo_url: 'https://example.invalid/catalog/manual.git' })).status, 501)
})

test('Only a named call with an RPC id can mutate data; disabled MCP fails closed', { timeout: 15_000 }, async t => {
  const disabled = await localMcp(t, { principals, mode: 'not-configured', vectors: false })
  const disabledClient = api(disabled, alice)
  assert.equal((await rpc(disabledClient, 'initialize', init, { headers: { 'X-Test-Mcp-Mode': 'read-write' } })).status, 503)
  assert.equal((await disabledClient('/api/v1/mcps')).status, 503)

  const worker = await localMcp(t, { principals, mode: 'read-write', vectors: false })
  const send = api(worker, alice)
  const uri = 'viking://~/resources/explicit.md'
  const params = { name: 'write', arguments: { uri, content: 'authored text', defer_processing: true } }
  const missingFile = async () => assert.equal((await send('/api/v1/content/read' + uriParam(uri))).status, 404)
  assert.equal((await rpc(send, 'tools/call', params, { id: false })).status, 202)
  await missingFile()
  assert.equal((await rpc(send, 'tools/call', params, { id: null })).status, 400)
  const body = [{ jsonrpc: '2.0', id: 42, method: 'tools/call', params }]
  assert.equal((await send('/mcp', { method: 'POST', body })).status, 400)
  await missingFile()
  assert.equal((await rpc(send, 'tools/call', params, { headers: { 'MCP-Protocol-Version': '0' } })).status, 400)
  assert.equal((await rpc(send, 'tools/call', params, { headers: { Accept: 'text/plain' } })).status, 406)
  await missingFile()
  assert.notEqual((await call(send, 'write', params.arguments)).isError, true)
  assert.equal(textOf(await call(send, 'read', { uri })), params.arguments.content)
  assert.equal((await call(send, 'find', { query: 'harbor' })).structuredContent.error.code, 'EMBEDDING_UNAVAILABLE')
  assert.equal((await call(send, 'invoke_mcp_tool', { name: 'health' })).isError, true)
})

test('Inline skills are stored as data in the configured root, never a request to fetch an external skill', { timeout: 15_000 }, async t => {
  const worker = await localMcp(t, { principals, mode: 'read-write' })
  const send = api(worker, alice), member = api(worker, bob), outsider = api(worker, other)
  const skill_uri = 'viking://agent/skills'
  const settings = '/api/v1/user-settings/add-locations'
  const patch = client => client(settings, { method: 'PATCH', body: { skill_uri } })
  assert.equal((await patch(member)).status, 403)
  const changed = await patch(send)
  assert.equal(changed.status, 200)
  assert.equal((await changed.json()).result.effective.skill_uri, skill_uri)
  const data = '---\nname: mcp-log\ndescription: A fictional harbor log.\n---\n\n# Harbor log\n'
  assert.match(textOf(await call(send, 'add_skill', { data })), /mcp-log/u)
  const uri = `${skill_uri}/mcp-log/SKILL.md`
  assert.match(textOf(await call(member, 'read', { uri })), /Harbor log/u)
  assert.equal((await call(outsider, 'read', { uri })).isError, true)
  assert.equal((await call(send, 'add_skill', { path: 'https://example.invalid/skill' })).structuredContent.error.code, 'NOT_IMPLEMENTED')
  assert.equal((await send(settings, { method: 'DELETE' })).status, 200)
  assert.deepEqual((await (await send(settings)).json()).result.override, {})
})

test('Registry and user add locations survive a fresh workerd on the same disposable SQLite storage', { timeout: 20_000 }, async t => {
  const persist = await mkdtemp(join(tmpdir(), 'ov-mcp-test-'))
  try {
    await t.test('initialize persistent SQLite', async sub => {
      const worker = await localMcp(sub, { principals, mode: 'read-write', vectors: false, persist })
      const send = api(worker, alice)
      assert.equal((await send('/api/v1/mcps', { method: 'POST', body: { name: 'persistent', url: 'viking://builtin/openviking-data' } })).status, 200)
      assert.equal((await send('/api/v1/user-settings/add-locations', { method: 'PATCH', body: { resource_uri: 'viking://~/resources' } })).status, 200)
    })
    await t.test('reopen read-only', async sub => {
      const worker = await localMcp(sub, { principals, mode: 'read', vectors: false, persist })
      const send = api(worker, alice)
      assert.equal((await (await send('/api/v1/mcps')).json()).result.servers[0].name, 'persistent')
      assert.equal((await send('/api/v1/mcps/persistent', { method: 'DELETE' })).status, 403)
      assert.equal((await (await send('/api/v1/user-settings/add-locations')).json()).result.override.resource_uri, 'viking://user/alice/resources')
    })
  } finally { await rm(persist, { recursive: true, force: true }) }
})
