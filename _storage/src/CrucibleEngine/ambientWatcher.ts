// Track M — M3: Proactive contextual engagement
// Watches session topic history and world model for surface-worthy signals.
// Fires a proactive suggestion only when cosine similarity > RELEVANCE_GATE.

import fs from 'fs'
import path from 'path'
import { buildGraphDigest, findEntities } from './entityGraph'
import { debugBus } from './debug/bus'

const RELEVANCE_GATE = 0.62   // min similarity to fire
const MAX_PROACTIVE_PER_SESSION = 3  // don't be annoying
const COOLDOWN_MS = 45_000    // min ms between proactive fires

interface SessionTopicState {
  recentTopics: string[]       // last 8 vectorized query tokens
  firedCount: number
  lastFiredAt: number
}

// In-memory per-request-stream state; keyed by session id (we use requestId prefix)
const sessionState = new Map<string, SessionTopicState>()

// Lightweight 16-dim hash projection (same family as uncertaintySurface.ts)
function hashProject(text: string, dims = 16): number[] {
  const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, '')
  const words = lower.split(/\s+/).filter(Boolean)
  const vec = new Array(dims).fill(0)
  for (const word of words) {
    let h = 5381
    for (let i = 0; i < word.length; i++) h = ((h << 5) + h) ^ word.charCodeAt(i)
    h = Math.abs(h)
    for (let d = 0; d < dims; d++) {
      const seed = h ^ (d * 2654435761)
      vec[d] += (seed % 3) - 1  // -1, 0, or 1
    }
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map(v => v / mag)
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// Pull interesting facts from the world model that the session hasn't explicitly queried.
async function findSurfaceWorthy(dir: string, topicVec: number[]): Promise<{ text: string; sim: number } | null> {
  const digest = await buildGraphDigest('', 1200)
  if (!digest || digest.length < 50) return null

  // Score each entity by similarity to session topics
  const entities = digest.split('\n').filter(l => l.startsWith('•'))
  let best: { text: string; sim: number } | null = null

  for (const line of entities) {
    const sim = cosineSim(topicVec, hashProject(line))
    if (sim > RELEVANCE_GATE && (!best || sim > best.sim)) {
      best = { text: line.replace(/^•\s*/, '').trim(), sim }
    }
  }
  return best
}

export interface ProactiveSuggestion {
  type: 'proactive_suggestion'
  text: string
  confidence: number
  reason: string
}

// Call after each round completes. Returns a suggestion to surface, or null.
export async function checkAmbientContext(
  dir: string,
  sessionId: string,
  query: string,
  requestId: string
): Promise<ProactiveSuggestion | null> {
  let state = sessionState.get(sessionId)
  if (!state) {
    state = { recentTopics: [], firedCount: 0, lastFiredAt: 0 }
    sessionState.set(sessionId, state)
  }

  // Cooldown + cap checks
  const now = Date.now()
  if (state.firedCount >= MAX_PROACTIVE_PER_SESSION) return null
  if (now - state.lastFiredAt < COOLDOWN_MS) return null

  // Accumulate topic tokens from query
  const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
  state.recentTopics = [...state.recentTopics, ...tokens].slice(-40)

  if (state.recentTopics.length < 6) return null  // need enough context

  const topicVec = hashProject(state.recentTopics.join(' '))
  const found = await findSurfaceWorthy(dir, topicVec)
  if (!found) return null

  // Don't surface something the user just asked about (high overlap = they know it)
  const queryVec = hashProject(query)
  const overlapWithQuery = cosineSim(queryVec, hashProject(found.text))
  if (overlapWithQuery > 0.80) return null  // too close to their explicit question

  state.firedCount++
  state.lastFiredAt = now
  sessionState.set(sessionId, state)

  debugBus.emit('pipeline', 'proactive_suggestion_fired', { requestId, sim: found.sim, sessionId }, { severity: 'info', requestId })

  return {
    type: 'proactive_suggestion',
    text: `Worth noting: ${found.text}`,
    confidence: Math.round(found.sim * 100) / 100,
    reason: 'ambient_context_match',
  }
}

// Clear state when a session ends or is reset
export function clearAmbientState(sessionId: string): void {
  sessionState.delete(sessionId)
}
