// ═══════════════════════════════════════════════════════════════════════════════
// VERIFIER LADDER — cheapest-gate-first composition with short-circuit (DOCTRINE W7)
// ═══════════════════════════════════════════════════════════════════════════════
//
// A candidate can fail for reasons that cost wildly different amounts to detect:
//
//     parse error        ~µs   (esbuild transform throws)
//     type error         ~ms   (tsc / esbuild)
//     acceptance case     ~1 process spawn
//     property invariant  ~1 process spawn
//     fuzz counterexample ~hundreds of instrumented calls   ← expensive
//     mutation survivor   ~many candidate re-runs           ← most expensive
//
// Running them in a fixed CHEAPEST-FIRST order and STOPPING at the first hard failure means a
// candidate with a parse error never pays for a fuzz campaign, and the proposer gets the
// cheapest actionable signal first (a parse error is more localizing than "fuzz found a
// disagreement 300 inputs deep"). This is the doctrine's "maximize information per unit of
// work": spend the expensive oracle ONLY on candidates that already survived the cheap ones.
//
// This module does not re-implement any verifier — it ORDERS existing ones. Each stage returns a
// Verdict (the same contract search()/iterate() consume). No model is consulted here.
// ═══════════════════════════════════════════════════════════════════════════════

import type { Candidate, TaskSpec, Verdict } from './types'

/** One rung of the ladder. Lower `cost` runs earlier. */
export interface LadderStage<T = string> {
  name: string
  /** Relative expense — stages run in ascending cost order. parse≈0, tsc≈1, acceptance≈2, property≈3, fuzz≈5, mutation≈6. */
  cost: number
  verify: (candidate: Candidate<T>, spec: TaskSpec) => Promise<Verdict> | Verdict
  /**
   * When false, a FAILURE at this stage does not short-circuit — the ladder records it and keeps
   * going. Use for ADVISORY gates (e.g. a fuzz gate whose counterexample should be reported but
   * not block a candidate that has no trusted reference). Defaults to true (hard gate).
   */
  hard?: boolean
}

export interface LadderVerdict extends Verdict {
  /** The stage that decided the outcome (first hard failure, or the last stage on a full pass). */
  decidedBy: string
  /** Per-stage trace in execution order — name, pass, and whether it ran (skipped after short-circuit). */
  trace: { name: string; ran: boolean; pass: boolean; score: number }[]
}

/**
 * Run `candidate` through `stages` cheapest-first, short-circuiting on the first HARD failure.
 * Returns a combined Verdict: `pass` iff every hard gate passed; `score` is the minimum stage
 * score (the worst gate dominates the hill-climb signal); `signals` accumulate from every gate
 * that actually ran, so the proposer sees the cheapest actionable feedback first.
 */
export async function runLadder<T = string>(
  stages: LadderStage<T>[],
  candidate: Candidate<T>,
  spec: TaskSpec,
): Promise<LadderVerdict> {
  const ordered = [...stages].sort((a, b) => a.cost - b.cost)
  const trace: LadderVerdict['trace'] = ordered.map(s => ({ name: s.name, ran: false, pass: false, score: 0 }))
  const signals: string[] = []
  let minScore = 0
  let allPass = true
  let decidedBy = ordered.length ? ordered[ordered.length - 1].name : 'empty-ladder'

  for (let i = 0; i < ordered.length; i++) {
    const stage = ordered[i]
    let v: Verdict
    try {
      v = await stage.verify(candidate, spec)
    } catch (e: any) {
      v = { pass: false, score: -1000, signals: [`stage ${stage.name} threw: ${String(e?.message ?? e).slice(0, 160)}`] }
    }
    trace[i] = { name: stage.name, ran: true, pass: v.pass, score: v.score }
    minScore = Math.min(minScore, v.score)
    // Prefix each carried signal with the gate that produced it (cheapest first is already the order).
    for (const s of v.signals) signals.push(`[${stage.name}] ${s}`)

    const isHard = stage.hard !== false
    if (!v.pass) {
      allPass = false
      if (isHard) { decidedBy = stage.name; break }  // short-circuit: don't pay for costlier gates
    }
  }

  return { pass: allPass, score: minScore, signals, decidedBy, trace }
}

/**
 * Wrap a ladder as a plain Verifier<T> (Candidate,Spec)→Verdict for direct use in search()/iterate().
 * The LadderVerdict's extra fields (decidedBy/trace) ride along structurally — callers that only
 * read the Verdict contract ignore them, ladder-aware callers can down-cast.
 */
export function ladderVerifier<T = string>(stages: LadderStage<T>[]) {
  return (candidate: Candidate<T>, spec: TaskSpec): Promise<Verdict> => runLadder(stages, candidate, spec)
}
