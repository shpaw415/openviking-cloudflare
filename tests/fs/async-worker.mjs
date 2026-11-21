// SPDX-License-Identifier: AGPL-3.0-only
// The scheduler, alarm, ACL, storage and HTTP entry point are the product code.
// Only the model binding is supplied via a local Miniflare service bridge.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, FormData, Miniflare } from 'miniflare'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

export function embeddingGate(match) {
  const entered = Promise.withResolvers(), resume = Promise.withResolvers()
  return {
    entered: entered.promise, release: resume.resolve,
    async provider(texts) {
      if (match(texts)) { entered.resolve(); await resume.promise }
      return { data: texts.map(text => {
        const vector = Array(768).fill(0)
        vector[/volcano|geology/i.test(text) ? 1 : 0] = 1
        return vector
      }) }
    },
  }
}

export async function gatedWorker(principals, provider, generate) {
  const result = await build({ stdin: { resolveDir: rootDir, contents: `
    import worker, { Workspace as ProductionWorkspace } from './src/worker.ts';
    export default worker;
    export { Control, OAuth } from './src/worker.ts';
    export class Workspace extends ProductionWorkspace {
      constructor(ctx, env) { super(ctx, { ...env, AI: { async run(model, args) {
        const isGeneration = model === '@cf/meta/llama-3.1-8b-instruct';
        if (!isGeneration && model !== '@cf/baai/bge-base-en-v1.5') throw Error('Unexpected model');
        const response = await env.FS_PROVIDER.fetch('https://fixture.invalid/' + (isGeneration ? 'generation' : 'embedding'), {
          method: 'POST', body: JSON.stringify(isGeneration ? args : args.text),
        });
        if (!response.ok) throw Error('Fixture embedding unavailable');
        return response.json();
      } } }); }
    }
  ` }, bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'] })
  return new Miniflare({ ...convertV4MiniflareOptions({ name: 'openviking-fs-jobs', host: '127.0.0.1', port: 0, modules: true,
    script: result.outputFiles[0].text, compatibilityDate: '2026-11-19', cf: false,
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true },
      OAUTH: { className: 'OAuth', useSQLite: true } },
    bindings: { OPENVIKING_EDGE_KEYS: JSON.stringify(principals), ...(generate && { OPENVIKING_EDGE_GENERATION: '1' }) },
    serviceBindings: { FS_PROVIDER: async request => {
      try {
        const input = await request.json()
        return Response.json(await (new URL(request.url).pathname === '/generation' ? generate(input) : provider(input)))
      }
      catch { return new Response(null, { status: 503 }) }
    } },
  }), enableDevRegistry: false, telemetry: { enabled: false } })
}

export function mountedEndpoint(runtime, principal) {
  return (path, { method, body, query = {} } = {}) => {
    const url = new URL(`/api/v1${path}`, 'http://localhost')
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item)
    }
    const headers = { 'x-api-key': principal.key }
    if (body && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(body)
    }
    return runtime.dispatchFetch(url, { method: method ?? (body ? 'POST' : 'GET'), headers, body })
  }
}
