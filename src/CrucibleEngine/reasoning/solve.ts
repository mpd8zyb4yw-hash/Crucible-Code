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
import { search, type SearchOpts } from './search'
import { type Completer, extractCodeSpec } from './specExtractor'
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
  const extraction = await extractCodeSpec(nl, { samples: opts.specSamples, complete: opts.specComplete })
  if (!extraction.ok || !extraction.spec) {
    return { status: 'abstained', code: null, entry: null, cases: null, search: null,
      detail: `could not form a checkable spec: ${extraction.reason ?? 'unknown'}` }
  }
  const { entry, cases } = extraction.spec
  const result = await solveCodeTask({ goal: nl, entry, cases }, opts)
  return {
    status: result.status,
    code: result.status === 'solved' ? (result.solution?.value ?? null) : null,
    entry, cases, search: result,
    detail: `${extraction.detail}; ${result.detail}`,
  }
}
