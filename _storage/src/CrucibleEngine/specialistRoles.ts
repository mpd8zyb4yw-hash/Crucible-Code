// Step 3 — Specialist Compute Lane
// Each Stage 1 model is assigned a specialist role that layers a focused system-prompt
// addendum on top of the shared Stage 1 prompt. For complex queries this turns the
// ensemble from "N copies of the same prompt" into "N genuinely distinct analysts."
//
// Simple queries get no specialist layer — cost-not-worth-it on fast-path calls.

export type SpecialistRole =
  | 'factual-verifier'
  | 'code-analyst'
  | 'math-prover'
  | 'reasoning-critic'
  | 'domain-expert'
  | 'contrarian'
  | 'simplifier'
  | 'integrator'

export interface RoleDefinition {
  id: SpecialistRole
  label: string
  /** Appended after the shared Stage 1 system prompt */
  addendum: string
  /** Prompt types this role is preferred for */
  preferredTypes: string[]
  /** Prompt types this role is penalised for (won't be primary pick) */
  avoidTypes: string[]
}

export const SPECIALIST_ROLES: RoleDefinition[] = [
  {
    id: 'factual-verifier',
    label: 'Factual Verifier',
    addendum:
      'YOUR ROLE THIS ROUND: Factual Verifier.\n' +
      'Prioritize accuracy above completeness. Flag any claim you are uncertain about ' +
      'with a qualifier ("likely", "as of my training", "unverified"). ' +
      'If you cannot verify something with high confidence, say so explicitly rather than stating it as fact. ' +
      'Cite reasoning for controversial or non-obvious claims.',
    preferredTypes: ['factual', 'general'],
    avoidTypes: ['coding'],
  },
  {
    id: 'code-analyst',
    label: 'Code Analyst',
    addendum:
      'YOUR ROLE THIS ROUND: Code Analyst.\n' +
      'Verify correctness by construction. Write executable, tested code wherever possible. ' +
      'Flag edge cases, off-by-one errors, and security issues explicitly. ' +
      'If referencing a library or API, double-check the method signatures from your training data. ' +
      'Prefer concrete runnable examples over abstract explanations.',
    preferredTypes: ['coding'],
    avoidTypes: ['creative'],
  },
  {
    id: 'math-prover',
    label: 'Math Prover',
    addendum:
      'YOUR ROLE THIS ROUND: Math Prover.\n' +
      'Break every claim into formal steps. Show your work. ' +
      'Validate each intermediate result before using it in the next step. ' +
      'If a numeric claim is central to the answer, compute it explicitly — do not approximate unless approximation is the question. ' +
      'Flag where symbolic vs numeric distinction matters.',
    preferredTypes: ['math', 'reasoning'],
    avoidTypes: ['creative', 'factual'],
  },
  {
    id: 'reasoning-critic',
    label: 'Reasoning Critic',
    addendum:
      'YOUR ROLE THIS ROUND: Reasoning Critic.\n' +
      'Your primary job is to identify the weakest link in the reasoning chain. ' +
      'Find hidden assumptions. Test edge cases the straightforward answer misses. ' +
      'If the obvious answer has a flaw, surface it and provide the corrected version. ' +
      'Do not over-explain the strong parts — spend your tokens on the places where the logic is fragile.',
    preferredTypes: ['reasoning', 'general'],
    avoidTypes: ['coding'],
  },
  {
    id: 'domain-expert',
    label: 'Domain Expert',
    addendum:
      'YOUR ROLE THIS ROUND: Domain Expert.\n' +
      'Apply specialist depth. Go beyond the surface answer into the underlying principles, ' +
      'historical context, and professional practice in this domain. ' +
      'Distinguish beginner-level explanations from expert-level nuance. ' +
      'Identify terminology that is commonly misunderstood or oversimplified.',
    preferredTypes: ['factual', 'reasoning', 'math'],
    avoidTypes: [],
  },
  {
    id: 'contrarian',
    label: 'Contrarian',
    addendum:
      'YOUR ROLE THIS ROUND: Contrarian.\n' +
      'Assume the obvious answer is incomplete or wrong. ' +
      'Argue for the strongest counter-position or alternative interpretation. ' +
      'Not for the sake of argument — but because the space of wrong-but-plausible answers is where hidden truth lives. ' +
      'If you agree with the obvious answer after analysis, say so explicitly and explain why the contrarian case fails.',
    preferredTypes: ['reasoning', 'general'],
    avoidTypes: ['math', 'coding'],
  },
  {
    id: 'simplifier',
    label: 'Simplifier',
    addendum:
      'YOUR ROLE THIS ROUND: Simplifier.\n' +
      'Strip the answer to its essential core. Remove jargon that obscures rather than illuminates. ' +
      'Use concrete examples, analogies, or the simplest possible formulation. ' +
      'If the question has a one-sentence core answer, lead with it before elaborating. ' +
      'Prefer clarity over comprehensiveness.',
    preferredTypes: ['general', 'factual'],
    avoidTypes: ['math'],
  },
  {
    id: 'integrator',
    label: 'Integrator',
    addendum:
      'YOUR ROLE THIS ROUND: Integrator.\n' +
      'Connect this question to adjacent disciplines. Find the structural similarity to a problem ' +
      'solved in a different field. Identify what a physicist, economist, and biologist would each ' +
      'say about this — and where they would disagree. ' +
      'The best answer often lives at the intersection of multiple perspectives, not within one.',
    preferredTypes: ['reasoning', 'general', 'factual'],
    avoidTypes: ['coding'],
  },
]

// How many specialists to assign per run (avoid over-specialising small ensembles)
const MAX_SPECIALISTS = 5

/**
 * Assign specialist roles to an ordered list of model IDs.
 * Returns a map of modelId → RoleDefinition for models that get a role.
 * Models that don't get a role receive no addendum (plain Stage 1 prompt).
 */
export function assignSpecialistRoles(
  modelIds: string[],
  promptType: string,
  complexity: string,
): Map<string, RoleDefinition> {
  const result = new Map<string, RoleDefinition>()
  if (complexity !== 'complex' || modelIds.length < 2) return result

  // Build a prioritized role queue: preferred roles for this promptType first
  const preferred: RoleDefinition[] = []
  const secondary: RoleDefinition[] = []
  for (const role of SPECIALIST_ROLES) {
    if (role.avoidTypes.includes(promptType)) continue
    if (role.preferredTypes.includes(promptType)) {
      preferred.push(role)
    } else {
      secondary.push(role)
    }
  }
  const roleQueue = [...preferred, ...secondary]

  // Assign one role per model, up to MAX_SPECIALISTS, cycling through the queue
  const count = Math.min(modelIds.length, MAX_SPECIALISTS, roleQueue.length)
  for (let i = 0; i < count; i++) {
    result.set(modelIds[i], roleQueue[i % roleQueue.length])
  }

  return result
}

/**
 * Build the system prompt addendum for a model's assigned role.
 * Returns '' if the model has no role assigned.
 */
export function buildRoleAddendum(modelId: string, roleMap: Map<string, RoleDefinition>): string {
  const role = roleMap.get(modelId)
  if (!role) return ''
  return `\n\n---\n${role.addendum}`
}
