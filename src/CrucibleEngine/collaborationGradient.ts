// Collaboration gradient — the system estimates confidence and adjusts its
// autonomy level accordingly. High confidence → just answers. Medium → answers
// with a caveat. Low → asks one targeted clarifying question before answering.
//
// The clarifying question is chosen to maximally reduce uncertainty (information
// gain heuristic): among the ambiguous dimensions of the question, which one
// most changes the correct answer?

export type CollabMode = 'autonomous' | 'caveat' | 'clarify'

export interface CollabDecision {
  mode: CollabMode
  confidence: number
  caveat?: string          // injected into synthesis when mode === 'caveat'
  clarifyQuestion?: string // surfaced to user when mode === 'clarify'
}

// Signals that indicate the question is genuinely ambiguous or risky to answer
// without clarification — not just hard, but dependent on unknown context.
const AMBIGUITY_SIGNALS = [
  { pattern: /\b(best|better|optimal|recommend)\b/i,          dimension: 'criteria', question: 'What matters most to you — performance, simplicity, or maintainability?' },
  { pattern: /\b(my|our|the)\s+(app|project|codebase|system)\b/i, dimension: 'context', question: 'Can you describe the scale and constraints of your system?' },
  { pattern: /\b(should I|should we)\b/i,                     dimension: 'intent',   question: 'What outcome are you optimising for?' },
  { pattern: /\b(latest|current|now|today|recent)\b/i,        dimension: 'time',     question: 'Are you asking about the current state or a specific version?' },
  { pattern: /\b(vs|versus|or|compare|difference between)\b/i, dimension: 'scope',   question: 'Are you choosing between these options, or trying to understand both?' },
]

export interface CollabOpts {
  // D1 — additive confidence from resolving context already in the conversation/memory.
  contextBoost?: number
  // D1 — when prior context exists, never interrupt with a question: prefer caveat.
  suppressClarify?: boolean
}

export function assessCollabMode(
  question: string,
  predictedScore: number,
  confidence: number,
  sampleSize: number,
  opts: CollabOpts = {}
): CollabDecision {
  // D1 — boost confidence by context the user already supplied (prior turns / memory).
  const conf = Math.min(1, confidence + (opts.contextBoost ?? 0))

  // Not enough history to have real confidence — answer autonomously. The multi-model
  // pipeline + verification backs accuracy independent of the predictor's sample count.
  if (sampleSize < 20) {
    return { mode: 'autonomous', confidence: conf }
  }

  // High confidence — just answer
  if (conf >= 0.65 && predictedScore >= 0.72) {
    return { mode: 'autonomous', confidence: conf }
  }

  // Only ask a clarifying question in the rarest genuinely-blocking case: very low
  // confidence, ample history, a real ambiguity signal, AND no resolving context.
  // When any conversational context exists we suppress the question and caveat instead
  // — the system stays autonomous and never makes the user round-trip.
  if (!opts.suppressClarify && conf < 0.40 && sampleSize > 40) {
    for (const sig of AMBIGUITY_SIGNALS) {
      if (sig.pattern.test(question)) {
        return { mode: 'clarify', confidence: conf, clarifyQuestion: sig.question }
      }
    }
  }

  // Medium confidence — answer with a caveat
  if (conf < 0.55 || predictedScore < 0.60) {
    const caveat = predictedScore < 0.50
      ? 'Note: this question falls outside my high-confidence range — verify the key claims independently.'
      : 'Note: there may be context-specific considerations not reflected here.'
    return { mode: 'caveat', confidence: conf, caveat }
  }

  return { mode: 'autonomous', confidence: conf }
}

// Build the clarify prompt that gets sent back to the user instead of a synthesis.
// The pipeline skips stages 1-5 entirely and returns this immediately.
export function buildClarifyResponse(originalQuestion: string, clarifyQuestion: string): string {
  return `Before I answer: ${clarifyQuestion}\n\n(Asking because the best answer to "${originalQuestion.slice(0, 80)}${originalQuestion.length > 80 ? '…' : ''}" depends on this.)`
}
