// MASTERPIECE — Epistemic Reinforcement Weight System
// Tracks reasoning paths (domain→domain, abductive/structural) across runs.
// Paths that survive dialectical challenge repeatedly gain weight.
// Weight decays with a 30-day half-life so stale paths don't dominate.
// Called by the orchestrator after each successful MASTERPIECE run.

import { randomUUID } from 'crypto'
import { stmts } from './corpus/db.js'
import type {
  ReasoningPath,
  CalibrationRecord,
  AbductiveConnection,
  StructuralResonance,
  LightConnection,
  AnchorId,
} from './types.js'

const DEFAULT_HALF_LIFE_DAYS = 30
const MS_PER_DAY = 86_400_000

// Exponential decay: weight decays by half every `halfLifeDays` days.
function applyDecay(weight: number, lastUsedAt: number, halfLifeDays: number): number {
  const daysSince = (Date.now() - lastUsedAt) / MS_PER_DAY
  return weight * Math.pow(0.5, daysSince / halfLifeDays)
}

function pathId(fromDomain: string, toDomain: string, pathType: 'abductive' | 'structural'): string {
  return `${pathType}:${fromDomain}→${toDomain}`
}

// Load an existing path from DB (after applying decay) or create a new one.
function loadOrCreate(
  fromDomain: string,
  toDomain: string,
  pathType: 'abductive' | 'structural',
  noveltyScore: number,
): ReasoningPath {
  const s = stmts()
  const existing = s.getReasoningPath.get(fromDomain, toDomain, pathType) as {
    id: string
    from_domain: string
    to_domain: string
    path_type: string
    weight: number
    novelty_score: number
    survived_count: number
    failed_count: number
    last_used_at: number
    decay_half_life_days: number
  } | undefined

  if (existing) {
    const decayed = applyDecay(existing.weight, existing.last_used_at, existing.decay_half_life_days)
    return {
      id: existing.id,
      fromDomain: existing.from_domain,
      toDomain: existing.to_domain,
      pathType: existing.path_type as 'abductive' | 'structural',
      weight: decayed,
      noveltyScore: existing.novelty_score,
      survivedCount: existing.survived_count,
      failedCount: existing.failed_count,
      lastUsedAt: existing.last_used_at,
      decayHalfLifeDays: existing.decay_half_life_days,
    }
  }

  return {
    id: pathId(fromDomain, toDomain, pathType),
    fromDomain,
    toDomain,
    pathType,
    weight: noveltyScore,
    noveltyScore,
    survivedCount: 0,
    failedCount: 0,
    lastUsedAt: Date.now(),
    decayHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  }
}

function persistPath(path: ReasoningPath): void {
  stmts().upsertReasoningPath.run(
    path.id,
    path.fromDomain,
    path.toDomain,
    path.pathType,
    path.weight,
    path.noveltyScore,
    path.survivedCount,
    path.failedCount,
    path.lastUsedAt,
    path.decayHalfLifeDays,
  )
}

// Called after a MASTERPIECE run completes. Updates all path weights based on
// which connections survived (survivedDialectic=true) and which were rejected.
export function recordCalibration(
  anchorId: AnchorId,
  connections: AbductiveConnection[],
  resonances: StructuralResonance[],
  finalConfidenceScore: number,
): CalibrationRecord {
  const s = stmts()
  const now = Date.now()
  const connectionIds: string[] = []
  const pathIds: string[] = []

  for (const conn of connections) {
    const path = loadOrCreate(conn.sourceDomain, conn.targetDomain, 'abductive', conn.noveltyScore)
    if (conn.survivedDialectic) {
      path.survivedCount++
      // Reinforce: survived paths grow in weight (bounded at 3.0)
      path.weight = Math.min(3.0, path.weight + 0.1 * path.noveltyScore)
    } else {
      path.failedCount++
      // Penalise: failed paths shrink
      path.weight = Math.max(0.01, path.weight - 0.05)
    }
    path.lastUsedAt = now
    persistPath(path)
    connectionIds.push(conn.id)
    pathIds.push(path.id)
  }

  for (const res of resonances) {
    const path = loadOrCreate(res.sourceDomain, res.resonantDomain, 'structural', res.mappingConfidence)
    path.survivedCount++
    path.weight = Math.min(3.0, path.weight + 0.08 * res.mappingConfidence)
    path.lastUsedAt = now
    persistPath(path)
    pathIds.push(path.id)
  }

  s.insertCalibration.run(
    anchorId,
    JSON.stringify(connectionIds),
    JSON.stringify(pathIds),
    finalConfidenceScore,
    now,
  )

  return {
    anchorId,
    connectionIds,
    pathIds,
    finalConfidenceScore,
    recordedAt: now,
  }
}

// Light-mode learning signal. Every prompt — even simple ones — exercises the
// reasoning paths it surfaces locally. This is a WEAK signal (no dialectical
// challenge happened), so the weight deltas are a fraction of recordCalibration's:
// genuinely novel local hits (noveltyScore ≥ 0.5) get a small reinforcement,
// everything else is recorded as merely "exercised" (lastUsedAt bumped, no boost).
// The whole point of always-on light mode is that the corpus keeps learning on
// every query, not just the complex ones that reach deep mode.
export function recordLightSignal(
  anchorId: AnchorId,
  connections: LightConnection[],
): void {
  if (connections.length === 0) return
  const now = Date.now()
  const pathIds: string[] = []

  for (const conn of connections) {
    const path = loadOrCreate(conn.sourceDomain, conn.targetDomain, 'abductive', conn.noveltyScore)
    if (conn.noveltyScore >= 0.5) {
      // A third of the dialectical-survival reinforcement — light signal is weaker.
      path.weight = Math.min(3.0, path.weight + 0.033 * conn.noveltyScore)
    }
    path.lastUsedAt = now
    persistPath(path)
    pathIds.push(path.id)
  }

  stmts().insertCalibration.run(
    anchorId,
    JSON.stringify([]),          // no challenged connection ids in light mode
    JSON.stringify(pathIds),
    0,                            // finalConfidenceScore N/A for light enrichment
    now,
  )
}

// Returns current path weights (decayed to now) for a domain pair.
// Used by the abductive engine to bias towards well-trodden connections.
export function getPathWeight(
  fromDomain: string,
  toDomain: string,
  pathType: 'abductive' | 'structural',
): number {
  const s = stmts()
  const row = s.getReasoningPath.get(fromDomain, toDomain, pathType) as {
    weight: number
    last_used_at: number
    decay_half_life_days: number
  } | undefined
  if (!row) return 0.5  // neutral prior for unseen paths
  return applyDecay(row.weight, row.last_used_at, row.decay_half_life_days)
}
