// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../context.js'
import { backupResponse, issuePermit, scopeFor, zipBuffer } from './backup-authority.js'
import type { Operation, Permit } from './backup-authority.js'
import type { Workspace } from '../worker.js'

/** Named RPC entrypoint only (no fetch). An independently provisioned service
 * binding is the operator capability. Never forward normal HTTP or API keys here. */
export class BackupOperator extends WorkerEntrypoint<Env> {
  async #call(account: unknown, op: Operation, invoke: (target: DurableObjectStub<Workspace>, permit: Permit) => Promise<Response>) {
    return backupResponse(async () => {
      const scope = scopeFor(this.env, account)
      return invoke(this.env.WORKSPACES.getByName(`openviking:account:${scope.account}`), await issuePermit(scope, op))
    })
  }

  capture(account: string, options?: unknown): Promise<Response> {
    return this.#call(account, 'capture', (target, permit) => target.captureBackup(permit, options))
  }

  evaluate(account: string, archive: ArrayBuffer, seal: string, options?: unknown): Promise<Response> {
    return this.#call(account, 'evaluate', (target, permit) => target.restoreBackup(permit, 'evaluate', zipBuffer(archive), seal, options))
  }

  apply(account: string, archive: ArrayBuffer, seal: string, options: unknown, approval: unknown): Promise<Response> {
    return this.#call(account, 'apply', (target, permit) => target.restoreBackup(permit, 'apply', zipBuffer(archive), seal, options, approval))
  }
}
