// SPDX-License-Identifier: AGPL-3.0-only
// Test-only Studio server. Participant data never goes to an AI service.
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { localWorker, testPrincipal } from '../tests/support/local-worker.mjs'

const assetsDir = process.argv.includes('--api-only') ? undefined : resolve('dist')
if (assetsDir) await access(resolve(assetsDir, 'studio/index.html'))
const port = Number(process.argv[2])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Supply a dedicated loopback test port.')
const principal = testPrincipal('edgeqa', 'reviewer', process.argv.includes('--as-admin') ? 'admin' : 'user')
const seedAdmin = process.argv.includes('--seed') ? testPrincipal('edgeqa', 'seed', 'admin') : undefined
const root = process.argv.includes('--root') ? testPrincipal('root', 'root', 'root') : undefined
const defaultAccount = process.argv.includes('--default-account') ? testPrincipal('default', 'owner_fixture', 'admin') : undefined
const vars = process.argv.includes('--generation') ? {OPENVIKING_EDGE_GENERATION:'1'} : {}
const runtime = await localWorker({ principals: [principal, ...(seedAdmin ? [seedAdmin] : []), ...(root ? [root] : []), ...(defaultAccount ? [defaultAccount] : [])], embeddings: 'fixture', assetsDir, port, vars })
const owned = []

try {
  const url = await runtime.ready
  const output = resolve('.work/browser')
  await mkdir(output, { recursive: true, mode: 0o700 })
  const keyFile = resolve(output, `synthetic-${port}.key`)
  await writeFile(keyFile, principal.key, { mode: 0o600, flag: 'wx' })
  owned.push(keyFile)
  if (root) {
    const rootFile = resolve(output, `synthetic-root-${port}.key`)
    await writeFile(rootFile, root.key, { mode: 0o600, flag: 'wx' })
    owned.push(rootFile)
  }
  console.log(`OpenViking smoke: ${url.origin}${assetsDir ? '/studio/' : '/health'} (ephemeral SQLite; fixture embeddings)`)
  console.log(`Workerd test bundle SHA-256: ${runtime.localBuildSha256}`)
  if(assetsDir) console.log(`Studio index SHA-256: ${createHash('sha256').update(await readFile(resolve(assetsDir,'studio/index.html'))).digest('hex')}`)

  if (seedAdmin) {
    const source = await readFile(new URL('../tests/fixtures/navigation.md', import.meta.url), 'utf8')
    const data = await fetch(`${url.origin}/api/v1/content/write`, {
      method: 'POST', headers: { 'x-api-key': seedAdmin.key, 'content-type': 'application/json' },
      body: JSON.stringify({ uri: 'viking://resources/navigation.md', content: source, wait: true }),
    })
    console.log(`Seed via Worker API: HTTP ${data.status}`)
    if (!data.ok) throw new Error(`Seed setup failed with HTTP ${data.status}`)
  }

  await new Promise(resolve => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
} finally {
  try { await runtime.dispose() } finally { for (const file of owned) await unlink(file) }
}
