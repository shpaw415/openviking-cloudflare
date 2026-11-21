// @vitest-environment jsdom
import { StudioFeatureBoundary } from '#/app/layouts/studio-feature-boundary'
import { EdgeFeatureProvider } from '#/features/connection/hooks/use-edge-features'
import { fetchBotHealth } from '#/features/workbench/sessions/lib/api'
import { ovClient } from '#/shared/api/ov-client/index'
import { cleanup, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pathname: '/vikingbot' }))
const connection = { accountId: 'tenant', userId: 'person', baseUrl: window.location.origin, serviceSelection: 'opensource' as const, apiKey: 'synthetic-user', adminApiKey: '' }
vi.mock('@tanstack/react-router', () => ({ useRouterState: () => state.pathname, Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({ useAppConnection: () => ({ connection, connectionRole: 'user', isConnectionRoleLoading: false, serverMode: 'api_key', studioMode: 'workbench' }) }))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({ useStudioService: () => ({ provider: 'opensource', ready: true, isChecking: false }) }))
vi.mock('#/features/connection/hooks/use-studio-capabilities', () => ({ useStudioCapabilities: () => ({}) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Gate({ children }: { children: ReactNode }) {
  return <EdgeFeatureProvider connection={connection} management={false} enabled><StudioFeatureBoundary>{children}</StudioFeatureBoundary></EdgeFeatureProvider>
}

it.each([['/vikingbot', 'bot'], ['/compile', 'compile'], ['/watches', 'watches']])(
  'mounts %s only on its own booleans from the authenticated response', async (path, flag) => {
    state.pathname = path
    const envelope = (value: unknown) => Response.json({ status: 'ok', result: { features: { [flag]: value }, links: [path] } })
    const fetch = vi.fn(async () => envelope('true'))
    vi.stubGlobal('fetch', fetch)
    const forbidden = render(<Gate><span>real route child</span></Gate>)
    await screen.findByText('edge.unsupportedTitle')
    expect(screen.queryByText('real route child')).toBeNull()
    forbidden.unmount()
    fetch.mockResolvedValueOnce(envelope(true))
    render(<Gate><span>real route child</span></Gate>)
    await screen.findByText('real route child')
    expect(fetch).toHaveBeenCalledTimes(2)
  },
)

it('lets the original bot probe run with the data key after admission, not before', async () => {
  state.pathname = '/vikingbot'
  ovClient.setOptions({ baseUrl: connection.baseUrl, credentialScope: 'data' })
  ovClient.setConnection({ apiKey: connection.apiKey, adminApiKey: '', identityHeaders: false })
  const observed = vi.fn()
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('X-API-Key')).toBe(connection.apiKey)
    const path = new URL(url).pathname
    if (path === '/api/v1/system/edge-capabilities') return Response.json({ status: 'ok', result: { features: { bot: true } } })
    expect(path).toBe('/bot/v1/health')
    return Response.json({ status: 'healthy', generation: 'configured_not_probed', persists_messages: true })
  })
  vi.stubGlobal('fetch', fetch)
  function Probe() {
    useEffect(() => { void fetchBotHealth().then(observed) }, [])
    return <span>bot view</span>
  }
  render(<Gate><Probe /></Gate>)
  expect(screen.queryByText('bot view')).toBeNull()
  await screen.findByText('bot view')
  await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(expect.objectContaining({ status: 'healthy' })))
  expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v1/system/edge-capabilities', '/bot/v1/health'])
})
