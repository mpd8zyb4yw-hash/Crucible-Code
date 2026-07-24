// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decompose SCORECARD — the aggregate capability number, in one run.
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_scorecard_live.ts   (live head :8080)
//   SCORECARD_RUNS=3        draws per class (default 1)
//   SCORECARD_ONLY=coinChange   run a single class by entry name
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY. Every prior session hand-ran __decompose_<x>_live.ts one class at a time, so the
// registry's *aggregate* solve rate was never in one place — and decisions that needed it
// ("does the four-class registry hold before I add a fifth?", cont.108 T4) waited on a
// manual sweep. This is that sweep, registry-driven: it runs the REAL
// decomposeCodeBySubFunction on EACH template class against the live head, with the SAME
// class-aware per-rung budget the live path uses (decomposePerRungBudget), and prints a
// per-class solved/attempts + median model-calls + median wall table plus one aggregate
// line. Honest measurement: a non-solve is reported, never dressed up; every 'solved' is
// the whole module re-verified against the class's adversarial cases by decompose itself.
//
// Adding a template class? Add one CLASSES row here and it enters the scorecard. That is the
// point — the aggregate number tracks the registry automatically.

import { decomposeCodeBySubFunction } from './solve'
import { decomposePerRungBudget } from './fmPlanner'
import type { CodeAcceptance } from './codeVerifier'

interface ClassProbe {
  entry: string
  label: string
  goal: string
  cases: CodeAcceptance['cases']
}

// One row per registry template class. Goals are phrased to trip each class's detector;
// cases are the same small adversarial batch the standalone probes use.
const CLASSES: ClassProbe[] = [
  {
    entry: 'basicCalculator',
    label: 'basicCalculator (parenless precedence fold)',
    goal:
      'Write basicCalculator(s: string): number evaluating an arithmetic expression string ' +
      'of non-negative integers and the operators + - * / with standard precedence ' +
      '(* and / before + and -) and NO parentheses. Division truncates toward zero. Spaces ignored.',
    cases: [
      { args: ['3+2*2'], expected: 7 },
      { args: [' 3/2 '], expected: 1 },
      { args: ['3+5 / 2'], expected: 5 },
      { args: ['14-3*2'], expected: 8 },
      { args: ['2*3+4*5'], expected: 26 },
    ],
  },
  {
    entry: 'evalRPN',
    label: 'evalRPN (postfix stack)',
    goal:
      'Write evalRPN(tokens: string[]): number evaluating a Reverse Polish Notation (postfix) ' +
      'expression. Operators are + - * /; every other token is an integer. For [a, b, op] compute ' +
      'a op b. Division truncates toward zero.',
    cases: [
      { args: [['2', '1', '+', '3', '*']], expected: 9 },
      { args: [['4', '13', '5', '/', '+']], expected: 6 },
      { args: [['6', '-4', '/']], expected: -1 },
      { args: [['-7']], expected: -7 },
      { args: [['10', '2', '-', '3', '*']], expected: 24 },
    ],
  },
  {
    entry: 'editDistance',
    label: 'editDistance (Levenshtein DP fold)',
    goal:
      'Write editDistance(a: string, b: string): number returning the Levenshtein edit distance — ' +
      'the minimum number of single-character insertions, deletions, or substitutions to turn a into b.',
    cases: [
      { args: ['kitten', 'sitting'], expected: 3 },
      { args: ['flaw', 'lawn'], expected: 2 },
      { args: ['', 'abc'], expected: 3 },
      { args: ['abc', 'abc'], expected: 0 },
      { args: ['sunday', 'saturday'], expected: 3 },
    ],
  },
  {
    entry: 'calculatorWithParens',
    label: 'calculatorWithParens (shunting-yard)',
    goal:
      'Write calculatorWithParens(s: string): number evaluating an arithmetic expression string ' +
      'containing non-negative integers, the operators + - * / with standard precedence ' +
      '(* and / before + and -), AND round parentheses ( ) that override precedence. Division ' +
      'truncates toward zero. Spaces ignored.',
    cases: [
      { args: ['(3+2)*2'], expected: 10 },
      { args: ['2*(3+4)'], expected: 14 },
      { args: ['(1+2)*(3+4)'], expected: 21 },
      { args: ['3+2*2'], expected: 7 },
      { args: ['2*(3+4*(5-1))'], expected: 38 },
    ],
  },
  {
    entry: 'coinChange',
    label: 'coinChange (min-coins unbounded DP fold)',
    goal:
      'Write coinChange(coins: number[], amount: number): number returning the fewest coins ' +
      '(each denomination available in unlimited supply) that sum to exactly amount, or -1 if no ' +
      'combination does.',
    cases: [
      { args: [[1, 2, 5], 11], expected: 3 },
      { args: [[2], 3], expected: -1 },
      { args: [[1], 0], expected: 0 },
      { args: [[1, 5, 6, 9], 11], expected: 2 },
      { args: [[2, 5, 10], 27], expected: 4 },
    ],
  },
]

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

interface ClassResult {
  label: string
  solved: number
  attempts: number
  callsMed: number
  wallMedS: number
}

async function runClass(p: ClassProbe, runs: number): Promise<ClassResult> {
  const budget = decomposePerRungBudget(p.goal, p.entry)
  let solved = 0
  const calls: number[] = []
  const walls: number[] = []
  for (let i = 0; i < runs; i++) {
    process.stdout.write(`  ${p.entry} draw ${i + 1}/${runs} … `)
    const t0 = Date.now()
    const d = await decomposeCodeBySubFunction(
      { goal: p.goal, nl: p.goal, entry: p.entry, cases: p.cases },
      { planAttempts: 3, iterate: budget },
    )
    const wallS = Math.round((Date.now() - t0) / 1000)
    if (d.status === 'solved') solved++
    calls.push(d.modelCalls)
    walls.push(wallS)
    console.log(`${d.status} (${d.modelCalls} calls, ${wallS}s) — rungs ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join(' ')}`)
  }
  return { label: p.label, solved, attempts: runs, callsMed: median(calls), wallMedS: median(walls) }
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(process.env.SCORECARD_RUNS || 1))
  const only = process.env.SCORECARD_ONLY
  const probes = only ? CLASSES.filter(c => c.entry === only) : CLASSES
  if (!probes.length) { console.error(`no class named ${only}`); process.exit(1) }
  console.log(`# LIVE decompose scorecard — ${probes.length} class(es), ${runs} draw(s) each, class-aware budgets\n`)

  const results: ClassResult[] = []
  for (const p of probes) results.push(await runClass(p, runs))

  console.log('\n# ── SCORECARD ─────────────────────────────────────────────────────────')
  let totSolved = 0, totAttempts = 0
  for (const r of results) {
    totSolved += r.solved; totAttempts += r.attempts
    const rate = ((r.solved / r.attempts) * 100).toFixed(0)
    console.log(`  ${r.solved}/${r.attempts} (${rate.padStart(3)}%)  calls~${String(r.callsMed).padStart(3)}  wall~${String(r.wallMedS).padStart(4)}s  ${r.label}`)
  }
  const aggRate = ((totSolved / totAttempts) * 100).toFixed(0)
  console.log(`  ───────────────────────────────────────────────────────────────────`)
  console.log(`  ${totSolved}/${totAttempts} (${aggRate}%)  AGGREGATE across the template registry`)
  console.log('\n' + JSON.stringify({ decompose_scorecard: true, solved: totSolved, attempts: totAttempts, byClass: results }))
}

main().catch(e => { console.error('decompose scorecard failed:', e); process.exit(1) })
