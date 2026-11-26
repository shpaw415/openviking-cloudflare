// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axios from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { afterEach, expect, it, vi } from 'vitest'
import { EdgeFeatureProvider } from '#/features/connection/hooks/use-edge-features'
import { AddResourceForm } from '#/features/workbench/resources/components/add-resource-page'
import { ResourceUploadProvider } from '#/features/workbench/resources/hooks/use-resource-upload'
import en from '#/i18n/locales/en/studio'
import zh from '#/i18n/locales/zh-CN/studio'
import { ovClient } from '#/shared/api/ov-client/index'
import { client as sdkClient } from '#/gen/ov-client/client.gen'

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const baseUrl = window.location.origin
const first = { accountId: 'fixture', userId: 'reader', baseUrl, serviceSelection: 'opensource' as const, apiKey: 'site-fixture-1', adminApiKey: '' }
const next = { ...first, apiKey: 'site-fixture-2' }
const id = '9b78dc8e-b81f-49c4-ac87-ab2c1fd008ea', taskRoute = `/api/v1/tasks/${id}`
const source = 'https://manuals.fixture.test/guide.html', uri = 'viking://user/reader/resources/guide'
const original = { options: ovClient.getOptions(), connection: ovClient.getConnection(), global: axios.defaults.adapter,
  instance: ovClient.instance.defaults.adapter, sdk: sdkClient.getConfig().adapter }
const limit = 'studio:edge.webImportSiteLimitReached'
const text = (key: string) => screen.getByRole('textbox', { name: key })
const button = (key: string) => screen.getByRole('button', { name: key })
const reply = (config: InternalAxiosRequestConfig, result: unknown) => ({ config, status: 200, statusText: 'OK', data: { status: 'ok', result }, headers: {} })
const terminal = (changes: Record<string, unknown> = {}, result: Record<string, unknown> = { site_limit_reached: true }) => ({
  status: 'completed', task_id: id, resource_id: uri, task_type: 'add_resource',
  result: { status: 'success', root_uri: uri, ...result }, ...changes,
})
function connection(value = first) {
  ovClient.setOptions({ baseUrl, apiKeyAuth: 'header' })
  ovClient.setConnection(value)
}
function mount(adapter: AxiosAdapter) {
  connection()
  axios.defaults.adapter = adapter
  ovClient.instance.defaults.adapter = adapter
  sdkClient.setConfig({ adapter })
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', result: { features: { siteImport: true } } })))
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } }), completed = vi.fn()
  const form = (key = first, open = true) => <QueryClientProvider client={query}>
    <EdgeFeatureProvider connection={key} management={false} enabled>
      <ResourceUploadProvider key={key.apiKey} enabled={false}>
        {open && <AddResourceForm onCompleted={completed} />}
      </ResourceUploadProvider>
    </EdgeFeatureProvider>
  </QueryClientProvider>
  return { form, completed, ...render(form()) }
}
async function submit() {
  fireEvent.click(await screen.findByRole('button', { name: 'mode.remote' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'studio:edge.webImportMode' }), { target: { value: 'site' } })
  fireEvent.change(text('remoteUrl'), { target: { value: source } })
  fireEvent.keyDown(text('remoteUrl'), { key: 'Enter' })
}
afterEach(() => {
  cleanup()
  axios.defaults.adapter = original.global
  ovClient.instance.defaults.adapter = original.instance
  sdkClient.setConfig({ adapter: original.sdk })
  vi.unstubAllGlobals()
  ovClient.setOptions(original.options)
  ovClient.setConnection(original.connection)
})

it('renders the structured limit inside the existing status region after same-ID recovery and keeps it on reopen', async () => {
  let deliver!: (value: unknown) => void
  const held = new Promise(resolve => { deliver = resolve })
  const calls: string[] = []
  const view = mount(async config => {
    expect(config.headers.get('x-api-key')).toBe(first.apiKey)
    calls.push(`${config.method} ${new URL(config.url!, baseUrl).pathname}`)
    if (config.method === 'post') {
      expect(JSON.parse(config.data)).toMatchObject({ path: source, args: { site: true }, wait: false })
      return reply(config, { status: 'accepted', root_uri: uri, task_id: id, site_limit_reached: true })
    }
    return reply(config, calls.length === 2 ? await held : terminal())
  })
  await submit()
  await waitFor(() => expect(calls).toHaveLength(2))
  expect(screen.queryByText(limit)).toBeNull()
  view.rerender(view.form(first, false))
  await act(async () => deliver(terminal()))
  view.rerender(view.form())
  await screen.findByText('studio:edge.urlImportFollowPaused')
  expect(screen.queryByText(limit)).toBeNull()
  fireEvent.click(button('studio:edge.urlImportVerify'))
  await within(screen.getByRole('status')).findByText(limit)
  expect(view.completed).toHaveBeenCalledTimes(1)
  view.rerender(view.form(first, false))
  view.rerender(view.form())
  expect(await within(await screen.findByRole('status')).findByText(limit)).toBeTruthy()
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskRoute}`, `get ${taskRoute}`])
  expect(en.edge.webImportSiteLimitReached).toContain('six pages')
  expect(zh.edge.webImportSiteLimitReached).toContain('最多六页')
})

it.each([
  ['warning only', terminal({}, { warnings: ['Only the bounded set was imported.'] }), true],
  ['string', terminal({}, { site_limit_reached: 'true' }), true],
  ['false', terminal({}, { site_limit_reached: false }), true],
  ['wrong id', terminal({ task_id: '686ec5e1-d099-40ea-9e7e-376dd02a48f4' }), false],
  ['wrong result URI', terminal({}, { root_uri: uri + '-other', site_limit_reached: true }), false],
  ['failed task', terminal({ status: 'failed' }), false],
] as const)('does not announce on %s', async (_case, record, succeeds) => {
  const view = mount(async config => reply(config, config.method === 'post'
    ? { status: 'accepted', root_uri: uri, task_id: id } : record))
  await submit()
  await screen.findByText(succeeds ? 'studio:edge.webImportSiteDone' : _case === 'failed task'
    ? 'studio:edge.urlImportFailed' : 'studio:edge.urlImportFollowUnavailable')
  expect(screen.queryByText(limit)).toBeNull()
  expect(view.completed).toHaveBeenCalledTimes(succeeds ? 1 : 0)
})

it('ignores a late success after key rotation', async () => {
  let deliver!: (value: unknown) => void
  const held = new Promise(resolve => { deliver = resolve })
  const send = vi.fn<AxiosAdapter>(async config => reply(config, config.method === 'post'
    ? { status: 'accepted', root_uri: uri, task_id: id } : await held))
  const view = mount(send)
  await submit()
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  connection(next)
  view.rerender(view.form(next))
  await act(async () => deliver(terminal()))
  expect(screen.queryByText(limit)).toBeNull()
  expect(view.completed).not.toHaveBeenCalled()
  expect(send.mock.calls[1][0].signal?.aborted).toBe(true)
})
