// Long-output continuation — ship large answers without truncating mid-thought.
//
// Apple FM latency scales with output length, so every draft runs under a token ceiling
// (maxTokensFor). A genuinely long answer — a multi-part explanation, a sizeable code build —
// can hit that ceiling and stop MID-SENTENCE or MID-CODE-BLOCK. The user asked for large coherent
// outputs that don't truncate; this module is the mechanism.
//
// The daemon can't help: it hardcodes finish_reason:"stop" and omits completion_tokens even when
// the response was cut at the budget (probed live, cont.68). So truncation is detected from the
// OUTPUT itself, using only HIGH-PRECISION signals (we must not "continue" a naturally-finished
// answer and make it ramble):
//
//   1. Unbalanced code fence — an odd number of ``` means a code block was left open. Definitive.
//   2. Budget-capped — the output's estimated token count is within a hair of the ceiling AND it
//      does not end on a sentence/structure boundary. If it filled the budget and stopped in the
//      middle, it was cut off, not done.
//
// When truncated, the caller resumes with a "continue from exactly where you stopped" turn and
// stitches the pieces (de-duplicating any overlap the model repeats). Pure + deterministic; the
// only model calls happen in the caller's continuation loop.

/** Rough token estimate. Apple FM ≈ 3.5-4 chars/token for English prose+code; 4 is conservative
 *  (slightly UNDER-counts tokens), so the budget-capped test only fires when genuinely near full. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4)
}

function countFences(text: string): number {
  return (text.match(/```/g) ?? []).length
}

/** True when the text's last non-space char closes a thought (sentence end, list item, or a
 *  balanced code block boundary). Used to avoid continuing an answer that actually finished. */
function endsOnBoundary(text: string): boolean {
  const t = text.trimEnd()
  if (!t) return true
  // Sentence/structure terminators, closing brackets/quotes, or a code-fence line.
  if (/[.!?)\]}"'’”:*_`]$/.test(t)) return true
  if (/```\s*$/.test(t)) return true
  // A markdown table row or bullet that ends cleanly.
  if (/\|\s*$/.test(t)) return true
  return false
}

export interface TruncationCheck {
  truncated: boolean
  /** One of: 'open-code-fence' | 'budget-capped' | '' (not truncated). */
  reason: string
}

/**
 * Decide whether `text` was cut off under `maxTokens`. Conservative by design — only the two
 * high-precision signals fire, so a finished answer is never "continued" into rambling.
 */
export function detectTruncation(text: string, maxTokens: number): TruncationCheck {
  const t = (text ?? '').trim()
  if (!t) return { truncated: false, reason: '' }

  // 1. An open code fence is unambiguous: the answer stopped inside a code block.
  if (countFences(t) % 2 === 1) return { truncated: true, reason: 'open-code-fence' }

  // 2. Filled (near) the whole budget AND did not land on a boundary → cut mid-thought.
  const est = estimateTokens(t)
  if (maxTokens > 0 && est >= maxTokens * 0.9 && !endsOnBoundary(t)) {
    return { truncated: true, reason: 'budget-capped' }
  }

  return { truncated: false, reason: '' }
}

const CONTINUE_DIRECTIVE =
  'Continue the response from EXACTLY where it stopped — do not repeat or re-summarize anything ' +
  'already written, do not restart, and do not add a preamble. If you were in the middle of a ' +
  'sentence, finish that sentence. If you were inside a code block, continue the code and remember ' +
  'to close the ``` fence. Pick up at the next character.'

/**
 * Build the message list that resumes generation. The prior draft is seated as the assistant's
 * turn-so-far and a terse "continue" instruction follows, so the model treats it as one response.
 */
export function buildContinuationMessages(
  baseMessages: Array<{ role: string; content: string }>,
  draftSoFar: string,
): Array<{ role: string; content: string }> {
  return [
    ...baseMessages,
    { role: 'assistant', content: draftSoFar },
    { role: 'user', content: CONTINUE_DIRECTIVE },
  ]
}

/**
 * Join a continuation onto the draft, removing any overlap the model repeats despite being told
 * not to. Finds the longest suffix of `draft` (up to `maxOverlap` chars) that the continuation
 * repeats as a prefix, and drops it. Inserts a single separating space only when the seam would
 * otherwise fuse two words. Never loses content beyond the detected repeat.
 */
export function stitchContinuation(draft: string, continuation: string, maxOverlap = 200): string {
  const cont = (continuation ?? '').replace(/^\s+/, '')
  if (!cont) return draft
  const base = draft ?? ''
  if (!base) return cont

  // Take the LONGEST suffix/prefix match (scanning big→small) so a genuine repeated phrase is
  // removed whole; the ≥4 floor ignores incidental 1-3 char coincidences at the seam.
  const limit = Math.min(maxOverlap, base.length, cont.length)
  let overlap = 0
  for (let len = limit; len >= 4; len--) {
    if (base.slice(base.length - len) === cont.slice(0, len)) { overlap = len; break }
  }
  const tail = cont.slice(overlap)
  if (!tail) return base
  // Insert a space only if both sides are word chars (avoid gluing "wor" + "ds" → "words" wrongly,
  // and avoid a double space); a newline seam or punctuation needs no help.
  const needSpace = /\w$/.test(base) && /^\w/.test(tail) && overlap === 0
  return base + (needSpace ? ' ' : '') + tail
}
