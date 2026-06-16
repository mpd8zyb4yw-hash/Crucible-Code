// Cross-session contradiction detection — extends counterfactualBranch.ts
// with a session history index.
//
// Before each task, scans recent session summaries for claims that contradict
// the current prompt. If a contradiction is found above threshold, it is
// surfaced to the user before the pipeline proceeds.
// Contradiction events stored in decisionMemory.ts for future reference.
//
// Uses the same Jaccard + keyword approach as counterfactualBranch for
// consistency — no model calls needed for the scan itself.

import fs from 'fs'
import path from 'path'
import { recordDecision } from './decisionMemory'
import { debugBus } from './debug/bus'

export interface SessionSummary {
  sessionId: string
  timestamp: number
  summary: string          // compressed summary of what was concluded/decided
  keyFacts: string[]       // explicit factual claims from the session
  promptType?: string
}

export interface ContradictionEvent {
  id: string
  timestamp: number
  currentPrompt: string
  conflictingSummaryId: string
  conflictingFact: string
  score: number            // 0-1 contradiction strength
  surfaced: boolean        // whether user was notified
}

const CONTRADICTION_THRESHOLD = 0.65  // minimum score to surface

function sessionSummaryFile(projectDir?: string): string {
  const base = projectDir
    ? path.join(projectDir, '.crucible')
    : path.join(process.env.HOME ?? '~', '.crucible')
  return path.join(base, 'session-summaries.json')
}

function contradictionLogFile(projectDir?: string): string {
  const base = projectDir
    ? path.join(projectDir, '.crucible')
    : path.join(process.env.HOME ?? '~', '.crucible')
  return path.join(base, 'contradiction-log.json')
}

export function loadSessionSummaries(projectDir?: string): SessionSummary[] {
  try { return JSON.parse(fs.readFileSync(sessionSummaryFile(projectDir), 'utf8')) }
  catch { return [] }
}

export function saveSessionSummary(summary: SessionSummary, projectDir?: string) {
  const all = loadSessionSummaries(projectDir)
  all.push(summary)
  const f = sessionSummaryFile(projectDir)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(all.slice(-100), null, 2))
}

export function loadContradictionLog(projectDir?: string): ContradictionEvent[] {
  try { return JSON.parse(fs.readFileSync(contradictionLogFile(projectDir), 'utf8')) }
  catch { return [] }
}

function saveContradictionEvent(event: ContradictionEvent, projectDir?: string) {
  const all = loadContradictionLog(projectDir)
  all.push(event)
  const f = contradictionLogFile(projectDir)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(all.slice(-200), null, 2))
}

// Extract factual claims from text (simple heuristic: declarative sentences
// with specific values, negations, or definitive statements)
function extractFacts(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(s =>
      s.length > 20 &&
      /\b(is|are|was|were|has|have|does|do|will|cannot|never|always|must|the [A-Z])\b/.test(s) &&
      !/\b(maybe|possibly|might|could|perhaps|sometimes)\b/i.test(s)
    )
    .map(s => s.trim().slice(0, 150))
    .slice(0, 8)
}

// Score contradiction between a known fact and a new prompt.
// High score = they likely say opposite things about the same topic.
function scoreContradiction(knownFact: string, newPrompt: string): number {
  const factWords = new Set(
    knownFact.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  )
  const promptWords = new Set(
    newPrompt.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  )

  // Topic overlap — they must be talking about the same thing
  const overlap = [...factWords].filter(w => promptWords.has(w)).length
  const topicScore = overlap / Math.max(factWords.size, 1)

  if (topicScore < 0.3) return 0  // different topics, not a contradiction

  // Contradiction signals in the new prompt vs the known fact
  const factNegated = /\b(not|no|never|cannot|don't|doesn't|isn't|aren't|won't|shouldn't)\b/i.test(knownFact)
  const promptNegated = /\b(not|no|never|cannot|don't|doesn't|isn't|aren't|won't|shouldn't)\b/i.test(newPrompt)

  // Different polarity on same topic is a strong signal
  const polarityConflict = factNegated !== promptNegated ? 0.4 : 0

  // Different specific values/numbers
  const factNums = (knownFact.match(/\b\d+(?:\.\d+)?\b/g) ?? []).map(Number)
  const promptNums = (newPrompt.match(/\b\d+(?:\.\d+)?\b/g) ?? []).map(Number)
  const numConflict = factNums.length && promptNums.length &&
    factNums.some(fn => promptNums.some(pn => Math.abs(fn - pn) / Math.max(fn, pn, 1) > 0.2))
    ? 0.3 : 0

  const score = topicScore * 0.4 + polarityConflict + numConflict
  return Math.min(1.0, score)
}

// Main entry: scan recent session summaries for contradictions with current prompt.
// Returns contradictions above threshold, surfaced for user review.
export function scanForContradictions(
  currentPrompt: string,
  projectDir?: string,
  requestId?: string,
): ContradictionEvent[] {
  const summaries = loadSessionSummaries(projectDir)
  const recent = summaries.slice(-20)  // scan last 20 sessions

  const found: ContradictionEvent[] = []

  for (const session of recent) {
    const factsToCheck = [
      ...session.keyFacts,
      ...extractFacts(session.summary),
    ]

    for (const fact of factsToCheck) {
      const score = scoreContradiction(fact, currentPrompt)
      if (score >= CONTRADICTION_THRESHOLD) {
        const event: ContradictionEvent = {
          id: `cx_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          timestamp: Date.now(),
          currentPrompt: currentPrompt.slice(0, 200),
          conflictingSummaryId: session.sessionId,
          conflictingFact: fact,
          score,
          surfaced: true,
        }
        found.push(event)
        saveContradictionEvent(event, projectDir)

        // Store in decision memory for future reference
        recordDecision({
          context: `Cross-session contradiction detected (score ${score.toFixed(2)})`,
          choice: `Surfaced conflict: current prompt vs. session ${session.sessionId}`,
          alternatives: [fact, currentPrompt.slice(0, 80)],
          outcome: 'unknown',
          tags: ['contradiction', 'cross_session'],
        })

        debugBus.emit('pipeline', 'cross_session_contradiction', {
          score,
          conflictingSessionId: session.sessionId,
          conflictingFact: fact.slice(0, 100),
          requestId,
        }, { severity: 'warn', requestId })
      }
    }
  }

  return found
}

// Build a user-facing warning string for surfacing contradictions
export function buildContradictionWarning(events: ContradictionEvent[]): string {
  if (!events.length) return ''
  const lines: string[] = [
    `[Note: the following may conflict with conclusions from a prior session]`,
  ]
  for (const e of events.slice(0, 3)) {
    lines.push(`  - Prior claim: "${e.conflictingFact.slice(0, 100)}" (confidence ${(e.score * 100).toFixed(0)}%)`)
  }
  lines.push(`Review the above before proceeding if accuracy is important.`)
  return lines.join('\n')
}

// Record session conclusions for future contradiction scanning
export function recordSessionConclusions(
  sessionId: string,
  summary: string,
  promptType?: string,
  projectDir?: string,
) {
  const keyFacts = extractFacts(summary)
  saveSessionSummary({
    sessionId,
    timestamp: Date.now(),
    summary: summary.slice(0, 600),
    keyFacts,
    promptType,
  }, projectDir)
}
