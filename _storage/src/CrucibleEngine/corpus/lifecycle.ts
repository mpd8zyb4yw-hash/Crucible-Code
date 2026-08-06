// Track C — LIVING CORPUS · dynamic lifecycle management
// The corpus grows toward what matters and sheds what doesn't — WITHOUT ever
// permanently destroying anything. Chunks are archived/superseded, never deleted.
//
// Runs as background jobs (weekly shedding + weekly gap audit). All decisions are
// written to governance_log for a full audit trail.

import {
  getActiveChunks, setStatus, logGovernance, domainDistribution,
  totalContentBytes, upsertCoverageGap, getCoverageGaps, getCorpusDb,
  type IngestedChunk,
} from './db.js'

// ── Staleness decay ───────────────────────────────────────────────────────────
export const STALENESS_HALF_LIVES: Record<string, number> = {
  permanent: Infinity,        // mathematical theorems
  scientific: 10 * 365,       // days — scientific consensus
  engineering: 3 * 365,       // engineering best practice
  technology: 548,            // 18 months — technology specifics
  current: 30,                // current events
}

export function effectiveConfidence(chunk: IngestedChunk): number {
  if (chunk.stalenessClass === 'permanent') return chunk.confidence
  const ageInDays = (Date.now() - new Date(chunk.ingestedAt).getTime()) / 86_400_000
  const halfLife = STALENESS_HALF_LIVES[chunk.stalenessClass] ?? STALENESS_HALF_LIVES.engineering
  const decayFactor = Math.pow(0.5, ageInDays / halfLife)
  return chunk.confidence * decayFactor
}

// ── Retention score ───────────────────────────────────────────────────────────
export function retentionScore(chunk: IngestedChunk): number {
  return (
    effectiveConfidence(chunk) * 0.40 +
    chunk.retrievalValue      * 0.35 +
    chunk.uniquenessScore     * 0.25
  )
}

// ── Natural shedding (weekly) ─────────────────────────────────────────────────
// Chunks with retention < 0.15 AND older than 90 days → archive. Never deleted;
// content + embedding + relationships are retained and remain recoverable.
const SHED_THRESHOLD = 0.15
const SHED_MIN_AGE_DAYS = 90

export function runShedding(): { archived: number } {
  const active = getActiveChunks()
  let archived = 0
  for (const c of active) {
    const ageDays = (Date.now() - new Date(c.ingestedAt).getTime()) / 86_400_000
    if (ageDays < SHED_MIN_AGE_DAYS) continue
    if (retentionScore(c) >= SHED_THRESHOLD) continue
    setStatus(c.id, 'archived', `shed: retention ${retentionScore(c).toFixed(3)} < ${SHED_THRESHOLD} after ${Math.round(ageDays)}d`)
    logGovernance('archive', c.id, `natural shedding — retention ${retentionScore(c).toFixed(3)}`)
    archived++
  }
  if (archived) console.log(`[CORPUS] Shedding: archived ${archived} low-retention chunk(s) (recoverable)`)
  return { archived }
}

// ── Supersession detection ────────────────────────────────────────────────────
// On ingestion (or a periodic pass), if a new chunk CONTRADICTS an existing
// high-confidence chunk with confidence > 0.7, archive the old one as superseded.
// Both remain queryable; the superseded one is labelled in query results.
export interface SupersessionDeps {
  callModel?: (m: { id: string; label: string; provider: string; isWildcard: boolean }, msgs: { role: string; content: string }[], opts?: { requestId?: string }) => Promise<string>
  pickFastModel?: () => { id: string; label: string; provider: string; isWildcard: boolean } | null
}

const CONTRADICT_SYSTEM = `You judge whether a NEW claim contradicts an ESTABLISHED claim (not merely differs in scope). Return ONLY JSON: {"contradicts": true|false, "confidence": 0.0-1.0}. contradicts=true only for genuine factual conflict where both cannot be correct.`

export async function checkSupersession(
  newChunk: IngestedChunk,
  candidates: IngestedChunk[],
  deps: SupersessionDeps,
): Promise<{ superseded: string[] }> {
  const superseded: string[] = []
  if (!deps.callModel || !deps.pickFastModel) return { superseded }
  const model = deps.pickFastModel()
  if (!model) return { superseded }

  // Only test against high-confidence established chunks.
  const established = candidates.filter(c => effectiveConfidence(c) > 0.7 && c.id !== newChunk.id).slice(0, 3)
  for (const old of established) {
    try {
      const raw = await deps.callModel(model, [
        { role: 'system', content: CONTRADICT_SYSTEM },
        { role: 'user', content: `ESTABLISHED:\n${old.content.slice(0, 500)}\n\nNEW:\n${newChunk.content.slice(0, 500)}` },
      ])
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const v: { contradicts?: boolean; confidence?: number } = JSON.parse(cleaned)
      if (v.contradicts && (v.confidence ?? 0) > 0.7) {
        // The NEWER chunk supersedes the OLDER one (assumes newer = more current).
        setStatus(old.id, 'superseded', `superseded by ${newChunk.id} (contradiction conf ${v.confidence})`, newChunk.id)
        logGovernance('supersede', old.id, `superseded by ${newChunk.id} — contradiction confidence ${v.confidence}`)
        superseded.push(old.id)
      }
    } catch { /* best-effort */ }
  }
  return { superseded }
}

// ── Gap detection (weekly audit) ──────────────────────────────────────────────
// Target domain allocation (deliberate curation, per the Track C spec priorities).
// Gap priority = deficit vs target × domain importance, plus any observed query
// miss rate from the retrieval log.
export const TARGET_ALLOCATION: Record<string, number> = {
  philosophy: 0.10, psychology: 0.05, physics: 0.08, mathematics: 0.08,
  biology: 0.06, economics: 0.05, 'computer-science': 0.10, engineering: 0.08,
  'systems-theory': 0.06, 'information-theory': 0.05, history: 0.06,
  'formal-reasoning': 0.06, networking: 0.05, 'cognitive-science': 0.04,
  'complex-systems': 0.03,
}

export interface CoverageGap {
  domain: string
  chunkCount: number
  share: number
  targetShare: number
  queryMissRate: number
  priorityScore: number
}

export function auditGaps(): CoverageGap[] {
  const dist = domainDistribution()
  const total = dist.reduce((s, d) => s + d.count, 0) || 1
  const countByDomain: Record<string, number> = {}
  for (const d of dist) countByDomain[d.domain] = d.count

  // Query miss rate per domain from the retrieval log: a logged retrieval with
  // outcome_confidence below 0.3 counts as a "miss" for that chunk's domain.
  const missRows = getCorpusDb().prepare(`
    SELECT c.domain AS domain,
           AVG(CASE WHEN r.outcome_confidence IS NOT NULL AND r.outcome_confidence < 0.3 THEN 1.0 ELSE 0.0 END) AS miss_rate
    FROM retrieval_log r JOIN chunks c ON c.id = r.chunk_id
    GROUP BY c.domain
  `).all() as Array<{ domain: string; miss_rate: number }>
  const missByDomain: Record<string, number> = {}
  for (const m of missRows) missByDomain[m.domain] = m.miss_rate ?? 0

  const gaps: CoverageGap[] = []
  for (const [domain, targetShare] of Object.entries(TARGET_ALLOCATION)) {
    const chunkCount = countByDomain[domain] ?? 0
    const share = chunkCount / total
    const deficit = Math.max(0, targetShare - share)
    const queryMissRate = missByDomain[domain] ?? 0
    // Priority: deficit (weighted by target importance) + observed miss rate.
    const priorityScore = deficit * (1 + targetShare * 2) + queryMissRate * 0.5
    gaps.push({ domain, chunkCount, share, targetShare, queryMissRate, priorityScore })
    upsertCoverageGap({ domain, chunkCount, queryMissRate, priorityScore })
  }
  gaps.sort((a, b) => b.priorityScore - a.priorityScore)
  return gaps
}

// ── Background lifecycle manager ──────────────────────────────────────────────
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

let _started = false
let _supersessionDeps: SupersessionDeps = {}

export const CorpusLifecycle = {
  setDeps(deps: SupersessionDeps) { _supersessionDeps = deps },

  start(): void {
    if (_started) return
    _started = true
    // Weekly shedding.
    setInterval(() => { try { runShedding() } catch (e: any) { console.error('[CORPUS] shedding error:', e?.message) } }, WEEK_MS)
    // Weekly gap audit — top-3 gaps flagged for the next acquisition cycle.
    setInterval(() => {
      try {
        const gaps = auditGaps()
        const top = gaps.filter(g => g.priorityScore > 0).slice(0, 3)
        if (top.length) console.log(`[CORPUS] Weekly gap audit — top gaps: ${top.map(g => `${g.domain} (${(g.share * 100).toFixed(1)}%)`).join(', ')}`)
      } catch (e: any) { console.error('[CORPUS] gap audit error:', e?.message) }
    }, WEEK_MS)
    console.log('[CORPUS] Lifecycle manager started (weekly shedding + gap audit)')
  },

  auditGaps,
  runShedding,
  get deps() { return _supersessionDeps },
}

export function corpusSummary() {
  const dist = domainDistribution()
  const bytes = totalContentBytes()
  return {
    totalBytes: bytes,
    totalMB: +(bytes / 1_048_576).toFixed(2),
    domains: dist.length,
    distribution: dist,
    gaps: getCoverageGaps(),
  }
}
