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
  Attempt, Candidate, Proposer, ProposeContext, SearchResult, TaskSpec, Verdict, Verifier,
} from './types'

export interface SearchOpts<T = unknown> {
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
  /**
   * W3 CONTINUOUS BATCHING. When supplied, a round draws ALL its proposals (every beam parent ×
   * proposalsPerNode) CONCURRENTLY through this one call instead of `proposer` serially — the K
   * draws decode across llama-server KV slots in one batched loop. Semantics are otherwise
   * IDENTICAL: same budget accounting (each non-null draw = one model call), same dedup, same
   * early-exit on the first certified candidate. result[i] must align to ctxs[i] (null = an
   * empty/failed draw for that slot). Omit it and search() behaves exactly as before (serial).
   */
  batchProposer?: (ctxs: ProposeContext<T>[]) => Promise<(Candidate<T> | null)[]>
}

const DEFAULTS: Required<Omit<SearchOpts, 'signal' | 'emit' | 'batchProposer'>> = {
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
  opts: SearchOpts<T> = {},
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

  // Transient infrastructure failures (the FM daemon returning empty/timeout under load) are
  // NOT reasoning failures — they must not consume the model-call reasoning budget or trip the
  // patience budget, or a few daemon hiccups abort a search that would otherwise converge.
  // (This was the live-exhaustion cause: `initials` solves in 3 calls unloaded, but empty
  // responses under contention burned the budget before a real proposal landed.) Tracked and
  // retried separately, bounded so a genuinely-down daemon still terminates honestly.
  let nullProposals = 0
  const maxNulls = Math.max(6, o.maxModelCalls)

  // Model-FREE proposals (mechanical single-edit repairs, retrieved executable code) cost no
  // model call, so they must not draw down the model-call budget — but that budget is also the
  // outer loop's bound, so a proposer emitting free candidates forever would never hit it.
  // Patience/dedup would almost certainly stop that; this is the explicit backstop so it does
  // not depend on "almost certainly". Generous — real free proposers cede after a bounded pool.
  let freeProposals = 0
  const maxFree = Math.max(32, o.maxModelCalls * 4)

  // Round 0 has no beam to expand from — seed it from the bare spec.
  // Each subsequent round expands every beam member, threading its failure feedback.
  for (let round = 0; modelCalls < o.maxModelCalls && freeProposals < maxFree; round++) {
    if (opts.signal?.aborted) {
      return finish('aborted', 'search aborted')
    }

    // The "parents" whose feedback seeds this round's proposals. Round 0 = the empty
    // context (history-only); later rounds expand each surviving beam member.
    const parents: Array<Attempt<T> | null> = round === 0 ? [null] : beam.slice()
    const fresh: Attempt<T>[] = []

    // The context this round would build for a given parent+slot. Shared by both the serial and
    // the batch path so they propose from byte-identical inputs.
    const ctxFor = (parent: Attempt<T> | null): ProposeContext<T> => ({
      spec,
      history: parent ? [...attempts.filter(a => a !== parent), parent] : attempts.slice(),
      diversify: stagnantRounds >= 1 || (parent != null && parent.verdict.score === bestScore && round > 1),
      signal: opts.signal,
    })

    // Process ONE drawn candidate through the shared dedup → verify → record → accept pipeline.
    // Returns the certified SearchResult to short-circuit on, or null to keep going. Used by both
    // paths so the batch path can never drift from the serial path's accounting.
    const consume = async (candidate: Candidate<T>): Promise<SearchResult<T> | null> => {
      if (seen.has(candidate.fingerprint)) {
        emit({ type: 'thought', text: `duplicate proposal (stuck) — will force a different approach` })
        stagnantRounds++
        return null
      }
      seen.add(candidate.fingerprint)
      const verdict = await verifyOne(candidate)
      const attempt: Attempt<T> = { candidate, verdict }
      record(attempt)
      fresh.push(attempt)
      emit({ type: 'verify', pass: verdict.pass, score: verdict.score, signals: verdict.signals.slice(0, 4), modelCalls })
      if (verdict.pass) {
        return {
          status: 'solved', solution: candidate, best: attempt, attempts, modelCalls,
          detail: modelCalls === 0
            ? `solved in 0 model call(s) — certified from ${freeProposals} mechanical proposal(s), no model involved`
            : `solved in ${modelCalls} model call(s)`,
        }
      }
      return null
    }

    // ── W3 BATCH PATH: draw the whole round's proposals concurrently (continuous batching) ──
    if (o.batchProposer) {
      // Every slot's context for this round, capped by the remaining model-call budget (a batch
      // draw is always a model call — the batch proposer IS the model path). Never draw more than
      // the budget allows, so the batch path bounds modelCalls exactly like the serial path.
      const slotParents: Array<Attempt<T> | null> = []
      for (const parent of parents) {
        for (let k = 0; k < o.proposalsPerNode; k++) slotParents.push(parent)
      }
      const room = Math.max(0, o.maxModelCalls - modelCalls)
      const drawParents = slotParents.slice(0, room)
      // A round may be RE-DRAWN when every slot came back null AND the beam is empty — otherwise
      // a total (transient) daemon outage on round 0 would leave no parent to expand and abstain
      // prematurely, where the serial path retries the empty slot in place. Bounded by maxNulls
      // (each null still counts toward the outage cap), so a genuinely-down daemon exits honestly.
      let producedReal = false
      while (drawParents.length && !producedReal) {
        let candidates: (Candidate<T> | null)[] = []
        try { candidates = await o.batchProposer(drawParents.map(ctxFor)) }
        catch (e: any) { emit({ type: 'thought', text: `batch proposer error: ${String(e?.message ?? e)}` }) }
        for (const candidate of candidates) {
          if (opts.signal?.aborted) return finish('aborted', 'search aborted')
          if (!candidate) {
            // Empty/failed draw for this slot — an infra hiccup, not reasoning. Don't charge the
            // reasoning budget; bounded by maxNulls so a dead daemon still exits honestly.
            nullProposals++
            emit({ type: 'thought', text: `empty proposal (transient FM failure ${nullProposals}/${maxNulls}) — not counted against the reasoning budget` })
            if (nullProposals >= maxNulls) return finish('exhausted', `on-device model unavailable — ${nullProposals} empty responses (daemon overloaded or down)`)
            continue
          }
          producedReal = true
          // A batch candidate is always model-produced (the batch proposer is the FM path).
          if (candidate.modelFree) freeProposals++
          else modelCalls++
          const solved = await consume(candidate)
          if (solved) return solved
        }
        // Only retry the draw when NOTHING real landed AND there's no beam to fall back on —
        // otherwise advance the round normally (a partially-null round still made progress).
        if (!producedReal && (beam.length > 0 || fresh.length > 0)) break
      }
      // Fall through to the shared beam re-form / stagnation logic below.
      beam = [...beam, ...fresh]
        .sort((a, b) => b.verdict.score - a.verdict.score)
        .slice(0, o.beamWidth)
      if (fresh.length > 0 && fresh.every(a => a.verdict.score <= bestScore) && round > 0) stagnantRounds++
      if (stagnantRounds >= o.patience) return finish('exhausted', `no improvement for ${o.patience} rounds — abstaining honestly`)
      if (!beam.length && round > 0) return finish('abstained', 'no viable candidate — abstaining honestly')
      continue
    }

    for (const parent of parents) {
      for (let k = 0; k < o.proposalsPerNode && modelCalls < o.maxModelCalls && freeProposals < maxFree; k++) {
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
        if (!candidate) {
          // Infra failure (empty/failed FM), NOT a reasoning failure: retry this slot without
          // charging the reasoning budget or the patience budget. Bounded by maxNulls so a
          // genuinely-down daemon still exits honestly instead of spinning forever.
          nullProposals++
          emit({ type: 'thought', text: `empty proposal (transient FM failure ${nullProposals}/${maxNulls}) — retrying, not counted against the reasoning budget` })
          if (nullProposals >= maxNulls) return finish('exhausted', `on-device model unavailable — ${nullProposals} empty responses (daemon overloaded or down)`)
          k--  // retry the same slot with a fresh call
          continue
        }
        // Charge the budget ONLY for real model work (see Candidate.modelFree).
        if (candidate.modelFree) freeProposals++
        else modelCalls++

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
          return {
            status: 'solved', solution: candidate, best: attempt, attempts, modelCalls,
            detail: modelCalls === 0
              ? `solved in 0 model call(s) — certified from ${freeProposals} mechanical proposal(s), no model involved`
              : `solved in ${modelCalls} model call(s)`,
          }
        }
      }
    }

    // Re-form the beam: keep the best-scoring surviving candidates across old+new.
    beam = [...beam, ...fresh]
      .sort((a, b) => b.verdict.score - a.verdict.score)
      .slice(0, o.beamWidth)

    // Stagnation only counts when the round actually produced verified attempts that failed
    // to improve — an empty round (all retried infra failures / dedup skips) is not evidence
    // the model is stuck reasoning, so it must not trip the patience budget.
    if (fresh.length > 0 && fresh.every(a => a.verdict.score <= bestScore) && round > 0) stagnantRounds++
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
