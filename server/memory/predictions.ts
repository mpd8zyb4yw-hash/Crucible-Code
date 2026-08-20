/**
 * COMMITTING TO AN EXPECTATION, AND THEN GOING BACK TO CHECK.
 *
 * §16 is the most important design claim in the handoff and it is worth stating
 * in this file's own terms, because it is what makes everything else here
 * something other than statistics for their own sake:
 *
 *     Asking a language model to find something interesting in an entire life is
 *     an unbounded search over a corpus it cannot verify. Asking whether reality
 *     matched a specific prior expectation is a bounded question with a right
 *     answer.
 *
 * The second is cheap, it is checkable, and — this is the part that matters — it
 * makes the SYSTEM improvable. A missed prediction says exactly which model was
 * wrong and by how much, in the model's own units. Nothing else in this app
 * produces that signal. Confidence decay in `world.ts` says how long since anyone
 * looked; a prediction outcome says whether we were right.
 *
 * THE SEPARATION THAT MUST NEVER BE COLLAPSED — §19, §38.
 *
 * A prediction outcome measures OUR MODEL. A recommendation outcome measures HIS
 * RESPONSE. They are different evidence about different things and they live in
 * different tables:
 *
 *     We said he would leave by 10:45. He left at noon.
 *         → our model of his Tuesdays is wrong. He did nothing; he was not asked
 *           anything; he may never have seen a screen that day.
 *
 *     We said "leave by 10:45 to arrive comfortably". He dismissed it.
 *         → he does not want travel nudges, or not that one. Says nothing at all
 *           about whether the timing was right.
 *
 * Folding the first into `person.ts`'s engagement counters would teach the
 * proactivity loop that he dislikes travel advice because the weather was bad.
 * Folding the second into calibration would teach the world model that his
 * Tuesdays are unpredictable because he was busy. Both are silent, both are
 * plausible, and both would be very hard to find later — which is why the two
 * are in separate files with no import between them.
 */

import { addDays, dayIn, weekdayOf } from '../clock.js'
import { hash, idOf } from './ids.js'
import { median, stdDev, type Sample } from './temporal.js'
import {
  VERSIONS,
  type EvidenceRef,
  type MemoryStore,
  type Prediction,
  type PredictionOutcome,
  type RoutineModel,
  type TypedPredictionTarget,
} from './types.js'

/**
 * A routine has to be at least emerging before it is allowed to predict.
 *
 * A `candidate` routine is two sightings. Predicting from it would produce a
 * stream of misses that the calibration record would faithfully log, and the
 * resulting picture — "this system is wrong most of the time" — would be a fact
 * about the threshold rather than about the models. Prediction is for things
 * we actually expect.
 */
const PREDICTABLE = new Set<RoutineModel['status']>(['emerging', 'established', 'weakening'])

/** Above this, the outcome carries no information. See the call site. */
const CERTAIN_ENOUGH = 0.95

/**
 * How wide an interval a timing prediction commits to.
 *
 * 1.5 standard deviations, floored at twenty minutes. The floor is the honest
 * part: a routine whose observed spread is four minutes is not really predictable
 * to four minutes, it is a routine we have not yet seen fail, and committing to a
 * four-minute window would generate misses that say more about optimism than
 * about him. The multiplier covers roughly seven days in eight of a normal
 * spread, which is what "likely" should mean if the word is to be used.
 */
const TIMING_SIGMAS = 1.5
const TIMING_FLOOR_MINUTES = 20

export interface PredictionRun {
  made: string[]
  resolved: { id: string; result: PredictionOutcome['calibrationResult']; error?: number | null }[]
  /** Models that could have predicted and were not allowed to, with the reason. */
  declined: { about: string; why: string }[]
}

// ── Making them ──────────────────────────────────────────────────────────────

const predictionId = (t: TypedPredictionTarget, windowStart: string): string =>
  idOf('prd', hash(`${JSON.stringify(t)}|${windowStart}`))

/**
 * Predict tomorrow, from every routine and baseline that is entitled to.
 *
 * Deliberately ONE DAY AHEAD. A prediction is only useful if it can be resolved
 * while the model that made it is still the model in force, and a fortnight of
 * pending predictions resolving against a routine that has since been relearned
 * measures nothing anybody can act on.
 */
export function makePredictions(
  store: MemoryStore,
  now: Date,
  opts: { timeZone?: string; departures?: Sample[] } = {}
): PredictionRun {
  const run: PredictionRun = { made: [], resolved: [], declined: [] }
  const today = dayIn(now, opts.timeZone)
  const day = addDays(today, 1)
  const weekday = weekdayOf(day)
  const windowStart = `${day}T00:00:00.000Z`
  const windowEnd = `${addDays(day, 1)}T00:00:00.000Z`
  const out: Prediction[] = []

  // ── will a routine occur tomorrow? ──
  for (const routine of store.routines.all()) {
    if (!PREDICTABLE.has(routine.status)) {
      run.declined.push({ about: routine.id, why: `status ${routine.status} is not enough to expect anything` })
      continue
    }
    const days = routine.temporal.daysOfWeek
    if (!days?.includes(weekday)) continue

    /**
     * A NEAR-CERTAINTY IS NOT WORTH PREDICTING.
     *
     * Found by running this over the fixture: the strongest routine in the data
     * was "he is at home", at p=0.98, on all seven days. It generated a correct
     * prediction every single day and carried the `episode_occurs` hit rate to
     * 0.91 — a number that described the trivial routine rather than the model,
     * and which then fed back through `calibrationFactor` to make every other
     * prediction more confident on the strength of it.
     *
     * The bar is INFORMATION, not correctness. A prediction whose outcome was
     * never in doubt teaches nothing when it lands and is not worth the row; a
     * routine at 0.7 is a real expectation whose failures are real signal. So the
     * band is bounded at both ends, and the routines excluded at the top are
     * excluded for being too reliable — which is worth saying in the log rather
     * than looking like they were forgotten.
     */
    if (routine.temporal.recurrenceProbability > CERTAIN_ENOUGH) {
      run.declined.push({
        about: routine.id,
        why: `happens ${Math.round(routine.temporal.recurrenceProbability * 100)}% of the time — predicting it would measure nothing`,
      })
      continue
    }

    const target: TypedPredictionTarget = { kind: 'episode_occurs', activityType: routine.activityType, day }
    out.push({
      id: predictionId(target, windowStart),
      target,
      createdAt: now.toISOString(),
      resolutionWindow: { start: windowStart, end: windowEnd },
      expected: true,
      probability: routine.temporal.recurrenceProbability,
      evidence: routine.evidence.slice(-4),
      modelBasis: [routine.id],
      /**
       * CONFIDENCE IS THE ROUTINE'S, TEMPERED BY OUR OWN TRACK RECORD.
       *
       * This is the loop §33 asks for closing: a model whose predictions of this
       * kind have been missing gets less confident, without anybody editing a
       * threshold. It is applied to the CONFIDENCE and not to the PROBABILITY,
       * because those are different claims — how often he does it, versus how
       * much we trust ourselves about it.
       */
      confidence: routine.confidence * calibrationFactor(store, 'episode_occurs', routine.activityType),
      status: 'pending',
      modelVersion: VERSIONS.prediction,
    })
    run.made.push(`${routine.activityType} on ${day} (p=${routine.temporal.recurrenceProbability.toFixed(2)})`)
  }

  // ── when will he leave tomorrow? ──
  const departures = opts.departures ?? []
  const sameWeekday = departures.filter((s) => weekdayOf(s.day) === weekday)
  /**
   * The RECENT half of the same weekday, not all of it.
   *
   * The Tuesday case is the reason: a departure time that shifted five weeks ago
   * has a bimodal history, and the median over the whole of it lands between the
   * two levels — a prediction that was never true on any Tuesday, before or
   * after. Taking the recent half tracks the current level. This is the crudest
   * possible answer to a real problem and it is chosen over the correct one
   * (predict from the segment after the change point) because the change point is
   * itself a hypothesis, and a prediction that depends on a hypothesis being right
   * cannot be used to test whether the hypothesis is right.
   */
  const recent = sameWeekday.slice(-Math.max(4, Math.ceil(sameWeekday.length / 2)))
  if (recent.length >= 4) {
    const values = recent.map((s) => s.value)
    const centre = median(values)!
    const spread = Math.max(TIMING_FLOOR_MINUTES, (stdDev(values) ?? TIMING_FLOOR_MINUTES) * TIMING_SIGMAS)
    const target: TypedPredictionTarget = { kind: 'timing', metric: 'departure_minute', day, scope: `weekday:${weekday}` }
    out.push({
      id: predictionId(target, windowStart),
      target,
      createdAt: now.toISOString(),
      resolutionWindow: { start: windowStart, end: windowEnd },
      expected: centre,
      interval: { lower: centre - spread, upper: centre + spread },
      evidence: recent.slice(-6).map((s) => ({ kind: 'observation' as const, id: s.evidenceIds[0] ?? s.day, says: `${s.day}: ${s.value}` })),
      modelBasis: [`tmp:location:departure_minute:weekday:${weekday}`],
      /* Scoped to this weekday's departure model — `subjectOf` folds the scope
         in, so his Tuesdays earn their own record rather than sharing one with
         every other day. Same argument as the scope on the baseline it reads. */
      confidence: Math.min(0.8, 0.3 + recent.length * 0.05) * calibrationFactor(store, 'timing', subjectOf(target)),
      status: 'pending',
      modelVersion: VERSIONS.prediction,
    })
    run.made.push(`departure on ${day} around ${Math.round(centre)} ±${Math.round(spread)}`)
  } else if (sameWeekday.length) {
    run.declined.push({ about: 'departure_minute', why: `${recent.length} recent same-weekday samples is under 4` })
  }

  if (out.length) store.predictions.put(out)
  return run
}

// ── Resolving them ───────────────────────────────────────────────────────────

/**
 * Settle every prediction whose window has closed.
 *
 * REALITY RESOLVES THESE, NOT HIM. He does not have to see, open, accept or
 * dismiss anything — which is precisely why the result must never reach the
 * engagement model. See the file header.
 */
export function resolvePredictions(
  store: MemoryStore,
  now: Date,
  opts: { timeZone?: string; departures?: Sample[] } = {}
): PredictionRun {
  const run: PredictionRun = { made: [], resolved: [], declined: [] }
  const due = store.predictions.due(now.toISOString())
  if (!due.length) return run

  const outcomes: PredictionOutcome[] = []
  const settled: Prediction[] = []

  for (const p of due) {
    const outcome = resolveOne(store, p, opts)
    outcomes.push(outcome)
    settled.push({ ...p, status: outcome.calibrationResult === 'unverifiable' ? 'unverifiable' : 'resolved' })
    run.resolved.push({ id: p.id, result: outcome.calibrationResult, error: outcome.error })
  }

  store.predictions.putOutcome(outcomes)
  store.predictions.put(settled)
  return run
}

function resolveOne(store: MemoryStore, p: Prediction, opts: { timeZone?: string; departures?: Sample[] }): PredictionOutcome {
  const id = idOf('pro', p.id.replace(/^prd:/, ''))
  const resolvedAt = p.resolutionWindow.end

  if (p.target.kind === 'episode_occurs') {
    const day = p.target.day
    const episodes = store.episodes.between(`${day}T00:00:00.000Z`, `${addDays(day, 1)}T00:00:00.000Z`)
    const match = episodes.find(
      (e) =>
        e.status !== 'cancelled' &&
        (e.placeEntityIds.some((x) => p.target.kind === 'episode_occurs' && p.target.activityType === `place:${x}`) ||
          e.participantEntityIds.some((x) => p.target.kind === 'episode_occurs' && p.target.activityType === `person:${x}`) ||
          (p.target.kind === 'episode_occurs' && p.target.activityType === `type:${e.type}`))
    )
    return {
      id,
      predictionId: p.id,
      observedReality: !!match,
      resolvedAt,
      error: null,
      /**
       * NO `partially_correct` FOR A YES/NO QUESTION. Either the thing happened
       * or it did not, and a middle grade here would exist only to make the hit
       * rate look better.
       */
      calibrationResult: match ? 'correct' : 'incorrect',
      evidence: match ? [{ kind: 'episode', id: match.id, says: `${match.type} at ${match.startAt}` }] : [],
    }
  }

  if (p.target.kind === 'timing') {
    const sample = (opts.departures ?? []).find((s) => s.day === (p.target.kind === 'timing' ? p.target.day : ''))
    if (!sample) {
      /**
       * NOT A MISS. The phone was off, he was away, the source did not report.
       * Scoring absence as error would make the calibration record a measure of
       * data coverage, and every improvement to a connector would look like an
       * improvement to the model.
       */
      return {
        id,
        predictionId: p.id,
        observedReality: null,
        resolvedAt,
        error: null,
        calibrationResult: 'unverifiable',
        evidence: [],
      }
    }
    const expected = typeof p.expected === 'number' ? p.expected : Number(p.expected)
    const error = sample.value - expected
    const inside = p.interval ? sample.value >= p.interval.lower && sample.value <= p.interval.upper : false
    const width = p.interval ? (p.interval.upper - p.interval.lower) / 2 : TIMING_FLOOR_MINUTES
    return {
      id,
      predictionId: p.id,
      observedReality: sample.value,
      resolvedAt,
      error,
      calibrationResult: inside ? 'correct' : Math.abs(error) <= width * 2 ? 'partially_correct' : 'incorrect',
      evidence: [{ kind: 'observation', id: sample.evidenceIds[0] ?? sample.day, says: `left at ${sample.value}` }],
    }
  }

  // measure
  const day = p.target.day
  const observations = store.observations
    .ofType('activity_measurement')
    .filter((o) => o.attributes.day === day && o.attributes.metric === (p.target.kind === 'measure' ? p.target.metric : ''))
  const value = observations.length ? Number(observations[observations.length - 1]!.attributes.value) : null
  if (value === null) {
    return { id, predictionId: p.id, observedReality: null, resolvedAt, error: null, calibrationResult: 'unverifiable', evidence: [] }
  }
  const expected = typeof p.expected === 'number' ? p.expected : Number(p.expected)
  const error = value - expected
  const inside = p.interval ? value >= p.interval.lower && value <= p.interval.upper : false
  return {
    id,
    predictionId: p.id,
    observedReality: value,
    resolvedAt,
    error,
    calibrationResult: inside ? 'correct' : 'incorrect',
    evidence: observations.slice(-1).map((o) => ({ kind: 'observation' as const, id: o.id, says: `${day}: ${value}` })),
  }
}

// ── Calibration ──────────────────────────────────────────────────────────────

/**
 * THE POPULATION A TRACK RECORD IS MEASURED OVER.
 *
 * `episode_occurs` for the Saturday shop and `episode_occurs` for a fortnightly
 * lunch are the same KIND and are not the same model. Pooling them gives one
 * number that describes neither, and because `calibrationFactor` feeds that
 * number back into the next prediction's confidence, the pooling is not merely
 * imprecise — it is a channel through which an unreliable routine lowers a
 * reliable one's confidence and a reliable one props up an unreliable one.
 *
 * §7 already makes this argument about baselines: "His Thursdays is a different
 * population from his days. Comparing a Thursday to an all-days mean produces a
 * permanent false alarm every Monday." It was never applied to calibration, and
 * it could not show while the fixture had exactly one routine in it — which it
 * did, because the block that would have added a second was unsatisfiable. The
 * first time a second routine existed, the pooled hit rate for a p=0.89 routine
 * came out at 0.52.
 *
 * §9 has already paid for this once from the other direction: "he is at home"
 * at 0.98 "carried the `episode_occurs` hit rate to 0.91 — a number describing
 * the trivial routine, which then fed back and made every other prediction more
 * confident". The fix then was to stop predicting above p=0.95, which removed
 * that symptom. The cause was the pooling, and this is the cause.
 */
export const subjectOf = (t: TypedPredictionTarget): string =>
  t.kind === 'episode_occurs' ? t.activityType : `${t.metric}${t.scope ? `@${t.scope}` : ''}`

export interface Calibration {
  kind: string
  /** The model this record is about, or null for the whole kind. See `subjectOf`. */
  subject: string | null
  resolved: number
  correct: number
  partial: number
  incorrect: number
  unverifiable: number
  /** Correct as a fraction of VERIFIABLE outcomes. Null below any evidence. */
  hitRate: number | null
  /** Mean signed error, for numeric targets. Bias, not accuracy. */
  bias: number | null
}

/**
 * HOW OFTEN WE HAVE BEEN RIGHT ABOUT THIS KIND OF THING.
 *
 * `unverifiable` is excluded from the denominator, per the note in `resolveOne`.
 * The SIGNED mean error is kept as well as the hit rate because the two say
 * different things: a model that is right half the time and unbiased needs a
 * wider interval, and one that is late every single time needs a different
 * centre. Averaging the absolute error would hide the second entirely.
 */
export function calibrationFor(store: MemoryStore, kind: string, subject?: string): Calibration {
  const byId = new Map(store.predictions.all().map((p) => [p.id, p]))
  const rows = store.predictions.outcomes().filter((o) => {
    const target = byId.get(o.predictionId)?.target
    if (!target || target.kind !== kind) return false
    return subject === undefined || subjectOf(target) === subject
  })

  const correct = rows.filter((r) => r.calibrationResult === 'correct').length
  const partial = rows.filter((r) => r.calibrationResult === 'partially_correct').length
  const incorrect = rows.filter((r) => r.calibrationResult === 'incorrect').length
  const unverifiable = rows.filter((r) => r.calibrationResult === 'unverifiable').length
  const verifiable = correct + partial + incorrect
  const errors = rows.map((r) => r.error).filter((e): e is number => typeof e === 'number')

  return {
    kind,
    subject: subject ?? null,
    resolved: rows.length,
    correct,
    partial,
    incorrect,
    unverifiable,
    hitRate: verifiable ? correct / verifiable : null,
    bias: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
  }
}

/**
 * The multiplier a model's own history earns it.
 *
 * BOUNDED IN BOTH DIRECTIONS AND NEUTRAL UNTIL THERE IS EVIDENCE, in the same
 * spirit as `engagementBiasOf`: below five resolutions it returns 1, and it can
 * never fall below 0.6 or rise above 1.1. A feedback loop with no floor drives
 * its own inputs to zero after a bad week and then has no way back, because a
 * model that is never confident enough to predict never generates the evidence
 * that would restore it.
 */
export function calibrationFactor(store: MemoryStore, kind: string, subject?: string): number {
  const bounded = (c: Calibration): number | null => {
    const verifiable = c.correct + c.partial + c.incorrect
    if (verifiable < MIN_RESOLUTIONS || c.hitRate === null) return null
    return Math.max(0.6, Math.min(1.1, 0.6 + c.hitRate * 0.5))
  }

  /*
    ITS OWN RECORD FIRST, THE KIND'S ONLY AS A FALLBACK.

    A model with five resolutions of its own is judged on them. Below that there
    is not enough to say anything about this routine specifically, and the kind's
    pool is a better prior than nothing — but it is a PRIOR, used while the model
    is new, rather than the answer it keeps getting forever. Falling back the
    other way round would be the pooling this scoping exists to remove.
  */
  const own = subject === undefined ? null : bounded(calibrationFor(store, kind, subject))
  return own ?? bounded(calibrationFor(store, kind)) ?? 1
}

/** Below this a track record is too short to say anything. See `calibrationFactor`. */
const MIN_RESOLUTIONS = 5

/** One line about a prediction, for a card or a log. Composed, never generated. */
export function predictionSentence(p: Prediction, label: (id: string) => string = (x) => x): string {
  if (p.target.kind === 'episode_occurs') {
    const chance = p.probability === undefined ? '' : ` (${Math.round(p.probability * 100)}% of the time lately)`
    return `${label(p.target.activityType)} on ${p.target.day}${chance}`
  }
  if (p.target.kind === 'timing') {
    const lower = p.interval ? clockOf(p.interval.lower) : '?'
    const upper = p.interval ? clockOf(p.interval.upper) : '?'
    return `leaving between ${lower} and ${upper} on ${p.target.day}`
  }
  return `${p.target.metric} on ${p.target.day} around ${String(p.expected)}`
}

function clockOf(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Evidence pointing at a prediction, for anything citing one. */
export const predictionEvidence = (p: Prediction): EvidenceRef => ({
  kind: 'prediction',
  id: p.id,
  says: predictionSentence(p),
})
