// ============================================================================
// PASSAGE SELECTION — show the model the part of the document that answers the question.
//
// WHY (measured 2026-08-03): researchDag handed each source to the FM as
// `src.text.slice(0, 1500)` — the first 1,500 characters, unconditionally. For an
// encyclopedia article that is the lead paragraph, which defines the subject and almost
// never contains the specific fact being asked about. The FM correctly answered "this text
// does not answer the question", every source was skipped, and the DAG abstained with
// "no source answered the question" on every probe.
//
// The naive fix — raise the cap — is wrong twice over: it costs tokens linearly, and a small
// model's accuracy DROPS as you bury the answer in irrelevant context. The right fix is to
// spend the same 1,500 characters on the RIGHT 1,500 characters.
//
// DOCTRINE §3.1: this is manufacturing quality rather than buying it. No larger model, no
// extra model call — a deterministic selector that makes each existing call far more likely
// to succeed. It is also §5.4 (maximise information per model call) applied to retrieval.
// ============================================================================

/** Words too common to discriminate between passages. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by',
  'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why',
  'how', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'may', 'might',
  'must', 'have', 'has', 'had', 'not', 'no', 'yes', 'than', 'then', 'there', 'their', 'them',
  'they', 'you', 'your', 'i', 'me', 'my', 'we', 'our', 'us', 'he', 'she', 'his', 'her',
  'about', 'into', 'over', 'between', 'main', 'other', 'some', 'any', 'all', 'more', 'most',
])

/** Content terms of a question, lowercased and de-duplicated. */
export function queryTerms(q: string): string[] {
  const raw = q.toLowerCase().match(/[a-z0-9][a-z0-9./+#-]*/g) ?? []
  return [...new Set(raw.filter(t => t.length > 1 && !STOP.has(t)))]
}

/**
 * Crude suffix stripping so a question's word form matches the document's.
 * Measured need: "when did widget MANUFACTURING begin" scored the pricing paragraph over
 * the history paragraph, because "manufacturing" is not a substring of "manufacturers".
 * Prefix matching on a stem fixes that whole class without a stemmer dependency.
 * Never stems below 4 characters, so short words can't start matching everything.
 */
export function stemOf(term: string): string {
  if (/\d/.test(term) || term.length < 6) return term
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ers', 'ies', 'ed', 'es', 's']) {
    if (term.endsWith(suf) && term.length - suf.length >= 4) return term.slice(0, term.length - suf.length)
  }
  return term
}

/** Does the question want a specific number/version/date? Those answers live near digits. */
function wantsNumber(q: string): boolean {
  return /\b(how many|how much|version|number|percent|population|year|when|date|price|cost|size|count|latest|current|release[ds]?|lts)\b/i.test(q)
}

interface Window { text: string; start: number; score: number }

/**
 * Split into paragraph-ish windows. Wikipedia plaintext extracts use "\n\n" between
 * paragraphs and "== Section ==" headers; both are good boundaries. Long paragraphs are
 * hard-split so one huge block can't monopolise the budget.
 */
function toWindows(text: string, target = 420): Window[] {
  const out: Window[] = []
  let cursor = 0
  for (const para of text.split(/\n{2,}|\n(?==+\s)/)) {
    const trimmed = para.trim()
    const start = cursor
    cursor += para.length + 2
    if (trimmed.length < 40) continue
    if (trimmed.length <= target * 1.8) {
      out.push({ text: trimmed, start, score: 0 })
      continue
    }
    // Hard-split an over-long paragraph on sentence boundaries.
    let buf = ''
    let bufStart = start
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (buf.length + sentence.length > target && buf) {
        out.push({ text: buf.trim(), start: bufStart, score: 0 })
        bufStart = start + trimmed.indexOf(sentence)
        buf = ''
      }
      buf += sentence + ' '
    }
    if (buf.trim().length >= 40) out.push({ text: buf.trim(), start: bufStart, score: 0 })
  }
  return out
}

export interface SelectOpts {
  /** Total character budget for the returned excerpt. */
  budget?: number
  /** Always include the opening of the document (defines the subject). */
  keepLead?: boolean
}

/**
 * Return the passages of `text` most likely to answer `question`, in document order,
 * within `budget` characters.
 *
 * Scoring is deliberately simple and deterministic:
 * - +1 per distinct query term present (rarer/longer terms weigh slightly more)
 * - a bonus for windows containing digits when the question asks for a number
 * - a small bonus for the lead window, which usually establishes what the subject IS
 *
 * If nothing matches at all, falls back to the head of the document — the old behaviour —
 * so this can only improve on what was there.
 */
export function selectPassages(text: string, question: string, opts: SelectOpts = {}): string {
  const budget = opts.budget ?? 1500
  const keepLead = opts.keepLead ?? true
  if (!text) return ''
  if (text.length <= budget) return text

  const terms = queryTerms(question)
  if (terms.length === 0) return text.slice(0, budget)

  const windows = toWindows(text)
  if (windows.length === 0) return text.slice(0, budget)

  const numeric = wantsNumber(question)
  const stems = terms.map(t => ({ term: t, stem: stemOf(t) }))
  for (const w of windows) {
    const hay = w.text.toLowerCase()
    let score = 0
    for (const { term, stem } of stems) {
      // Exact form scores full; a stem-only match still counts, slightly discounted.
      const exact = hay.includes(term)
      if (!exact && !(stem !== term && hay.includes(stem))) continue
      // Longer terms are more discriminating; cap the weight so one long token can't dominate.
      score += (exact ? 1 : 0.85) + Math.min(0.5, (term.length - 2) * 0.08)
    }
    if (numeric && /\d/.test(w.text)) score += 0.75
    // Slight preference for the lead: it names the subject, which grounds everything else.
    if (w.start === 0) score += 0.5
    w.score = score
  }

  const ranked = [...windows].sort((a, b) => b.score - a.score || a.start - b.start)
  if (ranked[0].score === 0) return text.slice(0, budget)

  const chosen: Window[] = []
  let used = 0
  if (keepLead && windows[0] && windows[0].score > 0) {
    chosen.push(windows[0])
    used = windows[0].text.length
  }
  for (const w of ranked) {
    if (used >= budget) break
    if (chosen.includes(w)) continue
    if (w.score <= 0) break
    if (used + w.text.length > budget && chosen.length) continue
    chosen.push(w)
    used += w.text.length + 5
  }
  if (chosen.length === 0) return text.slice(0, budget)

  chosen.sort((a, b) => a.start - b.start)
  // " … " marks elision so the model (and a human reading a trace) can see the text is not
  // contiguous — presenting spliced passages as continuous prose would be its own small lie.
  let out = chosen.map(c => c.text).join('\n … \n')
  if (out.length > budget) out = out.slice(0, budget)
  return out
}
