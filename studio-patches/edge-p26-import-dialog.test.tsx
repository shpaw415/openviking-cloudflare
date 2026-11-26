// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axios from 'axios'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EdgeFeatureProvider } from '#/features/connection/hooks/use-edge-features'
import { AddResourceForm } from '#/features/workbench/resources/components/add-resource-page'
import { ResourceUploadProvider } from '#/features/workbench/resources/hooks/use-resource-upload'
import { client as sdkClient } from '#/gen/ov-client/client.gen'
import { ovClient } from '#/shared/api/ov-client/index'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '#/shared/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '#/shared/ui/popover'

vi.mock('react-i18next', async original => ({ ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const baseUrl = window.location.origin
const first = { accountId: 'fixture', userId: 'reader', baseUrl, serviceSelection: 'opensource' as const, apiKey: 'fixture-first', adminApiKey: 'fixture-management' }
const next = { ...first, apiKey: 'fixture-next' }
const id = 'b32b281e-c834-4ffd-8a56-51db2787d188'
const taskPath = `/api/v1/tasks/${id}`
const e = (key: string) => `studio:edge.${key}`
const choose = () => screen.getByRole<HTMLSelectElement>('combobox', { name: e('webImportMode') })
const input = (name: string) => screen.getByRole<HTMLInputElement>('textbox', { name })
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const change = (el: Element, value: string) => fireEvent.change(el, { target: { value } })
const readOptions = () => within(choose()).getAllByRole<HTMLOptionElement>('option').map(option => option.value).filter(Boolean)
const reply = (config: InternalAxiosRequestConfig, result: unknown) => ({ config, status: 200, statusText: 'OK', data: { status: 'ok', result }, headers: {} })
const capability = (features: unknown) => Response.json({ status: 'ok', result: { features } })
const terminal = (root: string, result: unknown) => ({ task_id: id, task_type: 'add_resource', resource_id: root, status: 'completed', result })
const original = { options: ovClient.getOptions(), connection: ovClient.getConnection(), global: axios.defaults.adapter,
  instance: ovClient.instance.defaults.adapter, sdk: sdkClient.getConfig().adapter }

function intercepted(adapter: AxiosAdapter) {
  axios.defaults.adapter = adapter
  ovClient.instance.defaults.adapter = adapter
  sdkClient.setConfig({ adapter })
}
beforeEach(() => {
  ovClient.setOptions({ baseUrl, apiKeyAuth: 'header' })
  ovClient.setConnection(first)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  axios.defaults.adapter = original.global
  ovClient.instance.defaults.adapter = original.instance
  sdkClient.setConfig({ adapter: original.sdk })
  ovClient.setOptions(original.options)
  ovClient.setConnection(original.connection)
})

function harness(onShowTasks = vi.fn()) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (connection = first, enabled = true, open = true, management = false) => (
    <QueryClientProvider client={query}>
      <EdgeFeatureProvider connection={connection} management={management} enabled={enabled}>
        <ResourceUploadProvider key={connection.apiKey} enabled={false}>
          {open && <><button type="button">Other control</button><AddResourceForm onShowTasks={onShowTasks} /></>}
        </ResourceUploadProvider>
      </EdgeFeatureProvider>
    </QueryClientProvider>
  )
}
async function remote() { fireEvent.click(await screen.findByRole('button', { name: 'mode.remote' })) }

const fixtures = [
  ['gitDocsCollectionImport', 'git-collection', 'field-guide', e('webImportAlias'), 'folder', { add_type: 'git', args: { web_mode: 'collection' } }],
  ['feedImport', 'feed', 'https://docs.fixture.test/updates/', 'remoteUrl', 'folder', { args: { web_mode: 'feed' } }],
  ['sitemapImport', 'sitemap', 'https://docs.fixture.test/map.xml', 'remoteUrl', 'folder', { args: { sitemap: true } }],
  ['feishuNativeImport', 'feishu-native', 'https://team.feishu.cn/docx/fixture', e('webImportDocument'), 'doc.txt', { add_type: 'feishu', args: { web_mode: 'native' } }],
  ['tosNativeImport', 'tos-native', 'tos://fixture-bucket/folder/doc.txt', e('webImportDocument'), 'doc.txt', { add_type: 'tos', args: { web_mode: 'native' } }],
  ['feishuTreeImport', 'feishu-tree', 'wiki-guide', e('webImportAlias'), 'folder', { add_type: 'feishu', args: { web_mode: 'tree' } }],
  ['tosCollectionImport', 'tos-collection', 'approved-assets', e('webImportAlias'), 'folder', { add_type: 'tos', args: { web_mode: 'collection' } }],
] as const

it.each(fixtures)('%s alone offers %s and sends its exact API profile and consented private destination', async (flag, mode, path, label, leaf, profile) => {
  const flags: Record<string, unknown> = Object.fromEntries(fixtures.map(([key]) => [key, 'true']))
  flags[flag] = true
  flags.feishuArchiveImport = flags.tosArchiveImport = flags.liveGitDocsImport = true
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    expect(url.pathname).toBe('/api/v1/system/edge-capabilities')
    return capability(flags)
  }))
  const root = `viking://user/reader/resources/${leaf}`, to = `viking://~/resources/${leaf}`
  const completed = { status: 'success', root_uri: root, feed_limit_reached: mode === 'feed', sitemap_limit_reached: mode === 'sitemap' }
  const calls: string[] = []
  intercepted(async config => {
    const url = new URL(config.url!, baseUrl)
    expect(url.origin).toBe(baseUrl)
    expect(config.headers.get('x-api-key')).toBe(first.apiKey)
    calls.push(`${config.method} ${url.pathname}`)
    if (config.method === 'post') {
      expect(JSON.parse(config.data)).toEqual({ path, to, ...profile, wait: false, processing_mode: 'vectors_only', telemetry: true })
      return reply(config, { status: 'accepted', task_id: id, root_uri: root })
    }
    expect(url.pathname).toBe(taskPath)
    return reply(config, terminal(root, completed))
  })
  render(harness()())
  await remote()
  expect(readOptions()).toEqual([mode])
  change(choose(), mode)
  change(input(label), path)
  change(input('targetUri'), `viking://resources/${leaf}`)
  const action = leaf === 'folder' ? e('webImportCollectionAction') : e('urlImportExactAction')
  click(action)
  expect(screen.getByRole('alert').textContent).toContain(leaf === 'folder' ? 'webImportPrivateFolder' : 'webImportPrivateFile')
  expect(calls).toEqual([])
  change(input('targetUri'), to)
  click(action)
  expect(screen.getByRole('alert').textContent).toBe(e('webImportPrivateConsentRequired'))
  const checkbox = screen.getByRole('checkbox', { name: new RegExp(leaf === 'folder' ? 'webImportFolderConsent' : 'urlImportExactConsent') })
  expect(document.activeElement).toBe(checkbox)
  expect(calls).toEqual([])
  fireEvent.click(checkbox)
  click(action)
  await screen.findByText(root)
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskPath}`])
  expect(screen.queryByText(e('webImportCollectionLimitReached')) !== null).toBe(mode === 'feed' || mode === 'sitemap')
})

it.each([['html', 'https://docs.fixture.test/'], ['site', 'https://docs.fixture.test/guide/']] as const)(
  'sends an unchanged extensionless %s only after profile admission', async (mode, path) => {
    vi.stubGlobal('fetch', vi.fn(async () => capability(mode === 'html' ? { htmlImport: true, liveOriginImport: true } : { siteImport: true })))
    const calls: string[] = []
    const root = `viking://user/reader/resources/${mode === 'site' ? 'folder' : 'page.txt'}`
    intercepted(async config => {
      const url = new URL(config.url!, baseUrl)
      calls.push(url.pathname)
      return reply(config, config.method === 'post' ? (
        expect(JSON.parse(config.data)).toMatchObject({ path, args: mode === 'site' ? { site: true } : { web_mode: 'html' } }),
        { status: 'accepted', task_id: id, root_uri: root }
      ) : terminal(root, { status: 'success', root_uri: root, site_limit_reached: true }))
    })
    render(harness()())
    await remote()
    change(choose(), mode)
    const source = input('remoteUrl')
    for (const wrong of [path.replace('docs', 'DOCS'), `${path}?q=1`, ...(mode === 'site' ? ['https://docs.fixture.test/map.xml'] : [])]) {
      change(source, wrong)
      fireEvent.keyDown(source, { key: 'Enter' })
      expect(source.value).toBe(wrong)
      expect(source.getAttribute('aria-invalid')).toBe('true')
      expect(calls).toEqual([])
    }
    change(source, path)
    source.focus()
    fireEvent.keyDown(source, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByRole('status'))
    await screen.findByText(root)
    expect(calls).toEqual(['/api/v1/resources', taskPath])
  },
)

it('keeps snapshot HTML suffix rule and does not offer imports in management', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability({ htmlImport: true, sitemapImport: true, feishuNativeImport: true })))
  const send = vi.fn<AxiosAdapter>()
  intercepted(send)
  const tree = harness(), view = render(tree())
  await remote()
  change(choose(), 'html')
  change(input('remoteUrl'), 'https://docs.fixture.test/manual/')
  click(e('urlImportAction'))
  expect(screen.getByRole('alert').textContent).toBe(e('webImportUrlInvalid'))
  expect(send).not.toHaveBeenCalled()
  view.rerender(tree(first, true, true, true))
  await screen.findByText(e('textUploadOnly'))
  expect(screen.queryByRole('button', { name: 'mode.remote' })).toBeNull()
})

it('keeps the same receipt while admission is disabled; moves focus only on explicit submit or verify', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => capability({ siteImport: true })))
  const root = 'viking://user/reader/resources/orchard'
  const calls: string[] = []
  let finish!: (body: unknown) => void
  const completion = new Promise<unknown>(resolve => { finish = resolve })
  intercepted(async config => {
    const url = new URL(config.url!, baseUrl)
    calls.push(`${config.method} ${url.pathname}`)
    if (config.method === 'post') return reply(config, { status: 'accepted', task_id: id, root_uri: root })
    if (calls.length === 2) return reply(config, { task_id: id, status: 'unknown' })
    return reply(config, await completion)
  })
  const tree = harness(), view = render(tree())
  await remote()
  change(choose(), 'site')
  change(input('remoteUrl'), 'https://docs.fixture.test/orchard/')
  const submit = screen.getByRole('button', { name: e('webImportSiteAction') })
  submit.focus()
  fireEvent.click(submit)
  const status = screen.getByRole('status')
  expect(document.activeElement).toBe(status)
  const firstVerify = await screen.findByRole('button', { name: e('urlImportVerify') })
  view.rerender(tree(first, false))
  expect(screen.getByRole('button', { name: e('urlImportVerify') })).toBe(firstVerify)
  expect(screen.queryByRole('button', { name: e('webImportSiteAction') })).toBeNull()
  firstVerify.focus()
  fireEvent.click(firstVerify)
  expect(document.activeElement).toBe(status)
  const other = screen.getByRole('button', { name: 'Other control' })
  other.focus()
  await act(async () => finish(terminal(root, { status: 'success', root_uri: root, site_limit_reached: true })))
  await screen.findByText(e('webImportSiteLimitReached'))
  expect(document.activeElement).toBe(other)
  view.rerender(tree(first, false, false))
  view.rerender(tree(first, false))
  expect(screen.getByText(root)).toBeTruthy()
  view.rerender(tree(next, false))
  expect(screen.queryByText(root)).toBeNull()
  expect(calls).toEqual(['post /api/v1/resources', `get ${taskPath}`, `get ${taskPath}`])
})

it.each(['Task credential is no longer authorized.', 'untrusted provider debug text'])(
  'shows only a local failed-task diagnosis and Tasks recovery (wire error %s)', async error => {
    vi.stubGlobal('fetch', vi.fn(async () => capability({ gitDocsImport: true })))
    const root = 'viking://user/reader/resources/guide.txt', onShowTasks = vi.fn()
    intercepted(async config => reply(config, config.method === 'post' ? { status: 'accepted', task_id: id, root_uri: root }
      : { task_id: id, task_type: 'add_resource', resource_id: root, status: 'failed', error }))
    render(harness(onShowTasks)())
    await remote()
    change(choose(), 'git')
    change(input(e('webImportAlias')), 'guide')
    click(e('urlImportAction'))
    expect((await screen.findByRole('alert')).textContent).toContain(e(error.startsWith('Task credential') ? 'webImportTaskRevoked' : 'urlImportFailed'))
    expect(screen.queryByText(error)).toBeNull()
    click(e('urlImportShowTasks'))
    expect(onShowTasks).toHaveBeenCalledTimes(1)
  },
)

it('gates shared dialog overlay, popup and popover motion utilities', () => {
  render(<><Dialog open><DialogContent><DialogTitle>Fixture dialog</DialogTitle><DialogDescription>Fixture</DialogDescription></DialogContent></Dialog>
    <Popover open><PopoverTrigger>Open</PopoverTrigger><PopoverContent>Fixture popover</PopoverContent></Popover></>)
  for (const slot of ['dialog-overlay', 'dialog-content', 'popover-content']) {
    const el = document.querySelector(`[data-slot="${slot}"]`)
    const motion = [...(el?.classList ?? [])].filter(token => /:(?:animate-|fade-|zoom-|slide-)|duration-/.test(token))
    expect(motion.length).toBeGreaterThan(2)
    expect(motion.every(token => token.startsWith('motion-safe:'))).toBe(true)
  }
})
