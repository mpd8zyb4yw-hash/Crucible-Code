// Proof: Crucible reasons about NOVEL coding tasks with PURE CODE and ZERO model inference —
// by bottom-up enumerative program search over a typed DSL — and the solutions GENERALIZE.
//
// The rigorous parts:
//   • SOLVE tasks   — reveal only a SHOWN subset of worked examples to the synthesizer, then
//                     verify the emitted function against a HELD-OUT subset it never saw, run
//                     through the same execution oracle. Held-out PASS = it found the real
//                     program, not an overfit to the shown examples.
//   • BOUNDARY tasks — DP/recursion the expression DSL cannot compose; the engine must report
//                     'none' so the cascade escalates rather than bluff.
//   • AMBIGUOUS tasks — examples that two equally-simple programs both satisfy; the engine must
//                     report 'ambiguous' (under-specified) rather than ship a coin-flip.
//
// Run: npm run synth:enum   (model-cost-independent, no daemon, no network — it's pure code)

import { enumerate } from './proposers/enumerative'
import { deriveTests } from './derive'
import { verifyCandidate } from './oracle'

interface Task {
  name: string
  sig: string            // exported signature line (gives names/types to the synthesizer)
  examples: string[]     // worked-example lines, "name(args) === out"
  shown: number          // how many examples the synthesizer is allowed to see
  expect: 'solve' | 'boundary' | 'ambiguous'
}

const TASKS: Task[] = [
  // ── expression-composable → SOLVE with no model, must hold on held-out cases ──
  { name: 'sumList', expect: 'solve', shown: 4,
    sig: 'export function sumList(xs: number[]): number',
    examples: ['sumList([1,2,3]) === 6', 'sumList([10,20]) === 30', 'sumList([5]) === 5', 'sumList([]) === 0', 'sumList([2,2,2,2]) === 8', 'sumList([-1,1]) === 0'] },
  { name: 'doubleAll', expect: 'solve', shown: 3,
    sig: 'export function doubleAll(xs: number[]): number[]',
    examples: ['doubleAll([1,2,3]) === [2,4,6]', 'doubleAll([0]) === [0]', 'doubleAll([5,10]) === [10,20]', 'doubleAll([-1,4]) === [-2,8]'] },
  { name: 'maxTwo', expect: 'solve', shown: 3,
    sig: 'export function maxTwo(a: number, b: number): number',
    examples: ['maxTwo(3,7) === 7', 'maxTwo(9,2) === 9', 'maxTwo(4,4) === 4', 'maxTwo(-5,-9) === -5'] },
  { name: 'reverseString', expect: 'solve', shown: 3,
    sig: 'export function reverseString(s: string): string',
    examples: ["reverseString('abc') === 'cba'", "reverseString('hello') === 'olleh'", "reverseString('a') === 'a'", "reverseString('') === ''"] },
  { name: 'isPalindrome', expect: 'solve', shown: 4,
    sig: 'export function isPalindrome(s: string): boolean',
    examples: ["isPalindrome('racecar') === true", "isPalindrome('hello') === false", "isPalindrome('abba') === true", "isPalindrome('ab') === false", "isPalindrome('') === true", "isPalindrome('x') === true"] },
  { name: 'sumSquares', expect: 'solve', shown: 3,
    sig: 'export function sumSquares(xs: number[]): number',
    examples: ['sumSquares([1,2,3]) === 14', 'sumSquares([2]) === 4', 'sumSquares([0,4]) === 16', 'sumSquares([]) === 0', 'sumSquares([1,1,1]) === 3'] },
  { name: 'countPositives', expect: 'solve', shown: 3,
    sig: 'export function countPositives(xs: number[]): number',
    examples: ['countPositives([1,-2,3,-4]) === 2', 'countPositives([5,5]) === 2', 'countPositives([-1,-1]) === 0', 'countPositives([]) === 0', 'countPositives([0,1]) === 1'] },
  { name: 'lengthOf', expect: 'solve', shown: 2,
    sig: 'export function lengthOf(s: string): number',
    examples: ["lengthOf('abc') === 3", "lengthOf('hello') === 5", "lengthOf('') === 0"] },
  { name: 'joinWithComma', expect: 'solve', shown: 2,
    sig: 'export function joinWithComma(xs: string[]): string',
    examples: ["joinWithComma(['a','b','c']) === 'a,b,c'", "joinWithComma(['x']) === 'x'", "joinWithComma([]) === ''"] },
  { name: 'uniqueSorted', expect: 'solve', shown: 3,
    sig: 'export function uniqueSorted(xs: number[]): number[]',
    examples: ['uniqueSorted([3,3,1,2]) === [1,2,3]', 'uniqueSorted([5,5]) === [5]', 'uniqueSorted([2,1]) === [1,2]', 'uniqueSorted([]) === []', 'uniqueSorted([4,1,4,2]) === [1,2,4]'] },
  { name: 'lastElement', expect: 'solve', shown: 2,
    sig: 'export function lastElement(xs: number[]): number',
    examples: ['lastElement([1,2,3]) === 3', 'lastElement([4,5,1]) === 1', 'lastElement([9]) === 9', 'lastElement([4,5]) === 5'] },
  { name: 'absVal', expect: 'solve', shown: 3,
    sig: 'export function absVal(n: number): number',
    examples: ['absVal(-5) === 5', 'absVal(3) === 3', 'absVal(0) === 0', 'absVal(-10) === 10'] },
  { name: 'product', expect: 'solve', shown: 3,
    sig: 'export function product(xs: number[]): number',
    examples: ['product([1,2,3,4]) === 24', 'product([5]) === 5', 'product([]) === 1', 'product([2,3]) === 6'] },
  { name: 'evens', expect: 'solve', shown: 2,
    sig: 'export function evens(xs: number[]): number[]',
    examples: ['evens([1,2,3,4]) === [2,4]', 'evens([1,3]) === []', 'evens([2]) === [2]', 'evens([0,5,6]) === [0,6]'] },

  { name: 'identity', expect: 'solve', shown: 2,
    sig: 'export function identity(x: number): number',
    examples: ['identity(5) === 5', 'identity(-3) === -3', 'identity(0) === 0'] },
  { name: 'first', expect: 'solve', shown: 2,
    sig: 'export function first(a: number, b: number): number',
    examples: ['first(3,9) === 3', 'first(7,1) === 7', 'first(0,5) === 0'] },

  // ── honest boundary → not expression-composable; engine must report 'none' (escalate) ──
  { name: 'editDistance', expect: 'boundary', shown: 4,
    sig: 'export function editDistance(a: string, b: string): number',
    examples: ["editDistance('kitten','sitting') === 3", "editDistance('cat','cot') === 1", "editDistance('','abc') === 3", "editDistance('flaw','lawn') === 2"] },
  { name: 'fibonacci', expect: 'boundary', shown: 5,
    sig: 'export function fibonacci(n: number): number',
    examples: ['fibonacci(0) === 0', 'fibonacci(1) === 1', 'fibonacci(2) === 1', 'fibonacci(5) === 5', 'fibonacci(7) === 13'] },

  // ── under-specified → two equally-simple programs fit; engine must report 'ambiguous' ──
  { name: 'dedupeSorted', expect: 'ambiguous', shown: 3,
    sig: 'export function dedupeSorted(xs: number[]): number[]',
    examples: ['dedupeSorted([3,1,2,3,1]) === [1,2,3]', 'dedupeSorted([5,5]) === [5]', 'dedupeSorted([]) === []'] },
]

const moduleOf = (sig: string) => `src/${(/function\s+(\w+)/.exec(sig)?.[1] ?? 'm')}.ts`

function run(): void {
  console.log('Crucible ENUMERATIVE reasoning proof — novel tasks, pure code, ZERO model, held-out verified\n')
  const counts = { solve: 0, generalized: 0, boundary: 0, ambiguous: 0 }
  const totals = { solve: 0, boundary: 0, ambiguous: 0 }
  let regress = 0

  for (const t of TASKS) {
    totals[t.expect]++
    const module = moduleOf(t.sig)
    const shownSpec = `${t.sig}\n${t.examples.slice(0, t.shown).join('\n')}`
    const t0 = Date.now()
    const o = enumerate(shownSpec, { modulePath: module })
    const ms = Date.now() - t0

    if (t.expect === 'boundary') {
      const ok = o.status === 'none'
      ok ? counts.boundary++ : regress++
      console.log(`  ${ok ? 'BOUNDARY ✓' : 'REGRESS ✗'}  ${t.name.padEnd(15)} ${ok ? 'correctly escalated' : `unexpected ${o.status}`} (${ms}ms)`)
      continue
    }
    if (t.expect === 'ambiguous') {
      const ok = o.status === 'ambiguous'
      ok ? counts.ambiguous++ : regress++
      const why = o.status === 'ambiguous' ? o.candidates.join('  vs  ') : o.status
      console.log(`  ${ok ? 'AMBIG ✓' : 'REGRESS ✗'}     ${t.name.padEnd(15)} ${ok ? `escalated — under-specified [${why}]` : `expected ambiguous, got ${o.status}`} (${ms}ms)`)
      continue
    }

    // expect 'solve'
    if (o.status !== 'solved') { regress++; console.log(`  MISS ✗      ${t.name.padEnd(15)} expected a solution, got ${o.status} (${ms}ms)`); continue }
    counts.solve++
    const enr = o.result
    const held = deriveTests(`${t.sig}\n${t.examples.slice(t.shown).join('\n')}`, module)
    let gen = false, detail = 'no held-out tests'
    if (held) { const v = verifyCandidate(enr.files, held.testFile); gen = v.accepted; detail = v.detail }
    gen ? counts.generalized++ : regress++
    console.log(`  ${gen ? 'SOLVE ✓' : 'OVERFIT ✗'}    ${t.name.padEnd(15)} ${enr.fnName} = ${enr.expr} (size ${enr.size}, ${ms}ms) | held-out: ${gen ? 'ALL PASS' : detail}`)
  }

  console.log(`\nSolved ${counts.solve}/${totals.solve} pure-code · generalized ${counts.generalized}/${totals.solve} on held-out · honest boundary ${counts.boundary}/${totals.boundary} · ambiguity caught ${counts.ambiguous}/${totals.ambiguous} · 0 model calls`)
  const pass = counts.generalized === totals.solve && counts.boundary === totals.boundary && counts.ambiguous === totals.ambiguous && regress === 0
  console.log(pass
    ? '\nPROVEN: reasoned every composable task from worked examples alone — pure code, no model — each solution held on unseen cases; honest boundary + under-specification both handled.'
    : '\nINCOMPLETE: see ✗ rows above.')
  process.exit(pass ? 0 : 1)
}

run()
