// Per-model telemetry for the local-model pool (Track D). Read-only consumer of the
// existing router in src/CrucibleEngine/agent/localModelRouter.ts — records outcomes the
// router already computes (latency, confidence, whether a model's answer won) so the
// router can eventually learn from real win-rate instead of static tier ordering.
// Persisted as a flat JSON file next to the models config; fails open (corrupt/missing
// file never blocks a query — stats just reset).

import fs from 'fs'
import path from 'path'

function statsPath(): string {
  const dir = path.join(process.cwd(), '.crucible')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'local-model-telemetry.json')
}

export interface ModelStat {
  modelId: string
  calls: number
  wins: number
  errors: number
  totalLatencyMs: number
  lastLatencyMs: number
  lastConfidence: number
}

type StatsFile = Record<string, ModelStat>

function load(): StatsFile {
  try {
    return JSON.parse(fs.readFileSync(statsPath(), 'utf8'))
  } catch {
    return {}
  }
}

function save(stats: StatsFile): void {
  try {
    fs.writeFileSync(statsPath(), JSON.stringify(stats, null, 2))
  } catch {
    // best-effort; telemetry is never allowed to break a query
  }
}

function blank(modelId: string): ModelStat {
  return { modelId, calls: 0, wins: 0, errors: 0, totalLatencyMs: 0, lastLatencyMs: 0, lastConfidence: 0 }
}

/** Record one candidate call's outcome. `won` = this candidate's answer was the one returned. */
export function recordOutcome(opts: {
  modelId: string
  latencyMs: number
  confidence: number
  won: boolean
  errored: boolean
}): void {
  const stats = load()
  const s = stats[opts.modelId] ?? blank(opts.modelId)
  s.calls += 1
  if (opts.won) s.wins += 1
  if (opts.errored) s.errors += 1
  s.totalLatencyMs += opts.latencyMs
  s.lastLatencyMs = opts.latencyMs
  s.lastConfidence = opts.confidence
  stats[opts.modelId] = s
  save(stats)
}

/** Mark that this model's answer was the one returned to the user — does not count as a
 *  separate call; call recordOutcome() for the call/latency first, then markWin() once the
 *  winner among candidates is known. */
export function markWin(modelId: string): void {
  const stats = load()
  const s = stats[modelId] ?? blank(modelId)
  s.wins += 1
  stats[modelId] = s
  save(stats)
}

export interface ModelStatSummary extends ModelStat {
  avgLatencyMs: number
  winRate: number
}

export function getStats(): ModelStatSummary[] {
  const stats = load()
  return Object.values(stats)
    .map(s => ({
      ...s,
      avgLatencyMs: s.calls ? Math.round(s.totalLatencyMs / s.calls) : 0,
      winRate: s.calls ? s.wins / s.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls)
}

export function resetStats(): void {
  save({})
}
