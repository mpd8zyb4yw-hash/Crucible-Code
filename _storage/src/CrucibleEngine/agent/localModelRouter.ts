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
import { modelStatus, isModelEnabled, isFireAllMode, getPinnedModelId } from './modelDownloadManager'
import { callLocalModel } from './localModelPool'
import { fmDirectAnswer, checkFmAvailable } from './fmReact'
import { recordOutcome, markWin } from '../localModels/telemetry'
import { type CandidateAnswer, scoreAnswer, strengthenCandidates } from './consensus'
import { runDebate, type DebatePeer, type DebateResult } from './debate'

// Re-exported so existing importers (__strengthen_bench) keep working after the move to consensus.ts.
export { strengthenCandidates, type CandidateAnswer } from './consensus'

const TIER_RANK: Record<LocalModelSpec['tier'], number> = { fast: 0, balanced: 1, quality: 2 }
const CORROBORATE_DOMAINS = new Set<Domain>(['code', 'reasoning'])
const ESCALATE_BELOW = 0.5


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
  /** Full council-debate transcript when the answer went through cross-examination —
   *  drives the debate card in the chat UI. Absent on single-model fast paths. */
  debate?: DebateResult
}

function readyModels(): LocalModelSpec[] {
  return LOCAL_MODEL_CATALOG.filter(spec => modelStatus(spec.id).status === 'ready' && isModelEnabled(spec.id))
}

/**
 * True when at least one GGUF pool model is downloaded+enabled — the signal callers use to
 * decide whether it's worth routing through routeLocalModelQuery() at all, vs. going straight
 * to the single-model offline path (solveNonCodeTurn), which is more capable than this pool's
 * lone Track-S-FM fallback when zero GGUF models are installed.
 */
export function hasReadyLocalModels(): boolean {
  return readyModels().length > 0
}

/**
 * The device's available council seats for one query: ready GGUF peers up to the RAM
 * budget, plus Apple FM (OS-hosted, never counted against the budget). Used by callers
 * that convene a debate around an externally-produced draft (e.g. the strict-mode
 * answer engine) rather than routing through routeLocalModelQuery.
 */
export async function councilPeers(user: string): Promise<DebatePeer[]> {
  const candidates = readyModels()
  const fmUp = await checkFmAvailable().catch(() => false)
  const domain = classifyDomain(user)
  const primary = pickPrimary(domain, candidates)
  const ordered = primary ? [primary, ...candidates.filter(c => c.id !== primary.id)] : candidates
  const peers: DebatePeer[] = ordered.slice(0, deviceParallelBudget()).map(spec => ({
    modelId: spec.id, modelLabel: spec.label, call: (s: string, u: string) => callLocalModel(spec.id, s, u),
  }))
  if (fmUp) peers.push({ modelId: 'track-s-fm', modelLabel: 'Apple On-Device (Track S)', call: (_s: string, u: string) => fmDirectAnswer(u) })
  return peers
}

/** Best-fit model for a domain: strength match first, then the cheapest tier. */
function pickPrimary(domain: Domain, candidates: LocalModelSpec[]): LocalModelSpec | undefined {
  const withMatch = candidates.filter(m => m.strengths.includes(domain))
  const pool = withMatch.length ? withMatch : candidates
  return [...pool].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])[0]
}

/** How many GGUF models this device can usefully run at once — degrades gracefully on
 *  low-RAM/core machines. Counts ONLY in-process GGUF peers: Apple FM runs inside the
 *  OS's own model service and costs this process nothing, so it is never budgeted here.
 *  macOS reports file-cache pages as "used", so raw freemem() reads near-zero on a
 *  healthy machine — floor the estimate at a quarter of total RAM (reclaimable). */
function deviceParallelBudget(): number {
  const freeGB = Math.max(os.freemem() / 2 ** 30, os.totalmem() / 2 ** 30 * 0.25)
  const cores = os.cpus()?.length ?? 2
  if (freeGB >= 12 && cores >= 8) return 3
  if (freeGB >= 6 && cores >= 4) return 2
  return 1
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

  const pinnedId = getPinnedModelId()
  const pinnedSpec = pinnedId ? candidates.find(c => c.id === pinnedId) : undefined
  if (pinnedId) {
    // Single-model pin: the user explicitly chose one model — never fan out, never escalate,
    // even if the pinned model's own answer looks shaky. Honor the override literally.
    const pinned = pinnedSpec
      ? await callAsCandidate({ modelId: pinnedSpec.id, modelLabel: pinnedSpec.label, call: () => callLocalModel(pinnedSpec.id, system, user) })
      : pinnedId === 'track-s-fm' && fmUp
        ? await callAsCandidate({ modelId: 'track-s-fm', modelLabel: 'Apple On-Device (Track S)', call: () => fmDirectAnswer(user) })
        : null
    if (pinned) {
      markWin(pinned.modelId)
      return { text: pinned.text, modelId: pinned.modelId, modelLabel: pinned.modelLabel, domain, confidence: pinned.confidence, corroboration: [], corroborated: false, firedAll: false, contributors: [pinned.modelId], method: 'single-model' }
    }
    // Pinned model isn't actually ready (deleted/disabled since pinning) — fall through to auto.
  }

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
  const ggufOthers: Array<{ modelId: string; modelLabel: string; call: (s: string, u: string) => Promise<string> }> = []
  for (const spec of candidates) {
    if (spec.id === primary.modelId) continue
    ggufOthers.push({ modelId: spec.id, modelLabel: spec.label, call: (s, u) => callLocalModel(spec.id, s, u) })
  }
  const fmPeer = fmUp && primary.modelId !== 'track-s-fm'
    ? { modelId: 'track-s-fm', modelLabel: 'Apple On-Device (Track S)', call: (_s: string, u: string) => fmDirectAnswer(u) }
    : null

  // Fire-all is an explicit, informed user override — it bypasses the device-parallel-budget
  // throttle that otherwise degrades fan-out on low-RAM/core machines, since the user has
  // deliberately asked for every downloaded model to run on every query regardless of cost.
  // The FM peer is appended OUTSIDE the budget slice: it lives in the OS's model service,
  // not this process, so even a budget-1 (8GB) device seats a real two-voice council.
  const fanOut = [
    ...(fireAll ? ggufOthers : ggufOthers.slice(0, Math.max(0, budget - 1))),
    ...(fmPeer ? [fmPeer] : []),
  ]

  // Council debate (cont.58c) — co-equal peers, not primary-plus-backups: everyone proposes
  // blind (the primary's answer is seeded, not recomputed), everyone cross-examines everyone,
  // and the verdict is deterministic. Independent training lineages agreeing after adversarial
  // review is the strongest corroboration this device can produce.
  const peers: DebatePeer[] = [
    {
      modelId: primary.modelId,
      modelLabel: primary.modelLabel,
      call: primary.modelId === 'track-s-fm'
        ? (_s, u) => fmDirectAnswer(u)
        : (s, u) => callLocalModel(primary.modelId, s, u),
    },
    ...fanOut,
  ]
  const debate = await runDebate(peers, system, user, {
    seedProposals: [{ modelId: primary.modelId, modelLabel: primary.modelLabel, text: primary.text }],
  })

  if (!debate) {
    // Every peer failed — primary's own answer (already scored) is all we have.
    markWin(primary.modelId)
    return { text: primary.text, modelId: primary.modelId, modelLabel: primary.modelLabel, domain, confidence: primary.confidence, corroboration: [], corroborated: false, firedAll: fireAll, contributors: [primary.modelId], method: 'single-model' }
  }

  // Telemetry per peer from the propose round (the seeded primary was already recorded).
  for (const e of debate.rounds[0].entries) {
    if (e.modelId === primary.modelId) continue
    const { score } = scoreAnswer(e.text)
    recordOutcome({ modelId: e.modelId, latencyMs: e.latencyMs, confidence: e.errored ? 0 : score, won: false, errored: e.errored })
  }
  markWin(debate.winnerId)

  const finalRound = debate.rounds[debate.rounds.length - 1].entries
  const rest: CandidateAnswer[] = finalRound
    .filter(e => e.modelId !== debate.winnerId && !e.errored && e.text)
    .map(e => { const { score, reason } = scoreAnswer(e.text); return { modelId: e.modelId, modelLabel: e.modelLabel, text: e.text, confidence: score, reason } })
    .sort((a, b) => b.confidence - a.confidence)

  return {
    text: debate.text,
    modelId: debate.winnerId,
    modelLabel: debate.winnerLabel,
    domain,
    confidence: debate.confidence,
    corroboration: rest,
    corroborated: debate.contributors.length > 1,
    firedAll: fireAll,
    contributors: debate.contributors,
    method: debate.method,
    debate,
  }
}

