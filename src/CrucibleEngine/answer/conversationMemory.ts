// Conversation memory — long-horizon recall inside a finite model window.
//
// The problem: Apple FM (like any model) has a bounded context window. The live answer path used
// to either flatten the ENTIRE history into the prompt (overflows + gets silently truncated at
// ~message N, so the tail wins and the model still "forgets" the middle) or pass only the last
// few turns (forgets everything older — ask something on turn 500 that depends on turn 1 and it's
// gone). Neither remembers message 1 at message 500.
//
// The fix here is RETRIEVAL, not summarization: summarizing every old turn would need an FM call
// per turn (slow) and can hallucinate. Instead we deterministically SELECT which past turns to
// put in the window, maximizing recall of what THIS message actually needs:
//
//   1. RECENCY  — the last K turns verbatim (the immediate thread is always coherent).
//   2. ANCHOR   — the FIRST turn(s) always retained: they set the topic/task/persona the whole
//                 conversation hangs off ("build me a todo app" on turn 1, referenced on turn 90).
//   3. RELEVANCE — older turns scored by salient-token overlap with the current message; the
//                 best-matching ones are pulled back in (turn 1's "my name is Sam" resurfaces the
//                 moment turn 500 says "what's my name?").
//
// Everything is packed to a char budget (a proxy for the token budget), newest-relevant first,
// then re-sorted into chronological order so the model reads a coherent timeline. When a turn is
// dropped, a compact "[…N earlier turns omitted…]" marker is inserted so the model knows there is
// unshown history rather than assuming the shown turns are the whole conversation.
//
// The LEXICAL selection (selectMemory / buildRecallContext) is pure and deterministic: no model
// calls, no network, same inputs → same window, every time. It matches on shared salient TOKENS,
// so a back-reference that shares no words with the turn it means ("that thing we discussed" →
// a turn about "the bakery inventory app") won't retrieve. buildRecallContextAsync adds a bounded,
// best-effort SEMANTIC supplement on top: when the lexical pass is thin (vague/back-reference
// query), it embeds the query + the older turns lexical missed (on-device MiniLM, cached) and pulls
// in the closest by cosine. It only ever ADDS turns the lexical pass didn't already keep, degrades
// to the lexical result if embeddings are unavailable, and is gated by CRUCIBLE_SEMANTIC_RECALL.

import type { ConvTurn } from '../agent/fmReact'
import { embed, cosineSimilarity, isOnnxAvailable } from '../masterpiece/corpus/embed'

export interface MemoryOpts {
  /** Char budget for the assembled history (≈ 4 chars/token). Default fits a few thousand tokens
   *  while leaving room for the system prompt, evidence, and the model's own output. */
  budgetChars?: number
  /** How many most-recent turns are ALWAYS kept verbatim, regardless of relevance. */
  recentKeep?: number
  /** How many earliest turns are anchored (topic/task setters). */
  anchorKeep?: number
  /** Per-turn text is clipped to this many chars before packing so one giant turn can't eat the
   *  whole budget (its head carries the topic; the retrieval still matched on the full text). */
  perTurnClip?: number
}

const DEFAULT_BUDGET = 12_000
const DEFAULT_RECENT = 4
const DEFAULT_ANCHOR = 1
const DEFAULT_CLIP = 1_500

// Topical stopwords so relevance keys on content, not "what/the/you/…". Mirrors the retrieval
// ranker's set intentionally — the same notion of "salient token" across the system.
const STOP = new Set(('a an the of for and or to in on at is are was were be been being do does did ' +
  'what how why when where who which that this it its i you he she they we me my your our their ' +
  'with about from into out up down so as if then than can could should would will just have has ' +
  'had not no yes but by me us them him her').split(/\s+/))

function salientTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9.+#_-]{2,}/g) ?? []).filter(t => !STOP.has(t)))
}

function clip(text: string, n: number): string {
  const t = (text ?? '').trim()
  return t.length <= n ? t : t.slice(0, n).trimEnd() + '…'
}

/** Overlap score of a past turn against the current message's salient tokens. A match in the
 *  USER side of the turn weighs more (what the user cared about) than the assistant's reply. */
function relevance(turn: ConvTurn, want: Set<string>): number {
  if (want.size === 0) return 0
  const u = salientTokens(turn.user)
  const a = salientTokens(turn.assistant)
  let score = 0
  for (const t of want) {
    if (u.has(t)) score += 2
    else if (a.has(t)) score += 1
  }
  return score
}

export interface MemoryResult {
  /** The selected turns, in chronological order, each possibly clipped. */
  turns: ConvTurn[]
  /** Indices (into the original history) that were kept, chronological. */
  keptIndex: number[]
  /** How many turns were omitted for budget. */
  omitted: number
}

/**
 * Select and pack the slice of `history` most useful for answering `currentMessage`, bounded by a
 * char budget. Returns turns in chronological order (+ bookkeeping). Never throws.
 */
export function selectMemory(history: ConvTurn[] | undefined, currentMessage: string, opts: MemoryOpts = {}): MemoryResult {
  const turns = Array.isArray(history) ? history.filter(h => h && (h.user || h.assistant)) : []
  const n = turns.length
  if (n === 0) return { turns: [], keptIndex: [], omitted: 0 }

  const budget = opts.budgetChars ?? DEFAULT_BUDGET
  const recentKeep = Math.max(0, opts.recentKeep ?? DEFAULT_RECENT)
  const anchorKeep = Math.max(0, opts.anchorKeep ?? DEFAULT_ANCHOR)
  const perTurnClip = opts.perTurnClip ?? DEFAULT_CLIP

  // If the whole history already fits, keep it all (no need to drop anything).
  const cost = (i: number) => clip(turns[i].user, perTurnClip).length + clip(turns[i].assistant, perTurnClip).length + 24
  const totalCost = turns.reduce((s, _t, i) => s + cost(i), 0)
  if (totalCost <= budget) {
    return { turns: turns.map(t => ({ user: clip(t.user, perTurnClip), assistant: clip(t.assistant, perTurnClip) })), keptIndex: turns.map((_t, i) => i), omitted: 0 }
  }

  const want = salientTokens(currentMessage)
  const kept = new Set<number>()
  let used = 0

  // Priority order: mandatory recency, then mandatory anchors, then relevance-ranked older turns.
  const mandatory: number[] = []
  for (let i = Math.max(0, n - recentKeep); i < n; i++) mandatory.push(i)
  for (let i = 0; i < Math.min(anchorKeep, n); i++) mandatory.push(i)

  for (const i of mandatory) {
    if (kept.has(i)) continue
    kept.add(i); used += cost(i)   // mandatory turns are added even if they slightly exceed budget
  }

  // Fill remaining budget with the most relevant older turns (highest score first; newer breaks ties).
  const candidates = []
  for (let i = 0; i < n; i++) {
    if (kept.has(i)) continue
    candidates.push({ i, score: relevance(turns[i], want) })
  }
  candidates.sort((a, b) => b.score - a.score || b.i - a.i)
  for (const c of candidates) {
    if (c.score <= 0) break                 // nothing topical left to add
    const cst = cost(c.i)
    if (used + cst > budget) continue        // skip this one, a smaller later one may still fit
    kept.add(c.i); used += cst
  }

  const keptIndex = [...kept].sort((a, b) => a - b)
  return {
    turns: keptIndex.map(i => ({ user: clip(turns[i].user, perTurnClip), assistant: clip(turns[i].assistant, perTurnClip) })),
    keptIndex,
    omitted: n - keptIndex.length,
  }
}

export interface RecallContext {
  /** The immediate thread — the last `recentKeep` turns, verbatim, as normal conversation. */
  recentTurns: ConvTurn[]
  /** Older selected turns (anchor + relevance-retrieved) rendered as a labeled evidence block for
   *  the system prompt, or '' when there is nothing older to recall. Empty for short conversations
   *  (everything is already in recentTurns). */
  recallBlock: string
  /** How many earlier turns are folded into recallBlock. */
  recalledCount: number
  /** Total turns not shown anywhere (neither recent nor recalled). */
  omitted: number
}

/**
 * Split conversation memory into TWO channels the weak FM handles far better than one long chat
 * log: (1) the recent thread verbatim, and (2) a compact "earlier in this conversation" evidence
 * block of the older turns this message actually needs. The block is surfaced in the system prompt
 * exactly like retrieved web evidence — the one place the model reliably reads facts — so turn 1's
 * "my name is Sam" is recalled at turn 500 without relying on the model to scan 500 chat turns.
 */
export function buildRecallContext(history: ConvTurn[] | undefined, currentMessage: string, opts: MemoryOpts = {}): RecallContext {
  const all = Array.isArray(history) ? history.filter(h => h && (h.user || h.assistant)) : []
  const n = all.length
  const recentKeep = Math.max(0, opts.recentKeep ?? DEFAULT_RECENT)
  const recentStart = Math.max(0, n - recentKeep)
  const recentTurns = all.slice(recentStart)

  if (recentStart === 0) {
    // Whole conversation is "recent" — nothing older to recall.
    return { recentTurns, recallBlock: '', recalledCount: 0, omitted: 0 }
  }

  // Select from the OLDER portion only (everything before the recent window).
  const older = all.slice(0, recentStart)
  const sel = selectMemory(older, currentMessage, {
    ...opts,
    recentKeep: 0,                                  // recency handled separately above
    anchorKeep: Math.max(1, opts.anchorKeep ?? DEFAULT_ANCHOR),
    budgetChars: opts.budgetChars ?? DEFAULT_BUDGET,
  })
  if (sel.turns.length === 0) {
    return { recentTurns, recallBlock: '', recalledCount: 0, omitted: older.length }
  }

  const recallBlock = sel.keptIndex.map(i => renderRecallLine(older[i], i, opts)).join('\n')
  return {
    recentTurns,
    recallBlock,
    recalledCount: sel.keptIndex.length,
    omitted: older.length - sel.keptIndex.length,
  }
}

function renderRecallLine(t: ConvTurn, originalIdx: number, opts: MemoryOpts): string {
  const u = clip(t.user, opts.perTurnClip ?? DEFAULT_CLIP)
  const a = clip(t.assistant, 300)
  return `- (turn ${originalIdx + 1}) User: ${u}${a ? `\n  You replied: ${a}` : ''}`
}

// ── Semantic recall supplement ──────────────────────────────────────────────────
// Lexical relevance misses a back-reference that shares no salient tokens with its target. This
// adds the closest older turns by EMBEDDING cosine — but only when the lexical pass was thin (so a
// well-specified query pays zero embedding cost) and only turns lexical didn't already keep. On the
// hash fallback (ONNX unavailable) the embedding degrades to content-word overlap ≈ lexical, so the
// worst case is "no worse than lexical". Bounded: scans at most SEM_SCAN candidates, adds ≤ SEM_MAX.
// MiniLM cosine for topically-related but differently-worded short turns lands ~0.20–0.40, while
// unrelated pairs sit near 0 (measured: a bakery/inventory turn scores 0.24 against a "pastry
// ingredient stock" back-reference vs −0.01 for football filler). A 0.22 floor separates the two
// with margin; the SEM_MAX add-cap bounds the blast radius of a borderline pull either way.
const SEM_MIN = Number(process.env.CRUCIBLE_SEMANTIC_MIN ?? 0.22)   // cosine floor to count as related
const SEM_MAX = Number(process.env.CRUCIBLE_SEMANTIC_MAX_ADD ?? 3)  // most extra turns to pull in
const SEM_SCAN = Number(process.env.CRUCIBLE_SEMANTIC_SCAN ?? 120)  // candidate cap (bounds cost)

// Turn-embedding cache so a turn is embedded once across requests, not re-embedded every call.
const _turnEmb = new Map<string, Float32Array>()
const EMB_CACHE_MAX = 4000

function embedTextFor(t: ConvTurn): string {
  // Weight the USER side (what they cared about); a little assistant context helps disambiguate.
  return clip(t.user, 400) + (t.assistant ? ' ' + clip(t.assistant, 200) : '')
}

async function embedTurnCached(t: ConvTurn): Promise<Float32Array> {
  const key = `${t.user ?? ''} ${t.assistant ?? ''}`
  const hit = _turnEmb.get(key)
  if (hit) return hit
  const v = await embed(embedTextFor(t))
  if (_turnEmb.size >= EMB_CACHE_MAX) {
    const oldest = _turnEmb.keys().next().value
    if (oldest !== undefined) _turnEmb.delete(oldest)
  }
  _turnEmb.set(key, v)
  return v
}

/** Return `keptIndex` plus any older turns that are semantically close to `message` but were
 *  lexically missed. Best-effort: on any failure returns `keptIndex` unchanged. */
async function addSemanticTurns(older: ConvTurn[], message: string, keptIndex: number[], opts: MemoryOpts): Promise<number[]> {
  const want = salientTokens(message)
  // Only spend embeddings when lexical is THIN — a vague/back-reference query (few salient tokens)
  // or one where lexical matched almost nothing. Well-specified queries stay on the free fast path.
  const lexicalHits = keptIndex.filter(i => relevance(older[i], want) > 0).length
  if (want.size > 3 && lexicalHits > 1) return keptIndex

  const keptSet = new Set(keptIndex)
  const cand: number[] = []
  for (let i = older.length - 1; i >= 0 && cand.length < SEM_SCAN; i--) if (!keptSet.has(i)) cand.push(i)
  if (cand.length === 0) return keptIndex

  const qv = await embed(message)
  const scored: Array<{ i: number; s: number }> = []
  for (const i of cand) scored.push({ i, s: cosineSimilarity(qv, await embedTurnCached(older[i])) })
  scored.sort((a, b) => b.s - a.s)

  const perTurnClip = opts.perTurnClip ?? DEFAULT_CLIP
  const budget = opts.budgetChars ?? DEFAULT_BUDGET
  const cost = (i: number) => clip(older[i].user, perTurnClip).length + clip(older[i].assistant, perTurnClip).length + 24
  let used = keptIndex.reduce((s, i) => s + cost(i), 0)
  const out = [...keptIndex]
  let added = 0
  for (const { i, s } of scored) {
    if (added >= SEM_MAX || s < SEM_MIN) break
    const c = cost(i)
    if (used + c > budget) continue
    out.push(i); used += c; added++
  }
  return out
}

/**
 * Async superset of buildRecallContext: the same lexical selection, plus a bounded semantic pass
 * that recovers older turns a token-only match would miss. Falls back to the exact lexical result
 * when semantic recall is disabled or embeddings are unavailable.
 */
export async function buildRecallContextAsync(history: ConvTurn[] | undefined, currentMessage: string, opts: MemoryOpts = {}): Promise<RecallContext> {
  const all = Array.isArray(history) ? history.filter(h => h && (h.user || h.assistant)) : []
  const n = all.length
  const recentKeep = Math.max(0, opts.recentKeep ?? DEFAULT_RECENT)
  const recentStart = Math.max(0, n - recentKeep)
  const recentTurns = all.slice(recentStart)
  if (recentStart === 0) return { recentTurns, recallBlock: '', recalledCount: 0, omitted: 0 }

  const older = all.slice(0, recentStart)
  const lexOpts: MemoryOpts = {
    ...opts,
    recentKeep: 0,
    anchorKeep: Math.max(1, opts.anchorKeep ?? DEFAULT_ANCHOR),
    budgetChars: opts.budgetChars ?? DEFAULT_BUDGET,
  }
  const sel = selectMemory(older, currentMessage, lexOpts)
  let keptIndex = sel.keptIndex
  if (process.env.CRUCIBLE_SEMANTIC_RECALL !== '0') {
    try { keptIndex = await addSemanticTurns(older, currentMessage, keptIndex, lexOpts) }
    catch { /* best-effort: the lexical selection stands */ }
  }
  if (keptIndex.length === 0) return { recentTurns, recallBlock: '', recalledCount: 0, omitted: older.length }

  const sorted = [...keptIndex].sort((a, b) => a - b)
  const recallBlock = sorted.map(i => renderRecallLine(older[i], i, opts)).join('\n')
  return { recentTurns, recallBlock, recalledCount: sorted.length, omitted: older.length - sorted.length }
}

/** True when real (ONNX) semantic embeddings are active — used by benches to assert synonymy
 *  recall only when the neural model is present (the hash fallback is lexical-equivalent). */
export function semanticRecallActive(): boolean {
  return process.env.CRUCIBLE_SEMANTIC_RECALL !== '0' && isOnnxAvailable()
}
