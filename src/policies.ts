// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, ok } from './http.js'
import { activateCommand, byteLength, decoded, name, notFound, PrivacyInputError, query, reference,
  requireNoReveal, scanCommand, segment, select, versionNumber, writeCommand } from './policies/protocol.js'
import { fieldStates, initStore, PolicyStore, publicSnapshot } from './policies/store.js'
import { scanPrivacy } from './policies/scan.js'

export function initPolicies(ctx: WorkspaceContext): void {
  initStore(ctx.sql)
}

const prefix = '/api/v1/privacy-configs'
const tooLarge = () => new ApiError(413, 'RESOURCE_EXHAUSTED', 'Privacy tree exceeds 2 MiB; narrow the category.')
const wrongMethod = () => new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed for this Privacy route.')

function dispatchTree(store: PolicyStore, owner: string, filter: string | null) {
  type Field = ReturnType<typeof describeField>
  type TreeTarget = { target_key: string; version: number; fields: Field[] }
  const categories = new Map<string, TreeTarget[]>()
  const category = filter === null ? undefined : segment(filter, 'category')
  if (category !== undefined) categories.set(category, [])
  let bytes = 0
  for (const row of store.activeTargets(category)) {
    const item = { target_key: row.target_key, version: row.version,
      fields: fieldStates(row).map(state => describeField(owner, row.category, row.target_key, state)) }
    bytes += byteLength(JSON.stringify(item)) + byteLength(row.category) + 40
    if (bytes > 2 * 1024 * 1024) throw tooLarge()
    const targets = categories.get(row.category)
    if (targets) targets.push(item)
    else categories.set(row.category, [item])
  }
  return { owner_user_id: owner, categories: Array.from(categories, ([category, targets]) => ({ category, targets })) }
}

function describeField(owner: string, category: string, target: string, [field, configured]: [string, boolean]) {
  return { field, configured, reference: reference(owner, category, target, field) }
}

function resolveField(store: PolicyStore, owner: string, category: string, target: string, field: string) {
  const row = store.active(category, target)
  const state = fieldStates(row).find(([candidate]) => candidate === field)
  if (!state) throw notFound()
  return { owner_user_id: owner, category, target_key: target, version: row.version,
    ...describeField(owner, category, target, state) }
}

async function dispatch(request: Request, url: URL, ctx: WorkspaceContext, parts: string[]) {
  const owner = segment(ctx.caller.userId, 'owner_user_id')
  const store = new PolicyStore(ctx)
  const method = request.method === 'HEAD' ? 'GET' : request.method

  if (parts.length === 0) {
    if (method !== 'GET') throw wrongMethod()
    return ok(store.categories())
  }

  if (parts.length === 1) {
    const [route] = parts
    if (route === 'scan' && method === 'POST') return scanPrivacy(ctx, await scanCommand(request))
    if (route === 'resolve' && method === 'POST') {
      const selected = await select(request, owner, true)
      if (selected.field === undefined) throw new Error('Expected a validated Privacy field selector.')
      return ok({ ...resolveField(store, owner, selected.category, selected.target, selected.field), redacted: true })
    }
    if (route === 'selector' && method === 'DELETE') {
      const { category, target, field } = await select(request, owner, false)
      await ctx.reauthorize?.()
      if (field !== undefined) return ok(store.deleteField(category, target, field))
      return ok({ owner_user_id: owner, category, target_key: target, deleted: store.deleteTarget(category, target), scope: 'target' })
    }
    if (method !== 'GET') throw wrongMethod()
    if (route === 'tree') return ok(dispatchTree(store, owner, query(url, 'category')))
    return ok(store.targets(segment(route, 'category')))
  }

  const category = segment(parts[0], 'category')
  const target = segment(parts[1], 'target_key')
  if (parts.length === 2) {
    if (method === 'GET') return ok(store.current(category, target))
    if (method === 'POST' || method === 'PATCH') {
      const command = await writeCommand(request)
      await ctx.reauthorize?.()
      return ok(store.write(category, target, method === 'PATCH', command))
    }
    if (method === 'DELETE') return ok({ category, target_key: target, deleted: store.deleteTarget(category, target) })
    throw wrongMethod()
  }

  const operation = parts[2]
  if (operation === 'versions' && (parts.length === 3 || parts.length === 4)) {
    if (method !== 'GET') throw wrongMethod()
    if (parts.length === 3) return ok(store.versions(category, target))
    const version = versionNumber(/^\d+$/.test(parts[3]) ? Number(parts[3]) : NaN)
    return ok(publicSnapshot(store.version(category, target, version)))
  }
  if (parts.length !== 3) throw notFound()
  if (operation === 'activate') {
    if (method !== 'POST') throw wrongMethod()
    const version = await activateCommand(request)
    await ctx.reauthorize?.()
    return ok(store.activate(category, target, version))
  }
  if (operation === 'fields') {
    if (method !== 'GET') throw wrongMethod()
    const row = store.active(category, target)
    return ok({ owner_user_id: owner, category, target_key: target, version: row.version,
      fields: fieldStates(row).map(state => describeField(owner, category, target, state)) })
  }
  if (operation === 'field') {
    if (method === 'GET') {
      requireNoReveal(url)
      return ok(resolveField(store, owner, category, target, name(query(url, 'field'))))
    }
    if (method === 'DELETE') return ok(store.deleteField(category, target, name(query(url, 'field'))))
    throw wrongMethod()
  }
  throw notFound()
}

// Trust only the caller created by the parent after HTTP authentication; this
// router must be mounted inside authenticated Workspace dispatch, never on a
// public /api route. Admin has the very same visibility and projection as user.
export async function routePolicies(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | null> {
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null
  const suffix = url.pathname.slice(prefix.length + 1).replace(/\/$/, '')
  try {
    if (suffix.length > 8192) throw new PrivacyInputError('Privacy path is too long.', { field: 'path', reason: 'too long' })
    const result = await dispatch(request, url, ctx, suffix ? suffix.split('/').map(decoded) : [])
    const headers = new Headers(result.headers)
    headers.set('Cache-Control', 'private, no-store')
    return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers })
  } catch (error) {
    if (!(error instanceof PrivacyInputError)) throw error
    return Response.json(request.method === 'HEAD' ? null : {
      status: 'error', error: { code: error.code, message: error.message, details: error.details },
    }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } })
  }
}
