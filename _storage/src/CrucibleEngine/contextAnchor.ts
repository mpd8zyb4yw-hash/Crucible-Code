// Context anchor — immutable ground-truth store for long-running tasks.
// The original prompt is the anchor: everything the system produces should
// be traceable back to it. After each compression, a semantic diff checks
// whether the compressed state has lost coverage of the original.
//
// Discrepancy weight table:
//   SEMANTIC_DRIFT (Jaccard < 0.65)   → ignored (paraphrasing is fine)
//   SEMANTIC_DRIFT (Jaccard >= 0.65)  → weight 0.3–0.8 based on magnitude
//   MISSING_ENTITY                    → weight 0.6 → triggers injection patch
//   MISSING_REQUIREMENT               → weight 0.9 → triggers pause + re-anchor
//   CONTRADICTION                     → weight 0.85 → triggers counterfactualBranch
//
// Uses local TF cosine similarity for semantic comparison (free-tier safe),
// and named entity / requirement extraction for fact coverage.

export type DiscrepancyType =
  | 'SEMANTIC_DRIFT'
  | 'MISSING_ENTITY'
  | 'MISSING_REQUIREMENT'
  | 'CONTRADICTION'

export interface Discrepancy {
  type: DiscrepancyType
  weight: number       // 0-1: severity; drives which action fires
  details: string      // human-readable description of what is missing/drifted
}

export interface AnchorRecord {
  id: string
  original: string        // original goal — immutable
  entities: string[]      // named entities, numbers, paths extracted from original
  requirements: string[]  // explicit requirement sentences ("must", "should", etc.)
  vector: Map<string, number>  // TF vector of original for cosine similarity
}

export interface DiscrepancyReport {
  discrepancies: Discrepancy[]
  semanticDrift: number          // 0-1 Jaccard distance between original and compressed
  missingEntities: string[]
  missingRequirements: string[]
  // Derived action from highest-weight discrepancy
  action: 'ignore' | 'inject_entities' | 're_anchor' | 'flag_contradiction'
  patch: string                  // ready-to-inject block; empty when action='ignore'
}

// In-memory anchor store — one record per active agent loop invocation
const anchors = new Map<string, AnchorRecord>()

// --- local embedding (TF cosine, free-tier safe) ----------------------------

function tokenize(text: string): string[] {
  const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have',
    'will', 'your', 'are', 'not', 'but', 'can', 'its', 'was', 'you', 'they'])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w))
}

function buildVector(text: string): Map<string, number> {
  const tokens = tokenize(text)
  const freq = new Map<string, number>()
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  const total = tokens.length || 1
  const vec = new Map<string, number>()
  for (const [t, n] of freq) vec.set(t, n / total)
  return vec
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, magA = 0, magB = 0
  for (const [t, v] of a) { dot += v * (b.get(t) ?? 0); magA += v * v }
  for (const v of b.values()) magB += v * v
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom ? dot / denom : 0
}

function jaccardDistance(a: string, b: string): number {
  const words = (t: string) =>
    new Set(tokenize(t).filter(w => w.length > 3))
  const wa = words(a)
  const wb = words(b)
  const intersection = [...wa].filter(w => wb.has(w)).length
  const union = new Set([...wa, ...wb]).size
  return union ? 1 - intersection / union : 0
}

// --- entity & requirement extraction ----------------------------------------

function extractEntities(text: string): string[] {
  const results: string[] = []

  // Numbers with optional units
  const nums = text.match(/\b\d+(?:\.\d+)?(?:\s*(?:ms|px|kb|mb|gb|%|s\b|h\b|m\b))?\b/g) ?? []
  results.push(...nums.filter(n => n.length > 1))

  // Capitalized words (proper nouns, class/function names)
  const skipWords = new Set([
    'The', 'This', 'That', 'When', 'With', 'From', 'Into', 'Upon', 'Over', 'Under',
    'After', 'Before', 'Should', 'Could', 'Would', 'Every', 'Each', 'Some', 'None',
    'More', 'Most', 'Also', 'Then', 'Thus', 'Here', 'There', 'Just', 'Only',
  ])
  const caps = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? []
  results.push(...caps.filter(c => !skipWords.has(c)))

  // File paths and extensions
  const paths = text.match(/(?:~\/|\.\/|\/)[^\s,'"]{2,}|[\w-]+\.[a-z]{2,5}\b/g) ?? []
  results.push(...paths)

  return [...new Set(results)].slice(0, 30)
}

function extractRequirements(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/)
  return sentences
    .filter(s => /\b(must|should|ensure|never|always|require|need to|has to|have to|do not|don't)\b/i.test(s))
    .map(s => s.trim().slice(0, 120))
    .filter(s => s.length > 15)
    .slice(0, 10)
}

// --- public API -------------------------------------------------------------

export function createAnchor(anchorId: string, originalPrompt: string): AnchorRecord {
  const record: AnchorRecord = {
    id: anchorId,
    original: originalPrompt,
    entities: extractEntities(originalPrompt),
    requirements: extractRequirements(originalPrompt),
    vector: buildVector(originalPrompt),
  }
  anchors.set(anchorId, record)
  return record
}

export function getAnchor(anchorId: string): AnchorRecord | undefined {
  return anchors.get(anchorId)
}

export function deleteAnchor(anchorId: string): void {
  anchors.delete(anchorId)
}

// Core discrepancy analysis — returns typed Discrepancy[] with weight scores.
// SEMANTIC_DRIFT < 0.65 Jaccard is ignored per spec.
export function diffAgainstAnchor(anchorId: string, compressedState: string): Discrepancy[] {
  const anchor = anchors.get(anchorId)
  if (!anchor) return []

  const discrepancies: Discrepancy[] = []
  const summaryLower = compressedState.toLowerCase()

  // ── Semantic drift via Jaccard + cosine ──────────────────────────────────
  const jaccard = jaccardDistance(anchor.original, compressedState)
  const compressedVec = buildVector(compressedState)
  const cosSim = cosineSim(anchor.vector, compressedVec)
  // Use average of both metrics for robustness
  const driftScore = (jaccard + (1 - cosSim)) / 2

  if (jaccard >= 0.65) {
    // Contradictory drift (very high distance + low cosine overlap)
    if (driftScore > 0.75 && cosSim < 0.15) {
      discrepancies.push({
        type: 'CONTRADICTION',
        weight: Math.min(0.95, 0.85 + (driftScore - 0.75)),
        details: `Compressed state diverged strongly from original (Jaccard ${jaccard.toFixed(2)}, cosine ${cosSim.toFixed(2)})`,
      })
    } else {
      // Regular semantic drift — flagged but lower weight
      const w = 0.3 + (jaccard - 0.65) * (0.5 / 0.35)  // 0.3 at 0.65, 0.8 at 1.0
      discrepancies.push({
        type: 'SEMANTIC_DRIFT',
        weight: parseFloat(Math.min(0.8, w).toFixed(3)),
        details: `Semantic drift ${(jaccard * 100).toFixed(0)}% (cosine similarity ${(cosSim * 100).toFixed(0)}%)`,
      })
    }
  }
  // Jaccard < 0.65 → ignore (paraphrasing is fine, per spec)

  // ── Missing entities ─────────────────────────────────────────────────────
  const missingEntities = anchor.entities.filter(e => !summaryLower.includes(e.toLowerCase()))
  if (missingEntities.length > 0) {
    // Weight scales with how many are missing
    const ratio = missingEntities.length / Math.max(anchor.entities.length, 1)
    discrepancies.push({
      type: 'MISSING_ENTITY',
      weight: parseFloat(Math.min(0.9, 0.5 + ratio * 0.4).toFixed(3)),
      details: `Missing entities: ${missingEntities.slice(0, 6).join(', ')}${missingEntities.length > 6 ? '…' : ''}`,
    })
  }

  // ── Missing requirements ─────────────────────────────────────────────────
  const missingRequirements = anchor.requirements.filter(req => {
    const keyWords = req
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !/^(must|should|ensure|never|always|require|needs|have)$/.test(w))
    if (!keyWords.length) return false
    const covered = keyWords.filter(w => summaryLower.includes(w)).length
    return covered < keyWords.length * 0.5
  })
  if (missingRequirements.length > 0) {
    discrepancies.push({
      type: 'MISSING_REQUIREMENT',
      weight: parseFloat(Math.min(0.95, 0.75 + missingRequirements.length * 0.05).toFixed(3)),
      details: `Missing requirements: ${missingRequirements.length} of ${anchor.requirements.length}`,
    })
  }

  return discrepancies
}

// Validate a compressed summary against the stored anchor.
// Wraps diffAgainstAnchor and returns legacy DiscrepancyReport for backward compat.
export function validateCompression(anchorId: string, compressedSummary: string): DiscrepancyReport {
  const anchor = anchors.get(anchorId)
  if (!anchor) {
    return { discrepancies: [], semanticDrift: 0, missingEntities: [], missingRequirements: [], action: 'ignore', patch: '' }
  }

  const discrepancies = diffAgainstAnchor(anchorId, compressedSummary)
  const semanticDrift = jaccardDistance(anchor.original, compressedSummary)
  const summaryLower = compressedSummary.toLowerCase()
  const missingEntities = anchor.entities.filter(e => !summaryLower.includes(e.toLowerCase()))
  const missingRequirements = anchor.requirements.filter(req => {
    const keyWords = req.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
      .filter(w => w.length > 4 && !/^(must|should|ensure|never|always|require|needs|have)$/.test(w))
    if (!keyWords.length) return false
    return keyWords.filter(w => summaryLower.includes(w)).length < keyWords.length * 0.5
  })

  // Derive action from highest-weight discrepancy
  const sorted = [...discrepancies].sort((a, b) => b.weight - a.weight)
  const top = sorted[0]
  let action: DiscrepancyReport['action'] = 'ignore'
  if (top) {
    if (top.type === 'MISSING_REQUIREMENT') action = 're_anchor'
    else if (top.type === 'MISSING_ENTITY') action = 'inject_entities'
    else if (top.type === 'CONTRADICTION') action = 'flag_contradiction'
  }

  let patch = ''
  if (action === 'inject_entities' && missingEntities.length > 0) {
    patch = [
      `[ANCHOR PATCH — recovering entities lost in context compression]`,
      `The following facts from the original task must be preserved in your answer:`,
      missingEntities.map(e => `  - ${e}`).join('\n'),
    ].join('\n')
  } else if (action === 're_anchor' && missingRequirements.length > 0) {
    patch = [
      `[ANCHOR RE-INJECT — requirements dropped in context compression]`,
      `These requirements from the original task are still in effect:`,
      missingRequirements.map(r => `  - ${r}`).join('\n'),
      `\nOriginal task (first 400 chars): ${anchor.original.slice(0, 400)}`,
    ].join('\n')
  } else if (action === 'flag_contradiction') {
    patch = [
      `[ANCHOR FLAG — high semantic drift from original task; counterfactual branch triggered]`,
      `The compressed context has diverged significantly from the original task. Verify your direction.`,
      `Original task: ${anchor.original.slice(0, 300)}`,
    ].join('\n')
  }

  return {
    discrepancies,
    semanticDrift: parseFloat(semanticDrift.toFixed(3)),
    missingEntities,
    missingRequirements,
    action,
    patch,
  }
}
