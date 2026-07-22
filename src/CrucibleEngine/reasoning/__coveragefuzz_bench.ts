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

import {
  coverageFuzz,
  intArrayMutator,
  stringMutator,
  tupleMutator,
  type FuzzResult,
  type Mutator,
} from './coverageFuzz'

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
  /** Override the default int-array mutator/seeds for non-array arg shapes. */
  mutate?: Mutator
  seeds?: unknown[][]
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
  {
    // String surface: candidate uppercases only ASCII via a naive branch; reference uses toUpperCase.
    // The bug hides behind a non-ASCII char ('á'/'Ω') that stringMutator's alphabet deliberately includes.
    id: 'diff (string): naive ASCII-only upcase vs toUpperCase',
    entry: 'f',
    source: src(
      'export function f(s: string): string {',
      '  let out = ""',
      '  for (const c of s) {',
      '    if (c >= "a" && c <= "z") {',
      '      out += String.fromCharCode(c.charCodeAt(0) - 32)',
      '    } else {',
      '      out += c',
      '    }',
      '  }',
      '  return out',
      '}',
    ),
    reference: (s: string) => s.toUpperCase(),
    expectBug: true,
    mutate: stringMutator,
    seeds: [[''], ['abc'], ['aΩ']],
  },
  {
    // Multi-argument surface: candidate's indexOf-style search is off-by-one at the tail.
    // tupleMutator drives (haystack, needle) independently; reference is String.prototype.includes.
    id: 'diff (tuple): buggy substring search misses tail match',
    entry: 'f',
    source: src(
      'export function f(hay: string, needle: string): boolean {',
      '  if (needle.length === 0) { return true }',
      '  for (let i = 0; i < hay.length - needle.length; i++) {',
      '    if (hay.slice(i, i + needle.length) === needle) {',
      '      return true',
      '    }',
      '  }',
      '  return false',
      '}',
    ),
    reference: (hay: string, needle: string) => hay.includes(needle),
    expectBug: true,
    mutate: tupleMutator([stringMutator, stringMutator]),
    seeds: [['', ''], ['abc', 'b'], ['abc', 'c']],
  },
]

const SEEDS: number[][][] = [[[]], [[2]], [[1, 2, 3]]].map(s => s as number[][])

let pass = 0
const fails: string[] = []
console.log('── Coverage-guided fuzz self-verification (differential + property, minimized) ──\n')

for (const t of TRIALS) {
  const r: FuzzResult = coverageFuzz(t.source, t.entry, t.seeds ?? SEEDS, t.mutate ?? intArrayMutator, {
    reference: t.reference,
    property: t.property,
    iterations: 600,
    seed: 0xc0ffee,
  })

  let ok: boolean
  let note = ''
  if (t.expectBug) {
    ok = r.status === 'counterexample'
    if (ok) note = `witness=${JSON.stringify(r.counterexample!.args)} [${r.counterexample!.kind}]`
    if (ok && t.maxWitnessLen !== undefined) {
      const arg0 = r.counterexample!.args[0]
      const len = Array.isArray(arg0) ? arg0.length : 0
      if (len > t.maxWitnessLen) { ok = false; note = `witness not minimal (len ${len} > ${t.maxWitnessLen})` }
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
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${pass}/${TRIALS.length} checks passed`)
if (fails.length) console.log(`  failing: ${fails.join('; ')}`)
process.exit(ok ? 0 : 1)
