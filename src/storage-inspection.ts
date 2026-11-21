// SPDX-License-Identifier: AGPL-3.0-only
import { Filesystem } from './filesystem.js'
import type { WorkspaceContext } from './context.js'
import { ApiError, ok, readJson } from './http.js'
import { embeddingDimensions } from './embeddings.js'

const encoder=new TextEncoder()
const input=(message:string)=>new ApiError(400,'INVALID_ARGUMENT',message)

/** Inspect the same permission-filtered catalog used by search, not a privileged SQL scan. */
function visible(fs:Filesystem,raw:unknown){
  const path=fs.path(raw)
  const entry=fs.stat(path.uri)
  return {path, entry, files:(entry.is_dir?fs.list(path.uri,true):[entry]).filter(row=>!row.is_dir)}
}
const indexed=(row:{dimensions:number,vector_bytes:number})=>row.dimensions===embeddingDimensions&&row.vector_bytes>=embeddingDimensions*4&&row.vector_bytes%(embeddingDimensions*4)===0

function cursorToken(index:number,salt:string) {
  const bytes=encoder.encode(JSON.stringify([index,salt]));return btoa(String.fromCharCode(...bytes)).replace(/=+$/u,'').replace(/\+/gu,'-').replace(/\//gu,'_')
}
function parseCursor(raw:string|null,salt:string):number {
  if(raw===null)return 0
  if(!/^[A-Za-z0-9_-]{1,1800}$/u.test(raw))throw input('Invalid vector page cursor.')
  try{
    const b=atob(raw.replace(/-/gu,'+').replace(/_/gu,'/'))
    const pair=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(Uint8Array.from(b,ch=>ch.charCodeAt(0))))
    if(!Array.isArray(pair)||pair.length!==2||!Number.isSafeInteger(pair[0])||pair[0]<1||pair[0]>4096||pair[1]!==salt) throw input('Invalid vector page cursor.')
    return pair[0]
  }catch{throw input('Invalid vector page cursor.')}
}

export async function routeStorageInspection(request:Request,url:URL,ctx:WorkspaceContext):Promise<Response|undefined>{
  const path=url.pathname
  if(path==='/api/v1/system/consistency'&&request.method==='POST') {
    const {uri}=await readJson(request,8192)
    if(typeof uri!=='string')throw input('A Viking directory URI is required.')
    const fs=new Filesystem(ctx), candidate=visible(fs,uri)
    if(!candidate.entry.is_dir)throw input('Consistency requires a directory URI.')
    // A file intentionally ingested without vectors is a missing index record
    // from this check's perspective. Empty directories don't claim vectors.
    let missing=0
    const items=[]
    for(const entry of candidate.files){
      if(indexed(entry))continue
      missing++
      if(items.length<50)items.push({uri:entry.uri,path:entry.uri.slice(candidate.path.uri.length).replace(/^\//u,''),level:2,key:entry.uri})
    }
    return ok({ok:missing===0,expected_count:candidate.files.length,missing_record_count:missing,missing_records:items,missing_records_truncated:missing>items.length})
  }
  if(!['/api/v1/debug/vector/scroll','/api/v1/debug/vector/count'].includes(path)||!['GET','HEAD'].includes(request.method))return undefined
  if(url.searchParams.has('filter'))throw new ApiError(501,'NOT_IMPLEMENTED','A raw index DSL is unavailable; use URI scoping.')
  const fs=new Filesystem(ctx), catalog=visible(fs,url.searchParams.get('uri')??'viking://')
  const files=catalog.files.filter(indexed).sort((a,b)=>a.uri<b.uri?-1:a.uri>b.uri?1:0)
  if(path.endsWith('/count'))return ok({count:files.length})
  const raw=url.searchParams.get('limit')??'100', limit=Number(raw)
  if(!/^\d{1,4}$/u.test(raw)||limit<1||limit>1000)throw input('Invalid vector list limit.')
  const salt=JSON.stringify([ctx.caller.accountId,ctx.caller.userId,ctx.caller.agentId,catalog.path.uri])
  const offset=parseCursor(url.searchParams.get('cursor'),salt)
  const records=files.slice(offset,offset+limit).map(row=>({id:row.node_id,uri:row.uri,level:2,size:row.bytes,
    dimensions:row.dimensions,chunks:row.vector_bytes/(row.dimensions*4),revision:row.revision}))
  const next=offset+records.length
  return ok({records,next_cursor:next<files.length?cursorToken(next,salt):null})
}
