// Step 4 — Reasoning Engine
// For complex reasoning/math queries, runs a fast model call before Stage 1 to generate
// a structured problem scaffold. The scaffold is injected into all Stage 1 system prompts
// so models work within a shared, explicitly-reasoned framework.
//
// The scaffold does NOT answer the question — it only structures the problem.
// This prevents models from pattern-matching to a plausible-sounding but wrong answer
// by forcing them to name the key concepts, proof strategy, and common failure modes first.
//
// Runs concurrently in the pre-Stage-1 parallel block (4s timeout, fail-silent).

export type ScaffoldType = 'math-proof' | 'logical-reasoning' | 'causal-analysis' | 'algorithm-design' | 'generic-reasoning'

export interface ReasoningScaffold {
  scaffoldType: ScaffoldType
  problemRestatement: string       // One-sentence restatement of the core problem
  keyConceptsOrLemmas: string[]    // Named concepts/lemmas required to solve it
  approachSuggestion: string       // The proof/reasoning strategy (e.g. "proof by contradiction")
  commonMistakes: string[]         // Known failure modes for this problem type
  verificationCriteria: string     // How to know the answer is correct
}

// Prompt types that benefit from the reasoning scaffold
const REASONING_TYPES = new Set(['math', 'reasoning'])

// Minimum message length before scaffold is worth running
const MIN_LEN = 50

// Keyword signals that indicate a reasoning-heavy query regardless of classified promptType
const REASONING_SIGNALS = /\b(prove|proof|derive|derivation|explain why|why does|how does|induction|theorem|lemma|show that|demonstrate|justify|reason|deduce|logical|algorithm|complexity|analyze|analyse)\b/i

export function shouldRunReasoningEngine(promptType: string, message: string, complexity: string): boolean {
  if (complexity !== 'complex' || message.length < MIN_LEN) return false
  return REASONING_TYPES.has(promptType) || REASONING_SIGNALS.test(message)
}

const SCAFFOLD_SYSTEM_PROMPT = `You are a Reasoning Scaffold Generator. Given a problem or question, output a concise JSON object with these exact fields:
{
  "scaffoldType": one of: math-proof | logical-reasoning | causal-analysis | algorithm-design | generic-reasoning,
  "problemRestatement": "One clear sentence restating the core problem",
  "keyConceptsOrLemmas": ["concept1", "concept2", "concept3"],
  "approachSuggestion": "The best proof or reasoning strategy for this problem type",
  "commonMistakes": ["mistake1", "mistake2"],
  "verificationCriteria": "How to verify the answer is correct"
}

Rules:
- DO NOT solve the problem — only scaffold it
- Be concrete and specific (name actual theorems, techniques, common errors for this exact problem)
- Output ONLY the JSON object, no prose before or after
- Maximum 3 items in each array
- Keep all strings under 80 chars`

function parseScaffold(raw: string): ReasoningScaffold | null {
  try {
    // Extract JSON from the response (may have surrounding text)
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const obj = JSON.parse(match[0])
    if (!obj.scaffoldType || !obj.problemRestatement) return null
    return {
      scaffoldType: obj.scaffoldType,
      problemRestatement: String(obj.problemRestatement).slice(0, 150),
      keyConceptsOrLemmas: Array.isArray(obj.keyConceptsOrLemmas)
        ? obj.keyConceptsOrLemmas.slice(0, 3).map((s: unknown) => String(s).slice(0, 80))
        : [],
      approachSuggestion: String(obj.approachSuggestion || '').slice(0, 150),
      commonMistakes: Array.isArray(obj.commonMistakes)
        ? obj.commonMistakes.slice(0, 3).map((s: unknown) => String(s).slice(0, 80))
        : [],
      verificationCriteria: String(obj.verificationCriteria || '').slice(0, 150),
    }
  } catch {
    return null
  }
}

/**
 * Generate a reasoning scaffold. Returns null on failure (always fail-silent).
 * callModel is injected from server.ts to avoid circular imports.
 */
export async function generateScaffold(
  message: string,
  promptType: string,
  complexity: string,
  callModel: (model: { id: string; provider: string }, messages: Array<{ role: string; content: string }>) => Promise<string>,
  fastModel: { id: string; provider: string } | null,
): Promise<ReasoningScaffold | null> {
  if (!shouldRunReasoningEngine(promptType, message, complexity)) return null
  if (!fastModel) return null

  try {
    const raw = await callModel(fastModel, [
      { role: 'system', content: SCAFFOLD_SYSTEM_PROMPT },
      { role: 'user', content: message.slice(0, 500) },
    ])
    return parseScaffold(raw)
  } catch {
    return null
  }
}

/**
 * Build the scaffold context block injected into Stage 1 system prompts.
 */
export function buildScaffoldBlock(scaffold: ReasoningScaffold): string {
  const lines: string[] = [
    `[REASONING SCAFFOLD — structured before Stage 1]`,
    `Problem: ${scaffold.problemRestatement}`,
    `Approach: ${scaffold.approachSuggestion}`,
  ]
  if (scaffold.keyConceptsOrLemmas.length > 0) {
    lines.push(`Key concepts: ${scaffold.keyConceptsOrLemmas.join(', ')}`)
  }
  if (scaffold.commonMistakes.length > 0) {
    lines.push(`Common mistakes to avoid: ${scaffold.commonMistakes.join('; ')}`)
  }
  lines.push(`Verify by: ${scaffold.verificationCriteria}`)
  lines.push(`\nWork within this structure. Do not ignore these constraints.`)
  return lines.join('\n')
}
