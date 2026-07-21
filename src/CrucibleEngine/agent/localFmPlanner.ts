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

// GUI-control tools read/drive the LIVE macOS desktop (the frontmost window's
// accessibility tree, clicks, keystrokes). They only make sense when the goal actually
// expresses desktop-interaction intent. Offered indiscriminately they are a standing
// temptation for the weak on-device planner: a plain reasoning/math brief ("what is
// 17×4?") would sometimes emit a get_ui_tree step, whose output — during an UNATTENDED
// automation run the frontmost window is Crucible itself — is self-referential garbage
// ("APP: Claude\nWINDOW: …") that then got summarized as the answer (live, 2026-07-20).
// Without desktop intent these tools are removed from BOTH the prompt and the validation
// allowlist, so the planner can neither see nor smuggle them in.
const GUI_CONTROL_TOOLS = new Set(['get_ui_tree', 'click_element', 'type_text'])
const allowedFor = (desktopIntent: boolean): Set<string> =>
  desktopIntent ? ALLOWED_TOOLS : new Set([...ALLOWED_TOOLS].filter(t => !GUI_CONTROL_TOOLS.has(t)))

// Max characters we send to FM. 280 was tuned for <500ms on A18 but rejected legitimate
// single-step requests that merely carried context ("open the spreadsheet I was just looking
// at in Downloads called Q3-forecast and…"), forcing them onto the slower LLM loop. Raised to
// 360: the SYSTEM prompt dominates the token budget, so the marginal latency of ~80 more input
// chars is well under the ceiling, while more real one-shot commands now reach Layer 2. The
// HARD_PASS / MULTI_STEP / ACTION_VERB guards still divert anything genuinely multi-step.
const MAX_INPUT_CHARS = 360

// Requests that Layer 2 should never attempt — hand to LLM immediately.
const HARD_PASS = /\b(refactor|rewrite|implement|build|fix|debug|write (a |the )?function|create (a |the )?class|edit (the )?file|open (the )?file|in vs ?code|in xcode|commit|push|pull request|deploy|test|spec|unit test)\b/i

const TOOL_SPECS: Record<string, string> = {
  open_app: '- open_app: {"target":"App Name or URL or file path"}',
  shell_exec: '- shell_exec: {"command":"shell command string"}',
  get_ui_tree: '- get_ui_tree: {}',
  click_element: '- click_element: {"label":"button or menu item label"}',
  type_text: '- type_text: {"text":"text to type"}',
  search_web: '- search_web: {"query":"search query"}',
  search_youtube: '- search_youtube: {"query":"search query"}',
}

// Built per-request so the tool menu reflects exactly what this goal is allowed to use —
// a goal without desktop intent never even sees the GUI-control tools.
function buildSystem(allowed: Set<string>): string {
  const specs = [...allowed].map(t => TOOL_SPECS[t]).filter(Boolean).join('\n')
  return `You are a macOS automation planner. Given a user request, output a JSON object (NO markdown fences) with this exact shape:
{"intent":"short label","steps":[{"tool":"tool_name","args":{}}],"summary":"one-line prediction"}

Allowed tools and their required args:
${specs}

Rules:
- Use 1–3 steps only. No chaining beyond that.
- Only use tools from the list above.
- For a specific video, song, or clip the user wants to watch/play: use search_youtube. NEVER
  construct a youtube.com/watch or youtu.be URL yourself — invented video IDs are dead links.
- Use open_app with a URL ONLY for a site the user names by domain (e.g. "go to github.com").
- If you cannot confidently plan with the given tools, output: {"intent":"pass","steps":[],"summary":""}
- Output ONLY the JSON object, nothing else.`
}

// Model-constructed media/watch URLs are almost always hallucinated (dead video IDs).
// Any plan that opens one is rejected → the full LLM loop replans with search_youtube.
const HALLUCINATED_MEDIA_URL = /(youtube\.com\/watch|youtu\.be\/|\/watch\?v=|vimeo\.com\/\d|dailymotion\.com\/video)/i

// Multi-step / sequenced requests ("open settings, set brightness, then play a video") exceed
// Layer 2's 1–3 simple-step scope — hand them to the LLM loop which can truly plan + iterate.
// Pure reasoning / knowledge / arithmetic requests. This module is a macOS AUTOMATION planner —
// there is no tool here that answers "what is 17 + 4", so when the weak on-device planner is
// handed one it does not abstain, it reaches for the nearest tool it can see: live 2026-07-21,
// the automation brief "State the sum of 17 and 4, and nothing else" produced a 1-2 step
// shell_exec plan whose entire output was "exit 0". Same failure mode the GUI_CONTROL_TOOLS gate
// above was added for, one tool over.
//
// Bailing here (BEFORE the FM call, so it also saves a model round-trip) is strictly better than
// letting the plan run and rejecting it afterwards. Gated on !desktopIntent so a genuine
// desktop question still reaches Layer 2 — and note that when desktopIntent is false the
// GUI-control tools are already stripped, so such a goal has no tool that could answer it here
// anyway. Deliberately NOT keyed on "no action verb": in-scope goals like "screenshot the
// screen" match neither ACTION_VERB nor DESKTOP_ACTION (which is ^-anchored) and must still pass.
const PURE_REASONING = /^(?:state|calculate|compute|work out|figure out|what|which|who|whom|whose|when|why|how|define|explain|describe|summari[sz]e|translate|is|are|was|were|does|do|did|can|could|would|should)\b/i

const MULTI_STEP = /\b(?:then|after that|and then)\b/i
const ACTION_VERB = /\b(?:open|turn|set|play|show|find|search|close|launch|go to|put on|click|type|increase|decrease|adjust|mute|change|switch)\b/gi

/**
 * Drop a leading bracketed scaffolding block so ^-anchored guards see the ACTUAL request.
 * Exported for the bench: the automation preamble is what let a pure-reasoning brief through.
 */
export function stripPreamble(text: string): string {
  return text.replace(/^\s*\[[^\]]*\]\s*/, '').trim()
}

export type LocalSynth = (system: string, user: string) => Promise<string>

/**
 * Attempt to plan and describe execution of `message` using Apple FM on-device.
 * Returns a validated FmPlan, or null if FM can't handle it (caller uses LLM loop).
 */
export async function localFmPlan(
  message: string,
  localSynth: LocalSynth,
  opts: { desktopIntent?: boolean } = {},
): Promise<FmPlan | null> {
  const q = (message ?? '').trim()
  if (q.length < 4 || q.length > MAX_INPUT_CHARS) return null
  if (HARD_PASS.test(q)) return null
  // An unattended automation run arrives as "[Standing automation "name" — …] \n\n <brief>", so the
  // real request does not start at index 0. Strip a leading bracketed preamble before any
  // ^-anchored test, or every scheduled run silently bypasses those guards.
  if (PURE_REASONING.test(stripPreamble(q)) && !opts.desktopIntent) return null
  // Compound / sequenced request → exceeds Layer 2's simple-step scope; let the LLM loop plan it.
  if (MULTI_STEP.test(q) || (q.match(ACTION_VERB)?.length ?? 0) >= 3) return null

  // GUI-control tools are offered only when the caller confirms desktop-interaction intent.
  const allowed = allowedFor(opts.desktopIntent ?? false)

  let raw: string
  try {
    raw = await localSynth(buildSystem(allowed), q)
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
    if (!allowed.has(step.tool)) return null
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
