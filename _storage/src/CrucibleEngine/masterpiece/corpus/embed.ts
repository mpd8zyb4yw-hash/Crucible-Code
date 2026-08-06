// MASTERPIECE corpus — embedding engine
// Primary: ONNX all-MiniLM-L6-v2 (384-dim, runs locally, no API)
// Fallback: 256-dim word-level feature hashing (signed, TF-weighted, L2-normalised)
// Cosine similarity used for all nearest-neighbour lookups.
//
// The fallback is dependency-free and on-device (true to the free-tier ethos). It
// replaced an earlier 20-dim CHARACTER hash whose buckets saturated for any longer
// text — every pair of passages came out ~0.95 similar, so cross-domain novelty
// was meaningless (every score pinned to 1.0). Word-level feature hashing
// discriminates: passages that share content words score high, unrelated ones
// score near zero. See the 2026-06-14 changelog.

import type { Pipeline } from '@xenova/transformers'
import { ensureModelFiles, modelCacheDir } from './modelFetch'

let _pipeline: Pipeline | null = null
let _pipelineLoading: Promise<Pipeline> | null = null

// ONNX availability is NOT a permanent latch. A failed load (e.g. an interrupted
// download) records a timestamp and is retried after a cooldown, so one dropped
// connection can no longer degrade every embedding to the hash fallback until restart.
let _onnxAvailable = true
let _lastFailureAt = 0
const RETRY_COOLDOWN_MS = 30_000

function inCooldown(): boolean {
  return _lastFailureAt > 0 && Date.now() - _lastFailureAt < RETRY_COOLDOWN_MS
}

async function loadPipeline(): Promise<Pipeline | null> {
  if (_pipeline) return _pipeline
  if (_pipelineLoading) return _pipelineLoading
  if (inCooldown()) return null

  _pipelineLoading = (async () => {
    // Persist the transformers.js cache so a completed download survives restarts and is
    // never re-fetched. Point it at our resumable cache dir, then pre-fetch the weights
    // with byte-level Range resume — pipeline() then reads from cache with zero network.
    const { pipeline, env } = await import('@xenova/transformers')
    env.cacheDir = modelCacheDir()
    env.allowRemoteModels = true
    env.useFSCache = true

    await ensureModelFiles()

    const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    }) as Pipeline
    _pipeline = p
    _lastFailureAt = 0
    _onnxAvailable = true
    return p
  })()

  try {
    return await _pipelineLoading
  } catch {
    // Record the failure and back off, but self-heal: the completed portion of the
    // download is preserved on disk and the next attempt (after cooldown) resumes it.
    _lastFailureAt = Date.now()
    _onnxAvailable = false
    return null
  } finally {
    _pipelineLoading = null
  }
}

// Returns a 384-dim Float32Array via ONNX, or a 20-dim hash Float32Array as fallback.
export async function embed(text: string): Promise<Float32Array> {
  const pipe = await loadPipeline()
  if (pipe) {
    try {
      const output = await pipe(text, { pooling: 'mean', normalize: true })
      // @xenova/transformers returns a Tensor with .data
      const data: Float32Array = output.data instanceof Float32Array
        ? output.data
        : new Float32Array(output.data as number[])
      return data
    } catch {
      // fall through to hash projection
    }
  }
  return hashProject(text)
}

// Cosine similarity between two embedding vectors (any equal dimension).
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// Word-level feature hashing — 256-dim, signed, TF-weighted, L2-normalised.
// Used only when ONNX is unavailable (cold start, model download failure).
const FALLBACK_DIMS = 256

// Lightweight English stopword set — dropped so similarity is driven by content
// words, not function words every passage shares.
const STOPWORDS = new Set([
  'the','and','for','that','this','with','from','into','are','was','were','has','have','had',
  'not','but','its','they','them','their','your','you','our','his','her','she','him','who','what',
  'which','when','where','how','why','can','will','would','could','should','may','might','must',
  'one','two','also','than','then','out','off','over','under','more','most','some','any','all','each',
])

// FNV-1a 32-bit string hash.
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hashProject(text: string): Float32Array {
  const vec = new Float32Array(FALLBACK_DIMS)
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []
  for (const tok of tokens) {
    if (STOPWORDS.has(tok)) continue
    const h = fnv1a(tok)
    const bucket = h % FALLBACK_DIMS
    const sign = (h & 0x10000) ? 1 : -1   // independent bit ⇒ signed feature hashing
    vec[bucket] += sign
  }
  // L2 normalise so cosine similarity is dot product.
  let len = 0
  for (let i = 0; i < FALLBACK_DIMS; i++) len += vec[i] * vec[i]
  len = Math.sqrt(len) || 1
  for (let i = 0; i < FALLBACK_DIMS; i++) vec[i] /= len
  return vec
}

export function isOnnxAvailable(): boolean {
  return _onnxAvailable
}

export function embeddingDim(): number {
  return _onnxAvailable ? 384 : FALLBACK_DIMS
}

// Settle ONNX availability BEFORE callers read embeddingDim(). Without this, the
// first embeddingDim() call returns 384 (optimistic default) while embed() returns
// the fallback dim, so the corpus re-seed check would mis-fire on every startup.
export async function ensureEmbedderReady(): Promise<void> {
  await loadPipeline()
}
