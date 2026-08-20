/**
 * THE CROSS-SOURCE PASS.
 *
 * Everything above this file retrieves; everything below it renders. This is
 * the only place that is allowed to look at the calendar, the map, the step
 * counts, the goals and his stated preferences AT THE SAME TIME and conclude
 * something none of them contains.
 *
 * It exists because the alternative was tried and does not work. Every surface
 * calling a model with whatever it happens to hold produces six confident,
 * locally-correct, mutually-ignorant answers: Calendar knows there is a dinner,
 * Maps knows where the restaurant is, the world model knows he does not drive,
 * and nothing says "leave at half four". A model given all of it at once does
 * better but cannot be held to it — asked what matters today it will always
 * produce something, and it has no way to produce nothing.
 *
 * So conclusions are computed HERE, in code, from typed inputs, each carrying
 * the records it stands on. The model's remaining job — wording — is a job it
 * is actually good at, and one where being wrong is cheap.
 *
 * THE RULE THIS FILE IS BUILT AROUND: every item must be able to answer "why am
 * I seeing this?" by pointing at things, and must offer a way to be told it is
 * wrong that changes the MODEL rather than hiding the card. An item that cannot
 * do both does not belong on Home, however true it is.
 */

import {
  bandOf,
  compose,
  fitOf,
  life,
  noveltyOf,
  urgencyOf,
  whenOf,
  type Attention,
  type Composed,
  type Correction,
} from './attention.js'
import { activityReport, type ActivityReport } from './activity.js'
import { budgetForHome } from './homeCopy.js'
import { countdown, dayIn, relativeDay, timeLabel } from './clock.js'
import {
  clarificationStyleOf,
  demand,
  detectConflicts,
  getFact,
  SLOTS,
  type Conflict,
  type Person_,
  type Reading,
} from './person.js'
import {
  demandRelationship,
  liftOptions,
  liftStanceOf,
  peopleOnEvent,
  relationshipOf,
  relationshipOptions,
} from './people.js'
import { liftDraft } from './draft.js'
import { planTravel, type TravelPlan } from './plan.js'
import type { Need } from './think.js'
import type { World } from './world.js'

export interface InsightRun {
  ranked: Composed
  plans: TravelPlan[]
  conflicts: Conflict[]
  /** The activity state, computed once and read by Home and the surface alike. */
  activity: ActivityReport
  /** Everything considered and not surfaced, with the reason. */
  notes: string[]
}

/**
 * Build the attention list.
 *
 * Takes the world and the person and returns what matters, ranked. Mutates the
 * person only through `demand()` — the record that something wanted a fact and
 * could not have it — which is what the question engine reads. Nothing else in
 * here writes to the model, because a pass that both concludes and rewrites its
 * own inputs cannot be run twice with the same result.
 */
export async function buildInsights(
  w: World,
  p: Person_,
  opts: { now?: Date; seen?: Record<string, { at: string; score: number }>; offline?: boolean } = {}
): Promise<InsightRun> {
  const now = opts.now ?? new Date()
  const seen = opts.seen ?? {}
  const items: Attention[] = []
  const notes: string[] = []

  /**
   * Forget what we no longer need to ask.
   *
   * `demand()` records a want and nothing cleared it, so a slot he answered
   * last week kept generating a question until something happened to overwrite
   * it. Pruning at the START of the pass — before anything demands anything —
   * means the list always describes THIS pass's gaps rather than an accumulated
   * history of everything that was ever missing.
   */
  for (const key of Object.keys(p.demands)) {
    const held = getFact(p, key)
    if (held && held.status !== 'unknown') {
      delete p.demands[key]
      notes.push(`${key} is now known; stopped asking`)
    }
  }

  // ── Travel: the calendar × maps × preference join ──────────────────────────
  let plans: TravelPlan[] = []
  if (!opts.offline) {
    try {
      const out = await planTravel(w, p, { now })
      plans = out.plans
      for (const s of out.skipped) notes.push(`no travel plan for ${s.eventId}: ${s.why}`)
    } catch (e) {
      notes.push(`travel planning failed: ${(e as Error).message}`)
    }
  } else {
    notes.push('travel planning skipped: this build is offline')
  }

  for (const plan of plans) {
    items.push(travelItem(plan, p, seen, now, w.timeZone))
    /**
     * The people-aware journey rides on the SAME plan rather than recomputing
     * one. Two cards about one evening that disagreed about the distance would
     * be the "one answer, three windows" rule broken inside a single file.
     */
    const lift = liftItem(plan, p, seen, now, w.timeZone)
    if (lift) items.push(lift)
  }

  // ── Disagreement between sources ───────────────────────────────────────────
  const readings = readingsFrom(w, p, now)
  const conflicts = detectConflicts(readings, p.conflicts, now)
  p.conflicts = conflicts

  for (const c of conflicts) {
    if (c.state !== 'open') {
      notes.push(`${c.metric} conflict for ${c.scope} already settled on ${c.resolvedTo}`)
      continue
    }
    items.push(conflictItem(c, p, seen, now))
  }

  /*
    ── Activity, against his goal and his chosen source ───────────────────────

    Computed BEFORE the questions, and the order is the point. A question is
    generic exactly when it is asked without the state that provoked it: "what
    are you trying to get out of tracking?" is a survey prompt, and "you have
    averaged about 2,900 steps over 6 of the last 7 days — I do not know whether
    you are trying to walk more, get fitter, or just keep an eye on it" is a
    question about him. The second needs this report, so it has to exist first.
  */
  const activity = activityReport({ ...w, person: p }, p, { now })

  // ── Questions whose answers are actually blocked on ────────────────────────
  for (const item of clarificationItems(p, seen, now, activity)) items.push(item)

  for (const item of activityItems(activity, p, seen, now)) items.push(item)

  /**
   * ── COMPOSE ────────────────────────────────────────────────────────────────
   *
   * Everything above BUILDS candidates; nothing above decides what reaches the
   * screen. That decision — withdraw what has ended, drop duplicates of one gap,
   * rank, cut to his volume — is `compose`, in `attention.ts`, and it is the same
   * function for every source of candidates. The dedupe rules and the Home limit
   * used to live here as local constants, which meant this file was quietly the
   * composition layer while claiming to be the cross-source pass.
   */
  const ranked = compose(items, p, { now })
  notes.push(...ranked.notes)

  /**
   * ASK HIM HOW MUCH HE WANTS, ONCE IT IS VISIBLY COSTING HIM SOMETHING.
   *
   * `assistant.proactivity` was read by the ranker and settable only by an API
   * call nobody but me would make. This is the moment it becomes a real question:
   * the ranking has just held several things back, so his answer would visibly
   * change what he sees, which is the same demand-driven bar every other question
   * in this app has to clear. Recorded as a demand rather than pushed as a card,
   * so it queues behind anything more useful and arrives on a later pass.
   */
  if (ranked.held.length >= 3 && !getFact(p, 'assistant.proactivity')) {
    demand(p, 'assistant.proactivity', `deciding how much to put on your home screen — I held back ${ranked.held.length} things this time`)
  }

  return { ranked, plans, conflicts, activity, notes }
}

// ── Travel ───────────────────────────────────────────────────────────────────

function travelItem(
  plan: TravelPlan,
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date,
  tz?: string
): Attention {
  const complete = plan.leaveBy !== undefined
  /**
   * "Leave about 16:30 — tomorrow" rather than "Leave about 16:30".
   *
   * The day was missing entirely, which is worse than it sounds: a leave-by time
   * with no day attached reads as today, and the dinner it was computed for is on
   * the 12th. Both halves now come from `clock.ts` — the clock from `timeLabel`,
   * the day from `relativeDay` — so neither is a locale accident or a model's
   * recollection.
   */
  const when = whenOf({ at: plan.leaveBy ?? plan.event.start } as Attention, now, tz)
  const title = complete
    ? `Leave ${clockOf(plan.leaveBy!, p, tz)} ${when ? `· ${when}` : ''} for ${plan.event.summary}`.replace(/\s+/g, ' ').trim()
    : plan.destination.state === 'ambiguous'
      ? `Which ${plan.destination.query}?`
      : plan.destination.state === 'unresolved'
        ? `I cannot place "${plan.destination.query}"`
        : `Getting to ${plan.event.summary}`

  /**
   * The corrections offered depend on WHAT IS ACTUALLY WRONG with this plan.
   *
   * An ambiguous destination is the clearest case: the geocoder returned four
   * real places and the app cannot tell which he means. Offering "I usually
   * walk" there is answering a question nobody asked, while the one useful
   * control — naming the right place — is missing. So when the destination is
   * the blocker, the candidates ARE the chips, and choosing one writes the
   * coordinate under the same `place.*` key the planner reads next time.
   */
  const corrections: Correction[] =
    plan.destination.state === 'ambiguous'
      ? [
          ...(plan.destination.candidates ?? []).slice(0, 3).map(
            (c): Correction => ({
              verb: 'set-preference',
              /**
               * Labelled by TOWN, not by the first fragment of the address.
               *
               * Nominatim's `sub` starts at the house number, so taking its
               * first element produced chips reading "Osteria del Sole — 1d",
               * which distinguishes nothing. The last fragment before the
               * country is the locality, which is the only part that tells two
               * restaurants of the same name apart.
               */
              label: localityOf(c.sub) ? `${c.label} — ${localityOf(c.sub)}` : c.label,
              key: `place.${slug(plan.destination.query)}`,
              value: { lat: c.lat, lon: c.lon, label: c.label },
            })
          ),
          { verb: 'not-relevant', label: 'Do not plan my travel', about: 'travel' },
        ]
      : [
          { verb: 'set-preference', label: 'I usually walk', key: 'transport.default', value: 'walk' },
          { verb: 'set-preference', label: 'I take the bus', key: 'transport.default', value: 'transit' },
          {
            verb: 'wrong',
            label: 'Wrong place',
            target: { kind: 'fact', id: `place.${slug(plan.destination.query)}` },
            note: 'He said the geocoded location is not the right place.',
          },
          { verb: 'not-relevant', label: 'Do not plan my travel', about: 'travel' },
        ]

  return {
    id: plan.id,
    kind: 'obligation',
    title,
    detail: plan.because.sentence,
    because: plan.because,
    basis: plan.because.grounds.filter((g) => g.kind === 'observation').map((g) => g.id),
    corrections,
    at: plan.leaveBy ?? plan.event.start,
    /**
     * A JOURNEY ENDS WHEN THE EVENT STARTS, not on a twelve-hour timer and not
     * when it is recomputed.
     *
     * Anchored on the EVENT rather than on the leave-by time, because those are
     * different instants and only one of them ends the item's usefulness: past
     * the leave-by he is late and still wants to know, past the start there is
     * nothing left to say. `PASSED_GRACE_MIN` then keeps it on screen for a
     * quarter of an hour beyond that, which is the window in which "you should
     * have left" is the single most relevant thing the app could be saying.
     */
    life: life.until(plan.event.start, `${plan.event.summary}`),
    opens: { surface: 'Calendar', focus: plan.eventId },
    uncertainty: plan.uncertainty,
    scores: {
      /**
       * An event he has to physically get to is about as relevant as this app
       * gets. It is not scaled by confidence here — that is a separate axis,
       * and multiplying them in one number is how a genuinely important thing
       * with one unknown drops below a trivial thing that is fully known.
       */
      relevance: 0.95,
      confidence: plan.confidence,
      urgency: urgencyOf(plan.leaveBy ?? plan.event.start, now),
      /**
       * A plan with a leave-by time is directly actionable. A plan blocked on a
       * question is ALSO actionable — the action is answering — but slightly
       * less so, because answering does not by itself get him there.
       */
      actionability: complete ? 1 : plan.uncertainty.length ? 0.75 : 0.5,
      novelty: noveltyOf(plan.id, seen, now),
      fit: fitOf(p, 'obligation', 'travel'),
    },
    score: 0,
  }
}

// ── The journey that needs another person ────────────────────────────────────

/**
 * AN EVENT HE CANNOT GET TO, AND SOMEONE HE KNOWS WHO IS GOING TOO.
 *
 * This is the one journey that needs all four things at once, and it is the case
 * the old architecture could not reach at all: the calendar knows about the
 * dinner, the router knows it is 57 km away, the personal model knows he does not
 * drive, and `attendees[]` knows Anna and Paolo are going. Every part was
 * present. Nothing joined them, so the app's best offer was a leave-by time it had
 * correctly refused to compute.
 *
 * WHAT IT DOES NOT DO, and this is most of the design.
 *
 *   · It does not claim anyone gives him lifts. Nothing in his data says that, and
 *     `people.ts` refuses to infer it from attendance. The card says who else is
 *     going and asks how he is getting there — which is what a person would say.
 *
 *   · It does not send anything. There is no "Ask Anna for a lift" button that
 *     mails a stranger. The suggestion is what to do, not a thing the app does on
 *     his behalf to someone else.
 *
 *   · It does not appear when he can plainly get there. A leave-by time means the
 *     journey is solved and mentioning his fellow guests would be trivia.
 *
 *   · It DOES ask who they are, once, through the ordinary demand mechanism —
 *     because "someone I sometimes get a lift from" and "a client" produce
 *     completely different advice and the app has no business guessing which.
 *
 * When he answers, the answer is a typed `relationship` Fact `by: 'user'`, and it
 * changes this card permanently: a person he has said he does not know well is
 * never suggested again.
 */function liftItem(
  plan: TravelPlan,
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date,
  tz?: string
): Attention | null {
  /**
   * Solved journeys need no help; this fires on the ones that are genuinely stuck,
   * and "stuck" is read off the plan's typed `blocked` field rather than by matching
   * `/too far/i` against the sentence the planner wrote. That regex was the first
   * version of this line and it was the mistake `normaliseEvent` exists to forbid,
   * arriving one level up: a reader parsing prose this app produced, so a better
   * wording would have silently switched the card off.
   *
   * Only these two blockers, deliberately. An unresolved destination or an unknown
   * origin means the app does not know where he is going or coming from, and naming
   * his fellow guests would be changing the subject.
   */
  if (plan.leaveBy !== undefined) return null
  if (plan.blocked !== 'too-far' && plan.blocked !== 'no-timetable') return null

  const attendees = plan.attendees ?? []
  const known = peopleOnEvent(p, attendees)
  if (!known.length) return null

  /**
   * ANYONE HE HAS RULED OUT IS EXCLUDED, PERMANENTLY, AND BY EITHER ROUTE.
   *
   * Two different things he can have said, and both have to be honoured here or
   * the app asks a question he has already answered:
   *
   *   · "Not Anna" — the `lift` verb, which is a decision about exactly this.
   *   · "Not someone I know well" — the `relationship` verb, which is a
   *     description, and one that plainly rules the ask out.
   *
   * Someone with neither on file is INCLUDED. Not because anything is assumed
   * about them, but because "Anna is also going" is a true and useful thing to
   * say about a journey regardless of who Anna turns out to be.
   */
  const askable = known.filter((person) => {
    if (liftStanceOf(p, person.id)?.value === 'never') return false
    const rel = relationshipOf(person)
    return !rel || !/^(not-close|not someone|stranger)/i.test(rel.value)
  })
  if (!askable.length) return null

  /**
   * THE ONE PERSON HE HAS SAID HE WOULD ASK, IF THERE IS ONE.
   *
   * This is the whole hinge of the journey. Before he has said anything, the card
   * names who is going and asks; after he has said it, the card can offer to write
   * something. NOTHING promotes anyone into this list on its own — not the
   * relationship, not the fact that they organised the event, not how often they
   * appear together in his calendar. `liftStanceOf` reads a preference set only by
   * the `lift` correction verb, and there is no other writer.
   */
  const willAsk = askable.find((person) => liftStanceOf(p, person.id)?.value === 'ask')

  const named = askable.slice(0, 2)
  const names = named.map((x) => x.name).join(' and ')
  const plural = named.length > 1
  const withRelationship = named.filter((x) => relationshipOf(x))
  for (const person of named) {
    if (!relationshipOf(person) && !liftStanceOf(p, person.id)) {
      demandRelationship(
        p,
        person,
        `working out who to ask about getting to ${plan.event.summary}`,
        plan.event.start
      )
    }
  }

  const distance = plan.distanceM ? `${(plan.distanceM / 1000).toFixed(0)} km` : 'a long way'
  const when = whenOf({ at: plan.event.start } as Attention, now, tz)
  const cannot =
    plan.blocked === 'no-timetable'
      ? 'I cannot time the bus, so I have no leave-by time for you'
      : `it is too far to ${plan.mode.value === 'walk' ? 'walk' : plan.mode.value}`

  /**
   * THE DRAFT, AND ONLY ONCE HE HAS SAID WHO TO ASK.
   *
   * The journey the brief describes ends here — calendar, destination problem,
   * who is going, what they are to him, a suggested action, a draft, his
   * correction, a learned preference — and this is the step where an assistant
   * most easily stops being trustworthy. So: no draft exists until he has stated
   * a stance, the text is assembled from typed fields rather than written by a
   * model, and nothing sends. See `draft.ts` for all three arguments in full.
   */
  const draft = willAsk
    ? liftDraft(
        willAsk,
        {
          event: { summary: plan.event.summary, start: plan.event.start, location: plan.event.location },
          destination: plan.destination.label ?? plan.event.location,
          problem: `${plan.destination.label ?? plan.event.location} is ${distance} away and ${cannot}`,
          timeZone: tz,
        },
        now
      )
    : null

  const first = (person: { name: string }) => person.name.split(/\s+/)[0] || person.name

  return {
    id: `lift:${plan.eventId}`,
    kind: 'suggestion',
    title: draft
      ? `Ask ${first(willAsk!)} whether they are driving`
      : `${names} ${plural ? 'are' : 'is'} going to ${plan.event.summary} too`,
    detail: draft
      ? `${plan.destination.label ?? plan.event.location} is ${distance} away and ${cannot}. ` +
        `You told me ${willAsk!.name} is someone you would ask for a lift — I can put a note in your drafts asking whether they are driving ${when}.`
      : `${plan.destination.label ?? plan.event.location} is ${distance} away and ${cannot}. ` +
        `${names} ${plural ? 'are' : 'is'} on the invitation, but I do not know whether ${plural ? 'either of them is' : 'they are'} someone you would ask for a ride. Tell me once and I will remember.`,
    because: {
      sentence: draft
        ? `You have no way of getting to this yet, and you have told me ${willAsk!.name} is someone you would ask. I still do not know whether they are driving.`
        : `You have no way of getting to this yet, and the invitation names someone you know. ` +
          `I am not assuming ${named[0]!.name} drives — I do not know that.`,
      grounds: [
        ...plan.because.grounds,
        ...named.map((person) => {
          const stance = liftStanceOf(p, person.id)
          const rel = relationshipOf(person)
          /**
           * THE STANCE OUTRANKS THE RELATIONSHIP IN THE GROUNDS, because it is
           * the thing this card actually stands on. "Paolo is a friend" is not
           * why the app is offering to write to Paolo; "you said you would ask
           * Paolo" is.
           */
          if (stance) {
            return {
              kind: 'preference' as const,
              id: `transport.lift.${person.id}`,
              says: `you told me ${person.name} is someone you would ${stance.value === 'ask' ? 'ask for a lift' : 'not ask'}`,
            }
          }
          return {
            kind: rel ? ('fact' as const) : ('observation' as const),
            id: person.id,
            says: rel
              ? `${person.name} — ${rel.value} (you told me). That does not tell me whether you would ask them for a lift.`
              : `${person.name} is named on the event; you have not told me who they are to you`,
          }
        }),
      ],
    },
    basis: plan.because.grounds.filter((g) => g.kind === 'observation').map((g) => g.id),
    /**
     * THE CORRECTIONS ARE THE JOURNEY'S OWN NEXT STEP.
     *
     * Before he has said anything they are the two questions that unblock this —
     * would you ask this person, and who are they to you — and answering either
     * changes every future card about that person, which is the test of whether a
     * correction is real. Afterwards they are the way out: "not them after all".
     *
     * The lift question comes FIRST and is a verb of its own, because it is the
     * one the card is actually blocked on. Offering only "a friend / family /
     * a colleague" would be asking him to answer a different question and letting
     * the app infer the answer to this one — see `people.ts`.
     */
    corrections: draft
      ? [
          { verb: 'lift', label: `Not ${first(willAsk!)} after all`, personId: willAsk!.id, value: 'never' },
          { verb: 'not-relevant', label: 'Do not plan my travel', about: 'travel' },
        ]
      : [
          ...named.flatMap((person): Correction[] =>
            liftOptions(first(person)).map((o) => ({
              verb: 'lift',
              label: o.label,
              personId: person.id,
              value: o.value,
            }))
          ).slice(0, 3),
          ...(withRelationship.length < named.length
            ? relationshipOptions()
                .slice(0, 2)
                .map(
                  (o): Correction => ({
                    verb: 'relationship',
                    label: `${first(named[0]!)}: ${o.label}`,
                    personId: named[0]!.id,
                    value: o.value,
                  })
                )
            : []),
          { verb: 'not-relevant', label: 'Do not plan my travel', about: 'travel' },
        ],
    /**
     * THE DRAFT ITSELF, AS A COMPOSER HE IS LOOKING AT.
     *
     * A `compose` widget rather than a button that fires: the text is on screen,
     * editable, before anything happens to it — and what happens then is
     * `mail.draft`, which writes to HIS drafts folder and is undoable exactly.
     * Nothing in this app can send this.
     */
    panes: draft
      ? [
          {
            title: `To ${draft.toName}`,
            widget: {
              kind: 'compose',
              to: draft.to,
              value: draft.body,
              multiline: true,
              placeholder: 'Say it however you would say it.',
              submit: {
                kind: 'mail.draft',
                label: 'Put it in my drafts',
                busy: 'Saving…',
                params: { to: draft.to, subject: draft.subject },
              },
            },
          },
        ]
      : undefined,
    suggest: draft
      ? { label: 'Put it in my drafts', detail: draft.disclosure }
      : {
          label: `Ask how ${plural ? 'they' : 'they'} are getting there`,
          detail: `I have not messaged anyone — this is yours to send.`,
        },
    at: plan.event.start,
    life: life.until(plan.event.start, plan.event.summary),
    opens: { surface: 'Calendar', focus: plan.eventId },
    uncertainty: draft
      ? draft.uncertainty
      : [
          `I do not know how ${names} ${plural ? 'are' : 'is'} travelling, or whether asking would be welcome.`,
          ...(withRelationship.length < named.length
            ? [`I do not know who ${named.find((x) => !relationshipOf(x))!.name} is to you.`]
            : []),
        ],
    scores: {
      relevance: 0.85,
      /**
       * Deliberately capped, and capped LOWER before he has said anything.
       *
       * The facts are solid either way — the event, the distance, who is invited —
       * but the suggestion rests on a social judgement the app is not equipped to
       * make, and the confidence axis should say so rather than inheriting the
       * certainty of the arithmetic underneath it. Once he has stated the stance
       * himself, the judgement is his and the card can stand behind it.
       */
      confidence: draft ? 0.9 : withRelationship.length === named.length ? 0.7 : 0.55,
      urgency: urgencyOf(plan.event.start, now),
      actionability: 0.9,
      novelty: noveltyOf(`lift:${plan.eventId}`, seen, now),
      fit: fitOf(p, 'suggestion', 'travel'),
    },
    score: 0,
  }
}

// ── Conflict ─────────────────────────────────────────────────────────────────

function conflictItem(
  c: Conflict,
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date
): Attention {
  const [high, low] = c.readings
  return {
    id: c.id,
    kind: 'conflict',
    title: `Your ${c.metric} sources disagree`,
    detail:
      `${high!.source} reports ${high!.value.toLocaleString()} and ${low!.source} reports ` +
      `${low!.value.toLocaleString()} for ${c.scope} — ${c.differencePercent}% apart. ` +
      `I will not show a figure for ${c.metric} until you tell me which to trust.`,
    because: {
      sentence: `Two connected sources reported different numbers for the same day, and nothing here can tell which is right.`,
      grounds: c.readings.map((r) => ({
        kind: 'observation' as const,
        id: `${r.source}:${c.metric}:${c.scope}`,
        says: `${r.source} reported ${r.value.toLocaleString()} at ${r.at}`,
      })),
    },
    basis: [],
    corrections: c.readings.map(
      (r): Correction => ({
        verb: 'prefer-source',
        label: `Use ${r.source}`,
        metric: c.metric,
        source: r.source,
      })
    ),
    uncertainty: [`Until this is settled, ${c.metric} is shown as two readings rather than one.`],
    /**
     * A DISAGREEMENT DOES NOT RESOLVE ITSELF BY BEING IGNORED.
     *
     * The old lane timer withdrew this after twelve hours, at which point the
     * conflict was still open, still poisoning every figure downstream, and no
     * longer mentioned anywhere. It ends when he rules on it and at no other time.
     */
    life: life.answered(`the ${c.metric} disagreement`),
    scores: {
      relevance: 0.8,
      /** We are certain about the DISAGREEMENT, whatever the truth is. */
      confidence: 1,
      /** It does not expire, but it silently corrupts everything downstream. */
      urgency: 0.5,
      actionability: 1,
      novelty: noveltyOf(c.id, seen, now),
      fit: fitOf(p, 'conflict'),
    },
    score: 0,
  }
}

/**
 * Every number any source has offered for a metric, normalised.
 *
 * TODAY THIS FINDS ONE SOURCE FOR STEPS, and that is the honest answer rather
 * than a limitation to paper over: Google Fit is the only activity connector
 * that exists in this codebase. A second source can only come from him — an
 * export, or a number he types — and both of those arrive here as readings
 * with `source: 'user'`, so the conflict machinery works the day one appears
 * without another line here.
 */
export function readingsFrom(w: World, p: Person_, now: Date): Reading[] {
  const out: Reading[] = []
  const tz = w.timeZone

  for (const o of w.observations) {
    if (o.data?.kind !== 'steps') continue
    const source = o.source === 'health' ? 'google-fit' : o.source
    for (const d of o.data.days) {
      out.push({ metric: 'steps', scope: d.date, source, value: d.steps, at: o.at, unit: 'steps' })
    }
  }

  /**
   * Anything he has told us directly, as a reading rather than as a correction.
   *
   * This is what makes "my phone says 10,347 today" produce a CONFLICT rather
   * than an argument the app cannot represent. It is stored under `steps.user.<day>`
   * by the correction endpoint.
   */
  for (const [key, f] of Object.entries(p.identity)) {
    const m = /^reading\.([a-z]+)\.(\d{4}-\d{2}-\d{2})$/.exec(key)
    if (!m || typeof f.value !== 'number') continue
    out.push({
      metric: m[1]!,
      scope: m[2]!,
      source: typeof f.note === 'string' && f.note ? f.note : 'you',
      value: f.value,
      at: f.sourceAt,
    })
  }

  // Only days he could plausibly care about. A conflict on a Tuesday in June
  // is true and worthless.
  const today = dayIn(now, tz)
  const cutoff = dayIn(new Date(now.getTime() - 8 * 86_400_000), tz)
  return out.filter((r) => r.scope >= cutoff && r.scope <= today)
}

// ── Clarification ────────────────────────────────────────────────────────────

/**
 * Turn unmet demands into questions.
 *
 * THE DEMAND IS THE TRIGGER, not the emptiness. There are dozens of things this
 * app does not know about him and asking about all of them is an onboarding
 * questionnaire, which is the thing the brief explicitly rules out. A question
 * appears here only because a concrete computation reached for the answer this
 * pass and stopped — and the question says what it stopped.
 *
 * At most one reaches Home per pass. Two questions on one screen is a form.
 */
function clarificationItems(
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date,
  /** The state that provoked the question, where the question has one. */
  activity?: ActivityReport
): Attention[] {
  /**
   * HOW MANY QUESTIONS HE WANTS IS HIS DECISION TOO.
   *
   * One at a time was the rule and it is the right default — two questions on one
   * screen is a form. But it was a constant, and `assistant.clarification` existed
   * as a field nothing read. Someone who has said "ask me" can take two; someone
   * who has said "just make a guess" gets none, and the demands stay recorded so
   * the prompt still knows what it is guessing at.
   */
  const style = clarificationStyleOf(p)
  const cap = style === 'assume' ? 0 : style === 'ask' ? 2 : 1

  const wanted = Object.entries(p.demands)
    .filter(([key]) => {
      const held = getFact(p, key)
      if (held && held.status !== 'unknown') return false
      // Asked recently and not answered: he has seen it. Do not stack it up.
      const asked = p.asked[key]
      if (asked && now.getTime() - Date.parse(asked.at) < 20 * 3_600_000) return false
      return true
    })
    /**
     * A DEADLINE OUT-RANKS A TALLY.
     *
     * `count` alone starved every acute question: it accumulates across builds, so
     * "what are you tracking activity for?" — re-demanded on every single pass —
     * reaches a number that a question about tomorrow's journey can never catch, and
     * with one question reaching Home per pass the journey question was never asked.
     * A demand with a live deadline sorts first, earliest deadline leading; a passed
     * deadline drops back to competing on count.
     */
    .sort((a, b) => {
      const live = (d: { before?: string }) => (d.before && Date.parse(d.before) > now.getTime() ? d.before : null)
      const [x, y] = [live(a[1]), live(b[1])]
      if (x && y) return x.localeCompare(y)
      if (x) return -1
      if (y) return 1
      return b[1].count - a[1].count
    })

  return wanted.slice(0, cap).map(([key, d]) => {
    const slot = SLOTS[key]
    const question = questionFor(key, p) ?? slot?.question ?? `I need to know your ${key}.`
    const options = optionsFor(key, p, slot?.options)
    return {
      id: `ask:${key}`,
      kind: 'clarification' as const,
      title: question,
      /**
       * WHAT I KNOW, WHAT I DO NOT, AND WHY THE ANSWER MATTERS.
       *
       * This was "Answering this gets you activity shown against your goal" —
       * true, and it is the app describing a feature. §5's complaint is that the
       * question was directionally right and generic, and the fix is not better
       * wording, it is putting the state that PROVOKED the question into it. A
       * question that can quote his own numbers back to him is self-evidently
       * about him.
       */
      detail: knownStateFor(key, activity) ?? (slot ? `Answering this gets you ${slot.unlocks}.` : `I needed this for ${d.why}.`),
      because: {
        sentence: `I am asking because ${d.why} needed this and I do not have it.`,
        grounds: [
          { kind: 'computation', id: key, says: `${d.count} thing(s) this session wanted ${key}` },
        ],
      },
      basis: [],
      corrections: correctionsFor(key, p, options),
      /**
       * A question ends when it is answered. Nothing else retires it — and in
       * particular not a timer, which would silently stop asking for something a
       * computation is still stalling on every single pass.
       */
      life: life.answered(`the question about ${key}`),
      scores: {
        relevance: 0.75,
        confidence: 1,
        /** A question is as urgent as the thing it is blocking. */
        urgency: Math.min(1, 0.3 + 0.2 * d.count),
        actionability: 1,
        novelty: noveltyOf(`ask:${key}`, seen, now),
        fit: fitOf(p, 'clarification'),
      },
      score: 0,
    }
  })
}

/**
 * THE STATE BEHIND ONE QUESTION, in his own numbers.
 *
 * Only for slots where a live computation is genuinely stalled on the answer,
 * and only from figures that already exist — nothing here computes anything, it
 * reads the one report the whole app reads. A slot with no such state falls back
 * to what answering unlocks, which is honest and duller.
 */
function knownStateFor(key: string, activity?: ActivityReport): string | null {
  if (!activity) return null

  if (key === 'fitness.objective') {
    const t = activity.trend
    if (t.average === null) {
      return `I have no ${activity.metric} to read yet, so I cannot tell you whether anything is going the way you want.`
    }
    /**
     * THE FACT FIRST, IN ONE SHORT SENTENCE, AND THEN THE CAREFUL PART.
     *
     * This used to be a single 190-character sentence, and it is the exact copy
     * in the regression screenshot: it filled the question card, pushed the
     * answers under the fold, and the card grew a scrollbar to cope. The content
     * was not wrong — the app genuinely does not know whether 2,761 is good, and
     * saying so is the whole point of asking. What was wrong is that all of it
     * was aimed at 224 pixels.
     *
     * Split at the sentence boundary the prose already had. The first clause is
     * the card's `primaryFact` and fits the 60-character budget; the rest is
     * still attached, and `budgetForHome` moves it to `status`, which is what
     * "Why am I being asked?" opens. Nothing is lost and nothing scrolls.
     */
    const over =
      t.covered < t.windowDays
        ? `${t.covered} of ${t.windowDays} days`
        : `the last ${t.windowDays} days`
    return (
      `About ${t.average.toLocaleString()} ${activity.metric}/day over ${over}. ` +
      `I do not know whether that is you walking more, getting fitter, or simply keeping an eye on your normal level — ` +
      `and until I do I will not call the number good or bad.`
    )
  }

  if (key === 'source.steps' && activity.conflicts.length) {
    const c = activity.conflicts[0]!
    return (
      `${c.readings.map((r) => `${r.source} says ${r.value.toLocaleString()}`).join(' and ')} for ${c.scope} — ` +
      `${c.differencePercent}% apart. Until you tell me which to believe I will not put a single figure on screen.`
    )
  }

  return null
}

/**
 * The answers to offer.
 *
 * For most slots these are written down in `SLOTS`. For a source-preference
 * question they are not, and must not be: the choices are whichever sources
 * ACTUALLY disagreed, which is knowable only at this moment. A hardcoded list
 * of fitness vendors would offer him "Apple Health" on a device that has never
 * reported one.
 */
function optionsFor(
  key: string,
  p: Person_,
  declared?: { value: string; label: string }[]
): { value: string; label: string }[] {
  const m = /^source\.(.+)$/.exec(key)
  if (m) {
    const c = p.conflicts.find((x) => x.metric === m[1] && x.state === 'open')
    return (c?.readings ?? []).map((r) => ({ value: r.source, label: r.source }))
  }
  // A relationship question is about a named human, and the answers are the open
  // starting points from `people.ts` — never a closed taxonomy of kinship.
  if (/^person\..+\.relationship$/.test(key)) return relationshipOptions()
  return declared ?? []
}

/**
 * A question about a PERSON, phrased with their name in it.
 *
 * "Who is Anna to you?" rather than "I need to know your
 * person.person:anna-rossi.relationship". The slot table cannot hold this because
 * the slot does not exist until someone appears in his data — which is exactly
 * why relationships are demanded per-person rather than declared up front.
 */
function questionFor(key: string, p: Person_): string | null {
  const m = /^person\.(.+)\.relationship$/.exec(key)
  if (!m) return null
  const person = p.people.find((x) => x.id === m[1])
  return person ? `Who is ${person.name} to you?` : null
}

/**
 * The chips for a question, as corrections that actually implement it.
 *
 * A relationship answer is the `relationship` verb, not `set-preference`: it
 * writes onto the person's own record, where every future card about them reads
 * it. Routing it through `set-preference` would store a fact under a key nothing
 * reads, which is the "button that does nothing" failure `correct.ts` was written
 * to make impossible.
 */
function correctionsFor(
  key: string,
  p: Person_,
  options: { value: string; label: string }[]
): Correction[] {
  const m = /^person\.(.+)\.relationship$/.exec(key)
  if (m) {
    const personId = m[1]!
    return options
      .slice(0, 4)
      .map((o): Correction => ({ verb: 'relationship', label: o.label, personId, value: o.value }))
  }
  return options.map((o): Correction => ({ verb: 'set-preference', label: o.label, key, value: o.value }))
}

// ── Activity ─────────────────────────────────────────────────────────────────

/**
 * ONE REPORT, READ BY HOME AND BY THE SURFACE.
 *
 * This replaced three separate walks of the step data — a goal-slipping check
 * here, a source-coverage check in `integrationItems`, and a gap check beside it —
 * each with its own idea of what the average was and which source it came from.
 * They agreed today and had no structural reason to keep agreeing, which is the
 * same setup that once had Home announcing an event the Calendar did not have.
 *
 * `activityReport` is now the single computation. What is left here is the
 * decision of which of its findings deserve to interrupt him, which is a
 * different question and belongs in the attention layer.
 */
function activityItems(
  r: ActivityReport,
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date
): Attention[] {
  const out: Attention[] = []

  /**
   * HE NAMED A SOURCE THE APP CANNOT READ.
   *
   * Kept as its own card rather than folded into the goal card because it is a
   * consequence of a decision HE made, and the worst possible outcome is the one
   * that used to happen: he chooses Apple Health, the app accepts it, and activity
   * reporting silently disappears with no connection drawn between the two.
   */
  if (!r.source.canSupportGoal && r.source.by === 'chosen' && r.source.why) {
    out.push({
      id: 'integration:steps-source',
      kind: 'integration',
      title: `I cannot read ${r.source.id} directly`,
      detail: r.source.why,
      because: { sentence: r.source.why, grounds: r.grounds },
      basis: [],
      corrections: [
        ...r.source.available
          .filter((s) => s !== r.source.id)
          .slice(0, 2)
          .map((s): Correction => ({ verb: 'prefer-source', label: `Use ${s} instead`, metric: r.metric, source: s })),
        { verb: 'not-relevant', label: 'Not tracking activity', about: 'fitness' },
      ],
      uncertainty: [`Activity figures stay unreported while the source you chose has no series.`],
      // His decision stands until he changes it; there is no clock on this.
      life: life.answered(`the ${r.metric} source`),
      scores: {
        relevance: 0.7,
        confidence: 1,
        urgency: 0.2,
        actionability: 0.8,
        novelty: noveltyOf('integration:steps-source', seen, now),
        fit: fitOf(p, 'integration', 'fitness'),
      },
      score: 0,
    })
  }

  /**
   * THE DATA STOPPED, WHICH IS NOT THE SAME AS HIM STOPPING.
   *
   * "You walked less this week" and "I stopped receiving your steps four days ago"
   * look identical on a chart and mean opposite things. Reported as an integration
   * problem for that reason, and `recompute` because the next sync either fixes it
   * or does not — there is no elapsed time at which a gap becomes acceptable.
   */
  if (r.gap.staleDays >= 2 && r.gap.lastDay) {
    out.push({
      id: 'integration:steps-gap',
      kind: 'integration',
      title: `No activity data for ${r.gap.staleDays} days`,
      /**
       * `lastDayLabel`, and NOT the ISO date beside it.
       *
       * This line was `${relativeDay(r.gap.lastDay, now, undefined)} (${r.gap.lastDay})`,
       * which is wrong twice. The parenthetical put "(2026-08-07)" on his home
       * screen — a machine date, in an app whose previous pass was entirely about
       * no date being written by anything but `clock.ts`. And `undefined` as the
       * zone meant the runtime's, which on the edge is UTC: the one substitution
       * `clock.ts` exists to make impossible. The label is computed once, in
       * `activityReport`, with his zone, and every reader uses that.
       */
      detail: `The last day I have any ${r.metric} for is ${r.gap.lastDayLabel}. That is a gap in the feed, not ${r.gap.staleDays} days of sitting still.`,
      because: {
        sentence: `The newest reading is ${r.gap.staleDays} days old, so any average over "this week" is counting days that were never reported.`,
        grounds: r.grounds,
      },
      basis: [],
      corrections: [{ verb: 'not-relevant', label: 'Not tracking activity', about: 'fitness' }],
      suggest: r.next.does.kind === 'enter-reading' ? { label: r.next.label, detail: r.next.detail } : undefined,
      life: life.recompute(`the gap in ${r.metric}`),
      scores: {
        relevance: 0.6,
        confidence: 1,
        urgency: 0.25,
        actionability: 0.6,
        novelty: noveltyOf('integration:steps-gap', seen, now),
        fit: fitOf(p, 'integration', 'fitness'),
      },
      score: 0,
    })
  }

  /**
   * A GOAL THAT IS NOT BEING MET.
   *
   * Reported only when the report itself managed to compute progress — which means
   * a source that can be trusted, a target he set, and enough covered days to
   * average. Every one of those conditions failing produces a different, more
   * honest card above rather than a progress bar over numbers nobody stands behind.
   */
  if (r.goal && !r.goal.met) {
    out.push({
      id: `goal:${r.goal.goalId}:${r.metric}`,
      kind: 'goal-slipping',
      title: `${r.goal.description}: ${r.goal.current.toLocaleString()} against ${r.goal.target.toLocaleString()}`,
      detail: r.says,
      because: {
        sentence: `You set this target yourself, and the days I have fall ${r.goal.direction === 'up' ? 'below' : 'above'} it.`,
        grounds: r.grounds,
      },
      basis: [],
      corrections: [
        { verb: 'wrong', label: 'That is not my target', target: { kind: 'goal', id: r.goal.goalId } },
        { verb: 'not-relevant', label: 'Stop tracking this', about: 'fitness' },
      ],
      suggest: r.next.does.kind === 'nothing' ? { label: r.next.label, detail: r.next.detail } : undefined,
      uncertainty:
        r.trend.covered < r.trend.windowDays
          ? [`Based on ${r.trend.covered} recorded day(s), not a full ${r.trend.windowDays}.`]
          : [],
      opens: { surface: 'Activity' },
      /**
       * Recomputed every build from live readings, so it withdraws itself the day
       * he meets the target — rather than lingering for twelve hours announcing a
       * shortfall he has already closed.
       */
      life: life.recompute(`the shortfall on ${r.goal.description}`),
      scores: {
        relevance: 0.7,
        confidence: r.source.by === 'chosen' ? 0.9 : 0.75,
        urgency: 0.2,
        /** There is something to do, but nothing that must happen today. */
        actionability: 0.5,
        novelty: noveltyOf(`goal:${r.goal.goalId}:${r.metric}`, seen, now),
        fit: fitOf(p, 'goal-slipping', 'fitness'),
      },
      score: 0,
    })
  }

  /**
   * NUMBERS WITH NO MEANING ATTACHED.
   *
   * A continuous series and no goal is the state his account was actually in, and
   * the old surface handled it by printing "4,385/day" — a figure the app itself
   * could not say was good or bad. Asking is the honest move, and it goes through
   * the ordinary demand mechanism so it queues behind anything more useful rather
   * than pushing itself onto Home.
   */
  if (r.source.canSupportGoal && !r.goal && r.trend.average !== null) {
    demand(p, 'fitness.objective', `telling you whether ${r.trend.average.toLocaleString()} ${r.metric} a day is going the way you want`)
  }

  return out
}

/**
 * `stepDays` and `coverageNote` USED TO LIVE HERE and are deleted rather than
 * left unused.
 *
 * `stepDays` was the third independent merge of the step observations, alongside
 * one in `panes.ts` and one that is now in `activity.ts`. Each had its own idea of
 * which source counted and its own handling of overlapping sync windows. They
 * agreed on his data today; nothing made them keep agreeing, and a Home card
 * disagreeing with the Activity surface about the same week is the exact failure
 * the one-canonical-read rule exists to prevent. `seriesBySource` in `activity.ts`
 * is the single reading now, and it reports PER SOURCE rather than merging them —
 * which is what makes a disagreement expressible instead of silently collapsed.
 */

// ── Integrations ─────────────────────────────────────────────────────────────

/**
 * A connector that is off or broken AND is costing him something specific.
 *
 * The qualifier is the whole design. "Location is off" on its own is a settings
 * screen's business. "Location is off, which is why I cannot tell you when to
 * leave for tomorrow's dinner" is worth a card, and the difference is whether
 * anything actually reached for it — which `demands` records.
 */
function integrationItems(
  w: World,
  p: Person_,
  seen: Record<string, { at: string; score: number }>,
  now: Date
): Attention[] {
  const out: Attention[] = []

  /**
   * Only when we genuinely have NOWHERE to start from.
   *
   * The first version fired whenever there was no live fix, which meant it kept
   * saying "I do not know where you are" next to a plan that was successfully
   * timed from his village. Not knowing his exact position is not the same as
   * having no origin, and only the second is worth a card.
   */
  const wantedLocation = p.demands['identity.home']
  const haveLive = getFact(p, 'location.last')
  const haveHome = getFact(p, 'identity.home.coords')
  if (wantedLocation && !haveLive && !haveHome) {
    out.push({
      id: 'integration:location',
      kind: 'integration',
      title: 'I do not know where you are',
      detail:
        `Without a position I cannot work out travel times. ${wantedLocation.why} needed one. ` +
        `Turn location on, or just tell me where you are.`,
      because: {
        sentence: `Something this session tried to compute a journey and had no starting point.`,
        grounds: [
          { kind: 'computation', id: 'identity.home', says: `wanted for ${wantedLocation.why}` },
        ],
      },
      basis: [],
      corrections: [
        { verb: 'not-relevant', label: 'Do not ask again', about: 'location' },
      ],
      /**
       * Ends when a position arrives or he tells us where home is — not on a
       * timer, since a journey the app cannot time stays untimeable however long
       * the card has been on screen.
       */
      life: life.answered('where you are starting from'),
      scores: {
        relevance: 0.7,
        confidence: 1,
        urgency: 0.35,
        actionability: 0.85,
        novelty: noveltyOf('integration:location', seen, now),
        fit: fitOf(p, 'integration', 'location'),
      },
      score: 0,
    })
  }

  /**
   * THE TWO ACTIVITY CARDS THAT USED TO LIVE HERE HAVE MOVED to `activityItems`,
   * where they are derived from the one `activityReport` the surface also reads.
   *
   * They were each walking the step observations themselves, with their own idea
   * of which source was authoritative and their own coverage threshold. Nothing
   * made them agree with the Activity surface or with the goal check, and three
   * independent readings of one series is precisely the arrangement that produced
   * a Home row contradicting its own application.
   */

  return out
}

// ── small helpers ────────────────────────────────────────────────────────────

/**
 * A time of day, in HIS zone and HIS clock convention.
 *
 * `timeZone` is passed in rather than read from the runtime, and that is not
 * defensive style — it is the specific bug this codebase has already been bitten
 * by. The Worker runs in UTC and he lives two hours ahead of it, so
 * `new Date(iso).getHours()` on the edge renders "leave at 16:30" as "leave at
 * 14:30" for exactly the person who is trying to catch a bus. Every
 * day-boundary and clock question in this app goes through the stored zone;
 * this is no exception.
 */
function clockOf(iso: string, p: Person_, tz?: string): string {
  const twelve = getFact<string>(p, 'format.clock')?.value === '12h'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: twelve,
    })
      .format(d)
      .toLowerCase()
      .replace(/\s/g, '')
  } catch {
    // An unusable stored zone must not take the card down with it.
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: twelve }).format(d)
  }
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/**
 * The town out of a Nominatim address tail.
 *
 * Takes the last fragment that is not a postcode, since that is reliably the
 * comune or city. Returns empty rather than guessing when the tail is unusable
 * — a chip labelled with a postcode is worse than one labelled with nothing.
 */
function localityOf(sub?: string): string {
  if (!sub) return ''
  const parts = sub
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !/^\d{4,6}$/.test(s))
  return parts[parts.length - 1] ?? ''
}

// ── Rendering an attention item as a home card ───────────────────────────────

/**
 * An `Attention` as a `Need`, so it can ride the feed the client already draws.
 *
 * Deliberately NOT a new card type with a new renderer. Home has one card, four
 * lanes and a tested geometry gate; a second card shape would have to earn its
 * own place in all of that, and the thing being added here is not a new kind of
 * VISUAL, it is a new kind of PROVENANCE. What differs is `because`,
 * `corrections` and `standing`, and those ride along on the existing shape.
 *
 * Heat is chosen from the item's own axes rather than by a model. `hot` is
 * reserved for something that needs him inside the hour — the design says so,
 * and inflating it is how every card ends up red.
 */
export function needFrom(a: Attention, now = new Date()): Need {
  const soon = a.at ? Date.parse(a.at) - now.getTime() : Infinity
  const withinHour = Number.isFinite(soon) && soon > 0 && soon < 3_600_000
  const heat: Need['heat'] =
    a.kind === 'conflict' || a.kind === 'clarification'
      ? 'warm'
      : withinHour
        ? 'hot'
        : a.scores.urgency > 0.6
          ? 'warm'
          : 'quiet'

  /**
   * THE CARD'S COPY, INSIDE THE BUDGET IT HAS TO LIVE IN.
   *
   * Applied here rather than in each builder, because "does this fit on Home" is
   * a property of the destination and not of the finding. A builder's job is to
   * be right; keeping it to 224 pixels is this layer's. See `homeCopy.ts` — and
   * note that nothing is discarded: what does not fit moves into `status`, which
   * is what "Why am I being asked?" and the focused detail already show.
   */
  const copy = budgetForHome({
    title: a.title,
    sub: a.detail,
    status: a.because.sentence,
    corrections: a.corrections,
    /*
      AND THE SUB IS WRITTEN KNOWING WHAT THE EYEBROW WILL SAY.

      The relevance card draws `heatLabel` above the title, and for a timed item
      that label is the WHEN — "tomorrow · 11:00". A sub that then opens
      "Tomorrow at 11:00 AM." has spent its first sentence on a fact printed two
      lines above it. Handing the budget the INSTANT rather than the label is
      what lets it decide that without comparing anybody's prose; see
      `EyebrowClaim`.
    */
    eyebrow: { at: a.at, now },
  })

  return {
    id: a.id,
    tier: 'quiet',
    heat,
    heatLabel: heatLabelFor(a, withinHour),
    title: copy.title,
    sub: copy.sub,
    status: copy.status,
    /**
     * The opening line of the report thread.
     *
     * It states the grounds rather than repeating the headline, because the
     * report is where "why am I seeing this?" is answered and a restatement
     * answers nothing.
     */
    opening: openingFor(a),
    stats: null,
    /**
     * The chips ARE the corrections.
     *
     * This is the whole correction interface on Home: the labels he can tap are
     * exactly the verbs `applyCorrection` implements, so there is no way to
     * offer him a button that does not change the model.
     */
    chips: copy.corrections.map((c) => c.label),
    /**
     * The suggested action, as the card's primary control.
     *
     * `done` says plainly that the app has not acted on his behalf. The lift card
     * suggests asking someone how they are getting there, and the one thing that
     * must never happen is the app messaging a third party — so the button
     * acknowledges rather than sends.
     */
    action: a.suggest ? { label: a.suggest.label, done: 'Noted ✓' } : null,
    gauges: null,
    meter: null,
    glyph: null,
    accent: null,
    proposes: null,
    basis: a.basis,
    asks: a.kind === 'clarification',
    focus: a.opens?.focus ?? null,
    /**
     * The item's own panes, when it has any — see `Attention.panes`. A card
     * with none opens onto whatever its surface renders, which is the ordinary
     * case; the lift draft is the exception that needed this.
     */
    panes: a.panes,
    because: a.because,
    corrections: copy.corrections,
    uncertainty: a.uncertainty,
    /**
     * WHAT THE LANE IS TOLD, AND WHAT IT IS NO LONGER ALLOWED TO DECIDE.
     *
     * `standing: true` used to mean "exempt from the lane's 12-hour timer", which
     * made the lane the owner of every lifetime it did not exempt. It now means
     * only "the server owns this item's lifecycle", and the lifecycle itself
     * travels alongside: `expiresAt` when there is a clock, absent when there is
     * not. The lane obeys it and holds no policy of its own. See `Lifecycle`.
     */
    standing: true,
    expiresAt: a.life.until,
    expiryReason: a.life.reason,
    /**
     * WHICH KIND OF SCREEN SPACE THIS WANTS, decided here and not by the client.
     *
     * Home draws three bands and the client must not compute which one a card
     * belongs in: `bandOf` reads the item's kind, its instant and whether there
     * is anything to do about it, and none of those survive the trip to the
     * browser intact. A client that re-derived it would be a second opinion
     * about the most important decision on the screen.
     */
    band: bandOf(a, now),
    /**
     * WHAT SUBJECT THIS IS ABOUT, so acting on it or swiping it away can teach
     * us something.
     *
     * Read off the card's own `not-relevant` correction rather than added as a
     * new field on every builder, because that correction already names the
     * subject and there must not be two answers to "what is this card about".
     * Absent means the card belongs to no subject, and the engagement loop
     * simply learns nothing from it — which is the right outcome for a one-off.
     */
    topic: a.corrections.find((c) => c.verb === 'not-relevant')?.about,
    score: a.score,
  }
}

function heatLabelFor(a: Attention, withinHour: boolean): string {
  if (a.kind === 'conflict') return 'sources disagree'
  if (a.kind === 'clarification') return 'needs you'
  if (a.kind === 'integration') return 'not connected'
  if (a.kind === 'goal-slipping') return 'your goal'
  if (withinHour) return 'needs you · now'
  return 'upcoming'
}

/**
 * The report's opening message: the grounds, spelled out.
 *
 * Each ground is prefixed with what KIND of thing it is, because the difference
 * between "Google reported this" and "I worked this out" is the difference
 * between something he cannot argue with and something he should.
 */
function openingFor(a: Attention): string {
  const label: Record<string, string> = {
    observation: 'Your data says',
    object: 'A record says',
    fact: 'You told me',
    goal: 'Your goal',
    preference: 'Your preference',
    computation: 'I worked out',
    inference: 'I guessed',
  }
  const lines = a.because.grounds.map((g) => `· ${label[g.kind] ?? 'From'}: ${g.says}`)
  const doubts = (a.uncertainty ?? []).map((u) => `· Not certain: ${u}`)
  return [a.because.sentence, '', ...lines, ...doubts].join('\n')
}
