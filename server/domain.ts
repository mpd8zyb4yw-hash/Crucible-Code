/**
 * WHAT THE MEMORY CORE ADDS TO A DOMAIN THAT ALREADY WORKS.
 *
 * Phase 8. `intelligence.ts` compiles the one thought Crucible has concluded and
 * puts it in its own slot. This is the other half, and it is deliberately a much
 * smaller object:
 *
 *     memory / typed cognition
 *             ↓
 *     bounded domain context      ← this file
 *             ↓
 *     the existing domain model   (Widget: CalEvent, MailMessage, ActivityBrief…)
 *             ↓
 *     UI
 *
 * THE DISTINCTION THIS FILE EXISTS TO HOLD. Intelligence is COGNITION worth
 * surfacing as Crucible's own thought — it has a kind, an evidence trail, a
 * visual, a certainty band on the face, and three verdict controls behind it,
 * because it is a claim he is invited to argue with. Domain context is CONTEXT:
 * one line, on an object he is already looking at, saying the thing the domain
 * could not know about itself. It carries no evidence trail, no visual, no
 * actions and no feedback controls, and it never gets a card of its own.
 *
 * §18 is the rule that shape enforces: Calendar, Activity, Places and Mail must
 * not each invent their own hypothesis wording, their own certainty system,
 * their own evidence semantics and their own feedback model. There is one
 * certainty ladder in this codebase and it is `intelligence.ts`'s; this file
 * imports it rather than growing a second. There is one grounding guard and it
 * is `ungrounded()`; this file imports that too. What is local here is only the
 * choosing of what is worth a line.
 *
 * AND THE MEASURE OF SUCCESS IS NOT HOW OFTEN THIS RETURNS SOMETHING. Every
 * compiler below returns an EMPTY ARRAY far more often than not — no baseline,
 * too few samples, a spread of zero, a capability still in shadow — and on the
 * real ledger, which holds thirteen days, all four return empty always. The
 * domain has to be exactly as usable in that case as it was before this file
 * existed, which is what `scripts/negative.mjs` asserts one compiler at a time.
 *
 * WHO OWNS WHAT. The DOMAIN owns what is true — how many events are on today,
 * what the step count was, where the pins are, who sent the message. The MEMORY
 * CORE owns what is usual. So every function here takes the domain's fact as an
 * argument and supplies only the comparison; nothing in this file re-derives a
 * figure the domain already computed, and nothing in the domain has to learn how
 * to read a `TemporalSummary`.
 */

import { dayIn, partsIn, weekdayName, weekdayOf } from './clock.js'
import { certaintyOf, clampCopy, clockOf, ungrounded, type Certainty } from './intelligence.js'
import { isLive, type MemoryPosture } from './memory/authority.js'
import { PLACE_RADIUS_M, metresApart, geoOf } from './memory/entities.js'
import type { MemoryStore, RoutineModel, TemporalSummary } from './memory/types.js'

// ── The bounded object ───────────────────────────────────────────────────────

export type Domain = 'calendar' | 'activity' | 'places' | 'mail'

/**
 * WHERE THE LINE IS ALLOWED TO BE DRAWN.
 *
 * Data rather than convention, because §6 is a rule about competition for space:
 * a Home card must not grow a row merely because the memory core now has
 * something to say, and the judgement about whether this particular sentence
 * beats the event information beside it is made HERE, where the certainty and
 * the kind of claim are both in hand. A consumer that only draws `card` weight
 * on a card cannot get that wrong by forgetting.
 */
export type ContextWeight = 'card' | 'depth'

export interface DomainContext {
  domain: Domain
  /**
   * The object in the DOMAIN'S OWN vocabulary that this line belongs beside —
   * an event id, a message id, a place pin id — or `''` when it is about the
   * domain as a whole rather than about one object.
   *
   * A string the consumer already has. The join from a memory entity to a domain
   * object happens in this file, on structured identity (an email address, a
   * coordinate), and never on a label — the same rule `entities.ts` states, for
   * the same reason.
   */
  subject: string
  /** Memory-side ids this is about. The dedup key against the other slots. */
  subjectRefs: string[]
  /** The whole of it. One line, already clamped. */
  line: string
  weight: ContextWeight
  /**
   * The band the line's grammar was chosen from. NEVER rendered.
   *
   * Carried so a consumer can rank two contexts, and so the developer view can
   * say why a sentence hedged the way it did. §13 is explicit that the evidence
   * belongs deeper and the probabilities belong nowhere: a client that printed
   * this would be doing the thing the whole boundary exists to prevent.
   */
  certainty: Certainty
  /**
   * WHAT IT WAS WORKED OUT FROM, in his words — and only for `depth`.
   *
   * The detail slots this lands in (`CalEvent.note`, `MailMessage.note`) refuse
   * to render a line without one, which is a rule those types stated before this
   * file existed and a good one: a claim on an opened object should say where it
   * came from. It is a PHRASE, not a trail — "from your recent Saturdays" — and
   * never the internal vocabulary. §13: the evidence belongs deeper, and the
   * probabilities belong nowhere.
   *
   * A `card` context has none. There is no room for it on a card and no honest
   * way to shorten it further, which is part of why the card only ever gets the
   * conclusion.
   */
  grounds?: string
  /** Record ids this was compiled from. Traceability, never rendered. */
  provenanceRefs: string[]
}

/**
 * WHAT FITS ON ONE ROW UNDER SOMETHING ELSE.
 *
 * Shorter than `intelligence.ts`'s headline budget on purpose. That card is the
 * whole of its slot; this line is a subordinate row beneath an event title or a
 * step count, and a sentence that wraps to two lines there is a sentence that
 * has taken the space of the thing it was supposed to be explaining.
 */
export const CONTEXT_BUDGET = 52

/**
 * The compiler's own assertion, identical in intent to `intelligence.ts`'s.
 *
 * Same throw-rather-than-drop argument: a line that quietly lost itself to a
 * guard is a defect nobody sees. Imported rather than reimplemented so there is
 * exactly one definition of "a number nobody computed".
 */
function grounded(field: string, text: string, allowed: Iterable<string | number>): string {
  const bad = ungrounded(text, allowed)
  if (bad.length) {
    throw new Error(`domain: ${field} states ${bad.join(', ')}, which nothing computed`)
  }
  return text
}

const line = (field: string, text: string, allowed: Iterable<string | number> = []): string =>
  grounded(field, clampCopy(text, CONTEXT_BUDGET), allowed)

// ── Reading the baselines ────────────────────────────────────────────────────

/** The per-weekday summary for a metric, or null. `reflect.ts` writes these. */
function weekdayBaseline(
  store: MemoryStore,
  domain: string,
  metric: string,
  day: string
): TemporalSummary | null {
  const s = store.summaries.byId(`tmp:${domain}:${metric}:weekday:${weekdayOf(day)}`)
  /*
    FOUR SAMPLES IS THE FLOOR, AND IT IS `reflect.ts`'S FLOOR RATHER THAN A
    SECOND ONE.

    That pass already refuses to write a scoped summary under four points — "a
    mean is a rumour and a standard deviation is worse". Re-testing it here is
    not redundancy: a summary written when the series was longer survives the
    series getting shorter, and this is the read that would otherwise compare
    today against three old Tuesdays.
  */
  if (!s || s.count < 4 || s.mean === null) return null
  return s
}

/** How far from the middle, or null when the spread cannot support the question. */
function sigmas(value: number, s: TemporalSummary): number | null {
  if (s.mean === null || s.stdDev === null || s.stdDev === 0) return null
  return (value - s.mean) / s.stdDev
}

/**
 * The certainty of a comparison against a baseline.
 *
 * Confidence is the coverage rather than an asserted number: eight Thursdays is
 * a better answer about Thursdays than five, and neither is a fact. Passed
 * through the SHARED ladder so a baseline comparison and a hypothesis hedge with
 * the same five verbs.
 */
const baselineCertainty = (s: TemporalSummary): Certainty =>
  certaintyOf({ confidence: Math.min(0.78, 0.4 + s.count * 0.04), coverageDays: s.count * 7 })

// ── Calendar ─────────────────────────────────────────────────────────────────

export interface CalendarFacts {
  /** His day, from `clock.ts`. Never derived from a rendered string. */
  today: string
  /** How many events the DOMAIN has on today. The domain's fact, not ours. */
  todayEvents: number
  /**
   * The timed events the surface can annotate, in any order.
   *
   * Only an id, a start and whether it has somewhere to be. Deliberately not the
   * title: a compiler holding the words would eventually read them, and reading
   * a time or a place back out of a rendered string is the second, weaker
   * reading this codebase deletes wherever it appears.
   */
  events?: { id: string; start: string; located: boolean }[]
}

/**
 * WHAT CRUCIBLE KNOWS ABOUT THE SHAPE OF THIS DAY, AND ABOUT LEAVING.
 *
 * Two KINDS of line, and they answer the two questions §4 says Calendar should
 * be able to answer that a timeline cannot: whether today is unusual for a day
 * of its kind, and whether something on it needs him moving at an unusual hour.
 * At most one of the first; at most one of the second per event, and in practice
 * none, because most events do not start before he is out of the house.
 *
 * Neither is a panel and neither is a card. The density line rides the widget's
 * existing foot — the one row that already exists for "the sentence a picture of
 * blocks cannot make" — and the departure lines live in the event's detail
 * sheet, which before this change restated the block behind it and added a
 * button. §5: modify context, do not create another surface.
 */
export function calendarContext(
  store: MemoryStore,
  facts: CalendarFacts,
  ctx: { posture: MemoryPosture; timeZone?: string; hour12?: boolean }
): DomainContext[] {
  if (!isLive(ctx.posture, 'baselines')) return []
  const out: DomainContext[] = []

  /*
    UNUSUAL DENSITY. The conclusion, never the arithmetic.

    "Busier than your usual Friday" and not "3 events against a mean of 1.4,
    +1.8σ". §9's rule is written about Activity and is a rule about all four: the
    statistics are ingredients and he needs the conclusion. Nothing in this
    sentence is a quantity, so `grounded` has nothing to check — which is the
    correct shape for it rather than a way around it.
  */
  const load = weekdayBaseline(store, 'calendar', 'events_per_day', facts.today)
  if (load) {
    const z = sigmas(facts.todayEvents, load)
    if (z !== null && Math.abs(z) >= 1.2) {
      out.push({
        domain: 'calendar',
        subject: '',
        subjectRefs: ['events_per_day'],
        line: line('density', `${z > 0 ? 'Busier' : 'Quieter'} than your usual ${weekdayName(facts.today)}.`),
        weight: 'card',
        certainty: baselineCertainty(load),
        provenanceRefs: [load.id],
      })
    }
  }

  /*
    THE DEPARTURE IMPLICATION — AND ONLY THE FORM THAT IS WORTH SAYING.

    The obvious version of this is two-sided: warn when an event starts before he
    is usually out of the house, and otherwise state the baseline — "you usually
    leave home around 10:35". The second half is deleted, and the reason is a
    fixture event called "Call with the studio" at a location of "Zoom".

    `location` is a STRING. Nothing in a pane build knows whether it names a
    doorway or a video call, and there is no honest way to find out here — so a
    line about leaving the house would attach itself to a conference call, which
    is the confident-irrelevant answer that costs trust in the lines that are
    right. The one-sided version needs no such judgement: "this starts earlier
    than you usually leave home" is worth reading about an early call and about an
    early appointment alike, and it simply never fires for the 20:30 ones. §4's
    "whether something requires unusual timing", and nothing else.

    A baseline nobody compares anything to is a statistic, and a statistic on a
    detail sheet is engine state. So when there is no unusual timing there is no
    line, which is most events.

    Scoped to the EVENT'S weekday rather than to today's, because the question is
    about the morning of the event.
  */
  for (const e of facts.events ?? []) {
    if (!e.located) continue
    const at = new Date(e.start)
    if (Number.isNaN(at.getTime())) continue
    const day = dayIn(at, ctx.timeZone)
    const dep = weekdayBaseline(store, 'location', 'departure_minute', day)
    if (!dep || dep.median === null) continue

    const p = partsIn(at, ctx.timeZone)
    if (p.hour * 60 + p.minute >= dep.median) continue

    out.push({
      domain: 'calendar',
      subject: e.id,
      subjectRefs: ['departure_minute'],
      line: line('departure', `Earlier than you usually leave home on a ${weekdayName(day)}.`),
      grounds: `From when you have left home on recent ${weekdayName(day)}s`,
      weight: 'depth',
      certainty: baselineCertainty(dep),
      provenanceRefs: [dep.id],
    })
  }

  return out
}

// ── Activity ─────────────────────────────────────────────────────────────────

export interface ActivityFacts {
  /**
   * The trusted figure and the day it is FROM — never today by assumption.
   *
   * `ActivityBrief.current` is null when there is no trustworthy number, and
   * this takes the same shape so that the missing case cannot be papered over by
   * a caller passing a zero. MISSING IS NOT ZERO is a hard semantic rule and the
   * cheapest place to keep it is a type that has no zero to offer.
   */
  current: { day: string; value: number } | null
  metric: string
}

/**
 * HOW HE IS DOING RELATIVE TO HIMSELF — as one sentence, not six statistics.
 *
 * §9 in full: Current, Goal, Baseline, Expected, Trend, Deviation, Routine and
 * AI are ingredients, and displaying them as eight UI objects is a dashboard
 * rather than an answer. What Activity's card gets from the memory core is the
 * CONCLUSION — "about your usual Thursday" — and the ingredients stay where they
 * already are, which is the depth surface's header and the chart itself.
 *
 * MISSING IS NOT ZERO, ENFORCED BY WHAT THIS CANNOT SEE. The comparison is made
 * against the day the figure is FROM. When the phone has not synced since
 * Thursday, this compares Thursday to other Thursdays and says so; it has no way
 * to compare today to anything, because `current` is the only reading it is
 * given and a day with no reading never becomes one.
 */
export function activityContext(
  store: MemoryStore,
  facts: ActivityFacts,
  ctx: { posture: MemoryPosture }
): DomainContext[] {
  if (!isLive(ctx.posture, 'baselines')) return []
  if (!facts.current) return []

  const s = weekdayBaseline(store, 'activity', facts.metric, facts.current.day)
  if (!s) return []
  const z = sigmas(facts.current.value, s)
  if (z === null) return []

  /*
    FIVE RUNGS, AND THE MIDDLE ONE IS THE USEFUL ONE.

    A comparison that can only report deviation reports one every week and stops
    meaning anything. "About your usual Thursday" is the answer most days and is
    worth the row: it is the difference between a number he has to judge and a
    number that has already been judged against the only baseline that is his.
  */
  const a = Math.abs(z)
  const dir = z > 0 ? 'above' : 'below'
  const said =
    a < 0.6
      ? `About your usual ${weekdayName(facts.current.day)}.`
      : a < 1.5
        ? `A little ${dir} your usual ${weekdayName(facts.current.day)}.`
        : `Well ${dir} your usual ${weekdayName(facts.current.day)}.`

  return [{
    domain: 'activity',
    subject: '',
    subjectRefs: [facts.metric],
    line: line('baseline', said),
    weight: 'card',
    certainty: baselineCertainty(s),
    provenanceRefs: [s.id],
  }]
}

// ── Places ───────────────────────────────────────────────────────────────────

export interface PlaceFacts {
  /** The pins the domain is drawing, with the coordinates it drew them at. */
  pins: { id: string; lat: number; lon: number }[]
  /** Now, for the window the visits are read over. PASSED, never read here. */
  now: Date
}

/**
 * WHEN HE IS USUALLY AT A PLACE — said in his words, with the arithmetic left
 * where it belongs.
 *
 * §13 is the rule this is written against, by name: not
 *
 *     Dervio · probability 0.76 · 14 observations · confidence strong
 *
 * but
 *
 *     Dervio · usually Saturday morning
 *
 * The probability, the observation count and the confidence are all on the
 * `RoutineModel` and none of them reaches the string. What decides whether the
 * line appears at all is those numbers; what the line SAYS is a weekday and a
 * part of the day, which is the form a person would use.
 *
 * The join from a pin to a routine is by COORDINATE, through the same clustering
 * radius `entities.ts` uses to decide that two sightings are one doorway. Never
 * by label: "Coop" is the name of six hundred shops.
 */
export function placesContext(
  store: MemoryStore,
  facts: PlaceFacts,
  ctx: { posture: MemoryPosture; timeZone?: string }
): DomainContext[] {
  if (!isLive(ctx.posture, 'routines')) return []

  const routines = store.routines.all().filter((r) => r.activityType.startsWith('place:'))
  if (!routines.length) return []

  const out: DomainContext[] = []
  const located = placeCoordinates(store, facts.now)
  for (const pin of facts.pins) {
    const entityId = placeAt(located, pin)
    if (!entityId) continue
    const routine = routines.find((r) => r.activityType === `place:${entityId}`)
    if (!routine) continue
    const said = rhythmOf(routine)
    if (!said) continue
    out.push({
      domain: 'places',
      subject: pin.id,
      subjectRefs: [entityId, routine.id],
      line: line('rhythm', said),
      weight: 'card',
      certainty: certaintyOf({
        confidence: routine.confidence,
        coverageDays: routine.temporalCoverageDays,
      }),
      provenanceRefs: [routine.id, entityId],
    })
  }
  return out
}

/**
 * WHERE THE STORE HAS ACTUALLY SEEN EACH PLACE, AS COORDINATES.
 *
 * The join has to be geographic, and a place entity does not carry a coordinate:
 * its identity is `place:<the source's key>` when the source gave one, and only
 * `geo:<lat>,<lon>` when it did not. Parsing a coordinate back out of a source's
 * key would be reading a slug — the second, weaker reading this codebase deletes
 * on sight, and it would work on the fixture's keys and on nothing else.
 *
 * So the coordinates come from where they are actually recorded: the visits.
 * Both identity shapes are covered, one entity can hold several sightings, and
 * the proximity test is `entities.ts`'s own — same radius, same arithmetic, so a
 * pin and a visit are "the same doorway" here exactly when the resolver would
 * have said so.
 *
 * BOUNDED BY A WINDOW, NOT BY A ROW COUNT, because this is on the instant-paint
 * path and a year of location history is not a thing to scan before the first
 * frame. The first attempt took `ofType(type, 400)`, which the store answers
 * `ORDER BY at ASC` — the OLDEST four hundred. On a long history that reads April
 * and never reaches August, so a place he only started going to recently could
 * never be located, and the failure would look exactly like "no routine yet".
 * A trailing window says what was actually meant, and a routine that has not
 * been visited inside it is not a routine worth annotating a pin with.
 */
const VISIT_WINDOW_DAYS = 120

function placeCoordinates(store: MemoryStore, now: Date): { id: string; lat: number; lon: number }[] {
  const out: { id: string; lat: number; lon: number }[] = []
  const seen = new Set<string>()

  for (const e of store.entities.ofKind('place')) {
    for (const identity of e.identities) {
      const geo = geoOf(identity)
      if (geo && !seen.has(e.id)) { out.push({ id: e.id, ...geo }); seen.add(e.id) }
    }
  }

  const from = new Date(now.getTime() - VISIT_WINDOW_DAYS * 86_400_000).toISOString()
  const to = new Date(now.getTime() + 86_400_000).toISOString()
  for (const o of store.observations.between(from, to, 'location_visit')) {
    const lat = o.attributes.lat
    const lon = o.attributes.lon
    if (typeof lat !== 'number' || typeof lon !== 'number') continue
    for (const c of o.entityCandidates ?? []) {
      if (c.kind !== 'place' || !c.key) continue
      const entity = store.entities.byIdentity(c.key)
      if (!entity) continue
      const key = `${entity.id}:${lat.toFixed(4)},${lon.toFixed(4)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ id: entity.id, lat, lon })
    }
  }
  return out
}

/** The place entity this pin is standing on, by the store's own clustering rule. */
function placeAt(located: { id: string; lat: number; lon: number }[], pin: { lat: number; lon: number }): string | null {
  let best: { id: string; metres: number } | null = null
  for (const p of located) {
    const m = metresApart(p, pin)
    if (m <= PLACE_RADIUS_M && (!best || m < best.metres)) best = { id: p.id, metres: m }
  }
  return best?.id ?? null
}

/**
 * "Usually Saturday morning", or nothing.
 *
 * Nothing is the common answer and it is the honest one. A rhythm spread over
 * four weekdays is not a weekday rhythm, an unestablished one is a coincidence
 * with a low sample count, and a routine whose recurrence is under a half is a
 * thing he does sometimes — which is not worth a row on a map.
 */
function rhythmOf(r: RoutineModel): string | null {
  if (r.status !== 'established' && r.status !== 'emerging') return null
  if (r.temporal.recurrenceProbability < 0.5) return null
  const days = r.temporal.daysOfWeek ?? []
  if (!days.length || days.length > 2) return null

  const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const when = days.map((d) => NAMES[d] ?? '').filter(Boolean)
  if (when.length !== days.length) return null

  const m = r.temporal.typicalStartMinutes
  const part =
    m === undefined ? '' : m < 12 * 60 ? ' morning' : m < 17 * 60 ? ' afternoon' : ' evening'
  // Two days share one part-of-day word: "usually Tuesday or Thursday morning".
  return `Usually ${when.join(' or ')}${part}.`
}

// ── Mail ─────────────────────────────────────────────────────────────────────

export interface MailFacts {
  /** The messages the domain is showing, with the address each came from. */
  messages: { id: string; from: string }[]
  /** Now, for "what is coming". Passed rather than read — `clock.ts`'s rule. */
  now: Date
}

/**
 * WHO THIS IS, AND WHAT IS COMING WITH THEM.
 *
 * §14: Mail stays communication-first, and the memory core's contribution is
 * identity resolution and relation to an upcoming event — not a contact record,
 * not a last-contacted date, not an engagement score. The line is only ever
 * emitted when there is something ARRANGED with the sender, because "you have
 * mailed this person eleven times" is CRM and answers nothing.
 *
 * The identity join is the email address, lowercased — the same key
 * `normalize.ts` writes and the same key `people.ts` has always used, so the
 * mail this arrived in and the entity it resolves to agree by construction
 * rather than by a name match.
 *
 * WEIGHT IS `depth`, DELIBERATELY. A fourth string on a Home mail row is a
 * fourth string on four rows, and the widget's job at a glance is who wants
 * something. This belongs in the reader, which is where the question "why does
 * this matter" is actually being asked — and where, before this, the surface
 * showed a body and nothing else.
 */
export function mailContext(
  store: MemoryStore,
  facts: MailFacts,
  ctx: { posture: MemoryPosture; timeZone?: string; hour12?: boolean }
): DomainContext[] {
  if (!isLive(ctx.posture, 'entities')) return []

  const from = facts.now.toISOString()
  const to = new Date(facts.now.getTime() + 14 * 86_400_000).toISOString()
  const planned = store.episodes.between(from, to).filter((e) => e.status === 'planned')
  if (!planned.length) return []

  const out: DomainContext[] = []
  for (const m of facts.messages) {
    const address = addressOf(m.from)
    if (!address) continue
    const entity = store.entities.byIdentity(`email:${address}`)
    if (!entity) continue

    const next = planned
      .filter((e) => e.participantEntityIds.includes(entity.id))
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0]
    if (!next) continue

    const at = new Date(next.startAt)
    const when = whenWords(at, facts.now, ctx.timeZone, ctx.hour12)
    /*
      ONE PER MESSAGE, NOT ONE PER PERSON. Three replies from Odelia are three
      messages he can open, and the context is about whichever one he opened —
      deduplicating by sender would leave two of the three with no line for no
      reason a reader could discover.
    */
    out.push({
      domain: 'mail',
      subject: m.id,
      subjectRefs: [entity.id, next.id],
      line: line('upcoming', `You are seeing ${entity.label} ${when}.`, whenFigures(when)),
      grounds: 'From an arrangement already in your calendar',
      weight: 'depth',
      /*
        `known` rather than a hedge, and it is the one place in this file that
        reaches the top of the ladder legitimately: an arrangement is not a
        pattern anybody inferred. The entity resolution is exact — an address
        matched an address — and the episode is a planned meeting that exists.
        Nothing here was concluded, so nothing here hedges.
      */
      certainty: 'known',
      provenanceRefs: [entity.id, next.id],
    })
  }
  return out
}

/** `Display Name <a@b>` → `a@b`, lowercased. The header shape, not the tidy one. */
export function addressOf(from: string): string | null {
  const m = /<([^>]+)>/.exec(from)
  const raw = (m ? m[1] : from).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(raw) ? raw : null
}

/**
 * "tomorrow at 11:00", "on Saturday at 11:00", "later today at 18:30".
 *
 * Formatted HERE because every part of it is a zone decision and `clock.ts`
 * owns those. A client handed an ISO string and asked to say "tomorrow" is a
 * client doing date arithmetic, which is the standing rule this file will not
 * break for one sentence.
 */
function whenWords(at: Date, now: Date, timeZone?: string, hour12?: boolean): string {
  const today = dayIn(now, timeZone)
  const day = dayIn(at, timeZone)
  const p = partsIn(at, timeZone)
  const time = clockOf(p.hour * 60 + p.minute, timeZone, hour12)
  if (day === today) return `later today at ${time}`
  const tomorrow = dayIn(new Date(now.getTime() + 86_400_000), timeZone)
  if (day === tomorrow) return `tomorrow at ${time}`
  return `on ${weekdayName(day)} at ${time}`
}

/** The quantities `whenWords` is entitled to have produced. See `grounded`. */
const whenFigures = (when: string): string[] => {
  const m = /(\d{1,2}[:.]\d{2}\s*(?:[AaPp][Mm])?)/.exec(when)
  return m ? [m[1]!.trim()] : []
}

// ── The one entry point ──────────────────────────────────────────────────────

export interface DomainFacts {
  calendar?: CalendarFacts
  activity?: ActivityFacts
  places?: PlaceFacts
  mail?: MailFacts
}

export interface DomainContextOptions {
  posture: MemoryPosture
  timeZone?: string
  hour12?: boolean
}

/**
 * EVERY CONTEXT THE MEMORY CORE CAN SUPPORT FOR THE DOMAINS IT WAS GIVEN FACTS
 * ABOUT — AND AN EMPTY ARRAY IS THE NORMAL ANSWER.
 *
 * FAILURE IS ISOLATED PER DOMAIN, and that is the whole reason this is a loop
 * over four calls rather than one function with four sections. §27: if
 * enrichment fails the domain still renders, still interacts and keeps its data.
 * A single try/catch around all four would let a bad place entity cost Calendar
 * its departure line, which is the failure mode where one broken thing takes
 * three working ones with it.
 */
export function domainContexts(
  store: MemoryStore,
  facts: DomainFacts,
  opts: DomainContextOptions
): DomainContext[] {
  const out: DomainContext[] = []
  const run = (f: () => DomainContext[]) => {
    try {
      out.push(...f())
    } catch {
      /*
        Swallowed, and deliberately not logged as an error the caller can see:
        this is enhancement, and the contract with every consumer is that it
        either has a line or it does not. What a broken compiler must never do is
        turn into a broken screen. The developer view reads the store directly.
      */
    }
  }
  if (facts.calendar) run(() => calendarContext(store, facts.calendar!, opts))
  if (facts.activity) run(() => activityContext(store, facts.activity!, opts))
  if (facts.places) run(() => placesContext(store, facts.places!, opts))
  if (facts.mail) run(() => mailContext(store, facts.mail!, opts))
  return out
}

/**
 * The line for one object, at a weight the caller is willing to draw.
 *
 * A helper rather than a filter written at each call site, because "which of
 * these am I allowed to put on a card" is the rule §6 states and it should have
 * exactly one implementation.
 */
export const contextFor = (
  contexts: DomainContext[] | undefined,
  domain: Domain,
  subject: string,
  weight: ContextWeight
): DomainContext | null =>
  contexts?.find((c) => c.domain === domain && c.subject === subject && c.weight === weight) ?? null
