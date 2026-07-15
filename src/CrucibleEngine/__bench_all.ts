// ═══════════════════════════════════════════════════════════════════════════════
// bench:all — one command runs every deterministic bench and enforces NO REGRESSION.
// ═══════════════════════════════════════════════════════════════════════════════
//
// The RSI doctrine is monotonic never-regress self-improvement — but until now nothing
// enforced it across SESSIONS: each session ran the benches it touched, and a regression in
// an untouched suite could ship unnoticed. This runner executes the full deterministic suite,
// parses each bench's pass/total, appends a ledger line to .bench-history.jsonl, and exits
// nonzero when any suite fails OR passes fewer checks than the previous ledger entry
// (bench counts only ever grow — a shrink is a deleted-or-broken check either way).
//
//   npm run bench:all
//
// The ledger is append-only local state (gitignored, like .crucible): the comparison is
// against THIS machine's last run, which is exactly the "did my session regress anything"
// question a handoff needs answered.
// ═══════════════════════════════════════════════════════════════════════════════

import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

interface SuiteResult { suite: string; passed: number; total: number; ok: boolean; ms: number }

const SUITES = [
  'answer:bench',
  'ground:bench',
  'memory:bench',
  'longout:bench',
  'vgr:bench',
  'fuzz:bench',
  'harden:bench',
  'stakes:bench',
  'contract:bench',
  'lintgate:bench',
  'repair:bench',
  'examplegate:bench',
  'premise:bench',
  'jwt:bench',
  'textvector:bench',
  'latency:bench',
  'util:bench',
  'refactorroutes:bench',
  'vgr:coderesearch',
  'vgr:decompose',
  'vgr:retrieval',
  'retrieval:bench',
  'localpool:bench',
  'answer:iterate',
  'fmreact:bench',
]

const LEDGER = path.join(process.cwd(), '.bench-history.jsonl')

/** Parse "92/92 passed" or "PASS — 93 passed, 0 failed" from a bench's output. */
function parseCounts(out: string): { passed: number; total: number } | null {
  const frac = /(\d+)\s*\/\s*(\d+) passed/.exec(out)
  if (frac) return { passed: +frac[1], total: +frac[2] }
  const pf = /(\d+) passed, (\d+) failed/.exec(out)
  if (pf) return { passed: +pf[1], total: +pf[1] + +pf[2] }
  const tot = /TOTAL:\s*(\d+)\s*\/\s*(\d+)/.exec(out)
  if (tot) return { passed: +tot[1], total: +tot[2] }
  return null
}

function lastLedgerEntry(): Record<string, SuiteResult> | null {
  try {
    const lines = fs.readFileSync(LEDGER, 'utf-8').trim().split('\n').filter(Boolean)
    if (!lines.length) return null
    const entry = JSON.parse(lines[lines.length - 1])
    return entry.suites ?? null
  } catch { return null }
}

const results: SuiteResult[] = []
for (const suite of SUITES) {
  const t0 = Date.now()
  let out = ''
  let ok = true
  try {
    out = execSync(`npm run -s ${suite}`, { encoding: 'utf-8', timeout: 15 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e: unknown) {
    ok = false
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`
  }
  const counts = parseCounts(out) ?? { passed: 0, total: 0 }
  const r: SuiteResult = { suite, ...counts, ok: ok && counts.passed === counts.total && counts.total > 0, ms: Date.now() - t0 }
  results.push(r)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(16)} ${r.passed}/${r.total}  (${(r.ms / 1000).toFixed(1)}s)`)
}

const prev = lastLedgerEntry()
let regressed = false
for (const r of results) {
  const p = prev?.[r.suite]
  if (p && r.passed < p.passed) {
    regressed = true
    console.log(`REGRESSION  ${r.suite}: ${r.passed} passed < previous ${p.passed}`)
  }
}

const entry = {
  at: new Date().toISOString(),
  suites: Object.fromEntries(results.map(r => [r.suite, r])),
  totalPassed: results.reduce((a, r) => a + r.passed, 0),
  totalChecks: results.reduce((a, r) => a + r.total, 0),
}
try { fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n') } catch { /* ledger is best-effort */ }

const failed = results.filter(r => !r.ok)
console.log(`\n${entry.totalPassed}/${entry.totalChecks} checks across ${results.length} suites${prev ? '' : ' (first ledger entry — baseline recorded)'}`)
if (failed.length) console.log(`FAILED suites: ${failed.map(f => f.suite).join(', ')}`)
if (regressed) console.log('Regression vs previous ledger entry — fix before handing off.')
process.exit(failed.length || regressed ? 1 : 0)
