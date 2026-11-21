// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'

export async function compileWorker(principals, persist) {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const result = await build({ absWorkingDir: root, stdin: { resolveDir: root, sourcefile: 'compile-test-entry.mjs', contents: `
    import worker, { Workspace as RealWorkspace } from './src/worker.ts';
    import { ai } from './tests/compile/provider.mjs';
    export default worker;
    export { Control } from './src/worker.ts';
    export class Workspace extends RealWorkspace { constructor(ctx, env) { super(ctx, {...env, AI: ai}); } }
  ` }, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], write: false })
  const options = convertV4MiniflareOptions({
    name: 'edge-compile-test', host: '127.0.0.1', port: 0, modules: true, script: result.outputFiles[0].text,
    compatibilityDate: '2026-11-19', log: new Log(LogLevel.ERROR),
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true } },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify(principals), OPENVIKING_EDGE_GENERATION: '1' },
  })
  return new Miniflare(persist ? { ...options, resourcePersistencePath: persist } : options)
}
