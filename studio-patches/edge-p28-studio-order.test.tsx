// @vitest-environment jsdom
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KeysPage } from '#/features/admin/gateway/components/keys-page'
import { PROFILE_DEFAULTS } from '#/features/admin/gateway/lib/profile-schema'
import { UPSTREAM_DEFAULTS } from '#/features/admin/gateway/lib/upstream-schema'
import { useUpstreams } from '#/features/admin/gateway/lib/use-gateway'
import { Composer } from '#/features/workbench/sessions/components/composer'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('#/shared/api/admin', () => ({ createAdminClient: () => ({ request }) }))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({ useStudioService: () => ({ ready: true, provider: 'opensource' }) }))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({ useAppConnection: () => ({
  connection: { accountId: 'fixture', userId: 'reader', apiKey: 'fixture-only', adminApiKey: '', baseUrl: 'http://127.0.0.1' },
  isConnectionRoleLoading: false, serverMode: 'api_key', isGatewayHost: false,
}) }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<typeof import('@tanstack/react-router')>(),
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }))

const profile = { ...PROFILE_DEFAULTS, id: 'fixture-profile', name: 'Local profile', revision: 1 }
const upstream = { ...UPSTREAM_DEFAULTS, id: 'fixture-model', name: 'Local model', base_url: 'binding://workers-ai', enabled: true,
  revision: 1, has_api_key: false, header_names: [], models: ['local-model'], routable_models: ['local-model'] }
const access = { account_id: 'fixture', user_id: 'reader', role: 'user', can_write_objects: false,
  can_issue_for_others: false, managed: false, warnings: [], edge: { dedicated_gateway_keys: true } }
const ok = (data: unknown) => ({ data, status: 200, headers: {} })
const held: Array<() => void> = []
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const label = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'chat.placeholder' })
afterEach(() => {
  cleanup()
  notifyManager.setScheduler(callback => setTimeout(callback, 0))
  held.splice(0).forEach(callback => callback())
  vi.restoreAllMocks()
  request.mockReset()
})

function UpstreamName({ enabled = true }: { enabled?: boolean }) {
  const query = useUpstreams({ enabled })
  return <p>{!enabled ? 'Disabled' : query.data?.[0]?.name ?? 'Waiting for upstreams'}</p>
}

it('shows the scoped upstream result before the observer timer, without starting a disabled read', async () => {
  notifyManager.setScheduler(callback => held.push(callback))
  let finish!: (response: ReturnType<typeof ok>) => void
  request.mockReturnValue(new Promise(resolve => { finish = resolve }))
  const queryClient = client()
  const tree = (enabled: boolean) => <QueryClientProvider client={queryClient}><UpstreamName enabled={enabled} /></QueryClientProvider>
  const view = render(tree(false))
  expect(request).not.toHaveBeenCalled()
  view.rerender(tree(true))
  expect(screen.getByText('Waiting for upstreams')).toBeTruthy()
  await act(async () => finish(ok([upstream])))
  expect(queryClient.getQueryCache().getAll().some(query => query.state.status === 'success')).toBe(true)
  expect(held.length).toBeGreaterThan(0)
  expect(screen.getByText('Local model')).toBeTruthy()
  expect(request).toHaveBeenCalledTimes(1)
  view.unmount()
  await act(async () => held.splice(0).forEach(callback => callback()))
  expect(screen.queryByText('Local model')).toBeNull()
  queryClient.clear()
})

it('commits a synchronous send within the originating input dispatch', () => {
  const send = vi.fn(() => true)
  render(<Composer onSend={send} onCancel={vi.fn()} isStreaming />)
  fireEvent.change(label(), { target: { value: 'first synthetic turn' } })
  fireEvent.keyDown(label(), { key: 'Enter' })
  expect(send).toHaveBeenCalledWith('first synthetic turn')
  expect(label().value).toBe('')
})

it('does not let a late send clear a newly mounted composer', async () => {
  let finish!: (value: boolean) => void
  const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
  const tree = (identity: string) => <Composer key={identity} onSend={send} onCancel={vi.fn()} isStreaming />
  const view = render(tree('former'))
  fireEvent.change(label(), { target: { value: 'former message' } })
  fireEvent.keyDown(label(), { key: 'Enter' })
  view.rerender(tree('current'))
  const target = label()
  fireEvent.change(target, { target: { value: 'new draft' } })
  await act(async () => finish(true))
  expect(target.value).toBe('new draft')
  expect(document.activeElement).toBe(target)
  expect(send).toHaveBeenCalledTimes(1)
})

it('returns focus after physical close without waiting for a stale focus frame', async () => {
  request.mockImplementation(({ url }) => ok(url.endsWith('/access') ? access : url.endsWith('/policies') ? [profile]
    : url.endsWith('/upstreams') ? [upstream] : []))
  const queryClient = client()
  const view = render(<QueryClientProvider client={queryClient}><KeysPage /></QueryClientProvider>)
  const trigger = await waitFor(() => {
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'keys.issue' })
    expect(button.disabled).toBe(false)
    return button
  })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog')
  const focused = dialog.querySelector('input')
  focused?.focus()
  const focusedAfterRemoval = Promise.withResolvers<Element | null>()
  const observer = new MutationObserver(() => {
    if (!dialog.isConnected) {
      focusedAfterRemoval.resolve(document.activeElement)
      observer.disconnect()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  try {
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(await focusedAfterRemoval.promise).toBe(trigger)
  } finally {
    observer.disconnect()
    view.unmount()
    queryClient.clear()
  }
})
