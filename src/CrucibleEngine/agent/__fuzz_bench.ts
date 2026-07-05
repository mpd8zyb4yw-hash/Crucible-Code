// ============================================================================
// Committed bench for localHardenFuzz.ts — replaces cont.15's ad hoc scratch-script
// verification (4 cases, never committed) with a real test file covering all 8
// families plus the mutation-blindness companion properties (sort/set-op/dedupe),
// true-positive AND true-negative per family (zero-false-positive discipline matching
// localHardenCheck's bench convention). Run: npx tsx src/CrucibleEngine/agent/__fuzz_bench.ts
// ============================================================================
import { runLocalHardenFuzz } from './localHardenFuzz'

interface Case { name: string; src: string; expectFinding: boolean }

const CASES: Case[] = [
  // ── sort ──────────────────────────────────────────────────────────────
  {
    name: 'sort: correct ascending sort',
    src: `export function sortNumbers(arr: number[]): number[] { return [...arr].sort((a, b) => a - b) }`,
    expectFinding: false,
  },
  {
    name: 'sort: drops the last element (bug)',
    src: `export function sortNumbers(arr: number[]): number[] { const r = [...arr].sort((a, b) => a - b); return r.slice(0, -1) }`,
    expectFinding: true,
  },
  {
    // Correct output, but mutates the caller's array in place — the leaderboardModule
    // bug (2026-07-05) that the correctness property structurally can't see because it
    // always calls fn on a defensive copy. Only the sort-no-mutate companion catches this.
    name: 'sort: correct result but mutates input in place (bug)',
    src: `export function sortNumbers(arr: number[]): number[] { return arr.sort((a, b) => a - b) }`,
    expectFinding: true,
  },
  {
    // The actual leaderboardModule generation bug (2026-07-05): silently deduplicates via
    // Set before sorting, dropping repeated scores. Invisible to the old fc.integer() full
    // range (duplicates almost never generated) — caught now that the range is narrowed
    // to fc.integer({min:0,max:8}), same fix already proven for 'array-dedupe'.
    name: 'sort: silently dedupes via Set before sorting (bug)',
    src: `export function sortNumbers(arr: number[]): number[] { return Array.from(new Set(arr)).sort((a, b) => a - b) }`,
    expectFinding: true,
  },
  // ── validator ─────────────────────────────────────────────────────────
  {
    name: 'validator: correct boolean return',
    src: `export function isPalindrome(s: string): boolean { const r = s.split('').reverse().join(''); return r === s }`,
    expectFinding: false,
  },
  {
    name: 'validator: returns non-boolean (bug)',
    src: `export function isPalindrome(s: string): any { return s.length }`,
    expectFinding: true,
  },
  // ── string-transform ──────────────────────────────────────────────────
  {
    name: 'string-transform: correct string return',
    src: `export function trimAndLower(s: string): string { return s.trim().toLowerCase() }`,
    expectFinding: false,
  },
  {
    name: 'string-transform: returns non-string (bug)',
    src: `export function trimAndLower(s: string): any { return s.trim().length }`,
    expectFinding: true,
  },
  // ── comparator ────────────────────────────────────────────────────────
  {
    name: 'comparator: correct antisymmetric numeric comparator',
    src: `export function compareAscending(a: number, b: number): number { return a - b }`,
    expectFinding: false,
  },
  {
    name: 'comparator: not antisymmetric (bug — always returns 1)',
    src: `export function compareAscending(a: number, b: number): number { return 1 }`,
    expectFinding: true,
  },
  {
    // 2026-07-05 (cont.22): `() => 0` trivially satisfies antisymmetry (a===b check aside,
    // ab===0 && ba===0 both hold) but never actually orders anything — a real bug the old
    // property couldn't see.
    name: 'comparator: always returns 0 / treats every pair as equal (bug)',
    src: `export function compareAscending(a: number, b: number): number { return 0 }`,
    expectFinding: true,
  },
  {
    // 2026-07-06: type-collision guard. `compareVersions` matches the comparator family's
    // name+arity gate but takes STRING version params, not numbers — the fuzz property
    // feeds it random integers, and `a.split('.')` throws on a number, which fast-check
    // would otherwise report as a false "counterexample" for perfectly correct code.
    name: 'comparator: correct string comparator, non-numeric params (no finding — type guard)',
    src: `export function compareVersions(a: string, b: string): number { const pa = a.split('.').map(Number), pb = b.split('.').map(Number); for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d } return 0 }`,
    expectFinding: false,
  },
  // ── set-op-union ──────────────────────────────────────────────────────
  {
    name: 'set-op: correct union',
    src: `export function unionArrays(a: number[], b: number[]): number[] { return [...new Set([...a, ...b])] }`,
    expectFinding: false,
  },
  {
    name: 'set-op: union drops elements of b (bug)',
    src: `export function unionArrays(a: number[], b: number[]): number[] { return [...new Set(a)] }`,
    expectFinding: true,
  },
  {
    name: 'set-op: union correct but mutates a in place (bug)',
    src: `export function unionArrays(a: number[], b: number[]): number[] { for (const x of b) if (!a.includes(x)) a.push(x); return a }`,
    expectFinding: true,
  },
  // ── set-op-diff ───────────────────────────────────────────────────────
  {
    name: 'set-op: correct difference',
    src: `export function differenceArrays(a: number[], b: number[]): number[] { const s = new Set(b); return a.filter(x => !s.has(x)) }`,
    expectFinding: false,
  },
  {
    name: 'set-op: difference includes b-elements (bug)',
    src: `export function differenceArrays(a: number[], b: number[]): number[] { return [...a, ...b] }`,
    expectFinding: true,
  },
  {
    // 2026-07-05 (cont.22): `() => []` silently passed the old property — it only checked
    // "nothing foreign in the result," never that qualifying elements were actually present.
    name: 'set-op: difference always returns empty (bug — completeness gap)',
    src: `export function differenceArrays(a: number[], b: number[]): number[] { return [] }`,
    expectFinding: true,
  },
  {
    // 2026-07-06: type-collision guard. `differenceInDays` matches set-op-diff's
    // `/^(difference|subtract|complement)/` name gate at arity 2 but takes Date params,
    // not number arrays — the fuzz property would call `.filter`/`new Set` machinery on
    // whatever it feeds in, but the candidate itself does raw Date arithmetic and would
    // throw or silently misbehave on integers, a false positive on correct code.
    name: 'set-op: correct day-difference on Dates, non-array params (no finding — type guard)',
    src: `export function differenceInDays(a: Date, b: Date): number { return Math.round((a.getTime() - b.getTime()) / 86400000) }`,
    expectFinding: false,
  },
  // ── set-op-intersect ──────────────────────────────────────────────────
  {
    name: 'set-op: correct intersection',
    src: `export function intersectArrays(a: number[], b: number[]): number[] { const s = new Set(b); return a.filter(x => s.has(x)) }`,
    expectFinding: false,
  },
  {
    name: 'set-op: intersection includes foreign elements (bug)',
    src: `export function intersectArrays(a: number[], b: number[]): number[] { return [...a, ...b] }`,
    expectFinding: true,
  },
  {
    // Same completeness gap as differenceArrays above, for intersection.
    name: 'set-op: intersection always returns empty (bug — completeness gap)',
    src: `export function intersectArrays(a: number[], b: number[]): number[] { return [] }`,
    expectFinding: true,
  },
  // ── number-transform-clamp ────────────────────────────────────────────
  {
    name: 'clamp: correctly enforces both bounds',
    src: `export function clampValue(v: number, lo: number, hi: number): number { return Math.min(Math.max(v, lo), hi) }`,
    expectFinding: false,
  },
  {
    name: 'clamp: never enforces upper bound (bug)',
    src: `export function clampValue(v: number, lo: number, hi: number): number { return Math.max(v, lo) }`,
    expectFinding: true,
  },
  // ── array-dedupe ──────────────────────────────────────────────────────
  {
    name: 'dedupe: correct dedupe',
    src: `export function dedupeNumbers(arr: number[]): number[] { return [...new Set(arr)] }`,
    expectFinding: false,
  },
  {
    name: 'dedupe: leaves duplicates in (bug)',
    src: `export function dedupeNumbers(arr: number[]): number[] { return arr }`,
    expectFinding: true,
  },
  {
    name: 'dedupe: correct but mutates input in place (bug)',
    src: `export function dedupeNumbers(arr: number[]): number[] { let i = 0; while (i < arr.length) { if (arr.indexOf(arr[i]) !== i) arr.splice(i, 1); else i++ } return arr }`,
    expectFinding: true,
  },
  {
    // 2026-07-06: type-collision guard. `uniqueId` matches array-dedupe's
    // `/^(dedupe|dedup|unique|distinct)/` name gate at arity 1 but takes a string PREFIX,
    // not an array, and returns a string, not an array — the fuzz property would call it
    // with a random integer array and immediately fail the `Array.isArray(r)` check on
    // perfectly correct code, a false positive found the same way the comparator/set-op
    // ones above were.
    name: 'uniqueId: correct string-ID generator, non-array contract (no finding — type guard)',
    src: `export function uniqueId(prefix: string): string { return prefix + '_' + Math.random().toString(36).slice(2) }`,
    expectFinding: false,
  },
  // ── number-aggregate-sum ──────────────────────────────────────────────
  {
    name: 'sum: correct total',
    src: `export function sumValues(arr: number[]): number { return arr.reduce((a, b) => a + b, 0) }`,
    expectFinding: false,
  },
  {
    name: 'sum: off-by-one skip of first element (bug)',
    src: `export function sumValues(arr: number[]): number { return arr.slice(1).reduce((a, b) => a + b, 0) }`,
    expectFinding: true,
  },
  {
    name: 'sum: name-collision guard — summarizeByAccount is not a sum function (no finding)',
    src: `export function summarizeByAccount(txns: {account:string,amount:number}[]): Record<string, {balance:number}> { const out: Record<string, {balance:number}> = {}; for (const t of txns) { out[t.account] ??= {balance:0}; out[t.account].balance += t.amount } return out }`,
    expectFinding: false,
  },
]

function wrap(src: string): string {
  return `// ===== src/candidate.ts =====\n${src}`
}

async function main() {
  let pass = 0
  for (const c of CASES) {
    const findings = await runLocalHardenFuzz(wrap(c.src))
    const got = findings.length > 0
    const ok = got === c.expectFinding
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (expected ${c.expectFinding ? 'finding' : 'clean'}, got ${got ? 'finding' : 'clean'})`)
    if (!ok || got) for (const f of findings) console.log(`    ${f.message}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
