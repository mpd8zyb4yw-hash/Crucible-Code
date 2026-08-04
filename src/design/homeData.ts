// ── Home derivations — pure, testable, no I/O ──────────────────────────────────
// `useHomeFeeds` (homeFeeds.ts) owns the network; this file owns the arithmetic.
// The split matters: these are the only places Home computes a claim rather than
// relaying one, so they are exactly what needs to be unit-testable without a server.
//
// Nothing here invents a number. `longestFreeBlock` is exact interval arithmetic over
// the real event list — the calendar card is allowed to state it flatly because a
// deterministic solver computed it, not a model.

import type { GooglePreview } from '../ConnectionWidgets'
import type { AutomationLite, DigestEntry } from './homeFeeds'

export interface MailSlice {
  /** Messages the deterministic verifier flagged. NOT an unread count. */
  needYou: number
  topSender: string | null
  topSubject: string | null
  /** Real reason strings from importance.ts — never our own prose. */
  topReasons: string[]
}

export interface CalendarSlice {
  nextTitle: string | null
  nextStart: number | null
  longestFree: { start: number; end: number } | null
  clearRestOfDay: boolean
}

export interface WatchSlice {
  total: number
  quiet: number
  moved: Array<{ name: string; summary: string; at: number }>
  /**
   * Watches that disabled themselves after 3 consecutive failures. Surfaced separately
   * and never folded into `quiet`: silence must not be mistakable for "nothing changed".
   */
  selfDisabled: Array<{ name: string }>
}

/**
 * Longest free block between `now` and end of day. Merges overlapping busy intervals,
 * then takes the widest gap. A gap under 30 minutes is not worth calling a free block.
 */
export function longestFreeBlock(
  events: Array<{ start: number; end: number }>, now: number, dayEnd: number,
): { start: number; end: number } | null {
  const busy = events
    .map(e => ({ start: Math.max(e.start, now), end: Math.min(e.end, dayEnd) }))
    .filter(e => e.end > e.start)
    .sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const b of busy) {
    const last = merged[merged.length - 1]
    if (last && b.start <= last.end) last.end = Math.max(last.end, b.end)
    else merged.push({ ...b })
  }
  let best: { start: number; end: number } | null = null
  let cursor = now
  for (const b of merged) {
    if (b.start > cursor && (!best || b.start - cursor > best.end - best.start)) best = { start: cursor, end: b.start }
    cursor = Math.max(cursor, b.end)
  }
  if (dayEnd > cursor && (!best || dayEnd - cursor > best.end - best.start)) best = { start: cursor, end: dayEnd }
  return best && best.end - best.start >= 30 * 60_000 ? best : null
}

/** Null only when Gmail is not connected — an EMPTY inbox still returns a slice. */
export function deriveMail(google: GooglePreview | null): MailSlice | null {
  if (!google?.gmail) return null
  const important = google.gmail.filter(m => m.important)
  const top = important[0] ?? null
  return {
    needYou: important.length,
    topSender: top?.from ?? null,
    topSubject: top?.subject ?? null,
    topReasons: top?.reasons ?? [],
  }
}

/** Null only when Calendar is not connected — an EMPTY day still returns a slice. */
export function deriveCalendar(google: GooglePreview | null, now = Date.now()): CalendarSlice | null {
  if (!google?.calendar) return null
  const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999)
  const timed = google.calendar
    .filter(e => !e.allDay)
    .map(e => ({ title: e.title, start: Date.parse(e.start), end: Date.parse(e.end) }))
    .filter(e => Number.isFinite(e.start) && Number.isFinite(e.end))
    .sort((a, b) => a.start - b.start)
  const upcoming = timed.filter(e => e.end > now)
  const next = upcoming[0] ?? null
  return {
    nextTitle: next?.title ?? null,
    nextStart: next?.start ?? null,
    longestFree: longestFreeBlock(upcoming, now, dayEnd.getTime()),
    clearRestOfDay: upcoming.length === 0,
  }
}

export function deriveWatch(automations: AutomationLite[], digest: DigestEntry[], now = Date.now()): WatchSlice {
  // Read the engine's own auto-disable state rather than inferring it.
  const selfDisabled = automations
    .filter(a => !a.enabled && (a.consecutiveFailures ?? 0) >= 3)
    .map(a => ({ name: a.name }))
  const since = now - 24 * 3600_000
  const moved = digest
    .filter(e => e.status === 'ok' && e.ts >= since && !!e.summary)
    .slice(0, 3)
    .map(e => ({ name: e.name, summary: e.summary, at: e.ts }))
  return {
    total: automations.length,
    quiet: Math.max(0, automations.length - moved.length - selfDisabled.length),
    moved,
    selfDisabled,
  }
}
