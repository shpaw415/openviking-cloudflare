// SPDX-License-Identifier: AGPL-3.0-only
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'
import { fileURLToPath } from 'node:url'

export async function runtimeWorker({principals,persist,vars}) {
  const root=fileURLToPath(new URL('../../',import.meta.url))
  const { outputFiles }=await build({stdin:{resolveDir:root,contents:`
import worker, { Workspace as WS,Control as CT } from './src/worker.ts';
const AI={async run(model,options) {
  if (model==='@cf/baai/bge-base-en-v1.5') return {data:options.text.map(text=>{
    const v=Array(768).fill(0);v[0]=0.1;
    for(const word of text.toLowerCase().match(/[a-z]+/g)??[]) {
      let h=0;for(const c of word)h=(31*h+c.charCodeAt(0))>>>0;
      v[1+h%767]++;
    } return v;
  })};
  if (model!=='@cf/meta/llama-3.1-8b-instruct') throw Error('Unexpected model');
  const data=JSON.parse(options.messages[1].content);
  let response;
  if (data.kind==='memory-consolidation') response={summary:'A single synthetic observation survives consolidation.',evidence:[{source:0,quote:'Synthetic duplicate'}],
    ...(data.create_skill&&{skill:{description:'A private reference',body:'Use concise reference notes.'}})};
  else if (data.kind==='artifact-compile') response={artifacts:[{path:'index.md',content:'Valid synthetic scheduled output.',
    citations:[{uri:data.documents[0].uri,quote:'Synthetic calendar source'}]}]};
  else throw Error('Unexpected fixture request');
  return {response:JSON.stringify(response),usage:{prompt_tokens:4,completion_tokens:5}};
}};
export class Workspace extends WS {constructor(ctx,env){super(ctx,{...env,AI});}}
export class Control extends CT {constructor(ctx,env){super(ctx,{...env,AI});}}
export default {fetch(req,env,execution){return worker.fetch(req,{...env,AI},execution);}};
`},bundle:true,platform:'browser',format:'esm',write:false,external:['cloudflare:workers']})
  const options=convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,log:new Log(LogLevel.ERROR),workers:[{
    name:'openviking-edge-local', modules:true, script:outputFiles[0].text, compatibilityDate:'2026-11-19',
    durableObjects:{WORKSPACES:{className:'Workspace',useSQLite:true},CONTROL:{className:'Control',useSQLite:true}},
    bindings:{...vars,OPENVIKING_EDGE_KEYS:JSON.stringify(principals)},
  }]})
  return new Miniflare({...options,resourcePersistencePath:persist})
}
