import type { StreamHandle, StreamHandlers } from './types'

/**
 * INTEGRATION SEAM — this is the on-device model boundary.
 *
 * There is no real local-FM runtime available in this build environment
 * (no llama.cpp / WebLLM / ONNX runtime wired up), so this module is a
 * deterministic, zero-network responder that stands in for it. It performs
 * no fetch/XHR of any kind — the "zero external calls" guarantee from the
 * spec holds today even though the reasoning is templated rather than a
 * real model's.
 *
 * To wire up a real on-device model: replace `composeLocalReply` with a
 * call into your actual local inference (e.g. a llama.cpp server on
 * localhost, or an in-process WebLLM/ONNX session), and replace the
 * `for await` loop below with the real token stream from that engine.
 * Everything downstream (chat UI, MoltenPour animation) already consumes
 * chunks via the same `StreamHandlers` contract, so no other code needs to
 * change.
 */

function composeLocalReply(prompt: string): string {
  const trimmed = prompt.trim()
  const looksLikeCode = /```|function |class |const |import |def |=>/.test(trimmed)
  const looksLikeQuestion = /\?\s*$/.test(trimmed) || /^(how|what|why|when|should|can|does|is|are)\b/i.test(trimmed)

  const lines: string[] = []
  if (looksLikeCode) {
    lines.push(
      `Working from what you've given me, here's the shape I'd reach for:\n\n` +
        `1. Isolate the core operation into a small, testable unit — keep I/O and orchestration out of it.\n` +
        `2. Handle the obvious edge cases first (empty input, concurrent access, partial failure) before optimizing.\n` +
        `3. Add a guard at the boundary rather than defensive checks throughout — trust internal calls.`,
    )
    lines.push(
      `\nIf you want, tell me more about the surrounding constraints (throughput, existing patterns in the codebase) and I'll narrow this down further.`,
    )
  } else if (looksLikeQuestion) {
    lines.push(
      `Short answer: it depends on the constraint that matters most here — but let me lay out the tradeoff.\n\n` +
        `The straightforward approach gets you there fastest but assumes the common case holds. The more careful approach costs more upfront but survives the edge cases that tend to show up under real load.`,
    )
    lines.push(
      `\nGiven what you've described, I'd lean toward the simpler path first and add the extra rigor only once you've seen it's actually needed.`,
    )
  } else {
    lines.push(
      `Here's how I'd break this down:\n\n` +
        `- What's actually being asked for, stripped of assumptions\n` +
        `- The smallest version that would satisfy it\n` +
        `- Where that smallest version would fall over, if anywhere`,
    )
    lines.push(`\nWant me to go deeper on any one of those?`)
  }
  return lines.join('\n')
}

export function streamLocal(prompt: string, handlers: StreamHandlers, speed = 1): StreamHandle {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const full = composeLocalReply(prompt)
  const words = full.split(/(?<=\s)/)
  let i = 0
  let firstTokenFired = false
  let acc = ''

  const thinkingDelay = (700 + Math.random() * 500) / speed
  timer = setTimeout(() => {
    const step = () => {
      if (cancelled) return
      const n = 1 + Math.floor(Math.random() * 4)
      const nextI = Math.min(words.length, i + n)
      const chunk = words.slice(i, nextI).join('')
      i = nextI
      acc += chunk
      if (!firstTokenFired) {
        firstTokenFired = true
        handlers.onFirstToken?.(full.length)
      }
      handlers.onChunk?.(chunk, acc)
      if (i >= words.length) {
        handlers.onDone?.(acc)
        return
      }
      const pause = (Math.random() < 0.12 ? 380 : 40 + Math.random() * 110) / speed
      timer = setTimeout(step, pause)
    }
    step()
  }, thinkingDelay)

  return {
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
  }
}
