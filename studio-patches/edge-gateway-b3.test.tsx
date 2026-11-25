// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { KeysPage } from '#/features/admin/gateway/components/keys-page'
import { KeysIssueDialog } from '#/features/admin/gateway/components/keys-issue-dialog'
import { KeysSecretDialog } from '#/features/admin/gateway/components/keys-secret-dialog'
import { PROFILE_DEFAULTS } from '#/features/admin/gateway/lib/profile-schema'
import { UPSTREAM_DEFAULTS } from '#/features/admin/gateway/lib/upstream-schema'
import type { IssuedKey, KeyRequest } from '#/features/admin/gateway/lib/api'
import { GatewayError } from '#/features/admin/gateway/lib/api'

const { request, workspace } = vi.hoisted(() => ({ request: vi.fn(), workspace: { accountId: 'sample-team' } }))
vi.mock('#/shared/api/admin', () => ({ createAdminClient: () => ({ request }) }))
vi.mock('#/features/connection/hooks/use-studio-service', () => ({ useStudioService: () => ({ ready: true, provider: 'opensource' }) }))
vi.mock('#/features/connection/hooks/use-app-connection', () => ({ useAppConnection: () => ({
  connection: { ...workspace, baseUrl: 'http://127.0.0.1', userId: 'sample-member', apiKey: 'synthetic', adminApiKey: '' },
  isConnectionRoleLoading: false, serverMode: 'api_key', isGatewayHost: false,
}) }))
vi.mock('@tanstack/react-router', async (original) => ({ ...await original<typeof import('@tanstack/react-router')>(),
  Link: ({ to, children }: { to: string; children?: React.ReactNode }) => <a href={to}>{children}</a>,
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }) }))

const profile = { ...PROFILE_DEFAULTS, id: 'sample-profile', name: 'Local profile', revision: 1 }
const chat = { ...UPSTREAM_DEFAULTS, id: 'chat-only', name: 'Local Chat', base_url: 'binding://workers-ai', enabled: true,
  revision: 1, has_api_key: false, header_names: [], models: ['declared-only'], aliases: { 'stale-alias': 'declared-only' },
  protocol: 'chat' as const, routable_models: ['live-alias', 'live-model'] }
const responses = { ...chat, id: 'responses-only', name: 'Local Responses', protocol: 'responses' as const, routable_models: ['responses-alias'] }
const otherChat = { ...chat, id: 'different-chat', name: 'Different Chat', routable_models: ['different-chat-alias'] }
const access = () => ({ account_id: workspace.accountId, user_id: 'sample-member', role: 'user' as const,
  can_write_objects: true, can_issue_for_others: false, managed: false, warnings: [], edge: { dedicated_gateway_keys: true }, can_import_vlm: false })
const issueResult = { id: 'fixture', revision: 1, name: 'Fictional QA', user_id: 'sample-member', prefix: 'fixture-prefix',
  created_at: 1, policy_id: profile.id, upstream_ids: [chat.id], models: ['live-alias'], key: 'fixture-once-placeholder' } satisfies IssuedKey
const ok = (data: unknown) => ({ data, status: 200, headers: {} })
let client: QueryClient
let send: (body: KeyRequest) => unknown

function tree(node: React.ReactNode) {
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}
function button(name: string) { return screen.getByRole<HTMLButtonElement>('button', { name }) }
async function issueButton() {
  return waitFor(() => {
    const trigger = button('keys.issue')
    expect(trigger.disabled).toBe(false)
    return trigger
  })
}
function models() { return screen.getByRole<HTMLInputElement>('textbox', { name: /keys.form.models.label/ }) }
function submit() { fireEvent.submit(button('keys.form.submit').form!) }
function add(value: string) {
  fireEvent.change(models(), { target: { value } })
  fireEvent.keyDown(models(), { key: 'Enter' })
}
async function form(upstreams = [chat]) {
  render(tree(<KeysIssueDialog workspaceOnly open profiles={[profile]} upstreams={upstreams}
    defaults={{ upstream_ids: [chat.id] }} onIssued={vi.fn()} onOpenChange={vi.fn()} />))
  await screen.findByText('keys.form.user.self')
  fireEvent.change(screen.getByLabelText('keys.form.name.label'), { target: { value: 'Fictional QA' } })
}
function describedBy(input: HTMLInputElement) {
  return input.getAttribute('aria-describedby')?.split(' ').map((id) => document.getElementById(id)?.textContent)
}
beforeEach(() => {
  workspace.accountId = 'sample-team'
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  send = vi.fn(() => ok(issueResult))
  request.mockImplementation(({ method, url, body }) => {
    if (url.endsWith('/access')) return ok(access())
    if (url.endsWith('/keys')) return method === 'POST' ? send(body) : ok([])
    if (url.endsWith('/policies')) return ok([profile])
    if (url.endsWith('/upstreams')) return ok([chat])
    return ok({ base_url: 'http://127.0.0.1' })
  })
})
afterEach(() => { cleanup(); client.clear(); request.mockReset() })

it.each(['Escape', 'Cancel'])('returns focus to the actual issuing button after %s', async (action) => {
  render(tree(<KeysPage />))
  const opener = await issueButton()
  opener.focus()
  fireEvent.click(opener)
  const dialog = await screen.findByRole('dialog')
  if (action === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
  else fireEvent.click(within(dialog).getByRole('button', { name: 'actions.cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement === opener).toBe(true))
})

it('hands focus to the once dialog, removes the secret on Done and restores to active Refresh when issue becomes unavailable', async () => {
  render(tree(<KeysPage />))
  const opener = await issueButton()
  opener.focus()
  fireEvent.click(opener)
  await screen.findByText('keys.form.user.self')
  fireEvent.change(screen.getByLabelText('keys.form.name.label'), { target: { value: 'Fictional QA' } })
  submit()
  const done = await screen.findByRole('button', { name: 'keys.secret.done' })
  await waitFor(() => {
    const dialog = done.closest('[role="dialog"]')
    expect(dialog?.contains(document.activeElement)).toBe(true)
  })
  act(() => { client.setQueriesData({ predicate: ({ queryKey }) => queryKey[2] === 'upstreams' }, []) })
  await waitFor(() => expect(opener.disabled || !opener.isConnected).toBe(true))
  fireEvent.click(done)
  expect(Boolean(screen.queryByText(issueResult.key, { exact: true }))).toBe(false)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.activeElement === button('actions.refresh')).toBe(true))
  expect(client.getMutationCache().getAll().some((mutation) => typeof mutation.state.data === 'object' && mutation.state.data !== null)).toBe(false)
})

it('does not restore focus to a previous connection or present its late reply', async () => {
  const reply = Promise.withResolvers<ReturnType<typeof ok>>()
  send = vi.fn(() => reply.promise)
  const view = render(tree(<><button>Different view action</button><KeysPage /></>))
  const opener = await issueButton()
  opener.focus()
  fireEvent.click(opener)
  await screen.findByText('keys.form.user.self')
  fireEvent.change(screen.getByLabelText('keys.form.name.label'), { target: { value: 'Fictional QA' } })
  submit()
  await waitFor(() => expect(send).toHaveBeenCalledOnce())
  workspace.accountId = 'other-team'
  view.rerender(tree(<><button>Different view action</button><KeysPage /></>))
  const next = button('Different view action')
  next.focus()
  await act(async () => { reply.resolve(ok(issueResult)); await reply.promise })
  expect(opener.isConnected).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement === next).toBe(true)
})

it('previews and suggests only from the selected catalog; returning to the alias input permits a keyboard correction', async () => {
  await form([chat, responses])
  const selected = screen.getByRole('checkbox', { name: /Local Chat/ }).closest('label')!
  const unchecked = screen.getByRole('checkbox', { name: /Local Responses/ }).closest('label')!
  expect(selected.textContent?.includes('live-alias')).toBe(true)
  expect(selected.textContent?.includes('stale-alias')).toBe(false)
  expect(unchecked.textContent?.includes('responses-alias')).toBe(false)
  expect(screen.queryByRole('button', { name: 'responses-alias' })).toBeNull()
  add('stale-alias')
  button('keys.form.submit').focus()
  submit()
  expect(send).not.toHaveBeenCalled()
  expect(document.activeElement === models()).toBe(true)
  expect(models().getAttribute('aria-invalid')).toBe('true')
  expect(describedBy(models())).toEqual(['keys.edge.modelsHelp', 'keys.edge.modelError'])
  fireEvent.keyDown(models(), { key: 'Backspace' })
  expect(models().getAttribute('aria-invalid')).toBe('false')
  add('live-alias')
  expect(selected.textContent?.includes('live-model')).toBe(false)
  submit()
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ models: ['live-alias'], upstream_ids: [chat.id] })))
})

it('accepts an empty allowlist without manufacturing a model restriction', async () => {
  await form()
  submit()
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ models: [] })))
  expect(models().getAttribute('aria-invalid')).toBe('false')
})

it('focuses and describes the field on a server model refusal after pending clears', async () => {
  send = vi.fn(() => { throw new GatewayError('Fixture refusal', 400, undefined, 'model_not_allowed') })
  await form()
  add('live-alias')
  button('keys.form.submit').focus()
  submit()
  await waitFor(() => expect(models().getAttribute('aria-invalid')).toBe('true'))
  expect(send).toHaveBeenCalledOnce()
  expect(document.activeElement === models()).toBe(true)
  expect(describedBy(models())).toContain('keys.edge.modelError')
})

it('only makes client examples for an effective selected rule with a compatible protocol and restriction', async () => {
  const { rerender } = render(tree(<KeysSecretDialog workspaceOnly open issued={{ ...issueResult, upstream_ids: [chat.id, responses.id] }}
    baseUrl="http://127.0.0.1" upstreams={[chat, responses, otherChat]} onDone={vi.fn()} />))
  const panel = await screen.findByRole('tabpanel')
  expect(panel.textContent?.includes('Model: live-alias')).toBe(true)
  expect(panel.textContent?.includes('declared-only')).toBe(false)
  fireEvent.click(screen.getByRole('tab', { name: 'connect.clients.codex.name' }))
  expect(await screen.findByText('keys.edge.exampleUnavailable')).toBeTruthy()
  expect(screen.getByRole('tabpanel').querySelector('pre')).toBeNull()
  rerender(tree(<KeysSecretDialog workspaceOnly open issued={{ ...issueResult, models: ['different-chat-alias'] }}
    baseUrl="http://127.0.0.1" upstreams={[chat, responses, otherChat]} onDone={vi.fn()} />))
  fireEvent.click(screen.getByRole('tab', { name: 'connect.clients.chat.name' }))
  expect(await screen.findByText('keys.edge.exampleUnavailable')).toBeTruthy()
  expect(screen.getByRole('tabpanel').querySelector('pre')).toBeNull()
})
