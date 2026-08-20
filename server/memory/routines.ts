/**
 * LEARNING A RHYTHM, WITHOUT BEING TOLD THERE IS ONE.
 *
 * `person.ts` already has a `Routine`, and its cadence field is his words —
 * "most weekday evenings". That is exactly right for the prompt and useless for
 * arithmetic: nothing can ask a phrase whether half past twelve on a Saturday
 * with no shopping done is unusual, so the app could hold a routine and still be
 * unable to notice it had been broken.
 *
 * This is the same concept with the numbers kept. The two are written together
 * rather than one replacing the other — see `writeBack` — so the prompt keeps
 * reading the sentence it always read and the cognition gets the distribution.
 *
 * NOTHING HERE KNOWS WHAT SHOPPING IS.
 *
 * §32 forbids encoding the fixture's answers into the learner, and the strongest
 * form of that is a learner with no domain vocabulary at all. There is no list of
 * activity types, no keyword match on "grocery", no special case for weekends.
 * What it has is: episodes have a type and a place, days have a weekday, and a
 * thing that happens on most of one weekday across enough weeks is a rhythm. The
 * Saturday shop is discovered as "visits to this place, Saturdays, p=0.78,
 * usually 10:35, usually 68 minutes" — and it is recognisable as shopping only
 * because the PLACE has a label, which came from a source rather than from us.
 *
 * PURE IN THE EVIDENCE, WHICH IS WHAT MAKES REPLAY POSSIBLE.
 *
 * Nothing in this file reads the routine it is about to write. Status, confidence
 * and every statistic are functions of the observed episodes alone, so learning
 * incrementally over four months and learning once from the whole ledger produce
 * identical rows. The tempting alternative — incrementing a counter on each pass —
 * would make the result depend on how often the reflection cycle happened to run,
 * which is not a fact about his life.
 */

import { addDays, dayIn, weekdayOf } from '../clock.js'
import { idOf, slug } from './ids.js'
import { median, stdDev } from './temporal.js'
import {
  VERSIONS,
  type Episode,
  type EvidenceRef,
  type MemoryStore,
  type RoutineModel,
} from './types.js'

/**
 * THE BARS, AND WHY THEY ARE NOT `ENGAGEMENT_MIN`.
 *
 * `person.ts` uses four accepts-or-dismisses before behaviour nudges a ranking,
 * and four is right there: the claim is small, the effect is bounded, and being
 * wrong costs a card's position. A routine is a durable claim about how he lives
 * that predictions and anomalies will both rest on, so it asks for more — and it
 * asks for a DIFFERENT KIND of more.
 *
 *   · OCCURRENCES say the thing happened enough times to be a pattern.
 *   · COVERAGE says those times were spread over enough calendar for the pattern
 *     to be a rhythm rather than a fortnight of a project. Six lunches in one
 *     week is not a weekly lunch, and only the span can tell them apart.
 *
 * Both, always. Either alone is satisfied by data that plainly is not a routine.
 */
const CANDIDATE_MIN = 2
const EMERGING_MIN = 3
const ESTABLISHED_OCCURRENCES = 6
const ESTABLISHED_COVERAGE_DAYS = 42
const ESTABLISHED_PROBABILITY = 0.6

/**
 * A weekday counts as part of the rhythm when it happens on at least half of
 * them.
 *
 * Half is the point at which "usually" stops being a lie. Below it the honest
 * word is "sometimes", and a routine claiming Saturdays that only holds two in
 * five would generate a prediction that fails more often than it succeeds — and
 * the calibration record would then be measuring the threshold rather than his
 * life.
 */
const WEEKDAY_RATE = 0.5
const WEEKDAY_MIN_OCCURRENCES = 3

/**
 * How much of the recent past has to have gone quiet before a routine is
 * "weakening".
 *
 * Expressed as a fraction of its own established rate rather than as an absolute,
 * because a fortnightly routine and a daily one both weaken by halving. The
 * window is the last quarter of the observed span, which scales with the routine
 * instead of being a fixed number of weeks that is far too long for something new
 * and far too short for something that has run for a year.
 */
const WEAKENING_RATIO = 0.5

export interface RoutineRun {
  learned: string[]
  /** Groups that did not clear the bars, with the arithmetic that failed. */
  rejected: { activityType: string; why: string }[]
}

/**
 * Learn every routine the episode history supports.
 *
 * Reads the whole episode table by design. Routines are the one derived
 * structure whose correctness genuinely depends on all of history — a rhythm is
 * a statement about a span — and there are tens of them, not millions. The
 * incremental saving that matters is upstream, in normalisation and assembly;
 * making this incremental would trade a real property for a saving nobody can
 * measure.
 */
export function learnRoutines(store: MemoryStore, now: Date, opts: { timeZone?: string } = {}): RoutineRun {
  const run: RoutineRun = { learned: [], rejected: [] }
  const episodes = store.episodes.all().filter((e) => e.status !== 'cancelled')
  if (!episodes.length) return run

  const groups = new Map<string, Episode[]>()
  for (const ep of episodes) {
    for (const key of activityKeysOf(ep)) {
      groups.set(key, [...(groups.get(key) ?? []), ep])
    }
  }

  const out: RoutineModel[] = []
  for (const [activityType, group] of groups) {
    const model = modelFor(store, activityType, group, now, opts.timeZone)
    if (!model) {
      run.rejected.push({
        activityType,
        why: `${new Set(group.map((e) => dayIn(new Date(e.startAt), opts.timeZone))).size} occasion(s) is under ${CANDIDATE_MIN}`,
      })
      continue
    }
    out.push(model)
    run.learned.push(`${model.activityType} ${model.status} p=${model.temporal.recurrenceProbability.toFixed(2)}`)
  }

  if (out.length) store.routines.put(out)
  return run
}

/**
 * WHAT COUNTS AS "THE SAME THING HAPPENING AGAIN".
 *
 * The identity of a routine is what it is ABOUT, and an episode can be about
 * more than one thing — a lunch with Bernardo at the same trattoria is both "the
 * Bernardo rhythm" and "the trattoria rhythm", and which of the two is real is
 * a question the data answers rather than a choice made here. So an episode
 * contributes to every key it fits and the thresholds sort them out.
 *
 * Keys are ENTITY IDS, never labels. A place that gets renamed keeps its routine;
 * two places with the same name keep theirs apart.
 */
function activityKeysOf(ep: Episode): string[] {
  const keys: string[] = []
  for (const place of ep.placeEntityIds) keys.push(`place:${place}`)
  for (const person of ep.participantEntityIds) keys.push(`person:${person}`)
  // An episode with neither is still a rhythm of its kind — "he has a meeting
  // most Mondays" — but only if the type is more specific than "something".
  if (!keys.length && ep.type !== 'other') keys.push(`type:${ep.type}`)
  return keys
}

function modelFor(
  store: MemoryStore,
  activityType: string,
  group: Episode[],
  now: Date,
  timeZone?: string
): RoutineModel | null {
  const days = new Map<string, Episode>()
  for (const ep of group) {
    const day = dayIn(new Date(ep.startAt), timeZone)
    // One occurrence per day: two visits to the same shop on one Saturday is one
    // Saturday, and counting both would inflate a probability past 1.
    const held = days.get(day)
    if (!held || ep.startAt < held.startAt) days.set(day, ep)
  }
  if (days.size < CANDIDATE_MIN) return null

  const dayList = [...days.keys()].sort()
  const firstDay = dayList[0]!
  const lastDay = dayList[dayList.length - 1]!
  const today = dayIn(now, timeZone)
  /**
   * The OBSERVED SPAN is first-sighting to today, not first to last.
   *
   * Ending it at the last occurrence is how a routine that stopped in March
   * keeps reporting a perfect probability forever: the denominator stops growing
   * at the same moment the numerator does. Running the window to today is what
   * makes silence count as evidence.
   */
  const spanDays = Math.max(1, dayCount(firstDay, today))

  // ── which weekdays, if any ──
  const occurrencesByWeekday = new Map<number, number>()
  for (const day of dayList) {
    const w = weekdayOf(day)
    occurrencesByWeekday.set(w, (occurrencesByWeekday.get(w) ?? 0) + 1)
  }
  const availableByWeekday = new Map<number, number>()
  for (let day = firstDay; day <= today; day = addDays(day, 1)) {
    const w = weekdayOf(day)
    availableByWeekday.set(w, (availableByWeekday.get(w) ?? 0) + 1)
  }

  const daysOfWeek: number[] = []
  for (const [w, count] of occurrencesByWeekday) {
    const available = availableByWeekday.get(w) ?? 0
    if (!available) continue
    if (count >= WEEKDAY_MIN_OCCURRENCES && count / available >= WEEKDAY_RATE) daysOfWeek.push(w)
  }
  daysOfWeek.sort()

  const qualifyingDays = daysOfWeek.length
    ? daysOfWeek.reduce((a, w) => a + (availableByWeekday.get(w) ?? 0), 0)
    : spanDays
  const qualifyingOccurrences = daysOfWeek.length
    ? daysOfWeek.reduce((a, w) => a + (occurrencesByWeekday.get(w) ?? 0), 0)
    : days.size
  const recurrenceProbability = qualifyingDays ? qualifyingOccurrences / qualifyingDays : 0

  // ── timing and duration, over the qualifying occurrences only ──
  const relevant = dayList
    .filter((d) => !daysOfWeek.length || daysOfWeek.includes(weekdayOf(d)))
    .map((d) => days.get(d)!)
  const startMinutes = relevant
    .map((e) => e.attributes.minuteOfDay)
    .filter((m): m is number => typeof m === 'number')
  const durations = relevant
    .map((e) => e.attributes.durationMinutes)
    .filter((m): m is number => typeof m === 'number')

  // ── gaps, for rhythms that are not weekly ──
  const gaps: number[] = []
  for (let i = 1; i < dayList.length; i++) gaps.push(dayCount(dayList[i - 1]!, dayList[i]!))

  const status = statusOf(days.size, spanDays, recurrenceProbability, dayList, today, daysOfWeek, availableByWeekday)

  const evidence: EvidenceRef[] = relevant
    .slice(-24)
    .map((e) => ({ kind: 'episode' as const, id: e.id, says: `${e.type} on ${dayIn(new Date(e.startAt), timeZone)}` }))

  return {
    id: idOf('rtn', slug(activityType, 60)),
    activityType,
    entityRefs: entityRefsOf(activityType),
    temporal: {
      daysOfWeek: daysOfWeek.length ? daysOfWeek : undefined,
      recurrenceProbability,
      typicalStartMinutes: median(startMinutes) ?? undefined,
      startStdDevMinutes: stdDev(startMinutes) ?? undefined,
      typicalDurationMinutes: median(durations) ?? undefined,
      durationStdDevMinutes: stdDev(durations) ?? undefined,
      intervalDaysMedian: gaps.length ? (median(gaps) ?? undefined) : undefined,
    },
    context: {
      label: labelFor(store, activityType),
      occurrenceDays: dayList.length,
      qualifyingDays,
      spanDays,
    },
    /**
     * CONFIDENCE IS ABOUT THE EVIDENCE, NOT ABOUT THE PROBABILITY.
     *
     * Three Saturdays out of three is a recurrence probability of 1.0 and is not
     * something to be confident about. Keeping the two numbers apart is what
     * lets a surface say "he has done this every one of the four Saturdays I have
     * seen, which is not many yet" — one sentence containing both facts, neither
     * of which can be recovered from a single blended score.
     */
    confidence: confidenceOf(days.size, spanDays, daysOfWeek.length > 0),
    evidenceCount: days.size,
    temporalCoverageDays: spanDays,
    evidence,
    firstObservedAt: firstDay,
    lastObservedAt: lastDay,
    status,
    modelVersion: VERSIONS.routine,
  }
}

/**
 * `candidate` → `emerging` → `established`, with `weakening` and `inactive` for
 * rhythms that are going or gone.
 *
 * A pure function of the evidence, per the file header. `weakening` in particular
 * is computed by comparing the routine's recent rate to its own overall rate
 * rather than by remembering that it used to be established — which is what makes
 * an incremental run and a rebuild agree.
 */
function statusOf(
  occurrences: number,
  spanDays: number,
  probability: number,
  dayList: string[],
  today: string,
  daysOfWeek: number[],
  availableByWeekday: Map<number, number>
): RoutineModel['status'] {
  if (occurrences < EMERGING_MIN) return 'candidate'

  // The recent quarter of the routine's own life, floored at a fortnight so a
  // young routine is not judged on three days.
  const recentDays = Math.max(14, Math.round(spanDays / 4))
  const recentFrom = addDays(today, -recentDays + 1)
  const recentOccurrences = dayList.filter((d) => d >= recentFrom).length
  const recentQualifying = daysOfWeek.length
    ? countWeekdaysBetween(recentFrom, today, daysOfWeek)
    : recentDays
  const recentRate = recentQualifying ? recentOccurrences / recentQualifying : 0

  if (recentOccurrences === 0 && occurrences >= EMERGING_MIN) return 'inactive'

  const established =
    occurrences >= ESTABLISHED_OCCURRENCES &&
    spanDays >= ESTABLISHED_COVERAGE_DAYS &&
    probability >= ESTABLISHED_PROBABILITY

  if (established && recentRate < probability * WEAKENING_RATIO) return 'weakening'
  if (established) return 'established'
  return 'emerging'
}

/**
 * Confidence rises with occurrences AND with span, and is capped.
 *
 * The cap is not modesty. A routine is a claim about the future and the future
 * is not something this app has evidence about; 0.9 leaves room for the one
 * thing that is always true, which is that he may simply decide otherwise.
 */
function confidenceOf(occurrences: number, spanDays: number, weekly: boolean): number {
  const fromCount = Math.min(0.5, occurrences * 0.06)
  const fromSpan = Math.min(0.3, (spanDays / 90) * 0.3)
  // A rhythm with a named weekday is a stronger claim than a bare interval,
  // because it survives a week being skipped and an interval does not.
  const fromShape = weekly ? 0.1 : 0
  return Math.min(0.9, 0.1 + fromCount + fromSpan + fromShape)
}

const entityRefsOf = (activityType: string): string[] => {
  const m = /^(?:place|person):(.+)$/.exec(activityType)
  return m ? [m[1]!] : []
}

function labelFor(store: MemoryStore, activityType: string): string {
  const [id] = entityRefsOf(activityType)
  if (!id) return activityType.replace(/^type:/, '')
  return store.entities.byId(id)?.label ?? activityType
}

/** Whole days between two of his day strings. Through `clock.ts`, always. */
function dayCount(from: string, to: string): number {
  let n = 0
  for (let day = from; day < to; day = addDays(day, 1)) n++
  return n
}

function countWeekdaysBetween(from: string, to: string, weekdays: number[]): number {
  let n = 0
  for (let day = from; day <= to; day = addDays(day, 1)) if (weekdays.includes(weekdayOf(day))) n++
  return n
}

// ── The bridge back to the typed personal model ──────────────────────────────

/**
 * WRITE THE RHYTHM BACK INTO `Person_.routines` AS A SENTENCE.
 *
 * The prompt reads `renderPerson`, and `renderPerson` reads `Routine.cadence`.
 * If this milestone left the numbers only in the memory core, the model's view of
 * his life would be strictly worse than it was before — it would lose the
 * routines it used to be told about while the app quietly knew more. So the
 * learned model is rendered into the existing shape and put back.
 *
 * `by: 'agent'` and `mayReplace` govern the write, exactly as everywhere else: a
 * routine he stated himself is never overwritten by one we measured. The
 * ownership rule is `person.ts`'s and is not restated here — it is CALLED.
 */
export function routineSentence(model: RoutineModel, label: string): { what: string; cadence: string } {
  const days = model.temporal.daysOfWeek ?? []
  const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
  const when = days.length
    ? days.map((d) => names[d] ?? `day ${d}`).join(' and ')
    : model.temporal.intervalDaysMedian
      ? `about every ${Math.round(model.temporal.intervalDaysMedian)} days`
      : 'irregularly'

  const start = model.temporal.typicalStartMinutes
  const at = start === undefined ? '' : `, usually around ${clockOf(start)}`
  const often =
    model.temporal.recurrenceProbability >= 0.85
      ? 'almost always'
      : model.temporal.recurrenceProbability >= 0.6
        ? 'most'
        : 'some'

  return {
    what: label,
    cadence: days.length ? `${often} ${when}${at}` : `${when}${at}`,
  }
}

/** Minutes past midnight as a 24-hour clock time. His conventions, not ISO. */
function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = Math.round(minutes % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
