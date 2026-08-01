// Specialization forcing (Track C2) — when a model has demonstrated a very
// high EMA score on a specific prompt type (avgContrib > EMA_FORCE threshold),
// it is guaranteed a slot in Stage 1 for that type regardless of normal
// selectModels rotation. This ensures our strongest specialist always fires.

import type { PromptType } from './stageWeightLearner'
// The only property this module reads off a model is `id`, so it is stated STRUCTURALLY rather
// than imported. The old `import type { DynamicModel } from '../types'` never resolved (there is no
// `src/types` — the interface lives in `src/chat/core.tsx`), so this file has been silently
// `any`-typed since it was written; and importing a UI module into the engine would invert the
// layering to buy nothing. Generic in the caller's model type so `applyForcedSlots` returns
// exactly what it was handed instead of widening it.

// getSpecializationWeights is injected at call time to avoid circular dep with modelRegistry
type WeightsFn = (pt: PromptType) => Record<string, number>

export const FORCE_THRESHOLD = 0.78   // EMA score above this → forced slot
export const MAX_FORCED = 2           // at most 2 forced slots per round
export const FORCE_RECENCY_WINDOW = 50 // forced model must have been called in last N pipeline runs

// Rolling call counter — incremented by server on every pipeline run
let pipelineRunCount = 0
const modelLastForcedAt: Record<string, number> = {}

export function recordPipelineRun() { pipelineRunCount++ }
export function recordForcedCall(modelId: string) { modelLastForcedAt[modelId] = pipelineRunCount }

export interface ForcedSlot {
  modelId: string
  promptType: PromptType
  emaScore: number
}

// Given the current prompt type and the full model registry, return up to
// MAX_FORCED model IDs that should be guaranteed a Stage 1 slot.
export function getForcedModels(
  promptType: PromptType,
  registry: readonly { id: string }[],
  getSpecializationWeights?: WeightsFn
): ForcedSlot[] {
  if (!getSpecializationWeights) return []
  const forced: ForcedSlot[] = []

  for (const model of registry) {
    const weights = getSpecializationWeights(promptType)
    const ema = weights[model.id]
    if (ema !== undefined && ema >= FORCE_THRESHOLD) {
      // Decay check: if this model hasn't been called in the last FORCE_RECENCY_WINDOW
      // pipeline runs, skip forcing — let fresh competitors in
      const lastAt = modelLastForcedAt[model.id] ?? 0
      const staleness = pipelineRunCount - lastAt
      if (staleness > FORCE_RECENCY_WINDOW) {
        console.log(`[Forcing] ${model.id} EMA=${ema.toFixed(2)} but stale (${staleness} runs) — skipping forced slot`)
        continue
      }
      forced.push({ modelId: model.id, promptType, emaScore: ema })
    }
    if (forced.length >= MAX_FORCED) break
  }

  // Sort by EMA descending so we take the top performers
  return forced.sort((a, b) => b.emaScore - a.emaScore).slice(0, MAX_FORCED)
}

// Merge forced models into a selected model list — add any forced IDs that
// aren't already present, displacing the lowest-priority tail if needed.
export function applyForcedSlots<T extends { id: string }>(
  selected: readonly T[],
  forced: ForcedSlot[],
  registry: readonly T[]
): T[] {
  const out = [...selected]
  const presentIds = new Set(out.map(m => m.id))

  for (const slot of forced) {
    if (presentIds.has(slot.modelId)) continue  // already selected
    const model = registry.find(m => m.id === slot.modelId)
    if (!model) continue
    if (out.length < 6) {
      out.push(model)
    } else {
      // Displace last slot
      out[out.length - 1] = model
    }
    presentIds.add(slot.modelId)
  }

  return out
}
