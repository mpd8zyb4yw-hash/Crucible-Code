// FM queue contention bench (cont.116).
//
// WHY: the phase profiler measured a single `model.synth` call held for 5604s against a 12s
// median during an offline suite. The cause was not model latency — it was that every model
// call in the process funnels through ONE serial gate (fmQueue, MAX_CONCURRENT=1), and a
// benchmark task that the harness had already abandoned kept queueing work into that gate.
// One abandoned task therefore starved every task after it, and the suite measured queue
// contention instead of capability.
//
// This bench pins the two properties that make that impossible, deterministically and with
// no daemon, no model, and no network:
//   1. drop-on-cancel — a job whose signal aborted while it WAITED is rejected unrun.
//   2. no collateral damage — cancelling one caller's job must not drop or reorder anybody
//      else's, and must not wedge the gate (the classic bug in a hand-rolled queue is
//      forgetting to `pump()` after a drop, which deadlocks every job behind it).
//
// Run: npm run fmqueue:bench

import { enqueueFm, fmQueueStats, FmCancelledError } from './fmQueue'

let passed = 0, failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS — ${name}`) }
  else { failed++; console.log(`  FAIL — ${name}${detail ? ` :: ${detail}` : ''}`) }
}

const defer = (ms: number) => new Promise(r => setTimeout(r, ms))

async function main() {
  console.log('=== FM queue: drop-on-cancel ===')

  // ── 1. A job cancelled WHILE QUEUED is dropped without ever running. ──────────────
  {
    const ran: string[] = []
    let releaseBlocker: () => void = () => {}
    const blocker = new Promise<void>(r => { releaseBlocker = r })

    // Occupy the single lane so everything else must queue behind it.
    const p0 = enqueueFm(async () => { ran.push('blocker'); await blocker; return 'blocker' }, { label: 'blocker' })
    await defer(10)

    const ac = new AbortController()
    const pCancelled = enqueueFm(async () => { ran.push('cancelled'); return 'cancelled' },
      { label: 'cancelled', signal: ac.signal })
    const pSurvivor = enqueueFm(async () => { ran.push('survivor'); return 'survivor' }, { label: 'survivor' })

    // Abort AFTER enqueue, while the job is still sitting in `pending`. This is the real
    // shape of the bug: the harness gives up on a task that is already waiting its turn.
    ac.abort()
    const droppedBefore = fmQueueStats.dropped
    releaseBlocker()

    const cancelledOutcome = await pCancelled.then(() => 'resolved', e => e)
    const survivorOutcome = await pSurvivor
    await p0

    check('a job cancelled while queued rejects', cancelledOutcome instanceof Error,
      `got ${String(cancelledOutcome)}`)
    check('it rejects with FmCancelledError', cancelledOutcome instanceof FmCancelledError,
      `got ${(cancelledOutcome as Error)?.name}`)
    check('its fn NEVER ran', !ran.includes('cancelled'), `ran=[${ran.join(',')}]`)
    check('the dropped counter incremented', fmQueueStats.dropped === droppedBefore + 1,
      `${droppedBefore} -> ${fmQueueStats.dropped}`)

    // The collateral-damage property. A drop must re-pump, or everything behind the
    // dropped job hangs forever — which would be strictly worse than the bug being fixed.
    check('an unrelated queued job still ran', ran.includes('survivor'), `ran=[${ran.join(',')}]`)
    check('the unrelated job resolved normally', survivorOutcome === 'survivor', String(survivorOutcome))
  }

  // ── 2. An UNCANCELLED signal is inert — passing a signal must not change behaviour. ──
  {
    const ac = new AbortController()
    const v = await enqueueFm(async () => 'ok', { label: 'live', signal: ac.signal })
    check('a job with a live (unaborted) signal runs normally', v === 'ok', String(v))
  }

  // ── 3. A job already aborted BEFORE it is enqueued is also dropped. ─────────────────
  {
    const ac = new AbortController()
    ac.abort()
    let didRun = false
    const outcome = await enqueueFm(async () => { didRun = true; return 'x' },
      { label: 'preaborted', signal: ac.signal }).then(() => 'resolved', e => e)
    check('a pre-aborted job is dropped', outcome instanceof FmCancelledError, String(outcome))
    check('a pre-aborted job never runs', !didRun)
  }

  // ── 4. The gate is still usable afterwards (no wedged `active` counter). ────────────
  {
    const results = await Promise.all([1, 2, 3].map(n =>
      enqueueFm(async () => { await defer(5); return n }, { label: `post${n}` })))
    check('the gate still serves work after drops', results.join(',') === '1,2,3', results.join(','))
    check('no job is left active', fmQueueStats.active === 0, `active=${fmQueueStats.active}`)
    check('the queue drained', fmQueueStats.depth === 0, `depth=${fmQueueStats.depth}`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
