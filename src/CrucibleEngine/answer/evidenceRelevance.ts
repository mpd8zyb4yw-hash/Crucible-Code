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
