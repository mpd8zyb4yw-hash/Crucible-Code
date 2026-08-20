/**
 * FOUR ROWS FROM FOUR SOURCES, ONE THING THAT HAPPENED.
 *
 * The calendar knows there was an event on Tuesday. The location stream knows he
 * was somewhere near Dervio for four hours. The mail knows Bernardo confirmed on
 * Monday. Nobody involved knows there was a TRIP, and the trip is what a person
 * would name if you asked them about their week.
 *
 * That is the whole job. It is worth being precise about why it matters, because
 * "group related records" sounds like tidying:
 *
 *   · A ROUTINE IS A RHYTHM OF EPISODES, NOT OF ROWS. Counting calendar rows
 *     would count a recurring invitation once per instance and a location-only
 *     errand not at all, so the thing he actually does every Saturday — which
 *     appears in no calendar — would be invisible to routine learning forever.
 *   · A PREDICTION NEEDS SOMETHING TO BE RIGHT OR WRONG ABOUT. "A grocery episode
 *     will occur on Saturday" is falsifiable. "There will be a location sample"
 *     is not.
 *   · AN EVIDENCE CHAIN NEEDS A MIDDLE. Without episodes, every conclusion cites
 *     raw observations directly and the explanation is a list of coordinates.
 *
 * THE RULE THAT KEEPS THIS HONEST: TWO THINGS JOIN ONLY IF THEY OVERLAP IN TIME
 * AND SHARE AN ENTITY. Overlap alone would fuse everything that happens on a busy
 * Thursday into one blob — his day is continuous, so time overlap is nearly
 * always available and is nearly never evidence. A shared entity is what makes
 * the join mean something: the same person, or the same place.
 *
 * WHAT ASSEMBLY IS ALLOWED TO LEAVE ALONE. Most observations. A message from a
 * shop, a step count, a video — none of them belongs to an episode and forcing
 * them into one to make the timeline look complete is the failure this type's
 * `confidence` and `uncertain` status exist to avoid. An episode that cannot be
 * corroborated stays low-confidence rather than being deleted or asserted.
 *
 * PER-DAY, CLEAR-THEN-WRITE. See `EpisodeRepository.removeBetween` for why an
 * upsert alone is not enough: episode ids are a function of their contents, so
 * reassembly has to replace a window rather than add to it. The upside is that
 * assembling a day twice, or assembling it in a rebuild months later, produces
 * exactly the same rows — which is what the replay test asserts.
 */

import { addDays } from '../clock.js'
import { canonical, hash, idOf, slug } from './ids.js'
import { resolvedEntityIds } from './entities.js'
import {
  VERSIONS,
  type Episode,
  type MemoryStore,
  type NormalizedObservation,
} from './types.js'

/**
 * A visit shorter than this is passing through, not being somewhere.
 *
 * Ten minutes. Below it are traffic lights, a wrong turn, and the coordinate
 * noise of walking past a shop's door — all of which would become "errands" and
 * would then teach the routine learner that he visits the pharmacy every day.
 * The number is a threshold on what counts as an episode at all, not on what is
 * interesting: a genuine two-minute stop is still in the ledger, and a later
 * assembly version with better rules can find it.
 */
const MIN_VISIT_MINUTES = 10

/** What one assembly pass did. */
export interface AssemblyRun {
  written: number
  replaced: number
  /** Observations deliberately not put in any episode, with the reason. */
  loose: { id: string; why: string }[]
}

/**
 * Assemble every day touched by `observations`.
 *
 * Days rather than a rolling window because a day is the unit his life is
 * described in and because it makes the operation restartable: a crash halfway
 * through leaves whole days assembled and whole days not, rather than an episode
 * missing its afternoon.
 */
export function assembleEpisodes(
  store: MemoryStore,
  observations: NormalizedObservation[],
  now: string,
  opts: { timeZone?: string } = {}
): AssemblyRun {
  const run: AssemblyRun = { written: 0, replaced: 0, loose: [] }
  const days = new Set<string>()
  for (const o of observations) {
    const at = o.occurredAt ?? o.interval?.start
    if (at) days.add(at.slice(0, 10))
  }

  for (const day of [...days].sort()) {
    const next = addDays(day, 1)
    /**
     * The window is read from the STORE, not from the batch.
     *
     * A batch is whatever arrived since the cursor, and the calendar row for
     * Tuesday's trip may well have arrived a week before the location visit that
     * corroborates it. Assembling from the batch alone would produce an episode
     * missing half of itself and never revisit it. Reading the day back means a
     * late-arriving observation reassembles the whole day around it.
     */
    const window = store.observations.between(`${day}T00:00:00.000Z`, `${next}T00:00:00.000Z`)
    run.replaced += store.episodes.removeBetween(`${day}T00:00:00.000Z`, `${next}T00:00:00.000Z`)
    const episodes = assembleDay(store, window, day, now, run, opts)
    if (episodes.length) store.episodes.put(episodes)
    run.written += episodes.length
  }

  return run
}

/** One seed: an observation with a duration and something to join on. */
interface Seed {
  o: NormalizedObservation
  start: string
  end: string | null
  participants: string[]
  places: string[]
  /** 'meeting' from the calendar, 'visit' from location. */
  origin: 'meeting' | 'visit'
}

function assembleDay(
  store: MemoryStore,
  window: NormalizedObservation[],
  day: string,
  now: string,
  run: AssemblyRun,
  opts: { timeZone?: string }
): Episode[] {
  const seeds: Seed[] = []

  for (const o of window) {
    if (o.type === 'planned_meeting') {
      seeds.push({
        o,
        start: o.interval?.start ?? o.provenance.observedAt,
        end: o.interval?.end ?? null,
        participants: resolvedEntityIds(store, o, 'person'),
        places: resolvedEntityIds(store, o, 'place'),
        origin: 'meeting',
      })
      continue
    }
    if (o.type === 'location_visit') {
      const minutes = o.attributes.durationMinutes
      if (typeof minutes === 'number' && minutes < MIN_VISIT_MINUTES) {
        run.loose.push({ id: o.id, why: `${minutes} minutes is passing through, not being somewhere` })
        continue
      }
      seeds.push({
        o,
        start: o.interval?.start ?? o.provenance.observedAt,
        end: o.interval?.end ?? null,
        participants: [],
        places: resolvedEntityIds(store, o, 'place'),
        origin: 'visit',
      })
    }
  }

  if (!seeds.length) return []
  seeds.sort((a, b) => a.start.localeCompare(b.start) || a.o.id.localeCompare(b.o.id))

  /**
   * THE MERGE. Union-find over seeds, joined when they overlap in time AND share
   * an entity.
   *
   * Union-find rather than a single pass, because joining is transitive and
   * order-independent: if the calendar event overlaps the drive and the drive
   * overlaps the visit, all three are one trip even though the event and the
   * visit may not overlap each other. A pairwise sweep would give a different
   * answer depending on which seed it started from, and a different answer on a
   * rebuild is exactly what §34 forbids.
   */
  const parent = seeds.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const union = (a: number, b: number): void => {
    const [x, y] = [find(a), find(b)]
    if (x !== y) parent[Math.max(x, y)] = Math.min(x, y)
  }

  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const a = seeds[i]!
      const b = seeds[j]!
      if (!overlaps(a, b)) continue
      const shared =
        a.participants.some((p) => b.participants.includes(p)) || a.places.some((p) => b.places.includes(p))
      /**
       * ONE EXCEPTION, and it is the one the "Dervio trip" needs: a calendar
       * event with NO location, wholly inside a visit somewhere, is that visit.
       * The event says a thing was arranged; the visit says where he actually
       * was. Requiring a shared place here would be requiring the calendar to
       * repeat what the phone already knows, which it never does.
       *
       * Bounded deliberately: `contains`, not "overlaps". An event that merely
       * brushes a long stay is not that stay.
       */
      const meetingInsideVisit =
        a.origin !== b.origin && !a.places.length !== !b.places.length && contains(a, b)
      if (!shared && !meetingInsideVisit) continue
      union(i, j)
    }
  }

  const groups = new Map<number, Seed[]>()
  for (let i = 0; i < seeds.length; i++) {
    const root = find(i)
    const list = groups.get(root) ?? []
    list.push(seeds[i]!)
    groups.set(root, list)
  }

  const out: Episode[] = []
  for (const group of groups.values()) {
    out.push(episodeFrom(store, group, window, day, now, opts))
  }
  return out.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id))
}

/**
 * Time overlap, treating a seed with no end as a POINT rather than as open-ended.
 *
 * An all-day calendar entry with no end would otherwise swallow the entire day
 * and every seed in it, producing one enormous episode whenever a birthday is in
 * the calendar. A point still overlaps anything containing it, which is the
 * behaviour actually wanted.
 */
function overlaps(a: Seed, b: Seed): boolean {
  const aEnd = a.end ?? a.start
  const bEnd = b.end ?? b.start
  return a.start <= bEnd && b.start <= aEnd
}

/** Is `a` wholly inside `b`, or `b` wholly inside `a`? */
function contains(a: Seed, b: Seed): boolean {
  const aEnd = a.end ?? a.start
  const bEnd = b.end ?? b.start
  return (a.start >= b.start && aEnd <= bEnd) || (b.start >= a.start && bEnd <= aEnd)
}

function episodeFrom(
  store: MemoryStore,
  group: Seed[],
  window: NormalizedObservation[],
  day: string,
  now: string,
  opts: { timeZone?: string }
): Episode {
  const startAt = group.map((s) => s.start).sort()[0]!
  const ends = group.map((s) => s.end).filter((e): e is string => !!e).sort()
  const endAt = ends.length ? ends[ends.length - 1]! : null
  const participants = canonical(group.flatMap((s) => s.participants))
  const places = canonical(group.flatMap((s) => s.places))

  /**
   * MESSAGES ARE ATTACHED, NEVER SEEDS.
   *
   * A message has no duration and joining on it would fuse two unrelated
   * meetings that happen to involve the same person. But a message from
   * somebody who is IN this episode, on the day of it, is genuinely part of the
   * story of it — the confirmation, the change of plan, the "running late". So
   * it comes in as evidence and cannot pull anything else in with it.
   */
  const correspondence = participants.length
    ? window.filter(
        (o) =>
          o.type === 'communication' &&
          resolvedEntityIds(store, o, 'person').some((id) => participants.includes(id))
      )
    : []

  const observationIds = canonical([...group.map((s) => s.o.id), ...correspondence.map((o) => o.id)])
  const type = typeOf(group, places, store)

  /**
   * THE ID IS A FUNCTION OF THE CONTENT, AND OF THE CONTENT THAT DEFINES IT.
   *
   * The hash covers the observation ids, so an episode that gains a member gets
   * a new id and the old row is removed by the clear-then-write above. The
   * readable prefix — type and day — is what makes an id legible in an evidence
   * chain; the hash is what makes it unique.
   */
  const id = idOf('epi', slug(type, 24), day, hash(observationIds.join('|')))

  const corroborated = group.some((s) => s.origin === 'visit') && group.some((s) => s.origin === 'meeting')
  const status = statusOf(group, startAt, endAt, now)

  return {
    id,
    type,
    startAt,
    endAt,
    participantEntityIds: participants,
    placeEntityIds: places,
    observationIds,
    summary: summaryOf(group, store, places),
    attributes: {
      /** How it was known, so an explanation can say "your calendar and your phone". */
      origins: canonical(group.map((s) => s.origin)),
      corroborated,
      correspondenceCount: correspondence.length,
      durationMinutes: endAt ? Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000) : null,
      /** Carried through from normalisation so nothing recomputes his weekday. */
      weekday: group[0]!.o.attributes.weekday ?? null,
      minuteOfDay: group[0]!.o.attributes.minuteOfDay ?? null,
      timeZone: opts.timeZone ?? null,
    },
    /**
     * TWO INDEPENDENT SOURCES AGREEING IS THE ONLY THING THAT EARNS NEAR-CERTAINTY.
     *
     * A calendar entry is a plan and plans are broken; a location visit is a
     * measurement and measurements have no idea what they were for. Together
     * they are an event that was arranged and attended, which is a different
     * epistemic object from either. A lone calendar row sits at 0.7 forever, and
     * every conclusion resting on it inherits that.
     */
    confidence: corroborated ? 0.95 : group[0]!.origin === 'visit' ? 0.85 : 0.7,
    status,
    firstAssembledAt: now,
    updatedAt: now,
    assemblyVersion: VERSIONS.assemble,
  }
}

/**
 * WHAT KIND OF THING THIS WAS — from structure, never from reading the title.
 *
 * The temptation is to look for "lunch" or "shop" in the summary and type the
 * episode from it. That is a keyword list masquerading as understanding, it is
 * language-specific in an app used in Italian, and it would hard-code exactly
 * the conclusions §32 says the fixture must not contain.
 *
 * So the type comes from what the episode IS: people present, place present,
 * how it was seen. A recurring Saturday shop is discovered as "visits to this
 * place", and what makes it recognisable as shopping is the place's own label —
 * which came from a source, not from us.
 */
function typeOf(group: Seed[], places: string[], store: MemoryStore): string {
  const hasPeople = group.some((s) => s.participants.length > 0)
  const hasVisit = group.some((s) => s.origin === 'visit')
  if (hasPeople && hasVisit) return 'meeting'
  if (hasPeople) return 'meeting'
  if (hasVisit && places.length) {
    const place = store.entities.byId(places[0]!)
    /**
     * A place the SOURCE categorised keeps that category; everything else is a
     * plain visit. Not our judgement, and traceable to a field.
     */
    const category = place?.attributes.category
    return typeof category === 'string' && category ? `visit:${category}` : 'visit'
  }
  return 'other'
}

/**
 * `planned` / `ongoing` / `completed` / `cancelled` / `uncertain`.
 *
 * `cancelled` comes only from a source SAYING so — a declined RSVP. Inferring
 * cancellation from a missing location visit would mark every meeting he took
 * from his desk as cancelled, and inferring it from silence is how the app ends
 * up telling him he did not do something he did.
 *
 * `uncertain` is for the honest case: the time has passed, the only evidence is
 * a plan, and nothing corroborates it. That is not "it happened" and it is not
 * "it did not".
 */
function statusOf(group: Seed[], startAt: string, endAt: string | null, now: string): Episode['status'] {
  if (group.some((s) => s.o.attributes.response === 'declined')) return 'cancelled'
  if (startAt > now) return 'planned'
  if (endAt && endAt > now) return 'ongoing'
  const corroborated = group.some((s) => s.origin === 'visit')
  return corroborated ? 'completed' : 'uncertain'
}

/**
 * One line, composed by code.
 *
 * Deliberately not a model call. Every episode gets a summary, there are
 * thousands of them, and the sentence is entirely determined by fields we
 * already hold — a model here would cost a call per episode to reword a join.
 * `insight.ts`'s principle applies unchanged: typed conclusion first, expression
 * second, and expression only where wording genuinely carries meaning.
 */
function summaryOf(group: Seed[], store: MemoryStore, places: string[]): string {
  const titles = group
    .map((s) => s.o.attributes.summary)
    .filter((t): t is string => typeof t === 'string' && !!t)
  const placeLabel = places.length ? store.entities.byId(places[0]!)?.label : undefined
  if (titles.length) return placeLabel ? `${titles[0]} — ${placeLabel}` : titles[0]!
  if (placeLabel) return `at ${placeLabel}`
  return 'something that happened'
}
