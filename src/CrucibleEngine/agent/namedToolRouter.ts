// ── Named-tool router (Offline-First, Track O) ─────────────────────────────────
// When a request EXPLICITLY names registry tools ("Use calendar_list … and
// gmail_search (query: …)"), there is nothing to plan — the tools are stated. The
// weak on-device planner has no business guessing here (and it doesn't: it produced
// off-topic prose for exactly this brief, 2026-07-19). This layer resolves the named
// tools DETERMINISTICALLY, executes them for REAL data, and hands only the verified
// tool output to the FM for summarization. Doctrine-sound: the model never invents
// the data, only phrases it.
//
// Read-only by construction: only whitelisted read tools can be triggered by a bare
// name mention. Anything that sends/creates/deletes is excluded — those require an
// actual planned intent, never a name appearing in prose.

import type { ToolCall } from '../tools/protocol'

// Tools safe to run purely because the message names them. Read-only, idempotent.
export const NAME_TRIGGERABLE_TOOLS = new Set([
  'gmail_search', 'gmail_read', 'calendar_list',
  'drive_search', 'drive_read', 'contacts_search', 'youtube_search_api',
  'list_dir', 'read_file', 'web_search',
])

// Per-tool default args so a named tool with no inline args still runs meaningfully.
const DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  calendar_list: { maxResults: 10, days: 1 },
  gmail_search: { query: 'newer_than:1d in:inbox', maxResults: 10 },
}

// Required args per tool that CANNOT be defaulted — if the message doesn't supply
// one, the tool is skipped (we never fabricate a query/path/id).
const REQUIRED_NO_DEFAULT: Record<string, string[]> = {
  gmail_read: ['messageId'],
  read_file: ['path'],
  drive_read: ['fileId'],
}

export interface NamedToolResolution {
  calls: ToolCall[]
  /** tool names found but skipped for want of a required, non-defaultable arg */
  skipped: string[]
}

// Pull an inline arg object out of "toolname (query: "…", maxResults: 5)" or
// "toolname(query='…')". Best-effort, quote-and-comma tolerant; returns {} if none.
function extractInlineArgs(message: string, tool: string): Record<string, unknown> {
  // Find the tool name followed (within a few chars) by a parenthesised group.
  const re = new RegExp(`${tool}\\s*\\(([^)]*)\\)`, 'i')
  const m = message.match(re)
  if (!m) return {}
  const inner = m[1]
  const args: Record<string, unknown> = {}
  // key: "value" | key: 'value' | key: value(number)
  const pairRe = /([a-zA-Z_][\w]*)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))/g
  let p: RegExpExecArray | null
  while ((p = pairRe.exec(inner)) !== null) {
    const key = p[1]
    const val = p[2] ?? p[3] ?? (p[4] != null ? Number(p[4]) : undefined)
    if (val !== undefined) args[key] = val
  }
  // A bare quoted string with no key — treat as the tool's primary arg.
  if (Object.keys(args).length === 0) {
    const bare = inner.match(/"([^"]*)"|'([^']*)'/)
    if (bare) {
      const primary = tool === 'gmail_search' || tool === 'web_search' || tool === 'drive_search' || tool === 'youtube_search_api'
        ? 'query' : tool === 'read_file' ? 'path' : 'query'
      args[primary] = bare[1] ?? bare[2]
    }
  }
  return args
}

/**
 * Resolve every name-triggerable tool mentioned in `message` into an executable
 * ToolCall, in the order they appear. Returns null when no such tool is named — the
 * caller then proceeds to its normal planning path unchanged.
 */
export function resolveNamedTools(message: string): NamedToolResolution | null {
  const msg = message ?? ''
  const found: Array<{ tool: string; at: number }> = []
  for (const tool of NAME_TRIGGERABLE_TOOLS) {
    // Word-boundary match so "read_file" doesn't fire on "spread_files", and require
    // the exact snake_case token (these names never occur in ordinary prose).
    const re = new RegExp(`\\b${tool}\\b`)
    const at = msg.search(re)
    if (at !== -1) found.push({ tool, at })
  }
  if (found.length === 0) return null
  found.sort((a, b) => a.at - b.at)

  const calls: ToolCall[] = []
  const skipped: string[] = []
  let i = 0
  for (const { tool } of found) {
    const inline = extractInlineArgs(msg, tool)
    const args = { ...(DEFAULT_ARGS[tool] ?? {}), ...inline }
    const missing = (REQUIRED_NO_DEFAULT[tool] ?? []).filter(k => !(k in args))
    if (missing.length) { skipped.push(tool); continue }
    calls.push({ id: `named_${i++}`, name: tool, args })
  }
  if (calls.length === 0) return skipped.length ? { calls, skipped } : null
  return { calls, skipped }
}
