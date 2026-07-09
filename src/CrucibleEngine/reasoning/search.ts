// ═══════════════════════════════════════════════════════════════════════════════
// VGR — the propose → verify → backtrack search engine
// ═══════════════════════════════════════════════════════════════════════════════
//
// This file is the reasoner. Its control flow is DETERMINISTIC — the model never
// decides routing, pruning, or termination. The model appears only inside the
// injected `proposer`. Everything that makes the system reliable lives here:
//
//   • beam search over surviving candidates (explore multiple lines at once)
//   • ground-truth verification of every candidate (the compass)
//   • rich feedback threaded into the next proposal (sample-efficiency)
//   • anti-thrash: a repeated fingerprint means the model is stuck → force diversify
//   • a hard model-call budget (the scarce resource) → honest abstain, never a hang
//   • full audit trail of every attempt
//
// It is domain-agnostic: give it a TaskSpec, a Proposer, and a Verifier and it will
// search for a certified-correct candidate for ANY domain that can state a verifier.
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  Attempt, Candidate, Proposer, SearchResult, TaskSpec, Verdict, Verifier,
} from './types'

export interface SearchOpts {
  /** How many candidate lines to keep alive between rounds. Width of exploration. */
  beamWidth?: number
  /** Hard ceiling on model calls — the scarce budget on serial-ANE hardware. */
  maxModelCalls?: number
  /** Proposals to draw per beam member each round. */
  proposalsPerNode?: number
  /** Consecutive no-improvement rounds tolerated before abstaining. */
  patience?: number
  signal?: AbortSignal
  /** Optional progress sink for SSE streaming. */
  emit?: (e: Record<string, unknown>) => void
}

const DEFAULTS: Required<Omit<SearchOpts, 'signal' | 'emit'>> = {
  beamWidth: 3,
  maxModelCalls: 12,
  proposalsPerNode: 1,
  patience: 4,
}

/**
 * Search for a certified-correct candidate. Returns 'solved' with the certified
 * candidate, or an honest 'exhausted' / 'abstained' with the best partial attempt.
 * NEVER throws for a proposer/verifier failure — a failed proposal is just a dead
 * branch; a thrown verifier is treated as a hard-fail verdict.
 */
export async function search<T>(
  spec: TaskSpec,
  proposer: Proposer<T>,
  verifier: Verifier<T>,
  opts: SearchOpts = {},
): Promise<SearchResult<T>> {
  const o = { ...DEFAULTS, ...opts }
  const emit = opts.emit ?? (() => {})
  const attempts: Attempt<T>[] = []
  const seen = new Set<string>()          // fingerprints already tried (anti-thrash)
  let beam: Attempt<T>[] = []             // surviving candidates, best-first
  let modelCalls = 0
  let bestScore = -Infinity
  let stagnantRounds = 0

  const verifyOne = async (c: Candidate<T>): Promise<Verdict> => {
    try { return await verifier(c, spec) }
    catch (e: any) {
      return { pass: false, score: -Infinity, signals: [`verifier threw: ${String(e?.message ?? e)}`] }
    }
  }

  const record = (a: Attempt<T>) => {
    attempts.push(a)
    if (a.verdict.score > bestScore) { bestScore = a.verdict.score; stagnantRounds = 0 }
  }

  // Round 0 has no beam to expand from — seed it from the bare spec.
  // Each subsequent round expands every beam member, threading its failure feedback.
  for (let round = 0; modelCalls < o.maxModelCalls; round++) {
    if (opts.signal?.aborted) {
      return finish('aborted', 'search aborted')
    }

    // The "parents" whose feedback seeds this round's proposals. Round 0 = the empty
    // context (history-only); later rounds expand each surviving beam member.
    const parents: Array<Attempt<T> | null> = round === 0 ? [null] : beam.slice()
    const fresh: Attempt<T>[] = []

    for (const parent of parents) {
      for (let k = 0; k < o.proposalsPerNode && modelCalls < o.maxModelCalls; k++) {
        // The proposer sees the parent's line PLUS all global attempts — maximal
        // information per call. `diversify` fires when we're stuck so it changes tack.
        const history = parent ? [...attempts.filter(a => a !== parent), parent] : attempts.slice()
        const diversify = stagnantRounds >= 1 || (parent != null && parent.verdict.score === bestScore && round > 1)

        let candidate: Candidate<T> | null = null
        try {
          candidate = await proposer({ spec, history, diversify, signal: opts.signal })
        } catch (e: any) {
          emit({ type: 'thought', text: `proposer error: ${String(e?.message ?? e)}` })
        }
        modelCalls++
        if (!candidate) continue

        // Anti-thrash: an identical proposal we've already verified is wasted budget.
        // Record the collision as signal (so the next diversify is stronger) and skip.
        if (seen.has(candidate.fingerprint)) {
          emit({ type: 'thought', text: `duplicate proposal (stuck) — will force a different approach` })
          stagnantRounds++
          continue
        }
        seen.add(candidate.fingerprint)

        const verdict = await verifyOne(candidate)
        const attempt: Attempt<T> = { candidate, verdict }
        record(attempt)
        fresh.push(attempt)
        emit({
          type: 'verify',
          pass: verdict.pass,
          score: verdict.score,
          signals: verdict.signals.slice(0, 4),
          modelCalls,
        })

        // Ground truth says correct → done. Correctness certified by the verifier,
        // not by the model's confidence. This is the accept condition, and the only one.
        if (verdict.pass) {
          return { status: 'solved', solution: candidate, best: attempt, attempts, modelCalls, detail: `solved in ${modelCalls} model call(s)` }
        }
      }
    }

    // Re-form the beam: keep the best-scoring surviving candidates across old+new.
    beam = [...beam, ...fresh]
      .sort((a, b) => b.verdict.score - a.verdict.score)
      .slice(0, o.beamWidth)

    if (fresh.every(a => a.verdict.score <= bestScore) && round > 0) stagnantRounds++
    if (stagnantRounds >= o.patience) {
      return finish('exhausted', `no improvement for ${o.patience} rounds — abstaining honestly`)
    }
    if (!beam.length && round > 0) {
      return finish('abstained', 'no viable candidate — abstaining honestly')
    }
  }

  return finish('exhausted', `model-call budget (${o.maxModelCalls}) exhausted`)

  function finish(status: SearchResult<T>['status'], detail: string): SearchResult<T> {
    const best = attempts.length
      ? attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a))
      : null
    return { status, solution: null, best, attempts, modelCalls, detail }
  }
}
