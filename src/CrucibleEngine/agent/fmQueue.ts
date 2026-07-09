// ═══════════════════════════════════════════════════════════════════════════════
// FM daemon queue — one serial gate in front of the single-session on-device model
// ═══════════════════════════════════════════════════════════════════════════════
//
// The Apple FM daemon (port 11435) is a SINGLE on-device session. When several callers
// hit it at once — a live user request while the background autoImprove pass, keepalive
// prewarms, and synthesis all fire — it throws transient `GenerationError -1` and returns
// degraded/empty output. That is the documented cause of live VGR searches EXHAUSTING on
// tasks that solve in one call in isolation (the background daemons starve the search).
//
// The fix is structural, not a retry: funnel EVERY daemon call through one queue with
// concurrency 1. Serializing at the boundary means the daemon is never hit concurrently,
// so the under-load failure mode cannot occur. A priority field lets an interactive
// request (VGR / chat) jump ahead of background work that is already waiting.
//
// This does NOT preempt an in-flight call — a background generation already running will
// finish before a waiting foreground one starts. Background callers therefore use a lower
// priority AND should pass a shorter timeout so they can't hold the gate too long.
// ═══════════════════════════════════════════════════════════════════════════════

export type FmPriority = 'high' | 'normal' | 'low'
const RANK: Record<FmPriority, number> = { high: 0, normal: 1, low: 2 }

interface Queued<T> {
  fn: () => Promise<T>
  priority: number
  seq: number
  label: string
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

const MAX_CONCURRENT = Number(process.env.CRUCIBLE_FM_CONCURRENCY ?? 1)
const pending: Queued<unknown>[] = []
let active = 0
let seqCounter = 0

// Lightweight observability — read by /api/diag or debug to see contention.
export const fmQueueStats = { enqueued: 0, completed: 0, failed: 0, maxDepth: 0, get depth() { return pending.length }, get active() { return active } }

function pump(): void {
  while (active < MAX_CONCURRENT && pending.length) {
    // Stable priority order: lowest rank first, then FIFO by seq within a rank.
    let bestIdx = 0
    for (let i = 1; i < pending.length; i++) {
      const a = pending[i], b = pending[bestIdx]
      if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) bestIdx = i
    }
    const item = pending.splice(bestIdx, 1)[0]
    active++
    Promise.resolve()
      .then(item.fn)
      .then(
        v => { fmQueueStats.completed++; item.resolve(v) },
        e => { fmQueueStats.failed++; item.reject(e) },
      )
      .finally(() => { active--; pump() })
  }
}

/**
 * Run `fn` (a single daemon call) under the serial FM gate. Higher-priority jobs that are
 * WAITING run before lower-priority waiting jobs; an already-running job is never preempted.
 * The returned promise settles with fn's result/error — the queue is transparent.
 */
// ── Foreground gate ────────────────────────────────────────────────────────────────
// The queue serializes and lets interactive work jump AHEAD of waiting background work,
// but it cannot preempt a background call already in-flight — so a long background FM pass
// can still delay a live request by one call. The complementary fix: background schedulers
// (autoImprove, the improvement daemon, prewarm rounds) call `isForegroundActive()` and
// SKIP their FM work entirely while any interactive request is running. Foreground marks
// itself with begin/endForeground around the request lifecycle.
let foregroundCount = 0
export function beginForeground(): void { foregroundCount++ }
export function endForeground(): void { foregroundCount = Math.max(0, foregroundCount - 1) }
export function isForegroundActive(): boolean { return foregroundCount > 0 }

export function enqueueFm<T>(fn: () => Promise<T>, opts: { priority?: FmPriority; label?: string } = {}): Promise<T> {
  fmQueueStats.enqueued++
  return new Promise<T>((resolve, reject) => {
    pending.push({
      fn: fn as () => Promise<unknown>,
      priority: RANK[opts.priority ?? 'normal'],
      seq: seqCounter++,
      label: opts.label ?? 'fm',
      resolve: resolve as (v: unknown) => void,
      reject,
    })
    if (pending.length > fmQueueStats.maxDepth) fmQueueStats.maxDepth = pending.length
    pump()
  })
}
