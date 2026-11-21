// SPDX-License-Identifier: AGPL-3.0-only
import type { Workspace } from './worker.js'
import type { JobAccess } from './tasks.js'

export interface Caller {
  accountId: string
  userId: string
  agentId: string
  role: 'admin' | 'user'
}

export type ControlCaller = Omit<Caller, 'role'> & { role: Caller['role'] | 'root' }

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type Generation = (messages: ModelMessage[], options?: { maxTokens?: number }) => Promise<{
  text: string
  inputTokens: number | null
  outputTokens: number | null
}>

export type GenerationStream = (messages: ModelMessage[], options?: { maxTokens?: number; signal?: AbortSignal }) => Promise<ReadableStream<Uint8Array>>

export interface Env {
  ASSETS?: Fetcher
  WORKSPACES: DurableObjectNamespace<Workspace>
  CONTROL?: DurableObjectNamespace
  OAUTH?: DurableObjectNamespace
  OPENVIKING_OAUTH_ISSUER?: string
  OPENVIKING_OAUTH_CLIENTS?: string
  OPENVIKING_EDGE_OIDC?: string
  OPENVIKING_EDGE_KEYS?: string
  OPENVIKING_EDGE_GENERATION?: string
  OPENVIKING_EDGE_AUDIT?: string
  OPENVIKING_EDGE_TEXT_SOURCES?: string
  OPENVIKING_EDGE_MCP?: string
  OPENVIKING_EDGE_DOCUMENT_CONVERSION?: string
  /** Optional operator-curated fetcher for admitted document URLs. */
  TEXT_SOURCE?: Fetcher
  AI?: Ai
}

export interface WorkspaceContext {
  sql: SqlStorage
  storage: DurableObjectStorage
  caller: Caller
  embed: (texts: string[]) => Promise<number[][]>
  generate?: Generation
  generateStream?: GenerationStream
  groups?: readonly string[]
  aclPrincipals?: { users: readonly string[], groups: readonly string[] }
  auditEnabled?: boolean
  hasEmbedding?: boolean
  remoteText?: { allows: (url: string) => boolean; read: (url: string) => Promise<string> }
  registerWatch?: (body: Record<string, unknown>) => Promise<Response | undefined>
  mcpMode?: string
  compileExampleSkills?: readonly { name:string; description:string; content:string; uri?:string }[]
  compileScheduleCredential?: string
  sessionSearchContext?: (id:string)=>{text:string,usedMessages:number}
  convertDocument?: (file: File) => Promise<{ filename: string; content: string } | undefined>
  /** A persistently scheduled operation, not an in-isolate promise. */
  jobs?: JobAccess
  taskId?: string
  gatewayRequestId?: string
  /** Only call within the synchronous SQLite transaction publishing job results. */
  finishJobInTransaction?: (result: unknown) => void
  /** Synchronous persistence fence for a cancellable operation. */
  assertActive?: () => void
  /** Re-check managed credentials across an awaited provider call before publication. */
  reauthorize?: () => Promise<void>
}
