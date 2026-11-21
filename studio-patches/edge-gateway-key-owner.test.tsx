// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { KeysIssueDialog } from '#/features/admin/gateway/components/keys-issue-dialog'
import { PROFILE_DEFAULTS } from '#/features/admin/gateway/lib/profile-schema'
import { UPSTREAM_DEFAULTS } from '#/features/admin/gateway/lib/upstream-schema'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('#/shared/api/admin', () => ({ createAdminClient: () => ({ request }) }))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({
  useStudioService: () => ({ ready: true, provider: 'opensource' }),
}))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({
  useAppConnection: () => ({
    connection: {
      baseUrl: 'https://studio.example.invalid', accountId: 'fixture-team',
      userId: 'fixture-admin', apiKey: '', adminApiKey: 'fixture-only',
    },
    isConnectionRoleLoading: false,
    serverMode: 'api_key',
  }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const user = { user_id: 'fixture-user', role: 'user', api_key_available: true }
const access = {
  role: 'admin', user_id: 'fixture-admin', account_id: 'fixture-team',
  can_write_objects: true, can_issue_for_others: true, managed: false, warnings: [],
}
const profile = { ...PROFILE_DEFAULTS, id: 'fixture-profile', name: 'Fixture profile', revision: 1 }
const upstream = {
  ...UPSTREAM_DEFAULTS, id: 'fixture-source', name: 'Fixture source',
  revision: 1, has_api_key: false, header_names: [],
}
const accessPath = '/gateway/admin/access'
const usersPath = '/api/v1/admin/accounts/fixture-team/users'
const keysPath = '/gateway/admin/keys'
const ok = (data: unknown) => ({ data, headers: {}, status: 200 })
const picker = () => screen.getByRole('combobox', { name: 'keys.form.user.label' })
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: 'keys.form.submit' })
const calls = () => request.mock.calls.map(([options]) => [options.method, options.url])

function fixture() {
  request.mockReset()
  const accessReply = Promise.withResolvers<ReturnType<typeof ok>>()
  const usersReply = Promise.withResolvers<ReturnType<typeof ok>>()
  request.mockImplementation(({ method, url }) => {
    if (method === 'GET' && url === accessPath) return accessReply.promise
    if (method === 'GET' && url === usersPath) return usersReply.promise
    if (method === 'POST' && url === keysPath) return Promise.resolve(ok({ id: 'fixture-issued' }))
    throw new Error(`Unexpected fixture call: ${method} ${url}`)
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onIssued = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <KeysIssueDialog open onOpenChange={vi.fn()} profiles={[profile]} upstreams={[upstream]} onIssued={onIssued} />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('keys.form.name.label'), { target: { value: 'Fixture key' } })
  return { client, accessReply, usersReply, onIssued }
}

afterEach(cleanup)

it('starts the permitted account read even if the view has not processed the access notification', async () => {
  // Hold delivery to observers, not the transport or its promises. No sleeps,
  // fake clock, CPU load, or change to an original test's deadline.
  const notifications: Array<() => void> = []
  notifyManager.setScheduler((callback) => notifications.push(callback))
  try {
    const { client, accessReply, usersReply } = fixture()
    expect(calls()).toEqual([['GET', accessPath]])
    const accessQuery = client.getQueryCache().find({ queryKey: ['gateway'], exact: false,
      predicate: (query) => query.queryKey[2] === 'access' })
    if (!accessQuery?.promise) throw new Error('No access request in flight')
    await act(async () => {
      accessReply.resolve(ok(access))
      await accessQuery.promise
    })
    expect(calls()).toEqual([['GET', accessPath], ['GET', usersPath]])
    expect(request.mock.calls[1][0].query).toEqual({ include_credentials: false })
    usersReply.resolve(ok([user]))
  } finally {
    notifyManager.setScheduler((callback) => setTimeout(callback, 0))
    cleanup()
  }
})

it('announces a pending owner without issuing early, then submits the real selected user', async () => {
  const { accessReply, usersReply, onIssued } = fixture()
  expect(submit().disabled).toBe(true)
  const owner = picker()
  expect(owner.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('status').textContent).toBe('keys.form.user.loading')
  expect(screen.queryByText('keys.form.user.self')).toBeNull()
  fireEvent.submit(submit().form!)
  expect(calls()).toEqual([['GET', accessPath]])

  accessReply.resolve(ok(access))
  await waitFor(() => expect(calls()).toEqual([['GET', accessPath], ['GET', usersPath]]))
  expect(submit().disabled).toBe(true)
  fireEvent.submit(submit().form!)
  expect(calls()).toEqual([['GET', accessPath], ['GET', usersPath]])

  usersReply.resolve(ok([user]))
  await waitFor(() => expect(owner.textContent).toContain('fixture-user'))
  expect(picker()).toBe(owner)
  expect(owner.hasAttribute('aria-busy')).toBe(false)
  expect(screen.getByRole('status').textContent).toBe('keys.form.user.ready')
  expect(submit().disabled).toBe(false)
  fireEvent.click(submit())
  await waitFor(() => expect(onIssued).toHaveBeenCalledWith({ id: 'fixture-issued' }))
  expect(calls()).toEqual([['GET', accessPath], ['GET', usersPath], ['POST', keysPath]])
  expect(request.mock.calls[2][0].body).toEqual({
    name: 'Fixture key', user_id: 'fixture-user', policy_id: 'fixture-profile',
    upstream_ids: ['fixture-source'], models: [],
  })
})

it('never loads the account directory for an explicit self-only permission', async () => {
  const { accessReply, onIssued } = fixture()
  accessReply.resolve(ok({ ...access, role: 'user', can_issue_for_others: false }))
  await screen.findByText('keys.form.user.self')
  expect(screen.queryByRole('combobox', { name: 'keys.form.user.label' })).toBeNull()
  expect(screen.queryByText('keys.form.openvikingKey.paste')).toBeNull()
  fireEvent.click(submit())
  await waitFor(() => expect(onIssued).toHaveBeenCalledWith({ id: 'fixture-issued' }))
  expect(calls()).toEqual([['GET', accessPath], ['POST', keysPath]])
  expect(request.mock.calls[1][0].body).not.toHaveProperty('user_id')
  expect(request.mock.calls[1][0].body).not.toHaveProperty('openviking_key')
})

it('does not use a role or a truthy non-boolean as permission to load users', async () => {
  const { accessReply } = fixture()
  accessReply.resolve(ok({ ...access, can_issue_for_others: 'true' }))
  await screen.findByText('keys.form.user.accessUnavailable')
  expect(submit().disabled).toBe(true)
  expect(screen.queryByText('keys.form.openvikingKey.paste')).toBeNull()
  expect(calls()).toEqual([['GET', accessPath]])
})
