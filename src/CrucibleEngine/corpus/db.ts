// Track C — LIVING CORPUS · storage layer (Phase 2.1: domain-sharded)
// A self-maintaining knowledge base: chunks + relationship graph + performance
// feedback + governance audit log + coverage-gap tracking. SQLite (WAL), at
// .crucible/corpus/. Embeddings share the MASTERPIECE vector space (same embedder,
// same dimensionality) so the two corpora are interoperable.
//
// CRITICAL INVARIANT: good data never leaves the corpus. Chunks are archived /
// superseded / quarantined — never deleted. The schema has no DELETE path in the
// public API; status transitions only.
//
// ── Domain sharding (Phase 2.1) ───────────────────────────────────────────────
// The chunks live in per-domain shard files (`${domain}.db`) for fast domain-routed
// reads (see query.ts + domainRouter.ts). corpus.db remains the canonical META DB:
// it holds the FULL schema (a complete chunks mirror PLUS relationships /
// retrieval_log / governance_log / coverage_gaps) so every legacy raw-SQL caller of
// getCorpusDb() — lifecycle.ts's retrieval_log⋈chunks audit, reembed.ts, etc. —
// keeps working byte-for-byte. Writes go to BOTH the meta DB and the routed shard;
// aggregate reads use the meta DB; domain-routed reads use the single shard.
//
// SAFETY: sharding is DORMANT until the next server boot. The one-time migrate is
// idempotent + non-destructive — it COPIES (never moves/deletes) chunk data into
// shards, backs up corpus.db first, and only marks itself done after every chunk is
// verified copied. If anything fails mid-way it bails, leaving the original intact.

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_VERSION = 1
export const CORPUS_DIR = path.resolve(process.cwd(), '.crucible', 'corpus')
const DB_PATH = path.join(CORPUS_DIR, 'corpus.db')

// ── Domain shard taxonomy ─────────────────────────────────────────────────────
// ~30 initial domains. Unknown / unrecognised domains route to 'general'. These
// names are also the shard filenames (`${domain}.db`). Aligned with the corpus's
// existing domain labels (lifecycle.ts TARGET_ALLOCATION, acquire.ts manifest).
export const DOMAIN_SHARDS = [
  'mathematics', 'physics', 'chemistry', 'biology', 'computer-science',
  'machine-learning', 'engineering', 'networking', 'systems-theory',
  'information-theory', 'formal-reasoning', 'complex-systems', 'statistics',
  'economics', 'finance', 'psychology', 'cognitive-science', 'neuroscience',
  'sociology', 'political-science', 'law', 'medicine', 'philosophy', 'history',
  'literature', 'linguistics', 'art', 'music', 'geography', 'general',
] as const
export type DomainShard = typeof DOMAIN_SHARDS[number]

const SHARD_SET = new Set<string>(DOMAIN_SHARDS)
export const DEFAULT_SHARD: DomainShard = 'general'

// Map a (possibly free-form) chunk domain to one of the known shard names.
// Exact match wins; otherwise a few common aliases; else 'general'.
const DOMAIN_ALIASES: Record<string, DomainShard> = {
  math: 'mathematics', maths: 'mathematics',
  cs: 'computer-science', 'comp-sci': 'computer-science', software: 'computer-science', 'software-engineering': 'computer-science',
  ml: 'machine-learning', ai: 'machine-learning',
  bio: 'biology', chem: 'chemistry', phys: 'physics',
  econ: 'economics', psych: 'psychology', phil: 'philosophy',
  net: 'networking', stats: 'statistics',
}
export function normalizeDomain(domain?: string | null): DomainShard {
  const d = (domain ?? '').trim().toLowerCase()
  if (SHARD_SET.has(d)) return d as DomainShard
  if (DOMAIN_ALIASES[d]) return DOMAIN_ALIASES[d]
  return DEFAULT_SHARD
}

function shardPath(domain: DomainShard): string {
  return path.join(CORPUS_DIR, `${domain}.db`)
}

// ── Open handles ──────────────────────────────────────────────────────────────
let _db: Database.Database | null = null               // meta DB (canonical, full schema)
const _shards = new Map<DomainShard, Database.Database>()  // per-domain shard handles
let _migrated = false                                  // lazy one-time migration guard

function openDbFile(file: string): Database.Database {
  fs.mkdirSync(CORPUS_DIR, { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export function getCorpusDb(): Database.Database {
  if (_db) return _db
  _db = openDbFile(DB_PATH)
  // Lazily run the one-time shard migration on first corpus access (post-boot).
  // Guarded so it runs at most once; never throws to callers.
  ensureSharded()
  return _db
}

// Open (or return cached) the per-domain shard handle. Schema is identical to the
// meta DB. Unknown domains collapse to 'general' via normalizeDomain.
export function openShard(domain: string): Database.Database {
  const name = normalizeDomain(domain)
  const existing = _shards.get(name)
  if (existing) return existing
  const db = openDbFile(shardPath(name))
  _shards.set(name, db)
  return db
}

// The shard a chunk belongs in, by its domain.
export function getShardForChunk(chunk: { domain?: string | null }): Database.Database {
  return openShard(normalizeDomain(chunk.domain))
}

// Return the shard handles to query. With no arg → every shard that already exists
// on disk (or is open), opened on demand. With domains → only those (normalised,
// de-duped). Used by query.ts to query+merge across shards.
export function queryShards(domains?: string[]): Database.Database[] {
  ensureSharded()
  let names: DomainShard[]
  if (domains && domains.length) {
    names = [...new Set(domains.map(normalizeDomain))]
  } else {
    // All shards that have a file on disk, plus any already open.
    const onDisk = DOMAIN_SHARDS.filter(d => fs.existsSync(shardPath(d)))
    names = [...new Set<DomainShard>([...onDisk, ..._shards.keys()])]
    if (names.length === 0) names = [DEFAULT_SHARD]
  }
  return names.map(openShard)
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  if ((row?.version ?? 0) >= DB_VERSION) return
  db.exec(SCHEMA)
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(DB_VERSION)
}

// ── One-time shard migration ──────────────────────────────────────────────────
// Idempotent + non-destructive. Populates per-domain shard files from the meta DB's
// chunks table. The meta DB (corpus.db) is the canonical source of truth and is
// LEFT INTACT — shards are a parallel, domain-routed read index. We never delete or
// move chunk data; a backup is taken before the first copy and a marker file records
// completion so this runs at most once per machine.
const MIGRATION_MARKER = path.join(CORPUS_DIR, 'sharding.done')

export function ensureSharded(): void {
  if (_migrated) return
  _migrated = true               // set first: at-most-once even if this throws
  try {
    if (fs.existsSync(MIGRATION_MARKER)) return   // already migrated on a prior boot
    runShardMigration(getCorpusDb())
  } catch (e: any) {
    // Non-fatal: shards are an optimisation. Leave the meta DB as the source of
    // truth; clear the marker is NOT written so a later boot can retry.
    console.error('[CORPUS] shard migration deferred (non-fatal):', e?.message)
  }
}

function runShardMigration(meta: Database.Database): void {
  const total = (meta.prepare(`SELECT COUNT(*) c FROM chunks`).get() as { c: number }).c
  if (total === 0) {
    // Nothing to shard yet (fresh corpus). Mark done; future inserts dual-write.
    fs.writeFileSync(MIGRATION_MARKER, JSON.stringify({ at: new Date().toISOString(), copied: 0, total: 0 }))
    return
  }

  // 1) Non-destructive backup of the canonical DB before touching anything.
  const backup = `${DB_PATH}.premigration`
  if (!fs.existsSync(backup) && fs.existsSync(DB_PATH)) {
    try { meta.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`) }
    catch { fs.copyFileSync(DB_PATH, backup) }   // VACUUM INTO unavailable → plain copy
  }

  // 2) Copy every chunk into its domain shard (INSERT OR IGNORE = idempotent).
  const rows = meta.prepare(`SELECT * FROM chunks`).all() as any[]
  let copied = 0
  const byShard = new Map<DomainShard, any[]>()
  for (const r of rows) {
    const name = normalizeDomain(r.domain)
    if (!byShard.has(name)) byShard.set(name, [])
    byShard.get(name)!.push(r)
  }
  for (const [name, shardRows] of byShard) {
    const shard = openShard(name)
    const ins = shard.prepare(`
      INSERT OR IGNORE INTO chunks
        (id, content, embedding, domain, source, source_reliability, staleness_class,
         ingested_at, confidence, retrieval_count, retrieval_value, uniqueness_score,
         confirmation_count, status, superseded_by, archive_reason)
      VALUES (@id, @content, @embedding, @domain, @source, @source_reliability, @staleness_class,
         @ingested_at, @confidence, @retrieval_count, @retrieval_value, @uniqueness_score,
         @confirmation_count, @status, @superseded_by, @archive_reason)
    `)
    const tx = shard.transaction((batch: any[]) => { for (const r of batch) ins.run(r) })
    tx(shardRows)
    copied += shardRows.length
  }

  // 3) Verify every chunk landed in a shard before marking done. If counts don't
  //    reconcile, bail WITHOUT writing the marker so a later boot retries; the meta
  //    DB and backup remain fully intact, so no data is ever at risk.
  let shardTotal = 0
  for (const name of byShard.keys()) {
    shardTotal += (openShard(name).prepare(`SELECT COUNT(*) c FROM chunks`).get() as { c: number }).c
  }
  if (shardTotal < total) {
    throw new Error(`shard verification failed: shards have ${shardTotal} of ${total} chunks`)
  }

  fs.writeFileSync(MIGRATION_MARKER, JSON.stringify({ at: new Date().toISOString(), copied, total }))
  console.log(`[CORPUS] Domain sharding complete — ${copied} chunks across ${byShard.size} shard(s); meta DB retained as canonical source.`)
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
const INSERT_CHUNK_SQL = `
  INSERT OR IGNORE INTO chunks
    (id, content, embedding, domain, source, source_reliability, staleness_class,
     ingested_at, confidence, retrieval_count, retrieval_value, uniqueness_score,
     confirmation_count, status, superseded_by, archive_reason)
  VALUES (@id, @content, @embedding, @domain, @source, @sourceReliability, @stalenessClass,
     @ingestedAt, @confidence, @retrievalCount, @retrievalValue, @uniquenessScore,
     @confirmationCount, @status, @supersededBy, @archiveReason)
`

export function insertChunk(c: IngestedChunk): void {
  const embBuf = c.embedding ? Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength) : null
  const params = {
    ...c,
    embedding: embBuf,
    supersededBy: c.supersededBy ?? null,
    archiveReason: c.archiveReason ?? null,
  }
  // Canonical write to the meta DB (keeps every legacy raw-SQL caller correct) …
  getCorpusDb().prepare(INSERT_CHUNK_SQL).run(params)
  // … plus a routed write to the per-domain shard for fast domain-scoped reads.
  getShardForChunk(c).prepare(INSERT_CHUNK_SQL).run(params)
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
  // Fast path: read only the one domain shard. Fall back to the canonical meta DB
  // if the shard hasn't been populated yet (pre-migration / fresh boot) so callers
  // are never shown an empty result while data exists in the meta DB.
  const shard = openShard(domain)
  const rows = shard.prepare(`SELECT * FROM chunks WHERE domain = ? AND status = ?`).all(domain, status)
  if (rows.length) return rows.map(rowToChunk)
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
