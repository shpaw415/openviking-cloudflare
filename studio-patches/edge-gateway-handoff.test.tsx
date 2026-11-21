// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppConnectionProvider, useAppConnection } from '#/features/connection/hooks/use-app-connection'

// This additional regression covers the standalone upstream compatibility branch.
// The edge deployment itself still pins the server to the document's origin.
vi.mock('#/shared/lib/edge-studio', () => ({ EDGE_STUDIO: false, allowsStudioApiBase: () => true }))
const { health, navigate } = vi.hoisted(() => ({ health: vi.fn(), navigate: vi.fn() }))
vi.mock('#/features/connection/lib/health', async (original) => ({
  ...(await original<typeof import('#/features/connection/lib/health')>()),
  fetchServerHealth: health,
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, useRouterState: () => '/' }))
vi.mock('#/features/connection/lib/credential-storage', () => ({
  readCredentialStorage: (key: string) => localStorage.getItem(key),
  writeCredentialStorage: (key: string, value: string) => localStorage.setItem(key, value),
  flushCredentialStorage: async () => {},
}))

afterEach(() => { cleanup(); localStorage.clear(); vi.resetAllMocks(); window.history.replaceState(null, '', '/') })

it('adopts the already verified anonymous gateway health without another boot request', async () => {
  window.history.replaceState(null, '', '/studio/')
  localStorage.setItem('ov_console_connection', JSON.stringify({
    baseUrl: 'https://previous.invalid', adminApiKey: 'synthetic-root', apiKey: 'synthetic-user',
    accountId: 'old', userId: 'old',
  }))
  health.mockImplementation(async (_url, headers) => {
    expect(headers?.['X-API-Key']).toBeUndefined()
    return { service: 'openviking-gateway', auth_mode: 'api_key', openviking_url: 'https://fixture.invalid' }
  })
  function State() {
    const { connection, serverMode } = useAppConnection()
    return <output>{`${serverMode}:${connection.baseUrl}:${connection.apiKey}:${connection.adminApiKey}`}</output>
  }
  render(<QueryClientProvider client={new QueryClient()}><AppConnectionProvider><State /></AppConnectionProvider></QueryClientProvider>)
  await screen.findByText(`api_key:${window.location.origin}::`)
  expect(health.mock.calls.map(([url]) => url)).toEqual([window.location.origin])
})
