// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const root = testPrincipal('root', 'root', 'root')
const owner = testPrincipal('orbital', 'owner', 'admin')
const observer = testPrincipal('orbital', 'reader')
const other = testPrincipal('separate', 'owner', 'admin')
let runtime
const req = (principal, path, options) => api(runtime, principal)('/api/v1' + path, options)
const create = (principal, path, body) => req(principal, path, { method:'POST', body })
async function payload(response, expected = 200) {
  const value = await response.json()
  assert.equal(response.status, expected, value.error?.code)
  return value.result
}

before(async () => {
  runtime = await localWorker({ principals:[root,owner,observer,other], embeddings:'fixture', vars:{OPENVIKING_EDGE_GENERATION:'1'} })
  await runtime.ready
})
after(async () => { await runtime?.dispose() })

test('root capabilities do not grant tenant data access', async () => {
  const flags = await payload(await req(root,'/system/edge-capabilities'))
  assert.equal(flags.features.control,true)
  assert.equal(flags.features.tasks,false)
  assert.equal(flags.features.monitoring,false)
  assert.equal((await req(root,'/fs/ls?uri=viking://')).status,403)
  assert.equal((await req(root,'/system/status')).status,200)
  assert.equal((await req(root,'/admin/accounts')).status,200)
  assert.equal((await req(observer,'/admin/accounts')).status,403)
  const dataFlags=await payload(await req(observer,'/system/edge-capabilities'))
  assert.equal(dataFlags.features.bot,true)
  assert.equal(dataFlags.features.compile,true)
  assert.equal(dataFlags.generation.probed,false)
})

test('a durable alarm archives a real session and never exposes its data across scopes', async () => {
  const id = 'scheduled-proof'
  const base = `/sessions/${id}`
  await payload(await create(owner,'/sessions',{session_id:id,memory_policy:{memory_types:[]}}))
  await payload(await create(owner,base+'/messages',{role:'user',content:'Synthetic archive text'}))
  const accepted = await payload(await create(owner,base+'/commit',{wait:false,enable_working_memory:false}))
  assert.match(accepted.task_id,/^[a-f0-9-]{36}$/)
  assert.equal((await req(observer,'/tasks/'+accepted.task_id)).status,404)
  assert.equal((await req(other,'/tasks/'+accepted.task_id)).status,404)
  await payload(await create(owner,'/system/wait',{timeout:8}))
  const done = await payload(await req(owner,`/tasks/${accepted.task_id}?include_events=true`))
  assert.equal(done.status,'completed',done.error)
  assert.match(JSON.stringify(done.result), /archive_001/)
  assert.deepEqual(done.execution_events.map(x=>x.status),['pending','running','completed'])
  const row = await payload(await req(owner,base))
  assert.equal(row.message_count,0)
  const overdue = await create(owner,`/tasks/${accepted.task_id}/cancel`,{})
  assert.equal(overdue.status,409)
  const tasks = await payload(await req(owner,'/tasks?pagination=cursor&task_type=session_commit&limit=1'))
  assert.deepEqual(tasks.items.map(t=>t.task_id),[accepted.task_id])
})

test('dashboard and observer use measured local requests, with no body or query in audit', async () => {
  const text = 'Synthetic orbit chart'
  await payload(await create(owner,'/content/write',{uri:'viking://resources/example.md',content:text,wait:true}))
  await payload(await create(owner,'/search/find',{query:'synthetic orbit chart',target_uri:'viking://resources',limit:2}))
  const dash = await payload(await req(owner,'/console/dashboard/summary?timezone=UTC'))
  assert.ok(dash.today_retrievals.find >=1)
  const logs = await payload(await req(owner,'/console/audit?api_type=find&status=200'))
  assert.equal(logs.total,1)
  assert.equal(logs.items[0].route,'/api/v1/search/find')
  assert.doesNotMatch(JSON.stringify(logs),/synthetic orbit|example\.md/i)
  assert.equal((await payload(await req(observer,'/console/audit?api_type=find'))).total,0)
  assert.equal((await payload(await req(other,'/console/dashboard/summary'))).today_retrievals.find,0)
  const monitor = await payload(await req(owner,'/observer/system?format=json'))
  assert.equal(monitor.is_healthy,true)
  assert.deepEqual(monitor.errors,[])
  assert.equal(monitor.components.models.is_healthy,null)
  assert.equal(monitor.components.models.status.probed,false)
  assert.ok(monitor.components.retrieval.status.find.n >=1)
  assert.equal((await payload(await req(observer,'/observer/retrieval?format=json'))).status.find.n,0)
  assert.equal((await payload(await req(other,'/observer/retrieval?format=json'))).status.find.n,0)
})

test('the original Monitoring read contract is available to workspace keys, not root or anonymous callers', async () => {
  const path='/observer/system'
  assert.equal((await req(undefined,path)).status,401)
  assert.equal((await req(root,path)).status,403)
  for (const principal of [owner,observer]) {
    assert.equal((await payload(await req(principal,'/system/edge-capabilities'))).features.monitoring,true)
    const health=await api(runtime,principal)('/health')
    assert.equal(health.status,200)
    assert.equal((await health.json()).healthy,true)
    const response=await req(principal,path)
    assert.match(response.headers.get('cache-control') ?? '',/private, no-store/)
    const overview=await payload(response)
    assert.deepEqual(Object.keys(overview.components).sort(),['filesystem','lock','models','queue','retrieval','vikingdb'])
    assert.ok(Object.values(overview.components).every(component => typeof component.status === 'string'))
    assert.equal(overview.components.models.is_healthy,null)
    assert.equal(overview.components.models.status,'No model usage data available.')
    const models=await payload(await req(principal,'/observer/models?format=json'))
    assert.deepEqual(models.status,{
      embedding_binding:true,generation_binding:true,probed:false,
    })
    assert.match(overview.components.queue.status,/\| Queue\s+\| In Progress\s+\| Pending\s+\| Processed\s+\| Errors\s+\| Total\s+\|/)
    assert.match(overview.components.vikingdb.status,/\| Durable Object SQLite\s+\| OK\s+\|/)
    assert.equal((await req(principal,path+'?format=invalid')).status,400)
    const head=await req(principal,path,{method:'HEAD'})
    assert.equal(head.status,200)
    assert.equal(await head.text(),'')
  }
})

test('a real failed indexing task degrades the scoped Monitoring overview without probing a model', async t => {
  const editor=testPrincipal('monitoring-failure','editor','admin')
  const member=testPrincipal('monitoring-failure','member')
  const outsider=testPrincipal('monitoring-other','editor','admin')
  const isolated=await localWorker({principals:[editor,member,outsider],embeddings:'broken'})
  t.after(() => isolated.dispose())
  const read = principal => api(isolated,principal)('/api/v1/observer/system?format=json')
  assert.equal((await payload(await read(editor))).is_healthy,true)
  const write=api(isolated,editor)
  const rootUri='viking://~/resources/monitoring'
  await payload(await write('/api/v1/fs/mkdir',{method:'POST',body:{uri:rootUri}}))
  const job=await payload(await write('/api/v1/content/batch-write',{method:'POST',body:{
    root_uri:rootUri,wait:false,operations:[{uri:`${rootUri}/example.md`,content:'Synthetic index failure'}],
  }}))
  await payload(await write('/api/v1/system/wait',{method:'POST',body:{timeout:5}}))
  assert.equal((await payload(await write('/api/v1/tasks/'+job.task_id))).status,'failed')
  const status=await payload(await read(editor))
  assert.equal(status.is_healthy,false)
  assert.deepEqual(status.errors,['queue'])
  assert.equal(status.components.queue.status.failed,1)
  assert.equal(status.components.models.status.probed,false)
  const queue=await payload(await write('/api/v1/observer/queue?format=table'))
  assert.match(queue.status,/\| TOTAL\s+\| 0\s+\| 0\s+\| 0\s+\| 1\s+\| 1\s+\|/)
  for (const principal of [member,outsider]) {
    const scoped=await payload(await read(principal))
    assert.equal(scoped.components.queue.status.failed,0)
    assert.equal(scoped.is_healthy,true)
    assert.deepEqual(scoped.errors,[])
  }
})

test('zone validation and actual commit series are not replaced by fabricated zeros', async () => {
  const today = new Date().toISOString().slice(0,10)
  const params = new URLSearchParams({start_date:today,end_date:today,bucket:'4h',timezone:'UTC'})
  await payload(await create(owner,'/sessions/audit-series/messages',{role:'user',content:'Private test entry'}))
  const series = await payload(await req(owner,'/console/context-commits?'+params))
  assert.ok(series.items.some(x => x.session_add_message > 0))
  assert.equal((await req(owner,'/console/dashboard/summary?timezone=bogus/place')).status,400)
})

test('storage diagnostics measure only indexed resources the caller can see', async()=>{
  const uri='viking://resources/closed'
  await payload(await create(owner,'/fs/mkdir',{uri}))
  await payload(await create(owner,'/content/write',{uri:uri+'/evidence.md',content:'Inert file',wait:true}))
  assert.equal((await req(owner,'/acl',{method:'PUT',body:{uri,acl_mode:'restricted',entries:[]}})).status,200)
  const stats=await payload(await create(owner,'/system/consistency',{uri}))
  assert.equal(stats.ok,true)
  assert.equal(stats.expected_count,1)
  assert.equal(stats.missing_record_count,0)
  const vectors=await payload(await req(owner,'/debug/vector/scroll?uri='+encodeURIComponent(uri)))
  assert.match(vectors.records[0].uri,/evidence\.md$/)
  assert.equal(vectors.records[0].dimensions,768)
  assert.equal((await req(observer,'/debug/vector/count?uri='+encodeURIComponent(uri))).status,403)
  const metrics=await api(runtime,owner)('/metrics')
  assert.equal(metrics.status,200)
  assert.match(await metrics.text(),/^openviking_edge_retained_requests/m)
  assert.equal((await api(runtime,observer)('/metrics')).status,403)
})
