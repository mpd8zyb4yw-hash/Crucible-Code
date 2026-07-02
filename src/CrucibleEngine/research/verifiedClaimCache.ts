// ── Verified Claim Cache — RSI flywheel for reasoning ────────────────────────
//
// Persists verified claims so the same leaf question never asks the FM twice
// across sessions. Coverage compounds over time — the system gets smarter
// on topics it has already researched without any additional model calls.
//
// Storage: .crucible/research-claims.json (JSON, append-only per-claim)
// Key: SHA-256 of the normalized question (first 16 hex chars for brevity)
// TTL: matched to the VerificationTier and claim staleness class

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { VerifiedClaim, VerificationTier } from './provenanceOracle'

// ── TTL by tier (verified claims age differently) ─────────────────────────────
// Higher-tier = more trusted = longer TTL
const TIER_TTL_MS: Record<VerificationTier, number> = {
  'executable':          365 * 24 * 60 * 60 * 1000, // math is permanent
  'verbatim-provenance': 90  * 24 * 60 * 60 * 1000, // primary source text can change
  'cross-derived':       60  * 24 * 60 * 60 * 1000,
  'corroborated':        30  * 24 * 60 * 60 * 1000, // weakest, expires soonest
  'unverified':          0,                           // never cache unverified
}

// ── Cache record ──────────────────────────────────────────────────────────────

export interface CacheRecord {
  questionHash: string
  questionNorm: string   // for human readability in the JSON file
  claim: VerifiedClaim
  cachedAt: number
  expiresAt: number
}

export interface ClaimCacheStats {
  total: number
  byTier: Record<VerificationTier, number>
  hitRate: number
  hits: number
  misses: number
}

// ── Storage ───────────────────────────────────────────────────────────────────

function cacheFilePath(dir: string): string {
  return path.join(dir, '.crucible', 'research-claims.json')
}

function loadCache(dir: string): Map<string, CacheRecord> {
  try {
    const raw = fs.readFileSync(cacheFilePath(dir), 'utf8')
    const records: CacheRecord[] = JSON.parse(raw)
    const map = new Map<string, CacheRecord>()
    const now = Date.now()
    for (const r of records) {
      if (r.expiresAt > now) map.set(r.questionHash, r)
    }
    return map
  } catch {
    return new Map()
  }
}

function saveCache(dir: string, cache: Map<string, CacheRecord>): void {
  try {
    const file = cacheFilePath(dir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const records = [...cache.values()].slice(-2000) // cap at 2000 entries
    fs.writeFileSync(file, JSON.stringify(records, null, 2))
  } catch { /* best-effort */ }
}

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

export function hashQuestion(question: string): string {
  return crypto.createHash('sha256').update(normalizeQuestion(question)).digest('hex').slice(0, 16)
}

// ── Process-level in-memory layer (avoids file I/O on every lookup) ──────────

const _memCache = new Map<string, CacheRecord>()
let _loaded = false
let _dir = ''

function ensureLoaded(dir: string): void {
  if (_loaded && _dir === dir) return
  _dir = dir
  _loaded = true
  const disk = loadCache(dir)
  for (const [k, v] of disk) _memCache.set(k, v)
}

// ── Stats ─────────────────────────────────────────────────────────────────────

let _hits = 0
let _misses = 0

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Look up a cached verified claim for a question.
 * Returns null on cache miss or expired entry.
 */
export function lookupClaim(question: string, dir: string): VerifiedClaim | null {
  ensureLoaded(dir)
  const key = hashQuestion(question)
  const record = _memCache.get(key)
  if (!record) { _misses++; return null }
  if (record.expiresAt < Date.now()) {
    _memCache.delete(key)
    _misses++
    return null
  }
  _hits++
  return record.claim
}

/**
 * Store a verified claim in the cache. Unverified claims (tier='unverified') are ignored.
 */
export function storeClaim(question: string, claim: VerifiedClaim, dir: string): void {
  if (claim.tier === 'unverified') return
  const ttl = TIER_TTL_MS[claim.tier]
  if (!ttl) return
  const key = hashQuestion(question)
  const record: CacheRecord = {
    questionHash: key,
    questionNorm: normalizeQuestion(question).slice(0, 100),
    claim,
    cachedAt: Date.now(),
    expiresAt: Date.now() + ttl,
  }
  ensureLoaded(dir)
  _memCache.set(key, record)
  saveCache(dir, _memCache)
}

/** Purge all expired entries and persist. */
export function pruneCache(dir: string): number {
  ensureLoaded(dir)
  const now = Date.now()
  let pruned = 0
  for (const [k, v] of _memCache) {
    if (v.expiresAt < now) { _memCache.delete(k); pruned++ }
  }
  if (pruned) saveCache(dir, _memCache)
  return pruned
}

export function cacheStats(dir: string): ClaimCacheStats {
  ensureLoaded(dir)
  const byTier: Record<VerificationTier, number> = {
    'executable': 0, 'verbatim-provenance': 0, 'cross-derived': 0,
    'corroborated': 0, 'unverified': 0,
  }
  for (const r of _memCache.values()) byTier[r.claim.tier] = (byTier[r.claim.tier] ?? 0) + 1
  const total = _hits + _misses
  return {
    total: _memCache.size,
    byTier,
    hitRate: total > 0 ? _hits / total : 0,
    hits: _hits,
    misses: _misses,
  }
}
