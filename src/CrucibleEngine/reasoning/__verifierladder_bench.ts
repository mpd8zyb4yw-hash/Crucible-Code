// ═══════════════════════════════════════════════════════════════════════════════
// SELF-VERIFYING BENCH — cheapest-gate-first verifier ladder (W7)
//
// Proves: (a) stages run in ASCENDING cost order regardless of declaration order;
// (b) the first HARD failure SHORT-CIRCUITS — no costlier gate runs (so a parse error never
// pays for a fuzz campaign); (c) an ADVISORY (soft) failure does NOT short-circuit;
// (d) an all-pass candidate runs every gate and reports pass; (e) the combined score is the
// worst gate's score. Deterministic; no model.
//
//   run:  npx tsx src/CrucibleEngine/reasoning/__verifierladder_bench.ts
// ═══════════════════════════════════════════════════════════════════════════════

import { runLadder, type LadderStage } from './verifierLadder'
import type { Candidate, TaskSpec, Verdict } from './types'

const cand: Candidate<string> = { value: 'x', fingerprint: 'f' }
const spec: TaskSpec = { goal: 'g', domain: 'code', acceptance: {} as Record<string, unknown> }

const ran: string[] = []
const stage = (name: string, cost: number, pass: boolean, score = pass ? 0 : -1, hard = true): LadderStage<string> => ({
  name, cost, hard,
  verify: (): Verdict => { ran.push(name); return { pass, score, signals: [pass ? `${name} ok` : `${name} failed`] } },
})

let pass = 0
const fails: string[] = []
const check = (name: string, ok: boolean, note = '') => {
  if (ok) pass++; else fails.push(name)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `\n         ${note}` : ''}`)
}

console.log('── Verifier ladder — cheapest-first, short-circuit self-verification ──\n')

// ── 1) Ordering + short-circuit: tsc (cost 1) fails; declared out of order. ──────────────
{
  ran.length = 0
  // Declared fuzz-first to prove the ladder re-sorts by cost, not declaration order.
  const stages = [
    stage('fuzz', 5, true),
    stage('acceptance', 2, true),
    stage('parse', 0, true),
    stage('tsc', 1, false),        // the failing hard gate
    stage('mutation', 6, true),
  ]
  const v = await runLadder(stages, cand, spec)
  check('runs cheapest-first (parse before tsc)', ran[0] === 'parse' && ran[1] === 'tsc', `order=${ran.join('→')}`)
  check('short-circuits at first hard failure (tsc)', !v.pass && v.decidedBy === 'tsc')
  check('never pays for costlier gates after failure', !ran.includes('acceptance') && !ran.includes('fuzz') && !ran.includes('mutation'),
    `ran=${ran.join(',')}`)
  const traceRan = v.trace.filter(t => t.ran).map(t => t.name)
  check('trace records exactly the gates that ran', JSON.stringify(traceRan) === JSON.stringify(['parse', 'tsc']),
    `traceRan=${traceRan.join(',')}`)
}

// ── 2) Advisory (soft) failure does NOT short-circuit. ───────────────────────────────────
{
  ran.length = 0
  const stages = [
    stage('acceptance', 2, true),
    stage('fuzz-advisory', 5, false, -2, /*hard*/ false),  // soft: reports but does not block
    stage('mutation', 6, true),
  ]
  const v = await runLadder(stages, cand, spec)
  check('advisory failure keeps the ladder going', ran.includes('mutation'), `ran=${ran.join(',')}`)
  check('advisory failure still marks overall not-pass', !v.pass)
  check('combined score is the worst gate score', v.score === -2, `score=${v.score}`)
  check('signals are gate-prefixed', v.signals.every(s => /^\[[a-z-]+\]/.test(s)), v.signals[0])
}

// ── 3) All-pass candidate runs every gate and passes. ────────────────────────────────────
{
  ran.length = 0
  const stages = [stage('parse', 0, true), stage('acceptance', 2, true), stage('fuzz', 5, true)]
  const v = await runLadder(stages, cand, spec)
  check('all-pass runs every gate', ran.length === 3)
  check('all-pass reports pass, decidedBy last gate', v.pass && v.decidedBy === 'fuzz')
}

const ok = fails.length === 0
console.log(`\n  ${ok ? 'PASS' : 'FAIL'} — ${pass}/${pass + fails.length} checks passed`)
if (fails.length) console.log(`  failing: ${fails.join('; ')}`)
process.exit(ok ? 0 : 1)
