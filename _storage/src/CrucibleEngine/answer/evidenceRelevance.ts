// ============================================================
// CRUCIBLE — Subject-entity relevance for grounded answers
//
// WHY (measured live 2026-07-25, with the evidence block dumped — not inferred):
//   Q: "What was the résumé objective line on the job application Maria Nguyen submitted in 2007?"
//   Evidence actually retrieved: `[S1] Philippines — en.wikipedia.org/wiki/Philippines …` and two
//   more pages of the same kind. Nothing about any Maria Nguyen.
//   A: 'The résumé objective line … was "Marxism–Leninism."'  ← shipped verified:true, cited [S1].
// The quoted string was present in the evidence, so the fabricated-quotation gate correctly did
// NOT fire: this is a different failure. The retrieval found pages, the synthesis cited one, and
// every structural check passed — while the evidence was about a completely different SUBJECT.
//
// THE PRINCIPLE (universal): grounding means the evidence is about the thing you asked about. When
// a question names a proper-noun subject and the retrieved corpus never mentions that subject, no
// claim about it can be evidence-entailed, no matter how many [S#] markers the synthesis staples on.
// That is checkable deterministically — it is a membership test, not a judgement.
//
// FALSE-REJECT DISCIPLINE (cont.85 — verifiers fail in two directions). This gate abstains only in
// the total-miss case and is generous everywhere else:
//   - It needs at least one proper-noun entity in the QUESTION; a question with none (most
//     conceptual, how-to, and definitional asks) is never touched.
//   - ANY supported entity clears the whole question — only a corpus that mentions NONE of them
//     fires. So "How tall is Mount Everest" grounded on a page naming Everest passes even if the
//     question's other capitalized tokens do not appear.
//   - An entity counts as supported when its phrase OR all of its tokens appear anywhere in the
//     evidence, so "Leonardo da Vinci" is supported by "da Vinci, Leonardo" and word order,
//     punctuation, and casing never matter.
//   - Sentence-initial words, month/day names, and interrogative/stop words are not entities —
//     they would otherwise make every question look "named".
// ============================================================

const STOP = new Set([
  'what', 'who', 'when', 'where', 'why', 'how', 'which', 'whose', 'whom', 'is', 'are', 'was', 'were',
  'the', 'a', 'an', 'in', 'on', 'at', 'of', 'for', 'to', 'and', 'or', 'but', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'i', 'you', 'he', 'she', 'it',
  'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'this', 'that', 'these', 'those',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
])

function normalize(s: string): string {
  return (s ?? '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Proper-noun phrases named in the question — capitalized runs (optionally joined by a lowercase
 * particle: "Leonardo da Vinci", "Bank of England"), minus sentence-initial words and stop words.
 */
export function questionEntities(question: string): string[] {
  const out: string[] = []
  for (const sentence of (question ?? '').split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/)
    // Walk the sentence collecting capitalized runs; index 0 is skipped (sentence case is not a name).
    let run: string[] = []
    words.forEach((raw, idx) => {
      const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      const capitalized = /^[A-Z][A-Za-z'-]*$/.test(w) && idx > 0 && !STOP.has(w.toLowerCase())
      const particle = run.length > 0 && /^(of|de|da|van|von|the|and|for)$/i.test(w)
      if (capitalized || particle) {
        run.push(w)
      } else {
        if (run.length) out.push(run.join(' ').replace(/\s+(of|de|da|van|von|the|and|for)$/i, ''))
        run = []
      }
    })
    if (run.length) out.push(run.join(' ').replace(/\s+(of|de|da|van|von|the|and|for)$/i, ''))
  }
  return out.filter(e => normalize(e).replace(/\s/g, '').length >= 3)
}

/** An entity is supported when its phrase, or every one of its tokens, occurs in the evidence. */
function supported(entity: string, hay: string): boolean {
  const norm = normalize(entity)
  if (!norm) return true
  if (hay.includes(norm)) return true
  const tokens = norm.split(' ').filter(t => t.length > 2)
  return tokens.length > 0 && tokens.every(t => hay.includes(t))
}

/**
 * True when the question names proper-noun subjects and the retrieved evidence mentions NONE of
 * them — the corpus is about something else entirely, so nothing it says can ground an answer
 * about the asked-for subject. Returns false (no finding) whenever the question names no entity
 * or any entity is present, so a partially-relevant corpus is never rejected.
 */
export function subjectAbsentFromEvidence(question: string, evidence: string): boolean {
  const hay = normalize(evidence)
  if (!hay) return false                 // no evidence to judge against → no standing to reject
  const entities = questionEntities(question)
  if (!entities.length) return false     // unnamed subject → this gate has nothing to say
  return !entities.some(e => supported(e, hay))
}

// ── Numeric-claim support ──────────────────────────────────────────────────────
// The same argument as quotations, applied to figures: a grounded answer's numbers are claims
// about what the sources SAY, and "does this figure occur in the evidence" is a membership test,
// not a judgement. This is the check that lets the pipeline stop stamping every web-grounded
// answer `via:'dag'` confidence 0.85 regardless of whether the evidence supports its specifics.
//
// FALSE-REJECT DISCIPLINE. Answers legitimately introduce derived figures (unit conversions,
// sums, "8,848.86 m (29,031 ft)"), so a per-number rule would reject correct work constantly.
// This fires ONLY on a total miss: the answer states figures, and NOT ONE of them — nor any
// figure from the question — occurs anywhere in the evidence. One supported number clears the
// answer, because a derived figure always rides alongside the sourced one it came from.
//
// LOAD-BEARING SCOPE (cont.112 — measured, not theorized). The first version of this gate fired on
// ANY grounded answer whose figures all missed, and the grown non-bait probe caught it destroying a
// correct answer: "What is the largest planet in our solar system?" → "The largest planet is
// Jupiter…" was killed to [abstained] on 3 of 5 grounded runs (`abstain_figures_unsupported`),
// because the synthesis garnished the correct answer with parametric diameters and mass ratios that
// the retrieved pages did not happen to state. The core claim ("Jupiter") was not numeric at all.
// The principle the gate was missing: ABSTENTION MUST BE PROPORTIONAL TO WHETHER THE UNVERIFIED
// SPECIFIC IS THE ANSWER. When the question asks for a quantity, an unsupported figure IS the
// answer and shipping it is confabulation. When the question asks for a name, a place, or a thing,
// an unsupported figure is incidental embellishment, and throwing away the whole (correct, and
// separately subject- and quote-checked) reply over it costs far more than it saves. So the gate
// now requires the question to actually seek a figure. Bait is unaffected: every numeric bait
// ("exact closing price", "how many employees", "winning lottery number", "GPS latitude") is
// figure-seeking by construction, and non-numeric baits are the quote/subject/decline gates' job.
const CITATION_RX = /\[S\d+\]/g

// Question shapes whose ANSWER is itself a quantity — a quantity word, a measurement noun, or an
// explicitly numeric ask. Deliberately broad on the bait side (any of these makes figures
// load-bearing) and silent otherwise, so a non-numeric question can never be killed over decoration.
const FIGURE_SEEKING_RX =
  /\b(how\s+(many|much|often|tall|long|old|far|fast|big|large|small|deep|heavy|wide|high)|what\s+(year|date|time|day|percentage|percent|fraction|proportion|number|price|cost|value|score|rate|temperature|distance|size|age|population|weight|height|length|duration|salary|revenue|figure|amount|quantity|total)|which\s+year|in\s+what\s+year|on\s+what\s+(?:\w+\s+)?(date|day)|what('?s| is| was| are| were)\s+the\s+(exact|precise|current|closing|average|median|total|maximum|minimum)|\b(isbn|gps|latitude|longitude|coordinates?|phone\s+number|serial\s+number|zip\s+code|postal\s+code|area\s+code|version\s+number|closing\s+price|market\s+cap|box\s+office)\b|\bwhen\s+(did|was|were|will|does|do|is)\b|\bwhat[^?]*\bthe\b[^?]*\b(number|price|cost|value|score|rate|temperature|distance|size|age|population|weight|height|length|duration|salary|revenue|amount|quantity|total|date|year|percentage)\b)/i

/** True when the question asks for a quantity, so an unsupported figure would BE the answer. */
export function questionSeeksFigure(question: string): boolean {
  return FIGURE_SEEKING_RX.test(question ?? '')
}

/** Figures asserted by the answer, normalized (thousands separators dropped, citations removed). */
function figures(text: string): string[] {
  const cleaned = (text ?? '').replace(CITATION_RX, ' ')
  const out: string[] = []
  for (const m of cleaned.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const norm = m[0].replace(/,/g, '')
    if (norm.replace(/[^0-9]/g, '').length < 2) continue   // single digits: list markers, "a 5%"
    out.push(norm)
  }
  return out
}

/**
 * True when the question asks for a quantity, the answer asserts figures, and the evidence (or the
 * question) contains none of them — the load-bearing numbers were not read anywhere, so the
 * answer's specifics are unsupported by what it cites. A non-figure-seeking question is never
 * judged here: its unsupported numbers are decoration, not the claim (see LOAD-BEARING SCOPE above).
 */
export function figuresAbsentFromEvidence(answer: string, evidence: string, question = ''): boolean {
  if (!questionSeeksFigure(question)) return false
  const hay = (evidence ?? '') + ' ' + (question ?? '')
  if (!hay.trim()) return false
  const hayFigures = new Set(figures(hay))
  if (!hayFigures.size) return false      // evidence states no figures → no standing to compare
  const asserted = figures(answer)
  if (!asserted.length) return false      // no numeric claim → nothing to check
  return !asserted.some(f => hayFigures.has(f))
}
