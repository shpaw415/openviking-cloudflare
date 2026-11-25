// SPDX-License-Identifier: AGPL-3.0-only
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Env } from '../context.js'
import type { Control } from '../control.js'
import { backupResponse } from './backup-authority.js'
import { captureProfile, controlName, instanceKey, instanceMount, instancePermit, refused } from './instance-authority.js'
import type { ControlCommand } from './instance-authority.js'
import { zipInput } from './instance-codec.js'

/** Named service RPC only: never attach a route, fetch proxy, API key or OAuth grant. */
export class InstanceBackupOperator extends WorkerEntrypoint<Env> {
  identify(): Promise<Response> {
    return backupResponse(async () => {
      instanceKey(this.env)
      if (!this.env.CONTROL) return refused()
      return Response.json({ status: 'ok', result: { control: this.env.CONTROL.idFromName(controlName).toString() } },
        { headers: { 'cache-control': 'private, no-store' } })
    })
  }

  #call(command: ControlCommand, bytes?: ArrayBuffer, arg?: unknown): Promise<Response> {
    return backupResponse(async () => {
      const mount = instanceMount(this.env)
      if (command === 'capture') captureProfile(arg)
      if (command !== 'capture' && command !== 'status') zipInput(bytes)
      const control = this.env.CONTROL!.getByName(controlName) as DurableObjectStub<Control>
      const response = await control.instanceArchive(command, await instancePermit(mount, command), bytes, arg)
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'private, no-store')
      return new Response(response.body, { status: response.status, headers })
    })
  }

  capture(profile?: string) { return this.#call('capture', undefined, profile) }
  status() { return this.#call('status') }
  evaluate(bytes: ArrayBuffer) { return this.#call('evaluate', bytes) }
  begin(bytes: ArrayBuffer, approval: unknown) { return this.#call('begin', bytes, approval) }
  step(bytes: ArrayBuffer, index: number) { return this.#call('step', bytes, index) }
  release(bytes: ArrayBuffer) { return this.#call('release', bytes) }
}
