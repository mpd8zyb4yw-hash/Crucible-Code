// Escalation router for the optional local-model pool: picks the cheapest downloaded
// model first, scores its answer, and escalates to a stronger downloaded model (then to
// Track S / the existing triumvirate+critic gates) when confidence is low. This is
// separate from src/CrucibleEngine/router/capabilityRouter.ts, which is a parked,
// unrelated design for synth/fm/retrieve/abstain classification — do not merge the two.

import { LOCAL_MODEL_CATALOG, type LocalModelSpec } from './localModelCatalog'
import { modelStatus } from './modelDownloadManager'
import { callLocalModel } from './localModelPool'

const TIER_ORDER: LocalModelSpec['tier'][] = ['fast', 'balanced', 'quality']

export interface RoutedAnswer {
  text: string
  modelId: string
  modelLabel: string
  tier: LocalModelSpec['tier']
  confidence: number
  escalations: Array<{ modelId: string; confidence: number; reason: string }>
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

function downloadedModelsByTier(): Map<LocalModelSpec['tier'], LocalModelSpec[]> {
  const map = new Map<LocalModelSpec['tier'], LocalModelSpec[]>()
  for (const spec of LOCAL_MODEL_CATALOG) {
    if (modelStatus(spec.id).status !== 'ready') continue
    const list = map.get(spec.tier) ?? []
    list.push(spec)
    map.set(spec.tier, list)
  }
  return map
}

const ESCALATE_BELOW = 0.5

/**
 * Route a query through the downloaded local-model pool, cheapest tier first, escalating
 * to the next tier when the answer scores below ESCALATE_BELOW. Returns null if no models
 * are downloaded — callers should fall back to Track S / the existing pipeline.
 */
export async function routeLocalModelQuery(system: string, user: string): Promise<RoutedAnswer | null> {
  const byTier = downloadedModelsByTier()
  const escalations: RoutedAnswer['escalations'] = []

  for (const tier of TIER_ORDER) {
    const candidates = byTier.get(tier)
    if (!candidates?.length) continue
    const spec = candidates[0]

    const text = await callLocalModel(spec.id, system, user)
    const { score, reason } = scoreAnswer(text)
    escalations.push({ modelId: spec.id, confidence: score, reason })

    if (score >= ESCALATE_BELOW || tier === TIER_ORDER[TIER_ORDER.length - 1]) {
      return { text, modelId: spec.id, modelLabel: spec.label, tier, confidence: score, escalations }
    }
  }

  return null
}
