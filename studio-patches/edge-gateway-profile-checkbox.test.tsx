// @vitest-environment jsdom
import { ProfileSettingsForm } from '#/features/admin/gateway/components/profiles-settings'
import { ReadOnlyProvider } from '#/features/admin/gateway/components/read-only'
import { PROFILE_DEFAULTS } from '#/features/admin/gateway/lib/profile-schema'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { computeAccessibleDescription } from 'dom-accessibility-api'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('#/features/admin/gateway/lib/use-gateway', () => ({
  useTools: () => ({ isPending: false, isError: false, data: [
    { name: 'read', description: 'Read a file', annotations: { readOnlyHint: true } },
    { name: 'write', description: 'Write a file', annotations: { readOnlyHint: false } },
    { name: 'other', description: 'Other tool' },
  ] }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}))
afterEach(cleanup)

function mount(readOnly = false) {
  function Form() {
    const [profile, setProfile] = useState({ ...PROFILE_DEFAULTS, gateway_tools: true, disabled_tools: ['read', 'removed_tool'] })
    return <ReadOnlyProvider value={readOnly}>
      <ProfileSettingsForm value={profile} onChange={(delta) => setProfile({ ...profile, ...delta })} errors={{}} />
      <output aria-label="Disabled fixture tools">{profile.disabled_tools.join(',')}</output>
    </ReadOnlyProvider>
  }
  return render(<Form />)
}

it('exposes the name, selection and explicit annotation independently, and Space edits the profile', async () => {
  mount()
  const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'read', checked: false })
  expect(box).toBeInstanceOf(HTMLInputElement)
  expect(box.disabled).toBe(false)
  expect(computeAccessibleDescription(box)).toBe('profiles.tools.readOnly Read a file')
  expect(computeAccessibleDescription(screen.getByRole('checkbox', { name: 'write' }))).toBe('profiles.tools.modifiesData Write a file')
  expect(computeAccessibleDescription(screen.getByRole('checkbox', { name: 'other' }))).toBe('Other tool')
  box.focus()
  expect(document.activeElement).toBe(box)
  await userEvent.keyboard('[Space]')
  expect(screen.getByRole('checkbox', { name: 'read', checked: true })).toBe(box)
  expect(box.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByLabelText('Disabled fixture tools').textContent).toBe('removed_tool')
})

it('keeps the genuine permission read-only even for a selected tool', async () => {
  mount(true)
  const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'write', checked: true })
  expect(box).toBeInstanceOf(HTMLInputElement)
  expect(box.disabled).toBe(true)
  await userEvent.click(box)
  expect(box.checked).toBe(true)
  expect(screen.getByLabelText('Disabled fixture tools').textContent).toBe('read,removed_tool')
})
