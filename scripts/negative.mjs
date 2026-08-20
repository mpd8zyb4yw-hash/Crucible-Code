/**
 * THE NEGATIVE-MEMORY SUITE — §32, AND THE HALF THAT DECIDES WHETHER THE OTHER
 * HALF MEANT ANYTHING.
 *
 * `scripts/memory.mjs` proves the system can learn. On its own that proves very
 * little: a pattern-finder biased toward finding patterns passes it, and passes it
 * confidently. What separates learning from apophenia is behaviour on data with no
 * structure in it, and that is the only thing asserted here.
 *
 * EVERY ASSERTION IS AN ABSENCE. There is nothing to discover in `noise.ts`, so
 * there is nothing here of the form "it found X". The suite fails when the system
 * INVENTS: a routine out of GPS jitter, a friendship out of a mailing list, a
 * permanent baseline out of a holiday, a causal claim out of ten days of
 * coincidence.
 *
 * WHY ABSENCE ASSERTIONS ARE WRITTEN CAREFULLY. An absence test passes trivially
 * if the pipeline silently did nothing at all — an exception swallowed somewhere,
 * an empty series, a store that never got written. So the first block asserts that
 * the machinery RAN and produced the structures a busy four months should produce.
 * Without it every later assertion is vacuous, and vacuous green is worse than red.
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

import { betterSqliteMemoryStore } from '../server/memory/store.ts'
import { noisyLife } from '../server/memory/noise.ts'
import { rebuild } from '../server/memory/reflect.ts'
import { recordedCycle } from '../server/memory/shadow.ts'
import { hypothesisSentence } from '../server/memory/hypotheses.ts'
import { SELF_ENTITY_ID } from '../server/memory/entities.ts'
import { domainContexts } from '../server/domain.ts'
import { enrichPanes } from '../server/panes.ts'

let failures = 0
const ok = (what, cond, detail = '') => {
  if (cond) return
  failures++
  console.error(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
}

const life = noisyLife()
const opts = { timeZone: life.timeZone, me: life.me }
const store = betterSqliteMemoryStore(new Database(':memory:'))
store.events.append(life.events)
const built = rebuild(store, opts)

// ═════════════════════════════════════════════════════════════════════════════
// 0.  THE MACHINERY RAN — without this, every assertion below is vacuous
// ═════════════════════════════════════════════════════════════════════════════

ok('the reflection loop ran a pass per day', built.passes > 120, `${built.passes} passes`)
ok('and every pass succeeded', built.runs.every((r) => r.status === 'ok'), built.runs.find((r) => r.status !== 'ok')?.error ?? '')
ok('the ledger was normalised into observations', store.observations.count() > 500, `${store.observations.count()}`)
ok('entities were resolved', store.entities.all().length > 5, `${store.entities.all().length}`)
ok('episodes were assembled', store.episodes.all().length > 50, `${store.episodes.all().length}`)
ok('baselines were computed', store.summaries.all().length > 5, `${store.summaries.all().length}`)

// ═════════════════════════════════════════════════════════════════════════════
// 1.  NO ROUTINE OUT OF NOISE
// ═════════════════════════════════════════════════════════════════════════════

const routines = store.routines.all()
const believed = routines.filter((r) => r.status === 'emerging' || r.status === 'established')

/**
 * Departures are drawn flat across six hours. There is no departure routine to
 * find, and a system that reports one has fitted a mean to a uniform distribution
 * and called it a habit.
 */
const departureRoutines = believed.filter((r) => r.activityType.startsWith('departure'))
ok(
  'no departure routine is believed, because departures are uniformly random',
  departureRoutines.length === 0,
  departureRoutines.map((r) => `${r.id} p=${r.temporal.recurrenceProbability.toFixed(2)}`).join(', ')
)

/**
 * §31's GPS noise. Four minutes at the same coordinates on three days in four is
 * the single most recurrent thing in the corpus. It is also not a visit, and
 * turning it into his strongest routine is the failure this case exists to catch.
 */
const noiseRoutines = believed.filter((r) => r.activityType.includes('n-noise'))
ok(
  'a four-minute stop repeated daily is not a routine',
  noiseRoutines.length === 0,
  noiseRoutines.map((r) => `${r.id} evidence=${r.evidenceCount}`).join(', ')
)

/**
 * §63. The Monday standup is cancelled every week for four months — the most
 * regular row in the calendar, and it never once happened. Plan is not reality.
 */
const standupRoutines = believed.filter((r) => /standup/i.test(r.activityType) || /standup/i.test(JSON.stringify(r.context ?? {})))
ok(
  'a meeting cancelled every week is not a weekly routine',
  standupRoutines.length === 0,
  standupRoutines.map((r) => r.id).join(', ')
)

/**
 * §32's placeholder. "Gym" every Wednesday on the calendar, and no location
 * evidence within a mile of a gym in four months.
 */
const gymRoutines = believed.filter((r) => /gym/i.test(r.activityType) || /gym/i.test(JSON.stringify(r.context ?? {})))
ok(
  'a calendar placeholder he never attended is not a routine',
  gymRoutines.length === 0,
  gymRoutines.map((r) => r.id).join(', ')
)

/**
 * Six destinations drawn uniformly. Any of them reaching "established" means the
 * evidence bar is counting sightings rather than measuring recurrence.
 */
const placeRoutines = believed.filter((r) => r.activityType.startsWith('place:') && !r.activityType.includes('home'))
ok(
  'no destination becomes an established habit when all six are equally likely',
  placeRoutines.every((r) => r.status !== 'established'),
  placeRoutines.map((r) => `${r.id} ${r.status}`).join(', ')
)

// ═════════════════════════════════════════════════════════════════════════════
// 2.  NO RELATIONSHIP OUT OF FREQUENCY — §61
// ═════════════════════════════════════════════════════════════════════════════

const relationships = store.relationships.all().filter((rel) => !rel.retiredAt)
const STATED_ONLY = ['spouse', 'family', 'friend', 'colleague', 'household']

ok(
  'nothing behavioural produced a relationship that may only be stated',
  relationships.every((rel) => !STATED_ONLY.includes(rel.type)),
  relationships.filter((rel) => STATED_ONLY.includes(rel.type)).map((rel) => `${rel.type} → ${rel.toEntityId}`).join(', ')
)

/**
 * The vendor mails more often than any human in the corpus. Frequency is
 * evidence of frequency; it is never evidence of intimacy.
 */
const vendorEntity = store.entities.all().find((e) => JSON.stringify(e).includes('offers@shop.example.test'))
const vendorEdges = vendorEntity ? relationships.filter((rel) => rel.toEntityId === vendorEntity.id || rel.fromEntityId === vendorEntity.id) : []
ok(
  'the most frequent sender in four months is not called a friend',
  vendorEdges.every((rel) => !STATED_ONLY.includes(rel.type)),
  vendorEdges.map((rel) => rel.type).join(', ')
)

/**
 * The dentist appears on more calendar events than anybody. A service provider
 * on a recurring appointment is the §61 trap in its purest form.
 */
const dentistEntity = store.entities.all().find((e) => JSON.stringify(e).includes('studiodentistico'))
const dentistEdges = dentistEntity ? relationships.filter((rel) => rel.toEntityId === dentistEntity.id) : []
ok(
  'a service provider on many appointments is not a personal relationship',
  dentistEdges.every((rel) => !STATED_ONLY.includes(rel.type)),
  dentistEdges.map((rel) => rel.type).join(', ')
)

ok(
  'and he is never lifted as somebody in his own life',
  !store.entities.all().some((e) => e.id !== SELF_ENTITY_ID && JSON.stringify(e.identities ?? []).includes(life.me)),
  'his own address resolved to a second entity'
)

/**
 * THE REGRESSION FOR THE ONE REAL DATA FOUND — see `MACHINES` in `noise.ts`.
 *
 * Three automated senders, each mailing more often than any of the twelve
 * acquaintances, each written as Gmail writes a From header. Before the fix all
 * three were people: the address was never parsed out of the header, so the
 * not-a-person filter was matching its regex against `anthropic <no-reply-…`,
 * which begins with neither `no-reply` nor anything else it knows.
 *
 * Asserted on the IDENTITY rather than on a count, because the failure mode is
 * specifically that a machine acquires one. A count would also pass if the
 * filter started rejecting the humans too, which is the opposite mistake and is
 * checked on the positive corpus.
 */
for (const machine of ['no-reply-ipaixkkl3evymuhaquigbg@mail.anthropic', 'invoice+statements@shop', 'no-reply@accounts.google']) {
  ok(
    `an automated sender with a display name is not a person (${machine.split('@')[0].slice(0, 24)})`,
    !store.entities.all().some((e) => JSON.stringify(e.identities ?? []).toLowerCase().includes(machine)),
    'a machine was resolved as somebody he knows'
  )
}

/**
 * And the display name is not glued to the address.
 *
 * The separate symptom of the same defect: two no-reply addresses at one domain
 * became two entities both labelled "Anthropic", because the identity carried
 * the name. Nothing anywhere should hold an identity with a space or an angle
 * bracket in it.
 */
ok(
  'no entity identity is a raw mail header',
  !store.entities.all().some((e) => (e.identities ?? []).some((i) => /[<>\s]/.test(i))),
  store.entities.all().flatMap((e) => (e.identities ?? []).filter((i) => /[<>\s]/.test(i))).join(' · ')
)

// ═════════════════════════════════════════════════════════════════════════════
// 3.  NO PERMANENT SHIFT OUT OF A REGIME — §62
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A fortnight abroad and a fortnight of unusual activity, both over well before
 * the end. Neither may leave a hypothesis claiming his life changed — the level
 * before and the level after are the same, and a shift detector that fires on a
 * temporary excursion will fire on every holiday he ever takes.
 */
const shifts = store.hypotheses.all().filter((h) => h.proposition.kind === 'shift' && (h.status === 'supported' || h.status === 'emerging'))
const stepShifts = shifts.filter((h) => h.proposition.metric === 'steps')
ok(
  'a fortnight of high activity that ended is not a permanent change in his activity',
  stepShifts.length === 0,
  stepShifts.map((h) => hypothesisSentence(h)).join(' | ')
)

const departureShifts = shifts.filter((h) => h.proposition.metric === 'departure_minute')
ok(
  'and uniformly random departures never shifted',
  departureShifts.length === 0,
  departureShifts.map((h) => hypothesisSentence(h)).join(' | ')
)

/**
 * The holiday is also the §62 place test: two weeks of Athens must not displace
 * home, and must not make Athens a destination he has.
 */
const athens = believed.filter((r) => /hol|athens/i.test(r.activityType))
ok(
  'two weeks in another city did not become a routine',
  athens.length === 0,
  athens.map((r) => r.id).join(', ')
)

// ═════════════════════════════════════════════════════════════════════════════
// 4.  NO SUPPORTED ASSOCIATION OUT OF COINCIDENCE
// ═════════════════════════════════════════════════════════════════════════════

const supported = store.hypotheses.all().filter((h) => h.status === 'supported')
ok(
  'no association is supported, because none of these metrics are related',
  supported.filter((h) => h.proposition.kind === 'association').length === 0,
  supported.filter((h) => h.proposition.kind === 'association').map((h) => `${hypothesisSentence(h)} [${h.support}/${h.support + h.contradiction}, ${h.temporalCoverageDays}d, div ${h.evidenceDiversity}]`).join(' | ')
)

/**
 * Ten days of steps and calendar load moving together, by construction and for
 * no reason. A pair search will notice it; `temporalCoverageDays` is what must
 * stop it becoming a claim.
 */
const shortLived = store.hypotheses.all().filter((h) => h.status === 'supported' && h.temporalCoverageDays < 21)
ok(
  'nothing is believed on less than three weeks of evidence',
  shortLived.length === 0,
  shortLived.map((h) => `${hypothesisSentence(h)} (${h.temporalCoverageDays}d)`).join(' | ')
)

/** §36's invariant, restated against a corpus designed to tempt it. */
const CAUSAL = /\b(causes?|caused|because of|due to|leads? to|results? in|makes? (?:him|her|you)|drives?)\b/i
const sentences = store.hypotheses.all().map((h) => hypothesisSentence(h))
ok(
  'no rendered hypothesis expresses causation',
  sentences.every((s) => !CAUSAL.test(s)),
  sentences.filter((s) => CAUSAL.test(s)).join(' | ')
)

// ═════════════════════════════════════════════════════════════════════════════
// 5.  NO TRIVIAL PREDICTION, AND NO WINNING BY PREDICTING NOTHING — §34
// ═════════════════════════════════════════════════════════════════════════════

const predictions = store.predictions.all()
const outcomes = store.predictions.outcomes()

/**
 * The calibration trap, stated as a test because §34 asks for one.
 *
 * A system that learns it can raise its hit rate by predicting only near-certain
 * things will do exactly that, and the resulting number describes the threshold
 * rather than the model. Two ways to catch it: a hit rate of 1 over a corpus with
 * nothing predictable in it, and any prediction carrying a probability above the
 * information floor.
 */
const overconfident = predictions.filter((p) => (p.probability ?? 0) > 0.95)
ok(
  'nothing near-certain was predicted — a certainty teaches nothing when it lands',
  overconfident.length === 0,
  overconfident.map((p) => `${p.target.kind} p=${p.probability}`).join(', ')
)

if (outcomes.length) {
  const hitRate = outcomes.filter((o) => o.calibrationResult === 'correct').length / outcomes.length
  ok(
    'and the hit rate is not a perfect score bought with trivial predictions',
    hitRate < 0.95,
    `hit rate ${hitRate.toFixed(2)} over ${outcomes.length} resolved predictions of a random life`
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// 6.  AND THEREFORE: SILENCE — §66, §67
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE ONE THAT MATTERS.
 *
 * Everything above says a particular wrong structure was not formed. This says
 * the consequence: with nothing real to report, the intelligence slot stays quiet.
 *
 * A pass over four months of noise that produces a candidate clearing the
 * significance gate is the system manufacturing something to say, which §67 names
 * as the failure to avoid. Silence is a valid — here, the only valid — result.
 */
const { shadow } = recordedCycle(store, 'daily', life.now, opts)
ok('the pass produced a shadow record', !!shadow)

const wouldSurface = shadow ? shadow.candidates.filter((c) => c.surfaced) : []
ok(
  'nothing in four months of a structureless life earns the intelligence slot',
  wouldSurface.length === 0,
  wouldSurface.map((c) => `[${c.score}] ${c.says}`).join(' | ')
)

/**
 * And it considered things and rejected them, rather than having nothing to
 * consider. A gate that never sees a candidate is not a gate that is working.
 */
if (shadow) {
  ok(
    'and it did so by rejecting candidates, not by generating none',
    shadow.candidates.length > 0,
    'no candidate was generated at all — the suppression above proves nothing'
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 8  DOMAIN ENRICHMENT DISAPPEARS CLEANLY — §26 AND §27
// ═════════════════════════════════════════════════════════════════════════════

/**
 * THE PRODUCT MUST NOT HAVE BECOME DEPENDENT ON COGNITION BEING AVAILABLE.
 *
 * Production's memory core has thirteen days in it and clears none of these
 * bars, so the state asserted below is not an edge case — it is the state the
 * app actually ships in. What has to be true there is that Calendar, Activity,
 * Places and Mail are exactly the applications they were before Phase 8: same
 * events, same figure, same pins, same messages, no empty rows where a sentence
 * would have gone, and no card left saying nothing.
 *
 * Four kinds of absence, and they fail differently, so they are asserted
 * separately:
 *
 *   ·  the capability is still in shadow          — nothing may read
 *   ·  the records do not exist                   — nothing to read
 *   ·  the records exist and support no claim     — read, and declined
 *   ·  the store is broken                        — read, and survived
 */
{
  const SHADOW = { enabled: true, authority: {} }
  const LIVE = { enabled: true, authority: { entities: 'live', baselines: 'live', routines: 'live' } }
  const tz = life.timeZone
  const day = store.summaries.all().find((s) => s.samples.length)?.samples.slice(-1)[0]?.day ?? '2026-08-10'

  /** Every domain, asked at once, with facts a live store would answer. */
  const everything = {
    calendar: { today: day, todayEvents: 9, events: [{ id: 'e', start: `${day}T04:00:00.000Z`, located: true }] },
    activity: { metric: 'steps', current: { day, value: 200 } },
    places: { now: life.now, pins: [{ id: 'p', lat: 45.9188, lon: 9.4302 }] },
    mail: { now: life.now, messages: [{ id: 'm', from: 'Someone <someone@example.test>' }] },
  }

  // ── 1. Shadow is not a suggestion ──
  ok(
    'nothing is enriched while the capabilities are shadowed',
    domainContexts(store, everything, { posture: SHADOW, timeZone: tz }).length === 0,
    JSON.stringify(domainContexts(store, everything, { posture: SHADOW, timeZone: tz }))
  )
  /*
    AND THE DEFAULT POSTURE IS SHADOW. `authorityOf` reads a Partial map, so a
    host that has never heard of `baselines` gets shadow rather than undefined —
    asserted here because the failure would be silent and would be the whole
    milestone leaking onto his home screen at once.
  */
  ok(
    'and an empty posture is a shadowed one, not an unconfigured one',
    domainContexts(store, everything, { posture: { enabled: true, authority: {} }, timeZone: tz }).length === 0
  )

  // ── 2. Nothing to read ──
  const bare = {
    summaries: { byId: () => null },
    routines: { all: () => [] },
    entities: { ofKind: () => [], byIdentity: () => null },
    observations: { ofType: () => [], between: () => [] },
    episodes: { between: () => [] },
  }
  ok(
    'an empty memory core enriches nothing rather than enriching emptily',
    domainContexts(bare, everything, { posture: LIVE, timeZone: tz }).length === 0
  )

  // ── 3. Read, and declined ──
  /*
    THE FOUR NAMED CASES FROM §26, each with the records PRESENT and saying
    nothing. This is the interesting half: an absence that comes from having no
    data is easy, and an absence that comes from having data which supports no
    claim is the one that decides whether the bars are real.
  */
  const thin = (over) => ({ ...bare, ...over })

  ok(
    'a baseline of three days is not a baseline — Activity invents no comparison',
    domainContexts(
      thin({ summaries: { byId: () => ({ id: 't', count: 3, mean: 7000, median: 7000, stdDev: 900, samples: [] }) } }),
      { activity: everything.activity }, { posture: LIVE, timeZone: tz }
    ).length === 0
  )
  ok(
    'and a baseline with no spread cannot say anything is above or below it',
    domainContexts(
      thin({ summaries: { byId: () => ({ id: 't', count: 20, mean: 7000, median: 7000, stdDev: 0, samples: [] }) } }),
      { activity: everything.activity }, { posture: LIVE, timeZone: tz }
    ).length === 0
  )
  ok(
    'no learned departure routine — Calendar says nothing about leaving',
    !domainContexts(
      thin({ summaries: { byId: (id) => (id.includes('departure') ? null : { id, count: 20, mean: 1, median: 1, stdDev: 1, samples: [] }) } }),
      { calendar: everything.calendar }, { posture: LIVE, timeZone: tz }
    ).some((c) => c.line.includes('leave home'))
  )
  ok(
    'a place he goes to on four different weekdays is not a Tuesday habit',
    domainContexts(
      thin({
        routines: { all: () => [{
          id: 'r', activityType: 'place:ent:place:x', status: 'established', confidence: 0.9,
          temporalCoverageDays: 90, temporal: { daysOfWeek: [1, 2, 3, 4], recurrenceProbability: 0.9, typicalStartMinutes: 600 },
        }] },
        entities: { ofKind: (k) => (k === 'place' ? [{ id: 'ent:place:x', identities: ['geo:45.9188,9.4302'] }] : []), byIdentity: () => null },
      }),
      { places: everything.places }, { posture: LIVE, timeZone: tz }
    ).length === 0
  )
  ok(
    'and one he goes to half the time is not a habit either',
    domainContexts(
      thin({
        routines: { all: () => [{
          id: 'r', activityType: 'place:ent:place:x', status: 'established', confidence: 0.9,
          temporalCoverageDays: 90, temporal: { daysOfWeek: [6], recurrenceProbability: 0.31, typicalStartMinutes: 600 },
        }] },
        entities: { ofKind: (k) => (k === 'place' ? [{ id: 'ent:place:x', identities: ['geo:45.9188,9.4302'] }] : []), byIdentity: () => null },
      }),
      { places: everything.places }, { posture: LIVE, timeZone: tz }
    ).length === 0
  )
  ok(
    'no resolved person — Mail is normal Mail',
    domainContexts(bare, { mail: everything.mail }, { posture: LIVE, timeZone: tz }).length === 0
  )
  /*
    AND A RESOLVED PERSON IS NOT ENOUGH. §14: the line exists because something
    is ARRANGED, not because somebody is known. Without this the enrichment would
    be a contact record with a friendlier sentence.
  */
  ok(
    'a resolved person with nothing arranged still produces nothing',
    domainContexts(
      thin({ entities: { ofKind: () => [], byIdentity: () => ({ id: 'ent:person:x', label: 'Someone' }) } }),
      { mail: everything.mail }, { posture: LIVE, timeZone: tz }
    ).length === 0
  )

  // ── 4. Read, and survived ──
  /*
    §27: FAILURE IS ISOLATED. One broken read must cost its own domain's line and
    nothing else — not the other three, and never the screen.
  */
  const angry = (which) => thin({
    ...bare,
    summaries: { byId: () => { if (which === 'summaries') throw new Error('ledger'); return null } },
    routines: { all: () => { if (which === 'routines') throw new Error('ledger'); return live.routines } },
    entities: {
      ofKind: (k) => { if (which === 'entities') throw new Error('ledger'); return k === 'place' ? live.places : [] },
      byIdentity: () => { if (which === 'entities') throw new Error('ledger'); return null },
    },
    observations: {
      ofType: () => (which === 'entities' ? [] : live.visits),
      between: () => (which === 'entities' ? [] : live.visits),
    },
    episodes: { between: () => { if (which === 'episodes') throw new Error('ledger'); return [] } },
  })
  const live = {
    routines: store.routines.all(),
    places: store.entities.ofKind('place'),
    visits: store.observations.ofType('location_visit', 50),
  }

  for (const which of ['summaries', 'routines', 'entities', 'episodes']) {
    let threw = false
    let got = []
    try { got = domainContexts(angry(which), everything, { posture: LIVE, timeZone: tz }) } catch { threw = true }
    ok(`a ${which} read that throws does not reach the caller`, !threw)
    ok(`and it does not take the other domains with it`, Array.isArray(got))
  }

  /*
    THE STORE ITSELF BEING UNUSABLE. `enrichPanes` is the seam the feed calls, and
    its contract is that the caller gets its panes back — the same objects, not a
    stripped copy — whatever happened underneath.
  */
  const panes = [{
    id: 'src-email', panes: [{ widget: { kind: 'mail', messages: [{ id: 'm1', from: 'a@b.test', subject: 's', at: '2026-08-01T00:00:00.000Z' }] } }],
  }]
  const broken = enrichPanes(panes, null, { posture: LIVE, timeZone: tz, now: life.now })
  ok('a memory core that cannot be read leaves the panes exactly as they were', JSON.stringify(broken) === JSON.stringify(panes))
}

// ─────────────────────────────────────────────────────────────────────────────

if (failures) {
  console.error(`\n${failures} negative-memory failure(s).`)
  process.exit(1)
}

const considered = shadow?.candidates.length ?? 0
const reasons = [...new Set((shadow?.candidates ?? []).map((c) => c.reason).filter(Boolean))]
console.log(
  `negative memory ok — over four months of a life with no structure in it, the system built ` +
    `${store.observations.count()} observations, ${store.episodes.all().length} episodes and ${store.entities.all().length} entities, ` +
    `and concluded nothing from them: no routine from GPS jitter, from a meeting cancelled every week, ` +
    `or from a placeholder never attended; no relationship from the vendor that mailed most or the ` +
    `provider on the most appointments; no permanent change from a fortnight abroad or a fortnight of ` +
    `unusual activity; no supported association from ten days of coincidence; and no causal claim from ` +
    `any of it. It considered ${considered} candidate(s) and surfaced none` +
    `${reasons.length ? ` (${reasons.join(', ')})` : ''} — silence is the correct answer to a quiet life. ` +
    `Phase 8 stays silent on the same terms: nothing is enriched while a capability is shadowed, a three-day ` +
    `baseline produces no comparison, a spread of zero produces none either, a place visited on four weekdays ` +
    `is not a weekday habit, a person with nothing arranged gets no line, and a ledger read that throws costs ` +
    `its own domain's sentence and neither the other three nor the panes.`
)
