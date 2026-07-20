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

// ── Catch-up / "brief me on my day" intent ─────────────────────────────────────
// The residual gap from the 2026-07-20 report ("real turn 3": "just in general"): asks
// that describe the INTENT — a day-at-a-glance catch-up — without naming a domain noun
// (email/calendar). "what's on my plate today", "what needs my attention", "brief me on
// my day", "what's my day look like". Deixis is present but no domain noun, so the
// domain loop above resolves nothing and the request falls to the prose pipeline that
// fabricated "your inbox is empty". This IS the "Your day" concept the Home tiles ship:
// it maps 1:1 to the SAME two read-only tools, so it stays doctrine-sound (the model
// never invents data; the tools state their own windows).
//
// EXPLICIT phrase alternation, not a loose "catch me up on X" — "catch me up on the auth
// refactor" must NOT fire gmail/calendar. Each alternative carries its own day/attention
// framing so a false fire can't hijack an ordinary project/code turn.
const CATCHUP_INTENT = new RegExp(
  [
    "what'?s?\\s+(?:on\\s+)?my\\s+(?:plate|agenda)",
    "what\\s+(?:do\\s+i|have\\s+i)\\s+(?:got|have)\\s+(?:on|going\\s+on)\\b",
    "what'?s?\\s+going\\s+on\\s+(?:today|this\\s+(?:morning|afternoon|week))",
    "(?:catch|fill)\\s+me\\s+(?:up|in)\\s+on\\s+my\\s+day",
    "brief\\s+me\\s+on\\s+my\\s+day",
    "what\\s+needs?\\s+my\\s+attention",
    "what\\s+should\\s+i\\s+(?:know|be\\s+aware\\s+of|focus\\s+on)\\s+(?:about\\s+)?today",
    "(?:what|how)\\s+does\\s+my\\s+day\\s+look",
    "what'?s?\\s+my\\s+day\\s+look\\s+like",
    "anything\\s+i\\s+(?:need\\s+to|should)\\s+(?:deal\\s+with|handle|know\\s+about)\\b",
  ].join('|'),
  'i',
)

function catchupCalls(days: number): ToolCall[] {
  return [
    { id: 'catchup_0', name: 'gmail_search', args: { query: `newer_than:${days}d in:inbox`, maxResults: 15 } },
    { id: 'catchup_1', name: 'calendar_list', args: { maxResults: 15, days } },
  ]
}

// ── Entity-scoped inbox retrieval — "surface all emails from/about X" ───────────
// The emphasized PA ask (2026-07-20e user direction): "surface all emails from/about X"
// and Crucible ACCURATELY surfaces them. Doctrine-sound because GMAIL does the accurate
// retrieval — we only translate the NL relation into a precise gmail_search query
// (from:X / a content term), never guess at results. Deterministic string mapping, no
// model. Conservative firing: only on a clear retrieval request (a find/show/surface verb,
// an all/any/every quantifier, or a trailing "?"), so a statement like "the email from
// Dana was rude" never triggers a search.
const RETRIEVAL_FRAME = /\b(?:find|show|surface|search|get|pull\s+up|dig\s+up|list|fetch|look\s+up|bring\s+up|see|display|round\s+up|gather)\b/i
const RETRIEVAL_QUANTIFIER = /\b(?:all|any|every|everything|anything)\b/i
const isRetrievalRequest = (m: string): boolean =>
  RETRIEVAL_FRAME.test(m) || RETRIEVAL_QUANTIFIER.test(m) || /\?\s*$/.test(m)

// The noun that precedes the relation — real mail synonyms only. "stuff/anything/everything"
// let "surface everything from Dana" work without the literal word "email".
const MAIL_NOUN = '(?:emails?|mail|messages?|inbox|correspondence|stuff|anything|everything)'
// Compound "from X about Y" first (most specific), then sender-only, then content-only.
const FROM_ABOUT_REL = new RegExp(`\\b${MAIL_NOUN}\\s+from\\s+(.+?)\\s+(?:about|regarding|mentioning|concerning|re)\\s+(.+)$`, 'i')
const FROM_REL = new RegExp(`\\b${MAIL_NOUN}\\s+from\\s+(.+)$`, 'i')
const ABOUT_REL = new RegExp(`\\b${MAIL_NOUN}\\s+(?:about|regarding|mentioning|concerning|related\\s+to|on\\s+the\\s+(?:subject|topic)\\s+of|re)\\s+(.+)$`, 'i')

// Trailing time expressions are a window, not part of the sender/topic — strip them off the
// captured target so "emails from Dana in the last week" → from:Dana (+ newer_than:7d), not
// a from: filter containing the words "in the last week".
const TIME_TAIL = /\s+(?:(?:in|from|over|during|within|since)\s+)?(?:the\s+)?(?:last|past|this|recent)?\s*(?:\d{1,2}\s+)?(?:days?|weeks?|months?|today|yesterday|tonight|this\s+(?:week|morning|afternoon|evening)|few\s+days?|couple(?:\s+of)?\s+days?|night)\b.*$/i
// A LEADING time expression means the "target" was purely a recency phrase ("emails from
// last week") — strip it so cleanTarget collapses to '' and the ask falls through to the
// recency resolver instead of producing a nonsense from:last filter.
const TIME_LEAD = /^(?:(?:in|from|over|during|within|since)\s+)?(?:the\s+)?(?:last|past|this|recent)\s+(?:\d{1,2}\s+)?(?:days?|weeks?|months?|week|day|night|few\s+days?|couple(?:\s+of)?\s+days?)\b/i

/** Normalize a captured target: drop trailing punctuation/politeness, a trailing time
 *  clause, and a leading article. Returns '' when nothing meaningful survives (e.g. the
 *  "target" was only a time expression → this isn't an entity search after all). */
function cleanTarget(raw: string): string {
  let t = raw.trim().replace(/[?.!,;:]+\s*$/, '').replace(/\s+please\b\s*$/i, '').trim()
  t = t.replace(TIME_LEAD, '').trim()
  t = t.replace(TIME_TAIL, '').trim()
  t = t.replace(/^(?:the|a|an|my|any|all|some)\s+/i, '').trim()
  // A residue that is itself purely a recency/deixis word is not an entity.
  if (!t || /^(?:last|past|this|recent|recently|new|newer|unread|latest|lately)$/i.test(t)) return ''
  return t
}

// A valid entity target is a short name/topic, not a relative clause. These markers signal
// the capture ran past the entity into a predicate ("...from the last day THAT NEEDS a reply")
// — reject so a recency/brief ask isn't mangled into a from:"that needs a reply" filter.
const CLAUSE_MARKER = /\b(?:that|which|who|whom|whose|and|needs?|requires?|please|when|where|containing|labeled)\b/i
const isEntityLike = (t: string): boolean =>
  !!t && t.split(/\s+/).length <= 5 && !CLAUSE_MARKER.test(t)

// A strong calendar noun alongside a mail noun means this is a multi-domain day brief
// ("today's calendar and my inbox…"), not a single-entity mail search — defer to the
// catch-up / recency resolvers. "meeting"/"event" are deliberately NOT here: they're common
// mail TOPICS ("emails about the meeting") and must not block an entity search.
const CALENDAR_STRONG = /\b(?:calendar|schedule|appointments?)\b/i

/** Gmail from: operand — quote multi-word names so `from:"Dana Rivera"` stays one filter. */
const senderOperand = (t: string): string => (/\s/.test(t) ? `from:"${t}"` : `from:${t}`)
/** Gmail content operand — quote a multi-word phrase for an exact-phrase match. */
const contentOperand = (t: string): string => (/\s/.test(t) ? `"${t}"` : t)

/** Build the entity-scoped gmail_search calls, or null when the message isn't one. */
function resolveEntityScopedMail(msg: string): NamedToolResolution | null {
  if (!isRetrievalRequest(msg)) return null
  if (CALENDAR_STRONG.test(msg)) return null   // multi-domain brief → not a single-entity search
  const days = statedDayWindow(msg) ?? (/\byesterday\b/i.test(msg) ? 1 : null)
  const window = days ? ` newer_than:${days}d` : ''

  let query: string | null = null
  let ma: RegExpMatchArray | null
  if ((ma = msg.match(FROM_ABOUT_REL))) {
    const sender = cleanTarget(ma[1]); const topic = cleanTarget(ma[2])
    if (isEntityLike(sender) && isEntityLike(topic)) query = `${senderOperand(sender)} ${contentOperand(topic)}`
    else if (isEntityLike(sender)) query = senderOperand(sender)
  }
  if (!query && (ma = msg.match(FROM_REL))) {
    const sender = cleanTarget(ma[1])
    if (isEntityLike(sender)) query = senderOperand(sender)
  }
  if (!query && (ma = msg.match(ABOUT_REL))) {
    const topic = cleanTarget(ma[1])
    if (isEntityLike(topic)) query = contentOperand(topic)
  }
  if (!query) return null
  // No in:inbox restriction — "surface ALL emails from/about X" searches all mail. maxResults
  // higher than the recency default since an entity search is meant to be exhaustive.
  return { calls: [{ id: 'entity_0', name: 'gmail_search', args: { query: query + window, maxResults: 25 } }], skipped: [] }
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
  // Entity-scoped mail ("surface all emails from/about X") → a precise gmail_search query.
  // Checked before catch-up + the recency domain loop because it carries its own sender/topic
  // filter; a bare recency ask ("emails from last week") strips to no entity and falls through.
  const entity = resolveEntityScopedMail(msg)
  if (entity) return entity
  // Catch-up brief: intent named without a domain noun → both read-only day tools.
  // Checked before the domain loop so a bare "what's on my plate" resolves even though
  // PERSONAL_DOMAINS finds no email/calendar noun to match.
  if (CATCHUP_INTENT.test(msg)) {
    return { calls: catchupCalls(statedDayWindow(msg) ?? 1), skipped: [] }
  }
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

// ── Deterministic personal-data renderer ───────────────────────────────────────
// gmail_search and calendar_list already return CLEAN, structured text. Handing that
// to the weak on-device FM to "summarize" is pure downside for a retrieval ask: live
// (2026-07-20) the FM collapsed a full inbox to a single sender address, fabricated
// "your inbox is empty" over real mail, and twice shipped a 0-char answer. When the user
// asked to SEE their email/calendar, the data IS the answer — format it, never
// paraphrase it. This turns a lossy reasoning step into a lossless formatting step and
// makes an empty/fabricated final structurally impossible whenever a tool returned data.

export interface RenderableOutput { tool: string; ok: boolean; output: string }

const GMAIL_EMPTY = /^No emails found/i
const CAL_EMPTY = /^No upcoming events found/i

function renderGmail(output: string): string {
  if (GMAIL_EMPTY.test(output.trim())) return 'No emails found in your inbox for that window.'
  // Blocks are "[id] From: …\nDate: …\nSubject: …\nSnippet: …" joined by "\n\n---\n\n".
  const blocks = output.split(/\n\n---\n\n/).map(b => b.trim()).filter(Boolean)
  const items = blocks.map((b, i) => {
    const from = /^\s*(?:\[[^\]]*\]\s*)?From:\s*(.*)$/im.exec(b)?.[1]?.trim() ?? ''
    const date = /^\s*Date:\s*(.*)$/im.exec(b)?.[1]?.trim() ?? ''
    const subj = /^\s*Subject:\s*(.*)$/im.exec(b)?.[1]?.trim() || '(no subject)'
    const snip = /^\s*Snippet:\s*([\s\S]*)$/im.exec(b)?.[1]?.trim() ?? ''
    const head = `${i + 1}. ${subj} — ${from || 'unknown sender'}${date ? ` · ${date}` : ''}`
    return snip ? `${head}\n   ${snip}` : head
  })
  return items.length ? `Your recent emails:\n\n${items.join('\n\n')}` : output.trim()
}

function renderCalendar(output: string): string {
  if (CAL_EMPTY.test(output.trim())) return 'Nothing on your calendar for that window.'
  return `Your calendar:\n\n${output.trim()}`
}

/**
 * Format retrieved personal-data tool outputs into a clean, lossless answer. Returns
 * null when none of the successful outputs are renderable personal data (caller keeps
 * its FM path). Only ok outputs are rendered; errors are the caller's concern.
 */
export function renderPersonalData(outputs: RenderableOutput[]): string | null {
  const parts: string[] = []
  for (const o of outputs) {
    if (!o.ok) continue
    if (o.tool === 'gmail_search') parts.push(renderGmail(o.output))
    else if (o.tool === 'calendar_list') parts.push(renderCalendar(o.output))
  }
  return parts.length ? parts.join('\n\n') : null
}
