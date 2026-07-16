// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION-GUIDED REASONING (VGR) — core types
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (see DOCTRINE.md): correctness comes from the LOOP, not the oracle.
//
//   An unreliable small generator + a sound deterministic verifier + search
//   = a system MORE reliable than the generator.
//
// This is the whole thesis and it is provable (it is how SMT-guided synthesis,
// property-based testing, AlphaProof and AlphaCode all work). The on-device model
// is NEVER trusted as an answer. It is a *proposal function*: a cheap, fallible
// generator of candidate moves. The SYSTEM does the reasoning — it proposes,
// checks against ground truth, learns from the failure, prunes, backtracks, and
// only accepts a candidate a deterministic verifier certifies.
//
// The scarce resource on 8GB / serial-ANE hardware is MODEL CALLS, not parameters.
// So the design maximizes INFORMATION PER CALL: every rejected candidate returns
// rich, structured feedback that makes the next proposal converge in a handful of
// calls instead of hundreds. Sample-efficiency is the moat.
// ═══════════════════════════════════════════════════════════════════════════════

/** A single candidate produced by a Proposer. Opaque to the search engine. */
export interface Candidate<T = unknown> {
  /** The proposed artifact (code string, an answer, a plan step, …). */
  value: T
  /** Stable fingerprint used for anti-thrash dedup (identical proposal ⇒ stuck). */
  fingerprint: string
  /**
   * True when this candidate was produced WITHOUT invoking a model — a mechanical
   * single-edit repair, or executable code lifted from a retrieved source. The search
   * loop must not charge it against the model-call budget: that budget exists to bound
   * MODEL work, and billing free work against it both understates the deterministic
   * tiers in every report and starves the FM of the calls it was actually granted.
   * Proposers that do call a model leave this unset.
   */
  modelFree?: boolean
}

/**
 * The verdict a Verifier returns for a candidate. This is GROUND TRUTH, produced by
 * deterministic means (compiler, test execution, property check, type system, an
 * independent derivation) — never by the model judging itself.
 */
export interface Verdict {
  /** True only when the candidate is certified correct by the verifier. */
  pass: boolean
  /**
   * Higher is better. Partial-credit signal that lets the search RANK failing
   * candidates and climb toward a solution (e.g. -(#failing tests), -(#type errors)).
   * A monotone score is what turns blind guessing into hill-climbing.
   */
  score: number
  /**
   * HIGH-INFORMATION feedback — the single most important field on slow hardware.
   * Each line is concrete, actionable signal the proposer can learn from: the exact
   * type mismatch, the failing assertion's ACTUAL vs expected values, a minimized
   * counterexample, the thrown stack. "It failed" is worthless; "case f(3,4) returned
   * 7, expected 12; case f(0,0) threw TypeError at line 2" converges the next attempt.
   */
  signals: string[]
}

/**
 * A Proposer generates the next candidate given the problem and the FULL history of
 * prior attempts (each with its verdict). This is where the model lives — and the
 * ONLY place it lives. It must consume prior feedback so each call is maximally
 * informed. It may be stochastic, wrong, and weak; the loop tolerates all three.
 */
export type Proposer<T = unknown> = (
  ctx: ProposeContext<T>,
) => Promise<Candidate<T> | null>

export interface ProposeContext<T = unknown> {
  /** The task specification (mechanically-checkable statement of "correct"). */
  spec: TaskSpec
  /** Prior attempts in this search, oldest-first — the feedback that guides the next move. */
  history: Attempt<T>[]
  /** True when the engine wants a DELIBERATELY DIFFERENT approach (anti-thrash / backtrack). */
  diversify: boolean
  signal?: AbortSignal
}

/**
 * A Verifier certifies a candidate against ground truth. Deterministic. No model.
 * This is the source of all correctness in the system.
 */
export type Verifier<T = unknown> = (
  candidate: Candidate<T>,
  spec: TaskSpec,
) => Promise<Verdict> | Verdict

/** One (candidate, verdict) pair recorded during search — the loop's working memory. */
export interface Attempt<T = unknown> {
  candidate: Candidate<T>
  verdict: Verdict
}

/**
 * A task specification: the mechanically-checkable statement of what "correct" means.
 * The reasoning substrate. If we cannot state this, we cannot verify — and if we
 * cannot verify, we must ABSTAIN (mission: abstain means abstain). `acceptance`
 * carries whatever the domain's Verifier needs (test cases, invariants, a target
 * signature). Kept open so the same engine hosts code, math, planning, etc.
 */
export interface TaskSpec {
  /** Human-readable goal, passed to the proposer. */
  goal: string
  /** Domain tag ('code' | 'reason' | …) — selects proposer/verifier wiring. */
  domain: string
  /** Domain-specific acceptance data the Verifier consumes (test cases, invariants…). */
  acceptance: Record<string, unknown>
  /** Optional extra grounding (retrieved docs, repo context) injected into proposals. */
  context?: string
}

export type SearchStatus = 'solved' | 'exhausted' | 'abstained' | 'aborted'

export interface SearchResult<T = unknown> {
  status: SearchStatus
  /** The certified-correct candidate, when status === 'solved'. */
  solution: Candidate<T> | null
  /** The best failing candidate by score (for honest partial reporting), when unsolved. */
  best: Attempt<T> | null
  /** Every attempt made, in order — the full audit trail of the reasoning. */
  attempts: Attempt<T>[]
  /** Model calls consumed (the scarce budget on this hardware). */
  modelCalls: number
  detail: string
}
