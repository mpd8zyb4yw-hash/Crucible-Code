// Causal memory — directed graph of cause-effect relationships across sessions.
// Stores WHY things worked or failed, not just what happened. This is the
// layer above decisionMemory (what happened) and entityGraph (what exists):
// causalMemory records the connective tissue between events.
//
// Integrates with entityGraph.ts and decisionMemory.ts.
// Persisted to ~/.crucible/causal-memory.json

import fs from 'fs'
import path from 'path'
import { findEntities } from './entityGraph'
import { recallDecisions } from './decisionMemory'

export interface CausalNode {
  id: string
  event: string          // what happened (brief label)
  outcome: string        // the result/consequence
  confidence: number     // 0-1: how sure we are about this cause-effect
  sessionId: string
  timestamp: number
  tags: string[]
}

export interface CausalEdge {
  id: string
  cause: string          // CausalNode id that is the cause
  effect: string         // CausalNode id that is the effect
  strength: number       // 0-1: how strong/reliable the causal link is
  observedCount: number  // times this edge was reinforced
}

export interface CausalGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
  version: number
}

function causalFile(): string {
  return path.join(process.env.HOME ?? '~', '.crucible', 'causal-memory.json')
}

export function loadCausalGraph(): CausalGraph {
  try { return JSON.parse(fs.readFileSync(causalFile(), 'utf8')) }
  catch { return { nodes: [], edges: [], version: 0 } }
}

export function saveCausalGraph(g: CausalGraph) {
  const f = causalFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  // Cap at 1000 nodes; evict oldest low-confidence nodes first
  if (g.nodes.length > 1000) {
    g.nodes.sort((a, b) => a.confidence - b.confidence || a.timestamp - b.timestamp)
    const evicted = new Set(g.nodes.slice(0, g.nodes.length - 1000).map(n => n.id))
    g.nodes = g.nodes.slice(-1000)
    g.edges = g.edges.filter(e => !evicted.has(e.cause) && !evicted.has(e.effect))
  }
  g.version += 1
  fs.writeFileSync(f, JSON.stringify(g, null, 2))
}

export function addCausalNode(
  event: string,
  outcome: string,
  sessionId: string,
  confidence = 0.7,
  tags: string[] = [],
): CausalNode {
  const g = loadCausalGraph()
  const node: CausalNode = {
    id: `cn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event,
    outcome,
    confidence,
    sessionId,
    timestamp: Date.now(),
    tags,
  }
  g.nodes.push(node)
  saveCausalGraph(g)
  return node
}

// Link two nodes with a causal edge; reinforce if already exists
export function addCausalEdge(causeId: string, effectId: string, strength = 0.6): CausalEdge {
  const g = loadCausalGraph()
  const existing = g.edges.find(e => e.cause === causeId && e.effect === effectId)
  if (existing) {
    // Reinforce: EMA of strength, increment count
    existing.strength = existing.strength * 0.8 + strength * 0.2
    existing.observedCount += 1
    saveCausalGraph(g)
    return existing
  }
  const edge: CausalEdge = {
    id: `ce_${Date.now()}`,
    cause: causeId,
    effect: effectId,
    strength,
    observedCount: 1,
  }
  g.edges.push(edge)
  if (g.edges.length > 3000) g.edges = g.edges.slice(-3000)
  saveCausalGraph(g)
  return edge
}

// Token overlap scoring for relevance
function relevanceScore(node: CausalNode, tokens: string[]): number {
  const text = (node.event + ' ' + node.outcome + ' ' + node.tags.join(' ')).toLowerCase()
  return tokens.filter(t => text.includes(t)).length / Math.max(tokens.length, 1)
}

// Query the causal graph for chains relevant to the current context.
// Returns the most relevant causal chains before a task runs.
export function query(context: string, limit = 5): Array<{
  node: CausalNode
  causes: CausalNode[]
  effects: CausalNode[]
  score: number
}> {
  const tokens = context.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  const g = loadCausalGraph()
  const nodeMap = new Map(g.nodes.map(n => [n.id, n]))

  const scored = g.nodes.map(node => {
    const score = relevanceScore(node, tokens) * node.confidence
    return { node, score }
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)

  return scored.map(({ node, score }) => {
    const causes = g.edges
      .filter(e => e.effect === node.id)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 3)
      .map(e => nodeMap.get(e.cause))
      .filter(Boolean) as CausalNode[]

    const effects = g.edges
      .filter(e => e.cause === node.id)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 3)
      .map(e => nodeMap.get(e.effect))
      .filter(Boolean) as CausalNode[]

    return { node, causes, effects, score }
  })
}

// Build a digest string for injection into agent/synthesis context
export function buildCausalDigest(context: string, maxChars = 1000): string {
  const chains = query(context, 5)
  if (!chains.length) return ''

  const lines: string[] = ['Causal memory (why things worked/failed):']
  for (const { node, causes, effects } of chains) {
    lines.push(`[${(node.confidence * 100).toFixed(0)}%] ${node.event} → ${node.outcome}`)
    if (causes.length) lines.push(`  caused by: ${causes.map(c => c.event).join('; ')}`)
    if (effects.length) lines.push(`  led to: ${effects.map(e => e.event).join('; ')}`)
  }

  return lines.join('\n').slice(0, maxChars)
}

// Enrich a new causal node by linking to related entity graph entries
// and past decisions — integrating the three memory systems.
export function enrichAndRecord(
  event: string,
  outcome: string,
  sessionId: string,
  confidence = 0.7,
  tags: string[] = [],
): CausalNode {
  const node = addCausalNode(event, outcome, sessionId, confidence, tags)

  // Link to entity graph concepts mentioned in the event
  const entities = findEntities(event, undefined, 3)
  for (const entity of entities) {
    tags.push(entity.label)
  }

  // Link to past decisions with overlapping context
  const pastDecisions = recallDecisions(event, 2)
  const g = loadCausalGraph()
  for (const dec of pastDecisions) {
    // Find or create a node for the past decision's outcome
    const pastNode = g.nodes.find(n =>
      n.event.toLowerCase().includes(dec.choice.toLowerCase().slice(0, 20))
    )
    if (pastNode) {
      addCausalEdge(pastNode.id, node.id, dec.outcome === 'success' ? 0.7 : 0.4)
    }
  }

  return node
}
