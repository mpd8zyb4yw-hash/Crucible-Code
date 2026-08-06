// ============================================================
// CRUCIBLE — Drift Prevention Triumvirate
//
// Three specialized judge models debate every proposed autonomous
// change before it is committed. Each judge has a distinct mandate:
//
//   STABILITY  — "Does this change risk destabilizing the pipeline?"
//                Looks for: over-indexing on a narrow query type,
//                weight drift beyond sensible bounds, pattern noise.
//
//   EFFICACY   — "Is this change grounded in real signal, not noise?"
//                Looks for: too few samples, cherry-picked data,
//                circular reasoning from bad baselines.
//
//   DIVERSITY  — "Does this change preserve the ensemble's breadth?"
//                Looks for: homogenizing weights that erase cross-model
//                disagreement — the core source of ensemble value.
//
// Voting thresholds:
//   Scoring-weight changes  → UNANIMOUS (3/3)   — high stakes
//   Knowledge-base updates  → MAJORITY  (2/3)   — lower stakes
//
// All verdicts + reasoning stored in .crucible/triumvirate-log.json
// (capped at 200 entries, newest first).
// ============================================================

import fs from 'fs'
import path from 'path'

// ── Judge definitions ──────────────────────────────────────────

interface Judge {
  name: 'STABILITY' | 'EFFICACY' | 'DIVERSITY'
  mandate: string
  systemPrompt: string
}

const JUDGES: Judge[] = [
  {
    name: 'STABILITY',
    mandate: 'Prevent destabilizing changes to the pipeline',
    systemPrompt: `You are the STABILITY judge in the Crucible autonomous improvement system.
Your single job: decide if a proposed change risks destabilizing the pipeline.

Red flags you must catch:
- Scoring weights drifting toward a single dominant dimension (e.g. functional > 0.55)
- Weight changes that correlate with a narrow slice of query types (< 20% of data)
- Knowledge patterns extracted from fewer than 5 high-scoring samples
- Any change that would concentrate scoring power away from the current balanced distribution

You are NOT judging quality — only stability and safety.

Respond with EXACTLY this format (no other text):
VERDICT: APPROVE or REJECT
REASON: one sentence explaining your verdict`,
  },
  {
    name: 'EFFICACY',
    mandate: 'Ensure changes are grounded in real signal, not noise',
    systemPrompt: `You are the EFFICACY judge in the Crucible autonomous improvement system.
Your single job: decide if a proposed change is supported by sufficient evidence.

Red flags you must catch:
- Weight nudges derived from fewer than 20 history samples
- Knowledge patterns with vague or duplicate structural tokens
- Changes where the "top" and "bottom" distributions differ by less than 10%
- Circular improvements: patterns extracted from prior autonomous commits, not real user queries

You are NOT judging stability or diversity — only whether the evidence is real.

Respond with EXACTLY this format (no other text):
VERDICT: APPROVE or REJECT
REASON: one sentence explaining your verdict`,
  },
  {
    name: 'DIVERSITY',
    mandate: 'Preserve the ensemble breadth that makes Crucible valuable',
    systemPrompt: `You are the DIVERSITY judge in the Crucible autonomous improvement system.
Your single job: decide if a proposed change preserves or erodes ensemble diversity.

Red flags you must catch:
- Novelty weight dropping below 0.15 (kills creative and cross-domain synthesis)
- Similarity weight rising above 0.45 (collapses models toward same answers)
- Knowledge patterns that duplicate existing entries with different names
- Specialization signals that would route all queries to a single model

You are NOT judging stability or evidence quality — only ensemble breadth.

Respond with EXACTLY this format (no other text):
VERDICT: APPROVE or REJECT
REASON: one sentence explaining your verdict`,
  },
]

// ── Proposal types ─────────────────────────────────────────────

export type ProposalType = 'weight_change' | 'knowledge_pattern'

export interface WeightChangeProposal {
  type: 'weight_change'
  before: { similarity: number; functional: number; novelty: number }
  after: { similarity: number; functional: number; novelty: number }
  sampleSize: number
  topCodingFrac: number
  btmCodingFrac: number
  topCreativeFrac: number
  btmCreativeFrac: number
}

export interface KnowledgePatternProposal {
  type: 'knowledge_pattern'
  id: string
  tokens: string[]
  promptType: string
  sourceScore: number
  description: string
}

export type Proposal = WeightChangeProposal | KnowledgePatternProposal

// ── Log persistence ────────────────────────────────────────────

interface JudgeVerdict {
  judge: string
  verdict: 'APPROVE' | 'REJECT'
  reason: string
}

interface DebateEntry {
  ts: number
  proposalType: ProposalType
  proposal: Proposal
  verdicts: JudgeVerdict[]
  outcome: 'APPROVED' | 'REJECTED'
  threshold: string
}

const MAX_LOG_ENTRIES = 200

function logFile(dir: string) { return path.join(dir, '.crucible', 'triumvirate-log.json') }

function appendLog(dir: string, entry: DebateEntry): void {
  try {
    let log: DebateEntry[] = []
    try { log = JSON.parse(fs.readFileSync(logFile(dir), 'utf8')) } catch {}
    log.unshift(entry)
    if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES
    fs.mkdirSync(path.join(dir, '.crucible'), { recursive: true })
    fs.writeFileSync(logFile(dir), JSON.stringify(log, null, 2))
  } catch {}
}

// ── Proposal formatter ─────────────────────────────────────────

function formatProposal(proposal: Proposal): string {
  if (proposal.type === 'weight_change') {
    const p = proposal
    return `PROPOSED CHANGE: Scoring weight adjustment
Before: similarity=${p.before.similarity} functional=${p.before.functional} novelty=${p.before.novelty}
After:  similarity=${p.after.similarity}  functional=${p.after.functional}  novelty=${p.after.novelty}
Delta:  similarity=${(p.after.similarity - p.before.similarity).toFixed(3)} functional=${(p.after.functional - p.before.functional).toFixed(3)} novelty=${(p.after.novelty - p.before.novelty).toFixed(3)}
Evidence: ${p.sampleSize} history samples
Top-quintile coding/math fraction: ${(p.topCodingFrac * 100).toFixed(0)}%
Bottom-quintile coding/math fraction: ${(p.btmCodingFrac * 100).toFixed(0)}%
Top-quintile creative fraction: ${(p.topCreativeFrac * 100).toFixed(0)}%
Bottom-quintile creative fraction: ${(p.btmCreativeFrac * 100).toFixed(0)}%`
  } else {
    const p = proposal
    return `PROPOSED CHANGE: New knowledge pattern entry
ID: ${p.id}
Tokens: ${p.tokens.join(', ')}
Category: ${p.promptType}
Source composite score: ${p.sourceScore.toFixed(3)}
Description: ${p.description}`
  }
}

// ── Verdict parser ─────────────────────────────────────────────

function parseVerdict(text: string): { verdict: 'APPROVE' | 'REJECT'; reason: string } {
  const vMatch = text.match(/VERDICT:\s*(APPROVE|REJECT)/i)
  const rMatch = text.match(/REASON:\s*(.+)/i)
  const verdict = (vMatch?.[1]?.toUpperCase() ?? 'REJECT') as 'APPROVE' | 'REJECT'
  const reason = rMatch?.[1]?.trim() ?? 'No reason provided'
  return { verdict, reason }
}

// ── Core debate function ───────────────────────────────────────
// callModel is passed in to avoid a circular import with server.ts.
// It must match: (model, messages, opts?) => Promise<string>

type CallModelFn = (
  model: { id: string; label: string; provider: string; [k: string]: any },
  messages: Array<{ role: string; content: string }>,
  opts?: any
) => Promise<string>

// Picks three diverse models from the registry (one per provider where possible)
// to serve as the three judge seats. Falls back gracefully if models are unavailable.
function pickJudgeModels(MODEL_REGISTRY: any[]): any[] {
  const providers = ['groq', 'mistral', 'openrouter']
  const judges: any[] = []
  for (const provider of providers) {
    const m = MODEL_REGISTRY.find((e: any) =>
      e.provider === provider && e.free &&
      !judges.some(j => j.id === e.id)
    )
    if (m) judges.push(m)
  }
  // Pad if needed
  while (judges.length < 3) {
    const fallback = MODEL_REGISTRY.find((e: any) => e.free && !judges.some(j => j.id === e.id))
    if (!fallback) break
    judges.push(fallback)
  }
  return judges.slice(0, 3)
}

export async function runTriumvirate(
  proposal: Proposal,
  dir: string,
  MODEL_REGISTRY: any[],
  callModel: CallModelFn
): Promise<{ approved: boolean; verdicts: JudgeVerdict[]; outcome: string }> {
  const proposalText = formatProposal(proposal)
  const threshold = proposal.type === 'weight_change' ? 'unanimous (3/3)' : 'majority (2/3)'
  const requiredApprovals = proposal.type === 'weight_change' ? 3 : 2

  const judgeModels = pickJudgeModels(MODEL_REGISTRY)
  const verdicts: JudgeVerdict[] = []

  // Run all three judges in parallel — they must not see each other's reasoning
  const judgePromises = JUDGES.map(async (judge, i) => {
    const model = judgeModels[i] ?? judgeModels[0]
    const messages = [
      { role: 'system', content: judge.systemPrompt },
      {
        role: 'user',
        content: `${proposalText}\n\nMake your ruling now.`,
      },
    ]

    try {
      const raw = await Promise.race([
        callModel(model, messages, { maxTokens: 120 }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
      ]) as string
      const { verdict, reason } = parseVerdict(raw)
      return { judge: judge.name, verdict, reason } as JudgeVerdict
    } catch {
      // On timeout or error, conservative default: REJECT
      return { judge: judge.name, verdict: 'REJECT' as const, reason: 'Judge timed out — defaulting to REJECT' }
    }
  })

  const rawVerdicts = await Promise.all(judgePromises)
  verdicts.push(...rawVerdicts)

  const approvals = verdicts.filter(v => v.verdict === 'APPROVE').length
  const approved = approvals >= requiredApprovals
  const outcome = approved ? 'APPROVED' : 'REJECTED'

  const entry: DebateEntry = {
    ts: Date.now(),
    proposalType: proposal.type,
    proposal,
    verdicts,
    outcome,
    threshold,
  }
  appendLog(dir, entry)

  const summary = verdicts.map(v => `${v.judge}: ${v.verdict}`).join(' | ')
  console.log(`[Triumvirate] ${outcome} (${approvals}/${JUDGES.length} approve, need ${requiredApprovals}) — ${summary}`)

  return { approved, verdicts, outcome }
}

// ── Log reader (for /api/autonomous/debates) ──────────────────

export function loadTriumvirateLog(dir: string): DebateEntry[] {
  try { return JSON.parse(fs.readFileSync(logFile(dir), 'utf8')) }
  catch { return [] }
}

// ── Pending proposal queue ─────────────────────────────────────
// Proposals that couldn't be reviewed (no models available, all judges
// timed out) are saved here and retried on the next improvement pass.
// Auto-clean: entries expire after PENDING_TTL_MS or after MAX_RETRIES.

const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
const MAX_PENDING_RETRIES = 5
const MAX_PENDING_QUEUE = 50

export interface PendingProposal {
  id: string           // stable key to avoid re-queueing the same proposal
  proposal: Proposal
  enqueuedAt: number
  retryCount: number
  lastError: string
}

function pendingFile(dir: string) { return path.join(dir, '.crucible', 'triumvirate-pending.json') }

export function loadPendingQueue(dir: string): PendingProposal[] {
  try { return JSON.parse(fs.readFileSync(pendingFile(dir), 'utf8')) }
  catch { return [] }
}

function savePendingQueue(dir: string, queue: PendingProposal[]): void {
  try {
    fs.mkdirSync(path.join(dir, '.crucible'), { recursive: true })
    fs.writeFileSync(pendingFile(dir), JSON.stringify(queue, null, 2))
  } catch {}
}

function proposalKey(proposal: Proposal): string {
  if (proposal.type === 'weight_change') {
    return `wc-${proposal.after.similarity}-${proposal.after.functional}-${proposal.after.novelty}`
  }
  return `kp-${proposal.id}`
}

export function enqueuePending(dir: string, proposal: Proposal, error: string): void {
  const queue = loadPendingQueue(dir)
  const key = proposalKey(proposal)

  // Don't re-enqueue if already in queue
  if (queue.some(e => e.id === key)) return

  // Cap queue size — drop oldest if full
  while (queue.length >= MAX_PENDING_QUEUE) queue.pop()

  queue.unshift({ id: key, proposal, enqueuedAt: Date.now(), retryCount: 0, lastError: error })
  savePendingQueue(dir, queue)
  console.log(`[Triumvirate] Queued pending proposal "${key}" for retry (${queue.length} in queue)`)
}

// Returns proposals ready for retry and removes expired/exhausted entries.
// Increments retryCount for each returned entry before saving.
export function drainPendingQueue(dir: string): PendingProposal[] {
  const now = Date.now()
  let queue = loadPendingQueue(dir)

  // Clean expired and exhausted entries
  const before = queue.length
  queue = queue.filter(e =>
    (now - e.enqueuedAt) < PENDING_TTL_MS &&
    e.retryCount < MAX_PENDING_RETRIES
  )
  if (queue.length < before) {
    console.log(`[Triumvirate] Cleaned ${before - queue.length} expired/exhausted pending proposals`)
  }

  if (queue.length === 0) {
    savePendingQueue(dir, queue)
    return []
  }

  // Increment retry counts and save before returning
  const toRetry = queue.map(e => ({ ...e, retryCount: e.retryCount + 1 }))
  savePendingQueue(dir, toRetry)
  return toRetry
}

// ── Meta-learning (Gap 4) ──────────────────────────────────────────────────────
// The triumvirate tracks outcomes of its own past decisions and adjusts its
// effective thresholds when it detects systematic miscalibration:
//   - If approved proposals consistently precede quality decline → tighten
//   - If reject rate > 85% AND quality is flat/down → relax
//   - If approve rate > 90% AND quality is up → status quo is working, hold
//
// "Getting better at getting better."
//
// State persisted to .crucible/triumvirate-meta.json.

interface MetaOutcome {
  ts: number
  approvedCount: number
  rejectedCount: number
  qualityBefore: number  // recentAvg at decision time
  qualityAfter: number   // recentAvg N queries later (filled in retrospectively)
}

interface MetaState {
  outcomes: MetaOutcome[]
  // Effective multipliers applied to required approval counts (1.0 = baseline)
  weightChangeMultiplier: number   // default 1.0 → unanimous (3/3)
  knowledgePatternMultiplier: number // default 1.0 → majority (2/3)
  lastAdjusted: number
  adjustmentLog: Array<{ ts: number; action: string; reason: string }>
}

const META_FILE_NAME = 'triumvirate-meta.json'
const META_MAX_OUTCOMES = 100
const META_MIN_OUTCOMES = 8   // need at least this many before adjusting
const META_ADJUST_COOLDOWN = 3 * 60 * 60 * 1000  // 3 hours between adjustments

function metaFile(dir: string) { return path.join(dir, '.crucible', META_FILE_NAME) }

function loadMeta(dir: string): MetaState {
  try { return JSON.parse(fs.readFileSync(metaFile(dir), 'utf8')) }
  catch {
    return {
      outcomes: [],
      weightChangeMultiplier: 1.0,
      knowledgePatternMultiplier: 1.0,
      lastAdjusted: 0,
      adjustmentLog: [],
    }
  }
}

function saveMeta(dir: string, state: MetaState): void {
  try { fs.writeFileSync(metaFile(dir), JSON.stringify(state, null, 2), 'utf8') } catch {}
}

/**
 * Record a new batch of decisions with the current quality snapshot.
 * Call this after each autoImprove pass with the quality averages before/after.
 */
export function recordTriumvirateOutcome(
  dir: string,
  approved: number,
  rejected: number,
  qualityBefore: number,
  qualityAfter: number
): void {
  const state = loadMeta(dir)
  state.outcomes.push({ ts: Date.now(), approvedCount: approved, rejectedCount: rejected, qualityBefore, qualityAfter })
  if (state.outcomes.length > META_MAX_OUTCOMES) state.outcomes = state.outcomes.slice(-META_MAX_OUTCOMES)
  saveMeta(dir, state)
}

/**
 * Analyze recent outcomes and adjust thresholds if clearly miscalibrated.
 * Returns a human-readable description of any adjustment made.
 */
export function runMetaLearning(dir: string): string | null {
  const state = loadMeta(dir)
  const now = Date.now()
  if (state.outcomes.length < META_MIN_OUTCOMES) return null
  if (now - state.lastAdjusted < META_ADJUST_COOLDOWN) return null

  const recent = state.outcomes.slice(-20)

  // Compute avg quality delta for rounds with approvals vs rounds with only rejections
  const withApprovals = recent.filter(o => o.approvedCount > 0)
  const withoutApprovals = recent.filter(o => o.approvedCount === 0 && o.rejectedCount > 0)

  const avgDelta = (outcomes: MetaOutcome[]) =>
    outcomes.length === 0 ? null
      : outcomes.reduce((s, o) => s + (o.qualityAfter - o.qualityBefore), 0) / outcomes.length

  const approvalDelta = avgDelta(withApprovals)
  const rejectionDelta = avgDelta(withoutApprovals)

  // Compute overall reject rate
  const totalApproved = recent.reduce((s, o) => s + o.approvedCount, 0)
  const totalRejected = recent.reduce((s, o) => s + o.rejectedCount, 0)
  const totalDecisions = totalApproved + totalRejected
  const rejectRate = totalDecisions > 0 ? totalRejected / totalDecisions : 0

  // Compute quality trend
  const recentAvg = recent.slice(-5).reduce((s, o) => s + o.qualityAfter, 0) / Math.min(5, recent.length)
  const priorAvg = recent.slice(0, 5).reduce((s, o) => s + o.qualityAfter, 0) / Math.min(5, recent.length)
  const trend = recentAvg - priorAvg

  let action: string | null = null
  let reason: string | null = null

  // Case 1: approvals correlate with quality DECLINE → tighten
  if (approvalDelta !== null && approvalDelta < -0.03 && withApprovals.length >= 4) {
    if (state.weightChangeMultiplier < 1.2) {
      state.weightChangeMultiplier = Math.min(state.weightChangeMultiplier + 0.1, 1.2)
      action = `tightened weight_change threshold (multiplier → ${state.weightChangeMultiplier.toFixed(2)})`
      reason = `Approved proposals preceded avg quality drop of ${(approvalDelta * 100).toFixed(1)} pts over ${withApprovals.length} rounds.`
    }
  }

  // Case 2: near-total rejection AND quality is still flat/down → too conservative, relax
  if (!action && rejectRate > 0.85 && trend < 0.01 && totalDecisions >= 10) {
    if (state.knowledgePatternMultiplier > 0.8) {
      state.knowledgePatternMultiplier = Math.max(state.knowledgePatternMultiplier - 0.1, 0.8)
      action = `relaxed knowledge_pattern threshold (multiplier → ${state.knowledgePatternMultiplier.toFixed(2)})`
      reason = `${(rejectRate * 100).toFixed(0)}% reject rate with quality trend ${trend > 0 ? '+' : ''}${(trend * 100).toFixed(1)} pts — may be blocking real improvements.`
    }
  }

  // Case 3: quality trending up AND approve rate reasonable → hold, restore defaults if drifted
  if (!action && trend > 0.03 && rejectRate < 0.7 && rejectRate > 0.1) {
    if (state.weightChangeMultiplier !== 1.0 || state.knowledgePatternMultiplier !== 1.0) {
      state.weightChangeMultiplier = Math.min(state.weightChangeMultiplier + 0.05, 1.0)
      state.knowledgePatternMultiplier = Math.min(state.knowledgePatternMultiplier + 0.05, 1.0)
      action = `restored thresholds toward baseline (wc=${state.weightChangeMultiplier.toFixed(2)}, kp=${state.knowledgePatternMultiplier.toFixed(2)})`
      reason = `Quality trending up ${(trend * 100).toFixed(1)} pts with healthy approve/reject balance — thresholds working, relaxing any prior tightening.`
    }
  }

  if (!action) return null

  state.lastAdjusted = now
  state.adjustmentLog = [
    ...state.adjustmentLog,
    { ts: now, action, reason: reason! },
  ].slice(-50)
  saveMeta(dir, state)

  console.log(`[TriumvirateMeta] ${action} — ${reason}`)
  return `${action}: ${reason}`
}

/** Effective required-approval counts after meta-learning multipliers. */
export function effectiveThresholds(dir: string): { weightChange: number; knowledgePattern: number } {
  const state = loadMeta(dir)
  return {
    weightChange: Math.round(3 * state.weightChangeMultiplier),
    knowledgePattern: Math.round(2 * state.knowledgePatternMultiplier),
  }
}

/** Full meta-learning state for /api/autonomous/meta endpoint. */
export function metaLearningStatus(dir: string): MetaState & { effectiveThresholds: ReturnType<typeof effectiveThresholds> } {
  return { ...loadMeta(dir), effectiveThresholds: effectiveThresholds(dir) }
}
