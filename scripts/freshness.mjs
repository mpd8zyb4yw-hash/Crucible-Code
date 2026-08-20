#!/usr/bin/env node
/**
 * IS WHAT IS ON THE SCREEN STILL TRUE?
 *
 * Every gate this app already has answers a different question. `shots` says the
 * pixels are where they were told to be. `geometry` says the phone's notch and
 * keyboard are handled. `interaction` says a tap fires. `contract` says the types
 * hold. All of them were green on 18 August 2026, while his home screen led with
 * a restaurant booking from the 8th and claimed `8 ahead` on a week holding two
 * things.
 *
 * Nothing was broken in any of the senses those gates can express. Two functions
 * disagreed about the meaning of the word "ahead", the wrong one owned the
 * largest object on the home screen, and the app had no way to remove an event
 * that Google had deleted. This file is the question none of the others asks:
 *
 *     is the thing being drawn CURRENT, and does every surface that draws it
 *     agree about what it is?
 *
 * The scenarios are his real calendar on the day he reported it. Run: npm test
 */
import { canonical } from '../server/panes.ts'
import { deckWidget } from '../server/deck.ts'
import { isOver, isRunning, isToday, leadFor, nextUp, upcoming } from '../server/calendar.ts'

let failures = 0
const check = (what, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return
  failures++
  console.error(`FAIL  ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
const ok = (what, cond) => check(what, !!cond, true)

const ROME = 'Europe/Rome'
/** 18 August 2026, 10:00 Rome. The morning of the report. */
const NOW = new Date('2026-08-18T08:00:00Z')

/** An observation as the Google connector actually writes one. */
const event = (id, summary, start, end, extra = {}) => ({
  id: `gcal-${id}`,
  source: 'calendar',
  at: String(start).slice(0, 10),
  text: `${summary} — ${start}`,
  data: { kind: 'event', eventId: id, summary, start, end, allDay: !start.includes('T'), ...extra },
})

/**
 * HIS ACTUAL CALENDAR, as read out of production KV on the morning he wrote in.
 *
 * Seven of the nine are finished. Eight of the nine are all-day, which is why
 * `deck.ts`'s `e.allDay ? true` was not a small bug: it exempted almost his whole
 * calendar from ever expiring.
 */
const HIS_WEEK = [
  event('odelia', 'Restaurant with Odelia at 11 AM', '2026-08-08', '2026-08-09'),
  event('concert', 'Comic concert in avano 9PM', '2026-08-10', '2026-08-11'),
  event('eclipse', 'Partial eclipse', '2026-08-12', '2026-08-13'),
  event('polenta1', 'Polenta in Avano', '2026-08-12', '2026-08-14'),
  event('polenta2', 'Polenta in Avano with rafaella', '2026-08-12', '2026-08-14'),
  event('costume', 'Kristina & Nick costume party', '2026-08-15', '2026-08-16'),
  event('lunch', 'Lunch with rafaella and family', '2026-08-15T10:00:00Z', '2026-08-15T11:00:00Z', { location: 'Avano' }),
  event('hike', 'Hiking with Mauro at 9am', '2026-08-19', '2026-08-20'),
  event('premana', 'Premana party', '2026-08-23', '2026-08-24'),
]

const world = { observations: HIS_WEEK, timeZone: ROME }
const read = (obs = HIS_WEEK, now = NOW) => canonical('calendar', obs, { ...world, observations: obs }, now)

/** Home's Calendar widget, built the way the feed builds it. */
const homeCard = (obs = HIS_WEEK, now = NOW) => {
  const c = read(obs, now)
  return deckWidget(
    {
      id: 'src-calendar', title: 'Calendar', tier: 'quiet', heat: 'quiet',
      panes: [{ widget: { kind: 'calendar', events: c.events, view: 'day', empty: 'Nothing.' } }],
    },
    now,
    ROME
  )
}

// ── 1. Cold start: Home is truthful before anything is opened ────────────────

/**
 * THE REPORTED DEFECT, AS AN ASSERTION.
 *
 * "current Calendar information missing from the Home/card view" and "stale
 * Calendar events that are no longer relevant". Both are this one line.
 */
{
  const card = homeCard()
  check('cold start: the hero is the next real event', card.hero.title, 'Hiking with Mauro at 9am')
  check('cold start: the hero carries its day', card.hero.rel, 'tomorrow')
  check('cold start: the count is of what is ahead', card.meta, '2 ahead')
  ok('cold start: nothing finished is on the card',
     !JSON.stringify(card).includes('Odelia') && !JSON.stringify(card).includes('eclipse'))
  ok('cold start: the next-but-one is on the card without a tap',
     (card.rows ?? []).some((r) => r.title === 'Premana party'))
  check('cold start: its lead column is the day, not a clock',
        (card.rows ?? []).find((r) => r.title === 'Premana party')?.lead, 'Sunday')
}

// ── 2. Time-sensitive content ages out ───────────────────────────────────────

check('a finished all-day event is over', isOver(read().events.find((e) => e.id === 'odelia'), NOW, ROME), true)
check('tomorrow is not over', isOver(read().events.find((e) => e.id === 'hike'), NOW, ROME), false)

/**
 * A MULTI-DAY ALL-DAY EVENT IS CURRENT ON EVERY ONE OF ITS DAYS.
 *
 * Google stores 12–14 August as `end: 2026-08-14`, exclusive. Read as inclusive
 * it survives a day too long; read off `start` alone it dies two days early. The
 * 13th is the day that tells the two apart.
 */
{
  const thirteenth = new Date('2026-08-13T08:00:00Z')
  const polenta = read().events.find((e) => e.id === 'polenta2')
  check('mid-run: not over', isOver(polenta, thirteenth, ROME), false)
  check('mid-run: running', isRunning(polenta, thirteenth, ROME), true)
  check('mid-run: today', isToday(polenta, thirteenth, ROME), true)
  const after = new Date('2026-08-14T08:00:00Z')
  check('the day after its last day: over', isOver(polenta, after, ROME), true)
}

/**
 * A MEETING YOU ARE IN THE MIDDLE OF IS THE MOST CURRENT THING THERE IS.
 *
 * `start >= now` dropped it the moment it began, so the hour he was most likely
 * to look at his phone was the hour the card stopped saying where he should be.
 */
{
  const during = new Date('2026-08-15T10:30:00Z')
  const card = homeCard(HIS_WEEK, during)
  check('a running event is the hero', card.hero.title, 'Lunch with rafaella and family')
  check('and it says it is happening now', card.hero.rel, 'now')
}

/**
 * TIMED BEATS ALL-DAY WITHIN A DAY, AND ONLY WITHIN IT.
 *
 * An all-day event sorts before every timed event on its own date, so a birthday
 * used to take the hero from the meeting in forty minutes.
 */
{
  const morning = new Date('2026-08-15T06:00:00Z')
  check('the timed event outranks the all-day one on its own day',
        nextUp(read().events, morning, ROME).title, 'Lunch with rafaella and family')
  check('the all-day event is still ahead, just not the hero',
        upcoming(read().events, morning, ROME).some((e) => e.id === 'costume'), true)
}

// ── 3. The all-day band never restates the hero ──────────────────────────────

{
  const morning = new Date('2026-08-15T06:00:00Z')
  const card = homeCard(HIS_WEEK, morning)
  ok('the all-day band does not repeat the hero',
     !(card.strip?.allDay ?? []).some((a) => a.id === card.heroId))
  ok('nor do the rows', !(card.rows ?? []).some((r) => r.id === card.heroId))
}

// ── 4. Deduplication: one commitment, one representation ─────────────────────

/**
 * `Polenta in Avano` and `Polenta in Avano with rafaella` are two Google events
 * with two ids, both all-day, both 12–14 August. Nothing downstream can tell
 * them apart, so the calendar simply showed the same evening twice.
 */
{
  const twelfth = new Date('2026-08-12T08:00:00Z')
  const events = read().events
  check('the duplicate pair collapses', events.filter((e) => e.title.startsWith('Polenta')).length, 1)
  check('the surviving title is the one carrying the extra fact',
        events.find((e) => e.title.startsWith('Polenta')).title, 'Polenta in Avano with rafaella')
  ok('a genuine clash is NOT collapsed',
     upcoming(
       [...read().events, { id: 'x', title: 'Something else', start: '2026-08-12', end: '2026-08-13', allDay: true }],
       twelfth, ROME
     ).filter((e) => isToday(e, twelfth, ROME)).length >= 2)
}

// ── 5. Home and depth derive from the same canonical set ─────────────────────

/**
 * THE INVARIANT THE WHOLE REPORT IS ABOUT.
 *
 * Home may show fewer events than depth. It may never show a DIFFERENT event, and
 * it may never name one whose identity or state depth would disagree with.
 */
{
  const c = read()
  const card = homeCard()
  const depth = c.events            // what the Calendar surface is handed
  const onHome = [card.heroId, ...(card.rows ?? []).map((r) => r.id), ...(card.strip?.allDay ?? []).map((a) => a.id)]
    .filter(Boolean)
  for (const id of onHome) {
    ok(`Home's ${id} exists in depth`, depth.some((e) => e.id === id))
  }
  const aheadInDepth = upcoming(depth, NOW, ROME).map((e) => e.id)
  ok('Home names nothing depth would call finished', onHome.every((id) => aheadInDepth.includes(id)))
  check('Home is a subset, not a different set', onHome.length <= aheadInDepth.length, true)
}

// ── 6. Reschedule: the old occurrence does not survive ───────────────────────

/**
 * Lunch moves from 12:00 to 13:00. Google keeps the id and changes the time, so
 * the fold updates in place — and the test that matters is that nothing anywhere
 * still knows about 12:00.
 */
{
  const at = '2026-08-19T10:00:00Z'
  const before = [...HIS_WEEK, event('moves', 'Lunch', at, '2026-08-19T11:00:00Z')]
  const after = before.map((o) =>
    o.data?.eventId === 'moves'
      ? event('moves', 'Lunch', '2026-08-19T11:00:00Z', '2026-08-19T12:00:00Z')
      : o)
  check('before: Home leads with the 12:00', homeCard(before).hero.sub, '12:00')
  check('after:  Home leads with the 13:00', homeCard(after).hero.sub, '13:00')
  ok('after:  the old time is nowhere on the card', !JSON.stringify(homeCard(after)).includes('12:00'))
  check('after:  there is still exactly one Lunch',
        read(after).events.filter((e) => e.title === 'Lunch').length, 1)
}

// ── 7. Cancellation: an event Google no longer returns leaves the world ──────

/**
 * THE ROOT CAUSE, AS A TEST.
 *
 * `foldObservations` could only add or update. This asserts the connector's
 * coverage declaration, and — just as important — the three ways it must REFUSE
 * to delete, because each of those is a way this feature loses his data.
 */
{
  const { addObservations, reconcileBeliefs } = await import('../server/world.ts')
  const { memoryWorldStore, setWorldStore } = await import('../server/store.ts')

  const inst = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v))
  /** The connector's own declaration, restated: Google's selection criterion. */
  const cov = [{
    source: 'calendar',
    covers: (o) =>
      o.data?.kind === 'event' &&
      inst(o.data.end ?? o.data.start) > NOW.getTime() &&
      inst(o.data.start) < NOW.getTime() + 7 * 86_400_000,
  }]

  const sync = async (held, batch, coverage) => {
    setWorldStore(memoryWorldStore({ version: 1, observations: held, beliefs: [], timeZone: ROME }))
    return addObservations(batch, NOW, { timeZone: ROME, coverage })
  }

  {
    // Google returns everything except the hike: he cancelled it.
    const w = await sync(HIS_WEEK, HIS_WEEK.filter((o) => o.data.eventId !== 'hike'), cov)
    ok('a cancelled event leaves the world', !w.observations.some((o) => o.data?.eventId === 'hike'))
    ok('the finished ones are untouched — depth keeps its history',
       w.observations.some((o) => o.data?.eventId === 'odelia'))
    check('and Home moves on to the next real thing', homeCard(w.observations).hero.title, 'Premana party')
  }

  {
    // A FAILED fetch declares no coverage. An empty batch must then delete nothing.
    const w = await sync(HIS_WEEK, [], [])
    check('a failed sync deletes nothing', w.observations.length, HIS_WEEK.length)
  }

  {
    // A TRUNCATED reply declares no coverage either — same assertion, and the
    // reason `google.ts` checks the page length before pushing one.
    const w = await sync(HIS_WEEK, HIS_WEEK.slice(0, 2), [])
    check('a truncated sync deletes nothing', w.observations.length, HIS_WEEK.length)
  }

  {
    // Coverage is scoped to one source: a calendar sync may not retire an email.
    const mail = {
      id: 'gmail-1', source: 'email', at: '2026-08-18',
      text: 'Email', data: { kind: 'email', messageId: '1', from: 'a@b.c', subject: 'Hi' },
    }
    const w = await sync([...HIS_WEEK, mail], HIS_WEEK, cov)
    ok('the email survives a calendar sync', w.observations.some((o) => o.id === 'gmail-1'))
  }

  /**
   * A BELIEF RESTING ON A CANCELLED EVENT IS CONTESTED, NOT LEFT STANDING.
   *
   * §29: cognition must not go on reasoning over an object the UI correctly
   * removed. The mechanism already existed — this asserts that retirement
   * reaches it.
   */
  {
    const w = {
      version: 1, timeZone: ROME,
      observations: HIS_WEEK.filter((o) => o.data.eventId !== 'hike'),
      beliefs: [{
        id: 'b1', statement: 'He is hiking with Mauro tomorrow morning.',
        basis: ['gcal-hike'], confidence: 0.95, confirmedAt: '2026-08-17T09:00:00Z', decayPerDay: 0.01,
      }],
    }
    const touched = reconcileBeliefs(w, NOW)
    check('the belief is contested', touched.length, 1)
    ok('and is no longer near-certain', w.beliefs[0].confidence <= 0.3)
  }
}

// ── 8. Nothing ahead is a state, not a stale archive ─────────────────────────

{
  const september = new Date('2026-09-01T08:00:00Z')
  const card = homeCard(HIS_WEEK, september)
  check('with everything finished, the card says so', card.mini.line, 'Nothing ahead.')
  ok('and names none of it', !JSON.stringify(card).includes('Premana'))
  ok('the card collapses rather than drawing an empty box', card.quiet === true)
}

// ── 9. The lead column is the §0 ambient exemption, per row ──────────────────

{
  const morning = new Date('2026-08-15T06:00:00Z')
  const events = read().events
  check("today's timed event leads with a clock",
        leadFor(events.find((e) => e.id === 'lunch'), morning, ROME), '12:00')
  check("today's all-day event leads with 'today'",
        leadFor(events.find((e) => e.id === 'costume'), morning, ROME), 'today')
  check('a future all-day event leads with its day',
        leadFor(events.find((e) => e.id === 'hike'), morning, ROME), 'Wednesday')
}

if (failures) {
  console.error(`\n${failures} freshness failure(s): something on screen is no longer true.`)
  process.exit(1)
}
console.log(
  'freshness ok — his real 18 August calendar: finished events age out, the hero is what is next, ' +
  'a running event wins it, duplicates collapse, a reschedule replaces, a cancellation leaves the world ' +
  'and contests the belief that rested on it, and Home never names an event depth would call finished'
)
