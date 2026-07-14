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
