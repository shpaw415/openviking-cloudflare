// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { mountDataAuthority } from '../data-authority.js'
import { absChild, compare, conflict, denied, quota, textSize, unsupported, writable } from '../fs/contract.js'
import { Filesystem, tagsOf } from '../fs/store.js'
import type { Entry, Scoped } from '../fs/store.js'
import { documentIndex } from '../fs/vectors.js'
import { ApiError, ok } from '../http.js'
import { reference, name } from './protocol.js'

const maxFile = 64 * 1024, maxTotal = 512 * 1024, maxLiterals = 128, detailLimit = 16

export async function scanPrivacy(ctx: WorkspaceContext, command: {uri:string; fix:boolean; limit:number}) {
  if (!ctx.privacyScan) unsupported('Privacy filesystem scan is not mounted.')
  const fs = new Filesystem(ctx), root = fs.path(command.uri)
  if (!['resource','memory','skill'].includes(root.kind) || root.space === null) denied('Scan requires a resource, memory, or Skill URI.')
  if (command.fix && (root.parts[0]!=='user'||root.managed||!['memory','resource'].includes(root.kind))) {
    denied('Repair requires an ordinary private resource or memory; shared content and managed packages are scan-only.')
  }
  if (command.fix && !ctx.hasEmbedding) throw new ApiError(503,'EMBEDDING_UNAVAILABLE','Privacy repair requires the authorized embedding mount to replace stale vectors.')
  if (ctx.loadDataAuthority) await mountDataAuthority(ctx)
  await ctx.reauthorize?.()
  ctx.assertActive?.()
  const row = fs.require(root)
  const nodes = row.is_dir ? fs.entries(root).filter(e => absChild(e.uri,root.uri)).sort((a,b)=>compare(a.uri,b.uri)) : [row]
  const files = nodes.slice(0,command.limit).filter(e => !e.is_dir)
  const literals = new Map<string,string[]>()
  let fields = 0
  const configurations = () => ctx.sql.exec<{category:string;target_key:string;values_json:string;version:number}>(`SELECT v.category,v.target_key,v.values_json,v.version
    FROM privacy_targets t JOIN privacy_versions v USING(account_id,owner_user_id,category,target_key)
    WHERE t.account_id=? AND t.owner_user_id=? AND t.active_version=v.version ORDER BY v.category,v.target_key`,ctx.caller.accountId,ctx.caller.userId).toArray()
  const configs=configurations()
  for (const cfg of configs) {
    for (const [field,value] of Object.entries(JSON.parse(cfg.values_json))) {
      if (typeof value !== 'string' || value.length < 8 || value.length > 512 || /\p{Cc}/u.test(value)) continue
      if (++fields > maxLiterals) quota('Too many registered scan literals.')
      const ref = reference(ctx.caller.userId,cfg.category,cfg.target_key,name(field))
      const matched = literals.get(value) ?? []
      matched.push(ref)
      literals.set(value,matched)
    }
  }
  const scrub = (text:string) => [...literals.keys()].some(literal => text.includes(literal)) ? '[redacted]' : text
  const matches: {uri:string;occurrences:number;references:string[];references_truncated:boolean;ambiguous:string[][];ambiguous_truncated:boolean;fixable:boolean;fixed:boolean}[] = []
  const changes:{row:Entry;path:Scoped;text:string;bytes:number;match:typeof matches[number]}[]=[]
  const placeholder=/\{\{[ \t]*ov_privacy:[^}\r\n]{1,2048}\}\}/gu
  const alternatives=[...literals.keys()].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'))
  const tokens=new RegExp(`${placeholder.source}${alternatives.length?'|'+alternatives.join('|'):''}`,'gu')
  let fixTruncated=false
  let bytes=0, scanned=0, truncated=nodes.length>command.limit, stop_reason: string|null=truncated?'node_limit':null
  const skipped_files: Record<string,number> = {}
  const skip = (reason:string) => { skipped_files[reason]=(skipped_files[reason]??0)+1 }
  for (const file of files) {
    if (file.derived_from != null || file.derived_version != null || !/\.(?:md|txt|json|ya?ml|toml)$/iu.test(file.uri)) { skip('unsupported_file'); continue }
    if (file.bytes>maxFile) { skip('file_bytes_limit'); continue }
    if (bytes+file.bytes>maxTotal) { truncated=true;stop_reason='total_bytes_limit';break }
    const original=fs.read(file.uri), text=original.replace(placeholder,'\u0000')
    bytes+=file.bytes; scanned++
    let occurrences=0
    const refs:string[]=[], ambiguous:string[][]=[]
    for (const [literal,candidates] of literals) {
      let pos=0, count=0
      while ((pos=text.indexOf(literal,pos))!==-1) { count++;pos+=literal.length }
      if (count) {
        occurrences+=count
        if (candidates.length===1) refs.push(scrub(candidates[0]))
        else ambiguous.push(candidates.slice(0,detailLimit).map(scrub))
      }
    }
    if (occurrences) {
      const path=fs.path(file.uri) as Scoped
      const fixable=path.parts[0]==='user'&&!path.managed&&['resource','memory'].includes(path.kind)&&/\.(?:txt|md)$/iu.test(path.uri)&&
        !ambiguous.length&&occurrences<=256&&!path.parts.some(part=>part.startsWith('.'))&&scrub(path.uri)===path.uri&&
        fs.acl.allows(path,'write')
      const match={uri:scrub(file.uri),occurrences,references:refs.slice(0,detailLimit),references_truncated:refs.length>detailLimit,
        ambiguous:ambiguous.slice(0,detailLimit),ambiguous_truncated:ambiguous.length>detailLimit || [...literals.values()].some(list => list.length>detailLimit),fixable,fixed:false}
      matches.push(match)
      if (command.fix&&fixable) {
        if (changes.length>=8) {fixTruncated=true;continue}
        const updated=original.replace(tokens,token=>literals.get(token)?.[0]??token)
        if (updated===original || [...literals.keys()].some(literal=>updated.includes(literal))) {match.fixable=false;continue}
        writable(path,ctx.caller)
        changes.push({row:file,path,text:updated,bytes:textSize(updated),match})
      }
    }
  }
  const indexes:Awaited<ReturnType<typeof documentIndex>>[]=[]
  for (const change of changes) {
    await ctx.reauthorize?.()
    if (JSON.stringify(configurations())!==JSON.stringify(configs)) conflict('The active Privacy configuration changed.')
    if (fs.require(change.path,'write').revision!==change.row.revision) conflict('A Privacy repair target changed.')
    indexes.push(await documentIndex(ctx,change.text))
  }
  if (changes.length) {
    await ctx.reauthorize?.()
    fs.atomic(()=>{
      ctx.assertActive?.()
      if (JSON.stringify(configurations())!==JSON.stringify(configs)) conflict('The active Privacy configuration changed.')
      for (const [i,change] of changes.entries()) {
        const row=fs.require(change.path,'write')
        if (row.revision!==change.row.revision || !indexes[i].dimensions) conflict('A Privacy repair target or index changed.')
        fs.storeFile(change.path,change.text,change.bytes,indexes[i],tagsOf(row),row,row.description)
      }
    })
    for (const change of changes) change.match.fixed=true
  }
  return ok({uri:scrub(root.uri),enumerated_files:files.length,scanned_files:scanned,scanned_bytes:bytes,matched_files:matches.length,
    repaired_files:changes.length,dry_run:!command.fix,truncated,fix_truncated:fixTruncated,stop_reason,skipped_files,matches,
    reindex:changes.map(change=>({uri:change.match.uri,status:'completed'})),
    limits:{max_nodes:1000,max_file_bytes:maxFile,max_total_bytes:maxTotal,max_registered_fields:maxLiterals,max_reference_details_per_file:detailLimit}})
}
