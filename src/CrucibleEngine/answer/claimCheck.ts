// ============================================================================
// SUPERLATIVE CLAIM CHECK — the gap between "grounded" and "true".
//
// MEASURED 2026-08-03 on the live path. Question: "What is the capital of Australia?"
// Answer, shipped with `verified: true` and three cited sources:
//
//   "The capital of Australia is Canberra. Canberra is located within the Australian Capital
//    Territory (ACT), which was excised from New South Wales in 1908. It serves as the
//    national capital and IS THE MOST POPULOUS CITY IN EACH STATE AND INTERNAL TERRITORY."
//
// The last clause is false, and it is false in the most instructive possible way. The
// evidence really does contain the sentence
//
//   "In each state and internal territory, THE CAPITAL is also the jurisdiction's most
//    populous city."   (List of Australian capital cities)
//
// The model kept every content word and changed only what the predicate was attached to.
// So every entailment check that reduces a sentence to a bag of words — which is what
// lexical grounding does — certifies it. The subject is the entire error.
//
// Why this matters more than one wrong sentence: `answerWithWebGrounding` emits
// `passed: true, "Answer grounded in N web sources"` for ALL prose. The only real gate in
// that path is `certifyAnswer`, which checks library identifiers for CODE and abstains on
// prose. So for every non-code answer the product has ever given, "verified" meant "we
// retrieved something", not "we checked this". DOCTRINE's central claim is that the loop —
// not the oracle — produces correctness; a badge that cannot fail is not a loop.
//
// SCOPE, deliberately narrow. This checks SUPERLATIVE and EXCLUSIVE claims only:
// "the most populous", "the largest", "the first", "the only". That class is chosen because
// it is where fabrication concentrates and, more importantly, because superlatives are
// UNIQUE BY REFERENCE — exactly one thing can hold one — which is what makes subject
// attachment mechanically checkable at all. A broad "is every sentence entailed" checker is
// a model call wearing a verifier's clothes, and this repo has been burned by that before.
// Narrow and sound beats broad and noisy: an unsupported flag must mean something.
//
// Two independent rules, either of which can fail a sentence:
//   1. INCOHERENCE (needs no evidence at all): a single named subject cannot hold a
//      superlative distributed over "each/every/all <plural>". One city is not the most
//      populous city in each of eight jurisdictions. This is a logical property of
//      superlatives, so it is decidable from the sentence alone — and it alone catches the
//      measured failure even when retrieval returns nothing.
//   2. ATTACHMENT: the same evidence SENTENCE must contain the claim's subject, the
//      superlative head, and most of the predicate's content terms. Same-sentence is the
//      whole point — the measured failure is precisely a predicate borrowed across a
//      sentence boundary.
// ============================================================================

export type ClaimVerdict = 'supported' | 'unsupported' | 'incoherent'

export interface CheckedClaim {
  sentence: string
  verdict: ClaimVerdict
  /** The superlative that made this sentence checkable ("most populous", "largest"). */
  superlative: string
  /** Subject the superlative was attached to, after pronoun resolution. */
  subject: string
  /** Evidence sentence that supports it, when one does. */
  support?: string
  /** Human-readable reason, shown to the user when the claim fails. */
  reason: string
}

export interface ClaimReport {
  claims: CheckedClaim[]
  /** Claims that failed. Empty means nothing checkable was wrong. */
  failed: CheckedClaim[]
  /** True when at least one superlative claim was found and every one of them held. */
  checked: boolean
}

// ── Sentence splitting ───────────────────────────────────────────────────────

/** Abbreviations whose period does not end a sentence. */
const ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|approx|No|Fig|cf)\.$/i

export function splitSentences(text: string): string[] {
  // Strip markdown emphasis and citation markers first so they cannot break the split or
  // pollute term matching. Bullets become their own sentences, which is what we want.
  const clean = text
    .replace(/\[S\d+\]/g, ' ')
    .replace(/\*\*|__|`+/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
  const out: string[] = []
  let buf = ''
  for (const chunk of clean.split(/(?<=[.!?])\s+|\n+/)) {
    buf = buf ? `${buf} ${chunk}` : chunk
    if (ABBREV.test(buf.trim())) continue
    const t = buf.trim()
    if (t) out.push(t)
    buf = ''
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(s => s.length > 12)
}

// ── Superlative detection ────────────────────────────────────────────────────

/**
 * Superlative / exclusive heads. "-est" is matched morphologically rather than listed, but
 * guarded against the many ordinary words that end in "est" (best/west/rest/honest/…).
 */
const EST_STOPLIST = new Set([
  'best', 'west', 'rest', 'test', 'nest', 'guest', 'quest', 'honest', 'modest', 'forest',
  'invest', 'protest', 'request', 'suggest', 'interest', 'harvest', 'arrest', 'digest',
  'manifest', 'earnest', 'contest', 'conquest', 'priest', 'wrest', 'behest', 'latest',
])

const SUPERLATIVE_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?:the\s+)?(?:most|least)\s+[a-z]+` +   // most populous, least dense
    String.raw`|(?:the\s+)?only\b` +
    String.raw`|(?:the\s+)?first\b|(?:the\s+)?last\b` +
    String.raw`|(?:the\s+)?[a-z]{3,}est\b` +           // largest, oldest — filtered below
  String.raw`)`,
  'i',
)

/** Extract the superlative phrase, or null. Filters the "-est" false friends. */
export function superlativeOf(sentence: string): string | null {
  const m = SUPERLATIVE_RE.exec(sentence)
  if (!m) return null
  const phrase = m[0].replace(/^the\s+/i, '').trim().toLowerCase()
  const estWord = /^([a-z]+est)$/.exec(phrase)
  if (estWord && EST_STOPLIST.has(estWord[1])) {
    // Try again past this occurrence rather than giving up — "the latest and largest".
    const rest = sentence.slice(m.index + m[0].length)
    return rest ? superlativeOf(rest) : null
  }
  // "most" as a bare quantifier ("most people agree") is not a superlative claim.
  if (/^most\s+(people|of|others|users|cases|times)$/.test(phrase)) return null
  return phrase
}

// ── Subject extraction ───────────────────────────────────────────────────────

const PRONOUN = /^(it|he|she|they|this|that|these|those)\b/i

/**
 * The subject noun phrase: everything before the main verb. Crude but adequate, because we
 * only need the ENTITY, not a parse — and we only run on sentences we already know carry a
 * superlative.
 *
 * A leading pronoun resolves to `topic`, which the caller derives from the question and the
 * answer's opening. That resolution is the difference between catching the measured failure
 * ("IT serves as the national capital and is the most populous city…") and missing it.
 */
export function subjectOf(sentence: string, topic: string): string {
  const s = sentence.trim()
  if (PRONOUN.test(s)) return topic
  // Cut at the first finite verb. Ordered longest-first so "is also" doesn't match before "is".
  const m = /^(.{2,80}?)\s+\b(?:is|are|was|were|has|have|had|serves|remains|became|becomes|ranks|holds|stands)\b/i.exec(s)
  const subj = m ? m[1] : s.split(/[,;]/)[0]
  return subj.replace(/^(the|a|an)\s+/i, '').trim()
}

// ── Rule 1: distributive-superlative incoherence ─────────────────────────────

/**
 * "X is the most populous city in EACH state and internal territory."
 *
 * A superlative picks out exactly one member of one comparison class. Distributing it over a
 * plural domain asserts that one entity is simultaneously the unique maximum of many distinct
 * classes — incoherent for a singular subject, no matter what the evidence says. This is the
 * rule that catches the measured failure with zero retrieval, which is why it comes first.
 *
 * Guarded against the legitimate reading "the tallest building in each city was surveyed",
 * where the subject is itself distributive: only fires when the subject is a singular
 * definite entity.
 */
export function isDistributiveSuperlative(sentence: string, subject: string): boolean {
  if (!/\b(?:in|of|across|among|for)\s+(?:each|every|all)\b/i.test(sentence)) return false
  // A plural or generic subject ("capital cities", "the capital") can legitimately distribute.
  if (/\b(?:cities|countries|states|territories|regions|each|every|all|capitals?)\b/i.test(subject)) return false
  // Must be a specific singular entity: a proper noun, or a resolved pronoun topic.
  return /^[A-Z][\w.-]*/.test(subject.trim()) || subject.split(/\s+/).length <= 3
}

// ── Rule 2: same-sentence attachment ─────────────────────────────────────────

const TERM_STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'is', 'are', 'was', 'were',
  'it', 'its', 'also', 'as', 'be', 'been', 'that', 'which', 'with', 'for', 'by', 'from',
  'has', 'have', 'had', 'this', 'these', 'those', 'their', 'there', 'than', 'then', 'most',
  'least', 'more', 'very', 'serves', 'while',
])

function terms(s: string): string[] {
  return [...new Set(
    (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter(t => t.length > 2 && !TERM_STOP.has(t)),
  )]
}

/** Head noun/adjective of the superlative: "most populous" -> "populous", "largest" -> "largest". */
function superlativeHead(sup: string): string {
  const m = /^(?:most|least)\s+(\w+)/.exec(sup)
  return m ? m[1] : sup.replace(/^(?:the)\s+/, '')
}

/**
 * Is the claim attached to the same subject in the evidence?
 *
 * Requires ONE evidence sentence to carry all three of: the subject, the superlative head,
 * and at least half the predicate's content terms. Same-sentence is load-bearing — the
 * measured failure is a predicate lifted across a sentence boundary, and any check that
 * pools the whole document back into a bag of words certifies it again.
 */
export function findAttachment(
  claim: string, subject: string, sup: string, evidenceSentences: string[],
): string | null {
  const head = superlativeHead(sup)
  const subjTerms = terms(subject)
  // Predicate terms: the claim minus the subject, minus the superlative itself.
  const predTerms = terms(claim).filter(t => !subjTerms.includes(t) && t !== head)
  const need = Math.max(1, Math.ceil(predTerms.length / 2))

  for (const ev of evidenceSentences) {
    const low = ev.toLowerCase()
    if (!low.includes(head)) continue
    // Every subject term must be present — "Canberra" claims need Canberra in the sentence.
    if (!subjTerms.every(t => low.includes(t))) continue
    const hits = predTerms.filter(t => low.includes(t)).length
    if (hits >= need) return ev
  }
  return null
}

// ── The gate ─────────────────────────────────────────────────────────────────

export interface CheckOpts {
  /** Entity a leading pronoun refers to. Usually the question's subject. */
  topic?: string
}

/**
 * Check every superlative claim in `answer` against `evidence`.
 *
 * Returns `checked: false` when the answer makes no superlative claims — that is not a pass,
 * it means this gate had nothing to say, and the caller must not upgrade its badge on it.
 * Reporting "nothing refuted it" as "verified" is exactly the defect this file exists to fix.
 */
export function checkClaims(answer: string, evidence: string, opts: CheckOpts = {}): ClaimReport {
  const evidenceSentences = splitSentences(evidence)
  const topic = (opts.topic ?? '').trim() || inferTopic(answer)
  const claims: CheckedClaim[] = []

  for (const sentence of splitSentences(answer)) {
    const sup = superlativeOf(sentence)
    if (!sup) continue
    const subject = subjectOf(sentence, topic)

    if (isDistributiveSuperlative(sentence, subject)) {
      claims.push({
        sentence, superlative: sup, subject, verdict: 'incoherent',
        reason: `"${subject}" is a single thing, so it cannot be ${sup} across each of several places at once.`,
      })
      continue
    }

    const support = findAttachment(sentence, subject, sup, evidenceSentences)
    claims.push(support
      ? { sentence, superlative: sup, subject, verdict: 'supported', support, reason: 'Matched a source sentence making the same claim about the same subject.' }
      : { sentence, superlative: sup, subject, verdict: 'unsupported', reason: `No source says "${subject}" is ${sup} — the sources use that phrase about something else.` })
  }

  return { claims, failed: claims.filter(c => c.verdict !== 'supported'), checked: claims.length > 0 }
}

/**
 * Remove sentences whose claims failed, when doing so still leaves a real answer.
 *
 * Downgrading the badge is honest but leaves the false sentence on screen, and most people
 * read the answer rather than the badge. Because the check is sentence-scoped, we know
 * exactly which words are unsupported — so we can delete precisely those and keep the rest,
 * which is strictly better than either shipping the falsehood or discarding a good answer.
 *
 * Guarded: never strips the answer down to nothing. If what fails IS the answer, the caller
 * keeps the text and ships it unbadged — abstaining loudly beats silently returning a stub.
 */
export function stripFailedClaims(answer: string, report: ClaimReport): { text: string; removed: string[] } {
  if (!report.failed.length) return { text: answer, removed: [] }
  const bad = new Set(report.failed.map(f => f.sentence))
  const kept = splitSentences(answer).filter(s => !bad.has(s))
  // Require something substantial to survive — two sentences, or one long one.
  const enough = kept.length >= 2 || (kept.length === 1 && kept[0].length >= 60)
  if (!enough) return { text: answer, removed: [] }
  return { text: kept.join(' '), removed: [...bad] }
}

/** First capitalised entity in the answer — what a later "It" almost always refers back to. */
function inferTopic(answer: string): string {
  const m = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\b/.exec(answer.replace(/^[^.]*\bis\s+/, ''))
  return m ? m[1] : ''
}
