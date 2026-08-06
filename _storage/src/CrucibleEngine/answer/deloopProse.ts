// ── A prose answer that repeats itself is a stopping failure (cont.120) ───────
//
// Live report, 2026-07-29. Asked "build me a quizlet study guide of simple italian terms", the
// answer was 4,179 characters consisting of the PREVIOUS turn's email draft — "Hi Google, Thank
// you for bringing this to my attention…" — repeated five times, separated by `---`.
//
// Two defects stacked. The wrong CONTENT is fixed upstream in goalSpec (the request failed to
// parse as a creation goal at all, so it never got a brief and fell to a general pipeline holding
// a transcript). This file handles the second: nothing noticed that the answer was the same
// paragraph five times.
//
// `stripDegenerateRepetition` in synth/universal.ts already solves this shape for CODE, and it
// says so plainly — it anchors on top-level declaration lines (`function`, `const`, `class`). A
// repeated email body has no declarations, so that guard is structurally blind to it. This is the
// same guard for the other half of what the system emits.
//
// UNIVERSAL AND ZERO-INFERENCE, exactly as the code one is. Nothing is parsed, nothing is
// rewritten, no model is consulted: blocks are compared for equality and a repeated run is cut to
// its first copy. Cutting can only remove a duplicate suffix, so an answer that never looped is
// returned byte-identical and every downstream gate judges it exactly as before.
//
// WHY EQUALITY AND NOT SIMILARITY. A similarity threshold would catch more loops and would also
// eventually delete a legitimate refrain, a repeated table header, or two worked examples that
// differ only in their numbers. Deleting part of a correct answer is the expensive direction
// (crucible-verifier-two-failure-directions), and near-identical repetition is rare enough that
// paying for it in missed catches is the right trade.

/** Blocks shorter than this are not evidence of a loop — a repeated "Yes." or "---" is normal. */
const MIN_BLOCK_CHARS = 80

/** Normalise for COMPARISON only. The text that survives is always the original, unmodified. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export interface DeloopResult {
  text: string
  /** How many duplicate copies were removed. 0 means the text is untouched. */
  removed: number
}

/**
 * Cut degenerate repetition out of a prose answer.
 *
 * PERIODICITY, NOT BLOCK-WISE DEDUPLICATION. The first version of this deduplicated blocks
 * independently, and the bench caught what that does to the very answer it was written for: the
 * draft's short lines ("Hi Google,", "Best regards,") fall under the length floor, so they
 * survived all five times while the long paragraph was deduplicated to one — an output more
 * mangled than the input.
 *
 * A stopping failure does not sprinkle duplicate paragraphs around; it RESTARTS. The whole answer
 * becomes some segment repeated end to end. So the test is whether the block sequence is periodic
 * with period p, and the repair is to keep the first period. That is a much stronger condition
 * than "some block appears twice", which is exactly why it leaves refrains, repeated headings and
 * parallel worked examples alone — none of those make the WHOLE answer periodic.
 *
 * The final copy is allowed to be short. A model that loops usually gets cut off by the token
 * limit partway through its last restart, so the tail is a prefix of the period rather than a
 * full copy of it.
 */
export function deloopProse(answer: string): DeloopResult {
  const text = answer ?? ''
  if (text.length < MIN_BLOCK_CHARS * 2) return { text, removed: 0 }

  const parts = text.split(/\n\s*(?:-{3,}|\*{3,}|_{3,})\s*\n|\n{2,}/).filter(p => p.trim())
  if (parts.length < 2) return { text, removed: 0 }
  const keys = parts.map(norm)

  // Only worth cutting if the repeated unit carries real content — a period made entirely of
  // short lines is a list with repeated labels, not a loop.
  const substantial = (from: number, to: number) =>
    keys.slice(from, to).reduce((n, k) => n + k.length, 0) >= MIN_BLOCK_CHARS

  for (let p = 1; p <= Math.floor(parts.length / 2); p++) {
    if (!substantial(0, p)) continue
    let ok = true
    let full = 0
    for (let i = p; i < parts.length && ok; i++) {
      const a = keys[i], b = keys[i % p]
      if (a === b) { full++; continue }
      // The truncated tail: the last block may be cut off mid-sentence, so a prefix counts —
      // but only as the FINAL block, never in the middle of a copy.
      if (i === parts.length - 1 && a.length >= 20 && b.startsWith(a)) continue
      ok = false
    }
    // Require at least one COMPLETE repeated block, so a single truncated fragment that happens
    // to echo the opening does not trigger a cut.
    if (ok && full >= 1) {
      const out = parts.slice(0, p).join('\n\n').trim()
      if (!out) return { text, removed: 0 }
      return { text: out, removed: parts.length - p }
    }
  }
  return { text, removed: 0 }
}
