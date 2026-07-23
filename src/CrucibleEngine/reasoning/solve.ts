// ═══════════════════════════════════════════════════════════════════════════════
// VGR — public entry point: solveCodeTask
// ═══════════════════════════════════════════════════════════════════════════════
//
// Assembles the reasoning core into a single call the rest of Crucible uses:
//
//     spec ──► search( proposeCode , verifyCode )  ──► certified solution | honest abstain
//
// The model (proposeCode) proposes; execution (verifyCode) is the ground-truth judge;
// search() explores, prunes and backtracks. Correctness is certified by running the
// code, never by the model's say-so. If the loop cannot certify a candidate within
// the model-call budget, it returns an honest non-solution — it does NOT ship an
// unverified guess (mission: abstain means abstain).
// ═══════════════════════════════════════════════════════════════════════════════

import { proposeCode, proposeCodeMany } from './codeProposer'
import { type CodeAcceptance, verifyCode } from './codeVerifier'
import { makeCodeResearchFn, mergeCodeAcceptance, buildCodeSearchQuery, WEB_GROUND_MARK } from './codeResearch'
import { deriveDifferentialSpec, type DifferentialOpts } from './differentialSpec'
import { iterate, type IterateOpts, type IterateResult } from './iterate'
import { solveByDecomposition, type DecomposeResult, type Planner, type SubSpecFactory } from './decompose'
import { makeFmPlanner, makeFmSubFunctionPlanner, isArithmeticExprGoal } from './fmPlanner'
import { deriveMetamorphicSpec, canonicalImpl } from './metamorphicSpec'
import { derivePropertySpec, supplementalPropertySpec, verifyByProperty } from './propertyVerifier'
import { search, type SearchOpts } from './search'
import { type Completer, extractCodeSpec, harvestExplicitExamples } from './specExtractor'
import { makeRetrievalProposer, composeProposers } from './retrievalProposer'
import { makeMutationRepairProposer } from './mutationRepair'
import type { Proposer, SearchResult, TaskSpec, Verifier } from './types'

/**
 * Compose the RETRIEVAL proposer in front of a base (FM) proposer for one rung/solve. The
 * retrieval proposer yields executable candidates extracted from web source — aliased to
 * `entry` and run STRAIGHT through the verifier — until exhausted, then the base FM takes
 * over (with the reference still folded into its context by codeResearch channel 3). This
 * is the "internet solves the kernel" data path: on a cornered sub-problem the certified
 * answer can come from retrieved code with ZERO model calls. `webGround` absent → returns
 * the base proposer unchanged (no behavioural change on the no-network path). `wantArity`
 * is read from the first case's argument count for signature-fit ranking.
 */
function withRetrieval(
  base: Proposer<string>,
  entry: string,
  goal: string,
  cases: CodeAcceptance['cases'],
  webGround?: (query: string) => Promise<string | null>,
  query?: string,
  emit?: (e: Record<string, unknown>) => void,
): Proposer<string> {
  if (!webGround) return base
  const wantArity = cases?.[0]?.args?.length ?? null
  const retrieval = makeRetrievalProposer({ entry, goal, webGround, query, wantArity, emit })
  return composeProposers(retrieval, base)
}

export interface SolveCodeInput {
  goal: string
  entry: string
  /** All functions the module must export (multi-function specs). Defaults to [entry]. */
  entries?: string[]
  cases: CodeAcceptance['cases']
  context?: string
  timeoutMs?: number
  /**
   * For repair tasks: the current broken implementation. When present, solveCodeTask runs
   * ONE deterministic verify pass over it (no model call) and folds the concrete failing-case
   * evidence into the first proposal's context — so the loop localizes the bug on call #1
   * instead of spending a model call rediscovering which cases fail. Pure sample-efficiency.
   */
  buggyCode?: string
}

/** Render the buggy code's observed failures as a localization block for the first proposal. */
async function repairEvidenceBlock(
  buggyCode: string,
  spec: TaskSpec,
): Promise<string | null> {
  const v = await verifyCode({ value: buggyCode, fingerprint: 'repair-seed' }, spec)
  if (v.pass || v.signals.length === 0) return null
  const failures = `Observed failures of the current implementation (from executing it against the spec):\n${v.signals.slice(0, 6).map(s => `  - ${s}`).join('\n')}`
  // Structural-fault steer: every token-level regression (wrong operator, off-by-one
  // boundary, negated condition) is repaired mechanically BEFORE the model is ever asked
  // (see makeMutationRepairProposer). So when the model IS asked, the bug is — by
  // construction — not a single-token edit: the residual fault classes are a missing
  // statement (a dropped guard / early-return) or a wrong-or-absent return value. Point
  // the first proposal there instead of re-searching the token space the fast-path owns.
  const steer =
    'Note: single-token fixes (operator swaps, off-by-one boundaries, negated conditions) ' +
    'have already been tried mechanically and did not fix this. Look instead for a missing ' +
    'statement — a dropped guard or early-return whose absence lets a bad case through — or ' +
    'a return that yields the wrong value (or returns nothing where a value is required).'
  return `${failures}\n\n${steer}`
}

/**
 * Batch-path search-budget bump (item 3). Returns the proposalsPerNode / maxModelCalls overrides
 * to layer on top of the caller's opts when CRUCIBLE_VGR_BATCH is on. Pure + deterministic given
 * env — factored out so __search_batch_bench and a unit test can assert the accounting directly.
 *
 *   proposalsPerNode: raised to CRUCIBLE_VGR_BATCH_PROPOSALS (default 4), unless the caller pinned
 *                     its own value (respected verbatim — an explicit request always wins).
 *   maxModelCalls:    scaled by the SAME factor the draws-per-round grew by, so the round count is
 *                     preserved (K× wider search, not K× fewer rounds), then hard-capped at
 *                     CRUCIBLE_VGR_BATCH_MAXCALLS (default 64) so a large caller budget can't blow up.
 */
export function batchBudget(opts: SearchOpts<string>): { proposalsPerNode: number; maxModelCalls: number } {
  const wantProps = Math.max(1, Number(process.env.CRUCIBLE_VGR_BATCH_PROPOSALS || 4))
  const proposalsPerNode = opts.proposalsPerNode ?? wantProps
  const baseCalls = opts.maxModelCalls ?? 12
  const baseProps = opts.proposalsPerNode ?? 1               // serial default is 1 draw/node
  const factor = Math.max(1, proposalsPerNode / baseProps)   // how much wider each round got
  const cap = Math.max(baseCalls, Number(process.env.CRUCIBLE_VGR_BATCH_MAXCALLS || 64))
  const maxModelCalls = Math.min(cap, Math.round(baseCalls * factor))
  return { proposalsPerNode, maxModelCalls }
}

/**
 * Solve a code task by verification-guided search. Returns the full SearchResult —
 * callers read `.status` ('solved' | 'exhausted' | 'abstained' | 'aborted') and use
 * `.solution.value` only when solved, or report `.best` honestly otherwise.
 *
 * `proposerOverride` lets tests inject a deterministic proposer so the LOOP can be
 * proven without a live model (see __vgr_bench.ts).
 */
export async function solveCodeTask(
  input: SolveCodeInput,
  opts: SearchOpts = {},
  proposerOverride?: Proposer<string>,
): Promise<SearchResult<string>> {
  const acceptance = {
    entry: input.entry,
    entries: input.entries && input.entries.length > 1 ? input.entries : undefined,
    cases: input.cases,
    timeoutMs: input.timeoutMs,
  } satisfies CodeAcceptance as unknown as Record<string, unknown>
  const spec: TaskSpec = { goal: input.goal, domain: 'code', context: input.context, acceptance }
  if (input.buggyCode) {
    const evidence = await repairEvidenceBlock(input.buggyCode, spec)
    if (evidence) spec.context = [input.context, evidence].filter(Boolean).join('\n\n')
  }
  // Repair fast-path: when we hold the buggy source, try the bounded space of single-token
  // inversions (operator/arithmetic/boundary edits) BEFORE the model. Injected operator faults
  // and real off-by-one regressions are one deterministic edit from correct; the verifier
  // certifies the fix in zero model calls. Composed AHEAD of the FM so it only ever saves calls —
  // it cedes (returns null) the instant no single edit fixes the bug.
  // Gate the fast-path on the LIVE proposer only: the deterministic benches inject a
  // proposerOverride precisely to prove the harness accounting for an arbitrary proposer,
  // and must not have this mechanical repair fire ahead of their controlled one.
  const proposer: Proposer<string> = input.buggyCode && !proposerOverride
    ? composeProposers(makeMutationRepairProposer(input.buggyCode), proposeCode)
    : (proposerOverride ?? proposeCode)
  const verifier: Verifier<string> = verifyCode
  // W3 continuous batching on the LIVE path (opt-in via CRUCIBLE_VGR_BATCH=1). Only when the
  // proposer is the PLAIN FM proposer — a composed proposer (mutation-repair fast-path, or a test
  // override) has per-call ordering semantics the flat batch draw would flatten, so those keep the
  // serial path. proposeCodeMany draws a whole round's slots across llama-server KV slots at once;
  // search()'s batch path is proven accounting-identical to serial (see __search_batch_bench).
  const useBatch = process.env.CRUCIBLE_VGR_BATCH === '1' && !opts.batchProposer && proposer === proposeCode
  // BATCH-PATH SAMPLE BUMP (item 3, 2026-07-22). The pass@k experiment proved the loop is STARVED,
  // not weak: pass@1 52.5% → pass@10 83.3% — the correct answer is in the distribution, just rare,
  // so drawing MORE candidates per round converts directly to solves. Batching makes concurrent
  // draws ~free (the K slots decode together), so on the batch path we raise proposalsPerNode from 1
  // to `CRUCIBLE_VGR_BATCH_PROPOSALS` (default 4) — 4-8 draws/round is exactly where the curve says
  // the marginal draw still pays. A matching maxModelCalls scale keeps the ROUND count constant
  // (each round now spends proposalsPerNode× the calls), so the loop explores as many rounds as
  // before but K× wider — never fewer rounds than the serial budget would have run. Capped so a
  // pathological caller budget can't run away. A caller that set proposalsPerNode explicitly wins.
  const searchOpts: SearchOpts<string> = useBatch
    ? { ...opts, ...batchBudget(opts), batchProposer: proposeCodeMany }
    : opts
  return search(spec, proposer, verifier, searchOpts)
}

/**
 * CONVERGING solve: the same execution-grounded contract as solveCodeTask, but driven by
 * iterate() — the outer loop keeps spending epochs while the best score is climbing and,
 * when it stalls, injects the code-domain ResearchFn (prior-epoch counterexamples into the
 * proposer; sound differential-consensus cases into the verifier). Certifies where a single
 * bounded search() would abstain. Termination stays deterministic (pass / research-stall /
 * reality budget). `research` defaults to the code research fn built from `nl`; pass a
 * proposerOverride/research for deterministic tests (see __code_research_bench.ts).
 */
export async function iterateCodeTask(
  input: SolveCodeInput & { nl?: string; webGround?: (query: string) => Promise<string | null> },
  opts: IterateOpts<string> = {},
  proposerOverride?: Proposer<string>,
): Promise<IterateResult<string>> {
  // PROACTIVE web grounding: don't wait for the model to fail — like a strong coder who looks up
  // the approach BEFORE writing, fetch a reference up front (best-effort) and seed the FIRST
  // proposal's context. The stall channel (makeCodeResearchFn channel 3) still runs as a fallback,
  // but the WEB_GROUND_MARK sentinel we prepend here prevents it from re-fetching. Certification is
  // unchanged: the seeded reference only informs the proposer; every candidate is still executed.
  let seededContext = input.context
  let proactiveRef: string | null = null   // reused by the retrieval-candidate proposer — no 2nd fetch
  if (input.webGround && !opts.research && !opts.signal?.aborted) {
    try {
      const q = buildCodeSearchQuery(input.nl ?? input.goal, input.entry)
      const ref = (await input.webGround(q))?.trim()
      if (ref) {
        proactiveRef = ref
        const block = `${WEB_GROUND_MARK}\n${ref}`
        seededContext = seededContext ? `${seededContext}\n\n${block}` : block
      }
    } catch { /* best-effort: a retrieval failure never blocks synthesis */ }
  }
  const spec: TaskSpec = {
    goal: input.goal,
    domain: 'code',
    context: seededContext,
    acceptance: {
      entry: input.entry,
      entries: input.entries && input.entries.length > 1 ? input.entries : undefined,
      cases: input.cases,
      timeoutMs: input.timeoutMs,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
  // Retrieval-candidate path: alongside proactive context-grounding (above) and stall research
  // (channel 3), also offer executable candidates extracted from web source, aliased to the entry
  // and run straight through the verifier — so the kernel can certify with ZERO FM calls instead of
  // relying on the weak FM to adapt the reference (which the live parseClock runs proved it can't).
  // Reuse the already-fetched reference (no second network hit) as the retrieval proposer's source;
  // only fetch inside withRetrieval when the proactive path was skipped (opts.research set).
  const base: Proposer<string> = proposerOverride ?? proposeCode
  const retrievalSource = proactiveRef != null
    ? (async () => proactiveRef) as (query: string) => Promise<string | null>
    : input.webGround
  const proposer = withRetrieval(base, input.entry, input.nl ?? input.goal, input.cases, retrievalSource, buildCodeSearchQuery(input.nl ?? input.goal, input.entry), opts.emit)
  const research = opts.research ?? makeCodeResearchFn({ nl: input.nl ?? input.goal, webGround: input.webGround })
  return iterate(spec, proposer, verifyCode, {
    mergeAcceptance: mergeCodeAcceptance,
    ...opts,
    research,
  })
}

// ── VERIFIED DECOMPOSITION for the code domain ──────────────────────────────────
// The fallback for when a flat iterate() cannot converge because the weak proposer can't
// one-shot the whole function/module (the logged game-build bottleneck). Splits the
// acceptance CASES into a growing curriculum: rung i must pass cases[0..k_i], built on the
// frozen prior certified artifact. Each rung is a real executed check (verifyCode), and the
// composed final artifact is re-verified against the FULL case set by solveByDecomposition.
// Sound: no rung — and not the whole — is ever accepted on the model's say-so.

/** Split n cases into `rungs` growing prefixes (last prefix == all cases). */
export function growingCasePrefixes(total: number, rungs: number): number[] {
  const r = Math.max(1, Math.min(rungs, total))
  const out: number[] = []
  for (let i = 1; i <= r; i++) out.push(Math.max(1, Math.round((i / r) * total)))
  out[out.length - 1] = total // final rung always covers everything
  // de-dup while preserving order (avoids zero-width rungs when total < rungs)
  return out.filter((v, i) => i === 0 || v !== out[i - 1])
}

/** Build a code-domain incremental sub-acceptance factory over a growing case curriculum. */
export function makeCodeSubSpec(
  allCases: CodeAcceptance['cases'],
  acc: { entry: string; entries?: string[]; timeoutMs?: number },
  proposer: Proposer<string>,
  prefixes: number[],
): SubSpecFactory<string> {
  return (_sub, index, priorSolutions, parent) => {
    const k = prefixes[Math.min(index, prefixes.length - 1)]
    const cases = allCases.slice(0, k)
    const prior = priorSolutions[priorSolutions.length - 1]
    const context = [parent.context, prior ? `${WEB_GROUND_MARK}\n${prior}` : '']
      .filter(Boolean).join('\n\n') || undefined
    const spec: TaskSpec = {
      goal: `${parent.goal}\n\n(incremental rung ${index + 1}: satisfy the first ${k} case(s))`,
      domain: 'code',
      context,
      acceptance: {
        entry: acc.entry,
        entries: acc.entries && acc.entries.length > 1 ? acc.entries : undefined,
        cases, timeoutMs: acc.timeoutMs,
      } satisfies CodeAcceptance as unknown as Record<string, unknown>,
    }
    return { spec, proposer, verifier: verifyCode }
  }
}

/**
 * Solve a code task by verified decomposition. Call this after iterateCodeTask() returns a
 * non-'solved' status. Returns the certified code + rung trace, or an honest failure — it
 * NEVER ships an unverified guess (the composition is re-run against ALL cases).
 */
export async function decomposeCodeTask(
  input: SolveCodeInput & { nl?: string; webGround?: (query: string) => Promise<string | null> },
  opts: { planner?: Planner; rungs?: number; iterate?: Partial<IterateOpts<string>>; signal?: AbortSignal; emit?: IterateOpts<string>['emit'] } = {},
  proposerOverride?: Proposer<string>,
): Promise<DecomposeResult<string>> {
  const spec: TaskSpec = {
    goal: input.goal,
    domain: 'code',
    context: input.context,
    acceptance: {
      entry: input.entry,
      entries: input.entries && input.entries.length > 1 ? input.entries : undefined,
      cases: input.cases, timeoutMs: input.timeoutMs,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
  const proposer = proposerOverride ?? proposeCode
  const prefixes = growingCasePrefixes(input.cases.length, opts.rungs ?? Math.min(4, input.cases.length))
  return solveByDecomposition<string>(spec, proposer, verifyCode, {
    planner: opts.planner ?? makeFmPlanner(),
    subSpecFor: makeCodeSubSpec(input.cases, { entry: input.entry, entries: input.entries, timeoutMs: input.timeoutMs }, proposer, prefixes),
    iterateOpts: { mergeAcceptance: mergeCodeAcceptance, ...opts.iterate },
    signal: opts.signal, emit: opts.emit,
  })
}

// ── SUB-FUNCTION (logic) DECOMPOSITION for STRUCTURALLY-hard functions ───────────
// The axis the live parseClock run proved we needed: don't split the acceptance CASES
// (every case needs the whole parse first) — split the IMPLEMENTATION into smaller pure
// helpers, certify each against its own tiny spec, then a final COMPOSITION rung wires the
// certified helpers and is verified against the ORIGINAL cases. Each helper is within the
// weak model's one-shot reach; the certified helper SOURCE is sound grounding for the next.
//
// SubFunctionPlan is UNTRUSTED (helper names + example I/O from the FM). A bad plan only
// wastes budget: a wrong helper example certifies the wrong helper, and the composition then
// fails the original cases → honest collapse. The composition rung's verifier runs the FULL
// module (helpers + top) against the original cases, so the whole is proven as a whole.

/** A helper the top-level function is built from; `cases` seed its (untrusted) Verifier. */
export interface SubFunctionSpec {
  name: string
  goal: string
  cases: CodeAcceptance['cases']
}

/** Ask the FM for a helper decomposition of a code goal. Reads entry/cases off the input. */
export type SubFunctionPlanner = (
  input: { goal: string; entry: string; cases: CodeAcceptance['cases'] },
  signal?: AbortSignal,
) => Promise<SubFunctionSpec[] | null>

export interface SubFunctionRung {
  name: string
  status: IterateResult<string>['status']
  bestScore: number
  modelCalls: number
  certified: boolean
}

export interface SubFunctionResult {
  status: 'solved' | 'decompose-failed' | 'declined' | 'aborted'
  /** Full certified module (helpers + top), when solved. */
  code: string | null
  helpers: { name: string; source: string }[]
  rungs: SubFunctionRung[]
  modelCalls: number
  detail: string
}

/**
 * Solve a code task by SUB-FUNCTION decomposition. Certify each planned helper on its own,
 * then wire them in a composition rung verified against the ORIGINAL cases. Never ships an
 * unverified guess: the returned code is exactly what passed verifyCode over the full module.
 */
export async function decomposeCodeBySubFunction(
  input: SolveCodeInput & { nl?: string },
  opts: {
    planner?: SubFunctionPlanner
    /**
     * PLAN-LEVEL RETRY. Live data (cont.72b) shows the weak FM's decomposition QUALITY is
     * high-variance — one sample carves clean trivial helpers (parseHour("12")→12), the next
     * re-bakes the whole difficulty into a helper that can't certify. Since a single good plan
     * makes the rest easy, resample the plan on an honest collapse. Default 3. This is "the
     * loop, not the oracle" applied to the planner itself — every attempt is still fully
     * verifier-gated, so more attempts can only find a real solution, never fabricate one.
     */
    planAttempts?: number
    /**
     * WEB RETRIEVAL for the cornered kernel. Decomposition's real payoff: it corners the
     * FM's capability gap into ONE small, precisely-named helper ("convert 12h am/pm time to
     * minutes") — which is a great SEARCH QUERY. When such a helper stalls, the FM shouldn't
     * keep guessing (it provably can't invent it); the loop should RETRIEVE a real reference
     * implementation of exactly that sub-problem and adapt it. Injected (network stays out of
     * the pure loop); each rung searches for ITS OWN goal. Sound: retrieved code only grounds
     * the PROPOSER; the candidate is still executed against the rung's spec. Absent → no web.
     */
    webGround?: (query: string) => Promise<string | null>
    iterate?: Partial<IterateOpts<string>>
    signal?: AbortSignal
    emit?: IterateOpts<string>['emit']
  } = {},
  proposerOverride?: Proposer<string>,
): Promise<SubFunctionResult> {
  const emit = opts.emit ?? (() => {})
  const planAttempts = Math.max(1, opts.planAttempts ?? 3)
  // Retry the WHOLE decomposition on an honest collapse — a fresh (stochastic) plan each time.
  // Stop early on solve, decline (planner has nothing), or abort (reality budget/cancel).
  let last: SubFunctionResult | null = null
  let spentCalls = 0
  for (let attempt = 0; attempt < planAttempts; attempt++) {
    if (opts.signal?.aborted) break
    if (attempt > 0) emit({ type: 'thought', text: `subfn: plan attempt ${attempt + 1}/${planAttempts} (prior plan collapsed)` })
    const r = await runSubFunctionOnce(input, opts, proposerOverride)
    spentCalls += r.modelCalls
    last = { ...r, modelCalls: spentCalls }
    if (r.status === 'solved' || r.status === 'declined' || r.status === 'aborted') return last
    // else decompose-failed → resample the plan and try again
  }
  return last ?? { status: 'declined', code: null, helpers: [], rungs: [], modelCalls: spentCalls, detail: 'no plan attempts run' }
}

async function runSubFunctionOnce(
  input: SolveCodeInput & { nl?: string },
  opts: { planner?: SubFunctionPlanner; webGround?: (query: string) => Promise<string | null>; iterate?: Partial<IterateOpts<string>>; signal?: AbortSignal; emit?: IterateOpts<string>['emit'] },
  proposerOverride?: Proposer<string>,
): Promise<SubFunctionResult> {
  const emit = opts.emit ?? (() => {})
  const proposer = proposerOverride ?? proposeCode
  const rungs: SubFunctionRung[] = []
  let modelCalls = 0
  // Per-rung web retrieval: on a stall, fetch a reference impl for THAT rung's goal. Differential
  // channel off — the helper cases are FM-proposed (untrusted), so we don't tighten them further;
  // channel-1 signal grounding + channel-3 web retrieval are what corner-then-solve the kernel.
  const webGround = opts.webGround
  // Search the rung's NATURAL-LANGUAGE goal, NOT the invented helper identifier. Live probe:
  // "convert 12h am/pm to minutes" retrieved 2460 chars, but "…parseAMPM javascript" (the
  // invented name appended) hit a page that yielded no code. So strip the name from the query.
  const researchFor = webGround
    ? (nl: string) => makeCodeResearchFn({ nl, webGround: (_q: string) => webGround(buildCodeSearchQuery(nl)), differential: false })
    : (_nl: string) => undefined

  if (opts.signal?.aborted) return { status: 'aborted', code: null, helpers: [], rungs, modelCalls, detail: 'aborted before planning' }

  // 1) Untrusted helper plan.
  const planner: SubFunctionPlanner = opts.planner ?? (async (inp, signal) => {
    const fn = makeFmSubFunctionPlanner()
    const plan = await fn(inp.goal, inp.entry, inp.cases.map((c) => ({ args: c.args, expected: c.expected })), signal)
    return plan // PlannedSubFunction[] is structurally a SubFunctionSpec[]
  })
  let plan: SubFunctionSpec[] | null = null
  try { plan = await planner({ goal: input.goal, entry: input.entry, cases: input.cases }, opts.signal) }
  catch (e: any) { emit({ type: 'thought', text: `subfn: planner error ${String(e?.message ?? e)}` }) }
  if (!plan || plan.length < 1) {
    return { status: 'declined', code: null, helpers: [], rungs, modelCalls, detail: 'planner proposed no checkable helpers' }
  }
  // guard against a helper colliding with the top-level name
  const helperPlan = plan.filter((h) => h.name !== input.entry).slice(0, 5)
  emit({ type: 'thought', text: `subfn: ${helperPlan.length} helper(s) — ${helperPlan.map((h) => h.name).join(', ')}` })
  if (!helperPlan.length) {
    return { status: 'declined', code: null, helpers: [], rungs, modelCalls, detail: 'no helper distinct from the top-level function' }
  }

  // 2) Certify each helper independently. A helper that can't certify collapses the plan.
  const helpers: { name: string; source: string }[] = []
  for (const h of helperPlan) {
    if (opts.signal?.aborted) return { status: 'aborted', code: null, helpers, rungs, modelCalls, detail: `aborted at helper ${h.name}` }
    // CONTEXT HYGIENE (2026-07-22l): only ground a rung with the prior helpers it ACTUALLY calls
    // (its goal names them), not every certified helper. Live probe: foldMulDiv solves in 2 calls
    // in isolation but ANCHORED inside decomposition, because the unconditional prior-helper dump
    // crowded the idiom/cases out of the weak head's tiny per-slot context (n_ctx≈1024/slot). Most
    // template helpers are independent, so this hands them the same clean prompt isolation gets.
    const deps = helpers.filter((x) => h.goal.includes(x.name))
    const priorBlock = deps.map((x) => x.source).join('\n\n')
    const spec: TaskSpec = {
      goal: `${h.goal}\n\nImplement helper \`${h.name}\`.`,
      domain: 'code',
      context: [input.context, priorBlock].filter(Boolean).join('\n\n') || undefined,
      acceptance: { entry: h.name, cases: h.cases, timeoutMs: input.timeoutMs } satisfies CodeAcceptance as unknown as Record<string, unknown>,
    }
    // Retrieval-candidate path FIRST: the cornered helper is a precise search query, so try
    // executable candidates straight from web source before the FM guesses (which it provably
    // can't for the kernel). Same webGround the research fn uses, queried on the helper's goal.
    const rungProposer = withRetrieval(proposer, h.name, h.goal, h.cases, webGround, buildCodeSearchQuery(h.goal), opts.emit)
    const res = await iterate<string>(spec, rungProposer, verifyCode, { mergeAcceptance: mergeCodeAcceptance, research: researchFor(h.goal), ...opts.iterate, signal: opts.signal, emit: opts.emit })
    modelCalls += res.modelCalls
    const certified = res.status === 'solved' && !!res.solution
    rungs.push({ name: h.name, status: res.status, bestScore: res.bestScore, modelCalls: res.modelCalls, certified })
    if (!certified) {
      return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `helper \`${h.name}\` did not certify — ${res.detail}` }
    }
    helpers.push({ name: h.name, source: res.solution!.value })
    emit({ type: 'thought', text: `subfn: helper \`${h.name}\` certified (${modelCalls} calls so far)` })
  }

  // 3) COMPOSITION rung: write the top-level function calling the certified helpers. The
  //    verifier prepends the helper sources and runs the FULL module against the ORIGINAL
  //    cases, so what we certify is the whole, not just the top function in isolation.
  const helperBlock = helpers.map((h) => h.source).join('\n\n')
  const composeSpec: TaskSpec = {
    goal: `${input.goal}\n\nYou may CALL these already-implemented and tested helpers (they are defined in the same module — do NOT redefine them): ${helpers.map((h) => '`' + h.name + '`').join(', ')}.`,
    domain: 'code',
    context: [input.context, `${WEB_GROUND_MARK}\n${helperBlock}`].filter(Boolean).join('\n\n'),
    acceptance: {
      entry: input.entry,
      entries: input.entries && input.entries.length > 1 ? input.entries : undefined,
      cases: input.cases, timeoutMs: input.timeoutMs,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
  // Verify (helpers + candidate) as one module. The proposer only writes the top function.
  const composingVerifier: Verifier<string> = (cand, spec) =>
    verifyCode({ value: `${helperBlock}\n\n${cand.value}`, fingerprint: cand.fingerprint }, spec)

  const composeProposer = withRetrieval(proposer, input.entry, input.nl ?? input.goal, input.cases, webGround, buildCodeSearchQuery(input.nl ?? input.goal), opts.emit)
  const composed = await iterate<string>(composeSpec, composeProposer, composingVerifier, { mergeAcceptance: mergeCodeAcceptance, research: researchFor(input.nl ?? input.goal), ...opts.iterate, signal: opts.signal, emit: opts.emit })
  modelCalls += composed.modelCalls
  const composedCert = composed.status === 'solved' && !!composed.solution
  rungs.push({ name: `compose:${input.entry}`, status: composed.status, bestScore: composed.bestScore, modelCalls: composed.modelCalls, certified: composedCert })
  if (!composedCert) {
    return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `composition of ${input.entry} did not certify — ${composed.detail}` }
  }

  // 4) Final artifact = helpers + top. Re-verify with the PLAIN original verifier as a guard
  //    (identical check to the composing verifier, made explicit for soundness).
  const fullModule = `${helperBlock}\n\n${composed.solution!.value}`
  const guard = await verifyCode({ value: fullModule, fingerprint: 'subfn-composed' }, composeSpec)
  if (!guard.pass) {
    return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `composed module failed final re-verify: ${guard.signals.slice(0, 3).join('; ')}` }
  }
  return { status: 'solved', code: fullModule, helpers, rungs, modelCalls, detail: `sub-function decomposition solved ${input.entry} via ${helpers.length} helper(s), ${modelCalls} model call(s)` }
}

export interface CodingRequestResult {
  /** 'solved' → certified code in .code; 'abstained' → no trustworthy spec/solution. */
  status: SearchResult<string>['status'] | 'abstained'
  code: string | null
  entry: string | null
  cases: CodeAcceptance['cases'] | null
  search: SearchResult<string> | null
  detail: string
  /**
   * Present only when the opt-in `converge` loop produced this solution. `epochs > 1` means the
   * convergence loop actually EARNED the answer (single-shot would have stalled) — the signal we
   * watch to decide whether converge is worth turning on by default. Absent on the single-shot path.
   */
  converged?: { epochs: number; modelCalls: number }
}

/**
 * FULL doctrine loop from a bare natural-language request:
 *
 *   NL ──► extractCodeSpec (model proposes cases, consensus filter certifies the spec)
 *      ──► solveCodeTask (propose→execute→backtrack until a case-passing impl is certified)
 *      ──► certified code | HONEST ABSTAIN
 *
 * This is what the live /api/chat coding path should call. It NEVER returns unverified
 * code: if no trustworthy spec forms, or the loop can't certify an implementation within
 * budget, `status` is a non-'solved' value and `code` is null. Abstain means abstain.
 */
export async function solveCodingRequest(
  nl: string,
  opts: SearchOpts & {
    specSamples?: number
    specComplete?: Completer
    differential?: DifferentialOpts | false
    /**
     * Opt-in convergence: on the case-based tiers (differential, model-invents), drive the
     * search with iterate() so it keeps climbing across epochs and injects research on a
     * stall, instead of a single bounded search(). A pure ADD — it can only certify MORE
     * (a non-solve falls straight through to today's single-shot + poisoned-case recovery).
     * Pass tuning via `iterate` (epoch/budget caps, differential opts for the research fn).
     */
    converge?: boolean
    iterate?: Partial<IterateOpts<string>>
    /**
     * Injected WEB retriever for the research loop's channel 3: on a stall, fetch reference
     * implementations/snippets from the open web for `nl`, folded into PROPOSER grounding (never
     * a verifier value — the candidate is still executed against the spec). Kept out of this pure
     * module; the server provides the network-backed implementation. Only active on the converge
     * path (that's where research runs). Absent → no web grounding.
     */
    webGround?: (query: string) => Promise<string | null>
    /**
     * For repair/edit requests: the current broken implementation (e.g. the target file's
     * existing source). Threaded into every solveCodeTask call so the first proposal is seeded
     * with the buggy code's executed failure evidence — the loop localizes the bug on call #1
     * instead of burning a model call rediscovering which cases fail. Pure sample-efficiency;
     * certification is unchanged (every candidate is still executed against the spec).
     */
    buggyCode?: string
    /**
     * LAST-RESORT SUB-FUNCTION DECOMPOSITION (item 2, 2026-07-22). When a case-based tier's flat
     * search AND its poisoned-case recovery both fail, escalate to decomposeCodeBySubFunction: ask
     * the (untrusted) model to carve the goal into small helpers, certify each on its own tiny
     * spec, then verify the composed module against the ORIGINAL cases. This is the lever for the
     * genuinely-hard tasks the pass@k experiment showed stay 0% no matter how many times you draw
     * (basicCalculator: precedence-without-parens) — where more sampling can't help but a smaller
     * step can. Sound by construction (every rung + the whole are verifier-certified, and the
     * result still clears invariantGate). OFF by default: it spends several sub-searches, so the
     * server turns it on only for demonstrably-hard attempts. Absent → the ladder is unchanged.
     */
    decompose?: boolean
  } = {},
): Promise<CodingRequestResult> {
  // Shared converging attempt for the case-based tiers. Returns a solved CodingRequestResult
  // or null (→ caller falls through to the single-shot path, preserving recovery/metaGate).
  const tryConverge = async (
    entry: string, cases: CodeAcceptance['cases'], detailPrefix: string,
  ): Promise<CodingRequestResult | null> => {
    if (!opts.converge) return null
    const it = await iterateCodeTask({ goal: nl, nl, entry, cases, webGround: opts.webGround }, {
      signal: opts.signal, emit: opts.emit, ...opts.iterate,
    })
    if (it.status === 'solved' && it.solution && await invariantGate(it.solution.value, entry)) {
      return {
        status: 'solved', code: it.solution.value, entry, cases, search: null,
        detail: `${detailPrefix} → converged in ${it.epochs} epoch(s) (${it.modelCalls} model call(s)); ${it.detail}`,
        converged: { epochs: it.epochs, modelCalls: it.modelCalls },
      }
    }
    return null
  }

  // Ground-truth priority (DOCTRINE.md — trust order): 1) the USER's own worked examples (gold),
  // 2) a NAME-GATED PROPERTY (sort=sorted-permutation, codec=roundtrip, …; a true invariant),
  // 2.5) a METAMORPHIC RELATION detected from the SPEC TEXT (name-independent; also a true
  // invariant, so it reaches custom-named sort/reverse the whitelist misses and cannot be fooled
  // by a shared systematic bug), 3) DIFFERENTIAL CONSENSUS (system-fuzzed inputs + agreement across
  // independently-written implementations — no name whitelist, so it reaches ARBITRARY functions),
  // 4) only as a last resort, model-invented consensus cases (model picks BOTH input and output,
  // so it can be confidently wrong — the vote-bias trap). Each tier is preferred over the next
  // because it removes a source of model bias: true invariants (2, 2.5) remove it entirely;
  // differential removes input-selection bias and grounds outputs in executed code, not a value.

  // 1) USER-stated examples — gold, trusted without consensus.
  const harvested = harvestExplicitExamples(nl)
  if (harvested.cases.length >= 1) {
    const result = await solveCodeTask({ goal: nl, entry: harvested.entry, entries: harvested.entries, cases: harvested.cases, buggyCode: opts.buggyCode }, opts)
    const nFns = harvested.entries.length
    return {
      status: result.status,
      code: result.status === 'solved' ? (result.solution?.value ?? null) : null,
      entry: harvested.entry, cases: harvested.cases, search: result,
      detail: `${harvested.cases.length} user example(s) (gold)${nFns > 1 ? ` across ${nFns} functions [${harvested.entries.join(', ')}]` : ''}; ${result.detail}`,
    }
  }

  // 2) A GENERAL PROPERTY, when a high-confidence family matches.
  const prop = derivePropertySpec(nl)
  if (prop) {
    const spec: TaskSpec = {
      goal: nl, domain: 'code',
      acceptance: { entry: prop.entry, family: prop.family, assertions: prop.assertions } as unknown as Record<string, unknown>,
    }
    const result = await search(spec, proposeCode, verifyByProperty as Verifier<string>, opts)
    return {
      status: result.status,
      code: result.status === 'solved' ? (result.solution?.value ?? null) : null,
      entry: prop.entry, cases: null, search: result,
      detail: `no example → ${prop.family} property spec (${prop.assertions.length} propert${prop.assertions.length === 1 ? 'y' : 'ies'}); ${result.detail}`,
    }
  }

  // 2.5) METAMORPHIC RELATION from the SPEC TEXT (name-independent, un-foolable). Catches the
  // custom-named cases the name-gated property whitelist misses (`arrange` "ascending", `flipOrder`
  // "reversed"). Certifies against a COMPLETE relation set (sort = permutation ∧ ordered; reverse =
  // position-map) — a true invariant, so it cannot be fooled by a systematic bug shared across
  // samples the way value-consensus can. Ranked above differential precisely for that reason.
  const meta = deriveMetamorphicSpec(nl)
  if (meta) {
    const spec: TaskSpec = {
      goal: nl, domain: 'code',
      acceptance: { entry: meta.entry, family: meta.family, assertions: meta.assertions } as unknown as Record<string, unknown>,
    }
    // CANONICAL FAST-PATH — "Crucible IS the model." For a known class the correct impl is
    // known; emit the verified reference (ZERO model calls) and certify it against the SAME
    // invariant before shipping. A reference that fails the invariant (user tweaked the spec)
    // falls through to the search. This is the fastest, most 0-API path in the engine.
    const canon = canonicalImpl(meta)
    if (canon) {
      try {
        const v = await verifyByProperty({ value: canon, fingerprint: 'canonical' }, spec)
        if (v.pass) {
          return { status: 'solved', code: canon, entry: meta.entry, cases: null, search: null as never,
            detail: `no example → ${meta.family} canonical reference (0 model calls, certified against ${meta.assertions.length} invariant${meta.assertions.length === 1 ? '' : 's'})` }
        }
      } catch { /* fall through to the search */ }
    }
    const result = await search(spec, proposeCode, verifyByProperty as Verifier<string>, opts)
    if (result.status === 'solved') {
      return { status: result.status, code: result.solution?.value ?? null, entry: meta.entry, cases: null, search: result,
        detail: `no example → ${meta.family} metamorphic spec (${meta.assertions.length} relation${meta.assertions.length === 1 ? '' : 's'}); ${result.detail}` }
    }
    // Not solved by the metamorphic relation → fall through (a mis-detected class shouldn't block).
  }

  // A STRONG metamorphic invariant is ground truth. If one exists but its own search didn't
  // converge, the LOWER tiers (differential / model-invented) must NOT be allowed to certify a
  // candidate the invariant would REJECT — that is exactly the shared-systematic-bug hole
  // (observed live 2026-07-11: 4 sampled slugify impls all left doubled/edge hyphens, so
  // differential "agreed" on the wrong output). Gate every lower-tier solution through it.
  const metaGate = async (code: string | null): Promise<boolean> => {
    if (!meta || !code) return true
    try {
      const v = await verifyByProperty({ value: code, fingerprint: 'metagate' },
        { goal: nl, domain: 'code', acceptance: { entry: meta.entry, family: meta.family, assertions: meta.assertions } } as unknown as TaskSpec)
      return v.pass
    } catch { return true }  // a gate error must not block an otherwise-valid path
  }

  // W20 — INDEPENDENT HELD-OUT INVARIANT GATE (2026-07-22b). The lowest tiers (differential /
  // model-invented consensus) certify against cases whose OUTPUTS the system fuzzed or the model
  // guessed — a systematic bug shared across samples can slip a wrong impl past them (the live
  // `csvLine` shape: VGR-certified on a weak self-extracted spec, 11 hidden fails). Splitting the
  // already-thin consensus pool into visible+held-out just starves the proposer, so instead we
  // hold out a MODEL-FREE property family as the independent ground truth: `supplementalPropertySpec`
  // resolves the entry to one of ~30 exact-name-gated invariant families (factorial, gcd, unique,
  // max, clamp, reverse…) whose assertions hold for EVERY correct implementation. When one matches,
  // a lower-tier solution must satisfy it too — the proposer still drives on the cases (no
  // starvation), but a candidate that overfits weak cases yet violates the invariant is rejected.
  // Distinct from `meta` (metamorphic relations) and only reached when `derivePropertySpec` did NOT
  // already fire as the PRIMARY verifier, so it never double-gates a path the property tier owns.
  const supp = supplementalPropertySpec(nl)
  // Only enforce the supplemental invariant when its exact-name-gated family resolves to the
  // SAME function the tier actually certified — a name mismatch would run assertions against an
  // undefined export and wrongly reject a correct impl. `entry` defaults to supp.entry so a
  // caller that omits it keeps the strict-match behavior.
  const suppGate = async (code: string | null, entry?: string): Promise<boolean> => {
    if (!supp || !code) return true
    if (entry !== undefined && entry !== supp.entry) return true
    try {
      const v = await verifyByProperty({ value: code, fingerprint: 'suppgate' },
        { goal: nl, domain: 'code', acceptance: { entry: supp.entry, family: supp.family, assertions: supp.assertions } } as unknown as TaskSpec)
      return v.pass
    } catch { return true }  // a gate error must not block an otherwise-valid path
  }
  // A lower-tier certification must clear BOTH independent invariant gates. Neither fires unless
  // its family matched (and, for supp, the certified entry matches), so on a task with no known
  // invariant this is a transparent no-op.
  const invariantGate = async (code: string | null, entry?: string): Promise<boolean> =>
    (await metaGate(code)) && (await suppGate(code, entry))

  // LAST-RESORT DECOMPOSITION (item 2). A case-based tier that could neither certify a flat
  // candidate nor recover a poisoned case escalates here before it abstains: carve the goal into
  // small verifier-certified helpers and re-verify the composed whole against the SAME cases. Only
  // fires when `decompose` is on and there are enough cases to both carve helpers and re-verify
  // meaningfully. Sound: decomposeCodeBySubFunction re-runs the full module against these cases,
  // and we still clear invariantGate — a decomposition can only certify a genuinely-correct impl.
  // Returns a solved result or null (→ caller keeps its honest non-solve).
  const tryDecompose = async (
    entry: string, cases: CodeAcceptance['cases'], detailPrefix: string,
  ): Promise<CodingRequestResult | null> => {
    if (!opts.decompose || opts.signal?.aborted) return null
    if (cases.length < 3) return null
    const d = await decomposeCodeBySubFunction(
      { goal: nl, nl, entry, cases },
      { webGround: opts.webGround, signal: opts.signal, emit: opts.emit, iterate: opts.iterate },
    )
    if (d.status === 'solved' && d.code && await invariantGate(d.code, entry)) {
      return {
        status: 'solved', code: d.code, entry, cases, search: null,
        detail: `${detailPrefix}; flat search abstained → sub-function decomposition certified via ${d.helpers.length} helper(s) (${d.modelCalls} model call(s))`,
      }
    }
    return null
  }

  // 3) DIFFERENTIAL CONSENSUS — for arbitrary functions with no named-property family. The
  // SYSTEM fuzzes the inputs (no input bias) and independently-written implementations vote on
  // the outputs by EXECUTION (a far harder oracle than a model stating a value). Preferred over
  // the model-invents-both path below because neither the inputs nor the outputs are model-chosen.
  // Skipped only when a caller explicitly disables it (differential:false).
  if (opts.differential !== false) {
    const diff = await deriveDifferentialSpec(nl, { ...opts.differential })
    if (diff.ok && diff.spec) {
      const { entry, cases } = diff.spec
      // EARLY CLASS-ROUTING (2026-07-22l). A class that is provably 0% by sampling (arithmetic/parser
      // precedence — pass@k flat is zero, live-measured) must NOT spend the whole budget on flat
      // tryConverge → solveCodeTask → poisoned-case recovery before it ever reaches decompose (that is
      // exactly why the agent-path scorecard for basicCalculator TIMED OUT at 420s while the direct
      // decompose probe solved it in 7 calls). When the class is detected and decompose is enabled,
      // CARVE FIRST. Sound: tryDecompose re-verifies the composed whole against these same cases and
      // clears invariantGate; on any non-solve we fall straight through to the normal ladder, so a
      // misdetection costs at most one decompose attempt and never changes what can certify.
      if (isArithmeticExprGoal(nl, entry)) {
        const early = await tryDecompose(entry, cases, `${diff.detail} · arithmetic-class early-carve`)
        if (early) return early
      }
      const conv = await tryConverge(entry, cases, diff.detail)
      if (conv) return conv
      const result = await solveCodeTask({ goal: nl, entry, cases, buggyCode: opts.buggyCode }, opts)
      if (result.status === 'solved' && await invariantGate(result.solution?.value ?? null, entry)) {
        const gated = [meta && `${meta.family}`, supp && `${supp.family}`].filter(Boolean).join(' + ')
        return { status: result.status, code: result.solution?.value ?? null, entry, cases, search: result,
          detail: `${diff.detail}${gated ? ` (also passed the ${gated} invariant)` : ''}; ${result.detail}` }
      }
      // A differentially-agreed case can still be poisoned by a shared systematic bug — the same
      // cross-derivation recovery applies (independent impls unanimously failing ONE case → drop it).
      const rec = await recoverFromPoisonedCase(entry, cases, result.attempts)
      if (rec && await invariantGate(rec.code, entry)) {
        return { status: 'solved', code: rec.code, entry, cases: rec.cleaned, search: result,
          detail: `${diff.detail}; dropped 1 suspect case (${rec.nAgree} independent impls agreed it was wrong), certified against ${rec.cleaned.length}` }
      }
      // Neither flat search nor recovery certified → escalate to sub-function decomposition (the
      // hard-task lever) before conceding the differential path.
      const dec = await tryDecompose(entry, cases, diff.detail)
      if (dec) return dec
      // Fall through to the weaker path only if differential could not certify.
    }
  }

  // 4) Last resort — model-invented consensus cases (bias-prone; used only when nothing better).
  const extraction = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
  if (extraction.ok && extraction.spec) {
    const { entry, cases } = extraction.spec
    const conv = await tryConverge(entry, cases, extraction.detail)
    if (conv) return conv
    const result = await solveCodeTask({ goal: nl, entry, cases, buggyCode: opts.buggyCode }, opts)
    if (result.status === 'solved' && await invariantGate(result.solution?.value ?? null, entry)) {
      const gated = [meta && `${meta.family}`, supp && `${supp.family}`].filter(Boolean).join(' + ')
      return { status: result.status, code: result.solution?.value ?? null, entry, cases, search: result,
        detail: `${extraction.detail}${gated ? ` (also cleared the ${gated} invariant)` : ''}; ${result.detail}` }
    }
    // Recovery: a model-invented case may be WRONG, making a solvable spec unsatisfiable. If
    // multiple INDEPENDENT candidates unanimously fail the SAME single case (and pass all
    // others), that case — not the code — is the bad one (cross-derivation agreement). Drop it
    // and re-certify against the cleaned set. Never ships code failing a case we still trust.
    const rec = await recoverFromPoisonedCase(entry, cases, result.attempts)
    if (rec && await invariantGate(rec.code, entry)) {
      return { status: 'solved', code: rec.code, entry, cases: rec.cleaned, search: result,
        detail: `${extraction.detail}; dropped 1 suspect case (${rec.nAgree} independent impls agreed it was wrong), certified against the remaining ${rec.cleaned.length}` }
    }
    // Final escalation on the weakest tier: carve into certified helpers before abstaining.
    const dec = await tryDecompose(entry, cases, extraction.detail)
    if (dec) return dec
    return { status: result.status, code: null, entry, cases, search: result,
      detail: `${extraction.detail}; ${result.detail}` }
  }

  return { status: 'abstained', code: null, entry: null, cases: null, search: null,
    detail: `could not form a checkable spec: ${extraction.reason ?? 'unknown'}` }
}

/**
 * Cross-derivation recovery for a suspected-poisoned model-invented case. Given the failed
 * attempts, find candidates that pass ALL cases but one; if ≥2 DISTINCT candidates fail the
 * SAME single case, that case is the bad ground truth (independent implementations agreeing
 * outweigh one model-invented value). Drop it and certify a candidate against the rest.
 * Returns null (→ honest exhaust) unless the evidence is strong. Uses NO model calls.
 */
export async function recoverFromPoisonedCase(
  entry: string,
  cases: CodeAcceptance['cases'],
  attempts: SearchResult<string>['attempts'],
): Promise<{ code: string; cleaned: CodeAcceptance['cases']; nAgree: number } | null> {
  if (cases.length < 3) return null  // dropping a case must leave a spec still worth trusting (≥2)

  // Distinct candidate sources, best-scoring first, capped for cost.
  const seen = new Set<string>()
  const cands: string[] = []
  for (const a of [...attempts].sort((x, y) => y.verdict.score - x.verdict.score)) {
    if (seen.has(a.candidate.fingerprint)) continue
    seen.add(a.candidate.fingerprint); cands.push(a.candidate.value)
    if (cands.length >= 5) break
  }

  // For each candidate, the set of case-indices it FAILS (per-case execution; no model).
  const failMap = new Map<string, number[]>()
  for (const code of cands) {
    const failing: number[] = []
    for (let i = 0; i < cases.length; i++) {
      const v = await verifyCode({ value: code, fingerprint: 'x' },
        { goal: '', domain: 'code', acceptance: { entry, cases: [cases[i]] } as unknown as Record<string, unknown> })
      if (!v.pass) failing.push(i)
    }
    failMap.set(code, failing)
  }

  // Candidates that fail EXACTLY one case → vote for that case being the poison.
  const votes = new Map<number, string[]>()
  for (const [code, failing] of failMap) {
    if (failing.length === 1) {
      const idx = failing[0]
      const list = votes.get(idx) ?? []; list.push(code); votes.set(idx, list)
    }
  }
  // A suspect case needs ≥2 independent implementations agreeing it (and only it) is wrong.
  let suspect = -1, nAgree = 0
  for (const [idx, voters] of votes) if (voters.length > nAgree) { suspect = idx; nAgree = voters.length }
  if (suspect < 0 || nAgree < 2) return null

  const cleaned = cases.filter((_, i) => i !== suspect)
  const winner = votes.get(suspect)![0]
  // Certify the winner against the cleaned set before returning — never ship uncertified.
  const finalV = await verifyCode({ value: winner, fingerprint: 'x' },
    { goal: '', domain: 'code', acceptance: { entry, cases: cleaned } as unknown as Record<string, unknown> })
  if (!finalV.pass) return null
  return { code: winner, cleaned, nAgree }
}
