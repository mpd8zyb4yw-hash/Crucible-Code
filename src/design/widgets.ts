// ── The home widget registry ───────────────────────────────────────────────────
// One source of truth for what can appear on Home, replacing the two systems that
// existed before (MissionWidgets' `WIDGET_META` and the phase-1 `homeLayout.ts`
// pinned/suggested model). Deliberately a PLAIN DATA MODULE with no React import:
// the widget bodies live in a switch inside HomeBoard, which keeps every body
// readable in one place and lets this file be imported by tests and by the
// storage migration without pulling in a component tree.
//
// Ordering law (from MissionWidgets, and now the only one): the user's array IS the
// order. Nothing re-ranks it. Phase 1 shipped an adaptive pinned/suggested ranking;
// the user chose the explicit model instead, so `rankSuggested` and friends are gone.

import type { Domain } from './glass'

export type WidgetId = 'inbox' | 'calendar' | 'github' | 'watch' | 'digest' | 'runs'

/** Where a widget's header action goes when tapped. */
export type WidgetRoute = 'automations' | 'connections' | 'agents'

export interface WidgetDef {
  id: WidgetId
  title: string
  /** Glass tint — encodes WHICH domain, never decoration. */
  domain: Domain
  /** Drops a grounded prompt into the composer. Prefill, NEVER auto-send. */
  ask?: { label: string; prompt: string }
  /** Optional header action, e.g. Watch → the full automations view. */
  action?: { label: string; route: WidgetRoute }
}

export const WIDGETS: Record<WidgetId, WidgetDef> = {
  inbox: {
    id: 'inbox', title: 'Inbox', domain: 'mail',
    ask: { label: 'Summarize', prompt: 'Summarize any inbox email from the last day that needs a reply.' },
  },
  calendar: {
    id: 'calendar', title: 'Calendar', domain: 'time',
    ask: { label: 'What’s ahead', prompt: 'Summarize today’s calendar and what’s coming up over the next few days.' },
  },
  github: {
    id: 'github', title: 'Open PRs', domain: 'code',
    ask: { label: 'PR status', prompt: 'List my open GitHub PRs and flag any that look stalled or are waiting on review.' },
  },
  watch: {
    id: 'watch', title: 'Watch', domain: 'watch',
    ask: { label: 'What moved', prompt: 'Which of my watches changed most recently, and what exactly changed?' },
    action: { label: 'All watches', route: 'automations' },
  },
  digest: {
    id: 'digest', title: 'Recent runs', domain: 'watch',
    action: { label: 'All watches', route: 'automations' },
  },
  runs: {
    id: 'runs', title: 'Agents', domain: 'research',
    action: { label: 'Open roster', route: 'agents' },
  },
}

/** Default order for a fresh install — a working home, not an empty grid. */
export const ALL_WIDGETS: WidgetId[] = ['runs', 'inbox', 'calendar', 'watch', 'digest', 'github']

export function isWidgetId(v: unknown): v is WidgetId {
  return typeof v === 'string' && (ALL_WIDGETS as string[]).includes(v)
}

// ── Layout storage ─────────────────────────────────────────────────────────────
// `WidgetId[]` — the same shape MissionWidgets used, just a wider union.

const KEY = 'crucible_home_widgets_v2'
const LEGACY_BOARD = 'crucible_mc_widgets'          // MissionWidgets' order
const LEGACY_HOME = 'crucible_home_arrangement_v1'  // phase-1 pinned/hidden/sizes

/** Phase-1 `CardKind` → `WidgetId`. Only `hidden` survives; pinned and sizes do not. */
const LEGACY_KIND_MAP: Record<string, WidgetId> = {
  mail: 'inbox', calendar: 'calendar', watch: 'watch', runs: 'runs', research: 'runs',
}

/**
 * Read the board order, migrating the two legacy keys exactly once.
 *
 * Both legacy stores are pure view preferences, so a clean break would cost nothing
 * architecturally — but a user who curated a Mission Control board and then found Home
 * reset would reasonably read that as data loss. The migration is cheap insurance.
 *
 * Invariant: this NEVER returns an empty array for a user who had a non-empty board,
 * and never returns an unknown id (a stale or hand-edited key must not reach the
 * render loop).
 */
export function loadWidgetLayout(): WidgetId[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      const ids = Array.isArray(parsed) ? parsed.filter(isWidgetId) : []
      // An explicitly emptied board is a legitimate user choice, so an empty array
      // here is respected — only a MISSING key falls back to the default.
      return ids
    }

    // ── one-time migration ──
    let order: WidgetId[] = []
    try {
      const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_BOARD) ?? 'null')
      if (Array.isArray(legacy)) order = legacy.filter(isWidgetId)
    } catch { /* unreadable legacy board — fall through to defaults */ }

    let hidden: WidgetId[] = []
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_HOME) ?? 'null') as { hidden?: string[] } | null
      hidden = (legacy?.hidden ?? []).map(k => LEGACY_KIND_MAP[k]).filter(isWidgetId)
    } catch { /* unreadable legacy arrangement — nothing hidden */ }

    // Append any id the legacy board never knew about, so widening the union can
    // never silently drop a widget the user has not seen yet.
    const merged = [...order, ...ALL_WIDGETS.filter(id => !order.includes(id))]
    const result = merged.filter(id => !hidden.includes(id))

    saveWidgetLayout(result)
    try { localStorage.removeItem(LEGACY_BOARD); localStorage.removeItem(LEGACY_HOME) } catch { /* best effort */ }
    return result
  } catch {
    return [...ALL_WIDGETS]
  }
}

export function saveWidgetLayout(ids: WidgetId[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* view preference only */ }
}
