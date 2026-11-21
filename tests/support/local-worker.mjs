// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function testPrincipal(accountId, userId, role = 'user', agentId = 'default') {
  return { key: randomBytes(32).toString('hex'), accountId, userId, agentId, role }
}

// No fixture implementation lives under src/ or in the Wrangler bundle.
// The real workerd service and DO run normally, replacing only the AI binding here.
function testingEntry(mode) {
  if (mode !== 'fixture' && mode !== 'broken') throw new TypeError('Unknown test embedding mode')
  return `import worker, { Workspace as ProductionWorkspace } from './src/worker.ts';
export { Control, OAuth } from './src/worker.ts';
const fakeAI = ${mode === 'fixture' ? `{
  async toMarkdown(input) {
    if (input.blob.type !== 'application/pdf' || !input.name.endsWith('.pdf')) return {format:'error',error:'Fixture accepts only PDF'};
    return {format:'markdown',data:'# Converted document\\n\\nFixture-only Markdown.',tokens:5};
  },
  async run(model, {text,messages,stream}) {
    if (model === '@cf/meta/llama-3.1-8b-instruct' && messages) {
      if (stream === true) {
        const encoder=new TextEncoder();let i=0;
        return new ReadableStream({async pull(c){
          if(i===0){c.enqueue(encoder.encode('data: {"response":"Synthetic "}\\n\\n'));i++;return}
          if(i===1){await new Promise(r=>setTimeout(r,25));c.enqueue(encoder.encode('data: {"response":"stream"}\\n\\n'));i++;return}
          c.enqueue(encoder.encode('data: [DONE]\\n\\n'));c.close();
        }});
      }
      const events = messages[0]?.content.includes('event_name');
      const levels = (messages[0]?.content ?? '').includes('openviking_edge_directory_summary_v1');
      const reply=events ? JSON.stringify({events:[]}) : levels
        ? JSON.stringify({overview:'# CLI Test\\n\\nThis import contains a test file for CLI automation.\\n\\n## Contents\\n\\nThe document is a text fixture.'})
        : 'Fictional local test summary.';
      return {response: reply, usage:{prompt_tokens:4,completion_tokens:5}};
    }
    if (model !== '@cf/baai/bge-base-en-v1.5') throw Error('unexpected fixture model');
    return {data: text.map(value => {
      const vector = Array(768).fill(0);
      vector[0] = 0.001;
      for (const term of value.toLowerCase().match(/[a-z]+/g) ?? []) {
        const normalized = /^boats?$|^ships?$|^sailing$/.test(term) ? 'maritime' : term;
        let code = 0;
        for (const char of normalized) code = (code * 31 + char.charCodeAt(0)) >>> 0;
        vector[1 + code % 767] += 1;
      }
      return vector;
    })};
  }
}` : `{async run() {return {data: [[1,2,3]]}}}`};
export default {fetch(request,env,execution){return worker.fetch(request,{...env,AI:fakeAI},execution)}};
export class Workspace extends ProductionWorkspace {
  constructor(ctx, env) { super(ctx, {...env, AI: fakeAI}); }
}
`
}

export async function localWorker({ principals, embeddings = 'missing', assetsDir, persist, port = 0, vars = {}, serviceBindings } = {}) {
  const worker = await build({
    absWorkingDir: project,
    ...(embeddings === 'missing' ? { entryPoints: ['src/worker.ts'] } : {
      stdin: { contents: testingEntry(embeddings), resolveDir: project, sourcefile: 'local-test-entry.mjs' },
    }),
    platform: 'browser', format: 'esm', bundle: true, write: false,
    external: ['cloudflare:workers'],
  })
  const options = convertV4MiniflareOptions({
    name: 'openviking-edge-local', host: '127.0.0.1', port, modules: true, script: worker.outputFiles[0].text,
    compatibilityDate: '2026-11-19',
    durableObjects: { WORKSPACES: { className: 'Workspace', useSQLite: true }, CONTROL: { className: 'Control', useSQLite: true }, OAUTH: { className: 'OAuth', useSQLite: true } },
    ...(serviceBindings && { serviceBindings }),
    bindings: { ...vars, ...(principals && { OPENVIKING_EDGE_KEYS: JSON.stringify(principals) }) },
    ...(assetsDir && { assets: {
      directory: assetsDir, binding: 'ASSETS', run_worker_first: true,
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' },
    } }),
    log: new Log(LogLevel.ERROR),
  })
  const runtime=new Miniflare(persist ? { ...options, resourcePersistencePath: persist } : options)
  runtime.localBuildSha256=createHash('sha256').update(worker.outputFiles[0].text).digest('hex')
  return runtime
}

export function api(runtime, principal) {
  return async function send(path, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = new Headers(headers)
    if (principal && !requestHeaders.has('x-api-key') && !requestHeaders.has('authorization')) {
      requestHeaders.set('x-api-key', principal.key)
    }
    if (body instanceof FormData) {
      // Serialize once with the same Request web standard used by browsers.
      // Node's FormData and Miniflare's HTTP client's FormData can come from different realms.
      const multipart = new Request('http://localhost', { method:'POST',body })
      if (!requestHeaders.has('content-type')) requestHeaders.set('content-type',multipart.headers.get('content-type'))
      body=new Uint8Array(await multipart.arrayBuffer())
    } else if (body !== undefined && typeof body !== 'string') {
      body = JSON.stringify(body)
      if (!requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/json')
    }
    return runtime.dispatchFetch(new URL(path, 'http://localhost'), {
      method, body, headers: requestHeaders, redirect: 'manual',
    })
  }
}
