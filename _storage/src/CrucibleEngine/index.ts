// ============================================================
// CRUCIBLE — Knowledge Base & Scoring Engine
// Public API
// ============================================================

export { score, formatCritiqueForModel, evaluateIteration, loadAdditionalEntries, addApprovedEntry } from "./scoring-engine";
export { generateContract } from "./contract-generator";
export type { InterfaceContract } from "./contract-generator";
export { tokenizeSource, tokenSimilarity } from "./tokenizer";
export { TIER_1_ENTRIES } from "./knowledge-base";
export type {
  ScoringInput,
  CompositeScore,
  Critique,
  ClosestMatch,
  KnowledgeEntry,
  ScoringConfig,
  PatternCategory,
  QualitySignal,
} from "./types";
export { DEFAULT_SCORING_CONFIG } from "./types";

import type { PromptType } from "./types";

// getAspectContext — defined inline (rag-context does not export it).
// `fit` is a Record<PromptType, number> (from ModelEntry) or the string 'deterministic'.
export function getAspectContext(
  modelId: string,
  promptType: PromptType,
  fit: Record<PromptType, number> | string,
  slotIndex: number
): string {
  if (fit === 'deterministic') {
    return `You are operating as a deterministic, high-quality responder in slot ${slotIndex} of a parallel pipeline. Focus on accuracy and completeness.`
  }
  const fitMap = fit as Record<PromptType, number>
  const score = fitMap[promptType] ?? 5
  const role =
    score >= 8 ? 'primary specialist' :
    score >= 6 ? 'strong contributor' :
    score >= 4 ? 'generalist contributor' :
    'supporting contributor'

  return `You are operating as a ${role} for ${promptType} tasks (fit score: ${score}/10) in slot ${slotIndex} of a parallel synthesis pipeline. Produce your best independent response — it will be compared with other models and the highest-quality answer selected.`
}

// ── USAGE EXAMPLE ─────────────────────────────────────────────
//
// import { evaluateIteration, DEFAULT_SCORING_CONFIG } from "./index";
//
// const result = evaluateIteration(
//   {
//     proposedSource: modelOutput,
//     problemStatement: userPrompt,
//     pipelineLayer: 1,
//   },
//   DEFAULT_SCORING_CONFIG,
//   iteration
// );
//
// if (result.shouldAccept) {
//   // Pass to next pipeline layer
// } else if (result.shouldEscalate) {
//   // Send to full multi-model debate with critique attached
// } else {
//   // Send critiqueText back to model for local refinement
//   const nextModelPrompt = `
//     Your previous implementation was evaluated.
//     ${result.critiqueText}
//     Please revise your implementation addressing the issues above.
//   `;
// }
