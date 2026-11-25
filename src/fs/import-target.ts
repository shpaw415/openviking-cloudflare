// SPDX-License-Identifier: AGPL-3.0-only
import { encoder, exists, fromParts, missing, writable, conflict } from './contract.js'
import type { FsPath } from './contract.js'
import { ACCOUNT_ENTRIES } from './store.js'
import type { Filesystem } from './store.js'

export function ensureParentPlan(fs: Filesystem, parent: FsPath, create: boolean) {
  const dirs: Array<FsPath & { space: string }> = []
  let anchor = parent
  for (;;) {
    const row = fs.entry(anchor, 'write')
    if (row) {
      if (!row.is_dir) conflict('A parent path is not a directory.')
      return { anchor, revision: row.revision, dirs: dirs.reverse() }
    }
    if (!create) missing()
    writable(anchor, fs.caller)
    dirs.push(anchor)
    anchor = fs.parent(anchor)
  }
}

/** Shared with staged uploads. An ACL refusal at a candidate leaf is not a license to inspect it. */
export function nextResourceLeaf(fs: Filesystem, parent: FsPath, name: string) {
  const dot = name.lastIndexOf('.')
  const ext = name.slice(dot)
  for (let suffix = 0; suffix <= ACCOUNT_ENTRIES; suffix++) {
    const ending = `_${suffix}${ext}`
    const stem = Array.from(name.slice(0, dot))
    while (encoder.encode(stem.join('') + ending).length > 160) stem.pop()
    const leaf = suffix ? stem.join('') + ending : name
    const path = fromParts([...parent.parts, leaf], fs.caller)
    writable(path, fs.caller)
    if (!fs.entry(path, 'write')) return { path, warning: suffix ? `Name already used; imported as ${leaf}.` : undefined }
  }
  return exists()
}
