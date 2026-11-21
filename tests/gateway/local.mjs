// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'

const work = fileURLToPath(new URL('../../', import.meta.url))
let bundled

export async function fixtureWorker(t, { principals, persist, embeddings = true, generate = true, streaming = false }) {
  bundled ??= build({ absWorkingDir: work, entryPoints: ['tests/gateway/worker-fixture.mjs'], platform: 'browser',
    format: 'esm', bundle: true, write: false, external: ['cloudflare:workers'] })
  const script = (await bundled).outputFiles[0].text
  const egress = []
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'openviking-edge-gateway-test',
    host: '127.0.0.1', port: 0, modules: true, script, compatibilityDate: '2026-11-19',
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    ...(persist && { resourcePersistencePath: persist }),
    outboundService() { egress.push(true); return new Response(null, { status: 502 }) },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify(principals), OPENVIKING_EDGE_GENERATION: generate ? '1' : '0',
      TEST_GATEWAY_EMBEDDINGS: embeddings ? 'on' : 'off', TEST_GATEWAY_STREAMING: streaming ? 'on' : 'off' }, log: new Log(LogLevel.ERROR) }))
  const close = async () => { await runtime.dispose(); assert.deepEqual(egress, [], 'Gateway test made no outbound HTTP requests') }
  if (t) t.after(close)
  return { runtime, close }
}
