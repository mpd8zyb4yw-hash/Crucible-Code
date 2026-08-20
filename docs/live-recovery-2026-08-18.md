# LIVE PRODUCT RECOVERY — 18 August 2026

**Method.** The app was run at the mobile reference viewport against **his real
production world**, pulled out of KV, rather than against a fixture. Nothing
below was found by reading source. Every defect was seen on screen first and
traced afterwards, which is why several of them had survived a green suite for
weeks.

`docs/ux-audit.md` is superseded by this file for everything it overlaps. It was
a snapshot taken against fixture data, and fixture data is exactly what hid the
first and largest of these.

---

## THE ONE-LINE SUMMARY

His calendar is nine events, seven of which had finished. Eight of the nine are
all-day. `deck.ts` filtered "what is ahead" with `e.allDay ? true`, which is not
a filter — so Home led with a restaurant booking from ten days earlier and
claimed `8 ahead`, while the readline **in the same JSON payload**, built by a
different implementation of the same predicate, correctly said "Nothing on
today's agenda. Hiking with Mauro is tomorrow."

Nothing was stale. Nothing had failed to sync. No cache was involved. Two
functions disagreed about the meaning of one word, and the wrong one owned the
largest object on the screen.

---

## A. CALENDAR — ROOT CAUSES

### Why stale events appeared

`server/deck.ts`, calendar branch:

```ts
const ahead = w.events.filter((e) => (e.allDay ? true : Date.parse(e.start) >= now.getTime()))
```

`allDay ? true` exempts every all-day event from expiry, permanently. The correct
predicate existed forty lines away in `panes.ts#nextEvent` and was used by the
Home *line*, the *focus* id and the row *heat* — but not by the widget.

Fixed by deleting both and writing one: `server/calendar.ts`. Nothing re-derives
currency now; a surface asks and renders the answer.

### Why current events were absent from Home

Two reasons, and the second is the more interesting.

1. The hero fell through to `ahead[0]` — the earliest event in a list that
   included everything since the 8th — so tomorrow's hike sorted ninth.
2. **The Calendar widget had no rows.** The design specifies "the hero, then the
   following two, each with its time as the lead column"; the implementation had
   a hero, an all-day band and an hour axis. On a day with no *timed* events the
   axis draws nothing, so the widget was a hero and two chips over 200px of
   black — and there was no element on it capable of showing tomorrow.

### Why entering Calendar changed what he saw

It did not fetch anything, and there is no second endpoint. Tapping the widget
focused the **hero**, and focusing an event moves the calendar cursor to that
event's day (`reducer.ts`, `case 'focus'`). The hero was 8 August, so Calendar
opened on Saturday 8 August, ten days back, with a `Today` button beside it.

Depth was never fresher than Home. It was showing a different day.

A second, real instance of the same class was found afterwards: the surface
cursor persists in `localStorage`, so reopening Calendar days later landed on
whatever day was last looked at. A stored cursor from a day that has passed is
now dropped **on mount only** — see §E, because the first version of that fix
re-ran every render and forbade going back at all.

### Why the wrong Calendar implementation was mounted

**It was not.** There is exactly one Calendar component in the tree
(`src/surfaces/Calendar.tsx`), one calendar deck branch, one canonical read. No
legacy renderer, no unwired newer file, no duplicate adapter. The inventory:

```
ACTIVE                    src/surfaces/Calendar.tsx, server/deck.ts#calendar,
                          server/panes.ts#canonical, server/widgets.ts#normaliseEvent
LEGACY BUT REFERENCED     none
DEAD                      none
FIXTURE-ONLY              none
UPDATED BUT NOT WIRED     none
```

What is real in the report is that **the mounted Calendar does not match the
design that was authorised.** Measured against `docs/widget-depth-spec.md` §3,
which is the written specification of that design and is in the repository:

| §3 requires | was | now |
|---|---|---|
| hero = the next event, with relative timing | a 10-day-old event, `rel` blank | next event, `rel` = "tomorrow" / "in 40 min" / "now" |
| rows = the following two, time as lead column | **did not exist** | present, lead is a clock today and a day name otherwise |
| all-day as a band that is not the hero | band repeated the hero verbatim | hero excluded from the band |
| zone B yields its space rather than leaving void | 200px of black | rows take it when there is no axis to draw |

**I could not open the file you linked.** `claude.ai/design/p/df0c3e9d-…` returns
403, and the artifact id is not readable either. So the implementation is built
to §3 rather than to the design itself. If §3 and the design disagree anywhere,
send me the file — a `.html` export or a paste — and I will reconcile them.

---

## B. CROSS-DOMAIN DEFECTS

### Mail

| defect | evidence | fix |
|---|---|---|
| HTML entities rendered literally | `Here&#39;s how some of our power users…` on all four rows | `cleanSnippet` at ingestion **and** at the canonical read, so existing data is repaired without a migration |
| preheader padding filled the preview | ~90 invisible U+034F characters after each opening line | same function; the whole class of zero-width characters, not one vendor |
| four rows tinted as urgent | `hot: t.unread`, with 8 unread | `hot` is at most one row and means "this needs you"; `unread` became its own field and keeps the dot |
| bulk mail outranked people | ranking was unread-only, and bulk mail is what stays unread — the card was four Claude Team and Google notices | a `no-reply@`-style sender cannot be corresponded with and ranks below one that can |
| 11- and 12-day-old mail on a widget whose empty state says "in the last week" | the window was in the Gmail query and never in the read — the same shape as the calendar defect | the read is windowed to seven days |
| Home rolled threads up, depth did not | Home showed `Security alert ×2`, depth listed both flat | **not fixed** — see §D |

### Activity

| defect | evidence | fix |
|---|---|---|
| a daily verdict on two hours | "0 steps today … 425 short of your 3,221", at 10:00, from an 08:00 sync | while the day is running the gap is stated as distance ("3,615 to go to your 8,000"), not deficit. Figure and target unchanged |
| the goal stated three times | dashed line on the chart, `goal 3221` in the trend corner, and "your 3,221" in the sentence | the corner reverts to the trend when the chart can draw the goal line |
| an unformatted number beside formatted ones | `goal 3221` next to `2,796 / 3,221` | one formatter |
| `3221 steps of steps a day` | stored prose, generated by `${target} ${unit} of ${metric} a day` with unit === metric | the phrase is recompiled from the typed fields on read, which repairs the goal already in his account. A description **he** wrote is left alone |

I attempted a fifth fix here — treating a `0` from Google Fit as "no reading" —
and **reverted it**. `scripts/activity.mjs` records that `.filter(d => d.steps > 0)`
was removed deliberately, because it made "did not walk" and "connector said
nothing" the same fact. I was about to reintroduce a bug a previous session had
already paid for. The suite caught it.

### Places

Location was denied, and the recovery instructions were hard-coded to Safari —
"Safari → aA in the address bar → Website Settings → Location" — shown verbatim
in Chrome. A confident wrong answer to the one question the message exists to
answer. Now chosen per engine, with a truthful generic fallback.

### Video

The full YouTube description was rendered into a 150px box with its own
scrollbar: Patreon links, a coffee promo code, a chapter index, an
explicit-content disclaimer and a wall of hashtags. `synopsis()` keeps the
leading prose and stops at the first thing that is plainly not prose. The
scroller is gone.

### Watch

`All · Armed 0 · Paused · Changed` drawn above "Nothing being watched yet." Four
controls partitioning an empty set. Hidden below two watches.

### Relevance / intelligence

Slot two carried a model-authored card about the same event the Calendar widget
was drawing, one inch below it — "Hiking with Mauro · Scheduled for tomorrow at
9am", where the 9am was read out of the event's *title* and the event is all-day
with no clock at all. The no-restatement guard was correct and could not see the
evidence: it compares object ids, and a model-authored card attributes itself
with `basis`, which holds observation ids. `objectIdsOf` closes that.

---

## C. DELETIONS

Removed rather than repaired, per §19.

| removed | why |
|---|---|
| `New event` chip on the Home Calendar card | ran `calendar.create` with no parameters — one tap wrote an untitled event onto his real Google Calendar at that instant, unconfirmed. A card with no fields cannot carry a create. It already exists in Calendar's own menu |
| the free-windows prose line | "7 free windows: tomorrow 08:00 AM, Thursday, Aug 20 08:00 AM" over a grid already drawing all seven, in 12-hour time beside a 24-hour axis. Four presentations of one result; this was the weakest |
| the Watch filter row when empty | see above |
| `goal 3221` from the trend corner when the chart draws the goal | third statement of one fact |
| the description scroller in Video | rung zero of the overflow ladder |

One control was **built out** instead of deleted: `find 30 min` drew dashed
regions with no click handler at all — the finder found the answer and had
nowhere to put it. The regions are now tap targets that open the editor with the
time pre-filled, which is what §3 specifies. That also gave the editor a create
mode it did not have.

---

## D. WHAT I DID NOT FIX

Stated plainly rather than left to be discovered.

- **Mail thread identity differs between Home and depth.** Home rolls messages up
  by `threadId`; the Mail surface lists them flat. They agree about every
  message's identity and state, so it is not a correctness failure under
  "one domain, one current truth" — but it is a real inconsistency and it is the
  gap `widget-depth-spec.md` §4 already names.
- **The memory core keeps evidence for retired observations.** That is
  deliberate: the world document is the standing state of his life, the memory
  core is the ledger of what was observed, and a cancelled event *was* observed.
  Beliefs resting on a retired observation are contested automatically
  (`reconcileBeliefs`, asserted in the new gate). Episodes and predictions are
  not re-evaluated on retraction, and that is unbuilt work rather than a fix I
  chose to skip.
- **Two genuinely distinct Google events at the same time are not merged**, only
  near-identical ones (identical span, one title a prefix of the other — which is
  what `Polenta in Avano` / `Polenta in Avano with rafaella` are). A clash is a
  fact this app exists to make visible.
- **The Calendar card still has empty space.** He has two upcoming events. There
  is no further truth to draw and I did not invent any.

---

## E. GATES

`scripts/freshness.mjs`, wired into `npm test`. Scenarios are his real calendar.

```
cold start          Home's hero is the next real event, with its day,
                    and the next-but-one is on the card — without a tap
expiry              finished events age out; a multi-day all-day event
                    survives every one of its own days and not the day after
running now         a meeting in progress takes the hero and says "now"
ordering            a timed event outranks an all-day one within its day,
                    and only within it
no restatement      the all-day band and the rows never repeat the hero
dedup               one commitment, one representation; a real clash survives
parity              every object Home names exists in depth and is not
                    something depth would call finished
reschedule          12:00 → 13:00 replaces; the old time is nowhere; one Lunch
cancellation        an event Google stops returning leaves the world —
                    and a failed sync, a truncated page, and another source's
                    sync each delete nothing
cognition           a belief resting on a cancelled event is contested and
                    is no longer near-certain
empty               everything finished ⇒ the card collapses and names nothing
lead column         a clock today, a day name otherwise
```

### Results, each run in isolation

```
contract     ok      activity  ok      dates    ok      world     ok
person       ok      memory    ok      negative ok      freshness ok
edge         ok      geometry  90/90   shots    69/69   interaction 74/74
                                                        · 50 visible controls swept
```

Two of these caught ME, and both were the same mistake in different places —
fixing the reported symptom and breaking something adjacent:

- `activity.mjs` refused a change that would have reintroduced a bug a previous
  session had already paid for (a `0` from a step counter is a reading).
- `interaction.mjs` caught the stale-cursor guard, which I had written as an
  expression over `state.cursor` — so it re-ran every render and did not adopt a
  stale cursor, it FORBADE a past one. Back-navigation snapped forward and an
  event on a past day could not be reached. It is a mount-only effect now.

`shots.mjs` also caught the first version of the Calendar rows, which let the
rows and the hour axis both claim zone B: 340px of box with 370px in it.

**A note on running them.** A full-chain `npm test` produced 66/69 and a refusal,
both from port contention with the deploy reconciler's concurrent run — three
cards failing hit-testing, two of them in surfaces this pass never touched. Run
in isolation every gate is green. The reconciler's own run reached the same
69/69 on captures before blocking itself on a fixture its first attempt left
behind. Neither was a defect, and both are the environmental class this harness
is already documented as having.
