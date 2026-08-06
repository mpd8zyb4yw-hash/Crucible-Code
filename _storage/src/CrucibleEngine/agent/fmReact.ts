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
import { bonsaiComplete, sidecarStream, isBonsaiInstalled, repairModelName } from '../localModels/bonsaiSidecar'

const FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'

// ── Head model selection (cont.90) ──────────────────────────────────────────────
// cont.88/89 MEASURED the Apple FM cannot copy an identifier out of clean evidence (0/3) while
// qwen2.5-1.5b — SMALLER than the FM (~3B) and already on disk — does it 3/3 AND executes 3/3, at
// 40 tok/s. The FM's failure was model-specific, not parameter count. Per the user's cont.87
// decision (Apple FM path paused: more debugging overhead than value), the local sidecar model is
// now the HEAD for every interactive reasoning/planning/tool-routing call, with the Apple FM kept
// only as a fallback when the sidecar is not installed or fails. This is doctrine-COMPLIANT: the
// cognitive core is meant to be the smallest reasoning-dense model that certifies, not the largest
// that fits — qwen1.5b is closer to that ~1B endpoint than the FM ever was. Set CRUCIBLE_HEAD=fm
// to pin the old Apple-FM-first behavior (e.g. to re-bench the two head-to-head).
const HEAD = (process.env.CRUCIBLE_HEAD ?? 'local').toLowerCase()
/** True when the local sidecar should LEAD this call (installed + not explicitly pinned to fm). */
function useLocalHead(): boolean {
  return HEAD !== 'fm' && HEAD !== 'apple-fm' && isBonsaiInstalled()
}
/** Short name of the model actually serving the head, for telemetry / user-facing lines. */
export function headModelName(): string {
  return useLocalHead() ? repairModelName() : 'apple-fm'
}
const DEFAULT_MAX_ROUNDS = 8
/** How many times strict mode may reject a memory-only answer before taking what it gets.
 *  Two is enough for the weak head to comply when it CAN, and low enough that a goal no tool
 *  can serve still finishes rather than burning the whole round budget arguing. */
const STRICT_NUDGE_LIMIT = 2
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
  // Local head leads (cont.90): route the completion to the sidecar model. On any sidecar
  // failure fall through to the Apple FM daemon below so the head swap never HARD-fails a turn.
  if (useLocalHead()) {
    try {
      return await bonsaiComplete(
        [{ role: 'system', content: system }, ...messages],
        { maxTokens, temperature, timeoutMs, signal },
      )
    } catch { /* sidecar unavailable/errored — fall back to Apple FM */ }
  }
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
  /** True when `execute` already emits its own tool_call/tool_result (e.g. it goes through
   *  registry.exec, which guarantees exactly one of each). This executor then stays quiet
   *  rather than emitting a duplicate pair — see the note at the emit site. */
  emitsOwnEvents?: boolean
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
  /**
   * Stream agent events to the client (cont.118).
   *
   * WHY: fmReact is the executor that actually calls tools, and until now NONE of its calls were
   * visible. `extraTools` passed in from server.ts carried their own hand-rolled emit wrapper, but
   * the DEFAULT tools — search, fetch_page, corpus_query — emitted nothing at all. So a run could
   * fetch a real page, ground a real answer, and report `0 tools` to the UI, which then had
   * nothing to render. Every agent surface downstream was structurally blind.
   *
   * Emitting HERE rather than per-tool means it cannot be forgotten by the next tool added: the
   * wrapper sits at the single point where any tool is executed, whatever its origin.
   */
  emit?: (event: Record<string, unknown>) => void
  /**
   * STRICT AGENT MODE (cont.118) — refuse a final answer produced without ever looking.
   *
   * WHY: measured live, the flash-card brief planned "fetch the page, then build the deck" and
   * then answered straight from parametric memory — `0 tools`. The plan was right; the model
   * simply skipped it, because nothing made looking mandatory. That is a FALSE MISS: the tool
   * existed, the plan named it, the executor had it, and it was never called. It is also the
   * exact shape of every fabrication this session — an answer about the world produced without
   * consulting the world.
   *
   * When set, a FINAL_ANSWER with zero tool calls is rejected and the model is told, in the
   * loop, that it must use a tool first. Bounded by `STRICT_NUDGE_LIMIT` so a model that
   * genuinely cannot proceed abstains honestly rather than spinning.
   */
  requireTool?: boolean
}

/** One executed call and what it returned — the run's EVIDENCE, not just its tool names. */
export interface FmReactObservation { tool: string; args: Record<string, string>; result: string }

export interface FmReactResult {
  answer: string
  rounds: number
  toolsUsed: string[]
  abstained: boolean
  /**
   * Every real tool execution this turn, in order.
   *
   * `toolsUsed` carries only NAMES, which is enough to decide "did it look?" but not enough to
   * answer from. MEASURED LIVE (2026-08-04, phone): a run read notes.txt, got back
   * "notes.txt — 3 lines", produced no composed answer, and the caller escalated to a toolless
   * path that replied "has 10 lines". Four real observations were discarded and the answer was
   * invented. The evidence has to survive the escalation, so the caller can ground on it.
   */
  observations: FmReactObservation[]
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

/**
 * Strip markdown decoration the FM wraps its protocol lines in.
 *
 * LIVE (cont.97, "Vibe Code: make me a simple driving sim"): the FM emitted
 * `**TOOL: search**` — bolded, because the system prompt shows the protocol inside a
 * markdown-formatted block and a weak model copies the FORMATTING along with the shape. The
 * anchored `/^TOOL:/` never matched, nothing executed, and the raw tool transcript shipped to
 * the user as the answer. A protocol the model gets 95% right must not fail closed on the
 * other 5%: strip leading/trailing emphasis, heading, and list markers before matching.
 */
function undecorate(text: string): string {
  return text.split('\n').map(line => line
    .replace(/^\s*(?:[-*+]\s+|#{1,6}\s+|>\s+)?/, '')   // list bullet / heading / quote marker
    .replace(/^\s*(?:\*{1,3}|_{1,3}|`{1,3})\s*/, '')    // opening emphasis or code span
    .replace(/\s*(?:\*{1,3}|_{1,3}|`{1,3})\s*$/, '')    // closing emphasis or code span
    .trimEnd(),
  ).join('\n')
}

/**
 * Does this text still carry raw agent-protocol scaffolding? Then it is not an answer.
 *
 * Exported (cont.119) because the content path needs the same test: asked for a flashcard deck it
 * once returned `TOOL: web_act\nclick: Save` followed by an echo of its own brief. Any path that
 * can ship a final answer needs this check, not just this file's loop.
 */
export function looksLikeProtocol(text: string): boolean {
  return /^\s*(?:\*{0,3}|#{1,6}\s*)?TOOL:\s*\w+/im.test(text) || /FINAL_ANSWER:/i.test(text)
}

/**
 * Name of a tool's FIRST declared param — its "primary" one. `params` is a human-readable
 * spec string (`'query: the search query string'`), so the leading `word:` is the param the
 * model is most likely to be supplying when it emits a bare positional value.
 */
export function primaryParamOf(tool: FmReactTool): string | undefined {
  return tool.params.match(/^\s*(\w+)\s*:/)?.[1]
}

/**
 * Build the primary-param lookup `parseResponse` needs to rescue positional args.
 * Exported so benches can construct one without standing up the whole loop.
 */
export function primaryParamLookup(tools: FmReactTool[]): (toolName: string) => string | undefined {
  const byName = new Map(tools.map(t => [t.name, primaryParamOf(t)]))
  return (n) => byName.get(n)
}

/**
 * Every `TOOL:` block in a response, in order.
 *
 * MEASURED (2026-08-04): asked to count lines in a file and write the count to another file,
 * the head read the file, then answered with BOTH remaining steps in one completion —
 * `TOOL: read_file … TOOL: write_file … content: 4`. `parseResponse` takes the FIRST block by
 * design (a weak head narrates fabricated transcripts, and trusting a later block would execute
 * fiction), so it re-proposed the read it had already done, hit the repeated-call guard, and
 * looped until the raw text shipped as the answer. The write it had correctly worked out sat in
 * the same message, unread, the whole time.
 *
 * Taking the first block stays right. But when the first block is a call ALREADY MADE this
 * turn, a later block is not speculative fiction about the future — it is the model's own next
 * step, and executing it is strictly better than replaying a duplicate. The loop uses this to
 * look past a duplicate; nothing else changes.
 */
export function parseToolBlocks(
  text: string,
  primaryParam?: (name: string) => string | undefined,
): Array<{ toolName: string; args: Record<string, string> }> {
  const out: Array<{ toolName: string; args: Record<string, string> }> = []
  const lines = String(text ?? '').split('\n')
  let cur: { toolName: string; args: Record<string, string>; positional: string[] } | null = null
  const flush = () => {
    if (!cur) return
    if (!Object.keys(cur.args).length && cur.positional.length) {
      const key = primaryParam?.(cur.toolName)
      if (key) cur.args[key] = cur.positional.join(' ')
    }
    out.push({ toolName: cur.toolName, args: cur.args })
    cur = null
  }
  for (const line of lines) {
    // Trailing decoration too: the prompt shows the protocol in backticks, so the model
    // bolds it — `**TOOL: search**` — and a header anchored to end-of-line missed every one.
    const head = line.match(/^\s*(?:\*{0,3}|#{1,6}\s*)?TOOL:\s*(\w+)\s*\**\s*$/i)
    if (head) { flush(); cur = { toolName: head[1], args: {}, positional: [] }; continue }
    if (/^\s*FINAL_ANSWER:/i.test(line)) { flush(); continue }
    if (!cur) continue
    // `https://example.com` is a bare URL, not `key: value` — binding it as
    // {https: '//example.com'} silently destroyed the argument. A scheme is the only
    // realistic collision, and it is unambiguous: a real key is never followed by `//`.
    const kv = line.match(/^(\w+):\s*(.+)$/)
    if (kv && !/^\/\//.test(kv[2])) { cur.args[kv[1]] = kv[2].trim(); continue }
    const bare = line.trim().replace(/^["']|["']$/g, '')
    if (bare) cur.positional.push(bare)
  }
  flush()
  return out
}

export function parseResponse(
  raw: string,
  /** Maps a tool name to its primary param, so a BARE positional arg can be rescued. */
  primaryParam?: (toolName: string) => string | undefined,
  /** Names the model is allowed to invoke. Enables the bare-call rescue below. */
  isKnownTool?: (toolName: string) => boolean,
): ParsedResponse {
  const text = undecorate(raw)
  // A weak model routinely emits the tool call in function-call form on the TOOL: line
  // itself — `TOOL: run("mkdir", "dog_breeds_italy")` or `TOOL: search(query="…")` —
  // instead of the documented `TOOL: name\nkey: value` block. The old regex required a
  // NEWLINE after the tool name, so these matched nothing (or matched with an empty arg
  // body), and the tool ran with no args: `run` got `{"0":"mkdir","1":"dog_breeds_italy"}`
  // shaped garbage downstream, `search` got an empty `query`. Normalize the call form into
  // the block form up front so a single arg parser handles both.
  const normalized = text.replace(
    /^(\s*TOOL:\s*\w+)\s*\(([^)\n]*)\)\s*$/im,
    (_m, head: string, inner: string) => `${head}\n${splitCallArgs(inner).join('\n')}`,
  )
  let toolMatch = normalized.match(/^TOOL:\s*(\w+)\s*\n([\s\S]*)/im)

  // ── Bare call form: the model writes CODE instead of the protocol ──────────
  //
  // LIVE (cont.119): asked to create a set on quizlet.com, the model answered with
  //
  //     ```typescript
  //     web_open("https://quizlet.com/create-flashcard-set");
  //     ```
  //
  // It had picked the right tool and the right argument and simply expressed the call in the
  // notation it knows best. Nothing ran, and the code block shipped as the answer.
  //
  // This is the same principle `undecorate` above was written for — a protocol the model gets
  // 95% right must not fail closed on the other 5% — one step further out: not decoration around
  // the protocol, but the protocol expressed as source. Only fires when NO `TOOL:` line parsed
  // and there is no FINAL_ANSWER, and only for a name the caller says is a real tool, so prose
  // that merely mentions a tool cannot be hijacked into executing one.
  if (!toolMatch && isKnownTool && !/FINAL_ANSWER:/i.test(normalized)) {
    const CALL = /(?:^|[^\w.])([a-z_][\w]*)\s*\(([^)]*)\)/gim
    let m: RegExpExecArray | null
    while ((m = CALL.exec(normalized)) !== null) {
      const [, name, inner] = m
      if (!isKnownTool(name)) continue
      // A BARE positional arg must be labelled with the tool's primary param before the
      // `key: value` line parser sees it — otherwise `web_open("https://quizlet.com/x")` is
      // split on the URL's OWN colon and the tool receives {https: "//quizlet.com/x"}.
      const pp = primaryParam?.(name)
      const argLines = splitCallArgs(inner).map(a =>
        (/^[a-z][\w+.-]*:\/\//i.test(a) || !/^\w+\s*:\s/.test(a)) && pp ? `${pp}: ${a}` : a,
      )
      const rebuilt = `TOOL: ${name}\n${argLines.join('\n')}`
      toolMatch = rebuilt.match(/^TOOL:\s*(\w+)\s*\n([\s\S]*)/im)
      if (toolMatch) return parseNormalized(rebuilt, toolMatch, primaryParam)
    }
  }
  return parseNormalized(normalized, toolMatch, primaryParam)
}

/** Split a function-call arg list into one line per arg, preserving `key=value` pairs. */
function splitCallArgs(inner: string): string[] {
  return inner
    .split(/,(?=(?:[^"']*(?:"[^"]*"|'[^']*'))*[^"']*$)/)   // commas outside quotes
    .map(a => a.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .map(a => {
      const kv = a.match(/^(\w+)\s*=\s*(.*)$/)
      return kv ? `${kv[1]}: ${kv[2].replace(/^["']|["']$/g, '')}` : a
    })
}

function parseNormalized(
  text: string,
  toolMatch: RegExpMatchArray | null,
  primaryParam?: (toolName: string) => string | undefined,
): ParsedResponse {
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
    const positional: string[] = []
    for (const line of rest.split('\n')) {
      // Stop at the next hallucinated TOOL:/FINAL_ANSWER: block — without this, a
      // multi-block fabrication bleeds unrelated key:value lines from LATER
      // (never-executed) tool calls into THIS tool's real args, e.g. a fake
      // "TOOL: search\nquery: ..." block's `query:` line getting attached to the
      // real create_tool call as if it were one of create_tool's own params.
      if (/^TOOL:/i.test(line) || /^FINAL_ANSWER:/i.test(line)) break
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) { args[m[1]] = m[2].trim(); continue }
      // Not `key: value` — a BARE positional value. The model emits these constantly
      // ("TOOL: run\nmkdir dog_breeds_italy"), and silently dropping them handed the tool
      // an empty arg set, which is exactly how `run` ended up with no command and
      // `search` with an empty query. Keep them for the primary-param rescue below.
      const bare = line.trim().replace(/^["']|["']$/g, '')
      if (bare) positional.push(bare)
    }
    // Rescue: the model supplied a value but not the param NAME. Bind the positional text
    // to the tool's first declared param — the only param a single bare value can mean.
    // Only when nothing named was parsed, so a well-formed call is never overwritten.
    if (!Object.keys(args).length && positional.length) {
      const key = primaryParam?.(toolName)
      if (key) args[key] = positional.join(' ')
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

  // If nothing matched but text is non-empty, treat as a final answer — EXCEPT when the text
  // is still visibly agent protocol. That is a parse failure, not an answer, and shipping it
  // put `**TOOL: search**\nquery: "…"` in front of a user (cont.97). Returning empty makes the
  // loop treat the round as unproductive and retry/escalate, which is the honest outcome;
  // undecorate() above should mean we rarely get here, and this is the net under it.
  if (looksLikeProtocol(text)) return { type: 'final', answer: '' }
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
    emit,
    requireTool = false,
  } = opts

  const tools = [...makeDefaultTools(projectPath, noSearch), ...extraTools]
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const system = buildSystemPrompt(tools)
  const primaryParam = primaryParamLookup(tools)
  const toolNames = new Set(tools.map(t => t.name))
  const knownTool = (n: string) => toolNames.has(n)

  const messages: FmMessage[] = [
    ...historyToMessages(history),
    { role: 'user', content: goal },
  ]

  const toolsUsed: string[] = []
  const observations: FmReactObservation[] = []
  /** Tool calls actually executed this turn, keyed by tool + exact args → first result. */
  const attempted = new Map<string, string>()
  let rounds = 0
  /** Strict-mode refusals so far. Bounded so a tool-less goal degrades instead of spinning. */
  let strictNudges = 0

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

    const parsed = parseResponse(rawResponse, primaryParam, knownTool)

    if (parsed.type === 'final') {
      // STRICT MODE — an answer produced without ever looking is a false miss, not an answer.
      // Send it back into the loop with an explicit instruction rather than accepting it.
      // Bounded: after STRICT_NUDGE_LIMIT refusals we stop nudging and take what we get, so a
      // goal the tools genuinely cannot serve degrades to an honest answer instead of hanging.
      if (requireTool && toolsUsed.length === 0 && strictNudges < STRICT_NUDGE_LIMIT && rounds < maxRounds) {
        strictNudges++
        debugBus.emit('agent', 'strict_tool_required', {
          nudge: strictNudges, goal: goal.slice(0, 80),
        }, { severity: 'warn' })
        emit?.({ type: 'thought', text: 'That answer came from memory, not from looking — retrying with a real lookup.' })
        messages.push({ role: 'assistant', content: rawResponse })
        messages.push({
          role: 'user',
          content:
            'You have not used a single tool yet, so that answer came from memory rather than from ' +
            'the actual source. That is not acceptable for this task.\n\n' +
            `Available tools: ${[...toolMap.keys()].join(', ')}.\n\n` +
            'Call ONE tool now, using the exact call format. Do not give FINAL_ANSWER until you ' +
            'have a real tool result to base it on.',
        })
        continue
      }
      return {
        answer: stripAgentScaffold(parsed.answer ?? ''),
        rounds,
        toolsUsed,
        abstained: !parsed.answer,
        observations,
      }
    }

    // Execute the tool call
    let toolName = parsed.toolName!
    let args = parsed.args ?? {}
    let tool = toolMap.get(toolName)

    // Repeated-call guard. The weak head gets stuck re-issuing the SAME call when a tool comes
    // back empty: live 2026-07-21, a run fired the identical `search {"query":"\"sum of 17 and
    // 4\""}` six times, every one `search_all_backends_empty`, before finally answering from
    // reasoning. The answer was right; six network round-trips and six of the eight rounds were
    // burned re-asking a question that had already failed. Re-running a call whose args are
    // byte-identical cannot produce new information within one turn, so replay the first result
    // and tell the model plainly to change approach or answer.
    let callKey = `${toolName}:${JSON.stringify(args)}`
    let priorResult = attempted.get(callKey)

    // Before replaying a duplicate, look past it. The head often emits its whole remaining
    // plan in one completion — the step it just did, then the step it means to do next. The
    // first block is the duplicate; the NEXT un-run block is the actual next action, and it is
    // already sitting in this same response. Executing it beats spending a round telling the
    // model something it can work out from a message it has already written.
    if (priorResult !== undefined) {
      const blocks = parseToolBlocks(rawResponse, primaryParam)
      const fresh = blocks.find(b =>
        toolMap.has(b.toolName) && attempted.get(`${b.toolName}:${JSON.stringify(b.args)}`) === undefined)
      if (fresh) {
        debugBus.emit('agent', 'fm_react_skip_duplicate', {
          skipped: toolName, took: fresh.toolName, rounds,
        }, { severity: 'info' })
        toolName = fresh.toolName
        args = fresh.args
        tool = toolMap.get(toolName)
        callKey = `${toolName}:${JSON.stringify(args)}`
        priorResult = attempted.get(callKey)
      }
    }

    let toolResult: string
    if (priorResult !== undefined) {
      debugBus.emit('agent', 'fm_react_repeat', { tool: toolName, args: JSON.stringify(args).slice(0, 100), rounds }, { severity: 'warn' })
      toolResult =
        `You ALREADY ran this exact call earlier in this turn and got:\n${priorResult.slice(0, 1200)}\n\n` +
        'Repeating it cannot produce a different result. Either use a DIFFERENT tool, or the same ' +
        'tool with MEANINGFULLY different arguments, or — if you already have what you need, or ' +
        'the tool simply has nothing on this — give FINAL_ANSWER now using your own reasoning.'
    } else if (!tool) {
      toolResult = `Error: Unknown tool "${toolName}". Available: ${[...toolMap.keys()].join(', ')}`
    } else {
      // Emit for tools that do NOT emit for themselves.
      //
      // This used to emit unconditionally, and the note here rationalised the result: server.ts's
      // extraTools wrap registry.exec, which emits its own pair, so every registry-backed call
      // produced THREE tool_call events — one here, one from the wrapper, one from registry.exec.
      // Live that read as the agent calling `schedule_task` three times, and it is why the
      // duplicate guard there was load-bearing rather than belt-and-braces.
      //
      // registry.exec is the canonical emitter (one tool_call and one tool_result per exec, with
      // the derived view attached), so a tool routed through it says so and this stays quiet.
      const evId = `fmr_${toolsUsed.length}_${toolName}`
      const selfEmits = tool.emitsOwnEvents === true
      try {
        toolsUsed.push(toolName)
        debugBus.emit('agent', 'fm_react_tool', { tool: toolName, args: JSON.stringify(args).slice(0, 100) }, { severity: 'info' })
        if (!selfEmits) emit?.({ type: 'tool_call', id: evId, tool: toolName, args })
        toolResult = await tool.execute(args, signal ?? undefined)
        if (!selfEmits) emit?.({
          type: 'tool_result', id: evId, tool: toolName, ok: true,
          output: String(toolResult).slice(0, 800), truncated: String(toolResult).length > 800,
        })
      } catch (e: any) {
        toolResult = `Tool error: ${e?.message ?? e}`
        if (!selfEmits) emit?.({ type: 'tool_result', id: evId, tool: toolName, ok: false, output: toolResult })
      }
    }
    // Record only REAL executions, so the replay text above is always a genuine tool result.
    if (priorResult === undefined) {
      attempted.set(callKey, toolResult)
      // Keep the EVIDENCE, not just the tool name — the caller needs it to ground an answer
      // when this loop gathers good results but never composes one. See FmReactObservation.
      observations.push({ tool: toolName, args, result: toolResult })
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
    const parsed = parseResponse(lastResponse, primaryParam, knownTool)
    return {
      answer: stripAgentScaffold(parsed.answer ?? lastResponse),
      rounds,
      toolsUsed,
      abstained: false,
      observations,
    }
  } catch {
    return { answer: '', rounds, toolsUsed, abstained: true, observations }
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
/**
 * Drop `TOOL:` call blocks from a user-facing answer.
 *
 * MEASURED LIVE (2026-08-04): a run that correctly read a file, wrote "3" into count.txt and
 * read it back to confirm shipped this as the answer —
 *
 *     TOOL: search
 *     query: count
 *     TOOL: write_file
 *     path: ~/Desktop/agentprobe/count.txt
 *     content: 3
 *
 * The work was right; the user was shown the protocol. stripAgentScaffold handled FINAL_ANSWER
 * and bare labels but not the call syntax the model emits on every single turn.
 *
 * A block runs from a `TOOL:` header to the first line that is NOT one of its arguments — the
 * same shape parseToolBlocks reads, so what is stripped here is exactly what would have been
 * executed there. Scaffold mode ENDS at a blank line or at any line that is not `key: value`,
 * which is what keeps ordinary prose ("Note: it returns numbered lines", a recipe's
 * "flour: 200g") intact: with no TOOL: header, nothing is ever stripped.
 */
function stripToolProtocol(text: string): string {
  if (!/^\s*(?:\*{0,3}|#{1,6}\s*)?TOOL:\s*\w+/im.test(text)) return text
  const out: string[] = []
  let inCall = false
  for (const line of text.split('\n')) {
    if (/^\s*(?:\*{0,3}|#{1,6}\s*)?TOOL:\s*\w+\s*\**\s*$/i.test(line)) { inCall = true; continue }
    if (inCall) {
      if (!line.trim()) { inCall = false; continue }         // blank line closes the block
      if (/^\s*\w+:\s*.+$/.test(line)) continue              // an argument line
      inCall = false                                          // anything else is prose again
    }
    out.push(line)
  }
  return out.join('\n').trim()
}

export function stripAgentScaffold(text: string): string {
  let t = (text ?? '').trim()
  if (!t) return t
  const marker = /FINAL[_\s]?ANSWER\s*:/gi
  let lastIdx = -1, m: RegExpExecArray | null
  while ((m = marker.exec(t)) !== null) lastIdx = m.index + m[0].length
  if (lastIdx !== -1) t = t.slice(lastIdx).trim()
  t = stripToolProtocol(t)
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
  // cont.90: the local HEAD may be the sidecar model, which can serve even when the Apple FM
  // daemon is down. Treat the head as available if the sidecar is installed (it starts on first
  // use) — otherwise the whole local path would be skipped and the turn would go external.
  if (useLocalHead()) return true
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
  // Local head leads (cont.90): stream from the sidecar with the same delta contract. Any
  // sidecar failure falls through to the Apple FM streaming path so a turn never hard-fails.
  if (useLocalHead()) {
    try {
      return await sidecarStream(
        [{ role: 'system', content: system }, ...convo],
        onDelta,
        { maxTokens: opts?.maxTokens ?? 1536, temperature: opts?.temperature, timeoutMs: opts?.timeoutMs ?? FM_TIMEOUT_MS, signal: opts?.signal },
      )
    } catch { /* fall back to Apple FM streaming */ }
  }
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
