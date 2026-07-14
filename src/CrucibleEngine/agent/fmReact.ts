// FM ReAct Loop — structured tool-calling for the Apple Foundation Model.
//
// The FM has no native tool-calling API. We work around this by:
//   1. Giving FM a structured text format for emitting tool requests
//   2. Node parses the format and executes the tool
//   3. Node feeds results back to FM as context
//   4. Repeat until FM emits a FINAL_ANSWER or budget exhausted
//
// Output format expected from FM (one per response):
//
//   TOOL: <tool_name>
//   <key>: <value>
//   ...
//
//   or
//
//   FINAL_ANSWER:
//   <answer text spanning multiple lines>
//
// The Node side executes one tool call per round and passes the result back.
// Simple single-action responses like "ANSWER: ..." also accepted.

import { search, fetch as fetchPage, stripBoilerplate } from '../retrieval/retrievalLayer'
import { queryLivingCorpus } from '../corpus/query'
import { debugBus } from '../debug/bus'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { enqueueFm } from './fmQueue'

const FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
const DEFAULT_MAX_ROUNDS = 8
// Healthy generation measured at 21-28s, already against the old 30s ceiling —
// under load this crossed it, fired AbortSignal.timeout, and got misreported as
// "daemon unreachable" (see server.ts's offline_conversational_escalate catch).
//
// Item-9 fix (2026-07-07): in CRUCIBLE_OFFLINE=strict there is NO external pool to escalate
// to, so a slow FM on a genuinely hard task must be allowed to GRIND to completion rather than
// aborting empty-handed — a hard 45s ceiling that kills the task and returns nothing is the
// single most trust-damaging failure. Strict mode gets a generous ceiling (still bounded so a
// truly wedged daemon can't hang forever); hybrid keeps the short ceiling so a stall escalates
// quickly to the external pool. Both env-overridable for tuning.
// cont.47: gate on !== '0', not === 'strict'. Since cont.36c the server forces
// requestOffline='strict' PER-REQUEST for every non-quorum chat regardless of env, so with
// the default env ('1') these strict requests ran with the short hybrid ceiling AND no
// external fallback — a hard code-gen turn blew the 45s window and the raw AbortSignal
// DOMException ("The operation was aborted due to timeout") became the user-facing answer.
// Only an explicit CRUCIBLE_OFFLINE=0 (external-only) keeps the short ceiling.
const FM_STRICT = (process.env.CRUCIBLE_OFFLINE ?? '1') !== '0'
const FM_TIMEOUT_MS = Number(
  process.env.CRUCIBLE_FM_TIMEOUT_MS ?? (FM_STRICT ? 600_000 : 45_000),
)

// ── FM call helper ────────────────────────────────────────────────────────────

// Apple FM's on-device session throws a transient `GenerationError error -1`
// (surfaced as an HTTP-200 body `{"error":{"message":"generation_failed: …"}}`) when the
// device is under concurrent load — e.g. the background autoImprove pass + keepalive pings
// hitting the daemon at the same time as a live request. It recovers on a fresh session, so
// a short bounded retry with backoff turns an otherwise-fatal empty answer into a good one.
const FM_GEN_RETRIES = Number(process.env.CRUCIBLE_FM_GEN_RETRIES ?? 2)

/** Marks a retryable transient generation failure (as opposed to a permanent error). */
class FmTransientError extends Error {}

export interface FmCallOpts {
  temperature?: number
  /** Per-call daemon timeout. Verification lanes pass a SHORT one so a slow/wedged optional
   *  call can't hold the concurrency-1 gate for the full strict ceiling and starve the next
   *  live request. */
  timeoutMs?: number
  /** Queue priority. The primary draft is 'high'; optional verification lanes are 'normal'
   *  so a NEW request's draft always jumps ahead of leftover verification work. */
  priority?: 'high' | 'normal' | 'low'
  /** Abort signal — a disconnected client cancels its remaining verification fan-out. */
  signal?: AbortSignal
  /** Cap generated tokens. Apple FM latency scales with OUTPUT length, so a focused answer
   *  (grounded synthesis, short lookups) sets this low to stay fast. Defaults to 1536. */
  maxTokens?: number
}

async function callFm(system: string, messages: FmMessage[], timeoutMs = FM_TIMEOUT_MS, temperature?: number, priority: 'high' | 'normal' | 'low' = 'high', signal?: AbortSignal, maxTokens = 1536): Promise<string> {
  let lastErr: any
  for (let attempt = 0; attempt <= FM_GEN_RETRIES; attempt++) {
    try {
      return await callFmInner(system, messages, timeoutMs, temperature, priority, signal, maxTokens)
    } catch (e: any) {
      lastErr = e
      // Transient on-device generation failure — brief backoff then retry a fresh session.
      if (e instanceof FmTransientError && attempt < FM_GEN_RETRIES) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
        continue
      }
      // Never let the raw AbortSignal DOMException ("The operation was aborted due to
      // timeout") propagate — it has surfaced verbatim as a chat answer. Rethrow with a
      // message a user (and the escalation path) can act on.
      if (e?.name === 'TimeoutError' || /aborted due to timeout/i.test(String(e?.message ?? ''))) {
        throw new Error(`Local model timed out after ${Math.round(timeoutMs / 1000)}s (Apple FM daemon on ${FM_URL})`)
      }
      throw e
    }
  }
  throw lastErr
}

async function callFmInner(system: string, messages: FmMessage[], timeoutMs: number, temperature = 0.2, priority: 'high' | 'normal' | 'low' = 'high', signal?: AbortSignal, maxTokens = 1536): Promise<string> {
  // Serialize the single-session daemon (fmQueue): interactive React/VGR/chat runs at HIGH
  // priority so it jumps ahead of any waiting background (autoImprove) work. Prevents the
  // concurrent-load GenerationError that starved live VGR searches. Optional verification
  // lanes pass priority:'normal' so a fresh request's HIGH draft preempts them on the gate.
  if (signal?.aborted) throw new Error('aborted before FM call')
  // Combine the caller's abort signal with the per-call timeout so a disconnected client
  // (or a wedged call hitting the ceiling) both release the gate promptly.
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const res = await enqueueFm(() => fetch(`${FM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'apple-fm',
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: maxTokens,
      temperature,
    }),
    signal: combined,
  }), { priority, label: priority === 'high' ? 'fmReact' : 'fmVerify' })
  if (!res.ok) throw new Error(`FM HTTP ${res.status}`)
  const data = await res.json() as any
  // The daemon returns HTTP 200 with an `{error:{message}}` body on an on-device
  // generation failure — there are no `choices`, so the old `?? ''` silently shipped an
  // EMPTY answer that downstream treated as "FM has nothing", skipping retry/fallback and
  // hanging the turn. Surface it as a (retryable) error instead of swallowing it.
  if (data?.error) {
    const msg = String(data.error?.message ?? data.error)
    if (/generation_failed|GenerationError|error -1|-1\)/i.test(msg)) throw new FmTransientError(msg)
    throw new Error(`FM error: ${msg}`)
  }
  return (data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface FmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface FmReactTool {
  name: string
  description: string
  params: string   // human-readable param description for the FM
  execute: (args: Record<string, string>, signal?: AbortSignal) => Promise<string>
}

export interface FmReactOpts {
  goal: string
  projectPath?: string
  maxRounds?: number
  signal?: AbortSignal
  /** Extra tools beyond the default set. */
  extraTools?: FmReactTool[]
  /** Disable web search (e.g. for pure coding tasks). */
  noSearch?: boolean
  /** Prior conversation turns for multi-turn context. */
  history?: ConvTurn[]
}

export interface FmReactResult {
  answer: string
  rounds: number
  toolsUsed: string[]
  abstained: boolean
}

// ── Built-in tools ────────────────────────────────────────────────────────────

function makeDefaultTools(projectPath?: string, noSearch?: boolean): FmReactTool[] {
  const tools: FmReactTool[] = []

  if (!noSearch) {
    tools.push({
      name: 'search',
      description: 'Search the web for information',
      params: 'query: the search query string',
      async execute({ query }) {
        if (!query) return 'Error: query required'
        const results = await search(query)
        if (!results.length) return 'No results found.'
        return results.slice(0, 5).map(r => `## ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n')
      },
    })

    tools.push({
      name: 'fetch_page',
      description: 'Fetch the text content of a web page',
      params: 'url: the full URL to fetch',
      async execute({ url }) {
        if (!url) return 'Error: url required'
        try {
          const raw = await fetchPage(url)
          const text = stripBoilerplate(raw)
          return text.slice(0, 4000) || 'Page fetched but no readable content found.'
        } catch (e: any) {
          return `Error fetching page: ${e?.message ?? e}`
        }
      },
    })
  }

  tools.push({
    name: 'corpus_query',
    description: 'Query the local knowledge corpus for relevant information',
    params: 'query: what to look for',
    async execute({ query }) {
      if (!query) return 'Error: query required'
      const hits = await queryLivingCorpus(query, { limit: 5 })
      if (!hits.length) return 'No relevant corpus entries found.'
      return hits.map(h => `## ${h.title ?? h.url ?? 'chunk'}\n${h.text.slice(0, 600)}`).join('\n\n')
    },
  })

  if (projectPath) {
    tools.push({
      name: 'read_file',
      description: 'Read a file from the project',
      params: 'path: the file path (relative to project root or absolute)',
      async execute({ path: p }) {
        if (!p) return 'Error: path required'
        const resolved = p.startsWith('/') ? p : join(projectPath, p)
        if (!existsSync(resolved)) return `File not found: ${resolved}`
        try {
          const content = readFileSync(resolved, 'utf8')
          return content.length > 6000 ? content.slice(0, 6000) + '\n...(truncated)' : content
        } catch (e: any) {
          return `Error reading file: ${e?.message ?? e}`
        }
      },
    })

    tools.push({
      name: 'list_files',
      description: 'List files in a directory',
      params: 'path: directory path (relative to project root or absolute); depth: optional, default 1',
      async execute({ path: p, depth: d }) {
        const dir = p ? (p.startsWith('/') ? p : join(projectPath, p)) : projectPath
        const maxDepth = parseInt(d ?? '1')
        function walk(dir: string, depth: number): string[] {
          if (depth < 0 || !existsSync(dir)) return []
          return readdirSync(dir).flatMap(f => {
            const full = join(dir, f)
            const rel = full.replace(projectPath + '/', '')
            if (statSync(full).isDirectory()) {
              return depth > 0 ? [rel + '/'].concat(walk(full, depth - 1)) : [rel + '/']
            }
            return [rel]
          })
        }
        const files = walk(dir, maxDepth)
        return files.length ? files.join('\n') : 'Empty directory or not found.'
      },
    })

    tools.push({
      name: 'run_command',
      description: 'Run a shell command in the project directory (read-only commands only: tsc, test, etc.)',
      params: 'command: the shell command to run',
      async execute({ command }, signal) {
        if (!command) return 'Error: command required'
        // Safety: block destructive commands
        if (/\brm\s|rmdir|drop\s|delete\s|truncate\s|DROP\s/i.test(command)) {
          return 'Error: destructive commands are not allowed'
        }
        return new Promise<string>((resolve) => {
          const proc = spawn('sh', ['-c', command], {
            cwd: projectPath,
            timeout: 15_000,
          })
          let out = ''
          proc.stdout.on('data', d => { out += d })
          proc.stderr.on('data', d => { out += d })
          proc.on('close', () => resolve(out.slice(0, 4000) || '(no output)'))
          proc.on('error', (e) => resolve(`Error: ${e.message}`))
          signal?.addEventListener('abort', () => { proc.kill(); resolve('Aborted') })
        })
      },
    })
  }

  return tools
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(tools: FmReactTool[]): string {
  const toolList = tools.map(t =>
    `TOOL: ${t.name}\n  Description: ${t.description}\n  Params: ${t.params}`
  ).join('\n\n')

  return `You are Crucible, an expert AI assistant capable of reasoning, research, planning, and coding. You have no knowledge cutoff for factual questions — you can search and look things up.

You can use tools to gather information and then provide a complete answer.

## Available tools

${toolList}

## How to use tools

When you need to use a tool, respond with EXACTLY this format:
TOOL: <tool_name>
<param_name>: <param_value>

Example:
TOOL: search
query: TypeScript generics tutorial

When you have enough information to answer, respond with:
FINAL_ANSWER:
<your complete, detailed answer here>

Rules:
- Use at most one tool per response
- Always end with FINAL_ANSWER when you're ready
- If you can answer without tools, go straight to FINAL_ANSWER
- Be thorough — provide complete, actionable answers
- Never make up facts; if uncertain, say so or search first`
}

// ── Parser ────────────────────────────────────────────────────────────────────

interface ParsedResponse {
  type: 'tool' | 'final'
  toolName?: string
  args?: Record<string, string>
  answer?: string
}

function parseResponse(text: string): ParsedResponse {
  const toolMatch = text.match(/^TOOL:\s*(\w+)\s*\n([\s\S]*)/im)
  const finalMatch = text.match(/FINAL_ANSWER:\s*\n?([\s\S]+)/i)

  // A weak/local model routinely ignores "use at most one tool per response" and
  // instead narrates an entire fabricated transcript in one completion — e.g.
  // "TOOL: create_tool\n...\nTOOL: search\n...\nTOOL: create_pdf\n...\nFINAL_ANSWER:
  // The tool has been created and tested successfully." None of those later TOOL:
  // blocks were ever executed; the model just typed out what it imagined would
  // happen. The old code checked FINAL_ANSWER first, so it trusted that fabricated
  // success claim verbatim and returned it as the real answer.
  //
  // Fix: if a TOOL: block appears BEFORE any FINAL_ANSWER: in the same response,
  // the FINAL_ANSWER is necessarily premature (nothing has actually run yet) —
  // execute the first real tool call instead and discard everything after it,
  // including the tacked-on "success" narration. The genuine tool result gets fed
  // back next round, forcing the model to base its actual final answer on what
  // really happened instead of what it imagined.
  if (toolMatch && (!finalMatch || (toolMatch.index ?? 0) < (finalMatch.index ?? 0))) {
    const toolName = toolMatch[1].trim()
    const rest = toolMatch[2].trim()
    const args: Record<string, string> = {}
    for (const line of rest.split('\n')) {
      // Stop at the next hallucinated TOOL:/FINAL_ANSWER: block — without this, a
      // multi-block fabrication bleeds unrelated key:value lines from LATER
      // (never-executed) tool calls into THIS tool's real args, e.g. a fake
      // "TOOL: search\nquery: ..." block's `query:` line getting attached to the
      // real create_tool call as if it were one of create_tool's own params.
      if (/^TOOL:/i.test(line) || /^FINAL_ANSWER:/i.test(line)) break
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) args[m[1]] = m[2].trim()
    }
    return { type: 'tool', toolName, args }
  }

  if (finalMatch) {
    return { type: 'final', answer: finalMatch[1].trim() }
  }

  // Check for inline ANSWER:
  const answerMatch = text.match(/^ANSWER:\s*(.+)/im)
  if (answerMatch) {
    return { type: 'final', answer: answerMatch[1].trim() }
  }

  // If nothing matched but text is non-empty, treat as a final answer
  if (text.length > 20) {
    return { type: 'final', answer: text }
  }

  return { type: 'final', answer: '' }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

/**
 * Run a goal through the FM with structured tool access.
 * Returns the FM's final answer, or throws if the FM is unavailable.
 */
export async function fmReact(opts: FmReactOpts): Promise<FmReactResult> {
  const {
    goal,
    projectPath,
    maxRounds = DEFAULT_MAX_ROUNDS,
    signal,
    extraTools = [],
    noSearch = false,
    history,
  } = opts

  const tools = [...makeDefaultTools(projectPath, noSearch), ...extraTools]
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const system = buildSystemPrompt(tools)

  const messages: FmMessage[] = [
    ...historyToMessages(history),
    { role: 'user', content: goal },
  ]

  const toolsUsed: string[] = []
  let rounds = 0

  while (rounds < maxRounds) {
    if (signal?.aborted) throw new Error('Aborted')
    rounds++

    let rawResponse: string
    try {
      rawResponse = await callFm(system, messages, FM_TIMEOUT_MS)
    } catch (e: any) {
      throw new Error(`FM unavailable: ${e?.message ?? e}`)
    }

    if (!rawResponse) {
      throw new Error('FM returned empty response')
    }

    const parsed = parseResponse(rawResponse)

    if (parsed.type === 'final') {
      return {
        answer: stripAgentScaffold(parsed.answer ?? ''),
        rounds,
        toolsUsed,
        abstained: !parsed.answer,
      }
    }

    // Execute the tool call
    const toolName = parsed.toolName!
    const args = parsed.args ?? {}
    const tool = toolMap.get(toolName)

    let toolResult: string
    if (!tool) {
      toolResult = `Error: Unknown tool "${toolName}". Available: ${[...toolMap.keys()].join(', ')}`
    } else {
      try {
        toolsUsed.push(toolName)
        debugBus.emit('agent', 'fm_react_tool', { tool: toolName, args: JSON.stringify(args).slice(0, 100) }, { severity: 'info' })
        toolResult = await tool.execute(args, signal ?? undefined)
      } catch (e: any) {
        toolResult = `Tool error: ${e?.message ?? e}`
      }
    }

    // Feed result back to FM
    messages.push({ role: 'assistant', content: rawResponse })
    messages.push({
      role: 'user',
      content: `Tool result for "${toolName}":\n${toolResult.slice(0, 3000)}\n\nContinue. Use another tool if needed, or give FINAL_ANSWER.`,
    })
  }

  // Budget exhausted — ask FM for best answer with what it has
  messages.push({
    role: 'user',
    content: 'Budget reached. Provide FINAL_ANSWER with what you know so far.',
  })

  try {
    const lastResponse = await callFm(system, messages, FM_TIMEOUT_MS)
    const parsed = parseResponse(lastResponse)
    return {
      answer: stripAgentScaffold(parsed.answer ?? lastResponse),
      rounds,
      toolsUsed,
      abstained: false,
    }
  } catch {
    return { answer: '', rounds, toolsUsed, abstained: true }
  }
}

/**
 * Quick FM direct answer — no tool use, just a single call.
 * Good for questions that can be answered from training knowledge.
 */
/** Prior conversation turns, oldest-first, threaded into offline answers so the
 *  FM has multi-turn context. Without this the model treats every turn in
 *  isolation and hallucinates (e.g. refusing a plain follow-up question). */
export type ConvTurn = { user: string; assistant: string }

/** Convert {user,assistant} history into alternating FM chat messages. */
export function historyToMessages(history?: ConvTurn[]): FmMessage[] {
  if (!Array.isArray(history) || !history.length) return []
  const msgs: FmMessage[] = []
  for (const h of history) {
    const u = (h?.user ?? '').trim()
    const a = (h?.assistant ?? '').trim()
    if (u) msgs.push({ role: 'user', content: u })
    if (a) msgs.push({ role: 'assistant', content: a })
  }
  return msgs
}

/**
 * Trim runaway repetition from a local-FM answer. Apple's on-device FM has no
 * repetition-penalty knob (GenerationOptions only exposes temperature +
 * maximumResponseTokens), so on open-ended prompts it sometimes loops, emitting
 * a block ("### Example 10", "### Example 11", …) over and over until it hits the
 * token ceiling. This deterministically detects a normalized block that recurs
 * and cuts the answer at the first runaway repeat — no model call, no network.
 *
 * Conservative by design: only truncates when a normalized block signature
 * appears 3+ times (so legitimately-repeated short structure survives), and never
 * returns empty (falls back to the original if the trim would gut the answer).
 */
/**
 * Strip agent-scaffold that a weak model leaks into a user-facing answer. Two failures the
 * mantis-shrimp report showed: (1) a literal "FINAL_ANSWER:" marker printed in the reply, and
 * (2) the model narrating the answer, printing "FINAL_ANSWER:", then repeating the SAME answer —
 * so both copies shipped. Fix: when a FINAL_ANSWER marker is present, the real answer is what
 * follows the LAST one (the preamble before it is scratch reasoning, often an exact duplicate);
 * keep only that. Then drop any other leading scaffold label and collapse a whole-answer
 * duplication. Idempotent; safe on clean text (returns it unchanged).
 */
export function stripAgentScaffold(text: string): string {
  let t = (text ?? '').trim()
  if (!t) return t
  const marker = /FINAL[_\s]?ANSWER\s*:/gi
  let lastIdx = -1, m: RegExpExecArray | null
  while ((m = marker.exec(t)) !== null) lastIdx = m.index + m[0].length
  if (lastIdx !== -1) t = t.slice(lastIdx).trim()
  // Strip a single leading scaffold label ("THOUGHT:", "ANSWER:", "RESPONSE:", …).
  t = t.replace(/^(?:THOUGHT|ACTION|OBSERVATION|ANSWER|RESPONSE|REASONING|OUTPUT)\s*:\s*/i, '').trim()
  // Collapse a whole-answer duplication: the model printed the same answer twice back-to-back.
  const half = Math.floor(t.length / 2)
  const a = t.slice(0, half).trim(), b = t.slice(half).trim()
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (a.length > 60 && norm(a) === norm(b)) t = a
  return t
}

export function stripRunawayRepetition(text: string): string {
  if (!text || text.length < 400) return text
  // Split on markdown headings or blank-line paragraph breaks, keeping delimiters.
  const blocks = text.split(/\n(?=#{1,6}\s)|\n\s*\n/).map(b => b.trim()).filter(Boolean)
  if (blocks.length < 4) return text
  // Normalize: drop digits (kills "Example 10" vs "Example 11"), collapse ws, lowercase.
  const norm = (b: string) => b.replace(/\d+/g, '#').replace(/\s+/g, ' ').toLowerCase().trim()
  const seen = new Map<string, number>()
  let cutIdx = -1
  for (let i = 0; i < blocks.length; i++) {
    const sig = norm(blocks[i])
    if (sig.length < 20) continue // ignore tiny blocks (headings alone, list bullets)
    const count = (seen.get(sig) ?? 0) + 1
    seen.set(sig, count)
    if (count >= 3) { cutIdx = i; break } // 3rd occurrence → runaway; cut here
  }
  if (cutIdx < 0) return text
  // Keep everything up to (not including) the 3rd repeat.
  const keptBlocks = blocks.slice(0, cutIdx)
  // Drop a trailing block that is only a heading (a dangling "### Example 3" left
  // behind when the runaway body block was what tripped the cut).
  while (keptBlocks.length && /^#{1,6}\s[^\n]*$/.test(keptBlocks[keptBlocks.length - 1])) keptBlocks.pop()
  const kept = keptBlocks.join('\n\n').trim()
  return kept.length >= 120 ? kept : text
}

export async function fmDirectAnswer(goal: string, context?: string, history?: ConvTurn[]): Promise<string> {
  const system = `You are Crucible, an expert AI assistant. Answer the user's question clearly and completely.
${context ? `\n## Context\n${context}` : ''}
Be direct, thorough, and accurate. Format with markdown when helpful.

Use the prior conversation turns ONLY to resolve what the user is referring to ("it", "that", "those", earlier numbers or entities). Then answer the LATEST user message and NOTHING else, in 1-3 short sentences.
- Treat any value or fact you already established as GIVEN. Do NOT re-derive it, re-list it, or reprint earlier working (no re-listing the boxes, no re-showing an earlier subtotal). Start from the last result and produce ONLY the single new result.
- Example: earlier you established 26 apples remain; user says "split those between 2 people" → answer exactly "13 apples each", not the whole chain from the beginning.
- Do not invent extra sub-questions or keep computing past what was asked.`

  const raw = await callFm(system, [...historyToMessages(history), { role: 'user', content: goal }], FM_TIMEOUT_MS)
  return stripAgentScaffold(stripRunawayRepetition(raw))
}

/**
 * Check if the Apple FM daemon is available.
 */
export async function checkFmAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${FM_URL}/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * FM-backed driverComplete drop-in — mirrors the signature of driver.ts:driverComplete
 * but routes through Apple FM instead of the external model pool.
 *
 * Used for planning and simple completion calls where no tool use is needed.
 * Falls back to empty string on FM failure (caller handles gracefully).
 */
/**
 * Streaming completion — POSTs stream:true to the daemon and calls onDelta(fragment) as tokens
 * arrive, returning the full text at the end. This is the felt-latency fix: first fragment lands
 * after ~prefill (~0.7s) instead of after the whole answer decodes (~24ms/token). Serialized on
 * the same fmQueue as fmComplete so it never overlaps another FM call. On a transient generation
 * error it throws (no auto-retry — retrying mid-stream would re-emit already-sent fragments); the
 * caller falls back. Never used for the keepalive/verification lanes — those stay non-streaming.
 */
export async function fmStream(
  messages: Array<{ role: string; content: string }>,
  onDelta: (delta: string) => void,
  opts?: FmCallOpts,
): Promise<string> {
  const system = messages.find(m => m.role === 'system')?.content ??
    'You are Crucible, an expert AI assistant. Answer concisely and accurately.'
  const convo = messages.filter(m => m.role !== 'system')
  if (!convo.length) return ''
  const timeoutMs = opts?.timeoutMs ?? FM_TIMEOUT_MS
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const combined = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal
  return await enqueueFm(async () => {
    const res = await fetch(`${FM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'apple-fm', stream: true,
        max_tokens: opts?.maxTokens ?? 1536,
        temperature: opts?.temperature ?? 0.2,
        messages: [{ role: 'system', content: system }, ...convo],
      }),
      signal: combined,
    })
    if (!res.ok || !res.body) throw new Error(`FM HTTP ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let full = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data:'))
        if (!line) continue
        const p = line.slice(5).trim()
        if (p === '[DONE]') continue
        let ev: any
        try { ev = JSON.parse(p) } catch { continue }
        if (ev?.error) throw new FmTransientError(String(ev.error?.message ?? ev.error))
        const delta = ev?.choices?.[0]?.delta?.content ?? ''
        if (delta) { full += delta; try { onDelta(delta) } catch { /* sink errors */ } }
      }
    }
    return full.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  }, { priority: opts?.priority ?? 'high', label: 'fmStream' })
}

export async function fmComplete(
  messages: Array<{ role: string; content: string }>,
  opts?: FmCallOpts,
): Promise<string> {
  try {
    const system = messages.find(m => m.role === 'system')?.content ??
      'You are Crucible, an expert AI assistant. Answer concisely and accurately.'
    const convo = messages.filter(m => m.role !== 'system') as FmMessage[]
    if (!convo.length) return ''
    return await callFm(system, convo, opts?.timeoutMs ?? FM_TIMEOUT_MS, opts?.temperature, opts?.priority ?? 'high', opts?.signal, opts?.maxTokens)
  } catch {
    return ''
  }
}
