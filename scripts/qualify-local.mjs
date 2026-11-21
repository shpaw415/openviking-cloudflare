// SPDX-License-Identifier: AGPL-3.0-only
// Run the whole local qualification under a frozen copy, never a writer's live tree.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root=resolve(import.meta.dirname,'..')
const pin='000f0765d7ec183886fbabbc22e69bc289cc429d'
const fromRoot=()=>execFileSync('/usr/bin/python3',[resolve(root,'scripts/receipt.py')],{cwd:root,encoding:'utf8',maxBuffer:1024*1024})
const git=(...args)=>execFileSync('/usr/bin/git',['-C',resolve(root,'upstream'),...args],{encoding:'utf8'}).trim()
assert.equal(git('rev-parse','HEAD'),pin)
assert.equal(git('status','--porcelain=v1'),'','Upstream checkout must not change during qualification.')
const captured=fromRoot(), input=JSON.parse(captured)
const work=resolve(root,'.work')
await mkdir(work,{recursive:true,mode:0o700})
const copy=await mkdtemp(resolve(work,'frozen-local-'))
const hash=buffer=>createHash('sha256').update(buffer).digest('hex')
const staging=async(rel,expected)=>{
  const source=resolve(root,rel), target=resolve(copy,rel)
  assert.ok((await realpath(source)).startsWith(root+'/'))
  assert.ok(target.startsWith(copy+'/'))
  await mkdir(dirname(target),{recursive:true,mode:0o700})
  await copyFile(source,target)
  assert.equal(hash(await readFile(target)),expected,`Input changed while staging: ${rel}`)
}
for(const [path,sha] of Object.entries(input.source_and_test_hashes))await staging(path,sha)
await staging('dist/studio/index.html',input.studio_entry_sha256)
await writeFile(resolve(copy,'receipt.json'),captured,{mode:0o600})
await symlink(resolve(root,'node_modules'),resolve(copy,'node_modules'),'dir')
await symlink(resolve(root,'upstream'),resolve(copy,'upstream'),'dir')
await mkdir(resolve(copy,'home'),{mode:0o700})
const scope={PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin',HOME:resolve(copy,'home'),CI:'1',WRANGLER_SEND_METRICS:'false'}
const run=(args)=>new Promise((done,fail)=>{
  const child=spawn(process.execPath,args,{cwd:copy,env:scope,stdio:'inherit'})
  child.once('error',fail);child.once('close',status=>status===0?done():fail(Error(`Qualification exited ${status}`)))
})
console.log(`Frozen candidate ${input.source_set_sha256} (${input.file_count} inputs) in ${copy}`)
await run([resolve(copy,'node_modules/typescript/bin/tsc'),'--noEmit'])
await run(['--test','--test-concurrency=1',...Object.keys(input.source_and_test_hashes).filter(p=>/^tests\/[^/]+\.test\.mjs$/.test(p))])
assert.equal(await readFile(resolve(copy,'receipt.json'),'utf8'),captured)
for(const [file,expected] of Object.entries(input.source_and_test_hashes))assert.equal(hash(await readFile(resolve(copy,file))),expected,file)
assert.equal(git('rev-parse','HEAD'),pin)
assert.equal(git('status','--porcelain=v1'),'')
console.log(JSON.stringify({validated_source_sha256:input.source_set_sha256,candidate:copy,live_tree_matches:fromRoot()===captured,remote_tested:false}))
