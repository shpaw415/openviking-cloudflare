// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { localWorker, testPrincipal } from '../support/local-worker.mjs'

const origin = 'http://127.0.0.1:8824'
const port = 8824
const keyFile = process.argv[2]
assert.ok(process.env.LD_PRELOAD && keyFile)
// This negative must fail in bind(), not merely report an occupied port.
const wildcard = createServer()
const result = await new Promise(resolve => {
  wildcard.once('error', error => resolve(error.code))
  wildcard.listen(0, '0.0.0.0', () => wildcard.close(() => resolve('BOUND')))
})
assert.equal(result, 'EPERM')

const principal = testPrincipal('edgeqa', 'reviewer', 'admin')
const runtime = await localWorker({
  principals: [principal], port, embeddings: 'fixture',
  vars: { OPENVIKING_EDGE_GENERATION: '1' },
  outboundService() { return new Response('No external transport in client qualification', { status: 503 }) },
})
const closed = new Promise(resolve => {
  process.once('SIGINT', resolve)
  process.once('SIGTERM', resolve)
})
try {
  assert.equal((await runtime.ready).origin, origin)
  const health = await fetch(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  assert.equal(health.status, 200)
  const status = await health.json()
  assert.equal(status.healthy ?? status.result?.healthy, true)
  console.log(JSON.stringify({ origin, bundle_sha256: runtime.localBuildSha256, health_http: 200,
    api_version: status.version ?? status.result?.version, wildcard_bind: result,
    sqlite: 'ephemeral', embeddings: 'deterministic fixture', role: 'account admin' }))
  // Last step: the controller can run clients only after the bundle/health line.
  await writeFile(keyFile, principal.key, { mode: 0o600, flag: 'wx' })
  await closed
} finally {
  await runtime.dispose()
}
