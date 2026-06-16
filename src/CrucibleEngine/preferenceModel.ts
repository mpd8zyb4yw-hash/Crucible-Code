// Implicit preference learning (Track D4) — trains a lightweight logistic
// regression model over response features (length, structure, tone, etc.)
// using thumbs-up/down signals from the feedback API. The learned weights
// adjust the Stage 2 scoring function to match the user's revealed preferences.

import fs from 'fs'
import path from 'path'

export interface FeedbackSample {
  ts: number
  vote: 'up' | 'down'
  features: number[]  // same feature vector as failureTaxonomy
  query: string
  promptType: string
}

export interface PreferenceWeights {
  weights: number[]
  bias: number
  sampleSize: number
  lastUpdated: number
}

const FEATURE_DIM = 12
const LEARNING_RATE = 0.05
const REGULARISATION = 0.01

function prefFile(dir: string) { return path.join(dir, '.crucible', 'preference-weights.json') }
function samplesFile(dir: string) { return path.join(dir, '.crucible', 'feedback-samples.json') }

export function loadPreferenceWeights(dir: string): PreferenceWeights {
  try { return JSON.parse(fs.readFileSync(prefFile(dir), 'utf8')) }
  catch { return { weights: new Array(FEATURE_DIM).fill(0), bias: 0, sampleSize: 0, lastUpdated: 0 } }
}

export function savePreferenceWeights(dir: string, pw: PreferenceWeights) {
  fs.mkdirSync(path.dirname(prefFile(dir)), { recursive: true })
  fs.writeFileSync(prefFile(dir), JSON.stringify(pw, null, 2))
}

function loadSamples(dir: string): FeedbackSample[] {
  try { return JSON.parse(fs.readFileSync(samplesFile(dir), 'utf8')) } catch { return [] }
}

function saveSamples(dir: string, samples: FeedbackSample[]) {
  fs.mkdirSync(path.dirname(samplesFile(dir)), { recursive: true })
  fs.writeFileSync(samplesFile(dir), JSON.stringify(samples.slice(-500), null, 2))
}

function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)) }

// Featurise a synthesis response into a fixed-dim vector
export function featurizeResponse(synthesis: string, query: string, promptType: string): number[] {
  const words = synthesis.split(/\s+/).length
  const ptypes = ['coding', 'reasoning', 'creative', 'factual', 'math', 'general']
  return [
    Math.min(words / 300, 1),                         // normalised length
    synthesis.includes('```') ? 1 : 0,               // has code
    /^\d+\.|^-/m.test(synthesis) ? 1 : 0,            // has list
    synthesis.split('\n').some(l => l.startsWith('#')) ? 1 : 0, // has headers
    /e\.g\.|for example/i.test(synthesis) ? 1 : 0,   // has examples
    /however|but|although/i.test(synthesis) ? 1 : 0, // acknowledges tradeoffs
    /\d+/.test(synthesis) ? 1 : 0,                    // has numbers
    /I recommend|you should/i.test(synthesis) ? 1 : 0, // direct recommendation
    query.includes('?') ? 1 : 0,                      // question form
    Math.min(query.length / 100, 1),                  // query length
    ...ptypes.slice(0, 2).map(pt => pt === promptType ? 1 : 0),
  ]
}

// Record a feedback vote and run one online gradient update
export function recordFeedback(
  dir: string,
  vote: 'up' | 'down',
  synthesis: string,
  query: string,
  promptType: string
): void {
  const features = featurizeResponse(synthesis, query, promptType)
  const sample: FeedbackSample = { ts: Date.now(), vote, features, query: query.slice(0, 100), promptType }

  const samples = loadSamples(dir)
  samples.push(sample)
  saveSamples(dir, samples)

  // Online logistic regression update
  const pw = loadPreferenceWeights(dir)
  const label = vote === 'up' ? 1 : 0
  const logit = pw.weights.reduce((s, w, i) => s + w * features[i], pw.bias)
  const pred = sigmoid(logit)
  const error = pred - label

  // Gradient descent step with L2 regularisation
  for (let i = 0; i < pw.weights.length; i++) {
    pw.weights[i] -= LEARNING_RATE * (error * features[i] + REGULARISATION * pw.weights[i])
  }
  pw.bias -= LEARNING_RATE * error
  pw.sampleSize += 1
  pw.lastUpdated = Date.now()

  savePreferenceWeights(dir, pw)
}

// Score a candidate response using the learned preference model.
// Returns a value in [0, 1]; 0.5 is neutral (untrained model).
export function preferenceScore(dir: string, synthesis: string, query: string, promptType: string): number {
  const pw = loadPreferenceWeights(dir)
  if (pw.sampleSize < 10) return 0.5  // not enough data
  const features = featurizeResponse(synthesis, query, promptType)
  const logit = pw.weights.reduce((s, w, i) => s + w * features[i], pw.bias)
  return sigmoid(logit)
}

// Get a summary of what the preference model has learned
export function getPreferenceSummary(dir: string): { feature: string; weight: number }[] {
  const LABELS = ['length', 'has_code', 'has_list', 'has_headers', 'examples', 'tradeoffs', 'numbers', 'direct_rec', 'question_form', 'query_length', 'is_coding', 'is_reasoning']
  const pw = loadPreferenceWeights(dir)
  return LABELS.map((label, i) => ({ feature: label, weight: parseFloat((pw.weights[i] ?? 0).toFixed(3)) }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
}
