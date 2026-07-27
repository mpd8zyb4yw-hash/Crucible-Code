#!/usr/bin/env node
// ============================================================================
// Classify `.crucible/fm-rounds.jsonl` verdicts by ORACLE EXIT REASON and by TARGET FILE.
//
// WHY THIS EXISTS ALONGSIDE aggregate-phase-profiles.mjs (cont.117). They answer different
// halves of the same question and neither subsumes the other:
//
//   aggregate-phase-profiles.mjs  — reads the `verify.exit.*` lanes. COMPLETE (every oracle
//                                   call is tagged) but per-TASK: a phase-profile lane cannot
//                                   say which FILE the verification was for.
//   this script                   — reads the FM round ledger. PARTIAL (only the universal.ts
//                                   FM loops log rounds; catalog/bridge/fastPath calls do not)
//                                   but carries `modulePath` and `gate`, so it can say WHICH
//                                   ARTIFACT the budget went to.
//
// The second view is what surfaced the cont.117 headline: half of one suite's FM rounds were
// spent on `src/index.ts`, the self-test file the audit scores SOFT/`n/a` — i.e. on an artifact
// that cannot move the benchmark number. A per-task profile lane could never have shown that.
//
// Treat the two as independent measurements of the same run. Where they disagree on the exit
// MIX, the profile wins on coverage and this wins on attribution — and the disagreement itself
// is the interesting signal (it localises which callers are doing the uncounted verifying).
//
// Usage:  node scripts/fm-round-exits.mjs [--since 2026-07-26T20:22] [--ledger PATH]
// ============================================================================
import fs from 'fs'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt }
const since = arg('--since', '')
const ledger = arg('--ledger', '.crucible/fm-rounds.jsonl')

if (!fs.existsSync(ledger)) { console.error(`no ledger at ${ledger}`); process.exit(2) }

/**
 * Map an oracle `detail` string back to the exit that produced it.
 *
 * These prefixes are the CONTRACT with oracle.ts / lintGate.ts / dupSymbolGate.ts /
 * contractGate.ts. If a gate's detail wording changes, this silently reclassifies to
 * 'executed' — which is why 'executed' is the fallthrough and why the counts below are
 * cross-checked against the `verify.exit.*` lanes rather than trusted alone.
 */
function classify(v) {
  if (typeof v !== 'string') return 'no-verdict'
  if (v.startsWith('typecheck: ')) return 'typecheck'
  if (v.startsWith('lint (')) return 'lint'
  if (v.startsWith('duplicate exported symbol')) return 'dupexport'
  if (v.startsWith('contract: ')) return 'contract'
  if (v.startsWith('compiles, but no behavioral test')) return 'no-test'
  if (v.startsWith('oracle error')) return 'error'
  if (v.startsWith('no files')) return 'nofiles'
  return 'executed'
}

const rows = []
for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
  if (!line.trim()) continue
  try {
    const d = JSON.parse(line)
    if (since && d.ts < since) continue
    if (!('verdict' in d)) continue          // tripwire rows carry no oracle verdict
    rows.push(d)
  } catch { /* a torn final line during a live run is expected */ }
}

if (!rows.length) { console.error(`no verdict-carrying rows${since ? ` at/after ${since}` : ''} in ${ledger}`); process.exit(2) }

const ORDER = ['typecheck', 'lint', 'dupexport', 'contract', 'no-test', 'exec', 'executed', 'error', 'nofiles']
const rank = r => { const i = ORDER.indexOf(r); return i < 0 ? ORDER.length : i }
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

const byReason = new Map(), byFile = new Map(), byGate = new Map()
for (const d of rows) {
  const r = classify(d.verdict)
  bump(byReason, r)
  const f = d.modulePath ?? '(unknown)'
  if (!byFile.has(f)) byFile.set(f, { n: 0, reasons: new Map(), gates: new Map() })
  const fe = byFile.get(f); fe.n++; bump(fe.reasons, r); bump(fe.gates, d.gate ?? '?')
  if (!byGate.has(d.gate ?? '?')) byGate.set(d.gate ?? '?', new Map())
  bump(byGate.get(d.gate ?? '?'), r)
}
const total = rows.length
const pct = n => `${((n / total) * 100).toFixed(1)}%`

console.log(`\n[FM-ROUND EXITS] ${ledger}${since ? ` since ${since}` : ''} — ${total} verdict-carrying rounds`)
console.log(`  NOTE: PARTIAL COVERAGE. Only universal.ts's FM loops log rounds; catalog, L2 bridge and`)
console.log(`  fastPath verifications do not. Cross-check the mix against verify.exit.* before quoting it.\n`)

console.log('── exit reason')
for (const [r, n] of [...byReason].sort((a, b) => rank(a[0]) - rank(b[0]))) {
  console.log(`   ${r.padEnd(11)} ${String(n).padStart(4)}  ${pct(n).padStart(6)}  ${'█'.repeat(Math.round((n / total) * 40))}`)
}

console.log('\n── where the rounds went (the budget question)')
console.log(`   ${'file'.padEnd(22)} ${'rounds'.padStart(6)}  ${'share'.padStart(6)}  exit mix`)
for (const [f, e] of [...byFile].sort((a, b) => b[1].n - a[1].n)) {
  const mix = [...e.reasons].sort((a, b) => rank(a[0]) - rank(b[0])).map(([r, n]) => `${r}=${n}`).join(' ')
  console.log(`   ${f.padEnd(22)} ${String(e.n).padStart(6)}  ${pct(e.n).padStart(6)}  ${mix}`)
}

console.log('\n── by oracle gate (which verifier was actually in force)')
for (const [g, m] of [...byGate].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0))) {
  const n = [...m.values()].reduce((x, y) => x + y, 0)
  const mix = [...m].sort((a, b) => rank(a[0]) - rank(b[0])).map(([r, c]) => `${r}=${c}`).join(' ')
  console.log(`   ${g.padEnd(38)} n=${String(n).padStart(4)}  ${mix}`)
}
console.log('')
