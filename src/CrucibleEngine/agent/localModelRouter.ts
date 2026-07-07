// Escalation + collaboration router for the optional local-model pool. Separate from
// src/CrucibleEngine/router/capabilityRouter.ts, which is a parked, unrelated design for
// synth/fm/retrieve/abstain classification — do not merge the two.
//
// Strategy: classify the query's domain and pick the model with the best-matching
// strength as the primary answer (fast path — one model call). If that answer scores
// low, OR the domain is one where corroboration matters (code/reasoning), fan the
// remaining ready models — including Track S's Apple FM as a peer, not just the GGUF
// pool — out in parallel and let them critique/corroborate. Fan-out width is capped by
// what this device can actually run concurrently, so a phone-class machine degrades to
// sequential without falling over.

import os from 'os'
import { LOCAL_MODEL_CATALOG, classifyDomain, type LocalModelSpec, type Domain } from './localModelCatalog'
import { modelStatus, isModelEnabled, isFireAllMode } from './modelDownloadManager'
import { callLocalModel } from './localModelPool'
import { fmDirectAnswer, checkFmAvailable } from './fmReact'
import { recordOutcome, markWin } from '../localModels/telemetry'
import { correctArithmetic } from '../domainVerifiers'

const TIER_RANK: Record<LocalModelSpec['tier'], number> = { fast: 0, balanced: 1, quality: 2 }
const CORROBORATE_DOMAINS = new Set<Domain>(['code', 'reasoning'])
const ESCALATE_BELOW = 0.5

export interface CandidateAnswer {
  modelId: string
  modelLabel: string
  text: string
  confidence: number
  reason: string
}

export interface RoutedAnswer {
  text: string
  modelId: string
  modelLabel: string
  domain: Domain
  confidence: number
  /** Other models consulted in parallel, in confidence order — empty on the fast path. */
  corroboration: CandidateAnswer[]
  /** True when at least one other model's answer materially agreed with the winner. */
  corroborated: boolean
  /** True when this answer was produced with the user's "always fire all models" override on. */
  firedAll: boolean
  /** modelIds whose answer text fed the returned `text` (winner + any that voted with it). */
  contributors: string[]
  /** How the final answer was picked — surfaced in the UI, not just for debugging. */
  method: 'single-model' | 'oracle-arithmetic' | 'consensus-vote' | 'plurality-fallback'
}

function readyModels(): LocalModelSpec[] {
  return LOCAL_MODEL_CATALOG.filter(spec => modelStatus(spec.id).status === 'ready' && isModelEnabled(spec.id))
}

/** Best-fit model for a domain: strength match first, then the cheapest tier. */
function pickPrimary(domain: Domain, candidates: LocalModelSpec[]): LocalModelSpec | undefined {
  const withMatch = candidates.filter(m => m.strengths.includes(domain))
  const pool = withMatch.length ? withMatch : candidates
  return [...pool].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]
}

/** How many models this device can usefully run at once — degrades gracefully on low-RAM/core machines. */
function deviceParallelBudget(): number {
  const freeGB = os.freemem() / 2 ** 30
  const cores = os.cpus()?.length ?? 2
  if (freeGB >= 12 && cores >= 8) return 3
  if (freeGB >= 6 && cores >= 4) return 2
  return 1
}

/** Cheap, local, no-inference confidence heuristic — not a model call. */
function scoreAnswer(answer: string): { score: number; reason: string } {
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
function agrees(a: string, b: string): boolean {
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

async function callAsCandidate(
  kind: { modelId: string; modelLabel: string; call: () => Promise<string> },
): Promise<CandidateAnswer | null> {
  const startedAt = Date.now()
  try {
    const text = await kind.call()
    const { score, reason } = scoreAnswer(text)
    recordOutcome({ modelId: kind.modelId, latencyMs: Date.now() - startedAt, confidence: score, won: false, errored: false })
    return { modelId: kind.modelId, modelLabel: kind.modelLabel, text, confidence: score, reason }
  } catch (err: any) {
    recordOutcome({ modelId: kind.modelId, latencyMs: Date.now() - startedAt, confidence: 0, won: false, errored: true })
    return { modelId: kind.modelId, modelLabel: kind.modelLabel, text: '', confidence: 0, reason: err?.message ?? String(err) }
  }
}

/**
 * Route a query through the downloaded local-model pool plus Track S (Apple FM) as a
 * peer. Returns null only when no local models are downloaded AND FM is unavailable —
 * callers should fall back to the existing external-ensemble pipeline in that case.
 */
export async function routeLocalModelQuery(system: string, user: string): Promise<RoutedAnswer | null> {
  const candidates = readyModels()
  const fmUp = await checkFmAvailable().catch(() => false)
  if (!candidates.length && !fmUp) return null

  const domain = classifyDomain(user)
  const primarySpec = pickPrimary(domain, candidates)

  const primary = primarySpec
    ? await callAsCandidate({ modelId: primarySpec.id, modelLabel: primarySpec.label, call: () => callLocalModel(primarySpec.id, system, user) })
    : fmUp
      ? await callAsCandidate({ modelId: 'track-s-fm', modelLabel: 'Apple On-Device (Track S)', call: () => fmDirectAnswer(user) })
      : null

  if (!primary) return null

  const fireAll = isFireAllMode()
  const needsCorroboration = fireAll || primary.confidence < ESCALATE_BELOW || CORROBORATE_DOMAINS.has(domain)
  if (!needsCorroboration) {
    markWin(primary.modelId)
    return { text: primary.text, modelId: primary.modelId, modelLabel: primary.modelLabel, domain, confidence: primary.confidence, corroboration: [], corroborated: false, firedAll: false, contributors: [primary.modelId], method: 'single-model' }
  }

  const budget = deviceParallelBudget()
  const others: Array<{ modelId: string; modelLabel: string; call: () => Promise<string> }> = []
  for (const spec of candidates) {
    if (spec.id === primary.modelId) continue
    others.push({ modelId: spec.id, modelLabel: spec.label, call: () => callLocalModel(spec.id, system, user) })
  }
  if (fmUp && primary.modelId !== 'track-s-fm') {
    others.push({ modelId: 'track-s-fm', modelLabel: 'Apple On-Device (Track S)', call: () => fmDirectAnswer(user) })
  }

  // Fire-all is an explicit, informed user override — it bypasses the device-parallel-budget
  // throttle that otherwise degrades fan-out on low-RAM/core machines, since the user has
  // deliberately asked for every downloaded model to run on every query regardless of cost.
  const fanOut = fireAll ? others : others.slice(0, Math.max(0, budget - 1))
  const results = (await Promise.all(fanOut.map(callAsCandidate))).filter((c): c is CandidateAnswer => !!c)

  const all = [primary, ...results].filter(c => c.text.trim().length > 0)
  const strengthened = strengthenCandidates(all)
  const winner = all.find(c => c.modelId === strengthened.winnerId) ?? primary
  const rest = all.filter(c => c.modelId !== winner.modelId).sort((a, b) => b.confidence - a.confidence)
  markWin(winner.modelId)

  return {
    text: strengthened.text,
    modelId: winner.modelId,
    modelLabel: winner.modelLabel,
    domain,
    confidence: strengthened.confidence,
    corroboration: rest,
    corroborated: strengthened.contributors.length > 1,
    firedAll: fireAll,
    contributors: strengthened.contributors,
    method: strengthened.method,
  }
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
): { text: string; winnerId: string; confidence: number; contributors: string[]; method: RoutedAnswer['method'] } {
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
