import { addDays, dayIn, daysBetweenDays, relativeDay, timeLabel } from './clock.js'
import type { CalEvent } from './widgets.js'

/**
 * WHAT IS STILL AHEAD OF HIM. ONE DEFINITION, FOR EVERY SURFACE.
 *
 * This file exists because there were two, and only one of them was right.
 *
 * `panes.ts#nextEvent` filtered correctly — an all-day event stays current
 * through the end of its own day in HIS zone, a timed event until its start
 * passes. `deck.ts` filtered `e.allDay ? true`, which is not a filter: it means
 * every all-day event ever synced is "ahead" forever. His calendar is almost
 * entirely all-day events, so on 18 August his home screen led with
 * "Restaurant with Odelia at 11 AM" — 10 August — and said `8 ahead`, while the
 * line directly underneath, built from the other filter, correctly said
 * "Nothing on today's agenda. Hiking with Mauro is tomorrow."
 *
 * Both were projections of the same `CalEvent[]`. Nothing was stale, nothing was
 * cached, nothing had failed to sync. Two functions simply disagreed about what
 * "ahead" means, and the wrong one owned the biggest object on the screen.
 *
 * So: nothing below re-derives currency. A surface asks this module and renders
 * the answer. The rule the whole file is built on —
 *
 *     an event is current until it is OVER, not until it has STARTED
 *
 * — is why `nextUp` can name the thing he is in the middle of, which is the one
 * answer "what's next" was never able to give.
 */

/** The last day an all-day event covers. Google's all-day `end` is EXCLUSIVE. */
function lastDayOf(e: Pick<CalEvent, 'start' | 'end' | 'allDay'>): string {
  const start = e.start.slice(0, 10)
  if (!e.end) return start
  const end = e.end.slice(0, 10)
  // A one-day event is stored 12th → 13th. Anything that does not parse as a
  // later date is treated as the start day rather than silently extending it.
  const last = addDays(end, -1)
  return last >= start ? last : start
}

/**
 * Has this event finished?
 *
 * Timed events end when their end passes — or, with no end recorded, when their
 * start does, because an instant we cannot bound is not one we may keep alive by
 * guessing a duration.
 */
export function isOver(e: CalEvent, now: Date, tz?: string): boolean {
  if (e.allDay) return daysBetweenDays(dayIn(now, tz), lastDayOf(e)) < 0
  const t = Date.parse(e.end ?? e.start)
  if (!Number.isFinite(t)) return false
  return t < now.getTime()
}

/** Is it happening right now? An all-day event counts on each of its own days. */
export function isRunning(e: CalEvent, now: Date, tz?: string): boolean {
  if (isOver(e, now, tz)) return false
  if (e.allDay) return daysBetweenDays(dayIn(now, tz), e.start.slice(0, 10)) <= 0
  return Date.parse(e.start) <= now.getTime()
}

/** Does it fall on the day he is standing in? */
export function isToday(e: CalEvent, now: Date, tz?: string): boolean {
  const today = dayIn(now, tz)
  if (e.allDay) return e.start.slice(0, 10) <= today && today <= lastDayOf(e)
  return dayIn(new Date(e.start), tz) === today
}

/**
 * TWO GOOGLE EVENTS THAT ARE ONE EVENT.
 *
 * His calendar holds `Polenta in Avano` and `Polenta in Avano with rafaella`,
 * both all-day, both 12–14 August, both with their own `eventId`. Google will
 * never merge them and neither surface can tell them apart, so the calendar
 * simply shows the same commitment twice.
 *
 * The test is deliberately narrow: identical span, identical all-day flag, and
 * one title a prefix of the other. Two genuinely different things at the same
 * time do not satisfy it — that is a clash, and a clash is a fact this app is
 * built to make visible rather than to tidy away. The longer title survives
 * because it is the one carrying the extra fact.
 */
export function dedupeEvents(events: CalEvent[]): CalEvent[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  const out: CalEvent[] = []
  for (const e of events) {
    const i = out.findIndex(
      (k) =>
        !!k.allDay === !!e.allDay &&
        k.start === e.start &&
        (k.end ?? '') === (e.end ?? '') &&
        (norm(k.title).startsWith(norm(e.title)) || norm(e.title).startsWith(norm(k.title)))
    )
    if (i === -1) { out.push(e); continue }
    if (e.title.trim().length > out[i].title.trim().length) out[i] = e
  }
  return out
}

/**
 * Everything not yet over, deduped, earliest first.
 *
 * THE ONLY ANSWER TO "WHAT IS AHEAD". Home's count, Home's hero, the relevance
 * slot and the domain context all read this list, so it is not possible for one
 * of them to know about an event another does not.
 */
export function upcoming(events: CalEvent[], now: Date, tz?: string): CalEvent[] {
  return dedupeEvents(events)
    .filter((e) => !isOver(e, now, tz))
    .sort((a, b) => rank(a, b, tz))
}

/** Everything already finished, most recent first. Depth and history only. */
export function past(events: CalEvent[], now: Date, tz?: string): CalEvent[] {
  return dedupeEvents(events)
    .filter((e) => isOver(e, now, tz))
    .sort((a, b) => b.start.localeCompare(a.start))
}

/**
 * Chronological, except that WITHIN ONE DAY a timed event outranks an all-day
 * one.
 *
 * An all-day event sorts before every timed event on its own date, so on any day
 * with a birthday or a holiday on it the hero was "Ferragosto · all day" and the
 * meeting in forty minutes was a block in the strip. All-day events are not
 * demoted out of the day — they have their own band — they simply lose the hero
 * to something that can actually be about to happen.
 */
function rank(a: CalEvent, b: CalEvent, tz?: string): number {
  const dayA = a.allDay ? a.start.slice(0, 10) : dayIn(new Date(a.start), tz)
  const dayB = b.allDay ? b.start.slice(0, 10) : dayIn(new Date(b.start), tz)
  if (dayA !== dayB) return dayA < dayB ? -1 : 1
  if (!!a.allDay !== !!b.allDay) return a.allDay ? 1 : -1
  return a.start.localeCompare(b.start)
}

/**
 * The single event a surface should lead with.
 *
 * What he is IN outranks what is next, which is the answer the old "next event"
 * could not give: `start >= now` drops a meeting the moment it begins, so the
 * hour you are most likely to look at your phone is the hour the card stops
 * mentioning where you are supposed to be.
 */
export function nextUp(events: CalEvent[], now: Date, tz?: string): CalEvent | null {
  const ahead = upcoming(events, now, tz)
  return ahead.find((e) => !e.allDay && isRunning(e, now, tz)) ?? ahead[0] ?? null
}

/**
 * The lead column for a row: a clock time for today, a day name otherwise.
 *
 * This is the §0 ambient-information exemption applied per row rather than per
 * widget. A date on today's 09:00 meeting is noise — the widget is about today.
 * A date on Sunday's party is the entire point of showing it.
 */
export function leadFor(e: CalEvent, now: Date, tz?: string): string {
  const today = isToday(e, now, tz)
  if (e.allDay) return today ? 'today' : relativeDay(e.start.slice(0, 10), now, tz)
  const clock = timeLabel(new Date(e.start), tz)
  return today ? clock : `${relativeDay(dayIn(new Date(e.start), tz), now, tz)} ${clock}`
}

/**
 * "in 40 min", "now", "tomorrow" — how far off it is, in the unit that suits it.
 *
 * An all-day event has no clock, so it can never be "in 40 minutes"; the most it
 * can honestly be is a day away. Deriving an hour for it in order to count down
 * to it is the prose-time mistake in another costume.
 */
export function relFor(e: CalEvent, now: Date, tz?: string): string {
  if (e.allDay) {
    const d = daysBetweenDays(dayIn(now, tz), e.start.slice(0, 10))
    if (d <= 0) return 'today'
    return relativeDay(e.start.slice(0, 10), now, tz)
  }
  const mins = Math.round((Date.parse(e.start) - now.getTime()) / 60_000)
  if (!Number.isFinite(mins)) return ''
  if (mins <= 0) return isRunning(e, now, tz) ? 'now' : ''
  if (mins < 60) return `in ${mins} min`
  const h = Math.round(mins / 60)
  if (h < 24) return `in ${h}h`
  return relativeDay(dayIn(new Date(e.start), tz), now, tz)
}
