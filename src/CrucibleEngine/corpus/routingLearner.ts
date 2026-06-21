// Session E — Domain-routing active-learning loop (Phase 2.4).
//
// The keyword/TF-IDF domain router (domainRouter.ts) logs low-confidence routings to
// .crucible/routing-misses.jsonl. This loop periodically takes those misses, asks the
// fastest free model for the correct domain, and feeds the answer back via
// learnDomainRoute() — which the keyword classifier already blends into future routing.
// Over time the router stops missing on the same kinds of query. The LLM classifier is
// injected (no server coupling); a small cache short-circuits repeats.

import fs from 'fs'
import path from 'path'
import { learnDomainRoute } from './domainRouter'

const CRUCIBLE_DIR = path.resolve(process.cwd(), '.crucible')
const MISSES_PATH = path.join(CRUCIBLE_DIR, 'routing-misses.jsonl')
const CACHE_PATH = path.join(CRUCIBLE_DIR, 'routing-cache.json')

interface MissRecord { query: string; chosen?: string[]; confidence?: number; at?: string }

function loadCache(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) } catch { return {} }
}
function saveCache(c: Record<string, string>) {
  try { fs.mkdirSync(CRUCIBLE_DIR, { recursive: true }); fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)) } catch { /* best-effort */ }
}
function keyOf(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)
}

// Public: a confirmed domain for this query (or a near-exact normalized match), if learned.
export function lookupRoutingCache(query: string): string | null {
  const c = loadCache()
  return c[keyOf(query)] ?? null
}

// Public helper so callers (or domainRouter) can record a miss explicitly.
export function logRoutingMiss(query: string, chosenDomains: string[], confidence: number): void {
  try {
    fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
    fs.appendFileSync(MISSES_PATH, JSON.stringify({ query, chosen: chosenDomains, confidence, at: new Date().toISOString() }) + '\n')
  } catch { /* best-effort */ }
}

function readMisses(limit: number): MissRecord[] {
  try {
    const lines = fs.readFileSync(MISSES_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map(l => { try { return JSON.parse(l) as MissRecord } catch { return null } }).filter(Boolean) as MissRecord[]
  } catch { return [] }
}

// Remove the first `count` processed lines from the misses log (keep the tail).
function truncateProcessedMisses(count: number): void {
  try {
    const lines = fs.readFileSync(MISSES_PATH, 'utf8').split('\n').filter(Boolean)
    const remaining = lines.slice(count)
    fs.writeFileSync(MISSES_PATH, remaining.length ? remaining.join('\n') + '\n' : '')
  } catch { /* best-effort */ }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export interface LearningCycleResult { processed: number; learned: number }

// One active-learning pass. `classify(query)` must resolve to a single domain name
// (the injected LLM classifier). Rate-limited so it never hammers the free pool.
export async function runLearningCycle(
  classify: (query: string) => Promise<string>,
  opts: { batch?: number; gapMs?: number } = {},
): Promise<LearningCycleResult> {
  const batch = opts.batch ?? 20
  const gapMs = opts.gapMs ?? 2000
  const misses = readMisses(batch)
  if (!misses.length) return { processed: 0, learned: 0 }

  const cache = loadCache()
  let learned = 0
  for (let i = 0; i < misses.length; i++) {
    const q = (misses[i].query ?? '').trim()
    if (!q) continue
    const k = keyOf(q)
    let domain = cache[k]
    if (!domain) {
      try { domain = (await classify(q))?.trim().toLowerCase().split(/\s+/)[0] || '' } catch { domain = '' }
    }
    if (domain) {
      try { learnDomainRoute(q, domain); cache[k] = domain; learned++ } catch { /* skip */ }
    }
    if (i < misses.length - 1) await sleep(gapMs)   // gentle on the free pool
  }
  saveCache(cache)
  truncateProcessedMisses(misses.length)
  return { processed: misses.length, learned }
}
