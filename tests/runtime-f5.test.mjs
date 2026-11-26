// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { api, testPrincipal } from './support/local-worker.mjs'
import { runtimeWorker } from './support/runtime-f5-worker.mjs'

const post=body=>({method:'POST',body})
const uri=(route,name)=>`/api/v1/${route}?uri=${encodeURIComponent(name)}`
async function result(promise,status=200) {
  const response=await promise, body=await response.json()
  assert.equal(response.status,status,body.error?.code)
  return status<400?body.result:body.error
}

test('runtime opt-ins persist and have isolated HTTP effects in the real Workspace',async t=>{
  const a=testPrincipal('runtime-f5','alice','admin'),b=testPrincipal('runtime-f5','bob'),
    other=testPrincipal('rt-neighbor','alice','admin'),agent=testPrincipal('runtime-f5','alice','admin','other-agent')
  const persist=await mkdtemp(join(tmpdir(),'ov-runtime-proof-'))
  const start=()=>runtimeWorker({principals:[a,b,other,agent],persist,vars:{OPENVIKING_EDGE_GENERATION:'1',OPENVIKING_EDGE_SESSION_RUNTIME:'1',
    OPENVIKING_EDGE_PRIVACY_SCAN:'1',OPENVIKING_EDGE_MCP_LIVE:'1',OPENVIKING_EDGE_MCP:'read-write',OPENVIKING_EDGE_MEMORY_COMPILE:'1'}})
  let worker=await start()
  t.after(async()=>{await worker.dispose();await rm(persist,{recursive:true,force:true})})
  const as=(principal=a)=>(...params)=>api(worker,principal)(...params)
  const send=as(), bob=as(b)
  const mkdir=path=>result(send('/api/v1/fs/mkdir',post({uri:path})))
  const write=(path,content)=>result(send('/api/v1/content/write',post({uri:path,content,wait:true,processing_mode:'vectors_only'})))
  const read=(path,actor=send)=>result(actor(uri('content/read',path)))
  const session='/api/v1/sessions/turns'
  await result(send('/api/v1/sessions',post({session_id:'turns',memory_policy:{self:{enabled:false}}})))
  await result(send(session+'/messages/batch',post({messages:[{role:'user',content:'First synthetic turn with sizeable text.'},
    {role:'assistant',content:'First reply.'},{role:'user',content:'New'},{role:'assistant',content:'Yes'}]})))
  const commit={retention_mode:'turn_budget',keep_recent_turn_count:2,retained_message_token_budget:8}
  await result(send(session+'/commit?wait=true',post({...commit,retained_message_token_budget:1})),400)
  assert.equal((await result(send(session))).commit_count,0)
  assert.equal((await result(send(session+'/commit?wait=true',post(commit)))).archived,true)
  let detail=await result(send(session))
  assert.equal(detail.message_count,2);assert.equal(detail.retention_mode,'turn_budget')
  assert.equal(detail.retained_message_token_budget,8)
  await result(as(agent)(session),404)
  const partial='/api/v1/sessions/checkpoint'
  await result(send('/api/v1/sessions',post({session_id:'checkpoint',memory_policy:{self:{enabled:false}}})))
  await result(send(partial+'/messages/batch',post({messages:[{role:'user',content:'Ask'},
    {role:'assistant',content:'Earlier slow step with substantial synthetic details.'},{role:'assistant',content:'Done'}]})))
  await result(send(partial+'/commit?wait=true',post({enable_working_memory:true,reasoning_effort:'low'})),412)
  assert.equal((await result(send(partial))).commit_count,0)
  await result(send(partial+'/commit?wait=true',post({retention_mode:'turn_budget',keep_recent_turn_count:1,min_raw_tail_steps:1,
    session_window_context:20,retained_token_ratio:0.2})))
  assert.equal((await result(send(partial))).message_count,1)
  const checkpoint=async()=>{
    const resultBody=await result(send(partial+'/context'))
    assert.deepEqual(resultBody.messages.map(message=>message.parts[0].text),['Ask','Done'])
  }
  await checkpoint()

  const privateRoot='viking://~/resources/runtime', source='viking://resources/runtime-source.md', node=`${privateRoot}/live.md`
  const marker='synthetic-literal-2026'
  await mkdir(privateRoot)
  await write(source,'first revision')
  await write(`${privateRoot}/record.txt`,`${marker}\n${marker}`)
  await result(send('/api/v1/privacy-configs/credential/demo',post({values:{sample:marker}})))
  const scan=()=>send('/api/v1/privacy-configs/scan',post({uri:privateRoot}))
  const report=await result(scan())
  assert.equal(report.matched_files,1);assert.equal(report.matches[0].occurrences,2)
  assert.ok(!JSON.stringify(report).includes(marker))
  const repaired=await result(send('/api/v1/privacy-configs/scan',post({uri:privateRoot,fix:true})))
  assert.equal(repaired.repaired_files,1);assert.equal(repaired.reindex[0].status,'completed')
  assert.ok(!JSON.stringify(repaired).includes(marker))
  const persistedText=await read(`${privateRoot}/record.txt`)
  assert.match(persistedText,/\{\{ov_privacy:alice:/u);assert.ok(!persistedText.includes(marker))
  const stat=await result(send(uri('fs/stat',`${privateRoot}/record.txt`)))
  assert.equal(stat.isDir,false)
  await result(bob('/api/v1/privacy-configs/scan',post({uri:'viking://user/alice/resources/runtime'})),403)

  const mcp='/api/v1/mcps'
  await result(send(mcp,post({name:'local',url:'viking://builtin/openviking-data'})))
  const spec={tool_uri:'viking://~/tools/local/read.json',node_uri:node,title:'Local document',arguments:{uri:source},wait:true}
  await result(send(mcp+'/mount',post({...spec,node_uri:'viking://resources/refused.md'})),403)
  await result(send(mcp+'/mount',post(spec)))
  assert.equal(await read(node),'first revision')
  await write(source,'second revision')
  assert.equal(await read(node),'second revision')
  await result(as(other)(uri('content/read',node)),404)
  const bobRoot='viking://~/resources/runtime', bobNode=`${bobRoot}/live.md`
  await result(bob('/api/v1/fs/mkdir',post({uri:bobRoot})))
  await result(bob(mcp,post({name:'local',url:'viking://builtin/openviking-data'})))
  await result(bob(mcp+'/mount',post({...spec,node_uri:bobNode})))
  assert.equal(await read(bobNode,bob),'second revision')
  await result(send('/api/v1/acl',{method:'PUT',body:{uri:source,acl_mode:'restricted',entries:[]}}))
  await result(bob(uri('content/read',bobNode)),403)

  const target='viking://~/memories/preferences/runtime-proof'
  await mkdir('viking://~/memories/preferences')
  await mkdir(target)
  await write(`${target}/a.md`,'Synthetic duplicate');await write(`${target}/b.md`,'Synthetic duplicate')
  const task=await result(send('/api/v1/compile',post({skill:'memory',to:target,args:{skill_name:'runtime-reference'}})),202)
  let terminal
  for(let i=0;i<60;i++) {
    terminal=await result(send(`/api/v1/tasks/${task.task_id}`))
    if(['completed','failed'].includes(terminal.status)) break
    await sleep(100)
  }
  assert.equal(terminal.status,'completed',JSON.stringify(terminal))
  assert.equal(terminal.result.source_count,2)
  const output=terminal.result.output_uri
  assert.match(await read(output),/^A single synthetic observation survives consolidation\./u)
  assert.match(await read(`${terminal.result.skill_uri}/SKILL.md`),/Use concise reference notes\./u)
  assert.equal(await read(`${target}/a.md`),'Synthetic duplicate')

  await worker.dispose();worker=await start()
  assert.equal((await result(send(session))).retention_mode,'turn_budget')
  await checkpoint()
  await result(send(partial+'/commit?wait=true',post({reset_context:true})))
  assert.deepEqual((await result(send(partial+'/context'))).messages,[])
  assert.equal((await result(scan())).matched_files,0)
  assert.equal(await read(`${privateRoot}/record.txt`),persistedText)
  assert.match(await read(output),/^A single synthetic observation survives consolidation\./u)
  assert.equal(await read(node),'second revision')
  await result(bob(uri('content/read',bobNode)),403)
  assert.equal((await result(send(mcp+'/mounts?mcp=local'))).total,1)
  await result(send(mcp+'/mount?node_uri='+encodeURIComponent(node),{method:'DELETE'}))
  await result(send(uri('content/read',node)),404)
})
