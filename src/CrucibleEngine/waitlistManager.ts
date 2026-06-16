// ── Waitlist Manager ─────────────────────────────────────────────────────────
// Manages the pipeline: Hunter Discovery → Waitlist → Probation → Graduate/Reject
//
// Waitlist score (0-100):
//   60% Layer 1 — intrinsic: probe quality, params, provider reliability, history
//   40% Layer 2 — external: HuggingFace/OpenRouter benchmark scrape (graceful fallback)
//
// Fairness: age bonus (+2pts/cycle) ensures no model waits forever.
// Max 2 concurrent probation slots.
// Hard failures rotate out immediately. Soft failures (429/timeout) don't count.

import fs from 'fs'
import path from 'path'

const WAITLIST_FILE = (root: string) => path.join(root, '.crucible', 'waitlist.json')
const PROBATION_HISTORY_FILE = (root: string) => path.join(root, '.crucible', 'probation-history.json')

export const MAX_CONCURRENT_PROBATION = 2
export const PROBATION_CALLS = 5
export const VIABILITY_PASS_THRESHOLD = 0.4   // success rate to graduate
export const VIABILITY_LOW_THRESHOLD = 0.6    // below this = low-confidence graduate

// Tiered cooldowns on rejection (milliseconds)
const COOLDOWN_1ST = 48 * 60 * 60 * 1000       // 48 hours
const COOLDOWN_2ND = 30 * 24 * 60 * 60 * 1000  // 30 days
const COOLDOWN_3RD = 90 * 24 * 60 * 60 * 1000  // 90 days

export interface WaitlistEntry {
  id: string
  label: string
  provider: string
  params: number
  probeLatencyMs: number
  qualityScore: number        // from hunter probe battery (4-8)
  intrinsicScore: number      // Layer 1 (0-100)
  externalScore: number | null // Layer 2 (0-100), null if not yet scraped
  waitlistScore: number       // combined final score
  cyclesWaiting: number       // age bonus counter
  addedAt: number
  lastScoreUpdate: number
}

export interface ProbationEntry {
  id: string
  label: string
  callsRemaining: number
  consecutiveSoftFails: number
  addedAt: number
}

export interface ProbationHistoryEntry {
  id: string
  failureCount: number
  lastRejectedAt: number
  cooldownUntil: number
  reason: string
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadWaitlist(root: string): WaitlistEntry[] {
  try { return JSON.parse(fs.readFileSync(WAITLIST_FILE(root), 'utf8')) } catch { return [] }
}

function saveWaitlist(root: string, list: WaitlistEntry[]) {
  fs.mkdirSync(path.dirname(WAITLIST_FILE(root)), { recursive: true })
  fs.writeFileSync(WAITLIST_FILE(root), JSON.stringify(list, null, 2))
}

function loadHistory(root: string): Record<string, ProbationHistoryEntry> {
  try { return JSON.parse(fs.readFileSync(PROBATION_HISTORY_FILE(root), 'utf8')) } catch { return {} }
}

function saveHistory(root: string, history: Record<string, ProbationHistoryEntry>) {
  fs.mkdirSync(path.dirname(PROBATION_HISTORY_FILE(root)), { recursive: true })
  fs.writeFileSync(PROBATION_HISTORY_FILE(root), JSON.stringify(history, null, 2))
}

// ── In-memory probation state ─────────────────────────────────────────────────

const activeProbation: Map<string, ProbationEntry> = new Map()

// ── Scoring ───────────────────────────────────────────────────────────────────

function calcIntrinsicScore(entry: {
  qualityScore: number
  params: number
  probeLatencyMs: number
}, historyEntry?: ProbationHistoryEntry): number {
  // Quality probe score (4-8) → normalize to 0-100
  const qualityNorm = ((entry.qualityScore - 4) / 4) * 50  // 0-50 pts

  // Param count: sweet spot 7-70B. Too small = weak, too large = slow on free tier
  const paramScore = entry.params >= 7 && entry.params <= 70
    ? 20
    : entry.params < 7 ? 10 : 15  // huge models penalized for free-tier slowness

  // Latency score: faster initial probe = more reliable on free tier
  const latScore = entry.probeLatencyMs < 3000 ? 20
    : entry.probeLatencyMs < 8000 ? 15
    : entry.probeLatencyMs < 15000 ? 8 : 0

  // History penalty
  const histPenalty = historyEntry
    ? historyEntry.failureCount === 1 ? 10
    : historyEntry.failureCount === 2 ? 25 : 35
    : 0

  return Math.max(0, Math.min(100, qualityNorm + paramScore + latScore - histPenalty))
}

function combineScores(intrinsic: number, external: number | null, cyclesWaiting: number): number {
  const ageBonus = cyclesWaiting * 2  // +2pts per cycle, uncapped — guarantees eventual front
  if (external === null) {
    // Layer 2 not yet available — redistribute its weight to Layer 1
    return Math.min(100, intrinsic + ageBonus)
  }
  return Math.min(100, (intrinsic * 0.6) + (external * 0.4) + ageBonus)
}

// ── External benchmark scraper (Layer 2) ──────────────────────────────────────

async function scrapeExternalScore(id: string, apiKey: string): Promise<number | null> {
  try {
    // Step 1: fetch OpenRouter model card to get HuggingFace repo link
    const orRes = await Promise.race([
      fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(id)}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ])
    if (!orRes.ok) return null
    const orData = await orRes.json() as any

    // Extract HuggingFace model id from description or source links
    const desc: string = (orData?.description ?? '') + (orData?.per_request_limits ?? '')
    const hfMatch = desc.match(/huggingface\.co\/([a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+)/)
    const hfId = hfMatch?.[1] ?? id.replace('openrouter/', '')

    // Step 2: fetch HuggingFace model card
    const hfRes = await Promise.race([
      fetch(`https://huggingface.co/api/models/${hfId}`, {
        headers: { 'Accept': 'application/json' }
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ])
    if (!hfRes.ok) return null
    const hfData = await hfRes.json() as any

    // Extract available eval scores from model card metadata
    const evals = hfData?.cardData?.eval_results ?? hfData?.model_card?.eval_results ?? []
    let score = 0
    let count = 0

    for (const e of evals) {
      const name: string = (e.task?.name ?? e.dataset?.name ?? '').toLowerCase()
      const val = parseFloat(e.metrics?.[0]?.value ?? e.value ?? '')
      if (isNaN(val)) continue
      // Weight known benchmarks
      if (name.includes('mmlu')) { score += val * 0.4; count++ }
      else if (name.includes('humaneval') || name.includes('human_eval')) { score += val * 0.35; count++ }
      else if (name.includes('arc')) { score += val * 0.25; count++ }
    }

    if (count === 0) return null
    // Normalize: most scores are 0-100 percentages
    return Math.min(100, Math.max(0, score / count))
  } catch {
    return null  // graceful degradation — Layer 1 takes full weight
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Add a newly discovered model to the waitlist */
export function enqueueModel(root: string, model: {
  id: string
  label: string
  provider: string
  params: number
  probeLatencyMs: number
  qualityScore: number
}) {
  const list = loadWaitlist(root)
  if (list.find(e => e.id === model.id)) return  // already queued
  if (activeProbation.has(model.id)) return       // already in probation

  const history = loadHistory(root)
  const hist = history[model.id]

  // Check cooldown
  if (hist && hist.cooldownUntil > Date.now()) {
    console.log(`[Waitlist] ${model.id} still in cooldown until ${new Date(hist.cooldownUntil).toISOString()} — skipping`)
    return
  }

  const intrinsicScore = calcIntrinsicScore(model, hist)
  const entry: WaitlistEntry = {
    ...model,
    intrinsicScore,
    externalScore: null,
    waitlistScore: combineScores(intrinsicScore, null, 0),
    cyclesWaiting: 0,
    addedAt: Date.now(),
    lastScoreUpdate: Date.now(),
  }

  list.push(entry)
  list.sort((a, b) => b.waitlistScore - a.waitlistScore)
  saveWaitlist(root, list)
  console.log(`[Waitlist] Enqueued ${model.label} (score=${entry.waitlistScore.toFixed(1)})`)
}

/** Run background score updates — call every 6 hours */
export async function updateWaitlistScores(root: string, apiKey: string) {
  const list = loadWaitlist(root)
  if (list.length === 0) return

  console.log(`[Waitlist] Updating scores for ${list.length} queued models`)
  const history = loadHistory(root)

  for (const entry of list) {
    entry.cyclesWaiting++
    // Scrape external score if not yet done or stale (> 24h)
    const stale = Date.now() - entry.lastScoreUpdate > 24 * 60 * 60 * 1000
    if (entry.externalScore === null || stale) {
      const ext = await scrapeExternalScore(entry.id, apiKey)
      if (ext !== null) {
        entry.externalScore = ext
        entry.lastScoreUpdate = Date.now()
        console.log(`[Waitlist] External score for ${entry.label}: ${ext.toFixed(1)}`)
      }
    }
    const hist = history[entry.id]
    entry.intrinsicScore = calcIntrinsicScore(entry, hist)
    entry.waitlistScore = combineScores(entry.intrinsicScore, entry.externalScore, entry.cyclesWaiting)
  }

  list.sort((a, b) => b.waitlistScore - a.waitlistScore)
  saveWaitlist(root, list)
  console.log(`[Waitlist] Scores updated and re-sorted`)
}

/** Promote next eligible model from waitlist into probation */
export function promoteNextFromWaitlist(root: string): string | null {
  if (activeProbation.size >= MAX_CONCURRENT_PROBATION) return null

  const list = loadWaitlist(root)
  if (list.length === 0) return null

  // Pick highest scoring model not already in probation
  const candidate = list.find(e => !activeProbation.has(e.id))
  if (!candidate) return null

  // Remove from waitlist
  const updated = list.filter(e => e.id !== candidate.id)
  saveWaitlist(root, updated)

  // Add to active probation
  activeProbation.set(candidate.id, {
    id: candidate.id,
    label: candidate.label,
    callsRemaining: PROBATION_CALLS,
    consecutiveSoftFails: 0,
    addedAt: Date.now(),
  })

  console.log(`[Probation] Promoted ${candidate.label} from waitlist (score=${candidate.waitlistScore.toFixed(1)}, ${activeProbation.size}/${MAX_CONCURRENT_PROBATION} slots)`)
  return candidate.id
}

/** Get current probation slot IDs to inject into pipeline */
export function getProbationIds(): string[] {
  return Array.from(activeProbation.keys())
}

/** Record a probation outcome. Returns true if model should be rotated out immediately */
export function recordProbationOutcome(root: string, modelId: string, outcome: {
  ok: boolean
  hardFail: boolean  // 404/decommissioned vs 429/timeout
}): { rotateOut: boolean; graduated: boolean } {
  const entry = activeProbation.get(modelId)
  if (!entry) return { rotateOut: false, graduated: false }

  if (outcome.hardFail) {
    // Immediate rotation — API gone, model dead
    console.log(`[Probation] Hard fail on ${modelId} — rotating out immediately`)
    activeProbation.delete(modelId)
    applyRejection(root, modelId, entry.label, 'hard-fail')
    promoteNextFromWaitlist(root)
    return { rotateOut: true, graduated: false }
  }

  if (!outcome.ok) {
    // Soft fail — 429/timeout, doesn't count against probation calls
    entry.consecutiveSoftFails++
    if (entry.consecutiveSoftFails >= 3) {
      console.log(`[Probation] 3 consecutive soft fails on ${modelId} — treating as hard fail`)
      activeProbation.delete(modelId)
      applyRejection(root, modelId, entry.label, 'soft-fail-streak')
      promoteNextFromWaitlist(root)
      return { rotateOut: true, graduated: false }
    }
    console.log(`[Probation] Soft fail on ${modelId} (${entry.consecutiveSoftFails}/3) — not counting against probation`)
    return { rotateOut: false, graduated: false }
  }

  // Success — reset soft fail counter, decrement probation calls
  entry.consecutiveSoftFails = 0
  entry.callsRemaining--

  if (entry.callsRemaining <= 0) {
    // Probation complete — check viability
    return checkGraduation(root, modelId, entry.label)
  }

  console.log(`[Probation] ${entry.label} ok — ${entry.callsRemaining} calls remaining`)
  return { rotateOut: false, graduated: false }
}

function checkGraduation(root: string, modelId: string, label: string): { rotateOut: boolean; graduated: boolean } {
  // Import viabilityScore dynamically to avoid circular dep
  let viability = 1.0
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = require('../../modelRegistry')
    viability = reg.viabilityScore(modelId)
  } catch { /* can't check — give benefit of doubt */ }

  activeProbation.delete(modelId)

  if (viability < VIABILITY_PASS_THRESHOLD) {
    console.log(`[Probation] ${label} FAILED graduation (viability=${viability.toFixed(2)} < ${VIABILITY_PASS_THRESHOLD}) — rejecting`)
    applyRejection(root, modelId, label, 'low-viability')
    promoteNextFromWaitlist(root)
    return { rotateOut: true, graduated: false }
  }

  const confidence = viability >= VIABILITY_LOW_THRESHOLD ? 'full' : 'low'
  console.log(`[Probation] ${label} GRADUATED (viability=${viability.toFixed(2)}, confidence=${confidence})`)
  promoteNextFromWaitlist(root)
  return { rotateOut: false, graduated: true }
}

function applyRejection(root: string, modelId: string, label: string, reason: string) {
  const history = loadHistory(root)
  const existing = history[modelId]
  const failureCount = (existing?.failureCount ?? 0) + 1

  const cooldownMs = failureCount === 1 ? COOLDOWN_1ST
    : failureCount === 2 ? COOLDOWN_2ND
    : COOLDOWN_3RD

  history[modelId] = {
    id: modelId,
    failureCount,
    lastRejectedAt: Date.now(),
    cooldownUntil: Date.now() + cooldownMs,
    reason,
  }
  saveHistory(root, history)

  const cooldownLabel = failureCount === 1 ? '48h'
    : failureCount === 2 ? '30 days' : '90 days'
  console.log(`[Probation] ${label} rejected (failure #${failureCount}, cooldown ${cooldownLabel}, reason: ${reason})`)
}

/** Waitlist status for diagnostics */
export function waitlistStatus(root: string) {
  const list = loadWaitlist(root)
  const history = loadHistory(root)
  return {
    waitlistCount: list.length,
    probationCount: activeProbation.size,
    probationSlots: MAX_CONCURRENT_PROBATION,
    waitlist: list.map(e => ({ id: e.id, label: e.label, score: e.waitlistScore, cyclesWaiting: e.cyclesWaiting })),
    probation: Array.from(activeProbation.values()).map(e => ({ id: e.id, label: e.label, callsRemaining: e.callsRemaining })),
    rejectionHistory: Object.values(history).map(h => ({
      id: h.id, failureCount: h.failureCount,
      cooldownUntil: new Date(h.cooldownUntil).toISOString(), reason: h.reason
    }))
  }
}
