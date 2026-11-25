// SPDX-License-Identifier: AGPL-3.0-only
import type { Env, WorkspaceContext } from '../context.js'
import type { AclEntry } from '../acl.js'
import { isRecord, ok } from '../http.js'
import { onlyKeys, ROOT, textSize, writable } from '../fs/contract.js'
import { emptyIndex, Filesystem, initFilesystem, metadata, PRIVATE_BYTES, PRIVATE_ENTRIES, tagsOf } from '../fs/store.js'
import type { Entry, Scoped } from '../fs/store.js'
import { SUBTREE_MAX_BYTES } from '../fs/subtree.js'
import { attachment, bool, conflict, digest, fail, invalid, quota } from './common.js'
import { backupEntries, backupRoot, backupScopes, decodeBackup, directoryEntry, encodeBackup, excludedFile, parentOf, portablePath, sortEntries, topology } from './backup-codec.js'
import type { BackupEntry } from './backup-codec.js'
import { approvalMs, approvalToken, assertFixedDirectory, assertPermitLive, scopeFor, sign, verifies } from './backup-authority.js'
import type { Permit, Scope } from './backup-authority.js'
import { aclSeal, captureAclCeiling, readAclCeiling } from './backup-acl.js'
import { hasTable, type Domain } from './backup-domain.js'
import { captureDomains, decodeEdge, edgeFilename, encodeEdge, planDomains } from './edge-backup.js'

const privateHeaders = { 'cache-control': 'private, no-store' }
const entryPrefix = 'viking://'
const portableColumns = 'uri,space,is_dir,bytes,derived_from,derived_version'
const portableRows = `FROM ov_edge_fs_entry WHERE account_id=? AND (space='shared' OR substr(space,1,8)='["user",'
    OR uri='viking://resources' OR uri GLOB 'viking://resources/*' OR uri='viking://user' OR uri GLOB 'viking://user/*')`
const stale = (): never => fail(409, 'BACKUP_PLAN_STALE', 'The evaluated backup plan changed or expired. Evaluate again before applying.')
const policyUnsupported = (): never => fail(501, 'BACKUP_INDEX_UNSUPPORTED', 'This backup profile only supports deferred local indexing.')
type Target = { fs: Filesystem; path: Scoped; previous?: Entry }
type Options = { policy: 'fail' | 'skip' | 'overwrite'; profile: 'ovpack-v3' | 'edge-v1' }

function options(value: unknown, capture: boolean): Record<string, unknown> {
  const body = value === undefined ? {} : value
  if (!isRecord(body)) return invalid('Expected a backup options object.')
  onlyKeys(body, capture ? 'include_vectors profile' : 'on_conflict vector_mode profile')
  return body
}

function profile(body: Record<string, unknown>): 'ovpack-v3' | 'edge-v1' {
  if (body.profile === undefined || body.profile === 'ovpack-v3') return 'ovpack-v3'
  if (body.profile === 'edge-v1') return 'edge-v1'
  return invalid('Unknown backup profile.')
}

function restoreOptions(value: unknown): Options {
  const body = options(value, false)
  const policy = body.on_conflict === undefined ? 'fail' : body.on_conflict
  if (policy !== 'fail' && policy !== 'skip' && policy !== 'overwrite') return invalid('Unsupported backup conflict policy.')
  if (body.vector_mode !== undefined && body.vector_mode !== 'deferred') policyUnsupported()
  return { policy, profile: profile(body) }
}

/** The user subdomains below are inside the upstream URI scope, but Edge's
 * authoritative data lives in separate tables with incompatible semantics. */
function assertPortableTopology(sql: SqlStorage, account: string, edge: boolean) {
  for (const [table, filter, name] of [
    ['privacy_targets', '', 'privacy settings'],
    ['ov_edge_mcp_registry', " AND scope GLOB 'user:*'", 'private tools'],
    ...(!edge ? [['ov_sessions', '', 'sessions'], ['ov_edge_user_add_settings', '', 'user add locations'],
      ['ov_edge_fs_skill', " AND uri GLOB 'viking://user/*' AND current_revision IS NOT NULL", 'private skills']] : []),
  ]) if (hasTable(sql, table) && sql.exec(`SELECT 1 FROM ${table} WHERE account_id=?${filter} LIMIT 1`, account).toArray().length) {
    topology(`Backup does not support a workspace with ${name}.`)
  }
  if (hasTable(sql, 'ov_edge_fs_pending') && hasTable(sql, 'ov_jobs') && sql.exec(`SELECT 1 FROM ov_edge_fs_pending p
    JOIN ov_jobs j ON j.task_id=p.task_id AND j.account=p.account_id
    WHERE p.account_id=? AND (p.space='shared' OR substr(p.space,1,8)='["user",')
    AND j.status IN ('pending','running','cancelling') LIMIT 1`, account).toArray().length) {
    fail(409, 'RESOURCE_BUSY', 'A portable mount has an active filesystem reservation.')
  }
}

/** Backups never use a Data grant or an ambient role. The only callers of this
 * adapter have passed the independent operator/tenant gate. Reuse the normal FS
 * invariants for one validated path at a time; no impersonated HTTP dispatch. */
class BackupFilesystem {
  readonly #storage: DurableObjectStorage
  readonly #scope: Scope
  readonly #filesystems = new Map<string, Filesystem>()

  constructor(storage: DurableObjectStorage, scope: Scope) { this.#storage = storage; this.#scope = scope }

  fs(owner = ''): Filesystem {
    let fs = this.#filesystems.get(owner)
    if (!fs) {
      if (owner && !this.#scope.users.includes(owner)) topology('Backup owner is not in the provisioned workspace roster.')
      const ctx: WorkspaceContext = { storage: this.#storage, sql: this.#storage.sql,
        caller: { accountId: this.#scope.account, userId: owner, agentId: '', role: owner ? 'user' : 'admin' },
        embed: async () => policyUnsupported(),
      }
      this.#filesystems.set(owner, fs = new Filesystem(ctx))
    }
    return fs
  }

  target(entry: BackupEntry): { fs: Filesystem; path: Scoped } {
    const fs = this.fs(entry.owner)
    const path = fs.path(ROOT + entry.path)
    writable(path, fs.caller)
    if (path.uri !== ROOT + entry.path) invalid('Backup URI is not canonical.')
    return { fs, path }
  }

  /** No await while gathering topology, ACLs and file bytes. The account
   * predicate and the URI-to-space cross-check both precede body reads. */
  state(ownedSkills?: ReadonlySet<string>) {
    const sql = this.#storage.sql, account = this.#scope.account
    assertPortableTopology(sql, account, ownedSkills !== undefined)
    const ready = hasTable(sql, 'ov_edge_fs_entry')
    const roots = ['', ...backupScopes].map(path => directoryEntry(path))
    for (const user of this.#scope.users) {
      for (const suffix of ['', '/resources', '/memories']) roots.push(directoryEntry(`user/${user}${suffix}`, user))
    }
    const stored = new Map<string, { fs: Filesystem; path: Scoped; row: Entry; effective?: readonly AclEntry[] }>()
    const aclStamp: unknown[] = []
    if (ready) {
      const rows = sql.exec<Pick<Entry, 'uri' | 'is_dir' | 'bytes' | 'derived_from' | 'derived_version'> & { space: string }>(
        `SELECT ${portableColumns} ${portableRows} ORDER BY uri LIMIT ?`, account, backupEntries + (ownedSkills?.size ?? 0) + 1).toArray()
      if (rows.length > backupEntries + (ownedSkills?.size ?? 0)) quota('Workspace exceeds the backup entry limit.')
      let total = 0
      for (const raw of rows) {
        if (!raw.uri.startsWith(entryPrefix)) topology('Backup contains a malformed stored URI.')
        const path = raw.uri.slice(entryPrefix.length)
        if (ownedSkills?.has(raw.uri) && raw.space === JSON.stringify(['user', path.split('/')[1]])) continue
        if (!raw.is_dir && excludedFile(path) && (raw.space === 'shared' && path.startsWith('resources/') ||
            raw.space.startsWith('["user",') && path.startsWith('user/'))) continue
        const { owner, virtual } = portablePath(path, !!raw.is_dir)
        if (virtual || raw.derived_from != null || raw.derived_version != null) topology('Backup cannot detach a managed, generated or virtual filesystem row.')
        const node = this.target({ ...directoryEntry(path, owner), directory: !!raw.is_dir })
        if (node.path.space !== raw.space || stored.has(path)) topology('Backup URI does not agree with its stored mount.')
        if ((total += raw.bytes) > SUBTREE_MAX_BYTES || stored.size + roots.length >= backupEntries) quota('Workspace exceeds the backup content or entry limit.')
        const row = sql.exec<Entry>(`SELECT ${metadata} FROM ov_edge_fs_entry WHERE account_id=? AND space=? AND uri=?`,
          account, node.path.space, node.path.uri).one()
        const acl = node.path.space === 'shared' ? node.fs.acl.resolve(node.path) : undefined
        if (acl) aclStamp.push([path, acl.acl_mode, acl.direct_entries])
        stored.set(path, { ...node, row, effective: acl?.effective_entries })
      }
    }
    const virtual = new Set(roots.map(entry => entry.path))
    for (const path of stored.keys()) {
      const parent = parentOf(path)
      if (!virtual.has(parent) && !stored.get(parent)?.row.is_dir) topology('Backup found an incomplete destination directory tree.')
    }
    // Opaque revision hashes are computed from this internal stamp; nothing
    // here (including ACL principals) is ever returned or embedded in the ZIP.
    const stamp = JSON.stringify([this.#scope.users, [...stored].map(([path, { row }]) => [path, row.revision, row.node_id]), aclStamp])
    return { roots, stored, ready, stamp }
  }

  capture(ownedSkills?: ReadonlySet<string>) {
    const { roots, stored } = this.state(ownedSkills)
    const entries = sortEntries([...roots, ...[...stored].map(([path, { fs, path: target, row }]) => {
      const owner = target.space !== 'shared' ? fs.caller.userId : undefined
      const content = row.is_dir ? undefined : fs.read(target.uri)
      if (content !== undefined && textSize(content) !== row.bytes) topology('Stored content cannot be copied losslessly.')
      return { path, owner, directory: !!row.is_dir, content, description: row.description, tags: tagsOf(row) }
    })])
    return { entries, ceiling: captureAclCeiling(entries, this.#scope.users, path => stored.get(path)?.effective) }
  }

  plan(entries: BackupEntry[], policy: Options['policy'], allowsOverwrite: ReturnType<typeof readAclCeiling>, state = this.state(),
    extra: { fs: Filesystem; space: string; nodes: number; bytes: number }[] = []) {
    const owners = entries.filter(entry => entry.owner && entry.path === `user/${entry.owner}`).map(entry => entry.owner)
    if (JSON.stringify(owners) !== JSON.stringify(this.#scope.users)) topology('Backup owner roots and target roster do not match.')
    if (policy === 'fail') conflict('The resources and user scope roots already exist; explicitly evaluate an overwrite to merge.')
    const writes: Array<Target & { entry: BackupEntry; bytes: number }> = []
    const counts = { create: 0, update: 0, files_written: 0, unchanged: 0, quarantined: 0 }
    const growth = new Map<string, { nodes: number; bytes: number }>()
    let merged = state.stored.size + state.roots.length
    if (policy === 'overwrite') for (const [i, entry] of entries.entries()) {
      if (portablePath(entry.path, entry.directory).virtual) continue
      const { fs, path } = this.target(entry)
      const target = state.stored.get(entry.path), previous = target?.row
      if (previous && !!previous.is_dir !== entry.directory) {
        fail(409, 'BACKUP_TYPE_CONFLICT', 'A destination node has another type; backup restore will not delete a subtree.')
      }
      if (previous && previous.description === entry.description && JSON.stringify(tagsOf(previous)) === JSON.stringify(entry.tags) &&
          (entry.directory || fs.read(path.uri) === entry.content)) { counts.unchanged++; continue }
      if (path.space === 'shared' && previous && (!target?.effective || !allowsOverwrite(i, target.effective))) {
        fail(409, 'BACKUP_ACL_CONFLICT', 'The destination ACL exceeds the provable capture ceiling. Restrict the destination before re-evaluating.')
      }
      const bytes = entry.directory ? 0 : textSize(entry.content!)
      writes.push({ fs, path, previous, entry, bytes })
      counts[previous ? 'update' : 'create']++
      counts.files_written += Number(!entry.directory)
      if (!previous) {
        merged++
        counts.quarantined += Number(path.space === 'shared')
      }
      const delta = growth.get(path.space) ?? { nodes: 0, bytes: 0 }
      delta.nodes += Number(!previous)
      // Conservative positive growth also covers intermediate states during the
      // transaction. No credit before publishing for removed derived indexes.
      delta.bytes += Math.max(0, bytes - (previous?.bytes ?? 0))
      growth.set(path.space, delta)
    }
    if (merged > backupEntries) quota('Merged workspace exceeds the backup entry limit.')
    let nodes = 0, bytes = 0
    for (const { nodes: n, bytes: b } of growth.values()) { nodes += n; bytes += b }
    const fileBytes = bytes
    for (const item of extra) {
      const previous = growth.get(item.space) ?? { nodes: 0, bytes: 0 }
      growth.set(item.space, { nodes: previous.nodes + item.nodes, bytes: previous.bytes + item.bytes })
      nodes += item.nodes; bytes += item.bytes
    }
    if (state.ready) {
      this.fs().limits('shared', nodes, bytes)
      const visited = new Set<string>()
      for (const { fs, path } of writes) if (path.space !== 'shared' && !visited.has(path.space)) {
        const delta = growth.get(path.space)!
        fs.limits(path.space, delta.nodes, delta.bytes)
        visited.add(path.space)
      }
      for (const item of extra) if (!visited.has(item.space)) {
        const delta = growth.get(item.space)!
        item.fs.limits(item.space, delta.nodes, delta.bytes)
        visited.add(item.space)
      }
    } else {
      // No tables to query on a cold target: the only entries are from this plan.
      for (const [space, delta] of growth) if (space !== 'shared' && (delta.nodes > PRIVATE_ENTRIES || delta.bytes > PRIVATE_BYTES)) {
        quota('Private file quota exceeded by the cold restore plan.')
      }
    }
    const totalText = [...state.stored.values()].reduce((sum, node) => sum + node.row.bytes, 0)
    if (totalText + fileBytes > SUBTREE_MAX_BYTES) quota('Merged workspace exceeds the backup expanded content limit.')
    return { stamp: state.stamp, counts, writes, ready: state.ready,
      outcome: policy === 'skip' ? 'skipped' as const : writes.length ? 'ready' as const : 'unchanged' as const }
  }

  publish({ writes, ready }: ReturnType<BackupFilesystem['plan']>): void {
    if (!writes.length) return
    if (!ready) initFilesystem(this.fs().ctx)
    // Backup order is lexicographic by canonical URI, so directories precede children.
    for (const { fs, path, previous, entry, bytes } of writes) {
      const quarantine = !previous && path.space === 'shared' ? { acl_mode: 'restricted' as const, entries: [] } : undefined
      if (entry.directory) {
        if (!previous) fs.mkdir(path, entry.description, quarantine)
        if (previous || entry.tags.length) fs.updateDirectory(path, entry.description, entry.tags)
      } else {
        fs.storeFile(path, entry.content!, bytes, emptyIndex, entry.tags, previous, entry.description, quarantine)
      }
    }
  }
}

function domainContext(storage: DurableObjectStorage, scope: Scope, fs: BackupFilesystem): Domain {
  return { sql: storage.sql, scope, fs: owner => fs.fs(owner) }
}

export async function captureBackup(storage: DurableObjectStorage, env: Env, scope: Scope, permit: Permit, input: unknown): Promise<Response> {
  const body = options(input, true), format = profile(body)
  if (bool(body.include_vectors, 'include_vectors')) policyUnsupported()
  await assertFixedDirectory(env, scope)
  assertPermitLive(permit)
  const { entries, ceiling, domains } = storage.transactionSync(() => {
    const fs = new BackupFilesystem(storage, scope)
    const domains = format === 'edge-v1' ? captureDomains(domainContext(storage, scope, fs)) : undefined
    const snapshot = fs.capture(domains?.skills.owned)
    return { ...snapshot, domains }
  })
  const content = await encodeBackup(entries)
  const zip = domains ? await encodeEdge(content, domains) : content
  const sha256 = await digest(zip)
  const seal = await sign(scope, 'archive', sha256, ceiling)
  assertPermitLive(permit)
  return new Response(zip, { headers: { ...privateHeaders, 'content-type': 'application/zip',
    'content-disposition': attachment(domains ? edgeFilename : `${backupRoot.name}.ovpack`),
    'x-ovpack-sha256': sha256, 'x-ovpack-seal': `${ceiling}.${seal}` } })
}

export async function restoreBackup(storage: DurableObjectStorage, env: Env, workspaceId: string, scope: Scope, permit: Permit,
  evaluate: boolean, bytes: ArrayBuffer, seal: unknown, input: unknown, receipt?: unknown): Promise<Response> {
  const { policy, profile: format } = restoreOptions(input)
  const approved = evaluate ? undefined : approvalToken(receipt)
  if (approved && approved.expires_at <= Date.now()) stale()
  const { ceiling, mac } = aclSeal(seal, scope.users.length)
  const zip = new Uint8Array(bytes), sha256 = await digest(zip)
  if (!await verifies(scope, 'archive', mac, sha256, ceiling)) {
    fail(403, 'BACKUP_SEAL_INVALID', 'The backup bytes are not sealed for the named workspace.')
  }
  const fs = new BackupFilesystem(storage, scope), domain = domainContext(storage, scope, fs)
  const incoming = format === 'edge-v1' ? await decodeEdge(domain, zip) : undefined
  const entries = incoming?.entries ?? await decodeBackup(zip)
  const allowsOverwrite = readAclCeiling(ceiling, entries, scope.users)
  await assertFixedDirectory(env, scope)
  assertPermitLive(permit)
  const prepare = () => {
    const live = incoming && captureDomains(domain)
    const state = fs.state(live?.skills.owned)
    const domains = incoming && live && planDomains(domain, incoming, live, policy === 'skip')
    // Both dry-run and the final transaction resolve destination grants from
    // SQLite. The authenticated ceiling is immutable; the ACL stamp is CAS-bound.
    const files = fs.plan(entries, policy, allowsOverwrite, state, domains?.growth)
    return { files, domains, stamp: JSON.stringify([files.stamp, domains?.stamp]), outcome: domains?.changed ? 'ready' : files.outcome }
  }
  const plan = storage.transactionSync(prepare)
  const conditions = [workspaceId, format, policy, sha256, mac, plan.stamp, plan.files.counts, plan.domains?.counts, plan.outcome]
  const result = { uri: ROOT, scopes: backupScopes, profile: format, archive_sha256: sha256, counts: plan.files.counts,
    ...(plan.domains && { domain_counts: plan.domains.counts }),
    index_status: plan.files.counts.files_written || plan.domains?.counts.skills ? 'deferred' : 'unchanged', outcome: plan.outcome }
  if (!approved) {
    const expires_at = Date.now() + approvalMs
    const mac = await sign(scope, 'approve', expires_at, ...conditions)
    assertPermitLive(permit)
    return new Response(ok({ ...result, dry_run: true, approval: { expires_at, mac } }).body,
      { headers: { ...privateHeaders, 'content-type': 'application/json' } })
  }
  if (!await verifies(scope, 'approve', approved.mac, approved.expires_at, ...conditions)) stale()
  // Recheck admission and all mutable filesystem preconditions after the await.
  await assertFixedDirectory(env, scope)
  storage.transactionSync(() => {
    assertPermitLive(permit)
    if (approved.expires_at <= Date.now()) stale()
    const current = scopeFor(env, scope.account)
    if (current.key !== scope.key || current.realm !== scope.realm || JSON.stringify(current.users) !== JSON.stringify(scope.users) ||
        JSON.stringify(current.sessionOwners) !== JSON.stringify(scope.sessionOwners)) stale()
    const latest = prepare()
    if (plan.stamp !== latest.stamp) stale()
    fs.publish(latest.files)
    if (latest.domains) {
      if (!latest.files.ready && !latest.files.writes.length && latest.domains.counts.skills) initFilesystem(fs.fs().ctx)
      latest.domains.publish()
    }
  })
  await storage.sync()
  return new Response(ok({ ...result, dry_run: false, outcome: plan.outcome === 'ready' ? 'applied' : plan.outcome }).body,
    { headers: { ...privateHeaders, 'content-type': 'application/json' } })
}
