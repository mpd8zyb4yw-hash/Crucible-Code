// ── Corpus-First Answer Gate — Offline-First (Track O, Layer 1) ──────────────
//
// Before the model pipeline runs, ask: can we answer this purely from our own
// knowledge? If the living corpus covers the question well, we synthesize the answer
// on-device (Apple FM daemon) from the retrieved passages — ZERO external API. This
// is the layer that makes the ~20GB corpus do real work toward a fully-offline agent.
//
// HIGH PRECISION over recall: the gate only fires when coverage is genuinely strong
// (a high-similarity top hit AND corroboration from a second passage) AND on-device
// synthesis is available. Anything short of that returns null and the normal pipeline
// runs — so a thin corpus simply means the gate rarely fires, never a wrong answer.

import { queryLivingCorpus, type CorpusHit } from './query.js'

export interface CorpusFirstSource {
  domain: string
  source: string
  similarity: number
}

export interface CorpusFirstAnswer {
  answer: string
  sources: CorpusFirstSource[]
  confidence: number
}

export interface CorpusFirstOpts {
  /** On-device synthesis (Apple FM daemon). Required — no external API here. */
  localSynth: (systemPrompt: string, userMessage: string) => Promise<string>
  /** Minimum similarity for the top hit to consider answering. Default 0.55. */
  minTopSimilarity?: number
  /** Minimum similarity for a hit to count toward corroboration. Default 0.45. */
  corroborationSimilarity?: number
}

// Prompt types worth answering from a general-knowledge corpus. Creative wants
// generation (not recall); coding is about the user's own code, not the corpus.
const ANSWERABLE_TYPES = new Set(['factual', 'reasoning', 'math', 'general'])

// Signals that the query needs fresh/current information the corpus can't have.
const TIME_SENSITIVE = /\b(today|tonight|now|current(ly)?|latest|recent(ly)?|this (week|month|year)|right now|breaking|news|price|weather|stock|score|2024|2025|2026)\b/i

/**
 * Attempt to answer `message` from the living corpus alone, synthesized on-device.
 * Returns null when coverage is insufficient or the query isn't corpus-answerable —
 * the caller then falls through to the normal model pipeline.
 */
export async function corpusFirstAnswer(
  message: string,
  promptType: string,
  opts: CorpusFirstOpts,
): Promise<CorpusFirstAnswer | null> {
  const q = (message ?? '').trim()
  if (q.length < 8 || q.length > 400) return null
  if (!ANSWERABLE_TYPES.has(promptType)) return null
  if (TIME_SENSITIVE.test(q)) return null

  const minTop = opts.minTopSimilarity ?? 0.55
  const corrob = opts.corroborationSimilarity ?? 0.45

  let hits: CorpusHit[]
  try {
    hits = await queryLivingCorpus(q, { topK: 6, minSimilarity: 0.3 })
  } catch {
    return null
  }
  if (hits.length === 0) return null

  // Coverage gate: a strong top hit AND a second corroborating passage, OR a single
  // very-high-confidence hit (≥ 0.72). Otherwise the corpus doesn't really know this.
  const top = hits[0].similarity
  const corroborating = hits.filter(h => h.similarity >= corrob).length
  const strongEnough = (top >= minTop && corroborating >= 2) || top >= 0.72
  if (!strongEnough) return null

  // Build a grounded context from the qualifying passages only.
  const used = hits.filter(h => h.similarity >= corrob).slice(0, 5)
  if (used.length === 0) return null
  const context = used
    .map((h, i) => `[${i + 1}] (${h.chunk.domain}) ${h.chunk.content.trim()}`)
    .join('\n\n')

  const systemPrompt =
    'You are answering strictly from the provided reference passages drawn from a curated ' +
    'knowledge corpus. Use ONLY the information in the passages. If the passages do not ' +
    'contain enough to answer fully, say what they do support and note the limit — do NOT ' +
    'invent facts. Be direct and concise. Do not mention "passages" or "context" in your answer.'
  const userMessage = `Reference passages:\n\n${context}\n\n---\n\nQuestion: ${q}\n\nAnswer using only the passages above:`

  let answer: string
  try {
    answer = (await opts.localSynth(systemPrompt, userMessage)).trim()
  } catch {
    return null
  }
  // If on-device synthesis produced nothing usable, fall through to the pipeline.
  if (!answer || answer.length < 20) return null
  // Guard against the model refusing / declaring it can't answer from the passages.
  if (/\b(cannot|can't|unable to|not enough information|don't have enough|no information)\b/i.test(answer.slice(0, 120))) {
    return null
  }

  const sources: CorpusFirstSource[] = used.map(h => ({
    domain: h.chunk.domain,
    source: h.chunk.source,
    similarity: Math.round(h.similarity * 100) / 100,
  }))
  // Confidence blends top similarity and breadth of corroboration.
  const confidence = Math.min(0.98, top * 0.7 + Math.min(corroborating, 4) / 4 * 0.3)

  return { answer, sources, confidence }
}
