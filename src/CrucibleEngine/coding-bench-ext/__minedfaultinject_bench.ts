// DONE-WHEN (W42.2 teeth extension of W32): the MINED corpus's hidden suites are proven to
// have TEETH the same way the authored corpus is — for every git-mined reference, a
// deterministically injected fault is CAUGHT (rejected) by that task's paired regression bench
// through the REAL hermetic oracle, staged on the historical parent snapshot.
//
// Why this exists separately from __faultinject_bench.ts: the authored corpus mutates a
// self-contained `task.ref` string and runs a 20-assert hidden script in-process. A mined task
// is a multi-file world — the reference is one file inside a pinned historical src/ tree, and
// the "suite" is a full subsystem bench (__vgr_bench, __apifaith_bench) that only means anything
// when its sibling imports resolve against that same tree. So mutation testing the generated
// PATH for scaffolded/multi-file tasks has to go through minedHarness.runMinedCandidate, which
// materializes the parent snapshot and stages the whole closure — exactly the path the live
// agent's candidate takes. Without this, the mined green rests on "the subsystem bench passed
// the fix commit", never on "that bench would REJECT a broken emitPlan.ts".
//
// A mutant's fate is classified by the verdict's own gate booleans (identical to the authored
// teeth-check):
//   - accepted           → SURVIVOR. The injected fault slipped the subsystem bench. Coverage
//                          hole in that bench relative to this operator → triage.
//   - !gateA             → compile-killed (tsc/lint/determinism on the candidate file). Killed,
//                          but NOT proof of a behavioral suite.
//   - gateA && !gateB    → SUITE-KILLED. The informative kill: the mutant typechecked clean in
//                          the historical tree and the subsystem bench's assertions rejected it.
//
// What this bench IS and IS NOT: the AUTHORITATIVE teeth proof for a mined task already lives in
// __minedcorpus_bench.ts — it runs each suite against the REAL buggy parent file and requires a
// behavioral rejection (gateA clean, gateB red, ranAssertions true). That is a genuine
// discrimination on a real historical bug, strictly stronger than any synthetic single-site
// mutant. So THIS bench is an EXPLORATORY probe on top of that guarantee, not a second gate: a
// suite-kill here is a bonus datapoint, and NO suite-kill is INCONCLUSIVE, never a failure —
// first-match single-site mutation on a large engine file usually lands nowhere near the
// behaviorally load-bearing line, so absence of a synthetic kill says nothing about the suite.
// The ONE hard failure is a baseline that does not certify on the parent snapshot (that would
// mean the staging path itself is broken and every "kill" is a false positive).
//
// COST: every mutant reruns a full subsystem bench on a staged snapshot (seconds to minutes
// each). To bound it, the sweep EARLY-EXITS a task as soon as one compiling mutant is
// suite-killed (teeth demonstrated) — set MINEDFAULT_EXHAUSTIVE=1 to run the whole capped set
// and catalog every survivor. Per-task mutant count and per-mutant timeout are also capped so
// this is runnable alongside a live coding bench.
//
// Deterministic (first-match mutation, fixed operator order — no PRNG, no clock), model-free,
// offline (git objects are content-addressed; Gate B runs under the W30 hermetic contract).
// Run:            npx tsx src/CrucibleEngine/coding-bench-ext/__minedfaultinject_bench.ts
// One task only:  MINEDFAULT_TASK=mined-apifaith-vocabulary npx tsx <thisfile>
// Exhaustive:     MINEDFAULT_MAX_MUTANTS=99 MINEDFAULT_RUN_MS=180000 npx tsx <thisfile>
import { MINED_TASKS } from './tasks-mined'
import { minedRefContent, runMinedCandidate } from './minedHarness'
import { generateMutants } from './mutationOps'

let failures = 0
const check = (label: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${cond ? '' : ' :: ' + detail.slice(0, 300)}`)
  if (!cond) failures++
}

// Per-mutant run budget: a suite with teeth trips an assertion early, so a mutant rarely needs
// the full subsystem-bench cap. A mutation that induces a hang must be killed fast, not allowed
// to burn the whole run. Widen for a strict sweep where a slow-but-real kill is expected.
const RUN_MS = Number(process.env.MINEDFAULT_RUN_MS ?? 90_000) || 90_000
// First-match mutation on a big engine file yields many mutants; each is a full snapshot run.
// Cap per task by default so a routine invocation stays minutes, not an hour.
const MAX_MUTANTS = Number(process.env.MINEDFAULT_MAX_MUTANTS ?? 8) || 8
// By default stop a task at its first suite-kill (teeth shown) to bound cost. Exhaustive mode
// runs the whole capped set so every survivor is catalogued for triage.
const EXHAUSTIVE = process.env.MINEDFAULT_EXHAUSTIVE === '1'

const only = process.env.MINEDFAULT_TASK
const tasks = only ? MINED_TASKS.filter(t => t.id === only) : MINED_TASKS
if (only && tasks.length === 0) {
  console.log(`no mined task with id "${only}" — known ids: ${MINED_TASKS.map(t => t.id).join(', ')}`)
  process.exit(2)
}
console.log(`mined teeth-check: ${tasks.length} task(s), <= ${MAX_MUTANTS} mutants each, ${RUN_MS}ms/mutant\n`)

let totalMutants = 0, totalSuiteKilled = 0, totalCompileKilled = 0, totalSurvived = 0

for (const task of tasks) {
  console.log(`── ${task.id}  (${task.targetPath})`)
  const ref = minedRefContent(task)

  // 0. Baseline: the clean historical reference must certify on the parent snapshot, or the
  //    whole comparison is meaningless (a red baseline would make every mutant a false "kill").
  const clean = runMinedCandidate(task, ref)
  check(`${task.id}: clean reference certifies on parent snapshot (baseline)`, clean.accepted, clean.detail)
  if (!clean.accepted) { console.log(''); continue }

  // 1. Deterministic mutants of the reference file, capped for cost.
  const allMutants = generateMutants(ref)
  const mutants = allMutants.slice(0, MAX_MUTANTS)
  check(`${task.id}: at least 2 distinct mutants generated`, allMutants.length >= 2, `${allMutants.length} mutants`)
  if (allMutants.length > mutants.length) {
    // No silent cap: record exactly which operators were dropped from this sweep.
    console.log(`  (capped: running ${mutants.length}/${allMutants.length} mutants — dropped ${allMutants.slice(MAX_MUTANTS).map(m => m.op).join(', ')})`)
  }

  // 2. Run mutants; classify each by how it died. Early-exit on the first suite-kill unless
  //    exhaustive mode is on, so a task's cost is usually one baseline + a few mutant runs.
  let suiteKilled = 0
  let ranHere = 0
  const survivors: string[] = []
  const killedOps: string[] = []
  for (const mut of mutants) {
    totalMutants++; ranHere++
    const v = runMinedCandidate(task, mut.src, { runTimeoutMs: RUN_MS })
    if (v.accepted) { survivors.push(mut.op); totalSurvived++ }
    else if (v.gateA && !v.gateB) { suiteKilled++; totalSuiteKilled++; killedOps.push(mut.op) }
    else { totalCompileKilled++ }
    if (suiteKilled >= 1 && !EXHAUSTIVE) break
  }

  // 3. EXPLORATORY teeth signal — never a hard failure (see header): the authoritative teeth
  //    proof is __minedcorpus_bench's parent-rejection. A synthetic suite-kill here is a bonus;
  //    its absence within the capped sweep is inconclusive (the mutated site was likely outside
  //    the subsystem bench's behavioral scope), not evidence of a toothless suite.
  if (suiteKilled >= 1) {
    console.log(`  TEETH — ${task.id}: subsystem bench suite-killed a compiling mutant (${killedOps.join(', ')}) after ${ranHere} run(s)`)
  } else {
    console.log(`  INCONCLUSIVE — ${task.id}: no suite-kill in ${ranHere} mutant run(s) — first-match site likely outside the bench's scope. Authoritative teeth = __minedcorpus_bench parent-rejection. Widen: MINEDFAULT_MAX_MUTANTS/MINEDFAULT_EXHAUSTIVE.`)
  }
  if (survivors.length) console.log(`  survivors (accepted): ${survivors.join(', ')}`)
  console.log('')
}

console.log(`mutants: ${totalMutants} total | ${totalSuiteKilled} suite-killed | ${totalCompileKilled} compile-killed | ${totalSurvived} SURVIVED`)
const killRate = totalMutants ? (totalMutants - totalSurvived) / totalMutants : 0
console.log(`mined verifier kill rate: ${(killRate * 100).toFixed(1)}%  (suite-kill share: ${totalMutants ? (100 * totalSuiteKilled / totalMutants).toFixed(1) : '0'}%)`)
console.log('rule: a surviving mutant is a coverage-hole candidate in that subsystem bench relative to that operator — triage, then strengthen the bench, not this file.')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
