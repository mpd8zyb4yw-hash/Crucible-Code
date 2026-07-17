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
// TWO PROPOSERS (cont.86). cont.84/85 measured the ceiling this search kept hitting: given a hint
// that NAMES the fabricated identifier and lists the documented surface, the Apple FM re-proposes
// a name the hint just rejected. K attempts against ONE model re-sample ONE distribution, so the
// escalating hint has nothing to escalate INTO — that is a property of the generator, not of the
// budget, and no value of K fixes it. The doctrinal answer (DOCTRINE.md: the loop, not the oracle)
// is a second INDEPENDENT generator: MiniCPM5-1B, seated ALONGSIDE the FM (never replacing it),
// with the search rotating between them so a rejection is re-attempted by a different distribution.
// Both are unreliable; the verifier is unchanged and remains the only source of correctness, so a
// second weak proposer can only ever ADD certified candidates — it cannot lower the bar.
//
// Rotation keys off an ATTEMPT COUNTER, never history.length. A proposer that whiffs (MiniCPM not
// resident, timeout, unrecoverable reasoning leak) returns null, and `search()` treats null as a
// transient infra failure: it retries the SAME slot without charging the budget, so history does
// not grow. Keying rotation on history.length would therefore re-select the whiffing model forever
// and starve the FM of the calls it was granted. Counting attempts instead means a whiff HANDS the
// slot to the other engine — the graceful-degradation property that makes seating a flaky second
// model safe on the hot path.
//
// The alt is OPTIONAL and injected. Omit it (a machine where MiniCPM was never downloaded) and this
// is byte-for-byte the cont.84 single-proposer search — the same "zero voters when uninstalled"
// contract the ONNX ensemble follows.
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
  escalatedRepairHint,
  type FaithfulnessVerdict,
} from './apiFaithfulness'
// THE ORACLE. Must be the SAME certify condition groundedAnswer ships behind, or this search
// optimizes against a weaker gate and hands the badge a candidate the badge would have rejected
// (cont.86b: repair manufactured a false GREEN out of an honest UNVERIFIED). certifyAnswer EXECUTES.
import { certifyAnswer } from './executionVerify'
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
  /**
   * Per-engine override of `baseMsgs`, keyed by the proposer's name. Return null to use
   * `baseMsgs` unchanged.
   *
   * WHY THIS EXISTS — engines have wildly different COST PROFILES, and the prompt is the bill.
   * MEASURED (cont.89) on Bonsai-27B in background mode: prompt processing runs at ~6.6 tok/s,
   * so the ~1550-token repair prompt (full system + full evidence + the draft + the hint) cost
   * **190 seconds to READ** before a single token was generated — 68% of a 278s repair. The FM
   * reads the same prompt in about a second.
   *
   * This is NOT for handicapping an engine or changing the task (that would make `proposedBy`
   * attribution meaningless — see the rotation note in the header). The QUESTION, the EVIDENCE
   * and the escalating hint must all still be present. It exists so a slow-prefill engine can be
   * given the same information without the padding it cannot afford to read.
   */
  baseMsgsFor?: (source: string) => RepairMessage[] | null
  /** The primary generator (the Apple FM, live). */
  complete: CompleteFn
  /**
   * A SECOND, INDEPENDENT generator (MiniCPM5-1B, live) the search rotates to. Optional: when
   * absent the loop is exactly the single-proposer search. Seated alongside the primary, never
   * replacing it — it exists so a hint the FM ignores is re-attempted by a different distribution.
   * Must resolve to '' rather than throw when it cannot produce output; '' hands the slot back.
   */
  completeAlt?: CompleteFn
  /** Attribution labels for telemetry — which engine produced the shipped text. */
  primaryName?: string
  altName?: string
  /** The ask was for code, so a prose answer is a violation (threaded into certifyAnswer). */
  codeRequested?: boolean
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
  /** Progress sink — one line per attempt, for the live thought stream. `source` attributes it. */
  onAttempt?: (n: number, verdict: FaithfulnessVerdict, source?: string) => void
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
  /**
   * WHICH engine produced the shipped `text` ('draft' | primaryName | altName). The measurement
   * that makes seating a second proposer falsifiable: if this never reads 'minicpm' across real
   * traffic, the second proposer is not earning its latency and the honest move is to say so.
   */
  proposedBy: string
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

/**
 * Verifier<string> over an evidence block. Deterministic, no model — the source of truth.
 * `codeRequested` propagates the "prose is not an answer to a code ask" rule into the SAME
 * oracle the whole loop uses; without it the draft's prose re-verifies as `abstain` here and the
 * search never gets a violation to act on (cont.89).
 */
export function makeFaithfulnessVerifier(evidence: string, codeRequested = false): Verifier<string> {
  return (c: Candidate<string>) => faithfulnessVerdict(certifyAnswer(c.value, evidence, { codeRequested }))
}

/** The faithfulness verdict behind a recorded attempt, recomputed from ground truth. */
const verdictOf = (a: Attempt<string>, evidence: string, codeRequested = false) =>
  certifyAnswer(a.candidate.value, evidence, { codeRequested })

/**
 * Proposer: candidate 0 is the draft (free), thereafter re-synthesis carrying every prior
 * rejection. Exported so the bench can assert the escalation without a model.
 */
/**
 * Re-synthesize CLEAN, with the rejection expressed as a forward CONSTRAINT — never by showing
 * the model the answer we are rejecting.
 *
 * THIS IS THE FIX FOR "detection works, recovery does not" (cont.83/84/86, three sessions of it).
 * The loop used to prompt `[...base, {assistant: <the fabrication>}, {user: "that was wrong,
 * fix it"}]`. MEASURED cont.89 on qwen2.5-1.5b, same evidence, N=3 each:
 *
 *   A  clean, no hint                          3/3 correct   0.6s
 *   B  fabrication in context + hint (OLD)     0/3 correct   6.0s   <-- the architecture
 *   C  clean + constraint, no draft (THIS)     3/3 correct   0.7s
 *
 * The model IMITATES the fabrication sitting in its context — in-context pattern-matching beats
 * the instruction telling it not to. So the repair prompt was manufacturing the very failure it
 * existed to fix, and it did so regardless of engine: this is exactly the shape in which the FM
 * "re-fabricated a name the hint had just rejected". Nothing about the draft is load-bearing —
 * the hint already names every rejected identifier — so it is simply not shown.
 *
 * The constraint is appended to the final USER turn rather than added as a new message: two
 * consecutive user turns render unpredictably across chat templates.
 */
function withConstraints(base: RepairMessage[], hint: string): RepairMessage[] {
  const out = base.map(m => ({ ...m }))
  const block = `\n\n## CONSTRAINTS (a previous attempt was rejected — do not repeat it)\n${hint}`
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') { out[i].content += block; return out }
  }
  out.push({ role: 'user', content: block.trim() })
  return out
}

export function makeRepairProposer(input: FaithfulRepairInput, opts: FaithfulRepairOpts = {}): Proposer<string> {
  const primaryName = input.primaryName ?? 'afm'
  const altName = input.altName ?? 'minicpm'
  // Model-backed attempts STARTED — incremented even when the call whiffs, so a dead engine
  // rotates the slot to the other one instead of monopolizing it. See the header.
  let turn = 0

  return async ({ history, signal }): Promise<Candidate<string> | null> => {
    // Round 0 — the draft we already have. modelFree: it was paid for by the synthesis call,
    // and charging it to the repair budget would silently cost us one real attempt.
    if (!history.length) {
      return { value: input.draft, fingerprint: fingerprintCode(input.draft), modelFree: true, source: 'draft' }
    }
    if (opts.canPropose && !opts.canPropose()) return null

    // Repair the most recent attempt, informed by every earlier one. `history` is oldest-first.
    const cr = input.codeRequested ?? false
    const latest = history[history.length - 1]
    const latestVerdict = verdictOf(latest, input.evidence, cr)
    // Only violations carry a repair hint; an abstaining branch has nothing actionable to say,
    // so fall back to repairing the draft's own (real) violations rather than emitting noise.
    const target = latestVerdict.status === 'violations' ? latestVerdict : verdictOf(history[0], input.evidence, cr)
    if (target.status !== 'violations') return null

    const prior = history.slice(0, -1).map(a => verdictOf(a, input.evidence, cr)).filter(v => v.status === 'violations')
    const hint = escalatedRepairHint(target, prior)
    if (!hint) return null

    // Rotate: the primary opens (it is the stronger engine on this path), the alt takes the very
    // next attempt — the FM's first repair failing is exactly the moment a second distribution is
    // worth paying for, and with the default K=3 that spends one attempt on it. Identical prompt
    // for both: the escalating hint is the whole point, so handicapping either engine would make
    // the attribution meaningless.
    const useAlt = !!input.completeAlt && turn % 2 === 1
    const complete = useAlt ? input.completeAlt! : input.complete
    const source = useAlt ? altName : primaryName
    turn++  // BEFORE the call: a throw or an empty reply must still rotate the slot.

    let raw = ''
    try {
      const base = input.baseMsgsFor?.(source) ?? input.baseMsgs
      raw = (await complete(withConstraints(base, hint), signal)).trim()
    } catch { return null }
    if (raw.length < 20) return null
    return { value: raw, fingerprint: fingerprintCode(raw), source }
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
  const cr = input.codeRequested ?? false
  const draftVerdict = certifyAnswer(input.draft, input.evidence, { codeRequested: cr })

  let seen = 0
  const result = await search<string>(
    spec,
    makeRepairProposer(input, opts),
    makeFaithfulnessVerifier(input.evidence, cr),
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
  for (const a of result.attempts) opts.onAttempt?.(++seen, verdictOf(a, input.evidence, cr), a.candidate.source)

  if (result.status === 'solved' && result.solution) {
    const by = result.solution.source ?? 'draft'
    return {
      status: 'certified',
      text: result.solution.value,
      verdict: certifyAnswer(result.solution.value, input.evidence),
      modelCalls: result.modelCalls,
      attemptsRun: result.attempts.length,
      proposedBy: by,
      detail: by === 'draft'
        ? 'the draft was already faithful — certified for free, no repair call'
        : `certified after ${result.modelCalls} repair call(s) — winning candidate from ${by}`,
    }
  }

  // Nothing certified. Pick a survivor ONLY on a strict, verifier-measured improvement over
  // the draft — the ranking is a proxy, so the draft holds ties and the search can never make
  // the shipped answer worse than what it started with.
  const draftScore = faithfulnessVerdict(draftVerdict).score
  let best: { text: string; verdict: FaithfulnessVerdict; score: number; source: string } | null = null
  for (const a of result.attempts) {
    if (a.candidate.value === input.draft) continue
    const v = verdictOf(a, input.evidence)
    const score = faithfulnessVerdict(v).score
    if (score <= draftScore) continue          // ties → draft wins (earliest, conservative)
    if (!best || score > best.score) best = { text: a.candidate.value, verdict: v, score, source: a.candidate.source ?? 'unknown' }
  }

  if (best) {
    return {
      status: 'best-effort',
      text: best.text,
      verdict: best.verdict,
      modelCalls: result.modelCalls,
      attemptsRun: result.attempts.length,
      proposedBy: best.source,
      detail: `NOT certified — best of ${result.attempts.length} candidate(s) (from ${best.source}) improved on the draft ` +
        `(${-draftScore} → ${-best.score} fabricated identifier(s)) but still does not match the evidence`,
    }
  }

  return {
    status: 'unrepaired',
    text: input.draft,
    verdict: draftVerdict,
    modelCalls: result.modelCalls,
    attemptsRun: result.attempts.length,
    proposedBy: 'draft',
    detail: result.modelCalls
      ? `no candidate certified across ${result.modelCalls} repair call(s)${enginesTried(result.attempts)} and none improved on the draft — shipping the draft unverified`
      : 'no repair attempt was affordable — shipping the draft unverified',
  }
}

/** " (afm, minicpm)" — names the engines that actually proposed, so an honest failure says WHO failed. */
function enginesTried(attempts: Array<Attempt<string>>): string {
  const names = [...new Set(attempts.map(a => a.candidate.source).filter((s): s is string => !!s && s !== 'draft'))]
  return names.length ? ` (${names.join(', ')})` : ''
}
