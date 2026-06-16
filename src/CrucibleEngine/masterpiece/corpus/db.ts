// MASTERPIECE corpus — SQLite schema and initialisation
// Uses better-sqlite3 for synchronous access (safe from server.ts thread).
// Database lives at data/masterpiece-corpus.db relative to project root.
// Schema is versioned — migrations run automatically at startup.

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_VERSION = 1
const DB_PATH = path.resolve(process.cwd(), 'data', 'masterpiece-corpus.db')

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  _db = db
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `)
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  const current = row?.version ?? 0
  if (current >= DB_VERSION) return
  applyV1(db)
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(DB_VERSION)
}

function applyV1(db: Database.Database): void {
  db.exec(`
    -- Documents: top-level knowledge units (books, essays, papers, etc.)
    CREATE TABLE IF NOT EXISTS documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      domain     TEXT NOT NULL,
      source     TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      ingested_at INTEGER NOT NULL
    );

    -- Chunks: fixed-size semantic passages from each document
    CREATE TABLE IF NOT EXISTS chunks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      domain      TEXT NOT NULL,
      confidence  REAL NOT NULL DEFAULT 1.0,
      -- Embeddings stored as raw bytes (BLOB). Dimension determined at read time.
      embedding   BLOB,
      ingested_at INTEGER NOT NULL
    );

    -- Reasoning paths: cross-domain connections found during MASTERPIECE runs
    CREATE TABLE IF NOT EXISTS reasoning_paths (
      id                TEXT PRIMARY KEY,
      from_domain       TEXT NOT NULL,
      to_domain         TEXT NOT NULL,
      path_type         TEXT NOT NULL,   -- 'abductive' | 'structural'
      weight            REAL NOT NULL DEFAULT 1.0,
      novelty_score     REAL NOT NULL DEFAULT 0.5,
      survived_count    INTEGER NOT NULL DEFAULT 0,
      failed_count      INTEGER NOT NULL DEFAULT 0,
      last_used_at      INTEGER NOT NULL,
      decay_half_life_days INTEGER NOT NULL DEFAULT 30
    );

    -- Calibration records: per-run epistemic bookkeeping
    CREATE TABLE IF NOT EXISTS calibration_records (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      anchor_id              TEXT NOT NULL,
      connection_ids         TEXT NOT NULL,  -- JSON array of string ids
      path_ids               TEXT NOT NULL,  -- JSON array of string ids
      final_confidence_score REAL NOT NULL,
      user_feedback          TEXT,           -- 'positive' | 'negative' | NULL
      recorded_at            INTEGER NOT NULL
    );

    -- Ground truth anchors: one row per MASTERPIECE invocation
    CREATE TABLE IF NOT EXISTS anchors (
      id             TEXT PRIMARY KEY,
      original_prompt TEXT NOT NULL,
      stored_at      INTEGER NOT NULL,
      shard_count    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain);
    CREATE INDEX IF NOT EXISTS idx_reasoning_paths_domains ON reasoning_paths(from_domain, to_domain);
    CREATE INDEX IF NOT EXISTS idx_calibration_anchor ON calibration_records(anchor_id);
  `)
}

// ── Prepared statement accessors ───────────────────────────────────────────
// Called lazily to avoid re-compiling across hot-reloads.

export function stmts() {
  const db = getDb()
  return {
    insertDocument: db.prepare<[string, string, string | null, number, number]>(`
      INSERT INTO documents (title, domain, source, confidence, ingested_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertChunk: db.prepare<[number, string, string, number, Buffer | null, number]>(`
      INSERT INTO chunks (doc_id, content, domain, confidence, embedding, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getAllChunks: db.prepare<[]>(`
      SELECT id, doc_id, content, domain, confidence, embedding, ingested_at
      FROM chunks
    `),
    getChunksByDomain: db.prepare<[string]>(`
      SELECT id, doc_id, content, domain, confidence, embedding, ingested_at
      FROM chunks WHERE domain = ?
    `),
    getChunkById: db.prepare<[number]>(`
      SELECT id, doc_id, content, domain, confidence, embedding, ingested_at
      FROM chunks WHERE id = ?
    `),
    upsertReasoningPath: db.prepare<[string, string, string, string, number, number, number, number, number, number]>(`
      INSERT INTO reasoning_paths
        (id, from_domain, to_domain, path_type, weight, novelty_score, survived_count, failed_count, last_used_at, decay_half_life_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        weight          = excluded.weight,
        survived_count  = excluded.survived_count,
        failed_count    = excluded.failed_count,
        last_used_at    = excluded.last_used_at
    `),
    getReasoningPath: db.prepare<[string, string, string]>(`
      SELECT * FROM reasoning_paths WHERE from_domain = ? AND to_domain = ? AND path_type = ?
    `),
    getAllReasoningPaths: db.prepare<[]>(`SELECT * FROM reasoning_paths`),
    insertCalibration: db.prepare<[string, string, string, number, number]>(`
      INSERT INTO calibration_records
        (anchor_id, connection_ids, path_ids, final_confidence_score, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    insertAnchor: db.prepare<[string, string, number, number]>(`
      INSERT OR REPLACE INTO anchors (id, original_prompt, stored_at, shard_count)
      VALUES (?, ?, ?, ?)
    `),
    getChunkCount: db.prepare<[]>(`SELECT COUNT(*) as count FROM chunks`),
    getSampleChunkEmbedding: db.prepare<[]>(`SELECT embedding FROM chunks WHERE embedding IS NOT NULL LIMIT 1`),
  }
}

// Wipes all chunks + documents (cascade). Used when the embedding scheme changes
// and the stored vectors are dimensionally incompatible with the current embedder.
// Leaves reasoning_paths / calibration_records / anchors intact (scheme-agnostic).
export function resetCorpusChunks(): void {
  const db = getDb()
  db.exec('DELETE FROM chunks; DELETE FROM documents;')
}
