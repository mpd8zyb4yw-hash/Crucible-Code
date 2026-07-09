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
