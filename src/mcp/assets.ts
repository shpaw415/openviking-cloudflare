// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, ok, readJson } from '../http.js'
import { encoder, invalid, onlyKeys, pathFor, resourcePath, str, unsupported } from '../fs/contract.js'
import { asObject } from './common.js'
import { parseManifest } from './manifest.js'

const prefix = '/api/v1/openviking-assets/'
const protocol = 'openviking-assets/1'
const docLimit = 128 * 1024

function string(value: unknown, field: string, limit: number): string {
  const text = str(value, field, undefined, limit).trim()
  if (!text || /[\p{Cc}\p{Cf}]/u.test(text)) invalid(`${field} must be nonempty text without controls.`)
  return text
}
function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 128) invalid(`${name} must be a list of at most 128 entries.`)
  return value
}
const optional = (value: unknown, name: string, limit: number) => value == null ? null : string(value, name, limit)
function interval(value: unknown, fallback: number) {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid('watch_interval must be a finite nonnegative number.')
  return value
}

function repository(value: unknown) {
  const repo_url = string(value, 'repo_url', 2048)
  const url = /^(https?|ssh|git):\/\/(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/([A-Za-z0-9._~/-]+)$/iu.exec(repo_url)
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._~/-]+)$/u.exec(repo_url)
  if (!url && !scp) return invalid('repo_url must be a supported Git locator without credentials, query, or fragment.')
  if (url?.[2] && url[1].toLowerCase() !== 'ssh' || url?.[4] && (+url[4] < 1 || +url[4] > 65535)) {
    invalid('repo_url contains unsupported user information or port.')
  }
  const host = (url?.[3] ?? scp![2]).toLowerCase()
  const path = (url?.[5] ?? scp![3]).replace(/\/$/u, '')
  if (host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('-'))) invalid('Invalid Git host or repository path.')
  const locator = `${host}/${path.replace(/\.git$/iu, '')}`
  if (locator.endsWith('/')) invalid('The Git repository path is empty.')
  return { repo_url, locator }
}

function reference(rawBranch: unknown, rawCommit: unknown) {
  const branch = optional(rawBranch, 'branch', 256)
  const commit = optional(rawCommit, 'commit', 40)?.toLowerCase() ?? null
  if (branch !== null && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes('..') ||
      branch.split('/').some(segment => !segment || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock')))) invalid('Invalid Git branch.')
  if (commit !== null && !/^[a-f0-9]{40}$/u.test(commit)) invalid('commit must be a full hexadecimal SHA.')
  if (commit && branch) invalid('branch and commit are mutually exclusive.')
  return { branch, commit, git_ref: commit ?? branch ?? '' }
}

export async function routeAssets(request: Request, url: URL, ctx: WorkspaceContext): Promise<Response | undefined> {
  const path = url.pathname
  if (path !== `${prefix}resolve` && path !== `${prefix}preflight`) return
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST.')
  if (path.endsWith('/preflight')) unsupported('Git connectivity preflight is not available without an approved connector. No source was contacted.')

  const input = await readJson(request, 512 * 1024)
  onlyKeys(input, 'manifest_yaml catalog_yaml manifest_label catalog_label')
  const label = (value: unknown, field: string, fallback: string) => value === undefined ? fallback : string(value, field, 1024)
  const manifest_label = label(input.manifest_label, 'manifest_label', 'manifest.yaml')
  const catalog_label = label(input.catalog_label, 'catalog_label', 'catalog.yaml')
  const document = (value: unknown, field: string) => parseManifest(str(value, field, undefined, docLimit))
  const manifest = document(input.manifest_yaml, 'manifest_yaml')
  onlyKeys(manifest, 'protocol defaults catalog include assets')
  if (manifest.protocol != null && manifest.protocol !== protocol) invalid('Unsupported asset protocol.')
  if (manifest.include != null && list(manifest.include, 'include').length) invalid('Includes are not resolved; supply one flat manifest.')
  const inline = manifest.catalog != null
  if (inline && (input.catalog_yaml != null || manifest.protocol !== protocol)) invalid('An inline catalog requires the protocol and no separate catalog.')
  if (!inline && (manifest.defaults != null || input.catalog_yaml == null)) invalid('A separate catalog is required when the manifest does not define one.')
  const catalog = inline ? manifest : document(input.catalog_yaml, 'catalog_yaml')
  if (!inline) onlyKeys(catalog, 'protocol defaults catalog')
  if (catalog.protocol !== protocol) invalid('Unsupported catalog protocol.')

  const defaults = catalog.defaults == null ? {} : asObject(catalog.defaults, 'defaults')
  onlyKeys(defaults, 'git')
  const git = defaults.git == null ? {} : asObject(defaults.git, 'defaults.git')
  onlyKeys(git, 'auth_ref watch_interval')
  const defaultAuth = optional(git.auth_ref, 'auth_ref', 256)
  const defaultWatch = interval(git.watch_interval, 0)

  const entries = new Map<string, { name: string; asset: ReturnType<typeof asObject>; watch_interval: number; auth_ref: string | null }>()
  for (const candidate of list(catalog.catalog, 'catalog')) {
    const asset = asObject(candidate, 'Asset')
    onlyKeys(asset, 'name connector description to params auth_ref watch_interval')
    const name = string(asset.name, 'name', 256)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || asset.name !== name || entries.has(name)) invalid('Invalid or duplicate asset name.')
    if (asset.connector !== 'git') invalid('Only git assets can be resolved.')
    if (asset.description !== undefined) str(asset.description, 'description', undefined, 4096)
    asObject(asset.params, 'Asset params')
    entries.set(name, { name, asset, watch_interval: interval(asset.watch_interval, defaultWatch),
      auth_ref: optional(asset.auth_ref, 'auth_ref', 256) ?? defaultAuth })
  }
  const names = manifest.assets == null ? (inline ? [...entries.keys()] : []) :
    [...new Set(list(manifest.assets, 'assets').map(name => string(name, 'Asset selection', 256)))]
  if (!names.length) invalid('The manifest selects no assets.')
  const seenTargets = new Set<string>(), seenSources = new Set<string>()
  const assets = []
  for (const name of names) {
    const entry = entries.get(name) ?? invalid('The manifest selects an undefined asset.')
    const params = asObject(entry.asset.params, 'Asset params')
    onlyKeys(params, 'repo_url branch commit')
    const source = repository(params.repo_url), ref = reference(params.branch, params.commit)
    const target = optional(entry.asset.to, 'to', 4096)
    let to: string | null = null
    if (target !== null) {
      const path = pathFor(target, ctx.caller)
      resourcePath(path)
      to = path.uri
      if (seenTargets.has(to)) invalid('Two assets use the same target URI.')
      seenTargets.add(to)
    }
    const identity = `git\n${source.locator}\n${ref.git_ref}`
    if (seenSources.has(identity)) invalid('Two assets resolve to the same Git source and ref.')
    seenSources.add(identity)
    // SHA-1 is the pinned wire format for a display ID, not a security digest.
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(identity)))
    const asset_id = Array.from(sha.slice(0, 6), byte => byte.toString(16).padStart(2, '0')).join('')
    assets.push({ name, connector: 'git', to, ...source, ...ref, auth_ref: entry.auth_ref, watch_interval: entry.watch_interval, asset_id })
  }
  return ok({ protocol, manifest: manifest_label, catalog: inline ? manifest_label : catalog_label, assets })
}
