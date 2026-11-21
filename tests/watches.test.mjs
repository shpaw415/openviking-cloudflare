// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const approved='https://documents.example.test/season-notes.md'
const actor=testPrincipal('gardens','lily','admin')
const member=testPrincipal('gardens','planter')
const peer=testPrincipal('other','lily','admin')
const target='viking://resources/season-notes.md'
const base='/api/v1/'
let runtime, requests=0, outbound, badMime=false, releaseProvider
const call=(name,options,principal=actor)=>api(runtime,principal)(base+name,options)
const send=(method,name,body,principal)=>call(name,{method,body},principal)
const response=async(r,status=200)=>{const p=await r.json();assert.equal(r.status,status,p.error?.code);return p.result}

before(async()=>{
  runtime=await localWorker({principals:[actor,member,peer],embeddings:'fixture',vars:{OPENVIKING_EDGE_TEXT_SOURCES:JSON.stringify([approved])},serviceBindings:{
    TEXT_SOURCE:async req=>{
      requests++
      outbound={url:req.url,method:req.method,secret:req.headers.has('authorization')||req.headers.has('x-api-key')||req.headers.has('cookie')}
      if(releaseProvider===false)await new Promise(resolve=>{releaseProvider=resolve})
      return new Response('# Season notes\nFictional bulb planting schedule.',{headers:{'content-type':badMime?'text/html':'text/markdown'}})
    },
  }})
  await runtime.ready
})
after(async()=>await runtime?.dispose())

test('a registered watch is durable, scoped, and the trigger performs a real indexed import',async()=>{
  const begin=requests
  const make=await response(await send('POST','watches',{path:approved,to_uri:target,watch_interval:1,reason:'Seasonal notes'}))
  assert.equal(requests,begin)
  assert.equal(make.watch_interval,1)
  assert.equal(make.is_active,true)
  assert.equal((await call(`watches/${make.task_id}`,undefined,peer)).status,404)
  assert.equal((await response(await call(`watches?to_uri=${encodeURIComponent(target)}`))).task_id,make.task_id)
  assert.equal((await response(await send('POST',`watches/${make.task_id}/trigger`,{}))).scheduled,true)
  await response(await send('POST','system/wait',{timeout:8}))
  const latest=await response(await call(`watches/${make.task_id}`))
  assert.equal(latest.last_status,'completed',latest.last_error)
  assert.deepEqual(outbound,{url:approved,method:'GET',secret:false})
  assert.match(await response(await call(`content/read?uri=${encodeURIComponent(target)}`)),/Fictional bulb planting/)
  const hits=await response(await send('POST','search/find',{target_uri:'viking://resources',query:'Fictional bulb planting',limit:2}))
  assert.ok(hits.resources.some(hit=>hit.uri===target))
  const paused=await response(await send('PATCH',`watches/${make.task_id}`,{is_active:false}))
  assert.equal(paused.is_active,false)
  assert.equal(paused.watch_interval,1)
  assert.equal(paused.next_execution_time,null)
  assert.equal((await response(await call('watches?active_only=true'))).total,0)
  assert.equal((await response(await send('DELETE',`watches/${make.task_id}`))).deleted,true)
  assert.equal((await call(`watches/${make.task_id}`)).status,404)
})

test('unregistered, non-text, and unauthorized destinations never publish files',async()=>{
  const before=requests
  assert.equal((await send('POST','watches',{path:'https://documents.example.test/other.md',to_uri:target,watch_interval:1})).status,503)
  assert.equal(requests,before)
  const badTarget='viking://resources/rejected.md'
  badMime=true
  const wrap=await response(await send('POST','watches',{path:approved,to_uri:badTarget,watch_interval:1}))
  await response(await send('POST',`watches/${wrap.task_id}/trigger`,{}))
  await response(await send('POST','system/wait',{timeout:8}))
  assert.equal((await response(await call(`watches/${wrap.task_id}`))).last_status,'failed')
  assert.equal((await call(`fs/stat?uri=${encodeURIComponent(badTarget)}`)).status,404)
  await response(await send('DELETE',`watches/${wrap.task_id}`))
  badMime=false
})

test('deleting a watch during source I/O fences its eventual publication',async()=>{
  const delayed='viking://resources/stale.md'
  const wrap=await response(await send('POST','watches',{path:approved,to_uri:delayed,watch_interval:1}))
  releaseProvider=false
  await response(await send('POST',`watches/${wrap.task_id}/trigger`,{}))
  const stop=Date.now()+3500
  try {
    while(typeof releaseProvider!=='function'&&Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,25))
    assert.equal(typeof releaseProvider,'function')
    await response(await send('DELETE',`watches/${wrap.task_id}`))
  } finally { if(typeof releaseProvider==='function')releaseProvider() }
  await response(await send('POST','system/wait',{timeout:7}))
  assert.equal((await call(`fs/stat?uri=${encodeURIComponent(delayed)}`)).status,404)
})

test('a watch cannot publish after its group write grant is revoked during source IO',async()=>{
  const parent='viking://resources/greenhouse'
  const saved=parent+'/fresh.md'
  const group='admin/accounts/gardens/groups'
  const members=group+'/gardeners/members'
  await response(await send('POST',group,{group_id:'gardeners'}))
  await response(await send('PUT',members,{user_ids:[member.userId]}))
  await response(await send('POST','fs/mkdir',{uri:parent}))
  await response(await send('PUT','acl',{uri:parent,acl_mode:'restricted',entries:[{principal:'group:gardeners',level:'write'}]}))
  const wrap=await response(await send('POST','watches',{path:approved,to_uri:saved,watch_interval:1},member))
  releaseProvider=false
  await response(await send('POST',`watches/${wrap.task_id}/trigger`,{},member))
  try {
    const stop=Date.now()+3500
    while(typeof releaseProvider!=='function'&&Date.now()<stop)await new Promise(resolve=>setTimeout(resolve,25))
    assert.equal(typeof releaseProvider,'function')
    await response(await send('DELETE',members,{user_ids:[member.userId]}))
  } finally { if(typeof releaseProvider==='function')releaseProvider() }
  await response(await send('POST','system/wait',{timeout:7},member))
  assert.equal((await call(`fs/stat?uri=${encodeURIComponent(saved)}`)).status,404,'No write remains after group removal.')
})
