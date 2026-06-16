// MASTERPIECE ↔ Living Corpus bridge (C8)
// Routes MASTERPIECE corpus queries through the Living Corpus when it has
// sufficient content, falling back to the seed corpus when it doesn't.
// Also wires retrieval outcome feedback back into the Living Corpus so it
// learns which chunks actually contributed to good MASTERPIECE outputs.

import { queryLivingCorpus, expandByRelationships, recordRetrievalOutcome } from '../../corpus/query.js'
import { ingestDocument } from '../../corpus/ingest.js'
import { chunkCount } from '../../corpus/db.js'
import { queryCrossCorpus as querySeedCrossCorpus, queryCorpus as querySeedCorpus } from './query.js'
import type { CorpusChunk } from '../types.js'

// Minimum Living Corpus chunks before we route MASTERPIECE queries there.
// Below this threshold the seed corpus gives better coverage.
const LIVING_CORPUS_MIN_CHUNKS = 50

export interface BridgeQueryResult {
  chunk: CorpusChunk
  similarity: number
  source: 'living' | 'seed'
}

function isLivingCorpusReady(): boolean {
  try {
    return chunkCount('active') >= LIVING_CORPUS_MIN_CHUNKS
  } catch {
    return false
  }
}

// Cross-domain query — the primary MASTERPIECE use case.
// Excludes shardDomain so results are genuinely cross-domain.
// Prefers Living Corpus when ready; falls back to seed corpus.
export async function queryCrossCorpusBridge(
  shardContent: string,
  shardDomain: string,
  topK = 3,
): Promise<BridgeQueryResult[]> {
  if (isLivingCorpusReady()) {
    try {
      const hits = await queryLivingCorpus(shardContent, {
        topK: topK + 2, // fetch extra so relationship expansion has room
        excludeDomains: [shardDomain],
        minSimilarity: 0.12,
      })
      if (hits.length === 0) throw new Error('no results')

      // One-hop relationship expansion — pulls in chunks that analogize/enable
      // the direct hits, giving MASTERPIECE richer cross-domain context.
      const expanded = expandByRelationships(hits, 3)
      const expandedAsHits = expanded
        .filter(c => c.domain !== shardDomain)
        .map(c => ({ chunk: c, similarity: 0.18, superseded: false })) // modest sim for expanded

      const combined = [...hits, ...expandedAsHits]
        .slice(0, topK)

      return combined.map(h => ({
        chunk: {
          id: h.chunk.id as unknown as number,
          docId: 0,
          content: h.chunk.content,
          domain: h.chunk.domain,
          confidence: h.chunk.confidence,
          ingestedAt: new Date(h.chunk.ingestedAt).getTime(),
        },
        similarity: h.similarity,
        source: 'living' as const,
      }))
    } catch {
      // Fall through to seed corpus
    }
  }

  // Seed corpus fallback
  const seedResults = await querySeedCrossCorpus(shardContent, shardDomain, topK)
  return seedResults.map(r => ({ ...r, source: 'seed' as const }))
}

// General corpus query (same domain allowed) — used by light mode.
export async function queryCorpusBridge(
  queryText: string,
  opts: {
    topK?: number
    domainFilter?: string
    excludeDomains?: string[]
    minSimilarity?: number
  } = {},
): Promise<BridgeQueryResult[]> {
  if (isLivingCorpusReady()) {
    try {
      const hits = await queryLivingCorpus(queryText, {
        topK: opts.topK ?? 5,
        domainFilter: opts.domainFilter,
        excludeDomains: opts.excludeDomains,
        minSimilarity: opts.minSimilarity ?? 0.1,
      })
      if (hits.length === 0) throw new Error('no results')
      return hits.map(h => ({
        chunk: {
          id: h.chunk.id as unknown as number,
          docId: 0,
          content: h.chunk.content,
          domain: h.chunk.domain,
          confidence: h.chunk.confidence,
          ingestedAt: new Date(h.chunk.ingestedAt).getTime(),
        },
        similarity: h.similarity,
        source: 'living' as const,
      }))
    } catch {
      // Fall through to seed corpus
    }
  }

  const seedResults = await querySeedCorpus(queryText, opts)
  return seedResults.map(r => ({ ...r, source: 'seed' as const }))
}

// Record which Living Corpus chunks contributed to a MASTERPIECE output.
// Called after the assembler completes with the final confidence score.
// No-op when seed corpus was used (seed corpus has no feedback mechanism).
export function recordMasterpieceOutcome(
  retrievedChunkIds: string[],
  survivedChunkIds: string[],
  finalConfidence: number,
  queryContext: string,
): void {
  if (!isLivingCorpusReady()) return
  try {
    // Build fake hits array for recordRetrievalOutcome signature
    const hits = retrievedChunkIds.map(id => ({
      chunk: { id } as any,
      similarity: 0.5,
      superseded: false,
    }))
    const contributedSet = new Set(survivedChunkIds)
    recordRetrievalOutcome(hits, finalConfidence, queryContext, contributedSet)
  } catch {
    // Feedback is best-effort
  }
}

// P15 — Abductive connection persistence.
// Survived connections represent genuine cross-domain insights: a model found a
// structural bridge between two domains, and an adversarial challenger failed to
// refute it. These are corpus-quality insights, so we write them back into the
// Living Corpus so they can surface for future queries without re-generating them.
// Only high-novelty survivors (> 0.65) are persisted to avoid polluting the corpus
// with marginal connections.
export async function persistSurvivedConnections(
  connections: Array<{
    survivedDialectic: boolean
    noveltyScore: number
    sourceDomain: string
    targetDomain: string
    bridgeReasoning: string
    structuralMirror: string
    fragileAssumption: string
  }>,
): Promise<number> {
  const candidates = connections.filter(c => c.survivedDialectic && c.noveltyScore > 0.65)
  if (candidates.length === 0) return 0

  let persisted = 0
  for (const conn of candidates) {
    const text = `Cross-domain insight (${conn.sourceDomain} → ${conn.targetDomain}):\n${conn.bridgeReasoning}\n\nStructural mirror: ${conn.structuralMirror}\n\nFragile assumption: ${conn.fragileAssumption}`
    try {
      const result = await ingestDocument({
        text,
        domain: conn.targetDomain,
        source: `masterpiece:abductive:${conn.sourceDomain}`,
        sourceReliability: Math.min(0.9, 0.6 + conn.noveltyScore * 0.3),
        stalenessClass: 'scientific',
      })
      persisted += result.ingested
    } catch { /* non-blocking */ }
  }
  return persisted
}

// Diagnostic: which corpus is currently active for MASTERPIECE queries
export function corpusStatus(): { active: 'living' | 'seed'; livingChunkCount: number; threshold: number } {
  let livingChunkCount = 0
  try { livingChunkCount = chunkCount('active') } catch {}
  return {
    active: livingChunkCount >= LIVING_CORPUS_MIN_CHUNKS ? 'living' : 'seed',
    livingChunkCount,
    threshold: LIVING_CORPUS_MIN_CHUNKS,
  }
}
