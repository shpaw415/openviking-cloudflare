// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, ControlCaller } from '../context.js'
import { ApiError } from '../http.js'
import { LIMIT, absent, conflict, digestPattern, exhausted, forbidden, hasCallerShape, invalidFixed, isId, unauthenticated } from './input.js'
import { Settings } from './settings.js'
import { Templates } from './templates.js'

type Origin = 'fixed' | 'managed'
type Account = { account_id: string; origin: Origin; created_at: string; deleted: number }
type User = { account_id: string; user_id: string; origin: Origin; role: Caller['role'] | null; agent_id: string | null; digest: string | null; deleted: number }
type DirectoryUser = { user_id: string; role: Caller['role'] }
const now = () => new Date().toISOString()

export class Registry {
  readonly sql: SqlStorage

  constructor(private storage: DurableObjectStorage) {
    this.sql = storage.sql
    this.tx(() => {
      this.sql.exec(`
      CREATE TABLE IF NOT EXISTS ov_control_accounts (
        account_id TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL CHECK (origin IN ('managed','fixed')),
        created_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
        CHECK (origin = 'managed' OR deleted = 0)
      );
      CREATE TABLE IF NOT EXISTS ov_control_users (
        account_id TEXT NOT NULL REFERENCES ov_control_accounts(account_id),
        user_id TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('managed','fixed')),
        role TEXT CHECK (role IN ('admin','user')),
        agent_id TEXT,
        digest TEXT UNIQUE,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
        PRIMARY KEY (account_id, user_id),
        CHECK ((origin = 'fixed' AND role IS NULL AND agent_id IS NULL AND digest IS NULL AND deleted = 0)
          OR (origin = 'managed' AND role IS NOT NULL AND agent_id IS NOT NULL
            AND ((deleted = 0 AND length(digest) = 64 AND digest IS NOT NULL) OR (deleted = 1 AND digest IS NULL))))
      );
      CREATE TABLE IF NOT EXISTS ov_control_key_history (
        digest TEXT PRIMARY KEY NOT NULL CHECK (length(digest) = 64),
        account_id TEXT NOT NULL, user_id TEXT NOT NULL,
        FOREIGN KEY (account_id, user_id) REFERENCES ov_control_users(account_id, user_id) DEFERRABLE INITIALLY DEFERRED
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ov_control_key_owner ON ov_control_key_history(account_id, user_id);
      CREATE TABLE IF NOT EXISTS ov_control_groups (
        account_id TEXT NOT NULL REFERENCES ov_control_accounts(account_id),
        group_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
        PRIMARY KEY (account_id, group_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS ov_control_memberships (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        PRIMARY KEY (account_id, group_id, user_id),
        FOREIGN KEY (account_id, group_id) REFERENCES ov_control_groups(account_id, group_id),
        FOREIGN KEY (account_id, user_id) REFERENCES ov_control_users(account_id, user_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS ov_control_groups_by_user ON ov_control_memberships(account_id, user_id, group_id);
      CREATE TABLE IF NOT EXISTS ov_control_probe_budget (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), hour INTEGER NOT NULL, count INTEGER NOT NULL
      );
      `)
      Settings.init(this.sql)
      Templates.init(this.sql)
    })
  }

  tx<T>(operation: () => T): T { return this.storage.transactionSync(operation) }

  reserveProbe(): void {
    const hour = Math.floor(Date.now() / 3_600_000)
    const prior = this.sql.exec<{ hour: number; count: number }>('SELECT hour, count FROM ov_control_probe_budget WHERE singleton = 1').toArray()[0]
    const count = (prior?.hour === hour ? prior.count : 0) + 1
    if (count > 8) throw new ApiError(429, 'RATE_LIMITED', 'Model probe budget exhausted for this hour.')
    this.sql.exec(`INSERT INTO ov_control_probe_budget(singleton, hour, count) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET hour=excluded.hour, count=excluded.count`, hour, count)
  }

  private accountRow(account: string): Account | undefined {
    return this.sql.exec<Account>('SELECT * FROM ov_control_accounts WHERE account_id = ?', account).toArray()[0]
  }

  private userRow(account: string, user: string): User | undefined {
    return this.sql.exec<User>('SELECT * FROM ov_control_users WHERE account_id = ? AND user_id = ?', account, user).toArray()[0]
  }

  account(account: string): Account {
    const row = this.accountRow(account)
    if (!row || row.deleted) throw absent('Account', account)
    return row
  }

  private limitAccounts(): void {
    const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_control_accounts').one().n
    if (count >= LIMIT.accounts) throw exhausted()
  }

  private limitUsers(account: string): void {
    const count = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_control_users WHERE account_id = ?', account).one().n
    if (count >= LIMIT.users) throw exhausted()
  }

  // Fixed credentials are authenticated only by the outer Worker. Persist a
  // reservation, not authority: the env remains the only source of role/agent.
  reserveFixed(fixed: readonly Caller[]): void {
    for (const item of fixed) {
      const account = this.accountRow(item.accountId)
      if (account && (account.origin !== 'fixed' || account.deleted)) throw invalidFixed()
      const user = this.userRow(item.accountId, item.userId)
      if (user && (user.origin !== 'fixed' || user.deleted)) throw invalidFixed()
      if (!account) {
        this.limitAccounts()
        this.sql.exec(`INSERT INTO ov_control_accounts (account_id, origin, created_at) VALUES (?, 'fixed', ?)`, item.accountId, now())
      }
      if (!user) {
        this.limitUsers(item.accountId)
        this.sql.exec(`INSERT INTO ov_control_users (account_id, user_id, origin) VALUES (?, ?, 'fixed')`, item.accountId, item.userId)
      }
    }
  }

  resolve(digest: string): Caller | null {
    if (typeof digest !== 'string' || !digestPattern.test(digest)) return null
    const row = this.sql.exec<Pick<User, 'account_id' | 'user_id' | 'agent_id' | 'role'>>(`
      SELECT u.account_id, u.user_id, u.agent_id, u.role FROM ov_control_users u
      JOIN ov_control_accounts a USING (account_id)
      WHERE u.digest = ? AND u.origin = 'managed' AND u.deleted = 0 AND a.deleted = 0
    `, digest).toArray()[0]
    if (!row?.role || !row.agent_id) return null
    return { accountId: row.account_id, userId: row.user_id, agentId: row.agent_id, role: row.role }
  }

  resolveManagedIdentity(accountId: string, userId: string, agentId: string): Caller | null {
    if (!isId(accountId) || !isId(userId) || !isId(agentId)) return null
    const row = this.sql.exec<{ role: string }>(`
      SELECT u.role FROM ov_control_users u
      JOIN ov_control_accounts a USING (account_id)
      WHERE u.account_id = ? AND u.user_id = ? AND u.agent_id = ?
        AND u.origin = 'managed' AND u.deleted = 0 AND a.deleted = 0
    `, accountId, userId, agentId).toArray()[0]
    if (row?.role !== 'user' && row?.role !== 'admin') return null
    return { accountId, userId, agentId, role: row.role }
  }

  admitted(caller: ControlCaller, fixed: readonly Caller[], expected?: string): void {
    if (!hasCallerShape(caller)) throw unauthenticated()
    if (caller.role === 'root') {
      if (expected !== undefined) throw unauthenticated()
      return
    }
    if (expected === undefined && fixed.some(item => sameCaller(item, caller))) return
    const row = this.userRow(caller.accountId, caller.userId)
    if (!row || !this.active(caller) || row.origin !== 'managed' ||
        (expected !== undefined && row.digest !== expected)) throw unauthenticated()
  }

  active(caller: ControlCaller): boolean {
    if (!hasCallerShape(caller) || caller.role === 'root') return false
    const account = this.accountRow(caller.accountId)
    if (!account || account.deleted) return false
    const user = this.userRow(caller.accountId, caller.userId)
    return !!user && !user.deleted && (user.origin === 'fixed' ||
      (user.role === caller.role && user.agent_id === caller.agentId && !!user.digest))
  }

  create(account: string, admin: string, digest: string): void {
    if (this.accountRow(account)) throw conflict('Account')
    this.limitAccounts()
    this.sql.exec(`INSERT INTO ov_control_accounts (account_id, origin, created_at) VALUES (?, 'managed', ?)`, account, now())
    this.register(account, admin, 'admin', digest)
  }

  register(account: string, user: string, role: Caller['role'], digest: string): void {
    this.account(account)
    if (this.userRow(account, user)) throw conflict('User')
    this.limitUsers(account)
    this.rememberDigest(account, user, digest)
    this.sql.exec(`INSERT INTO ov_control_users (account_id, user_id, origin, role, agent_id, digest)
      VALUES (?, ?, 'managed', ?, 'default', ?)`, account, user, role, digest)
  }

  private checkNewDigest(account: string, user: string, digest: string): void {
    const count = this.sql.exec<{ total: number; owner: number }>(`
      SELECT count(*) AS total, COALESCE(sum(user_id = ?), 0) AS owner
      FROM ov_control_key_history WHERE account_id = ?`, user, account).one()
    if (count.total >= LIMIT.keysPerAccount || count.owner >= LIMIT.keysPerUser) throw exhausted()
    if (this.sql.exec('SELECT 1 FROM ov_control_key_history WHERE digest = ?', digest).toArray().length) {
      throw new ApiError(503, 'KEY_ISSUANCE_UNAVAILABLE', 'A new credential could not be allocated.')
    }
  }

  private rememberDigest(account: string, user: string, digest: string): void {
    this.checkNewDigest(account, user, digest)
    this.sql.exec('INSERT INTO ov_control_key_history(digest, account_id, user_id) VALUES (?, ?, ?)', digest, account, user)
  }

  directory(account: string, fixed: readonly Caller[]): DirectoryUser[] {
    this.account(account)
    const fixedRoles = new Map(fixed.filter(item => item.accountId === account).map(item => [item.userId, item.role]))
    return this.sql.exec<Pick<User, 'user_id' | 'role' | 'origin'>>(`
      SELECT user_id, role, origin FROM ov_control_users WHERE account_id = ? AND deleted = 0 ORDER BY rowid`, account)
      .toArray().flatMap(row => {
        const role = row.origin === 'fixed' ? fixedRoles.get(row.user_id) : row.role
        return role ? [{ user_id: row.user_id, role }] : []
      })
  }

  member(account: string, user: string, fixed: readonly Caller[]): DirectoryUser {
    this.account(account)
    const row = this.userRow(account, user)
    const role = row?.origin === 'fixed' ? fixed.find(item => item.accountId === account && item.userId === user)?.role : row?.role
    if (!row || row.deleted || !role) throw absent('User', user)
    return { user_id: user, role }
  }

  accounts(fixed: readonly Caller[], point?: string) {
    const rows = point === undefined
      ? this.sql.exec<Account>('SELECT * FROM ov_control_accounts WHERE deleted = 0 ORDER BY rowid').toArray()
      : [this.account(point)]
    const counts = new Map(this.sql.exec<{ account_id: string; n: number }>(`
      SELECT account_id, count(*) AS n FROM ov_control_users WHERE deleted = 0 AND origin = 'managed' GROUP BY account_id
    `).toArray().map(row => [row.account_id, row.n]))
    for (const item of fixed) counts.set(item.accountId, (counts.get(item.accountId) ?? 0) + 1)
    return rows.map(row => ({ account_id: row.account_id, created_at: row.created_at,
      user_count: counts.get(row.account_id) ?? 0, status: 'active' }))
  }

  writableUser(account: string, user: string): User {
    this.account(account)
    const row = this.userRow(account, user)
    if (!row || row.deleted) throw absent('User', user)
    if (row.origin !== 'managed') throw forbidden()
    return row
  }

  /** Called in Control's serialized preparation transaction. The account and
   * the new digest stay reserved in Control until this commit or abandonment. */
  prepareRotation(account: string, user: string, digest: string, previous: string | null): () => void {
    const row = this.writableUser(account, user)
    if (!row.digest || row.digest !== previous) throw new ApiError(409, 'CONFLICT', 'The credential changed during rotation.')
    this.checkNewDigest(account, user, digest)
    return () => {
      this.sql.exec('INSERT INTO ov_control_key_history(digest, account_id, user_id) VALUES (?, ?, ?)', digest, account, user)
      this.sql.exec('UPDATE ov_control_users SET digest = ? WHERE account_id = ? AND user_id = ?', digest, account, user)
    }
  }

  changeRole(account: string, user: string, role: Caller['role']): void {
    this.writableUser(account, user)
    this.sql.exec('UPDATE ov_control_users SET role = ? WHERE account_id = ? AND user_id = ?', role, account, user)
  }

  revoke(account: string, user?: string): void {
    if (user !== undefined) {
      this.writableUser(account, user)
      this.sql.exec('DELETE FROM ov_control_memberships WHERE account_id = ? AND user_id = ?', account, user)
      this.sql.exec('DELETE FROM ov_control_settings WHERE account_id = ? AND user_id = ?', account, user)
      this.sql.exec('UPDATE ov_control_users SET deleted = 1, digest = NULL WHERE account_id = ? AND user_id = ?', account, user)
    } else {
      if (this.account(account).origin !== 'managed') throw forbidden()
      this.sql.exec('DELETE FROM ov_control_memberships WHERE account_id = ?', account)
      this.sql.exec('DELETE FROM ov_control_settings WHERE account_id = ?', account)
      this.sql.exec('DELETE FROM ov_control_templates WHERE account_id = ?', account)
      this.sql.exec('UPDATE ov_control_groups SET deleted = 1 WHERE account_id = ?', account)
      this.sql.exec('UPDATE ov_control_users SET deleted = 1, digest = NULL WHERE account_id = ?', account)
      this.sql.exec('UPDATE ov_control_accounts SET deleted = 1 WHERE account_id = ?', account)
    }
  }

  principals(account: string, fixed: readonly Caller[]): { users: string[]; groups: string[] } {
    const row = this.accountRow(account)
    if (!row || row.deleted) return { users: [], groups: [] }
    return { users: this.directory(account, fixed).map(item => item.user_id), groups: this.groupIds(account) }
  }

  groupsFor(caller: Caller): string[] {
    if (!this.active(caller)) return []
    return this.sql.exec<{ group_id: string }>(`
      SELECT m.group_id FROM ov_control_memberships m JOIN ov_control_groups g USING (account_id, group_id)
      WHERE m.account_id = ? AND m.user_id = ? AND g.deleted = 0 ORDER BY m.group_id`, caller.accountId, caller.userId)
      .toArray().map(row => row.group_id)
  }

  private groupIds(account: string): string[] {
    return this.sql.exec<{ group_id: string }>(`
      SELECT group_id FROM ov_control_groups WHERE account_id = ? AND deleted = 0 ORDER BY group_id`, account)
      .toArray().map(row => row.group_id)
  }

  private requireGroup(account: string, group: string): void {
    this.account(account)
    if (!this.sql.exec('SELECT 1 FROM ov_control_groups WHERE account_id = ? AND group_id = ? AND deleted = 0', account, group)
      .toArray().length) throw absent('Group', group)
  }

  createGroup(account: string, group: string) {
    this.account(account)
    if (this.sql.exec('SELECT 1 FROM ov_control_groups WHERE account_id = ? AND group_id = ?', account, group).toArray().length) {
      throw conflict('Group')
    }
    if (this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_control_groups WHERE account_id = ?', account).one().n >= LIMIT.groups) {
      throw exhausted()
    }
    this.sql.exec('INSERT INTO ov_control_groups(account_id, group_id) VALUES (?, ?)', account, group)
    return { group_id: group, member_count: 0 }
  }

  deleteGroup(account: string, group: string): void {
    this.requireGroup(account, group)
    this.sql.exec('DELETE FROM ov_control_memberships WHERE account_id = ? AND group_id = ?', account, group)
    this.sql.exec('UPDATE ov_control_groups SET deleted = 1 WHERE account_id = ? AND group_id = ?', account, group)
  }

  listGroups(account: string, fixed: readonly Caller[]) {
    const users = new Set(this.directory(account, fixed).map(item => item.user_id))
    const counts = new Map<string, number>()
    for (const row of this.sql.exec<{ group_id: string; user_id: string }>(`
      SELECT group_id, user_id FROM ov_control_memberships WHERE account_id = ?`, account)) {
      if (users.has(row.user_id)) counts.set(row.group_id, (counts.get(row.group_id) ?? 0) + 1)
    }
    return this.groupIds(account).map(group => ({ group_id: group, member_count: counts.get(group) ?? 0 }))
  }

  private memberIds(account: string, group: string): string[] {
    return this.sql.exec<{ user_id: string }>(`
      SELECT user_id FROM ov_control_memberships WHERE account_id = ? AND group_id = ? ORDER BY user_id`, account, group)
      .toArray().map(item => item.user_id)
  }

  listMembers(account: string, group: string, fixed: readonly Caller[]): string[] {
    this.requireGroup(account, group)
    const users = new Set(this.directory(account, fixed).map(item => item.user_id))
    return this.memberIds(account, group).filter(user => users.has(user))
  }

  prepareMembers(account: string, group: string, users: string[], fixed: readonly Caller[], add: boolean) {
    this.requireGroup(account, group)
    const existing = new Set(this.memberIds(account, group))
    const changed = users.filter(user => existing.has(user) !== add)
    if (add) {
      const registered = new Set(this.directory(account, fixed).map(item => item.user_id))
      for (const user of users) if (!registered.has(user)) throw absent('User', user)
      if (changed.length) {
        const total = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM ov_control_memberships WHERE account_id = ?', account).one().n
        if (existing.size + changed.length > LIMIT.members || total + changed.length > LIMIT.memberships) throw exhausted()
      }
    }
    return { changed, commit: () => {
      const statement = add ? 'INSERT INTO ov_control_memberships(account_id, group_id, user_id) VALUES (?, ?, ?)' :
        'DELETE FROM ov_control_memberships WHERE account_id = ? AND group_id = ? AND user_id = ?'
      for (const user of changed) this.sql.exec(statement, account, group, user)
      return changed.length > 0
    } }
  }
}

export function fixedCallers(values: ControlCaller[]): Caller[] {
  if (!Array.isArray(values) || values.length > LIMIT.fixed) throw invalidFixed()
  const distinct = new Map<string, Caller>()
  const roles = new Map<string, Caller['role']>()
  for (const item of values) {
    if (!hasCallerShape(item)) throw invalidFixed()
    if (item.role === 'root') continue
    const { accountId, userId, agentId, role } = item
    const scope = `${accountId}/${userId}`
    if (roles.has(scope) && roles.get(scope) !== role) throw invalidFixed()
    roles.set(scope, role)
    distinct.set(`${scope}/${agentId}`, { accountId, userId, agentId, role })
  }
  return [...distinct.values()]
}

export function sameCaller(a: ControlCaller, b: ControlCaller): boolean {
  return a.accountId === b.accountId && a.userId === b.userId && a.agentId === b.agentId && a.role === b.role
}
