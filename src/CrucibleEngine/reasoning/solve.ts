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

import { proposeCode, proposeCodeBatch, proposeCodeMany, structuralFingerprint } from './codeProposer'
import { type CodeAcceptance, verifyCode } from './codeVerifier'
import { makeCodeResearchFn, mergeCodeAcceptance, buildCodeSearchQuery, WEB_GROUND_MARK } from './codeResearch'
import { deriveDifferentialSpec, type DifferentialOpts } from './differentialSpec'
import { iterate, type IterateOpts, type IterateResult } from './iterate'
import { solveByDecomposition, type DecomposeResult, type Planner, type SubSpecFactory } from './decompose'
import { makeFmPlanner, makeFmSubFunctionPlanner, hasDecomposeTemplate, composeHintFor, decomposePerRungBudget } from './fmPlanner'
import { probeCarve, skewRungBudget, type CarveProbe } from './traceCarve'
import { deriveMetamorphicSpec, canonicalImpl } from './metamorphicSpec'
import { derivePropertySpec, supplementalPropertySpec, verifyByProperty } from './propertyVerifier'
import { search, type SearchOpts } from './search'
import { type Completer, extractCodeSpec, harvestExplicitExamples } from './specExtractor'
import { makeRetrievalProposer, composeProposers } from './retrievalProposer'
import { makeMutationRepairProposer } from './mutationRepair'
import { makeMechanicalRepairProposer } from './mechanicalRepair'
import type { Attempt, Proposer, SearchResult, TaskSpec, Verifier } from './types'

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
  opts: SearchOpts<string> = {},
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
  // SIGNAL-DIRECTED MECHANICAL REPAIR (2026-07-26) — composed ahead of the FM on every live
  // synthesis, not just repair tasks. Measured motivation (__direct_vs_decompose_live.ts, 3 runs
  // × 10 tasks × 8 draws): roughly a THIRD of terminal best-of-8 failures were not reasoning
  // failures — the head had the right algorithm and lost to a JS gotcha the verifier NAMES
  // ("Assignment to constant variable", `"lastNumber" has already been declared`,
  // "frequencyMap.entries(...).sort is not a function"). Redrawing costs ~4000ms and usually
  // reproduces the same idiom; the licensed deterministic edit costs ~36ms and the verifier
  // certifies it. Unlike makeMutationRepairProposer this needs no `buggyCode`: it repairs the
  // last FAILING ATTEMPT using that attempt's own signals, which only exist mid-search.
  // Sound + free: every repair is still executed against the same acceptance cases, and the
  // candidate carries modelFree so it never charges the model-call budget.
  const base: Proposer<string> = proposerOverride ?? proposeCode
  const proposer: Proposer<string> = proposerOverride
    ? base
    : composeProposers(
        makeMechanicalRepairProposer(),
        input.buggyCode ? composeProposers(makeMutationRepairProposer(input.buggyCode), base) : base,
      )
  const verifier: Verifier<string> = verifyCode
  // W3 continuous batching on the LIVE path (opt-in via CRUCIBLE_VGR_BATCH=1). Only when the
  // proposer is the PLAIN FM proposer — a composed proposer (mutation-repair fast-path, or a test
  // override) has per-call ordering semantics the flat batch draw would flatten, so those keep the
  // serial path. proposeCodeMany draws a whole round's slots across llama-server KV slots at once;
  // search()'s batch path is proven accounting-identical to serial (see __search_batch_bench).
  // Key the batch decision off the BASE proposer, not the composed one. The mechanical-repair
  // wrapper is now always present on the live path, so `proposer === proposeCode` would be
  // permanently false and would silently disable the opt-in batch path. Note the real trade this
  // encodes: search() ignores `proposer` entirely when a batchProposer is supplied, so the
  // mechanical repair does NOT fire on the batch path. That is acceptable while batching is
  // opt-in and off by default; wiring repair into the batch path means teaching search.ts to run
  // it on a failing verdict, which is a change to the shared engine and is deliberately deferred.
  const useBatch = process.env.CRUCIBLE_VGR_BATCH === '1' && !opts.batchProposer &&
    base === proposeCode && !input.buggyCode
  // BATCH-PATH SAMPLE BUMP (item 3, 2026-07-22). The pass@k experiment proved the loop is STARVED,
  // not weak: pass@1 52.5% → pass@10 83.3% — the correct answer is in the distribution, just rare,
  // so drawing MORE candidates per round converts directly to solves. Batching makes concurrent
  // draws ~free (the K slots decode together), so on the batch path we raise proposalsPerNode from 1
  // to `CRUCIBLE_VGR_BATCH_PROPOSALS` (default 4) — 4-8 draws/round is exactly where the curve says
  // the marginal draw still pays. A matching maxModelCalls scale keeps the ROUND count constant
  // (each round now spends proposalsPerNode× the calls), so the loop explores as many rounds as
  // before but K× wider — never fewer rounds than the serial budget would have run. Capped so a
  // pathological caller budget can't run away. A caller that set proposalsPerNode explicitly wins.
  // ANTI-ANCHOR: hand search the structural key so a cosmetic re-emission of an already-drawn
  // control structure counts as stagnation (it is still verified — see SearchOpts.structuralKey).
  // A caller that supplied its own key keeps it.
  const searchOpts: SearchOpts<string> = useBatch
    ? { structuralKey: structuralFingerprint, ...opts, ...batchBudget(opts), batchProposer: proposeCodeMany }
    : { structuralKey: structuralFingerprint, ...opts }
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
 * Remove any top-level `function <name>` / `export function <name>` definition of a CERTIFIED
 * helper from a composition candidate, so the certified helper block can be prepended without a
 * duplicate-declaration compile error. The weak proposer, told to "return the full module", often
 * RE-DECLARES the helpers it was handed; concatenating that with the certified block yields
 * `Multiple exports with the same name` and the model then anchors on the same failing output
 * ("duplicate proposal (stuck)") — the exact wall the editDistance composition hit (2026-07-23).
 *
 * SOUND regardless of accuracy: this only strips redefinitions so the CERTIFIED helper sources win.
 * If it mangles the candidate, the composition fails the ORIGINAL cases and collapses honestly — it
 * can never make a wrong answer pass (composition re-verify owns truth). Brace-matched, string/
 * comment naïve (worst case a stray brace under-strips → the old duplicate-error path, still safe).
 */
export function stripHelperRedefinitions(src: string, helperNames: string[]): string {
  let out = src
  for (const name of helperNames) {
    const sig = new RegExp(`(?:export\\s+)?function\\s+${name}\\b`)
    // Repeat: a candidate could (pathologically) declare the same helper twice.
    for (let guard = 0; guard < 8; guard++) {
      const m = sig.exec(out)
      if (!m) break
      const start = m.index
      const brace = out.indexOf('{', start)
      if (brace === -1) break
      let depth = 0, end = -1
      for (let i = brace; i < out.length; i++) {
        if (out[i] === '{') depth++
        else if (out[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
      }
      if (end === -1) break // unbalanced — leave it (verify will reject the whole honestly)
      out = (out.slice(0, start) + out.slice(end)).replace(/\n{3,}/g, '\n\n')
    }
  }
  return out.trim()
}

/**
 * Extract ONLY the `function <name>` / `export function <name>` definition of `name` from a
 * source string, dropping everything else. A helper rung is certified as a whole MODULE, and the
 * weak model — grounded with the prior helpers this one calls — routinely returns those prior
 * helpers redefined ALONGSIDE the target. If we captured that whole module as the helper's
 * `source`, concatenating helper sources for the composition would collide (`Multiple exports with
 * the same name`) — the wall the editDistance carve hit even after the candidate was clean
 * (2026-07-23). Keeping only the helper's OWN function makes each helper appear exactly once in the
 * block; cross-references resolve against the other (certified) helpers in the same block. Sound:
 * behavior is re-verified against the ORIGINAL cases downstream. Returns src unchanged if the named
 * function isn't found or its braces don't balance (best effort — verify still owns truth).
 */
export function extractOwnFunction(src: string, name: string): string {
  const sig = new RegExp(`(?:export\\s+)?function\\s+${name}\\b`)
  const m = sig.exec(src)
  if (!m) return src.trim()
  const start = m.index
  const brace = src.indexOf('{', start)
  if (brace === -1) return src.trim()
  let depth = 0, end = -1
  for (let i = brace; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end === -1) return src.trim()
  return src.slice(start, end).trim()
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
    /**
     * RECURSIVE DECOMPOSITION depth. When a helper rung can't be certified by flat iterate, the
     * loop re-applies decomposition to THAT helper (its goal + FM-proposed sub-plan) before giving
     * up — so a task whose natural carve still contains a sub-helper too hard for the weak head one-
     * shot is subdivided further, rather than collapsing the whole plan. `depth` is the current
     * recursion level (0 at the top call); recursion fires only while `depth < maxDepth`. Sound at
     * every level: a recursively-solved helper is a module re-verified against ITS OWN cases, and
     * the parent's composed whole is still re-verified against the ORIGINAL cases, so recursion can
     * subdivide the search but never fabricate a certification. General path only (no custom planner).
     */
    depth?: number
    /** Max recursion levels for the above. Default 1 (one level of sub-decomposition). */
    maxDepth?: number
    /**
     * Helpers already CERTIFIED by a parent level, handed down so this level's module contains them
     * (compose verifies helpers + candidate as one module). Set only by the glue re-decomposition —
     * callers pass nothing. Sound: these sources were certified against their own cases upstream and
     * whatever is built on them is still re-verified as a whole against the original cases here.
     */
    preHelpers?: { name: string; source: string }[]
    /**
     * CARVE PROBE (2026-07-26) — spend ONE draw drafting the whole carve, then trace it, BEFORE
     * committing a per-rung budget to a plan nobody has checked. See traceCarve.ts for the full
     * argument; in short it (a) sometimes just solves the task in 1 call, (b) replaces the
     * planner's INVENTED helper outputs with GOLD-WITNESSED ones, and (c) exposes rungs a working
     * composition never calls. Defaults ON for the FM-general path; set false (or
     * `CRUCIBLE_CARVE_PROBE=0`) to measure the un-probed carve in isolation — which is what the
     * general scorecard needs in order to keep reporting carve quality rather than probe luck.
     */
    traceProbe?: boolean
    /**
     * SHARED CALL LEDGER (2026-08-01) — makes the carve's TOTAL budget exact.
     *
     * `iterate.globalModelCalls` is a PER-CALL cap, and a carve issues one `iterate()` per rung,
     * one to compose, and up to `planAttempts` times over — so an N-rung carve clamped to the
     * ladder's remainder could still spend N × that remainder. Same defect the wall-clock had
     * before `IterateOpts.deadline`, on the call axis: a per-invocation quantity used as a
     * whole-task ceiling. `left()` is read fresh before every iterate call and the per-call cap is
     * clamped to the amount the carve has NOT yet spent (its own running `modelCalls`, which
     * already bills the planner draw and the probe). Undefined → unbounded, exactly as before.
     *
     * Only ever TIGHTENS: a nested level (helper recursion, glue re-decomposition) is handed a
     * ledger derived from this one, so a child can never widen the ceiling it inherited.
     */
    budget?: { left: () => number }
  } = {},
  proposerOverride?: Proposer<string>,
  /**
   * Certified helpers inherited from a PARENT level (glue re-decomposition), so a sub-plan that
   * re-proposes an identical rung reuses the proven source at zero model cost. Was previously passed
   * by the glue call site as a 4th argument to a 3-parameter function — silently dropped by JS, and
   * invisible because no build typechecks this directory (tsconfig.json is `files: []` referencing
   * only app+node; tsconfig.server.json is referenced by nothing).
   */
  carrySeed?: Map<string, { source: string; spec: string }>,
): Promise<SubFunctionResult> {
  const emit = opts.emit ?? (() => {})
  const planAttempts = Math.max(1, opts.planAttempts ?? 3)
  // Retry the WHOLE decomposition on an honest collapse — a fresh (stochastic) plan each time.
  // Stop early on solve, decline (planner has nothing), or abort (reality budget/cancel).
  let last: SubFunctionResult | null = null
  let spentCalls = 0
  // Persists certified helpers across attempts so a retry re-grinds only the rung that failed,
  // not the easy ones it already got (the DP-fold scorecard showed a failed editDistance re-running
  // subCost/nextRow + a full editRow window every attempt → ~1200s). Reuse is exact-SPEC-gated.
  const carry = new Map<string, { source: string; spec: string }>(carrySeed ?? [])
  // The shared wall-clock deadline is fixed HERE, above the retry loop, not inside the attempt.
  // Computed per attempt it would reset `planAttempts` times over, which is the same multiplication
  // it exists to stop — a 180s budget × 3 attempts × N rungs is how a capped task reached 955s.
  // An inherited deadline always wins, so a nested level can only ever tighten the ceiling.
  const deadlineOpts = opts.iterate?.deadline !== undefined || opts.iterate?.wallClockMs === undefined
    ? opts
    : { ...opts, iterate: { ...opts.iterate, deadline: Date.now() + opts.iterate.wallClockMs } }
  // The call ledger spans the RETRY LOOP too, for the same reason the deadline does: three plan
  // attempts each clamped to the caller's remainder is three times the caller's remainder. Each
  // attempt sees the ledger minus what earlier attempts already spent.
  const outerBudget = opts.budget
  const attemptOpts = outerBudget === undefined
    ? deadlineOpts
    : { ...deadlineOpts, budget: { left: () => Math.max(0, outerBudget.left() - spentCalls) } }
  for (let attempt = 0; attempt < planAttempts; attempt++) {
    if (opts.signal?.aborted) break
    // Out of calls mid-retry: stop rather than start an attempt that can only abstain.
    if (outerBudget !== undefined && outerBudget.left() - spentCalls <= 0) {
      emit({ type: 'thought', text: 'subfn: model-call budget exhausted — no further plan attempts' })
      break
    }
    if (attempt > 0) emit({ type: 'thought', text: `subfn: plan attempt ${attempt + 1}/${planAttempts} (prior plan collapsed)` })
    const r = await runSubFunctionOnce(input, attemptOpts, proposerOverride, carry)
    spentCalls += r.modelCalls
    last = { ...r, modelCalls: spentCalls }
    if (r.status === 'solved' || r.status === 'declined' || r.status === 'aborted') return last
    // else decompose-failed → resample the plan and try again
  }
  return last ?? { status: 'declined', code: null, helpers: [], rungs: [], modelCalls: spentCalls, detail: 'no plan attempts run' }
}

/**
 * PLAN-QUALITY predicate for the code decompose path. A single-helper carve is degenerate — the
 * lone helper does all the work and compose just calls it (the FM "re-baked the whole difficulty
 * into one un-certifiable helper"), so it should fail fast and resample rather than burn a rung
 * budget. Fires ONLY on the FM general path: trusted template classes (always ≥2 helpers) and
 * caller-supplied planners (tests) are exempt. Pure — unit-tested in __decompose_bench.
 */
export function isDegenerateSubFnCarve(hasCustomPlanner: boolean, helperCount: number, hasTemplate: boolean): boolean {
  return !hasCustomPlanner && helperCount < 2 && !hasTemplate
}

/**
 * The identity of a RUNG's problem — its goal AND its acceptance cases — used to decide whether a
 * helper certified on an earlier plan attempt may be reused verbatim (carry-forward).
 *
 * Keying on the goal alone was already loose (a stochastic re-plan can keep a one-line purpose and
 * change its examples) and the carve probe makes it wrong outright: the probe rewrites a rung's
 * cases from trace evidence while preserving its goal, so a goal-only key would report a rung
 * `certified` under a spec nothing ever checked it against. Pure — unit-tested in __decompose_bench.
 *
 * SIBLING CONTEXT (2026-08-01). Goal+cases is still not the whole spec of a rung: a certified
 * helper's SOURCE may call its siblings (context hygiene grounds each rung on the prior helpers its
 * goal names, and the head duly calls them). Carried into a plan attempt that no longer contains
 * one of those siblings, the source is a dangling reference — it cannot fail certification (nothing
 * re-runs it in isolation) but it makes `helperBlock` non-compiling, so the COMPOSE rung fails and
 * the whole plan attempt is spent discovering it. Fold the rung's declared dependencies into the
 * key so that carve is a MISS (re-grind the rung) instead of a poisoned hit.
 *
 * Only the siblings the goal actually NAMES are folded in, not the whole plan: keying on the entire
 * sibling set would invalidate every carry-forward whenever any unrelated helper changed, which
 * costs exactly the re-grinding the carry cache exists to avoid. Missing/omitted `siblings` keeps
 * the pre-2026-08-01 key byte-for-byte, so a caller that has no plan in hand loses nothing.
 */
export function rungSpecKey(
  rung: { goal: string; cases: CodeAcceptance['cases'] },
  siblings?: readonly string[],
): string {
  let cases: string
  try { cases = JSON.stringify(rung.cases) } catch { cases = String(rung.cases) }
  const base = `${rung.goal}\x00${cases}`
  if (!siblings?.length) return base
  const deps = siblings.filter((n) => n && rung.goal.includes(n)).sort()
  return deps.length ? `${base}\x00${deps.join(',')}` : base
}

/** Coarse runtime type-shape of a case value, used only to compare a helper's declared inputs
 *  against the entry's actual ones. Arrays report their element shape so `number[]` ≠ `string[]`;
 *  an empty array is `unknown[]`, which matches any array (we must not reject on missing evidence). */
function argShape(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length ? `${argShape(v[0])}[]` : 'unknown[]'
  return typeof v
}

/** Do two shapes plausibly denote the same kind of value? `unknown[]` is a wildcard for arrays. */
function shapesMatch(a: string, b: string): boolean {
  if (a === b) return true
  return (a === 'unknown[]' && b.endsWith('[]')) || (b === 'unknown[]' && a.endsWith('[]'))
}

/**
 * PLAN-QUALITY predicate #3: this helper IS the top-level function wearing a different name.
 *
 * WHY (2026-07-25d general scorecard, 1/5). Every failing carve on that run contained one of these:
 * `intToRomanHelper`, `romanNumeralConverter`, `isBalancedHelper`, `runLength`. The planner names a
 * helper after the entry and SPECIFIES IT WITH THE ENTRY'S OWN EXAMPLE — so certifying that rung is
 * exactly as hard as the original task, and the rung that stalls (`subtractiveRoman`, `isIgnored`)
 * only stalls after the budget has already been poured into the alias. `isDegenerateSubFnCarve`
 * cannot see this: these plans have FOUR helpers, so the single-helper re-bake test passes.
 *
 * The test is the tight one, deliberately NOT a name-similarity heuristic: a helper is a re-bake
 * when one of its example cases is, argument-for-argument and result-for-result, a case of the
 * ENTRY. That is the planner literally writing down "this helper does the whole task". Naming is
 * ignored on purpose — the live `romanToInt` SOLVE used a carve containing `romanToIntHelper` and
 * `romanToIntHelper2`, so punishing the NAME would have destroyed the one task that works. Only the
 * spec is evidence.
 *
 * Callers FILTER these helpers out rather than failing the plan: a 4-helper carve with one alias may
 * have three good rungs, and if too few survive the existing degeneracy gate catches it on the way
 * past. Pure — unit-tested in __decompose_bench.
 */
export function isRebakedHelper(
  helperCases: { args: unknown[]; expected: unknown }[] | undefined,
  entryCases: { args: unknown[]; expected: unknown }[] | undefined,
): boolean {
  if (!helperCases?.length || !entryCases?.length) return false
  const key = (c: { args: unknown[]; expected: unknown }) => {
    try { return JSON.stringify([c.args, c.expected]) } catch { return null }
  }
  const entryKeys = new Set<string>()
  for (const c of entryCases) { const k = key(c); if (k) entryKeys.add(k) }
  for (const c of helperCases) { const k = key(c); if (k && entryKeys.has(k)) return true }
  return false
}

/**
 * PLAN-QUALITY predicate #2: the carve has NO ENTRY POINT — not one proposed helper consumes a
 * value of a type the top-level function is actually given, so no composition can even begin.
 *
 * WHY (2026-07-25c). `isDegenerateSubFnCarve` only catches the SINGLE-helper re-bake, so every
 * junk multi-helper carve sailed through and spent a full per-rung budget per helper before the
 * compose rung discovered there was nothing to compose. The live example: `numberToWords(1234)`,
 * whose goal merely FORBIDS commas and the word "and", drew the carve
 * `removeCommas, removeAnd, …` — helpers whose example args are all STRINGS while the entry is
 * only ever handed a NUMBER. Four rungs certified four helpers that could never be wired to the
 * input, and the task declined at the end of the budget instead of resampling in seconds.
 *
 * The check is deliberately ONE-SIDED and weak: it fires only when NOTHING lines up on the INPUT
 * side. It does not require the chain to type-check end to end, and it says nothing about the
 * output side — the compose rung is allowed to do a little final work, so demanding an exact
 * return-type anchor would reject good carves. Missing evidence never fires it either: no entry
 * cases, or a plan with no usable example args, is treated as "can't tell" → allow.
 *
 * Soundness: like every gate on this path it can only cause a RESAMPLE, never a certification. A
 * false positive costs one more plan draw; a false negative just leaves us where we were. Trusted
 * template classes and caller-supplied planners (tests) are exempt, as with the degeneracy gate.
 * Pure — unit-tested in __decompose_bench.
 */
export function isNonComposingCarve(
  hasCustomPlanner: boolean,
  // `expected` is declared-but-unused ON PURPOSE. This gate reads ARG SHAPES only, but every real
  // caller passes full acceptance cases which DO carry `expected`; an element type without it made
  // those literals excess-property errors, which is why both call sites in this file reached for
  // `as any` — and an `as any` on the plan is exactly how a wrong-shaped carve would slip past a
  // gate whose whole job is to reject wrong-shaped carves. Declaring the field lets the casts go.
  // `name`/`goal` likewise: unread here, but present on every real `SubFunctionSpec`, and without
  // them an inline plan literal (the unit bench) is an excess-property error.
  plan: { name?: string; goal?: string; cases?: { args: unknown[]; expected?: unknown }[] }[],
  entryCases: { args: unknown[]; expected?: unknown }[],
  hasTemplate: boolean,
): boolean {
  if (hasCustomPlanner || hasTemplate) return false
  const entryShapes = new Set<string>()
  for (const c of entryCases ?? []) for (const a of c?.args ?? []) entryShapes.add(argShape(a))
  if (!entryShapes.size) return false                       // no evidence → can't judge
  let sawHelperArgs = false
  for (const h of plan) {
    for (const c of h?.cases ?? []) {
      for (const a of c?.args ?? []) {
        sawHelperArgs = true
        for (const s of entryShapes) if (shapesMatch(argShape(a), s)) return false
      }
    }
  }
  return sawHelperArgs                                       // no example args at all → can't judge
}

/**
 * SUB-LEVEL BUDGET for the two recovery paths (helper recursion, glue re-decomposition). Both used
 * to hand the child `opts.iterate` VERBATIM, so a depth-1 subtree could spend the parent's full
 * per-rung budget again on EVERY one of its own rungs — a stuck rung's cost grew multiplicatively
 * with depth (live: one pinned rung alone burned 595s before recursion even started). Scale the
 * child down instead: it is a strictly smaller problem, so it should get a strictly smaller purse.
 * Floors keep a scaled budget usable (a 1-call, 5s rung can only abstain). Pure — unit-tested.
 */
export function subLevelIterateBudget(
  parent: Partial<IterateOpts<string>> | undefined,
  scale = 0.6,
): Partial<IterateOpts<string>> {
  const scaled = { ...(parent ?? {}) } as Partial<IterateOpts<string>> & Record<string, unknown>
  // Generic in the INPUT type rather than taking `unknown`: the non-numeric branch returns `v`
  // UNCHANGED, so an `unknown` parameter widened every result to `unknown` and the three
  // assignments below were each a TS2322 against a `number | undefined` field. `T | number` says
  // what the function actually does — shrink a finite number, pass anything else through
  // untouched — and preserves that pass-through exactly.
  const shrink = <T,>(v: T, floor: number): T | number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(floor, Math.round(v * scale)) : v
  if ('globalModelCalls' in scaled) scaled.globalModelCalls = shrink(scaled.globalModelCalls, 3)
  if ('wallClockMs' in scaled) scaled.wallClockMs = shrink(scaled.wallClockMs, 30_000)
  if ('maxEpochs' in scaled) scaled.maxEpochs = shrink(scaled.maxEpochs, 2)
  return scaled
}

async function runSubFunctionOnce(
  input: SolveCodeInput & { nl?: string },
  opts: { planner?: SubFunctionPlanner; webGround?: (query: string) => Promise<string | null>; iterate?: Partial<IterateOpts<string>>; signal?: AbortSignal; emit?: IterateOpts<string>['emit']; depth?: number; maxDepth?: number; preHelpers?: { name: string; source: string }[]; traceProbe?: boolean; budget?: { left: () => number } },
  proposerOverride?: Proposer<string>,
  // CARRY-FORWARD across planAttempts: helpers certified on a prior attempt, keyed by
  // name→{source, spec}. A rung whose plan is IDENTICAL reuses the stored source instead of
  // re-certifying — so a retry spends its whole budget on the rung that actually failed, not on
  // re-grinding the easy ones.
  //
  // The key covers the goal AND THE ACCEPTANCE CASES (`rungSpecKey`), not the goal alone. Goal-only
  // was already loose — a stochastic re-plan can keep a one-line purpose and change its examples —
  // and the carve probe makes it outright wrong, since a rung's cases are now rewritten from the
  // trace while its goal is preserved verbatim. Reusing across that boundary would report
  // `certified: true` for a rung nothing ever checked against the spec it is being reused under.
  // Composition re-verify would still catch a wrong whole, so this is a reporting-honesty fix
  // rather than a soundness one — which is exactly the class of bug this repo refuses to keep.
  carry?: Map<string, { source: string; spec: string }>,
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

  // ONE deadline for this whole carve, computed once and handed to every iterate() call below.
  // `opts.iterate.wallClockMs` is a PER-CALL duration, so without this each rung and the compose
  // step restarts the clock and the "budget" multiplies by the number of rungs (see IterateOpts.
  // deadline). A caller that already supplied a deadline keeps theirs — an inherited ceiling must
  // never be widened by a nested level, which is what makes this sound under recursion.
  const carveDeadline = opts.iterate?.deadline
    ?? (opts.iterate?.wallClockMs !== undefined ? Date.now() + opts.iterate.wallClockMs : undefined)
  const withDeadline = <T extends Record<string, unknown>>(b: T): T =>
    (carveDeadline === undefined ? b : { ...b, deadline: carveDeadline })

  // ONE call ledger for this whole carve — the deadline's counterpart on the call axis (see
  // `budget` on decomposeCodeBySubFunction). `modelCalls` below is this carve's running spend, so
  // the remainder is what the shared ledger has left MINUS what we have already taken from it.
  // Read fresh at each iterate call site, never snapshotted, so rung k sees rungs 0..k-1's spend.
  const callsLeft = (): number => (opts.budget === undefined ? Infinity : Math.max(0, opts.budget.left() - modelCalls))
  // Clamp a per-call `globalModelCalls` to the ledger remainder. Floor of 1: a 0-call purse can
  // only abstain, and the callers below check `callsLeft() <= 0` before spending at all.
  const withCallBudget = <T extends Partial<IterateOpts<string>>>(b: T): T => {
    const rem = callsLeft()
    if (!Number.isFinite(rem)) return b
    return { ...b, globalModelCalls: Math.max(1, Math.min(b.globalModelCalls ?? Infinity, rem)) }
  }
  /** A ledger for a NESTED level: whatever this carve has left at the moment the child asks. */
  const childBudget = opts.budget === undefined ? undefined : { left: () => callsLeft() }

  // 1) Untrusted helper plan.
  // ACCOUNTING (2026-07-27c). The DEFAULT planner is a MODEL CALL and was billed ZERO: `modelCalls`
  // is initialised at 0 above and was first incremented at the carve probe, so every draw that died
  // at or before the plan reported `0 calls` after spending a real draw. Live in this session's own
  // carve-probe A/B, both arms: `romanToInt [decompose] declined (0 calls, 28s)`,
  // `intToRoman [decompose] decompose-failed (0 calls, 12s)` — 12s is three plan attempts at ~4s.
  // Same class as the tier-0 four-slots-billed-as-one bug: the runs where the head misbehaves are
  // exactly the ones a 0-call report then hides. Every decompose-arm call count ever recorded is an
  // UNDERCOUNT by one per plan attempt, the "tier 3 costs 27-43 calls" figure included.
  //
  // Billed at the CALL SITE, not inside the closure, so a caller-supplied planner (tests) keeps its
  // exact zero-cost accounting. makeFmSubFunctionPlanner issues exactly ONE fmComplete per
  // invocation and NONE when a template matches (its `templateFor` fast-path returns first), so the
  // charge is gated on that same predicate — against `input.goal`, the value the closure forwards
  // as `inp.goal`, NOT the `input.nl ?? input.goal` used for routing elsewhere in this function.
  const planner: SubFunctionPlanner = opts.planner ?? (async (inp, signal) => {
    const fn = makeFmSubFunctionPlanner()
    const plan = await fn(inp.goal, inp.entry, inp.cases.map((c) => ({ args: c.args, expected: c.expected })), signal)
    return plan // PlannedSubFunction[] is structurally a SubFunctionSpec[]
  })
  const plannerCosts = !opts.planner && !hasDecomposeTemplate(input.goal, input.entry)
  let plan: SubFunctionSpec[] | null = null
  try { plan = await planner({ goal: input.goal, entry: input.entry, cases: input.cases }, opts.signal) }
  catch (e: any) { emit({ type: 'thought', text: `subfn: planner error ${String(e?.message ?? e)}` }) }
  // Charged on the THROW path too: an fmComplete that rejects (timeout, downed sidecar) still spent
  // the decode, and a 0-call report there would hide precisely the failure it should surface.
  if (plannerCosts) modelCalls += 1
  if (!plan || plan.length < 1) {
    return { status: 'declined', code: null, helpers: [], rungs, modelCalls, detail: 'planner proposed no checkable helpers' }
  }
  // guard against a helper colliding with the top-level name
  // Drop any rung that re-proposes a helper already certified by the parent level (see preHelpers):
  // it is proven code, so re-grinding it would only spend budget and risk a WORSE reimplementation.
  const preNames = new Set((opts.preHelpers ?? []).map((h) => h.name))
  // DEDUPE BY NAME (2026-07-25, live FM-general numberToWords). The FM planner repeats a helper
  // name across rows on real draws — that probe's carve was
  // `convertToWords, pluralize, convertToWordsHelper, convertToWordsHelper`. Without this filter
  // each copy is ground as its OWN rung (a full per-rung budget spent twice on the same goal), and
  // then both certified sources land in `helpers` — so `helperBlock` concatenates two `function`
  // declarations with the same name and the later one silently shadows the earlier, throwing away
  // a rung that was already paid for and certified. Keep the FIRST occurrence: the planner emits
  // its best-specified row first, and the dep-closure/stripHelperRedefinitions logic downstream
  // keys on NAME, so a name must map to exactly one source for any of it to be well-defined.
  // Deduping BEFORE the degeneracy gate is deliberate — a carve of [A, A] is a single-helper
  // re-bake wearing a disguise, and should resample rather than burn two rungs discovering that.
  // ALIAS RE-BAKE (2026-07-25d): also drop any helper the planner specified with one of the ENTRY's
  // OWN cases — that rung is the whole task under a new name, and certifying it is exactly as hard
  // as the original problem. Filtered rather than fatal, since the sibling rungs may be fine; if too
  // few survive, the degeneracy gate below catches it. Exempt when the caller supplied a planner.
  const seenNames = new Set<string>()
  const rebaked: string[] = []
  const helperPlan = plan
    .filter((h) => {
      if (h.name === input.entry || preNames.has(h.name) || seenNames.has(h.name)) return false
      if (!opts.planner && isRebakedHelper((h as any).cases, input.cases as any)) { rebaked.push(h.name); return false }
      seenNames.add(h.name)
      return true
    })
    .slice(0, 5)
  if (rebaked.length) emit({ type: 'thought', text: `subfn: dropped ${rebaked.join(', ')} — specified with the top-level function's own case (alias re-bake)` })
  emit({ type: 'thought', text: `subfn: ${helperPlan.length} helper(s) — ${helperPlan.map((h) => h.name).join(', ')}` })
  if (!helperPlan.length) {
    // A plan emptied by the ALIAS-REBAKE filter is a BAD PLAN, not an impossible task — the head
    // proposed helpers that all restate the entry, and a fresh stochastic draw may well carve it
    // properly. `declined` exits the planAttempts loop immediately, so returning it here threw away
    // both remaining attempts and reported a 0-call/3s decline (live 25e: intToRoman, compressRuns).
    // `decompose-failed` is the status that resamples. A plan emptied for any OTHER reason (every
    // helper collided with the entry name or a parent's pre-certified set) keeps the honest decline.
    if (rebaked.length) {
      return { status: 'decompose-failed', code: null, helpers: [], rungs, modelCalls, detail: `every helper restated the entry (${rebaked.join(', ')}); resample plan` }
    }
    return { status: 'declined', code: null, helpers: [], rungs, modelCalls, detail: 'no helper distinct from the top-level function' }
  }
  // PLAN-QUALITY GATE (universal, template-free path only). A single-helper carve is degenerate:
  // the lone helper necessarily does ALL the work and the compose rung just calls it — i.e. the
  // FM "re-baked the whole difficulty into one un-certifiable helper" (the documented failure
  // mode). Certifying that helper is exactly as hard as the original task, so spending a full
  // rung budget on it before failing is pure waste. Fail FAST as decompose-failed so the outer
  // planAttempts loop resamples a fresh (stochastic) carve immediately. Exempt the trusted
  // template classes (their fixed carves are always ≥2 helpers anyway) and any caller-supplied
  // planner (tests), so this only tightens the FM general path it was written for.
  if (isDegenerateSubFnCarve(!!opts.planner, helperPlan.length, hasDecomposeTemplate(input.nl ?? input.goal, input.entry))) {
    emit({ type: 'thought', text: 'subfn: single-helper carve re-bakes the whole task — resampling the plan' })
    return { status: 'decompose-failed', code: null, helpers: [], rungs, modelCalls, detail: 'degenerate single-helper carve (re-bake); resample plan' }
  }
  // PLAN-QUALITY GATE #2 — no helper consumes the entry's actual input types, so the carve has no
  // entry point and can never compose. Same fail-fast treatment: resample rather than certify four
  // helpers that cannot be wired to the input (see isNonComposingCarve for the live case).
  if (isNonComposingCarve(!!opts.planner, helperPlan, input.cases, hasDecomposeTemplate(input.nl ?? input.goal, input.entry))) {
    emit({ type: 'thought', text: 'subfn: no helper consumes the top-level input — carve cannot compose; resampling the plan' })
    return { status: 'decompose-failed', code: null, helpers: [], rungs, modelCalls, detail: 'non-composing carve (no helper takes the entry input); resample plan' }
  }

  // 1.5) CARVE PROBE — the carve's missing verifier (2026-07-26). Every gate above is STATIC: it
  // reads the plan's own text and argument shapes. None of them executes anything, so a carve that
  // is merely *plausible* still gets a full per-rung budget before anyone learns it was junk (live:
  // isBalanced 92 calls, wordFrequencyTop 115). Spend ONE draw drafting the whole carve and 89ms
  // tracing it instead. Three outcomes, all strictly better than proceeding blind — see traceCarve.ts:
  //   • the draft passes the ORIGINAL cases under verifyCode → done, in one call;
  //   • the trace witnesses helper I/O on gold-passing cases → those replace the planner's INVENTED
  //     expected values as the rung acceptance sets, closing the seeds-its-own-oracle hole;
  //   • a helper a working composition never calls is a dead branch → prune it or resample.
  // Gated to the FM-GENERAL path at depth 0: a caller-supplied planner (tests) must keep its exact
  // model-call accounting, a TEMPLATE class's cases are hand-authored constants rather than model
  // inventions (so the hole this closes does not exist there, and its rungs are known-good), and the
  // recursion/glue levels already run on a shrunken budget where another draw is not worth it.
  const probeOn = opts.traceProbe ?? process.env.CRUCIBLE_CARVE_PROBE !== '0'
  let probe: CarveProbe | null = null
  let rungPlan = helperPlan
  if (probeOn && !opts.planner && !opts.preHelpers?.length && (opts.depth ?? 0) === 0 &&
      !hasDecomposeTemplate(input.nl ?? input.goal, input.entry) &&
      input.cases.length >= 2 && !opts.signal?.aborted) {
    probe = await probeCarve(
      { goal: input.goal, entry: input.entry, cases: input.cases, context: input.context, timeoutMs: input.timeoutMs },
      helperPlan, proposer, { signal: opts.signal, emit: opts.emit },
    )
    modelCalls += probe.modelCalls
    if (probe.status === 'solved' && probe.certified) {
      // Certified by verifyCode against the ORIGINAL gold cases — the same judge the composition
      // rung answers to. Reported as its own rung so a scorecard can tell a probe solve apart from
      // a carve solve rather than banking one as evidence for the other.
      rungs.push({ name: `probe:${input.entry}`, status: 'solved', bestScore: 1, modelCalls: probe.modelCalls, certified: true })
      return { status: 'solved', code: probe.certified, helpers: [], rungs, modelCalls,
        detail: `carve probe drafted a composed module certified against all ${input.cases.length} original case(s) in ${modelCalls} model call(s) — no rung was ground` }
    }
    if (probe.status === 'grounded') {
      rungPlan = probe.plan
      if (probe.dead.length) {
        // A rung the working composition never reaches cannot be part of a correct whole. Prune it;
        // if pruning leaves a carve the degeneracy gate would have rejected, resample instead of
        // grinding a re-bake. Sound either way — this only ever changes which PATH we spend on.
        const live = rungPlan.filter((h) => !probe!.dead.includes(h.name))
        if (isDegenerateSubFnCarve(false, live.length, false)) {
          emit({ type: 'thought', text: `subfn: pruning dead rung(s) ${probe.dead.join(', ')} leaves a degenerate carve — resampling the plan` })
          return { status: 'decompose-failed', code: null, helpers: [], rungs, modelCalls,
            detail: `carve probe found ${probe.dead.join(', ')} unreachable from a working composition; too few rungs remain — resample plan` }
        }
        rungPlan = live
      }
      // RE-RUN THE STATIC GATES ON THE GROUNDED PLAN (2026-08-01). Both remaining plan-quality
      // gates were evaluated ABOVE against the planner's INVENTED cases, and `probe.plan` replaces
      // those with trace-witnessed I/O (and the prune drops rungs entirely) — so the carve they
      // passed is not the carve we are about to grind. `isDegenerateSubFnCarve` already re-runs
      // inside the prune branch; these two did not, which is partial coverage rather than a missing
      // mechanism, and it costs a full per-rung budget per surviving junk helper.
      //   • isRebakedHelper is STRICTLY better informed here: the entry-case collision it looks for
      //     is now real observed I/O rather than a value the planner made up. Filter (not fail), as
      //     at the first call site — sibling rungs may be fine — then let degeneracy catch a carve
      //     that lost too many.
      //   • isNonComposingCarve likewise reads REAL argument shapes instead of invented ones.
      // Soundness is unchanged: like every gate on this path, the only outcomes are "grind this
      // plan" and "resample" — neither can certify anything.
      const groundRebaked: string[] = []
      const survivors = rungPlan.filter((h) => {
        if (isRebakedHelper((h as any).cases, input.cases as any)) { groundRebaked.push(h.name); return false }
        return true
      })
      if (groundRebaked.length) {
        emit({ type: 'thought', text: `subfn: trace grounding exposed ${groundRebaked.join(', ')} as the entry under another name — dropped` })
      }
      if (isDegenerateSubFnCarve(false, survivors.length, false) ||
          isNonComposingCarve(false, survivors, input.cases, false)) {
        return { status: 'decompose-failed', code: null, helpers: [], rungs, modelCalls,
          detail: `grounded carve fails the plan-quality gates (${survivors.length} rung(s) after grounding) — resample plan` }
      }
      rungPlan = survivors
    }
    emit({ type: 'thought', text: `subfn: ${probe.detail}` })
  }

  // 2) Certify each helper independently. A helper that can't certify collapses the plan.
  // PRE-CERTIFIED helpers handed down by a parent level (glue re-decomposition): their sources are
  // already verifier-certified and must be part of THIS level's module, or the sub-solve would be
  // asked to compose against functions that exist only as prompt text and could never certify.
  const helpers: { name: string; source: string }[] = (opts.preHelpers ?? []).map((h) => ({ ...h }))
  // The names that will exist in THIS attempt's module — the carry key's sibling context (see
  // rungSpecKey). Computed once, after the probe has finished rewriting/pruning `rungPlan`, so the
  // key a rung is stored under and the key it is looked up by describe the same module.
  const siblingNames = [...helpers.map((x) => x.name), ...rungPlan.map((x) => x.name)]
  for (const h of rungPlan) {
    if (opts.signal?.aborted) return { status: 'aborted', code: null, helpers, rungs, modelCalls, detail: `aborted at helper ${h.name}` }
    // CARRY-FORWARD: this exact rung (name + identical goal) already certified on a prior
    // planAttempt — reuse its source at zero model cost instead of re-grinding it. Sound: the
    // stored source certified against this same spec last attempt, and the composed whole is
    // re-verified against the ORIGINAL cases regardless, so a stale reuse can only cost a compose
    // failure, never a false certification.
    //
    // DISCHARGED 2026-07-29 (this comment had stood unrefuted for three sessions, which is not the
    // same as checked). "Re-verified downstream" understates it: this function has exactly THREE
    // `status: 'solved'` exits, and every one of them runs verifyCode against `input.cases` BEFORE
    // returning — nothing downstream has to be trusted to hold the invariant.
    //   • probe solve (~:868)   — `probe.certified` is set only where verifyCode passed the draft
    //                             against the original gold cases (traceCarve.ts ~:274).
    //   • normal compose (~:1082) — composingVerifier prepends `helperBlock` (which is where a
    //                             carried source physically lands) and the explicit guard at ~:1078
    //                             re-runs the plain verifier on the same full module.
    //   • glue re-decompose (~:1068) — returns a recursive result, inductively one of these three,
    //                             invoked with the SAME `input.cases`.
    // A carried helper only ever reaches the verdict as text inside `helperBlock`, so the worst a
    // stale one can do is make that module fail. Two near-misses that would have broken it and
    // don't: a carried helper whose own dependency is absent from the new plan still fails only at
    // compose (the module doesn't run), and `carry` is allocated per decomposeCodeBySubFunction
    // call (~:527), so a key can never cross tasks. The reuse-time `certified: true` below is
    // honest for the same reason rungSpecKey exists — it is the identical goal AND cases.
    const carried = carry?.get(h.name)
    if (carried && carried.spec === rungSpecKey(h, siblingNames)) {
      helpers.push({ name: h.name, source: carried.source })
      rungs.push({ name: h.name, status: 'solved', bestScore: 1, modelCalls: 0, certified: true })
      emit({ type: 'thought', text: `subfn: helper \`${h.name}\` reused from a prior attempt (0 calls)` })
      continue
    }
    // CONTEXT HYGIENE (2026-07-22l): only ground a rung with the prior helpers it ACTUALLY calls
    // (its goal names them), not every certified helper. Live probe: foldMulDiv solves in 2 calls
    // in isolation but ANCHORED inside decomposition, because the unconditional prior-helper dump
    // crowded the idiom/cases out of the weak head's tiny per-slot context (n_ctx≈1024/slot). Most
    // template helpers are independent, so this hands them the same clean prompt isolation gets.
    // Start from the prior helpers this goal NAMES, then close over THEIR calls too: each stored
    // source is only the helper's OWN function (extractOwnFunction), so grounding editRow with just
    // `nextRow` would show nextRow calling an UNDEFINED subCost — a non-compiling partial module the
    // weak head thrashes on. Transitive closure keeps the grounding block a COMPILABLE partial
    // module while still excluding helpers this rung has nothing to do with (the hygiene intent).
    const depSet = new Map<string, { name: string; source: string }>()
    const frontier = helpers.filter((x) => h.goal.includes(x.name))
    while (frontier.length) {
      const x = frontier.pop()!
      if (depSet.has(x.name)) continue
      depSet.set(x.name, x)
      for (const y of helpers) if (y.name !== x.name && !depSet.has(y.name) && x.source.includes(y.name)) frontier.push(y)
    }
    // Emit in original certification order so definitions precede their callers.
    const deps = helpers.filter((x) => depSet.has(x.name))
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
    // BUDGET SKEW. Without the probe every rung gets the same purse whether or not it is the broken
    // one. With it, Ochiai over the draft's helper-call spectra says where the failures ran, so the
    // suspect rung gets 1.5× and a rung the draft already got right gets 0.6× (see skewRungBudget).
    // A budget is not a truth claim — a mis-ranked rung costs draws, never certification.
    const rungBudget = probe?.status === 'grounded' ? skewRungBudget(opts.iterate, probe.suspects, h.name) : opts.iterate
    // Ledger check BEFORE the rung, not after: a rung started with nothing left can only abstain,
    // and abstaining costs the plan attempt anyway. Report it as an honest budget stop.
    if (callsLeft() <= 0) {
      return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls,
        detail: `model-call budget exhausted before helper \`${h.name}\`` }
    }
    const res = await iterate<string>(spec, rungProposer, verifyCode, withDeadline(withCallBudget({ mergeAcceptance: mergeCodeAcceptance, research: researchFor(h.goal), ...rungBudget, signal: opts.signal, emit: opts.emit })))
    modelCalls += res.modelCalls
    const certified = res.status === 'solved' && !!res.solution
    rungs.push({ name: h.name, status: res.status, bestScore: res.bestScore, modelCalls: res.modelCalls, certified })
    if (!certified) {
      // RECURSIVE DECOMPOSITION. Flat iterate couldn't certify this helper — before collapsing the
      // whole plan, re-apply decomposition to the helper itself (its own goal + a fresh FM sub-plan).
      // This turns a helper that is STILL too hard for the weak head into its own propose→verify→
      // backtrack tree. In production the planner is always the default (FM, keyed on the passed
      // goal), so recursion naturally re-plans on `h.goal`; a caller-supplied planner (tests) is
      // simply re-invoked with the sub-goal. Loops are bounded by `maxDepth`, not the planner source.
      // Sound: the recursive solve re-verifies its module against THIS helper's cases, and the parent's
      // composed whole is re-verified against the ORIGINAL cases downstream — recursion widens the
      // search, never the trust.
      const depth = opts.depth ?? 0
      const maxDepth = opts.maxDepth ?? 1
      // Recurse only on the FM-GENERAL path — a task with NO decompose template. For a template class
      // the carve is already known-good: a rung failure there is model variance, best answered by
      // carry-forward + a fresh planAttempt (and re-decomposing a fixed template helper would just burn
      // the DP-fold wall-clock). Recursion's payoff is precisely the novel task where no template exists
      // and re-sampling the SAME carve can't help — subdividing the stuck helper is the only move left.
      const templated = hasDecomposeTemplate(input.nl ?? input.goal, input.entry)
      if (!templated && depth < maxDepth && res.status !== 'aborted' && !opts.signal?.aborted) {
        emit({ type: 'thought', text: `subfn: helper \`${h.name}\` won't one-shot — recursing (depth ${depth + 1}/${maxDepth})` })
        const sub = await decomposeCodeBySubFunction(
          { goal: h.goal, entry: h.name, cases: h.cases, context: [input.context, priorBlock].filter(Boolean).join('\n\n') || undefined, timeoutMs: input.timeoutMs, nl: h.goal },
          { ...opts, depth: depth + 1, emit: opts.emit, iterate: subLevelIterateBudget(opts.iterate), budget: childBudget },
          proposerOverride,
        )
        modelCalls += sub.modelCalls
        rungs.push(...sub.rungs.map((r) => ({ ...r, name: `${h.name}/${r.name}` })))
        if (sub.status === 'solved' && sub.code) {
          // Keep the WHOLE recursive module (its sub-helpers + `h.name`), only stripping any prior
          // helper it redefined — extractOwnFunction would wrongly drop the sub-helpers it needs.
          const recSource = stripHelperRedefinitions(sub.code, helpers.map((x) => x.name))
          helpers.push({ name: h.name, source: recSource })
          carry?.set(h.name, { source: recSource, spec: rungSpecKey(h, siblingNames) })
          emit({ type: 'thought', text: `subfn: helper \`${h.name}\` certified via recursion (${modelCalls} calls so far)` })
          continue
        }
        return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `helper \`${h.name}\` did not certify (recursion also failed: ${sub.detail})` }
      }
      return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `helper \`${h.name}\` did not certify — ${res.detail}` }
    }
    // Capture ONLY this helper's own function — the certified module often also redefines the
    // prior helpers it was grounded with, which would collide when the sources are concatenated
    // for the composition (see extractOwnFunction).
    const ownSource = extractOwnFunction(res.solution!.value, h.name)
    helpers.push({ name: h.name, source: ownSource })
    // Record for carry-forward: a later planAttempt with this identical rung reuses it at 0 cost.
    carry?.set(h.name, { source: ownSource, spec: rungSpecKey(h, siblingNames) })
    emit({ type: 'thought', text: `subfn: helper \`${h.name}\` certified (${modelCalls} calls so far)` })
  }

  // 3) COMPOSITION rung: write the top-level function calling the certified helpers. The
  //    verifier prepends the helper sources and runs the FULL module against the ORIGINAL
  //    cases, so what we certify is the whole, not just the top function in isolation.
  const helperBlock = helpers.map((h) => h.source).join('\n\n')
  // A class whose composition idiom isn't discoverable from the helper signatures (e.g. edit-distance:
  // the answer is the LAST cell of editRow's output) supplies it here so the compose rung doesn't
  // re-derive the whole algorithm and anchor. UNTRUSTED — the composed whole is re-verified downstream.
  const composeHint = composeHintFor(input.nl ?? input.goal, input.entry)
  const composeSpec: TaskSpec = {
    goal: `${input.goal}${composeHint ? `\n\n${composeHint}` : ''}\n\nYou may CALL these already-implemented and tested helpers (they are defined in the same module — do NOT redefine them): ${helpers.map((h) => '`' + h.name + '`').join(', ')}.`,
    domain: 'code',
    context: [input.context, `${WEB_GROUND_MARK}\n${helperBlock}`].filter(Boolean).join('\n\n'),
    acceptance: {
      entry: input.entry,
      entries: input.entries && input.entries.length > 1 ? input.entries : undefined,
      cases: input.cases, timeoutMs: input.timeoutMs,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
  // Verify (helpers + candidate) as one module. The proposer is asked for the top function, but a
  // weak model often returns the whole module and RE-DECLARES the helpers → strip those redefinitions
  // first so the CERTIFIED helper block is the single source (see stripHelperRedefinitions).
  const helperNames = helpers.map((h) => h.name)
  const composingVerifier: Verifier<string> = (cand, spec) =>
    verifyCode({ value: `${helperBlock}\n\n${stripHelperRedefinitions(cand.value, helperNames)}`, fingerprint: cand.fingerprint }, spec)

  const composeProposer = withRetrieval(proposer, input.entry, input.nl ?? input.goal, input.cases, webGround, buildCodeSearchQuery(input.nl ?? input.goal), opts.emit)
  const composed = await iterate<string>(composeSpec, composeProposer, composingVerifier, withDeadline(withCallBudget({ mergeAcceptance: mergeCodeAcceptance, research: researchFor(input.nl ?? input.goal), ...opts.iterate, signal: opts.signal, emit: opts.emit })))
  modelCalls += composed.modelCalls
  const composedCert = composed.status === 'solved' && !!composed.solution
  rungs.push({ name: `compose:${input.entry}`, status: composed.status, bestScore: composed.bestScore, modelCalls: composed.modelCalls, certified: composedCert })
  if (!composedCert) {
    // COMPOSE-RUNG RECOVERY (2026-07-25, from the first live FM-general run). Recursion covered only
    // a stuck HELPER rung — but live, the weak planner's more common miss is the opposite shape: it
    // carves helpers that all certify in one call each and leaves the DIFFICULTY IN THE GLUE (live
    // numberToWords: numberToDigit/digitToWord/… all OK, then compose stalled 3 epochs on duplicate
    // proposals). That stall used to collapse the whole plan and cost a full planAttempt, throwing
    // the certified helpers away. It is the same disease recursion treats — a rung still too hard for
    // one shot — so apply the same medicine: re-decompose THIS task one level deeper, with the
    // certified helpers supplied as context (and carried, so an identical rung costs 0 calls), asking
    // for a plan that covers the missing glue. Gated exactly like helper recursion: FM-general path
    // only (a template class's compose is a known-good idiom + composeHint, so a stall there is model
    // variance, best answered by the outer planAttempt) and bounded by maxDepth. Sound: the sub-solve
    // is verified against the SAME original cases by the same verifier — this widens search, not trust.
    const cDepth = opts.depth ?? 0
    const cMaxDepth = opts.maxDepth ?? 1
    const cTemplated = hasDecomposeTemplate(input.nl ?? input.goal, input.entry)
    if (!cTemplated && helpers.length > 0 && cDepth < cMaxDepth && composed.status !== 'aborted' && !opts.signal?.aborted) {
      emit({ type: 'thought', text: `subfn: composition of \`${input.entry}\` stalled with all helpers certified — re-decomposing the glue (depth ${cDepth + 1}/${cMaxDepth})` })
      const glueNote =
        `These helpers are already implemented, tested and available to call — do NOT re-plan them: ` +
        `${helperNames.map((n) => '`' + n + '`').join(', ')}. Plan the REMAINING steps that combine them into \`${input.entry}\`.`
      // Seed carry-forward with the certified helpers so a sub-plan that re-proposes an identical
      // rung (same name AND goal) reuses the proven source at zero model cost.
      const glueCarry = new Map(carry ?? [])
      for (const h of helpers) {
        const planned = rungPlan.find((p) => p.name === h.name)
        if (planned) glueCarry.set(h.name, { source: h.source, spec: rungSpecKey(planned, siblingNames) })
      }
      const sub = await decomposeCodeBySubFunction(
        { ...input, goal: `${input.goal}\n\n${glueNote}`, context: [input.context, `${WEB_GROUND_MARK}\n${helperBlock}`].filter(Boolean).join('\n\n') || undefined },
        { ...opts, depth: cDepth + 1, emit: opts.emit, preHelpers: helpers, iterate: subLevelIterateBudget(opts.iterate), budget: childBudget },
        proposerOverride,
        glueCarry,
      )
      modelCalls += sub.modelCalls
      rungs.push(...sub.rungs.map((r) => ({ ...r, name: `glue/${r.name}` })))
      if (sub.status === 'solved' && sub.code) {
        emit({ type: 'thought', text: `subfn: \`${input.entry}\` certified via glue re-decomposition (${modelCalls} calls so far)` })
        // The sub-solve's module is self-contained (its own helpers + the top fn) and was verified
        // against the ORIGINAL cases; return it as-is rather than re-concatenating this level's block.
        return { status: 'solved', code: sub.code, helpers: sub.helpers, rungs, modelCalls, detail: `sub-function decomposition solved ${input.entry} via glue re-decomposition (${modelCalls} model call(s))` }
      }
      return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `composition of ${input.entry} did not certify (glue re-decomposition also failed: ${sub.detail})` }
    }
    return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `composition of ${input.entry} did not certify — ${composed.detail}` }
  }

  // 4) Final artifact = helpers + top (redefinitions stripped, matching the composing verifier).
  //    Re-verify with the PLAIN original verifier as a guard (identical check, explicit for soundness).
  const fullModule = `${helperBlock}\n\n${stripHelperRedefinitions(composed.solution!.value, helperNames)}`
  const guard = await verifyCode({ value: fullModule, fingerprint: 'subfn-composed' }, composeSpec)
  if (!guard.pass) {
    return { status: 'decompose-failed', code: null, helpers, rungs, modelCalls, detail: `composed module failed final re-verify: ${guard.signals.slice(0, 3).join('; ')}` }
  }
  return { status: 'solved', code: fullModule, helpers, rungs, modelCalls, detail: `sub-function decomposition solved ${input.entry} via ${helpers.length} helper(s), ${modelCalls} model call(s)` }
}

// ── THE ESCALATION LADDER — spend effort in proportion to measured difficulty ────
//
// THE MEASUREMENT THAT FORCED THIS (2026-07-26 control arm, `npm run direct:arm`, 3 runs × 10 tasks
// × 8 draws). Every case-based path in `solveCodingRequest` used to run the same fixed sequence —
// converge → flat search → poisoned-case recovery → decomposition — regardless of whether the task
// was hard. It is usually not:
//
//   romanToInt   DIRECT solved @draw 1, 4–7s, 3/3   │  DECOMPOSE solved, 16 calls, 62s
//   intToRoman   DIRECT solved @draw 1–3, 4–19s, 3/3│  DECOMPOSE solved, 41 calls, 186s
//
// A 10–40× tax, paid on tasks the head answers on the first try. But the same arm also proved the
// opposite for four other tasks (basicCalculator, evalRPN, editDistance, calculatorWithParens):
// ~0/3 direct at EIGHT draws, 3/3 under decomposition. So neither path dominates, and the right
// answer is not to pick one — it is to ORDER them by cost and stop at the first that certifies:
//
//   tier 0  K concurrent blind draws + a free deterministic repair sweep     ~5s     1 round trip
//   tier 1  serial search with verifier feedback + mechanical repair         ~30s    K model calls
//   tier 2  model-free operators over everything drawn so far                ~0s     0 model calls
//   tier 3  sub-function decomposition                                       ~60-200s
//
// EVERY TIER ANSWERS TO THE SAME VERIFIER. Escalation changes only how much is spent looking; it
// never changes what counts as correct, and a tier-0 solve clears the identical invariant gates a
// tier-3 solve does. Cheap-first is therefore free of soundness risk by construction — the worst a
// misordered ladder can do is waste ~5s.
//
// WHY EACH TIER FEEDS THE NEXT rather than restarting cold:
//   • tier 0's best failing draw becomes tier 1's `buggyCode`, so tier 1 opens with executed
//     failure evidence AND the model-free single-token mutation sweep, instead of a cold prompt.
//   • tier 2's poisoned-case recovery reads tier 0's draws TOO. It needs ≥2 INDEPENDENT
//     implementations agreeing a case is wrong, and K blind concurrent draws are the most
//     independent candidates this system produces — strictly better evidence than the correlated
//     candidates a single feedback-guided search yields.

export type LadderTier = 0 | 1 | 2 | 3

/** One rung of the ladder, recorded whether or not it certified — the audit trail of the spend. */
export interface LadderStep {
  tier: LadderTier
  label: string
  modelCalls: number
  wallMs: number
  solved: boolean
  detail: string
}

export interface LadderOutcome {
  status: 'solved' | 'unsolved'
  code: string | null
  /** Which tier certified it; null when none did. */
  tier: LadderTier | null
  /** The case set the winner was certified against — tier 2 may have dropped a poisoned case. */
  cases: CodeAcceptance['cases']
  steps: LadderStep[]
  /** Tier 1's flat search result, when it ran. Callers still read `.attempts`. */
  search: SearchResult<string> | null
  modelCalls: number
  detail: string
  /** Set only when the tier-1 CONVERGE loop produced the solution (epochs > 1 ⇒ it earned it). */
  converged?: { epochs: number; modelCalls: number }
}

/**
 * How many concurrent blind draws tier 0 gets.
 *
 * `CRUCIBLE_LADDER_K` (default 4) sets the ceiling; measured pass@k says 4–8 is where the marginal
 * draw still pays, and the llama-server slot count is 4. It is then clamped to HALF the caller's
 * flat budget, so tier 0 alone cannot exceed half of it. Pure — unit-tested in __ladder_bench.
 *
 * SUBTRACTIVE AS OF 2026-07-28. This clamp still only bounds tier 0's own share; what changed is
 * that `solveByLadder` now keeps a running ledger and hands each later tier only what its
 * predecessors LEFT (see `left()` / `exhausted()` there). Previously no tier decremented anything,
 * so tier 1 received the caller's full budget again and tier 3's per-rung purses ignored it
 * outright — `maxModelCalls: 6` really licensed 6/2 + 6 flat calls plus an unbounded carve, and
 * only the AbortSignal bound it.
 *
 * EXACT WITHIN THE CARVE AS OF 2026-08-01. Tier 3's clamp used to apply to a PER-RUNG
 * `globalModelCalls`, so an N-rung carve could still spend up to N × the remainder. The ladder now
 * also hands the carve the ledger itself (`budget` on decomposeCodeBySubFunction), and the carve
 * subtracts its own in-flight spend before every iterate call, across rungs, compose, plan
 * attempts and nested levels. What remains inexact is only the granularity of a single iterate
 * call: it is stopped at its own cap, so the last call may end ON the ceiling, never above it.
 *
 * Measurements taken BEFORE this date (including the 2026-07-27 scorecard) ran under the old
 * non-subtractive semantics, so their per-task call counts are real measurements rather than
 * budget-derived, and are not comparable to a post-change run at the same nominal budget.
 */
export function tier0Draws(maxModelCalls?: number): number {
  const want = Math.max(1, Number(process.env.CRUCIBLE_LADDER_K || 4))
  return Math.max(1, Math.min(want, Math.floor((maxModelCalls ?? 12) / 2)))
}

/**
 * TIER 0 — K blind draws issued concurrently across the backend's KV slots, each verified, plus a
 * zero-model mechanical repair sweep over the failures.
 *
 * No feedback, no beam, no epochs: this is the "is it actually easy?" probe, and on the tasks the
 * control arm solves at draw 1 it is the whole answer for ~5s. The repair sweep is included because
 * it costs ~36ms and the same control arm measured roughly a THIRD of terminal failures being JS
 * gotchas the verifier NAMES ("Assignment to constant variable") rather than reasoning failures.
 *
 * Returns the certified code plus the full attempt list, which the later tiers consume as evidence.
 */
async function ladderTier0(
  spec: TaskSpec, k: number, signal?: AbortSignal,
): Promise<{ code: string | null; attempts: Attempt<string>[]; modelCalls: number; detail: string }> {
  let cands
  try {
    cands = await proposeCodeBatch({ spec, history: [], diversify: true, signal }, k)
  } catch (e: any) {
    // A backend without batch support must cost the ladder nothing — fall straight through to
    // tier 1, which uses the plain serial proposer.
    return { code: null, attempts: [], modelCalls: 0, detail: `blind draw unavailable: ${String(e?.message ?? e).slice(0, 80)}` }
  }
  // ACCOUNTING: charge all `k` slots, not the number of candidates we happened to inspect before an
  // early return. The batch decodes every slot concurrently BEFORE any of them is verified, so the
  // model work is already spent when the first one passes — billing 1 for a 4-slot batch would
  // understate the tier in exactly the reports that decide whether it earns its place. Slots that
  // came back empty still cost a decode, so they are charged too. (Matches the control arm's own
  // `calls: K` in __direct_vs_decompose_live.ts.)
  const modelCalls = k
  const attempts: Attempt<string>[] = []
  for (const c of cands) {
    const verdict = await verifyCode(c, spec)
    attempts.push({ candidate: c, verdict })
    if (verdict.pass) {
      return { code: c.value, attempts, modelCalls, detail: `blind draw ${attempts.length}/${k} certified` }
    }
  }
  if (signal?.aborted || !attempts.length) {
    // Charge `k` here too. `attempts` is empty whenever every slot decoded to empty/whitespace —
    // proposeCodeBatch drops nulls, and fmComplete swallows a timeout or a downed sidecar to ''. The
    // decodes still happened, so billing 0 would hide exactly the runs where the head is misbehaving
    // (and would repeat, on this branch, the 4-slots-billed-as-1 bug this tier already fixed above).
    return { code: null, attempts, modelCalls, detail: attempts.length ? 'aborted' : 'no candidate drawn (all slots decoded empty)' }
  }
  // Free deterministic sweep licensed by the failing draws' own verifier signals. No model call, so
  // it is not charged — and it is still executed against the same cases before it can be returned.
  try {
    const fixed = await makeMechanicalRepairProposer()({ spec, history: attempts, diversify: false, signal })
    if (fixed) {
      const v = await verifyCode(fixed, spec)
      attempts.push({ candidate: fixed, verdict: v })
      if (v.pass) return { code: fixed.value, attempts, modelCalls, detail: `mechanical repair of a blind draw certified (0 extra model calls)` }
    }
  } catch { /* a repair failure must never sink the tier */ }
  const best = attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a))
  return { code: null, attempts, modelCalls, detail: `${k} blind draw(s) + repair sweep did not certify (best score ${best.verdict.score})` }
}

/**
 * Run a case-based spec up the ladder and stop at the first tier that CERTIFIES.
 *
 * `gate` is the caller's independent invariant check (metamorphic + supplemental property). It is
 * applied identically at every tier — a cheap tier is never allowed to ship something an expensive
 * one would have been rejected for.
 */
export async function solveByLadder(
  nl: string,
  entry: string,
  cases: CodeAcceptance['cases'],
  opts: SolveCodingOpts,
  gate: (code: string | null, entry?: string) => Promise<boolean>,
  /** All functions the module must export, for multi-function gold specs. Defaults to [entry]. */
  entries?: string[],
  /**
   * TRUE when `cases` are the USER's own stated examples. Disables tier 2, whose entire warrant is
   * that independent implementations outvote ONE MODEL-INVENTED value — an argument that does not
   * transfer to a value a human wrote. See the tier-2 block.
   */
  casesAreGold = false,
): Promise<LadderOutcome> {
  const emit = opts.emit ?? (() => {})
  const steps: LadderStep[] = []
  let modelCalls = 0
  let search: SearchResult<string> | null = null
  const multi = entries && entries.length > 1 ? entries : undefined
  const spec: TaskSpec = { goal: nl, domain: 'code', acceptance: { entry, entries: multi, cases } as unknown as Record<string, unknown> }

  const record = (tier: LadderTier, label: string, t0: number, calls: number, solved: boolean, detail: string) => {
    steps.push({ tier, label, modelCalls: calls, wallMs: Date.now() - t0, solved, detail })
    emit({ type: 'thought', text: `ladder tier ${tier} (${label}): ${solved ? 'CERTIFIED' : 'no'} — ${detail}` })
  }
  const won = (tier: LadderTier, code: string, winCases: CodeAcceptance['cases'], detail: string): LadderOutcome => ({
    status: 'solved', code, tier, cases: winCases, steps, search, modelCalls, detail,
  })

  // A class with a known algorithm-shaped carve is provably ~0% by sampling (basicCalculator,
  // evalRPN, editDistance, calculatorWithParens: ~0/3 at eight direct draws) — so tiers 1 and 2 are
  // budget poured into a search the control arm says cannot converge. Take the cheap tier-0 lottery
  // ticket anyway (~5s) and then jump straight to the carve. This preserves the old EARLY-CARVE
  // routing while adding the one tier that is too cheap to skip.
  // Tier 3's OWN guards (≥3 cases, single-entry) are stricter than `opts.decompose`, so the skip
  // must be conditioned on the carve actually being reachable. Otherwise a templated task with 2
  // examples, or a multi-function one, skips tiers 1 AND 2 toward a tier 3 that never runs — it
  // spends the tier-0 draws and abstains with the rest of the caller's budget untouched, which is
  // strictly worse than the pre-ladder path (that one always ran the flat search).
  const willCarve = !!opts.decompose && cases.length >= 3 && !multi
  const templated = hasDecomposeTemplate(nl, entry) && willCarve

  // ── SUBTRACTIVE BUDGET ────────────────────────────────────────────────────────
  // `maxModelCalls` used to be read by tier 0 and then handed to tier 1 UNCHANGED, so each tier
  // spent the caller's whole budget over again and tier 3's per-rung purses ignored it entirely:
  // `maxModelCalls: 6` really licensed 6/2 + 6 flat calls plus an unbounded carve. Nothing capped
  // it but the AbortSignal, and that is not a substitute — a wall-clock cap bounds TIME, and the
  // thing this budget exists to bound is CALLS, which is what the doctrine's
  // information-per-model-call discipline is actually measured in. (The wall-clock ceiling had the
  // same defect on a different axis; see IterateOpts.deadline.)
  //
  // `modelCalls` is already the running total every tier adds to, so it is the ledger — `left()`
  // just reads the remainder from it. Undefined budget stays unbounded, exactly as before.
  const callCeiling = opts.maxModelCalls
  const left = (): number => (callCeiling === undefined ? Infinity : Math.max(0, callCeiling - modelCalls))
  const exhausted = (): boolean => left() <= 0

  // ── tier 0 ────────────────────────────────────────────────────────────────────
  // Kept in scope for tier 2: the K blind draws are the most INDEPENDENT implementations the system
  // produces, which is exactly the evidence poisoned-case recovery needs.
  let tier0Attempts: Attempt<string>[] = []
  if (opts.tier0 !== false && process.env.CRUCIBLE_LADDER_T0 !== '0' && !opts.signal?.aborted) {
    const t0 = Date.now()
    const r = await ladderTier0(spec, tier0Draws(opts.maxModelCalls), opts.signal)
    modelCalls += r.modelCalls
    tier0Attempts = r.attempts
    const pass = !!r.code && await gate(r.code, entry)
    record(0, 'blind concurrent draws', t0, r.modelCalls, pass, r.code && !pass ? `${r.detail} but failed the invariant gate` : r.detail)
    if (pass) return won(0, r.code!, cases, `tier 0 (${r.detail}) in ${r.modelCalls} model call(s)`)
    // Hand the best failing draw forward: tier 1 then opens with executed failure evidence and the
    // model-free single-token mutation sweep instead of a cold prompt. Never overrides a caller's
    // own repair seed.
    if (!opts.buggyCode && r.attempts.length) {
      const best = r.attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a))
      opts = { ...opts, buggyCode: best.candidate.value }
    }
  }

  // ── tier 1 — serial search with verifier feedback (+ mechanical & mutation repair) ──
  // Tier 2 is deliberately NOT budget-gated below: it is model-free, so an exhausted budget is no
  // reason to skip it — free evidence is still evidence.
  if (!templated && !opts.signal?.aborted && !exhausted()) {
    if (opts.converge) {
      const t0 = Date.now()
      const it = await iterateCodeTask({ goal: nl, nl, entry, cases, webGround: opts.webGround }, {
        signal: opts.signal, emit: opts.emit, ...opts.iterate,
      })
      modelCalls += it.modelCalls
      const pass = it.status === 'solved' && !!it.solution && await gate(it.solution.value, entry)
      record(1, 'converge', t0, it.modelCalls, pass, it.detail)
      if (pass) {
        return {
          ...won(1, it.solution!.value, cases, `tier 1 converged in ${it.epochs} epoch(s) (${it.modelCalls} model call(s)); ${it.detail}`),
          // Surfaced so callers can keep reporting when convergence EARNED the answer (epochs > 1).
          converged: { epochs: it.epochs, modelCalls: it.modelCalls },
        }
      }
    }
    const t0 = Date.now()
    // Tier 1 gets what tier 0 LEFT, not the caller's original budget.
    const result = await solveCodeTask({ goal: nl, entry, entries: multi, cases, buggyCode: opts.buggyCode },
      callCeiling === undefined ? opts : { ...opts, maxModelCalls: left() })
    search = result
    modelCalls += result.modelCalls
    const pass = result.status === 'solved' && await gate(result.solution?.value ?? null, entry)
    record(1, 'serial search + repair', t0, result.modelCalls, pass, result.detail)
    if (pass) return won(1, result.solution!.value, cases, `tier 1 flat search; ${result.detail}`)
  }

  // ── tier 2 — model-free operators over everything drawn so far ─────────────────
  // NEVER on gold. recoverFromPoisonedCase DELETES an acceptance case when ≥2 independent impls
  // agree it is wrong, and its warrant (see its docstring) is explicitly "independent
  // implementations agreeing outweigh one MODEL-INVENTED value". Against a case the USER wrote that
  // warrant inverts: two drafts making the same mistake would silently erase the user's stated
  // requirement and return `cases: rec.cleaned`, so the caller reports 'solved' with code that
  // contradicts an example the user typed. That is shipping a wrong answer, not abstaining.
  if (!templated && !casesAreGold && !opts.signal?.aborted) {
    const t0 = Date.now()
    const pool = [...tier0Attempts, ...(search?.attempts ?? [])]
    const rec = await recoverFromPoisonedCase(entry, cases, pool)
    const pass = !!rec && await gate(rec.code, entry)
    record(2, 'poisoned-case recovery', t0, 0, pass,
      rec ? `${rec.nAgree} independent impls agreed one case was wrong` : `no case had ≥2 independent impls against it (${pool.length} attempt(s) examined)`)
    if (pass) return won(2, rec!.code, rec!.cleaned, `tier 2 dropped 1 suspect case (${rec!.nAgree} independent impls agreed it was wrong), certified against ${rec!.cleaned.length}`)
  }

  // ── tier 3 — sub-function decomposition ───────────────────────────────────────
  // Single-entry only: this machinery carves and composes ONE function, so a multi-function gold
  // spec has nothing here to escalate to. Needs ≥3 cases to both carve helpers and re-verify the
  // composed whole meaningfully.
  if (opts.decompose && cases.length >= 3 && !multi && !opts.signal?.aborted && !exhausted()) {
    const t0 = Date.now()
    // The carve's per-rung purse is clamped to what the ladder has left, AND the ladder's ledger
    // itself is handed down (2026-08-01) so the carve's TOTAL is exact rather than per-rung. Before
    // that, `globalModelCalls` being a PER-CALL cap meant an N-rung carve could spend up to N × the
    // clamp — the clamp bounded each rung, nothing bounded their sum. `left()` reads the ladder's
    // running `modelCalls`, which the carve's own spend is added to only on return, so the carve
    // subtracts its in-flight spend from this remainder internally (see `budget` there).
    const rungBudget = opts.iterate ?? decomposePerRungBudget(nl, entry)
    const clamped = callCeiling === undefined ? rungBudget : {
      ...rungBudget,
      globalModelCalls: Math.max(1, Math.min(rungBudget.globalModelCalls ?? Infinity, left())),
    }
    const d = await decomposeCodeBySubFunction(
      { goal: nl, nl, entry, cases },
      { webGround: opts.webGround, signal: opts.signal, emit: opts.emit, iterate: clamped,
        budget: callCeiling === undefined ? undefined : { left } },
    )
    modelCalls += d.modelCalls
    const pass = d.status === 'solved' && !!d.code && await gate(d.code, entry)
    record(3, 'sub-function decomposition', t0, d.modelCalls, pass, d.detail)
    if (pass) {
      const how = d.helpers.length ? `via ${d.helpers.length} certified helper(s)` : 'via a single probe draft'
      return won(3, d.code!, cases, `tier 3 decomposition certified ${how} (${d.modelCalls} model call(s))`)
    }
  }

  return { status: 'unsolved', code: null, tier: null, cases, steps, search, modelCalls,
    detail: `no tier certified (${steps.map(s => `t${s.tier}:${s.modelCalls}c/${Math.round(s.wallMs / 1000)}s`).join(' ')})` }
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
  /**
   * WHICH LADDER TIER certified this (0 = K blind concurrent draws, 1 = feedback search, 2 =
   * model-free operators, 3 = decomposition). Null when nothing certified, absent on the paths that
   * do not use the ladder (property / metamorphic / canonical, which are case-free by construction).
   *
   * This field exists because the 2026-07-26 control arm found four sessions of work had been spent
   * improving tier 3 without anyone measuring whether tier 3 was the tier doing the work — it was
   * not, on 4 of 5 general tasks. An unattributed solve is how that happens; reporting the tier is
   * how it stops happening.
   */
  tier?: LadderTier | null
  /** Every tier attempted, with its own model-call and wall-clock cost — solved or not. */
  ladder?: LadderStep[]
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
export type SolveCodingOpts = SearchOpts<string> & {
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
    /**
     * LADDER TIER 0 — K concurrent blind draws before any feedback-guided search. Default ON; set
     * false (or `CRUCIBLE_LADDER_T0=0`) to measure the ladder without it. See the ladder block
     * above for why it leads: it costs one round trip and the control arm says it is the whole
     * answer on a large fraction of tasks.
     */
    tier0?: boolean
  }

export async function solveCodingRequest(
  nl: string,
  opts: SolveCodingOpts = {},
): Promise<CodingRequestResult> {
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
    const nFns = harvested.entries.length
    // GOLD needs no invariant gate: the cases came from the USER, which is the highest-trust ground
    // truth this system has. metaGate/suppGate exist to protect the LOWER tiers, whose outputs were
    // fuzzed or model-guessed. (They are also not yet in scope here — they are derived below.)
    const lad = await solveByLadder(nl, harvested.entry, harvested.cases, opts, async () => true, harvested.entries, true)
    const goldPrefix = `${harvested.cases.length} user example(s) (gold)${nFns > 1 ? ` across ${nFns} functions [${harvested.entries.join(', ')}]` : ''}`
    if (lad.status === 'solved') {
      return { status: 'solved', code: lad.code, entry: harvested.entry, cases: lad.cases, search: lad.search,
        tier: lad.tier, ladder: lad.steps, converged: lad.converged,
        detail: `${goldPrefix}; ${lad.detail}` }
    }
    return {
      status: lad.search?.status ?? 'abstained',
      code: null,
      entry: harvested.entry, cases: harvested.cases, search: lad.search,
      tier: null, ladder: lad.steps,
      detail: `${goldPrefix}; ${lad.detail}`,
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

  // Run a case-based spec up the escalation ladder (tier 0 blind draws → tier 1 feedback search →
  // tier 2 model-free operators → tier 3 decomposition), stopping at the first tier the verifier
  // AND both independent invariant gates accept. Replaces the old fixed converge → search →
  // recovery → decompose sequence, which paid the most expensive path's price on every task.
  const runLadder = async (
    entry: string, cases: CodeAcceptance['cases'], detailPrefix: string,
  ): Promise<CodingRequestResult> => {
    const lad = await solveByLadder(nl, entry, cases, opts, invariantGate)
    if (lad.status === 'solved') {
      const gated = [meta && `${meta.family}`, supp && `${supp.family}`].filter(Boolean).join(' + ')
      return { status: 'solved', code: lad.code, entry, cases: lad.cases, search: lad.search,
        tier: lad.tier, ladder: lad.steps, converged: lad.converged,
        detail: `${detailPrefix}${gated ? ` (also passed the ${gated} invariant)` : ''}; ${lad.detail}` }
    }
    return { status: lad.search?.status ?? 'abstained', code: null, entry, cases, search: lad.search,
      tier: null, ladder: lad.steps, detail: `${detailPrefix}; ${lad.detail}` }
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
      // The old EARLY CLASS-ROUTING (2026-07-22l) lives inside the ladder now: a class with an
      // algorithm-shaped template is ~0% by sampling, so the ladder still skips tiers 1-2 for it and
      // carves — but it takes the ~5s tier-0 ticket first, which the old branch could not.
      const lad = await runLadder(entry, cases, diff.detail)
      if (lad.status === 'solved') return lad
      // Fall through to the weaker path only if differential could not certify.
    }
  }

  // 4) Last resort — model-invented consensus cases (bias-prone; used only when nothing better).
  const extraction = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
  if (extraction.ok && extraction.spec) {
    const { entry, cases } = extraction.spec
    // Tier 2's poisoned-case recovery matters most HERE: a model-invented case may simply be WRONG,
    // making a solvable spec unsatisfiable, and the ladder now feeds that recovery tier 0's blind
    // concurrent draws as well as tier 1's — i.e. genuinely independent implementations, which is
    // exactly the evidence the cross-derivation argument requires.
    return runLadder(entry, cases, extraction.detail)
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
