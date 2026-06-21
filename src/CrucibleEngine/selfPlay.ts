// Session K — Ensemble self-play (learning-flywheel completion).
//
// The system generates its own training data by running the ensemble against its weak
// spots: take low-scoring benchmark questions, generate candidate answers, and have the
// Critic identify the SPECIFIC error in each. Those {question, flawed_answer,
// critic_error_identification} records accumulate into .crucible/self-play-dataset.jsonl.
// When enough accumulate, they're merged into the fine-tune corpus so the on-device /
// HuggingFace model gets better at error identification — which makes the Critic sharper,
// which makes synthesis better: a self-feeding loop with no human labelling.
//
// Fully decoupled: questions/generation/critique/threshold are injected by the caller
// (server.ts wires them to the free model pool), so this module compiles + runs on its own.

import fs from 'fs'
import path from 'path'

const CRUCIBLE_DIR = path.resolve(process.cwd(), '.crucible')
const DATASET_PATH = path.join(CRUCIBLE_DIR, 'self-play-dataset.jsonl')

export interface SelfPlayRecord {
  question: string
  flawed_answer: string
  critic_error_identification: string
  at: string
}

export interface SelfPlayDeps {
  // Low-scoring benchmark questions to target (server reads benchmarks; [] if none).
  weakQuestions: () => Promise<string[]> | string[]
  // Generate candidate answers for a question (a few models). Should not throw.
  generate: (question: string) => Promise<string[]>
  // Critic identifies the specific error in a flawed answer. Should not throw.
  critique: (question: string, answer: string) => Promise<string>
  // Called once when the dataset crosses `threshold`; server wires the fine-tune merge.
  onThreshold?: (datasetPath: string, size: number) => Promise<void> | void
}

export interface SelfPlayOpts {
  maxQuestions?: number   // cap questions per cycle (cost guard) — default 5
  threshold?: number      // dataset size that triggers the merge — default 200
}

export function selfPlayDatasetSize(): number {
  try { return fs.readFileSync(DATASET_PATH, 'utf8').split('\n').filter(Boolean).length } catch { return 0 }
}

function appendRecords(records: SelfPlayRecord[]): void {
  if (!records.length) return
  try {
    fs.mkdirSync(CRUCIBLE_DIR, { recursive: true })
    fs.appendFileSync(DATASET_PATH, records.map(r => JSON.stringify(r)).join('\n') + '\n')
  } catch { /* best-effort */ }
}

// Heuristic: did the Critic actually find a substantive error (vs "looks fine")?
function isRealError(critique: string): boolean {
  const c = critique.trim().toLowerCase()
  if (c.length < 12) return false
  if (/\b(no (significant |major )?(issue|error|problem)s?|looks (correct|fine|good)|nothing wrong|accurate and complete)\b/.test(c)) return false
  return true
}

export interface SelfPlayResult { questions: number; recordsAdded: number; datasetSize: number; thresholdFired: boolean }

export async function runSelfPlayCycle(deps: SelfPlayDeps, opts: SelfPlayOpts = {}): Promise<SelfPlayResult> {
  const maxQuestions = opts.maxQuestions ?? 5
  const threshold = opts.threshold ?? 200

  let questions: string[] = []
  try { questions = (await deps.weakQuestions()) ?? [] } catch { questions = [] }
  questions = questions.filter(q => typeof q === 'string' && q.trim()).slice(0, maxQuestions)

  const records: SelfPlayRecord[] = []
  for (const q of questions) {
    let answers: string[] = []
    try { answers = (await deps.generate(q)) ?? [] } catch { answers = [] }
    for (const a of answers) {
      if (!a || !a.trim()) continue
      let critique = ''
      try { critique = await deps.critique(q, a) } catch { critique = '' }
      if (isRealError(critique)) {
        records.push({ question: q, flawed_answer: a, critic_error_identification: critique.trim(), at: new Date().toISOString() })
      }
    }
  }

  appendRecords(records)
  const datasetSize = selfPlayDatasetSize()
  let thresholdFired = false
  // Fire the merge hook only on the crossing (size advanced past the threshold boundary).
  if (datasetSize >= threshold && datasetSize - records.length < threshold && deps.onThreshold) {
    try { await deps.onThreshold(DATASET_PATH, datasetSize); thresholdFired = true } catch { /* non-fatal */ }
  }
  return { questions: questions.length, recordsAdded: records.length, datasetSize, thresholdFired }
}
