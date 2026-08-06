#!/usr/bin/env node
// ============================================================================
// Aggregate `[PHASE_PROFILE]` blocks out of a server log into one table.
//
// WHY THIS EXISTS (cont.117): `debug/phaseProfile.ts` prints ONE report per task, to the
// server's stderr. Reading "which oracle gate ends most verifications" off 14 separate
// blocks by eye is exactly how a plausible-but-wrong number gets recorded — cont.116 nearly
// wrote down "the 30 unexecuted candidates were typecheck failures" without checking. This
// does the summing mechanically and REFUSES to print a distribution it cannot reconcile.
//
// THE INVARIANT. Every post-stage return in both oracle twins is tagged, so:
//     sum(verify.exit.*)      === oracle.stage.calls          (async twin)
//     sum(verify.sync.exit.*) === oracle.stage.sync.calls     (sync twin)
// A mismatch means a return path is untagged and the split is under-counting. That is
// reported as a hard FAIL line, not a footnote — an unreconciled distribution is not data.
//
// Usage:  node scripts/aggregate-phase-profiles.mjs [logfile] [--per-task]
// Default logfile: /tmp/crucible-server.log
// ============================================================================
import fs from 'fs'

const args = process.argv.slice(2)
const perTask = args.includes('--per-task')
const logPath = args.find(a => !a.startsWith('--')) ?? '/tmp/crucible-server.log'

if (!fs.existsSync(logPath)) {
  console.error(`no such log: ${logPath}`)
  process.exit(2)
}

// `  lane                  self=  121.7s  54.8%  calls= 17  avg=   7.2s  max=  35.1s`
// The lane column is padEnd(26) but longer names overflow it, so match on the `self=` anchor
// rather than a fixed width. `(unattributed)` and the concurrency NOTE carry no `calls=` and
// therefore never match — which is what we want, they are not lanes.
const LANE_RE = /^\s{2}(\S+)\s+self=\s*([\d.]+)s\s+[\d.]+%\s+calls=\s*(\d+)\s+avg=\s*([\d.]+)s\s+max=\s*([\d.]+)s\s*$/
// Anchor on the tail so a task string containing " wall=" cannot truncate the name.
const HEAD_RE = /^\[PHASE_PROFILE\] task=(.*) wall=([\d.]+)s attributed=([\d.]+)s concurrency=([\d.]+)x$/

const tasks = []
let cur = null
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  const h = HEAD_RE.exec(line)
  if (h) {
    cur = { task: h[1], wallS: +h[2], lanes: new Map() }
    tasks.push(cur)
    continue
  }
  if (!cur) continue
  const m = LANE_RE.exec(line)
  if (!m) continue
  const [, lane, self, calls, , max] = m
  const prev = cur.lanes.get(lane) ?? { selfS: 0, calls: 0, maxS: 0 }
  cur.lanes.set(lane, { selfS: prev.selfS + +self, calls: prev.calls + +calls, maxS: Math.max(prev.maxS, +max) })
}

if (!tasks.length) {
  console.error(`no [PHASE_PROFILE] blocks in ${logPath} — was the server started with CRUCIBLE_PHASE_PROFILE=1?`)
  process.exit(2)
}

const callsOf = (t, lane) => t.lanes.get(lane)?.calls ?? 0
/** Exit lanes for one twin, keyed by bare reason. `prefix` must not also match the other twin. */
function exitsOf(t, prefix) {
  const out = new Map()
  for (const [lane, v] of t.lanes) {
    if (!lane.startsWith(prefix + '.')) continue
    const reason = lane.slice(prefix.length + 1)
    out.set(reason, (out.get(reason) ?? 0) + v.calls)
  }
  return out
}
// `verify.exit` is a prefix of nothing else, but `verify.sync.exit` shares no prefix with it
// either — startsWith('verify.exit.') cannot swallow 'verify.sync.exit.*'. Guarded by the dot.

const TWINS = [
  // Labels name the POPULATION, not a provenance. The async lane is not "the gen path": it is
  // every caller that did not ask for the sync twin — FM candidates, their repair proposals, L2
  // structuralSynthBridge probes, and the server's synth.fastPath cascade. That is exactly the
  // set `oracle.stage` has always counted, which is what makes it comparable to cont.116's
  // "34 verifications, 4 executed". See oracle.ts's tagExit docblock.
  { label: 'ASYNC  (verifyCandidateAsync — the oracle.stage population: FM candidates + repairs + L2 probes + fastPath)', prefix: 'verify.exit', skip: 'verify.skip', stage: 'oracle.stage' },
  { label: 'SYNC   (verifyCandidate — only callers passing verify:\'sync\', i.e. synth.catalogL0L1)', prefix: 'verify.sync.exit', skip: 'verify.sync.skip', stage: 'oracle.stage.sync' },
]
// Print order is the gate order in oracle.ts, so the table reads as the funnel it is.
const ORDER = ['typecheck', 'lint', 'dupexport', 'contract', 'no-test', 'exec-pass', 'exec-fail', 'error']
const rank = r => { const i = ORDER.indexOf(r); return i < 0 ? ORDER.length : i }

let bad = 0
console.log(`\n[PHASE_PROFILE AGGREGATE] ${logPath} — ${tasks.length} task profile(s)\n`)

for (const twin of TWINS) {
  const total = new Map()
  let stageCalls = 0, skipCalls = 0
  for (const t of tasks) {
    stageCalls += callsOf(t, twin.stage)
    for (const [, v] of [...t.lanes].filter(([l]) => l.startsWith(twin.skip + '.'))) skipCalls += v.calls
    for (const [reason, n] of exitsOf(t, twin.prefix)) total.set(reason, (total.get(reason) ?? 0) + n)
  }
  const sum = [...total.values()].reduce((a, b) => a + b, 0)
  if (!sum && !stageCalls) continue

  console.log(`── ${twin.label}`)
  const rows = [...total.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
  for (const [reason, n] of rows) {
    const pct = sum ? ((n / sum) * 100).toFixed(1) : '0.0'
    console.log(`   ${reason.padEnd(12)} ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${'█'.repeat(Math.round((n / Math.max(1, sum)) * 40))}`)
  }
  const executed = (total.get('exec-pass') ?? 0) + (total.get('exec-fail') ?? 0)
  console.log(`   ${'TOTAL'.padEnd(12)} ${String(sum).padStart(5)}         executed=${executed} (${sum ? ((executed / sum) * 100).toFixed(1) : '0.0'}% of judged candidates ran a line)`)
  if (skipCalls) console.log(`   (+${skipCalls} pre-stage 'no files' calls — proposer emitted nothing; excluded from the invariant)`)
  if (sum === stageCalls) {
    console.log(`   INVARIANT OK: sum(${twin.prefix}.*)=${sum} === ${twin.stage}.calls=${stageCalls}\n`)
  } else {
    bad++
    console.log(`   INVARIANT FAIL: sum(${twin.prefix}.*)=${sum} !== ${twin.stage}.calls=${stageCalls} — a return path is UNTAGGED; distribution is under-counting. Do not report it.\n`)
  }
}

if (perTask) {
  console.log('── per task')
  for (const t of tasks) {
    const a = exitsOf(t, 'verify.exit')
    const parts = [...a.entries()].sort((x, y) => rank(x[0]) - rank(y[0])).map(([r, n]) => `${r}=${n}`)
    console.log(`   ${t.wallS.toFixed(0).padStart(5)}s  ${t.task.slice(0, 46).padEnd(46)}  ${parts.join(' ') || '(no async verifications)'}`)
  }
  console.log('')
}

process.exit(bad ? 1 : 0)
