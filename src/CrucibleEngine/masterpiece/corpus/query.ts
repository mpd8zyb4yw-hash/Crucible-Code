// MASTERPIECE corpus — semantic similarity queries
// Embeds the query text, then computes cosine similarity against all stored chunks.
// Returns the top-k results sorted by similarity score.

import { embed, cosineSimilarity, embeddingDim } from './embed.js'
import { stmts } from './db.js'
import type { CorpusChunk } from '../types.js'

export interface QueryResult {
  chunk: CorpusChunk
  similarity: number
}

// Find the top-k corpus chunks most similar to `queryText`.
// If `domainFilter` is provided, only chunks from that domain are considered.
// If `excludeDomains` is provided, those domains are excluded (for cross-domain search).
export async function queryCorpus(
  queryText: string,
  opts: {
    topK?: number
    domainFilter?: string
    excludeDomains?: string[]
    minSimilarity?: number
  } = {},
): Promise<QueryResult[]> {
  const { topK = 5, domainFilter, excludeDomains, minSimilarity = 0.1 } = opts
  const s = stmts()

  const rows: Array<{
    id: number
    doc_id: number
    content: string
    domain: string
    confidence: number
    embedding: Buffer | null
    ingested_at: number
  }> = domainFilter
    ? (s.getChunksByDomain.all(domainFilter) as typeof rows)
    : (s.getAllChunks.all() as typeof rows)

  if (rows.length === 0) return []

  const queryVec = await embed(queryText)
  const dim = embeddingDim()

  const scored: QueryResult[] = []
  for (const row of rows) {
    if (excludeDomains?.includes(row.domain)) continue
    if (!row.embedding || row.embedding.byteLength < dim * 4) continue

    const storedVec = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      Math.min(row.embedding.byteLength / 4, queryVec.length),
    )

    // If stored dimension differs from current embed dim (ONNX vs hash fallback mismatch),
    // skip rather than produce garbage similarity scores.
    if (storedVec.length !== queryVec.length) continue

    const similarity = cosineSimilarity(queryVec, storedVec)
    if (similarity < minSimilarity) continue

    scored.push({
      chunk: {
        id: row.id,
        docId: row.doc_id,
        content: row.content,
        domain: row.domain,
        confidence: row.confidence,
        ingestedAt: row.ingested_at,
      },
      similarity,
    })
  }

  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, topK)
}

// Find cross-domain matches for a shard — explicitly exclude the shard's own domain
// so abductive connections are genuinely cross-domain.
export async function queryCrossCorpus(
  shardContent: string,
  shardDomain: string,
  topK = 3,
): Promise<QueryResult[]> {
  return queryCorpus(shardContent, {
    topK,
    excludeDomains: [shardDomain],
    minSimilarity: 0.15,
  })
}
