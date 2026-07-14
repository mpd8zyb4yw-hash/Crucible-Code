// ═══════════════════════════════════════════════════════════════════════════════
// AFM vs MiniCPM head-to-head — same fault suite, same prompts, two proposers.
// Run:  npm run fault:h2h        (FM daemon on :11435; MiniCPM GGUF must be downloaded)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Decides the "dual-engine" question with data instead of a bet: both engines get
// buildProposalPrompt's IDENTICAL prompting and the identical deterministic verifier;
// the only variable is the model. Policy (agreed 2026-07-14): MiniCPM earns a
// dedicated code-repair role ONLY if it beats AFM here; otherwise AFM stays the
// single brain and MiniCPM stays out of the hot path.
//
// Engines run SEQUENTIALLY (AFM sweep, then MiniCPM sweep) — never both resident
// mid-trial. MiniCPM loads once per sweep; on 8 GB that is the whole point.
// ═══════════════════════════════════════════════════════════════════════════════

import { isMiniCpmAvailable, stripReasoning, warmMiniCpm } from '../agent/miniCpmHarness'
import { completeLocalModel } from '../agent/localModelPool'
import { buildProposalPrompt, extractCode, fingerprintCode } from './codeProposer'
import { runFaultSuite, type FaultReport, type FaultTarget } from './faultInject'
import type { Proposer } from './types'

// Same targets as fault:live — the baseline number stays comparable.
const TARGETS: FaultTarget[] = [
  {
    id: 'sumRange',
    code: `export function sumRange(a, b) {\n  if (a > b) return -1;\n  let total = 0;\n  for (let i = a; i <= b; i++) total = total + i;\n  return total;\n}\n`,
    entry: 'sumRange',
    cases: [
      { args: [1, 4], expected: 10 }, { args: [3, 3], expected: 3 },
      { args: [5, 2], expected: -1 }, { args: [0, 0], expected: 0 },
    ],
  },
  {
    id: 'clampIndex',
    code: `export function clampIndex(i, len) {\n  if (len < 1) return -1;\n  if (i < 0) return 0;\n  if (i >= len) return len - 1;\n  return i;\n}\n`,
    entry: 'clampIndex',
    cases: [
      { args: [5, 10], expected: 5 }, { args: [-2, 10], expected: 0 },
      { args: [10, 10], expected: 9 }, { args: [0, 0], expected: -1 },
      { args: [0, 1], expected: 0 }, { args: [0, 3], expected: 0 },
    ],
  },
  {
    id: 'countPositive',
    code: `export function countPositive(xs) {\n  let n = 0;\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > 0) n = n + 1;\n  }\n  return n;\n}\n`,
    entry: 'countPositive',
    cases: [
      { args: [[1, -2, 3, 0]], expected: 2 }, { args: [[]], expected: 0 },
      { args: [[-1, -1]], expected: 0 }, { args: [[0]], expected: 0 },
    ],
  },
  {
    id: 'titleCase',
    code: `export function titleCase(s) {\n  if (s.length < 1) return '';\n  const words = s.split(' ');\n  const out = [];\n  for (let i = 0; i < words.length; i++) {\n    const w = words[i];\n    if (w.length > 0) out.push(w[0].toUpperCase() + w.slice(1).toLowerCase());\n  }\n  return out.join(' ');\n}\n`,
    entry: 'titleCase',
    cases: [
      { args: ['hello world'], expected: 'Hello World' },
      { args: ['a'], expected: 'A' },
      { args: [''], expected: '' },
      { args: ['MIXED case'], expected: 'Mixed Case' },
    ],
  },
  {
    id: 'runningMax',
    code: `export function runningMax(xs) {\n  const out = [];\n  let best = -Infinity;\n  for (let i = 0; i < xs.length; i++) {\n    if (xs[i] > best) best = xs[i];\n    out.push(best);\n  }\n  return out;\n}\n`,
    entry: 'runningMax',
    cases: [
      { args: [[1, 3, 2, 5]], expected: [1, 3, 3, 5] },
      { args: [[]], expected: [] },
      { args: [[-2, -5]], expected: [-2, -2] },
    ],
  },
]

/** MiniCPM as a VGR proposer: identical prompt via the raw pool completer (the prose-tuned
 *  miniCpmAnswer wrapper injects "answer in 2-5 sentences", which sabotages code output);
 *  stripReasoning removes its stochastic thinking preamble before code extraction. */
const miniCpmProposer: Proposer<string> = async ctx => {
  const { system, user } = buildProposalPrompt(ctx)
  let raw = ''
  try { raw = await completeLocalModel('minicpm5-1b', system, user, { maxTokens: 900, timeoutMs: 45_000 }) } catch { return null }
  if (!raw || !raw.trim()) return null
  const code = extractCode(stripReasoning(raw))
  if (!code) return null
  return { value: code, fingerprint: fingerprintCode(code) }
}

function summarize(label: string, r: FaultReport, secs: number) {
  console.log(`  ${label.padEnd(8)} recovery ${(r.recoveryRate * 100).toFixed(0).padStart(3)}% (${r.recovered}/${r.detected})  calls ${String(r.totalModelCalls).padStart(3)}  wall ${secs.toFixed(0)}s`)
}

async function main() {
  console.log('\nFAULT head-to-head — AFM vs MiniCPM as the repair proposer\n')

  const t0 = Date.now()
  const afm = await runFaultSuite(TARGETS, { maxModelCalls: 6 })
  const afmSecs = (Date.now() - t0) / 1000
  summarize('AFM', afm, afmSecs)

  if (!(await isMiniCpmAvailable())) {
    console.log('  MiniCPM  not installed on this machine — head-to-head incomplete.\n')
    return
  }
  await warmMiniCpm()
  const t1 = Date.now()
  const cpm = await runFaultSuite(TARGETS, { maxModelCalls: 6, proposer: miniCpmProposer })
  const cpmSecs = (Date.now() - t1) / 1000
  summarize('MiniCPM', cpm, cpmSecs)

  console.log('')
  const diff = cpm.recoveryRate - afm.recoveryRate
  if (diff > 0.1) console.log(`  VERDICT: MiniCPM wins by ${(diff * 100).toFixed(0)} pts — a dedicated code-repair role is justified; wire it in.`)
  else if (diff < -0.1) console.log(`  VERDICT: AFM wins by ${(-diff * 100).toFixed(0)} pts — MiniCPM stays OUT of the hot path; AFM remains the single brain.`)
  else console.log('  VERDICT: within 10 pts — no role split justified; prefer AFM (simpler, no GGUF residency).')
  console.log('')
}

main().catch(e => { console.error(e); process.exit(1) })
