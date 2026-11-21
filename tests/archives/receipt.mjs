// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function recordBundle(t, dir) {
  const bytes = await readFile(join(dir, 'worker.mjs'))
  t.diagnostic(`Worker bundle SHA-256: ${createHash('sha256').update(bytes).digest('hex')}`)
}
