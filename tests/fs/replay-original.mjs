// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const runner = fileURLToPath(new URL('./original-contract.py', import.meta.url))
const admitted = new Map([
  ['/api/v1/fs/ls', new Set(['GET'])], ['/api/v1/content/batch-write', new Set(['POST'])],
  ['/api/v1/content/read', new Set(['GET'])], ['/api/v1/system/wait', new Set(['POST'])],
  ['/api/v1/search/find', new Set(['POST'])], ['/api/v1/skills', new Set(['GET', 'POST'])],
  ['/api/v1/skills/validate', new Set(['POST'])],
])

export async function replayOriginal(api, family, name, root = '') {
  const child = spawn('python3', ['-I', '-B', runner, family, name, root], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let errors = '', requests = 0
  child.stderr.setEncoding('utf8').on('data', chunk => { if (errors.length < 8192) errors += chunk })
  const completed = once(child, 'close')
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const { path, method, query, body } = JSON.parse(line)
      assert(++requests <= 16 && admitted.get(path)?.has(method), 'Only the local admitted fixtures are replayable')
      const response = await api(path.slice('/api/v1'.length), { method, query, body: body ?? undefined })
      const text = await response.text()
      assert(Buffer.byteLength(text) < 96 * 1024)
      child.stdin.write(JSON.stringify({ status_code: response.status, text, json: JSON.parse(text) }) + '\n')
    }
    const [code, signal] = await completed
    assert.equal(code, 0, `${signal ?? ''}${errors}`)
    assert(requests > 0)
  } finally {
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}
