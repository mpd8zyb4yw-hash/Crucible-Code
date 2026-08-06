// Cross-model knowledge distillation (Track C3) — extracts structural
// differences between high-scoring and low-scoring responses to the same
// question. The extracted "structural advantage" patterns are fed into the
// Stage 5 synthesis prompt so the synthesiser can learn from them without
// needing a fine-tune.

import fs from 'fs'
import path from 'path'

export interface DistillationRecord {
  ts: number
  promptType: string
  query: string
  highScorePatterns: string[]   // structural features from high-scoring responses
  lowScorePatterns: string[]    // structural features from low-scoring responses
  contrast: string              // one-liner: "high-scorers do X, low-scorers do Y"
}

const distillFile = (dir: string) => path.join(dir, '.crucible', 'distillation.json')

export function loadDistillations(dir: string): DistillationRecord[] {
  try { return JSON.parse(fs.readFileSync(distillFile(dir), 'utf8')) } catch { return [] }
}

export function saveDistillations(dir: string, records: DistillationRecord[]) {
  fs.mkdirSync(path.dirname(distillFile(dir)), { recursive: true })
  fs.writeFileSync(distillFile(dir), JSON.stringify(records.slice(-100), null, 2))
}

interface ScoredResponse { modelId: string; text: string; score: number }

// Extract lightweight structural features from a response text
function extractStructure(text: string): string[] {
  const features: string[] = []
  if (text.includes('```')) features.push('includes code block')
  if (/^\d+\.|^-|\*/m.test(text)) features.push('uses bullet/numbered list')
  if (text.split('\n').some(l => l.startsWith('#'))) features.push('uses headers')
  if (text.length > 600) features.push('long-form answer')
  else if (text.length < 100) features.push('very short answer')
  if (/e\.g\.|for example|such as/i.test(text)) features.push('gives examples')
  if (/however|but|although|on the other hand/i.test(text)) features.push('acknowledges tradeoffs')
  if (/\d+\s*%|\d+\s*(ms|seconds|hours|days)/i.test(text)) features.push('includes quantitative details')
  if (/I would|I recommend|you should/i.test(text)) features.push('gives direct recommendation')
  if (/could|might|may|possibly|perhaps/i.test(text)) features.push('hedges with uncertainty')
  return features
}

// Derive a short contrast string from two feature sets
function buildContrast(highFeatures: string[], lowFeatures: string[]): string {
  const unique_high = highFeatures.filter(f => !lowFeatures.includes(f))
  const unique_low = lowFeatures.filter(f => !highFeatures.includes(f))
  if (unique_high.length && unique_low.length) {
    return `High-scorers ${unique_high[0]}; low-scorers ${unique_low[0]}`
  } else if (unique_high.length) {
    return `High-scorers ${unique_high[0]}`
  } else if (unique_low.length) {
    return `Low-scorers ${unique_low[0]} (avoid)`
  }
  return 'No strong structural difference detected'
}

// Analyse a batch of scored responses and distill the structural difference.
export function distillRound(
  dir: string,
  query: string,
  promptType: string,
  responses: ScoredResponse[]
): DistillationRecord | null {
  if (responses.length < 2) return null

  const sorted = [...responses].sort((a, b) => b.score - a.score)
  const top = sorted.slice(0, Math.ceil(sorted.length / 2))
  const bottom = sorted.slice(Math.floor(sorted.length / 2))

  const highFeatures = [...new Set(top.flatMap(r => extractStructure(r.text)))]
  const lowFeatures = [...new Set(bottom.flatMap(r => extractStructure(r.text)))]
  const contrast = buildContrast(highFeatures, lowFeatures)

  if (contrast === 'No strong structural difference detected') return null

  const record: DistillationRecord = {
    ts: Date.now(),
    promptType,
    query: query.slice(0, 120),
    highScorePatterns: highFeatures,
    lowScorePatterns: lowFeatures,
    contrast,
  }

  const existing = loadDistillations(dir)
  existing.push(record)
  saveDistillations(dir, existing)
  return record
}

// Build a short context string of the N most recent distillation insights
// for a given prompt type — injected into the synthesis prompt.
export function getDistillationContext(dir: string, promptType: string, n = 3): string {
  const all = loadDistillations(dir).filter(d => d.promptType === promptType)
  const recent = all.slice(-n)
  if (!recent.length) return ''
  const lines = recent.map(d => `- ${d.contrast}`)
  return `Structural quality patterns observed for ${promptType} queries:\n${lines.join('\n')}`
}
