// Structured entity graph (Track D1) — replaces the flat bullet-list global
// memory with a typed JSON graph of entities and relationships.
// Stored in ~/.crucible/entity-graph.json. The agent can add, update, and
// query nodes and edges through the tool registry.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export type EntityType = 'person' | 'project' | 'concept' | 'technology' | 'decision' | 'goal' | 'fact' | 'other'
export type RelationType = 'uses' | 'created_by' | 'depends_on' | 'related_to' | 'conflicts_with' | 'improves' | 'part_of' | 'causes'
// H3: confidence tier for world model facts
export type FactTier = 'PROVISIONAL' | 'HIGH'

export interface Entity {
  id: string
  type: EntityType
  label: string
  description: string
  tags: string[]
  createdAt: number
  updatedAt: number
  confidence: number  // 0-1, allows decay on stale facts
  // H3 triangulation
  factTier?: FactTier          // PROVISIONAL until ≥2 independent sources agree
  sourceCount?: number         // how many independent observations
  lastReviewedAt?: number      // for 10-query re-evaluation cadence
  queryCountSinceReview?: number
}

export interface Relationship {
  id: string
  fromId: string
  toId: string
  relation: RelationType
  note?: string
  createdAt: number
}

export interface EntityGraph {
  entities: Entity[]
  relationships: Relationship[]
  version: number
}

function graphFile(): string {
  return path.join(process.env.HOME ?? '~', '.crucible', 'entity-graph.json')
}

export function loadGraph(): EntityGraph {
  try { return JSON.parse(fs.readFileSync(graphFile(), 'utf8')) }
  catch { return { entities: [], relationships: [], version: 0 } }
}

export function saveGraph(g: EntityGraph) {
  const f = graphFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  g.version += 1
  fs.writeFileSync(f, JSON.stringify(g, null, 2))
}

export function upsertEntity(props: Omit<Entity, 'id' | 'createdAt' | 'updatedAt'>, source?: string): Entity {
  const g = loadGraph()
  const existing = g.entities.find(e => e.label.toLowerCase() === props.label.toLowerCase() && e.type === props.type)
  if (existing) {
    const prevTier = existing.factTier
    const prevSources = existing.sourceCount ?? 1
    // H3: each distinct write is a new independent observation; cap at 2 for tier purposes
    const newSourceCount = Math.min(prevSources + 1, 10)
    const newTier: FactTier = newSourceCount >= 2 ? 'HIGH' : 'PROVISIONAL'
    Object.assign(existing, { ...props, updatedAt: Date.now(), sourceCount: newSourceCount, factTier: newTier })
    saveGraph(g)
    if (prevTier === 'PROVISIONAL' && newTier === 'HIGH') {
      debugBus.emit('pipeline', 'entity_triangulated', { label: existing.label, type: existing.type, sourceCount: newSourceCount }, { severity: 'info' })
    }
    return existing
  }
  // First observation — always PROVISIONAL
  const entity: Entity = {
    id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    factTier: 'PROVISIONAL',
    sourceCount: 1,
    queryCountSinceReview: 0,
    ...props,
  }
  g.entities.push(entity)
  if (g.entities.length > 500) g.entities = g.entities.slice(-500)
  saveGraph(g)
  return entity
}

// H3: bump query counter on entities touched by a query; flag PROVISIONAL ones for re-evaluation at 10 queries
export function touchEntities(labels: string[]): string[] {
  if (!labels.length) return []
  const g = loadGraph()
  const flagged: string[] = []
  for (const e of g.entities) {
    if (!labels.some(l => e.label.toLowerCase().includes(l.toLowerCase()))) continue
    e.queryCountSinceReview = (e.queryCountSinceReview ?? 0) + 1
    if (e.factTier === 'PROVISIONAL' && (e.queryCountSinceReview ?? 0) >= 10) {
      e.queryCountSinceReview = 0
      e.lastReviewedAt = Date.now()
      flagged.push(e.label)
    }
  }
  if (flagged.length) saveGraph(g)
  return flagged
}

export function addRelationship(fromId: string, relation: RelationType, toId: string, note?: string): Relationship {
  const g = loadGraph()
  const existing = g.relationships.find(r => r.fromId === fromId && r.toId === toId && r.relation === relation)
  if (existing) { existing.note = note; saveGraph(g); return existing }
  const rel: Relationship = { id: `r_${Date.now()}`, fromId, toId, relation, note, createdAt: Date.now() }
  g.relationships.push(rel)
  if (g.relationships.length > 2000) g.relationships = g.relationships.slice(-2000)
  saveGraph(g)
  return rel
}

export function findEntities(query: string, type?: EntityType, limit = 10): Entity[] {
  const g = loadGraph()
  const q = query.toLowerCase()
  return g.entities
    .filter(e => (!type || e.type === type) && (e.label.toLowerCase().includes(q) || e.description.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q))))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
}

export function getNeighbors(entityId: string): { entity: Entity; relation: string; direction: 'out' | 'in' }[] {
  const g = loadGraph()
  const entityMap = new Map(g.entities.map(e => [e.id, e]))
  const out: { entity: Entity; relation: string; direction: 'out' | 'in' }[] = []
  for (const rel of g.relationships) {
    if (rel.fromId === entityId) {
      const target = entityMap.get(rel.toId)
      if (target) out.push({ entity: target, relation: rel.relation, direction: 'out' })
    } else if (rel.toId === entityId) {
      const source = entityMap.get(rel.fromId)
      if (source) out.push({ entity: source, relation: rel.relation, direction: 'in' })
    }
  }
  return out
}

// Build a short digest of the graph for injection into agent context
export function buildGraphDigest(query: string, maxChars = 1200): string {
  const relevant = findEntities(query, undefined, 8)
  if (!relevant.length) return ''

  const lines: string[] = ['Relevant knowledge graph:']
  for (const entity of relevant) {
    const tier = entity.factTier === 'PROVISIONAL' ? ' [PROVISIONAL]' : ''
    lines.push(`[${entity.type}${tier}] ${entity.label}: ${entity.description}`)
    const neighbors = getNeighbors(entity.id).slice(0, 3)
    for (const n of neighbors) {
      const arrow = n.direction === 'out' ? `→ ${n.relation} →` : `← ${n.relation} ←`
      lines.push(`  ${arrow} ${n.entity.label}`)
    }
  }

  return lines.join('\n').slice(0, maxChars)
}

// J2 — Temporal fact expiry: time-sensitive facts decay from VERIFIED → STALE
// TTLs inferred from entity type and description content
const TTL_MS: Record<string, number> = {
  version:  90  * 24 * 60 * 60 * 1000,   // "React 18" — 90 days
  price:    1   * 24 * 60 * 60 * 1000,   // prices — 1 day
  role:     180 * 24 * 60 * 60 * 1000,   // "CEO of X" — 180 days
  event:    7   * 24 * 60 * 60 * 1000,   // current events — 7 days
  default:  365 * 24 * 60 * 60 * 1000,   // preferences, stable facts — 1 year
}

function inferTtl(entity: Entity): number {
  const d = (entity.label + ' ' + entity.description).toLowerCase()
  if (/version|v\d+\.\d+|release/.test(d)) return TTL_MS.version
  if (/price|cost|\$|€|usd|eur/.test(d)) return TTL_MS.price
  if (/ceo|cto|director|president|minister|head of/.test(d)) return TTL_MS.role
  if (/current|latest|today|this week|this month/.test(d)) return TTL_MS.event
  return TTL_MS.default
}

// Run at session start — downgrades expired facts to confidence 0.3 (STALE signal)
export function expireStaleEntities(): { expired: number } {
  const g = loadGraph()
  let expired = 0
  const now = Date.now()
  for (const e of g.entities) {
    const ttl = inferTtl(e)
    const age = now - e.updatedAt
    if (age > ttl && e.confidence > 0.3) {
      e.confidence = 0.3  // STALE
      e.factTier = 'PROVISIONAL'
      expired++
    }
  }
  if (expired) saveGraph(g)
  return { expired }
}
