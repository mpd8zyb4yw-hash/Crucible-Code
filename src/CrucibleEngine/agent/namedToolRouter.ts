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

// Harvest a required arg stated in PROSE rather than in a parenthesised arg list. Live
// failure (debug report 2026-07-20, Schwab draft-reply turn): EmailReader's canned prompt
// says `(Gmail message id 19f5c92ef39e60c2). Read the full message first with gmail_read`
// — the id never sits inside `gmail_read(...)`, so gmail_read was skipped for a "missing"
// messageId and the turn fell to the prose pipeline, which fabricated "I have drafted a
// reply" with zero tool calls. Deterministic extraction, tool-specific, no guessing: a
// Gmail message id is a long hex token and never occurs in ordinary prose.
function harvestProseArg(message: string, tool: string, key: string): string | null {
  if (tool === 'gmail_read' && key === 'messageId') {
    const m = message.match(/\b(?:message|msg)\s*id[:#\s]*([0-9a-f]{10,20})\b/i)
      ?? message.match(/\b(?:id)[:#\s]+([0-9a-f]{14,20})\b/i)
    return m?.[1] ?? null
  }
  return null
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
    for (const k of REQUIRED_NO_DEFAULT[tool] ?? []) {
      if (!(k in args)) {
        const harvested = harvestProseArg(msg, tool, k)
        if (harvested) args[k] = harvested
      }
    }
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

// ── Local-machine facts (cont.118) ────────────────────────────────────────────
//
// MEASURED LIVE (2026-07-28, agent mode). Brief: "List the files in the directory
// src/CrucibleEngine/answer and tell me what is there." Result: **0 tools**, and this answer,
// stamped `✓ verified`:
//
//     1. `answer.py`  — the main script that runs the engine
//     2. `answer.pyi` — the type stub for answer.py
//     3. `answer.json`— the output of the engine
//
// The directory contains twenty-odd `.ts` files and none of those three. The model INVENTED a
// plausible listing, and nothing caught it, because `detectAgentTask` is a list of BUILD and
// MUTATE verbs — create, write, build, run, delete, move — and "list" is not one of them. So a
// question about this machine went to the prose pipeline and was answered from parametric memory.
//
// This is cont.104 exactly ("personal-data asks fell past isAgenticIntent → 'inbox empty' with
// ZERO tool calls, stamped clean"), one domain over. The fix there was
// `resolveImplicitPersonalTools`; this is its local-filesystem twin, and the principle behind
// both is sharper than either verb list:
//
//     A FACT ABOUT THIS MACHINE CANNOT COME FROM THE WEIGHTS.
//
// There is no possible way for a model to know what is in a directory it has never seen. Unlike
// "what is a hash map", where parametric memory is a legitimate source, the correct behaviour
// here is *always* to look or to abstain — never to recall. That is a knowledge-boundary
// property, not a matter of which verb the user happened to type, which is why this gate keys on
// the REFERENT (a path, a directory) rather than on the verb.

/** A path-shaped token: a separator and no spaces — "src/CrucibleEngine/answer", "~/Desktop",
 *  "./build", "/etc/hosts" — or a bare filename carrying an extension ("package.json"). */
const PATH_TOKEN = /(?:~|\.{1,2})?\/[\w.\-/]+|[\w.\-]+\/[\w.\-/]+|\b[\w.\-]+\.[a-z0-9]{1,5}\b/gi

/** A filesystem referent: a path token, or an explicit directory noun. */
const FS_REFERENT = new RegExp(`(?:${PATH_TOKEN.source}|\\b(?:directory|directories|folder|folders)\\b)`, 'i')

/** Read-only inspection intent. Deliberately NOT a build verb — that is the whole point. */
const FS_READ_INTENT = new RegExp(
  '\\b(?:list|ls|show|display|what(?:\'?s| is| are)\\s+(?:in|inside|under)|' +
  'what\\s+files|which\\s+files|how\\s+many\\s+files|contents?\\s+of|look\\s+(?:in|at)|' +
  'browse|inspect|check|find|search|explore|read|open|cat)\\b',
  'i',
)

/** Intent that UNAMBIGUOUSLY wants a file's contents. "what's in X" is deliberately excluded:
 *  it reads identically for a file and a directory, so it defers to the path shape below. */
const FS_FILE_INTENT = /\b(?:read|contents?\s+of|open|cat|inspect)\b/i
/** Intent that specifically wants a LISTING. Wins over FS_FILE_INTENT when both appear. */
const FS_LIST_INTENT = /\b(?:list|ls|what\s+files|which\s+files|how\s+many\s+files|browse|directory|directories|folder|folders)\b/i

/**
 * Strip path tokens before testing for mutation verbs.
 *
 * Caught by `__localtools_bench`: "show me what is in ./build" did not route, because
 * MUTATION_VERBS contains `build` and the PATH contains the word "build". A directory named
 * `build`, `send`, `draft` or `design` is completely ordinary, and letting a filename veto the
 * route would fail silently and look like the gate simply did not fire. Verbs are read from
 * PROSE; a path is an opaque identifier.
 */
function prose(msg: string): string {
  return msg.replace(PATH_TOKEN, ' ')
}

/** Extract the path the user named, if any. Longest path-shaped token wins. */
/**
 * Hostnames, which look exactly like extensioned filenames and are not paths.
 *
 * LIVE (cont.119): "read example.com and tell me what it says" resolved to
 * `read_file({ path: "example.com" })` and failed with "File not found:
 * /Users/justin/Desktop/Crucible/branch-tune-mesa-grain/example.com". The `.com` satisfied the
 * "has a file extension" test, so a web page became a local file. A TLD is a closed, factual
 * class — unlike the open class of things a filename can be — so listing the common ones is sound
 * where guessing at filenames would not be. Anything with a slash is still a path, so
 * "example.com/index.html" and "./notes.com" are unaffected.
 */
const HOSTNAME_LIKE = /^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|co|edu|gov|uk|de|fr|jp|dev|app|ai|so|me|tv|info|biz|xyz)$/i

/** Every path-shaped token the user named, DISTINCT, longest first. */
function statedPaths(msg: string): string[] {
  const candidates = msg.match(PATH_TOKEN) ?? []
  const qualifying = candidates
    .map(s => s.replace(/[.,;:)]+$/, ''))
    // Require a separator OR a file extension; a bare word is not a path, and "3/4" is caught
    // by the length floor plus the read-intent requirement.
    .filter(s => (s.includes('/') || /\.[a-z0-9]{1,5}$/i.test(s)) && s.length > 1)
    // ...but a bare hostname is a SITE, not a file on this disk.
    .filter(s => s.includes('/') || !HOSTNAME_LIKE.test(s))
  // Naming the same referent twice is still ONE referent — "read src/api.ts, what's in
  // src/api.ts?" must not read as two. Trailing slashes are noise on a directory.
  return [...new Set(qualifying.map(s => s.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length)
}

function statedPath(msg: string): string | null {
  return statedPaths(msg)[0] ?? null
}

/**
 * Resolve a read-only question about THIS MACHINE's filesystem into real tool calls.
 *
 * Returns null unless the message BOTH names a filesystem referent and expresses a read intent,
 * and carries no mutation verb — so "build me a game" and "what is a hash map" are untouched and
 * take exactly the path they take today. Like its personal-data twin this only ever ROUTES a
 * question to a tool that can actually answer it; it never invents an intent.
 */
export function resolveImplicitLocalTools(message: string): NamedToolResolution | null {
  const msg = (message ?? '').trim()
  if (!msg || msg.length > 400) return null            // long briefs deserve real planning
  // Verbs are read from PROSE, never from a path — a directory called `build` is ordinary.
  const text = prose(msg)
  if (MUTATION_VERBS.test(text)) return null           // creating/changing needs real planning
  if (!FS_REFERENT.test(msg)) return null
  if (!FS_READ_INTENT.test(text)) return null

  // This resolver fires exactly ONE call and the server ships that call's output as the
  // answer — there is no loop behind it to take a second step. So a goal naming TWO distinct
  // referents is out of its jurisdiction, and taking it means answering a question the user
  // did not ask.
  //
  // MEASURED LIVE (2026-08-04): "Look at the files in ~/Desktop/agentprobe and tell me what is
  // in notes.txt" resolved to one `list_dir(~/Desktop/agentprobe)` — the longest path token won
  // and "files in" set the listing intent — and the whole answer was "notes.txt". The file the
  // user asked about was never opened.
  //
  // Declining hands the turn to fmReact, which carries list_dir AND read_file and loops, so
  // both steps are reachable there. This costs latency on a two-file question and buys back the
  // answer; the single-referent questions this gate exists for are untouched.
  const paths = statedPaths(msg)
  if (paths.length > 1) return null

  const p = statedPath(msg)
  // A request that names a SITE and no local path is a web request, and must not fall back to
  // the project root. Without this, "read example.com and tell me what it says" declined to use
  // the domain as a path (above) and then read `.` instead — a different wrong answer to a
  // question that was never about this disk.
  // A slash does not make a URL a path: "https://example.com/page" and "example.com/page" both
  // survive statedPath's separator test, so the web target has to be rejected explicitly.
  // PATH_TOKEN drops the scheme, so a URL arrives here as "//example.com/page" — strip any
  // leading scheme and slashes before asking whether the first segment is a host.
  const looksWeb = (t: string) => {
    const bare = t.replace(/^https?:/i, '').replace(/^\/{2,}/, '')
    return /^https?:\/\//i.test(t) || HOSTNAME_LIKE.test(bare.split('/')[0].replace(/[.,;:)]+$/, ''))
  }
  if (p && looksWeb(p)) return null
  if (!p && (/https?:\/\//i.test(msg) || (msg.match(PATH_TOKEN) ?? []).some(t => looksWeb(t.replace(/[.,;:)]+$/, ''))))) {
    return null
  }
  // No explicit path but a directory noun ("what files are in this folder") → the project root,
  // which is what `list_dir` defaults to.
  const target = p ?? '.'

  // FILE or DIRECTORY. The VERB is the better signal than the path shape: "/etc/hosts" carries
  // no extension yet "what's in /etc/hosts" plainly wants the contents, while "list src/foo.ts"
  // is a user who mistyped. An explicit listing verb wins; otherwise a file-contents verb or a
  // file extension selects read_file. Both tools are read-only and both enforce their own path
  // safety — this router picks which QUESTION is being asked, never what is permitted.
  const wantsListing = FS_LIST_INTENT.test(text)
  const wantsFile = !wantsListing && (FS_FILE_INTENT.test(text) || /\.[a-z0-9]{1,5}$/i.test(target))
  return {
    calls: [wantsFile
      ? { id: 'local_0', name: 'read_file', args: { path: target } }
      : { id: 'local_0', name: 'list_dir', args: { path: target } }],
    skipped: [],
  }
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
