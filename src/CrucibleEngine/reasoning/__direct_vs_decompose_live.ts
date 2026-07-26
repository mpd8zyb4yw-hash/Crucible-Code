// ═══════════════════════════════════════════════════════════════════════════════
// THE CONTROL ARM. What does the DIRECT path score on the general scorecard's own tasks?
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every general-scorecard number on record is produced by `decomposeCodeBySubFunction` — the
// planner invents a carve, each rung is filled and certified, then composed. Four sessions have
// been spent improving that carve. NOBODY EVER MEASURED THE CONTROL: draw the whole function
// directly, verify it, repeat. Without that arm, "2/5 on the general path" cannot distinguish
// "the model cannot do these tasks" from "the decomposition is destroying capability the model
// already has".
//
// This runs the control. Same five tasks, same real `verifyCode` (executes against the same
// acceptance cases), same live head. The only change is that no carve happens: each draw is a
// whole-module proposal through the repo's own `proposeCode`, with real verifier feedback
// threaded back in exactly as `search()` would.
//
// Reports, per task: solved-at-draw-k (so pass@1..pass@K falls straight out), model calls, and
// wall clock — against the decompose path's recorded numbers for the same task.
//
// Run:  npx tsx src/CrucibleEngine/reasoning/__direct_vs_decompose_live.ts
//   DIRECT_K=8            draws per task before giving up (default 8)
//   DIRECT_ONLY=isBalanced   single task
//   DIRECT_CONCURRENT=1   issue the K draws CONCURRENTLY across llama-server slots instead of
//                         serially with feedback. Measures blind-parallel pass@K against
//                         feedback-guided serial pass@K — the two are NOT the same search and
//                         the repo has never compared them.
// ═══════════════════════════════════════════════════════════════════════════════

import { proposeCode, proposeCodeBatch } from './codeProposer'
import { makeMechanicalRepairProposer } from './mechanicalRepair'
import { verifyCode } from './codeVerifier'
import type { CodeAcceptance } from './codeVerifier'
import type { Attempt, ProposeContext, TaskSpec } from './types'

interface Probe { entry: string; label: string; goal: string; cases: CodeAcceptance['cases']; decomposeBaseline: string }

// Byte-identical to __decompose_general_scorecard_live.ts's TASKS — same goals, same cases.
// If those drift apart this comparison is meaningless, so they are duplicated deliberately and
// the baseline column records what the decompose path scored on the very same row (25e run).
const TASKS: Probe[] = [
  {
    entry: 'romanToInt',
    label: 'romanToInt (subtractive-pair scan)',
    decomposeBaseline: 'solved, 16 calls, 62s',
    goal:
      'Write romanToInt(s: string): number converting an uppercase Roman numeral string ' +
      '(I V X L C D M, valid input, up to 3999) into its integer value. A smaller value placed ' +
      'before a larger one is subtracted (IV is 4, IX is 9, XL is 40, CM is 900).',
    cases: [
      { args: ['III'], expected: 3 }, { args: ['IV'], expected: 4 }, { args: ['IX'], expected: 9 },
      { args: ['LVIII'], expected: 58 }, { args: ['MCMXCIV'], expected: 1994 }, { args: ['MMMCMXCIX'], expected: 3999 },
    ],
  },
  {
    entry: 'intToRoman',
    label: 'intToRoman (greedy value-table emit)',
    decomposeBaseline: 'solved, 41 calls, 186s',
    goal:
      'Write intToRoman(n: number): string converting an integer from 1 to 3999 into its ' +
      'uppercase Roman numeral, using the subtractive forms IV IX XL XC CD CM where they apply.',
    cases: [
      { args: [3], expected: 'III' }, { args: [4], expected: 'IV' }, { args: [9], expected: 'IX' },
      { args: [58], expected: 'LVIII' }, { args: [1994], expected: 'MCMXCIV' }, { args: [3999], expected: 'MMMCMXCIX' },
    ],
  },
  {
    entry: 'compressRuns',
    label: 'compressRuns (run-length encode with digit guard)',
    decomposeBaseline: 'decompose-failed, 56 calls',
    goal:
      'Write compressRuns(s: string): string run-length encoding a string of lowercase letters: ' +
      'each maximal run of the same character becomes that character followed by its run length, ' +
      'but a run of length 1 emits just the character with no number. ' +
      'The empty string maps to the empty string.',
    cases: [
      { args: [''], expected: '' }, { args: ['a'], expected: 'a' }, { args: ['aab'], expected: 'a2b' },
      { args: ['aaabccddd'], expected: 'a3bc2d3' }, { args: ['abcd'], expected: 'abcd' }, { args: ['aaaaaaaaaaaa'], expected: 'a12' },
    ],
  },
  {
    entry: 'isBalanced',
    label: 'isBalanced (bracket matching over mixed text)',
    decomposeBaseline: 'decompose-failed, 92 calls',
    goal:
      'Write isBalanced(s: string): boolean returning true when every bracket in the string is ' +
      'correctly matched and nested. The bracket characters are ( ) [ ] { } ; every other ' +
      'character is ignored. A string with no brackets is balanced.',
    cases: [
      { args: [''], expected: true }, { args: ['abc'], expected: true }, { args: ['({[]})'], expected: true },
      { args: ['(]'], expected: false }, { args: ['([)]'], expected: false },
      { args: ['a(b[c]{d})e'], expected: true }, { args: ['((('], expected: false },
    ],
  },
  {
    entry: 'wordFrequencyTop',
    label: 'wordFrequencyTop (tokenize + count + tie-broken sort)',
    decomposeBaseline: 'decompose-failed, 115 calls',
    goal:
      'Write wordFrequencyTop(text: string, k: number): string[] returning the k most frequent ' +
      'words in the text, most frequent first. Words are maximal runs of letters, compared ' +
      'case-insensitively and returned lowercase; every other character is a separator. ' +
      'Words with equal counts are ordered alphabetically. If fewer than k distinct words exist, ' +
      'return them all.',
    cases: [
      { args: ['', 3], expected: [] }, { args: ['the cat the dog THE bird cat', 2], expected: ['the', 'cat'] },
      { args: ['a b c', 2], expected: ['a', 'b'] }, { args: ['Hello, hello! world.', 5], expected: ['hello', 'world'] },
      { args: ['x y x y z', 3], expected: ['x', 'y', 'z'] },
    ],
  },
]

// The TEMPLATE scorecard's five classes (from __decompose_scorecard_live.ts), verbatim. That
// scorecard reports 15/15 and is quoted as the headline number — but every one of its rows trips
// a hand-written detector, so decomposition is handed a pre-baked carve. Running the SAME rows
// through the direct path says whether the template registry is buying anything the model cannot
// already do in one draw.
const TEMPLATE_TASKS: Probe[] = [
  {
    entry: 'basicCalculator',
    label: 'basicCalculator (parenless precedence fold)',
    decomposeBaseline: 'template 3/3, ~18s median',
    goal:
      'Write basicCalculator(s: string): number evaluating an arithmetic expression string ' +
      'of non-negative integers and the operators + - * / with standard precedence ' +
      '(* and / before + and -) and NO parentheses. Division truncates toward zero. Spaces ignored.',
    cases: [
      { args: ['3+2*2'], expected: 7 }, { args: [' 3/2 '], expected: 1 }, { args: ['3+5 / 2'], expected: 5 },
      { args: ['14-3*2'], expected: 8 }, { args: ['2*3+4*5'], expected: 26 },
    ],
  },
  {
    entry: 'evalRPN',
    label: 'evalRPN (postfix stack)',
    decomposeBaseline: 'template 3/3',
    goal:
      'Write evalRPN(tokens: string[]): number evaluating a Reverse Polish Notation (postfix) ' +
      'expression. Operators are + - * /; every other token is an integer. For [a, b, op] compute ' +
      'a op b. Division truncates toward zero.',
    cases: [
      { args: [['2', '1', '+', '3', '*']], expected: 9 }, { args: [['4', '13', '5', '/', '+']], expected: 6 },
      { args: [['6', '-4', '/']], expected: -1 }, { args: [['-7']], expected: -7 },
      { args: [['10', '2', '-', '3', '*']], expected: 24 },
    ],
  },
  {
    entry: 'editDistance',
    label: 'editDistance (Levenshtein DP fold)',
    decomposeBaseline: 'template 3/3',
    goal:
      'Write editDistance(a: string, b: string): number returning the Levenshtein edit distance — ' +
      'the minimum number of single-character insertions, deletions, or substitutions to turn a into b.',
    cases: [
      { args: ['kitten', 'sitting'], expected: 3 }, { args: ['flaw', 'lawn'], expected: 2 },
      { args: ['', 'abc'], expected: 3 }, { args: ['abc', 'abc'], expected: 0 },
      { args: ['sunday', 'saturday'], expected: 3 },
    ],
  },
  {
    entry: 'calculatorWithParens',
    label: 'calculatorWithParens (shunting-yard)',
    decomposeBaseline: 'template 3/3',
    goal:
      'Write calculatorWithParens(s: string): number evaluating an arithmetic expression string ' +
      'containing non-negative integers, the operators + - * / with standard precedence ' +
      '(* and / before + and -), AND round parentheses ( ) that override precedence. Division ' +
      'truncates toward zero. Spaces ignored.',
    cases: [
      { args: ['(3+2)*2'], expected: 10 }, { args: ['2*(3+4)'], expected: 14 },
      { args: ['(1+2)*(3+4)'], expected: 21 }, { args: ['3+2*2'], expected: 7 },
      { args: ['2*(3+4*(5-1))'], expected: 38 },
    ],
  },
  {
    entry: 'coinChange',
    label: 'coinChange (min-coins unbounded DP fold)',
    decomposeBaseline: 'template 3/3, 3 calls/14s',
    goal:
      'Write coinChange(coins: number[], amount: number): number returning the fewest coins ' +
      '(each denomination available in unlimited supply) that sum to exactly amount, or -1 if no ' +
      'combination does.',
    cases: [
      { args: [[1, 2, 5], 11], expected: 3 }, { args: [[2], 3], expected: -1 },
      { args: [[1], 0], expected: 0 }, { args: [[1, 5, 6, 9], 11], expected: 2 },
      { args: [[2, 5, 10], 27], expected: 4 },
    ],
  },
]

const specOf = (p: Probe): TaskSpec => ({
  goal: p.goal, domain: 'code', acceptance: { entry: p.entry, cases: p.cases },
})

interface Row { label: string; entry: string; solvedAt: number; calls: number; wallS: number; baseline: string; bestScore: number; lastSignals: string[]; repairSolves?: number }

/** Serial, feedback-guided: exactly what search() does, minus beam bookkeeping. */
async function runSerial(p: Probe, K: number): Promise<Row> {
  const spec = specOf(p)
  const history: Attempt<string>[] = []
  const t0 = Date.now()
  let calls = 0
  let bestScore = -Infinity
  let lastSignals: string[] = []
  // MECHANICAL REPAIR ARM (DIRECT_REPAIR=1). After every failing draw, spend the deterministic
  // repair sweep licensed by that draw's OWN verifier signals before paying ~4s for another draw.
  // It is not charged against `calls` because it makes no model call — that is the whole point,
  // and counting it would make the two arms incomparable on the axis being measured.
  const repair = process.env.DIRECT_REPAIR === '1' ? makeMechanicalRepairProposer() : null
  let repairSolves = 0
  for (let k = 1; k <= K; k++) {
    const ctx: ProposeContext<string> = { spec, history, diversify: k > 1 && k % 2 === 0 }
    const cand = await proposeCode(ctx)
    calls++
    if (!cand) continue
    const verdict = await verifyCode(cand, spec)
    if (verdict.score > bestScore) bestScore = verdict.score
    lastSignals = verdict.signals
    history.push({ candidate: cand, verdict })
    if (verdict.pass) {
      return { label: p.label, entry: p.entry, solvedAt: k, calls, wallS: Math.round((Date.now() - t0) / 1000), baseline: p.decomposeBaseline, bestScore, lastSignals: [], repairSolves }
    }
    if (repair) {
      const fixed = await repair({ spec, history, diversify: false })
      if (fixed) {
        const rv = await verifyCode(fixed, spec)
        if (rv.score > bestScore) bestScore = rv.score
        history.push({ candidate: fixed, verdict: rv })
        if (rv.pass) {
          repairSolves++
          return { label: p.label, entry: p.entry, solvedAt: k, calls, wallS: Math.round((Date.now() - t0) / 1000), baseline: p.decomposeBaseline, bestScore, lastSignals: [], repairSolves }
        }
      }
    }
  }
  return { label: p.label, entry: p.entry, solvedAt: 0, calls, wallS: Math.round((Date.now() - t0) / 1000), baseline: p.decomposeBaseline, bestScore, lastSignals }
}

/** Blind parallel: K draws at once across slots, no feedback. The pass@K arm. */
async function runConcurrent(p: Probe, K: number): Promise<Row> {
  const spec = specOf(p)
  const t0 = Date.now()
  const ctx: ProposeContext<string> = { spec, history: [], diversify: true }
  const cands = await proposeCodeBatch(ctx, K)
  let bestScore = -Infinity
  let lastSignals: string[] = []
  let solvedAt = 0
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]
    if (!c) continue
    const v = await verifyCode(c, spec)
    if (v.score > bestScore) bestScore = v.score
    lastSignals = v.signals
    if (v.pass && !solvedAt) solvedAt = i + 1
  }
  return { label: p.label, entry: p.entry, solvedAt, calls: K, wallS: Math.round((Date.now() - t0) / 1000), baseline: p.decomposeBaseline, bestScore, lastSignals: solvedAt ? [] : lastSignals }
}

async function main(): Promise<void> {
  const K = Math.max(1, Number(process.env.DIRECT_K || 8))
  const only = process.env.DIRECT_ONLY
  const concurrent = process.env.DIRECT_CONCURRENT === '1'
  const set = process.env.DIRECT_TASKSET === 'template' ? TEMPLATE_TASKS
    : process.env.DIRECT_TASKSET === 'all' ? [...TASKS, ...TEMPLATE_TASKS]
      : TASKS
  const probes = only ? set.filter(t => t.entry === only) : set
  if (!probes.length) { console.error(`no task named ${only}`); process.exit(1) }

  console.log(`# DIRECT (no-decomposition) control arm — ${probes.length} task(s), K=${K} draws, ` +
    `${concurrent ? 'BLIND CONCURRENT (pass@K)' : 'SERIAL with verifier feedback'}\n`)

  const rows: Row[] = []
  for (const p of probes) {
    process.stdout.write(`  ${p.entry} … `)
    const r = concurrent ? await runConcurrent(p, K) : await runSerial(p, K)
    rows.push(r)
    console.log(r.solvedAt
      ? `SOLVED at draw ${r.solvedAt}/${K} (${r.calls} calls, ${r.wallS}s)`
      : `unsolved after ${K} draws (${r.wallS}s, best score ${r.bestScore}) — ${(r.lastSignals[0] ?? '').slice(0, 90)}`)
  }

  console.log('\n# ── DIRECT vs DECOMPOSE ───────────────────────────────────────────────')
  console.log('  ' + 'task'.padEnd(20) + 'DIRECT'.padEnd(30) + 'DECOMPOSE (25e baseline)')
  for (const r of rows) {
    const direct = r.solvedAt ? `solved @draw ${r.solvedAt}, ${r.wallS}s` : `unsolved (${K} draws, ${r.wallS}s)`
    console.log('  ' + r.entry.padEnd(20) + direct.padEnd(30) + r.baseline)
  }
  const solved = rows.filter(r => r.solvedAt).length
  const wall = rows.reduce((a, r) => a + r.wallS, 0)
  console.log(`  ───────────────────────────────────────────────────────────────────`)
  console.log(`  ${solved}/${rows.length} solved by the DIRECT path in ${wall}s total`)
  console.log('\n' + JSON.stringify({ direct_control_arm: true, mode: concurrent ? 'concurrent' : 'serial', K, solved, attempts: rows.length, totalWallS: wall, rows }))
}

main().catch(e => { console.error('direct control arm failed:', e); process.exit(1) })
