// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'

export { api, testPrincipal } from '../support/local-worker.mjs'

const project = fileURLToPath(new URL('../../', import.meta.url))

let bundle
function buildWorker() {
  return bundle ??= build({
    absWorkingDir: project, platform: 'browser', format: 'esm', bundle: true, write: false,
    external: ['cloudflare:workers'],
    stdin: { resolveDir: project, contents: `
      export { default, Control } from './src/worker.ts';
      import { Workspace as Parent } from './src/worker.ts';
      export class Workspace extends Parent {
        constructor(state, env) {
          super(state, { ...env, ...(env.MCP_TEST_VECTOR ? {AI: {async run(model, {text}) {
            if (model !== '@cf/baai/bge-base-en-v1.5' || !Array.isArray(text)) throw Error('Unexpected fixture call');
            return {data: text.map(s => {const v = Array(768).fill(0); v[0] = 0.01;
              v[/harbor|sailing|boat/i.test(s) ? 1 : 2] = 1; return v;})};
          }}} : {}) });
        }
      }
    ` },
  })
}

export async function localMcp(t, { principals, mode = '', vectors = true, persist } = {}) {
  const script = (await buildWorker()).outputFiles[0].text
  let outbound = 0
  const options = convertV4MiniflareOptions({
    name: 'openviking-mcp-local', host: '127.0.0.1', port: 0, cf: false, modules: true, script,
    compatibilityDate: '2026-11-19',
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify(principals), OPENVIKING_EDGE_MCP: mode, MCP_TEST_VECTOR: vectors },
    outboundService: () => { outbound++; return new Response('Network is disabled in the MCP test.', { status: 599 }) },
    log: new Log(LogLevel.ERROR),
  })
  const runtime = new Miniflare({ ...options, enableDevRegistry: false, telemetry: { enabled: false }, logRequests: false,
    ...(persist && { resourcePersistencePath: persist }) })
  t.after(async () => {
    await runtime.dispose()
    assert.equal(outbound, 0, 'The Worker attempted outbound network access')
  })
  return runtime
}
