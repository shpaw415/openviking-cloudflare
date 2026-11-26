// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { api, localWorker, testPrincipal } from './support/local-worker.mjs'

const owner = testPrincipal('mcp-completion', 'alice', 'admin')
const neighbor = testPrincipal('mcp-completion', 'bob')
const sha = text => createHash('sha256').update(text).digest('hex')
async function call(send,name,args) {
  const r = await send('/mcp',{method:'POST',headers:{Accept:'application/json, text/event-stream'},body:{
    jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args},
  }})
  assert.equal(r.status,200)
  const body = await r.json()
  assert.ok(body.result,JSON.stringify(body.error))
  return body.result
}
async function result(response) {
  const r=await response
  assert.equal(r.status,200)
  return (await r.json()).result
}

test('operator-mounted MCP context uses the same owned session ledger, keywords and Data ACL',async t=>{
  const worker=await localWorker({principals:[owner,neighbor],embeddings:'fixture',vars:{OPENVIKING_EDGE_MCP:'read-write',OPENVIKING_EDGE_MCP_LIVE:'1'}})
  t.after(()=>worker.dispose())
  const send=api(worker,owner), other=api(worker,neighbor)
  const uri='viking://~/resources/harbor.md'
  await result(send('/api/v1/content/write',{method:'POST',body:{uri,content:'Harbor lantern reference for sailors',mode:'create',wait:true}}))
  const session=await result(send('/api/v1/sessions',{method:'POST',body:{session_id:'mcp-context-ledger'}}))
  const sid=session.session_id ?? session.id
  assert.equal(sid,'mcp-context-ledger')
  const request={query:'harbor lantern',mode:'context',search_type:'keywords',session_id:sid,
    detail:'full',max_tokens:500,quotas:{resources:1},dedup_turns:1}
  const first=await call(send,'search',request)
  assert.notEqual(first.isError,true,JSON.stringify(first))
  assert.equal(first.structuredContent.entries[0].uri,'viking://user/alice/resources/harbor.md')
  assert.match(first.structuredContent.rendered,/Harbor lantern reference/u)
  const second=await call(send,'search',request)
  assert.notEqual(second.isError,true)
  assert.deepEqual(second.structuredContent.entries,[])
  const forbidden=await call(other,'search',request)
  assert.equal(forbidden.isError,true)
  assert.equal(forbidden.structuredContent.error.code,'NOT_FOUND')
  const list=await call(send,'search',{query:'harbor',search_type:'keywords',target_uri:'viking://~/resources'})
  assert.notEqual(list.isError,true)
  assert.match(list.content[0].text,/harbor\.md/u)
})

test('MCP resource import reaches the approved source and indexes real content without broadening MCP mutation policy',async t=>{
  const url='https://approved-mcp.example.test/harbor.html', html='<main><h1>Harbor guide</h1><p>Lanterns guide sailors.</p></main>'
  const robots='User-agent: *\nAllow: /\n'
  let calls=0
  const worker=await localWorker({principals:[owner,neighbor],embeddings:'fixture',vars:{OPENVIKING_EDGE_MCP:'read-write',OPENVIKING_EDGE_MCP_LIVE:'1',
    OPENVIKING_EDGE_WEB_CATALOG:JSON.stringify({version:1,git:[],sites:[{account:owner.accountId,entry:url,name:'harbor',explore:false,
      robots:{id:'policy',sha256:sha(robots)},pages:[{url,id:'page',sha256:sha(html),name:'harbor.txt'}]}]}),
  },serviceBindings:{WEB_SOURCE(req){
    calls++
    assert.ok(!req.headers.has('authorization')&&!req.headers.has('x-api-key'))
    const policy=new URL(req.url).pathname==='/v1/robots/policy'
    assert.equal(new URL(req.url).pathname,policy?'/v1/robots/policy':'/v1/html/page')
    return new Response(policy?robots:html,{headers:{'content-type':'application/octet-stream',
      'x-ov-web-source-url':policy?'https://approved-mcp.example.test/robots.txt':url,
      'x-ov-web-source-type':policy?'text/plain':'text/html'}})
  }}})
  t.after(()=>worker.dispose())
  const send=api(worker,owner)
  const added=await call(send,'add_resource',{path:url,args:{web_mode:'html'}})
  assert.notEqual(added.isError,true,JSON.stringify(added))
  assert.equal(calls,2)
  assert.equal(await result(send('/api/v1/content/read?uri='+encodeURIComponent('viking://~/resources/harbor.txt'))),'Harbor guide\nLanterns guide sailors.')
  const before=calls
  const bad=await call(send,'add_resource',{path:'https://unapproved.example.test/no.html',args:{web_mode:'html'}})
  assert.equal(bad.isError,true)
  assert.equal(calls,before)
})
