// ═══════════════════════════════════════════════════════════════════════════════
// SELFCHECK for failure-directed decomposition (solve.ts failureDirectedSubGoal). No model.
// Run:  npx tsx src/CrucibleEngine/reasoning/__failure_directed_selfcheck.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// The function is prompt text, so there is no verifier downstream to catch a mistake in it — a
// silently-empty or malformed note would just quietly make recursion no better than before, which
// is precisely the failure mode this repo keeps paying for (a mechanism that looks wired and is
// dark). These checks pin the properties the design argument actually rests on.

import { failureDirectedSubGoal } from './solve'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const GOAL = 'Write splitCsvLine(line: string): string[] splitting one line of CSV into its fields.'
const SIGNALS = [
  'case splitCsvLine #3 on input "\\"x,y\\",z" → got ["\\"x","y\\"","z"], expected ["x,y","z"]',
  'case splitCsvLine #4 on input "\\"he said \\"\\"hi\\"\\"\\",z" → got ["he said hi","z"], expected ["he said \\"hi\\"","z"]',
]

console.log('# failure-directed decomposition — selfcheck\n')

// 1) NO EVIDENCE → NO CHANGE. The pre-2026-08-02 path must be reproduced byte for byte when there
// are no signals, or every caller without failure evidence silently gets a different prompt.
check('undefined signals leave the goal byte-identical', failureDirectedSubGoal(GOAL, undefined) === GOAL)
check('empty signals leave the goal byte-identical', failureDirectedSubGoal(GOAL, []) === GOAL)
check('blank/whitespace signals leave the goal byte-identical', failureDirectedSubGoal(GOAL, ['', '   ']) === GOAL)

// 2) THE EVIDENCE SURVIVES. The whole point is that the planner sees which cases failed.
const out = failureDirectedSubGoal(GOAL, SIGNALS)
check('the original goal is still present', out.startsWith(GOAL))
check('every signal is carried into the text', SIGNALS.every(s => out.includes(s)))
check('the separation instruction is present', /SEPARATE those concerns/.test(out))

// 3) IT IS DOMAIN-NEUTRAL. If the instruction names the answer, the probe measures a CSV hint
// rather than a general mechanism — and the hard set's other rows (wrapText, splitSeconds,
// extractField) would get nothing. The goal may say "CSV"; the ADDED text must not.
const added = out.slice(GOAL.length)
check('the added instruction names no domain concept from the task',
  !/\bcsv\b/i.test(added.replace(/ - .*/g, '')) && !/quote|comma|escap/i.test(added.split('Those failures')[1] ?? ''),
  added.slice(-200))

// 4) IT IS BOUNDED. A stalled rung can carry many signals and the slot context is finite; an
// unbounded dump would crowd out the goal itself — the failure mode a prior session already hit.
const many = Array.from({ length: 20 }, (_, i) => `case #${i} failed with a fairly long explanation of what went wrong`)
const capped = failureDirectedSubGoal(GOAL, many, 4)
check('at most maxSignals are included', (capped.match(/^ {2}- /gm) ?? []).length === 4,
  String((capped.match(/^ {2}- /gm) ?? []).length))
check('the cap keeps the note far smaller than a slot', capped.length < 2000, String(capped.length))

console.log(`\n${failed === 0 ? '✅' : '❌'} failure-directed: ${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
