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

const FM_URL = process.env.LOCAL_INFERENCE_URL ?? 'http://127.0.0.1:11435'
const DEFAULT_MAX_ROUNDS = 8
// Healthy generation measured at 21-28s, already against the old 30s ceiling —
// under load this crossed it, fired AbortSignal.timeout, and got misreported as
// "daemon unreachable" (see server.ts's offline_conversational_escalate catch).
const FM_TIMEOUT_MS = 45_000

// ── FM call helper ────────────────────────────────────────────────────────────

async function callFm(system: string, messages: FmMessage[], timeoutMs = FM_TIMEOUT_MS): Promise<string> {
  const res = await fetch(`${FM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'apple-fm',
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 1536,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`FM HTTP ${res.status}`)
  const data = await res.json() as any
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
  // Check for FINAL_ANSWER (multi-line)
  const finalMatch = text.match(/FINAL_ANSWER:\s*\n?([\s\S]+)/i)
  if (finalMatch) {
    return { type: 'final', answer: finalMatch[1].trim() }
  }

  // Check for inline ANSWER:
  const answerMatch = text.match(/^ANSWER:\s*(.+)/im)
  if (answerMatch) {
    return { type: 'final', answer: answerMatch[1].trim() }
  }

  // Check for TOOL: block
  const toolMatch = text.match(/^TOOL:\s*(\w+)\s*\n([\s\S]*)/im)
  if (toolMatch) {
    const toolName = toolMatch[1].trim()
    const rest = toolMatch[2].trim()
    const args: Record<string, string> = {}
    // Parse key: value lines
    for (const line of rest.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (m) args[m[1]] = m[2].trim()
    }
    return { type: 'tool', toolName, args }
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
        answer: parsed.answer ?? '',
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
      answer: parsed.answer ?? lastResponse,
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

export async function fmDirectAnswer(goal: string, context?: string, history?: ConvTurn[]): Promise<string> {
  const system = `You are Crucible, an expert AI assistant. Answer the user's question clearly and completely.
${context ? `\n## Context\n${context}` : ''}
Be direct, thorough, and accurate. Format with markdown when helpful. Use the prior conversation turns for context — the user may refer back to things already said.`

  return callFm(system, [...historyToMessages(history), { role: 'user', content: goal }], FM_TIMEOUT_MS)
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
export async function fmComplete(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  try {
    const system = messages.find(m => m.role === 'system')?.content ??
      'You are Crucible, an expert AI assistant. Answer concisely and accurately.'
    const convo = messages.filter(m => m.role !== 'system') as FmMessage[]
    if (!convo.length) return ''
    return await callFm(system, convo, FM_TIMEOUT_MS)
  } catch {
    return ''
  }
}
