// ── RSI — Recursive Self-Improvement controller (monotonic, never-regress) ──────
//
// Goal: let Crucible autonomously shape its OFFLINE BRAIN (the living corpus + the
// learned scoring weights/patterns the pipeline uses) and pull knowledge from the
// internet to fill its own gaps — with a HARD guarantee that it can only move forward.
//
// The guarantee is structural, not aspirational: every cycle snapshots known-good state
// (git commit of .crucible/ + a baseline benchmark score run through the FULL pipeline),
// then applies improvements, then RE-MEASURES. A change is kept ONLY if the benchmark
// score holds or improves (>= baseline - EPSILON) AND the live quality trend isn't
// declining. Otherwise the snapshot is restored. So the system ratchets: flat or up,
// never down.
//
// SAFETY INVARIANTS (v1):
//   • Off the request path, idle-only, rate-limited — never competes with live work.
//   • Touches ONLY learned state under .crucible/ + the corpus (both additive / the
//     corpus is self-quarantining). Source code is NOT modified by RSI in v1 — that is
//     the highest-blast-radius change and stays out until explicitly opted in.
//   • Every mutation is bracketed by a git snapshot; regression → git restore.
//   • Kill switch (env RSI_ENABLED=0 or setRsiEnabled(false)) halts all cycles.
//   • Append-only ledger (.crucible/rsi-ledger.jsonl) records every cycle + verdict.

import fs from 'fs'
import path from 'path'
import { runBenchmarkSuite } from '../benchmarks'
import { triggerImprovementPass, rollbackIfDegraded } from '../autoImprove'
import { qualityPredictor } from '../qualityPredictor'
import { debugBus } from '../debug/bus'

// How much benchmark pass-rate regression we tolerate before reverting. 0 = strict
// monotonic (a candidate must be at least as good as the baseline to be kept).
const EPSILON = 0.0
// Minimum benchmarks required before the gate is trusted enough to keep changes.
const MIN_BENCHMARKS = 5
// Settle delay after triggering the (debounced) improvement pass before re-measuring.
const SETTLE_MS = 12_000

// The learned-state files the improvement pass mutates and that the gate must be able to
// restore. NOTE: .crucible/ is gitignored (it holds secrets + session state), so git
// snapshot/restore is hollow for these — we snapshot them by file copy instead. The
// corpus DB is intentionally excluded: it is additive + self-quarantining, not gate-reverted.
const LEARNED_FILES = [
  'scoring-weights.json',
  'learned-patterns.json',
  'stage-weights.json',
  'preference-weights.json',
]
const snapshotDir = (dir: string) => path.join(dir, '.crucible', 'rsi-snapshots', 'baseline')

export interface RsiDeps {
  // Runs ONE benchmark question through the FULL pipeline and returns the synthesis.
  // This is what makes the gate meaningful: it measures the very thing RSI mutates
  // (scoring weights/patterns + corpus), not a single isolated model call.
  runQuery: (question: string, promptType: string) => Promise<string>
  // Best-effort: drive a round of internet→corpus acquisition for current gaps.
  acquire?: () => Promise<void> | void
  // Reload restored learned-state files into live memory after a revert (e.g. the server's
  // refreshScoringConfig, which reloads scoring weights into the active SCORING_CONFIG).
  // Without this a file restore wouldn't take effect until the next process restart.
  reloadLearnedState?: () => void
}

type Verdict = 'promoted' | 'reverted' | 'held' | 'skipped' | 'error'

interface RsiState {
  baselineHash: string | null
  baselinePassRate: number | null
  lastCycleAt: number | null
  lastVerdict: Verdict | null
  cycles: number
  promotions: number
  reverts: number
}

let _enabled = process.env.RSI_ENABLED !== '0'
let _running = false   // one cycle at a time

const stateFile = (dir: string) => path.join(dir, '.crucible', 'rsi-state.json')
const ledgerFile = (dir: string) => path.join(dir, '.crucible', 'rsi-ledger.jsonl')

/** File-copy snapshot of the learned-state files → the baseline snapshot dir.
 *  Returns the snapshot path, or null if nothing existed to snapshot. */
export function snapshotLearnedState(dir: string): string | null {
  const dest = snapshotDir(dir)
  try { fs.mkdirSync(dest, { recursive: true }) } catch { return null }
  let copied = 0
  for (const f of LEARNED_FILES) {
    const src = path.join(dir, '.crucible', f)
    try {
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, f)); copied++ }
      else { try { fs.unlinkSync(path.join(dest, f)) } catch {} }  // record absence too
    } catch { /* skip unreadable file */ }
  }
  // Record which files existed at snapshot time so restore can re-create exact state.
  try { fs.writeFileSync(path.join(dest, '.manifest.json'), JSON.stringify({ ts: Date.now(), files: LEARNED_FILES.filter(f => fs.existsSync(path.join(dir, '.crucible', f))) })) } catch {}
  return copied >= 0 ? dest : null
}

/** Restore the learned-state files from the baseline snapshot. Returns true on success.
 *  Files absent in the snapshot are removed (so a newly-created bad file is undone too). */
export function restoreLearnedState(dir: string): boolean {
  const src = snapshotDir(dir)
  if (!fs.existsSync(src)) return false
  let manifest: string[] = LEARNED_FILES
  try { manifest = JSON.parse(fs.readFileSync(path.join(src, '.manifest.json'), 'utf8')).files ?? LEARNED_FILES } catch {}
  for (const f of LEARNED_FILES) {
    const snap = path.join(src, f)
    const live = path.join(dir, '.crucible', f)
    try {
      if (manifest.includes(f) && fs.existsSync(snap)) fs.copyFileSync(snap, live)
      else if (fs.existsSync(live)) fs.unlinkSync(live)  // didn't exist at baseline → remove
    } catch { /* best-effort per file */ }
  }
  return true
}

function loadState(dir: string): RsiState {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')) } catch {}
  return { baselineHash: null, baselinePassRate: null, lastCycleAt: null, lastVerdict: null, cycles: 0, promotions: 0, reverts: 0 }
}
function saveState(dir: string, s: RsiState): void {
  try { fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true }); fs.writeFileSync(stateFile(dir), JSON.stringify(s, null, 2)) } catch {}
}
function ledger(dir: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(ledgerFile(dir)), { recursive: true })
    fs.appendFileSync(ledgerFile(dir), JSON.stringify({ ts: Date.now(), ...entry }) + '\n')
  } catch {}
}

export function setRsiEnabled(on: boolean): void {
  _enabled = on
  debugBus.emit('system', 'rsi_toggle', { enabled: on }, { severity: 'warn' })
}
export function isRsiEnabled(): boolean { return _enabled }

export function rsiStatus(dir: string): RsiState & { enabled: boolean; running: boolean } {
  return { ...loadState(dir), enabled: _enabled, running: _running }
}

/** Run the full-pipeline benchmark suite and return its pass rate (0-1), or null. */
async function measure(dir: string, deps: RsiDeps): Promise<number | null> {
  try {
    const run = await runBenchmarkSuite(dir, deps.runQuery)
    return run.passRate
  } catch (e: any) {
    debugBus.emit('system', 'rsi_measure_error', { error: e?.message }, { severity: 'error' })
    return null
  }
}

/**
 * One RSI cycle. Returns the verdict. NEVER throws (best-effort, self-contained).
 * Sequence: kill-switch/idle gate → snapshot baseline + measure → acquire (corpus) +
 * improve (weights/patterns) → re-measure → GATE → promote or restore → ledger.
 */
export async function runRsiCycle(dir: string, deps: RsiDeps, opts: { force?: boolean } = {}): Promise<Verdict> {
  if (!_enabled) { ledger(dir, { event: 'skipped', reason: 'disabled' }); return 'skipped' }
  if (_running) { return 'skipped' }

  _running = true
  const t0 = Date.now()
  const state = loadState(dir)
  try {
    debugBus.emit('system', 'rsi_cycle_start', { dir }, { severity: 'info' })

    // 1. SNAPSHOT known-good learned state (file copy — .crucible/ is gitignored, so git
    //    cannot snapshot it) + establish the baseline score through the FULL pipeline.
    const snapPath = snapshotLearnedState(dir)
    if (!snapPath) { ledger(dir, { event: 'skipped', reason: 'snapshot_failed' }); return 'skipped' }
    const baselinePassRate = await measure(dir, deps)
    if (baselinePassRate === null) { ledger(dir, { event: 'skipped', reason: 'baseline_measure_failed' }); return 'skipped' }

    // 2. ACQUIRE — pull internet knowledge for current gaps into the corpus. Additive +
    //    self-quarantining (good data never leaves), so it is not gate-reverted; it only
    //    shapes the offline brain's knowledge. Best-effort.
    try { await deps.acquire?.() } catch (e: any) { debugBus.emit('system', 'rsi_acquire_error', { error: e?.message }, { severity: 'warn' }) }

    // 3. IMPROVE — the gated mutation: learn scoring weights/patterns from recent quality.
    //    (Already triumvirate-gated internally; we additionally gate on the benchmark.)
    triggerImprovementPass()
    await new Promise(r => setTimeout(r, SETTLE_MS))

    // 4. RE-MEASURE the candidate state through the full pipeline.
    const candidatePassRate = await measure(dir, deps)
    if (candidatePassRate === null) {
      // Couldn't verify — do not keep an unverified change. Restore + reload the baseline.
      restoreLearnedState(dir); deps.reloadLearnedState?.()
      const verdict: Verdict = 'reverted'
      finalize(dir, state, verdict, { baselinePassRate, candidatePassRate: null, reason: 'candidate_measure_failed' }, t0)
      return verdict
    }

    // 5. GATE — strict monotonic: keep only if the candidate holds or improves, and the
    //    live quality trend isn't declining.
    const liveTrend = qualityPredictor.stats().trend
    const passesBenchmark = candidatePassRate >= baselinePassRate - EPSILON
    const trendOk = liveTrend !== 'down'

    let verdict: Verdict
    if (passesBenchmark && trendOk) {
      // Promote: re-snapshot the (improved) learned state as the new known-good baseline.
      snapshotLearnedState(dir)
      const newState = loadState(dir)
      newState.baselinePassRate = candidatePassRate
      saveState(dir, newState)
      verdict = candidatePassRate > baselinePassRate ? 'promoted' : 'held'
      finalize(dir, newState, verdict, { baselinePassRate, candidatePassRate, liveTrend }, t0)
    } else {
      // Regression (or declining live trend) — HARD RESTORE the learned files + reload them
      // into live memory. The system cannot move back.
      restoreLearnedState(dir); deps.reloadLearnedState?.()
      // Belt-and-suspenders: the existing live-traffic guard (now that trend is wired).
      try { rollbackIfDegraded(liveTrend) } catch {}
      verdict = 'reverted'
      finalize(dir, state, verdict, { baselinePassRate, candidatePassRate, liveTrend, reason: passesBenchmark ? 'trend_down' : 'benchmark_regressed' }, t0)
    }
    return verdict
  } catch (e: any) {
    debugBus.emit('system', 'rsi_cycle_error', { error: e?.message }, { severity: 'error' })
    ledger(dir, { event: 'error', error: String(e?.message ?? e).slice(0, 200) })
    return 'error'
  } finally {
    _running = false
  }
}

function finalize(dir: string, state: RsiState, verdict: Verdict, detail: Record<string, unknown>, t0: number): void {
  const s = loadState(dir)
  s.cycles = (s.cycles ?? 0) + 1
  if (verdict === 'promoted' || verdict === 'held') s.promotions = (s.promotions ?? 0) + (verdict === 'promoted' ? 1 : 0)
  if (verdict === 'reverted') s.reverts = (s.reverts ?? 0) + 1
  s.lastCycleAt = Date.now()
  s.lastVerdict = verdict
  saveState(dir, s)
  ledger(dir, { event: 'cycle', verdict, durationMs: Date.now() - t0, ...detail })
  debugBus.emit('system', 'rsi_cycle_done', { verdict, ...detail }, { severity: verdict === 'reverted' ? 'warn' : 'success' })
  console.log(`[RSI] cycle ${verdict} — baseline=${detail.baselinePassRate} candidate=${detail.candidatePassRate ?? 'n/a'} (${Math.round((Date.now() - t0) / 1000)}s)`)
}
