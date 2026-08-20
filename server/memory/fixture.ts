/**
 * FOUR MONTHS OF A SYNTHETIC LIFE, CONTAINING NO CONCLUSIONS.
 *
 * §32 of the handoff is unusually specific about what this file may not do, and
 * the constraint is the whole value of it:
 *
 *     Do not encode "Saturday grocery routine" directly into fixture metadata.
 *
 * So there is no metadata. This emits raw source events — calendar rows, location
 * visits with start and end times, daily step counts, messages — and nothing
 * else. It does not return the routines it generated, the change point it
 * introduced or the day it deliberately broke the pattern. A test that asserted
 * against a fixture's own answer key would prove that two pieces of this file
 * agree with each other, which is not a property anybody wants.
 *
 * The acceptance tests therefore state the expected findings THEMSELVES, in their
 * own words, and compare them against what the cognition discovered. When the
 * fixture changes, the tests fail — which is correct, because the tests are
 * assertions about what the system can learn from a given life.
 *
 * DETERMINISTIC, WITH A SEEDED GENERATOR RATHER THAN `Math.random`.
 *
 * Everything below is a pure function of the seed. That matters twice over: the
 * replay test compares a rebuild byte for byte, and a flaky fixture would make
 * every failure in this directory unreproducible — which, per the existing
 * test-harness notes, is already the most expensive kind of failure this project
 * has.
 *
 * ABOUT THE ZONE. The window is April to August, which is entirely inside
 * European summer time, so local times are written with a fixed `+02:00` offset.
 * That is a property of the fixture's window and not an assumption the code
 * makes — everything downstream reads his zone through `clock.ts`. A fixture
 * spanning a DST boundary would have to construct its instants through `clock.ts`
 * too, and would be the right thing to write on the day this one is extended.
 */

import { addDays, weekdayOf } from '../clock.js'
import { event, statementEvent, visitEvent } from './ingest.js'
import type { MemoryEvent } from './types.js'

export interface SyntheticLife {
  events: MemoryEvent[]
  from: string
  to: string
  /** The instant the tests should treat as "now". */
  now: Date
  timeZone: string
  me: string
}

/**
 * A linear congruential generator — the numerical recipes constants.
 *
 * Chosen for being three lines and reproducible across runtimes rather than for
 * statistical quality. This is generating jitter around a mean, not cryptographic
 * material, and a generator whose sequence differs between Node versions would
 * break the replay test in a way that looks like a cognition bug.
 */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** Normal-ish jitter from two uniforms. Cheap, bounded, and good enough for minutes. */
const jitter = (r: () => number, spread: number): number => Math.round((r() + r() - 1) * spread)

const at = (day: string, minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000+02:00`).toISOString()
}

const HOME = { key: 'home-45.9012-9.4033', lat: 45.9012, lon: 9.4033, label: 'Via Roma 12' }
const SHOP = { key: 'shop-45.9188-9.4302', lat: 45.9188, lon: 9.4302, label: 'Coop Dervio' }
const LAKE = { key: 'lake-46.0741-9.3067', lat: 46.0741, lon: 9.3067, label: 'Dervio lakefront' }

const ME = 'him@example.test'
const BERNARDO = 'bernardo@example.test'
const ANNA = 'anna.rossi@work.example.test'
const SHOP_MAILER = 'newsletter@coop.example.test'

/**
 * SENDERS WRITTEN THE WAY GMAIL ACTUALLY WRITES THEM.
 *
 * Both corpora used to put a bare address in `from`, and no real message has
 * ever had one — the header is `Display Name <address>`, and a display name
 * containing a comma is quoted. That single unreality hid a four-symptom bug for
 * the whole life of this file: the address was never parsed out, so the
 * not-a-person filter matched against `anthropic <no-reply-…`, two no-reply
 * addresses at one domain became two people, `from === me` could never be true,
 * and he was resolved as a correspondent in his own life. It took running the
 * pipeline over his real mailbox to see any of it.
 *
 * So the fixtures now carry the real shape. A corpus whose inputs are tidier
 * than reality is a corpus that certifies the parts of the code reality does not
 * reach.
 */
const BERNARDO_FROM = `Bernardo Conti <${BERNARDO}>`
const SHOP_MAILER_FROM = `Coop <${SHOP_MAILER}>`
const ME_FROM = `Him <${ME}>`

/**
 * Build the life.
 *
 * The generated patterns, stated here so a reader of this file knows what is in
 * it — and stated NOWHERE the code can read, which is the point:
 *
 *   · a home stay every night, ending at a departure time
 *   · Tuesdays leave late morning; the last five weeks leave around midday
 *   · other weekdays leave early
 *   · most Saturdays include a stop at the same shop, mid-morning, about an hour
 *   · one Saturday near the end has no such stop
 *   · Thursdays carry one or two work meetings; some carry three or more
 *   · steps every day, lower on the heavy Thursdays
 *   · a handful of wet days that also depress steps regardless of the calendar
 *   · lunches with the same person, roughly fortnightly, at the lake
 *   · a shop newsletter, so the person filter has something to reject
 */
export function syntheticLife(opts: { seed?: number } = {}): SyntheticLife {
  const r = rng(opts.seed ?? 20260415)
  const from = '2026-04-06'
  const to = '2026-08-14'
  const now = new Date('2026-08-15T09:00:00.000+02:00')
  const events: MemoryEvent[] = []

  /**
   * The day the late-Tuesday pattern begins.
   *
   * Five weeks before the end, so that a four-week analysis window sees only the
   * new level and a whole-history change-point search sees both. That is exactly
   * the case §33 asks the system to tell apart, and a shift placed inside the
   * window would let a naive percentage change find it by accident.
   */
  const shiftFrom = '2026-07-14'

  /** The deliberate break: a Saturday with no shop trip, late enough to be recent. */
  const skippedSaturday = '2026-08-01'

  /** Wet days: the confounder. They depress steps without touching the calendar. */
  const wetDays = new Set(['2026-05-13', '2026-06-03', '2026-07-08', '2026-08-05'])

  let previousNightStart: string | null = null

  for (let day = from; day <= to; day = addDays(day, 1)) {
    const w = weekdayOf(day)
    const isTuesday = w === 2
    const isThursday = w === 4
    const isSaturday = w === 6
    const isWet = wetDays.has(day)

    // ── when he leaves ──
    const departure = isTuesday
      ? (day >= shiftFrom ? 720 : 630) + jitter(r, 20)
      : w === 0
        ? 600 + jitter(r, 45)
        : 525 + jitter(r, 25)

    // ── the night before, ending at that departure ──
    if (previousNightStart) {
      events.push(
        visitEvent(
          { start: previousNightStart, end: at(day, departure), placeKey: HOME.key, lat: HOME.lat, lon: HOME.lon, label: HOME.label, category: undefined },
          { observedAt: at(day, departure) }
        )
      )
    }

    // ── Saturday shop ──
    const shopped = isSaturday && day !== skippedSaturday && r() < 0.82
    if (shopped) {
      const start = 635 + jitter(r, 25)
      const duration = 68 + jitter(r, 12)
      events.push(
        visitEvent(
          { start: at(day, start), end: at(day, start + duration), placeKey: SHOP.key, lat: SHOP.lat, lon: SHOP.lon, label: SHOP.label },
          { observedAt: at(day, start + duration) }
        )
      )
    }

    // ── Thursday work ──
    let meetings = 0
    if (isThursday) {
      // Roughly one Thursday in three is heavy. Not flagged anywhere.
      const heavy = r() < 0.34
      meetings = heavy ? 3 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2)
      for (let i = 0; i < meetings; i++) {
        const start = 600 + i * 90 + jitter(r, 10)
        events.push(
          event({
            source: 'calendar',
            sourceId: `evt-${day}-${i}`,
            sourceAt: at(day, start),
            type: 'calendar.event',
            payload: {
              id: `gcal-${day}-${i}`,
              text: `Meeting with Anna Rossi`,
              at: at(day, start),
              data: {
                kind: 'event',
                eventId: `gcal-${day}-${i}`,
                summary: i === 0 ? 'Weekly review' : `Project sync ${i}`,
                start: at(day, start),
                end: at(day, start + 55),
                attendees: [
                  { email: ME, name: 'Him' },
                  { email: ANNA, name: 'Anna Rossi' },
                ],
                organizer: ANNA,
                response: 'accepted',
              },
            },
          })
        )
      }
    }

    /**
     * ── fortnightly lunch with the same person, at the lake ──
     *
     * THE OFFSET USED TO BE 0, AND THIS BLOCK NEVER RAN.
     *
     * `from` is Monday the 6th of April, so `dayIndex % 14 === 0` selects
     * Mondays, and the `w === 3` beside it asks for a Wednesday. The two
     * conditions are unsatisfiable together, so for the whole life of this file
     * the corpus contained no lunch, no lake, and no Bernardo — while the header
     * comment above listed all three, and `docs/memory-core.md` described a
     * fixture that has a fortnightly companion in it.
     *
     * What that cost is bigger than one absent person. Bernardo is the corpus's
     * ONLY human mail correspondent, so the keyed-person-from-a-mail-header path
     * had no positive coverage at all: the newsletter exercised the rejection and
     * nothing exercised the acceptance. A parser change that started rejecting
     * every sender would have been green. That is the shape of hole this phase
     * exists to find, and it was found by writing an assertion that a documented
     * inhabitant of the fixture exists.
     *
     * Offset 2, because day 2 is the first Wednesday.
     */
    if (w === 3 && dayIndex(from, day) % 14 === 2) {
      const start = 750 + jitter(r, 15)
      events.push(
        event({
          source: 'calendar',
          sourceId: `lunch-${day}`,
          sourceAt: at(day, start),
          type: 'calendar.event',
          payload: {
            id: `gcal-lunch-${day}`,
            text: 'Lunch Bernardo',
            at: at(day, start),
            data: {
              kind: 'event',
              eventId: `gcal-lunch-${day}`,
              summary: 'Lunch Bernardo',
              start: at(day, start),
              end: at(day, start + 80),
              attendees: [{ email: ME, name: 'Him' }, { email: BERNARDO, name: 'Bernardo Conti' }],
              organizer: ME,
              response: 'accepted',
            },
          },
        })
      )
      events.push(
        visitEvent(
          { start: at(day, start - 10), end: at(day, start + 95), placeKey: LAKE.key, lat: LAKE.lat, lon: LAKE.lon, label: LAKE.label },
          { observedAt: at(day, start + 95) }
        )
      )
      events.push(
        event({
          source: 'gmail',
          sourceId: `msg-lunch-${day}`,
          sourceAt: at(day, 540),
          type: 'gmail.message',
          payload: {
            id: `gmail-lunch-${day}`,
            text: 'See you at one',
            at: at(day, 540),
            data: { kind: 'email', messageId: `m-${day}`, from: BERNARDO_FROM, fromName: 'Bernardo Conti', to: ME_FROM, subject: 'today' },
          },
        })
      )
    }

    /**
     * A personal calendar note with NO attendee list, naming somebody.
     *
     * This is the case the keyless-person path exists for, and it is the common
     * case in a real life rather than an edge one: most of the people someone
     * sees are not on a calendar invitation with an email address attached. It is
     * here so the resolver's hardest rule — accumulate a bare name, never merge it
     * into anyone identified — is exercised by the fixture rather than asserted in
     * a comment.
     */
    if (w === 1 && dayIndex(from, day) % 14 === 7) {
      const start = 1020 + jitter(r, 15)
      events.push(
        event({
          source: 'calendar',
          sourceId: `coffee-${day}`,
          sourceAt: at(day, start),
          type: 'calendar.event',
          payload: {
            id: `gcal-coffee-${day}`,
            text: 'Coffee Giulia',
            at: at(day, start),
            data: { kind: 'event', eventId: `gcal-coffee-${day}`, summary: 'Coffee Giulia', start: at(day, start), end: at(day, start + 45) },
          },
        })
      )
    }

    // ── steps ──
    const base = 7200 + jitter(r, 500)
    const meetingDrag = meetings >= 3 ? 3100 : meetings ? 900 : 0
    const wetDrag = isWet ? 2600 : 0
    const steps = Math.max(900, base - meetingDrag - wetDrag - (isThursday ? 800 : 0))
    events.push(
      event({
        source: 'health',
        sourceId: `steps-${day}`,
        sourceAt: `${day}T23:00:00.000+02:00`,
        observedAt: `${day}T23:00:00.000+02:00`,
        type: 'health.steps',
        payload: { id: `fit-${day}`, text: `${steps} steps`, at: `${day}T23:00:00.000+02:00`, data: { kind: 'steps', days: [{ date: day, steps }] } },
      })
    )

    // ── a shop newsletter, so the non-person filter has work to do ──
    if (w === 1) {
      events.push(
        event({
          source: 'gmail',
          sourceId: `news-${day}`,
          sourceAt: at(day, 420),
          type: 'gmail.message',
          payload: {
            id: `gmail-news-${day}`,
            text: 'This week at the Coop',
            at: at(day, 420),
            data: { kind: 'email', messageId: `n-${day}`, from: SHOP_MAILER_FROM, fromName: 'Coop', to: ME_FROM, subject: 'This week' },
          },
        })
      )
    }

    previousNightStart = at(day, 1290 + jitter(r, 30))
  }

  /**
   * One thing he said, so the ownership test has something of his to protect.
   *
   * Deliberately about something the behaviour will later contradict: he says he
   * prefers the train, and the location stream is full of him driving. §36 is the
   * assertion that the second never overwrites the first.
   */
  events.push(statementEvent('I prefer taking the train to Milan.', at('2026-05-04', 660), 'preference'))

  return { events, from, to, now, timeZone: 'Europe/Rome', me: ME }
}

/** Days since the window opened. Used only to space the fortnightly lunch. */
function dayIndex(from: string, day: string): number {
  let n = 0
  for (let d = from; d < day; d = addDays(d, 1)) n++
  return n
}
