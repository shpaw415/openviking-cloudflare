// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceContext } from '../context.js'
import { ApiError, isRecord } from '../http.js'
import { SHARED_SKILLS, bool, denied, encoder, int, invalid, onlyKeys, pathFor, quota, str, unsupported } from '../fs/contract.js'
import type { FsPath } from '../fs/contract.js'

export const exampleRoot = 'viking://system/compile/example-skills'
// Native text recipes, not Runtime tool definitions. Nothing in a Skill package is executed.
export const recipes = new Map(Object.entries({
  'llm-wiki': 'Organize the evidence into a navigable Markdown wiki. Produce index.md and linked topic pages; call out unknowns and conflicts.',
  'knowledge-distillation': 'Write Markdown organized by cross-source findings, comparisons, drivers and uncertainties, not a list of document summaries.',
  'daily-report': 'Write a dated Markdown report of evidenced actions, decisions, blockers and next steps. Do not infer missing events or dates.',
  'ov-session-report': 'Summarize supplied session exports into Markdown with decisions, outcomes and unresolved questions. Never access other session data.',
}))

export function recipeMarkdown(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${description}\n`
}

export type Schedule = { frequency: 'daily' | 'weekly'; hour?: number; minute?: number; weekday?: number; timezone?:string; weekdays?:number[] }
export type Inputs = {
  from: string[]; to: string; skill: string; instruction: string | null; args: Record<string, unknown>
  auto_update: boolean; update_schedule: Schedule | null
}

export const compileName = (name: unknown): string => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_\p{Script=Han}][A-Za-z0-9_\p{Script=Han}-]*$/u.test(name) ||
      /\s/u.test(name) || [...name].length > (/[^\x00-\x7f]/u.test(name) ? 32 : 64)) invalid('Invalid compile_name.')
  return name
}

export function submissionKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:._-]{16,128}$/u.test(value)) invalid('Invalid Idempotency-Key.')
  return value
}

export function actorScope(ctx: WorkspaceContext): [string, string, string] {
  return [ctx.caller.accountId, ctx.caller.userId, ctx.caller.agentId]
}

const isSubtree = (uri: string, root: string) => uri === root || uri.startsWith(root + '/')
export const overlap = (a: string, b: string): boolean => isSubtree(a, b) || isSubtree(b, a)
export const rulesRoot = ({ caller }: WorkspaceContext): string => `viking://user/${caller.userId}/memories/rules`

export function sourcePath(value: unknown, ctx: WorkspaceContext, rule = false): FsPath {
  const path = pathFor(str(value, 'source URI', undefined, 2048).trim(), ctx.caller)
  const [root, second, third, fourth] = path.parts
  if (root === 'resources' && second || root === 'user' && third === 'resources' && fourth) return path
  if (!rule && (root === 'agent' && second && !path.managed || root === 'user' && third === 'memories' &&
      fourth && !['rules', 'experiences'].includes(fourth))) return path
  return invalid(rule ? 'Rule sources must be existing resources.' : 'Compile sources must be resource or ordinary memory directories.')
}

export function targetPath(value: unknown, ctx: WorkspaceContext): FsPath & { space: string } {
  if (typeof value === 'string' && /^viking:\/\/(?:~\/|user\/[^/]+\/|agent\/)skills(?:\/|$)/u.test(value.trim())) {
    unsupported('Compile does not install generated Skills.')
  }
  const path = sourcePath(value, ctx)
  if (path.space === null || path.builtin || path.managed || path.parts.some(part => part.startsWith('.')) ||
      (path.kind === 'memory' && path.parts.length < 5)) invalid('Expected a non-reserved output directory.')
  return path as FsPath & { space: string }
}

export function skillUri(value: unknown, ctx: WorkspaceContext): string {
  const uri = str(value, 'skill', undefined, 1024).trim().replace(/\/$/u, '').replace(/\/SKILL\.md$/u, '')
  if (uri === 'memory') unsupported('In-place memory consolidation is not implemented by the text compiler.')
  if (uri.startsWith(exampleRoot + '/')) {
    if (!recipes.has(uri.slice(exampleRoot.length + 1))) throw new ApiError(404, 'NOT_FOUND', 'Compile Skill not found.')
    return uri
  }
  const path = pathFor(uri, ctx.caller)
  const [root, second, third] = path.parts
  if (!(root === 'agent' && second === 'skills' && path.parts.length === 3 ||
        root === 'user' && third === 'skills' && path.parts.length === 4)) invalid('Select an installed Skill or its SKILL.md.')
  return path.uri
}

function checkedArgs(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (!isRecord(value)) invalid('args must be an object.')
  let nodes = 0
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 128 || depth > 6) quota('Compile args exceed the nesting or entry limit.')
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1))
    if (isRecord(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => {
        if (/password|credential|secret|authorization|api.?key|access.?token|private.?key/i.test(key)) {
          unsupported('Private execution arguments are not supported by the edge compiler.')
        }
        if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 128) invalid('Invalid Compile argument name.')
        return [key, visit(item[key], depth + 1)]
      }))
    }
    if (typeof item === 'number' && !Number.isFinite(item)) invalid('Non-finite Compile argument.')
    if (typeof item === 'string') str(item, 'argument', undefined, 2048)
    return item
  }
  const args = visit(value, 0) as Record<string, unknown>
  if (encoder.encode(JSON.stringify(args)).length > 2048) quota('Compile args exceed 2048 bytes.')
  return args
}

function scheduleOf(value: unknown, advanced: boolean): Schedule | null {
  if (value == null) return null
  if (advanced && (typeof value==='string' || isRecord(value) &&
      ['cron','rrule','expression','timezone','weekdays'].some(key=>Object.hasOwn(value,key)))) return advancedSchedule(value)
  if (typeof value === 'string' || isRecord(value) &&
      (typeof value.frequency === 'string' && !['daily', 'weekly'].includes(value.frequency) ||
       ['cron', 'expression', 'timezone', 'tz', 'rrule'].some(key => Object.hasOwn(value, key)))) {
    unsupported('Only daily and weekly Beijing-time schedules are portable; cron, RRULE and custom time zones are not supported.')
  }
  if (!isRecord(value) || value.frequency !== 'daily' && value.frequency !== 'weekly') invalid('Invalid update_schedule.')
  const { frequency } = value
  onlyKeys(value, frequency === 'daily' ? 'frequency hour minute' : 'frequency hour minute weekday')
  return {
    frequency,
    ...(value.hour !== undefined && { hour: int(value.hour, 'hour', 0, 0, 23) }),
    ...(value.minute !== undefined && { minute: int(value.minute, 'minute', 0, 0, 59) }),
    ...(value.weekday !== undefined && { weekday: int(value.weekday, 'weekday', 1, 1, 7) }),
  }
}

function advancedSchedule(input:unknown):Schedule {
  const value=isRecord(input)?input:typeof input==='string' && input.startsWith('RRULE:')?{rrule:input}:{cron:input}
  onlyKeys(value,'frequency cron expression rrule timezone weekday weekdays hour minute')
  const tz=value.timezone??'Asia/Shanghai'
  if (typeof tz!=='string'||tz.length>64||!(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/u.test(tz)||tz==='UTC')) invalid('Expected a named IANA timezone.')
  try { new Intl.DateTimeFormat('en',{timeZone:tz}) } catch { invalid('Unknown IANA timezone.') }
  const clock=(v:unknown,field:string,max:number)=>int(v,field,0,0,max)
  if (value.cron!==undefined||value.expression!==undefined||value.rrule!==undefined) {
    if (['weekday','weekdays','minute','hour'].some(k=>Object.hasOwn(value,k))) invalid('Conflicting recurrence fields.')
    const raw = value.cron ?? value.expression
    if (raw!==undefined) {
      if (value.cron!==undefined&&value.expression!==undefined||value.rrule!==undefined||
          value.frequency!==undefined&&value.frequency!=='cron'||typeof raw!=='string'||raw.length>100) invalid('Invalid cron definition.')
      const m=/^([0-9]{1,2}) ([0-9]{1,2}) \* \* (\*|[0-7](?:,[0-7]){0,6})$/u.exec(raw.trim())
      if (!m) invalid('Cron accepts fixed minute/hour, wildcard day/month, and wildcard or a weekday list.')
      const weekdays=m[3]==='*'?undefined:[...new Set(m[3].split(',').map(d=>Number(d)||7))].sort()
      return {frequency:weekdays?'weekly':'daily',minute:clock(Number(m[1]),'minute',59),hour:clock(Number(m[2]),'hour',23),timezone:tz,
        ...(weekdays&&{weekdays,weekday:weekdays[0]})}
    }
    if (typeof value.rrule!=='string'||value.rrule.length>150||value.frequency!==undefined&&value.frequency!=='rrule') invalid('Invalid RRULE definition.')
    const fields=new Map<string,string>()
    for (const part of value.rrule.replace(/^RRULE:/u,'').split(';')) {
      const match=/^(FREQ|BYDAY|BYHOUR|BYMINUTE|INTERVAL)=([A-Z0-9,]+)$/u.exec(part)
      if (!match||fields.has(match[1])) invalid('Unsupported or duplicate RRULE field.')
      fields.set(match[1],match[2])
    }
    const frequency=fields.get('FREQ'), days=fields.get('BYDAY'), hour=fields.get('BYHOUR'), minute=fields.get('BYMINUTE')
    if (!['DAILY','WEEKLY'].includes(frequency??'') || (fields.get('INTERVAL')??'1')!=='1'||
        !/^\d{1,2}$/u.test(hour??'')||!/^\d{1,2}$/u.test(minute??'')||
        (frequency==='WEEKLY'?!days||! /^(?:MO|TU|WE|TH|FR|SA|SU)(?:,(?:MO|TU|WE|TH|FR|SA|SU)){0,6}$/u.test(days):days!==undefined)) invalid('Invalid bounded RRULE.')
    const weekdays=days?[...new Set(days.split(',').map(d=>['MO','TU','WE','TH','FR','SA','SU'].indexOf(d)+1))].sort():undefined
    return {frequency:frequency==='WEEKLY'?'weekly':'daily',hour:clock(Number(hour),'hour',23),minute:clock(Number(minute),'minute',59),
      timezone:tz,...(weekdays&&{weekdays,weekday:weekdays[0]})}
  }
  if (value.frequency!=='daily'&&value.frequency!=='weekly') invalid('Invalid bounded schedule frequency.')
  const days=value.weekdays
  if (days!==undefined && (value.frequency!=='weekly'||!Array.isArray(days)||!days.length||days.length>7||
      days.some(d=>typeof d!=='number'||!Number.isInteger(d)||d<1||d>7))) invalid('Invalid weekly day list.')
  if (value.frequency==='daily'&&value.weekday!==undefined) invalid('Daily schedules cannot select a weekday.')
  return {frequency:value.frequency,timezone:tz,...(value.hour!==undefined&&{hour:clock(value.hour,'hour',23)}),
    ...(value.minute!==undefined&&{minute:clock(value.minute,'minute',59)}),
    ...(value.weekday!==undefined&&{weekday:int(value.weekday,'weekday',1,1,7)}),
    ...(Array.isArray(days)&&{weekdays:[...new Set(days as number[])].sort()})}
}

export function checkOwner(value: unknown, ctx: WorkspaceContext): void {
  if (value === undefined) return
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/u.test(value)) invalid('Invalid args.owner_user_id.')
  if (value !== ctx.caller.userId) denied('Delegated Compile configurations are not available on this Worker.')
}

function checkVisibility(dest: FsPath, source: FsPath): void {
  // This is an information-flow check in addition to ACLs. Shared destinations are
  // further checked against shared source ACLs at admission and in the commit fence.
  if (source.space === SHARED_SKILLS) return
  if (dest.space === 'shared' && source.space !== 'shared' || source.parts[0] === 'agent' && dest.parts[0] !== 'agent') {
    denied('Compile cannot publish inputs to a broader visibility scope.')
  }
}

export function parseInputs(body: Record<string, unknown>, ctx: WorkspaceContext,
  mode: 'create' | 'update' | 'execute', saved?: Inputs): Inputs {
  onlyKeys(body, 'from from_ to skill instruction args' + (mode === 'execute' ? '' : ' compile_name') +
    (mode === 'update' ? ' auto_update update_schedule updated_by' : ''))
  const list: unknown = body.from ?? body.from_
  if (!Array.isArray(list) || !list.length || list.length > 8 || body.from !== undefined && body.from_ !== undefined) {
    invalid('from must contain one to eight source directories.')
  }
  const target = targetPath(body.to ?? saved?.to, ctx)
  if (saved && target.uri !== saved.to) invalid('to must match the saved configuration directory.')
  const sources = list.map(source => sourcePath(source, ctx))
  sources.forEach(source => {
    if (overlap(target.uri, source.uri)) invalid('Compile sources and destination must not overlap.')
    checkVisibility(target, source)
  })
  const skill = skillUri(body.skill, ctx)
  if (!skill.startsWith(exampleRoot + '/')) checkVisibility(target, pathFor(skill, ctx.caller))
  const args = checkedArgs(body.args)
  if (['cron', 'crontab', 'rrule'].some(key => Object.hasOwn(args, key))) {
    unsupported('Cron, crontabs and RRULE are not supported; use a named daily or weekly Compile schedule.')
  }
  if (['mode', 'changes', 'last_compile_time'].some(key => Object.hasOwn(args, key))) {
    invalid('Compile execution controls are server-owned.')
  }
  if (Object.hasOwn(args, 'owner_user_id')) {
    if (mode === 'execute') invalid('args.owner_user_id requires compile_name.')
    checkOwner(args.owner_user_id, ctx)
    delete args.owner_user_id
  }
  if (mode !== 'create' && (Object.hasOwn(args, 'auto_update') || Object.hasOwn(args, 'update_schedule'))) {
    invalid('Use Compile configuration scheduling fields, not execution arguments.')
  }
  if (mode === 'update' && !Object.hasOwn(body, 'auto_update')) invalid('auto_update is required.')
  const schedule = scheduleOf(mode === 'update' ? body.update_schedule ?? saved?.update_schedule : args.update_schedule,!!ctx.compileAdvancedSchedule)
  const enabled = bool(mode === 'update' ? body.auto_update : args.auto_update, 'auto_update', !!schedule && mode === 'create')
  if (enabled && !schedule) invalid('update_schedule is required when auto_update is true.')
  delete args.auto_update
  delete args.update_schedule
  const from = [...new Set(sources.map(source => source.uri))]
  if (encoder.encode(JSON.stringify({ from, to: target.uri, skill })).length > 3000) quota('Compile paths exceed 3000 bytes.')
  const instruction = body.instruction == null ? null : str(body.instruction, 'instruction', undefined, 4096).trim() || null
  return { from, to: target.uri, skill, instruction, args, auto_update: enabled, update_schedule: schedule }
}

export function paging(query: URLSearchParams): { limit: number; cursor: string | null } {
  const raw = query.get('limit') ?? '20'
  if (!/^\d{1,3}$/u.test(raw)) invalid('Invalid limit.')
  const limit = int(Number(raw), 'limit', 20, 1, 100)
  const cursor = query.get('cursor')
  if (cursor != null && (!cursor || cursor.length > 1024 || /\p{Cc}/u.test(cursor))) invalid('Invalid cursor.')
  return { limit, cursor }
}

export async function sha256(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
