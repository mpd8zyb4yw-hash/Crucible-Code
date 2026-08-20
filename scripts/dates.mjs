#!/usr/bin/env node
/**
 * THE CALENDAR, ASSERTED.
 *
 * Every date bug this app has had was invisible from the screen: a header reading
 * 8/8/2026 on the 9th, an event labelled Saturday that was a Sunday, a leave-by
 * time two hours early. Each one looked exactly like a correct answer, which is why
 * a comment asking future edits to be careful would not have held. These fail the
 * deploy instead.
 *
 * The dates are FIXED and chosen for what they break:
 *
 *   · 2026-08-11 and 2026-08-12 — the Tuesday and Wednesday of his real world model,
 *     with a dinner on the 12th. The exact days a model was asked to reason about and
 *     got wrong.
 *   · the UTC/Rome midnight window — 23:15Z on the 8th is already the 9th in Rome. The
 *     literal bug, at the literal instant.
 *   · month and year boundaries — 31 August → 1 September, 31 December 2026 → 1
 *     January 2027, and February in a non-leap year. Anything that adds 86,400,000
 *     milliseconds gets these right and anything that hand-rolls month lengths does
 *     not.
 *   · the DST changeover — 25 October 2026, when Rome goes back an hour and a
 *     "day" is 25 hours long. Millisecond division answers this wrong by
 *     construction.
 *
 * Run: npm test
 */
import {
  addDays,
  countdown,
  dateLabel,
  dateVocabulary,
  dayIn,
  daysBetween,
  daysBetweenDays,
  forwardWindow,
  partsIn,
  relativeDay,
  restOfWeek,
  timeLabel,
  trailingWindow,
  weekWindow,
  weekdayName,
  whenLabel,
} from '../server/clock.ts'

let failures = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) return
  failures++
  console.error(`FAIL  ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}

const ROME = 'Europe/Rome'

// ── The days of his actual world model ───────────────────────────────────────

check('2026-08-11 is a Tuesday', weekdayName('2026-08-11'), 'Tuesday')
check('2026-08-12 is a Wednesday', weekdayName('2026-08-12'), 'Wednesday')
check('2026-08-11 short', weekdayName('2026-08-11', 'short'), 'Tue')
check('day after the 11th', addDays('2026-08-11', 1), '2026-08-12')
check('the 12th is one day after the 11th', daysBetweenDays('2026-08-11', '2026-08-12'), 1)
check('the 11th is one day before the 12th', daysBetweenDays('2026-08-12', '2026-08-11'), -1)

/**
 * THE BUG, AT THE INSTANT IT HAPPENED.
 *
 * 23:15Z on 8 August is 01:15 on the 9th in Rome. The runtime's zone said the 8th and
 * the header said 8/8/2026 while his phone clock read the 9th.
 */
const lateNight = new Date('2026-08-08T23:15:00Z')
check('UTC midnight window: his day', dayIn(lateNight, ROME), '2026-08-09')
check('UTC midnight window: UTC day', dayIn(lateNight, 'UTC'), '2026-08-08')
check('UTC midnight window: his weekday', weekdayName(dayIn(lateNight, ROME)), 'Sunday')
check('UTC midnight window: his clock', timeLabel(lateNight, ROME), '01:15')
check('UTC midnight window: UTC clock', timeLabel(lateNight, 'UTC'), '23:15')

/**
 * The leave-by time that read two hours early.
 *
 * A 16:30 Rome departure is 14:30Z, and slicing the hour out of the ISO string —
 * which is what `panes.ts` did — produced "14:30" for the man trying to catch a bus.
 */
const leaveBy = new Date('2026-08-12T14:30:00Z')
check('leave-by on his clock', timeLabel(leaveBy, ROME), '16:30')
check('leave-by 12-hour', timeLabel(leaveBy, ROME, { hour12: true }), '4:30pm')

// ── Month, year and leap boundaries ──────────────────────────────────────────

check('31 Aug + 1', addDays('2026-08-31', 1), '2026-09-01')
check('1 Sep − 1', addDays('2026-09-01', -1), '2026-08-31')
check('31 Dec 2026 + 1', addDays('2026-12-31', 1), '2027-01-01')
check('1 Jan 2027 − 1', addDays('2027-01-01', -1), '2026-12-31')
check('year boundary is one day', daysBetweenDays('2026-12-31', '2027-01-01'), 1)
check('28 Feb 2026 + 1 (not a leap year)', addDays('2026-02-28', 1), '2026-03-01')
check('28 Feb 2028 + 1 (leap year)', addDays('2028-02-28', 1), '2028-02-29')
check('29 Feb 2028 + 1', addDays('2028-02-29', 1), '2028-03-01')
check('a whole year of days', daysBetweenDays('2026-01-01', '2027-01-01'), 365)
check('a leap year of days', daysBetweenDays('2028-01-01', '2029-01-01'), 366)
check('+30 across two months', addDays('2026-08-20', 30), '2026-09-19')
check('−400 days', addDays('2027-01-01', -400), '2025-11-27')

/**
 * The weekday must survive the year boundary too. 1 January 2027 is a Friday; a
 * table indexed off a UTC-midnight parse gets this wrong for anyone west of London.
 */
check('1 Jan 2027 is a Friday', weekdayName('2027-01-01'), 'Friday')
check('31 Dec 2026 is a Thursday', weekdayName('2026-12-31'), 'Thursday')

// ── DST, where millisecond arithmetic fails by construction ──────────────────

/**
 * Rome goes back an hour at 03:00 local on 25 October 2026, so 25 October is 25
 * hours long. `Math.round(ms / 86_400_000)` between the 24th and the 25th gives
 * 1.04 → 1 by luck; between an instant on the 24th and one late on the 25th it
 * gives 2. Counting calendar days answers 1 either way.
 */
const beforeDst = new Date('2026-10-24T22:00:00Z')
const afterDst = new Date('2026-10-25T22:00:00Z')
check('across DST: his days', [dayIn(beforeDst, ROME), dayIn(afterDst, ROME)], ['2026-10-25', '2026-10-25'])
check('across DST: same calendar day', daysBetween(beforeDst, afterDst, ROME), 0)
check('DST day is still one day long on the calendar', daysBetweenDays('2026-10-25', '2026-10-26'), 1)
check('25 Oct 2026 is a Sunday', weekdayName('2026-10-25'), 'Sunday')

/** The hour on either side of the changeover, read in his zone. */
check('before the change', timeLabel(new Date('2026-10-25T00:30:00Z'), ROME), '02:30')
check('after the change', timeLabel(new Date('2026-10-25T01:30:00Z'), ROME), '02:30')

// ── Relative days, which is what a card actually prints ──────────────────────

const tuesdayMorning = new Date('2026-08-11T07:00:00Z') // 09:00 in Rome
check('today', relativeDay('2026-08-11', tuesdayMorning, ROME), 'today')
check('tomorrow', relativeDay('2026-08-12', tuesdayMorning, ROME), 'tomorrow')
check('yesterday', relativeDay('2026-08-10', tuesdayMorning, ROME), 'yesterday')
check('later this week is a weekday', relativeDay('2026-08-14', tuesdayMorning, ROME), 'Friday')
check('a week out is a date, not a weekday', relativeDay('2026-08-25', tuesdayMorning, ROME), 'Tue 25 Aug')
check('last week is qualified', relativeDay('2026-08-07', tuesdayMorning, ROME), 'last Friday')

/**
 * The specific trap `relativeDay` is bounded to avoid: a bare weekday for a day
 * more than a week out reads as the NEAR one. "Wednesday" said on the 11th about
 * the 26th is heard as the 12th, which is a fortnight of error in one word.
 */
check('the 26th is not "Wednesday"', relativeDay('2026-08-26', tuesdayMorning, ROME).includes('Wed 26'), true)

check('the dinner, as a phrase', whenLabel('2026-08-12T16:00:00Z', tuesdayMorning, ROME), 'tomorrow at 18:00')
check('an all-day event gets no clock', whenLabel('2026-08-12', tuesdayMorning, ROME, { allDay: true }), 'tomorrow')

// ── Countdowns ───────────────────────────────────────────────────────────────

check('40 minutes', countdown('2026-08-11T07:40:00Z', tuesdayMorning, ROME), 'in 40 min')
check('3 hours', countdown('2026-08-11T10:00:00Z', tuesdayMorning, ROME), 'in 3 hours')
check('the past is now, not negative', countdown('2026-08-11T06:00:00Z', tuesdayMorning, ROME), 'now')
check('tomorrow evening', countdown('2026-08-12T16:00:00Z', tuesdayMorning, ROME), 'tomorrow')
check('three days out', countdown('2026-08-14T16:00:00Z', tuesdayMorning, ROME), 'in 3 days')

/**
 * The countdown that used to flip on the hour of day rather than on the calendar.
 * 22:00 tonight to 08:00 tomorrow is ten hours, and calling it "in 10 hours" is
 * right — but the DAY count between them is 1, and a "days" answer of 0 would have
 * said "now".
 */
const lateTonight = new Date('2026-08-11T20:00:00Z') // 22:00 Rome
check('overnight is hours, not days', countdown('2026-08-12T06:00:00Z', lateTonight, ROME), 'in 10 hours')

// ── Windows ──────────────────────────────────────────────────────────────────

const week = weekWindow(tuesdayMorning, ROME)
check('his week starts Monday', [week.from, week.to], ['2026-08-10', '2026-08-16'])
check('the week has 7 days', week.days.length, 7)
check('a Sunday-start week', weekWindow(tuesdayMorning, ROME, 0).from, '2026-08-09')

const rest = restOfWeek(tuesdayMorning, ROME)
check('the rest of the week starts today', [rest.from, rest.to], ['2026-08-11', '2026-08-16'])
check('the rest of the week is 6 days', rest.days.length, 6)

check('trailing week ends today', trailingWindow(tuesdayMorning, 7, ROME).to, '2026-08-11')
check('trailing week starts 6 days back', trailingWindow(tuesdayMorning, 7, ROME).from, '2026-08-05')
check('forward week starts today', forwardWindow(tuesdayMorning, 7, ROME).from, '2026-08-11')

/**
 * A week that straddles a month boundary, which is where a window built by adding
 * milliseconds to a start-of-week instant lands on the wrong day.
 */
const endOfAugust = new Date('2026-08-31T09:00:00Z')
const straddle = weekWindow(endOfAugust, ROME)
check('week across the month end', [straddle.from, straddle.to], ['2026-08-31', '2026-09-06'])
check('week across the year end', weekWindow(new Date('2026-12-31T09:00:00Z'), ROME).days.slice(-1), ['2027-01-03'])

// ── The parts a card reads ───────────────────────────────────────────────────

check('parts in Rome', partsIn(lateNight, ROME), { year: 2026, month: 8, day: 9, weekday: 0, hour: 1, minute: 15 })
check('parts in UTC', partsIn(lateNight, 'UTC'), { year: 2026, month: 8, day: 8, weekday: 6, hour: 23, minute: 15 })
/** Midnight must be hour 0, not 24 — some ICU builds render it as 24. */
check('midnight is hour 0', partsIn(new Date('2026-08-11T22:00:00Z'), ROME).hour, 0)

// ── His conventions ──────────────────────────────────────────────────────────

check('day-month', dateLabel('2026-08-11', { weekday: 'long', month: 'long', year: true }), 'Tuesday 11 August 2026')
check('month-day', dateLabel('2026-08-11', { weekday: 'long', month: 'long', year: true, order: 'mdy' }), 'Tuesday August 11 2026')
check('the header form', dateLabel('2026-08-11', { weekday: 'short', month: 'short' }), 'Tue 11 Aug')
check('numeric day-month', dateLabel('2026-08-11', { month: 'numeric' }), '11/8')
check('numeric month-day', dateLabel('2026-08-11', { month: 'numeric', order: 'mdy' }), '8/11')

// ── What the model is handed instead of a calculator ─────────────────────────

const vocab = dateVocabulary(tuesdayMorning, ROME)
check('vocabulary: today', vocab.today, '2026-08-11')
check('vocabulary: today is a Tuesday', vocab.todayWeekday, 'Tuesday')
check('vocabulary: tomorrow', vocab.tomorrow, '2026-08-12')
check('vocabulary: tomorrow is a Wednesday', vocab.tomorrowWeekday, 'Wednesday')
check('vocabulary: the week', [vocab.weekStart, vocab.weekEnd], ['2026-08-10', '2026-08-16'])
check('vocabulary: eight days named', vocab.week.length, 8)
check('vocabulary: zone is his', vocab.timeZone, ROME)

/**
 * EVERY MAPPING IN THE VOCABULARY MUST BE INTERNALLY CONSISTENT.
 *
 * This is the assertion that makes the whole approach worth anything: the prompt
 * hands the model a table, and if the table is wrong the model is wrong in a way
 * that now looks authoritative. So every row is re-derived independently.
 */
for (const row of vocab.week) {
  check(`vocabulary row ${row.day} weekday`, row.weekday, weekdayName(row.day))
  check(`vocabulary row ${row.day} relative`, row.relative, relativeDay(row.day, tuesdayMorning, ROME))
}

/**
 * And it must survive a boundary. Built on 31 December, the table has to carry the
 * model across into the next year without a single wrong weekday.
 */
const newYear = dateVocabulary(new Date('2026-12-31T09:00:00Z'), ROME)
check('vocabulary across the year: today', newYear.today, '2026-12-31')
check('vocabulary across the year: tomorrow', newYear.tomorrow, '2027-01-01')
check('vocabulary across the year: tomorrow is a Friday', newYear.tomorrowWeekday, 'Friday')
for (const row of newYear.week) {
  check(`new-year row ${row.day}`, row.weekday, weekdayName(row.day))
}

// ── Degradation ──────────────────────────────────────────────────────────────

/**
 * An unusable zone must degrade to the runtime's rather than throw or produce
 * `NaN`. A card that cannot render a date is worse than a card that renders it in
 * the wrong zone, and `migrateWorld` clears an unusable stored zone anyway.
 */
check('a nonsense zone still answers', typeof dayIn(tuesdayMorning, 'Not/AZone'), 'string')
check('a nonsense date is returned as itself', addDays('not-a-date', 1), 'not-a-date')
check('a nonsense date has no weekday', weekdayName('not-a-date'), '')
check('an unparseable instant has no countdown', countdown('nonsense', tuesdayMorning), '')

if (failures) {
  console.error(`\n${failures} date failure(s): a weekday, a boundary or a zone is wrong.`)
  process.exit(1)
}
console.log(
  'dates ok — his week, the UTC midnight window, month/year/leap boundaries and the DST changeover all ' +
  `held; every mapping the model is handed re-derives correctly`
)
