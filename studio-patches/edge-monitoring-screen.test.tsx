// @vitest-environment jsdom
import { StudioFeatureBoundary } from '#/app/layouts/studio-feature-boundary'
import { StudioLayout } from '#/app/layouts/studio-layout'
import { EdgeFeatureProvider } from '#/features/connection/hooks/use-edge-features'
import type { ConnectionRole } from '#/features/connection/lib/types'
import { MonitoringRoute } from '#/features/workbench/monitoring/page'
import i18n from '#/i18n'
import { ovClient } from '#/shared/api/ov-client/index'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type { ComponentPropsWithRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  edge: true,
  management: false,
  role: 'user' as ConnectionRole,
  workspaceKey: 'synthetic-user',
}))
const origin = window.location.origin
const managementKey = 'synthetic-control'
function connection() {
  return {
    baseUrl: origin,
    accountId: 'fixture-account',
    userId: 'fixture-user',
    serviceSelection: 'opensource' as const,
    apiKey: fixture.workspaceKey,
    adminApiKey: managementKey,
  }
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: { to: string } & ComponentPropsWithRef<'a'>) => <a href={to} {...props} />,
  useRouterState: () => '/monitoring',
  useNavigate: () => vi.fn(),
}))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({
  useAppConnection: () => ({
    connection: connection(),
    connectionRole: fixture.role,
    identityScopeKey: fixture.workspaceKey,
    isConnectionRoleLoading: false,
    isGatewayHost: false,
    serverMode: 'api_key',
    studioMode: fixture.management ? 'management' : 'workbench',
  }),
}))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({
  useStudioService: () => ({ provider: 'opensource', ready: true, isChecking: false }),
}))
vi.mock('#/features/connection/hooks/use-studio-capabilities', () => ({ useStudioCapabilities: () => ({}) }))
vi.mock('#/app/layouts/studio-header', () => ({ StudioHeader: () => null }))
vi.mock('#/features/connection/components/studio-version', () => ({ StudioVersion: () => null }))
vi.mock('#/features/connection/components/generated-credential-dialog', () => ({ GeneratedCredentialDialog: () => null }))
vi.mock('#/features/oauth/components/cross-device-verify-dialog', () => ({ CrossDeviceVerifyDialog: () => null }))
vi.mock('#/shared/lib/edge-studio', async (original) => ({
  ...await original<typeof import('#/shared/lib/edge-studio')>(),
  get EDGE_STUDIO() { return fixture.edge },
}))

let fixtureInterceptor: number | undefined
beforeEach(async () => {
  fixture.edge = true
  fixture.management = false
  fixture.role = 'user'
  fixture.workspaceKey = 'synthetic-user'
  await i18n.changeLanguage('en')
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => {
  cleanup()
  if (fixtureInterceptor !== undefined) {
    ovClient.instance.interceptors.request.eject(fixtureInterceptor)
    fixtureInterceptor = undefined
  }
  ovClient.clearConnection()
  vi.unstubAllGlobals()
})

function Studio() {
  const draft = connection()
  return (
    <EdgeFeatureProvider connection={draft} management={fixture.management} enabled={fixture.edge}>
      <StudioLayout>
        <StudioFeatureBoundary><MonitoringRoute /></StudioFeatureBoundary>
      </StudioLayout>
    </EdgeFeatureProvider>
  )
}

function renderStudio() {
  const client = new QueryClient()
  const tree = () => <QueryClientProvider client={client}><Studio /></QueryClientProvider>
  const view = render(tree())
  return () => view.rerender(tree())
}

function capabilityBody(monitoring?: unknown) {
  return { status: 'ok', result: { features: { control: true, monitoring }, links: ['/monitoring'] } }
}

function serveFlags(payload: unknown) {
  const fetch = vi.fn(async (_url: URL, _options: RequestInit) => Response.json(payload))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

const modelStatus = 'No model usage data available.'
const modelTable = [
  '+---------------+',
  '| Model         |',
  '+---------------+',
  '| fixture-model |',
  '+---------------+',
].join('\n')
const modelDescription = 'VLM, embedding, and rerank model services.'
function serveObserver(modelHealth: boolean | null, { unavailable = false, observedFailure = false } = {}) {
  ovClient.setOptions({ baseUrl: origin, credentialScope: 'data' })
  ovClient.setConnection({ apiKey: fixture.workspaceKey, adminApiKey: managementKey, identityHeaders: false })
  const observe = vi.fn(async (config: InternalAxiosRequestConfig) => {
    const url = new URL(config.url ?? '', config.baseURL)
    const health = url.pathname === '/health'
    const response = { config, headers: {}, statusText: 'OK', status: 200, data: {} }
    expect(`${config.method} ${url.href}`).toBe(`get ${origin}${health ? '/health' : '/api/v1/observer/system'}`)
    expect(config.headers.get('X-API-Key')).toBe(fixture.workspaceKey)
    if (!health && unavailable) {
      throw new AxiosError('Synthetic observer unavailable', AxiosError.ERR_BAD_RESPONSE, config, undefined, {
        ...response,
        status: 503,
        statusText: 'Service Unavailable',
        data: { status: 'error', error: { code: 'UNAVAILABLE', message: 'Synthetic observer unavailable' } },
      })
    }
    response.data = health ? { status: 'ok', version: '0.0.1-fixture' } : {
      status: 'ok',
      result: {
        is_healthy: modelHealth !== false && !observedFailure,
        errors: [...(modelHealth === false ? ['models'] : []), ...(observedFailure ? ['filesystem'] : [])],
        components: {
          models: { name: 'models', has_errors: false, is_healthy: modelHealth, status: modelHealth === true ? modelTable : modelStatus },
          queue: { name: 'queue', has_errors: false, is_healthy: true, status: '' },
          filesystem: { name: 'filesystem', has_errors: observedFailure, is_healthy: true, status: '' },
          vikingdb: { name: 'vikingdb', has_errors: false, is_healthy: true, status: '' },
          lock: { name: 'lock', has_errors: false, is_healthy: true, status: '' },
          retrieval: { name: 'retrieval', has_errors: false, is_healthy: true, status: '' },
        },
      },
    }
    return response
  })
  fixtureInterceptor = ovClient.instance.interceptors.request.use((config) => ({ ...config, adapter: observe }))
  return observe
}

const monitoringLink = () => screen.queryByRole('link', { name: 'Monitoring' })
const pageHeading = () => screen.queryByRole('heading', { name: 'Monitoring' })
const deniedHeading = () => screen.findByRole('heading', { name: i18n.t('studio:edge.unsupportedTitle') })

it.each([
  ['false', capabilityBody(false)],
  ['absent', capabilityBody()],
  ['truthy string', capabilityBody('true')],
  ['truthy number', capabilityBody(1)],
  ['unwrapped', { features: { monitoring: true } }],
])('keeps the original link and direct route closed with a %s capability even for an admin', async (_label, payload) => {
  fixture.role = 'admin'
  const fetch = serveFlags(payload)
  const observe = serveObserver(null)
  renderStudio()
  await deniedHeading()
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-API-Key': fixture.workspaceKey })
  expect(monitoringLink()).toBeNull()
  expect(pageHeading()).toBeNull()
  expect(observe).not.toHaveBeenCalled()
})

it.each(['root', 'admin'] as const)('does not mount the workspace in %s management mode even if monitoring is advertised', async (role) => {
  fixture.role = role
  fixture.management = true
  const fetch = serveFlags(capabilityBody(true))
  const observe = serveObserver(null)
  renderStudio()
  await deniedHeading()
  expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-API-Key': managementKey })
  expect(monitoringLink()).toBeNull()
  expect(pageHeading()).toBeNull()
  expect(observe).not.toHaveBeenCalled()
})

it('clears an admitted key immediately and ignores a late positive answer after rotation', async () => {
  const stale = deferredResponse()
  const current = deferredResponse()
  const fetch = vi.fn(async (_url: URL, _options: RequestInit) => Response.json(capabilityBody(true)))
  vi.stubGlobal('fetch', fetch)
  const observe = serveObserver(null)
  const rerender = renderStudio()
  await screen.findByText('5 of 6 components healthy')
  expect(monitoringLink()).not.toBeNull()

  fetch.mockImplementationOnce(() => stale.promise)
  fixture.workspaceKey = 'synthetic-rotated-once'
  rerender()
  expect(pageHeading()).toBeNull()
  expect(monitoringLink()).toBeNull()
  const staleRequest = fetch.mock.calls[1][1]
  expect(staleRequest.headers).toMatchObject({ 'X-API-Key': fixture.workspaceKey })

  fetch.mockImplementationOnce(() => current.promise)
  fixture.workspaceKey = 'synthetic-rotated-twice'
  rerender()
  expect(staleRequest.signal?.aborted).toBe(true)
  expect(fetch.mock.calls[2][1].headers).toMatchObject({ 'X-API-Key': fixture.workspaceKey })
  await act(async () => { stale.resolve(Response.json(capabilityBody(true))) })
  expect(pageHeading()).toBeNull()
  expect(monitoringLink()).toBeNull()
  await act(async () => { current.resolve(Response.json(capabilityBody(false))) })
  await deniedHeading()
  expect(observe).toHaveBeenCalledTimes(2)
})

const partial = { title: 'Some components have not been checked', label: 'No data', color: 'text-muted-foreground' }
const healthy = { title: 'All components are healthy', label: 'Healthy', color: 'text-emerald-600' }
const edgeHealthy = { ...healthy, color: 'text-emerald-700' }
const unhealthy = { title: 'Some components need attention', label: 'Unhealthy', color: 'text-destructive' }

it.each([
  { role: 'user', edge: true, health: null, observedFailure: false, model: partial, summary: partial, count: 5 },
  { role: 'admin', edge: true, health: true, observedFailure: false, model: edgeHealthy, summary: edgeHealthy, count: 6 },
  { role: 'user', edge: true, health: false, observedFailure: false, model: unhealthy, summary: unhealthy, count: 5 },
  { role: 'user', edge: true, health: null, observedFailure: true, model: partial, summary: unhealthy, count: 4 },
  { role: 'user', edge: false, health: null, observedFailure: false, model: unhealthy, summary: healthy, count: 5 },
] as const)('renders the stock Monitoring overview and detail ($role, Edge=$edge, models=$health, failure=$observedFailure)', async ({ role, edge, health, observedFailure, model, summary, count }) => {
  fixture.role = role
  fixture.edge = edge
  const fetch = serveFlags(capabilityBody(true))
  const observe = serveObserver(health, { observedFailure })
  renderStudio()
  const countNode = await screen.findByText(`${count} of 6 components healthy`)
  const summaryCard = within(countNode.closest<HTMLElement>('[data-slot="card"]')!)
  expect(summaryCard.getByText(summary.title)).not.toBeNull()
  expect(summaryCard.getByText(summary.label).classList.contains(summary.color)).toBe(true)
  if (summary === edgeHealthy) expect(summaryCard.getByText(summary.label).classList.contains('dark:text-emerald-400')).toBe(true)
  if (summary === partial) expect(summaryCard.queryByText(healthy.title)).toBeNull()
  expect(monitoringLink()?.getAttribute('href')).toBe('/monitoring')
  expect(pageHeading()).not.toBeNull()
  expect(screen.getByText('v0.0.1-fixture')).not.toBeNull()
  expect(observe.mock.calls.map(([config]) => new URL(config.url ?? '', config.baseURL).pathname)).toEqual(['/health', '/api/v1/observer/system'])
  expect(fetch).toHaveBeenCalledTimes(edge ? 1 : 0)

  const tabs = within(screen.getByRole('tablist', { name: 'Monitoring type' }))
  expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'Overview', 'Task queue', 'VectorDB', 'Models', 'Filesystem', 'Locks', 'Retrieval',
  ])
  const overview = screen.getByRole('button', { name: /^Models / })
  expect(within(overview).getByText(model.label).classList.contains(model.color)).toBe(true)
  expect(within(screen.getByRole('button', { name: /^Filesystem / })).getByText(observedFailure ? 'Unhealthy' : 'Healthy')).not.toBeNull()
  const modelsTab = tabs.getByRole('tab', { name: 'Models' })
  fireEvent.click(modelsTab)
  expect(modelsTab.getAttribute('aria-selected')).toBe('true')
  const detail = screen.getByText(modelDescription).closest<HTMLElement>('[data-slot="card"]')!
  expect(within(detail).getByText(model.label).classList.contains(model.color)).toBe(true)
  if (health === true) {
    expect(within(detail).getByRole('cell', { name: 'fixture-model' })).not.toBeNull()
  } else {
    expect(within(detail).getByText(modelStatus)).not.toBeNull()
  }
  expect(observe).toHaveBeenCalledTimes(2)
})

it('localizes the partial Monitoring summary in Simplified Chinese', async () => {
  await i18n.changeLanguage('zh-CN')
  serveFlags(capabilityBody(true))
  serveObserver(null)
  renderStudio()
  expect(await screen.findByText('部分组件尚未检查')).not.toBeNull()
})

it('leaves an observer failure in the original load-error state', async () => {
  serveFlags(capabilityBody(true))
  serveObserver(null, { unavailable: true })
  renderStudio()
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Could not load monitoring data')).not.toBeNull()
  expect(alert.querySelector('[data-slot="alert-description"]')?.textContent).toBe('Synthetic observer unavailable')
  expect(screen.queryByRole('tablist', { name: 'Monitoring type' })).toBeNull()
})
