// SPDX-License-Identifier: AGPL-3.0-only
import { mountDataAuthority } from '../data-authority.js'
import { ApiError, ok, readJson } from '../http.js'
import { bool, conflict, denied, int, invalid, onlyKeys, parseTags, queryBool, queryInt, queryString, quota, str, textSize } from '../fs/contract.js'
import { Filesystem, emptyIndex } from '../fs/store.js'
import type { Scoped } from '../fs/store.js'
import { assertPendingClear } from '../fs/pending.js'
import { requireMcp, asObject } from './common.js'
import type { Data, McpContext } from './common.js'
import { localReadRegistration, prepareLocalRead } from './registry.js'

const scope = 'account_id=? AND user_id=? AND agent_id=?'
const ids = (ctx:McpContext) => [ctx.caller.accountId,ctx.caller.userId,ctx.caller.agentId]
type Row = { node_uri:string; marker_id:string; marker_revision:string; spec:string; server:string }
type Spec = Awaited<ReturnType<typeof localReadRegistration>> & { source:string; title:string;description:string;timeout_seconds:number;tags:string[] }

export function initLive(sql:SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_mcp_live (account_id TEXT NOT NULL,user_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    node_uri TEXT NOT NULL,marker_id TEXT NOT NULL,marker_revision TEXT NOT NULL,spec TEXT NOT NULL,server TEXT NOT NULL,
    PRIMARY KEY(account_id,user_id,agent_id,node_uri)) WITHOUT ROWID`)
}

const lookup = (ctx:McpContext, uri:string) => ctx.sql.exec<Row>(`SELECT * FROM ov_mcp_live WHERE ${scope} AND node_uri=?`,...ids(ctx),uri).toArray()[0]
const notFound = () => { throw new ApiError(404,'NOT_FOUND','No current Live Context mount at this URI.') }
const matches = (row:Row, marker:{node_id:string;revision:string}|undefined) => marker?.node_id===row.marker_id && marker.revision===row.marker_revision

async function authorize(ctx:McpContext) {
  if (ctx.loadDataAuthority) await mountDataAuthority(ctx)
  await ctx.reauthorize?.()
  ctx.assertActive?.()
}

function destination(fs:Filesystem,value:unknown) {
  const path=fs.path(value)
  if (path.parts[0]!=='user' || path.kind!=='resource' || path.managed || path.builtin || path.space===null ||
      !path.uri.endsWith('.md') || path.parts.some(part=>part.startsWith('.'))) denied('Live nodes require a Markdown path in your personal resources.')
  return path as Scoped
}

function sourceFile(fs:Filesystem, uri:string) {
  const path=fs.path(uri), row=fs.require(path)
  if (path.kind!=='resource' || row.is_dir || row.derived_from!=null || row.derived_version!=null) invalid('Live reads require authored resource text.')
  if (row.bytes>32_768) quota('Live Context source exceeds 32 KiB.')
  return row
}

const view = (node_uri:string, s:Spec) => ({ node_uri, tool_uri:s.uri, title:s.title, description:s.description, timeout_seconds:s.timeout_seconds,
  arguments:{uri:s.source},tags:s.tags,mcp:s.server,tool:'read',status:'mounted' })

async function mount(ctx:McpContext, fs:Filesystem, body:Data) {
  onlyKeys(body,'tool_uri node_uri title description timeout_seconds arguments tags wait')
  bool(body.wait,'wait')
  const node=destination(fs,body.node_uri), args=asObject(body.arguments??{},'arguments')
  onlyKeys(args,'uri')
  const source=fs.path(args.uri).uri
  if (source===node.uri) invalid('A live node cannot refer to itself.')
  const title=str(body.title,'title',undefined,128).trim(), description=str(body.description??undefined,'description','',512)
  if (!title) invalid('A live node needs a nonblank title.')
  const timeout_seconds=int(body.timeout_seconds,'timeout_seconds',60,1,60),tags=parseTags(body.tags)
  await prepareLocalRead()
  await authorize(ctx)
  ctx.assertActive?.()
  return fs.atomic(()=>{
    const ref=localReadRegistration(ctx,body.tool_uri)
    sourceFile(fs,source)
    if (lookup(ctx,source)) invalid('Live nodes cannot read other live nodes.')
    fs.check(node.uri,'write')
    assertPendingClear(ctx,node)
    const old=fs.entry(node,'write'), prior=lookup(ctx,node.uri)
    if (old && (!prior || !matches(prior,old))) conflict('An authored file already occupies the Live Context destination.')
    fs.fileParent(node,!!old)
    if (ctx.sql.exec<{n:number}>('SELECT count(*) AS n FROM ov_mcp_live WHERE account_id=?',ctx.caller.accountId).one().n>=128 && !prior) quota('Live Context mount quota reached.')
    const marker='# OpenViking Live Context\n\nRead via the local content API.\n'
    const bytes=textSize(marker)
    fs.limits(node.space,old?0:1,bytes-(old?.bytes??0))
    const entry=fs.storeFile(node,marker,bytes,emptyIndex,tags,old)
    const spec={...ref,source,title,description,timeout_seconds,tags}
    ctx.sql.exec(`INSERT OR REPLACE INTO ov_mcp_live VALUES(?,?,?,?,?,?,?,?)`,...ids(ctx),node.uri,entry.node_id,entry.revision,JSON.stringify(spec),ref.server)
    return view(node.uri,spec)
  })
}

async function unmount(ctx:McpContext,fs:Filesystem,value:unknown) {
  const node=destination(fs,value)
  await authorize(ctx)
  return fs.atomic(()=>{
    const saved=lookup(ctx,node.uri) ?? notFound(), marker=fs.entry(node,'write')
    // An edited/recreated authored file is never deleted when cleaning a stale descriptor.
    if (matches(saved,marker)) fs.remove(node,false)
    ctx.sql.exec(`DELETE FROM ov_mcp_live WHERE ${scope} AND node_uri=?`,...ids(ctx),node.uri)
    return {node_uri:node.uri,removed:true}
  })
}

export async function routeLive(request:Request,url:URL,ctx:McpContext,suffix:string):Promise<Response> {
  const fs=new Filesystem(ctx), query=url.searchParams
  if (suffix==='/mounts' && ['GET','HEAD'].includes(request.method)) {
    const server=str(queryString(query,'mcp'),'mcp',undefined,64),tool=queryString(query,'tool')
    const target=queryString(query,'target_uri')??'viking://~/tools'
    await prepareLocalRead()
    await authorize(ctx)
    const registered=localReadRegistration(ctx,`${target.replace(/\/$/u,'')}/${server}/read.json`)
    const mounts=tool && tool!=='read' ? [] : ctx.sql.exec<Row>(`SELECT * FROM ov_mcp_live WHERE ${scope} AND server=? ORDER BY node_uri`,...ids(ctx),server).toArray()
      .filter(row=>matches(row,fs.entry(fs.path(row.node_uri))) && (JSON.parse(row.spec) as Spec).registration===registered.registration)
      .map(row=>view(row.node_uri,JSON.parse(row.spec)))
    return ok({mcp:server,mounts,total:mounts.length})
  }
  if (ctx.mcpMode!=='read-write') denied('Live Context mounts require MCP write permission.')
  if (suffix==='/mount' && request.method==='POST') return ok(await mount(ctx,fs,await readJson(request,32*1024)))
  if (suffix==='/mount' && request.method==='DELETE') {
    queryBool(query,'wait')
    return ok(await unmount(ctx,fs,queryString(query,'node_uri')))
  }
  if (request.method==='POST' && ['/batch-mount','/batch-unmount'].includes(suffix)) {
    const adding=suffix==='/batch-mount',body=await readJson(request,32*1024)
    onlyKeys(body,adding?'mounts wait':'node_uris wait'); bool(body.wait,'wait')
    const items=adding?body.mounts:body.node_uris
    if (!Array.isArray(items) || !items.length || items.length>16) invalid('Expect 1 to 16 Live Context items.')
    const uri=(item:unknown)=>adding?asObject(item,'mount').node_uri:item
    const targets=items.map(item=>fs.path(uri(item)).uri)
    if (new Set(targets).size!==targets.length) invalid('Duplicate Live Context destinations.')
    const applied:unknown[]=[],succeeded:string[]=[],failed:unknown[]=[]
    for (const [i,item] of items.entries()) {
      try { applied.push(adding?await mount(ctx,fs,asObject(item,'mount')):await unmount(ctx,fs,item)); succeeded.push(targets[i]) }
      catch (error) { if (!(error instanceof ApiError)) throw error; failed.push({node_uri:targets[i], code:error.code, message:error.message, applied:false}) }
    }
    return ok({ [adding?'mounts':'unmounts']:applied,total:applied.length,succeeded,failed,not_attempted:[] })
  }
  throw new ApiError(405,'METHOD_NOT_ALLOWED','Unsupported Live Context method.')
}

export async function readLive(request:Request,url:URL,ctx:McpContext):Promise<Response|undefined> {
  const raw=queryString(url.searchParams,'uri')
  if (!raw?.endsWith('.md')) return
  const fs=new Filesystem(ctx), path=fs.path(raw)
  const row=lookup(ctx,path.uri)
  if (!row || !matches(row,fs.entry(path))) return
  if (request.method==='HEAD' || queryBool(url.searchParams,'raw') || queryInt(url.searchParams,'offset',0,0,1_000_000)!==0 ||
      queryInt(url.searchParams,'limit',-1,-1,1_000_000)!==-1) return
  requireMcp(ctx)
  const spec:Spec=JSON.parse(row.spec)
  await prepareLocalRead()
  await authorize(ctx)
  const registration=localReadRegistration(ctx,spec.uri)
  const current=lookup(ctx,path.uri)
  if (current?.spec!==row.spec || !matches(row,fs.entry(path)) || registration.registration!==spec.registration || registration.revision!==spec.revision) {
    return notFound()
  }
  if (lookup(ctx,spec.source)) invalid('Live nodes cannot read other live nodes.')
  sourceFile(fs,spec.source)
  const response=ok(fs.read(spec.source))
  response.headers.set('Cache-Control','private, no-store')
  return response
}
