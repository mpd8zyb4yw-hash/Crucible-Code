// ═══════════════════════════════════════════════════════════════════════════════
// FAITHFUL REPAIR — VGR search over answer candidates, certified by the API verifier
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS (cont.83 measured, cont.84 fix). The faithfulness gate DETECTS the
// fabrication and then fails to recover it: one retry with a hint, accept-if-certified,
// else ship UNVERIFIED. Live, that retry never certified — the FM answered a second time
// from the same distribution and simply fabricated something ELSE.
//
// "One retry with a hint" is not the VGR answer. DOCTRINE.md is explicit: correctness comes
// from the LOOP — propose K candidates, keep any the verifier certifies, and feed every
// rejection back so the next proposal is better informed than the last. That is `search()`,
// which this module reuses rather than re-implementing: it already owns anti-thrash dedup,
// the model-call budget, patience, and history threading (the escalating hint).
//
// The mapping onto the generic engine:
//   spec      = the user's question; `context` = the retrieved evidence
//   candidate = a whole answer (string)
//   verifier  = verifyApiFaithfulness — pure, deterministic, no model (the VGR requirement)
//   proposer  = round 0: the draft we ALREADY paid for (modelFree — costs no budget);
//               round N: re-synthesis carrying every prior rejection
//
// Seeding the existing draft as candidate 0 is what makes this a search rather than a retry:
// the draft competes with its own repairs under the same verifier, so a repair is only
// preferred when the verifier actually says it is better — and never on the model's say-so.
//
// HONEST LIMIT. If nothing certifies, this returns 'best-effort' and the caller still badges
// the answer UNVERIFIED. Ranking by violation count is a PROXY (2 fabricated names are not
// provably worse than 1), so ties and near-ties resolve to the ORIGINAL draft: the search may
// only replace it on a strict, verifier-measured improvement. If K attempts all fail, that is
// the measured FM ceiling — report it, do not dress it up.
// ═══════════════════════════════════════════════════════════════════════════════

import { fingerprintCode } from './codeProposer'
import { search } from './search'
import {
  escalatedRepairHint, verifyApiFaithfulness,
  type FaithfulnessVerdict,
} from './apiFaithfulness'
import type { Attempt, Candidate, Proposer, TaskSpec, Verdict, Verifier } from './types'

/** A chat message, structurally compatible with the FM client's message type. */
export interface RepairMessage { role: string; content: string }

/** Injected so the bench can drive the whole loop with zero model calls. */
export type CompleteFn = (msgs: RepairMessage[], signal?: AbortSignal) => Promise<string>

export interface FaithfulRepairInput {
  /** The already-synthesized answer. Verified first, free, as candidate 0. */
  draft: string
  /** The evidence block the answer must be faithful to. */
  evidence: string
  /** The user's question — the search spec's goal. */
  goal: string
  /** Base conversation (system + history + question/evidence) each repair re-synthesizes from. */
  baseMsgs: RepairMessage[]
  complete: CompleteFn
}

export interface FaithfulRepairOpts {
  /** K — model-backed repair attempts. The draft itself is free and never counted. */
  attempts?: number
  signal?: AbortSignal
  /**
   * Budget gate, consulted before EVERY model-backed proposal. Returning false ends the
   * search cleanly with whatever it has (grounding runs under a wall-clock budget, and a
   * repair that overruns it is worse than an honest UNVERIFIED ship).
   */
  canPropose?: () => boolean
  /** Progress sink — one line per attempt, for the live thought stream. */
  onAttempt?: (n: number, verdict: FaithfulnessVerdict) => void
}

export interface FaithfulRepairResult {
  /**
   * 'certified' → the verifier certified this text (green badge earned).
   * 'best-effort' → NOT certified; a repair strictly beat the draft. Ship UNVERIFIED.
   * 'unrepaired' → nothing beat the draft. Ship the draft UNVERIFIED (the cont.83 behavior).
   */
  status: 'certified' | 'best-effort' | 'unrepaired'
  /** The text to ship. Never null — we always have at least the draft. */
  text: string
  /** The verdict for `text`. Ground truth, not model opinion. */
  verdict: FaithfulnessVerdict
  /** Model calls actually spent (the draft is free, so 0 means the draft won). */
  modelCalls: number
  attemptsRun: number
  detail: string
}

/**
 * Abstain scores strictly below every real violation count. A repair that abstains has not
 * been proven faithful — it has escaped judgement, typically by deleting the code or swapping
 * in an unrelated library. Ranking it above a candidate with N countable violations would let
 * the loop "win" by erasing the evidence of failure, so it can never be selected.
 * (It is still not -Infinity: that is reserved for a verifier that THREW.)
 */
const ABSTAIN_SCORE = -1e6

/** Map the faithfulness verdict onto the search engine's Verdict. Pure. */
export function faithfulnessVerdict(v: FaithfulnessVerdict): Verdict {
  if (v.status === 'certified') return { pass: true, score: 0, signals: [v.reason] }
  if (v.status === 'abstain') return { pass: false, score: ABSTAIN_SCORE, signals: [`not judgeable: ${v.reason}`] }
  // Monotone: fewer fabricated identifiers ranks higher, so the loop can hill-climb.
  return { pass: false, score: -v.violations.length, signals: [v.reason] }
}

/** Verifier<string> over an evidence block. Deterministic, no model — the source of truth. */
export function makeFaithfulnessVerifier(evidence: string): Verifier<string> {
  return (c: Candidate<string>) => faithfulnessVerdict(verifyApiFaithfulness(c.value, evidence))
}

/** The faithfulness verdict behind a recorded attempt, recomputed from ground truth. */
const verdictOf = (a: Attempt<string>, evidence: string) => verifyApiFaithfulness(a.candidate.value, evidence)

/**
 * Proposer: candidate 0 is the draft (free), thereafter re-synthesis carrying every prior
 * rejection. Exported so the bench can assert the escalation without a model.
 */
export function makeRepairProposer(input: FaithfulRepairInput, opts: FaithfulRepairOpts = {}): Proposer<string> {
  return async ({ history, signal }): Promise<Candidate<string> | null> => {
    // Round 0 — the draft we already have. modelFree: it was paid for by the synthesis call,
    // and charging it to the repair budget would silently cost us one real attempt.
    if (!history.length) return { value: input.draft, fingerprint: fingerprintCode(input.draft), modelFree: true }
    if (opts.canPropose && !opts.canPropose()) return null

    // Repair the most recent attempt, informed by every earlier one. `history` is oldest-first.
    const latest = history[history.length - 1]
    const latestVerdict = verdictOf(latest, input.evidence)
    // Only violations carry a repair hint; an abstaining branch has nothing actionable to say,
    // so fall back to repairing the draft's own (real) violations rather than emitting noise.
    const target = latestVerdict.status === 'violations' ? latestVerdict : verdictOf(history[0], input.evidence)
    if (target.status !== 'violations') return null

    const prior = history.slice(0, -1).map(a => verdictOf(a, input.evidence)).filter(v => v.status === 'violations')
    const hint = escalatedRepairHint(target, prior)
    if (!hint) return null

    let raw = ''
    try {
      raw = (await input.complete([
        ...input.baseMsgs,
        { role: 'assistant', content: latest.candidate.value },
        { role: 'user', content: hint },
      ], signal)).trim()
    } catch { return null }
    if (raw.length < 20) return null
    return { value: raw, fingerprint: fingerprintCode(raw) }
  }
}

/**
 * Search for an answer the faithfulness verifier certifies. Sequential by construction
 * (beamWidth 1, one proposal per round): two concurrent syntheses is a KV footprint this
 * hardware does not have.
 */
export async function repairUntilFaithful(
  input: FaithfulRepairInput,
  opts: FaithfulRepairOpts = {},
): Promise<FaithfulRepairResult> {
  const K = Math.max(1, opts.attempts ?? 3)
  const spec: TaskSpec = { goal: input.goal, domain: 'answer', acceptance: {}, context: input.evidence }
  const draftVerdict = verifyApiFaithfulness(input.draft, input.evidence)

  let seen = 0
  const result = await search<string>(
    spec,
    makeRepairProposer(input, opts),
    makeFaithfulnessVerifier(input.evidence),
    {
      beamWidth: 1,
      proposalsPerNode: 1,
      maxModelCalls: K,
      // Every rejection is informative here (the hint accumulates), so never give up early:
      // the model-call budget alone bounds the search.
      patience: K + 2,
      signal: opts.signal,
      emit: () => {},
    },
  )
  for (const a of result.attempts) opts.onAttempt?.(++seen, verdictOf(a, input.evidence))

  if (result.status === 'solved' && result.solution) {
    return {
      status: 'certified',
      text: result.solution.value,
      verdict: verifyApiFaithfulness(result.solution.value, input.evidence),
      modelCalls: result.modelCalls,
      attemptsRun: result.attempts.length,
      detail: `certified after ${result.modelCalls} repair call(s)`,
    }
  }

  // Nothing certified. Pick a survivor ONLY on a strict, verifier-measured improvement over
  // the draft — the ranking is a proxy, so the draft holds ties and the search can never make
  // the shipped answer worse than what it started with.
  const draftScore = faithfulnessVerdict(draftVerdict).score
  let best: { text: string; verdict: FaithfulnessVerdict; score: number } | null = null
  for (const a of result.attempts) {
    if (a.candidate.value === input.draft) continue
    const v = verdictOf(a, input.evidence)
    const score = faithfulnessVerdict(v).score
    if (score <= draftScore) continue          // ties → draft wins (earliest, conservative)
    if (!best || score > best.score) best = { text: a.candidate.value, verdict: v, score }
  }

  if (best) {
    return {
      status: 'best-effort',
      text: best.text,
      verdict: best.verdict,
      modelCalls: result.modelCalls,
      attemptsRun: result.attempts.length,
      detail: `NOT certified — best of ${result.attempts.length} candidate(s) improved on the draft ` +
        `(${-draftScore} → ${-best.score} fabricated identifier(s)) but still does not match the evidence`,
    }
  }

  return {
    status: 'unrepaired',
    text: input.draft,
    verdict: draftVerdict,
    modelCalls: result.modelCalls,
    attemptsRun: result.attempts.length,
    detail: result.modelCalls
      ? `no candidate certified across ${result.modelCalls} repair call(s) and none improved on the draft — shipping the draft unverified`
      : 'no repair attempt was affordable — shipping the draft unverified',
  }
}
