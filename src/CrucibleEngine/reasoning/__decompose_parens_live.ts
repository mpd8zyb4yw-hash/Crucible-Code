// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decomposition probe — the calculatorWithParens ceiling (shunting-yard class).
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_parens_live.ts   (live head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE QUESTION. calculatorWithParens — evaluate `(3+2)*2` = 10 with */+- precedence AND
// round parentheses — is the fourth 0%-by-sampling corpus class. The parenless two-pass
// fold provably cannot evaluate grouping, so the flat loop stays at world (B): more
// sampling never draws a correct whole. The doctrine's lever is the SMALLER STEP —
// carve the goal into the four certified shunting-yard helpers (tokenize → precedence →
// toPostfix → evalPostfix) and let the SAME weak model certify each rung, then compose
// evalPostfix(toPostfix(tokenize(s))).
//
// This runs the REAL decomposeCodeBySubFunction (which routes through fmPlanner's
// isShuntingYardGoal → shuntingYardTemplatePlan + composeHintFor) against the live head
// and reports whether the composed whole certifies. Honest measurement, not a test: a
// non-solve is reported as such. The composed module is re-verified against all the
// adversarial cases below by decomposeCodeBySubFunction itself, so 'solved' is genuine.
//
//   PARENS_FLATFIRST=1   also run the flat solveCodeTask first, to show the contrast live.

import { decomposeCodeBySubFunction, solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'

const ENTRY = 'calculatorWithParens'
const GOAL =
  'Write calculatorWithParens(s: string): number evaluating an arithmetic expression string ' +
  'containing non-negative integers, the operators + - * / with standard precedence ' +
  '(* and / before + and -), AND round parentheses ( ) that override precedence. ' +
  'Division truncates toward zero. Spaces may appear anywhere and are ignored.'
const CASES: CodeAcceptance['cases'] = [
  { args: ['(3+2)*2'], expected: 10 },
  { args: ['2*(3+4)'], expected: 14 },
  { args: ['(1+2)*(3+4)'], expected: 21 },
  { args: ['3+2*2'], expected: 7 },
  { args: ['2*(3+4*(5-1))'], expected: 38 },
]

async function main(): Promise<void> {
  console.log(`# LIVE decompose probe — ${ENTRY} (parenthesised precedence / shunting-yard)\n`)

  if (process.env.PARENS_FLATFIRST === '1') {
    process.stdout.write('flat solveCodeTask (baseline: the parenless fold cannot group) … ')
    const t0 = Date.now()
    const flat = await solveCodeTask({ goal: GOAL, entry: ENTRY, cases: CASES }, { maxModelCalls: 12, beamWidth: 3 })
    console.log(`${flat.status} in ${flat.modelCalls} call(s) [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  }

  process.stdout.write('sub-function decomposition (four-helper shunting-yard carve) … ')
  const t1 = Date.now()
  const rungIterate = {
    globalModelCalls: Number(process.env.PARENS_RUNG_CALLS || 24),
    wallClockMs: Number(process.env.PARENS_RUNG_TIMEOUT || 240_000),
    maxEpochs: Number(process.env.PARENS_RUNG_EPOCHS || 6),
  }
  const d = await decomposeCodeBySubFunction(
    { goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    {
      planAttempts: Number(process.env.PARENS_PLAN_ATTEMPTS || 3),
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
  console.log('\n' + JSON.stringify({ decompose_parens: true, status: d.status, helpers: d.helpers.length, modelCalls: d.modelCalls }))
}

main().catch(e => { console.error('decompose parens probe failed:', e); process.exit(1) })
