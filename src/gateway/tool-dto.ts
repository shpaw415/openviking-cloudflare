// SPDX-License-Identifier: AGPL-3.0-only
import { isRecord } from '../http.js'
import { GatewayError, bytes, fields, invalid, record, unsupported } from './contract.js'
import type { Protocol } from './contract.js'

type Scalar = string | number | boolean | null
type Schema = ({ type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: false } |
  { type: 'array'; items: Schema } |
  { type: 'string' | 'number' | 'integer' | 'boolean' | 'null'; enum?: Scalar[] }) & { description?: string }
type FunctionTool = { type: 'function'; function: { name: string; description?: string; parameters: Schema; strict?: boolean } }
export type Call = { id: string; name: string; args: Record<string, unknown>; arguments: string }
type Choice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }
export type ToolRules = { tools: FunctionTool[]; choice?: Choice; parallel?: boolean }
export const maxCalls = 4, maxArgumentBytes = 8 * 1024, maxToolPayload = 24 * 1024
const ident = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
export const callId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export const wellFormed = (value: unknown): value is string => typeof value === 'string' && !/\p{Cs}/u.test(value)
const accepts = (type: string, value: unknown) => type === 'null' ? value === null : type === 'integer' ? Number.isSafeInteger(value) :
  type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type
const bad = () => invalid('Invalid or unsupported typed function declaration.', 'tool_declaration_invalid')
export const badHistory = () => invalid('Expected matching, declared function calls and results in the supplied history.', 'tool_history_invalid')
export const toolOutputError = () => new GatewayError(502, 'tool_call_invalid', 'The provider did not return a valid declared function call.')
export const toolsUnsupported = () => unsupported('Client function tools are not available on this model or endpoint.', 'tools_unsupported')

function description(value: unknown, max: number) {
  if (!wellFormed(value) || bytes(value) > max) throw bad()
  return value
}

function schema(input: unknown, budget: { left: number }, depth: number, strict: boolean): Schema {
  if (--budget.left < 0 || depth > 5) throw bad()
  const node = record(input, bad)
  const data = node.description === undefined ? {} : { description: description(node.description, 256) }
  if (node.type === 'object') {
    fields(node, ['type', 'properties', 'required', 'additionalProperties', 'description'], bad)
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) throw bad()
    const pairs = Object.entries(node.properties === undefined ? {} : record(node.properties, bad))
    const required: unknown = node.required === undefined ? [] : node.required
    const names = new Set(pairs.map(([key]) => key))
    if (pairs.length > 24 || pairs.some(([key]) => !ident(key) || Object.hasOwn(Object.prototype, key)) ||
        !Array.isArray(required) || required.length > pairs.length || required.some(x => !names.has(x)) ||
        new Set(required).size !== required.length || strict && required.length !== pairs.length) throw bad()
    return { type: 'object', properties: Object.fromEntries(pairs.map(([k, s]) => [k, schema(s, budget, depth + 1, strict)])),
      required, additionalProperties: false, ...data }
  }
  if (node.type === 'array') {
    fields(node, ['type', 'items', 'description'], bad)
    return { type: 'array', items: schema(node.items, budget, depth + 1, strict), ...data }
  }
  const type = node.type
  if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean' && type !== 'null') throw bad()
  fields(node, ['type', 'enum', 'description'], bad)
  const values = node.enum
  if (values === undefined) return { type, ...data }
  if (!Array.isArray(values) || !values.length || values.length > 16 || new Set(values).size !== values.length ||
      values.some(value => !accepts(type, value) || typeof value === 'string' && (!wellFormed(value) || bytes(value) > 128))) throw bad()
  return { type, enum: values, ...data }
}

export function toolRules(raw: Record<string, unknown>, protocol: Protocol, enabled: boolean): ToolRules {
  const input = raw.tools, rawChoice = raw.tool_choice
  const noChoice = rawChoice === undefined || rawChoice === 'none'
  if (!enabled && (input !== undefined && (!Array.isArray(input) || input.length) || !noChoice || raw.parallel_tool_calls !== undefined)) throw toolsUnsupported()
  if (input !== undefined && (!Array.isArray(input) || input.length > 8)) throw bad()
  const seen = new Set<string>(), budget = { left: 128 }
  const tools: FunctionTool[] = ((input as unknown[] | undefined) ?? []).map(item => {
    const wrapper = record(item, bad)
    let spec = wrapper
    if (protocol === 'chat') {
      fields(wrapper, ['type', 'function'], bad)
      spec = record(wrapper.function, bad)
    }
    if (protocol !== 'anthropic' && wrapper.type !== 'function') throw toolsUnsupported()
    fields(spec, protocol === 'anthropic' ? ['name', 'description', 'input_schema'] :
      [...(protocol === 'responses' ? ['type'] : []), 'name', 'description', 'parameters', 'strict'], bad)
    const { name, strict } = spec
    if (!ident(name) || seen.has(name) || strict !== undefined && typeof strict !== 'boolean') throw bad()
    seen.add(name)
    const parameters = schema(protocol === 'anthropic' ? spec.input_schema : spec.parameters, budget, 0, strict === true)
    if (parameters.type !== 'object') throw bad()
    return { type: 'function', function: { name, parameters, ...(spec.description !== undefined && { description: description(spec.description, 512) }),
      ...(strict !== undefined && { strict }) } }
  })
  if (bytes(JSON.stringify(tools)) > 16 * 1024) throw new GatewayError(413, 'tool_limit', 'Function declarations exceed their budget.')
  let parallel: boolean | undefined
  if (raw.parallel_tool_calls !== undefined) {
    if (protocol === 'anthropic' || typeof raw.parallel_tool_calls !== 'boolean') throw bad()
    parallel = raw.parallel_tool_calls
  }
  let choice: Choice | undefined
  if (rawChoice !== undefined) {
    if (rawChoice === 'none' || protocol !== 'anthropic' && (rawChoice === 'auto' || rawChoice === 'required')) choice = rawChoice
    else {
      const value = record(rawChoice, bad)
      if (protocol === 'anthropic') {
        fields(value, ['type', ...(value.type === 'tool' ? ['name'] : []), 'disable_parallel_tool_use'], bad)
        if (value.disable_parallel_tool_use !== undefined) {
          if (value.type === 'none' || typeof value.disable_parallel_tool_use !== 'boolean') throw bad()
          parallel = !value.disable_parallel_tool_use
        }
        if (value.type === 'auto' || value.type === 'none') choice = value.type
        else if (value.type === 'any') choice = 'required'
        else if (value.type === 'tool' && ident(value.name) && seen.has(value.name)) choice = { type: 'function', function: { name: value.name } }
        else throw bad()
      } else {
        fields(value, protocol === 'chat' ? ['type', 'function'] : ['type', 'name'], bad)
        const spec = protocol === 'chat' ? record(value.function, bad) : value
        if (protocol === 'chat') fields(spec, ['name'], bad)
        if (value.type !== 'function' || !ident(spec.name) || !seen.has(spec.name)) throw bad()
        choice = { type: 'function', function: { name: spec.name } }
      }
    }
  }
  if (!tools.length && (choice !== undefined && choice !== 'none' || parallel !== undefined)) throw bad()
  return { tools, choice, parallel }
}

function matches(node: Schema, value: unknown): boolean {
  if (node.type === 'object') return isRecord(value) && node.required.every(key => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(node.properties, key) && matches(node.properties[key], item))
  if (node.type === 'array') return Array.isArray(value) && value.length <= 32 && value.every(item => matches(node.items, item))
  return accepts(node.type, value) && (typeof value !== 'string' || wellFormed(value)) && (!node.enum || node.enum.includes(value as Scalar))
}

export function outputSchema(input: unknown) {
  const parsed = schema(input, { left: 128 }, 0, true)
  if (parsed.type !== 'object' || bytes(JSON.stringify(parsed)) > 16 * 1024) throw bad()
  return parsed
}

function visitStrings(value: unknown, secret: (value: string) => void): void {
  if (typeof value === 'string') secret(value)
  else if (Array.isArray(value)) value.forEach(item => visitStrings(item, secret))
  else if (isRecord(value)) Object.entries(value).forEach(([key, child]) => { secret(key); visitStrings(child, secret) })
}

export function matchesOutput(node: Schema, text: string, secret: (value: string) => void): boolean {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return false }
  if (!matches(node, parsed)) return false
  visitStrings(parsed, secret)
  return true
}

export function readCall(rules: ToolRules, id: unknown, name: unknown, args: unknown, encoded: boolean,
  failure: () => GatewayError = badHistory): Call {
  const tool = rules.tools.find(tool => tool.function.name === name)
  if (!callId(id) || !tool) throw failure()
  let value: unknown = args
  if (encoded) {
    if (!wellFormed(args) || bytes(args) > maxArgumentBytes) throw failure()
    try { value = JSON.parse(args) } catch { throw failure() }
  }
  if (!isRecord(value) || !matches(tool.function.parameters, value)) throw failure()
  const canonical = JSON.stringify(value)
  if (bytes(canonical) > maxArgumentBytes) throw failure()
  return { id, name: tool.function.name, args: value, arguments: canonical }
}

export function validateCalls(calls: Call[], finish: string, rules: ToolRules, existing: ReadonlySet<string>, secret: (value: string) => void, text: string) {
  const selected = typeof rules.choice === 'object' ? rules.choice.function.name : undefined
  if ((calls.length > 0) !== (finish === 'tool_calls') || calls.length > (rules.parallel === false ? 1 : maxCalls) ||
      calls.length && rules.choice === 'none' || finish === 'stop' && !calls.length && (selected || rules.choice === 'required')) throw toolOutputError()
  const ids = new Set(existing)
  let amount = 0
  for (const call of calls) {
    if (ids.has(call.id) || selected !== undefined && call.name !== selected) throw toolOutputError()
    ids.add(call.id)
    amount += bytes(call.arguments)
    if (amount > maxToolPayload) throw toolOutputError()
    secret(call.id)
    secret(call.name)
    secret(call.arguments)
    // Also check JSON-decoded string leaves; neither JSON escaping nor a split
    // SSE field may conceal a provider credential in a client-visible call.
    visitStrings(call.args, secret)
  }
  if (calls.length) secret(text + calls.map(call => call.id + call.name + call.arguments).join(''))
}

export const chatCall = (call: Call) => ({ id: call.id, type: 'function' as const,
  function: { name: call.name, arguments: call.arguments } })
export const messagesCall = (call: Call) => ({ type: 'tool_use' as const, id: call.id, name: call.name, input: call.args })
export const responsesCall = (call: Call, nonce: string, index: number) => ({ type: 'function_call' as const, id: `fc_${nonce}_${index}`,
  call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' as const })
