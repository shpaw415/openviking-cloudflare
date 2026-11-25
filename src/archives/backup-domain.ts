// SPDX-License-Identifier: AGPL-3.0-only
import type { Filesystem } from '../fs/store.js'
import type { Scope } from './backup-authority.js'
import { topology } from './backup-codec.js'
import { ROOT, invalid, uriOf } from '../fs/contract.js'
import { canonicalParts } from './zip.js'

export type Domain = { sql: SqlStorage; scope: Scope; fs: (owner?: string) => Filesystem }
export const hasTable = (sql: SqlStorage, name: string) => sql.exec(`PRAGMA table_info(${name})`).toArray().length > 0

export function privateURI(domain: Domain, input: unknown, kind?: 'skills' | 'sessions'): { uri: string; owner: string; name: string } {
  if (typeof input !== 'string' || !input.startsWith(ROOT)) invalid('Expected a canonical private backup URI.')
  const parts = canonicalParts(input.slice(ROOT.length))
  uriOf(parts)
  if (parts[0] !== 'user' || parts.length !== (kind ? 4 : 2) || (kind && parts[2] !== kind)) invalid('Invalid backup domain URI.')
  const owner = parts[1]
  if (!domain.scope.users.includes(owner)) topology('Backup domain owner is not in the provisioned workspace roster.')
  return { uri: input, owner, name: parts[3] ?? '' }
}
