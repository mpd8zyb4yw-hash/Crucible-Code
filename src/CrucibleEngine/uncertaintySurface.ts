// Uncertainty surface (Track H2) — per-topic uncertainty map built from
// confidence calibration history. When a new query arrives, its cluster is
// looked up; if that cluster has historically low calibration the pipeline
// routes harder (force full, inject flag, lower early-exit threshold).

import fs from 'fs'
import path from 'path'
import { debugBus } from './debug/bus'

export interface ClusterCalibration {
  clusterId: string
  clusterLabel: string
  sampleCount: number
  meanCalibrationScore: number   // EMA of overallScore values
  lastUpdated: number
}

export interface UncertaintySurface {
  clusters: ClusterCalibration[]
  updatedAt: number
}

export interface UncertaintyLookupResult {
  clusterId: string | null
  clusterLabel: string | null
  meanCalibrationScore: number | null
  isLowConfidence: boolean       // true → route harder
  injectionFlag: string | null   // block to inject into synthesis prompt
  forceFullPipeline: boolean
  lowerEarlyExitThreshold: boolean
}

const SURFACE_FILE = (dir: string) => path.join(dir, '.crucible', 'uncertainty-surface.json')
const LOW_CONFIDENCE_THRESHOLD = 0.55   // cluster mean below this → low-confidence routing
const EMA_ALPHA = 0.25                  // how fast cluster calibration updates

function loadSurface(dir: string): UncertaintySurface {
  try { return JSON.parse(fs.readFileSync(SURFACE_FILE(dir), 'utf8')) } catch { return { clusters: [], updatedAt: 0 } }
}

function saveSurface(dir: string, surface: UncertaintySurface) {
  fs.mkdirSync(path.dirname(SURFACE_FILE(dir)), { recursive: true })
  fs.writeFileSync(SURFACE_FILE(dir), JSON.stringify(surface, null, 2))
}

// Lightweight vectorizer — must match specializationDetector.ts for cluster lookup
function vectorize(text: string): number[] {
  const tokens = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  const freq: Record<string, number> = {}
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1
  const dim = 20
  const vec = new Array(dim).fill(0)
  for (const [word, count] of Object.entries(freq)) {
    let h = 0
    for (let i = 0; i < word.length; i++) h = (h * 31 + word.charCodeAt(i)) >>> 0
    vec[h % dim] += count
  }
  const n = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map(x => x / n)
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// Called after every pipeline round — updates calibration EMA for the matched cluster
export function recordCalibrationForQuery(
  dir: string,
  query: string,
  overallScore: number,
  requestId?: string
) {
  // Load current clusters (written by detectEmergentClusters in specializationDetector)
  let queryClusters: any[] = []
  try {
    queryClusters = JSON.parse(fs.readFileSync(path.join(dir, '.crucible', 'query-clusters.json'), 'utf8'))
  } catch { return }

  if (!queryClusters.length) return

  // Find closest cluster by cosine similarity
  const qVec = vectorize(query)
  let bestCluster = queryClusters[0]
  let bestSim = -Infinity
  for (const c of queryClusters) {
    const sim = cosineSim(qVec, c.centroid)
    if (sim > bestSim) { bestSim = sim; bestCluster = c }
  }

  // Min similarity to associate — avoids polluting unrelated clusters
  if (bestSim < 0.1) return

  const surface = loadSurface(dir)
  const existing = surface.clusters.find(c => c.clusterId === bestCluster.id)
  if (existing) {
    existing.meanCalibrationScore = existing.meanCalibrationScore * (1 - EMA_ALPHA) + overallScore * EMA_ALPHA
    existing.sampleCount += 1
    existing.lastUpdated = Date.now()
    existing.clusterLabel = bestCluster.label
  } else {
    surface.clusters.push({
      clusterId: bestCluster.id,
      clusterLabel: bestCluster.label,
      sampleCount: 1,
      meanCalibrationScore: overallScore,
      lastUpdated: Date.now(),
    })
  }
  surface.updatedAt = Date.now()
  saveSurface(dir, surface)

  debugBus.emit('pipeline', 'uncertainty_surface_updated', {
    clusterId: bestCluster.id,
    clusterLabel: bestCluster.label,
    newMean: parseFloat((existing?.meanCalibrationScore ?? overallScore).toFixed(3)),
    sampleCount: (existing?.sampleCount ?? 1),
  }, { severity: 'info', requestId })
}

// Cold-start: topics known to be high-risk for confident wrongness before cluster history builds
const COLD_START_DOMAINS = [
  // politics / policy
  'election', 'vote', 'democrat', 'republican', 'congress', 'senate', 'parliament', 'policy',
  'politician', 'president', 'prime minister', 'legislation', 'ballot',
  // future predictions
  'will happen', 'will be', 'prediction', 'forecast', 'by 2030', 'by 2025', 'future of',
  'going to', 'projected', 'expected to',
  // specific statistics
  'percent of', 'percentage of', 'statistics show', 'studies show', 'according to data',
  'survey found', 'research shows', 'unemployment rate', 'inflation rate', 'gdp',
  // medical
  'diagnosis', 'treatment for', 'cure for', 'symptoms of', 'medication', 'drug interaction',
  'clinical trial', 'side effects', 'dosage', 'medical advice',
  // legal
  'is it legal', 'legal advice', 'law says', 'court ruled', 'precedent', 'lawsuit',
  'liable', 'attorney', 'criminal charge', 'contract law',
]

function isColdStartRisky(query: string): boolean {
  const q = query.toLowerCase()
  return COLD_START_DOMAINS.some(kw => q.includes(kw))
}

const NULL_RESULT: UncertaintyLookupResult = {
  clusterId: null, clusterLabel: null, meanCalibrationScore: null,
  isLowConfidence: false, injectionFlag: null, forceFullPipeline: false, lowerEarlyExitThreshold: false,
}

// Called before Stage 1 — returns routing instructions for this query
export function lookupUncertainty(dir: string, query: string, requestId?: string): UncertaintyLookupResult {
  // Cold-start: apply known-risky domain routing before any cluster history exists
  if (isColdStartRisky(query)) {
    const surface = loadSurface(dir)
    const hasHistory = surface.clusters.some(c => c.sampleCount >= 3)
    if (!hasHistory) {
      debugBus.emit('pipeline', 'uncertainty_cold_start', { query: query.slice(0, 60) }, { severity: 'warn', requestId })
      return {
        clusterId: null,
        clusterLabel: 'cold-start domain',
        meanCalibrationScore: null,
        isLowConfidence: true,
        injectionFlag: '[UNCERTAINTY NOTE: This question touches a domain (politics, predictions, statistics, medical, or legal) where AI systems are prone to confident wrongness. Apply extra care, flag uncertain assertions explicitly, and avoid stating contested claims as fact.]',
        forceFullPipeline: true,
        lowerEarlyExitThreshold: true,
      }
    }
  }

  const surface = loadSurface(dir)
  if (!surface.clusters.length) return NULL_RESULT

  let queryClusters: any[] = []
  try {
    queryClusters = JSON.parse(fs.readFileSync(path.join(dir, '.crucible', 'query-clusters.json'), 'utf8'))
  } catch {}

  if (!queryClusters.length) return NULL_RESULT

  const qVec = vectorize(query)
  let bestCluster = queryClusters[0]
  let bestSim = -Infinity
  for (const c of queryClusters) {
    const sim = cosineSim(qVec, c.centroid)
    if (sim > bestSim) { bestSim = sim; bestCluster = c }
  }

  if (bestSim < 0.1) return NULL_RESULT

  const record = surface.clusters.find(c => c.clusterId === bestCluster.id)
  if (!record || record.sampleCount < 3) {
    // Not enough history to make routing decisions
    return { clusterId: bestCluster.id, clusterLabel: bestCluster.label, meanCalibrationScore: null,
             isLowConfidence: false, injectionFlag: null, forceFullPipeline: false, lowerEarlyExitThreshold: false }
  }

  const isLow = record.meanCalibrationScore < LOW_CONFIDENCE_THRESHOLD
  const injectionFlag = isLow
    ? `[UNCERTAINTY NOTE: This question falls in a topic area where the system has historically shown lower confidence (mean calibration ${Math.round(record.meanCalibrationScore * 100)}%). Apply extra care, avoid overconfident claims, and flag any uncertain assertions explicitly.]`
    : null

  if (isLow) {
    debugBus.emit('pipeline', 'uncertainty_routing', {
      clusterId: record.clusterId,
      clusterLabel: record.clusterLabel,
      meanCalibrationScore: record.meanCalibrationScore,
      sampleCount: record.sampleCount,
      action: 'force_full_pipeline',
    }, { severity: 'warn', requestId })
  }

  return {
    clusterId: record.clusterId,
    clusterLabel: record.clusterLabel,
    meanCalibrationScore: record.meanCalibrationScore,
    isLowConfidence: isLow,
    injectionFlag,
    forceFullPipeline: isLow,
    lowerEarlyExitThreshold: isLow,
  }
}

export function getSurface(dir: string): UncertaintySurface {
  return loadSurface(dir)
}
