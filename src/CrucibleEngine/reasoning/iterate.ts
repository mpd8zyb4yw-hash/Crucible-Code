// ═══════════════════════════════════════════════════════════════════════════════
// ITERATE — the outer convergence loop over VGR search()
// ═══════════════════════════════════════════════════════════════════════════════
//
// search() is a BOUNDED beam search: it abstains the moment it exhausts a fixed
// model-call budget or stalls for `patience` rounds. That is correct for a single
// attempt, but it is not "iterate until correct." This layer sits ABOVE search()
// and turns it into a progress-gated convergence loop:
//
//   • Run search() as one EPOCH with a modest budget.
//   • If it certifies a solution → done (correctness from the verifier, as always).
//   • If not, decide whether to KEEP GOING — but only on EVIDENCE of progress:
//        - the best verdict SCORE strictly improved vs the last epoch  → keep going,
//          the loop is climbing; give it a wider beam and more calls.
//        - it did NOT improve → we are stuck. Before abstaining, INJECT RESEARCH:
//          gather grounding (retrieved docs, an independently-derived counterexample,
//          a reference implementation) and fold it into the spec for the next epoch.
//        - research moved nothing for `stallLimit` consecutive epochs → we have hit
//          the frontier of what is achievable HERE. Abstain honestly with the best
//          partial. That is "as correct as reality allows" — not a hang, not a lie.
//
// TERMINATION IS DETERMINISTIC. The model never decides to stop. We stop on exactly
// one of: certified pass · measurable stall after research · a hard reality budget
// (wall-clock / global model-call ceiling / epoch cap / abort). The loop can run
// "indefinitely" ONLY while it is provably still improving — otherwise it is guessing,
// and guessing forever is not reasoning.
//
// RESEARCH IS SOUND OR IT IS NOTHING. A ResearchFn may tighten the VERIFIER (add a
// counterexample case to `acceptance`) only with data it can independently justify —
// an authoritative source or a derived reference. It must NEVER inject a case the
// model merely believes, or it would corrupt ground truth. When unsure, it returns
// grounding for the PROPOSER only (spec.context), which cannot compromise correctness.
// ═══════════════════════════════════════════════════════════════════════════════

import { search, type SearchOpts } from './search'
import type { Attempt, Proposer, SearchResult, TaskSpec, Verifier } from './types'

export interface ResearchInput<T = unknown> {
  spec: TaskSpec
  /** Best failing attempt so far — what research should try to move. */
  best: Attempt<T> | null
  /** 0-based epoch index that just stalled. */
  epoch: number
  /** Everything the loop has accumulated in context so far (deduped). */
  priorContext: string[]
  signal?: AbortSignal
}

export interface ResearchOutput {
  /** Grounding for the PROPOSER — appended to spec.context. Always safe. */
  context?: string
  /**
   * NEW acceptance data for the VERIFIER — merged into spec.acceptance. SOUND ONLY:
   * data the research fn independently justified (source/derivation), never a guess.
   * Shape is domain-specific (e.g. `{ cases: [...] }` for the code domain).
   */
  acceptance?: Record<string, unknown>
  /** Human-readable note for the audit trail. */
  note?: string
}

export type ResearchFn<T = unknown> = (
  input: ResearchInput<T>,
) => Promise<ResearchOutput | null>

export interface IterateOpts<T = unknown> extends Pick<SearchOpts, 'signal' | 'emit'> {
  /** Hard cap on epochs regardless of progress (a runaway backstop). Default 8. */
  maxEpochs?: number
  /** Consecutive stalled epochs (research included) tolerated before abstaining. Default 2. */
  stallLimit?: number
  /** Wall-clock ceiling across the whole loop, ms. Reality budget. Default 120_000. */
  wallClockMs?: number
  /** Hard ceiling on total model calls across ALL epochs. Default 64. */
  globalModelCalls?: number
  /** Search budget for epoch 0. Escalates each epoch it keeps going. Default 8. */
  baseModelCalls?: number
  /** Beam width for epoch 0. Escalates on improvement. Default 3. */
  baseBeamWidth?: number
  /** Optional research/grounding injector, called when an epoch stalls. */
  research?: ResearchFn<T>
  /** Injectable clock — Date.now() is banned in some hosts. Default Date.now. */
  now?: () => number
  /** How acceptance data from research merges into spec.acceptance. Default: shallow spread. */
  mergeAcceptance?: (
    current: Record<string, unknown>,
    incoming: Record<string, unknown>,
  ) => Record<string, unknown>
}

export type IterateStatus =
  | 'solved'
  | 'stalled'        // stopped: research could not move the score
  | 'budget'         // stopped: hit a reality ceiling (time / calls / epochs)
  | 'aborted'

export interface IterateResult<T = unknown> {
  status: IterateStatus
  solution: SearchResult<T>['solution']
  best: Attempt<T> | null
  /** Best verdict score reached (frontier of correctness achieved). */
  bestScore: number
  epochs: number
  modelCalls: number
  /** Per-epoch trace for the audit trail. */
  trace: EpochRecord[]
  detail: string
}

export interface EpochRecord {
  epoch: number
  status: SearchResult['status']
  bestScore: number
  modelCalls: number
  improved: boolean
  researched: boolean
  researchNote?: string
}

const DEFAULTS = {
  maxEpochs: 8,
  stallLimit: 2,
  wallClockMs: 120_000,
  globalModelCalls: 64,
  baseModelCalls: 8,
  baseBeamWidth: 3,
}

/**
 * Convergence loop over search(). Keeps iterating while it is measurably improving,
 * injects research when it stalls, and terminates deterministically on pass /
 * research-stall / reality budget. NEVER trusts the model to decide when to stop.
 */
export async function iterate<T>(
  spec: TaskSpec,
  proposer: Proposer<T>,
  verifier: Verifier<T>,
  opts: IterateOpts<T> = {},
): Promise<IterateResult<T>> {
  const o = { ...DEFAULTS, ...opts }
  const emit = opts.emit ?? (() => {})
  const now = opts.now ?? (() => Date.now())
  const mergeAcceptance =
    opts.mergeAcceptance ?? ((cur, inc) => ({ ...cur, ...inc }))

  const start = now()
  const trace: EpochRecord[] = []
  const contextParts: string[] = spec.context ? [spec.context] : []
  const seenContext = new Set(contextParts)

  // Working spec is mutated across epochs as research folds in grounding/acceptance.
  let workingSpec: TaskSpec = { ...spec, acceptance: { ...spec.acceptance } }

  let bestScore = -Infinity
  let best: Attempt<T> | null = null
  let totalCalls = 0
  let stalls = 0

  const finish = (
    status: IterateStatus,
    solution: SearchResult<T>['solution'],
    detail: string,
  ): IterateResult<T> => ({
    status, solution, best, bestScore,
    epochs: trace.length, modelCalls: totalCalls, trace, detail,
  })

  for (let epoch = 0; epoch < o.maxEpochs; epoch++) {
    if (opts.signal?.aborted) return finish('aborted', null, 'aborted before epoch')

    const elapsed = now() - start
    if (elapsed >= o.wallClockMs) {
      return finish('budget', null, `wall-clock budget (${o.wallClockMs}ms) reached at epoch ${epoch}`)
    }
    if (totalCalls >= o.globalModelCalls) {
      return finish('budget', null, `global model-call budget (${o.globalModelCalls}) reached at epoch ${epoch}`)
    }

    // Escalation schedule: each surviving epoch earns a wider beam and more calls,
    // clamped to whatever remains of the global reality budget.
    const beamWidth = o.baseBeamWidth + Math.min(epoch, 3)
    const remainingCalls = o.globalModelCalls - totalCalls
    const epochCalls = Math.max(1, Math.min(o.baseModelCalls + epoch * 2, remainingCalls))

    emit({ type: 'thought', text: `epoch ${epoch}: search (beam ${beamWidth}, ≤${epochCalls} calls, ${Math.round((o.wallClockMs - elapsed) / 1000)}s left)` })

    const result = await search<T>(workingSpec, proposer, verifier, {
      beamWidth,
      maxModelCalls: epochCalls,
      signal: opts.signal,
      emit: opts.emit,
    })
    totalCalls += result.modelCalls

    const epochScore = result.best?.verdict.score ?? -Infinity
    const improved = epochScore > bestScore
    if (result.best && epochScore > bestScore) { bestScore = epochScore; best = result.best }

    if (result.status === 'solved') {
      trace.push({ epoch, status: 'solved', bestScore, modelCalls: result.modelCalls, improved: true, researched: false })
      return finish('solved', result.solution, `solved in epoch ${epoch} (${totalCalls} total model call(s))`)
    }
    if (result.status === 'aborted') {
      trace.push({ epoch, status: 'aborted', bestScore, modelCalls: result.modelCalls, improved, researched: false })
      return finish('aborted', null, 'search aborted mid-epoch')
    }

    // Not solved. Did we climb? If yes, no research needed — press on with a bigger
    // budget on the same spec. If no, we are stuck: try to inject sound grounding.
    let researched = false
    let researchNote: string | undefined
    if (improved) {
      stalls = 0
    } else {
      stalls++
      if (opts.research) {
        try {
          const r = await opts.research({
            spec: workingSpec, best, epoch, priorContext: contextParts.slice(), signal: opts.signal,
          })
          if (r) {
            researched = true
            researchNote = r.note
            if (r.context && !seenContext.has(r.context)) {
              seenContext.add(r.context)
              contextParts.push(r.context)
              workingSpec = { ...workingSpec, context: contextParts.join('\n\n') }
            }
            if (r.acceptance) {
              workingSpec = { ...workingSpec, acceptance: mergeAcceptance(workingSpec.acceptance, r.acceptance) }
            }
            // Fresh grounding is evidence we are NOT truly stuck yet — give the stall
            // counter one epoch of grace so the injected signal can be exploited.
            if (r.context || r.acceptance) stalls = Math.max(0, stalls - 1)
          }
        } catch (e: any) {
          emit({ type: 'thought', text: `research error: ${String(e?.message ?? e)}` })
        }
      }
    }

    trace.push({ epoch, status: result.status, bestScore, modelCalls: result.modelCalls, improved, researched, researchNote })

    if (stalls >= o.stallLimit) {
      return finish('stalled', null,
        `no progress for ${stalls} epoch(s)${opts.research ? ' even after research' : ''} — abstaining at best score ${bestScore}`)
    }
  }

  return finish('budget', null, `epoch cap (${o.maxEpochs}) reached — abstaining at best score ${bestScore}`)
}
