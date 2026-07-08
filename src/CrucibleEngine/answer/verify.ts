// Deterministic, strict-offline critics for the answer engine.
//
// MISSION: the intelligence lives in the SYSTEM, not the model. The FM is the messenger —
// so before any answer ships, the system must CHECK it with code, not trust it. Under
// CRUCIBLE_OFFLINE=strict there is no online judge to escalate to, so every critic here is
// deterministic (arithmetic evaluation, string/number entailment) — never a model call.
//
// Stage 1 ships the arithmetic critic (reusing the proven correctArithmeticCascade) plus
// cheap answer-sanity signals. Stage 2 adds word-problem recomputation; Stage 3 adds
// retrieval-grounding entailment. Each critic returns a structured Issue the engine turns
// into a targeted repair directive.

import { correctArithmeticCascade } from '../domainVerifiers'

export interface Issue {
  kind: 'arithmetic' | 'empty' | 'truncated' | 'nonanswer'
  /** Human-readable defect, spliced into the repair prompt so the FM fixes THIS, not vibes. */
  detail: string
  /** When set, the critic already produced a corrected text (deterministic fix, no re-prompt). */
  fixedText?: string
}

// A reply that trails off mid-token/mid-clause — small FMs do this when they hit the token
// cap. We only flag the egregious case (ends with a dangling connective / open bracket / no
// terminal punctuation on a long reply) so we don't nag on legitimately short factual answers.
function looksTruncated(text: string): boolean {
  const t = text.trimEnd()
  if (t.length < 40) return false
  if (/[.!?)\]}"'`]$/.test(t)) return false
  if (/\b(and|but|or|the|a|an|to|of|for|with|that|which|because|so|then|is|are|was)$/i.test(t)) return true
  return !/[.!?]$/.test(t) && t.length > 200
}

// The FM sometimes "answers" by restating the question or emitting meta-chatter
// ("Sure, I can help with that!") with no content. Cheap heuristic guard.
function isNonAnswer(text: string, message: string): boolean {
  const t = text.trim().toLowerCase()
  if (!t) return true
  if (/^(sure|okay|ok|certainly|of course|i can help|happy to help|let me)\b[^.!?]*[.!?]?$/i.test(t) && t.length < 60) return true
  // Pure echo of the prompt.
  if (t.length < message.length * 1.2 && t.replace(/[^a-z0-9]/g, '') === message.trim().toLowerCase().replace(/[^a-z0-9]/g, '')) return true
  return false
}

/**
 * Run the Stage-1 deterministic critics over a drafted answer.
 * Returns the (possibly arithmetic-corrected) text and any issues that need a repair round.
 * Never throws, never calls a model.
 */
export function critiqueAnswer(draft: string, message: string): { text: string; issues: Issue[] } {
  const issues: Issue[] = []
  let text = draft ?? ''

  if (!text.trim()) {
    issues.push({ kind: 'empty', detail: 'The answer was empty.' })
    return { text, issues }
  }

  // ── Arithmetic critic — deterministic oracle, corrects in place (no re-prompt needed). ──
  try {
    const { text: fixed, corrections } = correctArithmeticCascade(text)
    if (corrections.length) {
      text = fixed
      issues.push({
        kind: 'arithmetic',
        detail: corrections.map(c => `${c.expr} = ${c.now} (answer said ${c.was})`).join('; '),
        fixedText: fixed,
      })
    }
  } catch { /* non-blocking: keep the original text */ }

  if (isNonAnswer(text, message)) {
    issues.push({ kind: 'nonanswer', detail: 'The reply acknowledged the request but did not actually answer it.' })
  } else if (looksTruncated(text)) {
    issues.push({ kind: 'truncated', detail: 'The answer appears cut off before finishing.' })
  }

  return { text, issues }
}

/** True when the only issues were deterministically fixed in place (no FM repair round needed). */
export function allFixedInPlace(issues: Issue[]): boolean {
  return issues.length > 0 && issues.every(i => !!i.fixedText)
}
