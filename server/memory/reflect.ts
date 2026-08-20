/**
 * THINKING WITHOUT BEING ASKED, AND THINKING INCREMENTALLY.
 *
 * Everything else in this directory is a pure function of some evidence. This is
 * the file that decides WHEN each of them runs and OVER WHAT — which is where a
 * cognitive architecture usually quietly becomes a full table scan on a cron.
 *
 * FOUR CADENCES, because the stages genuinely differ in cost and in how fast
 * their answers go stale:
 *
 *   · `ingest` — on arrival. Normalise, resolve, assemble the days touched.
 *     Bounded by what arrived; runs in milliseconds; must be safe to run twenty
 *     times an hour.
 *   · `short`  — every quarter hour or so. Resolve predictions whose windows have
 *     closed, and look at today. Cheap, and the only stage with a deadline: a
 *     prediction that resolves a day late has stopped being a signal.
 *   · `daily`  — recompute baselines, relearn routines, re-evaluate hypotheses,
 *     make tomorrow's predictions. Reads a lot; runs once.
 *   · `weekly` — the long view: change points over the whole history, relationship
 *     cadence, hypotheses that need months of coverage to move.
 *
 * WHAT MAKES IT INCREMENTAL is `cursors`. Ingestion reads events with
 * `observed_at > cursor`, which is an index seek rather than a scan, and the
 * cursor moves only when the work has landed. The stages that are NOT incremental
 * — routine learning, hypothesis evaluation — are deliberately not, and the
 * reason is in `routines.ts`: their correctness depends on the whole span, they
 * number in the tens, and making them incremental would trade the replay property
 * for a saving nobody can measure.
 *
 * FAILURE IS RECORDED, NOT SWALLOWED. §41: raw evidence survives, partial derived
 * writes do not corrupt anything (every writer is an idempotent upsert), and the
 * run says what went wrong. The cursor is the mechanism that makes a failed run
 * retryable — it does not move, so the next pass does the same work again, and
 * every stage is idempotent so doing it twice is free.
 *
 * ON BOTH HOSTS. `runCycle` knows nothing about Durable Object alarms or launchd.
 * The edge schedules it from an alarm, the Mac from a timer, and both call this.
 * That is the same arrangement `worldRoom.ts` uses and for the same reason: the
 * thing worth testing is the cognition, and a cognition that can only run inside
 * a platform's scheduler cannot be tested at all.
 */

import { dayIn, weekdayOf } from '../clock.js'
import { hash, idOf } from './ids.js'
import { detectAnomalies } from './anomalies.js'
import { assembleEpisodes } from './episodes.js'
import { deriveRelationships, ensureSelf, resolveEntities, SELF_ENTITY_ID } from './entities.js'
import {
  evaluateAssociation,
  proposeAssociations,
  saveHypotheses,
  shiftHypothesis,
  type MetricSeries,
} from './hypotheses.js'
import { normalizeEvents } from './normalize.js'
import { makePredictions, resolvePredictions } from './predictions.js'
import { learnRoutines } from './routines.js'
import {
  activitySeries,
  calendarLoadSeries,
  departureSeries,
  homePlaceId,
  onWeekday,
  summarize,
  type Sample,
} from './temporal.js'
import { VERSIONS, type Anomaly, type MemoryStore, type ReflectionRun, type TemporalSummary } from './types.js'

export interface CycleOptions {
  timeZone?: string
  /** His address, so he is not lifted as somebody in his own life. */
  me?: string
  /** Cap on events read in one ingestion pass. Keeps a backfill from one huge turn. */
  batch?: number
}

export interface CycleResult {
  run: ReflectionRun
  /** Computed this pass, for the caller that wants them without a second read. */
  summaries: TemporalSummary[]
  anomalies: Anomaly[]
  series: Record<string, Sample[]>
}

const INGEST_CURSOR = 'ingest'

/**
 * THE ONE ENTRY POINT.
 *
 * `now` is a parameter, never `new Date()` inside. That is what lets a test drive
 * four months of reflection in a loop, and it is what makes the replay in
 * `rebuild` able to reproduce a sequence of passes exactly — including the
 * predictions, which are the one derived thing whose value depends on when it was
 * computed.
 */
export function runCycle(
  store: MemoryStore,
  kind: ReflectionRun['kind'],
  now: Date,
  opts: CycleOptions = {}
): CycleResult {
  const startedAt = now.toISOString()
  const run: ReflectionRun = {
    // Content-derived, so a re-run at the same instant overwrites rather than
    // filling the log with duplicates of a retried pass.
    id: idOf('run', kind, hash(startedAt)),
    kind,
    startedAt,
    status: 'running',
    counts: {},
    notes: [],
  }
  let summaries: TemporalSummary[] = []
  let anomalies: Anomaly[] = []
  let series: Record<string, Sample[]> = {}

  try {
    ensureSelf(store, startedAt, opts.me ? [`email:${opts.me.toLowerCase()}`] : [])

    if (kind === 'ingest' || kind === 'daily' || kind === 'weekly' || kind === 'rebuild') {
      ingest(store, run, now, opts)
    }

    if (kind !== 'ingest') {
      const computed = temporalPass(store, now, opts)
      summaries = computed.summaries
      series = computed.series
      run.counts.summaries = summaries.length
      if (summaries.length) store.summaries.put(summaries)
    }

    if (kind === 'daily' || kind === 'weekly' || kind === 'rebuild') {
      const learned = learnRoutines(store, now, { timeZone: opts.timeZone })
      run.counts.routines = learned.learned.length
      for (const note of learned.rejected.slice(0, 5)) run.notes.push(`routine not kept: ${note.activityType} — ${note.why}`)
    }

    /**
     * PREDICTIONS ARE RESOLVED BEFORE NEW ONES ARE MADE.
     *
     * Order matters here and nowhere else in this function: `makePredictions`
     * reads the calibration record to temper its confidence, so resolving first
     * means today's predictions are informed by yesterday's result rather than by
     * a record one day out of date. It also means a prediction cannot be
     * overwritten by a fresh one for the same target before it has been scored.
     */
    if (kind !== 'ingest') {
      const departures = series.departure_minute ?? []
      const resolved = resolvePredictions(store, now, { timeZone: opts.timeZone, departures })
      run.counts.predictionsResolved = resolved.resolved.length
      for (const r of resolved.resolved) {
        run.notes.push(`prediction ${r.id} → ${r.result}${typeof r.error === 'number' ? ` (error ${Math.round(r.error)})` : ''}`)
      }
    }

    if (kind === 'daily' || kind === 'weekly' || kind === 'rebuild') {
      const hypotheses = hypothesisPass(store, now, series, summaries)
      run.counts.hypotheses = hypotheses.kept
      for (const note of hypotheses.notes.slice(0, 8)) run.notes.push(note)

      const departures = series.departure_minute ?? []
      const made = makePredictions(store, now, { timeZone: opts.timeZone, departures })
      run.counts.predictionsMade = made.made.length
      for (const d of made.declined.slice(0, 5)) run.notes.push(`did not predict ${d.about}: ${d.why}`)

      anomalies = detectAnomalies(store, now, summaries, series, { timeZone: opts.timeZone })
      run.counts.anomalies = anomalies.length
    }

    if (kind === 'weekly' || kind === 'rebuild') {
      const rels = deriveRelationships(store, SELF_ENTITY_ID, startedAt)
      run.counts.relationships = rels.written.length
      for (const r of rels.refused.slice(0, 5)) run.notes.push(`edge refused: ${r.type} — ${r.why}`)
    }

    run.status = 'ok'
  } catch (e) {
    /**
     * The ledger is untouched by any of this — every stage above only writes
     * derived tables, and the cursor has not moved past work that did not land.
     * So a failure is a retry, recorded, not a corruption to be repaired.
     */
    run.status = 'failed'
    run.error = (e as Error).message
    run.notes.push(`failed after ${JSON.stringify(run.counts)}`)
  }

  run.finishedAt = new Date(now.getTime()).toISOString()
  store.runs.put(run)
  return { run, summaries, anomalies, series }
}

// ── The stages ───────────────────────────────────────────────────────────────

/**
 * Normalise, resolve, assemble — over what has arrived since the cursor.
 *
 * The cursor moves to the last event's `observedAt` ONLY after all three stages
 * have written, so a crash between normalisation and assembly re-does both next
 * time rather than leaving observations that no episode will ever look at.
 */
function ingest(store: MemoryStore, run: ReflectionRun, now: Date, opts: CycleOptions): void {
  const cursor = store.runs.cursor(INGEST_CURSOR)?.at ?? '1970-01-01T00:00:00.000Z'
  const batch = store.events.since(cursor, opts.batch ?? 5000)
  run.counts.events = batch.length
  if (!batch.length) return

  const observations = normalizeEvents(batch, { me: opts.me, timeZone: opts.timeZone })
  store.observations.put(observations)
  store.events.markNormalized(batch.map((e) => e.id), now.toISOString(), VERSIONS.normalize)
  run.counts.observations = observations.length

  const resolved = resolveEntities(store, observations, now.toISOString())
  run.counts.entities = resolved.added.length
  for (const s of resolved.skipped.slice(0, 3)) run.notes.push(`not an entity: ${s.label} — ${s.why}`)

  const assembled = assembleEpisodes(store, observations, now.toISOString(), { timeZone: opts.timeZone })
  run.counts.episodes = assembled.written
  for (const l of assembled.loose.slice(0, 3)) run.notes.push(`not in an episode: ${l.id} — ${l.why}`)

  store.runs.setCursor(INGEST_CURSOR, batch[batch.length - 1]!.observedAt, now.toISOString())
}

/**
 * THE SERIES AND THE BASELINES.
 *
 * Four domains, and the per-weekday scoping that makes a deviation mean
 * something. `activity.ts` is not called from here and is not replaced by it:
 * it remains the surface's report for steps, reading the world document, and this
 * computes the same metric from the ledger for the models to reason over. The two
 * agreeing is a property worth testing; the two being one call is a coupling that
 * would make the memory core a dependency of a widget.
 */
function temporalPass(
  store: MemoryStore,
  now: Date,
  opts: CycleOptions
): { summaries: TemporalSummary[]; series: Record<string, Sample[]> } {
  const today = dayIn(now, opts.timeZone)
  const from = firstDay(store, opts.timeZone) ?? today

  const steps = activitySeries(store, 'steps')
  const load = calendarLoadSeries(store, from, today, opts.timeZone)
  const home = homePlaceId(store, opts.timeZone)
  const departures = home ? departureSeries(store, home, opts.timeZone) : []

  const series: Record<string, Sample[]> = {
    steps,
    events_per_day: load,
    departure_minute: departures,
  }

  const summaries: TemporalSummary[] = [
    summarize(steps, now, { domain: 'activity', metric: 'steps' }, opts.timeZone),
    summarize(load, now, { domain: 'calendar', metric: 'events_per_day' }, opts.timeZone),
  ]
  if (departures.length) {
    summaries.push(summarize(departures, now, { domain: 'location', metric: 'departure_minute' }, opts.timeZone))
  }

  /**
   * PER-WEEKDAY BASELINES, because that is the population a day belongs to.
   *
   * Seven summaries per metric looks extravagant and is the cheap half of this
   * pass — the samples are already in memory and the arithmetic is a mean. The
   * expensive alternative is the one that was in place before: comparing a
   * Thursday to an all-days average and announcing a deviation every week.
   */
  for (let weekday = 0; weekday < 7; weekday++) {
    for (const [metric, samples] of Object.entries(series)) {
      const scoped = onWeekday(samples, weekday, weekdayOf)
      // Under four points a mean is a rumour and a standard deviation is worse.
      if (scoped.length < 4) continue
      summaries.push(
        summarize(
          scoped,
          now,
          {
            domain: metric === 'steps' ? 'activity' : metric === 'events_per_day' ? 'calendar' : 'location',
            metric,
            scope: `weekday:${weekday}`,
            // Weekly data in a 28-day window is four points, so the window has to
            // be longer for a scoped series or every one of them is unusable.
            windowDays: 84,
          },
          opts.timeZone
        )
      )
    }
  }

  return { summaries, series }
}

/**
 * PROPOSE, TEST, KEEP OR REJECT.
 *
 * The proposals are enumerated by `proposeAssociations` — a closed cross-product
 * of the metrics in hand, not a model asked what looks interesting. Every one is
 * evaluated by the same arithmetic and the ones that fail are recorded as
 * failures, which is what makes "we considered this and it is not so" a thing the
 * system can say.
 *
 * A hypothesis that evaluates to `candidate` is DISCARDED rather than stored.
 * Storing every four-day coincidence would fill the table with claims that exist
 * only because a pair search was run, and the store is read by things that treat
 * a row as meaning somebody thought it was worth writing down.
 */
function hypothesisPass(
  store: MemoryStore,
  now: Date,
  series: Record<string, Sample[]>,
  summaries: TemporalSummary[]
): { kept: number; notes: string[] } {
  const notes: string[] = []
  const metricSeries: MetricSeries[] = [
    { domain: 'calendar', metric: 'events_per_day', sources: ['calendar'], samples: series.events_per_day ?? [] },
    { domain: 'activity', metric: 'steps', sources: ['health'], samples: series.steps ?? [] },
    { domain: 'location', metric: 'departure_minute', sources: ['location'], samples: series.departure_minute ?? [] },
  ].filter((s) => s.samples.length >= 8)

  const drafts: Parameters<typeof saveHypotheses>[1] = []

  for (const proposal of proposeAssociations(metricSeries, now)) {
    if (proposal.proposition.kind !== 'association') continue
    const evaluated = evaluateAssociation(proposal.proposition, proposal.when, proposal.then, now)
    if (!evaluated) continue
    if (evaluated.status === 'candidate') {
      notes.push(
        `not kept: ${proposal.proposition.when.metric}→${proposal.proposition.then.metric} (${evaluated.support}/${evaluated.support + evaluated.contradiction})`
      )
      continue
    }
    drafts.push(evaluated)
  }

  /**
   * A SHIFT HYPOTHESIS FOR EVERY CHANGE POINT the temporal pass found.
   *
   * Scoped summaries are the interesting ones — a shift in "his Tuesdays" is a
   * real statement about his life where a shift in "his days" is usually one
   * weekday's shift diluted across seven.
   */
  for (const summary of summaries) {
    if (!summary.changePoint) continue
    const samples = series[summary.metric]
    if (!samples) continue
    const scoped = /^weekday:(\d)$/.exec(summary.scope)
    const relevant = scoped ? onWeekday(samples, Number(scoped[1]), weekdayOf) : samples
    drafts.push(
      shiftHypothesis(
        summary.id,
        summary.metric,
        summary.changePoint,
        relevant,
        now,
        [summary.domain === 'activity' ? 'health' : summary.domain]
      )
    )
  }

  const saved = saveHypotheses(store, drafts)
  return { kept: saved.length, notes }
}

/** The first day anything was observed. The left edge of every series. */
function firstDay(store: MemoryStore, timeZone?: string): string | null {
  const oldest = store.events.since('1970-01-01T00:00:00.000Z', 1)[0]
  return oldest ? dayIn(new Date(oldest.sourceAt), timeZone) : null
}

// ── Replay ───────────────────────────────────────────────────────────────────

export interface RebuildResult {
  cleared: string[]
  passes: number
  runs: ReflectionRun[]
}

/**
 * DELETE EVERY DERIVED ROW AND THINK IT ALL AGAIN.
 *
 * §34's operation, and the reason the whole directory is arranged the way it is.
 * The ledger is untouched; `clearDerived` names exactly what may be destroyed and
 * `PRESERVED_TABLES` names what may not — including his recommendation history,
 * which looks derived and is not.
 *
 * WHY IT REPLAYS A SCHEDULE RATHER THAN RUNNING ONE BIG PASS.
 *
 * Almost everything here is a pure function of the evidence and would rebuild
 * identically in a single pass. Predictions are the exception, and they are not a
 * flaw in the design — a prediction is a statement made at a time, from the model
 * as it stood at that time, and "what would we have predicted on the 3rd of June"
 * only has an answer if the 3rd of June is replayed as the 3rd of June.
 *
 * So the rebuild re-runs the daily cycle once per day covered by the ledger. The
 * schedule is derived FROM THE LEDGER — first event to last — so it is a function
 * of the evidence like everything else, and a rebuild is reproducible without
 * anybody recording when the original passes happened.
 *
 * The honest limitation, stated because it will matter to whoever changes this:
 * a rebuild reproduces the ORIGINAL only if the original also ran on a daily
 * cadence. A system that ran three times on Tuesday and not at all on Wednesday
 * will not be reproduced tick for tick, and its predictions will differ. Every
 * other derived structure will be identical. `scripts/memory.mjs` drives both
 * sides on the same cadence and says so in its output rather than quietly
 * comparing two things that were never meant to match.
 */
export function rebuild(store: MemoryStore, opts: CycleOptions & { until?: Date } = {}): RebuildResult {
  const events = store.events.all()
  if (!events.length) return { cleared: [], passes: 0, runs: [] }

  store.clearDerived()

  const first = new Date(events[0]!.observedAt)
  const last = opts.until ?? new Date(events[events.length - 1]!.observedAt)
  const runs: ReflectionRun[] = []

  /**
   * One pass per day, at the same instant of day, driven off the ledger's own
   * span. `23:59` rather than midnight so a day's evidence is all in before the
   * day is thought about — a pass at midnight would resolve predictions for a day
   * whose observations had not been ingested.
   */
  for (let t = startOfDay(first); t.getTime() <= last.getTime(); t = nextDay(t)) {
    const at = new Date(t.getTime() + 23 * 3_600_000 + 59 * 60_000)
    if (at.getTime() > last.getTime() + 86_400_000) break
    runs.push(runCycle(store, 'daily', at, opts).run)
  }

  // A weekly pass at the end, for the stages that only run on that cadence.
  runs.push(runCycle(store, 'weekly', last, opts).run)

  return { cleared: ['derived'], passes: runs.length, runs }
}

const startOfDay = (d: Date): Date => new Date(Date.parse(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`))
const nextDay = (d: Date): Date => new Date(d.getTime() + 86_400_000)
