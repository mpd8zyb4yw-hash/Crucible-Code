// ═══════════════════════════════════════════════════════════════════════════════
// FAULT-INJECTION live measurement — the real on-device proposer against mutants.
// Run:  npm run fault:live          (requires the FM daemon on :11435)
// ═══════════════════════════════════════════════════════════════════════════════
//
// This is a METRIC, not a pass/fail gate: it prints detection rate (spec coverage)
// and RECOVERY RATE (can the live loop read the failing cases, localize the injected
// bug and ship a certified fix within budget?). Track this number across changes to
// the proposer/feedback/search — it is the closest thing we have to "how good is the
// agentic repair loop", which clean-synthesis benches never measure.
//
// Also the measurement harness for the keep-K prototype and the AFM-vs-MiniCPM
// head-to-head: pass a different proposer, compare the two reports.
// ═══════════════════════════════════════════════════════════════════════════════

import { runFaultSuite, type FaultTarget } from './faultInject'

const TARGETS: FaultTarget[] = [
  {
    id: 'sumRange',
    code: `export function sumRange(a, b) {\n  if (a > b) return -1;\n  let total = 0;\n  for (let i = a; i <= b; i++) total = total + i;\n  return total;\n}\n`,
    entry: 'sumRange',
    cases: [
      { args: [1, 4], expected: 10 }, { args: [3, 3], expected: 3 },
      { args: [5, 2], expected: -1 }, { args: [0, 0], expected: 0 },
    ],
  },
  {
    id: 'clampIndex',
    code: `export function clampIndex(i, len) {\n  if (len < 1) return -1;\n  if (i < 0) return 0;\n  if (i >= len) return len - 1;\n  return i;\n}\n`,
    entry: 'clampIndex',
    cases: [
      { args: [5, 10], expected: 5 }, { args: [-2, 10], expected: 0 },
      { args: [10, 10], expected: 9 }, { args: [0, 0], expected: -1 },
      { args: [0, 1], expected: 0 }, { args: [0, 3], expected: 0 },
    ],
  },
  {
    id: 'countPositive',
    code: `export function countPositive(xs) {\n  let n = 0;\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > 0) n = n + 1;\n  }\n  return n;\n}\n`,
    entry: 'countPositive',
    cases: [
      { args: [[1, -2, 3, 0]], expected: 2 }, { args: [[]], expected: 0 },
      { args: [[-1, -1]], expected: 0 }, { args: [[0]], expected: 0 },
    ],
  },
  {
    id: 'titleCase',
    code: `export function titleCase(s) {\n  if (s.length < 1) return '';\n  const words = s.split(' ');\n  const out = [];\n  for (let i = 0; i < words.length; i++) {\n    const w = words[i];\n    if (w.length > 0) out.push(w[0].toUpperCase() + w.slice(1).toLowerCase());\n  }\n  return out.join(' ');\n}\n`,
    entry: 'titleCase',
    cases: [
      { args: ['hello world'], expected: 'Hello World' },
      { args: ['a'], expected: 'A' },
      { args: [''], expected: '' },
      { args: ['MIXED case'], expected: 'Mixed Case' },
    ],
  },
  {
    id: 'runningMax',
    code: `export function runningMax(xs) {\n  const out = [];\n  let best = -Infinity;\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > best) best = xs[i];\n    out.push(best);\n  }\n  return out;\n}\n`,
    entry: 'runningMax',
    cases: [
      { args: [[1, 3, 2, 5]], expected: [1, 3, 3, 5] },
      { args: [[]], expected: [] },
      { args: [[-2, -5]], expected: [-2, -2] },
    ],
  },
  // ── Multi-function targets: the entry delegates to an internal helper, so a mutation can land
  //    in the CALLED function, not just the entry. This is the realistic "bug is one layer down"
  //    shape — repair must localize into a helper it didn't directly get a failing case for. ──
  {
    id: 'medianOf',
    code: `function sortAsc(xs) {\n  const a = xs.slice();\n  for (let i = 0; i < a.length; i++) {\n    for (let j = i + 1; j < a.length; j++) {\n      if (a[j] < a[i]) { const t = a[i]; a[i] = a[j]; a[j] = t; }\n    }\n  }\n  return a;\n}\nexport function medianOf(xs) {\n  if (xs.length < 1) return 0;\n  const a = sortAsc(xs);\n  const mid = Math.floor(a.length / 2);\n  if (a.length % 2 === 1) return a[mid];\n  return (a[mid - 1] + a[mid]) / 2;\n}\n`,
    entry: 'medianOf',
    cases: [
      { args: [[3, 1, 2]], expected: 2 },
      { args: [[4, 1, 3, 2]], expected: 2.5 },
      { args: [[5]], expected: 5 },
      { args: [[]], expected: 0 },
    ],
  },
  {
    id: 'minMaxNorm',
    code: `function minOf(xs) {\n  let m = xs[0];\n  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];\n  return m;\n}\nfunction maxOf(xs) {\n  let m = xs[0];\n  for (let i = 1; i < xs.length; i++) if (xs[i] > m) m = xs[i];\n  return m;\n}\nexport function minMaxNorm(xs) {\n  if (xs.length < 1) return [];\n  const lo = minOf(xs);\n  const hi = maxOf(xs);\n  if (hi === lo) return xs.map(() => 0);\n  return xs.map(v => (v - lo) / (hi - lo));\n}\n`,
    entry: 'minMaxNorm',
    cases: [
      { args: [[0, 5, 10]], expected: [0, 0.5, 1] },
      { args: [[2, 2, 2]], expected: [0, 0, 0] },
      { args: [[]], expected: [] },
    ],
  },
  {
    id: 'isBalanced',
    code: `function isPair(open, close) {\n  return (open === '(' && close === ')') || (open === '[' && close === ']') || (open === '{' && close === '}');\n}\nexport function isBalanced(s) {\n  const stack = [];\n  for (let i = 0; i < s.length; i++) {\n    const c = s[i];\n    if (c === '(' || c === '[' || c === '{') { stack.push(c); continue; }\n    if (c === ')' || c === ']' || c === '}') {\n      if (stack.length < 1) return false;\n      const top = stack.pop();\n      if (!isPair(top, c)) return false;\n    }\n  }\n  return stack.length === 0;\n}\n`,
    entry: 'isBalanced',
    cases: [
      { args: ['(a[b]{c})'], expected: true },
      { args: ['(]'], expected: false },
      { args: ['(('], expected: false },
      { args: ['abc'], expected: true },
    ],
  },
  // Boundary-sensitive helper: `firstK`'s loop bound `i < k` is off-by-one-observable
  // (flip-lt reads one past → NaN/extra element), so an operator fault injected into the
  // called helper propagates to the entry output instead of being an equivalent mutant.
  {
    id: 'sumFirstK',
    code: `function firstK(xs, k) {\n  const out = [];\n  for (let i = 0; i < k; i++) out.push(xs[i]);\n  return out;\n}\nexport function sumFirstK(xs, k) {\n  if (k < 0) return -1;\n  const head = firstK(xs, k);\n  let s = 0;\n  for (let i = 0; i < head.length; i++) s = s + head[i];\n  return s;\n}\n`,
    entry: 'sumFirstK',
    cases: [
      { args: [[10, 20, 30], 2], expected: 30 },
      { args: [[5, 5, 5, 5], 4], expected: 20 },
      { args: [[1, 2, 3], 0], expected: 0 },
      { args: [[1, 2, 3], -1], expected: -1 },
    ],
  },
  // Boundary-sensitive helper: `overThreshold`'s strict `xs[i] > t` is off-by-one-observable
  // at an element exactly equal to t (flip-gt `>`→`>=` counts it), forcing the fault down
  // into the helper to show up in the entry's fraction.
  {
    id: 'fracOver',
    code: `function overThreshold(xs, t) {\n  let n = 0;\n  for (let i = 0; i < xs.length; i++) if (xs[i] > t) n = n + 1;\n  return n;\n}\nexport function fracOver(xs, t) {\n  if (xs.length < 1) return 0;\n  return overThreshold(xs, t) / xs.length;\n}\n`,
    entry: 'fracOver',
    cases: [
      { args: [[1, 2, 3], 2], expected: 1 / 3 },
      { args: [[5, 5, 5], 5], expected: 0 },
      { args: [[10, 20, 30], 0], expected: 1 },
      { args: [[], 0], expected: 0 },
    ],
  },
]

/**
 * The FM is stochastic and this harness has no seed, so ONE run is a sample, not a
 * baseline. Measured cont.79: two back-to-back runs of identical code scored 83% and
 * 87% recovery (38/46 vs 40/46) while detection stayed pinned at 75% — i.e. recovery
 * carries a multi-point spread that a single number silently hides. Comparing one run
 * against one earlier run cannot tell a real regression from noise; every historical
 * single-sample figure (the old "91%") is quotable only with that spread attached.
 *
 * So: report the RANGE across N runs. Default 1 (a 300s run is expensive) — pass
 * `--runs=3` before citing a number as a baseline or claiming a change moved recovery.
 */
async function main() {
  const runsArg = process.argv.find(a => a.startsWith('--runs='))
  const runs = Math.max(1, Number(runsArg?.split('=')[1] ?? 1) || 1)

  console.log('\nFAULT-INJECTION live — recovery rate of the on-device loop\n')
  const started = Date.now()
  const recoveries: number[] = []
  let last!: Awaited<ReturnType<typeof runFaultSuite>>

  for (let run = 0; run < runs; run++) {
    const report = await runFaultSuite(TARGETS, { maxModelCalls: 6 })
    last = report
    recoveries.push(report.recoveryRate)

    if (runs > 1) console.log(`  ── run ${run + 1}/${runs} ──`)
    for (const t of report.trials) {
      const tag = !t.applicable ? 'skip ' : !t.detected ? 'GAP  ' : t.recovered ? 'FIXED' : 'MISS '
      console.log(`  ${tag} ${t.target}/${t.mutation}${t.detected ? ` — ${t.modelCalls} call(s), ${t.status}` : t.applicable ? ' — equivalent mutant (coverage gap)' : ''}`)
    }
    if (runs > 1) console.log(`  run ${run + 1} recovery: ${(report.recoveryRate * 100).toFixed(0)}%  (${report.recovered}/${report.detected})`)
  }

  const pct = (r: number) => `${(r * 100).toFixed(0)}%`
  console.log(`\n  applicable trials : ${last.applicable}`)
  console.log(`  detection rate    : ${pct(last.detectionRate)}  (case sets seeing injected faults)`)
  if (runs > 1) {
    // Deliberately do NOT headline a single run's rate here: printing one bold number above
    // the range is exactly the habit that produced the phantom "91% → 83% regression".
    const lo = Math.min(...recoveries), hi = Math.max(...recoveries)
    const sorted = [...recoveries].sort((a, b) => a - b)
    const median = sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    console.log(`  RECOVERY RATE     : median ${pct(median)}, range ${pct(lo)}–${pct(hi)} over ${runs} runs  [${recoveries.map(pct).join(', ')}]`)
    console.log(`                      (last run ${pct(last.recoveryRate)} = ${last.recovered}/${last.detected}; cite the median+range, not any one run)`)
  } else {
    console.log(`  RECOVERY RATE     : ${pct(last.recoveryRate)}  (${last.recovered}/${last.detected} detected faults fixed+certified)`)
    console.log(`  (single sample — FM is stochastic, spread is several points. Use --runs=3 for a baseline.)`)
  }
  console.log(`  model calls       : ${last.totalModelCalls}`)
  console.log(`  wall clock        : ${((Date.now() - started) / 1000).toFixed(0)}s\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
