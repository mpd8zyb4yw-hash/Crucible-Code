// ═══════════════════════════════════════════════════════════════════════════════
// ITERATE bench — proves the convergence loop's termination guarantees.
// Run:  npm run vgr:iterate
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every case uses a MOCK proposer/verifier (no FM) so the loop's CONTROL FLOW is
// what is under test, deterministically, in CI. We prove the four exit conditions
// and the two properties that make "iterate indefinitely" honest rather than a hang:
//
//   1. SOLVE            — converges and certifies when the answer is reachable.
//   2. CLIMB-THEN-SOLVE — keeps going ACROSS epochs while the score improves, and
//                         solves on a later epoch it would have abstained on alone.
//   3. RESEARCH-UNLOCKS — a task unsolvable until research injects grounding; the
//                         loop stalls, researches, then solves. (The whole point.)
//   4. STALL-ABSTAIN    — no progress + research that adds nothing → honest abstain,
//                         NOT an infinite loop.
//   5. WALL-CLOCK       — a slow task is cut off by the time budget deterministically.
//   6. SOUND-ACCEPTANCE — research that tightens the VERIFIER (adds a counterexample)
//                         makes a candidate the loose spec accepted get REJECTED.
// ═══════════════════════════════════════════════════════════════════════════════

import { iterate, type ResearchFn } from './iterate'
import type { Candidate, Proposer, TaskSpec, Verifier } from './types'

let pass = 0, fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}

const cand = (n: number): Candidate<number> => ({ value: n, fingerprint: String(n) })

// A fake monotone clock so wall-clock tests are deterministic (Date.now is banned here anyway).
function fakeClock(stepMs: number) {
  let t = 0
  return () => (t += stepMs)
}

async function main() {
  console.log('\nITERATE bench — convergence-loop termination guarantees\n')

  // ── 1. SOLVE: proposer walks toward the target; verifier certifies on hit. ──────
  {
    const spec: TaskSpec = { goal: 'reach 3', domain: 'test', acceptance: { target: 3 } }
    let next = 0
    const proposer: Proposer<number> = async () => cand(next++)
    const verifier: Verifier<number> = (c, s) => {
      const t = s.acceptance.target as number
      return { pass: c.value === t, score: -Math.abs(t - c.value), signals: [`got ${c.value}`] }
    }
    const r = await iterate(spec, proposer, verifier, { now: fakeClock(1) })
    check('1 solves reachable task', r.status === 'solved' && r.solution?.value === 3, JSON.stringify(r.detail))
  }

  // ── 2. CLIMB-THEN-SOLVE: target beyond one epoch's budget; only the outer loop's ──
  //     escalation across epochs reaches it. A single search() would abstain.
  {
    const spec: TaskSpec = { goal: 'reach 20', domain: 'test', acceptance: { target: 20 } }
    let next = 0
    const proposer: Proposer<number> = async () => cand(next++)
    const verifier: Verifier<number> = (c, s) => {
      const t = s.acceptance.target as number
      return { pass: c.value === t, score: -Math.abs(t - c.value), signals: [] }
    }
    const r = await iterate(spec, proposer, verifier, {
      baseModelCalls: 4, globalModelCalls: 64, now: fakeClock(1),
    })
    check('2 climbs across epochs to solve', r.status === 'solved' && r.solution?.value === 20, JSON.stringify({ s: r.status, e: r.epochs }))
    check('2 used more than one epoch', r.epochs > 1, `epochs=${r.epochs}`)
  }

  // ── 3. RESEARCH-UNLOCKS: proposer is stuck at a plateau until research reveals the ──
  //     true target via context. Models a fact the generator simply does not know.
  {
    // The proposer can only ever emit values it "knows". Without research it knows
    // {0..5}; research reveals the secret target 9 by widening its known ceiling.
    let ceiling = 5
    let next = 0
    const proposer: Proposer<number> = async () => {
      const v = next % (ceiling + 1)
      next++
      return cand(v)
    }
    const spec: TaskSpec = { goal: 'reach the researched target', domain: 'test', acceptance: { target: 9 } }
    const verifier: Verifier<number> = (c, s) => {
      const t = s.acceptance.target as number
      return { pass: c.value === t, score: -Math.abs(t - c.value), signals: [] }
    }
    const research: ResearchFn<number> = async () => {
      if (ceiling < 9) { ceiling = 9; return { context: 'target within reach of 9', note: 'raised ceiling' } }
      return null
    }
    const r = await iterate(spec, proposer, verifier, {
      baseModelCalls: 6, research, now: fakeClock(1),
    })
    check('3 research unlocks an otherwise-unsolvable task', r.status === 'solved' && r.solution?.value === 9, JSON.stringify(r.detail))
    check('3 trace records a research injection', r.trace.some(t => t.researched), JSON.stringify(r.trace.map(t => t.researched)))
  }

  // ── 4. STALL-ABSTAIN: unreachable target, research adds nothing → honest abstain. ──
  {
    const spec: TaskSpec = { goal: 'reach 999', domain: 'test', acceptance: { target: 999 } }
    const proposer: Proposer<number> = async () => cand(1) // always the same wrong, low score
    const verifier: Verifier<number> = (c, s) => ({ pass: false, score: -Math.abs((s.acceptance.target as number) - c.value), signals: [] })
    const research: ResearchFn<number> = async () => null // research finds nothing
    let epochsRun = 0
    const r = await iterate(spec, proposer, verifier, {
      stallLimit: 2, research, maxEpochs: 50, now: fakeClock(1),
      emit: e => { if ((e as any).type === 'thought' && String((e as any).text).startsWith('epoch')) epochsRun++ },
    })
    check('4 abstains honestly on unsolvable task', r.status === 'stalled', JSON.stringify(r.status))
    check('4 does NOT loop forever (well under epoch cap)', epochsRun <= 4, `epochsRun=${epochsRun}`)
    check('4 reports best score reached', Number.isFinite(r.bestScore), `bestScore=${r.bestScore}`)
  }

  // ── 5. WALL-CLOCK: each epoch "costs" time; the reality budget cuts it off. ─────
  {
    const spec: TaskSpec = { goal: 'reach 999', domain: 'test', acceptance: { target: 999 } }
    // proposer keeps improving slightly so the loop never stalls — only time stops it.
    let next = 0
    const proposer: Proposer<number> = async () => cand(next++)
    const verifier: Verifier<number> = (c, s) => ({ pass: false, score: -Math.abs((s.acceptance.target as number) - c.value), signals: [] })
    const r = await iterate(spec, proposer, verifier, {
      wallClockMs: 25, maxEpochs: 1000, now: fakeClock(10), // ~2-3 epochs then budget
    })
    check('5 wall-clock budget terminates the loop', r.status === 'budget', JSON.stringify(r.detail))
  }

  // ── 6. SOUND-ACCEPTANCE: research both UNLOCKS the range (proposer can't reach it ──
  //     alone → forces a stall) and TIGHTENS the verifier with a parity constraint,
  //     so the odd candidate the loose spec WOULD accept is rejected in favour of an
  //     even one. This exercises acceptance-merge affecting the final verdict — which
  //     is architecturally only reachable AFTER a stall (a loose spec that solves at
  //     epoch 0 exits before research ever runs; that is by design, not a gap).
  {
    const verifier: Verifier<number> = (c, s) => {
      const min = s.acceptance.min as number
      const even = s.acceptance.mustBeEven as boolean
      const okMin = c.value >= min
      const okEven = !even || c.value % 2 === 0
      // partial credit: in-range but wrong-parity scores above out-of-range.
      const score = okMin ? (okEven ? 0 : -1) : -(min - c.value)
      return { pass: okMin && okEven, score, signals: [] }
    }
    // Proposer known-set starts at {0..5}: cannot reach min=10 → epoch 0 stalls.
    // Deterministically walks its known range so the outcome is fixed.
    let ceiling = 5, next = 0
    const proposer: Proposer<number> = async () => cand(next++ % (ceiling + 1))
    // Loose control: parity OFF, and reachable — an odd value in range is accepted.
    const looseSpec: TaskSpec = { goal: 'x ≥ 4', domain: 'test', acceptance: { min: 4, mustBeEven: false } }
    let ln = 5
    const loose = await iterate(looseSpec, async () => cand(ln--), verifier, { maxEpochs: 1, now: fakeClock(1) })
    check('6 loose spec accepts an odd in-range candidate', loose.status === 'solved' && (loose.solution?.value as number) % 2 === 1, JSON.stringify({ s: loose.status, v: loose.solution?.value }))

    const spec: TaskSpec = { goal: 'even ≥ 10', domain: 'test', acceptance: { min: 10, mustBeEven: false } }
    const research: ResearchFn<number> = async ({ spec: s }) => {
      const out: any = {}
      if (ceiling < 12) { ceiling = 12; out.context = 'values up to 12 are reachable' }
      if (!(s.acceptance.mustBeEven as boolean)) out.acceptance = { mustBeEven: true }
      out.note = 'unlock range + counterexample: odd fails parity'
      return (out.context || out.acceptance) ? out : null
    }
    const tight = await iterate(spec, proposer, verifier, { research, baseModelCalls: 6, now: fakeClock(1) })
    check('6 research unlocks range AND tightens parity → ships even ≥10',
      tight.status === 'solved' && (tight.solution?.value as number) >= 10 && (tight.solution?.value as number) % 2 === 0,
      JSON.stringify({ s: tight.status, v: tight.solution?.value }))
    check('6 tightened verifier is in the working spec', tight.trace.some(t => t.researched), JSON.stringify(tight.trace.map(t => t.researched)))
  }

  console.log(`\n${pass}/${pass + fail} checks passed\n`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
