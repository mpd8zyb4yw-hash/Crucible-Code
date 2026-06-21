// Track C — LIVING CORPUS · retrieval surface
// Semantic search over the living corpus, with relationship-graph expansion and
// performance-feedback logging. Superseded chunks are returned only on request
// and always labelled. Every retrieval is logged so gap detection + retention
// scoring have real signal to learn from.

import { embed, cosineSimilarity } from '../masterpiece/corpus/embed.js'
import {
  getActiveChunks, getCorpusDb, queryShards, updateRetrieval, logRetrieval, getRelationshipsFor,
  type IngestedChunk,
} from './db.js'

// Decode a raw chunks-table row (incl. embedding BLOB) into an IngestedChunk.
// Shared by the sharded read path; mirrors db.ts rowToChunk exactly.
function decodeRow(r: any): IngestedChunk {
  return {
    id: r.id, content: r.content,
    embedding: r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : undefined,
    domain: r.domain, source: r.source, sourceReliability: r.source_reliability, stalenessClass: r.staleness_class,
    ingestedAt: r.ingested_at, confidence: r.confidence, retrievalCount: r.retrieval_count, retrievalValue: r.retrieval_value,
    uniquenessScore: r.uniqueness_score, confirmationCount: r.confirmation_count ?? 0, status: r.status,
    supersededBy: r.superseded_by, archiveReason: r.archive_reason,
  }
}

// Gather the candidate active (and optionally superseded) chunk pool. When
// `domains` is given, only those shards are opened and queried, then MERGED into a
// single de-duplicated pool; otherwise the canonical meta DB (= all chunks) is used,
// preserving the pre-sharding behaviour exactly.
function gatherPool(domains: string[] | undefined, includeSuperseded: boolean): IngestedChunk[] {
  if (!domains) {
    let pool = getActiveChunks().filter(c => c.embedding)
    if (includeSuperseded) {
      const sup = getCorpusDb().prepare(`SELECT * FROM chunks WHERE status = 'superseded'`).all() as any[]
      for (const r of sup) { const c = decodeRow(r); if (c.embedding) pool.push(c) }
    }
    return pool
  }
  // Sharded path: open just the routed shards and merge their rows (de-dup by id).
  const statusClause = includeSuperseded ? `status IN ('active','superseded')` : `status = 'active'`
  const seen = new Set<string>()
  const pool: IngestedChunk[] = []
  for (const shard of queryShards(domains)) {
    const rows = shard.prepare(`SELECT * FROM chunks WHERE ${statusClause}`).all() as any[]
    for (const r of rows) {
      if (seen.has(r.id)) continue
      const c = decodeRow(r)
      if (!c.embedding) continue
      seen.add(r.id)
      pool.push(c)
    }
  }
  return pool
}

export interface CorpusHit {
  chunk: IngestedChunk
  similarity: number
  superseded: boolean
}

export async function queryLivingCorpus(
  queryText: string,
  opts: { topK?: number; domains?: string[]; domainFilter?: string; excludeDomains?: string[]; includeSuperseded?: boolean; minSimilarity?: number } = {},
): Promise<CorpusHit[]> {
  const { topK = 5, domains, domainFilter, excludeDomains, includeSuperseded = false, minSimilarity = 0.1 } = opts

  // `domains` (Phase 2.1) restricts retrieval to specific shards, queried+merged in
  // parallel. Omitted → query all chunks via the canonical meta DB (unchanged path).
  let pool: IngestedChunk[] = gatherPool(domains, includeSuperseded)
  if (domainFilter) pool = pool.filter(c => c.domain === domainFilter)
  if (excludeDomains) pool = pool.filter(c => !excludeDomains.includes(c.domain))
  if (pool.length === 0) return []

  const qv = await embed(queryText)
  const scored: CorpusHit[] = []
  for (const c of pool) {
    if (c.embedding!.length !== qv.length) continue
    const sim = cosineSimilarity(qv, c.embedding!)
    if (sim < minSimilarity) continue
    scored.push({ chunk: c, similarity: sim, superseded: c.status === 'superseded' })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, topK)
}

// Helper that fetches a single chunk (incl. non-active) with embedding decoded.
function getActiveChunksById(id: string): IngestedChunk | null {
  const r = getCorpusDb().prepare(`SELECT * FROM chunks WHERE id = ?`).get(id) as any
  if (!r) return null
  return {
    id: r.id, content: r.content,
    embedding: r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : undefined,
    domain: r.domain, source: r.source, sourceReliability: r.source_reliability, stalenessClass: r.staleness_class,
    ingestedAt: r.ingested_at, confidence: r.confidence, retrievalCount: r.retrieval_count, retrievalValue: r.retrieval_value,
    uniquenessScore: r.uniqueness_score, confirmationCount: r.confirmation_count ?? 0, status: r.status,
    supersededBy: r.superseded_by, archiveReason: r.archive_reason,
  }
}

// Expand a hit set by one hop along the relationship graph — pulls in chunks
// that the hits depend-on / enable / analogize, etc. Used by MASTERPIECE for
// cross-domain reasoning.
export function expandByRelationships(hits: CorpusHit[], maxExtra = 5): IngestedChunk[] {
  const seen = new Set(hits.map(h => h.chunk.id))
  const extra: IngestedChunk[] = []
  for (const h of hits) {
    for (const edge of getRelationshipsFor(h.chunk.id)) {
      const otherId = edge.fromChunkId === h.chunk.id ? edge.toChunkId : edge.fromChunkId
      if (seen.has(otherId)) continue
      const c = getActiveChunksById(otherId)
      if (c && c.status === 'active') { extra.push(c); seen.add(otherId); if (extra.length >= maxExtra) return extra }
    }
  }
  return extra
}

// Record performance feedback after the pipeline finishes: which retrieved chunks
// contributed to a good outcome. Feeds retention scoring + gap detection.
export function recordRetrievalOutcome(
  hits: CorpusHit[],
  outcomeConfidence: number,
  queryContext: string,
  contributedIds: Set<string>,
): void {
  for (const h of hits) {
    const contributed = contributedIds.has(h.chunk.id)
    // retrievalValue gains more when the chunk actually contributed to a confident outcome.
    updateRetrieval(h.chunk.id, contributed ? 0.1 * Math.max(0, outcomeConfidence) : 0.01)
    logRetrieval({
      id: `rl_${h.chunk.id.slice(0, 12)}_${Date.now()}`,
      chunkId: h.chunk.id,
      queryContext: queryContext.slice(0, 200),
      outcomeConfidence,
      contributed,
    })
  }
}
