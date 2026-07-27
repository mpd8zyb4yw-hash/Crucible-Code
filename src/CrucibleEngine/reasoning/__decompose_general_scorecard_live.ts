// ═══════════════════════════════════════════════════════════════════════════════
// LIVE decompose GENERAL scorecard — the NO-TEMPLATE number.
// Run:  npx tsx src/CrucibleEngine/reasoning/__decompose_general_scorecard_live.ts   (live head :8080)
//   GEN_SCORECARD_RUNS=3          draws per task (default 1)
//   GEN_SCORECARD_ONLY=romanToInt run a single task by entry name
//   GEN_SCORECARD_TASK_WALL_MS=600000  abort each task at N ms (default 0 = no ceiling).
//     A capped run measures "solves within N seconds", which is STRICTER than the uncapped
//     baselines — the header line records the cap so the two are never confused.
//   GEN_SCORECARD_ARM=both|ladder|decompose   which arm(s) to run (default BOTH).
//     `ladder`    — the real escalation ladder, i.e. what the product does. THE headline number.
//     `decompose` — decomposition alone, the pre-2026-07-27 harness. A CONTROL, not a result.
//     `both`      — default, so the control is permanent and the two are never confused again.
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

import { decomposeCodeBySubFunction, solveByLadder } from './solve'
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

interface ArmResult {
  solved: number
  attempts: number
  callsMed: number
  wallMedS: number
  /** Which ladder tier certified each solve, in order — empty on the decompose-only arm. */
  tiers: number[]
}

interface TaskResult {
  label: string
  entry: string
  templated: boolean
  ladder: ArmResult | null
  decompose: ArmResult | null
  /** Kept so the aggregate line and the emitted JSON stay backwards-compatible with prior runs. */
  solved: number
  attempts: number
  callsMed: number
  wallMedS: number
}

const EMPTY_ARM: ArmResult = { solved: 0, attempts: 0, callsMed: 0, wallMedS: 0, tiers: [] }

/**
 * THE LADDER ARM — what the PRODUCT actually does with this task.
 *
 * The decompose arm below calls `decomposeCodeBySubFunction` directly, which is ONE TIER of the
 * system. Every general-scorecard number ever recorded came from it, and the 2026-07-26 control arm
 * showed that tier is a 10–40× tax on 4 of these 5 tasks — a fact four sessions of work never saw,
 * because the harness could not see any other tier. So the ladder arm is now the primary number and
 * the decompose arm is a permanent control: read the two columns together or not at all.
 *
 * Same goal, same entry, same cases, same real `verifyCode` — the ONLY difference is that the
 * ladder is allowed to stop early when a cheaper tier certifies, and it reports which one did.
 */
async function runLadderArm(p: GeneralProbe, runs: number, budget: ReturnType<typeof decomposePerRungBudget>, ceilingMs: number): Promise<ArmResult> {
  let solved = 0
  const calls: number[] = []
  const walls: number[] = []
  const tiers: number[] = []
  for (let i = 0; i < runs; i++) {
    process.stdout.write(`  ${p.entry} [ladder] draw ${i + 1}/${runs} … `)
    const t0 = Date.now()
    const ac = ceilingMs > 0 ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), ceilingMs) : null
    const lad = await solveByLadder(p.goal, p.entry, p.cases,
      { decompose: true, iterate: budget, ...(ac ? { signal: ac.signal } : {}) },
      async () => true)
    if (timer) clearTimeout(timer)
    const wallS = Math.round((Date.now() - t0) / 1000)
    if (lad.status === 'solved') { solved++; tiers.push(lad.tier ?? -1) }
    calls.push(lad.modelCalls)
    walls.push(wallS)
    console.log(`${lad.status}${lad.status === 'solved' ? ` @tier ${lad.tier}` : ''} (${lad.modelCalls} calls, ${wallS}s) — ` +
      lad.steps.map(s => `t${s.tier}:${s.solved ? 'OK' : 'no'}/${s.modelCalls}c/${Math.round(s.wallMs / 1000)}s`).join(' '))
  }
  return { solved, attempts: runs, callsMed: median(calls), wallMedS: median(walls), tiers }
}

async function runTask(p: GeneralProbe, runs: number): Promise<TaskResult> {
  // A task that trips a detector is no longer measuring the general path — report it and skip,
  // rather than silently folding a template-path solve into the general number.
  if (hasDecomposeTemplate(p.goal, p.entry)) {
    console.log(`  ${p.entry} — TEMPLATED: a detector now matches this goal; it no longer belongs in the general scorecard`)
    return { label: p.label, entry: p.entry, templated: true, ladder: null, decompose: null, solved: 0, attempts: 0, callsMed: 0, wallMedS: 0 }
  }
  const budget = decomposePerRungBudget(p.goal, p.entry)
  const arm = process.env.GEN_SCORECARD_ARM ?? 'both'
  const ceiling = Number(process.env.GEN_SCORECARD_TASK_WALL_MS || 0)
  const ladder = arm === 'decompose' ? null : await runLadderArm(p, runs, budget, ceiling)
  if (arm === 'ladder') {
    return { label: p.label, entry: p.entry, templated: false, ladder, decompose: null,
      solved: ladder!.solved, attempts: ladder!.attempts, callsMed: ladder!.callsMed, wallMedS: ladder!.wallMedS }
  }
  let solved = 0
  const calls: number[] = []
  const walls: number[] = []
  for (let i = 0; i < runs; i++) {
    process.stdout.write(`  ${p.entry} [decompose] draw ${i + 1}/${runs} … `)
    const t0 = Date.now()
    // WHOLE-TASK WALL-CLOCK CEILING (2026-07-25d). `budget` is a PER-RUNG budget, so a task with
    // four rungs × three planAttempts can legitimately run for over half an hour — the 25d run had
    // `isBalanced` grind 2288s and `compressRuns` 1888s, which put a single 5-task draw at ~2 hours
    // and made raising `GEN_SCORECARD_RUNS` (the only way to tell a real regression from n=1 noise)
    // practically impossible. This aborts the whole task at a fixed ceiling.
    //
    // It measures a DIFFERENT, stricter thing than an unbounded run: "solves within N seconds",
    // not "solves eventually". That is the honest trade and it is stated in the header line, so a
    // capped number is never silently compared against an uncapped one. Default OFF (no ceiling)
    // precisely so the existing baselines stay comparable.
    const ceilingMs = Number(process.env.GEN_SCORECARD_TASK_WALL_MS || 0)
    const ac = ceilingMs > 0 ? new AbortController() : null
    const timer = ac ? setTimeout(() => ac.abort(), ceilingMs) : null
    const d = await decomposeCodeBySubFunction(
      { goal: p.goal, nl: p.goal, entry: p.entry, cases: p.cases },
      { planAttempts: 3, iterate: budget, ...(ac ? { signal: ac.signal } : {}) },
    )
    if (timer) clearTimeout(timer)
    const wallS = Math.round((Date.now() - t0) / 1000)
    if (d.status === 'solved') solved++
    calls.push(d.modelCalls)
    walls.push(wallS)
    console.log(`${d.status} (${d.modelCalls} calls, ${wallS}s) — rungs ${d.rungs.map(r => `${r.name}:${r.certified ? 'OK' : r.status}`).join(' ')}`)
  }
  const decompose: ArmResult = { solved, attempts: runs, callsMed: median(calls), wallMedS: median(walls), tiers: [] }
  // The headline number is the LADDER's when we ran it — that is the system. The decompose arm
  // remains as the control column so "decomposition helped" is never assumed again.
  const head = ladder ?? decompose
  return { label: p.label, entry: p.entry, templated: false, ladder, decompose,
    solved: head.solved, attempts: head.attempts, callsMed: head.callsMed, wallMedS: head.wallMedS }
}

async function main(): Promise<void> {
  const runs = Math.max(1, Number(process.env.GEN_SCORECARD_RUNS || 1))
  const only = process.env.GEN_SCORECARD_ONLY
  const probes = only ? TASKS.filter(t => t.entry === only) : TASKS
  if (!probes.length) { console.error(`no task named ${only}`); process.exit(1) }
  const capMs = Number(process.env.GEN_SCORECARD_TASK_WALL_MS || 0)
  console.log(`# LIVE decompose GENERAL (no-template) scorecard — ${probes.length} task(s), ${runs} draw(s) each` +
    (capMs > 0 ? `, per-task wall ceiling ${Math.round(capMs / 1000)}s (STRICTER than an uncapped run — do not compare directly)` : '') + '\n')

  const results: TaskResult[] = []
  for (const p of probes) results.push(await runTask(p, runs))

  const cell = (a: ArmResult | null): string =>
    a ? `${a.solved}/${a.attempts} ${String(a.callsMed).padStart(3)}c ${String(a.wallMedS).padStart(4)}s` : '     —      '

  console.log('\n# ── GENERAL SCORECARD ─────────────────────────────────────────────────')
  console.log('  ' + 'LADDER (the system)'.padEnd(22) + 'DECOMPOSE (one tier, control)'.padEnd(32) + 'task')
  let totSolved = 0, totAttempts = 0, ctlSolved = 0, ctlAttempts = 0
  const tierHist = new Map<number, number>()
  for (const r of results) {
    if (r.templated) { console.log(`  ---- SKIPPED (templated)  ${r.label}`); continue }
    totSolved += r.solved; totAttempts += r.attempts
    if (r.decompose) { ctlSolved += r.decompose.solved; ctlAttempts += r.decompose.attempts }
    for (const t of r.ladder?.tiers ?? []) tierHist.set(t, (tierHist.get(t) ?? 0) + 1)
    console.log('  ' + cell(r.ladder).padEnd(22) + cell(r.decompose).padEnd(32) + r.label)
  }
  console.log(`  ───────────────────────────────────────────────────────────────────`)
  const aggRate = totAttempts ? ((totSolved / totAttempts) * 100).toFixed(0) : '  0'
  console.log(`  ${totSolved}/${totAttempts} (${aggRate}%)  AGGREGATE — the number the PRODUCT scores on the general path`)
  if (ctlAttempts) {
    console.log(`  ${ctlSolved}/${ctlAttempts} (${((ctlSolved / ctlAttempts) * 100).toFixed(0)}%)  control: decomposition ALONE (this is NOT the product's number)`)
  }
  if (tierHist.size) {
    // WHICH TIER EARNED IT. Four sessions were spent improving tier 3 without this line existing.
    const hist = [...tierHist.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `tier ${t}: ${n}`).join(', ')
    console.log(`  solves by tier — ${hist}`)
  }
  console.log('\n' + JSON.stringify({ decompose_general_scorecard: true, arm: process.env.GEN_SCORECARD_ARM ?? 'both', solved: totSolved, attempts: totAttempts, controlSolved: ctlSolved, controlAttempts: ctlAttempts, byTask: results }))
}

main().catch(e => { console.error('decompose general scorecard failed:', e); process.exit(1) })
