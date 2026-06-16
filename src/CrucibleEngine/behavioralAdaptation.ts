// Track O — Behavioral adaptation layer
// Compresses cross-session learning into behavioral priors injected into Stage 1.
// Not "here are your memories" — "here is how you have learned to approach this
// class of problem." Builds on episodicMemory.ts + preferenceModel.ts.

import { loadEpisodes } from './episodicMemory'
import { loadPreferenceWeights } from './preferenceModel'
import { debugBus } from './debug/bus'

// ── Behavioral prior schema ──────────────────────────────────────────────────
export interface BehavioralPrior {
  queryClass: string          // what type of query this applies to
  rule: string                // concise behavioral rule derived from history
  evidence: string            // one-sentence justification
  weight: number              // 0-1 confidence in this prior
}

// ── Derive behavioral priors from preference weights ─────────────────────────
// The preference model learns feature weights from thumbs up/down.
// We translate significant weight directions into human-readable priors.
const FEATURE_NAMES = [
  'length_short', 'length_medium', 'length_long',
  'has_structure', 'has_code', 'has_lists', 'has_citations',
  'tone_direct', 'tone_detailed', 'tone_hedged',
  'confidence_high', 'confidence_low',
]

function weightsToRules(weights: number[], sampleSize: number): BehavioralPrior[] {
  if (sampleSize < 5) return []  // not enough signal yet

  const priors: BehavioralPrior[] = []
  const threshold = 0.15

  for (let i = 0; i < weights.length && i < FEATURE_NAMES.length; i++) {
    const w = weights[i]
    if (Math.abs(w) < threshold) continue

    const liked = w > 0
    const name = FEATURE_NAMES[i]

    if (name === 'length_short' && liked) {
      priors.push({ queryClass: 'all', rule: 'Prefer concise answers over exhaustive ones', evidence: `User has upvoted short responses ${sampleSize}x`, weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'length_long' && liked) {
      priors.push({ queryClass: 'all', rule: 'Provide thorough, detailed responses', evidence: `User has upvoted detailed responses ${sampleSize}x`, weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'has_structure' && liked) {
      priors.push({ queryClass: 'all', rule: 'Use clear structure with headers or sections', evidence: 'User prefers structured output', weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'has_structure' && !liked) {
      priors.push({ queryClass: 'all', rule: 'Avoid heavy structural formatting; prefer prose', evidence: 'User downvotes heavily structured output', weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'tone_direct' && liked) {
      priors.push({ queryClass: 'all', rule: 'Get to the point immediately, no preamble', evidence: 'User consistently prefers direct tone', weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'tone_hedged' && !liked) {
      priors.push({ queryClass: 'all', rule: 'Minimize hedging language; state conclusions directly', evidence: 'User downvotes hedged/uncertain-sounding responses', weight: Math.min(Math.abs(w), 1) })
    } else if (name === 'has_code' && liked) {
      priors.push({ queryClass: 'technical', rule: 'Include concrete code examples when relevant', evidence: 'User consistently upvotes responses with code', weight: Math.min(Math.abs(w), 1) })
    }
  }

  return priors
}

// ── Derive priors from episodic memory ──────────────────────────────────────
// Look for patterns across recent successful/failed episodes
function episodesToPriors(query: string): BehavioralPrior[] {
  const episodes = loadEpisodes()
  if (episodes.length < 3) return []

  const recent = episodes.slice(-30)  // last 30 sessions
  const successRate = recent.filter(e => e.outcome === 'success').length / recent.length

  const priors: BehavioralPrior[] = []

  // If recent success rate is low, note that complex decomposition helped
  const complexEpisodes = recent.filter(e => e.goal.length > 100 && e.outcome === 'success')
  if (complexEpisodes.length >= 2) {
    priors.push({
      queryClass: 'complex',
      rule: 'Break complex multi-part questions into independent sub-answers before synthesizing',
      evidence: `${complexEpisodes.length} successful sessions used decomposition on long queries`,
      weight: Math.min(complexEpisodes.length / 5, 0.9),
    })
  }

  // If there are failed episodes with common patterns, warn
  const failedEpisodes = recent.filter(e => e.outcome === 'failed')
  if (failedEpisodes.length >= 2) {
    priors.push({
      queryClass: 'all',
      rule: 'Flag uncertainty early rather than overcommitting to a specific answer',
      evidence: `${failedEpisodes.length} recent sessions rated as failed`,
      weight: 0.5,
    })
  }

  return priors
}

// ── Public API ────────────────────────────────────────────────────────────────
export interface AdaptationContext {
  priors: BehavioralPrior[]
  injectionBlock: string      // ready to prepend to Stage 1 system prompt
}

export function buildAdaptationContext(dir: string, query: string, requestId?: string): AdaptationContext {
  try {
    const { weights, sampleSize } = loadPreferenceWeights(dir)
    const weightPriors = weightsToRules(weights, sampleSize)
    const episodePriors = episodesToPriors(query)
    const priors = [...weightPriors, ...episodePriors]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5)  // top 5 most confident priors

    if (priors.length === 0) return { priors: [], injectionBlock: '' }

    const lines = priors.map(p => `- ${p.rule}`)
    const injectionBlock = `[Behavioral priors from ${sampleSize} feedback sessions]\n${lines.join('\n')}\n`

    if (requestId) {
      debugBus.emit('pipeline', 'behavioral_priors_injected', { count: priors.length, sampleSize, requestId }, { severity: 'info', requestId })
    }

    return { priors, injectionBlock }
  } catch {
    return { priors: [], injectionBlock: '' }
  }
}
