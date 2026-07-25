// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decompose GENERAL scorecard — the NO-TEMPLATE number.
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_general_scorecard_live.ts   (live head :8080)
//   GEN_SCORECARD_RUNS=3          draws per task (default 1)
//   GEN_SCORECARD_ONLY=romanToInt run a single task by entry name
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS SEPARATELY FROM __decompose_scorecard_live.ts. That scorecard measures the
// TEMPLATE REGISTRY: every one of its five classes trips a `templateFor` detector, so the carve
// is handed to decompose pre-baked and the live head only has to fill rungs. That number (15/15)
// is real but it is NOT the general capability — it says nothing about a task nobody wrote a
// template for, which is the only case that matters for the doctrine's "novel problems it has
// not seen". This file is that measurement: every task below is asserted to match NO detector
// (`hasDecomposeTemplate === false`), so the FM planner must INVENT the carve from the goal, and
// then the same live head must fill and compose it. Same real verifiers, same honest reporting:
// a non-solve is printed as a non-solve.
//
// THE ASSERTION IS THE POINT. If a template is later added that happens to catch one of these
// goals, this probe FAILS LOUDLY on that row rather than quietly re-measuring the template path
// and reporting it as a general-path win. Read a `TEMPLATED` row as "this task no longer belongs
// in this file", not as a result.

import { decomposeCodeBySubFunction } from './solve'
import { decomposePerRungBudget, hasDecomposeTemplate } from './fmPlanner'
import type { CodeAcceptance } from './codeVerifier'

interface GeneralProbe {
  entry: string
  label: string
  goal: string
  cases: CodeAcceptance['cases']
}

// One row per no-template task. Each is decomposable in principle (a human would carve it into
// 2-3 helpers) but matches no detector, so the carve has to be invented. Cases are small and
// adversarial — enough to reject the shapes the 1.5B actually gets wrong, not an exhaustive suite.
const TASKS: GeneralProbe[] = [
  {
    entry: 'romanToInt',
    label: 'romanToInt (subtractive-pair scan)',
    goal:
      'Write romanToInt(s: string): number converting an uppercase Roman numeral string ' +
      '(I V X L C D M, valid input, up to 3999) into its integer value. A smaller value placed ' +
      'before a larger one is subtracted (IV is 4, IX is 9, XL is 40, CM is 900).',
    cases: [
      { args: ['III'], expected: 3 },
      { args: ['IV'], expected: 4 },
      { args: ['IX'], expected: 9 },
      { args: ['LVIII'], expected: 58 },
      { args: ['MCMXCIV'], expected: 1994 },
      { args: ['MMMCMXCIX'], expected: 3999 },
    ],
  },
  {
    entry: 'intToRoman',
    label: 'intToRoman (greedy value-table emit)',
    goal:
      'Write intToRoman(n: number): string converting an integer from 1 to 3999 into its ' +
      'uppercase Roman numeral, using the subtractive forms IV IX XL XC CD CM where they apply.',
    cases: [
      { args: [3], expected: 'III' },
      { args: [4], expected: 'IV' },
      { args: [9], expected: 'IX' },
      { args: [58], expected: 'LVIII' },
      { args: [1994], expected: 'MCMXCIV' },
      { args: [3999], expected: 'MMMCMXCIX' },
    ],
  },
  {
    entry: 'compressRuns',
    label: 'compressRuns (run-length encode with digit guard)',
    goal:
      'Write compressRuns(s: string): string run-length encoding a string of lowercase letters: ' +
      'each maximal run of the same character becomes that character followed by its run length, ' +
      'but a run of length 1 emits just the character with no number. ' +
      'The empty string maps to the empty string.',
    cases: [
      { args: [''], expected: '' },
      { args: ['a'], expected: 'a' },
      { args: ['aab'], expected: 'a2b' },
      { args: ['aaabccddd'], expected: 'a3bc2d3' },
      { args: ['abcd'], expected: 'abcd' },
      { args: ['aaaaaaaaaaaa'], expected: 'a12' },
    ],
  },
  {
    entry: 'isBalanced',
    label: 'isBalanced (bracket matching over mixed text)',
    goal:
      'Write isBalanced(s: string): boolean returning true when every bracket in the string is ' +
      'correctly matched and nested. The bracket characters are ( ) [ ] { } ; every other ' +
      'character is ignored. A string with no brackets is balanced.',
    cases: [
      { args: [''], expected: true },
      { args: ['abc'], expected: true },
      { args: ['({[]})'], expected: true },
      { args: ['(]'], expected: false },
      { args: ['([)]'], expected: false },
      { args: ['a(b[c]{d})e'], expected: true },
      { args: ['((('], expected: false },
    ],
  },
  {
    entry: 'wordFrequencyTop',
    label: 'wordFrequencyTop (tokenize + count + tie-broken sort)',
    goal:
      'Write wordFrequencyTop(text: string, k: number): string[] returning the k most frequent ' +
      'words in the text, most frequent first. Words are maximal runs of letters, compared ' +
      'case-insensitively and returned lowercase; every other character is a separator. ' +
      'Words with equal counts are ordered alphabetically. If fewer than k distinct words exist, ' +
      'return them all.',
    cases: [
      { args: ['', 3], expected: [] },
      { args: ['the cat the dog THE bird cat', 2], expected: ['the', 'cat'] },
      { args: ['a b c', 2], expected: ['a', 'b'] },
      { args: ['Hello, hello! world.', 5], expected: ['hello', 'world'] },
      { args: ['x y x y z', 3], expected: ['x', 'y', 'z'] },
    ],
  },
]

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

interface TaskResult {
  label: string
  solved: number
  attempts: number
  callsMed: number
  wallMedS: number
  templated: boolean
}

async function runTask(p: GeneralProbe, runs: number): Promise<TaskResult> {
  // A task that trips a detector is no longer measuring the general path — report it and skip,
  // rather than silently folding a template-path solve into the general number.
  if (hasDecomposeTemplate(p.goal, p.entry)) {
    console.log(`  ${p.entry} — TEMPLATED: a detector now matches this goal; it no longer belongs in the general scorecard`)
    return { label: p.label, solved: 0, attempts: 0, callsMed: 0, wallMedS: 0, templated: true }
  }
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
  return { label: p.label, solved, attempts: runs, callsMed: median(calls), wallMedS: median(walls), templated: false }
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(process.env.GEN_SCORECARD_RUNS || 1))
  const only = process.env.GEN_SCORECARD_ONLY
  const probes = only ? TASKS.filter(t => t.entry === only) : TASKS
  if (!probes.length) { console.error(`no task named ${only}`); process.exit(1) }
  console.log(`# LIVE decompose GENERAL (no-template) scorecard — ${probes.length} task(s), ${runs} draw(s) each\n`)

  const results: TaskResult[] = []
  for (const p of probes) results.push(await runTask(p, runs))

  console.log('\n# ── GENERAL SCORECARD ─────────────────────────────────────────────────')
  let totSolved = 0, totAttempts = 0
  for (const r of results) {
    if (r.templated) { console.log(`  ---- SKIPPED (templated)  ${r.label}`); continue }
    totSolved += r.solved; totAttempts += r.attempts
    const rate = ((r.solved / r.attempts) * 100).toFixed(0)
    console.log(`  ${r.solved}/${r.attempts} (${rate.padStart(3)}%)  calls~${String(r.callsMed).padStart(3)}  wall~${String(r.wallMedS).padStart(4)}s  ${r.label}`)
  }
  console.log(`  ───────────────────────────────────────────────────────────────────`)
  const aggRate = totAttempts ? ((totSolved / totAttempts) * 100).toFixed(0) : '  0'
  console.log(`  ${totSolved}/${totAttempts} (${aggRate}%)  AGGREGATE on the GENERAL (planner-invented carve) path`)
  console.log('\n' + JSON.stringify({ decompose_general_scorecard: true, solved: totSolved, attempts: totAttempts, byTask: results }))
}

main().catch(e => { console.error('decompose general scorecard failed:', e); process.exit(1) })
