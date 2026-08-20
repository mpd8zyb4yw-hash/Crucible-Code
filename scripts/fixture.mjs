#!/usr/bin/env node
/**
 * A deterministic backend, for looking at the app.
 *
 * The visual gate needs the same screen every run. The real server assembles
 * Home out of a live Google account and whichever model has quota left, so two
 * runs an hour apart legitimately differ — which makes "did this change break
 * the layout" unanswerable from a screenshot. This serves fixed feeds instead,
 * one per named scenario, so a difference between two captures is a difference
 * in the CODE.
 *
 * It is NOT a mock of the server's behaviour and must never grow into one. It
 * answers the handful of reads the client makes on load, in the shapes
 * `src/api.ts` declares, and nothing else.
 *
 *   node scripts/fixture.mjs --port 3002
 *   curl -X POST localhost:3002/__scenario -d '{"name":"many"}'
 */
import { createServer } from 'node:http'
/**
 * THE DECK IS PROJECTED BY THE REAL CODE, NOT RE-TYPED HERE.
 *
 * This file is a fixed BACKEND, not a mock of the server's behaviour, and the
 * distinction decides this import. Hand-writing a `deck` block per scenario
 * would make the gate assert against a second implementation of the projection —
 * so a bug in `buildDeck` would render wrongly in the app and correctly in every
 * capture, which is the exact shape of "56/56 green while the bug's card never
 * rendered". The scenarios still own the DATA; `buildDeck` owns the projection,
 * once.
 *
 * Run under `tsx` for this reason — see the `fixture` script.
 */
import { buildDeck } from '../server/deck.ts'
/*
  SLOT THREE IS COMPILED BY THE REAL COMPILER, from real typed records.

  Same argument as the deck: hand-writing an `IntelligencePresentation` per
  scenario would make the gate assert against a second implementation of the
  presentation boundary, so a compiler that invented a number would render
  correctly in every capture and wrongly in the app. The scenario owns the
  RECORDS — a hypothesis, its change point, its evidence — and
  `server/intelligence.ts` owns the compilation, once. It also means the
  fixture exercises `grounded()`: a scenario whose copy quoted a figure its
  records did not carry would throw here rather than paint.
*/
import { presentShift } from '../server/intelligence.ts'
/*
  PHASE 8 IS COMPILED BY THE REAL COMPILER TOO, from real typed records.

  Third instance of the same argument, and the one where it matters most: domain
  enrichment is a sentence drawn ON an event, a step count, a pin and a message,
  so a hand-written one would render in the capture and prove nothing about
  whether `domainContexts` can produce it. The scenario owns the RECORDS below —
  summaries, a routine, a place entity, a planned episode — and `enrichPanes`
  owns the projection. It also means the fixture exercises the ABSENCE path for
  free: any domain whose records are missing gets no line, and the captures show
  what the app looks like when the memory core has nothing to add.
*/
import { enrichPanes } from '../server/panes.ts'
import { cognitionOverStore } from '../server/memory/cognition.ts'
/*
  AND THE COPY BUDGET IS THE REAL ONE TOO. See `need` below.
*/
import { budgetForHome } from '../server/homeCopy.ts'

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3002

/** Which brain is in use, and which model each provider would use. See `/api/active`. */
let active = 'anthropic'
const models = { anthropic: 'claude-opus-5', gemini: 'gemini-2.5-flash' }

/**
 * The fixture's "now".
 *
 * A fixed instant, so "tomorrow" is the same word on every run — and shared with
 * `at` below rather than reconstructed beside it, because two definitions of the
 * fixture's own clock is how a scenario ends up asserting against a day it is not
 * on.
 */
const NOW = new Date('2026-08-07T09:00:00Z')

const at = (h, m = 0, dayOffset = 0) => {
  // Fixed wall-clock date so relative labels ("tomorrow", "2d ago") are stable.
  const d = new Date(NOW)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

/**
 * THE FIXTURE HAS TO BE AS HARD AS THE REAL THING.
 *
 * Every need's opening was "What would you like to do?" — 26 characters — and
 * production writes a whole sentence: "6 in the last week from 5 senders.
 * Newest: Your Chase statement is ready". That difference is not cosmetic: the
 * opening is what the chat handle previews, and the handle is a row of the
 * workspace grid, and an unconstrained grid column takes its width from the
 * widest row's min-content. The real string pushed the track 62px past the
 * phone and put `close` off the right edge; the fixture's string fitted, so the
 * gate that would have caught it never saw a failing input and reported 55/55.
 *
 * A fixture that is easier than production tests the fixture. This one is
 * deliberately long — longer than any real opening — so anything that is sized
 * by its content fails here first, on a laptop, instead of on his phone.
 */
const LONG_OPENING =
  '6 in the last week from 5 senders. Newest: Your receipt from Anthropic, PBC #2658-4963-4641 — nothing here needs you yet.'

/**
 * THE COPY BUDGET IS THE REAL ONE, FOR THE SAME REASON THE DECK IS.
 *
 * A scenario writes the sentences a builder would write; `budgetForHome` decides
 * what a card is allowed to say. Hand-writing the post-budget strings here would
 * make the visual gate assert against a second implementation of the rule — so
 * the eyebrow/subtitle restatement the audit found (#12) would keep rendering in
 * the app and stop rendering in the captures, which is precisely the failure
 * shape the deck import exists to prevent.
 *
 * `at` is the fixture's own instant for the item, and it is what makes the
 * eyebrow claim real rather than a guess: an item with a time on it says that
 * time in its eyebrow, so its sub must not open by saying it again.
 */
const need = (o) => {
  const copy = budgetForHome({
    title: o.title,
    sub: o.sub ?? '',
    status: o.status ?? '',
    corrections: o.corrections ?? [],
    eyebrow: { at: o.at, now: NOW },
  })
  return {
  id: o.id, tier: o.tier ?? 'hero', heat: o.heat ?? 'warm', heatLabel: o.heatLabel ?? '',
  title: o.title, sub: copy.sub, status: copy.status, opening: o.opening ?? LONG_OPENING,
  stats: o.stats ?? null, chips: o.chips ?? [], gauges: null, meter: null, glyph: null,
  accent: o.accent ?? null, action: o.action ?? null, proposes: null,
  /*
    `asks` AND `corrections` ARE FIXTURE INPUTS NOW.

    They were hardcoded to `false` and omitted respectively, which meant no
    scenario could produce a question — and `QuestionCard`, the component the
    regression scrollbar was in, was therefore unreachable from the entire
    capture suite. The gate reported 56/56 while never once rendering the card
    in the screenshot it was supposed to be guarding.
  */
  basis: o.basis ?? ['calendar'], asks: o.asks ?? false, corrections: o.corrections ?? undefined,
  focus: o.focus ?? null, panes: o.panes ?? undefined,
  // Undefined for a source or for model prose, which is what the server sends
  // for both — see `Need.band`. Only a computed attention card has one.
  band: o.band,
  standing: o.band ? true : undefined,
  }
}

const MESSAGES = [
  {
    id: 'm1', subject: 'Your receipt from Anthropic, PBC #2658-4963-4641',
    from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>', fromName: 'Anthropic, PBC',
    snippet: 'Your receipt from Anthropic, PBC #2658-4963-4641', at: at(9, 12, -2), unread: true,
    body: 'Your receipt from Anthropic, PBC #2658-4963-4641\n\nAmount charged: $20.00\nDate: August 5, 2026\n\nThank you for your business.',
    actions: [
      { kind: 'mail.archive', label: 'Archive' },
      { kind: 'mail.read', label: 'Mark read' },
    ],
  },
  {
    id: 'm2', subject: 'Security alert', from: '<no-reply@accounts.google.com>', fromName: 'Google',
    snippet: 'A new sign-in on a device you have not used before', at: at(18, 4, -3), unread: true,
    body: 'A new sign-in on a device you have not used before.',
    actions: [{ kind: 'mail.archive', label: 'Archive' }],
  },
  /*
    A THREE-MESSAGE THREAD, BECAUSE THAT IS WHAT A MAILBOX ACTUALLY CONTAINS.

    Every message here used to be its own conversation, so the widget could not
    tell a four-way exchange from four different people wanting something — and
    the rollup that fixes that had no failing input to prove itself against. One
    thread that would otherwise take three of the four rows is the whole test.
  */
  {
    id: 'm3', threadId: 't-odelia', subject: 'Odelia — Saturday', from: '<odelia@example.com>', fromName: 'Odelia',
    to: 'him@example.com',
    snippet: 'Still good for 11? I made the booking under my name.', at: at(20, 40, -4), unread: true,
    body: 'Still good for 11? I made the booking under my name.\n\nSee you there.',
    actions: [{ kind: 'mail.archive', label: 'Archive' }],
  },
  {
    id: 'm3b', threadId: 't-odelia', subject: 'Re: Odelia — Saturday', from: '<odelia@example.com>', fromName: 'Odelia',
    to: 'him@example.com',
    snippet: 'Also they need a card on file, I can do it.', at: at(21, 5, -4),
    body: 'Also they need a card on file, I can do it.',
    actions: [{ kind: 'mail.archive', label: 'Archive' }],
  },
  {
    id: 'm3c', threadId: 't-odelia', subject: 'Re: Odelia — Saturday', from: '<odelia@example.com>', fromName: 'Odelia',
    to: 'him@example.com',
    snippet: 'Done — booked, 11:00, under Rossi.', at: at(21, 30, -4),
    body: 'Done — booked, 11:00, under Rossi.',
    actions: [{ kind: 'mail.archive', label: 'Archive' }],
  },
  {
    id: 'm4', subject: 'Your August statement is ready', from: '<statements@bank.example>', fromName: 'Bank',
    to: 'him@example.com, someone@example.com, other@example.com',
    snippet: 'You can view it in the app.', at: at(7, 0, -6),
    actions: [{ kind: 'mail.archive', label: 'Archive' }],
  },
]

/*
  TODAY HAS TO HAVE A TODAY IN IT.

  The three events were one, four and nine days out, so the day strip — the
  whole point of a temporal widget — had nothing to draw and the axis collapsed
  to a single block. Real days collide, run late, and carry invitations nobody
  has answered; all three are now in here, because a rendering with no failing
  input is a rendering with no gate.
*/
const EVENTS = [
  { id: 'e0', title: 'Ferragosto', start: at(12, 0).slice(0, 10), allDay: true },
  // All three are AFTER the fixture's fixed clock (2026-08-07T17:59Z). The deck
  // only draws what is still ahead of him, so an event behind `now` is a row
  // the capture can never see — which is how the first version of this data
  // exercised the conflict rendering with nothing in it.
  { id: 'e4', title: 'Call with the studio', start: at(20, 30), end: at(21, 0), location: 'Zoom' },
  // Deliberately overlapping e4: the conflict the list rendering could not say.
  { id: 'e5', title: 'Pick up the dry cleaning', start: at(20, 45), end: at(21, 15), location: 'Via Mazzini' },
  { id: 'e6', title: 'Supper at Nonna’s', start: at(21, 30), end: at(23, 0), location: 'Sasso', response: 'needsAction' },
  { id: 'e1', title: 'Restaurant with Odelia', start: at(11, 0, 1), end: at(13, 0, 1), location: 'Via Roma 4' },
  { id: 'e2', title: 'Cinzia’s concert in Avano', start: at(21, 0, 4), end: at(23, 0, 4), location: 'Avano' },
  { id: 'e3', title: 'Dentist', start: at(8, 30, 9), end: at(9, 0, 9), location: 'Studio Bianchi' },
]

/**
 * The same day with nothing overlapping. See the `calm-day` scenario.
 *
 * Four events, which is what makes it "busier than your usual Friday" against a
 * baseline mean of 1.4 — the density claim needs a busy day to be true about, and
 * a scenario built to reach a branch has to reach it honestly.
 */
const CALM_EVENTS = [
  { id: 'c1', title: 'Call with the studio', start: at(19, 0), end: at(19, 30), location: 'Zoom' },
  { id: 'c2', title: 'Pick up the dry cleaning', start: at(20, 0), end: at(20, 20), location: 'Via Mazzini' },
  { id: 'c3', title: 'Supper at Nonna’s', start: at(21, 0), end: at(22, 30), location: 'Sasso' },
  { id: 'c4', title: 'Lock up the studio', start: at(23, 0), end: at(23, 20), location: 'Via Roma 4' },
]

/*
  `url` IS THE DIFFERENCE BETWEEN A TILE AND A DEAD TILE.

  It is set by `youtube.ts#presentable` only for videos whose identity was
  verified against the provider, and the deck now drops the ones without it. v4
  is here to be dropped: without an unopenable video in the fixture, the filter
  that removes it is code no capture has ever exercised.
*/
const VIDEOS = [
  { id: 'v1', title: 'How a jet engine actually starts', channel: 'Real Engineering', seconds: 902, publishedAt: at(12, 0, -1), url: 'https://www.youtube.com/watch?v=v1', thumbnail: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22320%22%20height%3D%22180%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%233A4A5E%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23141A24%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22320%22%20height%3D%22180%22%20fill%3D%22url(%23g)%22%2F%3E%3C%2Fsvg%3E" },
  { id: 'v2', title: 'The lost harbours of the Adriatic', channel: 'Coastal', seconds: 1544, publishedAt: at(9, 0, -2), url: 'https://www.youtube.com/watch?v=v2', thumbnail: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22320%22%20height%3D%22180%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%235E3A44%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23241417%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22320%22%20height%3D%22180%22%20fill%3D%22url(%23g)%22%2F%3E%3C%2Fsvg%3E" },
  { id: 'v3', title: 'Making stock the long way', channel: 'Kitchen Notes', seconds: 611, publishedAt: at(17, 0, -3), url: 'https://www.youtube.com/watch?v=v3', thumbnail: "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22320%22%20height%3D%22180%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%233E5E46%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%2316241A%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22320%22%20height%3D%22180%22%20fill%3D%22url(%23g)%22%2F%3E%3C%2Fsvg%3E" },
  { id: 'v4', title: 'Could not be identified against the provider', channel: 'Unknown', seconds: 300, publishedAt: at(17, 0, -4) },
]

/*
  THE THREE STATES A WATCH CAN BE IN, WHICH USED TO LOOK IDENTICAL.

  Changed recently, running quietly for weeks, and never once managed to run.
  The old depletion rendering drew all three as a bar with a time on it, and
  drew the broken one fullest.
*/
const WATCHES = [
  {
    id: 'w1', what: 'Whether the Avano concert gets moved', why: 'You asked on Tuesday',
    question: 'Has the venue changed?', everyHours: 12, lastRunAt: at(6, 0), nextRunAt: at(18, 0),
    active: true, by: 'user', state: 'No change since Tuesday.', changedAt: null,
    history: [{ at: at(6, 0), text: 'No change since Tuesday.', changed: false }],
  },
  {
    id: 'w2', what: 'The price of the Bologna–Milano fare', why: 'You said tell me if it drops',
    question: 'Has it gone under €25?', everyHours: 6, lastRunAt: at(15, 0), nextRunAt: at(21, 0),
    active: true, by: 'user', state: 'Down to €19.90 on the 07:35 — first time under €25.',
    changedAt: at(15, 0),
    history: [
      { at: at(15, 0), text: 'Down to €19.90 on the 07:35.', changed: true },
      { at: at(9, 0), text: '€31.50, unchanged.', changed: false },
      { at: at(3, 0), text: '€31.50, unchanged.', changed: false },
    ],
  },
  {
    id: 'w3', what: 'Whether the comune publishes the bin calendar', why: 'I started this after the last one lapsed',
    question: 'Is the 2027 calendar up?', everyHours: 24, lastRunAt: null, nextRunAt: null,
    active: true, by: 'agent', state: null, changedAt: null, history: [],
  },
]

/*
  THE LAST DAY HAS NO READING, AND THAT IS THE POINT.

  Every day carried a value, so the one rule Activity exists to prove — a
  missing reading is not a zero — had no failing input anywhere in the gate.
  Today is `null`: the phone has not synced yet. The bar draws as an outline,
  the figure is yesterday's and says so, and nothing is accented, because
  nothing has happened today that anyone can vouch for.
*/
const SERIES = [{
  key: 'steps', label: 'Steps', unit: 'steps', accent: '#7FB3D5',
  days: Array.from({ length: 7 }, (_, i) => ({
    date: at(12, 0, i - 6).slice(0, 10),
    value: i === 6 ? null : 4200 + i * 830,
  })),
}]

/*
  THE BRIEF, NOT JUST THE SERIES.

  `report` is optional on a fitness widget and the fixture never sent one, so
  every capture of Activity was the no-figure path — `—` where the number goes,
  no goal line, no trend, no freshness. The richest object in the application
  was therefore the least exercised one, and the goal chip, the goal rule and
  the staleness treatment had no picture in the gate at all. Shaped exactly as
  `ActivityBrief` in `server/widgets.ts`.
*/
const REPORT = {
  metric: 'steps',
  unit: 'steps',
  says: 'Steadily up all week — yesterday was your best day.',
  current: { day: at(12, 0, -1).slice(0, 10), value: 9180, isToday: false },
  freshness: { today: at(12, 0).slice(0, 10), haveToday: false, todayValue: null, staleDays: 1, level: 'lagging' },
  source: { id: 'health', by: 'only', canSupportGoal: true, available: ['health'] },
  trend: { average: 7180, priorAverage: 6390, changePercent: 12.4, direction: 'up', covered: 7, windowDays: 7 },
  goal: null,
  gap: { missingDays: [at(12, 0).slice(0, 10)], staleDays: 1, lastDay: at(12, 0, -1).slice(0, 10), lastDayLabel: 'yesterday' },
  conflicts: [],
  next: { label: 'Make 7,180 the goal', detail: 'Your seven-day average.', does: 'activity.goal' },
}

/**
 * THE SIX APPLICATIONS, BY THE ID THE FEED ACTUALLY FILES THEM UNDER.
 *
 * These were the NAVIGATION ids — `calendar`, `mail` — and the feed's are the
 * SOURCE ids — `src-calendar`, `src-email`. Two vocabularies for one object, and
 * the fixture spoke the wrong one, so every application tile in every capture
 * was "not connected" no matter what the scenario put in front of it. The
 * harness was therefore unable to see the exact class of bug that the `src`
 * field in `SYSTEM_APPS` exists to prevent, and had in fact already shipped once.
 */
const SYSTEM_ORDER = ['calendar', 'mail', 'places', 'video', 'fitness', 'watch']

const NEEDS = {
  odelia: need({
    id: 'odelia', tier: 'hero', heat: 'hot', heatLabel: 'tomorrow · 11:00',
    /**
     * THE BAND, AS THE SERVER NOW SENDS IT.
     *
     * A computed card carries which of Home's three bands it belongs in — see
     * `attention.ts`'s `bandOf`. The fixture has to carry it too, or the
     * reference picture of Home is a picture of three bands with everything
     * piled into the quietest one, which is not what production looks like and
     * would let a regression in the banding pass unnoticed.
     */
    band: 'now',
    at: at(11, 0, 1),
    title: 'Restaurant with Odelia',
    sub: 'Tomorrow at 11:00 AM. You asked when to leave earlier today.',
    status: 'Tomorrow at 11:00 AM at Via Roma 4.',
    stats: [{ l: 'tomorrow', v: at(11, 0, 1) }],
    chips: ['When should I leave?', 'Who else is coming?'],
    action: { label: 'Set a reminder', done: 'Reminder set' },
    panes: [{ title: 'Calendar', widget: { kind: 'calendar', events: EVENTS, focus: 'e1', view: 'day' } }],
    focus: 'e1',
  }),
  cinzia: need({
    id: 'cinzia', tier: 'ember', heat: 'warm', heatLabel: 'mon · 21:00', band: 'next', at: at(21, 0, 3),
    title: 'Cinzia’s concert in Avano',
    sub: 'Monday at 9:00 PM. The route is already armed.',
    status: 'Monday at 9:00 PM in Avano.',
    stats: [{ l: 'monday', v: at(21, 0, 3) }],
    chips: ['How long is the drive?'],
    panes: [{ title: 'Places', widget: { kind: 'map', places: [{ id: 'p1', label: 'Avano', lat: 44.5, lon: 11.3 }], zoom: 11 } }],
  }),
  /*
    THE SOURCE ROWS CARRY NO `status`, AND THAT IS PRODUCTION'S SHAPE.

    `panes.ts#row` sets `status: ''` for every source need. The fixture set a
    count — "4 this week." — and `Report`'s header draws `status` as the
    subtitle under the application's name, so the visual gate has been capturing
    a header that the real server has never once produced.

    It is also the audit's finding #4. "4 this week." sat above SIX visible
    message rows: two windows, both true, adjacent, reading as a contradiction.
    The fix is not a better number. The header's own comment already states the
    rule — "what survives is what is not recoverable from the surface itself" —
    and a count of the things listed two centimetres below it is the most
    recoverable fact on the screen. The unread count that IS useful is scoped and
    filterable and already exists, as the `Unread 3` chip in Mail's own toolbar.

    Asserted by `scripts/contract.mjs`, so the fixture cannot drift back.
  */
  calendar: need({
    id: 'src-calendar', tier: 'quiet', heat: 'quiet', heatLabel: 'calendar', title: 'Calendar',
    // NOT "at 11 AM — all day". An event is timed or it is all-day; the
    // fixture asserting both was testing the contradiction rather than the
    // contract. See `normaliseEvent` and CONTRACT 12.
    sub: 'Restaurant with Odelia — Sat 11:00',
    stats: [{ l: 'next 7 days', v: '2' }],
    // The card's line names an event, so opening it focuses THAT event. The
    // server sets this the same way (`panes.ts` → focus: nextEvent); a fixture
    // that omitted it was quietly testing a weaker contract than production.
    panes: [{ title: 'Calendar', widget: { kind: 'calendar', events: EVENTS, focus: 'e1', view: 'day' } }],
    focus: 'e1',
  }),
  mail: need({
    id: 'src-email', tier: 'quiet', heat: 'quiet', heatLabel: 'mail', title: 'Mail',
    sub: '4 in the last week from 3 senders. Newest: Your receipt from Anthropic, PBC.',
    stats: [{ l: 'this week', v: '4' }],
    chips: ['Archive the receipts'],
    panes: [{ title: 'Mail', widget: { kind: 'mail', messages: MESSAGES } }],
    focus: 'm1',
  }),
  watch: need({
    id: 'src-keepaneye', tier: 'quiet', heat: 'quiet', heatLabel: 'keep an eye', title: 'Keep an eye',
    sub: '1 watching · 0 pending',
    stats: [{ l: 'watching', v: '1' }],
    panes: [{ title: 'Keep an eye', widget: { kind: 'watch', watches: WATCHES } }],
  }),
  video: need({
    id: 'src-youtube', tier: 'quiet', heat: 'quiet', heatLabel: 'videos', title: 'Videos',
    sub: '3 new from 3 channels',
    stats: [{ l: 'new', v: '3' }],
    panes: [{ title: 'YouTube', widget: { kind: 'video', videos: VIDEOS } }],
  }),
  fitness: need({
    id: 'src-health', tier: 'quiet', heat: 'quiet', heatLabel: 'activity', title: 'Activity',
    sub: '9,180 steps yesterday — above your week',
    stats: [{ l: 'yesterday', v: '9,180' }],
    panes: [{
      title: 'Activity',
      widget: { kind: 'fitness', series: SERIES, report: REPORT },
      /*
        The goal offer, as `panes.ts` builds it when the four conditions hold —
        no goal yet, a trustworthy average, a source that can carry one, and
        enough covered days. The fixture had no pane actions at all, so the one
        capability wired end to end through the deck had never appeared in a
        capture.
      */
      actions: [{
        kind: 'activity.goal', label: 'Make 7,180 the goal', primary: true, setting: true,
        params: { metric: 'steps', target: 7180, unit: 'steps', direction: 'up', source: 'health', description: '7,180 steps a day' },
      }],
    }],
  }),
  places: need({
    id: 'src-map', tier: 'quiet', heat: 'quiet', heatLabel: 'places', title: 'Places',
    sub: 'Avano, 41 minutes away',
    stats: [{ l: 'saved', v: '1' }],
    panes: [{
      title: 'Places',
      widget: {
        kind: 'map',
        places: [
          { id: 'me', label: 'You', lat: 44.49, lon: 11.34, self: true },
          { id: 'p1', label: 'Avano', lat: 44.5, lon: 11.3, sub: '41 min by car' },
          // The hostile name, kept: a marker label is the one string on the map
          // with nothing to push against, so this is where a missing clamp shows.
          { id: 'p2', label: 'San Giovanni in Persiceto, Città metropolitana di Bologna, Emilia-Romagna', lat: 44.64, lon: 11.19, sub: 'Emilia-Romagna' },
        ],
        route: 'drive', searchable: true, zoom: 11,
      },
    }],
  }),
}

/** A transient task that produced nothing: failed, retryable, in the Tasks lane. */
const routePane = {
  paneId: 'pane-route', title: 'Show route to Avano',
  panes: [{ title: 'Route', widget: { kind: 'map', places: [], route: 'drive' } }],
  revisionId: 'rev-1', intent: 'show route to Avano', planClass: 'route',
  summary: 'No route found', pinned: null, canUndo: false, canRedo: false,
  refresh: 'manual', updatedAt: at(17, 40),
}

/** A transient task that produced a result: completed, offering to be kept. */
const donePane = {
  paneId: 'pane-done', title: 'Cheap flights to Palermo',
  panes: [{ title: 'Flights', widget: { kind: 'list', items: [{ id: 'f1', title: '€64 · Wed 06:20' }] } }],
  revisionId: 'rev-2', intent: 'find cheap flights to Palermo', planClass: 'search',
  summary: '3 under €80', pinned: null, canUndo: false, canRedo: false,
  refresh: 'manual', updatedAt: at(16, 10),
}

/** A pane he kept. Lives in the User Panes lane and never expires. */
const savedPane = {
  paneId: 'pane-saved', title: 'Harbour towns worth a weekend',
  panes: [{ title: 'Places', widget: { kind: 'list', items: [{ id: 's1', title: 'Camogli' }, { id: 's2', title: 'Sestri' }] } }],
  revisionId: 'rev-3', intent: 'harbour towns worth a weekend', planClass: 'research',
  summary: '6 places', pinned: 'content', canUndo: false, canRedo: false,
  refresh: 'manual', updatedAt: at(15, 0),
}

/**
 * A genuinely critical event. Recognised by its ID against the closed list in
 * Interrupt.tsx — a producer cannot promote itself into this layer.
 */
const criticalNeed = need({
  id: 'flight.cancelled', tier: 'hero', heat: 'hot', heatLabel: 'now',
  title: 'Your flight tomorrow was cancelled',
  sub: 'BA2604 to Palermo. The airline has not rebooked you.',
  status: 'Cancelled by the airline 20 minutes ago.',
})

const LONG = 'Quarterly planning review with the whole distributed platform team and the two contractors from Avano'

/**
 * THE STRINGS PROVIDERS AND PLACES ACTUALLY PRODUCE.
 *
 * Not invented to be awkward — a real Gmail subject with a reference number in
 * it, and a real Italian comune with its full administrative name. Both are the
 * length the app has to survive on a 375pt screen, and neither had a fixture.
 */
const LONG_SUBJECT =
  'Re: Fwd: [EXTERNAL] Your subscription renewal confirmation and updated tax invoice for the period 01/08/2026–31/08/2026 (ref. 2658-4963-4641-0087)'
const LONG_PLACE =
  'San Giovanni in Persiceto, Città metropolitana di Bologna, Emilia-Romagna'

const base = async (items, { intelligence = INTELLIGENCE, ...over } = {}) => {
  /*
    ENRICHED ONCE, AT THE TOP, AND THE SAME NEEDS GO EVERYWHERE.

    `needs` is what a tapped card resolves through and what every application
    surface renders; `deck` is the Home projection of the same objects. Enriching
    only the deck's copy would put the memory core's line on the card and not in
    the depth behind it — the card/surface disagreement `canonical` exists to
    make impossible, reintroduced by a fixture. So the enrichment happens here
    and both consumers read its result.
  */
  const served = (over.items ?? items).map((i) => (i.need ? { ...i, need: i.need } : i))
  const needs = await enrich(served.flatMap((i) => (i.need ? [i.need] : [])))
  const byId = new Map(needs.map((n) => [n.id, n]))
  const enrichedItems = served.map((i) => (i.need && byId.has(i.need.id) ? { ...i, need: byId.get(i.need.id) } : i))

  return {
    dateLabel: 'Aug 7, 2026',
    clock: '24h',
    place: null,
    readLine: 'Tomorrow brings Odelia and Monday holds Cinzia in Avano. Your routes are ready.',
    ask: { opening: 'What’s on your mind?', chips: ['What’s tomorrow?', 'Anything from Odelia?'] },
    quietLog: ['Archived 2 receipts.', 'Checked the concert venue.'],
    shelf: { items: [], updatedAt: at(17, 40) },
    at: at(17, 59),
    ...over,
    needs,
    items: enrichedItems,
    /*
      After the spread, deliberately: a scenario may override `items`, and the
      deck must be projected from what the scenario actually ends up serving
      rather than from the argument this function was called with.
    */
    deck: deckFor(enrichedItems, intelligence),
  }
}

/**
 * A SUPPORTED SHIFT, AS THE STORE WOULD HOLD IT.
 *
 * The reference finding for the whole intelligence design: his Tuesday
 * departures moved later, detected as a change point rather than as a drifting
 * average, with the split stated (19 of 23) and the evidence enumerable.
 *
 * DELIBERATELY SYNTHETIC, AND THAT IS THE POINT OF §49. The real ledger has
 * thirteen days of evidence and clears none of the coverage bars, so there is no
 * real card to look at — and the honest response to that is a fixture, not a
 * lowered bar. Cognition and the interface are validated separately: this proves
 * the card, and `scripts/memory.mjs` proves the thresholds.
 */
const SHIFT = {
  id: 'hyp:shift:departure:tuesday',
  proposition: {
    kind: 'shift',
    routineId: 'rtn:departure:weekday:2',
    metric: 'departure_minute',
    direction: 'later',
    since: '2026-07-07',
    magnitude: 83,
  },
  support: 19,
  contradiction: 4,
  observationCount: 23,
  evidenceDiversity: 3,
  temporalCoverageDays: 63,
  confidence: 0.82,
  firstObservedAt: '2026-06-15T07:00:00.000Z',
  lastObservedAt: '2026-08-05T09:12:00.000Z',
  status: 'supported',
  evidence: [
    { kind: 'observation', id: 'obs:dep:0731', says: 'You left at 11:48 on Tuesday 31 July' },
    { kind: 'observation', id: 'obs:dep:0724', says: 'You left at 12:02 on Tuesday 24 July' },
    { kind: 'routine', id: 'rtn:departure:weekday:2', says: 'Leaving on a Tuesday, seen on 23 of the last 26' },
    { kind: 'episode', id: 'epi:dep:jul', says: 'Nine Tuesday departures since the change point' },
  ],
  alternatives: [],
  lastEvaluatedAt: '2026-08-07T02:00:00.000Z',
  modelVersion: 1,
}

const DEPARTURE_SUMMARY = {
  id: 'tmp:location:departure_minute:weekday:2',
  domain: 'location',
  metric: 'departure_minute',
  scope: 'weekday:2',
  windowDays: 63,
  samples: [],
  count: 23,
  mean: 700,
  median: 714,
  stdDev: 38,
  priorMean: 631,
  changePercent: 11,
  direction: 'up',
  changePoint: { day: '2026-07-07', before: 631, after: 714, magnitude: 83 },
  computedAt: '2026-08-07T02:00:00.000Z',
  modelVersion: 1,
}

const INTELLIGENCE = presentShift(SHIFT, {
  now: new Date('2026-08-07T17:59:00Z'),
  timeZone: 'Europe/Rome',
  summaryOf: (metric) => (metric === 'departure_minute' ? DEPARTURE_SUMMARY : null),
  routineOf: () => null,
  label: (m) => (m === 'departure_minute' ? 'leaving in the morning' : m),
  verdict: { score: 0.34, surfaced: true },
})

/**
 * ── PHASE 8: WHAT THE MEMORY CORE KNOWS, IN THIS FIXTURE ─────────────────────
 *
 * Raw typed records, in the shapes `server/memory/types.ts` declares, with NO
 * conclusions in them. The summaries carry means and spreads; nothing here says
 * "he is busier on Fridays" or "Avano is a Tuesday habit". Those sentences are
 * `server/domain.ts`'s to produce or to decline, and whether it produces them is
 * what the captures are testing.
 *
 * Chosen so all four compilers have something to bite on and so the interesting
 * SILENT cases are covered as well: Mail's planned episode names one of the six
 * senders and not the other five, and the departure baselines are set so that
 * exactly one of the seven fixture events starts before he is usually out.
 */
const summary = (id, o) => ({
  id, samples: [], priorMean: null, changePercent: null, direction: 'flat',
  changePoint: null, computedAt: '2026-08-07T02:00:00.000Z', modelVersion: 1,
  windowDays: 84, scope: id.split(':').slice(3).join(':'), ...o,
})

/** Friday, weekday 5. Four things on today against a mean of 1.4 — a busy one. */
const CAL_LOAD_FRI = summary('tmp:calendar:events_per_day:weekday:5', {
  domain: 'calendar', metric: 'events_per_day', count: 11, mean: 1.4, median: 1, stdDev: 0.8,
})

/** Thursday, weekday 4 — the day the trusted step figure is actually from. */
const STEPS_THU = summary('tmp:activity:steps:weekday:4', {
  domain: 'activity', metric: 'steps', count: 12, mean: 7200, median: 7050, stdDev: 1400,
})

/**
 * When he is usually out, per weekday. Sunday's is late enough that an 08:30
 * appointment lands before it — which is the one event in this fixture that
 * gets a departure line, and the only one that should.
 */
const DEP_SUN = summary('tmp:location:departure_minute:weekday:0', {
  domain: 'location', metric: 'departure_minute', count: 9, mean: 604, median: 600, stdDev: 41,
})
const DEP_SAT = summary('tmp:location:departure_minute:weekday:6', {
  domain: 'location', metric: 'departure_minute', count: 10, mean: 636, median: 635, stdDev: 33,
})

/**
 * A place entity standing on the Avano pin, and the rhythm learned at it.
 *
 * The coordinate is the SAME one the pin carries, because that is the join —
 * `entities.ts`'s clustering radius, not a name match. Move the pin and the
 * rhythm stops applying, which is the correct behaviour and is why the join is
 * geographic in the first place.
 */
const AVANO = {
  id: 'ent:place:avano', kind: 'place', label: 'Avano', aliases: [],
  identities: ['geo:44.5000,11.3000'], attributes: { lat: 44.5, lon: 11.3 },
  confidence: 0.9, evidence: [], firstObservedAt: '2026-04-06T00:00:00.000Z',
  lastObservedAt: '2026-08-05T00:00:00.000Z', by: 'agent', resolveVersion: 1,
}

const AVANO_ROUTINE = {
  id: 'rtn:place-ent-place-avano', activityType: 'place:ent:place:avano',
  entityRefs: ['ent:place:avano'],
  temporal: { daysOfWeek: [2], recurrenceProbability: 0.76, typicalStartMinutes: 615, startStdDevMinutes: 24 },
  context: {}, confidence: 0.74, evidenceCount: 14, temporalCoverageDays: 96, evidence: [],
  firstObservedAt: '2026-04-06T00:00:00.000Z', lastObservedAt: '2026-08-05T00:00:00.000Z',
  status: 'established', modelVersion: 1,
}

/** Odelia, resolved from the address her mail arrives from, and Saturday's lunch. */
const ODELIA = {
  id: 'ent:person:odelia', kind: 'person', label: 'Odelia', aliases: [],
  identities: ['email:odelia@example.com'], attributes: {}, confidence: 0.95, evidence: [],
  firstObservedAt: '2026-06-01T00:00:00.000Z', lastObservedAt: at(9, 0, -4),
  by: 'agent', resolveVersion: 1,
}

const LUNCH = {
  id: 'epi:2026-08-08:restaurant', type: 'meal', title: 'Restaurant',
  startAt: at(11, 0, 1), endAt: at(13, 0, 1), status: 'planned',
  participantEntityIds: ['ent:person:odelia'], placeEntityIds: [],
  observationIds: [], evidence: [], attributes: {},
  firstAssembledAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z', modelVersion: 1,
}

/**
 * Where the store has seen Avano, as `location_visit` observations.
 *
 * A place entity's identity is usually `place:<the source's key>` and only
 * sometimes `geo:<lat>,<lon>`, so `domain.ts` locates a place from the visits
 * rather than from the entity. This is the real shape of one, minus everything
 * that read does not touch.
 */
const AVANO_VISITS = [
  { id: 'obs:visit:avano:1', type: 'location_visit',
    attributes: { lat: 44.5, lon: 11.3, day: '2026-08-04' },
    entityCandidates: [{ kind: 'place', key: 'place:avano', label: 'Avano', via: 'visit', confidence: 0.95 }] },
]

/**
 * A `MemoryStore`-shaped reader over those records.
 *
 * Only the reads `domain.ts` actually makes are implemented, and this stub
 * SHIPPED WITHOUT `observations` — which cost a silently absent Places line and
 * is the reason the comment below is longer than the object above it.
 *
 * `domainContexts` isolates each domain behind a `try`, so a missing repository
 * is indistinguishable from "the memory core had nothing to say": the rhythm
 * stopped rendering, nothing threw anywhere a human could see it, and the
 * interaction gate's own assertion about that line is the only thing between
 * that and shipping. An absent read here is not a loud failure — it is the
 * quietest one available.
 *
 * So the rule for this object is the same as the rule for the scenarios: it is
 * DATA in the store's real shapes, and every read the compiler makes has one.
 */
const SUMMARIES = [CAL_LOAD_FRI, STEPS_THU, DEP_SUN, DEP_SAT]
const MEMORY = {
  summaries: { byId: (id) => SUMMARIES.find((s) => s.id === id) ?? null },
  routines: { all: () => [AVANO_ROUTINE] },
  entities: {
    ofKind: (k) => (k === 'place' ? [AVANO] : k === 'person' ? [ODELIA] : []),
    byIdentity: (i) =>
      [AVANO, ODELIA].find((e) => e.identities.includes(i)) ??
      (i === 'place:avano' ? AVANO : null),
  },
  observations: { between: (from, to, t) => (t === 'location_visit' ? AVANO_VISITS : []) },
  episodes: { between: (from, to) => (LUNCH.startAt >= from && LUNCH.startAt <= to ? [LUNCH] : []) },
}

/**
 * The posture the captures run at.
 *
 * `entities`, `baselines` and `routines` live; `intelligence` is NOT here, and
 * its absence is the point — the slot-three fixture is compiled directly rather
 * than through the capability map, and production keeps everything shadowed.
 * This is a picture of an app whose domain enrichment has been promoted, which
 * is the thing worth having a picture of.
 */
const POSTURE = { enabled: true, authority: { entities: 'live', baselines: 'live', routines: 'live' } }

/*
  THE COGNITION THE CAPTURES RUN THROUGH — the same seam production uses.

  `enrichPanes` takes a cognition rather than a store now, because the edge's
  ledger is inside a Durable Object and can never hand out a synchronous SQL
  handle. The fixture still has a real local store, so it wraps it in the same
  `cognitionOverStore` both hosts run; what is being captured is therefore the
  production path, not a fixture-shaped imitation of it.
*/
const COGNITION = cognitionOverStore(MEMORY, POSTURE)

const enrich = (needs) =>
  enrichPanes(needs, COGNITION, { now: NOW, timeZone: 'Europe/Rome' })

/** The same split `feed.ts` makes: sources go in the deck, the rest compete for slot two. */
const deckFor = (items, intelligence = INTELLIGENCE) => {
  const needs = items.flatMap((i) => (i.need ? [i.need] : []))
  const sources = needs.filter((n) => n.id.startsWith('src-'))
  const attention = needs.filter((n) => !n.id.startsWith('src-') && n.because)
  const synthesis = needs.filter((n) => !n.id.startsWith('src-') && !n.because)
  return buildDeck(
    sources, attention, synthesis,
    { systemOrder: [], hiddenApps: [] },
    new Date('2026-08-07T17:59:00Z'),
    'Europe/Rome',
    { intelligence },
  )
}

const item = (need, kind = 'source') => ({ id: need.id, kind, need })

const SCENARIOS = {
  normal: () => base([
    item(NEEDS.odelia, 'synthesis'), item(NEEDS.cinzia, 'synthesis'),
    item(NEEDS.calendar), item(NEEDS.mail), item(NEEDS.watch), item(NEEDS.video),
    item(NEEDS.fitness), item(NEEDS.places),
  ]),

  /** Every rail overflowing. Geometry must be identical to `normal`. */
  many: () => base([
    ...[0, 1, 2, 3, 4, 5].map((i) =>
      item(need({ ...NEEDS.odelia, id: `p${i}`, title: `${NEEDS.odelia.title} ${i + 1}` }), 'synthesis')),
    ...[0, 1, 2, 3, 4, 5, 6].map((i) => item(need({ ...NEEDS.mail, id: `q${i}`, title: `Quiet ${i + 1}` }))),
  ]),

  /**
   * A DAY WITH NOTHING COLLIDING ON IT.
   *
   * Exists for one reason: Calendar's foot has two candidates and `normal`
   * always wins with the clash, so the memory core's density line — the whole of
   * Calendar's Phase 8 card contribution — was unreachable from every scenario
   * in this file. A branch no fixture can reach is a branch no gate is testing,
   * which is the failure this fixture has now been extended for three times.
   */
  'calm-day': () => base([
    item(need({
      ...NEEDS.calendar,
      panes: [{ title: 'Calendar', widget: { kind: 'calendar', events: CALM_EVENTS, focus: 'c1', view: 'day' } }],
    })),
    item(NEEDS.mail), item(NEEDS.fitness), item(NEEDS.places),
  ]),

  /** A transient task that produced nothing. It must not own the screen. */
  'failed-task': () => base([
    item(NEEDS.odelia, 'synthesis'), item(NEEDS.calendar), item(NEEDS.mail),
    { id: 'pane-route', kind: 'pane', pane: routePane },
  ]),

  /** All four lanes populated at once — the reference picture of Home. */
  lanes: () => base([
    item(NEEDS.odelia, 'synthesis'), item(NEEDS.cinzia, 'synthesis'),
    item(NEEDS.calendar), item(NEEDS.mail), item(NEEDS.watch), item(NEEDS.video),
    item(NEEDS.fitness), item(NEEDS.places),
    { id: 'pane-saved', kind: 'pane', pane: savedPane },
    { id: 'pane-route', kind: 'pane', pane: routePane },
    { id: 'pane-done', kind: 'pane', pane: donePane },
  ]),

  /**
   * Twenty objects in one lane. The geometry must be byte-identical to `lanes`
   * and the pager must be numeric rather than twenty dots.
   */
  'lane-overflow': () => base([
    ...SYSTEM_ORDER.map((k) => item(NEEDS[k])),
    ...Array.from({ length: 20 }, (_, i) =>
      item(need({ ...NEEDS.odelia, id: `i${i}`, title: `Insight ${i + 1}` }), 'synthesis')),
    /*
      THE SAME BANDS POPULATED AS `lanes`, WITH TWENTY-SIX OBJECTS INSTEAD OF
      THREE.

      That pairing is the whole reason this scenario exists: the cross-capture
      check compares it against `lanes` and demands identical geometry, which
      asserts that HOW MUCH a band holds cannot move the layout. It used to fill
      `now` alone and leave the other two empty, so once an empty band was
      allowed to collapse the comparison was measuring a different SHAPE of Home
      rather than a different amount of content — and reported the collapse
      working correctly as a regression.
    */
    item(NEEDS.cinzia, 'synthesis'),
    { id: 'pane-saved', kind: 'pane', pane: savedPane },
    { id: 'pane-route', kind: 'pane', pane: routePane },
    { id: 'pane-done', kind: 'pane', pane: donePane },
  ]),

  /** A critical interrupt, which must reach him even with chat open. */
  critical: () => base([
    item(criticalNeed, 'synthesis'), item(NEEDS.calendar), item(NEEDS.mail),
  ]),

  'long-title': () => base([
    item(need({ ...NEEDS.odelia, title: LONG, sub: `${LONG} — ${LONG}` }), 'synthesis'),
    item(need({ ...NEEDS.mail, title: LONG, sub: LONG })),
  ]),

  /** Nothing known at all. */
  empty: () => base([], { readLine: '', quietLog: [] }),

  /**
   * THE BLANK SCREEN, as a scenario.
   *
   * Home always draws all six system apps; the feed only sometimes carries a
   * `need` for each of them. Every id in that gap used to render nothing at
   * all — not a crash, not an empty state, an empty document. This is that
   * gap, deliberately: six cards, one backing need.
   */
  'apps-unbacked': () => base([item(NEEDS.calendar)]),

  /**
   * A QUESTION ON HOME. THE SCENARIO THAT DID NOT EXIST.
   *
   * `need()` hardcoded `asks: false` and no fixture ever set `corrections`, so
   * `QuestionCard` — the component the scrollbar was in — was NEVER RENDERED by
   * the gate. Fifty-six green captures, and the one card in the regression
   * screenshot had no capture at all. That is the whole lesson of this scenario:
   * a component with no fixture is a component with no gate, and its absence
   * looks exactly like a pass.
   *
   * Budgeted copy, since this is what the server now sends after `homeCopy.ts`.
   */
  question: () => base([
    item(need({
      id: 'ask:fitness.objective', tier: 'hero', heat: 'warm', heatLabel: 'needs you', band: 'now',
      title: 'What do you want from activity tracking?',
      sub: 'About 2,761 steps/day over the last 7 days.',
      status: 'I am asking because telling you whether 2,761 steps a day is going the way you want needed this and I do not have it. I do not know whether that is you walking more, getting fitter, or simply keeping an eye on your normal level.',
      asks: true,
      corrections: [
        { verb: 'set-preference', label: 'Walk more', key: 'fitness.objective', value: 'walk-more' },
        { verb: 'set-preference', label: 'Cardio fitness', key: 'fitness.objective', value: 'cardio' },
        { verb: 'set-preference', label: 'Keep it steady', key: 'fitness.objective', value: 'maintain' },
        { verb: 'set-preference', label: 'Just watching', key: 'fitness.objective', value: 'observe' },
      ],
    }), 'synthesis'),
    item(NEEDS.calendar), item(NEEDS.mail),
  ]),

  /**
   * THE HOSTILE FIXTURE.
   *
   * Every string at or past the length production can actually produce, all at
   * once: an unbudgeted question, a 60-word baseline, four choices that each
   * wrap, a 100-character Italian place name, a full email subject. Run at the
   * largest supported text size as well as the default.
   *
   * This exists because the same failure has now happened twice for the same
   * reason. The chat handle overflowed the phone because the fixture's opening
   * was 26 characters and production's was 71; the question card grew a
   * scrollbar because no fixture had a question in it. In both cases the gate
   * was correct, thorough, and handed input easier than the real thing. A
   * fixture that is easier than production tests the fixture.
   */
  hostile: () => base([
    item(need({
      id: 'ask:person.relationship', tier: 'hero', heat: 'warm', heatLabel: 'needs you', band: 'now',
      // Deliberately past the copy budget: the CARD must still hold, by
      // reducing what is optional, rather than by growing or scrolling.
      title: 'Who is Maria Annunziata Bevilacqua-Sforza to you, and should I treat her as family?',
      sub: `${LONG_PLACE} — ${LONG_PLACE}. ${LONG_OPENING}`,
      status: `${LONG_OPENING} ${LONG_OPENING}`,
      asks: true,
      corrections: [
        { verb: 'relationship', label: 'Immediate family member', personId: 'x', value: 'family' },
        { verb: 'relationship', label: 'A colleague from work', personId: 'x', value: 'colleague' },
        { verb: 'relationship', label: 'Someone I know socially', personId: 'x', value: 'friend' },
        { verb: 'relationship', label: 'Prefer not to categorise', personId: 'x', value: 'other' },
      ],
    }), 'synthesis'),
    item(need({
      ...NEEDS.mail, id: 'src-email',
      sub: `${LONG_SUBJECT} ${LONG_SUBJECT}`,
      stats: [{ l: 'in the last seven days from five separate senders', v: '4' }],
      panes: [{
        title: 'Mail',
        widget: {
          kind: 'mail',
          messages: MESSAGES.map((m, i) => ({ ...m, subject: i === 0 ? LONG_SUBJECT : m.subject })),
        },
      }],
    })),
    item(need({
      ...NEEDS.places, id: 'src-map', heat: 'warm',
      sub: LONG_PLACE,
      panes: [{
        title: 'Places',
        widget: {
          kind: 'map',
          places: [{ id: 'p1', label: LONG_PLACE, lat: 44.5, lon: 11.3, sub: LONG_PLACE }],
          zoom: 11,
        },
      }],
    })),
  ]),

  /** Mail with an empty mailbox — the surface must survive it. */
  'mail-empty': () => base([
    item(need({
      ...NEEDS.mail, sub: 'Nothing this week', stats: [{ l: 'this week', v: '0' }],
      panes: [{ title: 'Mail', widget: { kind: 'mail', messages: [], empty: 'Nothing here.' } }],
    })),
  ]),
}

let scenario = process.env.CRUCIBLE_FIXTURE ?? 'normal'
const feed = () => (SCENARIOS[scenario] ?? SCENARIOS.normal)()

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname

  /*
    WHICH PROCESS IS ANSWERING.

    A stale fixture left running by hand serves a harness run perfectly happily:
    `freePort` refuses to kill anything that is not an orphan (a port-killer once
    shot a sibling suite, and that restraint is right), the harness's own fixture
    then fails to bind with its stdio ignored, and `waitFor` is satisfied by the
    old one. The run is green, against code from before whatever change is being
    tested — which is how a Places assertion passed twice against a compiler that
    had since stopped producing the line it asserts.

    Nothing here can safely decide to kill that process. What it CAN do is say
    who it is, so the harness fails loudly instead of testing yesterday.
  */
  if (p === '/__id') return json(res, { pid: process.pid })

  if (req.method === 'POST' && p === '/__scenario') {
    const body = await new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)) })
    scenario = JSON.parse(body || '{}').name ?? 'normal'
    // A scenario switch is a fresh start, including the brain in use — otherwise
    // one task's model switch is the next task's starting state.
    active = 'anthropic'
    models.anthropic = 'claude-opus-5'
    models.gemini = 'gemini-2.5-flash'
    return json(res, { ok: true, scenario })
  }

  /*
    SWITCHING THE MODEL IS A STATE CHANGE, AND THE FIXTURE HELD NONE.

    `/api/active` fell through to the catch-all `{ ok: true }` at the bottom of
    this handler, so pressing "Think with this" on Gemini did exactly nothing
    visible: the badge stayed on Anthropic, the header kept saying
    `claude-opus-5`, and there was no way to tell a broken switch from a fixture
    that had never been asked to remember one. Found by pressing it.

    Two lines of state, so the screen behaves like the product. It is not a mock
    of the server's behaviour — it is the smallest amount of memory that makes
    the SCREEN honest, which is what this file is for.
  */
  if (req.method === 'POST' && p === '/api/active') {
    const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)) })
    const wanted = JSON.parse(body || '{}')
    if (wanted.providerId) active = wanted.providerId
    if (wanted.model) models[active] = wanted.model
    return json(res, { ok: true, active, model: models[active] })
  }

  if (p === '/api/providers') {
    /*
      Three shapes, because the settings screen behaves differently in each and
      one of them was broken: a connected provider with several models, a
      connected provider with EXACTLY ONE (which must not be special-cased into
      an immediate selection), and an UNCONNECTED one — expanding which used to
      autofocus a password field and summon the keyboard from what is, to the
      hand, a disclosure triangle.
    */
    return json(res, {
      providers: [
        {
          id: 'anthropic', label: 'Anthropic', hint: 'console.anthropic.com', free: false, configured: true,
          model: models.anthropic,
          models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
        },
        {
          id: 'gemini', label: 'Gemini', hint: 'aistudio.google.com', free: true, configured: true,
          model: models.gemini, models: ['gemini-2.5-flash'],
        },
        {
          id: 'openai', label: 'OpenAI', hint: 'platform.openai.com', free: false, configured: false,
          model: '', models: [],
        },
      ],
      active, routing: 'auto',
    })
  }
  if (p === '/api/home') return json(res, { systemOrder: [], hiddenApps: [], pinnedPanes: [], saved: [], archived: [], dismissed: [], seenAt: {}, updatedAt: at(17, 40) })
  if (p === '/api/feed') return json(res, await feed())
  if (p === '/api/feed/refresh') return json(res, { refreshed: [], failed: [], feed: await feed() })
  if (p === '/api/push/vapid-public') return json(res, { key: null })
  if (p === '/api/say') {
    return json(res, { reply: 'I’ve pulled that up for you.', learned: false, did: 'Pulled 2 new things from Google just now.', didKind: 'telemetry', ui: [] })
  }
  if (p === '/api/act') return json(res, { ok: true, refresh: false })
  /*
    THE CORRECTION ROUTE ANSWERS LIKE THE REAL ONE, in its own words.

    Present because a catch-all `{ ok: true }` is not the same thing: the card
    prints the server's SENTENCE rather than deciding for itself what happened,
    so a fixture that returned a bare ok would leave the capture showing "That
    did not go through." — which is what it did, and which is the honest answer
    to a route that is not there.
  */
  if (p === '/api/intelligence/judge') {
    const raw = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)) })
    const verdict = (() => { try { return JSON.parse(raw || '{}').verdict } catch { return '' } })()
    return json(res, {
      ok: true,
      said:
        verdict === 'wrong'
          ? 'Noted — I have dropped that and I will not work it out again from the same evidence.'
          : verdict === 'useful'
            ? 'Noted.'
            : 'Noted — I will raise this kind of thing less.',
    })
  }
  if (p === '/api/world/tell') return json(res, { ok: true })
  // The reads the settings screen makes. Shaped exactly as src/api.ts declares
  // them — a fixture that answers `{ok:true}` to everything is a fixture that
  // cannot show you the screen you are trying to look at.
  if (p === '/api/sources') return json(res, { sources: [{ id: 'calendar', on: true }, { id: 'email', on: true }, { id: 'health', on: false }, { id: 'youtube', on: true }], curation: 'auto' })
  if (p === '/api/tracks') return json(res, { tracks: [{ id: 'tr1', what: 'Whether the Avano concert gets moved', why: 'You asked on Tuesday', question: null, everyHours: 12, lastRunAt: at(6, 0), active: true, by: 'user' }] })
  if (p === '/api/google/status') return json(res, { configured: true, connected: true, scopes: ['calendar', 'gmail'] })
  if (p === '/api/health') return json(res, { providers: [], synthesis: [] })
  /**
   * WHAT CRUCIBLE BELIEVES, AND WHERE IT CAME FROM.
   *
   * A real payload rather than the `{ok:true}` fall-through below, because the
   * "What I know" section is the screen that makes the traceability rule
   * checkable — and a harness that captures it against a stub is a harness that
   * would not notice it had stopped rendering. One thing of each kind: something
   * he said, something a connector reported, something the app worked out, plus
   * one of each unresolved state.
   */
  if (p === '/api/person/health') return json(res, {
    at: '2026-08-11',
    unresolved: {
      disagreements: [{
        metric: 'steps', scope: '2026-08-11', scopeLabel: 'today', differencePercent: 58, state: 'open',
        readings: [{ source: 'google-fit', value: 4120 }, { source: 'my phone', value: 9800 }],
      }],
      questions: [{ key: 'identity.home', why: 'working out when to leave for the dinner', wanted: 3, before: at(16, 0, 1), asked: 1 }],
      decayed: [{ id: 'b1', statement: 'Pasta is running low', confidence: 0.18, confirmedAt: at(9, 0, -21), confirmedLabel: '21 Jul', contested: undefined }],
    },
    known: [
      { key: 'transport.default', value: 'transit', by: 'user', source: 'user', status: 'user_provided', confidence: 1, at: at(9, 0, -2), atLabel: 'Sunday', freshness: 'recent', bag: 'preferences', disputed: false },
      { key: 'identity.timeZone', value: 'Europe/Rome', by: 'connector', source: 'calendar', status: 'verified', confidence: 0.9, at: at(6, 0), atLabel: 'today', freshness: 'live', bag: 'identity', disputed: false },
      { key: 'source.steps', value: 'google-fit', by: 'agent', source: 'insight', status: 'inferred', confidence: 0.6, at: at(9, 0, -80), atLabel: '23 May', freshness: 'stale', bag: 'preferences', disputed: true },
    ],
    sources: [
      { id: 'calendar', records: 42, newest: at(6, 0), newestLabel: 'today', freshness: 'live', authoritativeFor: [] },
      { id: 'health', records: 7, newest: at(5, 0, -4), newestLabel: 'last Friday', freshness: 'recent', authoritativeFor: ['steps'] },
    ],
    counts: { known: 3, fromHim: 1, stale: 1, observations: 49, beliefs: 4, people: 2, goals: 1 },
  })
  if (p.startsWith('/api/')) return json(res, { ok: true })

  return json(res, { error: 'not found' }, 404)
}).listen(PORT, () => console.log(`fixture on ${PORT} (${scenario})`))
