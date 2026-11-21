// SPDX-License-Identifier: AGPL-3.0-only
import { base64url, flowCookie, idPattern, OAUTH_SCOPE, PENDING_TTL, random, registered, unavailable } from './protocol.js'
import type { Configuration, Intent } from './protocol.js'

const rotationMs = 60 * 60 * 1000
const ttlMs = PENDING_TTL * 1000
const ivLength = 12
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const version = 'v1'
const capsule = /^v1\.(0|[1-9]\d{0,9})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{38,3520})$/
const epochAt = (time: number) => Math.floor(time / rotationMs)

export type OpenIntent = Intent & { expiresAt: number }

function context(config: Configuration, epoch: number, pending: string, nonce: string) {
  return encoder.encode(JSON.stringify(['openviking:oauth:intent', version, config.issuer, config.resource,
    OAUTH_SCOPE, epoch, pending, nonce]))
}

// The SPA still receives only the short pending handle. The HttpOnly cookie
// carries authenticated ciphertext, scoped to that handle and its random nonce.
// There is no durable record for an anonymous intent or its expiry.
export class IntentCapsules {
  readonly #keys = new Map<number, Promise<CryptoKey>>()
  constructor(private readonly keyMaterial: (epoch: number, create: boolean) => ArrayBuffer | undefined) {}

  #key(epoch: number, current: number, create: boolean): Promise<CryptoKey> | undefined {
    for (const slot of this.#keys.keys()) if (slot < current - 1 || slot > current) this.#keys.delete(slot)
    const cached = this.#keys.get(epoch)
    if (cached) return cached
    const material = this.keyMaterial(epoch, create)
    if (!material) return undefined
    const imported = crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
    this.#keys.set(epoch, imported)
    return imported
  }

  async seal(input: Intent, config: Configuration, pending: string): Promise<string> {
    const issued = Date.now()
    const epoch = epochAt(issued)
    const key = await this.#key(epoch, epoch, true)
    if (!key) throw unavailable()
    const nonce = random()
    const iv = crypto.getRandomValues(new Uint8Array(ivLength))
    // Resource and scope are already bound in the additional data; no duplicate
    // URL is needed. The upper bound leaves room in a browser's 4 KiB cookie.
    const plain = encoder.encode(JSON.stringify([issued, input.client_id, input.redirect_uri, input.challenge, input.state]))
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(config, epoch, pending, nonce),
      tagLength: 128 }, key, plain)
    const bytes = new Uint8Array(ivLength + sealed.byteLength)
    bytes.set(iv)
    bytes.set(new Uint8Array(sealed), ivLength)
    const value = `${version}.${epoch}.${nonce}.${base64url(bytes)}`
    if (!capsule.test(value)) throw unavailable()
    return value
  }

  async open(request: Request, config: Configuration, pending: string): Promise<OpenIntent | null> {
    if (!idPattern.test(pending)) return null
    const value = flowCookie(request, config)
    const match = value && capsule.exec(value)
    if (!match) return null
    const [, slot, nonce, serialized] = match
    const epoch = Number(slot)
    const now = Date.now()
    const current = epochAt(now)
    // Reject invalid epochs without looking up or creating a key. A previous
    // slot can only have an unexpired capsule just after the boundary.
    if (epoch !== current && !(epoch === current - 1 && now % rotationMs < ttlMs)) return null
    const key = await this.#key(epoch, current, false)
    if (!key) return null
    try {
      const bytes = Uint8Array.from(atob(serialized.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, ivLength),
        additionalData: context(config, epoch, pending, nonce), tagLength: 128 }, key, bytes.subarray(ivLength))
      const decoded: unknown = JSON.parse(decoder.decode(plain))
      if (!Array.isArray(decoded) || decoded.length !== 5) return null
      const [issued, clientId, redirect, challenge, state] = decoded
      if (typeof issued !== 'number' || !Number.isSafeInteger(issued) || epochAt(issued) !== epoch || issued > now ||
          issued + ttlMs <= Date.now() || typeof clientId !== 'string' || typeof redirect !== 'string' ||
          typeof challenge !== 'string' || typeof state !== 'string' || !registered(config, clientId, redirect, config.resource)) return null
      return { client_id: clientId, redirect_uri: redirect, resource: config.resource, challenge, state, expiresAt: issued + ttlMs }
    } catch {
      // Authentication failure is indistinguishable from an expired intent.
      return null
    }
  }
}
