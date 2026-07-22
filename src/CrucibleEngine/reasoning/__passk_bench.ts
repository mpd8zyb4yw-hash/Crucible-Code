// ═══════════════════════════════════════════════════════════════════════════════
// pass@k harness — the "starved loop vs weak proposals" discriminator (W3 item 2)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE QUESTION THIS ANSWERS. The generated-path scorecard sits at ~3% (1/33). Two very
// different worlds produce that number, and they demand opposite fixes:
//
//   (A) STARVED LOOP  — the proposer CAN produce a correct answer, but only rarely, and the
//       loop's tiny model-call budget (3 iters/task at ~90s each) never draws enough. Fix:
//       more samples per wall-second → W3 continuous batching, bigger budgets. Cheap.
//   (B) WEAK PROPOSALS — the proposer essentially CANNOT produce a correct answer for these
//       tasks no matter how many times you draw. Fix: better proposals — decomposition,
//       retrieval grounding, verifier-failure-fed refinement. Expensive, but the only lever
//       that moves the needle if (A) is false.
//
// pass@k separates them mechanically. Draw N independent samples per task, count how many the
// REAL execution verifier certifies (c), and read the pass@k curve:
//   - pass@k climbs steeply with k  →  world (A): the answer is in the distribution, just rare.
//   - pass@k stays flat and low     →  world (B): sampling harder won't help; fix the proposer.
//
// METHOD. This is the standard HumanEval unbiased estimator: draw N ONCE, estimate every k from
// the single sample (no re-drawing per k). pass@k = 1 - C(N-c, k)/C(N, k). One model-spend,
// every k. Samples are drawn through proposeCodeBatch → fmCompleteBatch → the live local head's
// KV slots (W3 continuous batching), so this ALSO exercises the batch client end-to-end and
// reports its real wall-clock behaviour.
//
// The verifier is the SAME execution-ground-truth verifyCode the generated path uses — no
// model judges itself here. A draw that comes back empty/malformed counts as a failed sample
// (denominator stays N), so the curve honestly folds in malformed-proposal loss.
//
// Run:  npx tsx src/CrucibleEngine/reasoning/__passk_bench.ts
//   PASSK_N=50           samples per task (default 30)
//   PASSK_TASKS=easy,med only run tasks whose tier is listed (default: all)
//   PASSK_ONLY=evalRPN   run a single task by id
//   PASSK_MULTISHOT=1    ALSO run feedback-threaded sequential draws and print the loop's
//                        convergence lift over independent pass@k (PASSK_SHOTS=8 sets the depth)
// Requires a live local head (llama-server on :8080) — otherwise every draw is empty and the
// run reports that honestly rather than pretending.

import { proposeCode, proposeCodeBatch } from './codeProposer'
import { verifyCode } from './codeVerifier'
import type { Attempt, Candidate, TaskSpec } from './types'

interface PkCase { args: unknown[]; expected: unknown; entry?: string }
interface PkTask {
  id: string
  tier: 'easy' | 'med' | 'hard'
  goal: string
  entry: string
  cases: PkCase[]
}

// Difficulty-graded, catalog-agnostic algorithmic tasks. Each `cases` list is ADVERSARIAL:
// the boundary a naive implementation misses (empty input, ties broken by first, touching
// intervals, integer truncation toward zero, subtractive numerals) is pinned as a case, so a
// PASS means real correctness, not "happens to work on the happy path".
const ALL_TASKS: PkTask[] = [
  {
    id: 'sumEvens', tier: 'easy',
    goal: 'Write sumEvens(nums: number[]): number returning the sum of only the even numbers. Empty array → 0. Negative evens count.',
    entry: 'sumEvens',
    cases: [
      { args: [[1, 2, 3, 4]], expected: 6 },
      { args: [[]], expected: 0 },
      { args: [[-2, -3, 5, 8]], expected: 6 },
      { args: [[1, 3, 5]], expected: 0 },
      { args: [[0, 0, 2]], expected: 2 },
    ],
  },
  {
    id: 'titleCase', tier: 'easy',
    goal: 'Write titleCase(s: string): string that upper-cases the first letter of each whitespace-separated word and lower-cases the rest. Collapse runs of whitespace to a single space and trim ends. Empty string → "".',
    entry: 'titleCase',
    cases: [
      { args: ['hello world'], expected: 'Hello World' },
      { args: ['  the QUICK  brown  '], expected: 'The Quick Brown' },
      { args: [''], expected: '' },
      { args: ['a'], expected: 'A' },
      { args: ['ALL CAPS here'], expected: 'All Caps Here' },
    ],
  },
  {
    id: 'romanToInt', tier: 'med',
    goal: 'Write romanToInt(s: string): number converting a valid Roman numeral (I,V,X,L,C,D,M) to its integer value, honouring subtractive pairs (IV=4, IX=9, XL=40, XC=90, CD=400, CM=900).',
    entry: 'romanToInt',
    cases: [
      { args: ['III'], expected: 3 },
      { args: ['IV'], expected: 4 },
      { args: ['IX'], expected: 9 },
      { args: ['LVIII'], expected: 58 },
      { args: ['MCMXCIV'], expected: 1994 },
      { args: ['XLII'], expected: 42 },
    ],
  },
  {
    id: 'mergeIntervals', tier: 'med',
    goal: 'Write mergeIntervals(intervals: number[][]): number[][] that merges all overlapping intervals and returns them sorted ascending by start. Intervals that merely TOUCH (one ends where the next starts, e.g. [1,4] and [4,5]) also merge. Input may be unsorted and may contain fully-nested intervals. Empty input → [].',
    entry: 'mergeIntervals',
    cases: [
      { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]] },
      { args: [[[1, 4], [4, 5]]], expected: [[1, 5]] },
      { args: [[]], expected: [] },
      { args: [[[1, 10], [2, 3], [4, 8]]], expected: [[1, 10]] },
      { args: [[[8, 10], [1, 3], [2, 6]]], expected: [[1, 6], [8, 10]] },
    ],
  },
  {
    id: 'evalRPN', tier: 'med',
    goal: 'Write evalRPN(tokens: string[]): number evaluating a Reverse Polish Notation expression. Operators are "+", "-", "*", "/". Division truncates toward zero (so 6/-4 = -1, not -2). All intermediate and final results are integers. A single-number input returns that number.',
    entry: 'evalRPN',
    cases: [
      { args: [['2', '1', '+', '3', '*']], expected: 9 },
      { args: [['4', '13', '5', '/', '+']], expected: 6 },
      { args: [['6', '-4', '/']], expected: -1 },
      { args: [['-7']], expected: -7 },
      { args: [['10', '2', '-', '3', '*']], expected: 24 },
    ],
  },
  {
    id: 'longestPalindrome', tier: 'hard',
    goal: 'Write longestPalindrome(s: string): string returning the longest contiguous substring of s that is a palindrome. If several have the same maximal length, return the one that starts earliest. A single character is a palindrome. Empty string → "".',
    entry: 'longestPalindrome',
    cases: [
      { args: ['babad'], expected: 'bab' },
      { args: ['cbbd'], expected: 'bb' },
      { args: ['a'], expected: 'a' },
      { args: [''], expected: '' },
      { args: ['abacdfgdcaba'], expected: 'aba' },
      { args: ['racecar'], expected: 'racecar' },
    ],
  },
  {
    id: 'wordBreak', tier: 'hard',
    goal: 'Write wordBreak(s: string, dict: string[]): boolean returning true iff s can be segmented into a sequence of one or more words all present in dict. Words may be reused. Empty s → true.',
    entry: 'wordBreak',
    cases: [
      { args: ['leetcode', ['leet', 'code']], expected: true },
      { args: ['applepenapple', ['apple', 'pen']], expected: true },
      { args: ['catsandog', ['cats', 'dog', 'sand', 'and', 'cat']], expected: false },
      { args: ['', ['a']], expected: true },
      { args: ['aaaaaaa', ['aaaa', 'aaa']], expected: true },
    ],
  },
  {
    id: 'basicCalculator', tier: 'hard',
    goal: 'Write basicCalculator(s: string): number evaluating an arithmetic expression string containing non-negative integers and the operators + - * / with standard precedence (* and / before + and -) and no parentheses. Division truncates toward zero. Spaces may appear anywhere and are ignored.',
    entry: 'basicCalculator',
    cases: [
      { args: ['3+2*2'], expected: 7 },
      { args: [' 3/2 '], expected: 1 },
      { args: ['3+5 / 2'], expected: 5 },
      { args: ['14-3*2'], expected: 8 },
      { args: ['2*3+4*5'], expected: 26 },
    ],
  },
]

/** Unbiased HumanEval pass@k: probability that a random size-k subset of the N draws contains
 *  at least one of the c correct ones. Uses all N samples to estimate every k with no re-draw. */
export function passAtK(N: number, c: number, k: number): number {
  if (c <= 0) return 0
  if (N - c < k) return 1
  let prod = 1
  for (let i = 0; i < k; i++) prod *= (N - c - i) / (N - i)
  return 1 - prod
}

const KS = [1, 5, 10, 25, 50]

interface TaskResult {
  id: string; tier: string
  N: number; correct: number; empty: number; distinct: number
  passAt: Record<number, number>
  proposeMs: number; verifyMs: number
}

async function runTask(task: PkTask, N: number): Promise<TaskResult> {
  const spec: TaskSpec = { goal: task.goal, domain: 'code', acceptance: { entry: task.entry, cases: task.cases } as any }
  // Draw N samples concurrently across KV slots. proposeCodeBatch chunks into waves of the live
  // slot count internally, so one call handles the whole N. diversify:false, empty history — a
  // clean pass@k measures the FIRST-shot distribution, not the post-feedback one.
  const t0 = Date.now()
  const candidates = await proposeCodeBatch({ spec, history: [], diversify: false }, N)
  const proposeMs = Date.now() - t0
  const empty = N - candidates.length          // null/empty draws = failed samples (denominator stays N)
  const distinct = new Set(candidates.map(c => c.fingerprint)).size

  // Verify every drawn candidate with the real execution verifier, bounded-concurrent so we
  // don't spawn N node processes at once. A distinct-fingerprint cache avoids re-running the
  // exact same source (pure win — verdict is a deterministic function of source).
  const t1 = Date.now()
  const verdictCache = new Map<string, boolean>()
  let correct = 0
  const CONCURRENCY = 4
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY)
    const passes = await Promise.all(slice.map(async (c: Candidate<string>) => {
      const cached = verdictCache.get(c.fingerprint)
      if (cached !== undefined) return cached
      const v = await verifyCode(c, spec)
      verdictCache.set(c.fingerprint, v.pass)
      return v.pass
    }))
    correct += passes.filter(Boolean).length
  }
  const verifyMs = Date.now() - t1

  const passAt: Record<number, number> = {}
  for (const k of KS) if (k <= N) passAt[k] = passAtK(N, correct, k)
  return { id: task.id, tier: task.tier, N, correct, empty, distinct, passAt, proposeMs, verifyMs }
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-SHOT (item 4) — the loop-convergence lift over first-shot sampling.
// ─────────────────────────────────────────────────────────────────────────────
// first-shot pass@k (runTask above) draws N INDEPENDENT samples with an EMPTY history — it
// measures the raw proposal distribution, the number the "starved vs weak" question turns on.
// But the actual loop does NOT draw independently: every failed candidate's execution verdict is
// threaded back into the next prompt (buildProposalPrompt's feedback block), so the model debugs
// its own code against ground truth. This mode measures THAT — draw shots SEQUENTIALLY, feeding
// each failure's signals into the next draw's history, and report solve-rate@shot. Comparing it
// to the independent pass@k at the same k quantifies how much the feedback loop buys over blind
// resampling — the lever DOCTRINE.md calls "maximize information per model call".

interface MultiShotResult {
  id: string; tier: string
  shots: number
  solvedAtShot: number | null   // 1-indexed shot that first certified, or null if never
  ms: number
}

/** Run up to `shots` SEQUENTIAL draws, threading every failed attempt's verdict into the next
 *  proposal's history. Returns the first shot that certified (or null). One draw per shot (the
 *  loop's per-node behaviour), verified by the same execution ground truth. */
async function runTaskMultiShot(task: PkTask, shots: number): Promise<MultiShotResult> {
  const spec: TaskSpec = { goal: task.goal, domain: 'code', acceptance: { entry: task.entry, cases: task.cases } as any }
  const history: Attempt<string>[] = []
  const t0 = Date.now()
  let solvedAtShot: number | null = null
  for (let shot = 1; shot <= shots; shot++) {
    // diversify once the model has failed at least twice — mirrors search()'s stagnation nudge.
    const diversify = history.length >= 2
    let cand: Candidate<string> | null = null
    try { cand = await proposeCode({ spec, history: history.slice(), diversify }) }
    catch { cand = null }
    if (!cand) continue                          // empty/malformed draw — a wasted shot, keep going
    const v = await verifyCode(cand, spec)
    if (v.pass) { solvedAtShot = shot; break }
    history.push({ candidate: cand, verdict: v }) // feed this failure forward
  }
  return { id: task.id, tier: task.tier, shots, solvedAtShot, ms: Date.now() - t0 }
}

async function mainMultiShot(tasks: PkTask[], N: number, shots: number): Promise<void> {
  console.log(`# pass@k MULTI-SHOT — ${tasks.length} task(s): independent pass@k (N=${N}) vs feedback-threaded solve-rate@shot (shots=${shots})`)
  console.log(`# the gap between the two columns at equal k = the loop's convergence lift over blind resampling\n`)
  const indep: TaskResult[] = []
  const multi: MultiShotResult[] = []
  for (const task of tasks) {
    process.stdout.write(`[${task.tier}] ${task.id} … `)
    const r = await runTask(task, N)                       // independent first-shot distribution
    const m = await runTaskMultiShot(task, shots)          // feedback-threaded sequential draws
    indep.push(r); multi.push(m)
    const solved = m.solvedAtShot ? `shot ${m.solvedAtShot}` : 'never'
    console.log(`indep c=${r.correct}/${N} pass@1 ${(r.passAt[1] * 100).toFixed(0)}%  |  multishot ${solved}  [${(m.ms / 1000).toFixed(0)}s]`)
  }
  // Curve: at each k, independent pass@k (mean) vs multi-shot solve-rate within k shots (fraction).
  const shotKs = KS.filter(k => k <= Math.min(N, shots))
  console.log(`\n# CONVERGENCE CURVE (mean across ${tasks.length} task(s))`)
  console.log('k'.padEnd(8) + 'indep pass@k'.padStart(14) + 'multishot@k'.padStart(14) + 'lift'.padStart(10))
  for (const k of shotKs) {
    const ip = indep.reduce((s, r) => s + (r.passAt[k] ?? 0), 0) / (indep.length || 1)
    const mp = multi.filter(m => m.solvedAtShot != null && m.solvedAtShot <= k).length / (multi.length || 1)
    const lift = mp - ip
    console.log(`${String(k).padEnd(8)}${(ip * 100).toFixed(1).padStart(13)}%${(mp * 100).toFixed(1).padStart(13)}%${(lift >= 0 ? '+' : '') + (lift * 100).toFixed(1).padStart(8)}`)
  }
  const solvedEver = multi.filter(m => m.solvedAtShot != null).length
  console.log(`\n# ${solvedEver}/${multi.length} task(s) certified within ${shots} feedback-threaded shot(s)`)
  console.log('\n' + JSON.stringify({ passk_multishot: true, N, shots, indep: indep.map(r => ({ id: r.id, correct: r.correct, passAt: r.passAt })), multi }))
}

async function main(): Promise<void> {
  const N = Math.max(1, Number(process.env.PASSK_N || 30))
  const only = (process.env.PASSK_ONLY || '').trim()
  const tiers = (process.env.PASSK_TASKS || '').split(',').map(s => s.trim()).filter(Boolean)
  let tasks = ALL_TASKS
  if (only) tasks = tasks.filter(t => t.id === only)
  else if (tiers.length) tasks = tasks.filter(t => tiers.includes(t.tier))

  // MULTI-SHOT mode (item 4): PASSK_MULTISHOT=1, shots via PASSK_SHOTS (default 8).
  if (process.env.PASSK_MULTISHOT === '1') {
    const shots = Math.max(1, Number(process.env.PASSK_SHOTS || 8))
    await mainMultiShot(tasks, N, shots)
    return
  }

  console.log(`# pass@k — N=${N} samples/task, ${tasks.length} task(s), verifier=execution-ground-truth`)
  console.log(`# drawing through proposeCodeBatch → fmCompleteBatch → local head KV slots (W3)\n`)

  const results: TaskResult[] = []
  for (const task of tasks) {
    process.stdout.write(`[${task.tier}] ${task.id} … `)
    const r = await runTask(task, N)
    results.push(r)
    const ks = KS.filter(k => k <= N).map(k => `@${k}:${(r.passAt[k] * 100).toFixed(0)}%`).join(' ')
    console.log(`c=${r.correct}/${N} (empty ${r.empty}, distinct ${r.distinct})  ${ks}  [propose ${(r.proposeMs / 1000).toFixed(0)}s, verify ${(r.verifyMs / 1000).toFixed(1)}s]`)
  }

  // Aggregate: mean pass@k across tasks — the headline curve.
  console.log(`\n# AGGREGATE (mean pass@k across ${results.length} task(s))`)
  const validKs = KS.filter(k => k <= N)
  const header = 'k'.padEnd(6) + validKs.map(k => `pass@${k}`.padStart(10)).join('')
  console.log(header)
  const meanRow = 'mean'.padEnd(6) + validKs.map(k => {
    const m = results.reduce((s, r) => s + (r.passAt[k] ?? 0), 0) / (results.length || 1)
    return `${(m * 100).toFixed(1)}%`.padStart(10)
  }).join('')
  console.log(meanRow)
  // Any-task-solvable count per k: how many tasks have ANY passing sample (pass@k → 1 as k→N).
  const solvable = results.filter(r => r.correct > 0).length
  console.log(`\n# ${solvable}/${results.length} task(s) had ≥1 certified sample within N=${N} draws (the pass@N ceiling)`)
  const totalEmpty = results.reduce((s, r) => s + r.empty, 0)
  console.log(`# malformed/empty draws: ${totalEmpty}/${N * results.length} (${(100 * totalEmpty / (N * results.length || 1)).toFixed(1)}%)`)

  // Machine-readable line for downstream diffing.
  console.log('\n' + JSON.stringify({ passk: true, N, tasks: results }))
}

main().catch(e => { console.error('passk bench failed:', e); process.exit(1) })
