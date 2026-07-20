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

// ── Implicit personal-data resolution ──────────────────────────────────────────
// Live failure this closes (debug report 2026-07-20): "Summarize today's calendar and any
// inbox email from the last day that needs a reply." / "just show me my emails" named no
// snake_case tool and didn't classify as agentic, so the request fell through to the prose
// pipeline — which FABRICATED "Today's calendar is empty. There are no emails…" with ZERO
// tool calls, and the verifier stamped it clean. An answer about the user's own external
// data must come from a tool or be an honest failure — never from the model's imagination.
//
// Deterministic and conservative by construction (BINDING no-inference rule):
//  · fires only on a RETRIEVAL-shaped ask (no send/draft/create/delete verbs),
//  · only for domain nouns that map 1:1 to read-only registry tools (same whitelist as
//    NAME_TRIGGERABLE_TOOLS — this is a synonym layer, not a planner),
//  · needs first-person/deictic grounding ("my", "me", "today's", "last few days") so
//    "write an email validator" or "how do calendars work" never fire,
//  · time windows come from the message when stated; a bare ask defaults to 7 days
//    (the tool output states its own window, so the answer stays honest either way).

const PERSONAL_DOMAINS: Array<{ noun: RegExp; tool: string }> = [
  { noun: /\b(emails?|inbox|mail)\b/i, tool: 'gmail_search' },
  { noun: /\b(calendar|schedule|meetings?|events?|appointments?)\b/i, tool: 'calendar_list' },
]

// First-person / deictic grounding — the ask is about the USER's data, now-ish.
const PERSONAL_DEIXIS = /\b(my|me|mine|i\s+have|i've\s+got|today'?s?|tomorrow|yesterday|tonight|this\s+(?:week|morning|afternoon|evening)|last\s+(?:day|night|week|\d+\s+days?|few\s+days?|couple(?:\s+of)?\s+days?)|past\s+(?:day|week|\d+\s+days?|few\s+days?)|recent(?:ly)?|new|unread|upcoming)\b/i

// Creation/mutation intent — needs real planning and consent, never a bare-name fire.
// NB: 'reply'/'forward' are excluded as bare words — "any email that needs a reply" is a
// RETRIEVAL ask where "reply" is a noun (this exact phrasing fabricated an answer in the
// 2026-07-20 report). Only their verb-with-object forms ("reply to", "forward to") count.
const MUTATION_VERBS = /\b(send|draft|compose|create|add|book|cancel|delete|unsubscribe|reply\s+to|forward\s+to|schedule\s+an?|build|make|generate|implement|develop|design|code)\b/i

/** Day window stated in the message → gmail newer_than / calendar days. Deterministic map;
 *  null when nothing recency-shaped is stated (caller applies the 7-day default). */
function statedDayWindow(msg: string): number | null {
  const n = msg.match(/\b(?:last|past)\s+(\d{1,2})\s+days?\b/i)
  if (n) return Math.max(1, Math.min(30, Number(n[1])))
  if (/\b(?:last|past)\s+(?:few)\s+days?\b/i.test(msg)) return 3
  if (/\b(?:last|past)\s+couple(?:\s+of)?\s+days?\b/i.test(msg)) return 2
  if (/\b(?:last|past|this)\s+week\b/i.test(msg)) return 7
  if (/\btoday'?s?\b|\blast\s+(?:day|night)\b|\btonight\b|\bthis\s+(?:morning|afternoon|evening)\b/i.test(msg)) return 1
  return null
}

/**
 * Resolve a retrieval ask about the user's own email/calendar into the same read-only
 * ToolCalls the explicit router produces. Null when the message isn't such an ask —
 * the caller proceeds to its normal path unchanged.
 */
export function resolveImplicitPersonalTools(message: string): NamedToolResolution | null {
  const msg = (message ?? '').trim()
  if (!msg || msg.length > 400) return null            // long briefs deserve real planning
  if (MUTATION_VERBS.test(msg)) return null
  if (!PERSONAL_DEIXIS.test(msg)) return null
  const days = statedDayWindow(msg) ?? 7
  const calls: ToolCall[] = []
  let i = 0
  for (const d of PERSONAL_DOMAINS) {
    if (!d.noun.test(msg)) continue
    const args = d.tool === 'gmail_search'
      ? { query: `newer_than:${days}d in:inbox`, maxResults: 15 }
      : { maxResults: 15, days }
    calls.push({ id: `implicit_${i++}`, name: d.tool, args })
  }
  return calls.length ? { calls, skipped: [] } : null
}
