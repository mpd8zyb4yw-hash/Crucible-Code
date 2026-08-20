/**
 * RAW SOURCE PAYLOAD → TYPED OBSERVATION. NO MODEL, EVER.
 *
 * This is the layer that stops connector shapes from becoming the cognitive
 * model. Without it, every downstream stage — episode assembly, routine
 * learning, the temporal summaries — would have to know that a calendar event
 * keeps its people in `data.attendees[].email` while a mail keeps its person in
 * `data.from`, and adding a connector would mean editing the cognition. With it,
 * they all read `planned_meeting` and `communication` and never learn where
 * either came from.
 *
 * DETERMINISTIC BY CONTRACT, AND THIS IS NOT A PERFORMANCE ARGUMENT.
 *
 * Nothing in this file calls a language model, and nothing in it may. Three
 * reasons, in increasing order of how much they cost when ignored:
 *
 *   1. Replay. §34 requires that derived state be rebuildable from the ledger
 *      to a semantically equivalent result. A generative step in the middle
 *      makes that untestable — the rebuild would differ every time and there
 *      would be no way to tell an improvement from a regression.
 *   2. Cost and availability. Normalisation runs on every event forever. A model
 *      call here is a model call per calendar row per sync, on a free tier, in a
 *      cron that also has to do the thinking.
 *   3. Silence. A model asked to extract fields will produce fields. On a payload
 *      it does not understand it will produce plausible ones, and the ledger's
 *      provenance would then attest that a connector reported something no
 *      connector ever said.
 *
 * WHERE A MODEL IS LEGITIMATE — and this file is deliberately arranged so that
 * it can be added later without moving anything: free text. "See you for lunch
 * tomorrow" in a mail body genuinely does need language understanding, and when
 * that lands it will produce observations with a LOWER confidence and a
 * provenance naming the model, sitting beside the deterministic ones rather than
 * replacing them. `normalizeVersion` is what will let the improved pass re-run
 * over the same events.
 */

import { partsIn } from '../clock.js'
/* `people.ts` owns both halves of "who is this address": the parse and the
   is-it-a-human question. `entities.ts` already imports the second from there
   for the reason §5 gives — two resolvers must not be able to disagree — and
   the parse travels with it for exactly the same reason. */
import { mailbox } from '../people.js'
import { idOf } from './ids.js'
import {
  VERSIONS,
  type EntityCandidate,
  type MemoryEvent,
  type NormalizedObservation,
  type ObservationType,
  type Provenance,
} from './types.js'

export interface NormalizeOptions {
  /** His own address, so he is not lifted as a person in his own life. */
  me?: string
  /** His zone, for anything that has to become a local day. */
  timeZone?: string
}

/**
 * THE ONE ENTRY POINT. An event in, zero or more typed observations out.
 *
 * Zero is a legitimate answer and is not an error: a `crucible.recommendation.shown`
 * event is real history that nothing needs to reason over as an observation, and
 * a payload shape this version does not recognise is recorded as `other` rather
 * than being guessed at or dropped. The ledger keeps it either way, so a later
 * normaliser can do better with it.
 */
export function normalizeEvent(e: MemoryEvent, opts: NormalizeOptions = {}): NormalizedObservation[] {
  const p = payloadOf(e)
  const kind = dataKindOf(e, p)

  switch (kind) {
    case 'event':
      return [plannedMeeting(e, p, opts)]
    case 'email':
      return [communication(e, p, opts)]
    case 'steps':
      return activityMeasurements(e, p)
    case 'visit':
      return [locationVisit(e, p, opts)]
    case 'statement':
      return [statement(e, p)]
    default:
      return [other(e, p)]
  }
}

/** Normalise many, in ledger order, so the output is a function of the input alone. */
export function normalizeEvents(events: MemoryEvent[], opts: NormalizeOptions = {}): NormalizedObservation[] {
  return events.flatMap((e) => normalizeEvent(e, opts))
}

// ── Reading the payload without trusting it ──────────────────────────────────

type Bag = Record<string, unknown>

const payloadOf = (e: MemoryEvent): Bag => (e.payload && typeof e.payload === 'object' ? (e.payload as Bag) : {})

/**
 * Which shape this is, decided from the payload and the event type together.
 *
 * BOTH, not either. The event type is the source's word for it and can be
 * anything a connector author typed; the payload's `data.kind` is the world
 * document's own discriminator and is reliable where it exists. Checking the
 * structure first and falling back to the type string means a connector that
 * names its events unusually still normalises correctly, and one that produces a
 * payload we do not recognise is still classified by what it called itself.
 */
function dataKindOf(e: MemoryEvent, p: Bag): string {
  const data = p.data && typeof p.data === 'object' ? (p.data as Bag) : null
  const declared = typeof data?.kind === 'string' ? (data.kind as string) : null
  if (declared) return declared === 'video' || declared === 'place' ? 'other' : declared
  if (e.type === 'location.visit') return 'visit'
  if (e.type.startsWith('user.')) return 'statement'
  return 'other'
}

/** The typed half of a world-document payload, when there is one. */
const dataOf = (p: Bag): Bag => (p.data && typeof p.data === 'object' ? (p.data as Bag) : {})

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Ids are the event's, with a role and an index — see `ids.ts` for why. */
const obsId = (e: MemoryEvent, role: string, index = 0): string =>
  idOf(e.id.replace(/^evt:/, 'obs:'), role, index)

const provenanceOf = (e: MemoryEvent): Provenance => ({
  source: e.source,
  sourceId: e.sourceId,
  sourceAt: e.sourceAt,
  observedAt: e.observedAt,
})

// ── The shapes ───────────────────────────────────────────────────────────────

/**
 * A calendar row.
 *
 * The people come from `attendees[]` and `organizer` and NOWHERE ELSE — no regex
 * over the summary, which is the rule `people.ts` already states and the reason
 * it holds: a structured array of addresses is what the source actually knows,
 * and a name pulled out of a title is a guess wearing a fact's clothes.
 *
 * The one exception is deliberate and is marked as such. A summary like "Lunch
 * Bernardo" names somebody the attendee list does not, and refusing to notice
 * that would mean the app cannot model the people he actually spends time with —
 * most of whom are not on a calendar invitation. So a bare capitalised token IS
 * lifted, as a candidate with NO KEY and a low confidence, which resolution is
 * then forbidden to merge into anyone on evidence this thin. See
 * `entities.ts`'s `MENTION_EVIDENCE`.
 */
function plannedMeeting(e: MemoryEvent, p: Bag, opts: NormalizeOptions): NormalizedObservation {
  const d = dataOf(p)
  const start = str(d.start) ?? e.sourceAt
  const end = str(d.end)
  const summary = str(d.summary) ?? str(p.text) ?? ''
  const location = str(d.location)
  const mine = mailbox(opts.me)

  const candidates: EntityCandidate[] = []
  const attendees = Array.isArray(d.attendees) ? (d.attendees as Bag[]) : []
  for (const a of attendees) {
    // Calendar attendees are usually bare addresses; `mailbox` is idempotent on
    // one, and the invitation that arrives as `Name <addr>` is why it is here.
    const email = mailbox(str(a.email))
    if (!email || email === mine) continue
    candidates.push({ kind: 'person', key: `email:${email}`, label: str(a.name) ?? email, via: 'event-attendee', confidence: 0.9 })
  }
  const organizer = mailbox(str(d.organizer))
  if (organizer && organizer !== mine) {
    candidates.push({ kind: 'person', key: `email:${organizer}`, label: organizer, via: 'event-organizer', confidence: 0.9 })
  }
  /**
   * A NAME IN THE TITLE IS ONLY EVIDENCE WHEN THE SOURCE GAVE NO ATTENDEE LIST.
   *
   * Found by running this over four months of synthetic calendar: "Project sync
   * 1" produced a person called Project, who then accumulated enough sightings to
   * become an entity and to acquire a `frequently_meets` edge. The heuristic was
   * doing exactly what it was told; the instruction was wrong.
   *
   * The rule that fixes it is not a longer list of forbidden words — that is
   * whack-a-mole in one language against titles written in another. It is that a
   * calendar row WITH an attendee list has already told us who is there, so a
   * capitalised word in its title is a topic. A row with no attendees at all is a
   * personal note — "Lunch Bernardo" — where the title is the only signal there
   * is, and refusing to read it means modelling only the part of his life that
   * arrives with invitations.
   */
  if (!candidates.length) {
    for (const name of mentionedNames(summary)) {
      candidates.push({ kind: 'person', key: null, label: name, via: 'mentioned', confidence: 0.35 })
    }
  }
  if (location) {
    candidates.push({ kind: 'place', key: `label:${location.toLowerCase()}`, label: location, via: 'event-location', confidence: 0.7 })
  }

  return {
    id: obsId(e, 'meeting'),
    eventId: e.id,
    type: 'planned_meeting',
    interval: { start, end },
    entityCandidates: candidates,
    attributes: {
      summary,
      location: location ?? null,
      allDay: d.allDay === true,
      response: str(d.response) ?? null,
      attendeeCount: attendees.length,
      /** The local weekday and start minute, computed once here rather than by
       *  every temporal model separately — and computed in HIS zone, which is the
       *  only reason a "Tuesday" in this system is his Tuesday. */
      ...localMarks(start, opts.timeZone),
    },
    provenance: provenanceOf(e),
    confidence: 1,
    normalizeVersion: VERSIONS.normalize,
  }
}

/** A message. Direction matters and is taken from the payload, never inferred. */
function communication(e: MemoryEvent, p: Bag, opts: NormalizeOptions): NormalizedObservation {
  const d = dataOf(p)
  /**
   * THROUGH `mailbox`, WHICH IS `people.ts`'s — see the essay there.
   *
   * These three lines used to lowercase the raw header and compare it, which
   * made `from === mine` structurally impossible for any mail Gmail described as
   * `serg <cruciblecode1@gmail.com>`, and made the person key the display name
   * and the address glued together. Found by running this over his real mail;
   * both synthetic corpora write bare addresses and so could never have shown it.
   */
  const from = mailbox(str(d.from))
  const to = mailbox(str(d.to))
  const mine = mailbox(opts.me)
  const outbound = !!(mine && from === mine)

  const candidates: EntityCandidate[] = []
  const other = outbound ? to : from
  if (other && other !== mine) {
    candidates.push({
      kind: 'person',
      key: `email:${other}`,
      label: str(d.fromName) ?? other,
      via: outbound ? 'email-recipient' : 'email-sender',
      confidence: 0.85,
    })
  }

  return {
    id: obsId(e, 'message'),
    eventId: e.id,
    type: 'communication',
    occurredAt: e.sourceAt,
    entityCandidates: candidates,
    attributes: {
      subject: str(d.subject) ?? '',
      direction: outbound ? 'outbound' : 'inbound',
      counterparty: other ?? null,
      unread: d.unread === true,
      ...localMarks(e.sourceAt, opts.timeZone),
    },
    provenance: provenanceOf(e),
    confidence: 1,
    normalizeVersion: VERSIONS.normalize,
  }
}

/**
 * A step payload holds a WINDOW of days, not one number.
 *
 * Each day becomes its own observation, and that is what makes the baselines
 * possible: `activity.ts` already has to re-derive a per-day series out of
 * overlapping payloads on every read, with a documented merge rule about which
 * record wins. Splitting at normalisation time means the merge happens once,
 * here, and every later reader sees one observation per day per source.
 *
 * The day is the SOURCE'S day string, untouched. A steps payload dated
 * `2026-03-07` is about that calendar date wherever the runtime is standing, and
 * re-deriving it from an instant is how a day boundary gets lost.
 */
function activityMeasurements(e: MemoryEvent, p: Bag): NormalizedObservation[] {
  const d = dataOf(p)
  const days = Array.isArray(d.days) ? (d.days as Bag[]) : []
  const out: NormalizedObservation[] = []
  days.forEach((entry, i) => {
    const date = str(entry.date)
    const steps = num(entry.steps)
    if (!date || steps === undefined) return
    out.push({
      id: idOf(e.id.replace(/^evt:/, 'obs:'), 'steps', date),
      eventId: e.id,
      type: 'activity_measurement',
      // Midday rather than midnight: the sort key must land unambiguously inside
      // the day it describes under any zone offset the reader might apply.
      occurredAt: `${date}T12:00:00.000Z`,
      attributes: { metric: 'steps', value: steps, day: date, index: i },
      provenance: provenanceOf(e),
      confidence: 1,
      normalizeVersion: VERSIONS.normalize,
    })
  })
  return out
}

/** Somewhere he was, for how long. See `ingest.ts` for why duration is the point. */
function locationVisit(e: MemoryEvent, p: Bag, opts: NormalizeOptions): NormalizedObservation {
  const start = str(p.start) ?? e.sourceAt
  const end = str(p.end)
  const label = str(p.label)
  const lat = num(p.lat)
  const lon = num(p.lon)
  const key = str(p.placeKey)

  const candidates: EntityCandidate[] = [
    {
      kind: 'place',
      /**
       * A coordinate IS a structured identity, so a visit with one resolves by
       * position rather than by name — which is what lets an unlabelled stop at
       * the same doorway join the place it has been to before.
       */
      key: key ? `place:${key}` : lat !== undefined && lon !== undefined ? `geo:${lat.toFixed(4)},${lon.toFixed(4)}` : null,
      label: label ?? (lat !== undefined ? `${lat.toFixed(4)},${lon?.toFixed(4)}` : 'somewhere'),
      via: 'visit',
      confidence: key || lat !== undefined ? 0.95 : 0.4,
    },
  ]

  return {
    id: obsId(e, 'visit'),
    eventId: e.id,
    type: 'location_visit',
    interval: { start, end },
    entityCandidates: candidates,
    attributes: {
      label: label ?? null,
      lat: lat ?? null,
      lon: lon ?? null,
      /** Only when the SOURCE said so. Nothing here decides what a place is for. */
      category: str(p.category) ?? null,
      durationMinutes: end ? minutesBetween(start, end) : null,
      /**
       * Stamped here for the same reason a meeting's is: the routine learner
       * reads `minuteOfDay` off the episode, and a visit that arrived without one
       * produced a routine with no typical start time — a Saturday rhythm the
       * app could describe as happening and could not describe as happening at
       * any particular hour, which is most of what makes it useful.
       */
      ...localMarks(start, opts.timeZone),
    },
    provenance: provenanceOf(e),
    confidence: 1,
    normalizeVersion: VERSIONS.normalize,
  }
}

/**
 * Something he said.
 *
 * The split between a statement and a preference comes from the INGESTION CALL,
 * not from reading the words — deciding "I prefer the train" is a preference and
 * "I'm taking the train" is not, from text, is exactly the judgement that needs a
 * model and therefore exactly the judgement this layer refuses to make. The
 * caller knows which button he pressed.
 */
function statement(e: MemoryEvent, p: Bag): NormalizedObservation {
  const kind = str(p.kind) === 'preference' ? 'preference_statement' : 'user_statement'
  return {
    id: obsId(e, 'said'),
    eventId: e.id,
    type: kind as ObservationType,
    occurredAt: e.sourceAt,
    attributes: { text: str(p.text) ?? '' },
    provenance: provenanceOf(e),
    // He is the authority on what he said; the extraction is a copy.
    confidence: 1,
    normalizeVersion: VERSIONS.normalize,
  }
}

/**
 * Everything else, kept rather than dropped.
 *
 * A YouTube video, a place with no duration, a recommendation we showed, a
 * text-only observation written before `data` existed. None of these is read by
 * the cognition in this milestone, and all of them are real history — so they
 * become `other` with their payload intact, which costs a row and keeps the
 * ledger complete for whatever reads it next.
 */
function other(e: MemoryEvent, p: Bag): NormalizedObservation {
  return {
    id: obsId(e, 'other'),
    eventId: e.id,
    type: 'other',
    occurredAt: e.sourceAt,
    attributes: { type: e.type, text: str(p.text) ?? null, data: dataOf(p) },
    provenance: provenanceOf(e),
    confidence: 1,
    normalizeVersion: VERSIONS.normalize,
  }
}

// ── Shared derivations ───────────────────────────────────────────────────────

/**
 * The local weekday and minute-of-day, stamped once at normalisation.
 *
 * WHY HERE AND NOT IN THE TEMPORAL MODELS. Every routine and every baseline in
 * this directory groups by weekday and compares start times, and each one doing
 * its own `partsIn` would be one more place for his zone to be forgotten and the
 * runtime's to be used — which on the edge means UTC and means his Tuesday
 * evening lands on Wednesday. Computed once, from `clock.ts`, and carried.
 *
 * The cost is that the stamp is only as right as the zone known at normalisation
 * time. That is a real limitation and it is why `normalizeVersion` exists: if his
 * zone is learned later, re-normalising is a supported operation rather than a
 * migration.
 */
function localMarks(at: string, timeZone?: string): { weekday: number; minuteOfDay: number; day: string } | Record<string, never> {
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return {}
  const parts = partsIn(t, timeZone)
  return {
    weekday: parts.weekday,
    minuteOfDay: parts.hour * 60 + parts.minute,
    day: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
  }
}

/** Whole minutes, floored. Null-safe callers only — this assumes two valid instants. */
function minutesBetween(from: string, to: string): number | null {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.max(0, Math.round((b - a) / 60_000))
}

/**
 * BARE NAMES IN A TITLE, and the narrow rule that keeps this from being a regex
 * that invents people.
 *
 * A capitalised word is lifted only when the title is SHORT and the word is not
 * a calendar noun. "Lunch Bernardo" yields Bernardo; "Q3 Planning Review with
 * the Milan Office" yields nothing, because it is long and every capital in it
 * is a common noun. The output is a candidate at confidence 0.35 with no key,
 * which `entities.ts` will not merge into an existing person and will not
 * promote to an entity without repeated independent sightings.
 *
 * This is the one place in normalisation that guesses, it is bounded, and the
 * worst case is a candidate that never resolves into anything.
 */
const CALENDAR_NOUNS = new Set([
  'lunch', 'dinner', 'breakfast', 'coffee', 'meeting', 'call', 'review', 'standup', 'sync', 'catch',
  'appointment', 'birthday', 'holiday', 'flight', 'train', 'dentist', 'doctor', 'gym', 'class',
  'shopping', 'groceries', 'grocery', 'market', 'work', 'office', 'home', 'planning', 'weekly',
  'monthly', 'daily', 'am', 'pm', 'the', 'and', 'with', 'at', 'in', 'to', 'for',
])

function mentionedNames(summary: string): string[] {
  const words = summary.split(/[\s,–—-]+/).filter(Boolean)
  // Long titles are agendas, not "verb Person". Four words is the outside of
  // what "Lunch with Bernardo Rossi" needs.
  if (!words.length || words.length > 4) return []
  const out: string[] = []
  for (const w of words) {
    const clean = w.replace(/[^\p{L}'-]/gu, '')
    if (clean.length < 3) continue
    if (CALENDAR_NOUNS.has(clean.toLowerCase())) continue
    // Capitalised in a language that has case. Anything else is not a name we
    // can spot without understanding the sentence, and we do not.
    if (clean[0] !== clean[0]!.toUpperCase() || clean[0] === clean[0]!.toLowerCase()) continue
    out.push(clean)
  }
  return out
}
