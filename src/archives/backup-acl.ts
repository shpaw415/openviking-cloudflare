// SPDX-License-Identifier: AGPL-3.0-only
import type { AclEntry, AclLevel } from '../acl.js'
import { backupEntries, parentOf, type BackupEntry } from './backup-codec.js'
import { hexOf } from './backup-authority.js'
import { fail } from './common.js'

const version = 'acl2-'
const rank = { read: 1, write: 2, manage: 3 } satisfies Record<AclLevel, number>
const shared = (path: string) => path.startsWith('resources/')
const slots = (users: readonly string[]) => new Map(users.map((user, i) => [`user:${user}`, i + 1]))
const bytesFor = (entries: number, users: number) => Math.ceil(entries * (users + 1) / 4)
const get = (bits: Uint8Array, at: number) => (bits[at >> 2] >> ((at & 3) * 2)) & 3
const set = (bits: Uint8Array, at: number, level: number) => { bits[at >> 2] |= level << ((at & 3) * 2) }
const invalid = (): never => fail(403, 'BACKUP_SEAL_INVALID', 'The backup does not have a supported, authenticated ACL ceiling.')

/** Two bits per level: universal floor, then named users in the exact roster
 * order already bound by the signed manifest. Never serialize ACL entries,
 * group membership or the admin bypass. Group-only rights aren't a stable
 * source witness: their membership is not owned by this SQLite transaction. */
export function captureAclCeiling(entries: readonly BackupEntry[], users: readonly string[],
  effective: (path: string) => readonly AclEntry[] | undefined): string {
  const bits = new Uint8Array(bytesFor(entries.length, users.length)), stride = users.length + 1
  const seats = slots(users), indices = new Map<string, number>()
  entries.forEach(({ path }, index) => {
    if (!shared(path)) return
    const grants = effective(path) ?? invalid(), parent = parentOf(path), at = index * stride
    const above = parent === 'resources' ? undefined : indices.get(parent) ?? invalid()
    const levels = new Uint8Array(stride)
    for (const grant of grants) {
      const slot = grant.principal === 'user:*' ? 0 : seats.get(grant.principal)
      if (slot !== undefined) levels[slot] = Math.max(levels[slot], rank[grant.level])
    }
    for (const [slot, level] of levels.entries()) {
      // Keep the capture-side ancestry/read requirement. A hidden target
      // ancestor does not excuse a broader direct permission on its child.
      if (above === undefined || get(bits, above + slot)) set(bits, at + slot, Math.max(level, levels[0]))
    }
    indices.set(path, at)
  })
  return version + hexOf(bits)
}

export function aclSeal(seal: unknown, rosterSize: number): { ceiling: string; mac: string } {
  const max = version.length + bytesFor(backupEntries, rosterSize) * 2 + 1 + 64
  if (typeof seal !== 'string' || seal.length > max) return invalid()
  const match = /^(acl2-(?:[a-f0-9]{2})+)\.([a-f0-9]{64})$/.exec(seal)
  if (!match || match[0].length !== seal.length) return invalid()
  return { ceiling: match[1], mac: match[2] }
}

/** Only call after HMAC verification and canonical ZIP/manifest decoding. */
export function readAclCeiling(token: string, entries: readonly BackupEntry[], users: readonly string[]) {
  const stride = users.length + 1, n = bytesFor(entries.length, users.length)
  if (token.length !== version.length + n * 2) invalid()
  const bits = Uint8Array.from(token.slice(version.length).match(/../g)!, pair => Number.parseInt(pair, 16))
  const seats = slots(users)
  entries.forEach(({ path }, i) => {
    const at = i * stride, universal = get(bits, at), isShared = shared(path)
    for (let slot = 0; slot < stride; slot++) {
      const level = get(bits, at + slot)
      if (isShared ? level < universal : level !== 0) invalid()
    }
  })
  for (let at = entries.length * stride; at < bits.length * 4; at++) if (get(bits, at)) invalid()

  return (index: number, grants: readonly AclEntry[]): boolean => grants.every(grant => {
    // Compare group, wildcard and unknown user grants to the universal
    // floor. No assumption about current or historical group membership.
    const slot = seats.get(grant.principal) ?? 0
    return get(bits, index * stride + slot) >= rank[grant.level]
  })
}
