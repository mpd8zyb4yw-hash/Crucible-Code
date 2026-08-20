/**
 * WHAT WE SAID TO HIM, AND WHAT HE DID ABOUT IT.
 *
 * `person.ts` already learns from this and the learning is good: accept and
 * dismiss counts per subject, a minimum evidence bar, decay, and a bounded effect
 * that can never overrule a stated preference. None of that is being rebuilt.
 *
 * What it cannot do is answer a question about an OCCASION. `engagement.travel`
 * says twelve accepted and nine dismissed; it cannot say which nine, what they
 * said, what argued for them, or whether the dismissed ones were the ones drawn
 * from a weak hypothesis. Those are the questions that would let the app get
 * better at recommending rather than merely quieter, and none of them survives
 * being summed into a pair of integers.
 *
 * So the occasions live here and the counters stay there. `foldIntoEngagement`
 * is the one direction of travel, and it aggregates — it never writes anything
 * `person.ts` does not already understand.
 *
 * THE BOUNDARY WITH `predictions.ts` IS ABSOLUTE. There is no import between
 * these two files in either direction, and that is a deliberate structural fact
 * rather than an accident of layout. A dismissal is evidence about what he wants
 * from us; a missed prediction is evidence about whether we understand his life.
 * §38's acceptance test asserts that a miss and a dismissal, both present, land
 * in different places and neither leaks. See the header of `predictions.ts` for
 * the two concrete ways the leak would be invisible.
 *
 * WHY RECOMMENDATIONS ARE NOT DERIVED STATE. `sql.ts` keeps these tables out of
 * `DERIVED_TABLES`, so a rebuild does not touch them. A recommendation was shown
 * on a screen at a time and he responded to it — that happened, it is not a
 * conclusion, and no improvement to the cognition regenerates it. Wiping it on a
 * rebuild would silently erase the whole engagement history and nothing anywhere
 * would notice.
 */

import { noteEngagement, type Person_ } from '../person.js'
import { hash, idOf } from './ids.js'
import type {
  EvidenceRef,
  MemoryStore,
  RecommendationInstance,
  RecommendationOutcome,
} from './types.js'

/**
 * Record that something was put in front of him.
 *
 * `reasoningRefs` is the field that makes this worth more than a counter: it
 * names the hypotheses, routines and predictions that argued for the
 * recommendation, so a subject he keeps dismissing can be traced back to the
 * models producing it. That is the difference between learning "he does not want
 * travel advice" and learning "the travel advice we generate from this weak
 * association is not wanted".
 */
export function recordRecommendation(
  store: MemoryStore,
  d: {
    subject: string
    recommendation: string
    shownAt: string
    context?: EvidenceRef[]
    reasoningRefs?: string[]
    attentionScore?: unknown
  }
): RecommendationInstance {
  const instance: RecommendationInstance = {
    // Keyed on what was said, to whom, when — so re-rendering the same card in
    // one pass does not produce two rows, and the same advice given a week later
    // does.
    id: idOf('rec', hash(`${d.subject}|${d.recommendation}|${d.shownAt}`)),
    subject: d.subject,
    recommendation: d.recommendation,
    context: d.context ?? [],
    reasoningRefs: d.reasoningRefs ?? [],
    shownAt: d.shownAt,
    attentionScore: d.attentionScore,
  }
  store.recommendations.put([instance])
  return instance
}

/**
 * Record what he did with it.
 *
 * The four verbs are kept apart rather than collapsed into accepted/dismissed,
 * because they are not the same evidence. Opening something and doing nothing is
 * interest without agreement; acting on it without ever opening the card is the
 * strongest signal there is. `person.ts`'s counters only have two buckets, so the
 * mapping happens at the aggregation step — where it is visible — rather than at
 * capture, where the distinction would be destroyed before anyone could use it.
 */
export function recordOutcome(
  store: MemoryStore,
  d: {
    recommendationId: string
    recordedAt: string
    opened?: boolean
    dismissed?: boolean
    accepted?: boolean
    actedOn?: boolean
    userFeedback?: string
    observedResult?: unknown
  }
): RecommendationOutcome {
  const outcome: RecommendationOutcome = {
    id: idOf('rco', d.recommendationId.replace(/^rec:/, '')),
    recommendationId: d.recommendationId,
    opened: d.opened,
    dismissed: d.dismissed,
    accepted: d.accepted,
    actedOn: d.actedOn,
    userFeedback: d.userFeedback,
    observedResult: d.observedResult,
    recordedAt: d.recordedAt,
  }
  store.recommendations.putOutcome([outcome])
  return outcome
}

/**
 * A verdict `person.ts` understands, or nothing at all.
 *
 * `null` is a real answer and is the right one for an outcome that records only
 * that he opened something. Opening is attention, not agreement, and pushing it
 * into the accept bucket would make the engagement counters measure how often a
 * card was on screen — which is a measure of the ranking, feeding the ranking.
 */
export function verdictOf(o: RecommendationOutcome): 'accepted' | 'dismissed' | null {
  if (o.actedOn || o.accepted) return 'accepted'
  if (o.dismissed) return 'dismissed'
  return null
}

export interface EngagementFold {
  applied: number
  skipped: number
  bySubject: Record<string, { accepted: number; dismissed: number }>
}

/**
 * AGGREGATE THE OCCASIONS INTO THE COUNTERS `person.ts` ALREADY KEEPS.
 *
 * Calls `noteEngagement` — the existing function, unmodified — once per decided
 * outcome. Nothing here writes `p.engagement` directly, which matters because
 * that field's invariants (it is behaviour, never a preference; it may never
 * silently rewrite a stated setting) are documented and enforced there, and a
 * second writer would be a second place for them to be forgotten.
 *
 * NOT IDEMPOTENT ACROSS CALLS, and deliberately so: it is a fold from a set of
 * outcomes onto a fresh `Person_`, not a running update. The caller passes the
 * person it wants populated. Folding twice onto the same person would double the
 * counts, which is exactly why the reflection cycle rebuilds the counters from
 * the outcome table rather than incrementing them as outcomes arrive.
 */
export function foldIntoEngagement(store: MemoryStore, p: Person_, now = new Date()): EngagementFold {
  const fold: EngagementFold = { applied: 0, skipped: 0, bySubject: {} }
  const bySubject = new Map(store.recommendations.all().map((r) => [r.id, r.subject]))

  for (const outcome of store.recommendations.outcomes()) {
    const subject = bySubject.get(outcome.recommendationId)
    if (!subject) {
      fold.skipped++
      continue
    }
    const verdict = verdictOf(outcome)
    if (!verdict) {
      fold.skipped++
      continue
    }
    noteEngagement(p, subject, verdict, new Date(outcome.recordedAt))
    fold.applied++
    const held = fold.bySubject[subject] ?? { accepted: 0, dismissed: 0 }
    held[verdict === 'accepted' ? 'accepted' : 'dismissed']++
    fold.bySubject[subject] = held
  }

  void now
  return fold
}

/**
 * How a subject's recommendations have actually landed.
 *
 * Reported rather than acted on. The bounded nudge from this evidence is
 * `engagementBiasOf`'s job and stays there; this exists so a developer — and
 * eventually a surface — can see which subjects are being ignored and, through
 * `reasoningRefs`, which models are producing the ignored ones.
 */
export function recommendationReport(store: MemoryStore): {
  subject: string
  shown: number
  accepted: number
  dismissed: number
  undecided: number
  fromModels: string[]
}[] {
  const bySubject = new Map<
    string,
    { shown: number; accepted: number; dismissed: number; undecided: number; models: Set<string> }
  >()

  const outcomes = new Map(store.recommendations.outcomes().map((o) => [o.recommendationId, o]))
  for (const rec of store.recommendations.all()) {
    const held =
      bySubject.get(rec.subject) ?? { shown: 0, accepted: 0, dismissed: 0, undecided: 0, models: new Set<string>() }
    held.shown++
    for (const m of rec.reasoningRefs) held.models.add(m)
    const verdict = outcomes.has(rec.id) ? verdictOf(outcomes.get(rec.id)!) : null
    if (verdict === 'accepted') held.accepted++
    else if (verdict === 'dismissed') held.dismissed++
    else held.undecided++
    bySubject.set(rec.subject, held)
  }

  return [...bySubject.entries()]
    .map(([subject, h]) => ({
      subject,
      shown: h.shown,
      accepted: h.accepted,
      dismissed: h.dismissed,
      undecided: h.undecided,
      fromModels: [...h.models].sort(),
    }))
    .sort((a, b) => b.shown - a.shown)
}
