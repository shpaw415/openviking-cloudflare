// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { api,testPrincipal } from './support/local-worker.mjs'
import { runtimeWorker } from './support/runtime-f5-worker.mjs'

test('cron and RRULE with distinct IANA zones reach one real DO alarm slot after restart',{timeout:155_000},async t=>{
  const root=testPrincipal('calendar-root','root','root'),persist=await mkdtemp(join(tmpdir(),'rt-calendar-'))
  const start=()=>runtimeWorker({principals:[root],persist,vars:{OPENVIKING_EDGE_GENERATION:'1',OPENVIKING_EDGE_COMPILE_SCHEDULES:'1'}})
  let runtime=await start()
  t.after(async()=>{await runtime.dispose();await rm(persist,{recursive:true,force:true})})
  const body=async (promise,status=200)=>{const r=await promise;const j=await r.json();assert.equal(r.status,status,j.error?.code);return j.result}
  const post=body=>({method:'POST',body})
  const {user_key:key}=await body(api(runtime,root)('/api/v1/admin/accounts',post({account_id:'runtime-calendar',admin_user_id:'alice'})))
  const send=(...args)=>api(runtime,{key})(...args), from='viking://~/resources/calendar-source'
  await body(send('/api/v1/fs/mkdir',post({uri:from})))
  await body(send('/api/v1/content/write',post({uri:`${from}/source.md`,content:'Synthetic calendar source',wait:true,processing_mode:'vectors_only'})))
  const mark=new Date((Math.floor(Date.now()/60000)+2)*60000)
  const civil=zone=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'numeric',minute:'numeric',weekday:'short',hourCycle:'h23'})
    .formatToParts(mark).map(x=>[x.type,x.value]))
  const a=civil('Asia/Kolkata'), b=civil('America/Toronto')
  const plans=[['bounded-cron',{timezone:'Asia/Kolkata',cron:`${a.minute} ${a.hour} * * *`}],['bounded-rrule',
    {timezone:'America/Toronto',rrule:`FREQ=WEEKLY;BYDAY=${b.weekday.slice(0,2).toUpperCase()};BYHOUR=${b.hour};BYMINUTE=${b.minute}`}]]
  const request=(name,update_schedule)=>({compile_name:name,from:[from],to:`viking://~/resources/${name}`,skill:'viking://system/compile/example-skills/knowledge-distillation',
    args:{update_schedule}})
  await body(send('/api/v1/compile/create',post(request('bad-calendar',{cron:'* * * * *',timezone:'UTC'}))),400)
  for(const [name,schedule] of plans) {
    await body(send('/api/v1/compile/create',post(request(name,schedule))))
    const config=await body(send(`/api/v1/compile/config?compile_name=${name}`))
    assert.equal(config.next_triggered_slot,mark.toISOString());assert.equal(config.update_schedule.timezone,schedule.timezone)
  }
  await runtime.dispose();runtime=await start()
  await sleep(Math.max(0,+mark-Date.now()))
  for(const [name] of plans) {
    const uri=encodeURIComponent(`viking://~/resources/${name}/index.md`)
    let result
    for(let i=0;i<70;i++) {
      const response=await send(`/api/v1/content/read?uri=${uri}`)
      if(response.ok){result=(await response.json()).result;break}
      assert.equal(response.status,404); await sleep(200)
    }
    assert.match(result,/^Valid synthetic scheduled output\./u)
    const config=await body(send(`/api/v1/compile/config?compile_name=${name}`))
    assert.equal(config.last_triggered_slot,mark.toISOString())
    assert.ok(Date.parse(config.next_triggered_slot)>+mark)
    const runs=await body(send(`/api/v1/compile/runs?compile_name=${name}`))
    assert.equal(runs.runs.length,1)
  }
})
