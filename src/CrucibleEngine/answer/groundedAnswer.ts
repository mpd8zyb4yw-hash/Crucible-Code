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

import {
  search, fetch as fetchPage, stripBoilerplate, namesExternalLibrary, isCodingQuery, namesInstrument,
  fetchLibraryApiForQuery, type SearchResult, type LibraryApiDocs,
} from '../retrieval/retrievalLayer'
import { fmComplete, fmStream, type ConvTurn } from '../agent/fmReact'
import { debugBus } from '../debug/bus'
import { describeViolations, answerCodeBlocks, documentedCallSurface } from '../reasoning/apiFaithfulness'
// EXECUTES the answer's code against the real library. The name-matching check alone certified
// JSON-Schema-with-a-regex wearing a decorative import (cont.86b) — provenance is not correctness.
import { certifyAnswer } from '../reasoning/executionVerify'
import { repairUntilFaithful, type RepairMessage } from '../reasoning/faithfulRepair'
import { isMiniCpmAvailable, miniCpmComplete } from '../agent/miniCpmHarness'
import { bonsaiComplete, isBonsaiInstalled, repairModelName } from '../localModels/bonsaiSidecar'

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
/**
 * Per-call ceiling for the SECOND repair proposer (MiniCPM5-1B). >0 seats it; 0 disables it and
 * restores the single-FM search.
 *
 * DEFAULT 0 — MEASURED, cont.86. The second proposer is the doctrinally-right answer to the cont.84/85
 * ceiling (one model re-sampled K times re-samples ONE distribution), and the rotation mechanism below
 * is live, benched and safe. But MiniCPM specifically does not deliver it, measured on the real captured
 * draft+evidence pair:
 *
 *   FM only     certified 4/4, avg 11.9s
 *   FM+MiniCPM  certified 4/4, avg 29.7s  — MiniCPM earned 0, abstaining on EVERY call
 *
 * Across 5 calls (both the prose-shaped repair hint AND a code-shaped positive prompt built to this
 * harness's own documented convention) MiniCPM narrated instead of emitting code — 5/5 abstain — and
 * mangled `z.ipv4()` into `zipv4()`: the same cont.82 "won't copy the identifier out of clean evidence"
 * failure as the FM, so it is not an INDEPENDENT failure mode, which is the entire premise of seating it.
 * Enabling it therefore buys +18s per repair for zero measured recovery. That is a latency regression
 * dressed as doctrine, so it ships OFF until a second engine that actually emits code is seated (the
 * GGUF pool's code-tuned models are the obvious candidate — see localModelCatalog).
 *
 * Set CRUCIBLE_FAITH_ALT_MS=25000 to re-enable. When on, the cost is bounded: this caps one call, the
 * caller clamps it to the repair budget remaining, and a timeout returns '' → a null proposal, which
 * search() treats as transient infra failure — charging NO budget and rotating the slot back to the FM.
 */
const MINICPM_REPAIR_MS = Number(process.env.CRUCIBLE_FAITH_ALT_MS ?? 0)
/**
 * Bonsai-27B's per-call ceiling when it LEADS repair, and the repair allowance that must cover
 * it. Both are large on purpose.
 *
 * The standing instruction — seat a second proposer in every refinement loop — has been parked
 * since cont.86 for a stated reason: "ships OFF until a second engine that actually EMITS CODE
 * is seated". Bonsai is that engine, and it is now measured (cont.88, identical evidence and
 * prompt, only the model differing):
 *
 *   Apple FM      copies z.ipv4  0/3   EXECUTES 0/3
 *   Bonsai-27B    copies z.ipv4  3/3   EXECUTES 3/3
 *
 * WHY IT LEADS RATHER THAN ROTATES SECOND. On this failure class the FM does not merely fail
 * once — it re-fabricates the very name the hint just rejected (cont.83/86: "detection works,
 * recovery does not"). Its repair attempts are ~12s each of measured non-recovery, so opening
 * with the FM and rotating to Bonsai on attempt 2 would spend real budget on a known-dead
 * branch. The engine that can actually fix it goes first; the FM stays seated as the alt, where
 * it is free (it is fast) and can only ADD certified candidates — it cannot lower the bar.
 *
 * THE COST IS REAL AND DELIBERATE: Bonsai runs ~2.5 tok/s in background mode (the mode that
 * keeps the machine usable — see bonsaiSidecar.ts), so a ~350-token re-synthesis is ~2 minutes.
 * The 60s default could not fit even one attempt, which would seat the engine and never let it
 * finish — a dead gate wearing a green badge, the exact failure this project keeps repeating.
 * Repair only ever fires on a REAL violation (the common abstain path never enters the loop),
 * and the alternative is knowingly shipping a fabricated API. Set CRUCIBLE_BONSAI_REPAIR_MS=0
 * to unseat it.
 */
const BONSAI_REPAIR_MS = Number(process.env.CRUCIBLE_BONSAI_REPAIR_MS ?? 200_000)
const BONSAI_BUDGET_MS = Number(process.env.CRUCIBLE_BONSAI_FAITH_BUDGET_MS ?? 240_000)

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

  // Window-level IDF: weight a term by how FEW windows contain it. The rare term is the whole
  // point of the query ("ipv4"), and the common ones ("schema", "zod", "validate") are noise
  // that appears on nearly every window of a library's docs.
  //
  // The previous weight — 1/log2(2+occurrences) — was bounded in (0,1], so a rare term only
  // outweighed a common one ~4x and a window stacking FOUR common terms beat the one window
  // that actually contained the answer. Measured on zod's 53KB .d.ts: the selected passage came
  // back full of ZodCUID with ZERO mentions of ipv4, silently dropping the identifier from the
  // evidence. Classic IDF is unbounded as df→0, so a window holding the rare term always wins.
  const windows: string[] = []
  for (let i = 0; i < nWin; i++) windows.push(lower.slice(i * WIN, i * WIN + WIN))
  const df = new Map<string, number>()
  for (const t of terms) df.set(t, windows.reduce((n, w) => n + (w.includes(t) ? 1 : 0), 0))
  const weight = (t: string) => {
    const d = df.get(t) ?? 0
    return d === 0 ? 0 : Math.log2(1 + nWin / (1 + d))
  }

  const scored: Array<{ i: number; score: number }> = []
  for (let i = 0; i < nWin; i++) {
    let score = 0
    for (const t of terms) if (windows[i].includes(t)) score += weight(t)
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

  // ── Authoritative library API surface FIRST (blocker #1 fix, cont.89) ──────────
  // When the question names a library, its published .d.ts IS the fact being asked about.
  // Measured live: every open-web SERP backend is blocked to a server IP (DDG → 202 anti-bot
  // challenge, Bing → 200 JS/consent shell with no result markup), so search() returns 0 and
  // grounding gave up — the model then fabricated. The registry CDN is deterministic, keyless
  // and unthrottled, so this lane WORKS WHEN SEARCH IS DOWN, which is most of the time.
  // It leads the evidence block because a version-pinned declaration outranks any blog post.
  // `namesExternalLibrary` is capitalization-dependent by construction (its strongest signal is
  // a capitalized proper noun), and MEASURED cont.89 that gate alone let only 1 of 10 realistic
  // library asks through — "zod schema to validate an ipv4 address" skipped grounding entirely.
  // For THIS lane the gate is redundant: fetchLibraryApiForQuery already proves a package exists,
  // is popular enough to be meant, and publishes docs relevant to the question. Letting any
  // coding query try it is what makes the lane reachable for lowercase phrasing; a query that
  // names no real library simply gets null back.
  let apiDocs: LibraryApiDocs | null = null
  if (namesExternalLibrary(query) || isCodingQuery(query) || namesInstrument(query)) {
    emit?.({ type: 'thought', text: 'Reading the published type definitions for the named package…' })
    try { apiDocs = await fetchLibraryApiForQuery(opts.searchQuery || query) } catch { apiDocs = null }
    if (apiDocs) {
      debugBus.emit('pipeline', 'grounding_library_api', { pkg: apiDocs.pkg, version: apiDocs.version, files: apiDocs.files }, { severity: 'info' })
      emit?.({ type: 'thought', text: `Found ${apiDocs.pkg}@${apiDocs.version} type definitions — grounding on the real API surface.` })
    }
  }

  emit?.({ type: 'thought', text: 'Searching the web for current, verifiable sources…' })
  let results: SearchResult[] = []
  try { results = await search(opts.searchQuery || query) } catch { results = [] }
  if (signal?.aborted) return null
  // Search being down is NOT fatal any more — the API surface alone is better evidence than
  // the SERP was. Only give up when we have neither.
  if (results.length === 0 && !apiDocs) return null

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
  // The published API surface leads as [S1]: it is version-pinned and authoritative, so it
  // should win any conflict with a blog post or a Q&A snippet further down the block. It is
  // already fetched (no fetchPage), but still passes through selectRelevantPassages so a
  // 50KB .d.ts is trimmed to the windows that actually mention the query's terms.
  if (apiDocs) {
    parts.push(`[S1] ${apiDocs.title} — ${apiDocs.url}\n${selectRelevantPassages(apiDocs.text, opts.searchQuery || query, perSource)}`)
    sources.push(apiDocs.url)
    titles.push(apiDocs.title)
  }
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

  // A request for a schema/snippet that comes back as prose has not been answered. `codeRequested`
  // makes the SINGLE oracle (certifyAnswer) treat "no code block" as a violation — so the draft
  // and every repair attempt are judged identically. Doing it only here would be invisible inside
  // the repair loop, which re-verifies through the same oracle (cont.89).
  const codeRequested = isCodingQuery(message) || namesExternalLibrary(message) || namesInstrument(message)
  const faith = certifyAnswer(text, ev.block, { codeRequested })
  // Did the shipped code actually RUN against the real library, or did it merely name documented
  // identifiers? Both certify, but they are not the same claim, and the badge must not blur them:
  // a name-matched certify is the weak one that shipped JSON Schema as green (cont.86b).
  let executed = faith.status === 'certified' && faith.executed

  // PROVE THE GATE OPENS (cont.84). A verifier that never actually executes is a dead feature that
  // benches green forever. This says, per live request, whether the code REALLY ran — so "the
  // execution verifier is live" is a claim we can READ, not one we assume. If `executed` is false
  // across real traffic, the gate is unreachable and that is a finding to report, not to bury.
  debugBus.emit('pipeline', 'answer_certify', {
    status: faith.status, executed: faith.executed, library: faith.library, reason: faith.reason.slice(0, 120),
  }, { severity: 'info' })
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
    // Bonsai leads repair when it is installed, and it is ~2.5 tok/s — so the allowance has to
    // cover it or the engine is seated but can never finish (see BONSAI_REPAIR_MS).
    const bonsaiReady = BONSAI_REPAIR_MS > 0 && isBonsaiInstalled()
    const repairBudget = bonsaiReady ? Math.max(REPAIR_BUDGET_MS, BONSAI_BUDGET_MS) : REPAIR_BUDGET_MS
    const repairLeft = () => repairBudget - (Date.now() - repairStarted)
    if (repairLeft() > 4000 && !signal?.aborted) {
      emit?.({ type: 'thought', text: `Checked the code against the docs — ${describeViolations(faith)}. Repairing…` })

      // REPAIR IS A SEARCH (cont.84), not a retry. One hinted retry was measured live to
      // re-sample the same distribution and fabricate a DIFFERENT API; the VGR answer is to
      // propose K candidates, keep any the verifier certifies, and carry every rejection
      // forward. The draft enters as candidate 0 for free, so it can only be replaced on a
      // verifier-measured improvement — never on the model's say-so.
      // SECOND PROPOSER (cont.86). One model re-sampled K times re-samples ONE distribution: the
      // FM was measured re-proposing a name the hint had just rejected, which is why K=3 never
      // recovered live. MiniCPM5-1B is seated ALONGSIDE it (never replacing it) so a rejection is
      // re-attempted by an independent generator. Gated on the model actually being resident —
      // absent, `completeAlt` is undefined and this is exactly the cont.84 single-proposer search.
      const altReady = MINICPM_REPAIR_MS > 0 && await isMiniCpmAvailable()
      if (altReady) emit?.({ type: 'thought', text: 'Bringing in a second on-device model (MiniCPM) to cross-check the repair…' })

      if (bonsaiReady) emit?.({ type: 'thought', text: `The docs disagree with the draft — bringing in ${repairModelName()} to rewrite it against the real API…` })

      const fmFn = (m: RepairMessage[], sig?: AbortSignal) =>
        fmComplete(m as typeof msgs, { priority: 'high' as const, timeoutMs: SYNTH_TIMEOUT_MS, maxTokens: 1100, signal: sig })
      // Clamped to the wall-clock actually left, so the slower engine can never overrun the
      // repair budget — a timeout here costs no attempt (null → rotate to the other engine).
      const bonsaiFn = (m: RepairMessage[], sig?: AbortSignal) =>
        bonsaiComplete(m, { maxTokens: 700, timeoutMs: Math.min(BONSAI_REPAIR_MS, Math.max(1, repairLeft())), signal: sig })

      // Bonsai reads its prompt at ~6.6 tok/s in background mode, so every token of padding is
      // ~150ms of latency. MEASURED: the full 1550-token repair prompt cost 190s to READ — 68%
      // of a 278s repair, before generating anything. Same question, same evidence, same hint;
      // just none of the prose scaffolding that exists to shape a 250-word answer for a user.
      const compactMsgs: RepairMessage[] = [
        { role: 'system', content: 'You are a precise coding assistant. Use ONLY APIs that appear in the EVIDENCE. Answer with one short code block and at most one sentence.' },
        { role: 'user', content: `Question: ${message}\n\n## EVIDENCE\n${ev.block}` },
      ]

      const rep = await repairUntilFaithful(
        {
          draft: text, evidence: ev.block, goal: message, baseMsgs: msgs,
          baseMsgsFor: src => (src === repairModelName() ? compactMsgs : null),
          // Bonsai LEADS when installed — it is the only engine measured to copy an identifier
          // out of clean evidence (3/3 vs the FM's 0/3), and the FM's repair attempts on this
          // exact failure class are measured NON-recovery, so opening with the FM would spend
          // budget on a known-dead branch. The FM stays seated as the alt: it is fast, it can
          // only ADD certified candidates, and `proposedBy` records if it ever earns one.
          complete: bonsaiReady ? bonsaiFn : fmFn,
          completeAlt: bonsaiReady
            ? fmFn
            : altReady
              ? (m, sig) => miniCpmComplete(m, sig, { maxTokens: 1100, timeoutMs: Math.min(MINICPM_REPAIR_MS, repairLeft()) })
              : undefined,
          primaryName: bonsaiReady ? repairModelName() : 'afm',
          altName: bonsaiReady ? 'afm' : 'minicpm',
          codeRequested,
        },
        {
          // More attempts when a FAST engine is seated. Repair is a search over a weak model, so
          // each attempt is a Bernoulli trial (qwen measured ~2/3 per attempt on the harder asks
          // like email, where run 0 copies the TYPE name `ZodEmail`). At ~30 tok/s an attempt is
          // ~1-2s, so K=6 turns a 2/3 single-shot into ~99.9% and still fits the budget; the FM's
          // slow non-recovery is exactly why K stayed at 3 before. `canPropose` (wall-clock) is
          // the real backstop either way.
          attempts: bonsaiReady ? Math.max(REPAIR_ATTEMPTS, 6) : REPAIR_ATTEMPTS,
          signal,
          // Re-checked before EVERY attempt, so a slow first repair cannot drag the answer past
          // the allowance: K bounds the calls, this bounds the wall-clock.
          canPropose: () => repairLeft() > 4000,
          onAttempt: (n, v, src) => {
            if (n > 1 && v.status === 'violations')
              emit?.({ type: 'thought', text: `Repair ${n - 1}${src ? ` (${src})` : ''} still doesn't match the docs — ${describeViolations(v)}. Trying again…` })
          },
        },
      )

      if (rep.status === 'certified') {
        text = rep.text
        executed = (rep.verdict as { executed?: boolean }).executed === true
        opts.onToken?.(`\n\n${rep.text}`)
        debugBus.emit('pipeline', 'api_faithfulness_repaired', {
          library: faith.library, modelCalls: rep.modelCalls, detail: rep.detail,
          // WHO earned it. If 'minicpm' never appears across real traffic, the second proposer is
          // not paying for its latency — and that is a finding to report, not to bury.
          proposedBy: rep.proposedBy, altSeated: altReady,
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
          proposedBy: rep.proposedBy, altSeated: altReady,
        }, { severity: 'warn' })
      }
    } else {
      unfaithful = describeViolations(faith)
    }
  }

  const cites = (text.match(/\[S\d+\]/g) ?? []).length
  emit?.(unfaithful
    ? { type: 'verify', passed: false, report: `Grounded in ${ev.sources.length} source${ev.sources.length > 1 ? 's' : ''}, but UNVERIFIED — ${unfaithful}. Treat this code with suspicion.` }
    : { type: 'verify', passed: true, report: `Answer grounded in ${ev.sources.length} web source${ev.sources.length > 1 ? 's' : ''}${cites ? ` with ${cites} inline citation${cites > 1 ? 's' : ''}` : ''}${executed ? `, and the code was EXECUTED against the real ${faith.library ?? 'library'} without failing.` : '.'}` })
  // Flip the live strip's sources to 'grounded' (check-marked) now the answer actually cites them.
  emit?.({ type: 'sources', phase: 'grounded', items: ev.sources.map(u => ({ url: u, host: safeHost(u) })) })
  debugBus.emit('pipeline', 'grounding_hit', { message: message.slice(0, 80), sources: ev.sources.length, cites, ms: Date.now() - started }, { severity: 'info' })

  return { text: withSourcesFooter(text, ev), sources: ev.sources, sourceCount: ev.sources.length }
}
