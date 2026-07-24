// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decomposition probe — the coinChange ceiling (fifth 0%-by-sampling class).
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_coinchange_live.ts   (live head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE QUESTION. coinChange — fewest coins (unbounded supply) to make an amount, -1 if
// impossible — is the fifth template class. Greedy is provably wrong (coins [1,5,6,9],
// amount 11 → 2, not the 9+1+1 greedy would take), and a flat sample rarely draws the
// bottom-up DP, so it stays world (B). The doctrine's lever is the SMALLER STEP: carve
// into initDp (the amount+1 sentinel table) → relaxCoin (one unbounded relaxation pass)
// → the fold. This runs the REAL decomposeCodeBySubFunction (routing through fmPlanner's
// isCoinChangeGoal → coinChangeTemplatePlan + composeHintFor) against the live head and
// reports whether the composed whole certifies. Honest measurement, not a test.
//
//   COIN_FLATFIRST=1   also run the flat solveCodeTask first, to show the contrast live.

import { decomposeCodeBySubFunction, solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'

const ENTRY = 'coinChange'
const GOAL =
  'Write coinChange(coins: number[], amount: number): number returning the fewest coins ' +
  '(each denomination available in unlimited supply) that sum to exactly amount, or -1 if no ' +
  'combination does. amount is a non-negative integer and coins are positive integers.'
const CASES: CodeAcceptance['cases'] = [
  { args: [[1, 2, 5], 11], expected: 3 },
  { args: [[2], 3], expected: -1 },
  { args: [[1], 0], expected: 0 },
  { args: [[1, 5, 6, 9], 11], expected: 2 },
  { args: [[2, 5, 10], 27], expected: 4 },
]

async function main(): Promise<void> {
  console.log(`# LIVE decompose probe — ${ENTRY} (min-coins unbounded DP)\n`)

  if (process.env.COIN_FLATFIRST === '1') {
    process.stdout.write('flat solveCodeTask (baseline: greedy is wrong, flat DP is rare) … ')
    const t0 = Date.now()
    const flat = await solveCodeTask({ goal: GOAL, entry: ENTRY, cases: CASES }, { maxModelCalls: 12, beamWidth: 3 })
    console.log(`${flat.status} in ${flat.modelCalls} call(s) [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  }

  process.stdout.write('sub-function decomposition (initDp → relaxCoin → fold) … ')
  const t1 = Date.now()
  const rungIterate = {
    globalModelCalls: Number(process.env.COIN_RUNG_CALLS || 24),
    wallClockMs: Number(process.env.COIN_RUNG_TIMEOUT || 240_000),
    maxEpochs: Number(process.env.COIN_RUNG_EPOCHS || 6),
  }
  const d = await decomposeCodeBySubFunction(
    { goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    {
      planAttempts: Number(process.env.COIN_PLAN_ATTEMPTS || 3),
      iterate: rungIterate,
      emit: (e: any) => { if (e?.type === 'thought') console.log(`\n    · ${e.text}`) },
    },
  )
  console.log(`\n\n# RESULT: ${d.status} — ${d.detail}`)
  console.log(`# ${d.helpers.length} helper(s): ${d.helpers.map(h => h.name).join(', ') || '(none)'}`)
  console.log(`# rungs: ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join('  ')}`)
  console.log(`# model calls: ${d.modelCalls}, wall ${((Date.now() - t1) / 1000).toFixed(0)}s`)
  if (d.status === 'solved' && d.code) {
    console.log('\n# CERTIFIED module (re-verified against all 5 adversarial cases):\n')
    console.log(d.code)
  }
  console.log('\n' + JSON.stringify({ decompose_coinchange: true, status: d.status, helpers: d.helpers.length, modelCalls: d.modelCalls }))
}

main().catch(e => { console.error('decompose coinchange probe failed:', e); process.exit(1) })
