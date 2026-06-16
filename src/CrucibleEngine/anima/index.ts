// ANIMA processes signal to extract universal observations. No user data is stored at any layer.
//
// Track U — ANIMA main entry point.
//
// ANIMA spans two temporal phases of a single request, because its shaping output
// is needed BEFORE the response exists, while its learning input is the response
// ITSELF (see the spec's flow diagram — valence+store-query fire at request
// arrival; candidate-observation extraction fires in the background after synthesis):
//
//   Phase 1 — runAnimaShaping()  : valence detection + store query → directives.
//             Fired at request arrival, in parallel with model selection. Fast,
//             local-first. Its directives shape the Stage 5 synthesis prompt.
//
//   Phase 2 — runAnimaLearning() : observe → verify (5 gates) → store. Fired in
//             the BACKGROUND after the response is sent. Never blocks the user.
//
// `runAnima()` documents the conceptual single-call API; the server wires the two
// phases at their correct points in the pipeline.

import { detectValence } from './valence.js'
import { queryShaping } from './apply.js'
import { extractObservations } from './observe.js'
import { verifyCandidates, type VerifyOutcome } from './verify.js'
import * as store from './store.js'
import type {
  AnimaDeps,
  EmotionalValence,
  ShapingDirectives,
  ConversationTurn,
} from './types.js'

export interface AnimaShaping {
  valence: EmotionalValence
  directives: ShapingDirectives
  appliedTruths: string[]
}

// ── Phase 1: shaping (synchronous, fast, at request arrival) ─────────────────
export function runAnimaShaping(
  history: ConversationTurn[],
  currentPrompt: string,
): AnimaShaping {
  const valence = detectValence(history, currentPrompt)
  const { directives, appliedTruths } = queryShaping(valence)
  return { valence, directives, appliedTruths }
}

// ── Phase 2: learning (asynchronous, background, after synthesis) ────────────
export async function runAnimaLearning(
  history: ConversationTurn[],
  currentPrompt: string,
  finalSynthesis: string,
  valence: EmotionalValence,
  deps: AnimaDeps,
): Promise<VerifyOutcome[]> {
  // Opportunistic decay — cheap, idempotent, keeps stale truths from dominating.
  try { store.decay() } catch { /* best-effort */ }

  const candidates = await extractObservations(history, currentPrompt, finalSynthesis, valence, deps)
  if (candidates.length === 0) return []
  return verifyCandidates(candidates, deps)
}

// ── Conceptual single-call API (used in docs/tests) ──────────────────────────
// Returns shaping directives immediately; kicks off learning in the background.
export function runAnima(
  history: ConversationTurn[],
  currentPrompt: string,
  pendingSynthesis: string,
  deps: AnimaDeps,
): AnimaShaping {
  const shaping = runAnimaShaping(history, currentPrompt)
  // Fire-and-forget learning — never block the response.
  void runAnimaLearning(history, currentPrompt, pendingSynthesis, shaping.valence, deps)
    .catch(() => { /* learning is best-effort and must never surface to the user */ })
  return shaping
}

// Re-exports for the server + transparency wiring.
export { renderShapingBlock } from './apply.js'
export { isTransparencyQuery, buildTransparencyReport } from './transparency.js'
export * as animaStore from './store.js'
export type { AnimaDeps, EmotionalValence, ShapingDirectives, ConversationTurn } from './types.js'
