/**
 * PLUGGING THE MEMORY CORE INTO A HOST, WITHOUT MAKING IT AUTHORITATIVE.
 *
 * This is Phase B of §30's migration and nothing beyond it. The connectors are
 * untouched, the world document keeps being written exactly as it is, and the
 * ledger is filled BESIDE it from the same fetch. Nothing in the app reads the
 * memory core to decide anything yet.
 *
 * That restraint is the design, not caution for its own sake. Making the new
 * substrate authoritative before its parity with the old one has been observed
 * over real data would mean discovering a normalisation gap as a missing card on
 * his home screen. Filling both, watching, and moving consumers one at a time is
 * slower and is the only version where a mistake is visible before it costs him
 * something.
 *
 * WHAT IS INSTALLED AND WHAT IS NOT.
 *
 *   installed  · an observation sink on `addObservations`, so every connector
 *               that already writes the world also writes the ledger
 *             · a reflection entry point the host's scheduler can call
 *   NOT        · any read path. `feed.ts`, `panes.ts`, `insight.ts` and the
 *               prompt are unchanged and do not know this exists.
 *
 * FAILURE IS ALWAYS THE MEMORY CORE'S PROBLEM. Every entry point here is
 * defensive to the point of rudeness: a broken ledger costs evidence and must
 * never cost a sync, a request or a screen. `setObservationSink`'s contract says
 * the same thing from the other side.
 */

import { setObservationSink, type Observation } from '../world.js'
import { SHADOW_ONLY, type MemoryPosture } from './authority.js'
import { eventsFromWorldObservations } from './ingest.js'
import { recordedCycle, type ShadowOptions } from './shadow.js'
import type { MemoryStore, ReflectionRun, ShadowRun } from './types.js'

let installed: { store: MemoryStore; opts: ShadowOptions; posture: MemoryPosture } | null = null

/**
 * Point the dual write at a store.
 *
 * Idempotent, and re-installing replaces rather than stacking — a Worker isolate
 * calls this on every request, and a sink list that grew per request would write
 * the ledger n times for the nth request of an isolate's life.
 */
export function installMemory(
  store: MemoryStore,
  opts: ShadowOptions = {},
  posture: MemoryPosture = SHADOW_ONLY
): void {
  installed = { store, opts, posture }

  setObservationSink(async (observations: Observation[], now: Date) => {
    const events = eventsFromWorldObservations(observations, now.toISOString())
    const written = store.events.append(events)
    /**
     * NORMALISE IMMEDIATELY, but only what actually landed.
     *
     * `append` is idempotent on the dedupe key and returns the ids that were new,
     * so a three-hourly sync re-reading the same fortnight does no work here at
     * all. Running the ingest stage inline rather than waiting for the next
     * scheduled pass is what makes the ledger queryable the moment a sync
     * finishes — which matters because the alternative is a memory core that is
     * always one cadence behind the world document it is supposed to replace.
     */
    if (!written.length) return
    /*
      Through `run` rather than `runCycle`, so an arrival is watched like every
      other pass. An ingest cycle produces no candidates and usually no shadow
      section either — which is exactly what the log should show for it, and is
      information the previous `counts`-only record could not carry.
    */
    run('ingest', now)
  })
}

/**
 * ONE PASS, OBSERVED AND RECORDED.
 *
 * Every scheduled entry point goes through here, so there is one place where a
 * cycle becomes a shadow run and one place where a failure in the watching is
 * kept away from the thing being watched.
 */
function run(kind: ReflectionRun['kind'], now: Date): ShadowRun | null {
  if (!installed) return null
  return recordedCycle(installed.store, kind, now, installed.opts).shadow
}

/** Stop dual-writing. For tests, and for a host that is shutting down. */
export function uninstallMemory(): void {
  installed = null
  setObservationSink(null)
}

/** The store the host installed, or null. Read-only access for a debug route. */
export const memoryStore = (): MemoryStore | null => installed?.store ?? null

/**
 * WHAT THE MEMORY CORE IS CURRENTLY ALLOWED TO ANSWER FOR.
 *
 * Read by every prospective consumer before it returns a memory-core answer, and
 * `SHADOW_ONLY` when nothing is installed — so a read path that forgets to check
 * gets the safe answer rather than an exception, and a host with no memory core
 * behaves exactly like one whose capabilities are all shadowed.
 */
export const memoryPosture = (): MemoryPosture => installed?.posture ?? { ...SHADOW_ONLY, enabled: false }

/**
 * Run a reflection pass. THE SCHEDULER'S ENTRY POINT ON BOTH HOSTS.
 *
 * Returns null when nothing is installed, rather than throwing, because the
 * callers are a cron and an alarm — neither of which has anywhere to put an
 * exception except a log nobody reads.
 */
export function reflect(kind: ReflectionRun['kind'], now = new Date()): ShadowRun | null {
  if (!installed) return null
  try {
    return run(kind, now)
  } catch (e) {
    console.warn(`memory: ${kind} reflection failed — ${(e as Error).message}`)
    return null
  }
}

/**
 * WHICH PASS THIS TICK SHOULD BE.
 *
 * The two hosts have different schedulers and the same question: given that a
 * tick has fired, is this a quarter-hourly sweep, the day's consolidation, or the
 * week's? Deriving it from the clock rather than from separate cron entries means
 * one implementation and no chance of the daily pass silently never running
 * because a trigger string was edited.
 *
 * The boundaries are HIS, through the parts the caller supplies — a daily
 * consolidation at UTC midnight would land at two in the morning his time and
 * would consolidate a day that, for him, still had two hours left in it.
 */
export function cadenceFor(parts: { hour: number; weekday: number }): ReflectionRun['kind'] {
  // Late enough that the day's evidence has arrived; early enough that the
  // morning's first look at the app sees a consolidated yesterday.
  if (parts.hour === 23) return parts.weekday === 0 ? 'weekly' : 'daily'
  return 'short'
}
