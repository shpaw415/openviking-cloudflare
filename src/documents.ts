// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError } from './http.js'

export const documentInputLimit=1024*1024
const encoder=new TextEncoder()
const outputLimit=96*1024
const allowed=new Map([
  ['pdf',{mime:'application/pdf',magic:[0x25,0x50,0x44,0x46,0x2d]}],
  ['docx',{mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',magic:[0x50,0x4b,3,4]}],
  ['xlsx',{mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',magic:[0x50,0x4b,3,4]}],
  ['pptx',{mime:'application/vnd.openxmlformats-officedocument.presentationml.presentation',magic:[0x50,0x4b,3,4]}],
  ['png',{mime:'image/png',magic:[0x89,0x50,0x4e,0x47,13,10,26,10]}],
  ['jpeg',{mime:'image/jpeg',magic:[0xff,0xd8,0xff]}],
])
const bad=()=>new ApiError(415,'UNSUPPORTED_MEDIA_TYPE','The uploaded document does not match its admitted file type.')
const failed=()=>new ApiError(503,'CONVERSION_UNAVAILABLE','Document conversion did not complete.')

export function initDocuments(sql:SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_doc_budget (subject TEXT PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL, bytes INTEGER NOT NULL)`)
}

function admitBudget(ctx:WorkspaceContext,size:number) {
  const day=Math.floor(Date.now()/86_400_000)
  ctx.storage.transactionSync(()=>{
    for(const [subject,count,bytes] of [['_account',40,16*1024*1024],[`user:${ctx.caller.userId}`,12,4*1024*1024]] as const) {
      const old=ctx.sql.exec<{day:number,n:number,bytes:number}>('SELECT day,n,bytes FROM ov_doc_budget WHERE subject=?',subject).toArray()[0]
      const n=(old?.day===day?old.n:0)+1
      const total=(old?.day===day?old.bytes:0)+size
      if(n>count||total>bytes)throw new ApiError(429,'RATE_LIMITED','Document conversion budget exhausted.')
      ctx.sql.exec('INSERT INTO ov_doc_budget VALUES(?,?,?,?) ON CONFLICT(subject) DO UPDATE SET day=excluded.day,n=excluded.n,bytes=excluded.bytes',subject,day,n,total)
    }
  })
}

export function converter(ctx:WorkspaceContext,ai:Ai): NonNullable<WorkspaceContext['convertDocument']> {
  return async file=>{
    const dot=file.name.lastIndexOf('.')
    if(dot<1) return undefined
    const ext=file.name.slice(dot+1).toLowerCase().replace(/^jpg$/,'jpeg')
    const rule=allowed.get(ext)
    if(!rule)return undefined
    if(file.size>documentInputLimit)throw new ApiError(413,'RESOURCE_EXHAUSTED','Document exceeds the conversion upload limit.')
    if(file.type&&file.type!=='application/octet-stream'&&file.type!==rule.mime)throw bad()
    const lead=new Uint8Array(await file.slice(0,rule.magic.length).arrayBuffer())
    if(lead.length!==rule.magic.length||rule.magic.some((value,i)=>lead[i]!==value))throw bad()
    await ctx.reauthorize?.()
    admitBudget(ctx,file.size)
    let result:ConversionResponse
    // Bindings use the approved media type; never let document bytes select a target or credentials.
    try { result=await ai.toMarkdown({name:file.name,blob:file.slice(0,file.size,rule.mime)}) } catch {throw failed()}
    if(result.format!=='markdown'&&result.format!=='text'||typeof result.data!=='string'||!result.data.trim())throw failed()
    if(encoder.encode(result.data).byteLength>outputLimit)throw new ApiError(413,'RESOURCE_EXHAUSTED','Converted Markdown exceeds the storage limit.')
    if(result.data.includes('\0'))throw failed()
    await ctx.reauthorize?.()
    return {filename:`${file.name.slice(0,dot)}.md`,content:result.data}
  }
}
