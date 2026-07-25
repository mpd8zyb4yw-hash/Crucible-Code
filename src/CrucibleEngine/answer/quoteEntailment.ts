// ============================================================
// CRUCIBLE — Verbatim-quote entailment for grounded answers
//
// WHY (measured live 2026-07-25, abstain:bench live bait):
//   Q: "What was the résumé objective line on the job application Maria Nguyen submitted in 2007?"
//   A: 'The résumé objective line ... was "Marxism–Leninism."'   ← shipped verified:true
// Traced: `needsExternalFact:false` (no recency/lookup cue fired), so the ungrounded-external-fact
// abstain never applied; the web-grounding tier then ran and returned `sources:3, cites:1`, so the
// `groundedCited === 0` abstain never applied either. The answer was "grounded" by every structural
// check we had — and the load-bearing datum, a QUOTED STRING, appeared in none of the evidence.
//
// THE PRINCIPLE (universal, not a case fix): a quotation is a claim of VERBATIM PROVENANCE. Unlike
// paraphrase, it can be checked mechanically — the quoted characters either occur in the retrieved
// evidence or they do not. When an answer built on retrieved evidence puts words in quotation marks
// that nothing in that evidence (or in the user's own question) contains, the model did not read
// them; it invented them. That is the confabulation zone, and it is EXECUTABLE to detect, which is
// the bar this project holds verifiers to (you cannot regex your way to correctness — but you can
// substring-match a verbatim claim, because verbatim is a substring claim by definition).
//
// FALSE-REJECT DISCIPLINE (cont.85 — verifiers fail in two directions). Over-firing here would kill
// correct answers, so entailment is deliberately generous:
//   - Only DOUBLE-quoted spans count (straight or curly). Single quotes collide with apostrophes.
//   - A span echoing the QUESTION is entailed (the model is quoting the user, not a source).
//   - Matching is normalization-tolerant: case, unicode quotes/dashes/spaces, and interior
//     punctuation are all flattened before comparison, so "Marxism-Leninism" matches
//     "Marxism–Leninism" and trailing-period drift never matters.
//   - A near-miss still counts as entailed: if every content word of the span occurs in the
//     evidence, the model is compressing a real passage, not fabricating one.
//   - Very short spans (< 3 chars of content) and pure numbers are skipped — scare quotes around a
//     single letter or a figure are not verbatim-provenance claims.
// ============================================================

/** Flatten case, unicode punctuation, and whitespace so quote matching survives cosmetic drift. */
function normalize(s: string): string {
  return (s ?? '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[  -​]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Double-quoted spans in the answer — the only shape that claims verbatim provenance. */
function quotedSpans(text: string): string[] {
  const out: string[] = []
  for (const m of (text ?? '').matchAll(/[""]([^""\n]{1,300})[""]|"([^"\n]{1,300})"/g)) {
    const span = (m[1] ?? m[2] ?? '').trim()
    if (span) out.push(span)
  }
  return out
}

/**
 * Quoted spans in `answer` that the retrieved `evidence` does not contain (and that the user's own
 * `question` did not supply). A non-empty result means the answer asserts verbatim text nothing it
 * read actually says — a fabricated quotation.
 */
export function unentailedQuotes(answer: string, evidence: string, question = ''): string[] {
  const hay = normalize(evidence) + ' ' + normalize(question)
  if (!hay.trim()) return []          // no evidence to check against → no standing to reject
  const bad: string[] = []
  for (const span of quotedSpans(answer)) {
    const norm = normalize(span)
    if (norm.replace(/\s/g, '').length < 3) continue     // scare quotes, initials
    if (/^[0-9\s]+$/.test(norm)) continue                // a quoted figure is not a verbatim claim
    if (hay.includes(norm)) continue                     // verbatim (modulo cosmetics)
    // Near-miss: the model compressed or re-punctuated a real passage. Entailed if EVERY content
    // word of the span occurs somewhere in the evidence — fabrications introduce novel words.
    const words = norm.split(' ').filter(w => w.length > 2)
    if (words.length && words.every(w => hay.includes(w))) continue
    bad.push(span)
  }
  return bad
}
