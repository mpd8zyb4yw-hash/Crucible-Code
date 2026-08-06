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

// ── Misquote repair ────────────────────────────────────────────────────────────
// WHY (measured live 2026-07-25, cont.112 non-bait probe, 3/3 runs):
//   Q: "What are the opening words of the United States Constitution?"
//   A: 'We the People of the United States, having ord…'   ← the head garbles the preamble
// `unentailedQuotes` correctly flags this, and the pipeline abstains — throwing away a question the
// evidence CAN answer, because one quoted span drifted. Abstention is the right move when the datum
// is unknowable; it is the wrong move when the true verbatim text is sitting in the evidence we
// already retrieved. REPAIR DOMINATES ABSTENTION whenever the correct span is recoverable.
//
// SOUNDNESS. The replacement is a literal substring of the evidence by construction, so the repaired
// quote is entailed by definition — this can never manufacture a new fabrication. The risk is the
// opposite one (anchoring on the WRONG passage and confidently swapping in unrelated text), so the
// anchor is deliberately strict: the answer's quote and the evidence passage must share a contiguous
// run of leading content words that is both ≥3 tokens and ≥40% of the quote. A drifting tail is what
// this repairs; a quote that never lined up in the first place is left to the abstention gate.
// It runs ONLY on spans already judged unentailed — i.e. on the path that was about to abstain — so
// a correct quotation is never rewritten.

// How many contiguous leading content words must match exactly before we trust that the answer's
// quote and an evidence passage are the SAME passage. A fixed floor, deliberately not a proportion
// of the quote's length: measured live (cont.112), the head's misquote of the US Constitution
// anchored on 6 exact tokens out of ~20, and a 40%-of-quote rule refused to repair it — i.e. the
// proportional rule was strictest on exactly the case it exists to fix (a long quote that diverges
// early). The anchor's job is only to IDENTIFY the passage, and five consecutive exact content words
// is already a near-unique locator inside a few-KB evidence block; the longest-anchor-first search
// below then prefers the strongest match available.
const ANCHOR_TOKENS = 5

type Tok = { norm: string; start: number; end: number }

/** Content tokens of `raw` with their offsets back into `raw`, so a match can be quoted verbatim. */
function tokenize(raw: string): Tok[] {
  const out: Tok[] = []
  for (const m of (raw ?? '').matchAll(/[A-Za-z0-9]+/g)) {
    out.push({ norm: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length })
  }
  return out
}

/** Index of the first occurrence of `needle` (token norms) in `hay`, or -1. */
function findRun(hay: Tok[], needle: string[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j].norm !== needle[j]) continue outer
    return i
  }
  return -1
}

/**
 * The evidence's actual verbatim text for a quote the answer got wrong, or null when no passage
 * anchors it confidently. Returned text is a raw substring of `evidence`.
 */
export function repairMisquote(span: string, evidence: string): string | null {
  const quoteToks = tokenize(span).map(t => t.norm)
  const evToks = tokenize(evidence)
  if (quoteToks.length < ANCHOR_TOKENS + 1 || !evToks.length) return null  // too short to anchor safely
  const minAnchor = ANCHOR_TOKENS
  // Longest leading run of the quote that occurs contiguously in the evidence. Longest-first so a
  // quote that drifts only at the very end anchors on nearly its whole length.
  for (let len = quoteToks.length; len >= minAnchor; len--) {
    const at = findRun(evToks, quoteToks.slice(0, len))
    if (at < 0) continue
    // Extend the evidence span to the length of the original quote (that is what was asked for),
    // but never past the end of its sentence — an over-long quote is its own kind of wrong.
    const wanted = Math.min(quoteToks.length, evToks.length - at)
    let endTok = at + wanted - 1
    const rawStart = evToks[at].start
    for (let k = at; k <= endTok; k++) {
      const tail = evidence.slice(evToks[k].end, evToks[k + 1]?.start ?? evidence.length)
      if (/[.!?]/.test(tail)) { endTok = k; break }
    }
    const repaired = evidence.slice(rawStart, evToks[endTok].end).trim()
    // A repair that reproduces the (already-rejected) quote is not a repair.
    return normalize(repaired) === normalize(span) ? null : repaired
  }
  return null
}

/**
 * Rewrites every fabricated quotation in `answer` that the evidence can correct, and reports the
 * ones it cannot. `remaining` empty means the answer is now fully quote-entailed and may ship;
 * otherwise the caller should abstain, exactly as before.
 */
export function repairQuotations(
  answer: string,
  evidence: string,
  question = '',
): { text: string; repaired: Array<{ from: string; to: string }>; remaining: string[] } {
  const bad = unentailedQuotes(answer, evidence, question)
  const repaired: Array<{ from: string; to: string }> = []
  const remaining: string[] = []
  let text = answer
  for (const span of bad) {
    const fix = repairMisquote(span, evidence)
    if (!fix) { remaining.push(span); continue }
    text = text.split(span).join(fix)
    repaired.push({ from: span, to: fix })
  }
  return { text, repaired, remaining }
}
