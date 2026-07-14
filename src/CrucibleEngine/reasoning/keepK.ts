// ═══════════════════════════════════════════════════════════════════════════════
// KEEP-K — candidate retention + verifier-scored selection across retries
// ═══════════════════════════════════════════════════════════════════════════════
//
// The live retry-until-certified loop (server.ts, bounded 3) restarts search() from
// scratch and THROWS AWAY every non-certified candidate between attempts. That is
// the right call when the only acceptable outputs are "certified" or "abstain" —
// but it wastes the ranking information the verifier already paid for, and it gives
// callers nothing when a task is ALMOST solved (e.g. 7/8 cases passing on a spec
// with one uncertifiable edge).
//
// This module is sequential MCTS-lite, sized for 8 GB: ONE inference at a time
// (never parallel rollouts — two concurrent KV footprints is the swap-death the
// hardware forbids), with deterministic selection between attempts:
//
//   attempt 1..K:  search(spec)  — full VGR, certify → done (identical to today)
//   none certified: rank EVERY distinct candidate from ALL attempts by the
//                   deterministic verifier's score, return the best WITH its score
//                   and case coverage exposed — or abstain when even the best is
//                   below the floor. Never a silent unverified ship.
//
// Pure add: 'solved' behaves exactly like the existing retry loop; the new value is
// the honest 'best-effort' tier and the cross-attempt selection.
// ═══════════════════════════════════════════════════════════════════════════════

import { solveCodeTask, type SolveCodeInput } from './solve'
import type { SearchOpts } from './search'
import type { Attempt, Proposer, SearchResult } from './types'

export interface KeepKOpts extends SearchOpts {
  /** Restart attempts (the K). Matches the live loop's CRUCIBLE_VGR_ATTEMPTS default. */
  attempts?: number
  /**
   * Floor for the best-effort tier: a best candidate scoring below this abstains
   * instead of shipping. Score is the verifier's (-#failing cases - syntax penalty),
   * so e.g. -2 means "at most 2 failing cases". Default -2.
   */
  minBestEffortScore?: number
  /** Test hook — deterministic proposer, same convention as solveCodeTask. */
  proposer?: Proposer<string>
  /** Called between attempts (progress surface for SSE). */
  onAttempt?: (n: number, result: SearchResult<string>) => void
}

export interface KeepKResult {
  /** 'solved' → certified. 'best-effort' → NOT certified; best-scoring survivor, score exposed. */
  status: 'solved' | 'best-effort' | 'abstained' | 'aborted'
  code: string | null
  /** Verifier score of the returned code (0 = all cases pass). Ground truth, not model opinion. */
  score: number | null
  /** Cases passed / total for the returned code, derived from the score when case-based. */
  coverage: { passed: number; total: number } | null
  attemptsRun: number
  modelCalls: number
  detail: string
}

/**
 * Retry-until-certified with candidate retention. Sequential by construction —
 * attempts never overlap, so peak memory equals a single search's.
 */
export async function solveWithKeptCandidates(
  input: SolveCodeInput,
  opts: KeepKOpts = {},
): Promise<KeepKResult> {
  const K = Math.max(1, opts.attempts ?? 3)
  const floor = opts.minBestEffortScore ?? -2
  const kept: Attempt<string>[] = []
  const seen = new Set<string>()
  let modelCalls = 0

  for (let n = 1; n <= K; n++) {
    if (opts.signal?.aborted) {
      return { status: 'aborted', code: null, score: null, coverage: null, attemptsRun: n - 1, modelCalls, detail: 'aborted' }
    }
    const result = await solveCodeTask(input, opts, opts.proposer)
    modelCalls += result.modelCalls
    opts.onAttempt?.(n, result)

    if (result.status === 'solved' && result.solution) {
      return {
        status: 'solved', code: result.solution.value, score: 0,
        coverage: { passed: input.cases.length, total: input.cases.length },
        attemptsRun: n, modelCalls,
        detail: `certified on attempt ${n}/${K} — ${result.detail}`,
      }
    }
    if (result.status === 'aborted') {
      break  // fall through to selection over what we have
    }
    // KEEP every distinct failing candidate — this is the information the old loop discarded.
    for (const a of result.attempts) {
      if (seen.has(a.candidate.fingerprint)) continue
      seen.add(a.candidate.fingerprint)
      kept.push(a)
    }
  }

  // Deterministic selection: the verifier already ranked everything; pick the top.
  const best = kept.length ? kept.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a)) : null
  if (!best || best.verdict.score < floor || !Number.isFinite(best.verdict.score)) {
    return {
      status: 'abstained', code: null, score: best?.verdict.score ?? null, coverage: null,
      attemptsRun: K, modelCalls,
      detail: best
        ? `no candidate certified across ${K} attempt(s); best score ${best.verdict.score} is below the best-effort floor (${floor}) — abstaining honestly`
        : `no candidate produced across ${K} attempt(s) — abstaining honestly`,
    }
  }

  const total = input.cases.length
  // Code-verifier score is -(#failing) - syntaxPenalty; a clean integer in [-total, 0]
  // maps directly to case coverage. Anything outside that range gets no coverage claim.
  const passed = Number.isInteger(best.verdict.score) && best.verdict.score >= -total
    ? total + best.verdict.score
    : null
  return {
    status: 'best-effort',
    code: best.candidate.value,
    score: best.verdict.score,
    coverage: passed != null ? { passed, total } : null,
    attemptsRun: K, modelCalls,
    detail: `NOT certified — best of ${kept.length} kept candidate(s) across ${K} attempt(s): score ${best.verdict.score}` +
      (passed != null ? ` (${passed}/${total} cases pass)` : '') +
      `; top failure signals: ${best.verdict.signals.slice(0, 2).join(' | ') || 'none'}`,
  }
}
