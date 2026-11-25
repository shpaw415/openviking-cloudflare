// SPDX-License-Identifier: AGPL-3.0-only

// Public lexical envelope shared by provider admission and the SSE boundary.
// Neither the particular credential nor its length influences frame release.
const outside = /[^A-Za-z0-9._~+/=-]/u
export const maxProviderCredentialLength = 2048
export const breaksProviderCredential = (value: string): boolean => outside.test(value)
export const isProviderCredential = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 16 && value.length <= maxProviderCredentialLength && !breaksProviderCredential(value)
