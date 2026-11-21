// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { fetchConnectionHealth } from '#/features/connection/lib/health'
import { studioSetupDestination, verifyStudioSetup } from '#/features/connection/lib/onboarding'
import { fetchEdgeFeatures } from '#/shared/lib/edge-capabilities'

const { get, create } = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }))
vi.mock('#/gen/ov-client/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('#/gen/ov-client/client')>()
  return { ...original, createClient: (...options: Parameters<typeof original.createClient>) =>
    create(...options) ?? original.createClient(...options) }
})
vi.mock('#/features/connection/lib/health', async (importOriginal) => ({
  ...await importOriginal<typeof import('#/features/connection/lib/health')>(),
  fetchConnectionHealth: vi.fn(),
}))
vi.mock('#/shared/lib/edge-capabilities', async (importOriginal) => ({
  ...await importOriginal<typeof import('#/shared/lib/edge-capabilities')>(),
  fetchEdgeFeatures: vi.fn(),
}))

const synthetic = () => ({
  accountId: 'default', userId: 'default', baseUrl: window.location.origin,
  serviceSelection: 'opensource' as const, apiKey: '', adminApiKey: '',
})
const health = (role: 'root' | 'admin' | 'user') => ({ status: 'ok', healthy: true, version: 'fixture', auth_mode: 'api_key' as const, role, account_id: 'tenant-example', user_id: 'person-example' })
const signal = () => new AbortController().signal

beforeEach(() => {
  vi.resetAllMocks()
  create.mockReturnValue({ get })
  get.mockResolvedValue({ status: 200, headers: {}, data: { status: 'ok', result: [] } })
  vi.mocked(fetchEdgeFeatures).mockResolvedValue({ control: true })
})

it('uses the Root key for the control probe, never the workspace probe', async () => {
  vi.mocked(fetchConnectionHealth).mockResolvedValue(health('root'))
  const profile = await verifyStudioSetup({ ...synthetic(), adminApiKey: 'synthetic-root' }, signal())
  expect(profile).toMatchObject({ apiKey: '', adminApiKey: 'synthetic-root' })
  expect(studioSetupDestination(profile)).toBe('/admin')
  expect(get).toHaveBeenCalledOnce()
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/v1/admin/accounts' }))
})

it('uses the verified tenant for account-admin, without adopting the key into a data profile', async () => {
  vi.mocked(fetchConnectionHealth).mockResolvedValue(health('admin'))
  const profile = await verifyStudioSetup({ ...synthetic(), adminApiKey: 'synthetic-admin' }, signal())
  expect(profile).toMatchObject({ accountId: 'tenant-example', apiKey: '', adminApiKey: 'synthetic-admin' })
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/v1/admin/accounts/{account_id}/users', path: { account_id: 'tenant-example' } }))
})

it('does not elevate the workspace key or run a management probe', async () => {
  vi.mocked(fetchConnectionHealth).mockResolvedValue(health('user'))
  const profile = await verifyStudioSetup({ ...synthetic(), apiKey: 'synthetic-user' }, signal())
  expect(profile).toMatchObject({ apiKey: 'synthetic-user', adminApiKey: '' })
  expect(studioSetupDestination(profile)).toBe('/home')
  expect(fetchEdgeFeatures).not.toHaveBeenCalled()
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/v1/fs/ls' }))
})

it('requires a positive control flag and never repurposes a Root key entered into the workspace field', async () => {
  vi.mocked(fetchConnectionHealth).mockResolvedValue(health('root'))
  vi.mocked(fetchEdgeFeatures).mockResolvedValue({})
  await expect(verifyStudioSetup({ ...synthetic(), adminApiKey: 'synthetic-root' }, signal())).rejects.toMatchObject({ code: 'studio:edge.unsupportedTitle' })
  await expect(verifyStudioSetup({ ...synthetic(), apiKey: 'synthetic-root' }, signal())).rejects.toMatchObject({ code: 'studio:edge.wrongProfile' })
  expect(get).not.toHaveBeenCalled()
})
