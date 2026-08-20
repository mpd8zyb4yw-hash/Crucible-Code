/**
 * THE MEMORY CORE'S FINDINGS, AS CANDIDATES FOR THE ATTENTION SYSTEM IT ALREADY
 * HAS.
 *
 * §25 and §46 are unusually firm about this and they are right: `attention.ts`
 * is not being rebuilt, extended, wrapped or competed with. It scores six axes,
 * it knows when an item stops mattering, it knows which corrections it can
 * actually implement, and it will frequently and correctly decide to show
 * nothing. A second ranking engine would mean two answers to "what matters now",
 * and the app would show whichever one happened to run.
 *
 * So this file is a TRANSLATION and nothing more. An anomaly becomes an
 * `Attention`; a supported hypothesis becomes an `Attention`; and then they queue
 * up with the conflicts and the obligations and take their chances.
 *
 * THE THREE THINGS THE TRANSLATION HAS TO GET RIGHT.
 *
 *   · `because.grounds` MUST BE REAL. Every ground points at a row that exists —
 *     an observation, an episode, a routine, a prediction — and `says` states what
 *     that row contributes. This is what §39 tests: for every surfaced item, the
 *     evidence must be enumerable back to raw source events. A card whose grounds
 *     are prose is a card nobody can check.
 *
 *   · `kind` DECIDES WHAT `scoreOf` DOES WITH IT. A deviation is not an
 *     obligation and is not a warning: nothing is going to happen at a time, and
 *     he did not ask to be told. `recommendation` is the honest kind for most of
 *     what is here, which also means it is scored with the actionability
 *     multiplier — as it should be, because an observation he can do nothing about
 *     should struggle to reach a screen.
 *
 *   · `life` MUST NOT BE A TIMER BY DEFAULT. `attention.ts`'s own note explains
 *     the bug: a flat 12-hour timer is right for model prose and wrong for a
 *     dinner on Wednesday. A change point is `recompute` — it is true only while
 *     the next pass keeps deriving it. A missed routine is `passes` at the end of
 *     its day, because tomorrow it is not news.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO: decide anything is worth showing.
 * There is no threshold here. `compose` owns that, and it owns it alone.
 */

import { addDays, dayIn } from '../clock.js'
import type { Attention, Correction, Ground, Scores } from '../attention.js'
import { life } from '../attention.js'
import type {
  Anomaly,
  EvidenceRef,
  Hypothesis,
  MemoryStore,
  Prediction,
  TemporalSummary,
} from './types.js'
import { hypothesisSentence } from './hypotheses.js'
import { predictionSentence } from './predictions.js'

/**
 * Evidence → grounds, keeping the epistemic class.
 *
 * The mapping is the point. `attention.ts` uses `Ground.kind` to decide which
 * corrections it can offer — you cannot argue with an observation, you very much
 * can argue with an inference — so getting this wrong produces a card with a
 * "that's wrong" button pointed at a calendar row, which teaches him the button
 * does nothing.
 *
 *   observation / event → 'observation'  (a source said it; not arguable)
 *   episode / entity    → 'computation'  (we joined records; arguable via inputs)
 *   routine / hypothesis / prediction → 'inference' (our conclusion; correctable)
 */
const GROUND_KIND: Record<EvidenceRef['kind'], Ground['kind']> = {
  event: 'observation',
  observation: 'observation',
  episode: 'computation',
  entity: 'computation',
  routine: 'inference',
  hypothesis: 'inference',
  prediction: 'inference',
  fact: 'fact',
}

const groundsFrom = (evidence: EvidenceRef[]): Ground[] =>
  evidence.slice(0, 6).map((e) => ({ kind: GROUND_KIND[e.kind] ?? 'computation', id: e.id, says: e.says ?? e.id }))

export interface CandidateOptions {
  /** His zone, for the day boundary a `passes` lifecycle ends on. */
  timeZone?: string
  /** The subject vocabulary `fitOf` and `not-relevant` already use. */
  subjectFor?: (about: string) => string
}

/**
 * WHICH SUBJECT A FINDING BELONGS TO.
 *
 * `attention.ts`'s `fitOf` and the `not-relevant` correction both key on a
 * subject string, and `person.ts`'s engagement counters use the same vocabulary.
 * Inventing a new one here would mean the memory core's cards were invisible to
 * the proactivity loop — they would be ranked, shown, dismissed, and nothing
 * would learn from the dismissal.
 */
function subjectOf(domain: string): string {
  if (domain.startsWith('activity')) return 'fitness'
  if (domain.startsWith('location')) return 'travel'
  if (domain.startsWith('calendar')) return 'schedule'
  return 'general'
}

// ── Anomalies ────────────────────────────────────────────────────────────────

/**
 * An anomaly, as something that could be said.
 *
 * The scores are computed from the anomaly's own arithmetic, not chosen. That is
 * what makes them arguable later: when something wrong reaches a screen, the axis
 * that overrated it is visible in the record, which is the property
 * `attention.ts`'s six-axis design exists to provide and which a single
 * hand-picked priority number destroys.
 */
export function anomalyCandidate(a: Anomaly, now: Date, opts: CandidateOptions = {}): Attention {
  const subject = subjectOf(a.subject)
  const dayEnd = `${addDays(a.day, 1)}T00:00:00.000Z`

  const scores: Scores = {
    /**
     * How far out it is, saturating. A three-sigma miss and a nine-sigma miss are
     * both "very unusual", and letting the second dominate the ranking would mean
     * one broken sensor outranking everything true.
     */
    relevance: Math.min(1, 0.4 + a.magnitude / (a.magnitude + 30)),
    confidence: a.confidence,
    /**
     * A change point is the one kind with no urgency at all: it describes
     * something that has been true for weeks and will be true tomorrow. A missed
     * routine is urgent only for the rest of its day.
     */
    urgency: a.kind === 'change_point' ? 0.1 : a.day >= dayIn(now, opts.timeZone) ? 0.6 : 0.2,
    /**
     * ACTIONABILITY IS LOW AND SAYING SO IS THE HONEST PART. "You are below your
     * usual Thursday" is an observation, not a thing to do, and `scoreOf`
     * multiplies it down accordingly. A card that inflates this to reach the
     * screen is a card that promises an action it does not have.
     */
    actionability: a.kind === 'routine_missed' ? 0.5 : 0.2,
    // `noveltyOf` needs the seen-map the composer holds; a fresh finding starts
    // high and the composer decays it. Set once here rather than guessed twice.
    novelty: 0.8,
    fit: 0.6,
  }

  return {
    id: a.id,
    kind: a.kind === 'prediction_miss' ? 'recommendation' : 'recommendation',
    title: titleOf(a),
    detail: a.why,
    because: {
      sentence: a.why,
      grounds: groundsFrom(a.evidence),
    },
    scores,
    score: 0,
    basis: a.evidence.map((e) => e.id),
    corrections: [
      { verb: 'not-relevant', label: `Don't tell me about ${subject}`, about: subject },
    ] satisfies Correction[],
    at: a.kind === 'change_point' ? undefined : dayEnd,
    /**
     * A change point is true while it keeps being derived; everything else is
     * about a day and is over when the day is. Neither is a timer, and the
     * difference is `attention.ts`'s own argument about lifecycles.
     */
    life:
      a.kind === 'change_point'
        ? life.recompute('this shift')
        : life.until(dayEnd, `${a.day} `),
    uncertainty: uncertaintyOf(a),
  }
}

function titleOf(a: Anomaly): string {
  switch (a.kind) {
    case 'routine_missed':
      return `No ${String(a.expected ?? 'usual')} today`
    case 'routine_timing':
      return 'Later than usual'
    case 'baseline_deviation':
      return `${a.subject} is off its usual`
    case 'change_point':
      return 'Something has changed'
    case 'contact_cadence':
      return 'You have been in touch less'
    case 'prediction_miss':
      return 'That went differently'
  }
}

/**
 * WHAT WE DO NOT KNOW, STATED RATHER THAN HIDDEN.
 *
 * `Attention.uncertainty` exists for this and almost nothing populates it. An
 * anomaly is exactly the case where it earns its place: a deviation computed from
 * eight days of baseline and one computed from ninety are presented identically
 * on a card, and only this field can tell them apart.
 */
function uncertaintyOf(a: Anomaly): string[] {
  const out: string[] = []
  if (a.confidence < 0.5) out.push('this is a thin baseline — it may just be a quiet week')
  if (a.kind === 'routine_missed') out.push('a plan can change without anything being wrong')
  if (a.kind === 'baseline_deviation') out.push('other things affect this that are not being measured')
  return out
}

// ── Hypotheses ───────────────────────────────────────────────────────────────

/**
 * A hypothesis, as something that could be said — and only if it has earned it.
 *
 * Returns null below `supported`. That is a filter on WHAT MAY BE PHRASED AT ALL,
 * which is different from the ranking filter `compose` applies: an `emerging`
 * association is a real thing for the system to hold and is not a thing to tell
 * somebody about, because the honest sentence for it would be "we have noticed
 * something four times and are not sure", and that is noise however well it
 * scores.
 */
export function hypothesisCandidate(
  h: Hypothesis,
  now: Date,
  label: (metric: string) => string = (m) => m
): Attention | null {
  if (h.status !== 'supported') return null

  const sentence = hypothesisSentence(h, label)
  const domain = h.proposition.kind === 'association' ? h.proposition.then.scope ?? '' : ''

  return {
    id: h.id,
    kind: 'recommendation',
    title: h.proposition.kind === 'shift' ? 'A pattern has moved' : 'A pattern worth knowing',
    /**
     * THE SUPPORT SPLIT IS IN THE SENTENCE, not only in the record.
     *
     * "on nineteen of the twenty-three" is the difference between an observation
     * he can weigh and one he has to take on faith, and it costs eight words. It
     * is also the mechanical guard against §39: a card that cannot state its own
     * evidence count is a card whose evidence nobody checked.
     */
    detail: `${sentence} — on ${h.support} of the ${h.support + h.contradiction} occasions there was enough to tell.`,
    because: {
      sentence: `${h.support} for, ${h.contradiction} against, over ${h.temporalCoverageDays} days and ${h.evidenceDiversity} independent sources`,
      grounds: groundsFrom(h.evidence),
    },
    scores: {
      relevance: 0.6,
      confidence: h.confidence,
      // A pattern that has held for months is not news that decays in an hour.
      urgency: 0.1,
      actionability: 0.3,
      novelty: 0.7,
      fit: 0.6,
    },
    score: 0,
    basis: h.evidence.map((e) => e.id),
    corrections: [
      /**
       * "That's wrong" pointed at the HYPOTHESIS, which is the most correctable
       * thing on the card — and is a real target, unlike the observations under
       * it. `standardCorrections` would find this itself from the grounds; it is
       * stated explicitly so the label names the claim rather than an id.
       */
      { verb: 'wrong', label: "That's not right", target: { kind: 'inference', id: h.id } },
      { verb: 'not-relevant', label: `Don't tell me about ${subjectOf(domain)}`, about: subjectOf(domain) },
    ] satisfies Correction[],
    life: life.recompute('this pattern'),
    uncertainty: [
      'this is an association, not a cause — something else may explain both',
      ...(h.evidenceDiversity < 2 ? ['it comes from a single source, so it may be a quirk of that source'] : []),
    ],
  }
}

// ── The cross-domain join ────────────────────────────────────────────────────

/**
 * TODAY'S DEVIATION, EXPLAINED BY A PATTERN THAT ALREADY HELD.
 *
 * This is §23's example turned into a function, and it is the single most
 * valuable thing in this file — the difference between:
 *
 *     "You're below your usual Thursday."
 *
 * and:
 *
 *     "You're below your usual Thursday, but this looks like the
 *      meeting-heavy-day pattern rather than a change — five of your last six
 *      similarly scheduled Thursdays ended low too."
 *
 * The second is not better wording. It contains a claim the first does not, it is
 * built entirely from typed structures that already exist, and the language model
 * — when one is eventually involved — is only rendering it. Nothing here asks a
 * model to notice the connection; the connection is a join, in code, between an
 * anomaly and a hypothesis whose condition holds today.
 *
 * Returns null when no supported hypothesis covers the anomaly, which is the
 * common case and the correct one: an unexplained deviation stays an unexplained
 * deviation rather than acquiring a story.
 */
export function explainedAnomaly(
  anomaly: Anomaly,
  hypotheses: Hypothesis[],
  todayValues: Record<string, number>,
  now: Date,
  opts: CandidateOptions = {}
): Attention | null {
  const metric = anomaly.subject.split('.').pop() ?? ''
  const explanation = hypotheses.find((h) => {
    if (h.status !== 'supported') return false
    if (h.proposition.kind !== 'association') return false
    if (h.proposition.then.metric !== metric) return false
    // The condition has to actually HOLD TODAY, or the pattern is irrelevant to
    // what happened — which is the join everything here exists to make.
    const conditionValue = todayValues[h.proposition.when.metric]
    if (conditionValue === undefined) return false
    const holds =
      h.proposition.when.comparator === 'above'
        ? conditionValue > h.proposition.when.threshold
        : conditionValue < h.proposition.when.threshold
    if (!holds) return false
    // And it has to predict the direction the deviation actually went.
    const wentLow = Number(anomaly.observed ?? 0) < Number(anomaly.expected ?? 0)
    return h.proposition.then.direction === (wentLow ? 'lower' : 'higher')
  })

  if (!explanation) return null
  const base = anomalyCandidate(anomaly, now, opts)

  return {
    ...base,
    id: `${base.id}:explained`,
    title: 'Below your usual, and probably why',
    detail: `${anomaly.why}. On ${explanation.support} of the ${explanation.support + explanation.contradiction} comparable days this has happened too, so this looks like the pattern rather than a change.`,
    because: {
      sentence: `${anomaly.why}, and a pattern supported by ${explanation.support} of ${explanation.support + explanation.contradiction} comparable days`,
      grounds: [
        ...base.because.grounds,
        { kind: 'inference', id: explanation.id, says: hypothesisSentence(explanation) },
      ],
    },
    scores: {
      ...base.scores,
      /**
       * MORE CONFIDENT AND LESS ALARMING THAN THE BARE DEVIATION.
       *
       * Two structures agreeing is better evidence, so confidence rises. But an
       * explained deviation is LESS worth interrupting for than an unexplained
       * one — "this is your normal meeting-day pattern" is reassurance, and
       * reassurance is not urgent. Both moves are deliberate and they go in
       * opposite directions, which is only expressible because the axes are kept
       * apart.
       */
      confidence: Math.min(0.9, (base.scores.confidence + explanation.confidence) / 2 + 0.15),
      urgency: base.scores.urgency * 0.5,
      relevance: Math.min(1, base.scores.relevance + 0.1),
    },
    basis: [...base.basis, explanation.id],
    uncertainty: [
      'this is an association, not a cause',
      ...(base.uncertainty ?? []),
    ],
  }
}

// ── Predictions ──────────────────────────────────────────────────────────────

/**
 * An upcoming prediction, offered only when it is about something soon and is
 * uncertain enough to be worth mentioning.
 *
 * `life.until` the window's end, because a prediction about tomorrow is over
 * tomorrow — this is precisely the case `attention.ts`'s lifecycle note is about,
 * and a timer would leave it on the screen after it had already been resolved.
 */
export function predictionCandidate(p: Prediction, label: (id: string) => string = (x) => x): Attention | null {
  if (p.status !== 'pending') return null
  // A near-certainty is not worth saying either; the same argument as
  // `CERTAIN_ENOUGH` in `predictions.ts`, one layer up.
  if ((p.probability ?? 0) > 0.95) return null

  return {
    id: p.id,
    kind: 'suggestion',
    title: 'Probably today',
    detail: predictionSentence(p, label),
    because: {
      sentence: `from ${p.modelBasis.join(', ')}`,
      grounds: groundsFrom(p.evidence),
    },
    scores: {
      relevance: 0.5,
      confidence: p.confidence,
      urgency: 0.5,
      actionability: 0.4,
      novelty: 0.6,
      fit: 0.5,
    },
    score: 0,
    basis: p.evidence.map((e) => e.id),
    corrections: [{ verb: 'wrong', label: "That's not what I'm doing", target: { kind: 'inference', id: p.id } }],
    at: p.resolutionWindow.end,
    life: life.until(p.resolutionWindow.end, 'the day this was about'),
  }
}

// ── Everything at once ───────────────────────────────────────────────────────

/**
 * Every candidate the memory core has today, for the composer to rank.
 *
 * Explained anomalies REPLACE their bare form rather than sitting beside it. Two
 * cards about one deviation — one saying it is unusual and one saying it is the
 * usual pattern — is the app arguing with itself on his screen, which is worse
 * than either card alone.
 */
export function memoryCandidates(
  store: MemoryStore,
  anomalies: Anomaly[],
  now: Date,
  todayValues: Record<string, number>,
  opts: CandidateOptions = {}
): Attention[] {
  const hypotheses = store.hypotheses.all()
  const out: Attention[] = []
  const explained = new Set<string>()

  for (const a of anomalies) {
    const withReason = explainedAnomaly(a, hypotheses, todayValues, now, opts)
    if (withReason) {
      out.push(withReason)
      explained.add(a.id)
      continue
    }
    out.push(anomalyCandidate(a, now, opts))
  }

  for (const h of hypotheses) {
    const card = hypothesisCandidate(h, now)
    // A hypothesis already used to explain today's deviation does not also get
    // its own card.
    if (card && ![...explained].some((id) => out.some((c) => c.id === `${id}:explained` && c.basis.includes(h.id)))) {
      out.push(card)
    }
  }

  for (const p of store.predictions.pending()) {
    const card = predictionCandidate(p)
    if (card) out.push(card)
  }

  return out
}

/** A summary's own label, for a sentence. Kept here so cards read in his terms. */
export const metricLabel = (s: TemporalSummary): string =>
  s.metric === 'steps' ? 'your step count' : s.metric === 'events_per_day' ? 'how much is in your calendar' : s.metric === 'departure_minute' ? 'when you leave' : s.metric
