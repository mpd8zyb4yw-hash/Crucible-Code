// ═══════════════════════════════════════════════════════════════════════════════
// OFFLINE bench for signal-directed mechanical repair. ZERO model calls.
// Run:  npx tsx src/CrucibleEngine/reasoning/__mechrepair_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every INPUT below is a real fault class observed in the 2026-07-26 direct-arm run
// (`__direct_vs_decompose_live.ts`, 3 runs × 10 tasks × 8 draws) — the terminal best-of-8
// failures that were mechanical rather than algorithmic. The bench asserts that the repair
// sweep turns each one into a program the REAL verifier certifies, using the REAL acceptance
// cases from the general scorecard. Nothing is mocked: `sweepMechanicalRepairs` executes the
// repaired source exactly as the search loop would.
//
// A row is GREEN only when a repair is CERTIFIED — "it produced some variant" is not a pass.

import { mechanicalRepairs, sweepMechanicalRepairs } from './mechanicalRepair'
import type { TaskSpec } from './types'

interface Row {
  name: string
  /** The broken source, verbatim in the shape the head actually emits. */
  src: string
  /** The verifier signals that source produced — the localizer. */
  signals: string[]
  spec: TaskSpec
  /** True when a certified repair is REQUIRED; false when the row asserts "must NOT fire". */
  expectCertified: boolean
}

const spec = (entry: string, goal: string, cases: Array<{ args: unknown[]; expected: unknown }>): TaskSpec =>
  ({ goal, domain: 'code', acceptance: { entry, cases } })

const WORDFREQ = spec('wordFrequencyTop', 'top-k word frequency', [
  { args: ['', 3], expected: [] },
  { args: ['the cat the dog THE bird cat', 2], expected: ['the', 'cat'] },
  { args: ['a b c', 2], expected: ['a', 'b'] },
  { args: ['Hello, hello! world.', 5], expected: ['hello', 'world'] },
  { args: ['x y x y z', 3], expected: ['x', 'y', 'z'] },
])

const COMPRESS = spec('compressRuns', 'run-length encode', [
  { args: [''], expected: '' }, { args: ['a'], expected: 'a' }, { args: ['aab'], expected: 'a2b' },
  { args: ['aaabccddd'], expected: 'a3bc2d3' }, { args: ['abcd'], expected: 'abcd' }, { args: ['aaaaaaaaaaaa'], expected: 'a12' },
])

const SORTNUMS = spec('sortNums', 'sort numbers ascending', [
  { args: [[10, 2, 33, 4]], expected: [2, 4, 10, 33] },
  { args: [[]], expected: [] },
  { args: [[5]], expected: [5] },
])

const INTDIV = spec('divide', 'integer division truncating toward zero', [
  { args: [7, 2], expected: 3 }, { args: [9, 3], expected: 3 }, { args: [1, 2], expected: 0 },
])

const ROWS: Row[] = [
  {
    // OBSERVED: `case basicCalculator on input "3+2*2" threw: Assignment to constant variable.`
    name: 'const accumulator reassigned (Assignment to constant variable)',
    src: `export function compressRuns(s) {
  const out = ''
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] === s[i]) j++
    out += s[i] + (j - i > 1 ? String(j - i) : '')
    i = j
  }
  return out
}`,
    signals: ['case compressRuns #1 on input "a" threw: Assignment to constant variable.'],
    spec: COMPRESS,
    expectCertified: true,
  },
  {
    // OBSERVED: `syntax error: The symbol "lastNumber" has already been declared`
    name: 'duplicate declaration (symbol already declared)',
    src: `export function compressRuns(s) {
  let out = ''
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] === s[i]) j++
    const run = j - i
    let run = j - i
    out += s[i] + (run > 1 ? String(run) : '')
    i = j
  }
  return out
}`,
    signals: ['syntax error (does not compile): The symbol "run" has already been declared'],
    spec: COMPRESS,
    expectCertified: true,
  },
  {
    // OBSERVED: `threw: frequencyMap.entries(...).sort is not a function`
    name: 'Map iterator treated as array (.sort is not a function)',
    src: `export function wordFrequencyTop(text, k) {
  const words = (text.toLowerCase().match(/[a-z]+/g) || [])
  const frequencyMap = new Map()
  for (const w of words) frequencyMap.set(w, (frequencyMap.get(w) || 0) + 1)
  return frequencyMap.entries()
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, k)
    .map(e => e[0])
}`,
    signals: ['case wordFrequencyTop #0 on input "", 3 threw: frequencyMap.entries(...).sort is not a function'],
    spec: WORDFREQ,
    expectCertified: true,
  },
  {
    // OBSERVED: `syntax error (does not compile): Unterminated string literal`
    name: 'unterminated string literal',
    src: `export function compressRuns(s) {
  let out = '
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] === s[i]) j++
    out += s[i] + (j - i > 1 ? String(j - i) : '')
    i = j
  }
  return out
}`,
    signals: ['syntax error (does not compile): Unterminated string literal'],
    spec: COMPRESS,
    expectCertified: true,
  },
  {
    // The classic silent JS numeric bug. Verifier reports it only as a wrong ORDER.
    name: 'bare .sort() sorts lexicographically',
    src: `export function sortNums(xs) { return [...xs].sort() }`,
    signals: ['case sortNums #0 on input [10,2,33,4] → got [10,2,33,4], expected [2,4,10,33]'],
    spec: SORTNUMS,
    expectCertified: true,
  },
  {
    name: 'bare division where the spec truncates toward zero',
    src: `export function divide(a, b) { return a / b }`,
    signals: ['case divide #0 on input 7, 2 → got 3.5, expected 3'],
    spec: INTDIV,
    expectCertified: true,
  },
  {
    // GUARD: a purely algorithmic failure must produce NO repair, at zero cost.
    name: 'algorithmic failure licenses no repair (guard)',
    src: `export function compressRuns(s) { return s.split('').reverse().join('') }`,
    signals: ['case compressRuns #2 on input "aab" → got "baa", expected "a2b"'],
    spec: COMPRESS,
    expectCertified: false,
  },
  {
    // GUARD: `const` that is never reassigned must not be rewritten.
    name: 'non-reassigned const is left alone (guard)',
    src: `export function divide(a, b) { const q = a; return q / b }`,
    signals: ['case divide #0 on input 7, 2 → got 3.5, expected 3'],
    spec: INTDIV,
    expectCertified: true, // the truncation rule fires; the const rule must not corrupt it
  },
]

async function main(): Promise<void> {
  console.log('# mechanical-repair bench — signal-directed deterministic repair, ZERO model calls\n')
  let pass = 0
  let totalVariants = 0
  const t0 = Date.now()

  for (const row of ROWS) {
    const variants = mechanicalRepairs(row.src, row.signals)
    totalVariants += variants.length
    const sweep = await sweepMechanicalRepairs(row.src, row.signals, row.spec, -Infinity)
    const certified = !!sweep.certified
    const ok = certified === row.expectCertified
    if (ok) pass++
    const mark = ok ? 'PASS' : 'FAIL'
    const what = certified ? `certified via "${sweep.certified!.repair.label}"` : 'no certified repair'
    console.log(`  ${mark}  ${row.name}`)
    console.log(`        ${variants.length} variant(s) enumerated → ${what}`)
    if (!ok) {
      console.log(`        EXPECTED certified=${row.expectCertified}, GOT ${certified}`)
      for (const v of variants) console.log(`          · ${v.label}`)
    }
  }

  const ms = Date.now() - t0
  console.log(`\n  ${pass}/${ROWS.length} rows green — ${totalVariants} total variants executed in ${ms}ms (${(ms / Math.max(1, totalVariants)).toFixed(1)}ms per variant)`)
  console.log(`  For scale: ONE model draw on this box costs ~4000ms.`)
  if (pass !== ROWS.length) { console.error('\nmechanical-repair bench RED'); process.exit(1) }
}

main().catch(e => { console.error('mechrepair bench failed:', e); process.exit(1) })
