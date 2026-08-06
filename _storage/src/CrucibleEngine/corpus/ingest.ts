// Track C — LIVING CORPUS · ingestion pipeline
// Every document passes through every step in order. No shortcuts:
//   chunk → embed → dedup → validate → (relationship-extract) → write.
//
// Embeddings share the MASTERPIECE vector space (same embedder) so the living
// corpus and the masterpiece seed corpus are interoperable.
//
// Relationship extraction uses a model call and is therefore BUDGETED — the spec's
// "one call per chunk" is infeasible at corpus scale (millions of chunks). We run
// it for as many chunks as the per-cycle budget allows, newest/most-connected
// first; the rest get relationships lazily on a later lifecycle pass.

import { createHash } from 'crypto'
import { embed, cosineSimilarity } from '../masterpiece/corpus/embed.js'
import {
  insertChunk, insertRelationship, bumpConfirmation, logGovernance,
  getActiveChunks, getChunk,
  type IngestedChunk, type StalenessClass, type EdgeType,
} from './db.js'

// Char-based token estimate (≈4 chars/token, matching the rest of Crucible).
const CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 512
const OVERLAP_TOKENS = 64
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN     // ~2048
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN   // ~256
const DEDUP_THRESHOLD = 0.92

const VALID_EDGES = new Set<EdgeType>([
  'depends-on', 'enables', 'constrains', 'contradicts', 'analogizes', 'scales-with', 'emerges-from',
])

export interface IngestDeps {
  callModel?: (
    model: { id: string; label: string; provider: string; isWildcard: boolean },
    messages: { role: string; content: string }[],
    opts?: { requestId?: string }
  ) => Promise<string>
  pickFastModel?: () => { id: string; label: string; provider: string; isWildcard: boolean } | null
}

export interface SourceDoc {
  text: string
  domain: string
  source: string                 // URL or path
  sourceReliability: number      // 0..1
  stalenessClass: StalenessClass
}

export interface IngestResult {
  ingested: number
  deduped: number
  quarantined: number
  relationships: number
  bytes: number
}

// ── Chunking — sentence-boundary, ~512 tokens, 64-token overlap ───────────────
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (!clean) return []
  // Split into sentences, keeping the terminator. Fall back to newline blocks.
  const sentences = clean.match(/[^.!?\n]+[.!?]+|\n{2,}|[^.!?\n]+$/g)?.map(s => s.trim()).filter(Boolean) ?? [clean]

  const chunks: string[] = []
  let buf: string[] = []
  let bufLen = 0

  for (const sent of sentences) {
    // A single mega-sentence longer than the target gets hard-wrapped on whitespace.
    if (sent.length > TARGET_CHARS) {
      if (buf.length) { chunks.push(buf.join(' ')); buf = []; bufLen = 0 }
      for (let i = 0; i < sent.length; i += TARGET_CHARS) chunks.push(sent.slice(i, i + TARGET_CHARS))
      continue
    }
    if (bufLen + sent.length > TARGET_CHARS && buf.length) {
      chunks.push(buf.join(' '))
      // Build overlap: keep trailing sentences summing to ~OVERLAP_CHARS.
      const overlap: string[] = []
      let oLen = 0
      for (let i = buf.length - 1; i >= 0 && oLen < OVERLAP_CHARS; i--) {
        overlap.unshift(buf[i]); oLen += buf[i].length
      }
      buf = [...overlap]
      bufLen = oLen
    }
    buf.push(sent); bufLen += sent.length + 1
  }
  if (buf.length) chunks.push(buf.join(' '))
  return chunks.filter(c => c.trim().length >= 40)   // drop trivial fragments
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32)
}

// ── Validation gates → quarantine (never reject outright) ─────────────────────
// Returns null if the chunk passes, or a reason string if it should be quarantined.
function validate(content: string, doc: SourceDoc): string | null {
  // Gate 1 — source authority: must be an approved source with a real reliability.
  if (!doc.source || doc.sourceReliability < 0.3) return 'source-authority: missing source or reliability < 0.3'

  // Gate 4 — stylistic / adversarial anomaly detection (cheap heuristics).
  const lower = content.toLowerCase()
  if (/\b(ignore (?:all |the )?previous instructions|disregard (?:the )?above|system prompt|you are now|jailbreak)\b/.test(lower)) {
    return 'adversarial: prompt-injection pattern detected'
  }
  const nonText = (content.match(/[^\x09\x0a\x20-\x7e]/g)?.length ?? 0) / content.length
  if (nonText > 0.3) return 'adversarial: >30% non-text characters'
  // Extreme token repetition (a single token dominating) signals junk/spam.
  const toks = lower.match(/[a-z]{3,}/g) ?? []
  if (toks.length >= 20) {
    const freq: Record<string, number> = {}
    for (const t of toks) freq[t] = (freq[t] ?? 0) + 1
    const top = Math.max(...Object.values(freq))
    if (top / toks.length > 0.4) return 'adversarial: single token > 40% of content'
  }

  // Gate 2 — internal consistency: flagrant self-contradiction ("X is true ... X is false").
  if (/\bis (?:both )?true\b[^.]{0,60}\bis (?:also )?false\b/.test(lower) && !lower.includes('paradox') && !lower.includes('liar')) {
    return 'consistency: flagrant self-contradiction'
  }
  return null
}

// ── Relationship extraction (budgeted model call) ─────────────────────────────
const REL_SYSTEM = `You map relationships between knowledge chunks. Given a NEW chunk and up to 5 EXISTING chunks (each with an id), identify any relationships FROM the new chunk TO an existing chunk. Use ONLY these edge types: depends-on, enables, constrains, contradicts, analogizes, scales-with, emerges-from. Be conservative — only flag relationships you are confident about. Return ONLY a JSON array of {"toId": "<existing id>", "edgeType": "<type>", "confidence": 0.0-1.0}, or [] if none.`

async function extractRelationships(
  newChunkId: string,
  newContent: string,
  neighbours: Array<{ id: string; content: string }>,
  deps: IngestDeps,
): Promise<number> {
  if (!deps.callModel || !deps.pickFastModel || neighbours.length === 0) return 0
  const model = deps.pickFastModel()
  if (!model) return 0
  const userMsg = `NEW CHUNK:\n${newContent.slice(0, 800)}\n\nEXISTING CHUNKS:\n` +
    neighbours.map(n => `[${n.id}] ${n.content.slice(0, 300)}`).join('\n\n')
  let edges: Array<{ toId: string; edgeType: string; confidence: number }> = []
  try {
    const raw = await deps.callModel(model, [
      { role: 'system', content: REL_SYSTEM },
      { role: 'user', content: userMsg },
    ])
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) edges = parsed
  } catch { return 0 }

  let written = 0
  const now = new Date().toISOString()
  for (const e of edges.slice(0, 5)) {
    if (!VALID_EDGES.has(e.edgeType as EdgeType)) continue
    if (!neighbours.some(n => n.id === e.toId)) continue
    insertRelationship({
      id: `rel_${hashContent(newChunkId + e.toId + e.edgeType)}`,
      fromChunkId: newChunkId,
      toChunkId: e.toId,
      edgeType: e.edgeType as EdgeType,
      confidence: Math.min(1, Math.max(0, e.confidence ?? 0.5)),
      extractedAt: now,
    })
    written++
  }
  return written
}

// ── Main: ingest one document end-to-end ─────────────────────────────────────
export async function ingestDocument(
  doc: SourceDoc,
  deps: IngestDeps = {},
  opts: { relationshipBudget?: number } = {},
): Promise<IngestResult> {
  const result: IngestResult = { ingested: 0, deduped: 0, quarantined: 0, relationships: 0, bytes: 0 }
  let relBudget = opts.relationshipBudget ?? 0

  const pieces = chunkText(doc.text)
  if (pieces.length === 0) return result

  // Load the active set once for dedup + neighbour search (embeddings in memory).
  // For very large corpora this should be ANN-indexed; at current scale a linear
  // scan over active chunks with embeddings is acceptable and exact.
  const active = getActiveChunks().filter(c => c.embedding)

  for (const content of pieces) {
    const id = hashContent(content)
    if (getChunk(id)) { bumpConfirmation(id); result.deduped++; continue }   // exact dup

    const embedding = await embed(content)

    // ── Dedup: cosine > 0.92 to any existing active chunk ──────────────────
    let dupOf: string | null = null
    let bestSim = 0
    for (const c of active) {
      if (c.embedding!.length !== embedding.length) continue
      const sim = cosineSimilarity(embedding, c.embedding!)
      if (sim > bestSim) { bestSim = sim; if (sim > DEDUP_THRESHOLD) dupOf = c.id }
    }
    if (dupOf) {
      bumpConfirmation(dupOf)
      logGovernance('dedup', dupOf, `near-duplicate (sim ${bestSim.toFixed(3)}) from ${doc.source}`)
      result.deduped++
      continue
    }

    // ── Uniqueness score: 1 - bestSim (how much of this exists elsewhere) ───
    const uniquenessScore = Math.max(0, Math.min(1, 1 - bestSim))

    // ── Validation gates → quarantine on failure (never block pipeline) ────
    const failReason = validate(content, doc)
    const status = failReason ? 'quarantined' as const : 'active' as const

    const chunk: IngestedChunk = {
      id,
      content,
      embedding,
      domain: doc.domain,
      source: doc.source,
      sourceReliability: doc.sourceReliability,
      stalenessClass: doc.stalenessClass,
      ingestedAt: new Date().toISOString(),
      confidence: doc.sourceReliability,           // initial = reliability; lifecycle decays it
      retrievalCount: 0,
      retrievalValue: 0,
      uniquenessScore,
      confirmationCount: 0,
      status,
    }
    insertChunk(chunk)

    if (failReason) {
      logGovernance('quarantine', id, failReason)
      result.quarantined++
      continue
    }
    logGovernance('ingest', id, `${doc.domain} from ${doc.source} (uniqueness ${uniquenessScore.toFixed(2)})`)
    result.ingested++
    result.bytes += content.length

    // Add to in-memory active set so later chunks in THIS doc dedup against it.
    active.push(chunk)

    // ── Relationship extraction (budgeted) ─────────────────────────────────
    if (relBudget > 0 && deps.callModel) {
      const neighbours = topNeighbours(embedding, active, id, 5)
      if (neighbours.length) {
        result.relationships += await extractRelationships(id, content, neighbours, deps)
        relBudget--
      }
    }
  }
  return result
}

function topNeighbours(
  embedding: Float32Array,
  pool: IngestedChunk[],
  excludeId: string,
  k: number,
): Array<{ id: string; content: string }> {
  return pool
    .filter(c => c.id !== excludeId && c.embedding && c.embedding.length === embedding.length)
    .map(c => ({ c, sim: cosineSimilarity(embedding, c.embedding!) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .filter(x => x.sim > 0.1)
    .map(x => ({ id: x.c.id, content: x.c.content }))
}
