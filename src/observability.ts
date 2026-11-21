// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from './context.js'
import { ApiError, ok } from './http.js'
import { jobCounts } from './tasks.js'
import { Filesystem } from './filesystem.js'

type Audit = { request_id: string, account: string, user_id: string, time: number, method: string, route: string, api_type: string, status_code: number, duration_ms: number, error_code: string | null }
type Usage = { time: number, embedding_input: number | null, vlm_input: number | null, vlm_output: number | null }
type Count = { n: number }
const dayMillis = 86_400_000
const knownRead = /^\/(?:metrics|api\/v1\/(?:observer|console|system)|bot\/v1\/health)(?:\/|$)/u
const datePattern = /^\d{4}-\d\d-\d\d$/u
const types = new Set(['find','search','grep','glob','add_resource','add_skill','session_add_message','session_commit','filesystem','admin','tasks','skills','compile','rules','snapshots','packs','bot','other'])

export function initObservability(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_audit(
    request_id TEXT PRIMARY KEY,account TEXT NOT NULL,user_id TEXT NOT NULL,agent TEXT NOT NULL,time INTEGER NOT NULL,
    method TEXT NOT NULL,route TEXT NOT NULL,api_type TEXT NOT NULL,status_code INTEGER NOT NULL,duration_ms INTEGER NOT NULL,error_code TEXT
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_audit_time ON ov_edge_audit(account,time,request_id)')
  sql.exec(`CREATE TABLE IF NOT EXISTS ov_edge_usage(
    id INTEGER PRIMARY KEY,account TEXT NOT NULL,user_id TEXT NOT NULL,agent TEXT NOT NULL,time INTEGER NOT NULL,
    embedding_input INTEGER,vlm_input INTEGER,vlm_output INTEGER
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS ov_edge_usage_time ON ov_edge_usage(account,time)')
}

function label(path: string, method: string): [string, string] {
  if (/^\/api\/v1\/search\/(find|search|grep|glob)$/u.test(path)) return [path, path.split('/').at(-1)!]
  if (path === '/api/v1/resources' && method === 'POST') return [path,'add_resource']
  if (path === '/api/v1/skills' && method === 'POST') return [path,'add_skill']
  if (/^\/api\/v1\/sessions\/[^/]+\/messages(?:\/batch)?$/u.test(path)) return ['/api/v1/sessions/{session_id}/messages','session_add_message']
  if (/^\/api\/v1\/sessions\/[^/]+\/commit$/u.test(path)) return ['/api/v1/sessions/{session_id}/commit','session_commit']
  for (const [a, b] of [['/api/v1/fs','filesystem'],['/api/v1/content','filesystem'],['/api/v1/admin','admin'],['/api/v1/tasks','tasks'],['/api/v1/skills','skills'],['/api/v1/compile','compile'],['/api/v1/rules','rules'],['/api/v1/snapshot','snapshots'],['/api/v1/pack','packs'],['/webdav/resources','filesystem'],['/bot/v1','bot']]) {
    if (path === a || path.startsWith(`${a}/`)) return [a, b]
  }
  // Raw URLs, query strings, documents, session ids and response bodies aren't telemetry.
  return ['/api/v1/{operation}','other']
}

function boundedTable(ctx: WorkspaceContext, table: 'ov_edge_audit' | 'ov_edge_usage', order: string) {
  const sql = ctx.sql
  sql.exec(`DELETE FROM ${table} WHERE time < ?`, Date.now() - 366 * dayMillis)
  const n = sql.exec<Count>(`SELECT COUNT(*) n FROM ${table}`).one().n
  // Amortize trimming, with a bounded excess and no data crossing a tenant DO.
  if (n > 20_000) sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} ORDER BY ${order} LIMIT 1000)`)
}

export function auditRequest(ctx: WorkspaceContext, request: Request, path: string, id: string, start: number, status: number, error?: string) {
  if (ctx.auditEnabled === false || knownRead.test(path)) return
  const [route, type] = label(path, request.method)
  const duration = Math.round(Math.max(0, Date.now() - start))
  ctx.storage.transactionSync(() => {
    ctx.sql.exec('INSERT INTO ov_edge_audit VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, ctx.caller.accountId, ctx.caller.userId,
      ctx.caller.agentId, start, ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','PROPFIND','MKCOL','MOVE','COPY'].includes(request.method) ? request.method : 'OTHER',
      route, type, status, duration, error && /^[A-Z_]{1,64}$/u.test(error) ? error : null)
    boundedTable(ctx, 'ov_edge_audit', 'time,request_id')
  })
}

export function reportUsage(ctx: WorkspaceContext, usage: { embedding?: number | null, input?: number | null, output?: number | null }) {
  if (ctx.auditEnabled === false || [usage.embedding,usage.input,usage.output].every(x => x == null)) return
  ctx.storage.transactionSync(() => {
    ctx.sql.exec('INSERT INTO ov_edge_usage(account,user_id,agent,time,embedding_input,vlm_input,vlm_output) VALUES(?,?,?,?,?,?,?)',
      ctx.caller.accountId,ctx.caller.userId,ctx.caller.agentId,Date.now(),usage.embedding ?? null,usage.input ?? null,usage.output ?? null)
    boundedTable(ctx, 'ov_edge_usage', 'time,id')
  })
}

const bad = (message: string) => new ApiError(400, 'INVALID_ARGUMENT', message)
function date(value: string | null): number {
  if (!value || !datePattern.test(value)) throw bad('Use a date of the form YYYY-MM-DD.')
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10) !== value) throw bad('Invalid calendar date.')
  return timestamp
}

function calendar(timezone: string | null) {
  if (timezone !== null && (timezone.length > 100 || !/^[A-Za-z0-9_+\-/]+$/u.test(timezone))) throw bad('Invalid IANA timezone.')
  let formatter: Intl.DateTimeFormat
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone ?? 'UTC', year:'numeric',month:'2-digit',day:'2-digit', hour:'2-digit',hourCycle:'h23' }) }
  catch { throw bad('Invalid IANA timezone.') }
  return (t: number) => {
    const cells = formatter.formatToParts(t)
    const get = (part: string) => cells.find(cell => cell.type === part)!.value
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
  }
}

function membership(ctx: WorkspaceContext): { where: string; args: string[] } {
  if (ctx.caller.role === 'admin') return { where: 'account=?', args:[ctx.caller.accountId] }
  return { where: 'account=? AND user_id=?', args: [ctx.caller.accountId,ctx.caller.userId] }
}

function timeSeriesRows(ctx: WorkspaceContext, start: number, end: number, kind: 'audit' | 'usage') {
  const scope = membership(ctx)
  const from = start-dayMillis, to = end+2*dayMillis
  const predicate = `${scope.where} AND time>=? AND time<?`
  if (kind === 'audit') return ctx.sql.exec<{ time:number; api_type:string; status_code:number }>(
    `SELECT time,api_type,status_code FROM ov_edge_audit WHERE ${predicate}`, ...scope.args, from, to).toArray()
  return ctx.sql.exec<Usage>(`SELECT time,embedding_input,vlm_input,vlm_output FROM ov_edge_usage WHERE ${predicate}`, ...scope.args, from, to).toArray()
}

const contextTypes = ['add_resource','add_skill','session_add_message','session_commit'] as const
const usageTypes = ['embedding_input','vlm_input','vlm_output'] as const
function series(ctx: WorkspaceContext, url: URL, kind: 'tokens' | 'contexts') {
  const startDate = url.searchParams.get('start_date'), endDate = url.searchParams.get('end_date')
  const start = date(startDate), end = date(endDate)
  if (end < start || end - start > 366*dayMillis) throw bad('Require start_date through end_date, up to 367 days.')
  const bucket = url.searchParams.get('bucket') ?? (kind === 'tokens' ? 'day' : 'hour')
  if (kind === 'tokens' ? bucket !== 'day' : !['hour','4h'].includes(bucket)) throw bad('Invalid series bucket.')
  const local = calendar(url.searchParams.get('timezone'))
  const values = new Map<string, Record<string,string|number>>()
  const rows = timeSeriesRows(ctx,start,end,kind === 'tokens' ? 'usage' : 'audit')
  for (const row of rows) {
    const stamp = local(row.time)
    if (stamp.date < startDate! || stamp.date > endDate!) continue
    const hour = bucket === '4h' ? Math.floor(stamp.hour / 4) * 4 : stamp.hour
    const key = bucket === 'day' ? stamp.date : `${stamp.date}:${String(hour).padStart(2,'0')}`
    if ('api_type' in row) {
      if (row.status_code >= 300 || row.status_code === 202 || !contextTypes.includes(row.api_type as typeof contextTypes[number])) continue
      const item = values.get(key) ?? {date:stamp.date,hour,total:0,add_resource:0,add_skill:0,session_add_message:0,session_commit:0}
      item[row.api_type] = Number(item[row.api_type]) + 1
      item.total = Number(item.total) + 1
      values.set(key,item)
    } else {
      const item = values.get(key) ?? {date:stamp.date,total:0,embedding_input:0,vlm_input:0,vlm_output:0}
      for (const uid of usageTypes) {
        item[uid] = Number(item[uid]) + (row[uid] ?? 0)
        item.total = Number(item.total) + (row[uid] ?? 0)
      }
      values.set(key,item)
    }
  }
  return {enabled:true, start_date:startDate!,end_date:endDate!, bucket, items:[...values].sort(([a],[b]) => a.localeCompare(b)).map(([,item])=>item)}
}

function summary(ctx: WorkspaceContext, url: URL) {
  const timezone = url.searchParams.get('timezone')
  const now = calendar(timezone)(Date.now()).date
  const start = date(now)
  const local = calendar(timezone)
  let find = 0, search = 0
  for (const row of timeSeriesRows(ctx,start,start,'audit')) {
    if (!('api_type' in row) || row.status_code >= 300 || local(row.time).date !== now) continue
    if (row.api_type === 'find') find++
    if (row.api_type === 'search') search++
  }
  const totals = {embedding_input:0,vlm_input:0,vlm_output:0,total:0}
  for (const row of timeSeriesRows(ctx,start,start,'usage')) {
    if ('api_type' in row || local(row.time).date !== now) continue
    for (const uid of usageTypes) { totals[uid] += row[uid] ?? 0; totals.total += row[uid] ?? 0 }
  }
  const entries=new Filesystem(ctx).list('viking://',true)
  const counts={files:0,memories:0,skills:0,total:0}
  for(const entry of entries) {
    if(entry.is_dir)continue
    if(/^viking:\/\/(?:user\/[^/]+|agent\/[^/]+)\/memories\//u.test(entry.uri))counts.memories++
    else if(/\/skills\/[^/]+\/SKILL\.md$/u.test(entry.uri))counts.skills++
    else counts.files++
    counts.total++
  }
  return {enabled:true,context_counts:counts,today_retrievals:{find,search,total:find+search},today_tokens:totals,token_measurement:'provider_reported_only'}
}

function logs(ctx: WorkspaceContext, url: URL) {
  const qp = url.searchParams
  const numeric = (k:string,d:string,max:number) => {
    const value = qp.get(k) ?? d
    if (!/^\d{1,4}$/u.test(value) || Number(value) < 1 || Number(value)>max) throw bad('Invalid audit pagination.')
    return Number(value)
  }
  const page = numeric('page','1',2000), pageSize = numeric('page_size','10',100)
  const scope = membership(ctx), constraints = [scope.where], args: (string|number)[] = [...scope.args]
  const id = qp.get('request_id')
  if (id !== null) {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw bad('Invalid request ID.')
    constraints.push('request_id=?');args.push(id)
  }
  const split = (k:string)=> qp.getAll(k).flatMap(s=>s.split(',')).map(s=>s.trim()).filter(Boolean)
  const apiTypes = split('api_type')
  if (apiTypes.length > 20 || apiTypes.some(t=>!types.has(t))) throw bad('Invalid audit API filter.')
  if (apiTypes.length) { constraints.push(`api_type IN (${apiTypes.map(()=>'?').join(',')})`);args.push(...apiTypes) }
  const statuses = split('status'), alternatives: string[] = []
  if (statuses.length > 12) throw bad('Too many status filters.')
  for (const s of statuses) {
    if (s === 'success' || s === 'ok') alternatives.push('status_code<400')
    else if (s === 'error' || s === 'failed') alternatives.push('status_code>=400')
    else if (/^[2-5]xx$/u.test(s)) { alternatives.push('(status_code>=? AND status_code<?)'); const n=Number(s[0])*100; args.push(n,n+100) }
    else if (/^[1-5]\d\d$/u.test(s)) { alternatives.push('status_code=?'); args.push(Number(s)) }
    else throw bad('Invalid audit status filter.')
  }
  if (alternatives.length) constraints.push(`(${alternatives.join(' OR ')})`)
  const where=constraints.join(' AND ')
  const stat=ctx.sql.exec<{ total:number; success:number }>(`SELECT COUNT(*) AS total,COALESCE(SUM(status_code<400),0) AS success FROM ov_edge_audit WHERE ${where}`,...args).one()
  const items=ctx.sql.exec<Audit>(`SELECT request_id,account,user_id,time,method,route,api_type,status_code,duration_ms,error_code
    FROM ov_edge_audit WHERE ${where} ORDER BY time DESC,request_id DESC LIMIT ? OFFSET ?`,...args,pageSize,(page-1)*pageSize).toArray()
    .map(({time,account,...item})=>({...item, created_at:new Date(time).toISOString(),account_id:account}))
  return {enabled:true,items,page,page_size:pageSize,total:stat.total,total_pages:Math.ceil(stat.total/pageSize),success_rate:stat.total ? stat.success/stat.total : null}
}

const observerNames = ['queue','vikingdb','models','lock','retrieval','filesystem'] as const
function observe(ctx: WorkspaceContext, scope: string, format: string | null) {
  if (format !== null && format !== 'table' && format !== 'json') throw bad('Invalid observer format.')
  const membershipScope = membership(ctx)
  const totals = (kind: string) => ctx.sql.exec<{ n:number, failures:number }>(`SELECT COUNT(*) n, COALESCE(SUM(status_code>=400),0) failures
    FROM ov_edge_audit WHERE ${membershipScope.where} AND api_type=?`,...membershipScope.args,kind).one()
  const queue = jobCounts(ctx)
  const components = {
    queue: { name:'queue', is_healthy:true, has_errors:queue.failed>0, status:{...queue,driver:'durable-object-alarms'} },
    vikingdb: { name:'vikingdb', is_healthy:ctx.sql.exec<Count>('SELECT 1 n').one().n===1, has_errors:false, status:{driver:'durable-object-sqlite',index:'sqlite-vector-scan'} },
    models: { name:'models', is_healthy:null,has_errors:false,status:{embedding_binding:ctx.hasEmbedding ?? false,generation_binding:!!ctx.generate,probed:false} },
    lock: { name:'lock',is_healthy:true,has_errors:false,status:{driver:'sqlite-transactions',distributed_lock_count:null} },
    retrieval: { name:'retrieval',is_healthy:true,has_errors:false,status:{find:totals('find'),search:totals('search'),provider_quality_probed:false} },
    filesystem: { name:'filesystem',is_healthy:true,has_errors:false,status:{requests:totals('filesystem'),driver:'durable-object-sqlite'} },
  }
  const formatted = Object.fromEntries(Object.entries(components).map(([key,value])=>[key,{...value,
    status:format==='json'?value.status:JSON.stringify(value.status)}]))
  if (scope==='system') return {is_healthy:true,errors:[],components:formatted}
  return formatted[scope]
}

export function routeMetrics(request:Request,ctx:WorkspaceContext):Response {
  if(ctx.auditEnabled===false) return new Response('Prometheus metrics are disabled.\n',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}})
  if(!['GET','HEAD'].includes(request.method)) throw new ApiError(405,'METHOD_NOT_ALLOWED','Use GET to read metrics.')
  if(ctx.caller.role!=='admin') throw new ApiError(403,'PERMISSION_DENIED','Tenant administrator required to read metrics.')
  const rows=ctx.sql.exec<{status_code:number,n:number}>(`SELECT status_code,COUNT(*) AS n FROM ov_edge_audit
    WHERE account=? GROUP BY status_code ORDER BY status_code`,ctx.caller.accountId).toArray()
  const states=jobCounts(ctx)
  return new Response([
    '# HELP openviking_edge_retained_requests Count of retained requests in this tenant audit window.',
    '# TYPE openviking_edge_retained_requests gauge',
    ...rows.map(r=>`openviking_edge_retained_requests{status_code="${r.status_code}"} ${r.n}`),
    '# HELP openviking_edge_visible_tasks Tasks visible to this authorized account principal.',
    '# TYPE openviking_edge_visible_tasks gauge',
    ...Object.entries(states).map(([status,n])=>`openviking_edge_visible_tasks{status="${status}"} ${n}`), ''
  ].join('\n'),{headers:{'Content-Type':'text/plain; version=0.0.4; charset=utf-8'}})
}

export function routeObservability(request: Request, url: URL, ctx: WorkspaceContext): Response | undefined {
  const path = url.pathname
  if (!['GET','HEAD'].includes(request.method)) return undefined
  if (path.startsWith('/api/v1/observer/')) {
    const suffix = path.slice('/api/v1/observer/'.length)
    if (suffix !== 'system' && !observerNames.includes(suffix as typeof observerNames[number])) return undefined
    return ok(observe(ctx,suffix,url.searchParams.get('format')))
  }
  if (!['/api/v1/console/dashboard/summary','/api/v1/console/audit','/api/v1/console/tokens','/api/v1/console/context-commits'].includes(path)) return undefined
  if (ctx.auditEnabled === false) return ok({enabled:false,message:'Usage/Audit is disabled.'})
  if (path.endsWith('/dashboard/summary')) return ok(summary(ctx,url))
  if (path.endsWith('/audit')) return ok(logs(ctx,url))
  return ok(series(ctx,url,path.endsWith('/tokens')?'tokens':'contexts'))
}
