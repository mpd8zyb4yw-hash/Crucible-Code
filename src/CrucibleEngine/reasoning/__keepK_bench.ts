// ═══════════════════════════════════════════════════════════════════════════════
// KEEP-K bench — proves candidate retention + verifier-scored selection.
// Run:  npm run keepk:bench
// ═══════════════════════════════════════════════════════════════════════════════
//
// Deterministic (injected proposers, real execution verifier). Proves:
//
//   1. CERTIFY-PASSTHROUGH — a certifiable task returns 'solved' exactly like the
//                            plain retry loop (keep-K is a pure add).
//   2. BEST-ACROSS-ATTEMPTS — when nothing certifies, the returned candidate is the
//                            best-scoring one from ANY attempt, not the last one.
//   3. COVERAGE-EXPOSED    — best-effort reports passed/total derived from the
//                            ground-truth verifier score.
//   4. FLOOR-ABSTAIN       — a best candidate below the floor abstains; keep-K never
//                            ships garbage just because it kept it.
//   5. CALL-ACCOUNTING     — model calls sum across attempts.
// ═══════════════════════════════════════════════════════════════════════════════

import { solveWithKeptCandidates } from './keepK'
import type { Proposer } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// double(x) = 2x with 4 cases. Wrong variants fail a known number of cases.
const CASES = [
  { args: [0], expected: 0 }, { args: [1], expected: 2 },
  { args: [3], expected: 6 }, { args: [-2], expected: -4 },
]
const GOOD = `export function double(x) { return x * 2; }`
const OFF_BY_ONE = `export function double(x) { return x * 2 + 1; }`   // fails 4/4 (0→1, 1→3…)
const HALF_RIGHT = `export function double(x) { return x <= 0 ? x * 2 : 0; }` // passes 0 and -2 → fails 2
const NEAR_MISS = `export function double(x) { return x === 3 ? 7 : x * 2; }` // fails only x=3 → score -1

/** Proposer that emits a fixed sequence, one per call, then repeats the last. */
function sequence(codes: string[]): Proposer<string> {
  let i = 0
  return async () => {
    const value = codes[Math.min(i, codes.length - 1)]
    return { value, fingerprint: `p${i++}` }
  }
}

const INPUT = { goal: 'double a number', entry: 'double', cases: CASES }

async function main() {
  console.log('\nKEEP-K bench — candidate retention + verifier-scored selection\n')

  // ── 1. CERTIFY-PASSTHROUGH ──
  {
    const r = await solveWithKeptCandidates(INPUT, {
      attempts: 3, maxModelCalls: 4, proposer: sequence([OFF_BY_ONE, GOOD]),
    })
    check('1 certifiable task returns solved', r.status === 'solved' && r.code === GOOD, r.detail)
    check('1b coverage is full on solved', r.coverage?.passed === 4 && r.coverage.total === 4)
  }

  // ── 2+3. BEST-ACROSS-ATTEMPTS + COVERAGE-EXPOSED: best candidate (NEAR_MISS, score -1)
  //         appears mid-stream, WORSE ones after; selection must reach back for it. ──
  {
    const r = await solveWithKeptCandidates(INPUT, {
      attempts: 2, maxModelCalls: 2, patience: 2,
      proposer: sequence([HALF_RIGHT, NEAR_MISS, OFF_BY_ONE, OFF_BY_ONE]),
    })
    check('2 best-effort returns best-scoring candidate across attempts',
      r.status === 'best-effort' && r.code === NEAR_MISS, `status=${r.status} score=${r.score}`)
    check('3 coverage derived from ground truth (3/4)',
      r.coverage?.passed === 3 && r.coverage.total === 4, JSON.stringify(r.coverage))
    check('3b score exposed', r.score === -1, `score=${r.score}`)
  }

  // ── 4. FLOOR-ABSTAIN: only garbage candidates → abstain, not best-effort. ──
  {
    const r = await solveWithKeptCandidates(INPUT, {
      attempts: 2, maxModelCalls: 2, patience: 2, minBestEffortScore: -1,
      proposer: sequence([OFF_BY_ONE]),  // score -4, below the -1 floor
    })
    check('4 below-floor best abstains', r.status === 'abstained' && r.code === null, `status=${r.status} score=${r.score}`)
  }

  // ── 5. CALL-ACCOUNTING: 2 attempts × 2 calls = 4 model calls. ──
  {
    const r = await solveWithKeptCandidates(INPUT, {
      attempts: 2, maxModelCalls: 2, patience: 2,
      proposer: sequence([OFF_BY_ONE, HALF_RIGHT, OFF_BY_ONE, HALF_RIGHT]),
    })
    check('5 model calls sum across attempts', r.modelCalls === 4 && r.attemptsRun === 2, `calls=${r.modelCalls} attempts=${r.attemptsRun}`)
  }

  console.log(`\n${pass}/${pass + fail} checks passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
