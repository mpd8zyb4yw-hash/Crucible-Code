// ── Home arrangement: the law of pinned vs suggested ───────────────────────────
// DESIGN_HANDOFF §4.1.1, stated as one rule that the rest of this file enforces:
//
//   USER INTENT IS STICKY. SYSTEM SUGGESTION IS FLUID.
//   Anything the user placed stays exactly where they put it, forever, until they
//   move it. Everything else is free to reorder as relevance changes.
//
// Two mechanical consequences are easy to get wrong and are therefore encoded here
// rather than left to the component:
//
//  1. Pinned cards are ordered by the user's stored order and NEVER by score. No
//     signal — not urgency, not liveness — may reorder the pinned region.
//  2. Ranking is a pure function of a snapshot. The component takes a snapshot on
//     open / pull-to-refresh / real state change and holds it; nothing re-ranks under
//     a moving finger. A surface that reshuffles as you read it feels haunted.
//
// Hiding is permanent per card TYPE and always restorable (§4.1.1) — hide is not
// dismiss, and a hidden Calendar must not come back next week because it got relevant.

export type CardKind = 'research' | 'mail' | 'calendar' | 'watch' | 'runs'

/** S = 1×1, M = 2×1, L = 2×2 on the 2-column phone grid. */
export type CardSize = 'S' | 'M' | 'L'

export interface HomeArrangement {
  /** User-pinned card kinds, in the user's own order. Never re-sorted by score. */
  pinned: CardKind[]
  /** Permanently hidden card types. Restorable from settings, never auto-restored. */
  hidden: CardKind[]
  /** Per-card size overrides. */
  sizes: Partial<Record<CardKind, CardSize>>
}

/**
 * First run ships a sensible default arrangement, not an empty grid asking to be
 * configured (§4.1.1). The user edits a working home; they do not assemble one.
 */
export const DEFAULT_ARRANGEMENT: HomeArrangement = {
  pinned: [],
  hidden: [],
  sizes: { research: 'M', mail: 'M', calendar: 'M', watch: 'M', runs: 'M' },
}

const KEY = 'crucible_home_arrangement_v1'
const ALL_KINDS: CardKind[] = ['research', 'mail', 'calendar', 'watch', 'runs']

function isKind(v: unknown): v is CardKind {
  return typeof v === 'string' && (ALL_KINDS as string[]).includes(v)
}

export function loadArrangement(): HomeArrangement {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_ARRANGEMENT
    const p = JSON.parse(raw) as Partial<HomeArrangement>
    return {
      // Filter through isKind so a stale or hand-edited value can never inject an
      // unknown card kind into the render loop.
      pinned: Array.isArray(p.pinned) ? p.pinned.filter(isKind) : [],
      hidden: Array.isArray(p.hidden) ? p.hidden.filter(isKind) : [],
      sizes: { ...DEFAULT_ARRANGEMENT.sizes, ...(p.sizes ?? {}) },
    }
  } catch { return DEFAULT_ARRANGEMENT }
}

export function saveArrangement(a: HomeArrangement): void {
  try { localStorage.setItem(KEY, JSON.stringify(a)) } catch { /* arrangement is a nicety, not state we can block on */ }
}

// ── Ranking ────────────────────────────────────────────────────────────────────
// Four signals, and the constraint that picked them: every one produces a TRUE
// one-line reason. A promotion the user cannot understand reads as randomness
// (§4.1.1), so a card that cannot explain itself cannot be promoted.
//
// Deliberately NOT included: behavioural profiling ("you open Mail every morning").
// It ranks well and explains badly.

export interface RankInput {
  kind: CardKind
  /** Something is waiting on the user — the strongest signal. */
  obligation?: { count: number; reason: string }
  /** A run or watch changed state, or is live right now. */
  liveness?: { reason: string }
  /** The user asked about this recently, in their own words. */
  recency?: { reason: string }
  /** This card is characteristically useful at this hour. */
  timeOfDay?: { reason: string }
}

export interface Ranked {
  kind: CardKind
  score: number
  /** The single short line the card shows to explain its own promotion. */
  reason: string | null
}

/**
 * Pure and deterministic: same snapshot in, same order out. The caller decides WHEN
 * to take a snapshot; this function never decides for itself.
 */
export function rankSuggested(inputs: RankInput[]): Ranked[] {
  const scored = inputs.map(i => {
    let score = 0
    let reason: string | null = null
    // Order matters: the highest-weight signal that fired is the one that explains
    // the card, because that is the true reason it is where it is.
    if (i.obligation && i.obligation.count > 0) { score += 100 + Math.min(i.obligation.count, 20); reason = i.obligation.reason }
    if (i.liveness) { score += 60; reason = reason ?? i.liveness.reason }
    if (i.recency) { score += 30; reason = reason ?? i.recency.reason }
    if (i.timeOfDay) { score += 12; reason = reason ?? i.timeOfDay.reason }
    return { kind: i.kind, score, reason }
  })
  // Stable sort by score; ties keep their input order so the surface does not
  // shuffle between two equally-ranked snapshots.
  return scored
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => (b.s.score - a.s.score) || (a.idx - b.idx))
    .map(x => x.s)
}
