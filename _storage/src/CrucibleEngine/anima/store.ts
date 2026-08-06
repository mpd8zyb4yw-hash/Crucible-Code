// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Universal Truth Store. SQLite at .crucible/anima/truths.db.
//
// PRIVACY INVARIANT (enforced by schema, not just docs): the truths table has
// NO user-id column, NO session-id column, and NO timestamp granular enough to
// identify a session — only day-level ISO dates (firstObserved/lastUpdated).
// Every row is a universal observation about humans, never a record of a person.

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { UniversalTruth, TruthDomain, TruthStatus, EmotionalValence } from './types.js'

const DB_VERSION = 1
const DB_PATH = path.resolve(process.cwd(), '.crucible', 'anima', 'truths.db')

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  _db = db
  return db
}

function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  if ((row?.version ?? 0) >= DB_VERSION) return
  db.exec(`
    -- Universal truths: anonymous observations about the human condition.
    -- DELIBERATELY no user_id, no session_id, no sub-day timestamp.
    CREATE TABLE IF NOT EXISTS truths (
      id                     TEXT PRIMARY KEY,
      observation            TEXT NOT NULL,
      domain                 TEXT NOT NULL,
      confidence             REAL NOT NULL,
      novelty_score          REAL NOT NULL,
      confirming_instances   INTEGER NOT NULL DEFAULT 0,
      contradicting_instances INTEGER NOT NULL DEFAULT 0,
      fragility              TEXT NOT NULL,
      first_observed         TEXT NOT NULL,   -- ISO date, day granularity only
      last_updated           TEXT NOT NULL,   -- ISO date, day granularity only
      status                 TEXT NOT NULL    -- 'candidate' | 'active' | 'archived'
    );
    CREATE INDEX IF NOT EXISTS idx_truths_domain ON truths(domain);
    CREATE INDEX IF NOT EXISTS idx_truths_status ON truths(status);
  `)
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(DB_VERSION)
}

function isoDay(): string {
  return new Date().toISOString().slice(0, 10)  // YYYY-MM-DD — day granularity, never a session
}

// Conservative confidence: starts low, requires real signal to rise.
function computeConfidence(confirming: number, contradicting: number): number {
  return confirming / (confirming + contradicting + 2)
}

function rowToTruth(r: any): UniversalTruth {
  return {
    id: r.id,
    observation: r.observation,
    domain: r.domain as TruthDomain,
    confidence: r.confidence,
    noveltyScore: r.novelty_score,
    confirmingInstances: r.confirming_instances,
    contradictingInstances: r.contradicting_instances,
    fragility: r.fragility,
    firstObserved: r.first_observed,
    lastUpdated: r.last_updated,
    status: r.status as TruthStatus,
  }
}

let _idCounter = 0
function newTruthId(): string {
  // Monotonic + db-size based so ids are stable-ish and non-temporal.
  const n = (getDb().prepare('SELECT COUNT(*) as c FROM truths').get() as { c: number }).c + (++_idCounter)
  return `ut_${n.toString().padStart(4, '0')}`
}

// ── Operations ──────────────────────────────────────────────────────────────

// Write a verified candidate as a new entry. status 'candidate', confidence 0.35.
export function write(truth: {
  observation: string
  domain: TruthDomain
  noveltyScore: number
  fragility: string
}): UniversalTruth {
  const db = getDb()
  const day = isoDay()
  const entry: UniversalTruth = {
    id: newTruthId(),
    observation: truth.observation,
    domain: truth.domain,
    confidence: 0.35,            // conservative start
    noveltyScore: truth.noveltyScore,
    confirmingInstances: 0,
    contradictingInstances: 0,
    fragility: truth.fragility,
    firstObserved: day,
    lastUpdated: day,
    status: 'candidate',
  }
  db.prepare(`
    INSERT INTO truths (id, observation, domain, confidence, novelty_score,
      confirming_instances, contradicting_instances, fragility, first_observed, last_updated, status)
    VALUES (@id, @observation, @domain, @confidence, @noveltyScore,
      @confirmingInstances, @contradictingInstances, @fragility, @firstObserved, @lastUpdated, @status)
  `).run(entry)
  return entry
}

// Increment confirming instances, recompute confidence, promote to 'active' if it crosses 0.5.
export function confirm(id: string): UniversalTruth | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM truths WHERE id = ?').get(id)
  if (!row) return null
  const t = rowToTruth(row)
  const confirming = t.confirmingInstances + 1
  const confidence = computeConfidence(confirming, t.contradictingInstances)
  const status: TruthStatus = confidence >= 0.5 ? 'active' : t.status === 'archived' ? 'candidate' : t.status
  db.prepare(`UPDATE truths SET confirming_instances = ?, confidence = ?, status = ?, last_updated = ? WHERE id = ?`)
    .run(confirming, confidence, status, isoDay(), id)
  return { ...t, confirmingInstances: confirming, confidence, status, lastUpdated: isoDay() }
}

// Increment contradicting instances, recompute confidence, archive if it falls below 0.2.
export function contradict(id: string): UniversalTruth | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM truths WHERE id = ?').get(id)
  if (!row) return null
  const t = rowToTruth(row)
  const contradicting = t.contradictingInstances + 1
  const confidence = computeConfidence(t.confirmingInstances, contradicting)
  const status: TruthStatus = confidence < 0.2 ? 'archived' : t.status
  db.prepare(`UPDATE truths SET contradicting_instances = ?, confidence = ?, status = ?, last_updated = ? WHERE id = ?`)
    .run(contradicting, confidence, status, isoDay(), id)
  return { ...t, contradictingInstances: contradicting, confidence, status, lastUpdated: isoDay() }
}

// Retrieve active truths relevant to the current emotional context, ranked by
// confidence × relevance. Relevance maps the valence's dominant emotion to the
// truth domains most likely to carry useful framing guidance.
export function query(domain: TruthDomain | null, emotionalContext: EmotionalValence | null): UniversalTruth[] {
  const db = getDb()
  const rows = db.prepare(`SELECT * FROM truths WHERE status = 'active'`).all().map(rowToTruth)

  const relevantDomains = domain ? new Set<TruthDomain>([domain]) : emotionalDomainAffinity(emotionalContext)

  return rows
    .map(t => {
      let relevance = relevantDomains.has(t.domain) ? 1 : 0.4
      // Distress sharpens the relevance of emotional/relational/existential truths.
      if (emotionalContext && emotionalContext.score < -0.3 &&
          (t.domain === 'emotional' || t.domain === 'relational' || t.domain === 'existential')) {
        relevance *= 1.4
      }
      return { t, rank: t.confidence * relevance }
    })
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.t)
}

function emotionalDomainAffinity(v: EmotionalValence | null): Set<TruthDomain> {
  if (!v) return new Set<TruthDomain>(['cognitive', 'behavioral'])
  switch (v.dominant) {
    case 'grief':
    case 'longing':       return new Set<TruthDomain>(['emotional', 'existential', 'relational'])
    case 'stressed':
    case 'frustrated':
    case 'overwhelmed':   return new Set<TruthDomain>(['emotional', 'behavioral', 'cognitive'])
    case 'angry':         return new Set<TruthDomain>(['emotional', 'relational'])
    case 'curious':       return new Set<TruthDomain>(['cognitive', 'existential'])
    default:              return new Set<TruthDomain>(['cognitive', 'behavioral'])
  }
}

// Periodic decay: entries with no signal in 90 days drift toward neutral (0.5),
// then can re-settle as signal arrives. Run opportunistically (cheap, idempotent).
export function decay(): number {
  const db = getDb()
  const rows = db.prepare(`SELECT * FROM truths WHERE status != 'archived'`).all().map(rowToTruth)
  const today = Date.now()
  let touched = 0
  for (const t of rows) {
    const ageDays = (today - Date.parse(t.lastUpdated)) / 86_400_000
    if (ageDays < 90) continue
    // Pull a fraction of the way toward neutral per 90-day period of silence.
    const periods = Math.floor(ageDays / 90)
    const pulled = t.confidence + (0.5 - t.confidence) * Math.min(1, 0.25 * periods)
    const status: TruthStatus = pulled < 0.2 ? 'archived' : t.status
    db.prepare(`UPDATE truths SET confidence = ?, status = ?, last_updated = ? WHERE id = ?`)
      .run(pulled, status, isoDay(), t.id)
    touched++
  }
  return touched
}

// All active truths, highest confidence first — for the transparency layer.
export function list(includeCandidates = false): UniversalTruth[] {
  const db = getDb()
  const where = includeCandidates ? `status != 'archived'` : `status = 'active'`
  return db.prepare(`SELECT * FROM truths WHERE ${where} ORDER BY confidence DESC`).all().map(rowToTruth)
}

// Exposed for verify.ts cross-domain / novelty checks: every non-archived truth.
export function allLiveTruths(): UniversalTruth[] {
  return getDb().prepare(`SELECT * FROM truths WHERE status != 'archived'`).all().map(rowToTruth)
}
