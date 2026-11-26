// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

async function result(promise,status=200) {
  const response=await promise
  assert.equal(response.status,status)
  return (await response.json()).result
}

test('idle commit crosses its real 300s deadline after Workerd restart', {timeout:335_000,skip:process.env.OV_RUNTIME_LONG_IDLE!=='1'}, async t=>{
  const root=testPrincipal('rt-f5-root','root','root')
  const persist=await mkdtemp(join(tmpdir(),'ov-rt-idle-'))
  const start=()=>localWorker({principals:[root],persist,vars:{OPENVIKING_EDGE_SESSION_RUNTIME:'1'}})
  let worker=await start()
  t.after(async()=>{await worker.dispose();await rm(persist,{recursive:true,force:true})})
  const provision=async account=>({key:(await result(api(worker,root)('/api/v1/admin/accounts',{
    method:'POST',body:{account_id:account,admin_user_id:'alice'},
  }))).user_key})
  const live=await provision('rt-idle-live'),revoke=await provision('rt-idle-revoke')
  const path='/api/v1/sessions/proof', append=body=>({method:'POST',body})
  for (const owner of [live,revoke]) {
    const send=api(worker,owner)
    await result(send('/api/v1/sessions',append({session_id:'proof',memory_policy:{self:{enabled:false}},auto_commit_policy:
      {idle_timeout_seconds:300,message_count_threshold:0,pending_token_threshold:0,keep_recent_count:0}})))
    await result(send(path+'/messages',append({role:'user',content:'Synthetic recording'})))
  }
  const first=await result(api(worker,live)(path)), deadline=Date.parse(first.last_message_at)+300_000
  assert.equal(first.commit_count,0)
  assert.equal(first.last_idle_commit_accepted_at,'')
  await worker.dispose()
  worker=await start()
  const read=api(worker,live), rotated=await result(api(worker,revoke)('/api/v1/admin/accounts/rt-idle-revoke/users/alice/key',{method:'POST'}))
  assert.equal((await result(read(path))).commit_count,0)
  await sleep(Math.max(0,deadline-Date.now()))
  let observed
  for(let i=0;i<60;i++) {
    observed=await result(read(path))
    if(observed.commit_count) break
    await sleep(250)
  }
  assert.equal(observed.commit_count,1)
  assert.equal(observed.message_count,0)
  assert.ok(Date.parse(observed.last_commit_at)>=deadline)
  assert.ok(Date.parse(observed.last_idle_commit_accepted_at)>=deadline)
  assert.ok(Date.parse(observed.last_idle_commit_accepted_at)<=Date.parse(observed.last_commit_at))
  assert.equal((await result(api(worker,{key:rotated.user_key})(path))).commit_count,0)
  assert.equal((await result(read(path))).commit_count,1)
  await worker.dispose(); worker=await start()
  assert.equal((await result(api(worker,live)(path))).last_idle_commit_accepted_at,observed.last_idle_commit_accepted_at)
})
