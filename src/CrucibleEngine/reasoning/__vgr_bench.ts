// ═══════════════════════════════════════════════════════════════════════════════
// VGR bench — proves the thesis: correctness from the LOOP, not the oracle.
// Run:  npm run vgr:bench
// ═══════════════════════════════════════════════════════════════════════════════
//
// The proof has two parts:
//
//   PART A (deterministic, always runs): a MOCK proposer that behaves like a weak,
//   fallible generator — it emits a WRONG implementation first, and only produces a
//   correct one once it has seen the execution verifier's actual-vs-expected feedback.
//   We show:
//     • single-shot (trust the first proposal) SHIPS THE WRONG ANSWER, whereas
//     • the verification-guided loop REJECTS it via execution and converges to a
//       certified-correct solution.
//   This isolates and proves the LOOP mechanism with zero model dependency, so it is
//   stable in CI regardless of whether the on-device FM daemon is up.
//
//   PART B (only if the live FM daemon is up): runs the REAL on-device proposer on a
//   novel task to show the same loop closing over an actual weak model.
// ═══════════════════════════════════════════════════════════════════════════════

import { checkFmAvailable } from '../agent/fmReact'
import { verifyCode } from './codeVerifier'
import { solveCodeTask } from './solve'
import type { Candidate, ProposeContext } from './types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

// ── A novel task: sum only the EVEN numbers in an array. ──────────────────────────
const TASK = {
  goal: 'Write sumEvens(nums) returning the sum of only the even numbers in the array. Empty array → 0.',
  entry: 'sumEvens',
  cases: [
    { args: [[1, 2, 3, 4]], expected: 6 },
    { args: [[2, 4, 6]], expected: 12 },
    { args: [[1, 3, 5]], expected: 0 },
    { args: [[]], expected: 0 },
    { args: [[-2, -3, 8]], expected: 6 },
  ],
}

// A WRONG first guess (sums ALL numbers) — exactly the kind of plausible-but-wrong
// output a weak model emits. Single-shot would ship this.
const WRONG = `export function sumEvens(nums){return nums.reduce((a,b)=>a+b,0)}`
// The CORRECT implementation the mock only reaches after seeing the failure feedback.
const RIGHT = `export function sumEvens(nums){return nums.filter(n=>n%2===0).reduce((a,b)=>a+b,0)}`

function fp(code: string): string {
  const n = code.replace(/\s+/g, ' ').trim(); let h = 5381
  for (let i = 0; i < n.length; i++) h = ((h << 5) + h + n.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}`
}

// Mock weak proposer: emits WRONG until it has been shown a failing verdict, then RIGHT.
// This models "the model debugs itself against ground-truth feedback".
function mockProposer() {
  return async (ctx: ProposeContext<string>): Promise<Candidate<string>> => {
    const sawFailure = ctx.history.some(a => !a.verdict.pass)
    const code = sawFailure ? RIGHT : WRONG
    return { value: code, fingerprint: fp(code) }
  }
}

async function run() {
  console.log('\nVGR bench — correctness from the loop, not the oracle\n')

  // ── PART A ──────────────────────────────────────────────────────────────────────
  console.log('PART A — deterministic loop proof (no model)')

  // 1. Single-shot BASELINE: trust the model's first output. It is WRONG by execution.
  const singleShot = await verifyCode(
    { value: WRONG, fingerprint: fp(WRONG) },
    { goal: TASK.goal, domain: 'code', acceptance: { entry: TASK.entry, cases: TASK.cases } },
  )
  ok('single-shot ships an answer that FAILS ground-truth execution', !singleShot.pass,
    `score ${singleShot.score}: ${singleShot.signals[0]}`)

  // 2. The LOOP: same weak generator, but wrapped in propose→verify→backtrack.
  const looped = await solveCodeTask(TASK, { maxModelCalls: 6, beamWidth: 2 }, mockProposer())
  ok('verification-guided loop CERTIFIES a correct solution', looped.status === 'solved',
    `${looped.status} in ${looped.modelCalls} model call(s)`)
  ok('the loop\'s certified solution actually passes every case',
    !!looped.solution && (await verifyCode(looped.solution, {
      goal: TASK.goal, domain: 'code', acceptance: { entry: TASK.entry, cases: TASK.cases },
    })).pass)
  ok('the loop used the failure feedback (took >1 attempt, proving it did not luck into it)',
    looped.attempts.length >= 2, `${looped.attempts.length} attempts`)

  // 3. Honest abstain: a hopeless proposer must ABSTAIN, never ship a wrong answer.
  const hopeless = await solveCodeTask(TASK, { maxModelCalls: 4, beamWidth: 1 },
    async () => ({ value: WRONG, fingerprint: fp(WRONG) }))  // never improves
  ok('a proposer that never converges ABSTAINS honestly (no wrong answer shipped)',
    hopeless.status !== 'solved' && hopeless.solution === null,
    `status ${hopeless.status}`)

  // ── PART B ──────────────────────────────────────────────────────────────────────
  const fmUp = await checkFmAvailable()
  console.log(`\nPART B — live on-device FM proposer ${fmUp ? '(daemon UP)' : '(SKIPPED — daemon down)'}`)
  if (fmUp) {
    const live = await solveCodeTask({
      goal: 'Write dedupeStable(arr) that removes duplicate values from an array while preserving first-seen order.',
      entry: 'dedupeStable',
      cases: [
        { args: [[1, 1, 2, 3, 3, 1]], expected: [1, 2, 3] },
        { args: [['a', 'b', 'a', 'c']], expected: ['a', 'b', 'c'] },
        { args: [[]], expected: [] },
      ],
    }, { maxModelCalls: 8, beamWidth: 2 })
    console.log(`    live result: ${live.status} in ${live.modelCalls} call(s) — ${live.detail}`)
    ok('live on-device loop reaches a certified solution OR abstains honestly (never ships unverified)',
      live.status === 'solved' || live.solution === null)
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

run().catch(e => { console.error(e); process.exit(1) })
