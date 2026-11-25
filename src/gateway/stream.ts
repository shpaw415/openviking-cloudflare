// SPDX-License-Identifier: AGPL-3.0-only
import type { Caller, GenerationStream, ModelMessage, WorkspaceContext } from '../context.js'
import type { AuthorityAdvance, AuthorityRevision } from '../data-authority.js'
import { GatewayError, encoder, safeError, within } from './contract.js'
import type { Protocol } from './contract.js'
import { credentialChanged, modelChanged } from './model-authority.js'
import type { Metrics } from './store.js'
import { generationPieces, streamTimeout, translateStreamFailure } from './sse-source.js'
import type { Finish, Usage } from './sse-source.js'
import { sseWire } from './sse-wire.js'
import type { ResponseMeta } from './wire.js'

const clientGone = () => new GatewayError(499, 'client_disconnected', 'The client cancelled the stream.')
const maxActive = 8, maxLifetime = 45_000
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const identifier = /^[A-Za-z0-9_-]{1,48}$/u

export type GatewayStreamActor = Pick<Caller, 'accountId' | 'userId' | 'agentId'>
const userKey = (actor: GatewayStreamActor) => `${actor.accountId}/${actor.userId}`
const actorKey = (actor: GatewayStreamActor) => `${userKey(actor)}/${actor.agentId}`
const cancellationKey = (id: string, actor: GatewayStreamActor) => `${actorKey(actor)}/${id}`

export class StreamRegistry {
  readonly #active = new Map<string, { actor: string; account: string; user: string; notify: (cause: GatewayError) => void; until: number; revision?: number; credentialRevision?: AuthorityRevision }>()
  readonly #cancelled = new Map<string, { user: string; until: number }>()

  constructor(private readonly limits = { tombstones: 256, perUser: 16, ttlMs: 60_000 }) {}

  #expire(now: number) {
    for (const [key, item] of this.#cancelled) if (item.until <= now) this.#cancelled.delete(key)
    for (const [id, item] of this.#active) if (item.until <= now) { this.#active.delete(id); item.notify(clientGone()) }
  }

  cancel(id: string, actor: GatewayStreamActor, now = Date.now()): void {
    if (typeof id !== 'string' || !uuid.test(id) || !actor ||
        ![actor.accountId, actor.userId, actor.agentId].every(value => typeof value === 'string' && identifier.test(value))) return
    this.#expire(now)
    const current = this.#active.get(id)
    if (current) {
      if (current.actor === actorKey(actor)) current.notify(clientGone())
      return
    }

    const key = cancellationKey(id, actor)
    if (this.#cancelled.has(key)) return // Retries never extend a marker or change its FIFO position.
    const user = userKey(actor)
    let oldestOwn: string | undefined
    let own = 0
    for (const [candidate, item] of this.#cancelled) if (item.user === user) {
      oldestOwn ??= candidate
      own++
    }
    // Agents belonging to one user share one allowance. At the workspace cap,
    // prefer its own oldest entry; otherwise recycle the oldest workspace entry.
    if (oldestOwn !== undefined && (own >= this.limits.perUser || this.#cancelled.size >= this.limits.tombstones)) {
      this.#cancelled.delete(oldestOwn)
    } else if (this.#cancelled.size >= this.limits.tombstones) {
      const oldest = this.#cancelled.keys().next().value
      if (oldest !== undefined) this.#cancelled.delete(oldest)
    }
    this.#cancelled.set(key, { user, until: now + this.limits.ttlMs })
  }

  admit(id: string, actor: GatewayStreamActor, now = Date.now()): void {
    this.#expire(now)
    if (this.#cancelled.has(cancellationKey(id, actor))) throw clientGone()
    if (this.#active.size >= maxActive || this.#active.has(id)) {
      throw new GatewayError(503, 'gateway_overloaded', 'The workspace streaming admission limit was reached.')
    }
  }

  register(id: string, actor: GatewayStreamActor, notify: (cause: GatewayError) => void, until: number, now = Date.now(), revision?: number,
    credentialRevision?: AuthorityRevision): () => void {
    this.admit(id, actor, now)
    const item = { actor: actorKey(actor), account: actor.accountId, user: actor.userId, notify, until, revision, credentialRevision }
    this.#active.set(id, item)
    return () => { if (this.#active.get(id) === item) this.#active.delete(id) }
  }

  invalidateModel(account: string, revision: number): void {
    for (const item of this.#active.values()) {
      if (item.account === account && item.revision !== undefined && item.revision < revision) item.notify(modelChanged())
    }
  }

  invalidateCredentials(account: string, advance: AuthorityAdvance): void {
    const members = advance.scope === 'members' ? new Map(advance.floors) : undefined
    for (const item of this.#active.values()) if (item.account === account && item.credentialRevision) {
      const retired = advance.scope === 'account' ? item.credentialRevision.account < advance.revision :
        item.credentialRevision.member < (members!.get(item.user) ?? 0)
      if (retired) item.notify(credentialChanged())
    }
  }

  invalidateRouting(account: string): void {
    for (const item of this.#active.values()) if (item.account === account) item.notify(modelChanged())
  }
}

const registries = new WeakMap<DurableObjectStorage, StreamRegistry>()

function registry(storage: DurableObjectStorage): StreamRegistry {
  let state = registries.get(storage)
  if (!state) { state = new StreamRegistry(); registries.set(storage, state) }
  return state
}

/** Binding-only notification. The trusted Worker supplies both its UUID and the admitted actor. */
export function cancelGatewayStream(storage: DurableObjectStorage, requestId: string, actor: GatewayStreamActor): void {
  registry(storage).cancel(requestId, actor)
}

export function checkStreamAdmission(storage: DurableObjectStorage, requestId: string, actor: GatewayStreamActor): void {
  registry(storage).admit(requestId, actor)
}

export function invalidateGatewayStreams(storage: DurableObjectStorage, account: string, revision: number): void {
  // Wake a blocked reader for prompt cancellation. Ordering still relies on
  // the durable Workspace fence, not on when this notification is delivered.
  registries.get(storage)?.invalidateModel(account, revision)
}

export function invalidateGatewayCredentials(storage: DurableObjectStorage, account: string, advance: AuthorityAdvance): void {
  registries.get(storage)?.invalidateCredentials(account, advance)
}

export function invalidateGatewayRouting(storage: DurableObjectStorage, account: string): void {
  registries.get(storage)?.invalidateRouting(account)
}

type StreamOptions = {
  request: Request; ctx: WorkspaceContext; messages: ModelMessage[]; maxTokens: number
  protocol: Protocol; model: string; note: string; includeUsage: boolean; metrics: Metrics
  source: GenerationStream; external: boolean
  textFilter?: (delta: string, final?: boolean) => string
  response?: ResponseMeta
  modelRevision?: number
  credentialRevision?: AuthorityRevision
  guard: () => void
  publish: (text: string, guard: () => void, snapshot?: unknown) => Promise<unknown>
  release: () => void
}

export async function streamTurn(options: StreamOptions): Promise<Response> {
  const { ctx, request, metrics } = options
  const started = Date.now(), lifecycle = new AbortController(), signal = lifecycle.signal
  const previousGuard = ctx.assertActive
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let finished = false, readerCancelled = false, lastCheck = 0, returned = false
  const requestSignal = request.signal
  const wire = sseWire(options.protocol, options.model, metrics.request_id, options.note, options.includeUsage, options.response, options.external)
  // Resume cleanup in the originating RPC's I/O context, not in the separate
  // notification RPC that observes the HTTP disconnect.
  let resolveDisconnect!: (cause?: GatewayError) => void
  const disconnect = new Promise<GatewayError | undefined>(resolve => { resolveDisconnect = resolve })
  const unregister = registry(ctx.storage).register(metrics.request_id, ctx.caller,
    resolveDisconnect, started + maxLifetime + 1000, started, options.modelRevision, options.credentialRevision)
  void disconnect.then(cause => { if (cause) fail(cause) })
  const since = () => Date.now() - started
  const fence = () => {
    if (signal.aborted) throw signal.reason
    if (since() >= maxLifetime) throw streamTimeout()
    options.guard()
  }

  function cancelReader() {
    if (!reader || readerCancelled) return
    readerCancelled = true
    const source = reader
    // Defensively release pending reads without allowing a non-cooperative
    // provider cancel() promise to pin the Gateway slot.
    void source.cancel().catch(() => {}).finally(() => { try { source.releaseLock() } catch { /* already released */ } })
  }

  function wait<T>(call: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  function finish(error?: GatewayError) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    requestSignal?.removeEventListener('abort', disconnected)
    unregister()
    resolveDisconnect()
    cancelReader()
    if (error) {
      lifecycle.abort(error)
      metrics.error_reason = error.code
      metrics.stream_error = error.code
      if (error.code === 'client_disconnected') { metrics.client_disconnected = true; metrics.status = 499 }
    } else if (ctx.assertActive === fence) ctx.assertActive = previousGuard
    metrics.duration_ms = since()
    if (returned) options.release()
  }

  function fail(error: GatewayError) {
    if (finished) return
    if (output && error.code !== 'client_disconnected') {
      try { output.enqueue(encoder.encode(wire.fail(error))); output.close() } catch { /* downstream closed */ }
    } else if (output) {
      try { output.error(error) } catch { /* downstream closed */ }
    }
    finish(error)
  }

  const timer = setTimeout(() => fail(streamTimeout()), maxLifetime)
  const disconnected = () => fail(clientGone())
  if (requestSignal?.aborted) disconnected()
  else requestSignal?.addEventListener('abort', disconnected, { once: true })
  ctx.assertActive = fence

  const reauthorize = async (always = false) => {
    fence()
    if (always || Date.now() - lastCheck >= 1000) {
      const verify = ctx.reauthorize?.()
      if (verify) await wait(verify)
      lastCheck = Date.now()
    }
    fence()
  }

  const emitSuccess = (out: ReadableStreamDefaultController<Uint8Array>, text: string, reason: Finish, usage: Usage) => {
    out.enqueue(encoder.encode(wire.finish(text, reason, usage)))
    out.close()
    finish()
  }

  try {
    await reauthorize(true)
    let source: ReadableStream<Uint8Array>
    try {
      source = await within(12_000, () => wait(options.source(options.messages, { maxTokens: options.maxTokens, signal }).then(stream => {
        // A late opening after client cancellation/timeout must not leave a live provider body.
        if (signal.aborted) { if (stream instanceof ReadableStream) void stream.cancel().catch(() => {}); throw signal.reason }
        return stream
      })), streamTimeout)
    } catch (error) { throw translateStreamFailure(error) }
    if (!(source instanceof ReadableStream) || source.locked) throw new GatewayError(503, 'generation_unavailable', 'The generation binding did not supply a readable stream.')
    reader = source.getReader()
    const pieces = generationPieces(reader, wait, options.external, options.textFilter)
    const first = await pieces.next()
    if (first.done || !('delta' in first.value)) throw new GatewayError(502, 'stream_incomplete', 'The generation stream supplied no text delta.')
    await reauthorize(true)
    const initial = first.value.delta
    let opening = true
    const stream = new ReadableStream<Uint8Array>({
      start(out) { output = out },
      async pull(out) {
        if (finished) return
        try {
          if (opening) {
            opening = false
            await reauthorize()
            fence()
            out.enqueue(encoder.encode(wire.opening() + wire.delta(initial)))
            metrics.first_chunk_ms = since()
            return
          }
          const current = await pieces.next()
          if (finished) return
          if (current.done) throw new GatewayError(502, 'stream_incomplete', 'The generation stream ended unexpectedly.')
          if ('delta' in current.value) {
            await reauthorize()
            fence()
            out.enqueue(encoder.encode(wire.delta(current.value.delta)))
            return
          }
          const { text, finish: reason, usage } = current.value
          cancelReader()
          await reauthorize(true)
          if (usage.inputTokens !== null) metrics.input_tokens = usage.inputTokens
          if (usage.outputTokens !== null) metrics.output_tokens = usage.outputTokens
          metrics.upstream_status = 200
          if (reason !== 'length' && reason !== 'content_filter') {
            await wait(options.publish(text, fence, options.response?.store ? wire.snapshot(text, usage) : undefined))
            await reauthorize(true)
          } else {
            metrics.capture_status = 'disabled'
            metrics.capture_reason = 'provider_incomplete'
          }
          fence()
          emitSuccess(out, text, reason, usage)
        } catch (error) { fail(safeError(error)) }
      },
      cancel() { finish(clientGone()) },
    }, { highWaterMark: 0 })
    const response = new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform', 'x-openviking-request-id': metrics.request_id,
      'x-openviking-recall': metrics.recall_reason ?? 'disabled' } })
    metrics.status = 200
    metrics.stream = true
    returned = true
    return response
  } catch (error) {
    const safe = safeError(error)
    finish(safe)
    throw safe
  }
}
