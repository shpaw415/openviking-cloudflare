// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { ROOT, textFile } from '../fs/contract.js'
import { compileName, exampleRoot, overlap, parseInputs } from '../compile/input.js'
import { initState } from '../compile/state.js'
import { portablePath, strictJson, type BackupEntry } from './backup-codec.js'
import { hasTable, type Domain } from './backup-domain.js'
import { decoder, digest, encoder, fail, quota, text, under } from './common.js'
import { hashId, type InstanceProfile } from './instance-authority.js'
import { attachmentArchiveBytes, type AttachmentSeats } from './instance-attachments.js'
import { branchName, identifyBlob, initSnapshotStore, portableHiddenTable, SHA40, SNAPSHOT_BYTES, SNAPSHOT_FILES, type FileRef } from './snapshot-store.js'
import { inspectZip, memberBytes, storedZip } from './zip.js'

export const snapshotTables = ['ov_edge_snapshot_commit', 'ov_edge_snapshot_head', 'ov_edge_snapshot_blob', 'ov_edge_snapshot_ignore', portableHiddenTable] as const
const [commitTable, headTable, blobTable, ignoreTable] = snapshotTables
export const compileConfigTable = 'ov_edge_compile_config'
const statePath = 'portable-state.json', workspacePath = 'workspace.zip'
const stateLimit = 512 * 1024, ignoreLimit = 64 * 1024
const commitLimit = 512, headLimit = 512, blobLimit = 2048, compileLimit = 256
const limits = { bytes: attachmentArchiveBytes + stateLimit + 1024, expanded: attachmentArchiveBytes + stateLimit,
  entries: 2, storedOnly: true }
export const portableArchiveBytes = limits.bytes
const bad = (): never => fail(409, 'INSTANCE_BACKUP_PORTABLE_STATE', 'Invalid or unsupported portable snapshot or Compile state.')
type Bytes = Uint8Array<ArrayBuffer>
type Ref = [uri: string, digest: string, bytes: number, incarnation: number]
type Commit = [mount: string, owner: string, oid: string, parent: string | null, treeOid: string, message: string,
  author: string, email: string, time: number, changes: string[], files: Ref[]]
type Head = [mount: string, branch: string, oid: string]
type Blob = [mount: string, owner: string, digest: string, oid: string, body: string, bytes: number]
type Definition = [owner: string, agent: string, name: string, created: number, from: string[], to: string, skill: string]
type Portable = { kind: 'openviking.edge-portable-state', version: 1, shared_history: 'admin-only',
  ignore: string | null, commits: Commit[], heads: Head[], blobs: Blob[], compile: Definition[] }
const key = (...fields: unknown[]) => JSON.stringify(fields)
const sourceIncarnation = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|portable:[1-9][0-9]{0,5})$/u
const oid = (v: unknown): v is string => typeof v === 'string' && v.length === 40 && SHA40.test(v)
const capped = <T>(items: T[], limit: number): T[] => items.length <= limit ? items : quota('Portable state exceeds its row limit.')
function tuple(raw: unknown, n: number): unknown[] { return Array.isArray(raw) && raw.length === n ? raw : bad() }
function count(n: unknown, max: number): n is number { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max }

function fileScope(d: Domain, uri: unknown, mount: unknown, directory: boolean) {
  if (typeof uri !== 'string' || !uri.startsWith(ROOT) || typeof mount !== 'string') return bad()
  const { owner, virtual } = portablePath(uri.slice(ROOT.length), directory)
  if (virtual || (owner ? !d.scope.users.includes(owner) || mount !== key('user', owner) : mount !== 'shared')) return bad()
  const path = d.fs(owner).path(uri)
  if (path.uri !== uri || path.space !== mount || path.managed || path.builtin) return bad()
  if (!directory) textFile(path.parts.at(-1)!)
  return path
}

function validOwner(d: Domain, mount: unknown, owner: unknown): owner is string {
  return typeof owner === 'string' && d.scope.users.includes(owner) && (mount === 'shared' || mount === key('user', owner))
}

function shape(raw: unknown): Portable {
  if (!isRecord(raw) || Object.keys(raw).length !== 8 || raw.kind !== 'openviking.edge-portable-state' || raw.version !== 1 ||
      raw.shared_history !== 'admin-only' || !(raw.ignore === null || typeof raw.ignore === 'string') ||
      !Array.isArray(raw.commits) || !Array.isArray(raw.heads) || !Array.isArray(raw.blobs) || !Array.isArray(raw.compile)) return bad()
  return { kind: raw.kind, version: raw.version, shared_history: raw.shared_history, ignore: raw.ignore,
    commits: capped(raw.commits, commitLimit), heads: capped(raw.heads, headLimit),
    blobs: capped(raw.blobs, blobLimit), compile: capped(raw.compile, compileLimit) }
}

export function capturePortableState(d: Domain) {
  const { sql, scope: { account } } = d
  const rows = <T extends Record<string, SqlStorageValue>>(table: string, max: number, columns: string, order: string, bytes: string) => {
    if (!hasTable(sql, table)) return []
    // Reject a broken workspace scope, and bound SQL materialization before reading bodies.
    if (sql.exec(`SELECT 1 FROM ${table} WHERE account!=? LIMIT 1`, account).toArray().length) return bad()
    if (!count(sql.exec<{ n: number }>(`SELECT coalesce(sum(${bytes}),0) AS n FROM ${table}`).one().n, stateLimit)) {
      quota('Portable state exceeds its byte limit.')
    }
    return capped(sql.exec<T>(`SELECT ${columns} FROM ${table} WHERE account=? ORDER BY ${order} LIMIT ?`, account, max + 1).toArray(), max)
  }
  const bytesOf = (...columns: string[]) => columns.map(column => `length(CAST(${column} AS BLOB))`).join('+')
  const incarnations = new Map<string, number>()
  const commits: Commit[] = rows<{ mount: string; owner: string; oid: string; parent_oid: string | null; tree_oid: string;
    message: string; author_name: string; author_email: string; time_seconds: number; changes: string; tree: string }>(commitTable,
    commitLimit, 'mount,owner,oid,parent_oid,tree_oid,message,author_name,author_email,time_seconds,changes,tree', 'mount,oid',
    bytesOf('message', 'author_name', 'author_email', 'changes', 'tree')).map(row => {
    const tree = strictJson(row.tree, 8), changes = strictJson(row.changes)
    if (!Array.isArray(tree) || !Array.isArray(changes)) return bad()
    const refs = tree.map(raw => {
      const [uri, sha, size, guard] = tuple(raw, 4)
      if (typeof uri !== 'string' || !hashId(sha) || !count(size, SNAPSHOT_BYTES) || !isRecord(guard) || guard.path !== '' ||
          typeof guard.node_id !== 'string' || !sourceIncarnation.test(guard.node_id)) return bad()
      const id = key(row.mount, uri, guard.node_id)
      if (!incarnations.has(id)) incarnations.set(id, incarnations.size + 1)
      return [uri, sha, size, incarnations.get(id)!] satisfies Ref
    })
    return [row.mount, row.owner, row.oid, row.parent_oid, row.tree_oid, row.message, row.author_name, row.author_email, row.time_seconds, changes, refs]
  })
  const heads: Head[] = rows<{ mount: string; branch: string; oid: string }>(headTable, headLimit, 'mount,branch,oid',
    'mount,branch', bytesOf('mount', 'branch')).map(({ mount, branch, oid }) => [mount, branch, oid])
  const blobs: Blob[] = rows<{ mount: string; owner: string; digest: string; oid: string; body: string; size: number }>(blobTable,
    blobLimit, 'mount,owner,digest,oid,body,size', 'mount,digest', bytesOf('body')).map(({ mount, owner, digest, oid, body, size }) => [mount, owner, digest, oid, body, size])
  const ignore = rows<{ content: string }>(ignoreTable, 1, 'content', 'account', bytesOf('content'))[0]?.content ?? null
  const compile: Definition[] = []
  if (hasTable(sql, compileConfigTable)) {
    const records = sql.exec<{ account_id: string; user_id: string; agent_id: string; name: string; space: string; target: string; inputs: string;
      created: number; last_run: number | null; updated_by: string }>(`SELECT account_id,user_id,agent_id,name,space,target,inputs,created,last_run,updated_by
      FROM ${compileConfigTable} ORDER BY user_id,agent_id,name LIMIT ?`, compileLimit + 1).toArray()
    for (const row of capped(records, compileLimit)) {
      const input = strictJson(row.inputs)
      if (row.account_id !== account || row.last_run !== null || row.updated_by !== row.user_id || row.space !== key('user', row.user_id) ||
          !isRecord(input) || Object.keys(input).length !== 7 || input.to !== row.target || input.auto_update !== false || input.update_schedule !== null ||
          input.instruction !== null || !isRecord(input.args) || Object.keys(input.args).length || !Array.isArray(input.from) ||
          typeof input.to !== 'string' || typeof input.skill !== 'string') return bad()
      compile.push([row.user_id, row.agent_id, row.name, row.created, input.from, input.to, input.skill])
    }
  }
  return { kind: 'openviking.edge-portable-state', version: 1, shared_history: 'admin-only', ignore, commits, heads, blobs, compile } satisfies Portable
}

export async function wrapPortableState(workspace: Bytes, state: Portable) {
  const bytes = encoder.encode(JSON.stringify(state))
  if (bytes.length > stateLimit) quota('Portable state exceeds its byte limit.')
  return storedZip([{ name: workspacePath, bytes: workspace }, { name: statePath, bytes }], limits)
}

export async function unwrapPortableState(zip: Bytes) {
  const members = inspectZip(zip, limits), workspace = members.get(workspacePath), json = members.get(statePath)
  if (members.size !== 2 || !workspace || !json) return bad()
  return { workspace: await memberBytes(workspace, attachmentArchiveBytes),
    state: shape(strictJson(decoder.decode(await memberBytes(json, stateLimit)), 6)) }
}

// Digest checks are purely over bounded, authenticated immutable bytes. Prepare
// checks structural edges and the provisioned policy again inside the final CAS.
export async function checkPortableHashes(state: Portable) {
  for (const raw of state.blobs) {
    const [, , sha, id, value, bytes] = tuple(raw, 6)
    const blob = await identifyBlob(text(value, 'snapshot blob', SNAPSHOT_BYTES))
    if (sha !== blob.key || id !== blob.oid || bytes !== blob.bytes) return bad()
  }
  for (const raw of state.commits) {
    const [, , , , tree, , , , , , refs] = tuple(raw, 11)
    if (!Array.isArray(refs) || refs.length > SNAPSHOT_FILES ||
        tree !== (await digest(encoder.encode(`ov-edge-tree\0${JSON.stringify(refs.map(ref => tuple(ref, 4).slice(0, 3)))}`))).slice(0, 40)) return bad()
  }
}

export function preparePortableState(d: Domain, state: Portable, entries: BackupEntry[], seats: AttachmentSeats) {
  if (seats.account !== d.scope.account || state.shared_history !== 'admin-only') return bad()
  if (state.ignore !== null && encoder.encode(text(state.ignore, 'snapshot ignore', ignoreLimit)).length > ignoreLimit) return bad()
  const blobs = new Map<string, Blob>(), used = new Set<string>()
  for (const raw of state.blobs) {
    const [mount, owner, sha, id, body, bytes] = tuple(raw, 6), k = key(mount, sha)
    if (!validOwner(d, mount, owner) || !hashId(sha) || !oid(id) || typeof body !== 'string' || !count(bytes, SNAPSHOT_BYTES) || blobs.has(k)) return bad()
    blobs.set(k, raw)
  }
  const graph = new Map<string, { parent: string | null; refs: Map<string, Ref> }>(), authors = new Map<string, number>()
  const incarnationPaths = new Map<number, string>()
  for (const raw of state.commits) {
    const [mount, owner, id, parent, tree, message, author, email, time, changes, refs] = tuple(raw, 11), k = key(mount, id)
    if (!validOwner(d, mount, owner) || !oid(id) || !(parent === null || oid(parent)) || !oid(tree) || graph.has(k) || !count(time, 253402300799) ||
        !Array.isArray(changes) || changes.length > SNAPSHOT_FILES * 2 || !Array.isArray(refs) || refs.length > SNAPSHOT_FILES) return bad()
    text(message, 'message'); text(author, 'author_name', 160); text(email, 'author_email', 256)
    const n = 1 + (authors.get(owner) ?? 0)
    if (n > 96) quota('Portable snapshot author history limit exceeded.')
    authors.set(owner, n)
    const files = new Map<string, Ref>()
    let previous = '', total = 0
    for (const ref of refs) {
      const [uri, sha, size, incarnation] = tuple(ref, 4)
      const path = fileScope(d, uri, mount, false), blobKey = key(mount, sha), blob = blobs.get(blobKey)
      if (path.uri <= previous || !blob || size !== blob[5] || !count(incarnation, commitLimit * SNAPSHOT_FILES) || !incarnation ||
          (total += blob[5]) > SNAPSHOT_BYTES || (incarnationPaths.has(incarnation) && incarnationPaths.get(incarnation) !== key(mount, uri))) return bad()
      let ancestor = path.uri.slice(0, path.uri.lastIndexOf('/'))
      while (ancestor.startsWith(ROOT)) {
        if (files.has(ancestor)) return bad()
        ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'))
      }
      incarnationPaths.set(incarnation, key(mount, uri))
      previous = path.uri
      files.set(path.uri, ref)
      used.add(blobKey)
    }
    graph.set(k, { parent: parent === null ? null : key(mount, parent), refs: files })
  }
  if (used.size !== blobs.size) return bad()
  for (const [mount, , id, , , , , , , changes] of state.commits) {
    const { parent, refs } = graph.get(key(mount, id))!, old = parent === null ? undefined : graph.get(parent)?.refs
    if (parent !== null && !old) return bad()
    const declared = new Set(changes)
    if (declared.size !== changes.length || changes.some(uri => !refs.has(uri) && !old?.has(uri))) return bad()
    for (const uri of new Set([...refs.keys(), ...old?.keys() ?? []])) {
      const a = old?.get(uri), b = refs.get(uri)
      if ((a?.[1] !== b?.[1] || a?.[3] !== b?.[3]) && !declared.has(uri)) return bad()
    }
  }
  const reachable = new Set<string>(), branches = new Set<string>()
  for (const raw of state.heads) {
    const [mount, branch, id] = tuple(raw, 3)
    if (typeof branch !== 'string' || !oid(id) || branches.has(key(mount, branch))) return bad()
    branchName(branch)
    branches.add(key(mount, branch))
    const active = new Set<string>()
    let next: string | null = key(mount, id)
    while (next !== null && !reachable.has(next)) {
      const row = graph.get(next)
      if (!row || active.has(next)) return bad()
      active.add(next)
      next = row.parent
    }
    for (const item of active) reachable.add(item)
  }
  if (reachable.size !== graph.size) return bad()

  const directories = new Map(entries.filter(e => e.directory).map(e => [ROOT + e.path, e]))
  const targets = new Set<string>(), configs = new Set<string>()
  const definitions = state.compile.map(raw => {
    const [owner, agent, name, created, from, to, skill] = tuple(raw, 7)
    if (typeof owner !== 'string' || !d.scope.users.includes(owner) || typeof agent !== 'string' || !seats.owns(owner, agent) ||
        typeof created !== 'number' || !Number.isFinite(created) || created <= 0 || typeof to !== 'string' ||
        typeof skill !== 'string' || !skill.startsWith(exampleRoot + '/') || !Array.isArray(from)) return bad()
    const mount = key('user', owner), ctx = d.fs(owner).ctx
    const nameKey = key(owner, agent, compileName(name))
    if (configs.has(nameKey) || [...targets].some(uri => overlap(uri, to))) return bad()
    configs.add(nameKey); targets.add(to)
    const inputs = parseInputs({ from, to, skill }, ctx, 'create')
    if (inputs.to !== to || inputs.skill !== skill || JSON.stringify(inputs.from) !== JSON.stringify(from)) return bad()
    for (const uri of [...inputs.from, inputs.to]) {
      fileScope(d, uri, mount, true)
      if (directories.get(uri)?.owner !== owner) return bad()
    }
    if (!directories.get(to)?.tags.includes('compile_target=true')) return bad()
    return { owner, agent, name: compileName(name), mount, inputs, created }
  })

  return { changed: !!(state.ignore !== null || state.commits.length || definitions.length), publish() {
    const { sql, scope: { account } } = d
    if (state.ignore !== null || state.commits.length) initSnapshotStore(d.fs().ctx)
    if (state.commits.some(([mount]) => mount === 'shared')) sql.exec(`CREATE TABLE ${portableHiddenTable} (
      account TEXT NOT NULL, oid TEXT NOT NULL, PRIMARY KEY(account,oid)) WITHOUT ROWID`)
    if (state.ignore !== null) sql.exec(`INSERT INTO ${ignoreTable} (account,content) VALUES (?,?)`, account, state.ignore)
    for (const [mount, owner, sha, id, body, bytes] of state.blobs) sql.exec(
      `INSERT INTO ${blobTable} (account,mount,owner,digest,oid,body,size) VALUES (?,?,?,?,?,?,?)`, account, mount, owner, sha, id, body, bytes)
    for (const [mount, owner, id, parent, tree, message, author, email, time, changes, refs] of state.commits) {
      // No source ACL or node identifier comes through. The synthetic historical
      // incarnation is disjoint from all live nodes, and shared guards grant nothing.
      const files: FileRef[] = refs.map(([uri, sha, size, n]) => [uri, sha, size,
        { path: '', node_id: `portable:${n}`, ...(mount === 'shared' && { read_acl: [] }) }])
      const jsonTree = JSON.stringify(files), jsonChanges = JSON.stringify(changes)
      const size = encoder.encode(jsonTree + jsonChanges + message + author + email).length
      sql.exec(`INSERT INTO ${commitTable} (account,mount,owner,oid,parent_oid,tree_oid,message,author_name,author_email,time_seconds,changes,tree,storage_bytes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, account, mount, owner, id, parent, tree, message, author, email, time, jsonChanges, jsonTree, size)
      if (mount === 'shared') sql.exec(`INSERT INTO ${portableHiddenTable} (account,oid) VALUES (?,?)`, account, id)
    }
    for (const [mount, branch, id] of state.heads) sql.exec(`INSERT INTO ${headTable} (account,mount,branch,oid) VALUES (?,?,?,?)`, account, mount, branch, id)
    if (definitions.length) initState(d.fs().ctx)
    for (const { owner, agent, name, mount, inputs, created } of definitions) {
      sql.exec(`INSERT INTO ${compileConfigTable} (account_id,user_id,agent_id,name,space,target,signature,inputs,created,last_run,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`, account, owner, agent, name, mount, inputs.to,
      Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), JSON.stringify(inputs), created, owner)
    }
  } }
}
