// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs'
import { link, lstat, mkdtemp, open, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const help = `Usage: node scripts/admin.mjs COMMAND --url ORIGIN (--key-file FILE | --key-stdin) [OPTIONS]

  list-accounts
  list-users      --account ID
  create-account  --account ID --admin ID --out-key NEW_FILE
  register-user   --account ID --user ID [--role user|admin] --out-key NEW_FILE
  regenerate-key  --account ID --user ID --out-key NEW_FILE
  show-config
  import-config   --file ov.edge.conf (--dry-run | --apply) [--revision N]
  test-config     --kind vlm|embedding

Use HTTPS; plain HTTP is for 127.0.0.1 or [::1] only. Keys are never printed.
The output must be a new file in a private directory (mkdir -m 700).
`
const commands = new Map([
  ['list-accounts', []], ['list-users', ['account']],
  ['create-account', ['account', 'admin', 'out-key']],
  ['register-user', ['account', 'user', 'role', 'out-key']],
  ['regenerate-key', ['account', 'user', 'out-key']],
  ['show-config', []], ['import-config', ['file', 'revision']], ['test-config', ['kind']],
])
const idPattern = /^[A-Za-z0-9_-]{1,48}$/u
const credentialPattern = /^[A-Za-z0-9_-]{32,128}(?:\r?\n)?$/u
const managedPattern = /^[a-f0-9]{64}$/u
const maxCredentialBytes = 130
const maxResponseBytes = 256 * 1024
const configFileLimit = 16 * 1024
const accounts = '/api/v1/admin/accounts'
const configuration = '/api/v1/admin/configuration'

class CliError extends Error {
  constructor(message, exitCode) { super(message); this.exitCode = exitCode }
}
const usage = message => new CliError(`${message} See --help.`, 2)
const unexpected = 'Unexpected response from the Worker.'
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function originOf(value) {
  // Check the original string too: URL normalizes empty queries and dot segments.
  if (!/^https?:\/\/[^/?#@\\\s]+\/?$/iu.test(value ?? '')) throw usage('Set --url to the bare Worker origin.')
  let url
  try { url = new URL(value) } catch { throw usage('Set --url to the bare Worker origin.') }
  if (url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw usage('HTTPS is required outside loopback.')
  }
  return url.origin
}

function argumentsFor(command, args) {
  const flags = commands.get(command)
  if (!flags) throw usage('Unknown or missing command.')
  let parsed
  try {
    parsed = parseArgs({ args, tokens: true, options: {
      ...Object.fromEntries(['url', 'key-file', ...flags].map(name => [name, { type: 'string' }])),
      'key-stdin': { type: 'boolean' },
      ...(command === 'import-config' && { 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' } }),
    } })
  } catch { throw usage('Invalid options.') } // Never echo parse errors, which can include raw argv.
  const { values: opts, tokens } = parsed
  const seen = new Set()
  for (const token of tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) throw usage('Options cannot be repeated.')
    seen.add(token.name)
  }
  if ((opts['key-file'] !== undefined) === Boolean(opts['key-stdin']) || opts['key-file'] === '' || opts['key-file'] === '-') {
    throw usage('Use either --key-file FILE or --key-stdin.')
  }
  for (const flag of flags.filter(flag => ['account', 'admin', 'user'].includes(flag))) {
    if (!idPattern.test(opts[flag] ?? '')) throw usage(`--${flag} must be a valid OpenViking identifier.`)
  }
  const issuesKey = flags.includes('out-key')
  if (issuesKey && (!opts['out-key'] || opts['out-key'] === '-')) throw usage('A new --out-key file is required.')
  const query = new URLSearchParams()
  if (command === 'import-config') {
    if (!opts.file || opts.file === '-' || Boolean(opts['dry-run']) === Boolean(opts.apply)) {
      throw usage('Set --file and exactly one of --dry-run or --apply.')
    }
    if (opts['dry-run']) query.set('dry_run', 'true')
    if (opts.revision !== undefined) {
      if (!/^\d+$/u.test(opts.revision) || !Number.isSafeInteger(Number(opts.revision))) throw usage('Invalid --revision.')
      query.set('if_revision', opts.revision)
    }
  }
  if (command === 'test-config' && !['vlm', 'embedding'].includes(opts.kind)) throw usage('Set --kind to vlm or embedding.')
  const post = issuesKey || command === 'import-config' || command === 'test-config'
  const role = opts.role ?? 'user'
  if (role !== 'user' && role !== 'admin') throw usage('--role must be user or admin.')
  const users = `${accounts}/${opts.account}/users`
  const path = {
    'list-accounts': accounts, 'list-users': `${users}?include_credentials=false`,
    'create-account': accounts, 'register-user': users, 'regenerate-key': `${users}/${opts.user}/key`,
    'show-config': `${configuration}/import`,
    'import-config': `${configuration}/import${query.size ? `?${query}` : ''}`,
    'test-config': `${configuration}/test-model`,
  }[command]
  const payload = command === 'create-account' ? { account_id: opts.account, admin_user_id: opts.admin }
    : command === 'register-user' ? { user_id: opts.user, role }
    : command === 'test-config' ? { kind: opts.kind, active: true } : undefined
  return { opts, issuesKey, mutation: issuesKey || Boolean(opts.apply), method: post ? 'POST' : 'GET', url: new URL(path, originOf(opts.url)), payload }
}

async function readConfiguration(path) {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > configFileLimit) throw usage('Use a nonempty, regular JSON configuration file (max 16 KiB).')
    const bytes = Buffer.alloc(configFileLimit + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > configFileLimit) throw usage('Configuration file exceeds 16 KiB.')
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
    // Send only the Edge projection, never an unfiltered upstream startup file.
    const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key))
    const profile = (value, numbers, other = []) => keys(value, ['provider', 'model', 'api_base', ...numbers, ...other]) &&
      ['workers_ai', 'openai', 'openai-compatible', 'ollama'].includes(value.provider) &&
      typeof value.model === 'string' && /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/u.test(value.model) &&
      (value.api_base === undefined || (typeof value.api_base === 'string' && /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9_-]+)*\/?$/u.test(value.api_base))) &&
      numbers.every(key => value[key] === undefined || Number.isFinite(value[key]))
    if (!keys(data, ['vlm', 'embedding', 'default_search_limit']) || !Object.keys(data).length ||
        (data.vlm != null && !profile(data.vlm, ['temperature', 'max_tokens', 'timeout'])) ||
        (data.embedding != null && (!keys(data.embedding, ['dense']) || !profile(data.embedding.dense, ['dimension'], ['input']) ||
          (data.embedding.dense.input !== undefined && data.embedding.dense.input !== 'text'))) ||
        (data.default_search_limit != null && !Number.isFinite(data.default_search_limit))) {
      throw usage('Use only supported Edge fields; do not include provider keys or a full startup file.')
    }
    return data
  } catch (error) {
    throw error instanceof CliError ? error : usage('Could not read the JSON configuration file.')
  } finally { await file?.close().catch(() => {}) }
}

async function readCredential(opts) {
  let file
  try {
    const bytes = Buffer.alloc(maxCredentialBytes + 1)
    let size = 0
    if (opts['key-stdin']) {
      if (process.stdin.isTTY) throw usage('--key-stdin requires a pipe, not terminal input.')
      for await (const chunk of process.stdin) {
        if (size + chunk.length > maxCredentialBytes) throw usage('Credential input exceeds 130 bytes.')
        size += chunk.copy(bytes, size)
      }
    } else {
      file = await open(opts['key-file'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const details = await file.stat()
      if (!details.isFile() || details.uid !== process.getuid() || (details.mode & 0o077) !== 0) {
        throw usage('Use a regular key file you own with no group or other permissions (chmod 600).')
      }
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size)
        if (!bytesRead) break
        size += bytesRead
      }
      if (size > maxCredentialBytes) throw usage('Credential input exceeds 130 bytes.')
    }
    // latin1 is one-to-one over bytes; non-ASCII input cannot turn into ASCII.
    const key = bytes.toString('latin1', 0, size)
    if (!credentialPattern.test(key)) throw usage('Expected exactly one OpenViking API key.')
    return key.replace(/\r?\n$/u, '')
  } catch (error) {
    throw error instanceof CliError ? error : usage('Could not read the private credential input.')
  } finally { await file?.close().catch(() => {}) }
}

async function reserveOutput(path) {
  let scratch, file
  const requested = resolve(path)
  try {
    const parent = await realpath(dirname(requested))
    const info = await stat(parent)
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw usage('The output directory must be private and owned by you (chmod 700).')
    }
    const target = join(parent, basename(requested))
    const existing = await lstat(target).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (existing) throw usage('Output already exists; choose a new --out-key file.')
    scratch = await mkdtemp(join(parent, '.openviking-admin-'))
    const temporary = join(scratch, 'key')
    file = await open(temporary, 'wx', 0o600)
    await file.chmod(0o600)
    return {
      async save(key) {
        await file.writeFile(`${key}\n`)
        await file.sync()
        // Publish a complete file atomically, without replacing even a racing file/symlink.
        await link(temporary, target)
      },
      async close() {
        await file.close().catch(() => {})
        await unlink(temporary).catch(() => {})
        await rmdir(scratch).catch(() => {})
      },
    }
  } catch (error) {
    await file?.close().catch(() => {})
    if (scratch) {
      await unlink(join(scratch, 'key')).catch(() => {})
      await rmdir(scratch).catch(() => {})
    }
    throw error instanceof CliError ? error : usage('Could not prepare the private output file.')
  }
}

function request(url, key, method, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const headers = { 'X-API-Key': key, Accept: 'application/json', 'Cache-Control': 'no-store' }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Length'] = Buffer.byteLength(body)
  }
  if (method === 'POST' && body === undefined) headers['Content-Length'] = 0
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  // Direct connection, no redirects or retry, verified TLS, a single deadline through body read.
  return new Promise((done, fail) => {
    const req = send(url, { method, headers, agent: false,
      rejectUnauthorized: true, signal: AbortSignal.timeout(15_000) }, done)
    req.once('error', fail)
    req.end(body)
  })
}

const rejection = new Map([
  [400, 'Invalid request'], [401, 'Invalid or revoked API key'], [403, 'Operation not allowed for this identity'],
  [404, 'Account, user, or endpoint not found'], [405, 'Method not allowed'],
  [409, 'Conflict: check the current directory or configuration revision'], [412, 'Required provider binding is missing'],
  [413, 'Control-plane quota or request limit exceeded'], [429, 'Control-plane quota exceeded'], [501, 'Unsupported Worker operation or configuration'],
])
const failed = (message, mutation) => new CliError(mutation
  ? `${message} The mutation may have been applied; check the current state before retrying.` : message, mutation ? 3 : 1)

async function resultOf({ url, mutation, method, payload }, key) {
  let response
  try { response = await request(url, key, method, payload) } catch { throw failed('Worker request failed.', mutation) }
  const status = response.statusCode
  if (status !== 200) {
    response.destroy() // Ignore every error body and Location, even if they echo secrets.
    if (rejection.has(status)) throw new CliError(`HTTP ${status}: ${rejection.get(status)}.`, 1)
    if (status >= 300 && status < 400) throw failed(`HTTP ${status}: redirect not followed.`, mutation)
    throw failed(`Unexpected HTTP ${status}.`, mutation)
  }
  try {
    if (response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw Error()
    const chunks = []
    let size = 0
    for await (const chunk of response) {
      size += chunk.length
      if (size > maxResponseBytes) throw Error()
      chunks.push(chunk)
    }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
    if (!record(data) || data.status !== 'ok' || !Object.hasOwn(data, 'result')) throw Error()
    return data.result
  } catch {
    response.destroy()
    throw failed(unexpected, mutation)
  }
}

function configReceipt(data, credential, operation) {
  const invalid = () => failed(unexpected, operation.mutation)
  if (!record(data) || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      data.dry_run !== Boolean(operation.opts['dry-run']) || !record(data.effective) ||
      !Number.isSafeInteger(data.effective.default_search_limit)) throw invalid()
  const model = (value, optionalNumbers) => {
    if (!record(value) || typeof value.model !== 'string' || !/^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/u.test(value.model) ||
        !['workers_ai', 'openai'].includes(value.provider) || typeof value.configured !== 'boolean') throw invalid()
    return { provider: value.provider, model: value.model, configured: value.configured,
      ...Object.fromEntries(optionalNumbers.filter(key => Number.isFinite(value[key])).map(key => [key, value[key]])) }
  }
  const view = JSON.stringify({ revision: data.revision, dry_run: data.dry_run,
    vlm: data.effective.vlm === null ? null : model(data.effective.vlm, ['temperature', 'max_tokens', 'timeout']),
    default_embedding: model(data.effective.embedding, ['dimension']),
    default_search_limit: data.effective.default_search_limit }, null, 2)
  if (view.includes(credential)) throw invalid()
  return view
}

function directory(command, rows, key) {
  if (!Array.isArray(rows)) throw failed(unexpected, false)
  const output = rows.map(row => {
    if (command === 'list-accounts' && record(row) && typeof row.account_id === 'string' && idPattern.test(row.account_id) &&
        Number.isSafeInteger(row.user_count) && row.user_count >= 0) {
      return { account_id: row.account_id, user_count: row.user_count }
    }
    if (command === 'list-users' && record(row) && typeof row.user_id === 'string' && idPattern.test(row.user_id) &&
        ['user', 'admin'].includes(row.role)) return { user_id: row.user_id, role: row.role }
    throw failed(unexpected, false)
  })
  const json = JSON.stringify(output, null, 2)
  if (json.includes(key)) throw failed(unexpected, false)
  return json
}

async function main([command, ...args]) {
  if ((command === undefined || command === '--help' || command === '-h') && args.length === 0) {
    process.stdout.write(help)
    return
  }
  if (!process.getuid || constants.O_NOFOLLOW === undefined) throw usage('A POSIX filesystem is required.')
  // Node's low-level HTTP debug log can include request headers.
  if (process.env.NODE_DEBUG || process.env.NODE_DEBUG_NATIVE) throw usage('Disable Node debug logging first.')
  const operation = argumentsFor(command, args)
  const { opts, issuesKey } = operation
  if (command === 'import-config') operation.payload = await readConfiguration(opts.file)
  const credential = await readCredential(opts)
  if (command === 'import-config' && JSON.stringify(operation.payload).includes(credential)) throw usage('Do not include the OpenViking key in the configuration file.')
  const output = issuesKey ? await reserveOutput(opts['out-key']) : null
  try {
    const data = await resultOf(operation, credential)
    if (command === 'show-config' || command === 'import-config') {
      console.log(configReceipt(data, credential, operation))
      return
    }
    if (command === 'test-config') {
      if (!record(data) || typeof data.ok !== 'boolean' || !Number.isSafeInteger(data.ms) || data.ms < 0) throw failed(unexpected, false)
      if (!data.ok) throw failed('The provider did not pass the model probe.', false)
      console.log(JSON.stringify({ ok: true, ms: data.ms }))
      return
    }
    if (!output) {
      console.log(directory(command, data, credential))
      return
    }
    if (!record(data) || typeof data.user_key !== 'string' || !managedPattern.test(data.user_key) || data.user_key === credential ||
        (command === 'create-account' && (data.account_id !== opts.account || data.admin_user_id !== opts.admin)) ||
        (command === 'register-user' && (data.account_id !== opts.account || data.user_id !== opts.user))) {
      throw failed(unexpected, true)
    }
    try { await output.save(data.user_key) } catch {
      throw new CliError('Worker issued a key, but the private output could not be saved. Do not retry blindly.', 3)
    }
    console.log('API key saved to the requested private file.')
  } finally { await output?.close() }
}

await main(process.argv.slice(2)).catch(error => {
  if (error instanceof CliError) {
    console.error(`openviking admin: ${error.message}`)
    process.exitCode = error.exitCode
  } else {
    console.error('openviking admin: Unexpected local error.')
    process.exitCode = 1
  }
})
