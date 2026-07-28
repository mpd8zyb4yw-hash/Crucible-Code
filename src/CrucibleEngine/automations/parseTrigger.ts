// ── "every weekday at 8am" → Trigger (cont.119) ───────────────────────────────
//
// The automations subsystem has been complete for weeks — triggers, runner, digest, REST CRUD —
// and the agent could not reach ANY of it. There was no scheduling tool at all: the 46 registered
// tools included calendar_create (a Google Calendar event, which does nothing) but nothing that
// touched .crucible/automations.json. "Every morning summarise my inbox" produced a promise and
// no schedule.
//
// A tool needs a Trigger, and a model asked to emit `{kind:'weekly',day:1,time:'08:00'}` from
// prose will sometimes emit `day:'Monday'` or `time:'8am'`. So the parse happens HERE,
// deterministically, and the tool takes the user's own words. Pure and injectable-clock, so it is
// testable without freezing time.

import type { Trigger } from './store'

export interface ParsedTrigger {
  trigger: Trigger
  /** Echoed back to the user before anything is created — a schedule they did not intend is
   *  worse than no schedule, and only they can catch it. */
  description: string
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
}

/** "8am" | "8:30 pm" | "17:00" | "noon" | "midnight" → "HH:MM", or null. */
export function parseTime(s: string): string | null {
  const t = s.toLowerCase().trim()
  if (/\bnoon|midday\b/.test(t)) return '12:00'
  if (/\bmidnight\b/.test(t)) return '00:00'
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ampm = m[3]
  if (h > 23 || min > 59) return null
  // A bare hour with no am/pm and no colon is ambiguous ("at 8"). Treat 1-7 as PM, because
  // "remind me at 6" overwhelmingly means the evening, and 8-12 as AM.
  if (ampm === 'pm' && h < 12) h += 12
  else if (ampm === 'am' && h === 12) h = 0
  else if (!ampm && !m[2] && h >= 1 && h <= 7) h += 12
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/**
 * Parse a recurrence/one-shot phrase. `now` is injected so tests do not depend on the clock.
 * Returns null when nothing schedule-shaped is present — the caller must then ASK rather than
 * invent a cadence, because a wrong schedule runs forever without being noticed.
 */
export function parseTrigger(text: string, now: number): ParsedTrigger | null {
  const s = text.toLowerCase()

  // ── Relative one-shot: "in 20 minutes", "in 2 hours", "in 3 days" ──
  const rel = s.match(/\bin\s+(a|an|\d+)\s*(minute|min|hour|hr|day|week)s?\b/)
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : Number(rel[1])
    const unit = rel[2]
    const ms = unit.startsWith('min') ? 60_000 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('d') ? 86_400_000 : 604_800_000
    const at = now + n * ms
    return { trigger: { kind: 'once', at }, description: `once, ${new Date(at).toLocaleString()}` }
  }

  const time = parseTime(s)

  // ── Weekdays: "every weekday", "on weekdays", "monday to friday" ──
  if (/\b(week ?days?|mon(day)?\s*(-|to|through|–)\s*fri(day)?)\b/.test(s) && !/\bweekends?\b/.test(s)) {
    const t = time ?? '09:00'
    return { trigger: { kind: 'weekdays', time: t }, description: `every weekday at ${t}` }
  }

  // ── Weekly: "every monday", "on tuesdays", "weekly on friday" ──
  const dayHit = Object.keys(DAY_NAMES).find(d => new RegExp(`\\b${d}s?\\b`).test(s))
  if (dayHit) {
    const t = time ?? '09:00'
    const day = DAY_NAMES[dayHit]
    const label = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day]
    return { trigger: { kind: 'weekly', day, time: t }, description: `every ${label} at ${t}` }
  }

  // ── Interval: "every 30 minutes", "every 2 hours", "hourly" ──
  const every = s.match(/\bevery\s+(\d+)\s*(minute|min|hour|hr)s?\b/)
  if (every) {
    const n = Number(every[1])
    const minutes = every[2].startsWith('min') ? n : n * 60
    if (minutes >= 1 && minutes <= 7 * 24 * 60) {
      return { trigger: { kind: 'interval', minutes }, description: minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m` }
    }
  }
  if (/\bhourly|every hour\b/.test(s)) return { trigger: { kind: 'interval', minutes: 60 }, description: 'every 1h' }

  // ── Daily: "every day at 8am", "daily", "every morning/evening" ──
  if (/\b(every ?day|daily|each day|every morning|every evening|every night|each morning)\b/.test(s)) {
    const t = time ?? (/\b(evening|night)\b/.test(s) ? '19:00' : '08:00')
    return { trigger: { kind: 'daily', time: t }, description: `daily at ${t}` }
  }

  // ── One-shot at a clock time: "tomorrow at 9am", "at 5pm" ──
  if (time) {
    const [h, mi] = time.split(':').map(Number)
    const d = new Date(now)
    d.setHours(h, mi, 0, 0)
    if (/\btomorrow\b/.test(s)) d.setDate(d.getDate() + 1)
    else if (d.getTime() <= now) d.setDate(d.getDate() + 1)   // that time has passed today
    return { trigger: { kind: 'once', at: d.getTime() }, description: `once, ${d.toLocaleString()}` }
  }

  return null
}
