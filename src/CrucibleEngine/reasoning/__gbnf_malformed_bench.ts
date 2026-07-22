// ═══════════════════════════════════════════════════════════════════════════════
// GBNF malformed-rate measurement (W2 item 5) — does the wired grammar actually help?
// ═══════════════════════════════════════════════════════════════════════════════
//
// W2 wired fencedCodeGrammar into the proposal path (codeProposer → fmComplete({gbnf}) →
// bonsaiComplete → llama-server `grammar`). The CLAIM is that constrained decoding makes a
// malformed-SHAPE proposal (prose around the code, missing/doubled fence, no code at all)
// unreachable — so extractCode never fails and every drawn proposal is at least VERIFIABLE.
// This measures that claim on the live head instead of asserting it.
//
// Two arms, IDENTICAL prompt and sampling, only the grammar differs:
//   OFF — no grammar (what the model does unconstrained)
//   ON  — fencedCodeGrammar('typescript') masked at the sampler
//
// Reported per arm:
//   malformed  — raw output has NO clean single fenced ```lang … ``` block (extractCode would
//                fall back to the whole prose body → a guaranteed verifier miss)
//   noParse    — the extracted code does not transpile (esbuild TS→JS) → also a guaranteed miss
//   usable     — 1 - (malformed ∪ noParse): a proposal the verifier can actually execute
// The lever raises `usable`: every non-usable draw is a wasted ~7s slot on this hardware.
//
// Run:  CRUCIBLE_ROOT=<repo> npx tsx src/CrucibleEngine/reasoning/__gbnf_malformed_bench.ts
//   GBNF_N=20   draws per arm (default 12)
// Requires a live local head (llama-server). Without one, every draw is empty and both arms
// report 100% malformed — which the output states plainly rather than faking a win.

import { fmCompleteBatch } from '../agent/fmReact'
import { fencedCodeGrammar } from '../agent/grammars'
import { extractCode } from './codeProposer'
import { transform } from 'esbuild'

const FENCE = /```(?:[a-zA-Z0-9_+-]+)?\n[\s\S]*?```/

// A realistic proposal prompt — same shape codeProposer.buildProposalPrompt emits (system pins
// "one fenced block, no prose"; user is a concrete task). The grammar's whole job is to enforce
// the shape the system prompt only ASKS for, so this is the honest head-to-head.
const SYSTEM = [
  'You are a code-generation function inside a verification loop. You are NOT trusted —',
  'your output will be EXECUTED against hidden test cases immediately. Your only job is to',
  'return a correct implementation. Output ONE ES module in a single ``` code block and',
  'nothing else — no prose, no explanation.',
  '',
  'Export a function named `solve` (use `export function solve(...)`).',
].join('\n')
const USER = '## Task\nWrite solve(nums: number[]): number that returns the sum of the squares of the even numbers in nums. Empty array returns 0.\n\nReturn the corrected full module now.'

async function isParseable(code: string): Promise<boolean> {
  if (!code.trim()) return false
  try { await transform(code, { loader: 'ts', format: 'esm', target: 'node18' }); return true }
  catch { return false }
}

interface ArmResult { arm: string; n: number; empty: number; malformed: number; noParse: number; usable: number }

async function runArm(arm: string, n: number, gbnf?: string): Promise<ArmResult> {
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }]
  const raws = await fmCompleteBatch(Array.from({ length: n }, () => msgs), { temperature: 0.8, maxTokens: 500, gbnf })
  let empty = 0, malformed = 0, noParse = 0, usable = 0
  for (const raw of raws) {
    if (!raw || !raw.trim()) { empty++; malformed++; continue }
    if (!FENCE.test(raw)) { malformed++; continue }
    const code = extractCode(raw)
    if (!await isParseable(code)) { noParse++; continue }
    usable++
  }
  return { arm, n, empty, malformed, noParse, usable }
}

async function main(): Promise<void> {
  const n = Math.max(1, Number(process.env.GBNF_N || 12))
  console.log(`# GBNF malformed-rate — ${n} draws/arm, live head, identical prompt+sampling\n`)
  const off = await runArm('OFF (no grammar)', n)
  const on = await runArm('ON  (fencedCodeGrammar)', n, fencedCodeGrammar('typescript'))
  const pct = (x: number) => `${(100 * x / n).toFixed(0)}%`
  for (const r of [off, on]) {
    console.log(`${r.arm.padEnd(26)}  malformed ${String(r.malformed).padStart(2)}/${n} (${pct(r.malformed)})  noParse ${r.noParse}/${n}  USABLE ${r.usable}/${n} (${pct(r.usable)})  [empty ${r.empty}]`)
  }
  const delta = on.usable - off.usable
  console.log(`\n# grammar Δusable: ${delta >= 0 ? '+' : ''}${delta}/${n} (${off.usable}/${n} → ${on.usable}/${n})`)
  console.log(JSON.stringify({ gbnf_malformed: true, n, off, on }))
}

main().catch(e => { console.error('gbnf bench failed:', e); process.exit(1) })
