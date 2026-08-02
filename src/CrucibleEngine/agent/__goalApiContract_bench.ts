// ============================================================================
// Committed bench for goalApiContractBlock (synthDriver.ts) — the live-path arming of Gate A3.
//
// Found 2026-08-02 by dogfooding: Gate A3 (`synth/contractGate.ts`) fired only on specs
// carrying an "Exact public API (<path>):" block, and the only emitter of that literal was
// coding-benchmarks.ts. Production requests were therefore gated LESS strictly than the
// benchmark corpus. The fix emits a contract from synthDriver instead of loosening the gate's
// parser — so what this bench must prove is a ROUND TRIP: whatever the emitter writes, the
// gate's own declaredSignatures() must parse back identically, and a correct candidate must
// still certify. A contract the gate mis-parses is worse than no contract at all: it makes a
// CORRECT candidate un-certifiable.
//
// Same zero-false-positive discipline as __contractGate_bench.ts: every "should not emit" case
// is a case where guessing would block correct work.
// Run: npx tsx src/CrucibleEngine/agent/__goalApiContract_bench.ts
// ============================================================================
import { goalApiContractBlock } from './synthDriver'
import { checkContract } from '../synth/contractGate'

interface Case {
  name: string
  goal: string
  targetPath: string
  /** null = expect no contract emitted. Otherwise the candidate file that must certify. */
  candidate: string | null
  /** A candidate that must be REJECTED by the emitted contract (proves the gate has teeth). */
  violator?: string
}

const CASES: Case[] = [
  {
    name: 'goal declares export function — contract emitted, correct candidate certifies',
    goal: 'Write a module that exports:\nexport function slugify(input: string): string\nIt should lowercase and hyphenate.',
    targetPath: 'src/slug.ts',
    candidate: 'export function slugify(input: string): string { return input.toLowerCase() }',
    violator: 'export function slugify(input: string, sep: string): string { return input }',
  },
  {
    name: 'arrow-style goal declaration — re-emitted as function form, arrow candidate still certifies',
    goal: 'export const parseRow = (line: string, sep: string): string[] => ...',
    targetPath: 'src/csv.ts',
    candidate: 'export const parseRow = (line: string, sep: string): string[] => line.split(sep)',
    violator: 'export const parseRow = (line: string): string[] => [line]',
  },
  {
    name: 'declaration style is free: function-form contract, arrow-form candidate',
    goal: 'export function total(rows: number[]): number',
    targetPath: 'src/sum.ts',
    candidate: 'export const total = (rows: number[]): number => rows.reduce((a, b) => a + b, 0)',
  },
  {
    name: 'return shape is checked: array declared, scalar returned',
    goal: 'export function pluck(rows: string[]): string[]',
    targetPath: 'src/pluck.ts',
    candidate: 'export function pluck(rows: string[]): string[] { return rows }',
    violator: 'export function pluck(rows: string[]): string { return rows[0] }',
  },
  // ── Must NOT emit ─────────────────────────────────────────────────────────
  {
    name: 'prose naming a function — no declaration syntax, no contract',
    goal: 'Add a helper called slugify that takes a string and returns a slug.',
    targetPath: 'src/slug.ts',
    candidate: null,
  },
  {
    name: 'a CALL site is not a declaration',
    goal: 'The CLI should call formatReport(rows, opts) and print the result.',
    targetPath: 'src/cli.ts',
    candidate: null,
  },
  {
    name: 'non-exported local helper is not part of the public contract',
    goal: 'function normalize(s: string): string { ... } used internally.',
    targetPath: 'src/norm.ts',
    candidate: null,
  },
  {
    name: 'annotated const — parens may belong to the type, not the params; skipped',
    goal: 'export const handler: Handler<(a: string) => void> = makeHandler()',
    targetPath: 'src/handler.ts',
    candidate: null,
  },
  {
    name: 'goal already carries a contract block for this path — no duplicate emitted',
    goal: 'Exact public API (src/math.ts):\n  export function add(a: number, b: number): number\n',
    targetPath: 'src/math.ts',
    candidate: null,
  },
]

let pass = 0
let fail = 0
const note = (ok: boolean, msg: string) => {
  if (ok) { pass++; console.log(`  PASS  ${msg}`) } else { fail++; console.log(`  FAIL  ${msg}`) }
}

for (const c of CASES) {
  console.log(`\n${c.name}`)
  const block = goalApiContractBlock(c.goal, c.targetPath)

  if (c.candidate === null) {
    note(block === '', `no contract emitted (got ${JSON.stringify(block)})`)
    continue
  }

  note(block !== '', 'contract emitted')
  if (!block) continue

  // The round trip that matters: the gate must actually RUN on what the emitter wrote.
  const good = checkContract(block, [{ path: c.targetPath, content: c.candidate }])
  note(good.ran, 'gate ran on the emitted block (declaredSignatures parsed it back)')
  note(good.ok, `correct candidate certifies${good.ok ? '' : ` — ${good.detail}`}`)

  if (c.violator) {
    const bad = checkContract(block, [{ path: c.targetPath, content: c.violator }])
    note(!bad.ok, `violating candidate rejected${bad.ok ? '' : ` — ${bad.detail}`}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
