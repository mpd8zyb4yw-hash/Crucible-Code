/**
 * "USUALLY", "LATELY", "IT USED TO BE" — AS ARITHMETIC RATHER THAN AS ADJECTIVES.
 *
 * `activity.ts` already does this for one metric and does it well: a current
 * figure, a trailing window, the window before it, a percentage change, a
 * direction, and explicit handling of days with no reading. Everything it says
 * about steps is checkable, which is why the steps surface is the one part of
 * this app that has never asserted something nobody could verify.
 *
 * No other domain had it. So "your Thursdays are busier than usual" and "you have
 * been leaving later" were sentences only a language model could produce, which
 * meant they were sentences nobody could check, which meant the honest choice was
 * not to say them. This file is the generalisation: the same shape, over any
 * series, for calendar load, departure time, contact cadence and steps alike.
 *
 * THE THREE THINGS IT ADDS BEYOND `activity.ts`.
 *
 *   · SCOPE. "His Thursdays" is a different population from "his days", and a
 *     deviation is only meaningful against the right one. Comparing a Thursday to
 *     an all-days mean is how a schedule with a quiet weekend produces a
 *     permanent false alarm every Monday.
 *   · A MEDIAN AND A DEVIATION. A mean alone cannot say whether 12:00 is unusual;
 *     it needs to know that the spread is fifteen minutes rather than two hours.
 *     Every anomaly threshold in this directory is expressed in standard
 *     deviations for that reason.
 *   · A CHANGE POINT. The product difference between "today was odd" and "this
 *     has been drifting since June" is the entire value of a temporal model, and
 *     a percentage change cannot tell them apart — a step change and a slow drift
 *     produce the same number.
 *
 * WHAT IS DELIBERATELY ABSENT: any interpretation. Nothing here decides that a
 * change matters. It computes what happened; `anomalies` and `attention.ts`
 * decide what is worth saying, and the second of those is not being rebuilt.
 */

import { addDays, dayIn, daysBetweenDays, partsIn } from '../clock.js'
import { idOf } from './ids.js'
import { VERSIONS, type MemoryStore, type TemporalSummary } from './types.js'

/** One day's value for one metric. The universal input to everything below. */
export interface Sample {
  day: string
  value: number
  /** What produced it, for the evidence chain. */
  evidenceIds: string[]
}

// ── Statistics ───────────────────────────────────────────────────────────────

export const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/**
 * SAMPLE standard deviation, with `n − 1`, and null below two points.
 *
 * The population form would report 0 for a single observation, which reads as
 * "this never varies" and is the most dangerous possible answer: every anomaly
 * test downstream divides by it, so one sighting would make everything else
 * infinitely surprising. Null is the honest value for "not enough to say", and
 * every caller has to handle it.
 */
export function stdDev(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/**
 * WHERE A SERIES STEPS FROM ONE LEVEL TO ANOTHER.
 *
 * A split search: try every division of the series that leaves enough points on
 * both sides, and keep the one where the two halves' means are furthest apart.
 * That is the simplest change-point detector there is, and simple is the right
 * choice here for a reason beyond effort — the alternatives (CUSUM, binary
 * segmentation with a penalty term) need parameters tuned against data we do not
 * have yet, and a tuned detector nobody can explain is worse than a crude one
 * whose failure mode is obvious.
 *
 * THE SIGNIFICANCE TEST IS WHAT MAKES IT USABLE. Every series has a best split;
 * most of them are noise. The gap has to exceed `minSigma` standard deviations of
 * the whole series, so a drifting metric with a wide spread does not report a
 * change point every time it is asked. Returns null rather than a weak answer —
 * "there is no detectable change" is a real result and the caller says so.
 */
export function changePoint(
  samples: Sample[],
  opts: { minSide?: number; minSigma?: number } = {}
): TemporalSummary['changePoint'] {
  /**
   * RAISED FROM 4 AND 1.2 AFTER RUNNING THIS OVER FOUR MONTHS OF SYNTHETIC LIFE.
   *
   * At 1.2σ the detector found three change points in the fixture: the real one
   * — the Tuesday departure shift, deliberately planted — and two that were the
   * random meeting counts happening to be slightly heavier in one half than the
   * other. Both false ones went on to become `supported` shift hypotheses, which
   * is the failure mode that matters: a wrong change point does not stay a
   * statistic, it becomes a sentence claiming his life changed in May.
   *
   * 1.5σ over at least five points a side keeps the planted shift (which is
   * about 1.9σ) and drops both spurious ones. The direction of the remaining
   * error is chosen deliberately: a missed change point costs a useful
   * observation, an invented one costs trust in every observation.
   */
  const minSide = opts.minSide ?? 5
  const minSigma = opts.minSigma ?? 1.5
  if (samples.length < minSide * 2) return null

  const values = samples.map((s) => s.value)
  const spread = stdDev(values)
  if (spread === null || spread === 0) return null

  let best: { index: number; before: number; after: number; gap: number } | null = null
  for (let i = minSide; i <= samples.length - minSide; i++) {
    const before = mean(values.slice(0, i))!
    const after = mean(values.slice(i))!
    const gap = Math.abs(after - before)
    if (!best || gap > best.gap) best = { index: i, before, after, gap }
  }
  if (!best || best.gap < minSigma * spread) return null

  return {
    // The change begins at the first sample on the new level, which is the day a
    // person would name — not the last day of the old one.
    day: samples[best.index]!.day,
    before: best.before,
    after: best.after,
    magnitude: best.after - best.before,
  }
}

// ── Building a summary ───────────────────────────────────────────────────────

export interface SummarizeOptions {
  domain: string
  metric: string
  scope?: string
  /** How many days back from `now` the current window covers. */
  windowDays?: number
  /** Change in the direction of this many percent counts as flat. */
  flatPercent?: number
}

/**
 * Turn a series into a `TemporalSummary`.
 *
 * The prior window is the SAME LENGTH immediately before the current one, which
 * is the comparison `activity.ts` makes and the only one that is fair: comparing
 * a fortnight to all of history would report a change every time a habit was
 * formed and never report one again.
 */
export function summarize(samples: Sample[], now: Date, opts: SummarizeOptions, timeZone?: string): TemporalSummary {
  const windowDays = opts.windowDays ?? 28
  const flatPercent = opts.flatPercent ?? 5
  const today = dayIn(now, timeZone)
  const currentFrom = addDays(today, -windowDays + 1)
  const priorFrom = addDays(today, -windowDays * 2 + 1)

  const inWindow = samples.filter((s) => s.day >= currentFrom && s.day <= today)
  const inPrior = samples.filter((s) => s.day >= priorFrom && s.day < currentFrom)

  const values = inWindow.map((s) => s.value)
  const priorValues = inPrior.map((s) => s.value)
  const m = mean(values)
  const pm = mean(priorValues)
  const changePercent = m !== null && pm !== null && pm !== 0 ? ((m - pm) / Math.abs(pm)) * 100 : null

  return {
    id: idOf('tmp', opts.domain, opts.metric, opts.scope ?? 'all'),
    domain: opts.domain,
    metric: opts.metric,
    scope: opts.scope ?? 'all',
    windowDays,
    samples: inWindow.map((s) => ({ day: s.day, value: s.value })),
    count: inWindow.length,
    mean: m,
    median: median(values),
    stdDev: stdDev(values),
    priorMean: pm,
    changePercent,
    direction:
      changePercent === null
        ? 'unknown'
        : Math.abs(changePercent) < flatPercent
          ? 'flat'
          : changePercent > 0
            ? 'up'
            : 'down',
    /**
     * The change point is looked for over the WHOLE series, not the window.
     *
     * A shift that began ten weeks ago is invisible inside a four-week window —
     * every day in it is on the new level, so the window is perfectly stable and
     * reports nothing. That is the exact failure the Tuesday-departure case
     * exists to catch, and it is why this one statistic ignores the window that
     * every other statistic here respects.
     */
    changePoint: changePoint(samples),
    computedAt: now.toISOString(),
    modelVersion: VERSIONS.temporal,
  }
}

// ── The series, per domain ───────────────────────────────────────────────────

/**
 * HOW MANY EPISODES WITH PEOPLE IN THEM, PER DAY.
 *
 * Counted from EPISODES rather than from calendar rows, deliberately. A calendar
 * row is a plan; an episode is the thing that happened, and a recurring invite
 * that he declines every second week should not count as a busy day. It also
 * means a meeting that appears only in the location stream — which is most of
 * them for most people — is counted like any other.
 *
 * Days with none are emitted as ZERO, not omitted. A quiet Thursday is data
 * about Thursdays; leaving it out would make the average over "days that had
 * meetings" and would make it impossible to notice that a week was empty.
 */
export function calendarLoadSeries(store: MemoryStore, from: string, to: string, timeZone?: string): Sample[] {
  const byDay = new Map<string, { value: number; ids: string[] }>()
  for (let day = from; day <= to; day = addDays(day, 1)) byDay.set(day, { value: 0, ids: [] })

  for (const ep of store.episodes.between(`${from}T00:00:00.000Z`, `${addDays(to, 1)}T00:00:00.000Z`)) {
    if (ep.status === 'cancelled') continue
    if (!ep.participantEntityIds.length) continue
    const day = dayIn(new Date(ep.startAt), timeZone)
    const bucket = byDay.get(day)
    if (!bucket) continue
    bucket.value += 1
    bucket.ids.push(ep.id)
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, value: b.value, evidenceIds: b.ids }))
}

/** Steps per day, straight off the normalised measurements. */
export function activitySeries(store: MemoryStore, metric = 'steps'): Sample[] {
  const byDay = new Map<string, { value: number; ids: string[] }>()
  for (const o of store.observations.ofType('activity_measurement')) {
    if (o.attributes.metric !== metric) continue
    const day = typeof o.attributes.day === 'string' ? o.attributes.day : null
    const value = typeof o.attributes.value === 'number' ? o.attributes.value : null
    if (!day || value === null) continue
    /**
     * The NEWEST observation for a day wins, which is the merge rule
     * `activity.ts` documents at length: syncs write overlapping windows, and
     * taking the first would freeze a partial day's count forever.
     */
    byDay.set(day, { value, ids: [o.id] })
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, value: b.value, evidenceIds: b.ids }))
}

/**
 * WHERE HE SLEEPS, WORKED OUT RATHER THAN CONFIGURED.
 *
 * Home is the place he is most often present in the small hours. Not the place
 * with the most total minutes — an office can beat a home on a working week —
 * and not a setting, because a setting is one more thing to be wrong and stale.
 *
 * Deliberately NOT stored as a fact about him. `identity.home` in the live world
 * model is already corrupted prose from an earlier pass, and adding a second
 * competing claim would leave two answers to one question. This is a derivation
 * that runs when needed and says what the location data says today.
 */
export function homePlaceId(store: MemoryStore, timeZone?: string): string | null {
  const minutes = new Map<string, number>()
  for (const o of store.observations.ofType('location_visit')) {
    const start = o.interval?.start
    const end = o.interval?.end
    if (!start || !end) continue
    const placeId = firstPlaceIdentity(o)
    if (!placeId) continue
    // Present at 03:00 local on the night this visit covers.
    const at = new Date(Date.parse(start) + (Date.parse(end) - Date.parse(start)) / 2)
    const hour = partsIn(at, timeZone).hour
    if (hour >= 4 && hour < 24) continue
    minutes.set(placeId, (minutes.get(placeId) ?? 0) + (Date.parse(end) - Date.parse(start)) / 60_000)
  }
  let best: { id: string; minutes: number } | null = null
  for (const [id, m] of minutes) if (!best || m > best.minutes) best = { id, minutes: m }
  if (!best) return null
  const entity = store.entities.byIdentity(best.id)
  return entity?.id ?? null
}

/** The structured place identity an observation carries, if any. */
function firstPlaceIdentity(o: { entityCandidates?: { kind: string; key?: string | null }[] }): string | null {
  for (const c of o.entityCandidates ?? []) if (c.kind === 'place' && c.key) return c.key
  return null
}

/**
 * WHEN HE LEFT HOME, PER DAY, IN MINUTES PAST HIS MIDNIGHT.
 *
 * The first home visit that ENDS after 04:00 local. Not the first movement of the
 * day, because a two-minute trip to the bins is movement; not the last home
 * visit, because that is when he came back.
 *
 * Days with no home visit at all produce NO SAMPLE rather than a zero. He was
 * away, or the phone was off — and either way "left at 00:00" is a fiction that
 * would drag every average it touched.
 */
export function departureSeries(store: MemoryStore, homeId: string, timeZone?: string): Sample[] {
  const byDay = new Map<string, { minute: number; id: string }>()

  for (const o of store.observations.ofType('location_visit')) {
    const end = o.interval?.end
    if (!end) continue
    /**
     * HOME IS TESTED FIRST, before the earliest-of-the-day comparison.
     *
     * Doing it the other way round — pick the earliest visit that ended, then
     * check whether it was home — silently drops every day on which a shorter
     * errand happened to end before he got back, because that day's candidate is
     * chosen and then rejected and the real departure is never considered.
     */
    const placeKey = firstPlaceIdentity(o)
    if (!placeKey) continue
    const entity = store.entities.byIdentity(placeKey)
    if (!entity || entity.id !== homeId) continue

    const at = new Date(end)
    const parts = partsIn(at, timeZone)
    // Before four in the morning is the end of a night, not the start of a day.
    if (parts.hour < 4) continue
    const day = dayIn(at, timeZone)
    const minute = parts.hour * 60 + parts.minute
    const held = byDay.get(day)
    if (!held || minute < held.minute) byDay.set(day, { minute, id: o.id })
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, held]) => ({ day, value: held.minute, evidenceIds: [held.id] }))
}

/** Days on which any message passed with a given person. Cadence, not warmth. */
export function contactSeries(store: MemoryStore, counterpartyEmail: string): Sample[] {
  const byDay = new Map<string, string[]>()
  for (const o of store.observations.ofType('communication')) {
    if (o.attributes.counterparty !== counterpartyEmail) continue
    const day = (o.occurredAt ?? o.provenance.observedAt).slice(0, 10)
    byDay.set(day, [...(byDay.get(day) ?? []), o.id])
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, ids]) => ({ day, value: 1, evidenceIds: ids }))
}

// ── Scoping ──────────────────────────────────────────────────────────────────

/**
 * The same series, restricted to one weekday.
 *
 * `weekdayOf` is not used here because the samples already carry HIS day string
 * and `clock.ts`'s weekday function is the one that turns a day string into a
 * weekday — reimplementing it with `new Date(day).getDay()` is exactly the
 * mistake `clock.ts` exists to prevent, since that parses as UTC midnight and is
 * one day out for anyone west of Greenwich.
 */
export function onWeekday(samples: Sample[], weekday: number, weekdayOf: (day: string) => number): Sample[] {
  return samples.filter((s) => weekdayOf(s.day) === weekday)
}

/** How far from the middle of a distribution, in standard deviations. */
export function sigmasFrom(value: number, summary: Pick<TemporalSummary, 'mean' | 'stdDev'>): number | null {
  if (summary.mean === null || summary.stdDev === null || summary.stdDev === 0) return null
  return (value - summary.mean) / summary.stdDev
}

/** Whole days between two of his day strings, through `clock.ts`. */
export const spanDays = (from: string, to: string): number => daysBetweenDays(from, to)
