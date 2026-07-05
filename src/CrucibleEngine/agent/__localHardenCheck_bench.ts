// ============================================================================
// Committed bench for localHardenCheck.ts — the deterministic zero-inference AST-walk
// substitute for runHardenReview (see localHardenCheck.ts header). Priority-ladder item 1
// (2026-07-04 ladder, ROADMAP.md) was closed for the fuzz/property layer by __fuzz_bench.ts;
// this file closes the same gap for the five syntactic CHECKS in localHardenCheck.ts, which
// had no committed true-positive/true-negative coverage of its own. One pair per check —
// zero-false-positive discipline matches __fuzz_bench.ts / lintGate.ts / contractGate.ts.
// Run: npx tsx src/CrucibleEngine/agent/__localHardenCheck_bench.ts
// ============================================================================
import { runLocalHardenCheck } from './localHardenCheck'

interface Case { name: string; src: string; expectSolid: boolean }

const CASES: Case[] = [
  // ── off-by-one terminal access: arr[arr.length] ────────────────────────
  {
    name: 'terminal-access: correct last-element read',
    src: `export function last(arr: number[]): number { return arr[arr.length - 1] }`,
    expectSolid: true,
  },
  {
    name: 'terminal-access: arr[arr.length] is always out of bounds (bug)',
    src: `export function last(arr: number[]): number { return arr[arr.length] }`,
    expectSolid: false,
  },
  {
    // 2026-07-06: reversed addition operand order (`k + arr.length` instead of
    // `arr.length + k`) was silently missed — same bug, operands swapped.
    name: 'terminal-access: arr[1 + arr.length] — reversed operand order (bug)',
    src: `export function bad(arr: number[]): number { return arr[1 + arr.length] }`,
    expectSolid: false,
  },
  // ── off-by-one loop bound: for (i = 0; i <= arr.length; i++) ───────────
  {
    name: 'loop-bound: correct strict-less-than loop',
    src: `export function sumAll(arr: number[]): number { let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i] } return s }`,
    expectSolid: true,
  },
  {
    name: 'loop-bound: <= reads one past the end (bug)',
    src: `export function sumAll(arr: number[]): number { let s = 0; for (let i = 0; i <= arr.length; i++) { s += arr[i] } return s }`,
    expectSolid: false,
  },
  {
    // 2026-07-06: reversed comparison order (`arr.length >= i` instead of `i <= arr.length`)
    // is logically identical but was silently missed by the original left-side-only match.
    name: 'loop-bound: arr.length >= i — reversed comparison order (bug)',
    src: `export function sumAll(arr: number[]): number { let s = 0; for (let i = 0; arr.length >= i; i++) { s += arr[i] } return s }`,
    expectSolid: false,
  },
  // ── divide/modulo by literal 0 ──────────────────────────────────────────
  {
    name: 'divide-by-zero: divides by a variable (fine)',
    src: `export function average(total: number, count: number): number { return total / count }`,
    expectSolid: true,
  },
  {
    name: 'divide-by-zero: divides by literal 0 (bug)',
    src: `export function average(total: number): number { return total / 0 }`,
    expectSolid: false,
  },
  {
    // 2026-07-06: the compound-assignment form (`x /= 0`) is the same bug but was missed —
    // the original only matched the plain binary-expression `/` operator.
    name: 'divide-by-zero: compound x /= 0 (bug)',
    src: `export function normalize(x: number): number { x /= 0; return x }`,
    expectSolid: false,
  },
  // ── assignment in condition: if (x = y) ─────────────────────────────────
  {
    name: 'assignment-in-condition: correct equality check',
    src: `export function isReady(state: number): boolean { if (state === 1) { return true } return false }`,
    expectSolid: true,
  },
  {
    name: 'assignment-in-condition: bare assignment where comparison meant (bug)',
    src: `export function isReady(state: number): boolean { if (state = 1) { return true } return false }`,
    expectSolid: false,
  },
  {
    // 2026-07-06: the check originally only visited if/while/do-while, never a for-loop's
    // own condition slot — same always-truthy-assignment typo class, different statement.
    name: 'assignment-in-condition: for-loop condition assignment (bug)',
    src: `export function f(): number { let i: number = 0; for (i = 0; i = 1; i++) { } return i }`,
    expectSolid: false,
  },
  {
    name: 'assignment-in-condition: while resumed-value idiom stays unflagged (no false positive)',
    src: `export function readAll(next: () => string | null): string[] { const out: string[] = []; let x: string | null; while ((x = next()) != null) { out.push(x) } return out }`,
    expectSolid: true,
  },
  // ── NaN comparison: x === NaN ────────────────────────────────────────────
  {
    name: 'nan-comparison: correct Number.isNaN check',
    src: `export function isMissing(x: number): boolean { return Number.isNaN(x) }`,
    expectSolid: true,
  },
  {
    name: 'nan-comparison: x === NaN is always false (bug)',
    src: `export function isMissing(x: number): boolean { return x === NaN }`,
    expectSolid: false,
  },
  {
    // 2026-07-06: same bug spelled via Number.NaN instead of the bare NaN identifier — the
    // original pattern only recognized the bare identifier form.
    name: 'nan-comparison: x === Number.NaN is always false (bug)',
    src: `export function isMissing(x: number): boolean { return x === Number.NaN }`,
    expectSolid: false,
  },
]

function wrap(src: string): string {
  return `// ===== src/candidate.ts =====\n${src}`
}

function main() {
  let pass = 0
  for (const c of CASES) {
    const verdict = runLocalHardenCheck(wrap(c.src))
    const ok = verdict.solid === c.expectSolid
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (expected ${c.expectSolid ? 'solid' : 'finding'}, got ${verdict.solid ? 'solid' : 'finding'})`)
    if (!ok || !verdict.solid) console.log(`    ${verdict.findings}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
