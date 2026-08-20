/**
 * WHERE REALITY DEPARTED FROM WHAT THE MODELS EXPECTED.
 *
 * AN ANOMALY IS EVIDENCE, NOT AN INSIGHT. That sentence is the entire contract of
 * this file and it is worth being blunt about what it rules out: nothing here
 * reaches a screen. Every anomaly is a candidate, every candidate goes through
 * `attention.ts` like everything else, and the overwhelmingly common correct
 * outcome is that it is scored and not shown. §24 says it, and the reason is
 * arithmetic — a system watching a dozen metrics against baselines will find
 * something "unusual" most days, and an app that says so most days is noise with
 * a statistics engine attached.
 *
 * WHAT MAKES ONE WORTH COMPUTING AT ALL: the expectation is written down BEFORE
 * the comparison. Every anomaly here carries `expected` and `observed` and the
 * arithmetic between them, so the sentence a model eventually writes is a
 * rendering of a computation rather than an impression of a chart. That is the
 * difference between "you were unusually inactive" — which the app cannot
 * defend — and "you are 35% below your usual Thursday by four o'clock, and five
 * of your last six similarly-scheduled Thursdays ended low too".
 *
 * THE FOUR KINDS, and why each needs its own detector rather than one generic
 * threshold:
 *
 *   · `routine_missed`   — a rhythm that should have fired today and has not.
 *     Absence is invisible to any detector that looks at what happened.
 *   · `routine_timing`   — it fired, at a time the distribution did not expect.
 *   · `baseline_deviation` — a measured number away from the right population's
 *     mean. The RIGHT population is the load-bearing word: Thursdays against
 *     Thursdays, not against all days.
 *   · `change_point`     — not a day at all, but a level shift. Fundamentally
 *     different from the other three and the most valuable of them, because it is
 *     the only one that describes something ongoing.
 */

import { addDays, dayIn, partsIn, weekdayOf } from '../clock.js'
import { hash, idOf } from './ids.js'
import { sigmasFrom, type Sample } from './temporal.js'
import type { Anomaly, EvidenceRef, MemoryStore, TemporalSummary } from './types.js'

/**
 * How far out of the ordinary something has to be before it is worth naming.
 *
 * Two standard deviations. Against a roughly normal spread that is about one day
 * in twenty — rare enough that it is not the ordinary state of affairs, common
 * enough that a genuine change is caught within a fortnight rather than a
 * quarter. It is a threshold on COMPUTING the anomaly, not on showing it;
 * `attention.ts` has a much higher bar than this and is the one that matters.
 */
const DEVIATION_SIGMAS = 2

/**
 * A routine has to be at least this likely on a day before its absence is
 * remarkable.
 *
 * Below 0.6, "it did not happen" is the ordinary case and reporting it would be
 * reporting the coin landing tails. This is the same number as
 * `ESTABLISHED_PROBABILITY` in `routines.ts` and deliberately so: a rhythm we
 * would not call established is a rhythm whose absence means nothing.
 */
const MISSABLE_PROBABILITY = 0.6

const anomalyId = (kind: string, subject: string, day: string): string =>
  idOf('anm', kind, day, hash(subject))

export interface AnomalyOptions {
  timeZone?: string
  /** The day to examine. Defaults to the day `now` falls in, in his zone. */
  day?: string
}

/**
 * Everything unusual about one day, from the models as they currently stand.
 *
 * Pure with respect to storage — it reads and writes nothing — so the whole
 * detector can be tested against a hand-built store, and so a caller can ask
 * "what would have been unusual about the 3rd of June" without side effects.
 */
export function detectAnomalies(
  store: MemoryStore,
  now: Date,
  summaries: TemporalSummary[],
  series: Record<string, Sample[]>,
  opts: AnomalyOptions = {}
): Anomaly[] {
  const day = opts.day ?? dayIn(now, opts.timeZone)
  const weekday = weekdayOf(day)
  const out: Anomaly[] = []

  // ── routines that should have happened ──
  const dayStart = `${day}T00:00:00.000Z`
  const dayEnd = `${addDays(day, 1)}T00:00:00.000Z`
  const episodes = store.episodes.between(dayStart, dayEnd).filter((e) => e.status !== 'cancelled')

  for (const routine of store.routines.all()) {
    const days = routine.temporal.daysOfWeek
    if (!days?.includes(weekday)) continue
    if (routine.temporal.recurrenceProbability < MISSABLE_PROBABILITY) continue
    if (routine.status === 'candidate' || routine.status === 'inactive') continue

    const match = episodes.find((e) => matchesRoutine(e.placeEntityIds, e.participantEntityIds, e.type, routine.activityType))
    const label = String(routine.context.label ?? routine.activityType)

    if (!match) {
      /**
       * The day has to be OVER before absence means anything.
       *
       * Reporting a missed Saturday shop at nine in the morning is reporting that
       * it is nine in the morning. The routine's own typical start plus its own
       * spread is the honest deadline — a rhythm with a wide spread waits longer,
       * which is exactly right.
       */
      const deadline = expectedByMinute(routine.temporal)
      const nowMinutes = minuteOfDayIn(now, opts.timeZone)
      const today = dayIn(now, opts.timeZone)
      if (day === today && deadline !== null && nowMinutes < deadline) continue

      out.push({
        id: anomalyId('routine_missed', routine.id, day),
        kind: 'routine_missed',
        subject: routine.id,
        day,
        expected: label,
        observed: null,
        magnitude: routine.temporal.recurrenceProbability,
        why: `${label} happens on ${Math.round(routine.temporal.recurrenceProbability * 100)}% of these days and has not today`,
        confidence: routine.confidence,
        evidence: [{ kind: 'routine', id: routine.id, says: `${routine.evidenceCount} occasions over ${routine.temporalCoverageDays} days` }],
      })
      continue
    }

    // ── it happened, but when? ──
    const centre = routine.temporal.typicalStartMinutes
    const spread = routine.temporal.startStdDevMinutes
    const actual = match.attributes.minuteOfDay
    if (centre === undefined || spread === undefined || spread === 0 || typeof actual !== 'number') continue
    const sigmas = (actual - centre) / spread
    if (Math.abs(sigmas) < DEVIATION_SIGMAS) continue

    out.push({
      id: anomalyId('routine_timing', routine.id, day),
      kind: 'routine_timing',
      subject: routine.id,
      day,
      expected: Math.round(centre),
      observed: actual,
      magnitude: Math.abs(actual - centre),
      why: `usually within ${Math.round(spread)} minutes of ${Math.round(centre)}; today was ${Math.round(Math.abs(sigmas))} deviations out`,
      confidence: routine.confidence,
      evidence: [
        { kind: 'routine', id: routine.id, says: `typical start ${Math.round(centre)} ± ${Math.round(spread)}` },
        { kind: 'episode', id: match.id, says: `started at ${actual}` },
      ],
    })
  }

  // ── measured numbers against the right population ──
  for (const summary of summaries) {
    const samples = series[summary.metric]
    if (!samples) continue
    const todaySample = samples.find((s) => s.day === day)
    if (!todaySample) continue
    /**
     * SCOPE MUST MATCH, or the comparison is meaningless.
     *
     * A weekday-scoped summary is only allowed to judge a day of that weekday.
     * Without this a Thursday baseline would be applied to a Sunday and the app
     * would announce a deviation every weekend, forever, with perfect arithmetic.
     */
    const scoped = /^weekday:(\d)$/.exec(summary.scope)
    if (scoped && Number(scoped[1]) !== weekday) continue

    const sigmas = sigmasFrom(todaySample.value, summary)
    if (sigmas === null || Math.abs(sigmas) < DEVIATION_SIGMAS) continue

    out.push({
      id: anomalyId('baseline_deviation', `${summary.domain}:${summary.metric}:${summary.scope}`, day),
      kind: 'baseline_deviation',
      subject: `${summary.domain}.${summary.metric}`,
      day,
      expected: summary.mean === null ? null : Math.round(summary.mean),
      observed: Math.round(todaySample.value),
      magnitude: summary.mean === null ? 0 : Math.abs(todaySample.value - summary.mean),
      why: `${summary.count} comparable days average ${Math.round(summary.mean ?? 0)}; today is ${sigmas > 0 ? 'above' : 'below'} by ${Math.abs(sigmas).toFixed(1)} deviations`,
      /**
       * CONFIDENCE FALLS WITH A THIN BASELINE. Five days is a number, not a
       * baseline, and a deviation from it is mostly a statement about how little
       * has been seen. This is the axis `attention.ts` reads.
       */
      confidence: Math.min(0.9, 0.3 + summary.count * 0.02),
      evidence: [
        { kind: 'observation', id: todaySample.evidenceIds[0] ?? day, says: `${day}: ${todaySample.value}` },
        ...(summary.samples.slice(-4).map((s) => ({ kind: 'observation' as const, id: `${summary.id}:${s.day}`, says: `${s.day}: ${s.value}` }))),
      ],
    })
  }

  // ── level shifts, which are not about today at all ──
  for (const summary of summaries) {
    const change = summary.changePoint
    if (!change) continue
    out.push({
      id: anomalyId('change_point', `${summary.domain}:${summary.metric}:${summary.scope}`, change.day),
      kind: 'change_point',
      subject: `${summary.domain}.${summary.metric}`,
      day: change.day,
      expected: Math.round(change.before),
      observed: Math.round(change.after),
      magnitude: Math.abs(change.magnitude),
      why: `steady around ${Math.round(change.before)} until ${change.day}, around ${Math.round(change.after)} since`,
      confidence: Math.min(0.8, 0.3 + (summary.samples.length ?? 0) * 0.02),
      /**
       * THE EVIDENCE IS THE READINGS, NOT THE SUMMARY THAT AVERAGED THEM.
       *
       * The first version cited the summary's own id, which reads perfectly well
       * and fails §39: a summary is not in any evidence chain the tracer can
       * follow, so the one candidate on the screen with a genuinely interesting
       * claim was the one candidate whose evidence bottomed out in nothing. Citing
       * the actual observations on either side of the change point is both more
       * traceable and more honest — those are the days the claim rests on.
       */
      evidence: changeEvidence(series[summary.metric] ?? [], change.day),
    })
  }

  // ── predictions we got wrong ──
  out.push(...predictionMisses(store, day))

  return out.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
}

/**
 * A MISSED PREDICTION IS AN ANOMALY IN ITS OWN RIGHT.
 *
 * §16's argument, turned into a detector. Everything the app knows went into the
 * expectation, so a miss is a far denser signal than a raw deviation: it says
 * that a specific named model was wrong about a specific day by a measurable
 * amount. This is what makes prediction error something the system spends
 * attention on rather than merely records.
 *
 * `unverifiable` outcomes are excluded — the phone being off is not a surprise
 * about his life.
 */
function predictionMisses(store: MemoryStore, day: string): Anomaly[] {
  const byId = new Map(store.predictions.all().map((p) => [p.id, p]))
  const out: Anomaly[] = []

  for (const outcome of store.predictions.outcomes()) {
    if (outcome.calibrationResult !== 'incorrect') continue
    const p = byId.get(outcome.predictionId)
    if (!p) continue
    const about = p.target.kind === 'episode_occurs' ? p.target.day : p.target.day
    if (about !== day) continue

    const evidence: EvidenceRef[] = [
      { kind: 'prediction', id: p.id, says: `expected ${JSON.stringify(p.expected)}` },
      ...outcome.evidence,
    ]
    out.push({
      id: anomalyId('prediction_miss', p.id, day),
      kind: 'prediction_miss',
      subject: p.target.kind,
      day,
      expected: typeof p.expected === 'number' || typeof p.expected === 'string' ? p.expected : String(p.expected),
      observed:
        typeof outcome.observedReality === 'number' || typeof outcome.observedReality === 'string'
          ? outcome.observedReality
          : String(outcome.observedReality),
      magnitude: typeof outcome.error === 'number' ? Math.abs(outcome.error) : 1,
      why: `expected ${JSON.stringify(p.expected)}, observed ${JSON.stringify(outcome.observedReality)}`,
      confidence: p.confidence,
      evidence,
    })
  }
  return out
}

/**
 * Does this episode belong to that routine?
 *
 * The same key vocabulary `routines.ts` mints, read back. Kept as one function so
 * a change to how routines are keyed cannot leave the detector matching nothing —
 * which would show up as "no routine ever misses", the quietest possible failure.
 */
function matchesRoutine(places: string[], participants: string[], type: string, activityType: string): boolean {
  if (activityType.startsWith('place:')) return places.includes(activityType.slice(6))
  if (activityType.startsWith('person:')) return participants.includes(activityType.slice(7))
  if (activityType.startsWith('type:')) return type === activityType.slice(5)
  return false
}

/**
 * A few readings from each side of a change point.
 *
 * Both sides deliberately: the claim is "it was one level and is now another",
 * and evidence drawn only from the new level would support "it is this level now"
 * — a different and much weaker statement.
 */
function changeEvidence(samples: Sample[], day: string): EvidenceRef[] {
  const before = samples.filter((s) => s.day < day).slice(-3)
  const after = samples.filter((s) => s.day >= day).slice(0, 3)
  return [...before, ...after].map((s) => ({
    kind: 'observation' as const,
    id: s.evidenceIds[0] ?? s.day,
    says: `${s.day}: ${s.value}`,
  }))
}

/** Typical start plus one spread: the point after which absence is informative. */
function expectedByMinute(t: { typicalStartMinutes?: number; startStdDevMinutes?: number }): number | null {
  if (t.typicalStartMinutes === undefined) return null
  return t.typicalStartMinutes + (t.startStdDevMinutes ?? 60)
}

/**
 * Minutes past HIS midnight.
 *
 * Through `partsIn`, which is the only thing in the codebase that knows what time
 * it is where he is standing. Subtracting a UTC midnight from an instant would
 * have been two lines shorter and two hours wrong on the edge — the same class of
 * error the `timeZone` field on `World` exists to record, and the reason nothing
 * in this directory does its own clock arithmetic.
 */
function minuteOfDayIn(now: Date, timeZone?: string): number {
  const parts = partsIn(now, timeZone)
  return parts.hour * 60 + parts.minute
}
