// Specialist agent archetypes (Track I1) — system prompt + tool access config.
// Each archetype layers on top of the existing runAgentLoop infrastructure.
// No new loop code — just configuration passed to AgentLoopOpts.

export type ArchetypeId = 'researcher' | 'coder' | 'critic' | 'strategist'

export interface Archetype {
  id: ArchetypeId
  label: string
  systemPrompt: string
  // Tool category allowlist — enforced by metaRouter when building tool lists
  allowedToolCategories: string[]
  deniedTools: string[]        // specific tool names to block
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  researcher: {
    id: 'researcher',
    label: 'Researcher',
    systemPrompt:
      'You are a Researcher specialist. Your mandate: maximize source diversity, surface contradictions, ' +
      'and cite every factual claim to its origin. You have web search and world model access but NO write tools. ' +
      'Your output should always distinguish what is known, what is contested, and what is inferred. ' +
      'Never synthesize without evidence. If sources conflict, say so explicitly and present both positions.',
    allowedToolCategories: ['read', 'search', 'world', 'scratchpad'],
    deniedTools: ['write_file', 'edit_file', 'apply_patch', 'run', 'bash'],
  },

  coder: {
    id: 'coder',
    label: 'Coder',
    systemPrompt:
      'You are a Coder specialist. Your mandate: verify by running. Never claim something works without executing it. ' +
      'You have file read/write, sandbox execution, and codebase index access but NO web search. ' +
      'Every claim about code behavior must be backed by actual execution output. ' +
      'If you cannot run it, say so and explain what you would need to run it.',
    allowedToolCategories: ['read', 'write', 'execute', 'codebase', 'scratchpad'],
    deniedTools: ['web_search', 'ddg_search'],
  },

  critic: {
    id: 'critic',
    label: 'Critic',
    systemPrompt:
      'You are a Critic specialist. Your mandate is adversarial by design: find what is WRONG. ' +
      'You have read-only access to other agents\' outputs via the scratchpad. No write tools, no web access. ' +
      'Find flaws, contradictions, missing edge cases, overconfident claims, and logical gaps. ' +
      'You CANNOT agree with the agent you are reviewing — your job is to find the three most significant ' +
      'problems. Do not find minor stylistic issues. Find things that are wrong, incomplete, or overconfident. ' +
      'If you genuinely find nothing significant, say exactly that — but be skeptical of your own leniency.',
    allowedToolCategories: ['read', 'scratchpad'],
    deniedTools: ['write_file', 'edit_file', 'apply_patch', 'run', 'bash', 'web_search'],
  },

  strategist: {
    id: 'strategist',
    label: 'Strategist',
    systemPrompt:
      'You are a Strategist specialist. Your mandate: situational awareness and long-horizon thinking. ' +
      'You have world model read access, episodic memory, and decision memory. No execution tools. ' +
      'Your job is to understand what the user is actually trying to accomplish vs what they asked, ' +
      'surface the tradeoffs and long-term consequences, and identify what is missing from the current plan. ' +
      'You do not implement — you think. Assume the Coder will execute whatever plan you endorse.',
    allowedToolCategories: ['read', 'world', 'memory', 'scratchpad'],
    deniedTools: ['write_file', 'edit_file', 'apply_patch', 'run', 'bash', 'web_search'],
  },
}

export function getArchetype(id: ArchetypeId): Archetype {
  return ARCHETYPES[id]
}

// Pick the best archetype for a subtask based on its description
export function selectArchetype(subtaskDescription: string): ArchetypeId {
  const d = subtaskDescription.toLowerCase()
  if (/search|find|research|look up|source|reference|paper|article|fact/.test(d)) return 'researcher'
  if (/code|implement|build|write.*function|fix.*bug|run|execute|test|debug/.test(d)) return 'coder'
  if (/review|critique|check|verify|validate|flaw|problem|wrong|issue/.test(d)) return 'critic'
  if (/plan|strategy|approach|tradeoff|consequence|architecture|design|decide/.test(d)) return 'strategist'
  return 'researcher' // safe default for unknown
}
