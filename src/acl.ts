// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, isRecord, ok, readJson } from './http.js'
import { JSON_LIMIT, ROOT, compare, denied, invalid, onlyKeys, queryString, str } from './fs/contract.js'
import type { FsPath } from './fs/contract.js'
import type { Filesystem } from './fs/store.js'

export type AclLevel = 'read' | 'write' | 'manage'
export type AclMode = 'inherit' | 'restricted'
export type AclEntry = { principal: string; level: AclLevel }
export type AclSpec = { acl_mode?: AclMode; entries?: AclEntry[] }
export type DirectAcl = { acl_mode: AclMode; entries: AclEntry[] }

type AclReport = { uri: string; acl_mode: AclMode; direct_entries: AclEntry[]; inherited_entries: AclEntry[]; effective_entries: AclEntry[] }
type AclRow = { uri: string; acl_mode: string; entries: string }
const weight = { read: 1, write: 3, manage: 7 }
const id = /^[A-Za-z0-9_-]{1,48}$/
const modes = ['inherit', 'restricted'] as const
const noDirect: DirectAcl = { acl_mode: 'inherit', entries: [] }
const maxDirect = 64

export function initAcl(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_fs_acl (
    account_id TEXT NOT NULL, space TEXT NOT NULL CHECK (space='shared'), uri TEXT NOT NULL,
    acl_mode TEXT NOT NULL CHECK (acl_mode IN ('inherit', 'restricted')),
    entries TEXT NOT NULL CHECK (json_valid(entries) AND json_type(entries)='array'),
    PRIMARY KEY (account_id,space,uri),
    FOREIGN KEY(account_id,space,uri) REFERENCES ov_edge_fs_entry(account_id,space,uri) ON DELETE CASCADE
  ) WITHOUT ROWID`)
}

function principal(value: unknown): string {
  const p = str(value, 'principal', undefined, 64).trim()
  const delimiter = p.indexOf(':')
  const kind = p.slice(0, delimiter)
  const name = p.slice(delimiter + 1)
  if (p !== 'user:*' && (delimiter < 0 || !(kind === 'user' || kind === 'group') || !id.test(name))) invalid('Expected user:<id>, group:<id>, or user:* as principal.')
  return p
}

function level(value: unknown): AclLevel {
  const parsed = str(value, 'level', undefined, 16).trim()
  if (parsed !== 'read' && parsed !== 'write' && parsed !== 'manage') invalid('ACL level must be read, write, or manage.')
  return parsed
}

function merge(entries: AclEntry[]): AclEntry[] {
  const highest = new Map<string, AclLevel>()
  for (const entry of entries) {
    const old = highest.get(entry.principal)
    if (!old || weight[entry.level] > weight[old]) highest.set(entry.principal, entry.level)
  }
  return [...highest].sort(([a], [b]) => compare(a, b)).map(([principal, level]) => ({ principal, level }))
}

function entries(value: unknown): AclEntry[] {
  if (!Array.isArray(value) || value.length > maxDirect) invalid(`ACL must contain at most ${maxDirect} direct entries.`)
  return merge(value.map(raw => {
    if (!isRecord(raw)) invalid('Expected an ACL entry.')
    onlyKeys(raw, 'principal level')
    return { principal: principal(raw.principal), level: level(raw.level) }
  }))
}

export function aclSpec(value: unknown): AclSpec | undefined {
  if (value == null) return
  if (!isRecord(value)) invalid('acl must be an object.')
  onlyKeys(value, 'entries acl_mode')
  const mode = value.acl_mode ?? undefined
  if (mode !== undefined && mode !== modes[0] && mode !== modes[1]) invalid('acl_mode must be inherit or restricted.')
  if (value.entries == null && mode === undefined) invalid('Supply entries or acl_mode.')
  return { acl_mode: mode, entries: value.entries == null ? undefined : entries(value.entries) }
}

const validateTarget = (path: FsPath, mutable: boolean) => {
  if (path.space !== 'shared') invalid('ACL is only supported in viking://resources.')
  if (mutable && path.builtin) invalid('The shared resources root ACL cannot be changed.')
}

function decoded(row: AclRow): DirectAcl {
  try {
    const spec = aclSpec({ acl_mode: row.acl_mode, entries: JSON.parse(row.entries) })
    if (!spec?.acl_mode || spec.entries === undefined) throw new Error()
    return { acl_mode: spec.acl_mode, entries: spec.entries }
  } catch {
    // A malformed ACL is not equivalent to no ACL and never grants root access.
    throw new ApiError(500, 'ACL_UNAVAILABLE', 'The stored permissions could not be verified.')
  }
}

const sharedRoot = `${ROOT}resources`

export class ResourceAcl {
  constructor(private readonly ctx: WorkspaceContext) {}

  private get account() { return this.ctx.caller.accountId }
  private get admin() { return this.ctx.caller.role === 'admin' }

  private checkPrincipal(value: string): void {
    if (value === 'user:*') return
    const [kind, id] = value.split(':')
    const directory = this.ctx.aclPrincipals
    const registered = kind === 'user' ? (directory?.users ?? [this.ctx.caller.userId]) : (directory?.groups ?? this.ctx.groups ?? [])
    if (!registered.includes(id)) invalid('ACL principals must be registered in the current account.')
  }

  allowsGrants(grants: readonly AclEntry[], action: AclLevel): boolean {
    if (this.admin) return true
    const principals = new Set([`user:${this.ctx.caller.userId}`, 'user:*'])
    for (const group of this.ctx.groups ?? []) if (id.test(group)) principals.add(`group:${group}`)
    return grants.some(grant => principals.has(grant.principal) && weight[grant.level] >= weight[action])
  }

  private root(): AclReport {
    // Do not widen access to preexisting shared data as an implicit migration.
    const root: AclEntry[] = [{ principal: 'user:*', level: 'read' }]
    return { uri: sharedRoot, acl_mode: 'inherit', direct_entries: root, inherited_entries: [], effective_entries: root }
  }

  private compose(uri: string, local: DirectAcl, inherit: AclEntry[]): AclReport {
    return { uri, acl_mode: local.acl_mode, direct_entries: local.entries, inherited_entries: inherit,
      effective_entries: local.acl_mode === 'restricted' ? local.entries : merge([...inherit, ...local.entries]) }
  }

  resolve(path: FsPath): AclReport {
    validateTarget(path, false)
    const chain = path.parts.slice(1).map((_, i) => ROOT + path.parts.slice(0, i + 2).join('/'))
    let result = this.root()
    if (!chain.length) return result
    const rows = new Map(this.ctx.sql.exec<AclRow>(`SELECT uri,acl_mode,entries FROM ov_edge_fs_acl
      WHERE account_id=? AND space='shared' AND uri IN (${chain.map(() => '?').join(',')})`, this.account, ...chain)
      .toArray().map(row => [row.uri, row]))
    for (const uri of chain) {
      const row = rows.get(uri)
      result = this.compose(uri, row ? decoded(row) : noDirect, result.effective_entries)
    }
    return result
  }

  allows(path: FsPath, action: AclLevel): boolean {
    return path.space !== 'shared' || this.admin || this.allowsGrants(this.resolve(path).effective_entries, action)
  }

  // A read-only, synchronous view for one enumeration. Never retain across an await or mutation.
  reader(): (uri: string) => boolean {
    if (this.admin) return () => true
    const rows = new Map(this.ctx.sql.exec<AclRow>(`SELECT uri,acl_mode,entries FROM ov_edge_fs_acl
      WHERE account_id=? AND space='shared'`, this.account).toArray().map(row => [row.uri, row]))
    const unique = new Map([[sharedRoot, this.root()]])
    const rights = (uri: string): AclReport => {
      const found = unique.get(uri)
      if (found) return found
      const row = rows.get(uri)
      const report = this.compose(uri, row ? decoded(row) : noDirect, rights(uri.slice(0, uri.lastIndexOf('/'))).effective_entries)
      unique.set(uri, report)
      return report
    }
    return uri => uri !== sharedRoot && !uri.startsWith(`${sharedRoot}/`) || this.allowsGrants(rights(uri).effective_entries, 'read')
  }

  authorize(path: FsPath, action: AclLevel): void {
    if (!this.allows(path, action)) denied(`Resource ${action} permission is required.`)
  }

  prepare(path: FsPath, spec: AclSpec | undefined): void {
    if (!spec) return
    validateTarget(path, true)
    this.authorize(path, 'manage')
    for (const entry of spec.entries ?? []) this.checkPrincipal(entry.principal)
  }

  // Called only by already-authorized storage operations in transactionSync.
  apply(path: FsPath, spec: AclSpec, touchRevision = true): AclReport {
    validateTarget(path, true)
    const old = this.resolve(path)
    const update = { acl_mode: spec.acl_mode ?? old.acl_mode, entries: spec.entries ?? old.direct_entries }
    if (update.acl_mode === 'inherit' && !update.entries.length) {
      this.ctx.sql.exec("DELETE FROM ov_edge_fs_acl WHERE account_id=? AND space='shared' AND uri=?", this.account, path.uri)
    } else {
      this.ctx.sql.exec(`INSERT INTO ov_edge_fs_acl (account_id,space,uri,acl_mode,entries) VALUES (?,'shared',?,?,?)
        ON CONFLICT(account_id,space,uri) DO UPDATE SET acl_mode=excluded.acl_mode,entries=excluded.entries`,
      this.account, path.uri, update.acl_mode, JSON.stringify(update.entries))
    }
    if (touchRevision) this.ctx.sql.exec("UPDATE ov_edge_fs_entry SET revision=? WHERE account_id=? AND space='shared' AND uri=?",
      crypto.randomUUID(), this.account, path.uri)
    return this.compose(path.uri, update, old.inherited_entries)
  }

  get(fs: Filesystem, path: FsPath): AclReport {
    validateTarget(path, false)
    fs.require(path, 'manage')
    return this.resolve(path)
  }

  patch(fs: Filesystem, path: FsPath, spec: AclSpec): AclReport {
    return fs.atomic(() => {
      this.prepare(path, spec)
      fs.require(path, 'manage')
      return this.apply(path, spec)
    })
  }

  change(fs: Filesystem, path: FsPath, value: unknown, valueLevel?: AclLevel): AclReport {
    const checked = principal(value)
    return fs.atomic(() => {
      validateTarget(path, true)
      const report = this.get(fs, path)
      this.checkPrincipal(checked)
      const next = report.direct_entries.filter(entry => entry.principal !== checked)
      if (valueLevel) next.push({ principal: checked, level: valueLevel })
      return this.apply(path, { entries: entries(next) })
    })
  }
}

export async function routeAcl(request: Request, url: URL, fs: Filesystem): Promise<Response | undefined> {
  const route = url.pathname
  const method = request.method
  if (route === '/api/v1/acl') {
    if (method === 'GET' || method === 'HEAD') return ok(fs.acl.get(fs, fs.path(queryString(url.searchParams, 'uri'))))
    if (method === 'DELETE') return ok(fs.acl.patch(fs, fs.path(queryString(url.searchParams, 'uri')), { acl_mode: 'inherit', entries: [] }))
    if (method === 'PUT') {
      const { uri, ...body } = await readJson(request, JSON_LIMIT)
      return ok(fs.acl.patch(fs, fs.path(uri), aclSpec(body)!))
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET, PUT or DELETE for this route.')
  }
  if (route === '/api/v1/acl/grant' || route === '/api/v1/acl/revoke') {
    if (method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST for this route.')
    const body = await readJson(request, JSON_LIMIT)
    const grant = route.endsWith('/grant')
    onlyKeys(body, grant ? 'uri principal level' : 'uri principal')
    return ok(fs.acl.change(fs, fs.path(body.uri), body.principal, grant ? level(body.level) : undefined))
  }
}
