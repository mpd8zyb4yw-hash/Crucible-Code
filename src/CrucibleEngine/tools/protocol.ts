// Tool protocol — provider-portable tool calling.
// Two modes, one contract:
//   1. Native: providers with OpenAI-compatible function-calling (Groq, Mistral,
//      OpenRouter) or Gemini functionDeclarations get the registry as JSON-schema
//      tools and return structured tool_calls.
//   2. Fence fallback: models without native support emit ONE ```json fence with
//      {"tool": name, "args": {...}}. Parsed with a balanced-brace scan, not regex.

export interface ToolCtx {
  projectPath: string
  /** Authenticated user ID — used by Google API tools to load per-user tokens. */
  userId?: string
  /** Remaining token budget for the enclosing loop; tools may consult it to cap output. */
  budget?: { remainingTokens: number }
  /** Stream an event to the client (SSE). */
  emit?: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  /** When false, mutating tools (write/edit/run) must refuse. */
  allowMutation?: boolean
  /** When true, the `run` tool permits commands flagged as destructive (rm -rf, force-push,
   *  outside-root deletes, etc.). Defaults to false — destructive ops are blocked and the agent
   *  is told to surface them to the user (Section 8 — destructive op confirmation). */
  allowDestructive?: boolean
  /** Called after a successful mutating tool call with the abs paths that were written.
   *  Used by the codebase indexer to stay fresh without coupling registry to codebaseIndex. */
  onFileMutated?: (absPaths: string[]) => void
}

export interface ToolResult {
  ok: boolean
  output: string
  truncated?: boolean
  meta?: Record<string, unknown>
}

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  params: Record<string, unknown>
  /** Marks tools that mutate state — gated by ctx.allowMutation. */
  mutates?: boolean
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

// ── Native-mode adapters ──────────────────────────────────────────────────────

/** OpenAI-compatible `tools` array (Groq / Mistral / OpenRouter). */
export function toOpenAITools(defs: ToolDef[]) {
  return defs.map(d => ({
    type: 'function' as const,
    function: { name: d.name, description: d.description, parameters: d.params },
  }))
}

/** Gemini functionDeclarations. */
export function toGeminiTools(defs: ToolDef[]) {
  return [{ functionDeclarations: defs.map(d => ({ name: d.name, description: d.description, parameters: d.params })) }]
}

/** Normalize OpenAI-style tool_calls from a chat completion message. */
export function fromOpenAIToolCalls(message: any): ToolCall[] {
  const calls = message?.tool_calls ?? []
  return calls.map((c: any, i: number) => ({
    id: c.id ?? `call_${i}`,
    name: c.function?.name ?? '',
    args: safeParseJSON(c.function?.arguments) ?? {},
  })).filter((c: ToolCall) => c.name)
}

/** Normalize Gemini functionCalls(). */
export function fromGeminiFunctionCalls(calls: Array<{ name: string; args: object }> | undefined): ToolCall[] {
  return (calls ?? []).map((c, i) => ({ id: `call_${i}`, name: c.name, args: (c.args as Record<string, unknown>) ?? {} }))
}

// ── Fence-mode (fallback) ─────────────────────────────────────────────────────

export function fenceProtocolPrompt(defs: ToolDef[]): string {
  const list = defs.map(d =>
    `- ${d.name}: ${d.description}\n  args schema: ${JSON.stringify(d.params)}`).join('\n')
  return `
You can call tools. To call one, reply with EXACTLY ONE fenced json block and nothing else:
\`\`\`json
{"tool": "<name>", "args": { ... }}
\`\`\`
Available tools:
${list}
After you receive the tool result, continue. When you have the final answer, reply normally with NO json fence.`
}

// Free models are inconsistent about the *shape* of a tool call even when the intent is
// unambiguous. Every unrecognized shape used to parse as "no tool call", which means the
// loop treated the raw JSON as the model's final answer and shipped it to the user. So the
// cost of being strict here is not a retry — it is a garbage answer. Hence the aliases.
const NAME_KEYS = ['tool', 'name', 'tool_name', 'toolName', 'function', 'action']
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input', 'tool_input', 'action_input']
/** Tool names are identifiers. Anything else is prose that happened to sit in a JSON object. */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/

export interface ParseFenceOptions {
  /** When supplied, a parsed name must be a real tool. This is what makes permissive
   *  parsing safe: without it we cannot tell a tool call from a model quoting JSON. */
  knownTools?: string[]
}

/**
 * Extract a single tool call from model text.
 * Scans every fenced block (then the raw text) for balanced JSON objects, accepts the
 * common name/args aliases, and falls back to repairing near-JSON. Returns the first
 * object that actually looks like a tool call — not merely the first object that parses.
 */
export function parseFenceToolCall(text: string, opts: ParseFenceOptions = {}): ToolCall | null {
  if (!text) return null
  const known = opts.knownTools?.length ? new Set(opts.knownTools) : null
  const sources: string[] = []
  // All fences, in order — a model may emit an illustrative code block before the real call.
  const fenceRe = /```(?:[a-zA-Z0-9_-]*)\s*\n?([\s\S]*?)```/g
  for (let m; (m = fenceRe.exec(text)) !== null;) sources.push(m[1])
  sources.push(text)

  for (const src of sources) {
    for (const obj of balancedJSONObjects(src)) {
      const call = toToolCall(obj, known)
      if (call) return call
    }
  }
  return null
}

/** Interpret a parsed object as a tool call, or null if it is not one. */
function toToolCall(obj: Record<string, unknown>, known: Set<string> | null): ToolCall | null {
  let nameRaw: unknown
  let argsRaw: unknown
  /** True for shapes that cannot plausibly be anything but a tool call. */
  let unambiguous = false

  for (const k of NAME_KEYS) {
    const v = obj[k]
    // OpenAI-ish nesting: {"function": {"name": "x", "arguments": "{...}"}}
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>
      const innerName = NAME_KEYS.map(nk => inner[nk]).find(x => typeof x === 'string')
      if (typeof innerName === 'string') {
        nameRaw = innerName
        argsRaw = ARG_KEYS.map(ak => inner[ak]).find(x => x !== undefined)
        unambiguous = true
        break
      }
    }
    if (typeof v === 'string') { nameRaw = v; unambiguous = k === 'tool'; break }
  }
  if (typeof nameRaw !== 'string') return null

  const name = nameRaw.trim()
  if (!NAME_RE.test(name)) return null
  if (known && !known.has(name)) return null

  if (argsRaw === undefined) argsRaw = ARG_KEYS.map(k => obj[k]).find(x => x !== undefined)

  // Permissive aliases would otherwise misread ordinary JSON in a final answer — a
  // {"name": "Alice", "role": "admin"} object is not a tool call. Require corroboration:
  // the canonical "tool" key, an explicit args key, or a name we know is a real tool.
  if (!unambiguous && argsRaw === undefined && !known?.has(name)) return null
  // `arguments` frequently arrives as a JSON *string* rather than an object.
  if (typeof argsRaw === 'string') argsRaw = safeParseJSON(argsRaw) ?? repairParseJSON(argsRaw)
  const args = argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
    ? (argsRaw as Record<string, unknown>)
    : {}
  return { id: 'fence_0', name, args }
}

/** Yield every balanced top-level {...} in the string that parses (strictly, then repaired). */
function* balancedJSONObjects(src: string): Generator<Record<string, unknown>> {
  let start = src.indexOf('{')
  while (start !== -1) {
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = start; i < src.length; i++) {
      const ch = src[i]
      if (esc) { esc = false; continue }
      if (ch === '\\' && inStr) { esc = true; continue }
      if (ch === '"') { inStr = !inStr; continue }
      if (inStr) continue
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) return  // unterminated — nothing further can balance either
    const slice = src.slice(start, end + 1)
    const parsed = safeParseJSON(slice) ?? repairParseJSON(slice)
    if (parsed) yield parsed
    start = src.indexOf('{', start + 1)
  }
}

/**
 * Last-resort parse of near-JSON. Only ever called after a strict parse has already
 * failed, so a bad repair cannot corrupt an otherwise-valid call.
 */
export function repairParseJSON(s: string): Record<string, unknown> | null {
  const attempts = [
    (x: string) => x.replace(/,(\s*[}\]])/g, '$1'),                          // trailing commas
    (x: string) => x.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'),
    (x: string) => x.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3'),  // unquoted keys
    (x: string) => x.replace(/'([^'\\]*)'/g, '"$1"'),                        // single-quoted strings
  ]
  // Apply cumulatively — a broken payload usually has more than one of these defects.
  let cur = s
  for (const fix of attempts) {
    cur = fix(cur)
    const parsed = safeParseJSON(cur)
    if (parsed) return parsed
  }
  return null
}

export function safeParseJSON(s: unknown): Record<string, unknown> | null {
  if (typeof s !== 'string') return null
  try { return JSON.parse(s) } catch { return null }
}
