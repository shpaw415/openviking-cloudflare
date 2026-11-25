// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic Unix-socket transport; never mounted on the application's HTTP listener.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path === '/ready') return new Response(null, { status: 204 })
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const { account, options, archive, seal, approval } = await request.json()
    if (path === '/capture') return env.OPERATOR.capture(account, options)
    const bytes = Uint8Array.from(atob(archive), c => c.charCodeAt(0)).buffer
    if (path === '/evaluate') return env.OPERATOR.evaluate(account, bytes, seal, options)
    if (path === '/apply') return env.OPERATOR.apply(account, bytes, seal, options, approval)
    return new Response(null, { status: 404 })
  },
}
