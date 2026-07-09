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

import { proposeCode } from './codeProposer'
import { type CodeAcceptance, verifyCode } from './codeVerifier'
import { derivePropertySpec, verifyByProperty } from './propertyVerifier'
import { search, type SearchOpts } from './search'
import { type Completer, extractCodeSpec, harvestExplicitExamples } from './specExtractor'
import type { Proposer, SearchResult, TaskSpec, Verifier } from './types'

export interface SolveCodeInput {
  goal: string
  entry: string
  cases: CodeAcceptance['cases']
  context?: string
  timeoutMs?: number
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
  const spec: TaskSpec = {
    goal: input.goal,
    domain: 'code',
    context: input.context,
    acceptance: {
      entry: input.entry,
      cases: input.cases,
      timeoutMs: input.timeoutMs,
    } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
  const proposer: Proposer<string> = proposerOverride ?? proposeCode
  const verifier: Verifier<string> = verifyCode
  return search(spec, proposer, verifier, opts)
}

export interface CodingRequestResult {
  /** 'solved' → certified code in .code; 'abstained' → no trustworthy spec/solution. */
  status: SearchResult<string>['status'] | 'abstained'
  code: string | null
  entry: string | null
  cases: CodeAcceptance['cases'] | null
  search: SearchResult<string> | null
  detail: string
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
  opts: SearchOpts & { specSamples?: number; specComplete?: Completer } = {},
): Promise<CodingRequestResult> {
  // Ground-truth priority (DOCTRINE.md — trust order): 1) the USER's own worked examples
  // (gold), 2) a GENERAL PROPERTY (sort=sorted-permutation, codec=roundtrip, …; true for all
  // inputs, no model bias), 3) only as a last resort, model-invented consensus cases (which
  // can be confidently wrong — the vote-bias trap). Properties are preferred over model cases
  // precisely because a model-invented case with no user anchor can make a solvable spec
  // unsatisfiable and force a false exhaust (observed live on sortAsc).

  // 1) USER-stated examples — gold, trusted without consensus.
  const harvested = harvestExplicitExamples(nl)
  if (harvested.cases.length >= 1) {
    const result = await solveCodeTask({ goal: nl, entry: harvested.entry, cases: harvested.cases }, opts)
    return {
      status: result.status,
      code: result.status === 'solved' ? (result.solution?.value ?? null) : null,
      entry: harvested.entry, cases: harvested.cases, search: result,
      detail: `${harvested.cases.length} user example(s) (gold); ${result.detail}`,
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

  // 3) Last resort — model-invented consensus cases (bias-prone; used only when nothing better).
  const extraction = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
  if (extraction.ok && extraction.spec) {
    const { entry, cases } = extraction.spec
    const result = await solveCodeTask({ goal: nl, entry, cases }, opts)
    return {
      status: result.status,
      code: result.status === 'solved' ? (result.solution?.value ?? null) : null,
      entry, cases, search: result,
      detail: `${extraction.detail}; ${result.detail}`,
    }
  }

  return { status: 'abstained', code: null, entry: null, cases: null, search: null,
    detail: `could not form a checkable spec: ${extraction.reason ?? 'unknown'}` }
}
