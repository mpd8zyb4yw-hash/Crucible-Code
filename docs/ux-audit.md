# The interaction audit

*§4 and §90. Findings from **using** Crucible on the reference mobile viewport
(402×874, the iPhone 17 logical size the visual gate already captures at), not
from reading component source.*

Method: the app running against `scripts/fixture.mjs`, driven by synthesised
pointer events, with every reachable affordance enumerated from the DOM —
`cursor: pointer` as well as real buttons, because several of the interesting
ones are neither `<button>` nor carry a `data-role`, and an audit that only
counted the tagged ones would have missed the two worst.

Two mechanical notes, both of which cost a wrong conclusion first:

- **Read state after React re-renders, not in the same tick.** Mail's sort
  control looked dead — `innerText` was identical immediately after the tap. It
  works; the read was stale. (Already recorded in the harness notes; it applies
  to auditing by hand too.)
- **A harness that catches its own throw proves nothing.** The first
  Durable-Object tear test caught the exception inside the object's own `fetch`,
  so the turn succeeded at reporting a failure and the write survived for an
  uninteresting reason. See `docs/memory-core.md` §13.

A third has been added by this round, and it is the most useful of the three:

- **A control that passes every automated check can still deserve deletion.**
  `scripts/interaction.mjs` sweeps 53 visible controls for an accessible name
  and a real handler, and every one of them passes. The three that were deleted
  this round all passed too. Wiring is not justification.

---

## Verdicts

### REMOVED

| control | what it promised | what it did |
|---|---|---|
| Relevance card's action pill | "Set a reminder" | opened the Calendar day view; set nothing |
| `Relevance.action` projection | — | dead field once the pill went (§75) |
| Home's `as of <time>` stamp | how old the picture is | broke a frozen contract rule |
| **The intelligence slot's `Mind` projection** | Crucible thinking out loud | rendered whichever synthesis need carried an `opening` — a mail count |
| **`Watch ↗`, on every video card** | play this | it worked; it was also the loudest thing on a screen full of videos |
| **Rank badges 1–4 on video thumbnails** | — | a leaderboard over a four-item grid; the control's real job was selection |
| **Settings' `⌃` chevron** | close | the word beside it already said so, inside the same one clickable header |
| **`every 12h · checked 08-07 · overdue by 9d`, per Watch row** | this watch's health | one dead scheduler, reported three times as per-row metadata |

**The intelligence slot is the headline of this round.** It read *"6 in the last
week from 5 senders. Newest: Your…"* — a count as primary content (§42),
truncated mid-word, restating the Mail widget one swipe to the right, carried
onto every other surface by the collapsed chat handle, with no tap target and
nothing underneath it to open. Four separate frozen rules, broken by one
projection nobody had ever pointed at the cognition it was named after.

It was not renamed. `HomeDeck.mind: Mind | null` is gone and
`HomeDeck.intelligence: IntelligencePresentation | null` replaces it, and the
difference is in the TYPE rather than in the wording: `Mind` was `{ needId, body,
chips }`, which can hold any sentence any generator produces.
`IntelligencePresentation` can only be built by `server/intelligence.ts`, from a
`Hypothesis`, an `Anomaly` or a `Prediction`, with every quantity in its copy
checked against the record it came from. There is no fallback and no degraded
path: when cognition has concluded nothing that clears `significance.ts`'s bar,
**the slot is absent**.

**`Watch ↗` and the thumbnail are one decision, not two.** Three white pills
were the loudest elements on the Video surface, louder than the videos they were
about (§54) — and the obvious target, the thumbnail, was wired to *expand* the
card. §25's rule resolves it in one move: the picture plays, the words open up.
Deleting the pill was possible only because the action found a natural home.

### KEPT — including one I nearly deleted

| control | why it stays |
|---|---|
| the reserved 24px status band | its emptiness is load-bearing: reserving it is why "undo" stopped printing across a card |
| the stale-day warning inside it | `staleDay` means the cards predate the day turning over |
| deck position dots | inert readout, exactly as the contract specifies |
| Activity's whole surface | one figure, one chart, missing ≠ zero, and copy that refuses to judge |
| Video's error card | the one card with **no** action button, because it cannot be opened |
| Calendar's `find 90 min` | real work, shown on the timeline itself |
| Settings' section names | "What I think with", "What I know" — plain language, no jargon |
| the video selection control | it is a checkbox now instead of a rank, but it was always a real control |
| Settings' grab handle | the idiom that says "this sheet dismisses"; it is what a thumb reaches for |

The near-miss is worth recording. Splitting the stale signal, I first deleted it
whole — and the comment above it said, correctly, that one of its two values is
`'yesterday'` and "a screen quietly showing yesterday's day-bound cards under
today's deck is the single worst thing this app can do". Two different things
were travelling down one string: a **timestamp** (chrome, forbidden) and a
**correctness warning** (not chrome, essential). It is now a boolean, so a caller
cannot render a time it was never given. §76 — do not over-delete domain
capability — is the rule that caught me.

### FIXED

| # | defect | verdict | what changed |
|---|---|---|---|
| 1a | the intelligence slot is a mail counter | REMOVE | Phases 6–7. Typed presentation boundary; no prose path into the slot |
| 1b | …**and it follows you everywhere** | FIX | the collapsed chat handle fell back to `need.opening` when the thread was empty, so the same sentence was drawn along the bottom of Calendar, Mail, Activity, Video and Watch. An empty conversation has no last message: the handle now says "Ask about this". **Replacing the slot alone would have left this in place** — it reached every other surface by a second route |
| 2 | the intelligence card is not tappable | FIX | `role="button"`, `tabIndex=0`, Enter/Space, and a real evidence surface behind it |
| 3 | `Show all domains` is a 1×1px focusable button | FIX | `.cru-skip` — clipped until focused, legible the moment it is. Zero permanent pixels, real non-touch path |
| 5 | engine state on every Watch row | MERGE | cadence and last-checked moved into the row's expansion; "all of these are overdue" is now one sentence in the status line |
| 7 | `Watch ↗` on every video card | REMOVE | the thumbnail plays; the text expands |
| 8 | numbered badges 1–4 on video thumbnails | FIX | it is a selection checkbox in both states, not a rank in one of them |
| 9 | Settings has three exit affordances | MERGE | handle + one named `close` button; the chevron is gone |
| 10 | Settings is reachable only by a 700ms long-press | FIX | typing `settings` opens it — the composer is on every screen and already says "Ask Crucible anything…". The long-press stays and now has an accessible name that mentions it |
| 6 | `find 90 min` produces four presentations of one action | MERGE | the `undo` is gone — `VIEW_ONLY` operations commit without entering the undo history, because nothing was created, moved or deleted and the `×` beside it already cleared the highlight. The sentence no longer repeats the date the header is already showing; it says only what the dashed regions cannot, which is whether the first opening is even on this day |
| 11 | Mail's sort toggle is `↓` / `A` | REMOVE | a permanent two-state toolbar control whose state and purpose were both unreadable, explained only by a `title` tooltip that a touch device can never show. The sender filter in the overflow does the sharper version of the same job by name. The `sort` **operation** is untouched, so the assistant can still be asked to sort — this deletes a control, not a capability |
| — | the relevance subtitle clamped mid-word | FIX | the pill's row is free, so the subtitle takes the contract's two lines; the server budget was widened from 60 to 92, since 60 described the old shared row |

### CLOSED — the two that were open, fixed at the generation boundary

Both were recorded last round as "the real fix belongs upstream", and both turned
out to be upstream in a worse way than the audit had seen from the screen.

| # | defect | what it actually was | fix |
|---|---|---|---|
| 4 | the header's "4 this week." above six visible rows | **the fixture's invention, captured 69 times as though it were the product.** `panes.ts#row` gives every source need `status: ''`, so the real server has never produced a subtitle there; the fixture wrote one per source and `Report`'s header drew it. Every capture of every application has been of a header production does not have | the count is gone rather than corrected. The header's own comment already stated the rule it was breaking — *"what survives is what is not recoverable from the surface itself"* — and a count of the things listed two centimetres below it is the most recoverable fact on the screen. The count that IS useful is scoped, filterable and already there: Mail's `Unread 3` chip. `scripts/contract.mjs` now fails the build if a source need carries a subtitle at all |
| 12 | eyebrow `TOMORROW · 11:00` above subtitle "Tomorrow at 11:00 AM…" | **two defects wearing one symptom, and only the milder was visible.** The fixture's is the one the audit saw. The one in production is worse: `needFrom` sets `detail` from the builder and `status` from `because.sentence`, and the travel-plan builder's detail IS its `because.sentence` — while `relevanceFrom` preferred `because.sentence` for the eyebrow. On the card type this app is proudest of, the eyebrow was a 47-character prefix of the sentence printed beneath it | two changes, both where the strings are written. The eyebrow now reads `heatLabel`, which `heatLabelFor` composes from typed inputs and no builder can reach — so eyebrow-equals-sub is structurally impossible. And `budgetForHome` is handed the **instant** the eyebrow will render (not its words) and moves a leading sentence that says only that instant into `status`, where everything this file trims already goes. Regression tests at the boundary in `contract.mjs`, including the one a looser rule would break: *"Tomorrow it will be closed."* must survive untouched |

The card now reads

```text
TOMORROW · 11:00
Restaurant with Odelia

You asked when to leave earlier today.
```

Three slots, three facts. Nothing was deleted — the clause is in `status`, which
is what "Why am I being asked?" opens.

**What #4 is really a lesson about is the fixture.** A gate is a picture of
whatever the fixture serves, and this one had been serving a header the server
cannot emit. Two more things were routed through the real code this round for the
same reason — `budgetForHome` and `enrichPanes` now run over the scenarios' data,
alongside `buildDeck` and `presentShift`, which were already — and the rule is
worth stating plainly: **the fixture owns the DATA and never the PROJECTION.**

---

## Phase 8 — what using it changed

Four domains, used before being modified: Home, into the domain, every visible
object tapped, depth opened, back. What the memory core now CONTRIBUTES is one
line per domain and is documented in `docs/memory-core.md` §19; what follows is
what USING them found, which is a different and longer list.

The pattern worth naming before the tables: **every card that gained a sentence
lost a control to make room for it, and both are better for the exchange.**
Activity gave up a white pill offering to set a goal and a `+12%` badge, and got
"a little above your usual Thursday" plus ninety pixels of chart. Places gave up a
foot that read its own first row back, and got a rhythm on the row itself. That
trade is the one to look for, and it is not the one the reflex reaches for — the
reflex is to add the sentence and keep everything.

### REMOVED

| control | what it promised | what it did |
|---|---|---|
| **`Make 7,180 the goal`, on the Activity Home card** | set a goal | it worked, and it was a white pill and the loudest element on a card whose job is to say how today went — offering to configure how every future reading gets judged, from a glance surface. §33's "did anything feel like configuration work?", answered on the first card that asked it. The same action is on the Activity **surface** with the line that explains where 7,180 came from, which is where a decision like that can be made. The capability, the surface control and the assistant's ability to run it are untouched: a control was deleted, not a capability |
| **`undo`, after opening a message** | take that back | *"Opened Re: Odelia — Saturday.  undo  ✕"*. Undo of what? Nothing was created, moved or deleted; a message was looked at. `VIEW_ONLY` in `src/surface/store.ts` states the membership test exactly — "would undoing this restore any fact?" — and `mode` and `focus` were simply not in the list. The file's own comment calls this the third instance; this is the fourth, on the most ordinary action in the application |
| **`Nearest is Avano, 3.4 km away.`, under the Places card** | the nearest thing | the row above it read `Avano … 3.4 km`, and the rows are sorted by distance, so row one IS the nearest by construction. One card, one fact, printed twice — slot two's no-restatement rule happening inside a single widget. Removed rather than reworded: there is no version of it the rows are not already saying |
| **`+12%`, on the Activity card, while a personal comparison exists** | how the week is going | this week against last week, beside "a little above your usual Thursday" — the same conclusion in two units, in the two most prominent places on the card. §9's metric soup at its smallest scale. It gives way to the personal comparison and comes back when there is none |

The undo one generalises, so it was fixed as a rule rather than as four names.
`VIEW_ONLY` is now derived: **every operation the surface vocabulary declares is
a state of looking except `draft`**, which makes a reply that did not exist
before. `contract.mjs` fails the build if `MUTATES` names an operation no surface
declares. Written as the exception rather than the rule on purpose — a new
operation is view-only by omission, which fails towards a missing undo rather
than towards an undo that silently does nothing.

### FIXED

| defect | what changed |
|---|---|
| replying to a reply produced `Re: Re: Odelia — Saturday` | `replySubject` prefixes once, case-insensitively, and only when the subject does not already start with one. Found by replying to a reply, which is what most replies are |
| the Calendar detail sheet was the block behind it, larger | title, time, location and an `Edit` button — every one of them already on the timeline block or in the header. §35's depth test failed outright: *the same thing, larger*. It now carries the departure line when there is one, in `CalEvent.note` — a slot that has existed, typed, with the sheet already written to draw it, and that **nothing had ever populated** |
| the Mail reader showed a body and nothing else | one message out of a three-message exchange, with no indication of who Odelia is or why "Done — booked, 11:00, under Rossi." matters. It now carries what is arranged with the sender, under their address, above the body |
| the dead-control sweep's total moved with the tests before it | the sweep ran on whatever state the tasks left — Mail counted 6 controls while stuck in reader mode and 15 from a clean start. It clears storage first now. **The previously reported 53 and today's 50 are not comparable numbers**, and that is the finding rather than a reduction to claim |

### FIXED — found by the source-blind pass, after the gates were green

| defect | what changed |
|---|---|
| **switching the brain appeared to do nothing** | pressing `Think with this` on Gemini left `IN USE` on Anthropic and the header still reading `claude-opus-5`. The cause was the FIXTURE: `/api/active` fell through to a catch-all `{ ok: true }` and no state was kept, so a working switch and a broken one looked identical. Worse, the interaction gate's provider task asserted only that settings OPENS — the one thing that screen exists for had never been performed by any gate. Both halves fixed: the fixture keeps two lines of state, and the gate now asserts the badge MOVES |
| **a fixture nobody started could serve a whole run** | `freePort` deliberately kills only an orphan — the port-killer that shot a sibling suite is a mistake the harness does not repeat — so a fixture left running by hand survives it, the harness's own then fails to bind silently, and `waitFor` is answered by the old process. **It happened during this phase**, and it cost two green runs of a Places assertion whose compiler had stopped producing the line it asserts. The fixture reports its pid on `/__id` now and the harness refuses to continue against one it did not start |

The second is the more expensive lesson. A green run against yesterday's code is
worse than a red one, and nothing in the output distinguished them.

### KEPT AFTER INTERACTION

| control | why it stays |
|---|---|
| `find 90 min` **and** `find 30 min` | two arguments to one real operation, behind the overflow, both drawing on the timeline. §22: this is not a button-count contest |
| the Places permission banner | two lines of orange instructions is loud, and it is the only thing on that surface that can fix the surface |
| the Activity depth's `Make 7,180 the goal` | the same control the card gave up, with `Your seven-day average.` beside it. Depth is where configuration belongs |
| `+12%` when there is no baseline | the fallback is the point: with the memory core silent — which is production — it is the only comparison the card has |
| the reply composer's three exits (`✕`, `discard`, and the status `undo`) | noted and not touched. A draft is a real object, so undo is honest here; three ways out of one composer is worth a look, but not on the same pass that changed what the composer opens onto |

---

## The measurement that framed the previous round

Home's content ended at **y=664 of 874** — roughly a quarter of the screen empty
between the intelligence slot and the composer — while the intelligence slot
truncated its sentence mid-word.

The gap is unchanged, and that is now a deliberate answer rather than an
oversight: the three slot heights are the contract's (340 / 126 / 170), the
intelligence slot is the one permitted to compress, and **an absent slot leaves
space rather than growing its neighbour**. What changed is what occupies the
170px. It is no longer a clipped mail count; it is a finding with its evidence
one tap behind it.

The quiet state was decided the same way and is worth stating explicitly (§9):
**the slot is absent, not a placeholder.** No "No insights today", no "Everything
looks normal", no fallback to counts. Home's geometry is unaffected because
absence already collapses by contract, and a card-sized rectangle explaining that
there is nothing to say would be the app filing its own taxonomy on his home
screen — the same failure the three empty attention bands were deleted for.

---

## What the intelligence slot now costs, in controls

Face: **zero**. The card is the control (§11, §25), so there is no `View
details` pill beside a card that already opens on tap. The two model-written
chips it used to carry are gone with it — they were the only tappable thing on
the card, which is why the card itself did nothing.

Depth: **four**, all secondary, all after the evidence — `‹`, `Useful`, `Not
useful`, `Wrong`. §17's constraint was three large buttons under every insight;
these are 11.5px pills at the end of the screen, and the correction input only
exists after `Wrong` is pressed.

`Wrong` is not a dismissal. `Useful` / `Not useful` move engagement; `Wrong`
reaches the hypothesis and writes a `stated` fact that survives `clearDerived`.
The acceptance test for it is in `scripts/memory.mjs` under §16: deny a supported
hypothesis, rebuild from the untouched ledger, watch cognition legitimately
re-derive the same claim, and assert it still never reaches the slot.

---

## What has not been audited

The pinch zoom-out grid and RSVP were not driven by hand this round. Places was
opened and used; the reply composer was opened, typed into and dismissed; the
model switch was performed and now has a gate.

**No unresolved `FIX` item is being carried.** Both items the previous round left
open are closed above. Two things are recorded as decisions rather than as debt,
and neither is a defect:

- **The reply composer has three ways out** (`✕`, `discard`, and the status
  line's `undo`). Left alone deliberately — a draft is a real object, so undo is
  honest there, and merging the three is a change to what the composer IS on the
  same pass that changed what it opens onto.
- **The intelligence threshold is not calibrated.** Thirteen days of real
  evidence cannot calibrate a gate whose bars want forty-two. That is pending
  evidence, not unfinished implementation, and revisiting it before real
  candidate distributions exist would be choosing a number to make a slot speak.

**Phase 8 is done, and its authority is not.** Calendar, Activity, Places and
Mail each consume a bounded `DomainContext` compiled by `server/domain.ts`, and
each gates on the memory core's existing capability map — `baselines`,
`routines`, `entities`, which are the FIRST three of `authority.ts`'s eight
rather than the seventh that `intelligence` reads. All three are still `shadow`
in production, deliberately: promoting one is an evidence decision and the real
ledger holds thirteen days. So what the app ships today is the app with every
enrichment absent, which is the state `scripts/negative.mjs` now asserts one
compiler at a time.

That means the four sentences below have been seen in the fixture and in the
acceptance suite, and **not once on his own data**:

```text
Busier than your usual Friday.
A little above your usual Thursday.
Usually Saturday morning.
You are seeing Odelia tomorrow at 11:00.
```

The first three are compiled from the synthetic life in `scripts/memory.mjs`,
which contains no answers, so they are conclusions the system reached rather than
strings a fixture wrote. That is evidence about the compilers. It is not evidence
about whether they help him, and nothing here should be read as though it were.

## The two rules this round is worth remembering for

**A gate is a picture of whatever the fixture serves.** "4 this week." was
captured 69 times as though it were the product, and the server has never emitted
it. Four things now run through the real code — `buildDeck`, `presentShift`,
`budgetForHome`, `enrichPanes` — and the rule they are all instances of is that
the fixture owns the DATA and never the PROJECTION.

**A count that moves with the tests before it is not a count.** The control sweep
reported 53 last round and 50 now, and the difference is mostly neither deletions
nor additions: Home's controls depend on which domain the deck is showing, and
the deck remembers where the previous test left it. Mail counted 6 controls while
still in reader mode from an earlier task and 15 from a clean start. It clears
storage first now, and prints per surface:

```text
Home 5 · calendar 4 · mail 15 · fitness 4 · places 4 · video 15 · watch 3
```

**The two numbers are not comparable**, and saying so is more useful than
claiming a reduction. The deliberate deletions this round — the Activity goal
pill and the `undo` after a view-only operation — are not in the delta at all,
because the sweep measures freshly-opened surfaces on which neither had appeared.

**And a harness that crashes is worse than one that fails.** The geometry stage
died on the last check of the last screen with `Cannot read properties of null`,
because a measurement taken mid-render found no shell and the next line read
`.bottom` off it. Not a reported defect, not a reported flake — a stack trace
that stopped everything after it and did not reproduce on either of the next two
runs. It retries once and reports a real absence as a failure now.
