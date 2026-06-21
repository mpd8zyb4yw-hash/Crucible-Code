// ── Local FM Planner — Offline-First agentic execution (Track O, Layer 2) ──
//
// Layer 0 (localIntentRouter) handles unambiguous commands deterministically.
// Layer 1 (corpusFirst) answers knowledge questions from the living corpus.
// Layer 2 (this module) handles the middle ground: agentic requests that need
// a small amount of reasoning to plan (2–4 tool calls) but don't require the
// full LLM agent loop. It uses the Apple FM daemon (port 11435, on-device,
// zero API cost) to pick tools and args, then executes them locally.
//
// FM DAEMON CONSTRAINT: The Apple FM bridge is chat-completion only — it has
// no function/tool calling API. We work around this by giving FM a compact
// JSON schema in the system prompt and asking it to respond with raw JSON.
// We parse + validate the response and fall through to the LLM loop on any
// schema violation. HIGH PRECISION: if FM output can't be validated, return null.
//
// Scope — Layer 2 fires on requests that:
//   • Are agentic (user wants the Mac to DO something)
//   • Layer 0 didn't match (not a direct open/play/click/type command)
//   • Require 1–3 reasoning steps FM can handle on-device
//   • Do NOT require multi-step planning, iteration, or code execution
//
// Examples in scope:
//   "what's the frontmost app" → get_ui_tree → summarise
//   "screenshot the screen" → shell_exec screencapture
//   "open crucible project in VS Code" → open_app with path
//   "go to github.com/anthropics" → open_app with URL
//
// Examples out of scope (Layer 2 returns null → LLM loop):
//   "refactor this function" — requires code context + iteration
//   "book a flight to Rome" — multi-step web + form interaction

import type { ToolResult } from '../tools/protocol'

export interface FmStep {
  tool: string
  args: Record<string, unknown>
}

export interface FmPlan {
  intent: string
  steps: FmStep[]
  summary: string  // FM's prediction of the final reply — replaced by real result
}

// Tools Layer 2 is allowed to use. Anything beyond this → null (LLM takes over).
const ALLOWED_TOOLS = new Set([
  'open_app', 'shell_exec', 'get_ui_tree', 'click_element', 'type_text',
  'search_web', 'search_youtube',
])

// Max characters we send to FM. Keeps latency under ~500ms on A18.
const MAX_INPUT_CHARS = 280

// Requests that Layer 2 should never attempt — hand to LLM immediately.
const HARD_PASS = /\b(refactor|rewrite|implement|build|fix|debug|write (a |the )?function|create (a |the )?class|edit (the )?file|open (the )?file|in vs ?code|in xcode|commit|push|pull request|deploy|test|spec|unit test)\b/i

const SYSTEM = `You are a macOS automation planner. Given a user request, output a JSON object (NO markdown fences) with this exact shape:
{"intent":"short label","steps":[{"tool":"tool_name","args":{}}],"summary":"one-line prediction"}

Allowed tools and their required args:
- open_app: {"target":"App Name or URL or file path"}
- shell_exec: {"command":"shell command string"}
- get_ui_tree: {}
- click_element: {"label":"button or menu item label"}
- type_text: {"text":"text to type"}
- search_web: {"query":"search query"}
- search_youtube: {"query":"search query"}

Rules:
- Use 1–3 steps only. No chaining beyond that.
- Only use tools from the list above.
- For a specific video, song, or clip the user wants to watch/play: use search_youtube. NEVER
  construct a youtube.com/watch or youtu.be URL yourself — invented video IDs are dead links.
- Use open_app with a URL ONLY for a site the user names by domain (e.g. "go to github.com").
- If you cannot confidently plan with the given tools, output: {"intent":"pass","steps":[],"summary":""}
- Output ONLY the JSON object, nothing else.`

// Model-constructed media/watch URLs are almost always hallucinated (dead video IDs).
// Any plan that opens one is rejected → the full LLM loop replans with search_youtube.
const HALLUCINATED_MEDIA_URL = /(youtube\.com\/watch|youtu\.be\/|\/watch\?v=|vimeo\.com\/\d|dailymotion\.com\/video)/i

// Multi-step / sequenced requests ("open settings, set brightness, then play a video") exceed
// Layer 2's 1–3 simple-step scope — hand them to the LLM loop which can truly plan + iterate.
const MULTI_STEP = /\b(?:then|after that|and then)\b/i
const ACTION_VERB = /\b(?:open|turn|set|play|show|find|search|close|launch|go to|put on|click|type|increase|decrease|adjust|mute|change|switch)\b/gi

export type LocalSynth = (system: string, user: string) => Promise<string>

/**
 * Attempt to plan and describe execution of `message` using Apple FM on-device.
 * Returns a validated FmPlan, or null if FM can't handle it (caller uses LLM loop).
 */
export async function localFmPlan(
  message: string,
  localSynth: LocalSynth,
): Promise<FmPlan | null> {
  const q = (message ?? '').trim()
  if (q.length < 4 || q.length > MAX_INPUT_CHARS) return null
  if (HARD_PASS.test(q)) return null
  // Compound / sequenced request → exceeds Layer 2's simple-step scope; let the LLM loop plan it.
  if (MULTI_STEP.test(q) || (q.match(ACTION_VERB)?.length ?? 0) >= 3) return null

  let raw: string
  try {
    raw = await localSynth(SYSTEM, q)
  } catch {
    return null
  }

  // Strip any accidental markdown fences.
  const jsonStr = raw.replace(/```(?:json)?/gi, '').trim()
  const start = jsonStr.indexOf('{')
  const end = jsonStr.lastIndexOf('}')
  if (start === -1 || end === -1) return null

  let plan: any
  try {
    plan = JSON.parse(jsonStr.slice(start, end + 1))
  } catch {
    return null
  }

  // Validate shape.
  if (typeof plan?.intent !== 'string') return null
  if (plan.intent === 'pass' || !Array.isArray(plan.steps) || plan.steps.length === 0) return null
  if (plan.steps.length > 3) return null

  for (const step of plan.steps) {
    if (typeof step?.tool !== 'string') return null
    if (!ALLOWED_TOOLS.has(step.tool)) return null
    if (typeof step?.args !== 'object' || step.args === null) return null
    // Safety net: never execute a model-constructed video/watch URL — the FM hallucinates
    // video IDs (dead links). Reject the whole plan so the LLM loop replans via search_youtube.
    if (step.tool === 'open_app' && HALLUCINATED_MEDIA_URL.test(String((step.args as any).target ?? ''))) {
      return null
    }
  }

  return {
    intent: String(plan.intent).slice(0, 80),
    steps: plan.steps as FmStep[],
    summary: typeof plan.summary === 'string' ? plan.summary : '',
  }
}

/**
 * Execute a validated FmPlan step-by-step.
 * Returns { ok, summary } — same shape as runLocalPlan in Layer 0.
 */
export async function runFmPlan(
  plan: FmPlan,
  exec: (call: { tool: string; args: Record<string, unknown> }) => Promise<ToolResult>,
): Promise<{ ok: boolean; summary: string }> {
  const results: string[] = []
  for (const step of plan.steps) {
    let res: ToolResult
    try {
      res = await exec({ tool: step.tool, args: step.args })
    } catch (e: any) {
      return { ok: false, summary: `Tool ${step.tool} threw: ${String(e?.message ?? e).slice(0, 120)}` }
    }
    if (!res.ok) {
      return { ok: false, summary: res.output ?? `${step.tool} failed` }
    }
    if (res.output) results.push(res.output)
  }

  const body = results.filter(Boolean).join('\n').trim()
  // If the execution produced output (e.g. get_ui_tree), return it.
  // Otherwise confirm with the plan's predicted summary.
  const summary = body || plan.summary || `Done: ${plan.intent}`
  return { ok: true, summary }
}
