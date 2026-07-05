// ============================================================================
// Committed bench for repairProposers.ts — this file had NO test coverage anywhere in the
// repo despite containing 7 distinct deterministic repair functions, each confirmed against
// a real live FM failure per its own header comment. Found 2026-07-06 while adding an 8th
// repair (repairMutatingSort) for the leaderboardModule mutation bug and auditing the file
// for the same "no committed bench" test-debt pattern already closed for localHardenCheck.ts
// (cont.20), lintGate.ts/contractGate.ts (cont.24). One true-positive case per repair
// (proposeRepairs must produce the exact fixed candidate) plus a couple of no-op
// false-positive guards (repairs must not fire / must not corrupt already-correct code).
// Run: npx tsx src/CrucibleEngine/synth/__repairProposers_bench.ts
// ============================================================================
import { proposeRepairs } from './repairProposers'

interface Case {
  name: string
  candidate: string
  detail: string
  spec?: string
  // Exact string the repaired candidate must equal, or null if no repair should fire at all.
  expect: string | null
}

const CASES: Case[] = [
  {
    name: 'repairMissingField: TS2741 missing derived field gets a type-appropriate stub',
    candidate: `const out = { credits: 10, debits: 5 }`,
    detail: `Property 'balance' is missing in type '{ credits: number; debits: number }' but required in type 'AccountSummary'`,
    // Note the space-before-comma is the real (cosmetic-only, still valid TS) output shape —
    // the splice point is the original literal's own trailing space before its closing brace.
    expect: `const out = { credits: 10, debits: 5 , balance: 0 }`,
  },
  {
    name: 'repairDerivedField: spec-pinned "balance = credits - debits" gets computed before return',
    candidate: `function f(m) { return m }`,
    detail: '',
    spec: 'Rules: balance = credits - debits.',
    expect: `function f(m) { for (const __k of Object.keys(m)) { (m as any)[__k].balance = (m as any)[__k].credits - (m as any)[__k].debits }\n  return m }`,
  },
  {
    name: 'repairDynamicKeyIndex: b[key] mirrors the ternary that built key for a',
    candidate: `products.sort((a, b) => { const key = opts.by === 'price' ? a.price : a.name; return key < b[key] ? -1 : 1 })`,
    detail: `FAIL — sorted ascending by price when direction omitted`,
    expect: `products.sort((a, b) => { const key = opts.by === 'price' ? a.price : a.name; return key < (opts.by === 'price' ? b.price : b.name) ? -1 : 1 })`,
  },
  {
    name: 'repairDefaultDirectionCheck: explicit-value check flipped to default-negative check',
    candidate: `const dir = opts.direction === 'asc' ? 1 : -1`,
    detail: `FAIL — sorted ascending by price when direction omitted`,
    expect: `const dir = opts.direction !== 'desc' ? 1 : -1`,
  },
  {
    name: 'repairOneSidedCaseInsensitive: search term gets lowercased to match the already-lowercased field',
    candidate: `users.filter(u => u.name.toLowerCase().includes(opts.query))`,
    detail: `FAIL — query filter case-insensitive`,
    expect: `users.filter(u => u.name.toLowerCase().includes(opts.query.toLowerCase()))`,
  },
  {
    name: 'repairActiveFalseGuard: truthiness guard replaced with undefined-aware inequality',
    candidate: `if (opts.active && !user.active) continue`,
    detail: `FAIL — active=false returns only inactive`,
    expect: `if (opts.active !== undefined && user.active !== opts.active) continue`,
  },
  {
    name: 'repairArrayGuard: spurious Array.isArray(opts) throw-guard stripped',
    candidate: `function f(opts) {\n  if (!Array.isArray(opts)) throw new TypeError('bad');\n  return opts\n}`,
    detail: `does not throw on a well-formed call — threw: TypeError: bad`,
    expect: `function f(opts) {\nreturn opts\n}`,
  },
  {
    name: 'repairMutatingSort: bare arr.sort() rewritten to a non-mutating [...arr].sort()',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return scores.sort((a, b) => a - b) }`,
    detail: `sortScoresAscending fails the sort-no-mutate property — the function mutates its input argument in place. Return a NEW array/object instead of modifying the one passed in (e.g. use [...arr].sort(...) or arr.slice(), never arr.sort(...) directly on the parameter).`,
    expect: `export function sortScoresAscending(scores: number[]): number[] { return [...scores].sort((a, b) => a - b) }`,
  },
  {
    name: 'repairMutatingSort: no-op on already-correct spread form (no false rewrite)',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return [...scores].sort((a, b) => a - b) }`,
    detail: `mutates its input argument in place`,
    expect: null,
  },
  {
    name: 'repairMutatingSort: no-op on already-correct .slice() form (no false rewrite)',
    candidate: `export function sortScoresAscending(scores: number[]): number[] { return scores.slice().sort((a, b) => a - b) }`,
    detail: `mutates its input argument in place`,
    expect: null,
  },
  {
    name: 'no repair fires when detail matches nothing (clean candidate, no gate triggered)',
    candidate: `export function add(a: number, b: number): number { return a + b }`,
    detail: 'unrelated failure text',
    expect: null,
  },
]

function main() {
  let pass = 0
  for (const c of CASES) {
    const repairs = proposeRepairs(c.candidate, c.detail, c.spec ?? '')
    let ok: boolean
    if (c.expect === null) {
      ok = repairs.length === 0
    } else {
      ok = repairs.includes(c.expect)
    }
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name}`)
    if (!ok) console.log(`    got: ${JSON.stringify(repairs)}\n    expected: ${JSON.stringify(c.expect)}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
