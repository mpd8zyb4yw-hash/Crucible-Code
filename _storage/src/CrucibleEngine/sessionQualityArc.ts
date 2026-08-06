// Session quality arc (Track G3) — monitors the quality of pipeline responses
// over the course of a single session. If scores are trending down (indicating
// context drift or model degradation), it injects a reorientation prompt and
// optionally suggests clearing agent context.

import fs from 'fs'
import path from 'path'

export interface SessionArc {
  sessionId: string
  startedAt: number
  scores: number[]           // rolling per-round composite scores
  trend: 'rising' | 'stable' | 'degrading'
  triggerCount: number       // how many times we've reoriented this session
  lastReorientAt?: number
}

const ARC_FILE_PREFIX = '.crucible/session-arc-'
const WINDOW = 5              // rounds to look back for trend
const DEGRADE_THRESHOLD = -0.08  // per-round average drop that triggers action
const MIN_ROUNDS = 3          // need at least this many rounds before acting

export function getArcFile(dir: string, sessionId: string): string {
  return path.join(dir, `${ARC_FILE_PREFIX}${sessionId}.json`)
}

export function loadArc(dir: string, sessionId: string): SessionArc {
  try { return JSON.parse(fs.readFileSync(getArcFile(dir, sessionId), 'utf8')) }
  catch { return { sessionId, startedAt: Date.now(), scores: [], trend: 'stable', triggerCount: 0 } }
}

export function saveArc(dir: string, arc: SessionArc) {
  fs.mkdirSync(path.join(dir, '.crucible'), { recursive: true })
  fs.writeFileSync(getArcFile(dir, arc.sessionId), JSON.stringify(arc, null, 2))
}

function computeTrend(scores: number[]): 'rising' | 'stable' | 'degrading' {
  if (scores.length < MIN_ROUNDS) return 'stable'
  const recent = scores.slice(-WINDOW)
  const diffs = recent.slice(1).map((s, i) => s - recent[i])
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length
  if (avgDiff < DEGRADE_THRESHOLD) return 'degrading'
  if (avgDiff > 0.04) return 'rising'
  return 'stable'
}

// Record a round score and check for quality arc signals.
// Returns an action recommendation if degradation is detected.
export function recordRoundScore(
  dir: string,
  sessionId: string,
  score: number
): { action: 'none' | 'reorient' | 'suggest_reset'; message?: string } {
  const arc = loadArc(dir, sessionId)
  arc.scores.push(score)
  if (arc.scores.length > 50) arc.scores = arc.scores.slice(-50)
  arc.trend = computeTrend(arc.scores)

  if (arc.trend !== 'degrading') {
    saveArc(dir, arc)
    return { action: 'none' }
  }

  const now = Date.now()
  const cooldown = 3 * 60 * 1000  // 3 min between reorientations

  if (arc.lastReorientAt && now - arc.lastReorientAt < cooldown) {
    saveArc(dir, arc)
    return { action: 'none' }
  }

  arc.triggerCount += 1
  arc.lastReorientAt = now

  // After 2 reorientations, escalate to suggest_reset
  if (arc.triggerCount >= 3) {
    saveArc(dir, arc)
    return {
      action: 'suggest_reset',
      message: 'Response quality has been declining across this session. Consider starting a new conversation to reset context.',
    }
  }

  saveArc(dir, arc)
  return {
    action: 'reorient',
    message: 'Note: my recent responses on this topic have been declining in quality. I am re-focusing on the core question.',
  }
}

// Clean up old session arc files (older than 24h)
export function pruneOldArcs(dir: string) {
  const arcDir = path.join(dir, '.crucible')
  try {
    const files = fs.readdirSync(arcDir).filter(f => f.startsWith('session-arc-'))
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const f of files) {
      try {
        const arc: SessionArc = JSON.parse(fs.readFileSync(path.join(arcDir, f), 'utf8'))
        if (arc.startedAt < cutoff) fs.unlinkSync(path.join(arcDir, f))
      } catch {}
    }
  } catch {}
}

// Get current trend for a session (for the debug API)
export function getSessionTrend(dir: string, sessionId: string): { trend: string; scores: number[]; triggerCount: number } {
  const arc = loadArc(dir, sessionId)
  return { trend: arc.trend, scores: arc.scores.slice(-10), triggerCount: arc.triggerCount }
}
