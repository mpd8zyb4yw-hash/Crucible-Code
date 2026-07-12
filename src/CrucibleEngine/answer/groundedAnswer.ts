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

export interface GroundedResult {
  text: string
  /** URLs actually read and cited, in [S1..Sn] order. */
  sources: string[]
  /** How many independent sources fed the answer. */
  sourceCount: number
}

export interface GroundOpts {
  history?: ConvTurn[]
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

interface Evidence {
  block: string
  sources: string[]     // urls in [S#] order
  titles: string[]
}

// Query stopwords so scoring keys on topical tokens, not "what/how/the/…".
const RANK_STOP = new Set('what is are how does do did why who when where the of for a an in and or to with explain describe tell me about which that this it its'.split(/\s+/))

/**
 * Rank results by salient-token overlap, TITLE-weighted (a title match signals the page is
 * ABOUT the topic, not just mentioning it — this demotes tangential hits like "Rock cycle" for
 * "water cycle"), then keep only sources scoring within a relative band of the best. Dropping
 * low-relevance sources keeps the evidence clean so the FM isn't grounded on noise.
 */
function rankResults(results: SearchResult[], query: string): SearchResult[] {
  const sal = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{2,}/g) ?? []))].filter(t => !RANK_STOP.has(t))
  if (sal.length === 0) return results
  const scored = results.map(r => {
    const title = (r.title ?? '').toLowerCase()
    const body = `${r.snippet ?? ''} ${r.url ?? ''}`.toLowerCase()
    // Title matches count double; snippet/url matches count once.
    const score = sal.reduce((n, t) => n + (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0), 0)
    return { r, score }
  }).sort((a, b) => b.score - a.score)
  const top = scored[0]?.score ?? 0
  if (top === 0) return scored.map(s => s.r)
  // Keep the best source always; keep others only if they're at least ~40% as relevant — this
  // drops the tangential long tail while still allowing genuine corroborating sources.
  const threshold = Math.max(1, top * 0.4)
  return scored.filter((s, i) => i === 0 || s.score >= threshold).map(s => s.r)
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
    parts.push(`[S${n}] ${item.title || host} — ${item.url}\n${text.slice(0, perSource)}`)
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
  const msgs = [
    { role: 'system', content: GROUNDING_SYSTEM },
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

  const cites = (text.match(/\[S\d+\]/g) ?? []).length
  emit?.({ type: 'verify', passed: true, report: `Answer grounded in ${ev.sources.length} web source${ev.sources.length > 1 ? 's' : ''}${cites ? ` with ${cites} inline citation${cites > 1 ? 's' : ''}` : ''}.` })
  debugBus.emit('pipeline', 'grounding_hit', { message: message.slice(0, 80), sources: ev.sources.length, cites, ms: Date.now() - started }, { severity: 'info' })

  return { text: withSourcesFooter(text, ev), sources: ev.sources, sourceCount: ev.sources.length }
}
