// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axios from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EdgeFeatureProvider } from '#/features/connection/hooks/use-edge-features'
import { AddResourceForm } from '#/features/workbench/resources/components/add-resource-page'
import { ResourceUploadProvider } from '#/features/workbench/resources/hooks/use-resource-upload'
import { client as sdkClient } from '#/gen/ov-client/client.gen'
import { ovClient } from '#/shared/api/ov-client/index'

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const baseUrl = window.location.origin
const path = 'https://documents.fixture.test/compass.md'
const uri = 'viking://user/reader/resources/compass.md'
const id = '9b78dc8e-b81f-49c4-ac87-ab2c1fd008ea'
const taskRoute = `/api/v1/tasks/${id}`
const first = { accountId: 'fixture', userId: 'reader', baseUrl, serviceSelection: 'opensource' as const, apiKey: 'synthetic-one', adminApiKey: '' }
const next = { ...first, apiKey: 'synthetic-two' }
const original = { options: ovClient.getOptions(), connection: ovClient.getConnection(), global: axios.defaults.adapter,
  instance: ovClient.instance.defaults.adapter, sdk: sdkClient.getConfig().adapter }

function capability(flag: unknown) {
  return Response.json({ status: 'ok', result: { features: { urlImport: flag } } })
}

function adapters(adapter: AxiosAdapter) {
  axios.defaults.adapter = adapter
  ovClient.instance.defaults.adapter = adapter
  sdkClient.setConfig({ adapter })
}

function workspace(connection = first) {
  ovClient.setOptions({ baseUrl, apiKeyAuth: 'header' })
  ovClient.setConnection(connection)
}

function harness(onCompleted = vi.fn(), onSubmitted = vi.fn(), onShowTasks = vi.fn()) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (connection = first, management = false, open = true) => <QueryClientProvider client={query}>
    <EdgeFeatureProvider connection={connection} management={management} enabled>
      <ResourceUploadProvider key={connection.apiKey} enabled={false}>
        {open && <AddResourceForm onCompleted={onCompleted} onSubmitted={onSubmitted} onShowTasks={onShowTasks} />}
      </ResourceUploadProvider>
    </EdgeFeatureProvider>
  </QueryClientProvider>
}

const label = (name: string) => `studio:edge.urlImport${name}`
const action = (name: string) => screen.getByRole('button', { name: label(name) })
const sourceInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'remoteUrl' })
const targetInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'targetUri' })
const change = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } })
const ok = (config: InternalAxiosRequestConfig, result: unknown) => ({ data: { status: 'ok', result }, status: 200, statusText: 'OK', headers: {}, config })
const accepted = (root_uri = uri) => ({ status: 'accepted', root_uri, task_id: id })
const task = (status: string, root_uri = uri, result: unknown = { status: 'success', root_uri }) =>
  ({ task_id: id, task_type: 'add_resource', resource_id: root_uri, status, result })
const route = (config: InternalAxiosRequestConfig) => new URL(config.url!, baseUrl).pathname
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function switchToUrl() {
  fireEvent.click(screen.getByRole('button', { name: 'mode.remote' }))
}
function submitUrl(destination?: string) {
  switchToUrl()
  change(sourceInput(), path)
  if (destination) change(targetInput(), destination)
  fireEvent.click(action('Action'))
}

beforeEach(() => workspace())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  axios.defaults.adapter = original.global
  ovClient.instance.defaults.adapter = original.instance
  sdkClient.setConfig({ adapter: original.sdk })
  ovClient.setOptions(original.options)
  ovClient.setConnection(original.connection)
  vi.clearAllMocks()
})

it.each([undefined, false, 'true'])('keeps the stock local-file mode only for %s', async flag => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(flag)))
  render(harness()())
  expect(await screen.findByText('studio:edge.textUploadOnly')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'mode.remote' })).toBeNull()
  expect(document.querySelector('input[type="file"]')).toBeTruthy()
})

it('uses the stock API and job polling, with no premature success or upload fallback', async () => {
  const fetchCapabilities = vi.fn(async () => capability(true))
  vi.stubGlobal('fetch', fetchCapabilities)
  const gate = deferred()
  const completed = vi.fn(), submitted = vi.fn(), calls: string[] = []
  const bodies: unknown[] = []
  adapters(async config => {
    const url = new URL(config.url!, baseUrl)
    expect(url.origin).toBe(baseUrl)
    expect(config.headers.get('x-api-key')).toBe(first.apiKey)
    calls.push(`${config.method} ${url.pathname}`)
    if (url.pathname === '/api/v1/resources') {
      bodies.push(JSON.parse(config.data))
      await gate.promise
      return ok(config, accepted())
    }
    expect(url.pathname).toBe(taskRoute)
    return ok(config, task('completed'))
  })
  render(harness(completed, submitted)())
  await screen.findByRole('button', { name: 'mode.remote' })
  expect(fetchCapabilities.mock.calls).toHaveLength(1)
  submitUrl()
  expect(await screen.findByText(label('Submitting'))).toBeTruthy()
  expect(screen.queryByText(label('Done'))).toBeNull()
  expect(screen.queryByText('sourcePicker.title')).toBeNull()
  expect(screen.queryByText('watch.enabled')).toBeNull()
  expect(submitted).not.toHaveBeenCalled()
  await act(async () => gate.resolve())
  expect(await screen.findByText(label('Done'))).toBeTruthy()
  expect(screen.getByText(uri)).toBeTruthy()
  await waitFor(() => expect(completed).toHaveBeenCalledTimes(1))
  expect(calls).toContain('post /api/v1/resources')
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskRoute}`])
  expect(bodies).toEqual([{ path, parent: 'viking://~/resources', wait: false, processing_mode: 'vectors_only', telemetry: true }])
})

it('reports a source refusal and does not fall back to an upload', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const adapter = vi.fn<AxiosAdapter>(async config => {
    expect(new URL(config.url!, baseUrl).pathname).toBe('/api/v1/resources')
    expect(JSON.parse(config.data).parent).toBe('viking://~/resources/guides')
    const response = { data: { status: 'error', error: { code: 'SOURCE_UNAVAILABLE', message: 'Source not approved.' } }, status: 503, statusText: 'Unavailable', headers: {}, config }
    throw new axios.AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, undefined, response)
  })
  adapters(adapter)
  render(harness()())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl('viking://~/resources/guides')
  expect((await screen.findByRole('alert')).textContent).toBe(label('Source'))
  expect(sourceInput().getAttribute('aria-invalid')).toBe('true')
  expect(sourceInput().getAttribute('aria-describedby')).toContain('add-resource-remote-error')
  expect(document.activeElement).toBe(sourceInput())
  expect(sourceInput().value).toBe(path)
  expect(targetInput().value).toBe('viking://~/resources/guides')
  expect(screen.queryByText(label('Done'))).toBeNull()
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('F2-H01: an explicit admission refusal preserves the draft, resets consent, and is not a task to recover', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const calls: string[] = []
  const bodies: unknown[] = []
  adapters(async config => {
    calls.push(`${config.method} ${route(config)}`)
    if (config.method !== 'post') return ok(config, task('completed'))
    bodies.push(JSON.parse(config.data))
    if (bodies.length > 1) return ok(config, accepted())
    throw new axios.AxiosError('admission unavailable', 'ERR_BAD_RESPONSE', config, undefined, {
      data: { status: 'error', error: { code: 'AUTH_UNAVAILABLE', message: 'Worker diagnostic' } },
      status: 503, statusText: 'Unavailable', headers: {}, config,
    })
  })
  const completed = vi.fn()
  render(harness(completed)())
  await screen.findByRole('button', { name: 'mode.remote' })
  switchToUrl()
  change(sourceInput(), path)
  fireEvent.click(screen.getByRole('radio', { name: 'destination.exact' }))
  change(targetInput(), uri)
  const consent = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /urlImportExactConsent.*compass.md/ })
  fireEvent.click(consent())
  fireEvent.click(action('ExactAction'))
  expect((await screen.findByRole('alert')).textContent).toBe(label('AuthorityRefused'))
  expect(screen.queryByText('Worker diagnostic')).toBeNull()
  expect(screen.queryByText(label('Unknown'))).toBeNull()
  expect(screen.queryByRole('button', { name: label('Verify') })).toBeNull()
  expect(screen.queryByRole('button', { name: label('ShowTasks') })).toBeNull()
  expect(calls).toEqual(['post /api/v1/resources'])
  expect(sourceInput().value).toBe(path)
  expect(targetInput().value).toBe(uri)
  expect(sourceInput().disabled).toBe(false)
  expect(targetInput().disabled).toBe(false)
  expect(consent().checked).toBe(false)
  fireEvent.click(action('ExactAction'))
  expect(calls).toEqual(['post /api/v1/resources'])
  fireEvent.click(consent())
  fireEvent.click(action('ExactAction'))
  await screen.findByText(label('Done'))
  expect(calls).toEqual(['post /api/v1/resources', 'post /api/v1/resources', `get ${taskRoute}`])
  expect(bodies).toEqual([
    expect.objectContaining({ path, to: uri, wait: false }),
    expect.objectContaining({ path, to: uri, wait: false }),
  ])
  expect(completed).toHaveBeenCalledTimes(1)
})

it('F2-H01: a generic 503 is still an ambiguous submission, with no repeat POST', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const adapter = vi.fn<AxiosAdapter>(async config => {
    throw new axios.AxiosError('unavailable', 'ERR_BAD_RESPONSE', config, undefined, {
      data: { status: 'error', error: { code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' } },
      status: 503, statusText: 'Unavailable', headers: {}, config,
    })
  })
  adapters(adapter)
  render(harness()())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  expect((await screen.findByRole('alert')).textContent).toBe(label('Unknown'))
  expect(screen.queryByText(label('AuthorityRefused'))).toBeNull()
  expect(screen.queryByRole('button', { name: label('Action') })).toBeNull()
  expect(screen.getByRole('button', { name: label('ShowTasks') })).toBeTruthy()
  expect(adapter.mock.calls.map(([c]) => `${c.method} ${route(c)}`)).toEqual(['post /api/v1/resources'])
})

it('drops stale capability and import replies when the data key is edited', async () => {
  const delayed = deferred<Response>()
  const probe = vi.fn((_input: URL, init: RequestInit) => {
    const key = new Headers(init.headers).get('x-api-key')
    return key === first.apiKey ? delayed.promise : Promise.resolve(capability(false))
  })
  vi.stubGlobal('fetch', probe)
  const mount = harness()
  const view = render(mount())
  expect(screen.getByText('studio:edge.urlImportChecking')).toBeTruthy()
  workspace(next)
  view.rerender(mount(next))
  await act(async () => delayed.resolve(capability(true)))
  expect(probe.mock.calls[0][1].signal?.aborted).toBe(true)
  expect(await screen.findByText('studio:edge.textUploadOnly')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'mode.remote' })).toBeNull()
  view.unmount()

  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const write = deferred()
  const transport = vi.fn<AxiosAdapter>(async config => {
    await write.promise
    return ok(config, accepted())
  })
  adapters(transport)
  workspace()
  const completed = vi.fn(), secondMount = harness(completed), second = render(secondMount())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  await waitFor(() => expect(transport).toHaveBeenCalledTimes(1))
  workspace(next)
  second.rerender(secondMount(next))
  expect(transport.mock.calls[0][0].signal?.aborted).toBe(true)
  await act(async () => write.resolve())
  expect(completed).not.toHaveBeenCalled()
  expect(screen.queryByText(label('Done'))).toBeNull()
  expect(transport).toHaveBeenCalledTimes(1)
})

it('H01: exact destination requires explicit consent, renewed after editing the path or the source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const requests: unknown[] = []
  let saved = 'original synthetic content'
  adapters(async config => {
    if (config.method === 'post') {
      requests.push(JSON.parse(config.data))
      saved = 'replacement synthetic content'
      return ok(config, accepted())
    }
    return ok(config, task('completed'))
  })
  const mount = harness()
  const view = render(mount())
  await screen.findByRole('button', { name: 'mode.remote' })
  const prepare = () => {
    switchToUrl()
    change(sourceInput(), path)
    fireEvent.click(screen.getByRole('radio', { name: 'destination.exact' }))
    change(targetInput(), uri)
  }
  prepare()
  expect(screen.queryByRole('button', { name: 'targetUri.browse' })).toBeNull()
  const consent = () => screen.getByRole<HTMLInputElement>('checkbox', { name: new RegExp('urlImportExactConsent.*compass.md') })
  fireEvent.click(action('ExactAction'))
  expect(await screen.findByText(label('ConsentRequired'))).toBeTruthy()
  expect(document.activeElement).toBe(consent())
  expect(requests).toHaveLength(0)
  view.rerender(mount(first, false, false))
  expect(requests).toHaveLength(0)
  expect(saved).toBe('original synthetic content')
  view.rerender(mount())
  prepare()
  fireEvent.click(consent())
  expect(consent().checked).toBe(true)
  change(targetInput(), uri.replace('compass', 'chart'))
  change(targetInput(), uri)
  expect(consent().checked).toBe(false)
  fireEvent.click(consent())
  change(sourceInput(), path.replace('compass', 'chart'))
  change(sourceInput(), path)
  expect(consent().checked).toBe(false)
  fireEvent.click(action('ExactAction'))
  expect(requests).toHaveLength(0)
  fireEvent.click(consent())
  fireEvent.click(action('ExactAction'))
  await screen.findByText(label('Done'))
  expect(requests).toEqual([{ path, to: uri, wait: false, processing_mode: 'vectors_only', telemetry: true }])
  expect(saved).toBe('replacement synthetic content')
})

it('H02: keeps the URL/exact pair and staged file/parent pair independent in both directions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const staged = 'viking://~/resources/uploads'
  const requests: Array<{ path: string; body?: unknown }> = []
  adapters(async config => {
    const location = route(config)
    requests.push({ path: location, body: typeof config.data === 'string' ? JSON.parse(config.data) : undefined })
    if (location === '/api/v1/resources/temp_upload') return ok(config, { temp_file_id: 'fixture-upload' })
    if (location === '/api/v1/resources') return ok(config, { status: 'success', root_uri: staged + '/local.txt' })
    throw new Error('Unexpected request')
  })
  const submitted = vi.fn()
  render(harness(vi.fn(), submitted)())
  await screen.findByRole('button', { name: 'mode.remote' })
  change(targetInput(), staged)
  const file = new File(['synthetic staged file'], 'local.txt', { type: 'text/plain' })
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } })
  await screen.findByText('local.txt')
  switchToUrl()
  change(sourceInput(), path)
  fireEvent.click(screen.getByRole('radio', { name: 'destination.exact' }))
  change(targetInput(), uri)
  fireEvent.click(screen.getByRole('button', { name: 'mode.upload' }))
  expect(targetInput().value).toBe(staged)
  expect(screen.getByRole('radio', { name: 'destination.parent' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('local.txt')).toBeTruthy()
  change(targetInput(), staged + '/revised')
  switchToUrl()
  expect(targetInput().value).toBe(uri)
  expect(sourceInput().value).toBe(path)
  expect(screen.getByRole('radio', { name: 'destination.exact' }).getAttribute('aria-checked')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'mode.upload' }))
  fireEvent.click(screen.getByRole('button', { name: 'startProcessing' }))
  expect(submitted).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[0].path).toBe('/api/v1/resources/temp_upload')
  expect(requests[1]).toEqual({ path: '/api/v1/resources', body: expect.objectContaining({ parent: staged + '/revised', source_name: 'local.txt', temp_file_id: 'fixture-upload' }) })
  expect(requests[1].body).not.toHaveProperty('to')
  expect(requests[1].body).not.toHaveProperty('path')
})

it('H03: validates on explicit action, focuses the URL error and does not normalize a different source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const bodies: unknown[] = []
  adapters(async config => {
    if (config.method === 'post') { bodies.push(JSON.parse(config.data)); return ok(config, accepted()) }
    return ok(config, task('completed'))
  })
  render(harness()())
  await screen.findByRole('button', { name: 'mode.remote' })
  switchToUrl()
  fireEvent.click(action('Action'))
  expect((await screen.findByRole('alert')).textContent).toBe(label('Required'))
  for (const invalid of [` ${path}`, path.replace('documents', 'DOCUMENTS')]) {
    change(sourceInput(), invalid)
    fireEvent.keyDown(sourceInput(), { key: 'Enter' })
    expect((await screen.findByRole('alert')).textContent).toBe(label('Invalid'))
    expect(sourceInput().value).toBe(invalid)
    expect(document.activeElement).toBe(sourceInput())
    expect(sourceInput().getAttribute('aria-invalid')).toBe('true')
    expect(sourceInput().getAttribute('aria-describedby')).toContain('add-resource-remote-error')
  }
  expect(bodies).toHaveLength(0)
  change(sourceInput(), path)
  expect(sourceInput().getAttribute('aria-invalid')).toBeNull()
  fireEvent.keyDown(sourceInput(), { key: 'Enter' })
  await screen.findByText(label('Done'))
  expect(bodies).toEqual([expect.objectContaining({ path })])
})

it.each([404, 503, 200])('H04: HTTP %s without a valid status is interruption, not failure; verify is a GET of the same task', async code => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const calls: string[] = []
  adapters(async config => {
    calls.push(`${config.method} ${route(config)}`)
    if (config.method === 'post') return ok(config, accepted())
    if (calls.length > 2) return ok(config, task('completed'))
    if (code === 200) return ok(config, task('completed', uri, { status: 'success' }))
    throw new axios.AxiosError('status read failed', 'ERR_BAD_RESPONSE', config, undefined, {
      ...ok(config, null), status: code,
    })
  })
  render(harness()())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  expect(await screen.findByText(label('FollowUnavailable'))).toBeTruthy()
  expect(screen.queryByText(label('Failed'))).toBeNull()
  expect(screen.queryByText(label('Done'))).toBeNull()
  expect(screen.queryByRole('button', { name: label('Action') })).toBeNull()
  fireEvent.click(action('Verify'))
  await screen.findByText(label('Done'))
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskRoute}`, `get ${taskRoute}`])
})

it.each(['failed', 'cancelled'])('H04: renders a genuine terminal %s separately from a tracking error', async terminal => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  adapters(async config => ok(config, config.method === 'post' ? accepted() : task(terminal, uri, null)))
  const completed = vi.fn()
  render(harness(completed)())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  expect(await screen.findByText(label(terminal === 'failed' ? 'Failed' : 'Cancelled'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: label('Verify') })).toBeNull()
  expect(completed).not.toHaveBeenCalled()
})

it('H04/H05: a hanging status read is bounded, has no animation, and resumes without another POST', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  let reads = 0
  const hanging = deferred()
  const adapter = vi.fn<AxiosAdapter>(async config => {
    if (config.method === 'post') return ok(config, accepted())
    if (++reads === 1) await hanging.promise
    return ok(config, task('completed'))
  })
  adapters(adapter)
  render(harness()())
  await screen.findByRole('button', { name: 'mode.remote' })
  vi.useFakeTimers()
  submitUrl()
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByRole('status').textContent).toBe(label('Processing'))
  expect(document.querySelector('.animate-spin')).toBeNull()
  await act(async () => vi.advanceTimersByTimeAsync(30_001))
  expect(screen.getByText(label('FollowTimeout'))).toBeTruthy()
  expect(adapter.mock.calls[1][0].signal?.aborted).toBe(true)
  await act(async () => hanging.resolve())
  expect(screen.queryByText(label('Done'))).toBeNull()
  await act(async () => fireEvent.click(action('Verify')))
  expect(screen.getByText(label('Done'))).toBeTruthy()
  expect(adapter.mock.calls.map(([c]) => route(c))).toEqual(['/api/v1/resources', taskRoute, taskRoute])
})

it('H04: closing pauses a read, reopening resumes it by ID, and switching key drops a late terminal reply', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const dangling = [deferred(), deferred()]
  let reads = 0
  const adapter = vi.fn<AxiosAdapter>(async config => {
    if (config.method === 'post') return ok(config, accepted())
    await dangling[reads++].promise
    return ok(config, task('completed'))
  })
  adapters(adapter)
  const completed = vi.fn()
  const mount = harness(completed)
  const view = render(mount())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  await waitFor(() => expect(reads).toBe(1))
  view.rerender(mount(first, false, false))
  expect(adapter.mock.calls[1][0].signal?.aborted).toBe(true)
  await act(async () => dangling[0].resolve())
  expect(completed).not.toHaveBeenCalled()
  view.rerender(mount())
  expect(await screen.findByText(label('FollowPaused'))).toBeTruthy()
  expect(sourceInput().value).toBe(path)
  fireEvent.click(action('Verify'))
  await waitFor(() => expect(reads).toBe(2))
  workspace(next)
  view.rerender(mount(next))
  expect(adapter.mock.calls[2][0].signal?.aborted).toBe(true)
  await act(async () => dangling[1].resolve())
  expect(completed).not.toHaveBeenCalled()
  expect(screen.queryByText(label('Done'))).toBeNull()
  expect(adapter.mock.calls.map(([c]) => route(c))).toEqual(['/api/v1/resources', taskRoute, taskRoute])
})

it('H04: an ambiguous POST deadline is not success or a retry; it offers the existing Tasks route', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const hanging = deferred()
  const adapter = vi.fn<AxiosAdapter>(async config => { await hanging.promise; return ok(config, accepted()) })
  adapters(adapter)
  const showTasks = vi.fn()
  render(harness(vi.fn(), vi.fn(), showTasks)())
  await screen.findByRole('button', { name: 'mode.remote' })
  vi.useFakeTimers()
  submitUrl()
  await act(async () => vi.advanceTimersByTimeAsync(15_001))
  expect(screen.getByText(label('Unknown'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: label('Action') })).toBeNull()
  expect(screen.queryByRole('button', { name: label('Verify') })).toBeNull()
  fireEvent.click(action('ShowTasks'))
  expect(showTasks).toHaveBeenCalledTimes(1)
  await act(async () => hanging.resolve())
  expect(adapter).toHaveBeenCalledTimes(1)
})

it('H04: a receipt arriving after dialog closure is recoverable without polling a closed view', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(true)))
  const response = deferred()
  const adapter = vi.fn<AxiosAdapter>(async config => {
    if (config.method === 'post') { await response.promise; return ok(config, accepted()) }
    return ok(config, task('completed'))
  })
  adapters(adapter)
  const completed = vi.fn(), mount = harness(completed), view = render(mount())
  await screen.findByRole('button', { name: 'mode.remote' })
  submitUrl()
  await waitFor(() => expect(adapter).toHaveBeenCalledTimes(1))
  view.rerender(mount(first, false, false))
  expect(adapter.mock.calls[0][0].signal?.aborted).toBe(false)
  await act(async () => response.resolve())
  expect(adapter).toHaveBeenCalledTimes(1)
  expect(completed).not.toHaveBeenCalled()
  view.rerender(mount())
  await screen.findByText(label('FollowPaused'))
  fireEvent.click(action('Verify'))
  await screen.findByText(label('Done'))
  expect(adapter.mock.calls.map(([c]) => route(c))).toEqual(['/api/v1/resources', taskRoute])
  expect(completed).toHaveBeenCalledTimes(1)
})
