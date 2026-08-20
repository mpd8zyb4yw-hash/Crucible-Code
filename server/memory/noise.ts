/**
 * FOUR MONTHS OF A LIFE WITH NOTHING IN IT TO FIND.
 *
 * §32, and the companion to `fixture.ts` in the same way a control is the
 * companion to an experiment. That file asks "can it learn?", and the answer has
 * been yes for a while. This one asks the question that decides whether the first
 * answer was worth anything:
 *
 *     When there is no pattern, does it say so?
 *
 * A system that finds a weekly routine in `fixture.ts` and ALSO finds one here has
 * not learned anything — it has a bias toward finding routines, and the first
 * result was that bias landing on data that happened to agree with it. The two
 * corpora are only meaningful together.
 *
 * WHAT IS DELIBERATELY IN HERE.
 *
 * Not "no data" — that would be trivially passed by any threshold. This is a busy,
 * plausible, fully-populated life whose structure is absent by construction:
 *
 *   · departures at a uniformly random hour, every day, no weekday effect
 *   · destinations drawn at random from a set of places, no place preferred
 *   · steps from a flat distribution, uncorrelated with anything else
 *   · calendar events on random days with random people
 *   · one two-week holiday, which is a REGIME, not a new baseline (§62)
 *   · a fortnight of unusual activity that then stops (§62)
 *   · a recurring meeting that is always cancelled and never attended (§63)
 *   · placeholders he never went to
 *   · a vendor mailing constantly, and a service provider on many events (§61)
 *   · GPS noise: brief stops at the same coordinates, never real visits (§31)
 *   · a short accidental correlation, present for ten days and then gone
 *
 * Every one of those is a shape a pattern-finder wants to promote. The suite in
 * `scripts/negative.mjs` asserts that none of them becomes a routine, a
 * relationship, a permanent shift or a causal claim.
 *
 * SAME CONSTRAINT AS `fixture.ts`: NO ANSWER KEY. Nothing here is returned as
 * metadata and no test may read what the generator decided. The assertions state
 * the expected ABSENCE in their own words. The one exception is `holiday` and
 * `burst`, whose date ranges are exported — a test asserting that the holiday did
 * not become the baseline has to be able to say which fortnight was the holiday,
 * and deriving that from the data would be re-implementing the detector it is
 * checking.
 */

import { addDays, weekdayOf } from '../clock.js'
import { event, visitEvent } from './ingest.js'
import type { MemoryEvent } from './types.js'

export interface NoisyLife {
  events: MemoryEvent[]
  from: string
  to: string
  now: Date
  timeZone: string
  me: string
  /** The fortnight abroad. Exported because a test must be able to name it. */
  holiday: { from: string; to: string }
  /** The fortnight of unusual activity that then stopped. */
  burst: { from: string; to: string }
}

/** The same generator as `fixture.ts`, for the same reproducibility reason. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const at = (day: string, minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000+02:00`).toISOString()
}

const HOME = { key: 'n-home-44.4949-11.3426', lat: 44.4949, lon: 11.3426, label: 'Via Zamboni 4' }

/**
 * Six destinations, none preferred.
 *
 * Six rather than two, because with two a uniform draw still puts him at each one
 * about sixty times in four months and "he goes to A and B" is arguably true. With
 * six, no destination reaches the evidence count a routine needs — which is the
 * honest shape of somebody with no habits rather than a trick to defeat a counter.
 */
const PLACES = [
  { key: 'n-a-44.4812-11.3512', lat: 44.4812, lon: 11.3512, label: 'Piazza Aldrovandi' },
  { key: 'n-b-44.5031-11.3387', lat: 44.5031, lon: 11.3387, label: 'Giardini Margherita' },
  { key: 'n-c-44.4903-11.3271', lat: 44.4903, lon: 11.3271, label: 'Via del Pratello' },
  { key: 'n-d-44.4776-11.3604', lat: 44.4776, lon: 11.3604, label: 'Mercato Navile' },
  { key: 'n-e-44.5122-11.3199', lat: 44.5122, lon: 11.3199, label: 'Parco Nord' },
  { key: 'n-f-44.4688-11.3455', lat: 44.4688, lon: 11.3455, label: 'Stazione' },
]

const ME = 'her@example.test'

/** Twelve acquaintances, so no single person accumulates a cadence. */
const PEOPLE = Array.from({ length: 12 }, (_, i) => ({
  email: `person${i}@example.test`,
  name: `Person ${i}`,
}))

/**
 * The two senders that are NOT people, and are the §61 trap.
 *
 * A vendor that mails more often than any human, and a service provider who
 * appears on more calendar events than any friend. Frequency is the only signal
 * either of them has, and frequency is exactly what a naive relationship deriver
 * reads as closeness.
 */
const VENDOR = 'offers@shop.example.test'
const DENTIST = { email: 'reception@studiodentistico.example.test', name: 'Studio Dentistico' }

/**
 * THE MACHINES, WRITTEN AS GMAIL WRITES THEM — the case real mail produced and
 * both corpora were structurally unable to contain.
 *
 * Every `from` in here used to be a bare address, which no message has ever
 * had. The consequence was not that one test was weak: it was that the
 * not-a-person filter was reading `anthropic <no-reply-…` as a local part and
 * therefore could not match its own regex, so EVERY automated sender with a
 * display name became a person. His real world model held four of them and one
 * of himself, and the negative corpus — whose entire job is to contain plausible
 * non-people — was green throughout.
 *
 * The three shapes below are the three that appeared in his actual mailbox:
 * a per-message no-reply address, a quoted display name containing a comma, and
 * a plain-language brand on a billing mailbox. The comma one matters on its own
 * — it is why the parser looks for angle brackets before it looks for
 * separators, and a version that split on commas first would read `PBC" <…>` as
 * somebody's address.
 */
const MACHINES = [
  { from: 'Anthropic <no-reply-ipAiXkKl3EVYmUHAqUiGBg@mail.anthropic.example.test>', name: 'Anthropic' },
  { from: '"Shop, Inc" <invoice+statements@shop.example.test>', name: 'Shop, Inc' },
  { from: 'Google <no-reply@accounts.google.example.test>', name: 'Google' },
]

/** His own address as a From header, so outbound mail is recognisably his. */
const ME_FROM = `Her <${ME}>`

export function noisyLife(opts: { seed?: number } = {}): NoisyLife {
  const r = rng(opts.seed ?? 77010203)
  const from = '2026-04-06'
  const to = '2026-08-14'
  const now = new Date('2026-08-15T09:00:00.000+02:00')
  const events: MemoryEvent[] = []

  /** A fortnight away. Different city, different rhythm, and then it ends. */
  const holiday = { from: '2026-06-08', to: '2026-06-21' }
  /** A fortnight of much higher activity, for no reason, that then stops. */
  const burst = { from: '2026-05-04', to: '2026-05-17' }
  /** Ten days where two unrelated metrics happen to move together. */
  const coincidence = { from: '2026-07-06', to: '2026-07-15' }

  const inRange = (day: string, range: { from: string; to: string }) => day >= range.from && day <= range.to

  let previousNightStart: string | null = null

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const onHoliday = inRange(day, holiday)
    const inBurst = inRange(day, burst)
    const inCoincidence = inRange(day, coincidence)

    /**
     * DEPARTURE: UNIFORM ACROSS SIX HOURS, WITH NO WEEKDAY TERM.
     *
     * The spread is the point. A normal distribution around a mean would still
     * have a median a routine could quote and a standard deviation tight enough
     * to look like a habit; a flat draw across 06:00–12:00 has no centre to find.
     * `weekdayOf` is called and discarded — deliberately, so that a reader can see
     * the weekday was available and not used.
     */
    void weekdayOf(day)
    const departure = 360 + Math.floor(r() * 360)

    if (previousNightStart) {
      events.push(
        visitEvent(
          { start: previousNightStart, end: at(day, departure), placeKey: HOME.key, lat: HOME.lat, lon: HOME.lon, label: HOME.label },
          { observedAt: at(day, departure) }
        )
      )
    }

    /**
     * GPS NOISE: A STOP THAT IS NOT A VISIT. §31.
     *
     * Four minutes at the same coordinates, most days, at a random time. A visit
     * assembler that does not require dwell time will turn a hundred of these into
     * his most established routine — it has the highest recurrence of anything in
     * the corpus, which is exactly why it is here.
     */
    if (r() < 0.75) {
      const t = departure + 20 + Math.floor(r() * 200)
      events.push(
        visitEvent(
          { start: at(day, t), end: at(day, t + 4), placeKey: 'n-noise-44.4951-11.3429', lat: 44.4951, lon: 11.3429, label: 'unknown' },
          { observedAt: at(day, t + 4) }
        )
      )
    }

    // ── somewhere, chosen at random, for a random length ──
    if (!onHoliday && r() < 0.7) {
      const place = PLACES[Math.floor(r() * PLACES.length)]!
      const start = departure + 30 + Math.floor(r() * 300)
      const duration = 25 + Math.floor(r() * 120)
      events.push(
        visitEvent(
          { start: at(day, start), end: at(day, start + duration), placeKey: place.key, lat: place.lat, lon: place.lon, label: place.label },
          { observedAt: at(day, start + duration) }
        )
      )
    }

    /**
     * THE HOLIDAY. A different city entirely, every day, for a fortnight.
     *
     * §62's test: this must not rewrite the home routine, the departure baseline
     * or the place preferences. It is a regime, and the correct handling of a
     * regime is to notice it ended.
     */
    if (onHoliday) {
      const start = 540 + Math.floor(r() * 120)
      events.push(
        visitEvent(
          { start: at(day, start), end: at(day, start + 240), placeKey: 'n-hol-37.9838-23.7275', lat: 37.9838, lon: 23.7275, label: 'Athens' },
          { observedAt: at(day, start + 240) }
        )
      )
    }

    /**
     * STEPS: FLAT, EXCEPT FOR TWO DELIBERATE REGIMES.
     *
     * The burst is high for a fortnight and then stops; the holiday is high for a
     * different fortnight. Neither may become "his baseline", and the transition
     * out of each must not be reported as a decline — §62 is about both directions.
     */
    const steps = inBurst || onHoliday ? 13_000 + Math.floor(r() * 3000) : 4000 + Math.floor(r() * 5000)
    events.push(
      event({
        source: 'health',
        sourceId: `n-steps-${day}`,
        sourceAt: at(day, 1380),
        type: 'health.metric',
        payload: { id: `steps-${day}`, text: `${steps} steps`, at: at(day, 1380), data: { kind: 'steps', metric: 'steps', value: steps, day } },
      })
    )

    /**
     * CALENDAR: RANDOM DAYS, RANDOM PEOPLE, PLUS THE THREE TRAPS.
     */
    const meetings = r() < 0.35 ? 1 + Math.floor(r() * 2) : 0
    for (let i = 0; i < meetings; i++) {
      const person = PEOPLE[Math.floor(r() * PEOPLE.length)]!
      const start = 540 + Math.floor(r() * 420)
      events.push(
        calendarEvent(day, `n-${day}-${i}`, {
          summary: `Catch up with ${person.name}`,
          start: at(day, start),
          end: at(day, start + 45),
          attendees: [{ email: ME, name: 'Her' }, person],
          organizer: person.email,
          response: 'accepted',
        })
      )
    }

    /**
     * THE CANCELLED RECURRING MEETING. §63.
     *
     * Every Monday, all four months, and cancelled every single time. It is the
     * most regular thing in the corpus by a wide margin. An assembler that turns a
     * calendar row into a completed episode because the row existed will produce
     * the strongest routine here out of something that never once happened.
     */
    if (weekdayOf(day) === 1) {
      events.push(
        calendarEvent(day, `n-standup-${day}`, {
          summary: 'Team standup',
          start: at(day, 570),
          end: at(day, 600),
          attendees: [{ email: ME, name: 'Her' }, PEOPLE[0]!],
          organizer: PEOPLE[0]!.email,
          response: 'declined',
          status: 'cancelled',
        })
      )
    }

    /**
     * A PLACEHOLDER HE NEVER ATTENDED. §32.
     *
     * On the calendar, at a place, with no location evidence anywhere near it.
     * "Gym" every Wednesday and no visit to a gym in four months: the plan and the
     * reality must stay separate, and the plan alone is not a routine.
     */
    if (weekdayOf(day) === 3) {
      events.push(
        calendarEvent(day, `n-gym-${day}`, {
          summary: 'Gym',
          start: at(day, 1140),
          end: at(day, 1200),
          attendees: [{ email: ME, name: 'Her' }],
          organizer: ME,
          response: 'accepted',
        })
      )
    }

    /** The dentist: on many events, and never a friend. §61. */
    if (r() < 0.12) {
      const start = 600 + Math.floor(r() * 300)
      events.push(
        calendarEvent(day, `n-dent-${day}`, {
          summary: 'Appuntamento',
          start: at(day, start),
          end: at(day, start + 30),
          attendees: [{ email: ME, name: 'Her' }, DENTIST],
          organizer: DENTIST.email,
          response: 'accepted',
        })
      )
    }

    /** The vendor: mails more than any human, and is not one. §61. */
    if (r() < 0.6) {
      events.push(
        event({
          source: 'gmail',
          sourceId: `n-vendor-${day}`,
          sourceAt: at(day, 480),
          type: 'gmail.message',
          payload: {
            id: `n-vendor-${day}`,
            text: 'Weekend offers inside',
            at: at(day, 480),
            data: { kind: 'email', messageId: `nv-${day}`, from: `Shop Offers <${VENDOR}>`, fromName: 'Shop Offers', to: ME_FROM, subject: 'Your weekly deals' },
          },
        })
      )
    }

    /**
     * The three real machine shapes, mailing most days. See `MACHINES`.
     *
     * They mail MORE than the twelve acquaintances do, so if the person filter
     * misses them they will not merely appear — they will be the most frequent
     * contacts in the graph and the first candidates for a cadence edge.
     */
    for (const [i, machine] of MACHINES.entries()) {
      if (r() >= 0.55) continue
      events.push(
        event({
          source: 'gmail',
          sourceId: `n-machine-${i}-${day}`,
          sourceAt: at(day, 400 + i * 5),
          type: 'gmail.message',
          payload: {
            id: `n-machine-${i}-${day}`,
            text: 'An automated message',
            at: at(day, 400 + i * 5),
            data: {
              kind: 'email',
              messageId: `nm-${i}-${day}`,
              from: machine.from,
              fromName: machine.name,
              to: ME_FROM,
              subject: 'Your account',
            },
          },
        })
      )
    }

    /**
     * HER OWN OUTBOUND MAIL, addressed the way a real reply is.
     *
     * The assertion this exists for is that she is not lifted as a person in her
     * own life. It could not fail before, because `from === me` compared a header
     * to an address and was false for every message, so an outbound message was
     * simply read as an inbound one from her — which is exactly what the real
     * mailbox produced.
     */
    if (r() < 0.3) {
      const other = PEOPLE[Math.floor(r() * PEOPLE.length)]!
      events.push(
        event({
          source: 'gmail',
          sourceId: `n-sent-${day}`,
          sourceAt: at(day, 1020),
          type: 'gmail.message',
          payload: {
            id: `n-sent-${day}`,
            text: 'A reply she sent',
            at: at(day, 1020),
            data: {
              kind: 'email',
              messageId: `ns-${day}`,
              from: ME_FROM,
              fromName: 'Her',
              to: `${other.name} <${other.email}>`,
              subject: 'Re: later',
            },
          },
        })
      )
    }

    /**
     * THE ACCIDENTAL CORRELATION. Ten days, then nothing. §32.
     *
     * Steps and calendar load move together for a week and a half because this
     * line says so, and for no other reason. Ten days is enough for a pair search
     * to notice and nowhere near enough for it to be true — which is the whole
     * content of `temporalCoverageDays` as a promotion bar.
     */
    if (inCoincidence) {
      events.push(
        calendarEvent(day, `n-co-${day}`, {
          summary: 'Busy',
          start: at(day, 660),
          end: at(day, 720),
          attendees: [{ email: ME, name: 'Her' }, PEOPLE[1]!],
          organizer: ME,
          response: 'accepted',
        })
      )
    }

    previousNightStart = at(day, 1290 + Math.floor(r() * 120))
  }

  return { events, from, to, now, timeZone: 'Europe/Rome', me: ME, holiday, burst }
}

/** The calendar row shape, so the eight call sites above stay readable. */
function calendarEvent(
  day: string,
  sourceId: string,
  data: {
    summary: string
    start: string
    end: string
    attendees: { email: string; name: string }[]
    organizer: string
    response: string
    status?: string
  }
): MemoryEvent {
  return event({
    source: 'calendar',
    sourceId,
    sourceAt: data.start,
    type: 'calendar.event',
    payload: {
      id: `gcal-${sourceId}`,
      text: data.summary,
      at: data.start,
      data: { kind: 'event', eventId: `gcal-${sourceId}`, ...data },
    },
  })
}
