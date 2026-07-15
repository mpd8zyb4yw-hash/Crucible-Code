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
]

async function main() {
  console.log('\nFAULT-INJECTION live — recovery rate of the on-device loop\n')
  const started = Date.now()
  const report = await runFaultSuite(TARGETS, { maxModelCalls: 6 })

  for (const t of report.trials) {
    const tag = !t.applicable ? 'skip ' : !t.detected ? 'GAP  ' : t.recovered ? 'FIXED' : 'MISS '
    console.log(`  ${tag} ${t.target}/${t.mutation}${t.detected ? ` — ${t.modelCalls} call(s), ${t.status}` : t.applicable ? ' — equivalent mutant (coverage gap)' : ''}`)
  }
  console.log(`\n  applicable trials : ${report.applicable}`)
  console.log(`  detection rate    : ${(report.detectionRate * 100).toFixed(0)}%  (case sets seeing injected faults)`)
  console.log(`  RECOVERY RATE     : ${(report.recoveryRate * 100).toFixed(0)}%  (${report.recovered}/${report.detected} detected faults fixed+certified)`)
  console.log(`  model calls       : ${report.totalModelCalls}`)
  console.log(`  wall clock        : ${((Date.now() - started) / 1000).toFixed(0)}s\n`)
}

main().catch(e => { console.error(e); process.exit(1) })
