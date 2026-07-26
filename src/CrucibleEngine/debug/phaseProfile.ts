// ============================================================================
// Per-task WALL-CLOCK ATTRIBUTION for the offline agent loop.
//
// WHY THIS EXISTS (cont.116): the binding constraint on the coding benchmark is
// THROUGHPUT, not the loop's stopping logic. The harness cuts each task at
// PER_TASK_TIMEOUT_MS (480s) while an iteration costs ~45-60s, so most gen-path
// tasks are guillotined mid-work at iters=5-8. Every prior session proposed
// prompt/oracle changes to fix that; none had a measurement saying WHERE the
// seconds actually go. `traceTurn` (server.ts) times each driveTurn as a black
// box — it can tell you a turn took 60s but not whether that was the model, the
// oracle, tsc, or retrieval. This file opens the box.
//
// DESIGN — self-time attribution, not elapsed-time attribution.
// Spans nest (driveTurn > synthesizeUniversal > oracle.verify), so summing raw
// elapsed per lane double-counts and produces a total far larger than the run.
// Each span therefore reports SELF time = its own elapsed minus the elapsed of
// the spans nested inside it. Self times sum to (approximately) real wall-clock,
// which means the report answers the actual question: if you deleted this lane
// entirely, how many seconds would you get back?
//
// Nesting is tracked with AsyncLocalStorage rather than a plain stack so that
// concurrently-awaited siblings (the loop's Promise.all over tool calls) attach
// to the right parent instead of corrupting each other's frames.
//
// COST: zero when CRUCIBLE_PHASE_PROFILE is unset — `span()` returns fn()
// directly with no allocation, no ALS frame, no clock read. Safe to leave wired
// into the hot path permanently.
//
// SCOPE LIMIT (deliberate): the accumulator is process-global with an explicit
// per-task reset, NOT request-scoped. That is correct for the benchmark harness,
// which fires tasks strictly serially, and it keeps the wiring to two call sites
// in loop.ts instead of threading a session object through eight modules. Two
// concurrent profiled requests would interleave into one report — which is why
// this is a measurement mode, not a production telemetry feature.
// ============================================================================

import { AsyncLocalStorage } from 'async_hooks'

const ENABLED = !!process.env.CRUCIBLE_PHASE_PROFILE

/** One nesting frame: how much of MY elapsed time was actually spent inside children. */
interface Frame { childMs: number }

const als = new AsyncLocalStorage<Frame>()

export interface LaneStat {
  lane: string
  /** Time attributable to this lane alone (elapsed minus nested children). */
  selfMs: number
  /** Raw wall time from entry to exit, including nested lanes. */
  totalMs: number
  calls: number
  maxMs: number
}

interface Session {
  taskId: string
  startedAt: number
  lanes: Map<string, LaneStat>
  /** Sequential event log — lets us reconstruct the cadence, not just the totals. */
  timeline: Array<{ lane: string; at: number; ms: number }>
}

let session: Session | null = null

/**
 * Start attribution for one benchmark task / one agent run.
 *
 * Returns true only to the caller that actually OPENED the session. A nested run
 * (the meta-router runs a fresh agent loop per subtask) gets false and must not
 * call endProfile — otherwise the first subtask to finish would truncate the
 * report for the whole task and the remaining subtasks would attribute to nothing.
 */
export function beginProfile(taskId: string): boolean {
  if (!ENABLED) return false
  if (session) return false
  session = { taskId, startedAt: Date.now(), lanes: new Map(), timeline: [] }
  return true
}

function record(lane: string, selfMs: number, totalMs: number, startedAt: number): void {
  if (!session) return
  let s = session.lanes.get(lane)
  if (!s) { s = { lane, selfMs: 0, totalMs: 0, calls: 0, maxMs: 0 }; session.lanes.set(lane, s) }
  s.selfMs += selfMs
  s.totalMs += totalMs
  s.calls += 1
  if (totalMs > s.maxMs) s.maxMs = totalMs
  // Cap the timeline so a pathological run cannot grow unbounded memory.
  if (session.timeline.length < 4000) {
    session.timeline.push({ lane, at: startedAt - session.startedAt, ms: totalMs })
  }
}

/**
 * Time `fn` under `lane`. Nested spans are subtracted from this one's self time.
 * Returns fn()'s value untouched; exceptions propagate after being recorded, so a
 * lane that always throws still shows up in the report (an escalation path that
 * burns 30s before failing is exactly the kind of thing we are hunting).
 */
export function span<T>(lane: string, fn: () => T | Promise<T>): Promise<T> {
  // Accepts a sync-or-async thunk: several instrumented seams are typed to allow a
  // synchronous return (reasoning/search.ts's Verifier is `Verdict | Promise<Verdict>`),
  // and requiring Promise there would force a cast at the call site.
  if (!ENABLED || !session) return Promise.resolve(fn())
  const startedAt = Date.now()
  const frame: Frame = { childMs: 0 }
  const finish = () => {
    const totalMs = Date.now() - startedAt
    record(lane, Math.max(0, totalMs - frame.childMs), totalMs, startedAt)
    // `als.getStore()` here resolves in the CALLER's async context, i.e. the parent
    // frame — the child frame is only in scope inside als.run's callback.
    const parent = als.getStore()
    if (parent) parent.childMs += totalMs
  }
  return Promise.resolve(als.run(frame, fn)).then(
    v => { finish(); return v },
    e => { finish(); throw e },
  )
}

/** Synchronous variant, for lanes that are CPU-bound rather than awaited (tsc spawn, AST walks). */
export function spanSync<T>(lane: string, fn: () => T): T {
  if (!ENABLED || !session) return fn()
  const startedAt = Date.now()
  const frame: Frame = { childMs: 0 }
  try {
    return als.run(frame, fn)
  } finally {
    const totalMs = Date.now() - startedAt
    record(lane, Math.max(0, totalMs - frame.childMs), totalMs, startedAt)
    const parent = als.getStore()
    if (parent) parent.childMs += totalMs
  }
}

export interface ProfileReport {
  taskId: string
  wallMs: number
  /** Sum of every lane's self time. Compare against wallMs — see `concurrency`. */
  attributedMs: number
  /**
   * attributedMs / wallMs.
   *
   * >1 means lanes ran CONCURRENTLY: two awaited-in-parallel spans each legitimately own the
   * same wall-clock window, so their self times both count and the total exceeds the wall.
   * (Measured on caseCompareModule: 1.21 — the planner runs steps in parallel.) The per-lane
   * numbers stay meaningful as "seconds spent inside this lane", and the RANKING is what the
   * profile is for; but a lane's share must NOT be read as a share of the critical path when
   * this is above 1. <1 means instrumented lanes missed wall time — see unattributedMs.
   */
  concurrency: number
  /** Wall time not claimed by any instrumented lane (0 when concurrency > 1). A large value
   *  means the instrumentation is missing the real cost centre — a TODO, not noise. */
  unattributedMs: number
  lanes: LaneStat[]
}

/** Snapshot the current attribution without ending it. */
export function profileReport(): ProfileReport | null {
  if (!ENABLED || !session) return null
  const wallMs = Date.now() - session.startedAt
  const lanes = [...session.lanes.values()].sort((a, b) => b.selfMs - a.selfMs)
  // Only TOP-LEVEL self time is comparable to wall time; nested lanes' self time is
  // already inside a parent's total. Summing every lane's SELF time is exactly right:
  // by construction each millisecond of wall time is claimed by at most one lane.
  const attributedMs = lanes.reduce((n, l) => n + l.selfMs, 0)
  return {
    taskId: session.taskId,
    wallMs,
    attributedMs,
    concurrency: attributedMs / Math.max(1, wallMs),
    unattributedMs: Math.max(0, wallMs - attributedMs),
    lanes,
  }
}

/** Human-readable breakdown, widest lane first. */
export function formatProfile(r: ProfileReport): string {
  // Percentages are of ATTRIBUTED time, not of wall time. Under concurrency the lane self
  // times sum past the wall, so "% of wall" would print a column that adds to >100 and
  // silently invites the reader to treat a lane as a share of the critical path.
  const pct = (ms: number) => `${((ms / Math.max(1, r.attributedMs)) * 100).toFixed(1)}%`
  const rows = r.lanes.map(l =>
    `  ${l.lane.padEnd(26)} self=${(l.selfMs / 1000).toFixed(1).padStart(7)}s ${pct(l.selfMs).padStart(6)}` +
    `  calls=${String(l.calls).padStart(3)}  avg=${(l.totalMs / Math.max(1, l.calls) / 1000).toFixed(1).padStart(6)}s` +
    `  max=${(l.maxMs / 1000).toFixed(1).padStart(6)}s`,
  )
  const head = `[PHASE_PROFILE] task=${r.taskId} wall=${(r.wallMs / 1000).toFixed(1)}s ` +
    `attributed=${(r.attributedMs / 1000).toFixed(1)}s concurrency=${r.concurrency.toFixed(2)}x`
  const foot = r.concurrency > 1.05
    ? `  NOTE concurrency=${r.concurrency.toFixed(2)}x — lanes overlap in wall time, so a lane's %` +
      `\n       is its share of TOTAL WORK, not of the critical path. Ranking is still valid.`
    : `  ${'(unattributed)'.padEnd(26)} self=${(r.unattributedMs / 1000).toFixed(1).padStart(7)}s ${pct(r.unattributedMs).padStart(6)}`
  return [head, ...rows, foot].join('\n')
}

/** Finish attribution, write the breakdown to stderr, and return it for SSE emission. */
export function endProfile(): ProfileReport | null {
  const r = profileReport()
  if (r) process.stderr.write(formatProfile(r) + '\n')
  session = null
  return r
}

export function profileEnabled(): boolean { return ENABLED }
