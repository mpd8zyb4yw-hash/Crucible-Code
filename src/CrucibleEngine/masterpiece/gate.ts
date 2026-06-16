// MASTERPIECE Gate — two-mode universal activation selector.
//
// MASTERPIECE no longer fires on a subset of prompts. It runs on EVERY prompt,
// in one of two modes. The gate is a *mode selector*, not an on/off switch.
//
//   light  — ALWAYS. Local corpus enrichment only (semantic + abductive query +
//            structural resonance). No model calls, no triadic, no escalation,
//            no MoE. Target < 500ms. Generates learning signal on every query,
//            including the simple ones the old gate ignored.
//
//   deep   — Adds the full dialectical pipeline on top of light. Triggered by
//            prompt COMPLEXITY ALONE (no ensemble-confidence condition — the old
//            C4 meant MASTERPIECE never fired when the ensemble struggled, i.e.
//            exactly when it was most needed):
//              D1  token estimate ≥ 150
//              D2  ≥ 2 detectable subtasks
//              D3  prompt type is not 'factual'
//            All three must hold.

// Prompt types that read as a plain factual lookup — these never warrant deep mode.
// (Kept for parity with the old SYNTHESIS_TYPES allow-list, but inverted: we now
//  exclude 'factual' rather than allow-listing synthesis types, so any non-factual
//  complex prompt qualifies.)

// Heuristic sub-question detection: looks for conjunctions between distinct
// analytical asks, numbered lists, multi-dimensional framing.
export function countSubtasks(text: string): number {
  const lower = text.toLowerCase()
  let count = 1

  // Explicit enumerations
  const numbered = (lower.match(/\b(\d+[\.\)]\s|\(\d+\))/g) ?? []).length
  if (numbered >= 2) count = Math.max(count, numbered)

  // Conjunctions between analytical dimensions
  const conjRegex = /\b(and also|furthermore|additionally|as well as|in addition|on the other hand|not only|but also)\b/gi
  const conjs = (lower.match(conjRegex) ?? []).length
  count += conjs

  // Multi-part question structure
  if (/\b(how|why|what|when|where)\b.{10,}\b(how|why|what|when|where)\b/i.test(text)) count++
  if (/\b(compare|contrast|difference between|similarities between)\b/i.test(lower)) count++
  if (/\b(pros and cons|trade.?off|advantages.{0,20}disadvantages)\b/i.test(lower)) count++
  if (/\b(first|second|third|finally|lastly)\b/i.test(lower)) count++

  return count
}

export function detectPromptType(text: string): string {
  const lower = text.toLowerCase()
  if (/\b(compare|contrast|versus|vs\.?)\b/.test(lower)) return 'comparison'
  if (/\b(design|architect|build|create a system|how would you build)\b/.test(lower)) return 'design'
  if (/\b(strategy|strategically|strategic|roadmap|plan for)\b/.test(lower)) return 'strategy'
  if (/\b(explain|why does|how does|what is the reason)\b/.test(lower)) return 'explanation'
  if (/\b(analyse|analyze|analysis|examine)\b/.test(lower)) return 'analysis'
  if (/\b(synthesi[sz]e|synthesise|combine|integrate|unify)\b/.test(lower)) return 'synthesis'
  if (/\b(research|investigate|explore|survey)\b/.test(lower)) return 'research'
  if (/\b(evaluate|assess|critique|review)\b/.test(lower)) return 'evaluation'
  if (/\b(philosophi|ethic|moral|epistem|ontolog)\b/.test(lower)) return 'philosophy'
  if (/\b(plan|planning|schedule|organis[ez])\b/.test(lower)) return 'planning'
  // Factual lookup signatures that do NOT warrant deep mode
  if (/^(what is|who is|when did|where is|how many|what year|define )/i.test(text.trim())) return 'factual'
  if (text.trim().split(/\s+/).length < 15) return 'factual'
  return 'analysis'  // default
}

export function estimateTokens(text: string): number {
  // Char/4 — the standard tokenizer approximation. Word×0.75 severely
  // underestimates dense technical text (111 words ≈ 83, but the same 702-char
  // passage is ~175 tokens). See the 2026-06-14 changelog for the diagnosis.
  return Math.round(text.trim().length / 4)
}

export interface GateDecision {
  mode: 'light' | 'deep'
  // Diagnostics (used for logging + the SSE gate event; not part of the
  // minimal { mode } contract but structurally compatible with it).
  tokenEstimate: number
  detectedSubtasks: number
  promptType: string
  deepReasons: string[]   // why deep did/didn't trigger
}

// The single mode selector. Light is implicit (always runs); this decides
// whether deep ALSO runs.
export function evaluateGate(prompt: string): GateDecision {
  const tokenEstimate = estimateTokens(prompt)
  const detectedSubtasks = countSubtasks(prompt)
  const promptType = detectPromptType(prompt)

  const d1 = tokenEstimate >= 150
  const d2 = detectedSubtasks >= 2
  const d3 = promptType !== 'factual'

  const deepReasons: string[] = []
  if (!d1) deepReasons.push(`token estimate ${tokenEstimate} < 150`)
  if (!d2) deepReasons.push(`only ${detectedSubtasks} subtask detected (need ≥ 2)`)
  if (!d3) deepReasons.push(`prompt type '${promptType}' is factual`)

  const mode: 'light' | 'deep' = d1 && d2 && d3 ? 'deep' : 'light'

  return { mode, tokenEstimate, detectedSubtasks, promptType, deepReasons }
}
