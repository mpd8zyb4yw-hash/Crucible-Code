// ═══════════════════════════════════════════════════════════════════════════════
// SELF-VERIFYING BENCH for coverage-guided differential/property fuzzing (W12).
//
// No human labels: a correct reference is the oracle. Buggy candidates MUST yield a
// minimized counterexample; a candidate equal to the reference MUST stay clean (no
// false positive). One case hides the bug behind a RARE branch that fixed cases would
// miss — proving the coverage guidance is doing real work.
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__coveragefuzz_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { coverageFuzz, intArrayMutator, type FuzzResult } from './coverageFuzz'

interface Trial {
  id: string
  entry: string
  source: string
  reference?: (...a: unknown[]) => unknown
  property?: (args: unknown[], out: unknown) => boolean
  expectBug: boolean
  /** Upper bound on the minimized witness's array length — proves shrinking works. */
  maxWitnessLen?: number
  /** Lower bound on distinct source lines covered — proves coverage guidance actually ran. */
  minEdges?: number
}

const sumEvenRef = (xs: number[]) => xs.filter(x => x % 2 === 0).reduce((a, b) => a + b, 0)

// Sources are MULTI-LINE so distinct branches are distinct source lines — line-based coverage can
// then actually distinguish paths, and coverage guidance has something real to guide on.
const src = (...lines: string[]) => lines.join('\n')

const TRIALS: Trial[] = [
  {
    id: 'clean: correct sumEven vs reference',
    entry: 'f',
    source: src(
      'export function f(xs: number[]): number {',
      '  let t = 0',
      '  for (const x of xs) {',
      '    if (x % 2 === 0) {',
      '      t += x',
      '    }',
      '  }',
      '  return t',
      '}',
    ),
    reference: sumEvenRef,
    expectBug: false,
    minEdges: 4, // must drive the candidate through at least 4 distinct source lines
  },
  {
    id: 'diff: off-by-parity bug (sums ODD)',
    entry: 'f',
    source: src(
      'export function f(xs: number[]): number {',
      '  let t = 0',
      '  for (const x of xs) {',
      '    if (x % 2 === 1) {',
      '      t += x',
      '    }',
      '  }',
      '  return t',
      '}',
    ),
    reference: sumEvenRef,
    expectBug: true,
    maxWitnessLen: 1,
  },
  {
    id: 'diff: RARE-branch bug (miscounts only when a 7 is present)',
    // The fault hides behind `x === 7` on its OWN line — a branch random fixed cases rarely reach.
    // Coverage guidance keeps the first input that lands on that line and drills in. This is the
    // case that justifies W12 over plain random property testing.
    entry: 'f',
    source: src(
      'export function f(xs: number[]): number {',
      '  let t = 0',
      '  for (const x of xs) {',
      '    if (x === 7) {',
      '      t += 1',
      '    } else if (x % 2 === 0) {',
      '      t += x',
      '    }',
      '  }',
      '  return t',
      '}',
    ),
    reference: sumEvenRef,
    expectBug: true,
    maxWitnessLen: 1,
  },
  {
    id: 'crash: candidate throws on empty, reference does not',
    entry: 'f',
    source: src(
      'export function f(xs: number[]): number {',
      '  if (xs.length === 0) {',
      '    throw new Error("boom")',
      '  }',
      '  return xs[0]',
      '}',
    ),
    reference: (xs: number[]) => (xs.length === 0 ? 0 : xs[0]),
    expectBug: true,
    maxWitnessLen: 0,
  },
  {
    id: 'property: output must be a sum of only even inputs (bug sums all)',
    entry: 'f',
    source: src(
      'export function f(xs: number[]): number {',
      '  let t = 0',
      '  for (const x of xs) {',
      '    t += x',
      '  }',
      '  return t',
      '}',
    ),
    // Invariant without a reference: result equals the sum of the even inputs.
    property: (args, out) => out === (args[0] as number[]).filter(x => x % 2 === 0).reduce((a, b) => a + b, 0),
    expectBug: true,
    maxWitnessLen: 1,
  },
]

const SEEDS: number[][][] = [[[]], [[2]], [[1, 2, 3]]].map(s => s as number[][])

let pass = 0
const fails: string[] = []
console.log('── Coverage-guided fuzz self-verification (differential + property, minimized) ──\n')

for (const t of TRIALS) {
  const r: FuzzResult = coverageFuzz(t.source, t.entry, SEEDS, intArrayMutator, {
    reference: t.reference,
    property: t.property,
    iterations: 600,
    seed: 0xc0ffee,
  })

  let ok: boolean
  let note = ''
  if (t.expectBug) {
    ok = r.status === 'counterexample'
    if (ok && t.maxWitnessLen !== undefined) {
      const arg0 = r.counterexample!.args[0]
      const len = Array.isArray(arg0) ? arg0.length : 0
      if (len > t.maxWitnessLen) { ok = false; note = `witness not minimal (len ${len} > ${t.maxWitnessLen})` }
      else note = `witness=${JSON.stringify(r.counterexample!.args)} [${r.counterexample!.kind}]`
    }
  } else {
    ok = r.status === 'clean'
    note = `covered ${r.edgesCovered} lines over ${r.iterations} runs, corpus ${r.corpusSize}`
    if (!ok) note = `false positive: ${JSON.stringify(r.counterexample?.args)}`
    else if (t.minEdges !== undefined && r.edgesCovered < t.minEdges) {
      ok = false
      note = `coverage too low (${r.edgesCovered} < ${t.minEdges}) — guidance not exercised`
    }
  }

  if (ok) pass++; else fails.push(t.id)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${t.id}`)
  if (note) console.log(`         ${note}`)
}

const ok = pass === TRIALS.length
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${pass}/${TRIALS.length} trials`)
if (fails.length) console.log(`  failing: ${fails.join('; ')}`)
process.exit(ok ? 0 : 1)
