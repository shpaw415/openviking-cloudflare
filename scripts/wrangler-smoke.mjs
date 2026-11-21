// SPDX-License-Identifier: AGPL-3.0-only
// Exercise the shipped Worker/DO/assets through Wrangler, using the explicit no-AI local profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const project=resolve(import.meta.dirname,'..')
const port=Number(process.argv[2])
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Pass a dedicated port for the local Wrangler smoke.')
const checked=await new Promise((done,fail)=>{
  const s=createServer();s.once('error',fail);s.listen(port,'127.0.0.1',()=>s.close(e=>e?fail(e):done(true)))
})
assert.ok(checked)
const work=resolve(project,'.work')
await mkdir(work,{recursive:true,mode:0o700})
const temp=await mkdtemp(resolve(work,'wrangler-smoke-'))
const key=randomBytes(32).toString('hex')
const origin=`http://127.0.0.1:${port}`
let child, closed
let diagnostic=''
try {
  await cp(resolve(project,'src'),resolve(temp,'src'),{recursive:true})
  const config=JSON.parse(await readFile(resolve(project,'wrangler.jsonc'),'utf8'))
  // Wrangler rejects startup with an AI binding in local-only mode. The test profile
  // omits only that declaration; never switch the real binding to remote for this check.
  delete config.ai
  await writeFile(resolve(temp,'wrangler.jsonc'),JSON.stringify(config),{mode:0o600})
  await symlink(resolve(project,'dist'),resolve(temp,'dist'),'dir')
  await symlink(resolve(project,'node_modules'),resolve(temp,'node_modules'),'dir')
  await writeFile(resolve(temp,'.dev.vars'),`OPENVIKING_EDGE_KEYS='${JSON.stringify([{key,role:'admin',accountId:'wrangler_smoke',userId:'fixture',agentId:'local'}])}'\n`,{mode:0o600,flag:'wx'})
  child=spawn(process.execPath,[resolve(project,'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--ip','127.0.0.1','--port',String(port),'--log-level','error'],{
    cwd:temp,env:{PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:temp,CI:'1',WRANGLER_SEND_METRICS:'false',BROWSER:'none'},stdio:['ignore','pipe','pipe']
  })
  closed=new Promise(done=>child.once('close',done))
  const collect=d=>{diagnostic=(diagnostic+String(d)).slice(-3000)}
  child.stdout.on('data',collect);child.stderr.on('data',collect)
  const deadline=Date.now()+20_000
  let health
  while(Date.now()<deadline&&child.exitCode===null) {
    try {health=await fetch(origin+'/health',{signal:AbortSignal.timeout(600)});if(health.status===200)break} catch {/* not yet listening */}
    await new Promise(done=>setTimeout(done,200))
  }
  assert.equal(health?.status,200,'Wrangler local did not start.')
  assert.equal((await health.json()).auth_mode,'api_key')
  const check=await fetch(origin+'/api/v1/system/status',{headers:{'X-API-Key':key}})
  assert.equal(check.status,200)
  assert.equal((await check.json()).result.user,'fixture')
  assert.equal((await fetch(origin+'/api/v1/fs/ls?uri=viking%3A%2F%2F')).status,401)
  const abilities=await fetch(origin+'/api/v1/system/edge-capabilities',{headers:{'X-API-Key':key}})
  assert.equal(abilities.status,200)
  assert.equal((await abilities.json()).result.embedding.binding_present,false)
  const html=await fetch(origin+'/studio/index.html')
  assert.equal(html.status,200)
  const hash=x=>createHash('sha256').update(x).digest('hex')
  const expected=hash(await readFile(resolve(project,'dist/studio/index.html')))
  assert.equal(hash(Buffer.from(await html.arrayBuffer())),expected)
  assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/)
  console.log(JSON.stringify({runtime:'Wrangler dev --local (no-AI profile)',authenticated_disk_sqlite:true,anonymous_rejected:true,html_sha256:expected,remote_provider_probed:false}))
} catch(error) {
  if(diagnostic)console.error(diagnostic.split(key).join('[redacted]'))
  throw error
} finally {
  if(child&&child.exitCode===null) {
    child.kill('SIGTERM')
    const stop=setTimeout(()=>child.kill('SIGKILL'),3500)
    try { await closed } finally { clearTimeout(stop) }
  }
  await rm(temp,{recursive:true,force:true})
}
