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
  if (wa.size < 3 || wb.size < 3) return false // too short to judge agreement reliably
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
