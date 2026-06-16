// Roster rotation (Track C1) — automatically benches models with low contribution
// rates and promotes newly-discovered models to fill the gap.
// Runs after every 200 completed queries. Uses response genealogy (contributionRates
// in history.json) as the signal — a model that never survives into synthesis
// gets no rotation benefit even if its Stage 1 score was high.

import fs from 'fs'
import path from 'path'

export interface RosterEntry {
  modelId: string
  label: string
  status: 'active' | 'benched' | 'probation'
  benchedAt?: number
  reprobeAt?: number
  avgContribution: number  // EMA of contributionRates over last N rounds
  windowSize: number       // how many rounds this EMA covers
  promotedAt?: number
}

const rosterFile = (dir: string) => path.join(dir, '.crucible', 'roster.json')
const BENCH_THRESHOLD = 0.03     // contribution rate below this → bench candidate
const WINDOW = 200               // rounds per evaluation window
const REPROBATION_MS = 7 * 24 * 60 * 60 * 1000  // 7 days before re-probing benched models

export function loadRoster(dir: string): RosterEntry[] {
  try { return JSON.parse(fs.readFileSync(rosterFile(dir), 'utf8')) } catch { return [] }
}

export function saveRoster(dir: string, roster: RosterEntry[]) {
  fs.mkdirSync(path.dirname(rosterFile(dir)), { recursive: true })
  fs.writeFileSync(rosterFile(dir), JSON.stringify(roster, null, 2))
}

export function getBenchedIds(dir: string): Set<string> {
  return new Set(loadRoster(dir).filter(r => r.status === 'benched').map(r => r.modelId))
}

function updateEMA(current: number, newVal: number, alpha = 0.15): number {
  return current * (1 - alpha) + newVal * alpha
}

// Update roster from a completed pipeline round's contribution data.
export function recordRoundContributions(
  dir: string,
  contributionRates: Record<string, number>,  // modelId → fraction (0–1)
  allModelIds: string[],
  allLabels: Record<string, string>
): void {
  const roster = loadRoster(dir)
  const rosterMap = new Map(roster.map(r => [r.modelId, r]))

  for (const id of allModelIds) {
    const contrib = contributionRates[id] ?? 0
    let entry = rosterMap.get(id)
    if (!entry) {
      entry = { modelId: id, label: allLabels[id] ?? id, status: 'active', avgContribution: contrib, windowSize: 1 }
      roster.push(entry)
      rosterMap.set(id, entry)
    } else {
      entry.avgContribution = updateEMA(entry.avgContribution, contrib)
      entry.windowSize = Math.min(entry.windowSize + 1, WINDOW)
    }
  }

  saveRoster(dir, roster)
}

// Evaluate roster and bench underperformers after WINDOW rounds.
// Returns list of newly benched model IDs.
export function evaluateRoster(
  dir: string,
  totalRounds: number,
  onBench?: (modelId: string, label: string, avgContrib: number) => void
): string[] {
  if (totalRounds % WINDOW !== 0) return []  // only run every WINDOW rounds

  const roster = loadRoster(dir)
  const newly_benched: string[] = []

  for (const entry of roster) {
    if (entry.status !== 'active') continue
    if (entry.windowSize < 20) continue  // not enough data
    if (entry.avgContribution < BENCH_THRESHOLD) {
      entry.status = 'benched'
      entry.benchedAt = Date.now()
      entry.reprobeAt = Date.now() + REPROBATION_MS
      newly_benched.push(entry.modelId)
      onBench?.(entry.modelId, entry.label, entry.avgContribution)
      console.log(`[Roster] Benched: ${entry.label} (avg contribution: ${(entry.avgContribution * 100).toFixed(1)}%)`)
    }
  }

  saveRoster(dir, roster)
  return newly_benched
}

// Check if any benched models are ready to be re-probed (7 days have passed).
export function getModelsReadyForReprobe(dir: string): RosterEntry[] {
  const now = Date.now()
  return loadRoster(dir).filter(r => r.status === 'benched' && r.reprobeAt && r.reprobeAt <= now)
}

// Promote a benched model back to active (called after a successful probe).
export function promoteFromBench(dir: string, modelId: string): void {
  const roster = loadRoster(dir)
  const entry = roster.find(r => r.modelId === modelId)
  if (entry) {
    entry.status = 'active'
    entry.promotedAt = Date.now()
    entry.benchedAt = undefined
    entry.reprobeAt = undefined
    entry.avgContribution = 0.05  // reset with a small positive prior
    saveRoster(dir, roster)
    console.log(`[Roster] Promoted back to active: ${entry.label}`)
  }
}
