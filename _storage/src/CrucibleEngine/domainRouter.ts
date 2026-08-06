// Track N — N3: Domain-aware knowledge store routing
// Classifies queries into domain buckets, retrieves from the right store,
// injects relevant context into the pipeline before Stage 1.
//
// Domain stores extend Track J world model infrastructure.
// Routing is purely local (hash projection cosine sim) — no model call needed.

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

// ── Domain taxonomy ───────────────────────────────────────────────────────────
export type DomainId =
  | 'mathematics'
  | 'software_engineering'
  | 'natural_sciences'
  | 'social_sciences'
  | 'humanities'
  | 'medicine_health'
  | 'law_policy'
  | 'finance_economics'
  | 'general'

const DOMAIN_SEEDS: Record<DomainId, string[]> = {
  mathematics:         ['equation', 'theorem', 'proof', 'calculus', 'algebra', 'geometry', 'differential', 'integral', 'matrix', 'vector', 'probability', 'statistics', 'optimization', 'topology'],
  software_engineering:['code', 'function', 'algorithm', 'api', 'database', 'debug', 'typescript', 'python', 'javascript', 'class', 'runtime', 'async', 'deploy', 'architecture', 'compiler'],
  natural_sciences:    ['physics', 'chemistry', 'biology', 'evolution', 'quantum', 'molecule', 'reaction', 'experiment', 'hypothesis', 'species', 'ecosystem', 'climate', 'particle'],
  social_sciences:     ['psychology', 'sociology', 'behavior', 'cognition', 'culture', 'society', 'politics', 'election', 'policy', 'economics', 'anthropology', 'survey'],
  humanities:          ['history', 'literature', 'philosophy', 'ethics', 'religion', 'art', 'language', 'narrative', 'symbolism', 'myth', 'rhetoric', 'metaphysics'],
  medicine_health:     ['diagnosis', 'treatment', 'symptom', 'disease', 'drug', 'therapy', 'clinical', 'patient', 'anatomy', 'pharmacology', 'surgery', 'pandemic'],
  law_policy:          ['law', 'regulation', 'contract', 'rights', 'statute', 'court', 'legal', 'jurisdiction', 'compliance', 'liability', 'policy', 'legislation'],
  finance_economics:   ['stock', 'market', 'investment', 'portfolio', 'interest', 'inflation', 'gdp', 'asset', 'derivative', 'valuation', 'fiscal', 'monetary', 'banking'],
  general:             [],
}

// Lightweight 16-dim hash projection
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
      vec[d] += (seed % 3) - 1
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

// Pre-compute seed vectors once at module load
const SEED_VECS: Record<DomainId, number[]> = Object.fromEntries(
  (Object.entries(DOMAIN_SEEDS) as [DomainId, string[]][]).map(([d, seeds]) => [
    d, seeds.length ? hashProject(seeds.join(' ')) : new Array(16).fill(0),
  ])
) as Record<DomainId, number[]>

export function classifyDomain(query: string): { domain: DomainId; confidence: number } {
  const qv = hashProject(query)
  let best: DomainId = 'general'
  let bestSim = -Infinity
  for (const [d, sv] of Object.entries(SEED_VECS) as [DomainId, number[]][]) {
    if (d === 'general') continue
    const sim = cosineSim(qv, sv)
    if (sim > bestSim) { bestSim = sim; best = d }
  }
  // Threshold: if best similarity is too low, fall back to general
  if (bestSim < 0.15) return { domain: 'general', confidence: bestSim }
  return { domain: best, confidence: Math.round(bestSim * 100) / 100 }
}

// ── Domain knowledge stores ───────────────────────────────────────────────────
// Each store is a flat markdown file: .crucible/domain-stores/<domain>.md
// New knowledge is appended as bullet points (via ingestIntoDomainStore).

function storePath(dir: string, domain: DomainId): string {
  return path.join(dir, `.crucible/domain-stores/${domain}.md`)
}

export function readDomainStore(dir: string, domain: DomainId): string {
  try {
    return fs.readFileSync(storePath(dir, domain), 'utf8')
  } catch {
    return ''
  }
}

export function ingestIntoDomainStore(dir: string, domain: DomainId, text: string, source: string): void {
  if (!text || text.length < 20) return
  const p = storePath(dir, domain)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const entry = `\n- [${new Date().toISOString()}] (${source}) ${text.trim().replace(/\n/g, ' ').slice(0, 400)}`
  fs.appendFileSync(p, entry)
}

// ── Retrieval: get the most relevant snippets from a domain store ─────────────
const MAX_CONTEXT_CHARS = 600

export function retrieveFromDomain(dir: string, domain: DomainId, query: string): string {
  const store = readDomainStore(dir, domain)
  if (!store) return ''

  const qv = hashProject(query)
  const lines = store.split('\n').filter(l => l.startsWith('- '))
  if (lines.length === 0) return ''

  const scored = lines
    .map(l => ({ line: l, sim: cosineSim(qv, hashProject(l)) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5)

  const relevant = scored.filter(s => s.sim > 0.10).map(s => s.line).join('\n')
  return relevant.slice(0, MAX_CONTEXT_CHARS)
}

// ── Main entry point: classify + retrieve ────────────────────────────────────
export interface DomainContext {
  domain: DomainId
  confidence: number
  retrievedContext: string
}

export function getDomainContext(dir: string, query: string, requestId?: string): DomainContext {
  const { domain, confidence } = classifyDomain(query)
  const retrievedContext = retrieveFromDomain(dir, domain, query)

  if (retrievedContext) {
    debugBus.emit('pipeline', 'domain_context_retrieved', { domain, confidence, chars: retrievedContext.length, requestId: requestId ?? '' }, { severity: 'info', requestId: requestId ?? '' })
  }

  return { domain, confidence, retrievedContext }
}

export function getDomainStoreIndex(dir: string): Record<DomainId, { size: number; lines: number }> {
  const result: Partial<Record<DomainId, { size: number; lines: number }>> = {}
  for (const domain of Object.keys(DOMAIN_SEEDS) as DomainId[]) {
    const p = storePath(dir, domain)
    try {
      const content = fs.readFileSync(p, 'utf8')
      result[domain] = { size: content.length, lines: content.split('\n').filter(l => l.startsWith('- ')).length }
    } catch {
      result[domain] = { size: 0, lines: 0 }
    }
  }
  return result as Record<DomainId, { size: number; lines: number }>
}
