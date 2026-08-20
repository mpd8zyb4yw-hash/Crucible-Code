#!/usr/bin/env node
/**
 * THE PERSONAL MODEL, ASSERTED END TO END.
 *
 * These are the proofs the brief asked for, and they are written as proofs rather
 * than as unit tests because each one corresponds to a failure that was invisible
 * from the screen:
 *
 *   1. A CORRECTION SURVIVES A CONCURRENT BUILD. He taps "I take the bus" while a
 *      build is geocoding; the build finishes and writes back the document it read
 *      before he tapped. Nothing errors. The correction is simply gone, and he finds
 *      out days later when the app suggests walking again.
 *
 *   2. IT SURVIVES A RELOAD, SYNTHESIS AND A LATER BUILD. `mayReplace` protects a
 *      user fact from being overwritten by an agent — and does nothing at all when
 *      the whole document containing it is replaced by an older copy of itself.
 *
 *   3. AN ANSWER IS A TYPED FACT BEFORE IT IS A SENTENCE. "Do you drive?" → "No"
 *      appears TWICE in his real observation list, as prose, with no queryable fact
 *      anywhere, because the answer was filed as a transcript.
 *
 *   4. NO RELATIONSHIP IS EVER INFERRED. Anna is on the dinner invitation with a
 *      gmail address. That is one line of code away from "Anna is a friend" and from
 *      there one line away from "ask Anna for a lift".
 *
 *   5. "WHAT SHOULD I FOCUS ON THIS WEEK?" CONTAINS NO WRONG DATE, and every line in
 *      it can show its grounds and take a correction.
 *
 * Everything runs against an in-memory world store that implements the full
 * compare-and-set contract, so the concurrency proof exercises the real retry path
 * in `mutateWorld` rather than a simplified stand-in.
 *
 * Run: npm test
 */
import { setWorldStore, memoryWorldStore } from '../server/store.ts'
import { setShelfStore } from '../server/shelf.ts'
import { setHomeStore } from '../server/home.ts'
import { setSnapshotStore } from '../server/feed.ts'
import { mutateWorld, readWorld, writeWorld, migrateWorld, WORLD_VERSION } from '../server/world.ts'
import { readPerson, getFact, SLOTS } from '../server/person.ts'
import { correct, tell, preferences, setGoal, noteReading } from '../server/personRoutes.ts'
import { recordAnswer, slotForReply } from '../server/answer.ts'
import { liftPeople, relationshipOf } from '../server/people.ts'
import { activityReport } from '../server/activity.ts'
import { buildFeed } from '../server/feed.ts'
import { focusThisWeek, renderFocus } from '../server/focus.ts'
import { compose, life, ended, bandOf, bandLimitsFor, BANDS } from '../server/attention.ts'
import { applyCorrection as applyCorrectionDirect } from '../server/correct.ts'
import { weekdayName, relativeDay, dayIn, addDays } from '../server/clock.ts'

let failures = 0
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) return
  failures++
  console.error(`FAIL  ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
const ok = (what, cond, detail = '') => {
  if (cond) return
  failures++
  console.error(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
}

const ROME = 'Europe/Rome'
/** Tuesday 11 August 2026, 09:00 in Rome. The day of his real world model. */
const NOW = new Date('2026-08-11T07:00:00Z')

/**
 * His world, as the real one actually reads.
 *
 * The details are load-bearing rather than decorative: the dinner is 57 km away
 * across a valley, he answered "No" to driving twice, and Anna is on the invitation
 * with a personal address. Every assertion below is about what the app does with
 * exactly this material.
 */
const fixture = () => ({
  version: WORLD_VERSION,
  profile: '',
  timeZone: ROME,
  timeZoneBy: 'device',
  sources: {},
  curation: 'auto',
  beliefs: [],
  tracks: [],
  observations: [
    {
      id: 'said-drive-1',
      source: 'user',
      at: '2026-08-09',
      text: 'While looking at "Do you drive?", he said: No',
    },
    {
      id: 'said-lives',
      source: 'user',
      at: '2026-08-09',
      text: 'Lives in Castiglione dei Pepoli, a mountain village in the Bologna Apennines. No supermarket in the village itself.',
    },
    {
      id: 'gcal-dinner',
      source: 'calendar',
      at: '2026-08-11',
      text: 'Dinner, Anna and Paolo at Osteria del Sole on the 12th at 18:00',
      data: {
        kind: 'event',
        eventId: 'dinner-12',
        summary: 'Dinner, Anna and Paolo',
        start: '2026-08-12T16:00:00Z',
        location: 'Osteria del Sole',
        attendees: [
          { email: 'anna.rossi@gmail.com', name: 'Anna Rossi' },
          { email: 'paolo@example.com', name: 'Paolo Bianchi' },
          { email: 'no-reply@booking.example.com', name: 'Bookings' },
        ],
        organizer: 'anna.rossi@gmail.com',
      },
    },
    {
      id: 'gcal-review',
      source: 'calendar',
      at: '2026-08-11',
      text: 'Design review on the 14th at 08:00',
      data: {
        kind: 'event',
        eventId: 'review-14',
        summary: 'Design review',
        start: '2026-08-14T06:00:00Z',
        location: '',
      },
    },
    {
      id: 'fit-steps',
      source: 'health',
      at: '2026-08-11T05:00:00Z',
      text: 'Step counts for the last week.',
      data: {
        kind: 'steps',
        days: [
          { date: '2026-08-05', steps: 4102 },
          { date: '2026-08-06', steps: 5233 },
          { date: '2026-08-07', steps: 3980 },
          { date: '2026-08-08', steps: 4870 },
          { date: '2026-08-09', steps: 4390 },
          { date: '2026-08-10', steps: 4001 },
          { date: '2026-08-11', steps: 4120 },
        ],
      },
    },
  ],
})

/** A fresh store per section, so no proof depends on the order they run in. */
function install(world = fixture()) {
  const store = memoryWorldStore(world)
  setWorldStore(store)
  // The other stores this app installs per host. Kept in memory and deliberately
  // minimal: a build must not need a filesystem in order to be asserted over.
  let shelf = { items: [], updatedAt: '' }
  setShelfStore({ read: async () => shelf, write: async (s) => { shelf = s } })
  let home = null
  setHomeStore({ read: async () => home, write: async (h) => { home = h } })
  let snap = null
  setSnapshotStore({ read: async () => snap, write: async (f) => { snap = f } })
  return store
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 1 — versioning and migration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A document written before versioning must come forward intact, and a stored zone
 * the runtime cannot parse must be CLEARED rather than kept — a world that claims to
 * know where his days begin while every read silently falls back is the worst of the
 * three possible states.
 */
{
  const v0 = migrateWorld({ profile: 'x', observations: [{ id: 'a', source: 'user', at: '2026-01-01', text: 'hi' }] })
  check('migrate: version stamped', v0.version, WORLD_VERSION)
  check('migrate: observations kept', v0.observations.length, 1)
  check('migrate: person defaults to absent', v0.person, undefined)
  check('migrate: arrays filled in', [v0.beliefs.length, v0.tracks.length], [0, 0])

  const bad = migrateWorld({ timeZone: 'Not/AZone', timeZoneBy: 'device' })
  check('migrate: unusable zone cleared', bad.timeZone, undefined)
  const good = migrateWorld({ timeZone: ROME, timeZoneBy: 'device' })
  check('migrate: usable zone kept', good.timeZone, ROME)

  // Rubbish must not cost him the whole document.
  check('migrate: junk collections survive', migrateWorld({ observations: 'nope', beliefs: 3 }).observations, [])
  check('migrate: nothing at all', migrateWorld(null).version, WORLD_VERSION)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 2 — a correction survives a concurrent build
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE EXACT RACE, REPRODUCED.
 *
 * A slow writer reads the document, waits (as a build waits on a geocoder), then
 * writes. His correction lands in the middle of that. Under the old
 * read-modify-write the slow writer's put destroyed the correction; under
 * `mutateWorld` the conflict is detected and the slow mutation is re-run against the
 * document that actually exists.
 *
 * `store.conflicts` is asserted to be non-zero, because a test that passes without
 * the race having happened proves nothing.
 */
{
  const store = install()

  /**
   * A writer that holds the document across an await, bypassing the in-process
   * queue on purpose — this is what a build on another isolate, or a hand-edit of
   * `world.json`, looks like from here.
   */
  const slowOutsideWriter = async () => {
    const { world, token } = await store.readVersioned()
    const stale = migrateWorld(world)
    await new Promise((r) => setTimeout(r, 30))
    stale.observations.push({ id: 'sync-new', source: 'calendar', at: '2026-08-11', text: 'A newly synced thing' })
    return store.writeIfUnchanged(stale, token)
  }

  const racing = slowOutsideWriter()
  // He taps the chip while that is in flight.
  await new Promise((r) => setTimeout(r, 5))
  const applied = await correct({ verb: 'set-preference', label: 'I take the bus', key: 'transport.default', value: 'transit' })
  check('correction applied', applied.ok, true)

  const wroteStale = await racing
  ok('the stale outside write was REFUSED', wroteStale === false, 'compare-and-set let an older document overwrite a newer one')

  const after = readPerson(await readWorld())
  check('his correction survived the race', getFact(after, 'transport.default')?.value, 'transit')
  check('and it is still his', getFact(after, 'transport.default')?.by, 'user')
}

/**
 * The same race the other way round: many concurrent mutations, none lost.
 *
 * Ten writers each setting a different key. Under whole-document read-modify-write
 * the last one wins and nine are destroyed; through `mutateWorld` all ten are
 * present, because each conflict re-runs its mutation on the newer document.
 */
{
  install()
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      correct({ verb: 'set-preference', label: `k${i}`, key: `test.key${i}`, value: i })
    )
  )
  const p = readPerson(await readWorld())
  const held = Array.from({ length: 10 }, (_, i) => getFact(p, `test.key${i}`)?.value)
  check('ten concurrent corrections all landed', held, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 3 — the correction survives reload, synthesis and a later build
// ─────────────────────────────────────────────────────────────────────────────

{
  install()

  // He corrects two things: how he travels, and which source to trust for steps.
  await correct({ verb: 'set-preference', label: 'I take the bus', key: 'transport.default', value: 'transit' })
  await correct({ verb: 'relationship', label: 'A friend', personId: 'person:anna.rossi@gmail.com', value: 'friend' })

  // Anna does not exist yet — the relationship correction must FAIL honestly rather
  // than inventing a person to attach it to.
  const beforePeople = readPerson(await readWorld())
  check('a relationship for someone unknown is refused', beforePeople.people.length, 0)

  /**
   * A BUILD. Offline, so no model and no network — which is also how the cron path
   * runs. This is the pass that used to destroy the correction: it reads, spends
   * time, and writes back.
   */
  const feed = await buildFeed(await readWorld(), { withoutModel: true, now: NOW.getTime() })
  ok('the build produced a feed', feed.items.length > 0, 'no items at all')

  // RELOAD: a completely fresh read, as the next request would do.
  const reloaded = readPerson(await readWorld())
  check('after a build and a reload, the correction stands', getFact(reloaded, 'transport.default')?.value, 'transit')
  check('and it is still marked as his', getFact(reloaded, 'transport.default')?.by, 'user')

  /**
   * SYNTHESIS, simulated where it matters. The dangerous part of synthesis is not
   * the model call — it is that the call takes seconds, so whatever writes the
   * result back is holding an old document. `applyBeliefs` and `settle` are now
   * narrowed to beliefs and profile for exactly this reason, and this asserts it.
   */
  const stale = await readWorld()
  await new Promise((r) => setTimeout(r, 5))
  await correct({ verb: 'set-preference', label: 'Ask me each time', key: 'clarify.test', value: 'ask' })
  // A synthesis-shaped write, made from the document read BEFORE that correction.
  await mutateWorld((fresh) => {
    fresh.beliefs = [
      { id: 'b1', statement: 'He does not drive', basis: ['said-drive-1'], confidence: 0.9, confirmedAt: NOW.toISOString(), decayPerDay: 0.01 },
    ]
    fresh.profile = stale.profile
  })
  const afterSynthesis = readPerson(await readWorld())
  check('synthesis did not revert the correction', getFact(afterSynthesis, 'transport.default')?.value, 'transit')
  check('nor the one made during it', getFact(afterSynthesis, 'clarify.test')?.value, 'ask')
  check('and the belief landed', (await readWorld()).beliefs.length, 1)

  /**
   * A SECOND BUILD, which is where the rescue pass runs again. `liftFromObservations`
   * re-reads "Do you drive?" every time and tries to write `identity.drives` as
   * `by: 'agent'`; his own answers must be untouched by it.
   */
  await buildFeed(await readWorld(), { withoutModel: true, now: NOW.getTime() })
  const afterSecond = readPerson(await readWorld())
  check('after a second build, still transit', getFact(afterSecond, 'transport.default')?.value, 'transit')

  /**
   * AND THE CORRECTION CHANGES FUTURE BEHAVIOUR, which is the point of all of it.
   * A stored preference nothing reads is not a correction.
   */
  const { modeFor } = await import('../server/plan.ts')
  check('the planner obeys it', modeFor(afterSecond, 'the dinner').value, 'transit')
  check('and says whose decision it was', modeFor(afterSecond, 'the dinner').by, 'user')
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 4 — an answer is a typed fact first and a sentence second
// ─────────────────────────────────────────────────────────────────────────────

{
  install()

  /**
   * The question that was asked twice and answered twice and stored as nothing.
   *
   * The card's id IS the slot — `insight.ts` mints clarification ids as `ask:<key>` —
   * so a freeform "no" typed under that card reaches the right typed field without
   * anything being inferred from his wording.
   */
  const out = await tell({ text: 'no', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  check('the answer was recorded', out.ok, true)

  const p = readPerson(await readWorld())
  const drives = getFact(p, 'identity.drives')
  check('a TYPED fact exists', drives?.value, false)
  check('stored as a boolean, not the string "no"', typeof drives?.value, 'boolean')
  check('and it is HIS, permanently', drives?.by, 'user')
  check('status says he told us', drives?.status, 'user_provided')

  /** The consequence is written at the same moment, not discovered a build later. */
  ok('the transport constraint exists too', p.constraints.some((c) => c.id === 'constraint:does-not-drive'), 'no constraint was derived')
  check('and the constraint is his', p.constraints.find((c) => c.id === 'constraint:does-not-drive')?.by, 'user')

  /** The prose still exists — as HISTORY, beside the fact rather than instead of it. */
  const w = await readWorld()
  const record = w.observations.find((o) => o.id === 'answer-identity-drives')
  ok('a human-readable record was kept', !!record, 'no observation was written')
  ok('and it carries the question', (record?.text ?? '').includes('Do you drive?'), record?.text)

  /**
   * ANSWERING AGAIN REPLACES THE RECORD RATHER THAN APPENDING A SECOND ONE.
   * The duplicate pair in his real world model is exactly what this prevents.
   */
  await tell({ text: 'no', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  const again = await readWorld()
  check('answering twice leaves one record', again.observations.filter((o) => o.id === 'answer-identity-drives').length, 1)

  /** He changes his mind. His own later answer must win over his earlier one. */
  await tell({ text: 'yes', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  const changed = readPerson(await readWorld())
  check('he can change his own answer', getFact(changed, 'identity.drives')?.value, true)
  ok('and the constraint is withdrawn', !changed.constraints.some((c) => c.id === 'constraint:does-not-drive'), 'a stale constraint would rule out driving forever')

  /**
   * AN UNUSABLE ANSWER IS NOT A FACT. "depends" is not a yes and not a no, and
   * storing it as either would be worse than storing nothing.
   */
  install()
  await tell({ text: 'depends', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  const vague = readPerson(await readWorld())
  check('an ambiguous answer stores no boolean', getFact(vague, 'identity.drives'), undefined)
  ok('but it is recorded as asked', !!vague.asked['identity.drives'], 'the question would be asked again immediately')

  /**
   * A CHOICE IS STORED AS ITS VALUE, NOT ITS LABEL. He taps "Bus or train"; the
   * planner reads `transit`, so improving the wording cannot break the behaviour.
   */
  install()
  await tell({ text: 'Bus or train', slot: 'transport.default', inReplyTo: SLOTS['transport.default'].question })
  check('the label became the value', getFact(readPerson(await readWorld()), 'transport.default')?.value, 'transit')
}

/**
 * THE SLOT IS NEVER GUESSED FROM HIS WORDS.
 *
 * This is the guard that stops `slotForReply` from becoming `liftFromObservations`
 * in a new location: with nothing outstanding and no card, a sentence that plainly
 * mentions the bus must NOT be filed as a transport preference.
 */
{
  const p = readPerson({ person: undefined })
  check('no card, nothing asked: no slot', slotForReply(p, {}), null)
  check('prose is not matched on', slotForReply(p, { question: 'I take the bus into town' }), null)
  check('a card id IS matched on', slotForReply(p, { cardId: 'ask:transport.default' }), 'transport.default')

  const bare = recordAnswer(p, { text: 'I take the bus into town' })
  check('an unslotted answer writes no fact', bare.touched, [])
  ok('but is still kept as history', bare.observation.text.includes('bus'), bare.observation.text)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 5 — people are lifted, relationships are never inferred
// ─────────────────────────────────────────────────────────────────────────────

{
  install()
  const w = await readWorld()
  const p = readPerson(w)
  const run = liftPeople(p, w)

  const anna = p.people.find((x) => x.name === 'Anna Rossi')
  ok('Anna was lifted from the invitation', !!anna, `people: ${JSON.stringify(p.people.map((x) => x.name))}`)
  check('with the address the record gave', anna?.contact?.email, 'anna.rossi@gmail.com')
  check('with the record as her provenance', anna?.basis, ['gcal-dinner'])
  check('and as an agent-made record, not his', anna?.by, 'agent')

  /**
   * THE CENTRAL ASSERTION OF THIS FILE.
   *
   * Anna is on a dinner invitation with a gmail address. Neither of those is evidence
   * of what she is to him, and both are one line of code away from claiming to be.
   */
  check('NO relationship was inferred from attendance', anna?.relationship, undefined)
  check('NO relationship was inferred from the address', relationshipOf(anna), null)
  check('and no roles were invented', anna?.roles, [])
  for (const person of p.people) {
    check(`nobody has a relationship yet: ${person.name}`, person.relationship, undefined)
  }

  /** A mailbox is not a person. */
  ok('the no-reply address was skipped', !p.people.some((x) => (x.contact?.email ?? '').startsWith('no-reply')), 'a booking robot became a person')
  ok('and the skip was reported', run.skipped.some((s) => /mailbox/.test(s.why)), JSON.stringify(run.skipped))

  /** HE says who she is, and that is the only way it can happen. */
  w.person = p
  await writeWorld(w)
  const said = await correct({ verb: 'relationship', label: 'A friend', personId: anna.id, value: 'friend' })
  check('his answer was accepted', said.ok, true)
  const after = readPerson(await readWorld())
  const annaAfter = after.people.find((x) => x.id === anna.id)
  check('the relationship is now known', relationshipOf(annaAfter)?.value, 'friend')
  check('because he said so', relationshipOf(annaAfter)?.status, 'user_provided')
  check('and it is locked to him', annaAfter?.by, 'user')

  /**
   * A LATER LIFT MUST NOT UNDO IT. Every calendar sync re-reads the same attendee
   * list; if enrichment could touch a record he has corrected, his answer would last
   * exactly until the next pull.
   */
  liftPeople(after, await readWorld())
  check('a re-lift leaves his relationship alone', relationshipOf(after.people.find((x) => x.id === anna.id))?.value, 'friend')

  /** A single mail sender is not yet someone in his life. */
  const mailOnly = readPerson({ person: undefined })
  liftPeople(mailOnly, {
    observations: [
      { id: 'm1', source: 'email', at: '2026-08-10', text: '', data: { kind: 'email', messageId: 'm1', from: 'someone@shop.example', fromName: 'Marco Neri', subject: 'x' } },
    ],
  })
  check('one message does not make a person', mailOnly.people.length, 0)
  liftPeople(mailOnly, {
    observations: [
      { id: 'm1', source: 'email', at: '2026-08-10', text: '', data: { kind: 'email', messageId: 'm1', from: 'someone@shop.example', fromName: 'Marco Neri', subject: 'x' } },
      { id: 'm2', source: 'email', at: '2026-08-11', text: '', data: { kind: 'email', messageId: 'm2', from: 'someone@shop.example', fromName: 'Marco Neri', subject: 'y' } },
    ],
  })
  check('two do', mailOnly.people.length, 1)
  check('still with no relationship', mailOnly.people[0]?.relationship, undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 6 — Activity is about the goal, and refuses when it cannot be
// ─────────────────────────────────────────────────────────────────────────────

{
  install()

  /** With no goal, the surface must decline to call the numbers good or bad. */
  {
    const w = await readWorld()
    const r = activityReport({ ...w, person: readPerson(w) }, readPerson(w), { now: NOW })
    check('the only source is used without a choice', r.source.by, 'only')
    check('the current figure is today\'s', r.current?.value, 4120)
    check('the average names its window', r.trend.covered, 7)
    check('no goal, no progress', r.goal, null)
    ok('and it says so rather than judging', /do not know what you are aiming for/i.test(r.says), r.says)
    check('the next action is to ask what it is for', r.next.does.kind, 'set-goal')
  }

  /** He states one. Now the same numbers mean something. */
  await setGoal({ description: 'Walk more', metric: 'steps', target: 8000, unit: 'steps', direction: 'up', timeframe: 'this month' })
  {
    const w = await readWorld()
    const p = readPerson(w)
    const r = activityReport({ ...w, person: p }, p, { now: NOW })
    ok('progress is measured', !!r.goal, 'no goal progress computed')
    check('against his target', r.goal?.target, 8000)
    check('in his direction', r.goal?.direction, 'up')
    check('and it is not met', r.goal?.met, false)
    ok('the bar is a real fraction', r.goal.fraction > 0.4 && r.goal.fraction < 0.7, String(r.goal.fraction))
    /*
      THE GAP IS STATED, AND WHILE THE DAY IS RUNNING IT IS STATED AS DISTANCE.

      This asserted "short of your 8,000" and the assertion's intent — that the
      sentence relates the numbers to the goal — is unchanged. What changed is
      that a shortfall against a DAILY target is a verdict, and at 4,120 steps
      with the day still going there is nothing to deliver a verdict on yet. The
      figure and the target both survive; only the framing moves. See `briefSays`.

      The case that forced it was his: "0 steps today … 425 short of your 3,221",
      drawn at 10:00 from a sync taken at 08:00.
    */
    ok('the sentence states the gap', /[\d,]+ to go to your 8,000/.test(r.says), r.says)
  }

  /**
   * A 'down' goal must not report an overshoot as an achievement. Someone reducing
   * load while an injury heals is MISSING a ceiling of 3,000 at 4,400 steps, and a
   * bar that filled as he went over would report his setback as progress.
   */
  {
    install()
    await setGoal({ description: 'Take it easy while my knee heals', metric: 'steps', target: 3000, unit: 'steps', direction: 'down' })
    const w = await readWorld()
    const p = readPerson(w)
    const r = activityReport({ ...w, person: p }, p, { now: NOW })
    check('a ceiling goal is not met when he is over it', r.goal?.met, false)
    ok('and the bar is not full', r.goal.fraction < 1, String(r.goal.fraction))
    ok('the sentence says "over", not "short"', /over your ceiling/.test(r.says), r.says)
  }

  /**
   * TWO SOURCES DISAGREE. There is then NO current value — not the higher, not the
   * newer, not the connector's. The surface renders the reason in its place.
   */
  {
    install()
    await setGoal({ description: 'Walk more', metric: 'steps', target: 8000, unit: 'steps', direction: 'up' })
    await noteReading({ metric: 'steps', day: '2026-08-11', value: 10347, source: 'my phone' })
    const w = await readWorld()
    const p = readPerson(w)
    // The conflict is detected by the insight pass, which is what writes it onto the
    // person — so the report is asked AFTER a build, as it would be in life.
    await buildFeed(w, { withoutModel: true, now: NOW.getTime() })
    const w2 = await readWorld()
    const p2 = readPerson(w2)
    ok('the disagreement was recorded', p2.conflicts.some((c) => c.metric === 'steps' && c.state === 'open'), JSON.stringify(p2.conflicts))
    const r = activityReport({ ...w2, person: p2 }, p2, { now: NOW })
    check('the source is disputed', r.source.by, 'disputed')
    check('so there is NO current figure', r.current, null)
    check('and no goal progress over disputed numbers', r.goal, null)
    check('the next action is to rule on it', r.next.does.kind, 'choose-source')
    ok('the sentence names both readings', /10,347/.test(r.says) && /4,120/.test(r.says), r.says)

    /** He rules. The figure comes back, from the source he named. */
    await correct({ verb: 'prefer-source', label: 'Use my phone', metric: 'steps', source: 'my phone' })
    const w3 = await readWorld()
    const p3 = readPerson(w3)
    const r3 = activityReport({ ...w3, person: p3 }, p3, { now: NOW })
    check('his chosen source is used', r3.source.id, 'my phone')
    check('by his choice', r3.source.by, 'chosen')
    /**
     * AND THE CONSEQUENCE IS STATED. He named a source that reaches the app as one
     * typed number, so it cannot carry a trend or a goal — and the old behaviour was
     * that activity reporting silently vanished.
     */
    check('a one-reading source cannot support a goal', r3.source.canSupportGoal, false)
    ok('and it says so plainly', /not enough to show a trend|nothing from it has reached me/i.test(r3.source.why ?? ''), r3.source.why)
  }

  /** DATA THAT STOPPED is not a quiet week. */
  {
    const world = fixture()
    world.observations = world.observations.map((o) =>
      o.id === 'fit-steps'
        ? { ...o, data: { ...o.data, days: o.data.days.filter((d) => d.date <= '2026-08-07') } }
        : o
    )
    install(world)
    const w = await readWorld()
    const p = readPerson(w)
    const r = activityReport({ ...w, person: p }, p, { now: NOW })
    check('the gap is counted on his calendar', r.gap.staleDays, 4)
    check('and the last day is named', r.gap.lastDay, '2026-08-07')
    /**
     * THE SENTENCE SAYS THE FEED STOPPED, IN WORDS HE WOULD USE.
     *
     * This used to assert `/Nothing since 2026-08-07/` — and it passed, which is
     * how an ISO date came to be printed on his home screen in an app whose whole
     * previous pass was about `clock.ts` owning every date. The machine date is
     * still on `gap.lastDay` for anything that computes with it; nothing that
     * SPEAKS may reach for it, so the assertion is now the negative one as well.
     */
    ok('the sentence says the feed stopped', /Nothing since last Friday/.test(r.says), r.says)
    ok('and says how far behind it is', /4 days with nothing recorded/.test(r.says), r.says)
    ok('with no machine date anywhere in it', !/\d{4}-\d{2}-\d{2}/.test(r.says), r.says)
    ok('nor in the next action it offers', !/\d{4}-\d{2}-\d{2}/.test(`${r.next.label} ${r.next.detail}`), `${r.next.label} — ${r.next.detail}`)
    check('the day is carried in his vocabulary beside the machine one', r.gap.lastDayLabel, 'last Friday')
    /** Today, the newest trusted day and the trend are three different things. */
    check('there is no reading for today', r.freshness.haveToday, false)
    check('and the surface is told to say so loudly', r.freshness.level, 'stale')
    check('the newest figure knows it is not today\'s', r.current.isToday, false)
    check('the action is to fill it in', r.next.does.kind, 'enter-reading')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 7 — attention owns lifecycle
// ─────────────────────────────────────────────────────────────────────────────

{
  const item = (over) => ({
    id: 'x',
    kind: 'obligation',
    title: 't',
    detail: 'd',
    because: { sentence: '', grounds: [] },
    basis: [],
    corrections: [],
    scores: { relevance: 1, confidence: 1, urgency: 1, actionability: 1, novelty: 1, fit: 1 },
    score: 0,
    life: over,
  })

  const dinner = '2026-08-12T16:00:00Z'
  check('a future obligation is live', ended(item(life.until(dinner, 'dinner')), NOW), null)
  ok('it is over once the instant passes', !!ended(item(life.until(dinner, 'dinner')), new Date('2026-08-12T17:00:00Z')), 'a passed event stayed on screen')
  /** The grace window: still the most relevant thing to say for a quarter hour. */
  check('and it lingers briefly, saying he is late', ended(item(life.until(dinner, 'dinner')), new Date('2026-08-12T16:05:00Z')), null)

  /** A conflict does not become acceptable by being ignored. */
  check('an answered-lifecycle item never times out', ended(item(life.answered('the disagreement')), new Date('2030-01-01T00:00:00Z')), null)
  check('nor does a recomputed one', ended(item(life.recompute('the shortfall')), new Date('2030-01-01T00:00:00Z')), null)
  /** Model prose does go stale on the clock. */
  ok('a timer item expires', !!ended(item(life.stale(12, 'this note', NOW)), new Date('2026-08-12T09:00:00Z')), 'prose lived forever')

  /** Composition WITHDRAWS rather than ranking something that is over. */
  const p = readPerson({ person: undefined })
  const past = { ...item(life.until('2026-08-10T10:00:00Z', 'yesterday\'s thing')), id: 'past', at: '2026-08-10T10:00:00Z' }
  const future = { ...item(life.until(dinner, 'the dinner')), id: 'future', at: dinner }
  const composed = compose([past, future], p, { now: NOW })
  check('only the live item surfaces', composed.surface.map((x) => x.id), ['future'])
  check('and the withdrawal is explained', composed.withdrawn.map((x) => x.id), ['past'])
  ok('with a reason, not silently', /has passed/.test(composed.withdrawn[0].why), composed.withdrawn[0].why)

  /**
   * His volume preference bounds the screen, not just the ordering — and it now
   * bounds it BAND BY BAND. Asserted as the property rather than as two magic
   * totals, because the totals move whenever the split does and a test that
   * pins them fails for a reason nobody cares about.
   */
  const many = Array.from({ length: 10 }, (_, i) => ({ ...future, id: `i${i}` }))
  const pref = (v) => readPerson({ person: { preferences: { 'assistant.proactivity': { key: 'assistant.proactivity', value: v, source: 'user', sourceAt: '', updatedAt: '', confidence: 1, status: 'user_provided', by: 'user' } } } })
  const quiet = compose(many, pref('low'), { now: NOW })
  const loud = compose(many, pref('high'), { now: NOW })
  ok('"only when it matters" means a shorter screen', quiet.surface.length < loud.surface.length, `${quiet.surface.length} vs ${loud.surface.length}`)
  check('every item lands in exactly one band', BANDS.flatMap((b) => quiet.bands[b]).length, quiet.surface.length)
  for (const [band, cap] of Object.entries(bandLimitsFor(pref('low')))) {
    ok(`the "${band}" band respects his volume`, quiet.bands[band].length <= cap, `${quiet.bands[band].length} > ${cap}`)
  }
  /** The dinner is 33 hours out: context for what is coming, not an interruption. */
  check('a day-out obligation is context, not an alarm', bandOf(future, NOW), 'next')
  check('and once it is hours away it interrupts', bandOf({ ...future, at: '2026-08-11T14:00:00Z' }, NOW), 'now')
  /**
   * THE BUG THE BANDS EXIST TO FIX. Five things needing him today used to fill
   * the single global limit, so a genuinely useful item further out was reported
   * as "Home was already full" and never seen.
   */
  const busy = [
    ...Array.from({ length: 6 }, (_, i) => ({ ...future, id: `urgent${i}`, at: '2026-08-11T10:00:00Z', life: life.until('2026-08-11T10:00:00Z', 'a thing today') })),
    { ...future, id: 'thursday' },
  ]
  ok(
    'a busy morning does not empty the part of the screen about what is coming',
    compose(busy, pref('high'), { now: NOW }).bands.next.some((x) => x.id === 'thursday'),
    'the item further out was crowded out by today'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 8 — assistant preferences are reachable from the product
// ─────────────────────────────────────────────────────────────────────────────

{
  install()
  const before = await preferences()
  ok('the settable slots are offered', before.slots.length >= 2, JSON.stringify(before.slots.map((s) => s.key)))
  ok('proactivity is one of them', before.slots.some((s) => s.key === 'assistant.proactivity'), '')
  ok('clarification behaviour is another', before.slots.some((s) => s.key === 'assistant.clarification'), '')
  /** Not said is distinct from having chosen the middle option. */
  check('nothing is pre-selected', before.slots.map((s) => s.value), before.slots.map(() => null))
  ok('each says what answering changes', before.slots.every((s) => !!s.unlocks), '')
  ok('and offers real options', before.slots.every((s) => s.options.length >= 2), '')

  await correct({ verb: 'set-preference', label: 'Only when it matters', key: 'assistant.proactivity', value: 'low' })
  const after = await preferences()
  check('his choice is held', after.slots.find((s) => s.key === 'assistant.proactivity')?.value, 'low')
  check('and marked as his', after.slots.find((s) => s.key === 'assistant.proactivity')?.by, 'user')

  /** And it changes behaviour, which is the only test that matters. */
  const { clarificationStyleOf, proactivityOf } = await import('../server/person.ts')
  const p = readPerson(await readWorld())
  check('the ranker reads it', proactivityOf(p), 'low')
  await correct({ verb: 'set-preference', label: 'Just make a guess', key: 'assistant.clarification', value: 'assume' })
  check('and the clarification style', clarificationStyleOf(readPerson(await readWorld())), 'assume')
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 9 — "What should I focus on this week?"
// ─────────────────────────────────────────────────────────────────────────────

{
  install()
  await tell({ text: 'no', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  await setGoal({ description: 'Walk more', metric: 'steps', target: 8000, unit: 'steps', direction: 'up' })
  // A build first, so people are lifted and conflicts detected as they would be.
  await buildFeed(await readWorld(), { withoutModel: true, now: NOW.getTime() })

  const f = await focusThisWeek(await readWorld(), { now: NOW, offline: true })

  /** THE WEEK ITSELF, computed rather than recalled. */
  check('the week is his', [f.week.from, f.week.to], ['2026-08-10', '2026-08-16'])
  check('the rest of it starts today', f.remaining.from, '2026-08-11')

  /**
   * EVERY DATE PHRASE IN THE ANSWER IS RE-DERIVED AND CHECKED.
   *
   * This is the assertion behind "without a single incorrect date". Every named day
   * in the structure is recomputed from `clock.ts` independently and compared.
   */
  for (const d of f.week.days) {
    check(`focus week ${d.day} weekday`, d.weekday, weekdayName(d.day))
    check(`focus week ${d.day} relative`, d.relative, relativeDay(d.day, NOW, ROME))
  }
  for (const d of f.days) {
    check(`focus day ${d.day} weekday`, d.weekday, weekdayName(d.day))
    check(`focus day ${d.day} relative`, d.relative, relativeDay(d.day, NOW, ROME))
    for (const i of d.items) {
      check(`item ${i.id} sits on its own day`, i.day, d.day)
    }
  }

  /**
   * NO WEEKDAY NAME ANYWHERE IN THE PROSE MAY CONTRADICT THE CALENDAR.
   *
   * Scanned rather than trusted: the answer is assembled from many builders, and one
   * of them printing "Thursday" about the 12th is exactly the failure that made the
   * whole model-authored approach untenable.
   */
  const prose = renderFocus(f)
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const isoMentions = [...prose.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1])
  for (const iso of isoMentions) {
    /**
     * Where an ISO date and a weekday appear on the same line, they must agree.
     * "tomorrow (Wednesday 2026-08-12)" is the shape `renderFocus` produces.
     */
    const line = prose.split('\n').find((l) => l.includes(iso)) ?? ''
    const named = DAYS.find((d) => line.includes(d))
    if (named) check(`prose: ${iso} on the same line as a weekday`, named, weekdayName(iso))
  }
  /** "today"/"tomorrow" must mean the days they actually are. */
  const todayLine = f.days.find((d) => d.relative === 'today')
  if (todayLine) check('"today" is today', todayLine.day, dayIn(NOW, ROME))
  const tomorrowLine = f.days.find((d) => d.relative === 'tomorrow')
  if (tomorrowLine) check('"tomorrow" is tomorrow', tomorrowLine.day, addDays(dayIn(NOW, ROME), 1))

  /**
   * EVERY RECOMMENDATION CAN SHOW ITS GROUNDS AND TAKE A CORRECTION.
   *
   * Both halves asserted per item, because either alone is not enough: grounds
   * without a correction is a claim he cannot argue with, and a correction without
   * grounds is a button whose effect he cannot predict.
   */
  const all = [...f.days.flatMap((d) => d.items), ...f.standing]
  ok('the week has something in it', all.length > 0, JSON.stringify(f.summary))
  for (const i of all) {
    ok(`"${i.headline}" states why`, !!i.because?.sentence, '')
    ok(`"${i.headline}" points at real grounds`, (i.because?.grounds ?? []).length > 0, '')
    ok(`"${i.headline}" can be corrected`, (i.corrections ?? []).length > 0, '')
    for (const g of i.because.grounds) {
      ok(`ground on "${i.headline}" names its kind`, !!g.kind && !!g.says, JSON.stringify(g))
    }
  }

  /**
   * AND A CORRECTION FROM THAT SCREEN CHANGES FUTURE BEHAVIOUR.
   *
   * Taken from the answer itself rather than hand-written, so this asserts the chips
   * he can actually see are the ones that work.
   */
  /**
   * Taken from the answer itself rather than hand-written, so this asserts that the
   * chips he can actually SEE are the ones that work. Whichever verb the screen
   * happens to offer, applying it has to land and has to change the stored model —
   * a correction that reports success and changes nothing is the exact failure
   * `correct.ts` was written to make impossible.
   */
  const chips = all.flatMap((i) => i.corrections)
  ok('the screen offers something correctable', chips.length > 0, '')
  const chip = chips.find((c) => c.verb === 'not-relevant') ?? chips[0]
  const before = readPerson(await readWorld()).updatedAt
  const applied = await correct(chip)
  check(`the chip "${chip.label}" was applied`, applied.ok, true)
  const p = readPerson(await readWorld())
  ok('and the stored model moved', p.updatedAt !== before, `updatedAt stayed ${before}`)
  if (chip.verb === 'not-relevant') {
    check('the dislike is recorded as his', getFact(p, `dislike.${chip.about}`)?.by, 'user')
    /**
     * AND IT CHANGES FUTURE BEHAVIOUR. `fitOf` reads exactly this key, so the same
     * item must score lower on the next pass — a stored preference nothing consults
     * is not a correction.
     */
    const { fitOf } = await import('../server/attention.ts')
    ok('and the ranker obeys it', fitOf(p, 'goal-slipping', chip.about) < 0.1, String(fitOf(p, 'goal-slipping', chip.about)))
  }
  const after = await focusThisWeek(await readWorld(), { now: NOW, offline: true })
  ok('the answer is recomputed against it', !!after.summary, '')

  /** A truncated list must never read as complete. */
  ok('anything left out is reported', Array.isArray(f.held), '')
}

/**
 * A QUIET WEEK IS AN ANSWER, and the model version could never give it.
 */
{
  install({ ...fixture(), observations: [] })
  const f = await focusThisWeek(await readWorld(), { now: NOW, offline: true })
  check('nothing dated', f.days.length, 0)
  ok('and it says so honestly', /Nothing in what I can see needs you/.test(f.summary), f.summary)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 10 — the people-aware journey
// ─────────────────────────────────────────────────────────────────────────────

{
  install()
  // He does not drive, so the 57 km dinner cannot be walked. Anna is on the invite.
  await tell({ text: 'no', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  await correct({ verb: 'set-preference', label: 'I take the bus', key: 'transport.default', value: 'transit' })

  const w = await readWorld()
  const p = readPerson(w)
  liftPeople(p, w)
  w.person = p
  await writeWorld(w)

  const { planTravel } = await import('../server/plan.ts')
  const { buildInsights } = await import('../server/insight.ts')

  /**
   * OFFLINE, which means no geocoding and therefore no route — so this asserts the
   * one thing that must hold whatever the network does: the app does not claim
   * anyone gives him lifts, and nothing about Anna's relationship is invented.
   */
  const p2 = readPerson(await readWorld())
  const run = await buildInsights(await readWorld(), p2, { now: NOW, offline: true })
  const invented = p2.people.filter((x) => relationshipOf(x))
  check('no relationship appeared during a build', invented.length, 0)
  const claimsLift = [...run.ranked.surface, ...run.ranked.held.map((h) => h.item)].filter((a) =>
    /gives (me|him) (a )?lift|will drive (me|him)|is driving (me|him)/i.test(`${a.title} ${a.detail}`)
  )
  check('and nothing claimed a lift', claimsLift.length, 0)

  /**
   * The demand-driven relationship question must be phrased with her NAME, and its
   * chips must be the `relationship` verb — a `set-preference` under a key nothing
   * reads would be a control that does nothing.
   */
  const { demandRelationship } = await import('../server/people.ts')
  const anna = p2.people.find((x) => x.name === 'Anna Rossi')
  /**
   * With the event's start passed as the deadline, so this question can out-rank the
   * chronic ones. Without it a relationship question competes purely on how many
   * things have wanted the answer — once — and loses the single Home slot forever to
   * a gap re-demanded on every build. See `demand`.
   */
  demandRelationship(p2, anna, 'getting to the dinner', '2026-08-12T16:00:00Z')
  const run2 = await buildInsights(await readWorld(), p2, { now: NOW, offline: true })
  const asking = [...run2.ranked.surface, ...run2.ranked.held.map((h) => h.item)].find((a) => a.id === `ask:person.${anna.id}.relationship`)
  ok('the question about her is asked', !!asking, JSON.stringify(run2.ranked.surface.map((a) => a.id)))
  ok('by name', (asking?.title ?? '').includes('Anna Rossi'), asking?.title)
  ok('and its chips actually set a relationship', (asking?.corrections ?? []).every((c) => c.verb === 'relationship'), JSON.stringify(asking?.corrections))
  check('pointed at her', asking?.corrections?.[0]?.personId, anna.id)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 10b — the data-health view: what is believed, where it came from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The screen that makes the architectural rule checkable rather than merely
 * asserted. Two properties are tested: everything the model holds is REACHABLE
 * with its provenance, and the unflattering parts are not hidden.
 */
{
  install()
  const { dataHealth } = await import('../server/health.ts')

  await tell({ text: 'no', cardId: 'ask:identity.drives', inReplyTo: 'Do you drive?' })
  await correct({ verb: 'set-preference', label: 'I take the bus', key: 'transport.default', value: 'transit' })
  /** Two sources for one metric, on one day, far enough apart to be material. */
  await noteReading({ metric: 'steps', day: '2026-08-11', value: 9800, source: 'my phone' })

  const w = await readWorld()
  const p = readPerson(w)
  const { detectConflicts } = await import('../server/person.ts')
  const { readingsFrom } = await import('../server/insight.ts')
  p.conflicts = detectConflicts(readingsFrom(w, p, NOW), p.conflicts, NOW)

  const h = dataHealth(w, p, NOW)

  /** Everything he told us is here, marked as his, with the day he said it. */
  const bus = h.known.find((k) => k.key === 'transport.default')
  ok('what he told me is listed', !!bus, JSON.stringify(h.known.map((k) => k.key)))
  check('and attributed to him', bus.by, 'user')
  /*
    THE PROPERTY IS "SPOKEN BY clock.ts", NOT "ONE OF THESE THREE WORDS".

    The old pattern was `today|yesterday|[A-Z][a-z]+`, and it failed on every day
    after 2026-08-11 for a reason that had nothing to do with the code under
    test: `correct()` stamps the fact with the REAL clock while this file pins
    `NOW` to a fixed instant, so from the eleventh's point of view the fact was
    written tomorrow — a correct rendering of a date the test itself created.
    Enumerating vocabulary was the mistake; the assertion is that the label is
    whatever `clock.ts` says for that day, which is the actual rule.
  */
  ok(
    'with the day in his vocabulary',
    bus.atLabel === relativeDay(bus.at.slice(0, 10), NOW, 'Europe/Rome'),
    `${bus.atLabel} (fact written ${bus.at.slice(0, 10)}, asserted against ${NOW.toISOString().slice(0, 10)})`,
  )
  ok('and no machine date on the label', !/\d{4}-\d{2}-\d{2}/.test(bus.atLabel), bus.atLabel)

  /** The unflattering part is present and first. */
  ok('an unresolved disagreement is reported', h.unresolved.disagreements.length > 0, JSON.stringify(h.unresolved))
  ok(
    'with both numbers, rather than a characterisation of them',
    h.unresolved.disagreements[0].readings.length === 2,
    JSON.stringify(h.unresolved.disagreements[0])
  )
  ok('and open questions are listed too', Array.isArray(h.unresolved.questions), '')
  /**
   * NO MACHINE DATE ANYWHERE ON THIS SCREEN. It shipped once reading "58% apart,
   * for 2026-08-11" — an ISO date on the one screen whose entire subject is
   * whether the app's records can be trusted.
   */
  ok(
    'the disagreement names its day the way he would',
    !/\d{4}-\d{2}-\d{2}/.test(h.unresolved.disagreements[0].scopeLabel),
    h.unresolved.disagreements[0].scopeLabel
  )
  ok(
    'and nothing anywhere on the screen prints one',
    !h.known.some((k) => /\d{4}-\d{2}-\d{2}/.test(k.atLabel))
      && !h.sources.some((x) => /\d{4}-\d{2}-\d{2}/.test(x.newestLabel ?? '')),
    JSON.stringify([h.known.map((k) => k.atLabel), h.sources.map((x) => x.newestLabel)])
  )

  /** Sources are counted from what actually arrived, not from a toggle. */
  const health = h.sources.find((s) => s.id === 'health')
  ok('every source that reported anything is listed', !!health, JSON.stringify(h.sources.map((s) => s.id)))
  ok('with how much it gave us', health.records > 0, String(health.records))
  ok('and how old the newest of it is', !!health.newestLabel, JSON.stringify(health))

  /**
   * AND THERE IS NO SCORE. A single percentage over facts, sources,
   * disagreements and questions would be exactly the invented metric this
   * codebase has already lost a session to.
   */
  ok('no health score is invented', !('score' in h) && !('percent' in h), JSON.stringify(Object.keys(h)))
  check('what is reported instead are counts of named states', typeof h.counts.known, 'number')
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 11a — every card can be inspected and argued with, and none by accident
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE PRODUCT RULE: every important inference must be inspectable and
 * correctable from the interface that displays it.
 *
 * Asserted over `compose`, because that is where the guarantee is made — a
 * builder may write a better verb and keep it, but nothing reaches a screen
 * without a way to say it is wrong. Asserted as a property over EVERY item
 * rather than on one example, since the failure mode being prevented is
 * precisely "some cards have it".
 */
{
  const p = readPerson({ person: undefined })
  const item = (over) => ({
    id: 'x', kind: 'suggestion', title: 't', detail: 'd',
    because: { sentence: 's', grounds: [{ kind: 'inference', id: 'i1', says: 'we worked this out' }] },
    basis: [], corrections: [], life: life.recompute('x'),
    scores: { relevance: 1, confidence: 1, urgency: 1, actionability: 1, novelty: 1, fit: 1 },
    score: 0, ...over,
  })

  const composed = compose([item({})], p, { now: NOW })
  const verbs = composed.surface[0].corrections.map((c) => c.verb)
  ok('every card can be told it is wrong', verbs.includes('wrong'), JSON.stringify(verbs))
  ok('and told it is not wanted', verbs.includes('not-relevant'), JSON.stringify(verbs))
  check(
    'and "wrong" points at the thing that is actually arguable',
    composed.surface[0].corrections.find((c) => c.verb === 'wrong').target,
    { kind: 'inference', id: 'i1' }
  )

  /**
   * A CARD STANDING ONLY ON RECORDS GETS NO "THAT'S WRONG".
   *
   * Google really did report that event. A button that cannot change anything
   * teaches him that buttons in this app do not change anything, which is a
   * far more expensive lesson than a missing chip.
   */
  const factual = compose([item({
    because: { sentence: 's', grounds: [{ kind: 'observation', id: 'o1', says: 'the calendar says so' }] },
  })], p, { now: NOW })
  ok(
    'a card standing only on records offers no "that is wrong"',
    !factual.surface[0].corrections.some((c) => c.verb === 'wrong'),
    JSON.stringify(factual.surface[0].corrections)
  )

  /** A card with a source behind it can have its source changed. */
  const sourced = compose([item({
    because: { sentence: 's', grounds: [{ kind: 'preference', id: 'source.steps', says: 'you chose google-fit' }] },
  })], p, { now: NOW })
  ok(
    'a card reading a chosen source offers to change it',
    sourced.surface[0].corrections.some((c) => c.key === 'source.steps'),
    JSON.stringify(sourced.surface[0].corrections)
  )

  /** A builder's own, better-worded verb survives rather than being duplicated. */
  const specific = compose([item({
    corrections: [{ verb: 'not-relevant', label: 'Not tracking activity', about: 'fitness' }],
  })], p, { now: NOW })
  check(
    'a builder\'s own wording is not duplicated by the generic one',
    specific.surface[0].corrections.filter((c) => c.verb === 'not-relevant').length,
    1
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 11b — behaviour moves the ranking; it never rewrites what he said
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The loop the brief asked to close: accepting travel warnings while dismissing
 * routine activity nudges should influence ranking WITHOUT silently changing
 * explicit preferences. Both halves are asserted, and the second is the one that
 * matters — a setting the app edits behind him is not a setting.
 */
{
  const { noteEngagement, engagementBiasOf, ENGAGEMENT_MIN } = await import('../server/person.ts')
  const { fitOf } = await import('../server/attention.ts')

  const p = readPerson({ person: undefined })
  const before = fitOf(p, 'suggestion', 'travel', NOW)

  /** One swipe is a mood, not a pattern. Nothing moves. */
  noteEngagement(p, 'fitness', 'dismissed', NOW)
  check('one dismissal changes nothing at all', engagementBiasOf(p, 'fitness', NOW), 0)

  for (let i = 1; i < ENGAGEMENT_MIN; i++) noteEngagement(p, 'fitness', 'dismissed', NOW)
  for (let i = 0; i < ENGAGEMENT_MIN; i++) noteEngagement(p, 'travel', 'accepted', NOW)

  ok('repeatedly dismissed nudges rank lower', fitOf(p, 'goal-slipping', 'fitness', NOW) < before, '')
  ok('repeatedly accepted warnings rank higher', fitOf(p, 'suggestion', 'travel', NOW) > before, '')

  /** THE HALF THAT MATTERS. His stated setting is untouched, and still governs. */
  check('his stated proactivity was not rewritten', p.preferences['assistant.proactivity'], undefined)
  check('nor was a dislike invented on his behalf', p.preferences['dislike.fitness'], undefined)

  /** And the nudge is bounded: behaviour alone can never suppress a subject. */
  for (let i = 0; i < 60; i++) noteEngagement(p, 'fitness', 'dismissed', NOW)
  ok('however many times he swipes, the subject survives', fitOf(p, 'goal-slipping', 'fitness', NOW) > 0.3, String(fitOf(p, 'goal-slipping', 'fitness', NOW)))

  /** Saying it, on the other hand, is decisive — and visible, and reversible. */
  const said = readPerson({ person: undefined })
  applyCorrectionDirect(said, { verb: 'not-relevant', label: 'x', about: 'fitness' })
  ok('but SAYING it is decisive', fitOf(said, 'goal-slipping', 'fitness', NOW) <= 0.05, String(fitOf(said, 'goal-slipping', 'fitness', NOW)))
  ok('and it is stored where he can see and reverse it', !!said.preferences['dislike.fitness'], '')

  /** An opinion formed two months ago is not evidence about today. */
  const old = readPerson({ person: undefined })
  for (let i = 0; i < ENGAGEMENT_MIN; i++) noteEngagement(old, 'travel', 'dismissed', new Date('2026-05-01T00:00:00Z'))
  check('a stale pattern decays to nothing', engagementBiasOf(old, 'travel', NOW), 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// PROOF 11 — the journey runs to the end: draft, correction, learned preference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE FULL CHAIN THE BRIEF ASKED FOR, ASSERTED STEP BY STEP.
 *
 *   calendar → destination problem → who is going → what they are to him
 *   → a suggested action → a draft → his correction → a learned preference
 *
 * The load-bearing assertion is the NEGATIVE one, and it is asserted twice: at
 * no point does attending the same dinner make anyone a source of
 * transportation. Before he says anything the card names them and asks; after he
 * says it, and only then, there is something to send.
 */
{
  install()
  const w = await readWorld()
  const p = readPerson(w)
  liftPeople(p, w)
  w.person = p
  await writeWorld(w)

  const { liftDraft } = await import('../server/draft.ts')
  const { liftStanceOf, liftKey } = await import('../server/people.ts')
  const paolo = readPerson(await readWorld()).people.find((x) => x.name === 'Paolo Bianchi')
  ok('Paolo was lifted from the invitation', !!paolo, JSON.stringify(readPerson(await readWorld()).people.map((x) => x.name)))

  /** Step 1. Being on the invitation says nothing about lifts. Nothing at all. */
  check('attendance grants no lift stance', liftStanceOf(readPerson(await readWorld()), paolo.id), null)

  /**
   * Step 2. Nor does a relationship. He says Paolo is a friend — which is real
   * information and is emphatically not "Paolo drives me places". People do not
   * lend cars along kinship lines, and the app must not join those two facts.
   */
  const rel = await correct({ verb: 'relationship', label: 'Paolo: a friend', personId: paolo.id, value: 'friend' })
  check('the relationship lands', rel.ok, true)
  check('and STILL grants no lift stance', liftStanceOf(readPerson(await readWorld()), paolo.id), null)

  /**
   * And the CARD offers no draft yet, because a draft is only ever about a
   * stance he stated. Asserted through the real builder rather than by calling
   * `liftDraft` directly, since the question is what the app decides to show.
   */
  {
    const { buildInsights } = await import('../server/insight.ts')
    const run = await buildInsights(await readWorld(), readPerson(await readWorld()), { now: NOW, offline: true })
    const lift = [...run.ranked.surface, ...run.ranked.held.map((h) => h.item)].find((a) => a.id.startsWith('lift:'))
    ok('no card offers to write to anyone yet', !lift?.panes, JSON.stringify(lift?.panes))
  }

  /** Step 3. He states it himself. This is the only writer of that fact. */
  const said = await correct({ verb: 'lift', label: "I'd ask Paolo for a lift", personId: paolo.id, value: 'ask' })
  check('the stance is accepted', said.ok, true)
  ok('and it says it will still never message anyone', /never message anyone/.test(said.said), said.said)

  const after = readPerson(await readWorld())
  check('it is stored as his, permanently', after.preferences[liftKey(paolo.id)]?.by, 'user')
  check('with the value he gave', liftStanceOf(after, paolo.id)?.value, 'ask')

  /** Step 4. NOW there is a draft, and every date in it comes from clock.ts. */
  const draft = liftDraft(after.people.find((x) => x.id === paolo.id), {
    event: { summary: 'Dinner, Anna and Paolo', start: '2026-08-12T16:00:00Z' },
    problem: 'Osteria del Sole is 57 km away and it is too far to walk',
    timeZone: ROME,
  }, NOW)
  ok('there is a draft', !!draft, 'no draft after he said he would ask')
  check('addressed to the person, from the record that named them', draft.to, 'paolo@example.com')
  ok('it names the day the way he would', /tomorrow/.test(draft.body), draft.body)
  ok('with no machine date in it', !/\d{4}-\d{2}-\d{2}/.test(draft.body), draft.body)
  /**
   * IT ASKS AND DOES NOT CLAIM. The app does not know Paolo has a car, is going
   * by car, or is in any position to offer, so the draft asks whether he is
   * driving and stops. The ask itself is his to write.
   */
  ok('it asks whether they are driving', /Are you driving/i.test(draft.body), draft.body)
  ok('and never asks for the lift on his behalf', !/give me a lift|can you take me|could you drive me/i.test(draft.body), draft.body)
  ok('the draft says plainly that nothing was sent', /not sent this/.test(draft.disclosure), draft.disclosure)
  ok('and states what it does not know', draft.uncertainty.length >= 2, JSON.stringify(draft.uncertainty))
  ok('every line traces to something typed', draft.grounds.every((g) => g.kind && g.id && g.says), JSON.stringify(draft.grounds))
  ok(
    'including the stance, as a preference rather than an inference',
    draft.grounds.some((g) => g.kind === 'preference' && g.id === liftKey(paolo.id)),
    JSON.stringify(draft.grounds.map((g) => `${g.kind}:${g.id}`))
  )

  /** Step 5. The correction that ends it, and the app stops offering. */
  const no = await correct({ verb: 'lift', label: 'Not Paolo after all', personId: paolo.id, value: 'never' })
  check('he can take it back', no.ok, true)
  check('and it is remembered as a decision, not an absence', liftStanceOf(readPerson(await readWorld()), paolo.id)?.value, 'never')
  ok('with no suggestion of asking again', /not suggest asking/.test(no.said), no.said)
  /** The relationship he stated is untouched — they are different facts. */
  check(
    'his relationship with Paolo survives the refusal',
    relationshipOf(readPerson(await readWorld()).people.find((x) => x.id === paolo.id))?.value,
    'friend'
  )
}

if (failures) {
  console.error(`\n${failures} personal-model failure(s).`)
  process.exit(1)
}
console.log(
  'person ok — a correction survived a concurrent build, a reload, synthesis and a later build; ' +
  'ten simultaneous corrections all landed; an answer became a typed fact before a sentence; ' +
  'people were lifted with no relationship inferred from an address or an invitation; ' +
  'Activity refused to show a figure its sources disagreed about; attention withdrew what had passed; ' +
  'and "what should I focus on this week" answered with every date re-derived, every line grounded, ' +
  'and every recommendation correctable; and the lift journey ran end to end — attendance and even a ' +
  'stated friendship granted no lift stance, only he could, and only then did a draft exist, which asks ' +
  'whether they are driving and says plainly that nothing was sent; every card that reaches a screen ' +
  'can be inspected and argued with, and none of them by accident; behaviour moved the ranking without ' +
  'rewriting a single thing he had stated; and the data-health view lists what is believed, who said it, ' +
  'what is stale and what is still unresolved, with no invented score anywhere in it'
)
