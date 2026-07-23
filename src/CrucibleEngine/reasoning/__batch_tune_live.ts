// ═══════════════════════════════════════════════════════════════════════════════
// LIVE batch-tuning probe (item 3) — solves-per-wall-second vs CRUCIBLE_VGR_BATCH_PROPOSALS.
// Run:  npx tsx src/CrucibleEngine/reasoning/__batch_tune_live.ts   (needs a head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// W3 continuous batching draws K proposals per round CONCURRENTLY across the head's KV slots.
// Decode is bandwidth-bound, so K concurrent draws cost ~1.1-1.3× one draw, not K× — meaning
// under a FIXED wall-clock cap more draws per round convert to more solves. But the optimum K is
// empirical (slot count, ctx pressure), so this sweeps K ∈ {off,4,6,8} over a moderately-hard,
// multi-draw-to-solve task and reports wall-seconds + solve for each. The env CRUCIBLE_VGR_BATCH*
// vars are read INSIDE solveCodeTask (batchBudget/useBatch) at call time, so toggling process.env
// between runs here exercises the exact live path the server uses. Honest: a non-solve is reported
// as such; the point is solves-per-wall-second, not a single lucky draw (repeat with BATCH_REPS).

import { solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'

const GOAL =
  'Write mergeIntervals(intervals: number[][]): number[][] that merges all overlapping intervals ' +
  'and returns them sorted ascending by start. Intervals that merely TOUCH (one ends where the next ' +
  'starts) also merge. Input may be unsorted and may contain fully-nested intervals. Empty → [].'
const ENTRY = 'mergeIntervals'
const CASES: CodeAcceptance['cases'] = [
  { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]] },
  { args: [[[1, 4], [4, 5]]], expected: [[1, 5]] },
  { args: [[]], expected: [] },
  { args: [[[1, 10], [2, 3], [4, 8]]], expected: [[1, 10]] },
  { args: [[[8, 10], [1, 3], [2, 6]]], expected: [[1, 6], [8, 10]] },
]

async function runOne(label: string, batch: '0' | '1', props: number): Promise<void> {
  process.env.CRUCIBLE_VGR_BATCH = batch
  process.env.CRUCIBLE_VGR_BATCH_PROPOSALS = String(props)
  const reps = Number(process.env.BATCH_REPS || 3)
  let solves = 0, totalCalls = 0, totalMs = 0
  for (let r = 0; r < reps; r++) {
    const t0 = Date.now()
    const res = await solveCodeTask(
      { goal: GOAL, entry: ENTRY, cases: CASES },
      { maxModelCalls: Number(process.env.BATCH_MAXCALLS || 12), beamWidth: 3 },
    )
    const ms = Date.now() - t0
    totalMs += ms; totalCalls += res.modelCalls
    if (res.status === 'solved') solves++
    process.stdout.write(`  ${label} rep${r + 1}: ${res.status} in ${res.modelCalls} call(s) [${(ms / 1000).toFixed(0)}s]\n`)
  }
  const secsPerSolve = solves ? (totalMs / 1000 / solves).toFixed(1) : '∞'
  console.log(`# ${label}: ${solves}/${reps} solved | ${(totalMs / 1000).toFixed(0)}s total | ${totalCalls} calls | ${secsPerSolve}s/solve\n`)
}

async function main(): Promise<void> {
  console.log(`# batch-tuning — ${ENTRY}, ${Number(process.env.BATCH_REPS || 3)} rep(s)/arm, maxCalls ${Number(process.env.BATCH_MAXCALLS || 12)}\n`)
  await runOne('serial(off)', '0', 1)
  await runOne('batch=4', '1', 4)
  await runOne('batch=6', '1', 6)
  await runOne('batch=8', '1', 8)
  console.log('# lower s/solve is better; batch wins only if concurrent decode stays sub-linear here.')
}

main().catch((e) => { console.error('batch tune probe failed:', e); process.exit(1) })
