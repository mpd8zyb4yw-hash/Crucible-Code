// Web-grounded answering — the real-time knowledge gap-closer.
//
// The thesis (cont.67): the on-device brain does not need to MEMORIZE the world. When a
// question exceeds what it reliably knows, it should do what a person does — look it up,
// read the sources, and answer FROM them — instead of bluffing from thin parametric
// memory or dead-ending in an abstain. This module is that loop:
//
//     search (domain-routed, structured) → fetch top sources → strip to evidence →
//     FM synthesizes an answer grounded in THAT evidence, with inline [S#] citations.
//
// It emits live steps ("Searching…", "Reading …", "Grounding …") so the user sees the
// gap being closed, and returns the sources so the answer is auditable. Returns null when
// the web yields nothing usable, so the caller falls back to a parametric draft — grounding
// only ever makes an answer better or is transparently skipped, never worse.

import { search, fetch as fetchPage, stripBoilerplate, type SearchResult } from '../retrieval/retrievalLayer'
import { fmComplete, fmStream, type ConvTurn } from '../agent/fmReact'
import { debugBus } from '../debug/bus'
import { verifyApiFaithfulness, describeViolations } from '../reasoning/apiFaithfulness'
import { repairUntilFaithful } from '../reasoning/faithfulRepair'

export interface GroundedResult {
  text: string
  /** URLs actually read and cited, in [S1..Sn] order. */
  sources: string[]
  /** How many independent sources fed the answer. */
  sourceCount: number
}

export interface GroundOpts {
  history?: ConvTurn[]
  /** Older-turn recall (turn-1 anchor + relevance-retrieved), folded into the system prompt as an
   *  authoritative "earlier in this conversation" block — the same long-horizon memory the direct
   *  path uses, so a grounded follow-up ("what's the latest on the project I mentioned") still sees
   *  the fact the user stated 200 turns ago. Lexical/deterministic; built by buildRecallContext. */
  recallBlock?: string
  emit?: (event: Record<string, unknown>) => void
  signal?: AbortSignal
  /** Wall-clock ceiling for the whole grounding pass; on overrun the caller's fallback ships. */
  budgetMs?: number
  /** Per-source excerpt size (chars). */
  perSourceChars?: number
  /** Explicit web-search query (e.g. the metacognitive gate's suggested terms). Falls back to
   *  the message when absent. Synthesis always answers the original question. */
  searchQuery?: string
  /** Token sink — when provided, the grounded answer STREAMS (first fragment ~0.7s instead of
   *  waiting for the whole answer to decode). Receives raw fragments as they generate. */
  onToken?: (delta: string) => void
}

const DEFAULT_BUDGET_MS = Number(process.env.CRUCIBLE_GROUND_BUDGET_MS ?? 14_000)
const MAX_SOURCES = 3
const PER_SOURCE_CHARS = 1200
const EVIDENCE_BUDGET = 3600
const PER_FETCH_MS = 4500   // hard cap per page so one slow site can't blow the whole budget
const SYNTH_TIMEOUT_MS = Number(process.env.CRUCIBLE_GROUND_SYNTH_MS ?? 30_000)
/**
 * K — model-backed repair attempts when the faithfulness verifier rejects the draft. Each is a
 * full re-synthesis, so this trades wall-clock for a certified answer; the wall-clock budget
 * (`canPropose`) cuts the search short before it can overrun. Only ever spent on a REAL
 * violation — the common `abstain` path never enters the loop and costs nothing.
 */
const REPAIR_ATTEMPTS = Number(process.env.CRUCIBLE_FAITH_ATTEMPTS ?? 3)
/**
 * Repair's OWN wall-clock allowance, measured from when repair starts — deliberately NOT the
 * remainder of the retrieval budget, for the same reason SYNTH_TIMEOUT_MS is not (see above).
 *
 * MEASURED (cont.84): the retrieval budget defaults to 14s while synthesis alone is allowed 30s,
 * so `remaining()` is tens of seconds NEGATIVE by the time the verifier rules — the old
 * `remaining() > 4000` repair gate was therefore UNREACHABLE on default settings, and the repair
 * path had never once executed live (cont.83 only saw it run under a hand-raised 90s budget).
 * A gate that can never open is a dead feature that benches green, so the budget that governs
 * FETCHING must not silently decide whether we FIX a known-fabricated answer.
 *
 * The tradeoff is explicit: repair costs a full re-synthesis per attempt and only ever fires on
 * a REAL violation (the common `abstain` path never enters the loop). Shipping a knowingly-wrong
 * answer faster is not the goal. Set to 0 to disable repair entirely.
 */
const REPAIR_BUDGET_MS = Number(process.env.CRUCIBLE_FAITH_BUDGET_MS ?? 60_000)

interface Evidence {
  block: string
  sources: string[]     // urls in [S#] order
  titles: string[]
}

// ── Query-relevance windowing ────────────────────────────────────────────────
// A page's answer is rarely in its first N chars — on a docs page those chars are
// nav chrome. Blind `text.slice(0, perSource)` therefore fetched the right page and
// then discarded the answer (audit cont.81: zod's `ipv4` sat at offset 6370 of 7955;
// the 1200-char head held only the DeepWiki sidebar, so the model had NO ipv4 mention
// in evidence and grafted an unrelated zipCode regex it DID find).
//
// Universal fix: score fixed-size windows of the page by query-term coverage and keep
// the best-scoring ones in document order. Falls back to the head slice when nothing
// matches, so a query whose terms are absent behaves exactly as before.

const STOPWORDS = new Set(['the','a','an','is','are','was','were','to','of','in','on','for','and','or','what','which','how','do','does','did','that','this','it','with','as','at','by','from','be','can','i','you','use','using','used','exact','method','way','string','valid'])

/** Content words from a query, lowercased, de-duped, stopwords removed. */
export function queryTerms(query: string): string[] {
  const raw = (query.toLowerCase().match(/[a-z0-9_.]+/g) ?? [])
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
  return [...new Set(raw)]
}

/**
 * Select up to `budget` chars of `text` most relevant to `query`.
 * Splits into overlapping windows, scores each by distinct query-term hits (rare terms
 * weighted higher via inverse document frequency within the page), and stitches the
 * top windows back together in document order.
 */
export function selectRelevantPassages(text: string, query: string, budget: number): string {
  if (text.length <= budget) return text
  const terms = queryTerms(query)
  if (!terms.length) return text.slice(0, budget)

  const WIN = 400
  const lower = text.toLowerCase()
  const nWin = Math.ceil(text.length / WIN)

  // Per-term page frequency → rare terms (e.g. "ipv4") outweigh common ones (e.g. "zod").
  const freq = new Map<string, number>()
  for (const t of terms) {
    const m = lower.split(t).length - 1
    freq.set(t, m)
  }
  const weight = (t: string) => {
    const f = freq.get(t) ?? 0
    return f === 0 ? 0 : 1 / Math.log2(2 + f)
  }

  const scored: Array<{ i: number; score: number }> = []
  for (let i = 0; i < nWin; i++) {
    const w = lower.slice(i * WIN, i * WIN + WIN)
    let score = 0
    for (const t of terms) if (w.includes(t)) score += weight(t)
    scored.push({ i, score })
  }
  if (scored.every(s => s.score === 0)) return text.slice(0, budget)

  // Take best windows until the budget is spent, then re-order by position so the
  // stitched passage still reads in document order.
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  const keep: number[] = []
  let used = 0
  for (const s of scored) {
    if (s.score === 0) break
    if (used + WIN > budget) break
    keep.push(s.i); used += WIN
  }
  if (!keep.length) return text.slice(0, budget)
  keep.sort((a, b) => a - b)

  const out: string[] = []
  let prev = -2
  for (const i of keep) {
    if (i !== prev + 1 && out.length) out.push(' … ')
    out.push(text.slice(i * WIN, i * WIN + WIN))
    prev = i
  }
  return out.join('')
}

// Query stopwords so scoring keys on topical tokens, not "what/how/the/…".
const RANK_STOP = new Set('what is are how does do did why who when where the of for a an in and or to with explain describe tell me about which that this it its'.split(/\s+/))
// Title-side stopwords: query verbs/fillers that legitimately appear in a query but are NOT
// part of the entity ("who WROTE Dune"). These must not count as "extra" content tokens when
// judging how canonical a title is, and never inflate the extra-token penalty.
const TITLE_STOP = new Set('wrote written write author authored by created made discovered invented directed produced founded designed built the of a an in on and or to'.split(/\s+/))

function titleContentTokens(title: string): string[] {
  // Strip parenthetical disambiguators — "Dune (novel)" is the canonical base article for the
  // entity "Dune"; the "(novel)" qualifier should not read as extra specificity.
  const bare = title.toLowerCase().replace(/\([^)]*\)/g, ' ')
  return [...new Set(bare.match(/[a-z0-9][a-z0-9.+#_-]{2,}/g) ?? [])].filter(t => !TITLE_STOP.has(t))
}

// Intent → disambiguator-class map. A creation verb in the query implies the WORK TYPE the
// asker means: "who WROTE Dune" wants the written work, not the film franchise. Wikipedia
// disambiguates same-name entities with a parenthetical ("Dune (novel)" / "Dune (franchise)"),
// so when the base-token overlap ties, the page whose disambiguator matches the verb's class
// should win. Each entry maps trigger verbs to the disambiguator keywords they favour.
const INTENT_DISAMBIG: Array<{ verbs: string[]; classes: string[] }> = [
  { verbs: ['wrote', 'written', 'write', 'author', 'authored', 'novelist', 'penned'],
    classes: ['novel', 'book', 'novella', 'poem', 'play', 'story', 'short story', 'memoir', 'essay'] },
  { verbs: ['directed', 'director', 'filmed'],
    classes: ['film', 'movie', 'miniseries'] },
  { verbs: ['painted', 'painter'],
    classes: ['painting', 'artwork'] },
  { verbs: ['composed', 'composer'],
    classes: ['opera', 'symphony', 'ballet', 'concerto', 'composition'] },
  { verbs: ['sang', 'sung', 'recorded', 'singer'],
    classes: ['song', 'single', 'album'] },
  { verbs: ['sculpted', 'sculptor'],
    classes: ['sculpture', 'statue'] },
]

function titleDisambig(title: string): string {
  return (title.toLowerCase().match(/\(([^)]*)\)/)?.[1] ?? '').trim()
}

// Specific-work disambiguator classes. A Wikipedia parenthetical like "(2023 TV series)",
// "(1999 film)" or "(album)" marks a NAMED creative work — not a general concept. A plain-
// language question ("what causes the northern lights") almost never means the show that merely
// shares a word, yet such pages win on raw lexical overlap ("Blue Lights" literally contains
// "lights"; a "Northern Irish" snippet supplies "northern"). So: when the query carries NO signal
// that the user wants a specific work, demote work-disambiguated pages hard.
const WORK_DISAMBIG_TOKENS = [
  'film', 'movie', 'tv', 'television', 'series', 'miniseries', 'season', 'episode', 'sitcom',
  'album', 'song', 'single', 'band', 'soundtrack', 'video game', 'game', 'novel', 'novella',
  'book', 'play', 'musical', 'opera', 'anime', 'manga', 'comic', 'comics',
]
const YEAR_RE = /\b(?:19|20)\d{2}\b/
// Query tokens that DO invite a specific work — the intent verbs plus common media nouns. If any
// appears, the off-topic penalty is disabled (intentBonus then handles which work-type wins).
const MEDIA_INTENT_TOKENS = new Set<string>([
  ...INTENT_DISAMBIG.flatMap(e => e.verbs),
  'film', 'movie', 'show', 'series', 'tv', 'television', 'episode', 'season', 'sitcom',
  'album', 'song', 'single', 'band', 'soundtrack', 'video', 'game', 'videogame',
  'novel', 'novella', 'book', 'play', 'musical', 'opera', 'anime', 'manga', 'comic', 'comics',
  'franchise', 'cast', 'starring', 'actor', 'actress', 'watch', 'trailer', 'sequel', 'prequel',
])

/** Does this title's disambiguator mark a specific creative work (media type or a release year)? */
function isWorkDisambig(title: string): boolean {
  const d = titleDisambig(title)
  if (!d) return false
  if (YEAR_RE.test(d)) return true
  return WORK_DISAMBIG_TOKENS.some(w => d.includes(w))
}

/** Tiny tie-break bonus (< the 0.5 penalty step, so it only reorders exact ties): give a small
 *  edge to the disambiguator page whose work-type matches a creation verb in the query. */
function intentBonus(title: string, queryTokens: Set<string>): number {
  const disambig = titleDisambig(title)
  if (!disambig) return 0
  for (const { verbs, classes } of INTENT_DISAMBIG) {
    if (!verbs.some(v => queryTokens.has(v))) continue
    if (classes.some(c => disambig.includes(c))) return 0.25
  }
  return 0
}

/**
 * Rank results by salient-token overlap, TITLE-weighted (a title match signals the page is
 * ABOUT the topic, not just mentioning it — this demotes tangential hits like "Rock cycle" for
 * "water cycle"), then keep only sources scoring within a relative band of the best. Dropping
 * low-relevance sources keeps the evidence clean so the FM isn't grounded on noise.
 *
 * CANONICAL-TITLE PREFERENCE (cont.67): within the same overlap tier the base entity page must
 * beat its derivatives. "who wrote Dune" hits "Dune Messiah", "Children of Dune" and
 * "Dune (novel)" all with the same {dune} title overlap, and Wikipedia's own order often puts a
 * sequel first — so the answer grounded on the wrong book. We subtract a small penalty for each
 * title content token NOT asked for in the query (a sequel's "Messiah"/"Children" is extra
 * specificity the base article lacks). The penalty is fractional and capped so it only reorders
 * WITHIN an overlap tier — a genuinely more-relevant page (≥1 more matched salient token = ≥2
 * points) always still wins.
 */
export function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const sal = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{2,}/g) ?? []))].filter(t => !RANK_STOP.has(t))
  if (sal.length === 0) return results
  const salSet = new Set(sal)
  // Full query tokens (verbs included, unfiltered) drive the intent tie-break.
  const queryTokens = new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []))
  // Does the query itself invite a specific creative work? If not, work-disambiguated pages
  // ("(2023 TV series)", "(1999 film)") are almost certainly not what the asker means.
  const wantsWork = [...queryTokens].some(t => MEDIA_INTENT_TOKENS.has(t))
  const scored = results.map(r => {
    const title = (r.title ?? '').toLowerCase()
    const body = `${r.snippet ?? ''} ${r.url ?? ''}`.toLowerCase()
    // Title matches count double; snippet/url matches count once.
    const overlap = sal.reduce((n, t) => n + (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0), 0)
    // Canonical penalty: title content tokens the query never mentioned = derivative-page signal.
    const titleTokens = titleContentTokens(r.title ?? '')
    const extras = titleTokens.filter(t => !salSet.has(t)).length
    // Exact-base bonus: a title whose content tokens (disambiguator stripped) are EXACTLY the
    // salient entity is the canonical article for it — the residual tie-break for bare same-base
    // titles that all share extras=0 ("Mercury" over "Mercury Records" when both clear the tier).
    // Smaller than the intent bonus so an intent match still wins a three-way tie.
    const exactBase = titleTokens.length > 0 && titleTokens.every(t => salSet.has(t)) ? 0.15 : 0
    // Off-topic-work penalty: a specific-work page the query never invited is demoted below any
    // genuine concept/entity page. Large (3) so it clears a full title-overlap match, but applied
    // only when the query carries no media intent — so "who directed Dune" is untouched.
    const offTopic = !wantsWork && isWorkDisambig(r.title ?? '')
    const score = overlap - 0.5 * Math.min(extras, 3) + intentBonus(r.title ?? '', queryTokens) + exactBase - (offTopic ? 3 : 0)
    return { r, score, overlap, offTopic }
  }).sort((a, b) => b.score - a.score)
  const top = scored[0]?.overlap ?? 0
  if (top === 0) return scored.map(s => s.r)
  // Keep the best source always; keep others only if their raw overlap is at least ~40% as
  // relevant — this drops the tangential long tail while still allowing genuine corroborating
  // sources. Threshold is on overlap (not the penalized score) so a verbose-but-on-topic
  // corroborator isn't dropped for its title length.
  const threshold = Math.max(1, top * 0.4)
  const kept = scored.filter((s, i) => (i === 0 || s.overlap >= threshold) && !s.offTopic)
  // Off-topic secondary-work pages are dropped outright (not just demoted) so they never leak in
  // as a cited source — but only while a genuine page survives; if EVERYTHING was work-shaped
  // (the query really was about a work after all), fall back to the score-ranked set.
  return (kept.length ? kept : scored).map(s => s.r)
}

/** Search → fetch top sources → assemble a budget-fit, citation-numbered evidence block. */
async function gatherEvidence(query: string, opts: GroundOpts): Promise<Evidence | null> {
  const { emit, signal } = opts
  emit?.({ type: 'thought', text: 'Searching the web for current, verifiable sources…' })
  let results: SearchResult[] = []
  try { results = await search(opts.searchQuery || query) } catch { results = [] }
  if (signal?.aborted || results.length === 0) return null

  const ranked = rankResults(results, query).slice(0, MAX_SOURCES)
  emit?.({ type: 'thought', text: `Found ${results.length} sources — reading the top ${ranked.length}: ${ranked.map(r => safeHost(r.url)).join(', ')}…` })
  // Structured event for the live favicon strip in the UI (thought text stays for the log).
  emit?.({ type: 'sources', phase: 'reading', items: ranked.map(r => ({ url: r.url, host: safeHost(r.url) })) })

  const perSource = opts.perSourceChars ?? PER_SOURCE_CHARS
  // Fetch pages in PARALLEL with a hard per-fetch cap — sequential full-page fetches were
  // the latency killer (3 slow StackOverflow pages blew the whole budget). The retrieval
  // layer eager-caches SO answers + Wikipedia extracts during search(), so many of these
  // resolve instantly from cache; the cap bounds the rest.
  const fetched = await Promise.all(ranked.map(async item => {
    let text = ''
    try {
      const raced = await Promise.race([
        fetchPage(item.url).then(stripBoilerplate),
        new Promise<string>(r => setTimeout(() => r(''), PER_FETCH_MS)),
      ])
      text = raced
    } catch { text = '' }
    // A bare title/snippet is still worth citing when the body didn't come through.
    if (text.length < 80) text = `${item.title}. ${item.snippet}`.trim()
    return { item, text }
  }))

  const parts: string[] = []
  const sources: string[] = []
  const titles: string[] = []
  for (const { item, text } of fetched) {
    if (text.length < 40) continue
    const n = sources.length + 1
    const host = safeHost(item.url)
    parts.push(`[S${n}] ${item.title || host} — ${item.url}\n${selectRelevantPassages(text, opts.searchQuery || query, perSource)}`)
    sources.push(item.url)
    titles.push(item.title || host)
  }
  if (sources.length === 0) return null

  let block = parts.join('\n\n---\n\n')
  if (block.length > EVIDENCE_BUDGET) block = block.slice(0, EVIDENCE_BUDGET) + '\n… (truncated)'
  return { block, sources, titles }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url.slice(0, 40) }
}

const GROUNDING_SYSTEM =
  "You are Crucible, a private AI assistant running on the user's own device. You have just " +
  'retrieved live web sources to answer the user\'s question. Write a clear, accurate, well-' +
  'structured answer using the EVIDENCE below as your primary source of truth.\n' +
  '- Ground every factual claim in the evidence; do not contradict it and do not invent facts ' +
  'it does not support.\n' +
  '- Cite sources inline with [S1], [S2], … immediately after the claims they support.\n' +
  '- You may use your own knowledge to explain, connect, and add helpful context, but anything ' +
  'the evidence can settle must match the evidence.\n' +
  "- If the evidence doesn't fully answer the question, say what it does establish and what " +
  'remains uncertain — never pad or bluff.\n' +
  '- Be direct and FOCUSED: a tight, information-dense answer (roughly 120-250 words unless the ' +
  'question genuinely needs more). Answer the question asked, then STOP.\n' +
  '- Do NOT append an "Example" section, extra scenarios, or a restated conclusion unless the ' +
  'user explicitly asked for one — that padding is what makes answers run long and get cut off.\n' +
  '- Use markdown structure where it helps. Do not mention "the evidence" as a phrase — just ' +
  'answer and cite.'

function historyToMessages(history?: ConvTurn[]): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return []
  return history.slice(-4).flatMap(h => [
    { role: 'user', content: h.user },
    { role: 'assistant', content: h.assistant },
  ])
}

/** Append a compact, clickable sources footer so citations resolve for the user. */
function withSourcesFooter(text: string, ev: Evidence): string {
  const cited = new Set((text.match(/\[S(\d+)\]/g) ?? []).map(m => Number(m.replace(/\D/g, ''))))
  // If the model cited nothing, still show all sources (the answer is grounded in them).
  const idxs = cited.size ? [...cited].sort((a, b) => a - b) : ev.sources.map((_, i) => i + 1)
  const lines = idxs
    .filter(n => n >= 1 && n <= ev.sources.length)
    .map(n => `[S${n}] ${ev.titles[n - 1]} — ${ev.sources[n - 1]}`)
  if (!lines.length) return text
  return `${text.trim()}\n\n---\nSources:\n${lines.join('\n')}`
}

/**
 * Answer `message` by researching the web and synthesizing a grounded, cited answer.
 * Returns null (→ caller falls back to a parametric answer) when the web yields nothing
 * usable or the FM synthesis is empty. Honors a wall-clock budget and the abort signal.
 */
export async function answerWithWebGrounding(message: string, opts: GroundOpts = {}): Promise<GroundedResult | null> {
  const { emit, signal, history } = opts
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const started = Date.now()
  const remaining = () => budgetMs - (Date.now() - started)

  const ev = await gatherEvidence(message, opts)
  if (!ev || signal?.aborted) {
    debugBus.emit('pipeline', 'grounding_no_evidence', { message: message.slice(0, 80) }, { severity: 'info' })
    return null
  }
  if (remaining() < 3000) {
    debugBus.emit('pipeline', 'grounding_budget_exhausted', { message: message.slice(0, 80), sources: ev.sources.length }, { severity: 'warn' })
    return null
  }

  emit?.({ type: 'thought', text: `Grounding the answer in ${ev.sources.length} source${ev.sources.length > 1 ? 's' : ''}…` })
  const groundingSystem = opts.recallBlock
    ? `${GROUNDING_SYSTEM}\n\n## Earlier in this conversation (facts the user already told you — treat as authoritative)\n${opts.recallBlock}`
    : GROUNDING_SYSTEM
  const msgs = [
    { role: 'system', content: groundingSystem },
    ...historyToMessages(history),
    { role: 'user', content: `Question: ${message}\n\n## EVIDENCE\n${ev.block}` },
  ]
  let text = ''
  try {
    // Synthesis gets its own generous timeout (it IS the answer) — NOT derived from the
    // remaining budget, which starved it into timing out. A capped max_tokens keeps the
    // focused answer fast regardless. When a token sink is wired, STREAM (first fragment ~0.7s).
    const fmOpts = { priority: 'high' as const, timeoutMs: SYNTH_TIMEOUT_MS, maxTokens: 1100, signal }
    text = opts.onToken
      ? (await fmStream(msgs, opts.onToken, fmOpts)).trim()
      : (await fmComplete(msgs, fmOpts)).trim()
  } catch { text = '' }
  if (!text || text.length < 20) {
    debugBus.emit('pipeline', 'grounding_synth_empty', { message: message.slice(0, 80) }, { severity: 'warn' })
    return null
  }

  // ── API-FAITHFULNESS GATE (cont.82) ─────────────────────────────────────────────
  // The measured blocker: the FM grounds on the right page, CITES it, and contradicts it —
  // `import { Schema } from 'zod'` with a literal `z.ipv4();` in the evidence. Prompting alone
  // does not fix it (a code-aware prompt merely swapped one fabrication for another), so we
  // CHECK instead of asking: reject library identifiers the evidence never mentions, feed the
  // violation back, and re-synthesize. Verification is pure and free; only a real violation
  // ever spends a model call. `abstain` (the overwhelmingly common verdict — prose answers,
  // no library) costs nothing and changes nothing.
  // Set when the answer ships with known-fabricated APIs — suppresses the green "grounded"
  // badge below. A verified-looking badge over a known-bad artifact is the exact cont.79h
  // failure (a green gate only ever means "nothing I check is broken"), so the one verify
  // event this function emits must tell the truth.
  let unfaithful: string | null = null

  const faith = verifyApiFaithfulness(text, ev.block)
  if (process.env.CRUCIBLE_DUMP_FAITH) {
    const fsx = await import('fs')
    fsx.writeFileSync(process.env.CRUCIBLE_DUMP_FAITH + '.evidence.txt', ev.block)
    fsx.writeFileSync(process.env.CRUCIBLE_DUMP_FAITH + '.answer.txt', text)
    fsx.writeFileSync(process.env.CRUCIBLE_DUMP_FAITH + '.verdict.json', JSON.stringify(faith, null, 2))
  }
  if (faith.status === 'violations') {
    debugBus.emit('pipeline', 'api_faithfulness_violation', {
      library: faith.library, identifiers: faith.violations.map(v => v.identifier), reason: faith.reason,
    }, { severity: 'warn' })

    // Repair runs on its OWN clock (REPAIR_BUDGET_MS), not the retrieval budget's remainder —
    // which is always exhausted here and made this branch dead code. See REPAIR_BUDGET_MS.
    const repairStarted = Date.now()
    const repairLeft = () => REPAIR_BUDGET_MS - (Date.now() - repairStarted)
    if (repairLeft() > 4000 && !signal?.aborted) {
      emit?.({ type: 'thought', text: `Checked the code against the docs — ${describeViolations(faith)}. Repairing…` })

      // REPAIR IS A SEARCH (cont.84), not a retry. One hinted retry was measured live to
      // re-sample the same distribution and fabricate a DIFFERENT API; the VGR answer is to
      // propose K candidates, keep any the verifier certifies, and carry every rejection
      // forward. The draft enters as candidate 0 for free, so it can only be replaced on a
      // verifier-measured improvement — never on the model's say-so.
      const rep = await repairUntilFaithful(
        { draft: text, evidence: ev.block, goal: message, baseMsgs: msgs, complete: (m, sig) =>
          fmComplete(m as typeof msgs, { priority: 'high' as const, timeoutMs: SYNTH_TIMEOUT_MS, maxTokens: 1100, signal: sig }) },
        {
          attempts: REPAIR_ATTEMPTS,
          signal,
          // Re-checked before EVERY attempt, so a slow first repair cannot drag the answer past
          // the allowance: K bounds the calls, this bounds the wall-clock.
          canPropose: () => repairLeft() > 4000,
          onAttempt: (n, v) => {
            if (n > 1 && v.status === 'violations')
              emit?.({ type: 'thought', text: `Repair ${n - 1} still doesn't match the docs — ${describeViolations(v)}. Trying again…` })
          },
        },
      )

      if (rep.status === 'certified') {
        text = rep.text
        opts.onToken?.(`\n\n${rep.text}`)
        debugBus.emit('pipeline', 'api_faithfulness_repaired', {
          library: faith.library, modelCalls: rep.modelCalls, detail: rep.detail,
        }, { severity: 'info' })
      } else {
        // Honest failure. We do NOT return null: the caller's fallback is a PARAMETRIC answer,
        // which is strictly more fabrication-prone and loses the citations. Ship the grounded
        // best candidate, but say it is unverified rather than badging it green. 'best-effort'
        // means the search measurably improved the draft yet still could not certify it — a
        // better artifact with the same honest badge, never a green one.
        if (rep.status === 'best-effort') {
          text = rep.text
          opts.onToken?.(`\n\n${rep.text}`)
        }
        unfaithful = describeViolations(rep.verdict)
        debugBus.emit('pipeline', 'api_faithfulness_repair_failed', {
          library: faith.library, status: rep.status, modelCalls: rep.modelCalls, detail: rep.detail,
        }, { severity: 'warn' })
      }
    } else {
      unfaithful = describeViolations(faith)
    }
  }

  const cites = (text.match(/\[S\d+\]/g) ?? []).length
  emit?.(unfaithful
    ? { type: 'verify', passed: false, report: `Grounded in ${ev.sources.length} source${ev.sources.length > 1 ? 's' : ''}, but UNVERIFIED — ${unfaithful}. Treat this code with suspicion.` }
    : { type: 'verify', passed: true, report: `Answer grounded in ${ev.sources.length} web source${ev.sources.length > 1 ? 's' : ''}${cites ? ` with ${cites} inline citation${cites > 1 ? 's' : ''}` : ''}.` })
  // Flip the live strip's sources to 'grounded' (check-marked) now the answer actually cites them.
  emit?.({ type: 'sources', phase: 'grounded', items: ev.sources.map(u => ({ url: u, host: safeHost(u) })) })
  debugBus.emit('pipeline', 'grounding_hit', { message: message.slice(0, 80), sources: ev.sources.length, cites, ms: Date.now() - started }, { severity: 'info' })

  return { text: withSourcesFooter(text, ev), sources: ev.sources, sourceCount: ev.sources.length }
}
