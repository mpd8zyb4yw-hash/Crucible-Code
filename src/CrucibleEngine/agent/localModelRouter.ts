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
import { modelStatus, isModelEnabled } from './modelDownloadManager'
import { callLocalModel } from './localModelPool'
import { fmDirectAnswer, checkFmAvailable } from './fmReact'

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
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
  const wa = words(a), wb = words(b)
  if (!wa.size || !wb.size) return false
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.min(wa.size, wb.size) >= 0.3
}

async function callAsCandidate(
  kind: { modelId: string; modelLabel: string; call: () => Promise<string> },
): Promise<CandidateAnswer | null> {
  try {
    const text = await kind.call()
    const { score, reason } = scoreAnswer(text)
    return { modelId: kind.modelId, modelLabel: kind.modelLabel, text, confidence: score, reason }
  } catch (err: any) {
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

  const needsCorroboration = primary.confidence < ESCALATE_BELOW || CORROBORATE_DOMAINS.has(domain)
  if (!needsCorroboration) {
    return { text: primary.text, modelId: primary.modelId, modelLabel: primary.modelLabel, domain, confidence: primary.confidence, corroboration: [], corroborated: false }
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

  const fanOut = others.slice(0, Math.max(0, budget - 1))
  const results = (await Promise.all(fanOut.map(callAsCandidate))).filter((c): c is CandidateAnswer => !!c)

  const all = [primary, ...results].sort((a, b) => b.confidence - a.confidence)
  const winner = all[0]
  const rest = all.slice(1)
  const corroborated = rest.some(c => c.confidence > 0.3 && agrees(winner.text, c.text))

  return {
    text: winner.text,
    modelId: winner.modelId,
    modelLabel: winner.modelLabel,
    domain,
    confidence: corroborated ? Math.min(1, winner.confidence + 0.15) : winner.confidence,
    corroboration: rest,
    corroborated,
  }
}
