// ── Home data: what the cards are actually allowed to say ──────────────────────
// Every field here comes from a real endpoint. The handoff is explicit (§4.1): home
// content is real and earned, and "if there is nothing real to show, show fewer cards
// — never filler." So each slice is nullable, and null means the card does not render
// at all rather than rendering a placeholder.
//
// Sources, all pre-existing:
//   /api/connections/google/preview  → inbox with a DETERMINISTIC importance verdict
//                                      (importance.ts) and today's calendar events
//   /api/automations                 → watches: cadence, last runs, consecutiveFailures
//   /api/automations/digest          → recent run results
//
// Nothing in this file invents a number. The one computed value — the longest free
// block — is exact interval arithmetic over the real event list, not an estimate.

import { API_BASE, apiFetch } from '../api'

export interface MailSlice {
  /** Messages the deterministic verifier said actually need the user. Not unread count. */
  needYou: number
  /** The single most important sender, if there is one. */
  topSender: string | null
  topSubject: string | null
  /** Why the verifier flagged it — real reason strings, not our prose. */
  topReasons: string[]
}

export interface CalendarSlice {
  nextTitle: string | null
  nextStart: number | null
  /** Exact interval arithmetic over the day's events. Null when the day is fully free. */
  longestFree: { start: number; end: number } | null
  /** True when there is genuinely nothing else scheduled today. */
  clearRestOfDay: boolean
}

export interface WatchSlice {
  total: number
  quiet: number
  /** Watches that changed on their most recent run. */
  moved: Array<{ name: string; summary: string; at: number }>
  /**
   * Watches that disabled themselves after 3 consecutive failures. Silence must never
   * be mistakable for "nothing changed" (§5.5.4), so this is surfaced as loudly as a
   * change, never folded into `quiet`.
   */
  selfDisabled: Array<{ name: string }>
}

export interface HomeData {
  mail: MailSlice | null
  calendar: CalendarSlice | null
  watch: WatchSlice | null
  /** True once at least one fetch resolved, so the surface can tell empty from pending. */
  loaded: boolean
}

export const EMPTY_HOME: HomeData = { mail: null, calendar: null, watch: null, loaded: false }

interface GPreviewMsg { id: string; from: string; subject: string; date: string; unread: boolean; important: boolean; reasons: string[] }
interface GPreviewEvent { title: string; start: string; end: string; allDay: boolean }
interface RunRec { ts: number; status: 'ok' | 'failed'; summary: string; ms: number }
interface Automation {
  id: string; name: string; enabled: boolean
  lastRuns: RunRec[]; consecutiveFailures: number; nextRun: number | null
}
interface DigestEntry extends RunRec { automationId: string; name: string }

/**
 * Longest free block between now and end of day, from the real event list.
 * Deterministic: merges overlapping busy intervals, then takes the widest gap.
 */
export function longestFreeBlock(events: Array<{ start: number; end: number }>, now: number, dayEnd: number): { start: number; end: number } | null {
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
  // A "free block" shorter than 30 minutes is not worth claiming as one.
  return best && best.end - best.start >= 30 * 60_000 ? best : null
}

export async function fetchHomeData(signal?: AbortSignal): Promise<HomeData> {
  const out: HomeData = { mail: null, calendar: null, watch: null, loaded: true }

  // Each source degrades independently: a missing Google scope must not blank the
  // watch card, and vice versa.
  await Promise.all([
    (async () => {
      try {
        const r = await apiFetch(`${API_BASE}/api/connections/google/preview`, { credentials: 'include', signal })
        if (!r.ok) return
        const j = await r.json() as { gmail: GPreviewMsg[] | null; calendar: GPreviewEvent[] | null }

        if (j.gmail) {
          const important = j.gmail.filter(m => m.important)
          const top = important[0] ?? null
          out.mail = {
            needYou: important.length,
            topSender: top?.from ?? null,
            topSubject: top?.subject ?? null,
            topReasons: top?.reasons ?? [],
          }
        }

        if (j.calendar) {
          const now = Date.now()
          const dayEnd = new Date(); dayEnd.setHours(23, 59, 59, 999)
          const timed = j.calendar
            .filter(e => !e.allDay)
            .map(e => ({ title: e.title, start: Date.parse(e.start), end: Date.parse(e.end) }))
            .filter(e => Number.isFinite(e.start) && Number.isFinite(e.end))
            .sort((a, b) => a.start - b.start)
          const upcoming = timed.filter(e => e.end > now)
          const next = upcoming[0] ?? null
          out.calendar = {
            nextTitle: next?.title ?? null,
            nextStart: next?.start ?? null,
            longestFree: longestFreeBlock(upcoming, now, dayEnd.getTime()),
            clearRestOfDay: upcoming.length === 0,
          }
        }
      } catch { /* not connected — the card simply does not render */ }
    })(),

    (async () => {
      try {
        const [ar, dr] = await Promise.all([
          apiFetch(`${API_BASE}/api/automations`, { credentials: 'include', signal }),
          apiFetch(`${API_BASE}/api/automations/digest`, { credentials: 'include', signal }),
        ])
        if (!ar.ok) return
        const autos = await ar.json() as Automation[] | { automations: Automation[] }
        const list = Array.isArray(autos) ? autos : (autos.automations ?? [])
        if (!list.length) return
        const digest = dr.ok ? (await dr.json() as DigestEntry[] | { entries: DigestEntry[] }) : []
        const entries = Array.isArray(digest) ? digest : (digest.entries ?? [])

        // Self-disabled: the engine auto-disables after 3 consecutive failures. Read
        // that state rather than inferring it, and never let it hide inside "quiet".
        const selfDisabled = list.filter(a => !a.enabled && a.consecutiveFailures >= 3).map(a => ({ name: a.name }))
        // "Moved" is the last 24h of successful runs that produced a summary. A change
        // is the only thing that earns attention; silence is the healthy state.
        const since = Date.now() - 24 * 3600_000
        const moved = entries
          .filter(e => e.status === 'ok' && e.ts >= since && !!e.summary)
          .slice(0, 3)
          .map(e => ({ name: e.name, summary: e.summary, at: e.ts }))
        out.watch = {
          total: list.length,
          quiet: Math.max(0, list.length - moved.length - selfDisabled.length),
          moved,
          selfDisabled,
        }
      } catch { /* no automations service — the card does not render */ }
    })(),
  ])

  return out
}
