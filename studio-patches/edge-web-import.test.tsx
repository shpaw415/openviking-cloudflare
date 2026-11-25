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
const first = { accountId: 'fixture', userId: 'reader', baseUrl, serviceSelection: 'opensource' as const, apiKey: 'synthetic-web-one', adminApiKey: '' }
const next = { ...first, apiKey: 'synthetic-web-two' }
const original = { options: ovClient.getOptions(), connection: ovClient.getConnection(), global: axios.defaults.adapter,
  instance: ovClient.instance.defaults.adapter, sdk: sdkClient.getConfig().adapter }
const id = '9b78dc8e-b81f-49c4-ac87-ab2c1fd008ea', taskRoute = `/api/v1/tasks/${id}`
const entry = 'https://manuals.fixture.test/docs/guide.html'
const webFlags = { htmlImport: true, siteImport: true, gitDocsImport: true }
const label = (key: string) => `studio:edge.webImport${key}`
const urlLabel = (key: string) => `studio:edge.urlImport${key}`
const reply = (config: InternalAxiosRequestConfig, result: unknown) => ({ config, status: 200, statusText: 'OK', data: { status: 'ok', result }, headers: {} })
const mode = () => screen.getByRole<HTMLSelectElement>('combobox', { name: label('Mode') })
const text = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name })
const action = (key = urlLabel('Action')) => screen.getByRole('button', { name: key })
const change = (element: Element, value: string) => fireEvent.change(element, { target: { value } })

function setup(connection = first) {
  ovClient.setOptions({ baseUrl, apiKeyAuth: 'header' })
  ovClient.setConnection(connection)
}
function renderForm(onCompleted = vi.fn()) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (connection = first, management = false, open = true) => <QueryClientProvider client={query}>
    <EdgeFeatureProvider connection={connection} management={management} enabled>
      <ResourceUploadProvider key={connection.apiKey} enabled={false}>
        {open && <AddResourceForm onCompleted={onCompleted} />}
      </ResourceUploadProvider>
    </EdgeFeatureProvider>
  </QueryClientProvider>
}
const capability = (features: unknown) => Response.json({ status: 'ok', result: { features } })
function adapters(adapter: AxiosAdapter) {
  axios.defaults.adapter = adapter
  ovClient.instance.defaults.adapter = adapter
  sdkClient.setConfig({ adapter })
}
async function enterRemote() { fireEvent.click(await screen.findByRole('button', { name: 'mode.remote' })) }

beforeEach(() => setup())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  axios.defaults.adapter = original.global
  ovClient.instance.defaults.adapter = original.instance
  sdkClient.setConfig({ adapter: original.sdk })
  ovClient.setOptions(original.options)
  ovClient.setConnection(original.connection)
})

it('shows only true workspace capabilities and does not infer a source from input or mount', async () => {
  const mount = renderForm()
  const probe = vi.fn(async (_url: URL, init: RequestInit) => {
    expect(new Headers(init.headers).get('x-api-key')).toBe(first.apiKey)
    return capability({ htmlImport: true, siteImport: 'true', gitDocsImport: false })
  })
  const send = vi.fn<AxiosAdapter>()
  vi.stubGlobal('fetch', probe)
  adapters(send)
  const view = render(mount())
  await enterRemote()
  expect(probe).toHaveBeenCalledTimes(1)
  expect(mode().value).toBe('')
  expect(screen.getByRole('option', { name: label('Html') })).toBeTruthy()
  expect(screen.queryByRole('option', { name: label('Site') })).toBeNull()
  expect(screen.queryByRole('option', { name: label('Git') })).toBeNull()
  expect(text('remoteUrl').disabled).toBe(true)
  fireEvent.click(action())
  expect((await screen.findByRole('alert')).textContent).toBe(label('ChooseMode'))
  expect(document.activeElement).toBe(mode())
  expect(send).not.toHaveBeenCalled()
  view.unmount()

  vi.stubGlobal('fetch', vi.fn(async () => capability(webFlags)))
  render(mount({ ...first, adminApiKey: 'synthetic-control' }, true))
  await screen.findByText('studio:edge.textUploadOnly')
  expect(screen.queryByRole('button', { name: 'mode.remote' })).toBeNull()
})

it.each([
  ['html', entry, 'remoteUrl', 'viking://user/reader/resources/guide.txt', { path: entry, args: { web_mode: 'html' } }],
  ['git', 'seabird-docs', label('Alias'), 'viking://user/reader/resources/compass.txt', { path: 'seabird-docs', add_type: 'git' }],
] as const)('submits approved %s once via the stock SDK and reads the same task', async (source, input, name, uri, expected) => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(webFlags)))
  const calls: string[] = []
  adapters(async config => {
    const url = new URL(config.url!, baseUrl)
    expect(url.origin).toBe(baseUrl)
    expect(config.headers.get('x-api-key')).toBe(first.apiKey)
    calls.push(`${config.method} ${url.pathname}`)
    if (config.method === 'post') {
      expect(JSON.parse(config.data)).toEqual({ ...expected, parent: 'viking://~/resources', wait: false, processing_mode: 'vectors_only', telemetry: true })
      return reply(config, { status: 'accepted', root_uri: uri, task_id: id })
    }
    return reply(config, { status: 'completed', resource_id: uri, task_id: id, task_type: 'add_resource', result: { status: 'success', root_uri: uri } })
  })
  const completed = vi.fn()
  render(renderForm(completed)())
  await enterRemote()
  change(mode(), source)
  if (source === 'git') {
    change(text(name), 'Unapproved format')
    fireEvent.click(action())
    expect((await screen.findByRole('alert')).textContent).toBe(label('AliasInvalid'))
    expect(text(name).getAttribute('aria-describedby')).toContain('add-resource-remote-error')
    expect(document.activeElement).toBe(text(name))
    expect(calls).toEqual([])
  }
  change(text(name), input)
  fireEvent.keyDown(text(name), { key: 'Enter' })
  await screen.findByText(urlLabel('Done'))
  expect(screen.getByText(uri)).toBeTruthy()
  expect(completed).toHaveBeenCalledTimes(1)
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskRoute}`])
})

it('requires exact folder consent for a site and resumes that task without resubmitting', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(webFlags)))
  const requests: string[] = []
  const uri = 'viking://user/reader/resources/costal-manual', to = 'viking://~/resources/costal-manual'
  let resume!: () => void
  const wait = new Promise<void>(resolve => { resume = resolve })
  let reads = 0
  adapters(async config => {
    requests.push(`${config.method} ${new URL(config.url!, baseUrl).pathname}`)
    if (config.method === 'post') {
      expect(JSON.parse(config.data)).toEqual({ path: entry, args: { site: true }, to,
        wait: false, processing_mode: 'vectors_only', telemetry: true })
      return reply(config, { status: 'accepted', root_uri: uri, task_id: id })
    }
    if (++reads === 1) await wait
    return reply(config, { status: 'completed', resource_id: uri, task_id: id, task_type: 'add_resource', result: { status: 'success', root_uri: uri } })
  })
  const completed = vi.fn(), mount = renderForm(completed), view = render(mount())
  await enterRemote()
  change(mode(), 'site')
  change(text('remoteUrl'), entry)
  fireEvent.click(screen.getByRole('radio', { name: 'destination.exact' }))
  change(text('targetUri'), to)
  fireEvent.click(action(label('SiteAction')))
  expect((await screen.findByRole('alert')).textContent).toBe(label('FolderConsentRequired'))
  const consent = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /webImportFolderConsent.*costal-manual/ })
  expect(document.activeElement).toBe(consent())
  expect(requests).toEqual([])
  fireEvent.click(consent())
  change(text('targetUri'), to + '-changed')
  change(text('targetUri'), to)
  expect(consent().checked).toBe(false)
  fireEvent.click(consent())
  fireEvent.click(action(label('SiteAction')))
  await waitFor(() => expect(reads).toBe(1))
  view.rerender(mount(first, false, false))
  await act(async () => resume())
  expect(completed).not.toHaveBeenCalled()
  view.rerender(mount())
  await screen.findByText(urlLabel('FollowPaused'))
  expect(mode().value).toBe('site')
  expect(text('targetUri').value).toBe(to)
  fireEvent.click(action(urlLabel('Verify')))
  await screen.findByText(label('SiteDone'))
  expect(requests).toEqual(['post /api/v1/resources', `get ${taskRoute}`, `get ${taskRoute}`])
  expect(completed).toHaveBeenCalledTimes(1)
})

it('discards stale web capabilities on key change', async () => {
  let deliver!: (value: Response) => void
  const stale = new Promise<Response>(resolve => { deliver = resolve })
  const probe = vi.fn((_url: URL, init: RequestInit) => new Headers(init.headers).get('x-api-key') === first.apiKey
    ? stale : Promise.resolve(capability({})))
  vi.stubGlobal('fetch', probe)
  const mount = renderForm(), view = render(mount())
  await waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
  setup(next)
  view.rerender(mount(next))
  await act(async () => deliver(capability(webFlags)))
  expect(probe.mock.calls[0][1].signal?.aborted).toBe(true)
  await screen.findByText('studio:edge.textUploadOnly')
  expect(screen.queryByRole('button', { name: 'mode.remote' })).toBeNull()
})

it('offers neutral guidance and no exact-file consent before a site-only source is chosen', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability({ siteImport: true })))
  const send = vi.fn<AxiosAdapter>()
  adapters(send)
  render(renderForm()())
  await enterRemote()
  expect(mode().value).toBe('')
  expect(screen.getByText(label('ModeHint'))).toBeTruthy()
  expect(screen.queryByText(urlLabel('Hint'))).toBeNull()
  expect(text('targetUri').disabled).toBe(true)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(send).not.toHaveBeenCalled()

  change(mode(), 'site')
  expect(screen.getByText(label('SiteHint'))).toBeTruthy()
  expect(text('targetUri').disabled).toBe(false)
  expect(screen.queryByText(label('ModeHint'))).toBeNull()
})

function refused(config: InternalAxiosRequestConfig, code: string, status: number) {
  return new axios.AxiosError('Fixture refusal', 'ERR_BAD_REQUEST', config, undefined, {
    ...reply(config, null), status, data: { status: 'error', error: { code, message: 'Raw fixture diagnostic' } },
  })
}

it('asks for a new exact site folder when the chosen location already exists', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(webFlags)))
  const send = vi.fn<AxiosAdapter>(async config => { throw refused(config, 'ALREADY_EXISTS', 409) })
  adapters(send)
  render(renderForm()())
  await enterRemote()
  change(mode(), 'site')
  change(text('remoteUrl'), entry)
  fireEvent.click(screen.getByRole('radio', { name: 'destination.exact' }))
  const to = 'viking://~/resources/occupied'
  change(text('targetUri'), to)
  const consent = screen.getByRole<HTMLInputElement>('checkbox', { name: /webImportFolderConsent.*occupied/ })
  fireEvent.click(consent)
  fireEvent.click(action(label('SiteAction')))

  expect((await screen.findByRole('alert')).textContent).toBe(label('FolderExists'))
  expect(text('targetUri').value).toBe(to)
  expect(document.activeElement).toBe(text('targetUri'))
  expect(send.mock.calls.map(([config]) => config.method)).toEqual(['post'])
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /webImportFolderConsent.*occupied/ }).checked).toBe(false)
  expect(screen.queryByText('Raw fixture diagnostic')).toBeNull()
})

it('points to the alias and not a URL on a generic GitHub admission refusal', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability(webFlags)))
  const send = vi.fn<AxiosAdapter>(async config => { throw refused(config, 'PERMISSION_DENIED', 403) })
  adapters(send)
  render(renderForm()())
  await enterRemote()
  change(mode(), 'git')
  change(text(label('Alias')), 'seabird-docs')
  fireEvent.click(action())
  expect((await screen.findByRole('alert')).textContent).toBe(label('GitRefused'))
  expect(text(label('Alias')).value).toBe('seabird-docs')
  expect(send.mock.calls.map(([config]) => config.method)).toEqual(['post'])
  expect(screen.queryByText('Raw fixture diagnostic')).toBeNull()
})
