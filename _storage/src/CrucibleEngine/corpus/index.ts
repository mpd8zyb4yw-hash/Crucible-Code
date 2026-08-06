// Track C — LIVING CORPUS · public entry point + startup orchestration
//
// initCorpus() is called once at server startup. It starts the lifecycle manager,
// runs an initial gap audit, and kicks a deliberate acquisition cycle in the
// BACKGROUND (never blocks request handling — invariant #5). The corpus fills
// toward its deliberately-curated target allocation; the lifecycle refines it.

import { CorpusLifecycle, auditGaps, corpusSummary, type SupersessionDeps } from './lifecycle.js'
import { acquireDeliberately, type AcquireOptions } from './acquire.js'
import { chunkCount, totalContentBytes, domainDistribution } from './db.js'
import type { IngestDeps } from './ingest.js'

export { queryLivingCorpus, expandByRelationships, recordRetrievalOutcome, type CorpusHit } from './query.js'
export { corpusSummary, CorpusLifecycle, auditGaps } from './lifecycle.js'
export { acquireDeliberately } from './acquire.js'
export * from './db.js'

export type CorpusDeps = IngestDeps & SupersessionDeps

let _acquiring = false

// Kick a deliberate acquisition cycle in the background. Idempotent (content-hash
// chunk ids + dedup make re-ingestion safe). Never throws to the caller.
export function startAcquisition(deps: CorpusDeps, opts: AcquireOptions = {}): void {
  if (_acquiring) return
  _acquiring = true
  void acquireDeliberately(deps, opts)
    .catch(e => console.error('[CORPUS] acquisition error (non-blocking):', e?.message))
    .finally(() => { _acquiring = false })
}

export function isAcquiring(): boolean { return _acquiring }

// Called once at server startup.
export function initCorpus(deps: CorpusDeps, opts: { autoAcquire?: boolean; byteBudget?: number } = {}): void {
  CorpusLifecycle.setDeps(deps)
  CorpusLifecycle.start()

  const bytes = totalContentBytes()
  const chunks = chunkCount('active')
  const domains = domainDistribution().length
  console.log(`[CORPUS] Living corpus: ${chunks} active chunks, ${(bytes / 1_048_576).toFixed(2)}MB, ${domains} domains`)

  // Initial gap analysis.
  try {
    const gaps = auditGaps()
    const top = gaps.slice(0, 3).map(g => g.domain)
    console.log(`[CORPUS] Gap analysis complete — top gaps: ${top.join(', ')}`)
  } catch (e: any) {
    console.error('[CORPUS] initial gap audit failed:', e?.message)
  }

  // Background acquisition toward the deliberate allocation (off the request path).
  if (opts.autoAcquire) {
    console.log('[CORPUS] Starting background deliberate-curation acquisition...')
    startAcquisition(deps, { byteBudget: opts.byteBudget, relationshipBudget: 150 })
  }
}

export function corpusStatus() {
  const summary = corpusSummary()
  return {
    ...summary,
    activeChunks: chunkCount('active'),
    archivedChunks: chunkCount('archived'),
    quarantinedChunks: chunkCount('quarantined'),
    supersededChunks: chunkCount('superseded'),
    acquiring: _acquiring,
    targetBytes: 1_073_741_824,
    progressPct: +((totalContentBytes() / 1_073_741_824) * 100).toFixed(3),
  }
}
