// SPDX-License-Identifier: AGPL-3.0-only
import type { Workspace } from './worker.js'
import type { JobAccess } from './tasks.js'
import type { AuthorityRevision, DataAuthority, DataAuthorityGrant } from './data-authority.js'
import type { UrlSource } from './url-source.js'
import type { WebSources } from './web/catalog.js'
import type { MemorySettings, RetrievalSettings } from './model-config.js'

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

export type Generation = (messages: ModelMessage[], options?: {
  maxTokens?: number; signal?: AbortSignal; reasoningEffort?: import('./model-config.js').ReasoningEffort
}) => Promise<{
  text: string
  inputTokens: number | null
  outputTokens: number | null
}>

export type StreamGenerationOptions = { maxTokens?: number; signal?: AbortSignal }
export type GenerationStream = (messages: ModelMessage[], options?: StreamGenerationOptions) => Promise<ReadableStream<Uint8Array>>

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
  OPENVIKING_EDGE_PROVIDERS?: string
  OPENVIKING_EDGE_OPERATOR_STREAMING?: string
  OPENVIKING_EDGE_GATEWAY_NATIVE?: string
  OPENVIKING_EDGE_GATEWAY_CAPABILITIES?: string
  OPENVIKING_EDGE_AUDIT?: string
  OPENVIKING_EDGE_TEXT_SOURCES?: string
  OPENVIKING_EDGE_MCP?: string
  OPENVIKING_EDGE_SESSION_RUNTIME?: string
  OPENVIKING_EDGE_PRIVACY_SCAN?: string
  OPENVIKING_EDGE_MCP_LIVE?: string
  OPENVIKING_EDGE_MEMORY_COMPILE?: string
  OPENVIKING_EDGE_COMPILE_SCHEDULES?: string
  OPENVIKING_EDGE_DOCUMENT_CONVERSION?: string
  OPENVIKING_EDGE_GATEWAY_TRANSFERS?: string
  OPENVIKING_EDGE_GATEWAY_TRANSFER_SECRET?: string
  OPENVIKING_EDGE_BACKUP_POLICY?: string
  OPENVIKING_EDGE_BACKUP_KEY?: string
  OPENVIKING_EDGE_INSTANCE_BACKUP?: string
  OPENVIKING_EDGE_INSTANCE_BACKUP_KEY?: string
  /** Optional operator-curated fetcher for admitted document URLs. */
  TEXT_SOURCE?: Fetcher
  /** Private, read-only service for pinned documentary snapshots. */
  WEB_SOURCE?: Fetcher
  OPENVIKING_EDGE_WEB_CATALOG?: string
  WEB_NATIVE_SOURCE?: Fetcher
  OPENVIKING_EDGE_WEB_NATIVE_CATALOG?: string
  AI?: Ai
}

export interface WorkspaceContext {
  sql: SqlStorage
  storage: DurableObjectStorage
  caller: Caller
  embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>
  generate?: Generation
  generateStream?: GenerationStream
  groups?: readonly string[]
  aclPrincipals?: { users: readonly string[], groups: readonly string[] }
  auditEnabled?: boolean
  hasEmbedding?: boolean
  embeddingModel?: string
  defaultSearchLimit?: number
  defaultSearchScore?: number
  useSearchSessionContext?: boolean
  retrievalSettings?: RetrievalSettings
  memorySettings?: MemorySettings
  /** Check the policy snapshot in the same transaction that seals a new archive. */
  assertArchiveSettingsCurrent?: () => void
  searchReranker?: { threshold: number; score: (query: string, documents: string[], signal: AbortSignal) => Promise<number[]> }
  /** Explicitly configured VLM, lazily fenced; context planning passes only the caller's query. */
  searchQueryGeneration?: (query: string, signal?: AbortSignal) => Promise<string | undefined>
  /** Operator-permitted digest, with a last-effect guard on exactly the selected bytes. */
  searchDigestGeneration?: (data: { query: string; rendered: string; max_bullets: number }, maxTokens: number,
    checkSelection: () => void, signal?: AbortSignal) => ReturnType<Generation> | Promise<undefined>
  remoteText?: { allows: (url: string) => boolean; read: (url: string) => Promise<string> }
  urlSource?: UrlSource
  webSources?: WebSources
  registerWatch?: (body: Record<string, unknown>) => Promise<Response | undefined>
  mcpMode?: string
  sessionRuntime?: boolean
  sessionReasoning?: boolean
  sessionIdleCredential?: string
  privacyScan?: boolean
  mcpLive?: boolean
  /** Same cancellation lifecycle as the authenticated incoming dispatch. */
  requestSignal?: AbortSignal
  /** Lazily reconstruct search mounts under the same authenticated direct identity. */
  prepareMcpSearch?: () => Promise<WorkspaceContext>
  /** Internal Data-to-MCP handoff: stage publication on the derived scope only. */
  deferSearchPublication?: (finish: () => void) => void
  /** Installed after the MCP tool result is successfully formatted. */
  publishMcpSearch?: () => void
  memoryCompile?: boolean
  compileAdvancedSchedule?: boolean
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
  /** Private binding path for operations requiring a model-independent Data lease. */
  loadDataAuthority?: (expected?: AuthorityRevision) => Promise<DataAuthorityGrant>
  dataAuthority?: DataAuthority
  /** Re-check managed credentials across an awaited provider call before publication. */
  reauthorize?: () => Promise<void>
}
