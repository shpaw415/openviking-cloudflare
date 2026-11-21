// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { edgeAllowsPage, fetchEdgeFeatures, readEdgeFeatures } from '#/shared/lib/edge-capabilities'
import { importOvpack, isOvpackFile } from '#/features/workbench/filesystem/lib/data-management'
import type { OvClientAdapter } from '#/shared/api/ov-client/types'

afterEach(() => vi.unstubAllGlobals())

it('never treats links, truthy values or a 200 without the envelope as capabilities', () => {
  expect(readEdgeFeatures({ status: 'ok', result: { links: ['/studio/admin'], features: { control: 'true', bot: 1, packExport: true, packImport: false, unknown: true } } })).toEqual({ packExport: true })
  expect(readEdgeFeatures({ features: { control: true } })).toEqual({})
  expect(readEdgeFeatures({ status: 'error', result: { features: { control: true } } })).toEqual({})
  expect(edgeAllowsPage('/admin/users/', { control: true }, false)).toBe(false)
  expect(edgeAllowsPage('/admin/users/', { control: true }, true)).toBe(true)
  expect(edgeAllowsPage('/admin/users/memory-templates', { control: true }, true)).toBe(false)
  expect(edgeAllowsPage('/vikingbot', {}, false)).toBe(false)
  expect(edgeAllowsPage('/vikingbot', { bot: true }, false)).toBe(true)
})

it('reads flags with just the selected key, no redirects or third-party HTTP', async () => {
  const fetch = vi.fn(async () => Response.json({ status: 'ok', result: { features: { control: true } } }))
  vi.stubGlobal('fetch', fetch)
  const signal = new AbortController().signal
  expect(await fetchEdgeFeatures('https://outside.invalid', 'synthetic-key', signal)).toEqual({})
  expect(fetch).not.toHaveBeenCalled()
  expect(await fetchEdgeFeatures(window.location.origin, 'synthetic-key', signal)).toEqual({ control: true })
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith(new URL('/api/v1/system/edge-capabilities', window.location.origin), expect.objectContaining({
    headers: { 'X-API-Key': 'synthetic-key', Accept: 'application/json' }, redirect: 'error', cache: 'no-store', credentials: 'omit',
  }))
  fetch.mockResolvedValueOnce(new Response(null, { status: 501 }))
  expect(await fetchEdgeFeatures(window.location.origin, 'synthetic-key', signal)).toEqual({})
})

it('requires an archive extension, a compatible MIME type when provided, and nonempty content', () => {
  expect(isOvpackFile(new File(['fixture'], 'folder.ovpack', { type: 'application/zip' }))).toBe(true)
  expect(isOvpackFile(new File(['fixture'], 'folder.ovpack'))).toBe(true)
  expect(isOvpackFile(new File(['fixture'], 'folder.ovpack', { type: 'text/plain' }))).toBe(false)
  expect(isOvpackFile(new File(['fixture'], 'folder.zip', { type: 'application/zip' }))).toBe(false)
  expect(isOvpackFile(new File([], 'folder.ovpack'))).toBe(false)
})

it('stages only in the pack endpoint, imports by returned id, and never falls back to text upload', async () => {
  const post = vi.fn()
  const source = { client: { post } } as unknown as OvClientAdapter
  const signal = new AbortController().signal
  const valid = new File(['synthetic fixture'], 'example.ovpack', { type: 'application/zip' })
  const uri = 'viking://resources/example'
  post.mockResolvedValueOnce({ status: 200, headers: {}, data: { status: 'ok', result: { temp_file_id: 'fixture-id' } } })
  post.mockResolvedValueOnce({ status: 200, headers: {}, data: { status: 'ok', result: { uri } } })
  await expect(importOvpack(source, 'viking://resources/', valid, 'fail', signal)).resolves.toEqual({ uri })
  expect(post.mock.calls.map(([args]) => args.url)).toEqual(['/api/v1/pack/temp_upload', '/api/v1/pack/import'])
  expect(post.mock.calls[0][0].body.get('file')).toBe(valid)
  expect(post.mock.calls[1][0].body).toMatchObject({ temp_file_id: 'fixture-id', parent: 'viking://resources/' })
  post.mockReset()
  post.mockRejectedValueOnce(new Error('fixture upload failed'))
  await expect(importOvpack(source, 'viking://resources/', valid, 'fail', signal)).rejects.toBeDefined()
  expect(post).toHaveBeenCalledOnce()
})
