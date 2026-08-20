/**
 * THINGS THAT MIGHT BE TRUE, KEPT AS THINGS THAT MIGHT BE TRUE.
 *
 * The failure this whole file exists to prevent has a shape, and the shape is
 * familiar enough that it is worth writing out:
 *
 *     1. Two numbers move together on four occasions.
 *     2. Something records "meetings lower his activity" at confidence 0.8.
 *     3. Nothing ever looks at the occasions where they did not.
 *     4. Confidence decays, so the claim ages, but ageing is not the same as
 *        being wrong — and a claim that was never testable cannot be tested by
 *        waiting.
 *     5. A year later the app is still saying it.
 *
 * `world.ts` already has the scar tissue from exactly this: `reconcileBeliefs`
 * and `claimsUnperformedEffect` exist because a belief was formed, aged
 * gracefully, and was completely false the entire time. A belief has confidence
 * and decay and no way to be CONTRADICTED. That is the missing verb, and it is
 * what a hypothesis has and a belief does not.
 *
 * THE THREE RULES.
 *
 *   · SUPPORT AND CONTRADICTION ARE SEPARATE NUMBERS. Never netted, never
 *     folded. Eight-for and seven-against is a completely different epistemic
 *     state from one-for and nothing-against, and any single score loses that.
 *
 *   · EVERYTHING IS RECOMPUTED FROM EVIDENCE, NEVER INCREMENTED. A counter that
 *     goes up each time the reflection cycle runs is measuring the cron, not his
 *     life, and it cannot be rebuilt from the ledger — which would break §34 in a
 *     way that only shows up months later as a rebuild that disagrees with the
 *     original.
 *
 *   · THERE IS NO CAUSAL PROPOSITION, AND ADDING ONE MEANS WRITING AN EVALUATOR
 *     THAT CAN ESTABLISH CAUSATION. `TypedProposition` has `association`,
 *     `shift` and `cadence_change`. It structurally cannot express "meetings
 *     cause lower activity", so no amount of evidence can promote the associative
 *     claim into a causal one — which is §37's requirement, enforced by the type
 *     system rather than by a threshold somebody can raise.
 *
 * THE THRESHOLDS ARE NOT `ENGAGEMENT_MIN`. §17 is explicit about this and it is
 * worth restating why: four is right for a bounded nudge to a ranking. A
 * cross-domain association is a claim about how his life works that will be
 * spoken aloud and used to make predictions, and it needs both more occasions AND
 * evidence from more than one connector — otherwise what has been discovered is a
 * quirk of one source's reporting.
 */

import { addDays, weekdayOf } from '../clock.js'
import { hash, idOf } from './ids.js'
import { mean, stdDev, type Sample } from './temporal.js'
import {
  VERSIONS,
  type EvidenceRef,
  type Hypothesis,
  type HypothesisStatus,
  type MemoryStore,
  type TypedProposition,
} from './types.js'

/**
 * THE BARS FOR AN ASSOCIATION.
 *
 * Occasions counts DAYS ON WHICH THE CONDITION HELD, not days observed: a
 * hypothesis about meeting-heavy Thursdays is only tested by meeting-heavy
 * Thursdays, and counting the quiet ones would let a claim reach "supported" on
 * evidence that never touched it.
 */
const ASSOCIATION_MIN_OCCASIONS = 8
const ASSOCIATION_MIN_COVERAGE_DAYS = 42
/**
 * At least two independent connectors.
 *
 * The one number here that is doing real epistemic work. Six calendar rows are
 * one kind of evidence six times over; a calendar row and a step count are two
 * different instruments agreeing, and only the second is evidence about his life
 * rather than about a source's behaviour.
 */
const ASSOCIATION_MIN_DIVERSITY = 2
/**
 * THE BAR FOR A SHIFT, WHICH IS A DIFFERENT NUMBER FOR A REASON.
 *
 * `shiftHypothesis` had no coverage bar at all. Its ladder asked for four
 * decided samples and a ratio, and never for a span — so a change point four
 * days from the end of the data, with four samples on the new side, became a
 * `supported` claim that his life had changed. The negative corpus caught it the
 * first time its random sequence produced one, having been unable to before.
 *
 * `ASSOCIATION_MIN_COVERAGE_DAYS` is the wrong number to reuse. An association
 * is tested over the whole history; a shift's evidence is by construction only
 * the part AFTER the change point, so demanding forty-two days there would mean
 * no shift is ever sayable until six weeks after it happened — which would
 * suppress §64's flagship case, "your Tuesdays have shifted later", for the five
 * weeks in which it is the most useful thing the system knows.
 *
 * Three weeks is the answer, and it is not chosen here: it is the bar the
 * negative corpus already states as the product rule ("nothing is believed on
 * less than three weeks of evidence"). §64's case clears it at roughly four
 * weeks of Tuesdays; the four-day one does not. Below it a shift is `emerging`,
 * which is a real state that the intelligence slot may not speak from — not
 * discarded, because a change point that is real will cross the bar by simply
 * continuing to be true.
 */
const SHIFT_MIN_COVERAGE_DAYS = 21

/** Of the occasions the condition held, the fraction that must go the claimed way. */
const SUPPORTED_RATIO = 0.7
const WEAKENING_RATIO = 0.6
const REJECTED_RATIO = 0.45

/**
 * How far a day's value must sit from the population mean to count as
 * "lower" or "higher" at all.
 *
 * Half a standard deviation. Without a threshold, every day is either above or
 * below the mean and a coin-flip association would come out at 50% support and
 * sit at `emerging` forever; with one, a day that is merely ordinary counts as
 * NEITHER support nor contradiction, which is the honest reading of it.
 */
const EFFECT_SIGMAS = 0.5

/**
 * How many days the condition must be ABSENT on for the comparison to mean
 * anything. See the baseline note in `evaluateAssociation`.
 *
 * Twelve, matching the spirit of the occasion bar on the other side: an
 * association compares two groups, and a two-day control group is not a control
 * group. It is deliberately not proportional — "the complement must be 20% of
 * days" would still admit a four-day complement in a three-week series.
 */
const MIN_COMPLEMENT_DAYS = 12

/**
 * How much likelier the outcome must be when the condition holds than when it
 * does not, before the condition counts as having explained anything.
 *
 * Twelve points. Measured rather than picked: across the two corpora the genuine
 * associations lift by .15 to .40 and the spurious one that clears the ratio bar
 * lifts by .07, so the bar sits in the gap with room on both sides. It is
 * deliberately not tighter — the narrow margin above .07 is one corpus, and a bar
 * tuned to the last decimal of two fixtures is a bar fitted to them.
 */
const MIN_LIFT = 0.12

export interface HypothesisRun {
  written: string[]
  /** Propositions considered and not kept, with the arithmetic. */
  rejected: { proposition: string; why: string }[]
}

/** A named day-series with the connector behind it, for the diversity count. */
export interface MetricSeries {
  domain: string
  metric: string
  /** The connectors that produced these samples: 'calendar', 'health', 'location'. */
  sources: string[]
  samples: Sample[]
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/**
 * Test an association against every day the condition held.
 *
 * Pure, and takes the series rather than the store, so the whole discipline of
 * this file is testable without a database — which is what makes §37's
 * "inject contradicting examples and watch confidence fall" a three-line test
 * rather than a fixture rewrite.
 */
/**
 * HOW OFTEN A SET OF DAYS READS AS `direction`, UNDER THE SAME CLASSIFICATION THE
 * SUPPORT COUNT USES.
 *
 * The base rate. Run over the days the condition did NOT hold, it is the number
 * the support ratio has to beat — and it is the number that was silently assumed
 * to be 0.5 for as long as this file has existed.
 *
 * Deliberately shares the arithmetic with the loop below rather than
 * approximating it: a control rate computed by a slightly different rule than the
 * support rate would produce a lift that is partly an artifact of the difference.
 */
function rateOf(values: number[], baseline: number, spread: number, direction: 'lower' | 'higher'): number {
  const wanted = direction === 'lower' ? -1 : 1
  let matched = 0
  let decided = 0
  for (const v of values) {
    const sigmas = (v - baseline) / spread
    if (Math.abs(sigmas) < EFFECT_SIGMAS) continue
    decided++
    if (Math.sign(sigmas) === wanted) matched++
  }
  // No decided day in the control means no base rate to beat, and the honest
  // reading is that the comparison could not be made rather than that it was won.
  return decided ? matched / decided : 0.5
}

export function evaluateAssociation(
  proposition: Extract<TypedProposition, { kind: 'association' }>,
  when: MetricSeries,
  then: MetricSeries,
  now: Date
): Omit<Hypothesis, 'id' | 'alternatives' | 'modelVersion'> | null {
  const byDay = new Map(then.samples.map((s) => [s.day, s]))
  const threshold = proposition.when.threshold
  const holdsOn = (v: number) => (proposition.when.comparator === 'above' ? v > threshold : v < threshold)

  /**
   * THE BASELINE IS THE DAYS THE CONDITION DID NOT HOLD — NOT ALL DAYS.
   *
   * This was the whole population, and that made the condition do no work at all.
   * An association says "on days when A, B tends to be lower", which is a
   * COMPARATIVE claim: lower than when A is absent. Measuring each qualifying day
   * against the average of every day — including the qualifying ones — asks
   * something else entirely, namely "is B below its own average today", and the
   * answer to that depends only on B's distribution.
   *
   * For a skewed metric it is not even close. `events_per_day` is 0 on most days,
   * so its mean sits above its median, so more than half of ALL days read as
   * "lower" by half a standard deviation. Any condition you care to name — any
   * subset of days whatsoever — then comes out around 70–80% support for
   * "tends to be lower", and `SUPPORTED_RATIO` at 0.7 duly promotes it.
   *
   * Caught by the negative corpus: two independent random series with a measured
   * Pearson correlation of −0.11 produced a supported association at 39 of 49
   * occasions. That is not a threshold that needed raising. It is a test that was
   * not testing the proposition, and no ratio bar can fix a comparison against the
   * wrong group.
   *
   * The SPREAD stays pooled over every day. It is the unit the effect is measured
   * in, not part of the comparison, and computing it per-group would let a
   * condition that happens to select quiet days shrink its own denominator and
   * inflate its effect size.
   */
  const absent = then.samples.filter((s) => {
    const condition = when.samples.find((c) => c.day === s.day)
    return condition !== undefined && !holdsOn(condition.value)
  })
  const baseline = mean(absent.map((s) => s.value))
  const spread = stdDev(then.samples.map((s) => s.value))
  if (baseline === null || spread === null || spread === 0) return null

  /**
   * A COMPARISON NEEDS SOMETHING TO COMPARE AGAINST.
   *
   * When the condition holds on nearly every day the complement is a handful of
   * days, its mean is noise, and every qualifying day is being measured against
   * it. That is the degenerate-threshold case — a median sitting at the bottom of
   * a metric's range, which `proposeAssociations` will happily produce — and the
   * honest answer is that the proposition is untestable on this data rather than
   * that it is supported.
   */
  if (absent.length < MIN_COMPLEMENT_DAYS) return null

  /**
   * AND THE TEST NEEDS A NULL, WHICH IT DID NOT HAVE.
   *
   * Moving the baseline to the complement was necessary and, on its own, changed
   * nothing — the same 39 of 49. The reason is that the per-day classification is
   * a function of the day's own value, and shifting the point it is measured from
   * by a tenth of a standard deviation reclassifies almost no days. The bias is
   * not in where the baseline sits; it is that `SUPPORTED_RATIO = 0.7` is being
   * compared against an assumed null of 0.5, and for a skewed or discrete metric
   * the real null is nowhere near 0.5.
   *
   * `events_per_day` takes the values 0, 1 and 2, and 0 is the commonest. So
   * "lower by half a sigma" is true of most days no matter which days you pick,
   * and 0.7 is below the base rate rather than above it. The ratio was measuring
   * the shape of the outcome metric.
   *
   * So the same classification is run on the complement, and what has to clear the
   * bar is the DIFFERENCE. If B reads "lower" on 80% of the condition's days and
   * on 78% of everything else, the condition has explained two percentage points
   * and the proposition is not a finding. This is the multiple-comparisons
   * defence the file's own note admits it was missing — not as a correction
   * factor, but by making the statistic one that is actually zero under the null.
   */
  const controlRate = rateOf(absent.map((s) => s.value), baseline, spread, proposition.then.direction)

  let support = 0
  let contradiction = 0
  let neutral = 0
  const evidence: EvidenceRef[] = []
  const days: string[] = []

  for (const s of when.samples) {
    if (!holdsOn(s.value)) continue
    const outcome = byDay.get(s.day)
    // A day where the condition held and the outcome was never measured is
    // neither support nor contradiction. Counting it either way would make the
    // hypothesis a claim about data coverage.
    if (!outcome) continue
    days.push(s.day)

    const sigmas = (outcome.value - baseline) / spread
    const wanted = proposition.then.direction === 'lower' ? -1 : 1

    /**
     * A DAY WITH NOTHING ON IT HAS NOTHING TO CITE.
     *
     * `evidenceIds[0] ?? s.day` used to stand in a date string when the day had no
     * rows behind it, and a date is not an id — `explain` cannot walk it, and the
     * traceability check correctly reported the chain as broken. It only started
     * appearing once "events_per_day tends to be LOWER" became supported, because
     * the days supporting that claim are precisely the days with no calendar rows
     * on them.
     *
     * The statistics are unaffected and should be: a quiet day is real evidence
     * about a quiet calendar, and the support count is a count of days. What
     * cannot be done is cite it — an absence has no record — so the citation is
     * omitted rather than fabricated. A hypothesis resting entirely on absences
     * then arrives at the significance gate with no grounds and is suppressed for
     * having nothing to show, which is the right outcome and is now reached
     * honestly instead of being papered over with six dates.
     */
    const citation = outcome.evidenceIds[0]

    if (Math.abs(sigmas) < EFFECT_SIGMAS) {
      neutral++
    } else if (Math.sign(sigmas) === wanted) {
      support++
      if (citation) evidence.push({ kind: 'observation', id: citation, says: `${s.day}: ${outcome.value}` })
    } else {
      contradiction++
      if (citation) evidence.push({ kind: 'observation', id: citation, says: `${s.day}: ${outcome.value} — against` })
    }
  }

  if (!days.length) return null
  days.sort()
  const first = days[0]!
  const last = days[days.length - 1]!
  const coverage = dayCount(first, last)
  const decided = support + contradiction
  const observed = decided ? support / decided : 0
  const diversity = new Set([...when.sources, ...then.sources]).size

  /**
   * THE LIFT IS A SECOND NUMBER, AND IT IS NOT FOLDED INTO THE FIRST.
   *
   * The first attempt rescaled `ratio` into a lift and applied the existing bars
   * to the result. It killed the fixture's genuine associations along with the
   * noise, and the measurements say why: neither quantity separates the two
   * corpora on its own.
   *
   *                        observed   lift
   *     real (fixture)     .83–1.00   .15–.40
   *     spurious (noise)   .79        .07
   *     spurious (noise)   .62        .15
   *
   * The spurious pair with a convincing 0.79 has almost no lift; the spurious pair
   * with a real-looking lift of 0.15 holds on barely three days in five. Every
   * fixture association clears BOTH. So the test is a conjunction, and collapsing
   * them into one score — by any weighting — throws away exactly the distinction
   * that does the work.
   *
   * That is §4.4's argument arriving somewhere new. Support and contradiction are
   * kept apart because netting them destroys an epistemic distinction; "how often
   * it held" and "how much oftener than usual" are two more, and the same
   * reasoning applies. `ratio` therefore stays what it always was, and the bars
   * tuned against it keep their meaning.
   */
  const ratio = observed
  const lift = observed - controlRate

  const status = statusOf({ occasions: decided, coverage, diversity, ratio, lift })

  return {
    proposition,
    support,
    contradiction,
    observationCount: decided + neutral,
    evidenceDiversity: diversity,
    temporalCoverageDays: coverage,
    confidence: confidenceOf({ occasions: decided, coverage, diversity, ratio, status }),
    firstObservedAt: first,
    lastObservedAt: last,
    status,
    // Capped: an association tested over a year would otherwise carry a
    // three-hundred-entry evidence list into every read of it.
    evidence: [...evidence.slice(0, 12), ...evidence.slice(-12)],
    lastEvaluatedAt: now.toISOString(),
  }
}

/**
 * `candidate` → `emerging` → `supported`, with `weakening` and `rejected` for
 * claims the evidence has turned against.
 *
 * All four bars must clear for `supported`, and the diversity bar is the one that
 * most often stops something. That is intended: a pattern visible in one
 * connector is a pattern in that connector until a second instrument agrees.
 */
function statusOf(d: {
  occasions: number
  coverage: number
  diversity: number
  ratio: number
  /** Absent for propositions with no control group to compare against. */
  lift?: number
}): HypothesisStatus {
  if (d.occasions < 4) return 'candidate'
  if (d.occasions >= ASSOCIATION_MIN_OCCASIONS && d.ratio < REJECTED_RATIO) return 'rejected'
  if (d.occasions >= ASSOCIATION_MIN_OCCASIONS && d.ratio < WEAKENING_RATIO) return 'weakening'
  if (
    d.occasions >= ASSOCIATION_MIN_OCCASIONS &&
    d.coverage >= ASSOCIATION_MIN_COVERAGE_DAYS &&
    d.diversity >= ASSOCIATION_MIN_DIVERSITY &&
    d.ratio >= SUPPORTED_RATIO &&
    // The condition must also explain something. See the lift note above.
    (d.lift === undefined || d.lift >= MIN_LIFT)
  ) {
    return 'supported'
  }
  return 'emerging'
}

/**
 * Confidence, CAPPED WELL BELOW CERTAINTY AND BELOW A ROUTINE'S.
 *
 * 0.75 at the very best. An association between two things measured by two
 * different instruments over four months is genuinely useful and is not a fact
 * about him, and the number has to say so wherever it is read — including in
 * `attention.ts`'s confidence axis, which is where it decides whether the
 * sentence is worth his time.
 *
 * A rejected hypothesis keeps a LOW but non-zero confidence rather than dropping
 * to nothing, because "we looked at this and it is not so" is worth knowing and
 * worth not re-proposing next week.
 */
function confidenceOf(d: {
  occasions: number
  coverage: number
  diversity: number
  ratio: number
  status: HypothesisStatus
}): number {
  if (d.status === 'rejected') return 0.1
  const fromRatio = Math.max(0, d.ratio - 0.5) * 0.8
  const fromCount = Math.min(0.2, d.occasions * 0.015)
  const fromSpan = Math.min(0.1, (d.coverage / 90) * 0.1)
  const fromDiversity = Math.min(0.1, (d.diversity - 1) * 0.05)
  return Math.min(0.75, Math.max(0.05, fromRatio + fromCount + fromSpan + fromDiversity))
}

// ── Proposing ────────────────────────────────────────────────────────────────

/**
 * PROPOSE THE ASSOCIATIONS WORTH TESTING, from the series in hand.
 *
 * Every ordered pair of distinct metrics, with the condition threshold set at the
 * condition metric's own median. That is a small, closed search rather than "ask
 * a model what looks interesting", and the difference matters: a model asked to
 * find patterns in a life will find them, in the sense that it will emit them.
 * The pairs here are enumerated, each is tested by the same arithmetic, and the
 * ones that fail are recorded as failures.
 *
 * The threshold at the median rather than at a tuned value is deliberate: a
 * threshold chosen to maximise the effect is how a search over enough pairs
 * manufactures significance, and there is no correction for multiple comparisons
 * anywhere in this file. The `diversity` and `coverage` bars are the blunt
 * instrument standing in for one, and the honest statement is that a `supported`
 * association here is a strong hint rather than a finding.
 */
export function proposeAssociations(series: MetricSeries[], now: Date): { proposition: TypedProposition; when: MetricSeries; then: MetricSeries }[] {
  const out: { proposition: TypedProposition; when: MetricSeries; then: MetricSeries }[] = []
  void now

  for (const when of series) {
    for (const then of series) {
      if (when === then) continue
      // Same-domain pairs are excluded: "calendar load predicts calendar load"
      // is arithmetic about one connector, and it is exactly the kind of thing a
      // pair search will find plenty of.
      if (when.domain === then.domain) continue
      const conditionValues = when.samples.map((s) => s.value)
      const threshold = medianOf(conditionValues)
      if (threshold === null) continue
      /**
       * ONLY `above`, AND THE REASON IS THAT `below` IS THE SAME TEST.
       *
       * The threshold is the condition metric's own median, so "above it" and
       * "below it" partition the same days — and the four combinations of
       * comparator and direction are two hypotheses each stated twice. Both
       * copies were being evaluated, both were being stored, and the table came
       * out at twenty-two rows describing eleven claims.
       *
       * That is not merely untidy. Every duplicate is another proposition in a
       * search with no correction for multiple comparisons, and a search that
       * runs twice as many tests finds twice as many things that are not there.
       *
       * The two DIRECTIONS are kept, because they are genuine mirror claims and
       * one of them being supported while the other is rejected is exactly the
       * shape a real finding has. Keeping both is also what makes the rejection
       * visible rather than implied.
       */
      for (const direction of ['lower', 'higher'] as const) {
        out.push({
          proposition: {
            kind: 'association',
            when: { metric: when.metric, comparator: 'above', threshold, scope: when.domain },
            then: { metric: then.metric, direction, scope: then.domain },
          },
          when,
          then,
        })
      }
    }
  }
  return out
}

/**
 * A SHIFT HYPOTHESIS, straight off a change point.
 *
 * Structurally different from an association and deliberately cheaper to
 * establish: a change point is one series against itself with a significance
 * test already applied, so it does not need cross-connector diversity to be
 * meaningful. It is also the hypothesis that produces the sentence §45 describes —
 * "your Tuesdays have shifted later over the last six weeks" — which is the
 * single most valuable thing in this milestone and would be unsayable without it.
 */
export function shiftHypothesis(
  routineId: string,
  metric: string,
  change: NonNullable<import('./types.js').TemporalSummary['changePoint']>,
  samples: Sample[],
  now: Date,
  sources: string[]
): Omit<Hypothesis, 'id' | 'alternatives' | 'modelVersion'> {
  const after = samples.filter((s) => s.day >= change.day)
  const before = samples.filter((s) => s.day < change.day)
  const spread = stdDev(samples.map((s) => s.value)) ?? 1

  /**
   * Support is counted PER SAMPLE ON THE NEW SIDE, against the old level. A
   * genuine step change means most days after the change point sit clearly on
   * the new side; a single outlier that happened to maximise the split does not.
   */
  let support = 0
  let contradiction = 0
  for (const s of after) {
    const moved = (s.value - change.before) / spread
    const wanted = change.magnitude > 0 ? 1 : -1
    if (Math.abs(moved) < EFFECT_SIGMAS) continue
    if (Math.sign(moved) === wanted) support++
    else contradiction++
  }

  const coverage = after.length ? dayCount(after[0]!.day, after[after.length - 1]!.day) : 0
  const decided = support + contradiction
  const ratio = decided ? support / decided : 0
  /*
    The coverage bar is checked ONLY on the way up to `supported`. A shift whose
    new level has held for four days may be emerging, weakening or rejected on
    its ratio like any other — what it may not be is believed. Putting the span
    in the `rejected` branch instead would throw away a change point that is
    merely young, and it would come back as a new row a fortnight later having
    lost the fortnight of evidence it had already gathered.
  */
  const established = coverage >= SHIFT_MIN_COVERAGE_DAYS
  const status: HypothesisStatus =
    decided < 3
      ? 'candidate'
      : ratio < REJECTED_RATIO
        ? 'rejected'
        : ratio < WEAKENING_RATIO
          ? 'weakening'
          : ratio >= SUPPORTED_RATIO && decided >= 4 && established
            ? 'supported'
            : 'emerging'

  return {
    proposition: {
      kind: 'shift',
      routineId,
      metric,
      direction: change.magnitude > 0 ? 'later' : 'earlier',
      since: change.day,
      magnitude: Math.abs(change.magnitude),
    },
    support,
    contradiction,
    observationCount: after.length,
    evidenceDiversity: new Set(sources).size,
    temporalCoverageDays: coverage,
    confidence: Math.min(0.8, 0.2 + ratio * 0.5 + Math.min(0.1, after.length * 0.01)),
    firstObservedAt: before.length ? before[0]!.day : change.day,
    lastObservedAt: after.length ? after[after.length - 1]!.day : change.day,
    status,
    evidence: after.slice(-12).map((s) => ({ kind: 'observation' as const, id: s.evidenceIds[0] ?? s.day, says: `${s.day}: ${s.value}` })),
    lastEvaluatedAt: now.toISOString(),
  }
}

// ── Persisting ───────────────────────────────────────────────────────────────

/**
 * The id is a function of the CLAIM, not of the evidence.
 *
 * That is what makes re-evaluation an update rather than a second hypothesis:
 * the same proposition, tested again next week against more days, lands on the
 * same row with a new support-to-contradiction split. If the id moved with the
 * evidence the store would fill with generations of the same claim and nothing
 * could ever be seen to have been revised.
 */
export function hypothesisId(p: TypedProposition): string {
  const key =
    p.kind === 'association'
      ? `assoc|${p.when.metric}|${p.when.comparator}|${p.then.metric}|${p.then.direction}`
      : p.kind === 'shift'
        ? `shift|${p.routineId}|${p.metric}|${p.direction}`
        : `cadence|${p.routineId}|${p.direction}`
  return idOf('hyp', hash(key))
}

/** One line, from the structure. No model, for the reasons in `episodes.ts`. */
export function hypothesisSentence(h: Hypothesis, label: (metric: string) => string = (m) => m): string {
  const p = h.proposition
  if (p.kind === 'shift') {
    /**
     * "later" AND "earlier" ARE ONLY WORDS FOR A CLOCK.
     *
     * The direction on a `shift` is stored as later/earlier because the case it
     * was written for is a departure time, and the first pass rendered "events
     * per day has been earlier by about 1" — which is not wrong so much as not
     * English. A count moves up and down; a time moves later and earlier. The
     * metric knows which it is, so the sentence asks it.
     */
    const clockLike = /minute|time|departure|arrival|start/i.test(p.metric)
    const moved = clockLike ? p.direction : p.direction === 'later' ? 'higher' : 'lower'
    return `${label(p.metric)} has been ${moved} by about ${Math.round(p.magnitude)} since ${p.since}`
  }
  if (p.kind === 'cadence_change') {
    return `${label(p.routineId)} has become ${p.direction.replace('_', ' ')}`
  }
  /**
   * ASSOCIATIVE WORDING, ALWAYS. "tends to be" and "on days when" — never
   * "because", never "causes", never "leads to". §17 asks for this in the
   * language and the type system is what guarantees it: there is no causal
   * proposition for this function to be handed.
   */
  return `on days when ${label(p.when.metric)} is ${p.when.comparator} ${round(p.when.threshold)}, ${label(p.then.metric)} tends to be ${p.then.direction}`
}

/**
 * Write hypotheses, minting ids from their propositions.
 *
 * `alternatives` is filled by grouping on the OUTCOME metric: two claims that
 * explain the same thing differently are alternatives to each other, and holding
 * that link is what stops the app presenting one of them as the explanation when
 * it has two.
 */
export function saveHypotheses(
  store: MemoryStore,
  drafts: Omit<Hypothesis, 'id' | 'alternatives' | 'modelVersion'>[]
): Hypothesis[] {
  const withIds = drafts.map((d) => ({ ...d, id: hypothesisId(d.proposition), alternatives: [] as string[], modelVersion: VERSIONS.hypothesis }))

  const byOutcome = new Map<string, string[]>()
  for (const h of withIds) {
    const key = outcomeKeyOf(h.proposition)
    byOutcome.set(key, [...(byOutcome.get(key) ?? []), h.id])
  }
  for (const h of withIds) {
    const key = outcomeKeyOf(h.proposition)
    h.alternatives = (byOutcome.get(key) ?? []).filter((id) => id !== h.id)
  }

  if (withIds.length) store.hypotheses.put(withIds)
  return withIds
}

/**
 * WHAT A PROPOSITION IS TRYING TO EXPLAIN.
 *
 * Two hypotheses are alternatives when they account for the same outcome, so the
 * key is the outcome and not the claim. A `cadence_change` has no metric of its
 * own — its subject is the routine — so that is what it is keyed on, which is
 * also correct: "he shops less often" and "he shops at a different time" are
 * competing accounts of the same routine and should know about each other.
 */
function outcomeKeyOf(p: TypedProposition): string {
  if (p.kind === 'association') return p.then.metric
  if (p.kind === 'shift') return p.metric
  return p.routineId
}

const medianOf = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** Whole days between two of his day strings, through `clock.ts`. */
function dayCount(from: string, to: string): number {
  let n = 0
  for (let day = from; day < to; day = addDays(day, 1)) n++
  return n
}

/** Re-exported so callers grouping by weekday use the one implementation. */
export { weekdayOf }
