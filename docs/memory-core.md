# The Memory Core — World Model v2

*What `server/memory/` is, why each part of it exists, and what is deliberately
not there yet.*

This document is the answer to §49 of the temporal-memory handoff: the next
engineer must be able to understand **why these systems exist**, not merely what
tables were added.

---

## 1. The one idea

> **Memory is durable. The world is reconstructed.**

`world.ts` has been doing two jobs that pull against each other. It is the
**snapshot** the prompt reads — a current picture, trimmed to a token budget by
`renderWorld`. And it is the **archive** — the only durable record of everything
ever observed.

Those cannot both be true of one JSON document. The render budget exists because
the document grew without limit; the growth exists because the document is the
only place history lives. The result was an app that got slower and more
expensive every day it ran, and whose oldest evidence silently stopped reaching
the model.

So the substrate splits in two:

| | what it is | who may destroy it |
|---|---|---|
| **Ledger** | raw source events, and the typed observations read out of them | nothing, ever |
| **Derived cognition** | entities, episodes, routines, hypotheses, predictions | `clearDerived()`, on purpose |
| **World snapshot** | the current picture | it is a *read*; there is nothing to destroy |

Improving the cognition is therefore a **rebuild**, not a migration. That is the
property everything below is arranged around.

---

## 2. The pipeline

```
  raw source event            ingest.ts        append-only, idempotent on dedupeKey
        ↓
  normalised observation      normalize.ts     deterministic; no model, ever
        ↓
  entities & relationships    entities.ts      extends people.ts; never overmerges
        ↓
  episodes                    episodes.ts      overlap in time AND a shared entity
        ↓
  temporal summaries          temporal.ts      the activity.ts shape, generalised
  probabilistic routines      routines.ts      distributions, not phrases
        ↓
  hypotheses                  hypotheses.ts    support AND contradiction
        ↓
  predictions → outcomes      predictions.ts   falsifiable; reality resolves them
        ↓
  anomalies                   anomalies.ts     expectation written down first
        ↓
  attention candidates        candidates.ts    → attention.ts, unmodified
```

`reflect.ts` decides when each stage runs and over what. `snapshot.ts` builds the
current picture. `inspect.ts` lets you see all of it.

---

## 3. Persistence

### One SQL core, two four-line drivers

The handoff asked for `DurableObjectMemoryStore` and `BetterSqliteMemoryStore` as
two classes, plus an acceptance test proving they agree. **That test is the tell.**
Two implementations of the same thirty queries will drift, the drift will be in a
predicate nobody looked at, and the test will be the only thing between his life
and two different versions of it.

They do not have to be two implementations. Both surfaces are *synchronous* and
both speak SQLite:

```ts
// Durable Object
state.storage.sql.exec(query, ...bindings).toArray()
// Mac
db.prepare(query).all(...bindings)
```

So `sql.ts` defines a `SqlDriver` with one method, implements it twice in about
four lines each, and **everything above it is literally the same code on both
hosts**. Parity is a property of the construction rather than a claim a test has
to keep re-establishing.

The named constructors from the handoff still exist —
`durableObjectMemoryStore(sql)` and `betterSqliteMemoryStore(db)` — because that
is the API the next person will look for. They differ only in which driver they
wrap.

### The row shape

Every table is `(id, …indexed columns…, json)`. The JSON is the truth; the
columns are a projection written by the same statement. Only things a `WHERE`
clause touches get a column.

This was chosen over full normalisation for one reason: these records are still
being designed. `Hypothesis.evidenceDiversity` did not exist when the file was
started. A schema needing a migration per field discourages exactly the design
work this milestone is mostly made of.

### What a rebuild may destroy

`DERIVED_TABLES` in `sql.ts` names it explicitly, rather than "everything except
a hard-coded few" — that form silently includes any table added later, which for
a table holding something *he* said would be data loss with no error.

`PRESERVED_TABLES` holds `events`, `reflection_runs`, and — the interesting case
— `recommendations` and `recommendation_outcomes`. Those look derived and are
not: a recommendation was shown on a screen at a time and he responded to it.
That happened. Wiping it on a rebuild would erase the engagement history
`person.ts` learns from, and nothing would regenerate it.

`observations` **is** derived. It is a reading of the ledger under a versioned
normaliser, and treating it as durable is how a normalisation improvement becomes
unshippable.

---

## 4. Invariants

These are the rules the code enforces mechanically. Breaking one is a bug even if
every test passes.

### 4.1 Inference may never overwrite what he said

`person.ts`'s `mayReplace` owns this. `facts.ts` **calls** it; it does not
restate it. The memory core makes the failure much easier to cause than before —
four months of location data contains dozens of drives to Milan, and a writer
that scored evidence would conclude he drives, over the top of "I prefer taking
the train", which he typed once.

Refusals are *reported*, not swallowed. A fact the memory core believes and the
personal model refuses is exactly the disagreement worth being able to see.

### 4.2 A relationship is never inferred from an address or from attendance

`people.ts` states this; `RELATIONSHIP_RULES` in `types.ts` enforces it.
`spouse`, `family`, `friend`, `colleague` and `household` are marked `stated:
true` and can only be created through `stateRelationship`. `deriveRelationships`
cannot reach them, and anything that somehow produced one is dropped with the
refusal recorded.

What behaviour *may* assert: `frequently_meets` and `frequent_contact`. Those are
literally what was measured. Frequency is evidence of frequency and never becomes
evidence of kinship.

### 4.3 Nothing can express causation

`TypedProposition` has `association`, `shift` and `cadence_change`. There is no
causal variant, so no amount of evidence can promote "on meeting-heavy days
activity tends to be lower" into "meetings cause lower activity". A threshold can
be raised by anybody; a type cannot be satisfied by anybody.

`hypothesisSentence` renders "tends to be" and "on days when". The acceptance
test greps every rendered sentence for causal verbs.

### 4.4 Support and contradiction are separate numbers

Never netted. Eight-for-and-seven-against is a completely different epistemic
state from one-for-and-nothing-against, and any single score destroys the
distinction.

`world.ts`'s `Belief` has confidence and decay and **no way to be contradicted** —
which is why `reconcileBeliefs` and `claimsUnperformedEffect` had to be bolted on
after a belief aged gracefully while being false the whole time. Contradiction is
the missing verb, and a hypothesis has it.

### 4.5 A prediction outcome is not an engagement outcome

| | measures | resolved by |
|---|---|---|
| `PredictionOutcome` | whether our model of his life was right | reality |
| `RecommendationOutcome` | whether an intervention was wanted | him |

`predictions.ts` and `recommendations.ts` do not import each other, in either
direction. The leak would be invisible both ways: a miss folded into engagement
teaches the proactivity loop that he dislikes travel advice because the weather
was bad; a dismissal folded into calibration teaches the world model that his
Tuesdays are unpredictable because he was busy.

### 4.6 Everything derived is a pure function of the evidence

Nothing increments. Routine status, hypothesis support, confidence — all
recomputed from the observations each pass. A counter that goes up each time the
reflection cycle runs is measuring the cron, not his life, and cannot be rebuilt.

### 4.7 No date arithmetic outside `clock.ts`

Every weekday, every day boundary, every local hour goes through `dayIn`,
`partsIn`, `addDays`, `weekdayOf`. The Worker runs in UTC and he lives in
Europe/Rome; a day computed from the runtime is a day that is wrong for two hours
every night.

Local weekday and minute-of-day are stamped **once**, at normalisation, and
carried — so no downstream model has an opportunity to forget.

### 4.8 Every id is a function of its content

`ids.ts`. This is what makes the replay test a byte-for-byte comparison instead of
a comparison of summaries with identity canonicalised away. Nothing in this
directory calls `Date.now()` or `Math.random()`.

---

## 5. Entity resolution

Two paths, and the split is the whole anti-overmerge design:

- **Keyed.** The source gave a structured identity (`email:anna@…`,
  `geo:45.9012,9.4033`). Resolves by that identity. Safe.
- **Keyless.** A bare name in a calendar title — "Lunch Bernardo". Needs
  `MENTION_EVIDENCE` (3) sightings **on distinct days** before it becomes anybody,
  gets an id marked `~`, and **can never merge into a keyed entity.**

A keyless candidate joining a keyed one is how "Bernardo" from a lunch becomes
Bernardo Rossi the client, and how the app then speaks about one as if it knew
the other. An unresolved name is a correct outcome; a wrong merge is
unrecoverable without him noticing something he has no way to see.

Two rules found by running this over four months of synthetic data:

- **A name in a title is only evidence when the source gave no attendee list.**
  "Project sync 1" produced a person called Project, who accumulated sightings and
  earned a `frequently_meets` edge. The fix is not a longer word list — that is
  whack-a-mole in one language against titles written in another. A row *with*
  attendees has already told us who is there; the title is a topic.
- **Is this mailbox a human? Ask `people.ts`.** The Coop's newsletter became a
  person with nineteen days of contact. `personMailboxCheck` is now exported from
  `people.ts` and called by both resolvers, so the two cannot answer differently.

**Places** cluster: coordinates are rounded to ~11 m at normalisation (GPS jitter
at a stationary phone), then a second stage merges anything within 80 m of an
existing place (a supermarket has a car park). Too large is the worse failure —
merging his home with the neighbour's makes "was he at home" unanswerable and
nothing in the data would ever split them again.

**Home** is derived, not configured: the place he is most often present in the
small hours. `identity.home` in the live world model is already corrupted prose,
and a second competing claim would leave two answers to one question.

---

## 6. Episode assembly

Two things join only if they **overlap in time AND share an entity**.

Overlap alone would fuse everything on a busy Thursday into one blob — his day is
continuous, so time overlap is nearly always available and is nearly never
evidence. One exception, which the "trip" case needs: a calendar event with no
location, wholly inside a visit somewhere, *is* that visit.

Assembly is **per day, clear-then-write**. An episode's id is a function of its
contents, so adding a fifth observation to a four-part episode moves the id — an
upsert alone would leave a ghost with the same evidence. `removeBetween` is the
only destructive method in the store, and it is why reassembly and a from-scratch
rebuild produce identical rows.

Type comes from **structure**, never from reading the title. A keyword list for
"lunch" or "shop" is language-specific in an app used in Italian and would
hard-code the answers §32 forbids. The Saturday shop is discovered as "visits to
this place"; what makes it recognisable as shopping is the place's own label,
which came from a source.

`cancelled` comes only from a source **saying** so (a declined RSVP). Inferring it
from a missing location visit would mark every meeting he took from his desk as
cancelled.

---

## 7. Temporal models and routines

`activity.ts` already did this for steps: current, prior window, baseline,
percentage change, direction, explicit handling of missing days. It is the design
precedent and it is **not replaced** — it remains the surface's report, reading
the world document. `temporal.ts` generalises the shape so calendar load,
departure time and contact cadence can be compared the same way.

Three things it adds:

- **Scope.** "His Thursdays" is a different population from "his days". Comparing
  a Thursday to an all-days mean produces a permanent false alarm every Monday.
- **A median and a deviation.** A mean alone cannot say whether 12:00 is unusual.
  Every anomaly threshold here is in standard deviations for that reason.
- **A change point.** The product difference between "today was odd" and "this has
  been drifting since June". A percentage change cannot tell them apart.

The change-point detector was raised from 1.2σ/4-a-side to **1.5σ/5-a-side** after
running it over the fixture: at 1.2σ it found the planted Tuesday shift *and* two
that were random meeting counts being slightly heavier in one half. Both false
ones became `supported` shift hypotheses — a wrong change point does not stay a
statistic, it becomes a sentence claiming his life changed in May.

### Routine confidence semantics

`RoutineModel` keeps **two numbers that are often confused**:

- `temporal.recurrenceProbability` — how often it happens, given a qualifying day.
- `confidence` — how much evidence there is that this is a rhythm at all.

Three Saturdays out of three is a probability of 1.0 and is not something to be
confident about. Keeping them apart is what lets a surface say "he has done this
every one of the four Saturdays I have seen, which is not many yet".

Status is a **pure function of the evidence window**, never of the previously
stored status — which is what makes an incremental run and a rebuild agree:

```
candidate  < 3 occurrences
emerging   ≥ 3, not yet established
established ≥ 6 occurrences AND ≥ 42 days coverage AND p ≥ 0.6
weakening  established, but the recent quarter's rate < half its own overall rate
inactive   nothing in the recent window
```

The observed span runs **first sighting → today**, not first → last. Ending it at
the last occurrence is how a routine that stopped in March keeps reporting a
perfect probability forever: the denominator stops growing when the numerator
does. Running it to today is what makes silence count as evidence.

---

## 8. Hypothesis lifecycle

```
candidate → emerging → supported
                ↓          ↓
            weakening ← ────┘
                ↓
            rejected
```

All four bars must clear for `supported`:

| bar | value | why |
|---|---|---|
| occasions | ≥ 8 days the condition held | not days observed — a claim about meeting-heavy Thursdays is only tested by meeting-heavy Thursdays |
| coverage | ≥ 42 days | six lunches in one week is a project, not a rhythm |
| diversity | ≥ 2 independent connectors | six calendar rows are one kind of evidence six times; a calendar row and a step count are two instruments agreeing |
| ratio | ≥ 0.7 support | |

**These are deliberately not `ENGAGEMENT_MIN`.** Four is right for a bounded nudge
to a ranking, where being wrong costs a card's position. A cross-domain
association will be spoken aloud and used to make predictions.

A day where the condition held and the outcome was within ±0.5σ of baseline counts
as **neither** support nor contradiction. Without that, a coin-flip association
sits at 50% support forever.

Proposals are an enumerated cross-product of the metrics in hand — not "ask a
model what looks interesting". Only the `above` comparator is generated: the
threshold is the condition metric's own median, so `above` and `below` partition
the same days and the four combinations are two claims each stated twice. (Both
copies were being stored; the table came out at 22 rows describing 11 claims.)

**Honest limitation:** there is no correction for multiple comparisons. The
diversity and coverage bars are the blunt instrument standing in for one. A
`supported` association here is a strong hint, not a finding.

---

## 9. Predictions and calibration

A prediction commits to an expectation with a window in which it can be checked.
The point is not to tell him what will happen — it is that a system which commits
can **measure its own error**, and prediction error is a far denser signal than a
model asked to find something interesting in an entire life.

What is predicted:

- `episode_occurs` — from a routine on a day it falls on
- `timing` — departure minute, from the recent half of the same weekday
- `measure` — a metric against a baseline

Two guards, both found by running the fixture:

- **Only `emerging`/`established`/`weakening` routines predict.** A `candidate`
  routine is two sightings; its misses would say more about the threshold than the
  model.
- **Nothing above `p = 0.95` is predicted.** The strongest routine in the data was
  "he is at home" at 0.98 on all seven days. It was right every day and carried the
  `episode_occurs` hit rate to 0.91 — a number describing the trivial routine, which
  then fed back and made every other prediction more confident. The bar is
  *information*, not correctness.

Scoring:

- `unverifiable` is **excluded from the denominator**. The phone being off is not a
  miss; scoring it as one makes calibration a measure of data coverage, and every
  connector fix would look like a model improvement.
- **Signed** mean error is kept alongside the hit rate. A model that is right half
  the time and unbiased needs a wider interval; one that is late every single time
  needs a different centre. Absolute error hides the second entirely.

`calibrationFactor` feeds the record back into the next prediction's confidence.
Bounded in both directions (0.6–1.1) and neutral below five resolutions, in the
same spirit as `engagementBiasOf` — a loop with no floor drives its own inputs to
zero after a bad week and has no way back.

The timing interval is 1.5σ, **floored at 20 minutes**. A routine whose observed
spread is four minutes is not predictable to four minutes; it is a routine we
have not yet seen fail.

---

## 10. Reflection cadence

| pass | when | does |
|---|---|---|
| `ingest` | on arrival | normalise, resolve, assemble the days touched |
| `short` | ~15 min | resolve predictions whose windows closed |
| `daily` | 23:00 **his time** | baselines, routines, hypotheses, tomorrow's predictions, anomalies |
| `weekly` | Sunday 23:00 | relationship cadence, the long view |

Incremental via `cursors`: `WHERE observed_at > ?` is an index seek. The cursor
moves **only when the work has landed**, so a failed pass is retried and every
stage is idempotent so retrying is free.

Routine learning and hypothesis evaluation are deliberately **not** incremental —
their correctness depends on the whole span, there are tens of them, and making
them incremental would trade the replay property for a saving nobody can measure.

`runCycle` knows nothing about alarms or timers. The edge calls it from a Durable
Object alarm, the Mac from an unref'd interval. Same arrangement as
`worldRoom.ts`, for the same reason.

Predictions are **resolved before new ones are made**, so today's are informed by
yesterday's result rather than by a record one day stale.

---

## 11. Replay and rebuild

`rebuild(store)`:

1. `clearDerived()` — every derived table, plus the ledger's normalisation flags
2. re-run the daily cycle once per day covered by the ledger
3. one weekly pass at the end

The schedule is derived **from the ledger** (first event → last), so a rebuild is
reproducible without anybody having recorded when the original passes ran.

**Why a schedule and not one big pass.** Almost everything is a pure function of
the evidence and would rebuild identically in a single pass. Predictions are the
exception, and that is not a flaw: a prediction is a statement made *at a time*
from the model as it stood then. "What would we have predicted on 3 June" only has
an answer if 3 June is replayed as 3 June.

**The honest limitation:** a rebuild reproduces the original only if the original
also ran daily. A system that ran three times on Tuesday and not at all on
Wednesday will not be reproduced tick-for-tick, and its predictions will differ.
Every other derived structure will be identical. `scripts/memory.mjs` drives both
sides on the same cadence and says so in its output.

---

## 12. Migration status

Following §30:

| phase | state |
|---|---|
| **A** — types, schema, both adapters, ledger, normalisation, replay | **done** |
| **B** — dual write, parity | **done, and inert by default** |
| **C** — entities, episodes, relationships, temporal | **done** |
| **D** — WorldSnapshot + compatibility mapping | **done; nothing reads it yet** |
| **E** — routines, hypotheses, predictions, anomalies, cross-domain candidates | **done** |
| **F** — authority migration | **not started, deliberately** |

### What the dual write actually does

`world.ts` gained `setObservationSink` — inert unless a host installs one.
`addObservations` is the single funnel every connector already goes through, so
hooking it once means the ledger sees exactly what the world document sees, from
the same fetch, with no chance of drift because somebody added a connector and
forgot a second call.

The sink is **forbidden from failing a sync**. It runs *after* the world write has
landed, inside a `try`/`catch` that swallows. A ledger that is unavailable costs
evidence and never costs him his calendar. There is an acceptance test for exactly
this.

### What still reads the old world

Everything. `feed.ts`, `panes.ts`, `insight.ts`, the widgets, the prompt. None of
them knows the memory core exists.

`enrichWorld` is the only thing that flows the other way, and it is **additive
only**: measured routines are written into `Person_.routines` as sentences through
the existing `addRoutine`, under `mayReplace`, so the prompt keeps reading what it
always read and gets better rhythms for free. Nothing is written to
`World.observations`, `World.beliefs` or `World.profile` — those are the old
substrate and the point is to stop growing them.

---

## 13. Verification

`npm run memory` (also in `npm test`) runs `scripts/memory.mjs`: §33–§39 against
four months of synthetic life.

The fixture **returns raw source events and nothing else** — no metadata, no
answer key, no list of the routines it generated or the day it deliberately broke
one. The expectations are stated in the *test*, in its own words, and the system
has to find them from evidence. A test reading the fixture's own conclusions would
prove that two halves of the fixture agree with each other.

What passes today:

- a weekly place routine discovered and quantified (weekday, start, spread,
  duration) with nothing telling it what shopping is
- the one skipped occasion noticed; the ones that happened not flagged
- an isolated deviation distinguished from a five-week departure shift, and the
  shift dated
- cross-domain associations formed, some supported, some rejected on contradicting
  evidence
- falsifiable predictions made, resolved against reality, signed error recorded,
  calibration fed back
- attention candidates whose evidence chains reach raw source events (§39 is a
  test, not a principle)
- **every derived row rebuilt byte-identically** from the untouched ledger
- **identically again through the Durable Object adapter**
- behaviour could not overwrite a stated preference
- no hypothesis can express causation
- a prediction miss and a dismissed recommendation stayed in different tables

### The real runtime — `npm run edge`

The two gaps above used to be listed here as unverified. `scripts/edge.mjs`
closes them by running the memory core on **workerd** — Cloudflare's actual
runtime, started by `wrangler dev --local` against `wrangler.edge-test.jsonc`,
with its own SQLite, its own alarm scheduler and its own input gating.

It cannot reach production: a different worker name, no routes, a local-only KV
id, and all state in a scratch `--persist-to` directory it deletes on the way
out.

`worker/edge-probe.ts` binds **two** objects, for two different questions. The
real `WorldObject` is imported and re-exported unchanged, so the append-arms-an-
alarm-which-reflects path is the shipping code rather than a copy of it. A second
`MemoryProbe` carries the introspection the production object deliberately does
not have — row counts, raw `SELECT`s, a forced mid-reflection failure, an isolate
`abort()`.

What now holds on the real platform:

- the schema creates, every table in the ladder present, `memory_schema` at 2
- a genuine **v1 → v2 migration**, with his stated fact, the recommendation he
  was shown and his response to it all intact afterwards; migrating again is a
  no-op
- `clearDerived` keeps every raw event and every `stated` row and discards the
  `inferred` row beside it
- appends are idempotent on `dedupeKey`; **eight concurrent appends** each land
  whole, which is input gating doing what it claims
- `setAlarm` schedules, the platform wakes the object, the handler runs a real
  reflection cycle and persists it, and **re-arms — including after a failure**
- a pass poisoned mid-reflection records itself `failed`, leaves the ledger
  untouched, and the next pass completes
- an evicted isolate and a **killed-and-restarted process** both find the same
  database

### What the real runtime found

**A Durable Object does not roll back a turn that throws.**

`durableObjectSqlDriver` had no transaction, and the comment explaining why
argued that input gating plus "writes within one turn are committed together
when the turn ends" already provided the strongest available guarantee, so a
`BEGIN`/`COMMIT` would be a weaker mechanism duplicating it.

The first clause is true. The second describes only the success path. Measured on
workerd, with the throw escaping the object's own `fetch` so the turn genuinely
fails:

| | outcome |
|---|---|
| statement, statement, uncaught throw | both **survive** |
| the same inside `storage.transactionSync` | both discarded |

The operation this endangers is `clearDerived`, which empties fifteen tables in
sequence. A throw between the fourth and the fifth leaves eleven tables holding
rows from the previous algorithm, and because every id is content-derived the
following rebuild upserts *around* them rather than replacing them. That is the
silent corruption `DERIVED_TABLES` exists to prevent, arriving underneath it.

So the driver now uses `transactionSync`, which is synchronous and fits
`SqlDriver` unchanged. `durableObjectMemoryStore` takes `state.storage` rather
than `state.storage.sql`, because the SQL surface and the transaction live on the
same object and taking them separately is how a caller passes one and forgets the
other.

The first version of this measurement was wrong in the reassuring direction: the
probe's own `fetch` caught the throw, so the turn succeeded at reporting a
failure and the write survived for an uninteresting reason. A harness that
confirms what you already believe is the failure mode this file is about.

## 16. Shadow Intelligence

The next milestone's first phase. The pipeline now runs against live observation
flows on both hosts and **nothing it concludes reaches a screen**.

### 16.1 There is no `shadowMode` flag

`authority.ts` holds a map from capability to `'shadow' | 'live'`, defaulting
every row to `shadow`. There is deliberately no boolean, because the handoff's §3
forbids `legacy OFF / memory core ON` and its §52 gives an eight-step order to
migrate authority in — neither of which a two-state flag can express, and both of
which a two-state flag invites somebody to skip in one line.

`nextCapability()` returns the first still-shadowed capability in §52's order, so
widening authority a step at a time is the path of least resistance and jumping
to recommendations requires naming it.

### 16.2 What a pass now records

`shadow.ts` wraps `runCycle` as an **observer** — same arguments, same writes, and
removing it changes no cognition. It censuses derived state before and after and
records the delta: entities added, episodes opened/updated/closed, routines
emerging/strengthened/weakened, hypothesis support and confidence deltas with
status transitions, predictions made and resolved with signed error, anomalies,
and the snapshot delta.

The half that is the point is `candidates`: every candidate the pass could have
made, with a **typed** verdict on each. `ReflectionRun`'s six counts could say a
pass ran; they could not distinguish four real routines from three real ones and
"he is at home".

Stored in `shadow_runs` (schema v2, the migration ladder's first real rung),
capped at 1500 rows, and **not** on `DERIVED_TABLES` — a rebuild cannot reproduce
what the model concluded when it stood as it did, which is usually the thing a
rebuild is being compared against.

Read it with `npm run shadow` (see the header of `scripts/shadow.mjs` for §57's
actions). It opens the real database, and only `reflect` and `rebuild` write.

### 16.3 The significance gate

`significance.ts` answers a question nothing asked before: *should this have been
a candidate at all.* `compose` ranks, and ranking cannot suppress — on a quiet day
the least trivial of six trivial findings still wins, and §67's quiet slot never
happens.

Reasons are a union, not prose, because the useful question of a shadow run is
"what is this thing mostly throwing away, and is that right" — which needs
counting.

The rank test uses `INTELLIGENCE_THRESHOLD`, **not** `HOME_THRESHOLD`. The latter
asks "may this interrupt him"; the intelligence slot is a fixed slot that
interrupts nobody. Measured, not chosen: every memory-core candidate over four
months of fixture scores 0.18–0.28, because `scoreOf` multiplies by actionability
and an observation is not an action. Against 0.32 the slot would be structurally
empty forever.

What is deliberately absent: §33 lists "whether the user likely already knows",
and there is no honest measurement of it. The tempting proxies — old, strong — are
both wrong in the direction that matters, since §64's flagship case is a
five-week-old strongly-supported shift he had *not* noticed. The only "he knows"
asserted is the one with evidence: we told him.

---

## 17. The negative corpus

`noise.ts` and `scripts/negative.mjs` (`npm test`). Four months of a busy,
plausible, fully-populated life with its structure absent by construction:
uniform departures, six equally-likely destinations, flat steps, random
attendees, a fortnight abroad, a fortnight of unexplained activity, a meeting
cancelled every week for four months, a placeholder never attended, a vendor that
mails more than any human, a provider on more events than any friend, GPS jitter
at the same coordinates daily, and ten days of accidental correlation.

**Every assertion is an absence**, preceded by assertions that the machinery ran —
an absence suite passes trivially if the pipeline silently did nothing, and
vacuous green is worse than red.

The two corpora are only meaningful together. A system that finds a weekly routine
in `fixture.ts` and also finds one here has not learned; it has a bias that landed
on agreeable data.

### 17.1 What it caught immediately

**An association test with no null.** `evaluateAssociation` measured each
qualifying day against the outcome metric's own global mean and compared the
resulting ratio to `SUPPORTED_RATIO = 0.7` — a bar that assumes a null of 0.5.
For a skewed or discrete metric the real null is nowhere near 0.5: `events_per_day`
is 0 on most days, so "lower by half a sigma" is true of most days *whatever
subset you pick*, and any condition at all came out at 70–80% support. Two
independent random series with a measured Pearson correlation of −0.11 produced a
supported association at 39 of 49 occasions.

The fix is two numbers, not one. The baseline moved to the complement group, and
the same classification is run there to give a control rate; `supported` now
requires the raw ratio **and** a lift over that control. Measured across both
corpora:

| | observed | lift |
|---|---|---|
| real (fixture) | .83–1.00 | .15–.40 |
| spurious (noise) | .79 | .07 |
| spurious (noise) | .62 | .15 |

Neither column separates them; the conjunction does. Collapsing them into one
score by any weighting throws away the distinction that does the work — which is
§4.4's argument about support and contradiction, arriving somewhere new.

**Predictions that narrow nothing.** §34 is written about probability, and half
the predictions commit to a range instead. "You will leave between 07:43 and
12:29" is not near-certain, so it passed the information floor, and it names most
of the morning. Since `predictions.ts` builds every interval at ±1.5σ of the
scoped series, width alone can never fail — what separates a real timing
prediction is whether the *scope* knows anything, so the test is the scoped
interval against the interval the marginal would give.

**Change points in metrics that cannot change.** `events_per_day` takes three
values, and the detector duly found a date after which it was "higher by about 1".
In sigmas that is 1.2, because the standard deviation of a three-valued series is
itself about one — every test framed in sigmas passes it. The test is now on the
metric's resolution.

**Grounds that were dates.** A hypothesis supported by days with *no* calendar
rows had `evidenceIds[0] ?? day` fabricate a date string as an id. The statistics
were fine — a quiet day is real evidence about a quiet calendar — but an absence
has no record to cite, so the citation is omitted rather than invented. A
hypothesis resting entirely on absences now reaches the gate with no grounds and
is suppressed for having nothing to show.

### 17.2 A data-loss bug in the foundation

`facts` was on `DERIVED_TABLES`, so `clearDerived` — every rebuild — deleted his
**stated** answers along with the inferred ones, and nothing regenerates them:
no source event produces a sentence he typed. The comment above `clearDerived`
argued at length that naming tables protects against exactly this, then named the
one table that is half his.

Naming cannot express it, so `DERIVED_ROWS` adds a row-level predicate for the
mixed table. Covered by an assertion that fails both ways: his stated fact
survives, the inferred fact beside it does not.

---

---

## 18. Real data — `npm run real`

The last unverified thing. `scripts/real.mjs` reads the world document out of KV
(the object mirrors every landed write into it, which is what keeps it
inspectable), turns it into ledger events through the same
`eventsFromWorldObservations` the edge calls, rebuilds, and reports. It writes
nothing anywhere.

It does **not** read the edge's accumulated ledger, which lives inside the
production Durable Object behind a session cookie signed with a secret this
machine does not have. That is the correct posture for a public hostname holding
his mail and his location, and it is why `/api/memory` exists as a read-only,
session-gated view rather than as anything a screen can reach.

### 18.1 The headline is the evidence, not the cognition

```
98 observations · 13 distinct days · 2026-08-05 → 2026-08-23
user 70 · calendar 9 · email 14 · health 5
```

Routines need 42 days of coverage. Hypotheses need 42. There are 13, and 70 of
the 98 observations are sentences he typed rather than anything a connector
measured.

So on today's real evidence the pipeline concludes **nothing**, and that is the
correct answer rather than a failure — a system that found a rhythm in thirteen
days would be the system the negative corpus exists to prevent. But it means the
honest state of §24 is that **the intelligence slot's threshold cannot be
calibrated from real distributions yet**, because there are no real candidates to
form a distribution from. The 0.18–0.28 range in §16.3 is still a fixture
measurement. Choosing a number from it and calling it calibrated would be
inventing the very thing §24 forbids.

The structural reason is worth writing down: `pullObservations` fetches **one
week back and one week forward**. The ledger accumulates across syncs, so
coverage grows with wall-clock time from the day the sink was deployed — it is
not something a change to the model can shorten.

### 18.2 What real data found that four months of synthetic life could not

**Every automated sender was a person.** Six of the seven "people" in his world
model were machines or himself:

```
person Anthropic       email:anthropic <no-reply-ipAiXkKl3EVYmUHAqUiGBg@mail.anthropic.com>
person Anthropic       email:anthropic <no-reply-uYWFet-rwV2O0YEBKvpTMA@mail.anthropic.com>
person Anthropic, PBC  email:"anthropic, pbc" <invoice+statements@mail.anthropic.com>
person Google          email:google <no-reply@accounts.google.com>
person serg            email:serg <cruciblecode1@gmail.com>
```

One defect, four symptoms. Gmail's `From` header is `Display Name <address>` and
both resolvers used the whole string as the identity, so:

- `personMailboxCheck` split on `@` and tested `NOT_A_PERSON` against
  `anthropic <no-reply-ipaixkkl3evymuhaquigbg`. The regex is anchored, so every
  machine **with a display name** passed. §17's "ask `people.ts`" fix was right
  and insufficient: the two resolvers were also both *parsing*, separately and
  identically wrongly.
- two no-reply addresses at one domain became two entities, both "Anthropic"
- `from === me` compared a header to an address and was false for every message,
  so his outbound mail was read as inbound
- and therefore **he was resolved as a correspondent in his own life**

The fix is `mailbox()` in `people.ts`, beside the question it feeds, called by
both resolvers. Angle brackets are looked for *before* separators, because
`"Anthropic, PBC" <…>` splits on a comma into an address that is not one.

**Nothing was supplying `me` at all.** `NormalizeOptions.me` is documented as
"his own address, so he is not lifted as a person in his own life", it is
optional, and no host passed it — not the Worker, not the Mac. So `ensureSelf`
built a self with no identities and every self-comparison compared against
`undefined`. The edge now passes `ALLOWED_EMAIL`, which is definitionally the one
account it serves.

After both: **two entities, `you` carrying his address, and the place Avano.**

**The fixture's fortnightly lunch never existed.** `if (w === 3 && dayIndex % 14
=== 0)` — the corpus starts on a Monday, so the offset selects Mondays and the
`w === 3` beside it asks for a Wednesday. Unsatisfiable. For the life of the
file, the fixture the header comment describes as containing "lunches with the
same person, roughly fortnightly, at the lake" contained no lunch, no lake and no
Bernardo — who is its **only human mail correspondent**. The keyed-person-from-a-
mail-header path therefore had no positive coverage at all: the newsletter
exercised the rejection and nothing exercised the acceptance, so a parser change
that rejected every sender would have been green.

**Calibration was pooled across models that are not the same model.**
`calibrationFor(store, kind)` gathered every `episode_occurs` outcome regardless
of which routine made it. With one routine in the corpus that was the same
question; with four, the pooled hit rate for a p=0.89 routine came out at 0.52.
Since `calibrationFactor` feeds it back into the next prediction's confidence,
the pooling is a channel through which an unreliable routine lowers a reliable
one's confidence. §9 already paid for this once from the other direction — "he is
at home" at 0.98 carrying the pool to 0.91 — and the fix then removed that
symptom by not predicting above p=0.95. This is the cause: §7's scope argument,
which was made for baselines and never applied to calibration.

**A `shift` could be believed on four days.** `shiftHypothesis`'s status ladder
asked for four decided samples and a ratio, and never for a span, so §8's
coverage bar was enforced for associations and not for shifts. A change point
four days from the end of the data became a supported claim that his life had
changed. `SHIFT_MIN_COVERAGE_DAYS = 21`, and deliberately not the association's
42: a shift's evidence is only the part after the change point, so a six-week bar
would suppress §64's flagship case for the five weeks in which it is the most
useful thing the system knows.

### 18.3 What the corpora learned from this

Both of them wrote **bare addresses** in `from`, and no real message has ever had
one. A corpus whose inputs are tidier than reality certifies the parts of the
code that reality does not reach — which is not a small remark here, because
that single unreality is what hid a four-symptom bug for the whole life of the
directory, in a suite whose entire purpose is to contain plausible non-people.

Both now carry `Display Name <address>`. `noise.ts` gained the three shapes his
mailbox actually produced — a per-message no-reply, a quoted display name with a
comma in it, and a brand on a billing mailbox — each mailing more often than any
of the twelve acquaintances, so a filter that misses them does not merely admit
them but ranks them first. It also gained her own outbound mail, because the
assertion that she is not lifted into her own contact graph could not fail while
`from === me` was structurally false.

### What is *still* not verified

- **The edge's accumulated ledger.** Everything in §18 is the world document,
  which is trimmed. How much the Durable Object has actually piled up since the
  sink was deployed is unmeasured, and `/api/memory?view=census` is the way to
  find out from a browser that has a session.
- **Enough real coverage to conclude anything.** 13 days. The bars are 42.

---

## 19. The second consumer — `server/domain.ts`

Phase 8. `intelligence.ts` compiles the ONE thought worth a slot of its own;
this compiles what a domain that already works can usefully be told, and the two
are deliberately different sizes of object.

```
memory / typed cognition
        ↓
  bounded domain context      DomainContext — one line, a subject, a weight
        ↓
  the existing domain model   CalEvent.note, MailMessage.note, Widget.context
        ↓
  React
```

`DomainContext` has no kind, no evidence trail, no visual, no actions and no
feedback controls. It is one sentence, attached to an object he is already
looking at, and the whole reason it is a separate type from
`IntelligencePresentation` is that a domain line is not a claim he is invited to
argue with — it is context. There is exactly one certainty ladder in this
codebase and one grounding guard, both in `intelligence.ts`; `domain.ts` imports
them rather than growing its own.

**Which capabilities it reads, and why that is the interesting part.**

| domain | capability | what it says |
|---|---|---|
| Calendar | `baselines` | unusual density for a day of this weekday; an event that starts before he is usually out of the house |
| Activity | `baselines` | the reading against the population the DAY IT IS FROM belongs to |
| Places | `routines` | which weekday and part of day a place belongs to |
| Mail | `entities` | what is arranged with the person who wrote |

Those are `authority.ts`'s **first three** capabilities. `intelligence` is the
seventh. That is not a coincidence of naming: a baseline comparison on a step
count and a hypothesis on his home screen are different sizes of claim, and §52's
migration order already says which is earned first. It means domain enrichment
can be promoted without touching the intelligence slot's authority — and, today,
that none of them is promoted, so all four return nothing in production.

**Two joins, both on structured identity.** Mail resolves a sender by lowercased
address, which is the same key `normalize.ts` writes and `people.ts` has always
used. Places resolves a pin by coordinate, through `entities.ts`'s own clustering
radius — and it takes the coordinate from the **visits**, because a place entity
carries `place:<the source's key>` and only sometimes a `geo:` identity. Parsing
a coordinate back out of a source's key would work on the fixture and on nothing
else.

**What it must never do**, asserted in `scripts/negative.mjs`: speak while a
capability is shadowed, compare against a baseline of three days or one with no
spread, call a place visited on four weekdays a weekday habit, write a line about
a person with nothing arranged, or let a read that throws cost anything but its
own domain's sentence.

---


## 14. Developer tooling

`inspect.ts`, all read-only:

```ts
overview(store)      // counts per table, last runs with their notes
entities(store)      // identities, aliases, which are bare names
routines(store)      // status, cadence sentence, evidence counts
hypotheses(store)    // the support/contradiction SPLIT, not just confidence
predictions(store)   // with outcomes and signed errors
explain(store, id)   // walk a conclusion back to raw source events
evidenceEvents(...)  // the same, as a list, for assertions
dump(store)          // all of it
```

`explain` is the one that matters. A ref resolving to nothing is printed as
`NOTHING HOLDS THIS ID` rather than skipped — that is the entire diagnostic value,
and silence there would hide exactly the failure it exists to find.

---

## 15. A note on `pg`

`package.json` depends on `pg` and `@types/pg`. Searching the live tree
(`server/`, `worker/`, `src/`, `scripts/`, `docs/`, deploy config) finds **no
import of it**. The only mention is a comment in `server/push.ts` describing the
*old* implementation: "Node's crypto and a Postgres table — neither exists on a
Worker."

Per §2, it is treated as **dormant**. Nothing here is built around it, and it has
not been removed — the runtime that once needed it may yet reappear, and removing
a dependency on the strength of a grep is how a build breaks somewhere nobody is
looking.
