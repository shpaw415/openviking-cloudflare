// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KeysIssueDialog } from '#/features/admin/gateway/components/keys-issue-dialog'
import { GatewayLayout } from '#/features/admin/gateway/components/gateway-layout'
import { PROFILE_DEFAULTS } from '#/features/admin/gateway/lib/profile-schema'
import { UPSTREAM_DEFAULTS } from '#/features/admin/gateway/lib/upstream-schema'
import { edgeKeyAccessReason, edgeRoutableModels } from '#/features/admin/gateway/lib/use-gateway'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('#/shared/api/admin', () => ({ createAdminClient: () => ({ request }) }))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({ useStudioService: () => ({ ready: true, provider: 'opensource' }) }))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({ useAppConnection: () => ({
  connection: { baseUrl: 'http://127.0.0.1', accountId: 'sample-team', userId: 'sample-admin', apiKey: 'synthetic', adminApiKey: '' },
  isConnectionRoleLoading: false, serverMode: 'api_key', isGatewayHost: false,
}) }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<typeof import('@tanstack/react-router')>(),
  Link: ({ to, children }: {to: string; children?: React.ReactNode}) => <a href={to}>{children}</a>,
  Outlet: () => <p>Protected keys outlet</p>,
  useNavigate: () => vi.fn(), useRouterState: () => '/admin/gateway/keys',
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const access = { account_id: 'sample-team', user_id: 'sample-admin', role: 'admin' as const,
  can_write_objects: true, can_issue_for_others: true, managed: false, warnings: [], edge: { dedicated_gateway_keys: true }, can_import_vlm: false }
const upstream = { ...UPSTREAM_DEFAULTS, id: 'sample-route', name: 'Local rule', base_url: 'binding://workers-ai', enabled: true,
  revision: 1, has_api_key: false, header_names: [], models: ['declared-model'], routable_models: ['live-alias'] }
const profile = { ...PROFILE_DEFAULTS, id: 'sample-profile', name: 'Local profile', revision: 1 }
const ok = (data: unknown) => ({ data, status: 200, headers: {} })
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: 'keys.form.submit' })
const directory = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'keys.edge.recipient' })
const proof = () => screen.queryByLabelText<HTMLInputElement>('keys.edge.proofLabel')
const calls = (method: string, suffix: string) => request.mock.calls.filter(([r]) => r.method === method && r.url.endsWith(suffix))

function providers(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

function openDialog(users: () => unknown, issue: () => unknown, grant = access) {
  request.mockImplementation(({ method, url }) => {
    if (url.endsWith('/access')) return ok(grant)
    if (url.endsWith('/users')) return users()
    if (method === 'POST' && url.endsWith('/keys')) return issue()
    throw Error('unexpected fixture request')
  })
  const issued = vi.fn()
  const view = providers(<KeysIssueDialog workspaceOnly open profiles={[profile]} upstreams={[upstream]} onIssued={issued} onOpenChange={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('keys.form.name.label'), { target: { value: 'Local receipt key' } })
  return { ...view, issued }
}

afterEach(() => { cleanup(); request.mockReset() })

it('rechecks the second access gate rather than opening Keys when authority is ambiguous', async () => {
  let attempt = 0
  request.mockImplementation(({ url }) => url.endsWith('/access') ? ok(++attempt === 1 ? { ...access, edge: {} } : access) : ok({}))
  providers(<GatewayLayout />)
  expect(await screen.findByText('keys.edge.access.unconfirmed')).toBeTruthy()
  expect(screen.queryByText('Protected keys outlet')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'keys.edge.verify' }))
  expect(await screen.findByText('Protected keys outlet')).toBeTruthy()
  expect(attempt).toBe(2)
  const who = { accountId: access.account_id, userId: access.user_id }
  expect(edgeKeyAccessReason({ ...access, account_id: 'different' }, who)).toBe('wrongIdentity')
  expect(edgeKeyAccessReason({ ...access, role: 'root' }, who)).toBe('wrongRole')
  expect(edgeKeyAccessReason({ ...access, edge: { dedicated_gateway_keys: false } }, who)).toBe('unmounted')
})

it('confirms a named same-account beneficiary, clears proof when they change, and recovers a failed directory', async () => {
  let available = false
  const users = [{ user_id: 'member-one', role: 'user' }, { user_id: 'member-two', role: 'user' }]
  let sent: { user_id: string; verified: boolean } | undefined
  const { issued } = openDialog(() => { if (!available) throw Error('directory fixture unavailable'); return ok(users) }, () => {
    const body = calls('POST', '/keys').at(-1)![0].body
    sent = { user_id: body.user_id, verified: body.openviking_key === 'synthetic-fixture-proof' }
    return ok({ id: 'issued-fixture' })
  })
  fireEvent.click(await screen.findByRole('radio', { name: 'keys.edge.forOther' }))
  expect(await screen.findByText('keys.edge.directoryFailed')).toBeTruthy()
  expect(proof()).toBeNull()
  expect(submit().disabled).toBe(true)
  expect(calls('POST', '/keys')).toHaveLength(0)
  available = true
  fireEvent.click(screen.getByRole('button', { name: 'keys.edge.retryDirectory' }))
  await screen.findByRole('option', { name: 'member-one' })
  expect(directory().value).toBe('')
  fireEvent.change(directory(), { target: { value: 'member-one' } })
  expect(proof()).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'keys.edge.confirm' }))
  expect(proof()).toBe(document.activeElement)
  expect(screen.getByText('keys.edge.proofHelp')).toBeTruthy()
  fireEvent.change(proof()!, { target: { value: 'first-synthetic-proof' } })
  fireEvent.change(directory(), { target: { value: 'member-two' } })
  expect(proof()).toBeNull()
  expect(submit().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'keys.edge.confirm' }))
  expect(proof()?.value.length).toBe(0)
  fireEvent.change(proof()!, { target: { value: 'synthetic-fixture-proof' } })
  fireEvent.submit(submit().form!)
  await waitFor(() => expect(issued).toHaveBeenCalledOnce())
  expect(sent).toEqual({ user_id: 'member-two', verified: true })
})

it('does not present a late issued secret after the originating view unmounts', async () => {
  const reply = Promise.withResolvers<ReturnType<typeof ok>>()
  const { unmount, issued } = openDialog(() => { throw Error('no directory for self') }, () => reply.promise)
  await screen.findByText('keys.form.user.self')
  fireEvent.submit(submit().form!)
  await waitFor(() => expect(calls('POST', '/keys')).toHaveLength(1))
  unmount()
  await act(async () => { reply.resolve(ok({ id: 'fixture-only', key: 'synthetic-display-value' })); await reply.promise })
  expect(issued).not.toHaveBeenCalled()
  expect(calls('GET', '/users')).toHaveLength(0)
})

it('offers effective models only and refuses a typed alias outside the selected rules', async () => {
  expect(edgeRoutableModels(upstream)).toEqual(['live-alias'])
  expect(edgeRoutableModels({ ...upstream, routable_models: undefined })).toEqual([])
  expect(edgeRoutableModels({ ...upstream, enabled: false })).toEqual([])
  openDialog(() => { throw Error('no directory for self') }, () => ok({ id: 'fixture-issued' }))
  await screen.findByText('keys.form.user.self')
  const field = screen.getByPlaceholderText('keys.form.models.placeholder')
  fireEvent.change(field, { target: { value: 'declared-model' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  fireEvent.submit(submit().form!)
  expect(await screen.findByText('keys.edge.modelError')).toBeTruthy()
  expect(calls('POST', '/keys')).toHaveLength(0)
})
