// ═══════════════════════════════════════════════════════════════════════════════
// FAULT-INJECTION bench — proves the recovery-measurement harness itself.
// Run:  npm run fault:bench
// ═══════════════════════════════════════════════════════════════════════════════
//
// Deterministic (injected proposers, no FM) so CI proves the harness ACCOUNTING:
//
//   1. MUTATION VALIDITY  — every operator, where applicable, produces changed source.
//   2. DETECTION          — mutants of well-covered targets FAIL execution (the case
//                           set can see the injected fault).
//   3. RECOVERY-COUNTS    — a proposer that repairs on attempt 2 is scored recovered,
//                           with the model-call count preserved.
//   4. NO-REPAIR-HONEST   — a proposer that keeps re-proposing the mutant is scored
//                           NOT recovered (status exhausted/abstained, never solved).
//   5. EQUIVALENT-MUTANT  — a fault the case set cannot see is reported as a
//                           coverage gap (undetected), excluded from recovery scoring.
//   6. BROKEN-TARGET      — a target whose own code fails its cases is skipped, not
//                           scored (harness never blames the loop for a bad target).
//
// The LIVE measurement (real on-device proposer) runs via `npm run fault:live`
// (__fault_live.ts) and is a metric, not a pass/fail gate.
// ═══════════════════════════════════════════════════════════════════════════════

import { MUTATIONS, runFaultSuite, runFaultTrial, type FaultTarget } from './faultInject'
import { extractPastedCode } from './emitPlan'
import type { Proposer } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

// Well-covered reference targets: each has cases that pin boundaries, guards and values,
// so the classic operators are all visible to execution.
const TARGETS: FaultTarget[] = [
  {
    // Guard returns a DISTINCT sentinel (-1, not the loop's natural 0) so deleting or
    // loosening it is visible to execution — a dropped guard that happens to produce
    // the same value is an equivalent mutant, which is a coverage lesson, not a target.
    id: 'sumRange',
    code: `export function sumRange(a, b) {\n  if (a > b) return -1;\n  let total = 0;\n  for (let i = a; i <= b; i++) total = total + i;\n  return total;\n}\n`,
    entry: 'sumRange',
    cases: [
      { args: [1, 4], expected: 10 },
      { args: [3, 3], expected: 3 },
      { args: [5, 2], expected: -1 },
      { args: [0, 0], expected: 0 },
    ],
  },
  {
    id: 'clampIndex',
    code: `export function clampIndex(i, len) {\n  if (len < 1) return -1;\n  if (i < 0) return 0;\n  if (i >= len) return len - 1;\n  return i;\n}\n`,
    entry: 'clampIndex',
    cases: [
      { args: [5, 10], expected: 5 },
      { args: [-2, 10], expected: 0 },
      { args: [10, 10], expected: 9 },
      { args: [0, 0], expected: -1 },
      { args: [0, 1], expected: 0 },
      { args: [0, 3], expected: 0 },
    ],
  },
  {
    id: 'countPositive',
    code: `export function countPositive(xs) {\n  let n = 0;\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > 0) n = n + 1;\n  }\n  return n;\n}\n`,
    entry: 'countPositive',
    cases: [
      { args: [[1, -2, 3, 0]], expected: 2 },
      { args: [[]], expected: 0 },
      { args: [[-1, -1]], expected: 0 },
      { args: [[0]], expected: 0 },
    ],
  },
]

// A proposer that "understands the bug" on its Nth call: earlier calls re-propose the
// broken mutant (extracted from the spec context), the Nth proposes the good code.
function repairAfter(n: number, goodCode: string): Proposer<string> {
  let calls = 0
  return async ctx => {
    calls++
    if (calls >= n) return { value: goodCode, fingerprint: `good-${calls}` }
    const m = /```\n([\s\S]*?)```/.exec(ctx.spec.context ?? '')
    return { value: (m?.[1] ?? 'export function x(){}') + `\n// retry ${calls}`, fingerprint: `bad-${calls}` }
  }
}

async function main() {
  console.log('\nFAULT-INJECTION bench — recovery-harness accounting\n')

  // ── 1+2. Mutation validity + detection across the full sweep (repair on 1st call). ──
  {
    const report = await runFaultSuite(TARGETS, {
      proposer: repairAfter(1, TARGETS[0].code),  // placeholder; per-trial correctness checked below
      mutations: MUTATIONS,
      maxModelCalls: 3,
    })
    check('1 operators apply broadly (≥12 applicable trials)', report.applicable >= 12, `applicable=${report.applicable}`)
    check('2 detection is high on well-covered targets (≥75%)', report.detectionRate >= 0.75,
      `rate=${report.detectionRate.toFixed(2)} — undetected: ${report.trials.filter(t => t.status === 'undetected').map(t => `${t.target}/${t.mutation}`).join(', ')}`)
  }

  // ── 3. RECOVERY-COUNTS: repair lands on attempt 2, harness scores it recovered. ──
  {
    const t = TARGETS[0]
    const trial = await runFaultTrial(t, MUTATIONS[0], { proposer: repairAfter(2, t.code), maxModelCalls: 6 })
    check('3 recovery on attempt 2 scored recovered', trial.detected && trial.recovered && trial.status === 'solved', JSON.stringify(trial))
    check('3b model calls preserved (2)', trial.modelCalls === 2, `calls=${trial.modelCalls}`)
  }

  // ── 4. NO-REPAIR-HONEST: proposer never fixes → not recovered, never "solved". ──
  {
    const t = TARGETS[2]  // countPositive × swap-plus-minus: `n + 1` → `n - 1`, always visible
    const trial = await runFaultTrial(t, MUTATIONS[2], { proposer: repairAfter(99, t.code), maxModelCalls: 4 })
    check('4 non-repairing proposer scored NOT recovered', trial.detected && !trial.recovered && trial.status !== 'solved', JSON.stringify(trial))
  }

  // ── 5. EQUIVALENT-MUTANT: fault invisible to the cases → coverage gap, not a loop failure. ──
  {
    // Cases never exercise the guard (all inputs non-empty), so dropping it is invisible.
    const t: FaultTarget = {
      id: 'weakSpec',
      code: `export function head(xs) {\n  if (xs.length < 1) return null;\n  return xs[0];\n}\n`,
      entry: 'head',
      cases: [{ args: [[7, 8]], expected: 7 }, { args: [[1]], expected: 1 }],
    }
    const dropGuard = MUTATIONS.find(m => m.name === 'drop-guard')!
    const trial = await runFaultTrial(t, dropGuard, { proposer: repairAfter(1, t.code) })
    check('5 equivalent mutant reported as coverage gap', trial.applicable && !trial.detected && trial.status === 'undetected' && !trial.recovered, JSON.stringify(trial))
  }

  // ── 6. BROKEN-TARGET: target failing its own cases is skipped, not scored. ──
  {
    const t: FaultTarget = {
      id: 'broken',
      code: `export function double(x) { return x + x + 1; }\n`,
      entry: 'double',
      cases: [{ args: [2], expected: 4 }],
    }
    const trial = await runFaultTrial(t, MUTATIONS[2], { proposer: repairAfter(1, t.code) })
    check('6 broken target skipped', !trial.applicable && trial.status === 'skipped', JSON.stringify(trial))
  }

  // ── 7. REPAIR-EVIDENCE-SEED: the first proposal sees concrete failing-case evidence
  //       (from executing the buggy code), not just a generic "some cases fail" goal —
  //       so the loop localizes on call #1 instead of burning a model call rediscovering it. ──
  {
    const t = TARGETS[0]
    let firstContext: string | null = null
    const capturing: Proposer<string> = async ctx => {
      if (firstContext === null) firstContext = ctx.spec.context ?? ''
      return { value: t.code, fingerprint: 'good' }  // repair on call #1
    }
    const trial = await runFaultTrial(t, MUTATIONS[0], { proposer: capturing, maxModelCalls: 6 })
    check('7 first proposal is seeded with executed failure evidence',
      trial.recovered && (firstContext ?? '').includes('Observed failures of the current implementation'),
      `ctxHasEvidence=${(firstContext ?? '').includes('Observed failures')}`)
  }

  // ── 8. PASTED-CODE SEED: when the request names no target file, the repair seed comes from a
  //       fenced code block pasted inline. Largest block wins; tiny/oversized blocks are skipped. ──
  {
    const fn = 'function add(a, b) {\n  return a - b // bug: should be +\n}'
    const msg = `fix this bug:\n\`\`\`js\n${fn}\n\`\`\``
    check('8a fenced block extracted as repair seed', extractPastedCode(msg) === fn,
      JSON.stringify(extractPastedCode(msg)))
    check('8b no fence → null', extractPastedCode('fix the adder') === null)
    check('8c tiny block skipped', extractPastedCode('```\nx=1\n```') === null)
    const two = 'small snippet here'
    const big = 'function reallyLongOne() {\n  return computeSomethingComplicated() + 1\n}'
    check('8d largest of multiple blocks wins',
      extractPastedCode(`\`\`\`\n${two}\n\`\`\`\nand\n\`\`\`\n${big}\n\`\`\``) === big)
    // Data/prose fences don't seed: a bigger quoted log loses to a smaller real code block.
    const log = '[2026-07-16] ERROR at line 3: undefined is not a function, retrying forever…'
    check('8e data-tagged fence skipped in favor of code fence',
      extractPastedCode(`fix this:\n\`\`\`js\n${fn}\n\`\`\`\nlog:\n\`\`\`log\n${log}\n\`\`\``) === fn)
    check('8f a lone data fence → null', extractPastedCode(`\`\`\`json\n{"a":1,"b":2,"c":3}\n\`\`\``) === null)
  }

  console.log(`\n${pass}/${pass + fail} checks passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
