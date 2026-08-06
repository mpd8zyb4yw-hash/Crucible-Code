// ============================================================================
// Committed bench for contractGate.ts (Gate A3) — this critic had NO test coverage of its
// own anywhere in the repo (found 2026-07-06 while auditing it for the same class of
// mirror-image blind spot __fuzz_bench.ts / __localHardenCheck_bench.ts already closed for
// their respective gates). Same zero-false-positive discipline as those benches: one pair
// per checked dimension, plus the arrow/function-expression-const false-positive this file
// exists because of.
// Run: npx tsx src/CrucibleEngine/synth/__contractGate_bench.ts
// ============================================================================
import { checkContract } from './contractGate'

interface Case {
  name: string
  spec: string
  files: Array<{ path: string; content: string }>
  expectOk: boolean
}

const SPEC = 'Exact public API (src/math.ts):\nexport function add(a: number, b: number): number\n\nRules: no side effects.'

const CASES: Case[] = [
  {
    name: 'no "Exact public API" block — fails open, ran:false, ok:true',
    spec: 'Just build a math module.',
    files: [{ path: 'src/math.ts', content: 'export function add(a: number, b: number): number { return a + b }' }],
    expectOk: true,
  },
  {
    name: 'function declaration matches contract exactly',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export function add(a: number, b: number): number { return a + b }' }],
    expectOk: true,
  },
  {
    // 2026-07-06: this was a real false positive before the fix — arrow-const exports were
    // invisible to actualSignatures(), so this correct candidate was rejected as "missing
    // export", actively hurting generation accuracy (Gate A3 exists to add confidence, not
    // punish a valid style choice).
    name: 'export const arrow-function matches contract (was a false positive)',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export const add = (a: number, b: number): number => a + b' }],
    expectOk: true,
  },
  {
    name: 'export const function-expression matches contract',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export const add = function(a: number, b: number): number { return a + b }' }],
    expectOk: true,
  },
  {
    name: 'missing export entirely (bug)',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export function subtract(a: number, b: number): number { return a - b }' }],
    expectOk: false,
  },
  {
    name: 'non-exported const of the right name does not satisfy the contract (bug)',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'const add = (a: number, b: number): number => a + b' }],
    expectOk: false,
  },
  {
    name: 'arity mismatch, function declaration (bug)',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export function add(a: number): number { return a }' }],
    expectOk: false,
  },
  {
    name: 'arity mismatch, arrow-const (bug — same check must apply to both forms)',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export const add = (a: number): number => a' }],
    expectOk: false,
  },
  {
    name: 'return-type widened to any — allowed, not a contract violation',
    spec: SPEC,
    files: [{ path: 'src/math.ts', content: 'export function add(a: number, b: number): any { return a + b }' }],
    expectOk: true,
  },
  {
    name: 'return-type array-ness mismatch (bug)',
    spec: 'Exact public API (src/list.ts):\nexport function makeList(n: number): number[]\n\nRules: none.',
    files: [{ path: 'src/list.ts', content: 'export function makeList(n: number): number { return n }' }],
    expectOk: false,
  },
]

function main() {
  let pass = 0
  for (const c of CASES) {
    const verdict = checkContract(c.spec, c.files)
    const ok = verdict.ok === c.expectOk
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (expected ${c.expectOk ? 'ok' : 'rejected'}, got ${verdict.ok ? 'ok' : 'rejected'})`)
    if (!ok || !verdict.ok) console.log(`    ${verdict.detail}`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
  if (pass !== CASES.length) process.exit(1)
}

main()
