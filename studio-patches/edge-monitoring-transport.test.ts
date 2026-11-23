// @vitest-environment jsdom
import { fetchEdgeFeatures } from '#/shared/lib/edge-capabilities'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('never starts a capability request outside the Edge base URL guard', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const { hostname, host, origin, port, protocol } = window.location
  const signal = new AbortController().signal
  for (const base of [
    'https://other.invalid',
    `${protocol}//${hostname}:${port === '4444' ? '4445' : '4444'}`,
    `${protocol === 'https:' ? 'http:' : 'https:'}//${host}`,
    `${protocol}//fixture:fixture@${host}/`,
    `${origin}/nested`,
    `${origin}/?query=fixture`,
    `${origin}/#fragment`,
  ]) {
    await expect(fetchEdgeFeatures(base, 'synthetic-workspace', signal)).resolves.toEqual({})
  }
  await expect(fetchEdgeFeatures(origin, '', signal)).resolves.toEqual({})
  expect(fetch).not.toHaveBeenCalled()
})

it('permits the same-origin Access cookie without redirects, caching or a different key', async () => {
  const fetch = vi.fn(async (url: URL, options: RequestInit) => {
    const request = new Request(url, options)
    expect(request.url).toBe(`${window.location.origin}/api/v1/system/edge-capabilities`)
    expect(request.method).toBe('GET')
    expect(request.credentials).toBe('same-origin')
    expect(request.redirect).toBe('error')
    expect(request.cache).toBe('no-store')
    expect(Object.fromEntries(request.headers)).toEqual({
      accept: 'application/json',
      'x-api-key': 'synthetic-workspace',
    })
    return Response.json({ status: 'ok', result: { features: { monitoring: true } } })
  })
  vi.stubGlobal('fetch', fetch)
  const timeout = vi.spyOn(AbortSignal, 'timeout')
  const caller = new AbortController()
  await expect(fetchEdgeFeatures(window.location.origin, 'synthetic-workspace', caller.signal)).resolves.toEqual({ monitoring: true })
  expect(fetch).toHaveBeenCalledOnce()
  expect(timeout).toHaveBeenCalledExactlyOnceWith(8000)
  const requestSignal = fetch.mock.calls[0][1].signal
  expect(requestSignal?.aborted).toBe(false)
  caller.abort()
  expect(requestSignal?.aborted).toBe(true)
})
