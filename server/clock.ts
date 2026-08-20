/**
 * EVERY DATE EXPRESSION IN THIS APP, IN ONE FILE.
 *
 * Not a utility module. This is a policy: NO OTHER FILE MAY DO DATE ARITHMETIC,
 * and in particular no language model may. That rule exists because the same
 * bug has now appeared in five different costumes.
 *
 *   · The Worker runs in UTC and he lives in Europe/Rome, so `new Date().getDay()`
 *     was two hours behind his own day for two hours out of every twenty-four —
 *     which is how his home screen came to be stamped 8/8/2026 at one in the
 *     morning on the 9th.
 *   · `panes.ts` had a `dayLabel` that read `getUTCDay()` off a local date
 *     string, so a Sunday event in Rome was labelled Saturday.
 *   · `shortWhen` divided a millisecond difference by 86_400_000 and called the
 *     result "days ago", which is only true when nobody changes their clocks.
 *   · The synthesis prompt asked a language model for `dateLabel`, and the model
 *     answered with whatever weekday it believed 2026-08-11 to be. A model has no
 *     calendar. It has a plausible-sounding guess, and the app printed it as the
 *     heading of his day.
 *   · Every "tomorrow", "Wednesday" and "in 3 days" in a card came out of the
 *     same guess, so a dinner on the 12th could be announced as "Thursday".
 *
 * The through-line is that a date is arithmetic on a calendar in a named zone,
 * and every mechanism that is not that — a runtime default, a subtraction of
 * epoch milliseconds, a model's recollection — is wrong in a way that looks
 * right most of the time.
 *
 * THREE RULES HOLD THROUGHOUT.
 *
 *   - THE ZONE IS ALWAYS A PARAMETER. Nothing here reads the runtime's zone
 *     except as a last-resort fallback, and every function that could differ
 *     between the Mac and the edge takes `tz` explicitly. A missing zone is a
 *     visible degradation, not a silent substitution.
 *
 *   - CALENDAR ARITHMETIC HAPPENS ON `YYYY-MM-DD`, NOT ON INSTANTS. Adding a day
 *     to an instant is ambiguous twice a year and wrong across a month boundary
 *     if you do it by adding 86.4 million milliseconds. Adding a day to a date
 *     is exact. So the date functions convert to Y-M-D in his zone first, do
 *     integer arithmetic there, and convert back only to render.
 *
 *   - EVERY PHRASE A CARD CAN CONTAIN HAS A FUNCTION HERE. "tomorrow", "in 40
 *     minutes", "Wednesday the 12th", "leave about half four", "this week" —
 *     each one is a function, so a card cannot invent a sixth phrasing and a
 *     model cannot be asked to produce one. See `dateVocabulary`, which is what
 *     the prompt is given INSTEAD of the freedom to work it out.
 */

// ── The primitive: what calendar is it, where he is ──────────────────────────

/**
 * The calendar day an instant falls on, IN HIS ZONE, as `YYYY-MM-DD`.
 *
 * One expression, used by everything that has to decide what day something is
 * on, so the header, the "next event" filter and the snapshot staleness check
 * cannot answer it three different ways. `en-CA` is chosen only because it
 * formats as ISO; nothing here is locale-dependent.
 */
export function dayIn(t: Date, tz?: string): string {
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(t)
    } catch {
      // An unknown zone is worse than no zone: fall through to the runtime's.
    }
  }
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** Is this a zone `Intl` will actually accept? */
export function isZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * An instant broken into the fields his wall clock shows.
 *
 * Read out of `Intl.formatToParts` rather than from any `getX()` method, because
 * every `getX()` answers in the runtime's zone and there is no `getHoursIn(tz)`.
 * `weekday` is 0=Sunday, matching `Date.getDay()`'s convention so that code
 * moving off `getDay()` does not also have to change its comparisons.
 */
export interface Parts {
  year: number
  /** 1..12. */
  month: number
  /** 1..31. */
  day: number
  /** 0=Sunday … 6=Saturday, in his zone. */
  weekday: number
  hour: number
  minute: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

export function partsIn(t: Date, tz?: string): Parts {
  const fmt = safeFormat(
    { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false },
    tz
  )
  if (!fmt) {
    return {
      year: t.getFullYear(),
      month: t.getMonth() + 1,
      day: t.getDate(),
      weekday: t.getDay(),
      hour: t.getHours(),
      minute: t.getMinutes(),
    }
  }
  const got: Record<string, string> = {}
  for (const p of fmt.formatToParts(t)) got[p.type] = p.value
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    weekday: WEEKDAY_INDEX[got.weekday ?? ''] ?? t.getDay(),
    // `hour12: false` still renders midnight as "24" in some ICU versions.
    hour: Number(got.hour) % 24,
    minute: Number(got.minute),
  }
}

function safeFormat(opts: Intl.DateTimeFormatOptions, tz?: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-GB', tz ? { ...opts, timeZone: tz } : opts)
  } catch {
    try {
      return new Intl.DateTimeFormat('en-GB', opts)
    } catch {
      return null
    }
  }
}

// ── Calendar arithmetic, done on dates rather than on instants ───────────────

/**
 * `YYYY-MM-DD` as three integers. Rejects anything that is not one rather than
 * producing `NaN` that then propagates silently into a rendered sentence.
 */
export function ymdParts(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/**
 * The instant at NOON UTC on a calendar date.
 *
 * Noon, not midnight, and this is the single most load-bearing choice in the
 * file. A date-only value parsed as UTC midnight is the PREVIOUS EVENING for
 * everyone west of Greenwich and the same morning for everyone east of it, so
 * `new Date('2026-08-12')` renders as 11 August in New York. Anchoring at noon
 * leaves a twelve-hour margin either side, which is more than any real zone
 * offset, so the date renders as itself everywhere on earth.
 *
 * This is a rendering and comparison anchor ONLY. It is never a time of day and
 * must never be shown as one.
 */
export function ymdToNoonUtc(ymd: string): Date {
  const p = ymdParts(ymd)
  if (!p) return new Date(NaN)
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0))
}

/**
 * `n` calendar days after a date. Exact across months, years and leap years.
 *
 * Done with `Date.UTC`, which normalises out-of-range components properly:
 * `Date.UTC(2026, 11, 31 + 1)` is 1 January 2027 and `Date.UTC(2026, 1, 28 + 1)`
 * is 1 March 2026. That is the whole reason not to hand-roll month lengths.
 */
export function addDays(ymd: string, n: number): string {
  const p = ymdParts(ymd)
  if (!p) return ymd
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n, 12, 0, 0))
  return d.toISOString().slice(0, 10)
}

/** Whole calendar days from one date to another. Negative means `to` is earlier. */
export function daysBetweenDays(from: string, to: string): number {
  const a = ymdToNoonUtc(from).getTime()
  const b = ymdToNoonUtc(to).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN
  return Math.round((b - a) / 86_400_000)
}

/** Whole days from `from` to `to`, counted by HIS calendar rather than by 24h. */
export function daysBetween(from: Date, to: Date, tz?: string): number {
  return daysBetweenDays(dayIn(from, tz), dayIn(to, tz))
}

/**
 * The weekday of a calendar date, 0=Sunday.
 *
 * Computed off the noon-UTC anchor with `getUTCDay`, which is correct BECAUSE
 * the anchor is UTC — the mistake this replaces was calling `getUTCDay()` on a
 * date parsed at UTC midnight and then displaying it beside a local time.
 */
export function weekdayOf(ymd: string): number {
  const d = ymdToNoonUtc(ymd)
  return Number.isFinite(d.getTime()) ? d.getUTCDay() : NaN
}

// ── Words ────────────────────────────────────────────────────────────────────

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Weekday names are a FIXED TABLE, not `toLocaleDateString`.
 *
 * Two reasons, and the second is the one that bit. The obvious one is that
 * `toLocaleDateString(undefined, …)` uses the RUNTIME's locale, so the same
 * stored world produced English on the Mac and English-with-different-ordering
 * on the edge. The subtler one is that a table is TESTABLE: `weekdayName` for
 * 2026-08-11 is asserted to be exactly "Tuesday" in `scripts/dates.mjs`, which
 * is not something you can assert about an ICU version.
 *
 * Writing to him in his own language is a real requirement and it is handled
 * one level up: the model does the WORDING, and it is handed these names as
 * facts to translate rather than dates to work out. See `dateVocabulary`.
 */
export function weekdayName(ymd: string, style: 'long' | 'short' = 'long'): string {
  const w = weekdayOf(ymd)
  if (!Number.isFinite(w)) return ''
  return (style === 'long' ? LONG_DAYS : SHORT_DAYS)[w]!
}

export function monthName(month: number, style: 'long' | 'short' = 'long'): string {
  const list = style === 'long' ? LONG_MONTHS : SHORT_MONTHS
  return list[month - 1] ?? ''
}

/**
 * A date written out: "Tuesday 11 August 2026", "Tue 11 Aug".
 *
 * `order` carries HIS convention — day-month or month-day — because that is a
 * fact about him rather than about the calendar, and getting it from a stored
 * preference is what lets an American in Italy read his own dates.
 */
export function dateLabel(
  ymd: string,
  opts: { weekday?: 'long' | 'short' | 'none'; month?: 'long' | 'short' | 'numeric'; year?: boolean; order?: 'dmy' | 'mdy' } = {}
): string {
  const p = ymdParts(ymd)
  if (!p) return ymd
  const style = opts.month ?? 'long'
  const monthPart = style === 'numeric' ? String(p.month) : monthName(p.month, style)
  const order = opts.order ?? 'dmy'
  const core =
    style === 'numeric'
      ? order === 'mdy'
        ? `${p.month}/${p.day}`
        : `${p.day}/${p.month}`
      : order === 'mdy'
        ? `${monthPart} ${p.day}`
        : `${p.day} ${monthPart}`
  const wd = opts.weekday && opts.weekday !== 'none' ? `${weekdayName(ymd, opts.weekday)} ` : ''
  const yr = opts.year ? ` ${p.year}` : ''
  return `${wd}${core}${yr}`
}

/**
 * How he would refer to a day, relative to today.
 *
 * Bounded deliberately. Within a day either side it is "today"/"tomorrow"/
 * "yesterday"; inside the coming week a bare weekday is unambiguous and is what
 * a person actually says; beyond that a weekday alone is a TRAP — "Wednesday"
 * said on the 11th about the 26th is read as the 12th — so it becomes a date.
 */
export function relativeDay(
  target: string,
  now: Date,
  tz?: string,
  opts: { order?: 'dmy' | 'mdy' } = {}
): string {
  const today = dayIn(now, tz)
  const delta = daysBetweenDays(today, target)
  if (!Number.isFinite(delta)) return target
  if (delta === 0) return 'today'
  if (delta === 1) return 'tomorrow'
  if (delta === -1) return 'yesterday'
  if (delta > 1 && delta <= 6) return weekdayName(target, 'long')
  if (delta < -1 && delta >= -6) return `last ${weekdayName(target, 'long')}`
  return dateLabel(target, { weekday: 'short', month: 'short', order: opts.order })
}

/**
 * A time of day on his clock, in his convention.
 *
 * Formatted from `partsIn` rather than from `toLocaleTimeString` so the string
 * is identical on both hosts and so 12-hour output is "4:30pm" rather than
 * whichever spacing and casing the platform's ICU data prefers this year.
 */
export function timeLabel(t: Date, tz?: string, opts: { hour12?: boolean } = {}): string {
  const p = partsIn(t, tz)
  if (!Number.isFinite(p.hour)) return ''
  const mm = String(p.minute).padStart(2, '0')
  if (!opts.hour12) return `${String(p.hour).padStart(2, '0')}:${mm}`
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12
  return `${h}:${mm}${p.hour < 12 ? 'am' : 'pm'}`
}

/**
 * When something is, as one phrase: "tomorrow at 18:00", "Tuesday, all day".
 *
 * The all-day branch is not a formatting nicety. An all-day event HAS no clock
 * time — Google holds it as a date — and every attempt to give it one has ended
 * up inventing an hour from either a title or a zone conversion. Here it simply
 * never gets one.
 */
export function whenLabel(
  iso: string,
  now: Date,
  tz?: string,
  opts: { allDay?: boolean; hour12?: boolean; order?: 'dmy' | 'mdy' } = {}
): string {
  if (opts.allDay) {
    const day = iso.slice(0, 10)
    return relativeDay(day, now, tz, { order: opts.order })
  }
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return iso
  const day = relativeDay(dayIn(t, tz), now, tz, { order: opts.order })
  return `${day} at ${timeLabel(t, tz, { hour12: opts.hour12 })}`
}

/**
 * How long until something, in the coarsest unit that is still useful.
 *
 * Minutes below an hour, hours below a day, and DAYS COUNTED ON HIS CALENDAR
 * above that — not by dividing milliseconds, which is how "tomorrow evening"
 * became "in 1 day" at 23:00 and "in 0 days" at 01:00 on the same event.
 */
export function countdown(at: string, now: Date, tz?: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ''
  const ms = t - now.getTime()
  if (ms <= 0) return 'now'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `in ${mins} min`
  const hours = Math.round(ms / 3_600_000)
  if (hours < 24) return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = daysBetween(now, new Date(t), tz)
  if (days <= 1) return 'tomorrow'
  return `in ${days} days`
}

// ── Windows ──────────────────────────────────────────────────────────────────

export interface Window {
  /** First day, inclusive. */
  from: string
  /** Last day, inclusive. */
  to: string
  /** Every day in it, oldest first. */
  days: string[]
}

const windowOf = (from: string, count: number): Window => {
  const days: string[] = []
  for (let i = 0; i < count; i++) days.push(addDays(from, i))
  return { from, to: days[days.length - 1] ?? from, days }
}

/**
 * The week he is standing in, and which day it starts on is HIS convention.
 *
 * Monday by default because that is the ISO week and the one most of the world
 * plans against, but it is a parameter: "what should I focus on this week?"
 * means something different to someone whose week starts on Sunday, and getting
 * that wrong shifts the whole answer by a day at both ends.
 */
export function weekWindow(now: Date, tz?: string, startsOn: number = 1): Window {
  const today = dayIn(now, tz)
  const wd = weekdayOf(today)
  const back = (wd - startsOn + 7) % 7
  return windowOf(addDays(today, -back), 7)
}

/** The window from today forward, inclusive of today. What "the next 7 days" is. */
export function forwardWindow(now: Date, days: number, tz?: string): Window {
  return windowOf(dayIn(now, tz), Math.max(1, days))
}

/** The window ending today, inclusive. What a trailing average is computed over. */
export function trailingWindow(now: Date, days: number, tz?: string): Window {
  const today = dayIn(now, tz)
  return windowOf(addDays(today, -(Math.max(1, days) - 1)), Math.max(1, days))
}

/**
 * The remainder of the week, which is what "focus on this week" is actually
 * about — nobody can act on Monday once it is Thursday.
 */
export function restOfWeek(now: Date, tz?: string, startsOn: number = 1): Window {
  const week = weekWindow(now, tz, startsOn)
  const today = dayIn(now, tz)
  const days = week.days.filter((d) => d >= today)
  return { from: days[0] ?? today, to: days[days.length - 1] ?? today, days }
}

/** Is this instant inside the window, by his calendar? */
export function inWindow(iso: string, w: Window, tz?: string, allDay?: boolean): boolean {
  const day = allDay ? iso.slice(0, 10) : dayIn(new Date(iso), tz)
  return day >= w.from && day <= w.to
}

// ── What the model is allowed to know about dates ─────────────────────────────

/**
 * THE PROMPT IS GIVEN DATES, NOT ASKED FOR THEM.
 *
 * This is the mechanism behind "no model-authored date arithmetic". Rather than
 * telling the model the current instant and trusting it to work out that the
 * 12th is a Wednesday, every date phrase it could possibly need is computed
 * here and handed over as a fact, with an instruction that it may use these
 * strings and may not derive others.
 *
 * It cannot be enforced absolutely — a model can always type a wrong weekday —
 * so nothing downstream DEPENDS on it: `dateLabel` on the feed is computed here
 * and overwrites whatever the model returned (see `feed.ts`), and every date on
 * a computed card comes from this file. What the vocabulary buys is that the
 * model's PROSE agrees with the app's arithmetic instead of inventing a rival
 * calendar in the same sentence.
 */
export interface DateVocabulary {
  /** ISO instant, so the model can reason about ordering without formatting. */
  nowIso: string
  timeZone: string
  today: string
  todayLabel: string
  todayWeekday: string
  time: string
  tomorrow: string
  tomorrowWeekday: string
  yesterday: string
  /** Every day of the coming week, named. The lookup table for "what day is X". */
  week: { day: string; weekday: string; relative: string }[]
  weekStart: string
  weekEnd: string
}

export function dateVocabulary(now: Date, tz?: string, opts: { startsOn?: number; order?: 'dmy' | 'mdy' } = {}): DateVocabulary {
  const zone = tz && isZone(tz) ? tz : 'UTC'
  const today = dayIn(now, zone)
  const week = weekWindow(now, zone, opts.startsOn ?? 1)
  const forward = forwardWindow(now, 8, zone)
  return {
    nowIso: now.toISOString(),
    timeZone: zone,
    today,
    todayLabel: dateLabel(today, { weekday: 'long', month: 'long', year: true, order: opts.order }),
    todayWeekday: weekdayName(today, 'long'),
    time: timeLabel(now, zone),
    tomorrow: addDays(today, 1),
    tomorrowWeekday: weekdayName(addDays(today, 1), 'long'),
    yesterday: addDays(today, -1),
    week: forward.days.map((d) => ({
      day: d,
      weekday: weekdayName(d, 'long'),
      relative: relativeDay(d, now, zone, { order: opts.order }),
    })),
    weekStart: week.from,
    weekEnd: week.to,
  }
}

/** The block that goes in a prompt. Facts, plus the rule about not deriving more. */
export function renderDateVocabulary(v: DateVocabulary): string {
  return [
    `THE CALENDAR, ALREADY WORKED OUT FOR YOU (do not compute dates yourself — you have no calendar and you will get the weekday wrong):`,
    `- right now: ${v.todayLabel}, ${v.time} (${v.timeZone})`,
    `- today is ${v.today}, a ${v.todayWeekday}`,
    `- tomorrow is ${v.tomorrow}, a ${v.tomorrowWeekday}`,
    `- his week runs ${v.weekStart} to ${v.weekEnd}`,
    `- the next eight days: ${v.week.map((d) => `${d.day} = ${d.weekday} (${d.relative})`).join('; ')}`,
    `Use ONLY these mappings when you name a day. If you need a date that is not listed, say "on ${'{'}the date{'}'}" using the ISO date itself rather than guessing a weekday or a countdown.`,
  ].join('\n')
}
