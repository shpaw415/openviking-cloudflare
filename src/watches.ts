// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, Env, WorkspaceContext } from './context.js'
import { Filesystem } from './filesystem.js'
import { ApiError, ok, readBytes, readJson } from './http.js'
import { ensureAlarm } from './tasks.js'

const base='/api/v1/watches'
const limit=48, maxText=96*1024, period=60_000
const ids=(c:Caller) => [c.accountId,c.userId,c.agentId] as const
const own='account=? AND user_id=? AND agent=?'
const time=(n:number|null) => n===null?null:new Date(n).toISOString()
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const bad=(s:string) => new ApiError(400,'INVALID_ARGUMENT',s)
const unavailable=() => new ApiError(503,'SOURCE_UNAVAILABLE','This remote text source has not been authorized or is unavailable.')
const missing=() => new ApiError(404,'NOT_FOUND','Watch task not found.')
type Watch={id:string, account:string, user_id:string, agent:string, role:Caller['role'], credential:string, source:string, uri:string,
  cadence:number, reason:string, instruction:string, active:number, created:number, due:number|null, started:number|null, last_time:number|null,
  last_task:string|null,last_status:string|null,last_error:string|null, rev:number}

function allowedURL(raw: unknown): string {
  if (typeof raw!=='string' || raw.length>1000) throw bad('Invalid registered text source.')
  let u:URL
  try { u=new URL(raw) } catch { throw bad('Invalid registered text source.') }
  if (u.protocol!=='https:' || u.port || u.username || u.password || u.search || u.hash ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]+$/u.test(u.hostname) ||
      /(?:^|\.)(?:localhost|internal|local|lan|home|arpa)$/u.test(u.hostname)) throw bad('Only exact pre-approved HTTPS document addresses are allowed.')
  return u.href
}

export function remoteTextSource(env:Env): WorkspaceContext['remoteText'] {
  const config=env.OPENVIKING_EDGE_TEXT_SOURCES
  if (!config || config.length>32_000) return undefined
  let urls: Set<string>
  try {
    const value=JSON.parse(config)
    if (!Array.isArray(value) || !value.length || value.length>64) return undefined
    urls=new Set(value.map(allowedURL))
  } catch { return undefined }
  return { allows: raw=>{try{return urls.has(allowedURL(raw))}catch{return false}}, async read(raw) {
    const href=allowedURL(raw)
    if (!urls.has(href)) throw unavailable()
    let response: Response
    const req=new Request(href,{method:'GET',redirect:'manual', headers:{Accept:'text/plain, text/markdown, application/json'}, signal:AbortSignal.timeout(8_000)})
    try { response=await (env.TEXT_SOURCE ? env.TEXT_SOURCE.fetch(req) : fetch(req)) } catch { throw unavailable() }
    if (!response.ok || (response.status>=300 && response.status<400) || response.redirected ||
        !/^(?:text\/(?:plain|markdown|x-markdown|csv)|application\/json)(?:;|$)/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel()
      throw unavailable()
    }
    try {
      const bounded=new Request(href,{method:'POST',body:response.body,headers:response.headers})
      return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(await readBytes(bounded,maxText))
    } catch { throw unavailable() }
  } }
}

export function initWatches(sql:SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_watches (
    id TEXT PRIMARY KEY, account TEXT NOT NULL,user_id TEXT NOT NULL,agent TEXT NOT NULL,role TEXT NOT NULL,credential TEXT NOT NULL,
    source TEXT NOT NULL, uri TEXT NOT NULL, cadence REAL NOT NULL,reason TEXT NOT NULL,instruction TEXT NOT NULL,active INTEGER NOT NULL,
    created INTEGER NOT NULL,due INTEGER,started INTEGER,last_time INTEGER,last_task TEXT,last_status TEXT,last_error TEXT,rev INTEGER NOT NULL,
    UNIQUE(account,user_id,agent,uri)
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_watches_due ON ov_watches(active,due)')
}

function rowById(ctx:WorkspaceContext,id:string) { return ctx.sql.exec<Watch>(`SELECT * FROM ov_watches WHERE ${own} AND id=?`,...ids(ctx.caller),id).toArray()[0] }
function rowByUri(ctx:WorkspaceContext,uri:string) { return ctx.sql.exec<Watch>(`SELECT * FROM ov_watches WHERE ${own} AND uri=?`,...ids(ctx.caller),uri).toArray()[0] }
function wire(r:Watch) {
  return {task_id:r.id,path:r.source,source_type:'url',to_uri:r.uri,parent_uri:null,reason:r.reason,instruction:r.instruction,
    watch_interval:r.cadence,build_index:true,summarize:false,processing_mode:'full',processor_kwargs:{},created_at:time(r.created),
    last_execution_time:time(r.last_time),last_task_id:r.last_task,last_status:r.last_status,last_error:r.last_error,next_execution_time:time(r.due),
    is_active:!!r.active,account_id:r.account,user_id:r.user_id,original_role:r.role}
}
function interval(v:unknown):number {
  if (typeof v!=='number' || !Number.isFinite(v) || v<1 || v>43200) throw bad('watch_interval is in minutes (1–43200).')
  return v
}
function small(v:unknown,k:string) {
  if(v==null)return ''
  if(typeof v!=='string'||v.length>1024)throw bad(`${k} must be text up to 1024 characters.`)
  return v
}

function destination(ctx:WorkspaceContext, raw:unknown):string {
  if (typeof raw!=='string') throw bad('A destination URI is required.')
  const fs=new Filesystem(ctx), path=fs.path(raw)
  if (!/\.(?:txt|md|json|csv)$/iu.test(path.uri)) throw bad('A text-file destination is required.')
  return path.uri
}

export function prepareWatchRegistrar(ctx:WorkspaceContext, credential:string): NonNullable<WorkspaceContext['registerWatch']> {
  return async body => {
    const source=body.path??body.source_url
    if (typeof source!=='string'||!/^https?:/iu.test(source)) return undefined
    const url=allowedURL(source)
    if (!ctx.remoteText?.allows(url)) throw unavailable()
    const uri=destination(ctx,body.to_uri??body.uri)
    const fs=new Filesystem(ctx)
    fs.checkWriteParent(uri)
    const cadence=interval(body.watch_interval)
    if (body.summarize===true || body.build_index===false || body.auth_state!=null || body.connector_states!=null) {
      throw new ApiError(501,'NOT_IMPLEMENTED','Remote imports accept indexed, plain text without delegated credentials or generated summaries.')
    }
    const reason=small(body.reason,'reason'), instruction=small(body.instruction,'instruction')
    await ctx.reauthorize?.()
    const now=Date.now(), due=now+cadence*period
    await ensureAlarm(ctx.storage,due)
    const row=ctx.storage.transactionSync(()=>{
      const old=rowByUri(ctx,uri)
      if(old) throw new ApiError(409,'ALREADY_EXISTS','A watch already owns this destination for the caller.')
      if (ctx.sql.exec<{n:number}>('SELECT COUNT(*) n FROM ov_watches WHERE account=?',ctx.caller.accountId).one().n>=limit ||
          ctx.sql.exec<{n:number}>('SELECT COUNT(*) n FROM ov_watches WHERE account=? AND user_id=?',ctx.caller.accountId,ctx.caller.userId).one().n>=12) {
        throw new ApiError(429,'RATE_LIMITED','Too many registered watches.')
      }
      const id=crypto.randomUUID()
      ctx.sql.exec(`INSERT INTO ov_watches(id,account,user_id,agent,role,credential,source,uri,cadence,reason,instruction,active,created,due,rev)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,1)`,id,...ids(ctx.caller),ctx.caller.role,credential,url,uri,cadence,reason,instruction,now,due)
      return rowById(ctx,id)!
    })
    // A watch is a persisted schedule. Do not claim a file was fetched at registration.
    return ok({...wire(row),watch_task_id:row.id,root_uri:uri,uri,scheduled:true})
  }
}

async function ingest(ctx:WorkspaceContext,source:string,uri:string) {
  if(!ctx.remoteText?.allows(source)) throw unavailable()
  const fs=new Filesystem(ctx)
  fs.checkWriteParent(uri)
  const path=fs.path(uri), prior=fs.entry(path)
  const text=await ctx.remoteText.read(source)
  await ctx.reauthorize?.()
  ctx.assertActive?.()
  if(prior&&!prior.is_dir&&fs.stat(uri).revision===prior.revision&&fs.read(uri)===text) return {uri,root_uri:uri,changed:false}
  await fs.putText(uri,text,{mode:prior?'replace':'create',expectedRevision:prior?.revision??null})
  return {uri,root_uri:uri,changed:true}
}

function get(ctx:WorkspaceContext,url:URL,id?:string) {
  const input=url.searchParams.get('to_uri')
  const uri=input===null?undefined:destination(ctx,input)
  if (!id&&!uri) throw bad('Provide a watch ID or to_uri.')
  if (id&&!idPattern.test(id)) throw missing()
  const row=id?rowById(ctx,id):rowByUri(ctx,uri!)
  if (!row) throw missing()
  if (uri&&row.uri!==uri) throw bad('The watch ID and URI refer to different resources.')
  const fs=new Filesystem(ctx)
  try { fs.checkWriteParent(row.uri) } catch { throw missing() }
  return row
}

export async function routeWatches(request:Request,url:URL,ctx:WorkspaceContext):Promise<Response|undefined> {
  if(url.pathname!==base && !url.pathname.startsWith(`${base}/`))return undefined
  const tail=url.pathname.slice(base.length).split('/').filter(Boolean)
  if(tail.length>2 || (tail.length===2&&tail[1]!=='trigger')) throw missing()
  const trigger=tail.at(-1)==='trigger'
  const id=trigger?tail[0]==='trigger'?undefined:tail[0]:tail[0]
  const byUri=url.searchParams.has('to_uri')
  const method=request.method
  if(method==='POST'&&!trigger&&!id&&!byUri) {
    if(!ctx.registerWatch)throw unavailable()
    const body=await readJson(request,16*1024)
    if (!body.watch_interval) throw bad('A watch interval is required.')
    const registered=await ctx.registerWatch(body)
    if(!registered) throw bad('Use a permitted remote text URL.')
    return registered
  }
  if(method==='GET'||method==='HEAD') {
    const active=url.searchParams.get('active_only')
    if (active!==null&&!['1','true','0','false'].includes(active)) throw bad('Invalid active_only value.')
    const only=active==='1'||active==='true'
    if(trigger) throw bad('Use POST to trigger a watch.')
    if(id||byUri) {
      const row=get(ctx,url,id)
      if(only&&!row.active) throw missing()
      return ok(wire(row))
    }
    const fs=new Filesystem(ctx)
    const rows=ctx.sql.exec<Watch>(`SELECT * FROM ov_watches WHERE ${own} AND (active=1 OR ?=0) ORDER BY created DESC,id DESC`,...ids(ctx.caller),only?1:0).toArray()
      .filter(row=>{try{fs.checkWriteParent(row.uri);return true}catch{return false}})
    const n=url.searchParams.get('limit'), cursor=url.searchParams.get('cursor')
    if(n===null&&cursor===null)return ok({tasks:rows.map(wire),total:rows.length})
    const take=n===null?100:Number(n)
    if(!Number.isInteger(take)||take<1||take>200 || (cursor!==null&&!idPattern.test(cursor)))throw bad('Invalid watch pagination.')
    const offset=cursor===null?0:rows.findIndex(row=>row.id===cursor)+1
    if(cursor&&offset===0)throw bad('Watch cursor is outside the selected view.')
    const tasks=rows.slice(offset,offset+take).map(wire),more=offset+take<rows.length
    return ok({tasks,total:rows.length,has_more:more,next_cursor:more?tasks.at(-1)?.task_id:null})
  }
  const old=get(ctx,url,id)
  if(method==='POST'&&trigger) {
    if(!ctx.remoteText?.allows(old.source)||!ctx.jobs)throw unavailable()
    const active=ctx.jobs.get(old.last_task??'')
    if(active&&['pending','running','cancelling'].includes(active.status))return ok({task_id:old.id,to_uri:old.uri,scheduled:true,reused:true})
    await ctx.jobs.enqueue('watch_sync',old.uri,{watch_id:old.id,rev:old.rev},{onAccepted(task){
      const fresh=rowById(ctx,old.id)
      if(!fresh||fresh.rev!==old.rev) throw new ApiError(409,'CONFLICT','Watch changed before triggering.')
      const pending=ctx.jobs?.get(fresh.last_task??'')
      if(pending&&['pending','running','cancelling'].includes(pending.status)) throw new ApiError(409,'CONFLICT','A watch run is already active.')
      ctx.sql.exec(`UPDATE ov_watches SET last_task=? WHERE ${own} AND id=? AND rev=?`,task.task_id,...ids(ctx.caller),old.id,old.rev)
    }})
    return ok({task_id:old.id,to_uri:old.uri,scheduled:true})
  }
  if(method==='DELETE'&&!trigger){
    ctx.sql.exec(`DELETE FROM ov_watches WHERE ${own} AND id=?`,...ids(ctx.caller),old.id)
    return ok({task_id:old.id,to_uri:old.uri,deleted:true})
  }
  if(method==='PATCH'&&!trigger){
    const body=await readJson(request,8*1024)
    if (Object.keys(body).some(key=>!['watch_interval','is_active','instruction','reason'].includes(key))) throw bad('Unsupported watch field.')
    const current=get(ctx,url,id)
    if(body.is_active!=null&&typeof body.is_active!=='boolean')throw bad('is_active must be boolean.')
    const active=body.is_active==null?!!current.active:body.is_active
    if(active&&!ctx.remoteText?.allows(current.source))throw unavailable()
    const cadence=body.watch_interval==null?current.cadence:interval(body.watch_interval)
    const due=active?Date.now()+cadence*period:null
    if(due)await ensureAlarm(ctx.storage,due)
    const next=ctx.storage.transactionSync(()=>{
      const row=get(ctx,url,id)
      if(row.rev!==current.rev)throw new ApiError(409,'CONFLICT','Watch changed while updating.')
      ctx.sql.exec(`UPDATE ov_watches SET cadence=?,active=?,due=?,reason=?,instruction=?,rev=rev+1 WHERE ${own} AND id=?`,cadence,active?1:0,due,
        body.reason==null?row.reason:small(body.reason,'reason'),body.instruction==null?row.instruction:small(body.instruction,'instruction'),...ids(ctx.caller),row.id)
      return rowById(ctx,row.id)!
    })
    return ok(wire(next))
  }
  throw new ApiError(405,'METHOD_NOT_ALLOWED','Unsupported watch method.')
}

export function claimWatch(sql:SqlStorage) {
  const now=Date.now()
  const row=sql.exec<Watch>('SELECT * FROM ov_watches WHERE active=1 AND due<=? ORDER BY due,id LIMIT 1',now).toArray()[0]
  if(row)sql.exec('UPDATE ov_watches SET due=? WHERE id=? AND rev=?',now+row.cadence*period,row.id,row.rev)
  return row
}

export async function scheduleWatch(storage:DurableObjectStorage) {
  const next=storage.sql.exec<{ due:number|null }>('SELECT MIN(due) due FROM ov_watches WHERE active=1').one().due
  if(next!==null) await ensureAlarm(storage,Math.max(next,Date.now()+50))
}

export function identityForWatch(row:Watch):Caller { return {accountId:row.account,userId:row.user_id,agentId:row.agent,role:row.role} }

export function revokeWatch(sql:SqlStorage,row:Watch) {
  sql.exec("UPDATE ov_watches SET active=0,due=NULL,last_status='failed',last_error='Watch credential was revoked',rev=rev+1 WHERE id=? AND rev=?",row.id,row.rev)
}

export async function runWatch(payload:Record<string,unknown>,ctx:WorkspaceContext):Promise<unknown> {
  if(typeof payload.watch_id!=='string'||!idPattern.test(payload.watch_id)) throw missing()
  const watchId=payload.watch_id
  const start=Date.now()
  const row=ctx.storage.transactionSync(()=>{
    const current=rowById(ctx,watchId)
    if(!current||current.rev!==payload.rev)throw new ApiError(409,'CONFLICT','Watch changed before its run.')
    if(current.started!==null&&current.started>start-120_000)throw new ApiError(409,'CONFLICT','Another run is active.')
    ctx.sql.exec('UPDATE ov_watches SET started=? WHERE id=? AND rev=?',start,current.id,current.rev)
    return current
  })
  const upstreamFence=ctx.assertActive
  // Use the live authorization fields. reauthorize() replaces groups on the
  // original context after an await, so a shallow copy would hold stale grants.
  const scoped=Object.assign(Object.create(ctx) as WorkspaceContext,{assertActive:()=>{
    upstreamFence?.()
    const current=rowById(ctx,row.id)
    if(current?.rev!==row.rev||current.started!==start)throw new ApiError(409,'CONFLICT','Watch changed before the import was published.')
  }})
  try {
    const value=await ingest(scoped,row.source,row.uri)
    ctx.sql.exec("UPDATE ov_watches SET started=NULL,last_status='completed',last_time=?,last_error=NULL WHERE id=? AND started=?",Date.now(),row.id,start)
    return value
  } catch (error) {
    ctx.sql.exec("UPDATE ov_watches SET started=NULL,last_status='failed',last_time=?,last_error='Text import did not complete' WHERE id=? AND started=?",Date.now(),row.id,start)
    throw error
  }
}
