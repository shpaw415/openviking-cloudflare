// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { deleteAdminAccount } from '#/shared/api/admin'
import { deleteAdminAccountByAccountId } from '#/shared/api/ov-client/index'

vi.mock('#/shared/api/ov-client/index', async (original) => ({
  ...await original<typeof import('#/shared/api/ov-client/index')>(),
  deleteAdminAccountByAccountId: vi.fn(),
}))

it('reports a retained-data revocation without manufacturing a purge task', async () => {
  const connection = { baseUrl: window.location.origin, accountId: 'synthetic', userId: '', apiKey: 'synthetic-root' }
  const response = (result: unknown) => ({ status: 202, headers: {}, data: { status: 'ok', result } })
  const send = vi.mocked(deleteAdminAccountByAccountId)
  send.mockResolvedValueOnce(response({ status: 'revoked', data_retained: true }) as Awaited<ReturnType<typeof send>>)
  await expect(deleteAdminAccount(connection, 'synthetic')).resolves.toBeUndefined()
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ path: { account_id: 'synthetic' } }))
  send.mockResolvedValueOnce(response({ task_id: 'synthetic-legacy' }) as Awaited<ReturnType<typeof send>>)
  await expect(deleteAdminAccount(connection, 'synthetic')).rejects.toBeInstanceOf(Error)
})
