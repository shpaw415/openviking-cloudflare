// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const [connectionSlot, profilesSlot] = [
  'ov_console_connection',
  'ov_console_connection_profiles',
]
const legacy = JSON.stringify({ apiKey: 'synthetic-legacy-placeholder' })
const encrypted = '{"format":"ov-credentials-aes-gcm-v1","ciphertext":"synthetic-unreadable"}'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('crypto', webcrypto)
  localStorage.clear()
  sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function loadStorage() {
  const api = await import('#/features/connection/lib/credential-storage')
  await api.initializeCredentialStorage()
  return api
}

it('keeps new keys only in memory without IndexedDB', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const api = await loadStorage()
  api.writeCredentialStorage(connectionSlot, 'synthetic-new-placeholder')
  await api.flushCredentialStorage()
  expect(localStorage.getItem(connectionSlot)).toBeNull()
  expect(api.credentialStorageMode()).toBe('session')
  expect(api.readCredentialStorage(connectionSlot)).toBe('synthetic-new-placeholder')
})

it('does not adopt or change legacy slots, including the old session mirror', async () => {
  vi.stubGlobal('indexedDB', undefined)
  localStorage.setItem(connectionSlot, legacy)
  localStorage.setItem(profilesSlot, encrypted)
  sessionStorage.setItem('ov_console_api_key', 'synthetic-obsolete-placeholder')
  const api = await loadStorage()
  expect(api.readCredentialStorage(connectionSlot)).toBeNull()
  expect(api.readCredentialStorage(profilesSlot)).toBeNull()
  expect(localStorage.getItem(connectionSlot)).toBe(legacy)
  expect(localStorage.getItem(profilesSlot)).toBe(encrypted)
  expect(sessionStorage.getItem('ov_console_api_key')).toBe('synthetic-obsolete-placeholder')
})

it('does not adopt or migrate a plaintext slot even when IndexedDB exists', async () => {
  const open = vi.fn(() => { throw Error('synthetic IndexedDB failure') })
  vi.stubGlobal('indexedDB', { open })
  localStorage.setItem(connectionSlot, legacy)
  const api = await loadStorage()
  expect(api.readCredentialStorage(connectionSlot)).toBeNull()
  expect(api.credentialStorageMode()).toBe('session')
  expect(localStorage.getItem(connectionSlot)).toBe(legacy)
  expect(open).not.toHaveBeenCalled()
})

it('uses empty memory storage when the key database rejects access', async () => {
  const open = vi.fn(() => { throw Error('synthetic IndexedDB failure') })
  vi.stubGlobal('indexedDB', { open })
  const api = await loadStorage()
  expect(open).toHaveBeenCalledTimes(1)
  expect(api.credentialStorageMode()).toBe('session')
  expect(api.readCredentialStorage(connectionSlot)).toBeNull()
})

it('does not restore a selection marker or persist either credential on reload without Web Crypto', async () => {
  vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  sessionStorage.setItem('ov_studio_workspace_selected', 'selected')
  const store = await loadStorage()
  const setup = await import('#/features/connection/lib/onboarding')
  expect(setup.needsStudioSetup()).toBe(true)
  await setup.completeStudioSetup({
    accountId: 'synthetic', userId: 'fixture', baseUrl: window.location.origin,
    serviceSelection: 'opensource', apiKey: '', adminApiKey: 'synthetic-control-only',
  }, 'Fixture administration')
  expect(store.credentialStorageMode()).toBe('session')
  expect(setup.needsStudioSetup()).toBe(false)
  expect(localStorage.getItem(connectionSlot)).toBeNull()
  expect(localStorage.getItem(profilesSlot)).toBeNull()
  expect(localStorage.getItem('ov_studio_setup')).toBeNull()
  expect(sessionStorage.length).toBe(1)
  vi.resetModules()
  const reloaded = await loadStorage()
  expect(reloaded.readCredentialStorage(connectionSlot)).toBeNull()
  expect(reloaded.readCredentialStorage(profilesSlot)).toBeNull()
  expect((await import('#/features/connection/lib/onboarding')).needsStudioSetup()).toBe(true)
})

it('encrypts both slots using real Web Crypto and opens them with the existing key', async () => {
  const { CredentialStorage } = await import('#/features/connection/lib/credential-storage')
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const getKey = vi.fn(async () => key)
  const store = new CredentialStorage(localStorage, getKey)
  await store.initialize()
  const user = JSON.stringify({ apiKey: 'synthetic-workspace-only' })
  const control = JSON.stringify({ adminApiKey: 'synthetic-control-only' })
  store.write(connectionSlot, user)
  store.write(profilesSlot, control)
  await store.flush()
  expect(key.extractable).toBe(false)
  const connection = localStorage.getItem(connectionSlot)!
  const profiles = localStorage.getItem(profilesSlot)!
  expect(JSON.parse(connection).format).toBe('ov-credentials-aes-gcm-v1')
  expect(connection + profiles).not.toMatch(/synthetic-|apiKey|adminApiKey/)
  const reloaded = new CredentialStorage(localStorage, getKey)
  await reloaded.initialize()
  expect(getKey.mock.calls).toEqual([[true], [false]])
  expect(reloaded.read(connectionSlot)).toBe(user)
  expect(reloaded.read(profilesSlot)).toBe(control)
  // Slot-bound authentication: the two ciphertexts are not interchangeable.
  localStorage.setItem(connectionSlot, profiles)
  await expect(new CredentialStorage(localStorage, getKey).initialize()).rejects.toBeDefined()
  expect(localStorage.getItem(connectionSlot)).toBe(profiles)
})

it('never replaces ciphertext or writes plaintext when storage rejects a write', async () => {
  const { CredentialStorage } = await import('#/features/connection/lib/credential-storage')
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const error = vi.fn()
  const store = new CredentialStorage(localStorage, async () => key, error)
  await store.initialize()
  store.write(connectionSlot, 'synthetic-before')
  await store.flush()
  const before = localStorage.getItem(connectionSlot)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
  store.write(connectionSlot, 'synthetic-unsaved')
  await expect(store.flush()).rejects.toMatchObject({ name: 'QuotaExceededError' })
  expect(error).toHaveBeenCalledOnce()
  expect(localStorage.getItem(connectionSlot)).toBe(before)
  expect(sessionStorage.length).toBe(0)
})
