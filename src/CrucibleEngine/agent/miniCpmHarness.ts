// MiniCPM harness — makes MiniCPM5-1B's output usable despite its quirks.
//
// MiniCPM5 is a THINKING model. Empirically (cont.67) it does not emit <think> tags here;
// instead it STOCHASTICALLY either (a) answers cleanly or (b) dumps a plain-text reasoning
// preamble ("First, I need to answer the question…"). The leak is triggered by prompt
// complexity (evidence blocks, conditional/negative instructions) and is worse on short token
// budgets (it gets cut off mid-reasoning, never reaching the answer). Confidence self-ratings
// and LOOKUP-protocol prompts confuse it outright.
//
// This harness maximizes clean output without pretending it's guaranteed:
//   1. SIMPLE, positive prompt convention (no "use ONLY", no "do NOT", no conditionals).
//   2. Generous token budget so a reasoning pass can still reach the answer.
//   3. Detect a leaked reasoning preamble; strip it to the answer, else retry once (the leak
//      is stochastic, so a resample often comes back clean).
//   4. If it still won't produce a clean answer, return '' so the caller falls back to Apple FM.
//
// MiniCPM is NOT better than Apple FM for the interactive answer path (comparable speed, more
// errors), so this harness exists to make MiniCPM available for AGENTIC / reasoning-heavy roles
// where its step-by-step thinking is an asset — not to replace the web+FM answer path.

import fs from 'fs'
import { completeLocalModel, warmModel, isGgufRuntimeAvailable } from './localModelPool'
import { findModelSpec } from './localModelCatalog'
import { modelFilePath } from './modelDownloadManager'

const MINICPM_ID = 'minicpm5-1b'

/**
 * Whether MiniCPM can actually run in THIS process right now: the GGUF runtime (node-llama-cpp)
 * is importable AND the model file is on disk. Cheap (a cached probe + one existsSync), never
 * throws. Consumers use this to stay a no-op on machines where MiniCPM was never downloaded —
 * the same "zero voters when uninstalled" contract the ONNX ensemble already follows.
 */
export async function isMiniCpmAvailable(): Promise<boolean> {
  try {
    if (!(await isGgufRuntimeAvailable())) return false
    const spec = findModelSpec(MINICPM_ID)
    return !!spec && fs.existsSync(modelFilePath(spec))
  } catch { return false }
}

// Leaked-reasoning openers MiniCPM uses when it narrates instead of answering.
const REASONING_OPENER = /^\s*(first[,:]?\s|okay[,:]?\s|alright[,:]?\s|let me\b|let's\b|i need to\b|i must\b|i should\b|i'll\b|i will\b|the question\b|to answer\b|so[,:]\s|well[,:]\s|now[,:]\s|thinking\b|step 1\b|step one\b)/i

function looksLikeReasoning(text: string): boolean {
  return REASONING_OPENER.test(text)
}

/**
 * Strip a leaked reasoning preamble. MiniCPM, when it narrates, often still lands on the answer
 * — commonly after an "In summary:" / "Therefore" / "The answer is" marker, or in the final
 * paragraph(s). Return the cleaned answer, or '' when the whole output is reasoning (it was cut
 * off before answering).
 */
export function stripReasoning(raw: string): string {
  let text = raw.trim()
  if (!text) return ''
  if (!looksLikeReasoning(text)) return text

  // Prefer an explicit conclusion marker if present.
  const marker = text.match(/\b(in summary|to summarize|therefore|in conclusion|the answer is|final answer|so,? in short|overall)\b[:,]?\s*/i)
  if (marker && marker.index !== undefined) {
    const after = text.slice(marker.index + marker[0].length).trim()
    if (after.length >= 40) return after
  }

  // Otherwise drop leading reasoning paragraphs; keep the first non-reasoning block onward.
  const paras = text.split(/\n\s*\n/)
  const start = paras.findIndex(p => p.trim() && !looksLikeReasoning(p.trim()))
  if (start > 0) {
    const kept = paras.slice(start).join('\n\n').trim()
    if (kept.length >= 40) return kept
  }

  // Whole thing is reasoning (or cut off) — signal failure so the caller falls back.
  return ''
}

export interface LocalAnswerOpts {
  /** Reference/evidence text to ground on. Presented plainly (no "use ONLY" — that provokes the leak). */
  context?: string
  /** Target answer length hint. */
  concise?: boolean
  maxTokens?: number
  timeoutMs?: number
}

/**
 * Get a CLEAN answer from MiniCPM for `question`, or '' if it won't produce one. Uses the simple
 * prompt convention, a generous budget, and a strip+retry cleanup. Never throws.
 */
export async function miniCpmAnswer(question: string, opts: LocalAnswerOpts = {}): Promise<string> {
  const system = 'You are a helpful, accurate assistant. Answer the question directly.'
  const lengthHint = opts.concise === false ? '' : ' Answer clearly and concisely (2-5 sentences).'
  const prompt = opts.context
    ? `Reference:\n${opts.context}\n\nUsing this reference, answer the question.${lengthHint}\nQuestion: ${question}`
    : `${question}${lengthHint}`
  const maxTokens = opts.maxTokens ?? 1600
  const timeoutMs = opts.timeoutMs ?? 30_000

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw = ''
    try { raw = await completeLocalModel(MINICPM_ID, system, prompt, { maxTokens, timeoutMs }) }
    catch { return '' }
    const cleaned = stripReasoning(raw)
    if (cleaned) return cleaned
    // Leaked and unrecoverable — resample once (the leak is stochastic).
  }
  return ''
}

/** Preload MiniCPM so the first agentic call doesn't pay the model-load cost. */
export async function warmMiniCpm(): Promise<boolean> {
  return warmModel(MINICPM_ID)
}
