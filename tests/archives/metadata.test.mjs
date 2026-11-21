// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, principal } from '../control/harness.mjs'
import { recordBundle } from './receipt.mjs'

test('snapshot revision metadata is authorized separately from readable content', async t => {
  const owner = principal('metadata-fixture', 'owner', 'admin')
  const editor = principal('metadata-fixture', 'editor')
  const { send, dir } = await harness(t, [owner, editor], { production: true })
  await recordBundle(t, dir)
  const project = 'viking://resources/notes', note = `${project}/readme.md`
  const sibling = 'viking://resources/internal.md', extra = `${project}/extra.md`
  const request = (actor, path, method, body) => send(path, { key: actor.key, method, body })
  const snap = (actor, action, query, method, body) => request(actor,
    `/api/v1/snapshot/${action}?${new URLSearchParams(query)}`, method, body)
  const ok = response => {
    assert.equal(response.status, 200, response.json?.error?.code)
    return response.json.result
  }
  const write = (uri, content, mode = 'create') => request(owner, '/api/v1/content/write', 'POST', {
    uri, content, mode, defer_processing: true,
  }).then(ok)
  const commit = (message, ...paths) => snap(owner, 'commit', {}, 'POST', { paths, message }).then(ok)
  const show = (actor, ref, method = 'GET') => snap(actor, 'show', { path: note, target_ref: ref }, method)
  const restore = (actor, body) => snap(actor, 'restore', {}, 'POST', body).then(ok)

  ok(await request(owner, '/api/v1/fs/mkdir', 'POST', { uri: project,
    acl: { entries: [{ principal: 'user:editor', level: 'manage' }] } }))
  await write(note, 'public v1\n')
  const first = (await commit('first', note)).commit_oid
  await write(sibling, 'restricted fixture v1')
  ok(await request(owner, '/api/v1/acl', 'PUT', { uri: sibling, acl_mode: 'restricted', entries: [] }))
  const hidden = (await commit('restricted one', sibling)).commit_oid
  await write(note, 'public v2\n', 'replace')
  const visible = (await commit('second public', note)).commit_oid
  await write(sibling, 'restricted fixture v2', 'replace')
  const hiddenHead = (await commit('restricted two', sibling)).commit_oid

  await t.test('show and HEAD keep the readable blob and omit restricted revision headers', async () => {
    const full = await show(owner, 'main')
    assert.equal(full.status, 200)
    assert.equal(full.headers['x-snapshot-commit-oid'], hiddenHead)
    assert.match(full.headers['x-snapshot-time-seconds'], /^\d+$/)
    const publicVersion = await show(editor, visible)
    assert.equal(publicVersion.headers['x-snapshot-commit-oid'], visible)
    assert.match(publicVersion.headers['x-snapshot-time-seconds'], /^\d+$/)
    for (const method of ['GET', 'HEAD']) {
      const scoped = await show(editor, 'main', method)
      assert.equal(scoped.status, 200)
      assert.equal(scoped.text, method === 'GET' ? 'public v2\n' : '')
      assert.equal(scoped.headers['x-snapshot-oid'], full.headers['x-snapshot-oid'])
      assert.equal(scoped.headers['x-snapshot-size'], '10')
      for (const key of ['x-snapshot-commit-oid', 'x-snapshot-time-seconds']) {
        assert.equal(Object.hasOwn(scoped.headers, key), false, key)
      }
    }
    assert.equal((await snap(editor, 'show', { path: sibling, target_ref: 'main' })).status, 403)
  })

  await t.test('diff keeps the file delta and applies authorization to each reference independently', async () => {
    const diff = async (from, to) => ok(await snap(editor, 'diff', { path: note, ...(from && { from }), to }))
    const olderVisible = await diff(first, 'main')
    assert.equal(olderVisible.from_commit, first)
    assert.equal(olderVisible.change_type, 'modified')
    assert.match(olderVisible.diff_text, /-public v1\n\+public v2/)
    const baseEmpty = await diff(undefined, visible)
    assert.equal(baseEmpty.from_commit, '')
    assert.equal(baseEmpty.to_commit, visible)
    const newerVisible = await diff(hidden, visible)
    assert.equal(newerVisible.to_commit, visible)
    assert.equal(newerVisible.diff_text, olderVisible.diff_text)
    const noMetadata = await diff(hidden, 'main')
    assert.equal(noMetadata.diff_text, olderVisible.diff_text)
    assert.deepEqual([Object.hasOwn(olderVisible, 'to_commit'), Object.hasOwn(newerVisible, 'from_commit'),
      Object.hasOwn(noMetadata, 'from_commit'), Object.hasOwn(noMetadata, 'to_commit')], [false, false, false, false])
  })

  await t.test('log and versions omit a restricted parent without inventing a new link', async () => {
    for (const [action, query] of [['log', { paths: note }], ['versions', { uri: note }]]) {
      const adminList = ok(await snap(owner, action, query)), editorList = ok(await snap(editor, action, query))
      const adminRows = adminList.versions ?? adminList, editorRows = editorList.versions ?? editorList
      assert.deepEqual(editorRows.map(row => row.oid), [visible, first])
      assert.deepEqual(adminRows[0].parents, [hidden])
      assert.equal(editorRows[0].parents.length, 0)
    }
  })

  await t.test('restore plans and summaries preserve the authorized operation without restricted references', async () => {
    const dry = { project_dir: project, source_commit: hidden, dry_run: true }
    const preview = await restore(editor, dry)
    assert.equal(preview.result, 'dry_run')
    assert.deepEqual(preview.diff.to_write.map(item => item.path), ['readme.md'])
    const full = await restore(owner, dry)
    assert.equal(full.head, hiddenHead)
    assert.equal(full.source, hidden)
    const noop = await restore(editor, { project_dir: project, source_commit: 'main' })
    assert.equal(noop.result, 'noop')

    await write(extra, 'public new file\n')
    await write(sibling, 'restricted fixture v3', 'replace')
    const mixed = (await commit('mixed changes', extra, sibling)).commit_oid
    const single = { path: extra, restore_commit_id: mixed }
    const singleDry = await restore(editor, { ...single, dry_run: true, current_commit_id: mixed })
    const singleNoop = await restore(editor, single)
    assert.equal(singleDry.result, 'dry_run')
    assert.equal(singleNoop.result, 'noop')
    assert.equal((await restore(owner, single)).snapshot_id, mixed)
    const applied = await restore(editor, { project_dir: project, source_commit: hiddenHead })
    assert.equal(applied.result, 'applied')
    assert.deepEqual(applied.deleted_paths, ['resources/notes/extra.md'])
    const read = uri => request(editor, `/api/v1/content/read?${new URLSearchParams({ uri })}`)
    assert.equal((await read(extra)).status, 404)
    assert.equal(ok(await read(note)), 'public v2\n')
    assert.deepEqual([
      ...['head', 'source'].flatMap(key => [Object.hasOwn(preview, key), Object.hasOwn(noop, key)]),
      Object.hasOwn(singleDry, 'snapshot_id'), Object.hasOwn(singleNoop, 'snapshot_id'),
      ...['source_commit', 'parent_commit', 'new_commit_oid'].map(key => Object.hasOwn(applied, key)),
    ], Array(9).fill(false))
  })
})
