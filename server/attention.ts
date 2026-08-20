/**
 * WHAT DESERVES HIS ATTENTION, AND WHY.
 *
 * Home has always been a list of cards a language model decided to write. That
 * is not the same thing as a list of things that matter, and the difference
 * shows: read off his live feed on 2026-08-11, the top item was "Design review
 * today — you have a design review scheduled for 08:00", which is his calendar,
 * restated, at the moment the calendar was already visible two cards below.
 * Meanwhile a dinner across a valley, tomorrow, for a man with no car, was
 * nowhere on the screen.
 *
 * A model asked "what should he see?" will always produce something. It has no
 * way to produce NOTHING, and no vocabulary for "I calculated this and it is
 * not worth his time". So the decision of what reaches Home moves here, into
 * code, and the model goes back to doing what it is good at — wording.
 *
 * Three things this file insists on.
 *
 *   - AN ITEM CARRIES ITS OWN GROUNDS. Not a sentence about why, a LIST of the
 *     records and stored facts it stands on, each tagged with what kind of
 *     thing it is. "Why am I seeing this?" is then answered by reading, not by
 *     asking a model to reconstruct its own reasoning after the fact — which
 *     is a thing models are happy to do and cannot do honestly.
 *
 *   - OBSERVATION, INTERPRETATION AND PREFERENCE ARE DIFFERENT GROUNDS. Tagged
 *     separately, because collapsing them is what turns "he watched this
 *     channel at 00:43" into "he likes this channel" into "show him more of
 *     this channel", with no point at which anyone can disagree with the step
 *     that was actually wrong.
 *
 *   - SOMETHING CALCULABLE IS NOT SOMETHING WORTH SAYING. Every item is scored
 *     on six axes and most of them do not clear the bar. What gets dropped is
 *     LOGGED rather than silently discarded, because a threshold nobody can
 *     see is indistinguishable from a bug.
 */

import { engagementBiasOf, proactivityOf, type Person_ } from './person.js'
import type { WidgetPane } from './widgets.js'
import { countdown, dayIn, relativeDay } from './clock.js'

// ── Why something is on screen ───────────────────────────────────────────────

/**
 * One piece of the reasoning, pointing at a real thing.
 *
 * `kind` is the load-bearing field. It is what lets the correction interface
 * offer the right verb: you cannot "correct" an observation (Google really did
 * report that event) but you can absolutely correct an inference drawn from it,
 * and you can change a preference. Offering "that's wrong" against a retrieved
 * fact teaches him the button does nothing.
 */
export interface Ground {
  kind:
    /** A record a connector produced. Not arguable — it says what it says. */
    | 'observation'
    /** A retrieved object, by id. Same. */
    | 'object'
    /** Something stored in the typed model. Correctable. */
    | 'fact'
    /** A goal of his. Correctable. */
    | 'goal'
    /** A preference of his. Correctable. */
    | 'preference'
    /** Arithmetic we did. Arguable only via its inputs. */
    | 'computation'
    /** A conclusion we drew. The most correctable thing here. */
    | 'inference'
  /** Id of the thing, where it has one. */
  id: string
  /** What this ground contributes, in one clause. */
  says: string
}

/** The complete answer to "why am I seeing this?" */
export interface Because {
  /** One sentence, for the card. */
  sentence: string
  /** The grounds, in the order they were used. */
  grounds: Ground[]
}

// ── Corrections ──────────────────────────────────────────────────────────────

/**
 * Something he can tell us that changes the model rather than the card.
 *
 * A DELIBERATELY SMALL, CLOSED SET. Every one of these has an implementation in
 * `applyCorrection`, and adding a verb means adding the behaviour — there is no
 * "other" that quietly does nothing. The alternative, which is what a per-card
 * "hide this" button amounts to, suppresses one symptom and leaves the model
 * believing exactly what it believed before, so the same wrong conclusion comes
 * back tomorrow wearing a different sentence.
 */
export type Correction =
  /** "That's wrong." Retires an inference or a fact and records that he said so. */
  | { verb: 'wrong'; label: string; target: { kind: Ground['kind']; id: string }; note?: string }
  /** "Use Apple Health instead." Settles a conflict and remembers the choice. */
  | { verb: 'prefer-source'; label: string; metric: string; source: string }
  /** "I usually walk." Sets a typed preference, by him, permanently. */
  | { verb: 'set-preference'; label: string; key: string; value: unknown }
  /** "Forget that." Removes an inference and stops it being re-derived. */
  | { verb: 'forget'; label: string; target: { kind: Ground['kind']; id: string } }
  /** "Don't show me this kind of thing." Records the dislike, not a filter. */
  | { verb: 'not-relevant'; label: string; about: string }
  /** "Jamie is my sister." Sets a relationship. Never inferred; see people.ts. */
  | { verb: 'relationship'; label: string; personId: string; value: string }
  /**
   * "I'd ask Paolo for a lift" / "Not Anna."
   *
   * DELIBERATELY NOT THE SAME VERB AS `relationship`, and the split is load-bearing
   * rather than tidy. Knowing that someone is a friend does not tell you whether
   * he would ask them for a ride — people do not lend cars along kinship lines —
   * and the output of getting it wrong is a draft message to a real person asking
   * a favour. So the ask is its own stated fact with its own verb, and nothing in
   * the app derives one from the other. See `people.ts`'s `LiftStance`.
   */
  | { verb: 'lift'; label: string; personId: string; value: 'ask' | 'never' }

// ── The item ─────────────────────────────────────────────────────────────────

export type AttentionKind =
  /** We need an answer before we can be useful. */
  | 'clarification'
  /** Two sources disagree and nothing should be stated until he rules. */
  | 'conflict'
  /** Something is going to happen and there is a decision inside it. */
  | 'obligation'
  /** We think he should do a specific thing. */
  | 'suggestion'
  /** A goal he set is not moving. */
  | 'goal-slipping'
  /** A threshold he asked to be told about has been crossed. */
  | 'warning'
  /** A connector is broken or a permission is off, and it is costing him. */
  | 'integration'
  /** Something he might like, offered as a recommendation and labelled so. */
  | 'recommendation'

/**
 * Six axes rather than one priority number.
 *
 * A single score cannot express the difference between "very likely true but
 * nothing to do about it" and "might be wrong but if right he needs to move in
 * an hour". Keeping them apart also means the threshold can be argued with:
 * when something wrong reaches the screen, the axis that overrated it is
 * visible in the record.
 *
 * All 0..1.
 */
export interface Scores {
  /** Does this bear on his life as we understand it right now? */
  relevance: number
  /** How sure are we the underlying claim is true? */
  confidence: number
  /** Does the value of saying it decay fast? */
  urgency: number
  /** Is there something he could actually DO? */
  actionability: number
  /** Is this new, or has he already been told? */
  novelty: number
  /** Does it fit what he has said he wants from us? */
  fit: number
}

/**
 * WHEN AN ITEM STOPS BEING ONE.
 *
 * Lifecycle belongs on the attention object and not in the lane that draws it,
 * and that was the actual bug rather than a tidiness argument. The insights lane
 * held a flat 12-hour timer: an insight nobody engaged with is not intelligence
 * any more, which is exactly right for model prose and exactly wrong for a dinner
 * on Wednesday. The first fix was a `standing: true` flag that exempted computed
 * cards from the timer entirely — which replaced one wrong lifetime with another,
 * because now nothing ever took them off the screen except being recomputed.
 *
 * Neither a timer nor an exemption is the answer. The answer is that each item
 * knows what would make it stop mattering, because the thing that computed it
 * knows:
 *
 *   · a leave-by time is over the moment it passes, to the minute;
 *   · a conflict ends when he rules on it, and not before, however long that is;
 *   · a question ends when it is answered, or when asking again would be nagging;
 *   · a model's observation about his week is stale in half a day.
 *
 * So an item declares `until`, and the lane simply obeys. `reason` is carried so
 * that a withdrawal is explicable — "this left because the time passed" is a
 * different thing from "this left because you answered it", and a build log that
 * cannot tell them apart cannot be debugged.
 */
export interface Lifecycle {
  /**
   * How this ends.
   *
   *   'passes'   — it is about an instant, and it is over when that instant is.
   *   'answered' — it ends when the model changes; nothing else retires it.
   *   'timer'    — it goes stale on the clock. For prose and recommendations.
   *   'recompute'— it is true only as long as the next build re-derives it.
   */
  ends: 'passes' | 'answered' | 'timer' | 'recompute'
  /**
   * The instant after which this must not be shown. Absent for 'answered' and
   * 'recompute', which have no clock.
   */
  until?: string
  /** Said back to him, and written into the build log, when it is withdrawn. */
  reason: string
}

export interface Attention {
  id: string
  kind: AttentionKind
  /** Short. Goes on the card. */
  title: string
  /** One or two sentences of substance. Never padding. */
  detail: string
  because: Because
  scores: Scores
  /** Weighted total. Computed, never stored by a caller. */
  score: number
  /** Observation/object ids. Same contract as a belief's basis. */
  basis: string[]
  corrections: Correction[]
  /**
   * Answers only the DEVICE can give. See `Need.answers` in `think.ts` — the
   * location question is the case this exists for, and it had no way through
   * itself until it did.
   */
  answers?: { kind: 'locate' | 'compose'; label: string }[]
  /** ISO instant this is about, when it is about one. Drives urgency decay. */
  at?: string
  /** How and when this stops being worth his attention. See `Lifecycle`. */
  life: Lifecycle
  /** Which surface, if any, this opens into. */
  opens?: { surface: string; focus?: string }
  /**
   * WHAT THE CARD OPENS ONTO, when the item carries its own thing to look at.
   *
   * Almost every attention item is a sentence and a set of corrections, and its
   * surface is somewhere else — the dinner opens Calendar. The exception is an
   * item whose whole substance IS an object the app made: a draft message, which
   * has to be on screen and editable BEFORE anything happens to it, because the
   * alternative is a button that writes something he never read.
   *
   * Typed as the widget vocabulary rather than as a free-form payload, so a card
   * cannot smuggle a renderer of its own onto Home.
   */
  panes?: WidgetPane[]
  /** What we do not know, stated rather than hidden. */
  uncertainty?: string[]
  /**
   * The one thing to do about it, when there is one.
   *
   * Separate from `corrections`, and the distinction is the point: a correction
   * tells the app it is wrong, an action does the thing. A card that offers only
   * corrections is a card that can be argued with and not acted on.
   */
  suggest?: { label: string; detail: string }
}

/**
 * The lifecycles, as constructors, so no caller hand-rolls one.
 *
 * Having these as functions rather than object literals at each site is what
 * keeps `reason` honest — the reason is written once, beside the rule it
 * describes, instead of being retyped (and drifting) at every call.
 */
export const life = {
  /** Over when the instant passes. For anything with a time attached. */
  until: (at: string, what: string): Lifecycle => ({
    ends: 'passes',
    until: at,
    reason: `${what} has passed`,
  }),
  /** Ends only when he settles it. For conflicts and questions. */
  answered: (what: string): Lifecycle => ({ ends: 'answered', reason: `${what} was settled` }),
  /** Goes stale on the clock. For prose, trends and recommendations. */
  stale: (hours: number, what: string, now = new Date()): Lifecycle => ({
    ends: 'timer',
    until: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    reason: `${what} is more than ${hours} hours old`,
  }),
  /** True only while it keeps being re-derived. For computed state. */
  recompute: (what: string): Lifecycle => ({ ends: 'recompute', reason: `${what} is no longer true` }),
}

/**
 * Has this item's life ended?
 *
 * 'answered' and 'recompute' are never expired by the clock, and that asymmetry
 * is deliberate rather than an omission: an unresolved conflict does not become
 * acceptable by being ignored for a week, and a recomputed item is withdrawn by
 * simply not being produced again. Only a clock-bound item can time out.
 *
 * A grace period applies to 'passes', because the useful lifetime of "leave at
 * half four" does not end at 16:30:00 — for the next few minutes it is still the
 * most relevant thing on his screen, now reading "you should have left".
 */
export const PASSED_GRACE_MIN = 15

export function ended(a: Attention, now = new Date()): { over: true; why: string } | null {
  const { ends, until, reason } = a.life
  if (ends === 'answered' || ends === 'recompute') return null
  if (!until) return null
  const t = Date.parse(until)
  if (!Number.isFinite(t)) return null
  const grace = ends === 'passes' ? PASSED_GRACE_MIN * 60_000 : 0
  return now.getTime() > t + grace ? { over: true, why: reason } : null
}

// ── The three kinds of screen space ──────────────────────────────────────────

/**
 * WHAT KIND OF ATTENTION THIS WANTS.
 *
 * Home used to be four lanes named after where things CAME FROM — apps, saved
 * panes, tasks, insights. That is a filing system, and a filing system asks the
 * reader to do the triage: six equal-weight rails, and the question "is anything
 * actually on fire?" answered by reading all of them. The intelligence was real
 * and it was invisible, because the layout had no way to express that one card
 * mattered more than another.
 *
 * These three say what the reader actually wants to know, in the order they want
 * to know it:
 *
 *   now         Something is blocked on him, or is close enough that waiting
 *               costs him. He should look at this before he puts the phone down.
 *   next        Context for what is coming. Nothing to do this minute; he will
 *               be glad he read it.
 *   background  True, quiet, and safe to ignore today. Trends, recommendations,
 *               things running by themselves.
 *
 * A BAND IS COMPUTED, NEVER ASSIGNED. Every input is a typed field the item
 * already carries — its kind, its instant, its lifecycle, whether there is
 * anything to do — so no builder can promote its own card by choosing a lane,
 * which is exactly how the old screen ended up with six equally loud things on
 * it. When a card is in the wrong band the fix is in this function, once, where
 * it can be argued with.
 */
export type Band = 'now' | 'next' | 'background'

/**
 * How close is close enough to interrupt.
 *
 * Twelve hours rather than the more obvious "today", because his day does not
 * end at midnight and a 07:30 departure is a thing he needs at 21:00 the night
 * before. Beyond that it is context, not pressure.
 */
export const NOW_HOURS = 12

/** How far ahead `next` reaches before something becomes background. */
export const NEXT_DAYS = 8

export function bandOf(a: Attention, now = new Date()): Band {
  const ms = a.at ? Date.parse(a.at) - now.getTime() : NaN
  const hours = Number.isFinite(ms) ? ms / 3_600_000 : null

  /**
   * A CONFLICT IS ALWAYS `now`, whatever its clock says.
   *
   * Two sources disagree, so every number computed downstream of them is
   * currently unsafe to state — Activity is already refusing to print a figure
   * because of it. That is a live cost, and there is exactly one thing that ends
   * it, which is him ruling. Filing it under "context for later" would be the
   * app quietly deciding to keep being wrong.
   */
  if (a.kind === 'conflict') return 'now'

  /**
   * A QUESTION IS `now` ONLY WHEN SOMETHING IS WAITING ON THE ANSWER.
   *
   * `at` on a clarification is the deadline the demand carried — the start of
   * the journey it is blocking. A question with no deadline is a chronic gap:
   * worth asking eventually, never worth interrupting for, and the thing that
   * used to fill Home with "where should I treat as home?" on a morning with a
   * dinner across a valley on it.
   */
  if (a.kind === 'clarification') return hours !== null && hours <= 24 * 2 ? 'now' : 'background'

  if (hours !== null) {
    // Already passed but inside its grace window — see PASSED_GRACE_MIN. Still
    // the most relevant thing on the screen, now reading "you should have left".
    if (hours <= 0) return 'now'
    if (hours <= NOW_HOURS) return a.suggest || a.kind === 'warning' || a.kind === 'obligation' ? 'now' : 'next'
    if (hours <= 24 * NEXT_DAYS) return 'next'
    return 'background'
  }

  /**
   * NO INSTANT AT ALL. A broken connector is costing him something continuously,
   * which is a weaker claim on his attention than a deadline but a real one; a
   * goal that is not moving, a trend and a recommendation are all things that
   * will be just as true tomorrow.
   */
  if (a.kind === 'integration') return 'next'
  return 'background'
}

/**
 * How the axes combine.
 *
 * ACTIONABILITY AND URGENCY ARE MULTIPLIED IN, not added. That is the whole
 * character of the ranking and it is deliberate: an interesting fact he can do
 * nothing about should not out-rank a dull fact he must act on today, and
 * addition lets a high-relevance, high-novelty, zero-action item win. The
 * brief's own example — "he walked 87 fewer steps on Tuesday" — is exactly that
 * item, and under addition it scores respectably.
 *
 * A conflict is exempt from the actionability floor, because the action IS
 * answering it, and an unanswered conflict silently poisons every number
 * downstream.
 */
export function scoreOf(s: Scores, kind: AttentionKind): number {
  const substance = 0.4 * s.relevance + 0.3 * s.confidence + 0.15 * s.novelty + 0.15 * s.fit
  const pressure = kind === 'conflict' || kind === 'clarification'
    ? Math.max(0.55, 0.5 + 0.5 * s.urgency)
    : (0.35 + 0.65 * s.actionability) * (0.5 + 0.5 * s.urgency)
  return Math.round(substance * pressure * 1000) / 1000
}

/**
 * The bar for reaching Home.
 *
 * Chosen so that the fixture's own items sort the way a person would sort them,
 * and stated as a constant rather than buried in a comparison so that moving it
 * is a visible decision. Anything below still exists and is still reachable —
 * it just does not get to interrupt.
 */
export const HOME_THRESHOLD = 0.32

/**
 * The bar for a screen HE ASKED FOR.
 *
 * Much lower, and the difference is not a tuning knob — the two thresholds answer
 * different questions. `HOME_THRESHOLD` is "may this interrupt him", which is a high
 * bar because the cost of a wrong yes is that he stops trusting the screen. When he
 * has typed "what should I focus on this week?", nothing is interrupting anybody and
 * the question becomes "is this relevant at all".
 *
 * Getting this wrong in the obvious direction is what the first version did: it
 * composed the week against the Home bar, and a genuinely useful item scoring 0.31 —
 * a goal he set, missed by 3,600 steps a day — was withheld from a screen whose
 * entire purpose was to list it. The answer came back "nothing needs you this week",
 * which was false and looked authoritative.
 */
export const ASKED_THRESHOLD = 0.08

export interface Ranked {
  /** Above the bar, best first. */
  surface: Attention[]
  /** Below the bar, with the reason. Never silently dropped. */
  held: { item: Attention; why: string }[]
}

/**
 * There is no free-standing `rank()` any more, and its absence is deliberate.
 *
 * It existed alongside `compose`, doing the scoring-and-cutting half, and the two
 * had to agree about the bar and about how a cut is reported. Once the cut became
 * per-band there was no honest way to keep both — a ranker that does not know the
 * bands cannot say which one filled up. Scoring now happens once, inside
 * `compose`, which is the only thing that decides what reaches a screen.
 */

// ── The four affordances every intelligent card owes him ─────────────────────

/**
 * "WHY THIS?", "THAT'S WRONG", "CHANGE SOURCE", "DON'T USE THIS".
 *
 * THE PRODUCT RULE THIS ENFORCES: every important inference must be inspectable
 * and correctable from the interface that displays it.
 *
 * Before this, corrections were bespoke. Each builder wrote its own chips, so
 * the activity card offered "use Apple Health instead" and the travel card
 * offered a relationship, and whether you could argue with a conclusion depended
 * on which flow had happened to think of it. That is the wrong shape for a
 * promise: an affordance that appears in some places is not an affordance, it is
 * a feature of one screen, and a reader cannot learn to expect it.
 *
 * So the composition layer adds what is missing, once, to everything that
 * reaches a screen. Two properties make that safe rather than noisy:
 *
 *   · IT ADDS, IT NEVER REPLACES. A builder that has written a better, more
 *     specific verb keeps it — "Use Google Fit instead" beats a generic "change
 *     source", and the check below is by verb, not by count.
 *   · IT ONLY OFFERS WHAT IT CAN IMPLEMENT. "That's wrong" needs something
 *     correctable to point AT, and pointing it at an observation would be a
 *     button that teaches him buttons do nothing — Google really did report that
 *     event, and no amount of tapping changes it. So the target is chosen from
 *     the grounds by how arguable they are, and if nothing is arguable the chip
 *     is not offered.
 *
 * "Why this?" is deliberately NOT in this list. It is not a correction — nothing
 * is written — it is inspection, and it is available on every computed card
 * because every computed card carries `because.grounds`. The client renders it
 * from that, always, rather than from a chip a builder might forget.
 */

/** How arguable each kind of ground is. Highest wins as the `wrong` target. */
const ARGUABLE: Partial<Record<Ground['kind'], number>> = {
  inference: 4,
  fact: 3,
  goal: 2,
  preference: 1,
}

export function standardCorrections(a: Attention): Correction[] {
  const has = (verb: Correction['verb']) => a.corrections.some((c) => c.verb === verb)
  const out: Correction[] = []

  /**
   * "THAT'S WRONG", pointed at the most arguable thing the card stands on.
   *
   * A conclusion first, then a stored fact, then a goal, then a preference —
   * which is the order in which being wrong is both likely and worth fixing.
   * Observations and retrieved objects are excluded outright: they are records
   * of what a connector said, and the honest response to a wrong one is to
   * correct what was INFERRED from it.
   */
  if (!has('wrong') && !has('forget')) {
    const target = [...a.because.grounds]
      .filter((g) => ARGUABLE[g.kind] !== undefined)
      .sort((x, y) => (ARGUABLE[y.kind] ?? 0) - (ARGUABLE[x.kind] ?? 0))[0]
    if (target) {
      out.push({ verb: 'wrong', label: 'That’s wrong', target: { kind: target.kind, id: target.id } })
    }
  }

  /**
   * "CHANGE SOURCE", only where there is a source to change.
   *
   * Recognised structurally — a ground whose id is `source.<metric>` — rather
   * than by reading the prose, for the same reason the lift card stopped
   * matching `/too far/i` against its own sentence. `applyCorrection` needs the
   * metric and a source name, and the alternatives are not knowable from here,
   * so this is a `set-preference` that CLEARS the choice: the next build finds
   * no authoritative source, reports the disagreement honestly, and offers the
   * real alternatives it can actually see.
   */
  if (!has('prefer-source')) {
    const source = a.because.grounds.find((g) => g.kind === 'preference' && g.id.startsWith('source.'))
    if (source) {
      out.push({ verb: 'set-preference', label: 'Change source', key: source.id, value: null })
    }
  }

  /**
   * "DON'T USE THIS", about the card's own subject.
   *
   * Stored as a dislike rather than as a filter — see `applyCorrection` — so it
   * is readable in settings, rendered into the prompt and reversible by him,
   * which an invisible suppression list is none of. Only offered when the card
   * has a subject; a one-off has nothing to switch off.
   */
  if (!has('not-relevant')) {
    const about = subjectOf(a)
    if (about) out.push({ verb: 'not-relevant', label: 'Don’t use this', about })
  }

  return out
}

/**
 * What subject a card belongs to, when it belongs to one.
 *
 * Derived from the kind rather than declared per builder, because a builder
 * asked to name its own subject will invent a new one — and then "don't use
 * this" switches off a category of exactly one card, which is a filter wearing a
 * preference's clothes.
 */
function subjectOf(a: Attention): string | undefined {
  switch (a.kind) {
    case 'goal-slipping': return 'goals'
    case 'recommendation': return 'recommendations'
    case 'integration': return 'connections'
    case 'suggestion': return 'suggestions'
    default: return undefined
  }
}

// ── Composition: the whole of what reaches Home ───────────────────────────────

/**
 * ONE ITEM PER GAP, NOT ONE PER WAY OF NOTICING IT.
 *
 * Moved here from `insight.ts`, where it was a local `covered` map applied after
 * the items had been built. It belongs in the composition layer because it is a
 * statement about the RELATIONSHIP between items — which is the only kind of
 * decision a per-item builder structurally cannot make.
 *
 * Read as "the key is superseded by the value whenever the value is present".
 * The question always wins over the complaint about the same gap: "Where should I
 * treat as home?" is answerable in one tap, and "I do not know where you are" is
 * the same fact with nothing to do about it.
 */
const SUPERSEDED: Record<string, string> = {
  'integration:location': 'ask:identity.home',
  'integration:steps-source': 'ask:source.steps',
}

/**
 * How many items Home may carry, at HIS chosen volume.
 *
 * The preference finally does something structural rather than only nudging a
 * score: someone who asked to be left alone gets a shorter screen, not the same
 * six cards in a slightly different order. This is the difference between a
 * setting that is respected and one that is merely consulted.
 */
export function homeLimitFor(p: Person_): number {
  const level = proactivityOf(p)
  return level === 'low' ? 3 : level === 'high' ? 8 : 6
}

/**
 * How his volume is spent across the three bands.
 *
 * NOT an even split, and the shape is the argument. `now` is uncapped in
 * practice because a thing that is blocked on him does not become less blocked
 * by being the fourth one — suppressing it would be the app deciding on his
 * behalf that he has had enough bad news. `next` and `background` are tight,
 * because their failure mode is the opposite: a long list of true, quiet things
 * is exactly what makes a screen unreadable.
 *
 * All three still come from `homeLimitFor`, so "leave me alone" produces a
 * shorter screen everywhere rather than only in one band — and `homeLimitFor`
 * has changed meaning slightly and deliberately: it is now the number of things
 * allowed to INTERRUPT him, which is what a volume preference was always
 * actually about. What is quietly available a swipe away is a different
 * question, and a smaller number.
 */
export function bandLimitsFor(p: Person_): Record<Band, number> {
  const total = homeLimitFor(p)
  return {
    now: total,
    next: Math.max(1, Math.round(total / 3)),
    background: Math.max(1, Math.round(total / 4)),
  }
}

export interface Composed extends Ranked {
  /** Items withdrawn because their life ended, with the reason. */
  withdrawn: { id: string; why: string }[]
  /**
   * The surfaced items, split by what kind of attention they want.
   *
   * `surface` is the same list flattened in band order, so a caller that does
   * not care about the split — the report, the week view — reads it unchanged.
   */
  bands: Record<Band, Attention[]>
  /** Everything decided, in order, for the build log. */
  notes: string[]
}

/** Band order, wherever the three have to be walked in the order they read. */
export const BANDS: Band[] = ['now', 'next', 'background']

/**
 * TURN A PILE OF CANDIDATES INTO THE SCREEN.
 *
 * This is the function the brief asked for: Home's composition happens in one
 * place, over typed objects that own their own lifecycle, and the lane that draws
 * the result is presentation with no truth of its own. Four decisions happen
 * here, in this order, and the order matters:
 *
 *   1. WITHDRAW what has ended. Before scoring, because scoring a card about an
 *      event that finished an hour ago produces a number, and a number is what
 *      lets it onto the screen.
 *   2. SUPERSEDE duplicates of one underlying gap.
 *   3. RANK on the six axes.
 *   4. CUT to his volume.
 *
 * Every step that removes something records why. A threshold nobody can see is
 * indistinguishable from a bug, and that applies at least as much to a lifecycle
 * rule as to a score.
 */
export function compose(
  items: Attention[],
  p: Person_,
  /**
   * `threshold` defaults to the Home bar. A screen he asked for passes
   * `ASKED_THRESHOLD` instead — see the comment there for why one constant could
   * not serve both.
   */
  opts: { now?: Date; limit?: number; threshold?: number } = {}
): Composed {
  const now = opts.now ?? new Date()
  const notes: string[] = []
  const withdrawn: { id: string; why: string }[] = []

  const live = items.filter((i) => {
    const over = ended(i, now)
    if (!over) return true
    withdrawn.push({ id: i.id, why: over.why })
    notes.push(`withdrew "${i.title}": ${over.why}`)
    return false
  })

  const present = new Set(live.map((i) => i.id))
  const kept = live.filter((i) => {
    const by = SUPERSEDED[i.id]
    if (!by || !present.has(by)) return true
    notes.push(`dropped "${i.title}": ${by} covers the same gap and can be answered`)
    return false
  })

  /**
   * SCORE EVERYTHING FIRST, THEN CUT PER BAND.
   *
   * A single global limit was the old behaviour and it had a specific failure:
   * five things needing him today filled the whole screen, so the dinner on
   * Thursday — genuinely useful, genuinely not urgent — was reported as "held
   * back, Home was already full" and he never saw it. The bands are different
   * kinds of space rather than a ranked queue, and a busy morning should not
   * empty the part of the screen that tells him what is coming.
   */
  const threshold = opts.threshold ?? HOME_THRESHOLD
  const scored = kept
    .map((i) => ({
      ...i,
      score: scoreOf(i.scores, i.kind),
      /**
       * EVERY CARD THAT REACHES A SCREEN CAN BE ARGUED WITH.
       *
       * Applied here, in the composition layer, rather than trusted to each
       * builder — which is what made correction discoverability inconsistent in
       * the first place. A builder can still write a better, more specific verb
       * and keep it; what it cannot do is ship a conclusion with no way to say
       * it is wrong. See `standardCorrections`.
       */
      corrections: [...i.corrections, ...standardCorrections(i)],
    }))
    .sort((a, b) => b.score - a.score)

  const limits = opts.limit !== undefined
    ? ({ now: opts.limit, next: opts.limit, background: opts.limit } as Record<Band, number>)
    : bandLimitsFor(p)

  const bands: Record<Band, Attention[]> = { now: [], next: [], background: [] }
  const held: { item: Attention; why: string }[] = []

  for (const item of scored) {
    if (item.score < threshold) {
      held.push({ item, why: `scored ${item.score.toFixed(2)}, below the ${threshold} bar` })
      continue
    }
    const band = bandOf(item, now)
    if (bands[band].length >= limits[band]) {
      held.push({ item, why: `scored ${item.score.toFixed(2)} but "${band}" was already full at ${limits[band]}` })
      continue
    }
    bands[band].push(item)
  }

  for (const h of held) notes.push(`held back "${h.item.title}": ${h.why}`)

  return { surface: BANDS.flatMap((b) => bands[b]), held, bands, withdrawn, notes }
}

// ── Saying when something is, without doing arithmetic ───────────────────────

/**
 * The phrase a card uses for its own instant.
 *
 * Here rather than at each builder so that no card can render a date by any
 * other means — which is the enforcement half of "no model-authored date
 * arithmetic". Everything it can say comes out of `clock.ts`.
 */
export function whenOf(a: Attention, now = new Date(), tz?: string): string {
  if (!a.at) return ''
  const t = Date.parse(a.at)
  if (!Number.isFinite(t)) return ''
  const day = dayIn(new Date(t), tz)
  const soonness = countdown(a.at, now, tz)
  const named = relativeDay(day, now, tz)
  // Within the day, how long is more useful than which day. Beyond it, the
  // reverse: "in 39 hours" is a number nobody converts, "Wednesday" is a plan.
  return soonness.startsWith('in ') && !soonness.includes('day') ? soonness : named
}

// ── Helpers for building items honestly ──────────────────────────────────────

/**
 * Urgency from a deadline, in his zone-independent terms.
 *
 * A pure function of remaining time, so two items about the same evening cannot
 * disagree about how soon it is. Past instants score 0 rather than negative:
 * something that has already happened is not urgent, it is over, and the item
 * should have been retired.
 */
export function urgencyOf(at: string | undefined, now = new Date()): number {
  if (!at) return 0.2
  const ms = Date.parse(at) - now.getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  const hours = ms / 3_600_000
  if (hours <= 3) return 1
  if (hours <= 12) return 0.85
  if (hours <= 30) return 0.7
  if (hours <= 24 * 3) return 0.45
  if (hours <= 24 * 7) return 0.25
  return 0.1
}

/**
 * Has he been told this already, and did anything change?
 *
 * Novelty is not "have we generated this string before" — the model words the
 * same conclusion differently every pass, so string comparison scores
 * everything as new. It is keyed on the item ID, which is derived from what the
 * item is ABOUT, so "the dinner on the 12th" is one thing however it is worded.
 */
export function noveltyOf(id: string, seen: Record<string, { at: string; score: number }>, now = new Date()): number {
  const held = seen[id]
  if (!held) return 1
  const hours = (now.getTime() - Date.parse(held.at)) / 3_600_000
  if (!Number.isFinite(hours)) return 1
  // Shown an hour ago: nearly worthless. Shown three days ago and still true:
  // worth raising again, because circumstances have had time to change.
  if (hours < 6) return 0.05
  if (hours < 24) return 0.25
  if (hours < 72) return 0.5
  return 0.8
}

/**
 * Does this fit what he has told us he wants?
 *
 * Reads the assistant's OWN preferences — how proactive to be, what he has said
 * he does not want raised. Defaults to neutral-positive rather than to 1, so an
 * item nobody has expressed an opinion about does not out-score one he has
 * actively endorsed.
 */
export function fitOf(p: Person_, kind: AttentionKind, about?: string, now = new Date()): number {
  const proactivity = p.preferences['assistant.proactivity']?.value
  const base =
    proactivity === 'low' ? 0.4 : proactivity === 'high' ? 0.9 : 0.7

  if (about) {
    const disliked = p.preferences[`dislike.${about}`]
    // He SAID this. Nothing below may soften it, and nothing above may
    // manufacture it — that is the difference between a preference and a habit.
    if (disliked && disliked.value === true) return 0.05
  }

  /**
   * WHAT HE SAID, THEN WHAT HE DOES — IN THAT ORDER, AND ONLY EVER AS A NUDGE.
   *
   * The loop the brief asked to close: accepting travel warnings while
   * dismissing routine activity nudges should influence the ranking. It does,
   * here, and it does it WITHOUT touching `assistant.proactivity` — his stated
   * setting is the base, and behaviour moves the result by at most 0.2 either
   * way on top of it.
   *
   * Writing the stated preference from behaviour was the tempting shortcut and
   * would have been the worst possible version: he sets "tell me everything",
   * swipes three cards away on a bad morning, and finds the app has quietly
   * turned itself down with nothing on any screen saying so. A setting that the
   * app edits behind him is not a setting. See `engagementBiasOf` for the
   * bounds, the evidence threshold and the decay.
   */
  const learned = engagementBiasOf(p, about, now)

  // A recommendation is the most intrusive kind and the easiest to get wrong,
  // so it starts lower than an obligation he actually has.
  const fit = kind === 'recommendation' ? base * 0.8 : base
  return Math.min(1, Math.max(0.05, fit + learned))
}
