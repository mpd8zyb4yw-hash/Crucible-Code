// Shared deterministic-consensus primitives for the local-model layer. Extracted from
// localModelRouter so both the flat corroboration path (routeLocalModelQuery) and the
// co-equal debate ensemble (debate.ts) build verdicts from the SAME machinery — one
// definition of "these answers agree", one oracle tie-break, one honest-confidence rule.

import { correctArithmetic } from '../domainVerifiers'

export interface CandidateAnswer {
  modelId: string
  modelLabel: string
  text: string
  confidence: number
  reason: string
}

export type ConsensusMethod = 'single-model' | 'oracle-arithmetic' | 'consensus-vote' | 'plurality-fallback'

/** Cheap, local, no-inference confidence heuristic — not a model call. */
export function scoreAnswer(answer: string): { score: number; reason: string } {
  const trimmed = answer.trim()
  if (!trimmed) return { score: 0, reason: 'empty answer' }
  if (trimmed.length < 8) return { score: 0.2, reason: 'answer too short to be useful' }
  if (/\b(i (don'?t|cannot|can'?t) (know|help|answer))\b/i.test(trimmed)) {
    return { score: 0.15, reason: 'model declined to answer' }
  }
  if (/\[object Object\]|undefined|NaN/.test(trimmed)) {
    return { score: 0.1, reason: 'malformed output' }
  }
  return { score: 0.75, reason: 'plausible answer' }
}

// ── Claim-key normalization (shared with answer/factConsensus) ─────────────────────
// A short factual answer's key claim is (in priority order): a number with optional unit,
// else a proper-noun phrase, else the first clause lowercased. Comparison happens on this
// key, so phrasing differences ("Paris." / "The capital is Paris") still agree. This is
// THE system-wide definition — factConsensus re-exports it; do not fork a second copy.

const STOP = new Set(['The', 'A', 'An', 'It', 'Its', 'This', 'That', 'There', 'They', 'He', 'She', 'I', 'Yes', 'No', 'In', 'On', 'As', 'At'])

export function extractClaimKey(text: string, question?: string): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  // Number (with thousands separators / decimals) — normalize commas away.
  const num = t.match(/-?\d[\d,]*(?:\.\d+)?/)
  if (num) return num[0].replace(/,/g, '')
  // Proper-noun phrase: longest run of Capitalized words that isn't a sentence-starter stopword.
  // Entities the QUESTION already mentions carry no new information (the claim in "the capital
  // of Australia is Canberra" is Canberra, not Australia) — exclude them when possible.
  const q = (question ?? '').toLowerCase()
  const runs = [...t.matchAll(/\b([A-Z][a-zA-Z'’-]+(?:\s+(?:of|the|de|da|von|van|[A-Z][a-zA-Z'’-]+))*)\b/g)]
    .map(m => m[1])
    .map(r => r.split(/\s+/).filter((w, i) => !(i === 0 && STOP.has(w))).join(' '))
    .filter(r => r && !STOP.has(r))
  const fresh = q ? runs.filter(r => !q.includes(r.toLowerCase())) : runs
  const pool = fresh.length ? fresh : runs
  if (pool.length) return pool.sort((a, b) => b.length - a.length)[0].toLowerCase()
  // Fallback: first clause, aggressively normalized.
  const clause = t.split(/[.!?\n]/)[0].toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  return clause || null
}

/** One definition of "these claim keys agree": equality or substring containment. */
export function keysAgree(a: string, b: string): boolean {
  if (a === b) return true
  // Substring containment covers "paris" vs "paris france".
  return a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))
}

/** Rough lexical overlap between two answers — a cheap stand-in for "do these agree". */
export function agrees(a: string, b: string): boolean {
  // Numeric veto first: two answers asserting different standalone numbers are NOT in
  // agreement no matter how much surrounding boilerplate they share ("The answer is 42"
  // vs "The answer is 17" must not be treated as corroborating).
  const numbers = (s: string) => new Set((s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number))
  const na = numbers(a), nb = numbers(b)
  if (na.size && nb.size) {
    const overlap = [...na].some(n => nb.has(n))
    if (!overlap) return false
  }
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
  const wa = words(a), wb = words(b)
  if (wa.size < 3 || wb.size < 3) {
    // Too short for lexical overlap ("Paris." vs "The capital is Paris") — fall back to
    // the claim-key comparison so terse factual answers can still corroborate each other.
    const ka = extractClaimKey(a), kb = extractClaimKey(b)
    return !!ka && !!kb && keysAgree(ka, kb)
  }
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.min(wa.size, wb.size) >= 0.3
}

/**
 * Turn N candidate answers into one strengthened result. Deterministic-first, in order:
 *  1. Oracle tie-break — if any candidate contains a checkable arithmetic claim, correct it
 *     with domainVerifiers.correctArithmetic (zero inference) and prefer whichever candidate
 *     was already numerically correct (or the highest-confidence one, corrected in place).
 *  2. Consensus vote — cluster candidates by mutual lexical agreement (`agrees`), pick the
 *     largest cluster, and report honest confidence proportional to cluster size. A single
 *     dissenting voice among agreeing peers should NOT be reported as high-confidence.
 *  3. Plurality fallback — no cluster of 2+ agrees; return the highest-confidence single
 *     answer, but confidence is capped low since nothing corroborated it.
 */
export function strengthenCandidates(
  candidates: CandidateAnswer[],
): { text: string; winnerId: string; confidence: number; contributors: string[]; method: ConsensusMethod } {
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence)
  const top = ranked[0]

  // 1. Oracle tie-break for arithmetic claims — only trust this path when we actually found
  //    a checkable expression (corrections.length or "already correct" is indistinguishable
  //    from "nothing checkable" unless we also test raw candidates for evaluable claims).
  for (const c of ranked) {
    const { corrections } = correctArithmetic(c.text)
    if (corrections.length > 0) {
      // c had a wrong claim we can fix deterministically — prefer whichever candidate needed
      // NO correction (i.e. was already right) among those checking the same expression.
      const alreadyCorrect = ranked.find(other => correctArithmetic(other.text).corrections.length === 0
        && new RegExp(corrections[0].expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(other.text))
      if (alreadyCorrect) {
        return { text: alreadyCorrect.text, winnerId: alreadyCorrect.modelId, confidence: 0.95, contributors: [alreadyCorrect.modelId], method: 'oracle-arithmetic' }
      }
      const fixed = correctArithmetic(c.text)
      return { text: fixed.text, winnerId: c.modelId, confidence: 0.9, contributors: [c.modelId], method: 'oracle-arithmetic' }
    }
  }

  // 2. Consensus vote — group by mutual agreement, take the largest cluster.
  const clusters: CandidateAnswer[][] = []
  for (const c of ranked) {
    const cluster = clusters.find(cl => agrees(cl[0].text, c.text))
    if (cluster) cluster.push(c)
    else clusters.push([c])
  }
  clusters.sort((a, b) => b.length - a.length || (b[0].confidence - a[0].confidence))
  const bestCluster = clusters[0]

  if (bestCluster.length > 1) {
    const rep = [...bestCluster].sort((a, b) => b.confidence - a.confidence)[0]
    // Honest confidence: scales with agreement fraction, never inflated past what the
    // agreeing group actually supports — a 2-of-5 plurality is NOT high confidence.
    const agreementFraction = bestCluster.length / ranked.length
    const confidence = Math.min(0.97, rep.confidence + agreementFraction * 0.25)
    return { text: rep.text, winnerId: rep.modelId, confidence, contributors: bestCluster.map(c => c.modelId), method: 'consensus-vote' }
  }

  // 3. No agreement at all among 2+ candidates — genuine disagreement. Do not boost
  //    confidence past the top candidate's own honest score.
  return { text: top.text, winnerId: top.modelId, confidence: Math.min(top.confidence, 0.6), contributors: [top.modelId], method: 'plurality-fallback' }
}
