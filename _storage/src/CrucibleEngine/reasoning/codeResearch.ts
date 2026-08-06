// ═══════════════════════════════════════════════════════════════════════════════
// CODE RESEARCH — the doctrine-sound ResearchFn for the code domain
// ═══════════════════════════════════════════════════════════════════════════════
//
// iterate() (iterate.ts) is domain-agnostic: it runs search() as epochs, and when an
// epoch STALLS it calls a ResearchFn to fold grounding into the next epoch. This file
// is that injector for CODE. It has exactly two channels, ranked by the same rule the
// whole engine obeys — never let research corrupt ground truth:
//
//   CHANNEL 1 — PROPOSER GROUNDING (always safe).
//     Each epoch is a FRESH search() with empty history, so the rich per-case feedback
//     the last epoch earned ("case f(3,4) → got 7, expected 12") is otherwise thrown
//     away at the epoch boundary. We distil the best failing attempt's signals into a
//     compact "known failing behaviour" note and append it to spec.context. This can
//     only guide the proposer; it can NEVER change what "correct" means. So it is
//     unconditionally sound.
//
//   CHANNEL 2 — SOUND VERIFIER-TIGHTENING (differential consensus).
//     A stall on a THIN case set usually means the spec is underspecified: the proposer
//     keeps finding degenerate impls that pass the few cases yet are wrong. We do NOT
//     invent a case the model "believes" (that would poison ground truth — the exact
//     trap DOCTRINE.md warns about). Instead we derive fresh cases by DIFFERENTIAL
//     CONSENSUS: the system fuzzes inputs and ≥2 INDEPENDENTLY-WRITTEN implementations
//     must AGREE by EXECUTION on the output. That agreement is independently-justified
//     ground truth, not a guess, so merging the NEW cases into acceptance is sound. If
//     no quorum forms, we add nothing (abstain over guess).
//
// Channel 2 costs model calls (it samples impls), so it fires sparingly — only while
// the case set is thin enough that tightening plausibly helps.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CodeAcceptance, CodeCase } from './codeVerifier'
import { deriveDifferentialSpec, type DifferentialOpts } from './differentialSpec'
import type { ResearchFn, ResearchOutput } from './iterate'

export interface CodeResearchOpts {
  /** Natural-language request — needed to sample independent impls for channel 2. */
  nl: string
  /**
   * Sound verifier-tightening via differential consensus. `false` disables channel 2
   * entirely (channel 1 only). An options object tunes/injects the derivation (tests
   * pass a deterministic sampleImpls). Default: enabled with library defaults.
   */
  differential?: DifferentialOpts | false
  /**
   * Only attempt channel-2 tightening while the acceptance case count is at or below
   * this threshold (a thin spec is where a wrong degenerate impl slips through). Default 6.
   */
  tightenWhenCasesAtMost?: number
  /** Cap on how many NEW differential cases a single research call may add. Default 8. */
  maxNewCasesPerCall?: number
  /**
   * WEB grounding (channel 3): on a stall, fetch reference implementations / API usage from the
   * open web (StackOverflow, docs) for `nl`, folded into PROPOSER CONTEXT as a hint. DOCTRINE-SOUND
   * because it only tightens the PROPOSER, never the verifier — the retrieved code is never trusted,
   * and the candidate that adapts it is still EXECUTED against the spec/oracle. Injected so the
   * network stays out of the pure loop; returns null when nothing useful is found. Fires at most
   * once per solve (marked in context so later stalls don't re-fetch). Absent → channel 3 off.
   */
  webGround?: (query: string) => Promise<string | null>
}

/** Sentinel prefixing a web-grounded block — lets the ResearchFn detect (via priorContext) that it
 *  already fetched, so a later stall doesn't re-hit the network, and cues the model that the snippet
 *  is a REFERENCE to adapt, not trusted ground truth (only execution certifies). */
export const WEB_GROUND_MARK = '### Web reference (adapt to the spec — NOT trusted; your code is executed against hidden cases):'

/** Build a CODE-optimized web-search query from the request: keep the goal, append the target
 *  function name and a language hint so the retrieval layer ranks real implementations (a raw
 *  chat sentence like "can you write me something that…" retrieves poorly). Bounded length. */
export function buildCodeSearchQuery(nl: string, entry?: string): string {
  const goal = (nl ?? '').replace(/\b(can|could|would|please|you|write|me|a|an|the|function|that|which|to)\b/gi, ' ')
    .replace(/[^\w\s+#.-]/g, ' ').replace(/\s+/g, ' ').trim()
  const lang = /\b(typescript|\.ts|tsx)\b/i.test(nl) ? 'typescript' : 'javascript'
  const fn = entry ? ` ${entry}` : ''
  return `${goal}${fn} ${lang}`.replace(/\s+/g, ' ').trim().slice(0, 200)
}

/** Stable identity of a case for union/dedup: which function + which arguments. */
function caseKey(entry: string, c: CodeCase): string {
  try { return `${c.entry ?? entry}::${JSON.stringify(c.args ?? [])}` }
  catch { return `${c.entry ?? entry}::<unserialisable>` }
}

/**
 * Union incoming acceptance cases into the current ones by (entry,args). Existing cases
 * WIN on a key collision — we never let research overwrite an expected value already in
 * the spec (that would be silent ground-truth rewriting; a genuine conflict should
 * surface as a failing case, not be papered over). Suitable as iterate()'s mergeAcceptance.
 */
export function mergeCodeAcceptance(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const cur = current as unknown as CodeAcceptance
  const inc = incoming as unknown as Partial<CodeAcceptance>
  if (!inc.cases?.length) return current
  const entry = cur.entry
  const seen = new Set((cur.cases ?? []).map(c => caseKey(entry, c)))
  const merged = [...(cur.cases ?? [])]
  for (const c of inc.cases) {
    const k = caseKey(entry, c)
    if (seen.has(k)) continue
    seen.add(k); merged.push(c)
  }
  return { ...current, cases: merged }
}

/** Distil a failing verdict's signals into a compact, deduped proposer hint. */
function groundingFromSignals(signals: string[]): string | null {
  const useful = signals
    .map(s => s.trim())
    .filter(s => s && !/^all \d+ case/.test(s))
    // keep the high-information lines (got/expected/threw/error), drop noise.
    .filter(s => /got |expected|threw|error|violated/i.test(s))
    .slice(0, 6)
  if (!useful.length) return null
  return ['Known failing behaviour from the previous attempt — fix these specifically:',
    ...useful.map(s => `  • ${s}`)].join('\n')
}

/**
 * Build the code-domain ResearchFn for iterate(). Channel 1 always runs; channel 2 runs
 * only when enabled AND the spec is thin enough to benefit. Returns null when it has
 * nothing NEW to add (already-seen grounding, no fresh quorum) so the stall counter is
 * free to advance toward an honest abstain — research must not manufacture false progress.
 */
export function makeCodeResearchFn(opts: CodeResearchOpts): ResearchFn<string> {
  const differential = opts.differential
  const tightenAtMost = opts.tightenWhenCasesAtMost ?? 6
  const maxNew = opts.maxNewCasesPerCall ?? 8

  return async ({ spec, best, priorContext, signal }) => {
    const out: ResearchOutput = {}
    const notes: string[] = []

    // ── Channel 1: proposer grounding from the best failure (always safe). ──────────
    if (best?.verdict?.signals?.length) {
      const grounding = groundingFromSignals(best.verdict.signals)
      // Only inject if it is genuinely new — otherwise it is not progress.
      if (grounding && !priorContext.some(p => p.includes(grounding))) {
        out.context = grounding
        notes.push('carried prior-epoch counterexamples into proposer context')
      }
    }

    // ── Channel 2: sound verifier-tightening via differential consensus. ────────────
    const acc = spec.acceptance as unknown as CodeAcceptance
    const caseCount = acc?.cases?.length ?? 0
    const canTighten = differential !== false && Array.isArray(acc?.cases) && caseCount <= tightenAtMost
    if (canTighten && !signal?.aborted) {
      try {
        const diff = await deriveDifferentialSpec(opts.nl, {
          ...(differential || {}),
          entry: (differential && differential.entry) || acc.entry,
        })
        if (diff.ok && diff.spec?.cases?.length) {
          const existing = new Set((acc.cases ?? []).map(c => caseKey(acc.entry, c)))
          const fresh = diff.spec.cases
            .filter(c => !existing.has(caseKey(acc.entry, c)))
            .slice(0, maxNew)
          if (fresh.length) {
            out.acceptance = { cases: fresh }
            notes.push(`tightened verifier with ${fresh.length} differential-consensus case(s)`)
          }
        }
      } catch { /* a research failure must never break the loop; fall through */ }
    }

    // ── Channel 3: WEB grounding — reference snippets from the open web, PROPOSER-only. ──────
    // Sound: retrieved code is a HINT folded into proposer context; the candidate is still executed
    // against the spec, so a wrong/irrelevant snippet can only waste a proposal, never certify a
    // false answer. Fires at most once (the marker in priorContext blocks a re-fetch on later
    // stalls), best-effort, and only when it returns something new.
    const alreadyWebGrounded = priorContext.some(p => p.startsWith(WEB_GROUND_MARK))
    if (opts.webGround && !alreadyWebGrounded && !signal?.aborted) {
      try {
        const query = buildCodeSearchQuery(opts.nl, (spec.acceptance as { entry?: string })?.entry)
        const snippet = (await opts.webGround(query))?.trim()
        if (snippet) {
          const block = `${WEB_GROUND_MARK}\n${snippet}`
          out.context = out.context ? `${out.context}\n\n${block}` : block
          notes.push('folded web reference snippets into proposer context')
        }
      } catch { /* a research failure must never break the loop; fall through */ }
    }

    if (!out.context && !out.acceptance) return null
    out.note = notes.join('; ')
    return out
  }
}
