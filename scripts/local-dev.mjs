// SPDX-License-Identifier: AGPL-3.0-only
// Explicitly no Workers AI or remote bindings. Use studio-smoke.mjs for fixture AI.
import { spawn } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const project=resolve(import.meta.dirname,'..')
const scratch=resolve(project,'.wrangler')
const config=JSON.parse(await readFile(resolve(project,'wrangler.jsonc'),'utf8'))
const port=process.argv[2]??'8787'
if(!/^\d{4,5}$/u.test(port)||Number(port)>65535||Number(port)<1024)throw Error('Invalid local port.')
delete config.ai
delete config.$schema
config.main=resolve(project,config.main)
if(config.assets)config.assets.directory=resolve(project,config.assets.directory)
await mkdir(scratch,{recursive:true,mode:0o700})
const path=resolve(scratch,'offline-wrangler.json')
await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600})

const args=[resolve(project,'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--ip','127.0.0.1','--port',port,'--config',path,
  '--persist-to',resolve(scratch,'offline-state')]
const devVars=resolve(project,'.dev.vars')
try{await access(devVars);args.push('--env-file',devVars)}catch{/* Without a key the Worker stays closed. */}
const env={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:scratch,CI:'1',WRANGLER_SEND_METRICS:'false',BROWSER:'none'}
const proc=spawn(process.execPath,args,{cwd:project,env,stdio:'inherit'})
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>proc.kill(signal))
await new Promise((done,fail)=>{proc.once('error',fail);proc.once('close',code=>{process.exitCode=code??1;done()})})
