// Decision memory with outcome tracking (Track D2) — stores decisions made
// during agent/pipeline sessions (e.g., "chose model X for task Y", "used
// strategy Z"), tracks whether they led to good outcomes, and surfaces the
// most relevant precedent when a similar decision comes up again.

import fs from 'fs'
import path from 'path'

export type OutcomeLabel = 'success' | 'failure' | 'mixed' | 'unknown'

export interface Decision {
  id: string
  ts: number
  context: string        // brief description of the situation
  choice: string         // what was chosen / decided
  alternatives: string[] // other options that were considered
  outcome?: OutcomeLabel
  outcomeNote?: string
  score?: number         // quality score at the time (0-1)
  promptType?: string
  tags: string[]
}

function decisionsFile(): string {
  return path.join(process.env.HOME ?? '~', '.crucible', 'decisions.json')
}

export function loadDecisions(): Decision[] {
  try { return JSON.parse(fs.readFileSync(decisionsFile(), 'utf8')) } catch { return [] }
}

export function saveDecisions(decisions: Decision[]) {
  const f = decisionsFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(decisions.slice(-300), null, 2))
}

export function recordDecision(props: Omit<Decision, 'id' | 'ts'>): Decision {
  const d: Decision = { id: `d_${Date.now()}`, ts: Date.now(), ...props }
  const all = loadDecisions()
  all.push(d)
  saveDecisions(all)
  return d
}

export function updateOutcome(id: string, outcome: OutcomeLabel, note?: string, score?: number) {
  const all = loadDecisions()
  const d = all.find(d => d.id === id)
  if (d) { d.outcome = outcome; d.outcomeNote = note; if (score !== undefined) d.score = score }
  saveDecisions(all)
}

// Find decisions whose context overlaps the current situation
export function recallDecisions(context: string, limit = 5): Decision[] {
  const words = context.toLowerCase().split(/\s+/).filter(w => w.length > 4)
  const all = loadDecisions()
  const scored = all
    .filter(d => d.outcome !== 'unknown')
    .map(d => {
      const text = (d.context + ' ' + d.tags.join(' ')).toLowerCase()
      const hits = words.filter(w => text.includes(w)).length
      return { d, hits }
    })
    .filter(x => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.d.ts - a.d.ts)
  return scored.slice(0, limit).map(x => x.d)
}

// Build a decision precedent string for agent context injection
export function buildDecisionContext(currentContext: string, maxChars = 800): string {
  const precedents = recallDecisions(currentContext)
  const successful = precedents.filter(d => d.outcome === 'success')
  const failed = precedents.filter(d => d.outcome === 'failure')

  if (!successful.length && !failed.length) return ''

  const lines: string[] = ['Decision precedents:']
  for (const d of successful.slice(0, 3)) lines.push(`+ Success: ${d.choice} (${d.context.slice(0, 60)})`)
  for (const d of failed.slice(0, 2)) lines.push(`- Avoid: ${d.choice} (${d.outcomeNote ?? d.context.slice(0, 60)})`)

  return lines.join('\n').slice(0, maxChars)
}
