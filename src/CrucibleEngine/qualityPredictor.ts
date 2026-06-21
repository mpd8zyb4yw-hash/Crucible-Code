// ============================================================
// CRUCIBLE — Cross-Session Quality Predictor
// Learns (prompt_features → composite_score) from history.
// predict() returns expected score range + confidence so the
// pipeline can tune its early-exit threshold and complexity gate.
//
// Same architecture as debugAnalyzer: persistent JSON, k-NN
// over feature vectors, no API calls, runs in <1ms.
// ============================================================

import fs from 'fs'
import path from 'path'

// ── Feature extraction ────────────────────────────────────────
// Builds a lightweight feature vector from a prompt:
//   - Token-tf cosine base (via vectorize)
//   - Structural scalars packed alongside: length bucket, code
//     signal, question count, multi-part, complexity keywords

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','can','of','in','on','at','to','for','with','by','from','and','or','but','not','this','that','it','its','i','you','we','they','he','she','what','how','when','where','why','who','which'])
const CODE_SIGNAL = /\b(code|function|class|implement|debug|typescript|javascript|python|rust|sql|api|algorithm|bug|error|compile)\b/i
const COMPLEX_SIGNAL = /\b(compare|explain|design|architect|analyse|analyze|implement|refactor|optimize|evaluate|step.?by.?step|comprehensive)\b/i

export interface QualityFeatures {
  tokens: Map<string, number>   // tf-idf-lite token weights
  lengthBucket: number          // 0=<30 chars, 1=30-100, 2=100-300, 3=>300
  hasCode: number               // 0|1
  questionCount: number         // # question marks
  isComplex: number             // 0|1 from COMPLEX_SIGNAL
  wordCount: number
}

function extractFeatures(prompt: string): QualityFeatures {
  const lower = prompt.toLowerCase()
  const words = (lower.match(/[a-z0-9]{2,}/g) ?? []).filter(w => !STOPWORDS.has(w))
  const tf = new Map<string, number>()
  for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1)
  // Normalize tf
  const maxTf = Math.max(1, ...tf.values())
  for (const [k, v] of tf) tf.set(k, v / maxTf)

  return {
    tokens: tf,
    lengthBucket: prompt.length < 30 ? 0 : prompt.length < 100 ? 1 : prompt.length < 300 ? 2 : 3,
    hasCode: CODE_SIGNAL.test(prompt) ? 1 : 0,
    questionCount: Math.min(5, (prompt.match(/\?/g) ?? []).length),
    isComplex: COMPLEX_SIGNAL.test(prompt) ? 1 : 0,
    wordCount: Math.min(100, words.length),
  }
}

function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0
  for (const [k, v] of a) { dot += v * (b.get(k) ?? 0); na += v * v }
  for (const v of b.values()) nb += v * v
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

function featureSim(a: QualityFeatures, b: QualityFeatures): number {
  const tokenSim = cosineSim(a.tokens, b.tokens)
  // Structural similarity — normalized Euclidean distance → similarity
  const structDist = Math.sqrt(
    Math.pow((a.lengthBucket - b.lengthBucket) / 3, 2) +
    Math.pow(a.hasCode - b.hasCode, 2) +
    Math.pow((a.questionCount - b.questionCount) / 5, 2) +
    Math.pow(a.isComplex - b.isComplex, 2) +
    Math.pow((a.wordCount - b.wordCount) / 100, 2)
  )
  const structSim = 1 / (1 + structDist)
  // Token cosine weighted 0.7, structural 0.3
  return 0.7 * tokenSim + 0.3 * structSim
}

// ── Persistence ───────────────────────────────────────────────

interface QualityEntry {
  ts: number
  promptSnippet: string       // first 60 chars for debugging
  features: { lengthBucket: number; hasCode: number; questionCount: number; isComplex: number; wordCount: number; tokens: [string, number][] }
  compositeScore: number
  promptType: string
}

const MAX_HISTORY = 500
const K_NEIGHBORS = 7

class QualityPredictor {
  private dataFile: string | null = null
  private history: QualityEntry[] = []
  private loaded = false

  init(projectPath: string): void {
    this.dataFile = path.join(projectPath, '.crucible', 'quality-history.json')
    this.load()
  }

  private load(): void {
    if (!this.dataFile) return
    try {
      this.history = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))
      this.loaded = true
    } catch { this.loaded = true }
  }

  private save(): void {
    if (!this.dataFile) return
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true })
      fs.writeFileSync(this.dataFile, JSON.stringify(this.history, null, 2))
    } catch {}
  }

  record(prompt: string, compositeScore: number, promptType: string): void {
    if (!this.loaded) return
    const features = extractFeatures(prompt)
    const entry: QualityEntry = {
      ts: Date.now(),
      promptSnippet: prompt.slice(0, 60),
      features: {
        lengthBucket: features.lengthBucket,
        hasCode: features.hasCode,
        questionCount: features.questionCount,
        isComplex: features.isComplex,
        wordCount: features.wordCount,
        tokens: [...features.tokens.entries()],
      },
      compositeScore,
      promptType,
    }
    this.history.push(entry)
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY)
    this.save()
  }

  predict(prompt: string): {
    predictedScore: number
    confidence: number    // 0–1: how similar the k neighbors are to this prompt
    recentAvg: number
    trend: 'up' | 'flat' | 'down'
    sampleSize: number
  } {
    const fallback = { predictedScore: 0.7, confidence: 0, recentAvg: 0.7, trend: 'flat' as const, sampleSize: 0 }
    if (!this.loaded || this.history.length < 5) return fallback

    const features = extractFeatures(prompt)

    // Reconstruct comparable feature objects from stored entries
    const neighbors = this.history
      .map(entry => {
        const stored: QualityFeatures = {
          tokens: new Map(entry.features.tokens),
          lengthBucket: entry.features.lengthBucket,
          hasCode: entry.features.hasCode,
          questionCount: entry.features.questionCount,
          isComplex: entry.features.isComplex,
          wordCount: entry.features.wordCount,
        }
        return { sim: featureSim(features, stored), score: entry.compositeScore }
      })
      .sort((a, b) => b.sim - a.sim)
      .slice(0, K_NEIGHBORS)

    const totalWeight = neighbors.reduce((s, n) => s + n.sim, 0)
    if (totalWeight === 0) return fallback

    const predictedScore = neighbors.reduce((s, n) => s + n.score * n.sim, 0) / totalWeight
    const confidence = Math.min(1, totalWeight / K_NEIGHBORS)

    // Recent trend: compare last-10 average vs prior-10
    const recent = this.history.slice(-10).map(e => e.compositeScore)
    const prior  = this.history.slice(-20, -10).map(e => e.compositeScore)
    const recentAvg = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : predictedScore
    const priorAvg  = prior.length  ? prior.reduce((s, v) => s + v, 0)  / prior.length  : recentAvg
    const trend: 'up' | 'flat' | 'down' =
      recentAvg > priorAvg + 0.03 ? 'up' : recentAvg < priorAvg - 0.03 ? 'down' : 'flat'

    return {
      predictedScore: parseFloat(predictedScore.toFixed(3)),
      confidence: parseFloat(confidence.toFixed(3)),
      recentAvg: parseFloat(recentAvg.toFixed(3)),
      trend,
      sampleSize: this.history.length,
    }
  }

  stats(): { sampleSize: number; recentAvg: number; trend: 'up' | 'flat' | 'down' } {
    if (!this.history.length) return { sampleSize: 0, recentAvg: 0, trend: 'flat' }
    // Real trend (was hardcoded 'flat', which silently disabled rollbackIfDegraded):
    // compare the last-10 average against the prior-10, same logic as predict().
    const recent = this.history.slice(-10).map(e => e.compositeScore)
    const prior  = this.history.slice(-20, -10).map(e => e.compositeScore)
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length
    const priorAvg  = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : recentAvg
    const trend: 'up' | 'flat' | 'down' =
      recentAvg > priorAvg + 0.03 ? 'up' : recentAvg < priorAvg - 0.03 ? 'down' : 'flat'
    return { sampleSize: this.history.length, recentAvg: parseFloat(recentAvg.toFixed(3)), trend }
  }
}

export const qualityPredictor = new QualityPredictor()
