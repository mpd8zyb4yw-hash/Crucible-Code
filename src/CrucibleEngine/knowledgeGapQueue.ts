// J4 — Active knowledge gap filling.
// After each session, records what the system didn't know that it needed to.
// The improvement daemon picks up top-3 gaps each cycle and fires a Researcher
// agent to fill them, writing results back to the world model.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export interface KnowledgeGap {
  id: string
  topic: string
  reason: 'low_confidence' | 'model_disagreement' | 'quality_surprise' | 'unverified_claim'
  details: string
  severity: number   // 0-1 priority
  createdAt: number
  resolvedAt?: number
  resolutionSummary?: string
}

const GAPS_FILE = (dir: string) => path.join(dir, '.crucible', 'knowledge-gaps.json')
const MAX_GAPS = 100

function load(dir: string): KnowledgeGap[] {
  try { return JSON.parse(fs.readFileSync(GAPS_FILE(dir), 'utf8')) } catch { return [] }
}
function save(dir: string, gaps: KnowledgeGap[]) {
  fs.mkdirSync(path.dirname(GAPS_FILE(dir)), { recursive: true })
  fs.writeFileSync(GAPS_FILE(dir), JSON.stringify(gaps.slice(-MAX_GAPS), null, 2))
}

export function recordGap(dir: string, topic: string, reason: KnowledgeGap['reason'], details: string, severity = 0.5) {
  const gaps = load(dir)
  // Dedup by topic
  if (gaps.some(g => !g.resolvedAt && g.topic.toLowerCase() === topic.toLowerCase())) return
  const gap: KnowledgeGap = {
    id: `gap_${Date.now()}`,
    topic, reason, details, severity,
    createdAt: Date.now(),
  }
  gaps.push(gap)
  save(dir, gaps)
  debugBus.emit('pipeline', 'knowledge_gap_recorded', { topic, reason, severity }, { severity: 'info' })
}

export function resolveGap(dir: string, gapId: string, summary: string) {
  const gaps = load(dir)
  const gap = gaps.find(g => g.id === gapId)
  if (!gap) return
  gap.resolvedAt = Date.now()
  gap.resolutionSummary = summary
  save(dir, gaps)
}

// Returns top N unresolved gaps by severity
export function getTopGaps(dir: string, n = 3): KnowledgeGap[] {
  return load(dir)
    .filter(g => !g.resolvedAt)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, n)
}

// Called after each pipeline round — detect gaps from calibration + quality signals
export function detectGapsFromRound(
  dir: string,
  query: string,
  overallCalibrationScore: number,
  modelScoreVariance: number,   // max - min score across models
  predictedScore: number,
  actualScore: number,
) {
  if (overallCalibrationScore < 0.45) {
    recordGap(dir, query.slice(0, 80), 'low_confidence',
      `Calibration score ${overallCalibrationScore.toFixed(2)} — system was uncertain about this topic`,
      1 - overallCalibrationScore)
  }
  if (modelScoreVariance > 0.35) {
    recordGap(dir, query.slice(0, 80), 'model_disagreement',
      `Model score variance ${modelScoreVariance.toFixed(2)} — ensemble strongly disagreed on this topic`,
      modelScoreVariance * 0.8)
  }
  if (predictedScore > 0.75 && actualScore < 0.5) {
    recordGap(dir, query.slice(0, 80), 'quality_surprise',
      `Predicted ${predictedScore.toFixed(2)} but got ${actualScore.toFixed(2)} — quality predictor was wrong`,
      (predictedScore - actualScore) * 0.7)
  }
}

export function listGaps(dir: string): KnowledgeGap[] {
  return load(dir)
}
