// SPDX-License-Identifier: AGPL-3.0-only
const utf8 = new TextEncoder()

export async function generate(model, input, calls, gate) {
  if (model !== '@cf/meta/llama-3.1-8b-instruct' || !input.messages) throw new Error('Only the synthetic generation fixture is mounted')
  calls.generation++
  calls.temperature = input.temperature ?? null
  if (input.stream === true) {
    let opening = true, cancelled = false
    return new ReadableStream({
      async pull(out) {
        if (opening) {
          opening = false
          out.enqueue(utf8.encode('data: {"response":"First fixture delta"}\n\n'))
          return
        }
        await gate.hold('stream-tail')
        if (cancelled) return
        calls.tail = true
        out.enqueue(utf8.encode('data: {"response":"Second fixture delta"}\n\ndata: [DONE]\n\n'))
        out.close()
      },
      cancel() { cancelled = calls.cancelled = true; gate.release('stream-tail') },
    }, { highWaterMark: 0 })
  }
  if (input.messages.at(-1)?.content === 'held generation') await gate.hold('generation')
  return { response: 'Synthetic reply', usage: { prompt_tokens: 4, completion_tokens: 5 } }
}
