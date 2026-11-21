// @vitest-environment jsdom
import { UserMemoryPolicyCell } from '#/features/admin/users/components/user-memory-policy-cell'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ fetch: vi.fn(), update: vi.fn() }))
vi.mock('#/shared/api/admin', () => ({ fetchUserMemorySettings: api.fetch, updateUserMemorySettings: api.update }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('keeps the Root Users row rendered for a 200 with memory_policy null, with no editing affordance', async () => {
  api.fetch.mockResolvedValue({ memory_policy: null })
  const mount = () => render(
    <QueryClientProvider client={new QueryClient()}>
      <table><tbody><tr><th scope="row">Synthetic user</th><td>
        <UserMemoryPolicyCell connection={{ baseUrl: window.location.origin, accountId: 'example', userId: '', apiKey: 'synthetic-root' }} user={{ accountId: 'example', userId: 'fixture-user', role: 'user' }} />
      </td></tr></tbody></table>
    </QueryClientProvider>,
  )
  for (let replay = 0; replay < 2; replay += 1) {
    const rendered = mount()
    const row = within(screen.getByRole('row'))
    expect(await row.findByText('studio:edge.memoryPolicyUnavailable')).toBeDefined()
    expect(row.getByText('Synthetic user')).toBeDefined()
    expect(row.queryByRole('button')).toBeNull()
    rendered.unmount()
  }
  expect(api.fetch).toHaveBeenCalledTimes(2)
  expect(api.update).not.toHaveBeenCalled()
})
