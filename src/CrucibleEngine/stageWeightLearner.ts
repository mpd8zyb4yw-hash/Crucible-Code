// Stage weight learner (Track B3) — tracks, per prompt type, which pipeline
// stages reliably lift the composite score vs. the Stage 1 baseline.
// Stores running EMA of per-stage delta scores in .crucible/stage-weights.json
// so server.ts can boost or suppress stages for specific query categories.

import fs from 'fs'
import path from 'path'

export type PromptType = 'coding' | 'reasoning' | 'creative' | 'factual' | 'math' | 'general'
export type StageKey = 'stage1' | 'stage3_critique' | 'stage4_revise' | 'stage5_synthesis' | 'stage5b_polish'

export interface StageWeight {
  stage: StageKey
  promptType: PromptType
  avgDelta: number    // EMA of (stageScore - stage1Baseline)
  sampleSize: number
  confidence: number  // 0-1, grows with sampleSize
}

export interface StageWeightsFile {
  weights: StageWeight[]
  lastUpdated: number
}

const weightsFile = (dir: string) => path.join(dir, '.crucible', 'stage-weights.json')
const EMA_ALPHA = 0.15
const CONFIDENCE_SATURATION = 50  // sampleSize at which confidence reaches ~0.9

export function loadStageWeights(dir: string): StageWeight[] {
  try {
    const f: StageWeightsFile = JSON.parse(fs.readFileSync(weightsFile(dir), 'utf8'))
    return f.weights
  } catch { return [] }
}

export function saveStageWeights(dir: string, weights: StageWeight[]) {
  fs.mkdirSync(path.dirname(weightsFile(dir)), { recursive: true })
  const f: StageWeightsFile = { weights, lastUpdated: Date.now() }
  fs.writeFileSync(weightsFile(dir), JSON.stringify(f, null, 2))
}

// Record a completed pipeline round's per-stage scores.
// stageScores: map of stage key → composite score at that stage exit
// stage1Baseline: the average Stage 1 score (before critique/synthesis)
export function recordRound(
  dir: string,
  promptType: PromptType,
  stageScores: Partial<Record<StageKey, number>>,
  stage1Baseline: number
): void {
  const weights = loadStageWeights(dir)
  const wMap = new Map(weights.map(w => [`${w.stage}:${w.promptType}`, w]))

  for (const [stage, score] of Object.entries(stageScores) as [StageKey, number][]) {
    if (stage === 'stage1') continue
    const delta = score - stage1Baseline
    const key = `${stage}:${promptType}`
    let entry = wMap.get(key)
    if (!entry) {
      entry = { stage, promptType, avgDelta: delta, sampleSize: 1, confidence: 0 }
      weights.push(entry)
      wMap.set(key, entry)
    } else {
      entry.avgDelta = entry.avgDelta * (1 - EMA_ALPHA) + delta * EMA_ALPHA
      entry.sampleSize += 1
    }
    entry.confidence = Math.min(0.95, 1 - Math.exp(-entry.sampleSize / CONFIDENCE_SATURATION))
  }

  saveStageWeights(dir, weights)
}

// Get stage multipliers for a given prompt type.
// Returns a map of stage → weight multiplier (>1 = boost, <1 = suppress).
// High positive delta + high confidence → boost. Negative delta → suppress.
export function getStageMultipliers(dir: string, promptType: PromptType): Record<StageKey, number> {
  const weights = loadStageWeights(dir)
  const relevant = weights.filter(w => w.promptType === promptType && w.confidence > 0.3)
  const multipliers: Record<StageKey, number> = {
    stage1: 1.0,
    stage3_critique: 1.0,
    stage4_revise: 1.0,
    stage5_synthesis: 1.0,
    stage5b_polish: 1.0,
  }
  for (const w of relevant) {
    // Map delta range [-0.3, +0.3] → multiplier [0.7, 1.3], scaled by confidence
    const raw = 1.0 + (w.avgDelta * w.confidence * 1.5)
    multipliers[w.stage] = Math.max(0.5, Math.min(1.5, raw))
  }
  return multipliers
}

// Summary for the debug API — shows which stages help/hurt per type
export function getStageWeightSummary(dir: string): Record<string, { stage: StageKey; avgDelta: number; confidence: number }[]> {
  const weights = loadStageWeights(dir)
  const out: Record<string, { stage: StageKey; avgDelta: number; confidence: number }[]> = {}
  for (const w of weights) {
    if (!out[w.promptType]) out[w.promptType] = []
    out[w.promptType].push({ stage: w.stage, avgDelta: w.avgDelta, confidence: w.confidence })
  }
  return out
}
