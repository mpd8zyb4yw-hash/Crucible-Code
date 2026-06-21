// Track C — LIVING CORPUS · query → domain classifier (Phase 2.1 sharding)
// Routes an incoming query to the corpus shard(s) most likely to hold the answer,
// so retrieval (query.ts) can open one or two shards instead of all ~30.
//
// PURE keyword / TF-IDF — NO model call, sub-millisecond — mirroring the style of
// classifyDomain / classifyIntent. Banding (per the spec):
//   confidence > 0.7      → single shard  (the top domain)
//   0.4 ≤ confidence ≤ 0.7 → top-2 shards
//   confidence < 0.4      → all shards, and the miss is appended to
//                           .crucible/routing-misses.jsonl for later seed tuning.
// learnDomainRoute(query, domain) persists confirmed routings k-NN-style to
// .crucible/classifier-domain-history.json; those exemplars are blended into future
// classifications so routing self-improves from real usage (no model, no retrain).

import fs from 'fs'
import path from 'path'
import { DOMAIN_SHARDS, DEFAULT_SHARD, normalizeDomain, type DomainShard } from './db.js'

const CRUCIBLE_DIR = path.resolve(process.cwd(), '.crucible')
const HISTORY_PATH = path.join(CRUCIBLE_DIR, 'classifier-domain-history.json')
const MISSES_PATH = path.join(CRUCIBLE_DIR, 'routing-misses.jsonl')

export interface DomainScore { domain: DomainShard; confidence: number }

// ── Per-domain keyword seeds (TF-IDF lexicon) ─────────────────────────────────
// Conservative, high-precision content words per shard. 'general' has no seeds —
// it's the fallback when nothing else scores. Kept in sync with db.ts DOMAIN_SHARDS.
const DOMAIN_KEYWORDS: Record<DomainShard, string[]> = {
  mathematics:        ['theorem', 'proof', 'algebra', 'calculus', 'integral', 'derivative', 'matrix', 'topology', 'geometry', 'equation', 'lemma', 'manifold', 'polynomial', 'prime'],
  physics:            ['quantum', 'relativity', 'particle', 'thermodynamics', 'electromagnetic', 'entropy', 'momentum', 'photon', 'gravity', 'field', 'wavefunction', 'spacetime'],
  chemistry:          ['molecule', 'reaction', 'compound', 'atom', 'bond', 'catalyst', 'acid', 'oxidation', 'enzyme', 'solvent', 'isomer', 'valence'],
  biology:            ['cell', 'gene', 'protein', 'evolution', 'species', 'organism', 'dna', 'mutation', 'ecosystem', 'metabolism', 'enzyme', 'chromosome'],
  'computer-science': ['algorithm', 'compiler', 'runtime', 'data structure', 'complexity', 'recursion', 'pointer', 'concurrency', 'cache', 'typescript', 'javascript', 'database', 'api', 'function'],
  'machine-learning': ['neural', 'gradient', 'training', 'embedding', 'transformer', 'model', 'inference', 'tensor', 'backprop', 'overfitting', 'classifier', 'dataset'],
  engineering:        ['design', 'tolerance', 'stress', 'load', 'circuit', 'voltage', 'material', 'fabrication', 'mechanical', 'structural', 'turbine', 'actuator'],
  networking:         ['tcp', 'packet', 'protocol', 'router', 'latency', 'http', 'tls', 'socket', 'bandwidth', 'dns', 'handshake', 'congestion'],
  'systems-theory':   ['feedback', 'homeostasis', 'equilibrium', 'subsystem', 'control loop', 'nonlinear', 'stability', 'cybernetics', 'boundary'],
  'information-theory':['entropy', 'channel', 'compression', 'encoding', 'redundancy', 'mutual information', 'bit', 'codeword', 'shannon', 'noise'],
  'formal-reasoning': ['logic', 'inference', 'predicate', 'axiom', 'deduction', 'quantifier', 'proposition', 'soundness', 'completeness', 'syllogism'],
  'complex-systems':  ['emergence', 'self-organization', 'attractor', 'chaos', 'network', 'phase transition', 'fractal', 'agent-based', 'criticality'],
  statistics:         ['probability', 'distribution', 'regression', 'variance', 'hypothesis', 'bayesian', 'sample', 'correlation', 'estimator', 'confidence interval'],
  economics:          ['market', 'supply', 'demand', 'inflation', 'gdp', 'utility', 'equilibrium', 'incentive', 'trade', 'monetary', 'fiscal', 'elasticity'],
  finance:            ['portfolio', 'asset', 'derivative', 'valuation', 'interest', 'bond', 'equity', 'hedge', 'liquidity', 'arbitrage', 'yield', 'dividend'],
  psychology:         ['behavior', 'cognition', 'memory', 'emotion', 'perception', 'motivation', 'conditioning', 'bias', 'personality', 'attachment'],
  'cognitive-science':['cognition', 'reasoning', 'attention', 'concept', 'representation', 'mental model', 'heuristic', 'consciousness', 'language'],
  neuroscience:       ['neuron', 'synapse', 'cortex', 'brain', 'axon', 'dopamine', 'neural', 'hippocampus', 'plasticity', 'receptor'],
  sociology:          ['society', 'culture', 'institution', 'norm', 'class', 'inequality', 'community', 'identity', 'socialization', 'kinship'],
  'political-science':['government', 'policy', 'election', 'democracy', 'sovereignty', 'legislation', 'state', 'power', 'constitution', 'diplomacy'],
  law:                ['statute', 'contract', 'liability', 'court', 'jurisdiction', 'rights', 'precedent', 'tort', 'plaintiff', 'regulation', 'legal'],
  medicine:           ['diagnosis', 'treatment', 'symptom', 'disease', 'patient', 'therapy', 'clinical', 'drug', 'anatomy', 'pathology', 'syndrome'],
  philosophy:         ['ethics', 'metaphysics', 'epistemology', 'consciousness', 'ontology', 'morality', 'free will', 'rationality', 'phenomenology', 'virtue'],
  history:            ['empire', 'revolution', 'war', 'dynasty', 'century', 'civilization', 'treaty', 'ancient', 'medieval', 'colonial', 'monarchy'],
  literature:         ['novel', 'poem', 'narrative', 'metaphor', 'protagonist', 'prose', 'verse', 'fiction', 'allegory', 'genre', 'rhetoric'],
  linguistics:        ['syntax', 'phoneme', 'grammar', 'semantics', 'morphology', 'language', 'dialect', 'lexicon', 'phonology', 'corpus'],
  art:                ['painting', 'sculpture', 'composition', 'color', 'aesthetic', 'baroque', 'abstract', 'canvas', 'perspective', 'visual'],
  music:              ['harmony', 'melody', 'rhythm', 'chord', 'tempo', 'scale', 'composition', 'counterpoint', 'timbre', 'orchestral'],
  geography:          ['climate', 'terrain', 'region', 'continent', 'population', 'topography', 'latitude', 'urban', 'watershed', 'biome'],
  general:            [],
}

// ── TF-IDF lexicon, computed once at module load ──────────────────────────────
// IDF over the seed "documents" (one per domain) so generic words that appear in
// many domains (e.g. "model", "field") get down-weighted vs. discriminative ones.
const DOMAINS_WITH_SEEDS = (Object.keys(DOMAIN_KEYWORDS) as DomainShard[]).filter(d => DOMAIN_KEYWORDS[d].length > 0)

const IDF: Record<string, number> = (() => {
  const df: Record<string, number> = {}
  for (const d of DOMAINS_WITH_SEEDS) {
    for (const term of new Set(DOMAIN_KEYWORDS[d])) df[term] = (df[term] ?? 0) + 1
  }
  const N = DOMAINS_WITH_SEEDS.length
  const idf: Record<string, number> = {}
  for (const [term, freq] of Object.entries(df)) idf[term] = Math.log((1 + N) / (1 + freq)) + 1
  return idf
})()

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length >= 2)
}

// Score a query against one domain's seed lexicon. Counts both single-token and
// multi-word seed hits, weighted by IDF, normalised by query length so longer
// queries don't inflate scores.
function scoreDomain(domain: DomainShard, lower: string, tokens: Set<string>): number {
  const seeds = DOMAIN_KEYWORDS[domain]
  if (seeds.length === 0) return 0
  let score = 0
  for (const seed of seeds) {
    const weight = IDF[seed] ?? 1
    if (seed.includes(' ')) {
      if (lower.includes(seed)) score += weight
    } else if (tokens.has(seed)) {
      score += weight
    }
  }
  // Normalise by query token count (diminishing): keeps confidence in 0..1-ish.
  return score / Math.sqrt(tokens.size + 2)
}

// ── Learned exemplars (k-NN over confirmed routings) ──────────────────────────
interface Exemplar { tokens: string[]; domain: DomainShard }

function loadHistory(): Exemplar[] {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
    return Array.isArray(raw) ? raw.filter(e => e && Array.isArray(e.tokens) && typeof e.domain === 'string') : []
  } catch { return [] }
}

// Jaccard similarity between two token sets — cheap, dependency-free k-NN metric.
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Blend learned exemplars into the seed scores: nearest confirmed routings vote
// for their domain, weighted by token-set similarity.
function exemplarBoost(tokens: Set<string>): Record<string, number> {
  const boost: Record<string, number> = {}
  const hist = loadHistory()
  if (hist.length === 0) return boost
  const scored = hist
    .map(e => ({ domain: e.domain, sim: jaccard(tokens, new Set(e.tokens)) }))
    .filter(x => x.sim > 0.1)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5)   // k = 5
  for (const s of scored) boost[s.domain] = (boost[s.domain] ?? 0) + s.sim
  return boost
}

// ── Public: classify a query into ranked domain shards ────────────────────────
export function classifyQueryDomain(query: string): DomainScore[] {
  const lower = query.toLowerCase()
  const tokenList = tokenize(query)
  const tokens = new Set(tokenList)

  const raw: Record<string, number> = {}
  for (const d of DOMAINS_WITH_SEEDS) raw[d] = scoreDomain(d, lower, tokens)

  // Blend in learned exemplars (self-improvement from real usage).
  const boost = exemplarBoost(tokens)
  for (const [d, b] of Object.entries(boost)) raw[d] = (raw[d] ?? 0) + b

  const ranked = (Object.entries(raw) as [DomainShard, number][])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])

  if (ranked.length === 0) {
    return [{ domain: DEFAULT_SHARD, confidence: 0 }]
  }

  // Normalise the top score into a 0..1 confidence via softmax-ish share of total.
  const total = ranked.reduce((s, [, v]) => s + v, 0)
  return ranked.map(([domain, v]) => ({ domain, confidence: Math.round((v / total) * 100) / 100 }))
}

// ── Public: which shards to query, applying the spec's confidence bands ───────
// > 0.7 → single shard; 0.4–0.7 → top-2; < 0.4 → all shards (and log the miss).
export function routeQueryToShards(query: string): { domains: string[]; scores: DomainScore[]; band: 'single' | 'top2' | 'all' } {
  const scores = classifyQueryDomain(query)
  const top = scores[0]
  if (top.confidence > 0.7) {
    return { domains: [top.domain], scores, band: 'single' }
  }
  if (top.confidence >= 0.4) {
    return { domains: scores.slice(0, 2).map(s => s.domain), scores, band: 'top2' }
  }
  // Low confidence — fan out to all shards and record the miss for seed tuning.
  recordRoutingMiss(query, scores)
  return { domains: [...DOMAIN_SHARDS], scores, band: 'all' }
}

function recordRoutingMiss(query: string, scores: DomainScore[]): void {
  try {
    fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
    const line = JSON.stringify({
      at: new Date().toISOString(),
      query: query.slice(0, 300),
      top: scores.slice(0, 3),
    }) + '\n'
    fs.appendFileSync(MISSES_PATH, line)
  } catch { /* best-effort logging — never block retrieval */ }
}

// ── Public: persist a confirmed routing (k-NN exemplar) ───────────────────────
// Call after a query was successfully answered from `domain`'s shard, so future
// similar queries route there with higher confidence. Bounded history (keeps the
// most recent N) so the file never grows unbounded.
const MAX_HISTORY = 2000
export function learnDomainRoute(query: string, domain: string): void {
  try {
    const norm = normalizeDomain(domain)
    const tokens = [...new Set(tokenize(query))].slice(0, 24)
    if (tokens.length === 0) return
    const hist = loadHistory()
    hist.push({ tokens, domain: norm })
    const trimmed = hist.length > MAX_HISTORY ? hist.slice(hist.length - MAX_HISTORY) : hist
    fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(trimmed))
  } catch { /* best-effort persistence */ }
}
