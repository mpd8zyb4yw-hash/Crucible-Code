// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decomposition probe — the basicCalculator ceiling (item 2).
// Run:  npm run vgr:decompose:calc     (requires a live local head on :8080)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE QUESTION. The pass@k experiment (npm run passk:bench) showed basicCalculator —
// evaluate `3+2*2` = 7 with */+- precedence and NO parentheses — stays 0% at N=15 no
// matter how many first-shot samples you draw. That is world (B): the flat proposal
// distribution does not contain a correct answer, so more sampling cannot help. The
// doctrine's answer to a too-hard step is NOT a bigger model — it is a SMALLER step.
//
// This probe runs the real decomposeCodeBySubFunction on exactly that task against the
// live head and reports whether carving it into certified helpers (e.g. tokenize →
// apply-*/-first → sum) lets the SAME weak model certify the whole, where the flat loop
// abstains. It is a HONEST measurement, not a test: a non-solve is reported as such
// (decomposition is stochastic — the plan quality varies, hence planAttempts), never
// dressed up. The composed module is re-verified against all 5 adversarial cases by
// decomposeCodeBySubFunction itself, so a reported 'solved' is genuinely certified.
//
//   CALC_FLATFIRST=1   also run the flat solveCodeTask first, to show the contrast live.

import { decomposeCodeBySubFunction, solveCodeTask } from './solve'
import type { CodeAcceptance } from './codeVerifier'

const ENTRY = 'basicCalculator'
const GOAL =
  'Write basicCalculator(s: string): number evaluating an arithmetic expression string ' +
  'containing non-negative integers and the operators + - * / with standard precedence ' +
  '(* and / before + and -) and no parentheses. Division truncates toward zero. Spaces may ' +
  'appear anywhere and are ignored.'
const CASES: CodeAcceptance['cases'] = [
  { args: ['3+2*2'], expected: 7 },
  { args: [' 3/2 '], expected: 1 },
  { args: ['3+5 / 2'], expected: 5 },
  { args: ['14-3*2'], expected: 8 },
  { args: ['2*3+4*5'], expected: 26 },
]

async function main(): Promise<void> {
  console.log(`# LIVE decompose probe — ${ENTRY} (precedence-without-parens, the pass@k 0% ceiling)\n`)

  if (process.env.CALC_FLATFIRST === '1') {
    process.stdout.write('flat solveCodeTask (baseline the pass@k curve says is ~0%) … ')
    const t0 = Date.now()
    const flat = await solveCodeTask({ goal: GOAL, entry: ENTRY, cases: CASES }, { maxModelCalls: 12, beamWidth: 3 })
    console.log(`${flat.status} in ${flat.modelCalls} call(s) [${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  }

  process.stdout.write('sub-function decomposition (the smaller-step lever) … ')
  const t1 = Date.now()
  const d = await decomposeCodeBySubFunction(
    { goal: GOAL, nl: GOAL, entry: ENTRY, cases: CASES },
    { planAttempts: Number(process.env.CALC_PLAN_ATTEMPTS || 3), emit: (e: any) => { if (e?.type === 'thought') console.log(`\n    · ${e.text}`) } },
  )
  console.log(`\n\n# RESULT: ${d.status} — ${d.detail}`)
  console.log(`# ${d.helpers.length} helper(s): ${d.helpers.map(h => h.name).join(', ') || '(none)'}`)
  console.log(`# rungs: ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join('  ')}`)
  console.log(`# model calls: ${d.modelCalls}, wall ${((Date.now() - t1) / 1000).toFixed(0)}s`)
  if (d.status === 'solved' && d.code) {
    console.log('\n# CERTIFIED module (re-verified against all 5 adversarial cases):\n')
    console.log(d.code)
  }
  console.log('\n' + JSON.stringify({ decompose_calc: true, status: d.status, helpers: d.helpers.length, modelCalls: d.modelCalls }))
}

main().catch(e => { console.error('decompose calc probe failed:', e); process.exit(1) })
