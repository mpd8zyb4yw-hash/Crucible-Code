/**
 * THE BAR BETWEEN "TRUE" AND "WORTH SAYING", AND WHY IT IS A SEPARATE FILE.
 *
 * `candidates.ts` ends with a deliberate note: it decides nothing is worth
 * showing, because `compose` owns that. That is still true and this does not take
 * it back. `compose` ranks — it answers "of the things that could be said, which
 * wins". This answers a question asked earlier and never asked anywhere before:
 * **should this have been a candidate at all.**
 *
 * The difference is not academic. Ranking cannot suppress; it can only lose. On a
 * quiet day the least trivial of six trivial findings is still the winner, and
 * §67's quiet slot never happens — the app fills it with whatever came top of a
 * weak field. Every rule below is a rule that a ranking function structurally
 * cannot express.
 *
 * WHY THE REASONS ARE A UNION AND NOT A SENTENCE.
 *
 * §29 asks the developer view to show, per candidate, "surfaced? / suppression
 * reason". A prose reason is a reason nobody can count. With a typed reason the
 * shadow log answers "what is this thing mostly throwing away, and is that the
 * right thing" — which is the actual question of a shadow run, and the one that
 * tells you whether the thresholds are wrong before he ever sees the output.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * §33 lists "whether the user likely already knows" among the tests. There is no
 * honest measurement of that in this system, and the tempting proxies — the
 * pattern is old, the pattern is strong — are both wrong in the direction that
 * matters: the flagship case in §64 is a five-week-old, strongly-supported shift
 * that he demonstrably had NOT noticed. So the only "he already knows" this file
 * will assert is the one it has evidence for: we told him. That is `said-recently`,
 * and it is keyed on the record of having surfaced it.
 */

import { scoreOf, type Attention } from '../attention.js'
import type { CandidateRecord, SuppressionReason } from './types.js'

/*
  The reasons are evaluated below in the order they are declared in `types.ts`,
  which is also roughly the order of how damning they are: the first two say the
  finding should not have been believed, the middle two say it was believed and
  does not matter, and the last three say it mattered and this was not the moment.
*/

export interface Verdict {
  surfaced: boolean
  reason?: SuppressionReason
  /** The developer-view sentence. Never shown to him; never the card's copy. */
  why: string
  /** `scoreOf` on the candidate's own axes, so the log can be read without a re-run. */
  score: number
  /** `-log2(p)`, for the findings that are a probability. §34's actual metric. */
  informationBits?: number
}

/**
 * A candidate with the typed facts the gates need, and nothing else.
 *
 * Every optional field below comes off a record that already exists — an
 * `Anomaly`'s magnitude, a `Hypothesis`'s coverage, a `Prediction`'s probability.
 * None of them is re-derived from the candidate's prose, which is the failure
 * `deck.ts` calls out by name: reading a fact back out of a sentence somebody
 * generated is how a system starts confidently disagreeing with itself.
 */
export interface Finding {
  candidate: Attention
  /** Which record produced it. Shared with the shadow log so the two agree. */
  source: CandidateRecord['source']
  /** In standard deviations of the metric's own baseline. Anomalies only. */
  magnitude?: number
  /** Days of evidence behind it. Hypotheses carry this as temporal coverage. */
  coverageDays?: number
  /** How many independent sources agreed. A single-source pattern is a quirk. */
  diversity?: number
  /**
   * Which kind of proposition a hypothesis makes.
   *
   * Needed because the source-diversity test means completely different things
   * for the two. See the gate.
   */
  propositionKind?: 'association' | 'shift' | 'cadence_change'
  /** The predicted probability. Predictions only. */
  probability?: number
  /**
   * How wide the prediction's interval is, against how wide it would be with no
   * model at all. Predictions with a numeric interval only. See the gate.
   */
  interval?: { width: number; naiveWidth: number }
  /**
   * How many distinct values the outcome metric actually takes.
   *
   * A change point in a series that only ever reads 0, 1 or 2 is a step between
   * adjacent integers, which is not the thing change-point detection is for.
   */
  distinctValues?: number
  /** The object this is about, in the same vocabulary the widgets use. */
  focus?: string
  /** The subject, in `fitOf`'s vocabulary. */
  subject?: string
}

export interface SignificanceContext {
  now: Date
  /**
   * WHAT THE APP IS ALREADY SAYING. §49, and the only input here that is not a
   * property of the finding.
   *
   * Ids, never words. The rule is the one `deck.ts` settled: two things are the
   * same thing when they carry the same id, and comparing rendered titles is the
   * prose re-derivation this codebase refuses everywhere else.
   */
  onScreen?: { focus?: string[]; subjects?: string[] }
  /** id → when it was last surfaced to him. The only "he knows" with evidence. */
  seen?: Record<string, { at: string }>
}

/** Below this the evidence does not support saying it out loud at all. */
const CONFIDENCE_FLOOR = 0.45

/**
 * Two grounds, because one is an anecdote.
 *
 * A card with a single ground is a card whose "why am I seeing this" is one row.
 * That is not enough to defend a claim on his home screen, and §39's traceability
 * requirement is satisfied trivially and uselessly by it.
 */
const GROUNDS_FLOOR = 2

/**
 * `-log2(0.95)` ≈ 0.074 bits. The same bar `predictions.ts` applies at
 * generation, expressed here in the unit the argument is actually about.
 *
 * Both layers, on purpose. Generation declines to make the row; this declines to
 * say it. They can be reached independently — a prediction made when a routine
 * was at 0.7 and now sitting at 0.98 passed the first gate and must not pass this
 * one — and a rule that only exists at the moment of creation is a rule that
 * stops applying the moment anything changes underneath it.
 */
const INFORMATION_FLOOR = 0.075

/** Under one sigma is inside the noise the baseline already describes. */
const MAGNITUDE_FLOOR = 1

/**
 * How much of the no-model window a prediction may still occupy.
 *
 * Two thirds. A scope that narrows the plausible range by a third has told you
 * something; one that hands back four fifths of it has told you the marginal.
 * Generous on purpose — the honest failure here is a prediction that is wide
 * because his life genuinely is, and that should be suppressed for saying nothing
 * rather than treated as a modelling error.
 */
const INTERVAL_NARROWING = 0.67

/**
 * How many distinct values a metric needs before a change in it can be a shift.
 *
 * Six. Below that the series is a small-integer count and a "change point" is one
 * count replacing an adjacent one.
 */
const MIN_DISTINCT_VALUES = 6

/** Three days. Long enough that a repeat is a repeat, short enough to re-raise. */
const SAID_RECENTLY_MS = 3 * 86_400_000

/**
 * THE BAR FOR THE INTELLIGENCE SLOT, WHICH IS NOT THE BAR FOR INTERRUPTING HIM.
 *
 * `HOME_THRESHOLD` was the obvious constant to reach for and it is the wrong
 * question. Its own note says what it asks: "may this interrupt him", set high
 * because the cost of a wrong yes is that he stops trusting the screen. That is
 * the right bar for something claiming a band it had to win.
 *
 * The intelligence slot is not won and does not interrupt. §15 gives it a fixed
 * place on Home whose entire purpose is to hold one observation, and §67 says the
 * honest answer when nothing qualifies is a quiet slot. So the question it asks is
 * `ASKED_THRESHOLD`'s question — "is this worth saying at all" — against a surface
 * he is already looking at.
 *
 * MEASURED, NOT CHOSEN. Every candidate the memory core produced over four months
 * of the fixture scored between 0.18 and 0.28, because `scoreOf` multiplies by
 * actionability and an observation is not an action. Against 0.32 the slot would
 * be structurally empty forever — not quiet on quiet days, but incapable — and
 * §71's worked example could never appear no matter how good the cognition got.
 *
 * It sits above `ASKED_THRESHOLD` by a wide margin, because that bar is for a
 * screen he explicitly asked to see and this one still costs him attention he did
 * not ask to spend. And it is deliberately NOT the discriminator: the range above
 * is compressed enough that ranking barely separates the good candidates from the
 * bad, which is the point — the tests above this one are what do the separating,
 * and this only catches what is weak on every axis at once.
 */
export const INTELLIGENCE_THRESHOLD = 0.19

/**
 * DOES THIS DESERVE THE SLOT.
 *
 * Pure, and takes `now` rather than reading a clock, for the same reason
 * `runCycle` does: a shadow run replaying four months has to be able to ask this
 * question as of a Tuesday in June.
 */
export function significanceOf(f: Finding, ctx: SignificanceContext): Verdict {
  const a = f.candidate
  const score = scoreOf(a.scores, a.kind)
  const bits = f.probability === undefined ? undefined : -Math.log2(Math.max(1e-9, f.probability))
  const out = (surfaced: boolean, why: string, reason?: SuppressionReason): Verdict => ({
    surfaced,
    reason,
    why,
    score,
    informationBits: bits,
  })

  // ── Should it have been believed ──

  if (a.scores.confidence < CONFIDENCE_FLOOR) {
    return out(false, `confidence ${a.scores.confidence.toFixed(2)} is under the floor of ${CONFIDENCE_FLOOR}`, 'thin-evidence')
  }
  if (a.because.grounds.length < GROUNDS_FLOOR) {
    return out(false, `${a.because.grounds.length} ground(s); a claim needs at least ${GROUNDS_FLOOR}`, 'thin-evidence')
  }
  /*
    A CORRELATION FROM ONE SOURCE IS A FACT ABOUT THAT SOURCE — AND A SHIFT IS NOT.

    The distinction cost the flagship case before it was drawn. An `association`
    joins two metrics, so if both readings come from one connector the "pattern"
    may be that connector's quirk rather than his life, and two sources is the
    cheapest defence there is. A `shift` says one metric moved: it is single-metric
    by construction, its diversity is one by definition, and applying the same
    floor to it suppressed exactly the observation §64 names as the milestone's
    worked example — "your Tuesdays have shifted later" — for having the only
    evidence such a claim can ever have.

    Anomalies are excluded for the same reason and were from the start. The rule is
    not "one source is weak"; it is "one source cannot corroborate a claim ABOUT
    TWO THINGS".
  */
  if (f.source === 'hypothesis' && f.propositionKind === 'association' && f.diversity !== undefined && f.diversity < 2) {
    return out(false, 'both metrics come from one source — this may be a quirk of that connector', 'thin-evidence')
  }

  // ── Does the outcome carry anything ──

  if (bits !== undefined && bits < INFORMATION_FLOOR) {
    return out(
      false,
      `p=${f.probability!.toFixed(2)} carries ${bits.toFixed(3)} bits — the outcome was never in doubt`,
      'no-information'
    )
  }

  /**
   * AN INTERVAL THAT DOES NOT NARROW ANYTHING PREDICTS NOTHING.
   *
   * §34 is written about probability, and probability is the wrong axis for the
   * half of the predictions that commit to a range instead. "You will leave
   * between 07:43 and 12:29" is not near-certain, so it sails past the
   * information floor above, and it is worthless for a different reason: it names
   * most of the morning.
   *
   * `predictions.ts` builds the interval at ±1.5σ of the SCOPED series, so the
   * width is always about three sigmas of whatever it was given and can never
   * fail a test on width alone. What separates a real timing prediction from that
   * sentence is whether the scope KNOWS anything — whether his Tuesdays cluster
   * more tightly than his days in general. When the scoped spread equals the
   * overall spread, the model has learned nothing and the interval is just the
   * marginal distribution with a confident tone.
   *
   * Caught by the negative corpus, where departures are uniform across six hours:
   * every timing prediction came out four to five hours wide and every one of them
   * would have been shown.
   */
  if (f.interval && f.interval.naiveWidth > 0 && f.interval.width / f.interval.naiveWidth > INTERVAL_NARROWING) {
    return out(
      false,
      `a ${Math.round(f.interval.width)}-wide window against a ${Math.round(f.interval.naiveWidth)}-wide baseline — the scope knows nothing the marginal did not`,
      'no-information'
    )
  }

  /**
   * A STEP BETWEEN ADJACENT INTEGERS IS NOT A CHANGE IN HIS LIFE.
   *
   * Change-point detection assumes a measure that can move. `events_per_day` on a
   * quiet calendar takes three values — 0, 1, 2 — and over four months of random
   * days the detector duly found a date after which the mean was "higher by about
   * 1". In sigmas that is a respectable 1.2, because the standard deviation of a
   * three-valued series is itself about one; every test framed in sigmas passes it
   * and the claim is still meaningless.
   *
   * So the test is on the metric's own resolution rather than on the effect. Below
   * a handful of distinct values there is no shift to detect, only a count that
   * went up.
   */
  if (f.propositionKind === 'shift' && f.distinctValues !== undefined && f.distinctValues < MIN_DISTINCT_VALUES) {
    return out(
      false,
      `${f.distinctValues} distinct values — a step between adjacent counts is not a shift`,
      'too-small'
    )
  }

  // ── Is it big enough to be worth his attention ──

  if (f.magnitude !== undefined && f.magnitude < MAGNITUDE_FLOOR) {
    return out(false, `${f.magnitude.toFixed(2)}σ is inside the spread the baseline already describes`, 'too-small')
  }
  /*
    NOTHING TO DO AND NOTHING ABOUT TO HAPPEN.

    All three axes, not any one of them. A low-actionability finding about
    something happening in an hour is worth saying; so is a completely
    unactionable finding that is enormous. This catches only the case where every
    reason to interrupt him is absent at once — which is §33's "statistically true
    and completely worthless".
  */
  if (a.scores.actionability < 0.25 && a.scores.urgency < 0.2 && a.scores.relevance < 0.55) {
    return out(false, 'nothing to do, nothing imminent, and not especially relevant', 'not-actionable')
  }

  // ── Is the app already saying it ──

  if (f.focus && ctx.onScreen?.focus?.includes(f.focus)) {
    return out(false, `the widget in front is already showing ${f.focus}`, 'already-on-screen')
  }

  const last = ctx.seen?.[a.id]
  if (last && ctx.now.getTime() - Date.parse(last.at) < SAID_RECENTLY_MS) {
    return out(false, `surfaced at ${last.at}; not again this soon`, 'said-recently')
  }

  // ── Would it win ──

  if (score < INTELLIGENCE_THRESHOLD) {
    return out(false, `scored ${score.toFixed(3)}, under the ${INTELLIGENCE_THRESHOLD} slot threshold`, 'below-rank')
  }

  return out(true, `scored ${score.toFixed(3)} and cleared every gate`)
}

/**
 * The whole field, judged, ordered best-first.
 *
 * Returns EVERY finding with its verdict rather than the survivors, because the
 * suppressed ones are the more interesting half of a shadow run: a pass that
 * threw away nine things for one reason is telling you about a threshold, and a
 * pass that surfaced nothing is telling you the day was quiet. A function that
 * returned only the winners could not distinguish those.
 */
export function judge(findings: Finding[], ctx: SignificanceContext): { finding: Finding; verdict: Verdict }[] {
  return findings
    .map((finding) => ({ finding, verdict: significanceOf(finding, ctx) }))
    .sort((x, y) => Number(y.verdict.surfaced) - Number(x.verdict.surfaced) || y.verdict.score - x.verdict.score)
}
