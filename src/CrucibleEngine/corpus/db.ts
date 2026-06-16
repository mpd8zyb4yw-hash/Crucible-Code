// Track C — LIVING CORPUS · storage layer
// A self-maintaining knowledge base: chunks + relationship graph + performance
// feedback + governance audit log + coverage-gap tracking. SQLite (WAL), at
// .crucible/corpus/corpus.db. Embeddings share the MASTERPIECE vector space
// (same embedder, same dimensionality) so the two corpora are interoperable.
//
// CRITICAL INVARIANT: good data never leaves the corpus. Chunks are archived /
// superseded / quarantined — never deleted. The schema has no DELETE path in the
// public API; status transitions only.

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_VERSION = 1
export const CORPUS_DIR = path.resolve(process.cwd(), '.crucible', 'corpus')
const DB_PATH = path.join(CORPUS_DIR, 'corpus.db')

let _db: Database.Database | null = null

export function getCorpusDb(): Database.Database {
  if (_db) return _db
  fs.mkdirSync(CORPUS_DIR, { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  _db = db
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  if ((row?.version ?? 0) >= DB_VERSION) return
  db.exec(SCHEMA)
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(DB_VERSION)
}

const SCHEMA = `
-- Core chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,                       -- sha256 hash of content
  content TEXT NOT NULL,
  embedding BLOB,                            -- Float32 vector, MASTERPIECE vector space
  domain TEXT NOT NULL,
  source TEXT NOT NULL,
  source_reliability REAL NOT NULL,          -- peer-reviewed 0.9, preprint 0.7, blog 0.4
  staleness_class TEXT NOT NULL,             -- permanent|scientific|engineering|technology|current
  ingested_at TEXT NOT NULL,                 -- ISO timestamp
  confidence REAL NOT NULL,
  retrieval_count INTEGER DEFAULT 0,
  retrieval_value REAL DEFAULT 0,
  uniqueness_score REAL DEFAULT 0.5,
  confirmation_count INTEGER DEFAULT 0,      -- bumped when a near-duplicate is re-seen
  status TEXT DEFAULT 'active',              -- active|archived|quarantined|superseded
  superseded_by TEXT,
  archive_reason TEXT
);

-- Relationship graph
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  from_chunk_id TEXT NOT NULL,
  to_chunk_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,                   -- depends-on|enables|constrains|contradicts|analogizes|scales-with|emerges-from
  confidence REAL NOT NULL,
  extracted_at TEXT NOT NULL,
  FOREIGN KEY (from_chunk_id) REFERENCES chunks(id),
  FOREIGN KEY (to_chunk_id) REFERENCES chunks(id)
);

-- Performance feedback — which chunks contributed to good outcomes
CREATE TABLE IF NOT EXISTS retrieval_log (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  query_context TEXT,
  outcome_confidence REAL,
  contributed_to_masterpiece INTEGER DEFAULT 0
);

-- Governance log — every lifecycle/ingestion decision, full audit trail
CREATE TABLE IF NOT EXISTS governance_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,                  -- ingest|quarantine|archive|supersede|dedup|gap|restore
  chunk_id TEXT,
  reason TEXT,
  timestamp TEXT NOT NULL,
  resolved INTEGER DEFAULT 0
);

-- Coverage-gap tracking, one row per domain
CREATE TABLE IF NOT EXISTS coverage_gaps (
  domain TEXT PRIMARY KEY,
  chunk_count INTEGER,
  query_miss_rate REAL,
  last_audited TEXT,
  priority_score REAL,
  acquisition_triggered INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_domain   ON chunks(domain);
CREATE INDEX IF NOT EXISTS idx_chunks_status   ON chunks(status);
CREATE INDEX IF NOT EXISTS idx_chunks_staleness ON chunks(staleness_class);
CREATE INDEX IF NOT EXISTS idx_chunks_confidence ON chunks(confidence);
CREATE INDEX IF NOT EXISTS idx_rel_from        ON relationships(from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_rel_to          ON relationships(to_chunk_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_chunk ON retrieval_log(chunk_id);
CREATE INDEX IF NOT EXISTS idx_gov_chunk       ON governance_log(chunk_id);
`

// ── Types ────────────────────────────────────────────────────────────────────
export type StalenessClass = 'permanent' | 'scientific' | 'engineering' | 'technology' | 'current'
export type ChunkStatus = 'active' | 'archived' | 'quarantined' | 'superseded'
export type EdgeType =
  | 'depends-on' | 'enables' | 'constrains' | 'contradicts'
  | 'analogizes' | 'scales-with' | 'emerges-from'

export interface IngestedChunk {
  id: string
  content: string
  embedding?: Float32Array
  domain: string
  source: string
  sourceReliability: number
  stalenessClass: StalenessClass
  ingestedAt: string
  confidence: number
  retrievalCount: number
  retrievalValue: number
  uniquenessScore: number
  confirmationCount: number
  status: ChunkStatus
  supersededBy?: string | null
  archiveReason?: string | null
}

export interface RelationshipEdge {
  id: string
  fromChunkId: string
  toChunkId: string
  edgeType: EdgeType
  confidence: number
  extractedAt: string
}

// ── Row mapping ──────────────────────────────────────────────────────────────
function rowToChunk(r: any): IngestedChunk {
  return {
    id: r.id,
    content: r.content,
    embedding: r.embedding ? new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4) : undefined,
    domain: r.domain,
    source: r.source,
    sourceReliability: r.source_reliability,
    stalenessClass: r.staleness_class,
    ingestedAt: r.ingested_at,
    confidence: r.confidence,
    retrievalCount: r.retrieval_count,
    retrievalValue: r.retrieval_value,
    uniquenessScore: r.uniqueness_score,
    confirmationCount: r.confirmation_count ?? 0,
    status: r.status,
    supersededBy: r.superseded_by,
    archiveReason: r.archive_reason,
  }
}

// ── Write operations ─────────────────────────────────────────────────────────
export function insertChunk(c: IngestedChunk): void {
  const db = getCorpusDb()
  const embBuf = c.embedding ? Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength) : null
  db.prepare(`
    INSERT OR IGNORE INTO chunks
      (id, content, embedding, domain, source, source_reliability, staleness_class,
       ingested_at, confidence, retrieval_count, retrieval_value, uniqueness_score,
       confirmation_count, status, superseded_by, archive_reason)
    VALUES (@id, @content, @embedding, @domain, @source, @sourceReliability, @stalenessClass,
       @ingestedAt, @confidence, @retrievalCount, @retrievalValue, @uniquenessScore,
       @confirmationCount, @status, @supersededBy, @archiveReason)
  `).run({
    ...c,
    embedding: embBuf,
    supersededBy: c.supersededBy ?? null,
    archiveReason: c.archiveReason ?? null,
  })
}

export function insertRelationship(e: RelationshipEdge): void {
  getCorpusDb().prepare(`
    INSERT OR IGNORE INTO relationships (id, from_chunk_id, to_chunk_id, edge_type, confidence, extracted_at)
    VALUES (@id, @fromChunkId, @toChunkId, @edgeType, @confidence, @extractedAt)
  `).run(e)
}

export function bumpConfirmation(chunkId: string): void {
  getCorpusDb().prepare(`UPDATE chunks SET confirmation_count = confirmation_count + 1 WHERE id = ?`).run(chunkId)
}

// Status transitions — the ONLY way content leaves "active". Never DELETE.
export function setStatus(chunkId: string, status: ChunkStatus, reason?: string, supersededBy?: string): void {
  getCorpusDb().prepare(`UPDATE chunks SET status = ?, archive_reason = COALESCE(?, archive_reason), superseded_by = COALESCE(?, superseded_by) WHERE id = ?`)
    .run(status, reason ?? null, supersededBy ?? null, chunkId)
}

export function updateRetrieval(chunkId: string, deltaValue: number): void {
  getCorpusDb().prepare(`UPDATE chunks SET retrieval_count = retrieval_count + 1, retrieval_value = MIN(1.0, retrieval_value + ?) WHERE id = ?`)
    .run(deltaValue, chunkId)
}

export function logRetrieval(r: { id: string; chunkId: string; queryContext?: string; outcomeConfidence?: number; contributed?: boolean }): void {
  getCorpusDb().prepare(`
    INSERT INTO retrieval_log (id, chunk_id, retrieved_at, query_context, outcome_confidence, contributed_to_masterpiece)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(r.id, r.chunkId, new Date().toISOString(), r.queryContext ?? null, r.outcomeConfidence ?? null, r.contributed ? 1 : 0)
}

export function logGovernance(eventType: string, chunkId: string | null, reason: string): void {
  getCorpusDb().prepare(`
    INSERT INTO governance_log (id, event_type, chunk_id, reason, timestamp, resolved)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(`gov_${Date.now()}_${Math.round(perfRand() * 1e6)}`, eventType, chunkId, reason, new Date().toISOString())
}

export function upsertCoverageGap(g: { domain: string; chunkCount: number; queryMissRate: number; priorityScore: number; acquisitionTriggered?: boolean }): void {
  getCorpusDb().prepare(`
    INSERT INTO coverage_gaps (domain, chunk_count, query_miss_rate, last_audited, priority_score, acquisition_triggered)
    VALUES (@domain, @chunkCount, @queryMissRate, @lastAudited, @priorityScore, @acquisitionTriggered)
    ON CONFLICT(domain) DO UPDATE SET
      chunk_count = excluded.chunk_count,
      query_miss_rate = excluded.query_miss_rate,
      last_audited = excluded.last_audited,
      priority_score = excluded.priority_score,
      acquisition_triggered = excluded.acquisition_triggered
  `).run({ ...g, lastAudited: new Date().toISOString(), acquisitionTriggered: g.acquisitionTriggered ? 1 : 0 })
}

// ── Read operations ──────────────────────────────────────────────────────────
export function getChunk(id: string): IngestedChunk | null {
  const r = getCorpusDb().prepare(`SELECT * FROM chunks WHERE id = ?`).get(id)
  return r ? rowToChunk(r) : null
}

export function getActiveChunks(limit?: number): IngestedChunk[] {
  const sql = `SELECT * FROM chunks WHERE status = 'active'` + (limit ? ` LIMIT ${limit}` : '')
  return getCorpusDb().prepare(sql).all().map(rowToChunk)
}

export function getChunksByDomain(domain: string, status: ChunkStatus = 'active'): IngestedChunk[] {
  return getCorpusDb().prepare(`SELECT * FROM chunks WHERE domain = ? AND status = ?`).all(domain, status).map(rowToChunk)
}

export function chunkCount(status?: ChunkStatus): number {
  const db = getCorpusDb()
  const row = status
    ? db.prepare(`SELECT COUNT(*) c FROM chunks WHERE status = ?`).get(status)
    : db.prepare(`SELECT COUNT(*) c FROM chunks`).get()
  return (row as { c: number }).c
}

export function domainDistribution(): Array<{ domain: string; count: number; bytes: number }> {
  return getCorpusDb().prepare(`
    SELECT domain, COUNT(*) as count, SUM(LENGTH(content)) as bytes
    FROM chunks WHERE status = 'active' GROUP BY domain ORDER BY count DESC
  `).all() as any[]
}

export function totalContentBytes(): number {
  const r = getCorpusDb().prepare(`SELECT SUM(LENGTH(content)) b FROM chunks WHERE status = 'active'`).get() as { b: number | null }
  return r.b ?? 0
}

export function relationshipCount(): number {
  return (getCorpusDb().prepare(`SELECT COUNT(*) c FROM relationships`).get() as { c: number }).c
}

export function getCoverageGaps(): Array<{ domain: string; chunk_count: number; query_miss_rate: number; priority_score: number; last_audited: string }> {
  return getCorpusDb().prepare(`SELECT * FROM coverage_gaps ORDER BY priority_score DESC`).all() as any[]
}

export function getRelationshipsFor(chunkId: string): RelationshipEdge[] {
  return getCorpusDb().prepare(`SELECT * FROM relationships WHERE from_chunk_id = ? OR to_chunk_id = ?`).all(chunkId, chunkId).map((r: any) => ({
    id: r.id, fromChunkId: r.from_chunk_id, toChunkId: r.to_chunk_id, edgeType: r.edge_type, confidence: r.confidence, extractedAt: r.extracted_at,
  }))
}

// Deterministic-ish randomness without Math.random in hot ingestion id paths is
// unnecessary here (server runtime, not a workflow), but keep a tiny helper so
// governance ids stay unique even within the same millisecond.
let _ctr = 0
function perfRand(): number { return (++_ctr % 1000) / 1000 }
