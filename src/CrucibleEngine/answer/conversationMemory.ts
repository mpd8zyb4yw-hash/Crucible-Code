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
// Pure and deterministic: no model calls, no network. Same inputs → same window, every time.

import type { ConvTurn } from '../agent/fmReact'

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

  const lines = sel.keptIndex.map(i => {
    const t = older[i]
    const u = clip(t.user, opts.perTurnClip ?? DEFAULT_CLIP)
    const a = clip(t.assistant, 300)
    return `- (turn ${i + 1}) User: ${u}${a ? `\n  You replied: ${a}` : ''}`
  })
  const recallBlock = lines.join('\n')
  return {
    recentTurns,
    recallBlock,
    recalledCount: sel.keptIndex.length,
    omitted: older.length - sel.keptIndex.length,
  }
}
