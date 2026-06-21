// Specialist agent archetypes (Track I1) — system prompt + tool access config.
// Each archetype layers on top of the existing runAgentLoop infrastructure.
// No new loop code — just configuration passed to AgentLoopOpts.

import type { ToolDef } from '../tools/protocol'

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
      'When you need to read a paper, chart, or image, call read_pdf or read_image to extract its contents yourself ' +
      'rather than asking the user to paste the content. ' +
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

// Infer a coarse capability category for a tool from its name + mutates flag.
// ToolDef carries no category, so we map by name. 'misc' = neutral helpers
// (e.g. ensemble_solve) that every specialist may use.
function toolCategory(t: ToolDef): string {
  const n = t.name
  if (n === 'ask_user') return 'interactive'   // not granted to specialists — the orchestrator owns user contact
  if (n === 'run') return 'execute'
  // Mutation/write tools FIRST — a writing tool must never fall through to a softer
  // category (e.g. write_global_memory matching /memory/ and reaching a read-only archetype).
  if (t.mutates || /^(write_file|edit_file|apply_patch|delete_file|delete_folder|move_file|download_file|empty_trash|create_tool|type_text|click_element|navigate_browser|open_app|write_global_memory)$/.test(n)) return 'write'
  if (/^(read_file|read_image|read_pdf|list_dir|get_ui_tree|date|google_services_status|list_dynamic_tools)$/.test(n)) return 'read'
  if (/^web_search$|^search$|^custom_search$|^image_search$|search_youtube|youtube_search_api|knowledge_graph_search|maps_directions$/.test(n)) return 'search'
  if (/world|knowledge_graph/.test(n)) return 'world'
  if (/memory/.test(n)) return 'memory'
  if (/codebase|reindex|code_index/.test(n)) return 'codebase'
  return 'misc'
}

// Return only the tools a given archetype is permitted to use. Enforced at the
// driveTurn boundary so a 'critic' physically cannot write files and a 'researcher'
// cannot run shell commands — making the specialist separation real, not cosmetic.
export function buildArchetypeTools(id: ArchetypeId, allTools: ToolDef[]): ToolDef[] {
  const a = ARCHETYPES[id]
  const allowed = new Set(a.allowedToolCategories)
  return allTools.filter(t => {
    if (a.deniedTools.includes(t.name)) return false
    const cat = toolCategory(t)
    if (cat === 'misc' || cat === 'read') return true   // neutral + read tools available to all
    return allowed.has(cat)
  })
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
