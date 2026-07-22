// ═══════════════════════════════════════════════════════════════════════════════
// SELF-VERIFYING BENCH for spectrum-based fault localization (W8).
//
// The localizer's accuracy is measurable WITHOUT human labels: take known-good code,
// inject a fault at a KNOWN line via faultInject's deterministic mutation operators,
// run the localizer, and assert the injected line ranks in the top-K suspects. The
// mutation tells us the ground-truth fault line, so this is a closed loop — exactly
// the self-verifying capability the doctrine prizes (a metric with no oracle).
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__faultlocalize_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { MUTATIONS } from './faultInject'
import { localizeFault, type LocCase } from './faultLocalize'

interface Target {
  id: string
  entry: string
  code: string
  cases: LocCase[]
}

// Braced bodies so instrumentation resolves per-branch. Case sets are DISCRIMINATING:
// each has inputs that survive a single-point mutation and inputs that break under it,
// so the passing/failing spectrum has real contrast (the whole basis of Ochiai).
const TARGETS: Target[] = [
  {
    id: 'clamp',
    entry: 'clamp',
    code: [
      'export function clamp(x: number, lo: number, hi: number): number {',
      '  if (x < lo) {',
      '    return lo',
      '  }',
      '  if (x > hi) {',
      '    return hi',
      '  }',
      '  return x',
      '}',
    ].join('\n'),
    cases: [
      { args: [-5, 0, 10], expected: 0, name: 'below' },
      { args: [3, 0, 10], expected: 3, name: 'inside' },
      { args: [50, 0, 10], expected: 10, name: 'above' },
      { args: [0, 0, 10], expected: 0, name: 'at-lo' },
      { args: [10, 0, 10], expected: 10, name: 'at-hi' },
      { args: [7, 0, 10], expected: 7, name: 'inside2' },
    ],
  },
  {
    id: 'sumEven',
    entry: 'sumEven',
    code: [
      'export function sumEven(xs: number[]): number {',
      '  let total = 0',
      '  for (let i = 0; i < xs.length; i++) {',
      '    if (xs[i] % 2 === 0) {',
      '      total = total + xs[i]',
      '    }',
      '  }',
      '  return total',
      '}',
    ].join('\n'),
    cases: [
      { args: [[1, 2, 3, 4]], expected: 6, name: 'mixed' },
      { args: [[2, 4, 6]], expected: 12, name: 'all-even' },
      { args: [[1, 3, 5]], expected: 0, name: 'all-odd' },
      { args: [[]], expected: 0, name: 'empty' },
      { args: [[10]], expected: 10, name: 'single-even' },
      { args: [[7]], expected: 0, name: 'single-odd' },
    ],
  },
  {
    id: 'grade',
    entry: 'grade',
    code: [
      "export function grade(score: number): string {",
      '  if (score >= 90) {',
      "    return 'A'",
      '  }',
      '  if (score >= 80) {',
      "    return 'B'",
      '  }',
      "  return 'F'",
      '}',
    ].join('\n'),
    cases: [
      { args: [95], expected: 'A', name: 'high-A' },
      { args: [90], expected: 'A', name: 'edge-A' },
      { args: [85], expected: 'B', name: 'mid-B' },
      { args: [80], expected: 'B', name: 'edge-B' },
      { args: [50], expected: 'F', name: 'low-F' },
      { args: [79], expected: 'F', name: 'just-F' },
    ],
  },
]

/** First source line where good and mutant diverge = the injected fault line (1-indexed). */
function faultLine(good: string, mutant: string): number {
  const g = good.split('\n')
  const m = mutant.split('\n')
  const n = Math.min(g.length, m.length)
  for (let i = 0; i < n; i++) if (g[i] !== m[i]) return i + 1
  return Math.min(g.length, m.length) // pure deletion at the tail
}

function sanity(t: Target): boolean {
  const r = localizeFault(t.code, t.entry, t.cases)
  // Good code: every case passes, so the localizer must ABSTAIN (nothing to localize).
  return r.status === 'abstain' && /all .* passed/.test(r.reason ?? '')
}

let applicable = 0
let detected = 0
let hitExact = 0
let hitWithin1 = 0
const misses: string[] = []

console.log('── Fault-localization self-verification (inject known fault → assert top-K) ──\n')

for (const t of TARGETS) {
  if (!sanity(t)) {
    console.log(`  [WARN] ${t.id}: good code did not cleanly pass its own cases — target is miscrafted, skipping`)
    continue
  }
  for (const mut of MUTATIONS) {
    const mutant = mut.apply(t.code)
    if (mutant == null || mutant === t.code) continue // operator pattern absent — not applicable
    applicable++
    const fl = faultLine(t.code, mutant)
    const r = localizeFault(mutant, t.entry, t.cases)
    if (r.status !== 'localized') continue // mutant not detected by this case set — nothing to localize
    detected++
    const lines = r.ranked.map(s => s.line)
    const exact = lines.includes(fl)
    const within1 = lines.some(l => Math.abs(l - fl) <= 1)
    if (exact) hitExact++
    if (within1) hitWithin1++
    if (!within1) misses.push(`${t.id}/${mut.name}: fault@L${fl}, ranked=[${lines.join(',')}]`)
  }
}

const pctExact = detected ? ((hitExact / detected) * 100).toFixed(0) : '0'
const pctWithin1 = detected ? ((hitWithin1 / detected) * 100).toFixed(0) : '0'

console.log(`  applicable mutations : ${applicable}`)
console.log(`  detected (localizable): ${detected}`)
console.log(`  top-K exact-line hit : ${hitExact}/${detected}  (${pctExact}%)`)
console.log(`  top-K within ±1 line : ${hitWithin1}/${detected}  (${pctWithin1}%)`)
if (misses.length) {
  console.log('\n  misses:')
  for (const m of misses) console.log(`    - ${m}`)
}

// Gate: block-attribution (see faultLocalize LIMITATION) means brace-less lines fold into their
// enclosing block, so ±1 is the honest accuracy bar. Below it, the localizer is not earning trust.
const GATE = 0.8
const rate = detected ? hitWithin1 / detected : 0
const ok = detected > 0 && rate >= GATE
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — within-±1 rate ${(rate * 100).toFixed(0)}% vs gate ${GATE * 100}% (n=${detected})`)
process.exit(ok ? 0 : 1)
