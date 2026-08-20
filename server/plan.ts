/**
 * GETTING THERE: one normalised travel plan, computed once, read by three
 * surfaces.
 *
 * This is the first place the personal model has to earn its keep, and it was
 * chosen because it is the case the old architecture could not do AT ALL — not
 * "did badly", could not express.
 *
 * The concrete situation, live in his world model on 2026-08-11: an event
 * "Dinner, Anna and Paolo" at "Osteria del Sole" on the 12th at 18:00. He
 * lives in Castiglione dei Pepoli, a mountain village. He was asked "Do you
 * drive?" and answered "No" — twice. He has told the app he walks to the market
 * and takes the bus into town, about twenty minutes each way.
 *
 * Every fact needed to say "leave at about half past four" is present. Nothing
 * could combine them, because Calendar knew the event, Maps knew coordinates,
 * and the answer about driving was a sentence in a list. Three surfaces, three
 * partial views, no plan.
 *
 * So the plan is computed HERE, once, and Calendar, Maps and Home render the
 * same object. That is the actual requirement — not "Calendar should mention
 * travel" but "there is one answer and three windows onto it". If the number on
 * Home and the number in Calendar can ever differ, this file has failed.
 *
 * WHAT IT REFUSES TO DO. It does not invent an origin, a mode or a duration. A
 * plan with an unresolved destination is a plan that SAYS the destination is
 * unresolved and offers to ask; it is never a plan with a plausible coordinate
 * quietly substituted. Each gap is named in `uncertainty` and each one has a
 * question attached that would close it.
 */

import { routeBetween, searchPlaces, type FoundPlace } from './maps.js'
import type { Because, Ground } from './attention.js'
import {
  demand,
  fact,
  getFact,
  setFact,
  type Person_,
} from './person.js'
import type { Observation, World } from './world.js'

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Mode = 'walk' | 'cycle' | 'drive' | 'transit'

export interface Origin {
  label: string
  lat: number
  lon: number
  /** How we know where he is starting from. Governs what may be claimed. */
  kind: 'live' | 'stated-home' | 'unknown'
  /** When the position was true. */
  at?: string
  accuracyM?: number
  /** Minutes since `at`. Computed at plan time so the UI need not. */
  ageMin?: number
}

export interface Destination {
  /** The raw string off the calendar event. Kept verbatim. */
  query: string
  state: 'resolved' | 'ambiguous' | 'unresolved'
  label?: string
  lat?: number
  lon?: number
  /** Present when `ambiguous`: the choices, for him to pick from. */
  candidates?: { label: string; sub?: string; lat: number; lon: number }[]
}

export interface TravelPlan {
  /** Stable, derived from the event, so novelty tracking works across passes. */
  id: string
  eventId: string
  event: { summary: string; start: string; location: string }
  /**
   * Who else is going, straight off the event's own `attendees[]`.
   *
   * Carried on the plan rather than looked up again downstream, because a second
   * reader of the same event would be a second chance to disagree about who is on
   * it — the mistake `panes.ts` documents at length about Home and Calendar. It is
   * raw contact data ONLY: names and addresses a connector asserted, with no claim
   * whatsoever about who these people are to him. See `people.ts` for why that
   * line is drawn so hard.
   */
  attendees?: { email: string; name?: string; response?: string }[]
  origin: Origin
  destination: Destination
  mode: {
    value: Mode
    /** 'user' when he set it, 'constraint' when driving is ruled out, etc. */
    by: 'user' | 'constraint' | 'routine' | 'default'
    why: string
  }
  distanceM?: number
  durationSec?: number
  /** ISO instant. Absent whenever anything upstream is unresolved. */
  leaveBy?: string
  /** How much of this is solid, 0..1. Never rounded up to look confident. */
  confidence: number
  /** Everything we do not know, in his words. Empty means genuinely complete. */
  uncertainty: string[]
  /**
   * WHY THERE IS NO LEAVE-BY TIME, as a value rather than as a sentence.
   *
   * `uncertainty` is prose for him to read, and the first version of the
   * people-aware journey card decided whether a plan was stuck by running
   * `/too far/i` over it. That is the same mistake as recovering an event's time from
   * its title, one level up: a downstream reader parsing a sentence THIS APP wrote,
   * so improving the wording silently breaks the behaviour and nothing fails.
   *
   * Absent means the journey is not blocked — either it produced a leave-by time or
   * nothing tried.
   */
  blocked?:
    /** Routable and real, but nobody would make this journey that way. */
    | 'too-far'
    /** A bus we cannot time, because no timetable is connected. */
    | 'no-timetable'
    /** The location string matches several real places, or none. */
    | 'destination'
    /** No starting point is known. */
    | 'origin'
    /** The router was unreachable. */
    | 'routing'
  /** What would close each gap: a slot key the question engine can ask. */
  wants: string[]
  because: Because
  /** Human summary of the travel leg, or null when it could not be computed. */
  summary: string | null
}

// ── Origin ───────────────────────────────────────────────────────────────────

/**
 * A live fix stops being live.
 *
 * Thirty minutes is the line, and it is a JUDGEMENT rather than a measurement:
 * long enough that sitting still with the app closed does not invalidate a
 * position, short enough that a bus ride does. What matters more than the exact
 * number is that a fix older than it is not silently used as though it were
 * current — the age travels with the plan and is shown.
 */
export const LIVE_FIX_MAX_MIN = 30

/**
 * WHERE HE IS, AS A FACT, WITH NO SIDE EFFECTS AND NO OPINION ABOUT AGE.
 *
 * Split out of `originFor` so a second reader can have the precedence without
 * also having the `demand()` write. The Places map needs to know which ground
 * to draw and runs on the synchronous instant-paint path, where a pane builder
 * that quietly mutates the personal model is exactly the wrong thing.
 *
 * It also reports a STALE fix rather than discarding it, because the two
 * readers want different things from the same fact. A departure time computed
 * from an hour-old position is a wrong answer stated confidently, so
 * `originFor` still refuses it. A map centred on where he was an hour ago is
 * simply a map of the right valley, and refusing to draw it — which is what
 * happened — leaves the one geographic domain in the app blank while the
 * device is holding a verified coordinate.
 */
export function positionOf(
  p: Person_,
  now = new Date()
): { lat: number; lon: number; label: string; kind: 'live' | 'stale' | 'stated-home'; at?: string; accuracyM?: number; ageMin?: number } | null {
  const live = getFact<{ lat: number; lon: number; accuracy?: number; label?: string }>(p, 'location.last')
  if (live && typeof live.value?.lat === 'number' && Number.isFinite(live.value.lat) && Number.isFinite(live.value.lon)) {
    const ageMin = Math.round((now.getTime() - Date.parse(live.sourceAt)) / 60_000)
    const fresh = Number.isFinite(ageMin) && ageMin <= LIVE_FIX_MAX_MIN
    return {
      lat: live.value.lat,
      lon: live.value.lon,
      label: live.value.label ?? (fresh ? 'where you are' : 'where you last were'),
      kind: fresh ? 'live' : 'stale',
      at: live.sourceAt,
      accuracyM: live.value.accuracy,
      ageMin: Number.isFinite(ageMin) ? ageMin : undefined,
    }
  }

  const home = getFact<{ lat: number; lon: number; label?: string }>(p, 'identity.home.coords')
  if (home && typeof home.value?.lat === 'number') {
    return { lat: home.value.lat, lon: home.value.lon, label: home.value.label ?? 'home', kind: 'stated-home', at: home.sourceAt }
  }
  return null
}

export function originFor(p: Person_, now = new Date()): Origin {
  const at = positionOf(p, now)
  // A stale fix is deliberately NOT an origin. See `positionOf`: the map may
  // draw it, a leave-by time may not be computed from it.
  if (at && at.kind !== 'stale') {
    return {
      label: at.label,
      lat: at.lat,
      lon: at.lon,
      kind: at.kind === 'live' ? 'live' : 'stated-home',
      at: at.at,
      accuracyM: at.accuracyM,
      ageMin: at.ageMin,
    }
  }

  // Not a coordinate, and deliberately not defaulted to one. A plan built from
  // a guessed origin is worse than no plan: it produces a confident leave-by
  // time computed from somewhere he is not.
  demand(p, 'identity.home', 'working out how long it takes you to get to your events')
  return { label: 'unknown', lat: 0, lon: 0, kind: 'unknown' }
}

// ── Mode ─────────────────────────────────────────────────────────────────────

/**
 * How he would travel, and on whose authority.
 *
 * The order is the argument. A CONSTRAINT beats a preference — if he cannot
 * drive, "drive" is not an option however convenient it would be — and his
 * stated preference beats anything we noticed. Only when all three are silent
 * does this fall through to walking, and in that case it says so and asks.
 */
export function modeFor(p: Person_, forWhat: string): TravelPlan['mode'] {
  const stated = getFact<string>(p, 'transport.default')
  const drives = getFact<boolean>(p, 'identity.drives')
  const cannotDrive = drives?.value === false

  if (stated && stated.value !== 'ask') {
    const value = stated.value as Mode
    if (value === 'drive' && cannotDrive) {
      // Two of his own answers contradict each other. Believe the more
      // specific and more recent, and say which — never silently pick one.
      return {
        value: 'transit',
        by: 'constraint',
        why: 'you told me you do not drive, which rules out the driving preference on file',
      }
    }
    return { value, by: 'user', why: 'you told me this is how you usually get around' }
  }

  if (cannotDrive) {
    /**
     * No car narrows it to two, and the two are very different journeys. This
     * is exactly the point at which guessing is worse than asking: over 2 km,
     * walking and a bus differ by half an hour, and a wrong guess produces a
     * leave-by time that makes him late.
     */
    demand(p, 'transport.default', `planning how you get to ${forWhat}`)
    return {
      value: 'walk',
      by: 'constraint',
      why: 'you do not drive; I have assumed walking until you tell me otherwise',
    }
  }

  demand(p, 'transport.default', `planning how you get to ${forWhat}`)
  return { value: 'walk', by: 'default', why: 'I do not know yet how you get around' }
}

// ── Destination ──────────────────────────────────────────────────────────────

/**
 * Turn an event's location string into a point, or say honestly that it is not
 * one.
 *
 * Geocoded answers are CACHED INTO THE PERSON, not just into the process. The
 * Mac keeps a module-level cache in `maps.ts`, which is worth having and does
 * nothing at all on Cloudflare, where every request is a fresh isolate. Without
 * persistence, building the feed on the edge would geocode the same five events
 * on every single build against a volunteer-run service that asks for one
 * request a second — which is both rude and slow enough to matter.
 *
 * An AMBIGUOUS result is a first-class outcome. Nominatim returning five places
 * called "Osteria del Sole" is information, and picking the first is how the
 * app confidently routes him to another province.
 */
export async function resolveDestination(
  p: Person_,
  query: string,
  near?: { lat: number; lon: number }
): Promise<Destination> {
  const raw = query.trim()
  if (!raw) return { query, state: 'unresolved' }

  const key = `place.${slug(raw)}`
  const held = getFact<{ lat: number; lon: number; label: string }>(p, key)
  if (held && typeof held.value?.lat === 'number') {
    return { query: raw, state: 'resolved', label: held.value.label, lat: held.value.lat, lon: held.value.lon }
  }

  let found: FoundPlace[] = []
  try {
    found = await searchPlaces(raw, near)
  } catch {
    // A geocoder that is down is not a place that does not exist. Saying
    // "unresolved" here is honest; inventing a coordinate would not be.
    return { query: raw, state: 'unresolved' }
  }

  if (!found.length) return { query: raw, state: 'unresolved' }

  /**
   * When is one answer good enough?
   *
   * If the geocoder returned several and they are far apart, they are genuinely
   * different places and he has to choose. Several results clustered within a
   * few hundred metres are the same place described twice, and asking about
   * that is noise.
   */
  const best = found[0]!
  const spread = found.slice(1).some((f) => haversineM(best, f) > 600)
  if (found.length > 1 && spread) {
    return {
      query: raw,
      state: 'ambiguous',
      candidates: found.slice(0, 4).map((f) => ({ label: f.label, sub: f.sub, lat: f.lat, lon: f.lon })),
    }
  }

  setFact(
    p,
    'preferences',
    fact(
      key,
      { lat: best.lat, lon: best.lon, label: best.label },
      {
        source: 'nominatim',
        status: 'verified',
        confidence: 0.85,
        by: 'connector',
        note: `Geocoded from the calendar entry "${raw}".`,
      }
    )
  )

  return { query: raw, state: 'resolved', label: best.label, lat: best.lat, lon: best.lon }
}

// ── The plan ─────────────────────────────────────────────────────────────────

/**
 * Build travel plans for upcoming events that have somewhere to be.
 *
 * `limit` is a real cap on outbound geocoding per build, and what it excludes
 * is reported by the caller rather than silently dropped. Events with no
 * location are skipped entirely — there is nothing to plan and a card saying
 * "your standup has no address" is noise, not insight.
 */
export async function planTravel(
  w: Pick<World, 'observations'>,
  p: Person_,
  opts: { now?: Date; withinHours?: number; limit?: number } = {}
): Promise<{ plans: TravelPlan[]; skipped: { eventId: string; why: string }[] }> {
  const now = opts.now ?? new Date()
  const withinHours = opts.withinHours ?? 48
  const limit = opts.limit ?? 3

  /**
   * Put a point on the place he says he lives, once, before anything needs it.
   *
   * `identity.home` is a NAME lifted from a sentence ("Lives in Castiglione dei
   * Pepoli"); `identity.home.coords` is a point. Resolving the first into the
   * second here rather than inside `originFor` keeps that function synchronous
   * and pure, which everything else in this file depends on — and it means the
   * geocode happens once per build instead of once per event.
   */
  await ensureHomeCoords(p)

  const origin = originFor(p, now)
  const near = origin.kind === 'unknown' ? undefined : { lat: origin.lat, lon: origin.lon }

  const upcoming = w.observations
    .flatMap((o) => (o.data?.kind === 'event' ? [{ o, e: o.data }] : []))
    .filter(({ e }) => {
      const t = Date.parse(e.start)
      if (!Number.isFinite(t)) return false
      const hours = (t - now.getTime()) / 3_600_000
      return hours > -1 && hours <= withinHours
    })
    .sort((a, b) => a.e.start.localeCompare(b.e.start))

  const plans: TravelPlan[] = []
  const skipped: { eventId: string; why: string }[] = []

  for (const { o, e } of upcoming) {
    if (e.kind !== 'event') continue
    if (!e.location?.trim()) {
      skipped.push({ eventId: e.eventId, why: 'no location on the event' })
      continue
    }
    if (plans.length >= limit) {
      skipped.push({ eventId: e.eventId, why: `beyond the ${limit}-event planning limit for this build` })
      continue
    }
    plans.push(await planOne(o, e, p, origin, near, now))
  }

  return { plans, skipped }
}

/**
 * Turn the name of the place he lives into a coordinate, if we can.
 *
 * Deliberately silent on failure. A village that will not geocode is a gap the
 * plan already knows how to describe ("I do not know where you are starting
 * from"); it is not an error worth surfacing on its own, and it must not stop
 * the destinations being resolved.
 */
async function ensureHomeCoords(p: Person_): Promise<void> {
  if (getFact(p, 'identity.home.coords')) return
  const name = getFact<string>(p, 'identity.home')
  if (!name || typeof name.value !== 'string' || !name.value.trim()) return

  const found = await resolveDestination(p, name.value)
  if (found.state !== 'resolved' || found.lat === undefined) return

  setFact(
    p,
    'identity',
    fact(
      'identity.home.coords',
      { lat: found.lat, lon: found.lon, label: found.label ?? name.value },
      {
        source: 'nominatim',
        status: 'inferred',
        confidence: 0.75,
        // `agent`, so a place he types himself later overrides this permanently.
        by: 'agent',
        sourceAt: name.sourceAt,
        basis: name.basis,
        note: `Geocoded from "${name.value}", which he told me is where he lives.`,
      }
    )
  )
}

async function planOne(
  o: Observation,
  e: Extract<NonNullable<Observation['data']>, { kind: 'event' }>,
  p: Person_,
  origin: Origin,
  near: { lat: number; lon: number } | undefined,
  now: Date
): Promise<TravelPlan> {
  const destination = await resolveDestination(p, e.location!, near)
  const mode = modeFor(p, e.summary)

  const uncertainty: string[] = []
  const wants: string[] = []
  /**
   * Set alongside each `uncertainty` sentence, never derived from one. Declared up
   * here with the sentences it accompanies, so the two cannot drift apart. See the
   * `blocked` contract for why a downstream reader must not parse our prose.
   */
  let blocked: TravelPlan['blocked']
  const grounds: Ground[] = [
    { kind: 'observation', id: o.id, says: `${e.summary} at ${e.location} on ${e.start}` },
  ]

  if (origin.kind === 'unknown') {
    uncertainty.push('I do not know where you are starting from.')
    wants.push('identity.home')
    blocked = 'origin'
  } else if (origin.kind === 'stated-home') {
    uncertainty.push('Timed from home — your phone has not reported a position recently.')
  } else if ((origin.ageMin ?? 0) > 5) {
    uncertainty.push(`Timed from your position ${origin.ageMin} minutes ago.`)
  }
  grounds.push({
    kind: origin.kind === 'unknown' ? 'inference' : 'fact',
    id: origin.kind === 'live' ? 'location.last' : 'identity.home.coords',
    says:
      origin.kind === 'unknown'
        ? 'no starting point is known'
        : `starting from ${origin.label}${origin.kind === 'live' ? ` (${origin.ageMin} min old)` : ' (home)'}`,
  })

  if (destination.state === 'ambiguous') {
    uncertainty.push(`"${e.location}" matches more than one place. Which one is it?`)
    blocked = 'destination'
  } else if (destination.state === 'unresolved') {
    uncertainty.push(`I could not find "${e.location}" on the map.`)
    blocked = 'destination'
  }

  grounds.push({
    kind: mode.by === 'user' ? 'preference' : mode.by === 'constraint' ? 'fact' : 'inference',
    id: mode.by === 'constraint' ? 'identity.drives' : 'transport.default',
    says: `${mode.value} — ${mode.why}`,
  })
  if (mode.by !== 'user') wants.push('transport.default')

  let distanceM: number | undefined
  let durationSec: number | undefined
  let leaveBy: string | undefined
  let summary: string | null = null

  const canRoute = origin.kind !== 'unknown' && destination.state === 'resolved'
  if (canRoute) {
    try {
      /**
       * Transit is not routable here and must not be faked.
       *
       * OSRM has no public transit profile, and the demo server runs the car
       * profile for every profile string it is given (measured, and documented
       * in maps.ts). So a bus journey gets the ROAD DISTANCE — which is real —
       * and no duration, plus the twenty-minute figure he himself gave for the
       * trip into town if that is where he is going. Printing "23 min by bus"
       * from a car router would be exactly the fabricated number this codebase
       * has a standing rule against.
       */
      const routable: Mode = mode.value === 'transit' ? 'drive' : mode.value
      const r = await routeBetween(
        { lat: origin.lat, lon: origin.lon },
        { lat: destination.lat!, lon: destination.lon! },
        routable
      )
      distanceM = r.distanceM
      if (mode.value === 'transit') {
        uncertainty.push('I cannot time a bus journey — no timetable is connected.')
        wants.push('transit.timetable')
        blocked = 'no-timetable'
        summary = `${(r.distanceM / 1000).toFixed(1)} km away`
      } else if (!practical(mode.value, r.distanceM, r.durationS)) {
        /**
         * A ROUTE THAT EXISTS IS NOT A JOURNEY HE WILL MAKE.
         *
         * Caught in testing against his own data: the dinner is 57 km away, he
         * does not drive, so the planner assumed walking, computed 11h 42m from
         * the distance, and confidently produced "leave about 08:07 and walk".
         * Every step of that is arithmetically correct and the answer is
         * useless — worse than useless, because it is stated with the same
         * confidence as a ten-minute stroll.
         *
         * The distance is still real and still worth showing. What is withheld
         * is the LEAVE-BY, because a departure time is a recommendation and
         * this is not one. The gap becomes a question about how he would
         * actually get there, which is the honest thing to ask a man with no
         * car about a restaurant in another province.
         */
        distanceM = r.distanceM
        summary = `${(r.distanceM / 1000).toFixed(1)} km away`
        uncertainty.push(
          `That is ${(r.distanceM / 1000).toFixed(0)} km — too far to ${modeVerb(mode.value)}. How would you get there?`
        )
        blocked = 'too-far'
        wants.push('transport.default')
        demand(p, 'transport.default', `getting to ${e.summary}, which is ${(r.distanceM / 1000).toFixed(0)} km away`)
        grounds.push({
          kind: 'computation',
          id: 'osrm-route',
          says: `${(r.distanceM / 1000).toFixed(1)} km by road, which is not a walk`,
        })
      } else {
        durationSec = r.durationS
        summary = r.summary
        const startMs = Date.parse(e.start)
        if (Number.isFinite(startMs) && durationSec !== undefined) {
          // A margin, stated rather than hidden inside the arithmetic. Ten
          // minutes is a guess about him and is therefore in `uncertainty`.
          const marginSec = 10 * 60
          leaveBy = new Date(startMs - (durationSec + marginSec) * 1000).toISOString()
          uncertainty.push('Leave-by includes a 10 minute margin.')
        }
      }
      grounds.push({
        kind: 'computation',
        id: 'osrm-route',
        says: summary ?? `${Math.round((distanceM ?? 0) / 100) / 10} km by road`,
      })
    } catch {
      uncertainty.push('Routing was unavailable when I worked this out.')
      blocked = 'routing'
    }
  }

  /**
   * Confidence is a PRODUCT of what is known, not an average.
   *
   * An average lets three solid components hide one missing origin and still
   * report 0.75. Multiplying means any single unknown factor drags the whole
   * plan down, which is the correct behaviour: a perfectly routed journey from
   * a place he is not is not 75% right, it is wrong.
   */
  const originC = origin.kind === 'live' ? 1 : origin.kind === 'stated-home' ? 0.7 : 0.15
  const destC = destination.state === 'resolved' ? 0.95 : destination.state === 'ambiguous' ? 0.4 : 0.2
  const modeC = mode.by === 'user' ? 1 : mode.by === 'constraint' ? 0.7 : 0.45
  const legC = durationSec !== undefined ? 1 : distanceM !== undefined ? 0.6 : 0.3
  const confidence = Math.round(originC * destC * modeC * legC * 100) / 100

  const because: Because = {
    sentence: sentenceFor(e, origin, destination, mode, summary, leaveBy),
    grounds,
  }

  return {
    id: `plan:${e.eventId}`,
    eventId: e.eventId,
    event: { summary: e.summary, start: e.start, location: e.location! },
    attendees: e.attendees,
    origin,
    destination,
    mode,
    distanceM,
    durationSec,
    leaveBy,
    confidence,
    uncertainty,
    blocked,
    wants: [...new Set(wants)],
    because,
    summary,
  }
}

function sentenceFor(
  e: { summary: string; start: string },
  origin: Origin,
  d: Destination,
  mode: TravelPlan['mode'],
  summary: string | null,
  leaveBy?: string
): string {
  if (d.state !== 'resolved') {
    return `"${e.summary}" has a location I could not pin down, so I cannot tell you how long it takes to get there.`
  }
  if (origin.kind === 'unknown') {
    return `I know where "${e.summary}" is, but not where you would be leaving from.`
  }
  const from = origin.kind === 'live' ? 'where you are now' : 'home'
  const how = mode.by === 'user' ? `you ${modeVerb(mode.value)}` : `I have assumed you ${modeVerb(mode.value)}`
  if (!summary) return `${e.summary} is at ${d.label}, and ${how}.`
  if (!leaveBy) return `${d.label} is ${summary} from ${from}, and ${how}.`
  return `${d.label} is ${summary} from ${from}; ${how}, so leaving around then gets you there on time.`
}

const modeVerb = (m: Mode) =>
  m === 'walk' ? 'walk' : m === 'cycle' ? 'cycle' : m === 'drive' ? 'drive' : 'take the bus'

/**
 * Would a person actually make this journey this way?
 *
 * Stated as distance AND time, because either alone lets something silly
 * through: two kilometres straight up a mountain is a long walk at a short
 * distance, and a flat ten kilometres is a short ride at a long one. Driving is
 * exempt — a two-hour drive is an ordinary thing to be told about.
 *
 * These are judgements about ordinary human behaviour, not measurements, and
 * they are deliberately generous: the cost of withholding a leave-by time he
 * would have wanted is one extra question, and the cost of emitting one he
 * cannot use is that he stops believing the times.
 */
function practical(mode: Mode, distanceM: number, durationS: number): boolean {
  if (mode === 'drive') return true
  if (mode === 'cycle') return distanceM <= 40_000 && durationS <= 3 * 3600
  // Walking. About an hour and a half, or seven kilometres, whichever comes
  // first — beyond that it is a hike he is choosing to do, not a commute.
  return distanceM <= 7_000 && durationS <= 90 * 60
}

// ── small helpers ────────────────────────────────────────────────────────────

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

/** Metres between two points. Enough precision to tell places apart. */
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const la = (a.lat * Math.PI) / 180
  const lb = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
