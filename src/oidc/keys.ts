// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { base64url, onlyFields, utf8, visibleAscii } from './encoding.js'

const algorithms = {
  RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  RS384: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  RS512: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  PS256: { name: 'RSA-PSS', hash: 'SHA-256', saltLength: 32 },
  PS384: { name: 'RSA-PSS', hash: 'SHA-384', saltLength: 48 },
  PS512: { name: 'RSA-PSS', hash: 'SHA-512', saltLength: 64 },
  ES256: { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256', coordinateBytes: 32 },
  ES384: { name: 'ECDSA', hash: 'SHA-384', namedCurve: 'P-384', coordinateBytes: 48 },
  ES512: { name: 'ECDSA', hash: 'SHA-512', namedCurve: 'P-521', coordinateBytes: 66 },
} as const

type Alg = keyof typeof algorithms
interface KeyInput {
  kid: string
  alg: Alg
  material: string
  jwk: JsonWebKey
  signatureBytes: number
}
export interface VerificationKey {
  alg: Alg
  key: CryptoKey
  signatureBytes: number
}

const common = ['kid', 'kty', 'alg', 'use', 'key_ops', 'ext']
const invalid = () => new TypeError('Invalid configured OIDC verification key.')

function keyInput(value: unknown): KeyInput {
  if (!isRecord(value)) throw invalid()
  const { kid, alg, kty } = value
  if (!visibleAscii(kid, 128) || typeof alg !== 'string' || !Object.hasOwn(algorithms, alg) ||
      (Object.hasOwn(value, 'use') && value.use !== 'sig') ||
      (Object.hasOwn(value, 'key_ops') && (!Array.isArray(value.key_ops) || value.key_ops.length !== 1 || value.key_ops[0] !== 'verify')) ||
      (Object.hasOwn(value, 'ext') && typeof value.ext !== 'boolean')) throw invalid()

  const pinned = alg as Alg
  const scheme = algorithms[pinned]
  if ('namedCurve' in scheme) {
    const { crv, x, y } = value
    if (kty !== 'EC' || crv !== scheme.namedCurve || typeof x !== 'string' || typeof y !== 'string' ||
        !onlyFields(value, [...common, 'crv', 'x', 'y']) || base64url(x, 88).length !== scheme.coordinateBytes ||
        base64url(y, 88).length !== scheme.coordinateBytes) throw invalid()
    return { kid, alg: pinned, material: `${crv}.${x}.${y}`, jwk: { kty, crv: scheme.namedCurve, x, y }, signatureBytes: 2 * scheme.coordinateBytes }
  }

  const { n, e } = value
  if (kty !== 'RSA' || typeof n !== 'string' || e !== 'AQAB' || !onlyFields(value, [...common, 'n', 'e'])) throw invalid()
  const modulus = base64url(n, 683)
  if (![256, 384, 512].includes(modulus.length) || modulus[0] < 128 || (modulus[modulus.length - 1] & 1) !== 1) throw invalid()
  return { kid, alg: pinned, material: `RSA.${n}.${e}`, jwk: { kty, n, e }, signatureBytes: modulus.length }
}

export async function importKeys(value: unknown): Promise<ReadonlyMap<string, VerificationKey>> {
  if (!isRecord(value) || !onlyFields(value, ['keys']) || !Array.isArray(value.keys) ||
      value.keys.length < 1 || value.keys.length > 16) throw invalid()
  const inputs = value.keys.map(keyInput)
  if (new Set(inputs.map(key => key.kid)).size !== inputs.length || new Set(inputs.map(key => key.material)).size !== inputs.length) {
    throw invalid()
  }

  const pairs = await Promise.all(inputs.map(async ({ kid, alg, jwk, signatureBytes }) => {
    const scheme = algorithms[alg]
    const parameters = 'namedCurve' in scheme ? { name: scheme.name, namedCurve: scheme.namedCurve } : { name: scheme.name, hash: scheme.hash }
    const key = await crypto.subtle.importKey('jwk', jwk, parameters, false, ['verify'])
    return [kid, { alg, key, signatureBytes }] as const
  }))
  return new Map(pairs)
}

export async function verifySignature(key: VerificationKey, encoded: string, signingInput: string): Promise<boolean> {
  const scheme = algorithms[key.alg]
  const signature = base64url(encoded, Math.ceil(key.signatureBytes * 4 / 3))
  if (signature.length !== key.signatureBytes) return false
  const parameters = 'saltLength' in scheme ? { name: scheme.name, saltLength: scheme.saltLength }
    : 'namedCurve' in scheme ? { name: scheme.name, hash: scheme.hash } : { name: scheme.name }
  return crypto.subtle.verify(parameters, key.key, signature, utf8.encode(signingInput))
}
