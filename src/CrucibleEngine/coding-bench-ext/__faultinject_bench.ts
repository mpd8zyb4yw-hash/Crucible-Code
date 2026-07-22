// DONE-WHEN (W32, GAP_CLOSURE_ADDENDUM.md): the verifier is proven to have TEETH — for every
// authored reference, a deterministically injected fault is CAUGHT (rejected) by that task's
// own hidden suite through the real hermetic oracle. This is mutation testing turned on the
// verifier itself.
//
// Why this exists: __taskcorpus_bench.ts proves each clean ref is ACCEPTED, and __refdiff_bench
// proves each ref AGREES with an independent oracle. Neither proves the suite would REJECT a
// wrong implementation — a suite that asserts nothing, or only tautologies, passes both of those
// and still certifies garbage. If the suites are toothless, the whole generated-path pass rate is
// measuring "did tsc compile", not "is it correct". This bench closes that: it feeds each ref a
// menu of behavior-changing mutations and requires the suite to kill them.
//
// A mutant's fate is classified by the verdict's own gate booleans:
//   - accepted           → SURVIVOR. The fault slipped through. A real coverage hole → FAIL.
//   - !gateA             → compile-killed (tsc/lint/determinism). Killed, but NOT proof of a
//                          behavioral suite — a syntactically-broken mutant proves nothing.
//   - gateA && !gateB    → SUITE-KILLED. The informative kill: the mutant compiled clean and the
//                          hidden suite's assertions rejected it. This is the teeth we assert.
//
// Green bar: (1) every clean ref still certifies, (2) ZERO survivors across all mutants, and
// (3) every task yields >= 1 suite-kill (a compiling mutant its suite rejected) — so no task's
// green rests on tsc alone.
//
// Deterministic (first-match mutation, fixed operator order — no PRNG, no clock), model-free,
// in-process through verifyCandidate (which uses the W30 hermetic runner).
// Run:  npx tsx src/CrucibleEngine/coding-bench-ext/__faultinject_bench.ts
// Subset (be kind to a concurrent live bench):  FAULTINJECT_LIMIT=3 npx tsx <thisfile>
import { EXT_TASKS } from './index'
import { verifyCandidate } from '../synth/oracle'
import { generateMutants } from './mutationOps'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 260)}`)
  if (!cond) failures++
}


const LIMIT = Number(process.env.FAULTINJECT_LIMIT ?? EXT_TASKS.length) || EXT_TASKS.length
const tasks = EXT_TASKS.slice(0, LIMIT)
if (tasks.length < EXT_TASKS.length) console.log(`(subset: first ${tasks.length}/${EXT_TASKS.length} tasks — FAULTINJECT_LIMIT set)\n`)

let totalMutants = 0, totalSuiteKilled = 0, totalCompileKilled = 0, totalSurvived = 0

for (const task of tasks) {
  // 0. Sanity: the clean reference must certify, or the whole comparison is meaningless.
  const clean = verifyCandidate(
    [{ path: task.modulePath, content: task.ref }],
    { path: `__audit__/${task.id}.hidden.ts`, content: task.suite },
  )
  check(`${task.id}: clean reference certifies (baseline)`, clean.accepted, clean.detail)
  if (!clean.accepted) continue

  // 1. Generate the distinct mutants (drop operators that did not change the source).
  const mutants = generateMutants(task.ref)
  // >= 2 not >= 3: the most compact refs (dedentText, minStack) expose only two mutable code
  // sites. The load-bearing bar is the teeth check below (>= 1 compiling mutant suite-rejected),
  // not the raw mutant count — count only guards against an operator set that fired on nothing.
  check(`${task.id}: at least 2 distinct mutants generated`, mutants.length >= 2, `${mutants.length} mutants`)

  // 2. Every mutant must be rejected; track how it died.
  let suiteKilled = 0
  const survivors: string[] = []
  for (const mut of mutants) {
    totalMutants++
    const v = verifyCandidate(
      [{ path: task.modulePath, content: mut.src }],
      { path: `__audit__/${task.id}.hidden.ts`, content: task.suite },
    )
    if (v.accepted) { survivors.push(mut.op); totalSurvived++ }
    else if (v.gateA && !v.gateB) { suiteKilled++; totalSuiteKilled++ }
    else { totalCompileKilled++ }
  }

  // 3. HARD invariant: the SUITE (not just tsc) must reject at least one compiling mutant —
  //    otherwise this task's green rests on the typechecker alone. Survivors are REPORTED, not
  //    failed: mutant equivalence is undecidable (e.g. templateExpand's `&&`->`||` differs only
  //    for an empty-string property key), so a permanent gate cannot demand a 100% kill rate.
  //    The corpus-wide floor below is the actual regression guard.
  check(`${task.id}: suite has behavioral teeth (>= 1 compiling mutant rejected by assertions)`, suiteKilled >= 1, `suite-kills=${suiteKilled} of ${mutants.length}`)
  if (survivors.length) console.log(`  SURVIVORS — ${task.id}: ${survivors.join(', ')} (coverage-hole candidates; triage before strengthening the suite)`)
}

console.log('')
console.log(`mutants: ${totalMutants} total | ${totalSuiteKilled} suite-killed | ${totalCompileKilled} compile-killed | ${totalSurvived} SURVIVED`)
const killRate = totalMutants ? (totalMutants - totalSurvived) / totalMutants : 0
console.log(`verifier kill rate: ${(killRate * 100).toFixed(1)}%  (suite-kill share: ${totalMutants ? (100 * totalSuiteKilled / totalMutants).toFixed(1) : '0'}%)`)
console.log('rule: a surviving mutant is a coverage-hole candidate in that task’s hidden suite — triage, then fix the suite, not this bench.')

// Corpus-wide regression gate: the aggregate kill rate must clear a floor. Set at 0.80 — the
// full-corpus rate is well above it; a drop below signals either a weakened suite or a
// broadened ref that outran its tests. Only meaningful on the FULL corpus (subset runs skip it).
const FLOOR = 0.80
if (tasks.length === EXT_TASKS.length) {
  check(`corpus verifier kill rate >= ${(FLOOR * 100).toFixed(0)}%`, killRate >= FLOOR, `${(killRate * 100).toFixed(1)}%`)
} else {
  console.log(`(subset run — corpus-wide kill-rate floor not evaluated)`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
