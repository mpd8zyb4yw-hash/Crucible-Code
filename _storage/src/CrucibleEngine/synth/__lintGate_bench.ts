// ============================================================================
// Committed bench for lintGate.ts (Gate A2) — no test coverage existed anywhere in the
// repo (found 2026-07-06 during the same audit pass that added __contractGate_bench.ts).
// This gate wraps trusted ESLint rules, so the risk isn't incomplete pattern coverage (each
// rule is independently battle-tested) — it's WIRING regressions, like the flat-config
// "files: ['**/*.ts'] omitted → silently matches nothing" pitfall already hit once during
// this gate's original build (see crucible-coding-harness memory). One true-positive per
// configured rule plus a clean-code true-negative catches both a broken rule config AND a
// broken file-matcher regressing back to "reports nothing, ever" without anyone noticing.
// Run: npx tsx src/CrucibleEngine/synth/__lintGate_bench.ts
// ============================================================================
import { lintCandidates } from './lintGate'

interface Case { name: string; content: string; expectOk: boolean }

const CASES: Case[] = [
  {
    name: 'clean code — no violations',
    content: `export function add(a: number, b: number): number { return a + b }`,
    expectOk: true,
  },
  {
    name: 'for-direction: loop counter moves away from its bound (bug)',
    content: `export function f(): void { for (let i = 0; i < 10; i--) { } }`,
    expectOk: false,
  },
  {
    name: 'no-compare-neg-zero: x === -0 (bug)',
    content: `export function isZero(x: number): boolean { return x === -0 }`,
    expectOk: false,
  },
  {
    name: 'no-constant-condition: if (true) (bug)',
    content: `export function f(): number { if (true) { return 1 } return 2 }`,
    expectOk: false,
  },
  {
    name: 'no-dupe-else-if: duplicate branch condition, later unreachable (bug)',
    content: `export function f(x: number): number { if (x === 1) { return 1 } else if (x === 1) { return 2 } return 0 }`,
    expectOk: false,
  },
  {
    name: 'no-dupe-keys: object literal silently drops the first value (bug)',
    content: `export function f(): Record<string, number> { return { a: 1, a: 2 } }`,
    expectOk: false,
  },
  {
    name: 'no-duplicate-case: later case unreachable (bug)',
    content: `export function f(x: number): number { switch (x) { case 1: return 1; case 1: return 2; default: return 0 } }`,
    expectOk: false,
  },
  {
    name: 'no-self-assign: a = a, likely a mistyped variable name (bug)',
    content: `export function f(a: number): number { a = a; return a }`,
    expectOk: false,
  },
  {
    name: 'no-self-compare: a === a, likely a mistyped variable name (bug)',
    content: `export function f(a: number): boolean { return a === a }`,
    expectOk: false,
  },
  {
    name: 'no-unsafe-negation: !key in obj negates the key, not the expression (bug)',
    content: `export function f(key: string, obj: Record<string, unknown>): boolean { return !key in obj }`,
    expectOk: false,
  },
  {
    name: 'use-isnan: x === NaN is always false (bug)',
    content: `export function f(x: number): boolean { return x === NaN }`,
    expectOk: false,
  },
  {
    name: 'no-unreachable: code after return (bug)',
    content: `export function f(): number { return 1; console.log('never') }`,
    expectOk: false,
  },
]

function main() {
  let pass = 0
  for (const c of CASES) {
    const verdict = lintCandidates([{ path: 'src/candidate.ts', content: c.content }])
    const ok = verdict.ok === c.expectOk
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (expected ${c.expectOk ? 'ok' : 'rejected'}, got ${verdict.ok ? 'ok' : 'rejected'})`)
    if (!ok || !verdict.ok) console.log(`    ${verdict.detail}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
