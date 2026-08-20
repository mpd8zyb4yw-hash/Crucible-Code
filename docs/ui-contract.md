# THE CRUCIBLE UI CONTRACT

Frozen product decisions. **Read this before touching Home.**

These are not preferences and they are not implementation notes. Each one was
settled after a regression, and each one has since been broken by a later change
that was fixing something else. That is the pattern this file exists to stop: a
fix is not valid if it breaks an invariant below.

**None of these may be changed without explicit user authorisation.** If an
implementation makes one of them technically impossible, report the conflict.
Do not redesign the product around it.

---

## HOME

Home is **three slots**, and they never move:

```
1  the widget deck   one full-width domain widget, swiped sideways
2  relevance         the thing most worth saying underneath it
3  intelligence      Crucible thinking out loud
```

Authorised 2026-08-13, from the Phase 1 design. What it replaced is recorded in
the decision log; the rules below are the ones that survived it.

- **The widgets ARE the navigation.** Ranking no longer decides *whether* a
  domain is on Home, only which one you land on first. A domain leaves the deck
  by one route: he switches it off in Settings.
- **No app launcher and no app tab row.** The deck is not a launcher: it shows
  one domain at a time, at full size, saying what it currently has to say. A
  row of tiles, icons or labels standing for applications is still forbidden.
- **The zoomed-out grid is transient.** Reached by pinch, closes the moment a
  domain is picked, never on screen by default. It may not become a home screen.
- **The position dots are a readout, not a control.** They say where you are in
  the deck. They are not tappable and they never grow into pagination chrome.
- **No nested vertical card scrolling.** Home has exactly one vertical scroll
  owner. `Home scroll → card scroll → inner text scroll` is forbidden at every
  depth, including through a shared primitive. The deck scrolls **horizontally**
  and snaps; that is the one axis Home pages on.
- **Fixed slot geometry, from the design.** Deck widget 340, relevance 126,
  intelligence 170, overview mini 104. A widget does not get a height of its own
  and content never expands a slot.
  - The three tiers `compact` / `standard` / `tall` (112 / 168 / 224) are
    **retired for Home** as of the Phase 1 design, and are kept only where
    surfaces still use them. Home's geometry is the four numbers above.
- **Nothing on Home restates the phone.** No date, no day name, no clock, no
  town, no "as of" stamp, no source label. The phone already says the time and
  the widget already says which domain it is. What replaces them is picture.
- Long secondary text clamps. Long primary titles clamp.
- **Critical content is never clipped**: the question itself, the primary
  action, a blocking error, and anything needed to choose an answer.
- **Empty attention collapses.** An empty band is a compact unboxed row, not a
  bordered card-sized region. Empty content does not preserve populated
  geometry.
- Tap gives deeper detail.
- **No blank navigation destination.** Every tappable card resolves to inline
  completion, real content, or a declared designed empty state — decided before
  the screen changes, never discovered in render.
- One composer.
- No persistent drawer.
- **No new global navigation region** without explicit user authorisation.

### The overflow ladder

When content does not fit, in this order:

1. show less information
2. shorten the generated copy to the card budget
3. move to the next approved height tier
4. line-clamp noncritical text
5. reduce inline secondary actions
6. move the remainder into the tapped deeper view

`overflow-y: auto` and `overflow-y: scroll` inside a Home card are never the
answer, for any content: long subjects, long event names, long place names,
verbose model output, translations, large accessibility text, or a card kind
that does not exist yet.

### Clamps

| content | limit |
|---|---|
| primary title | 2 lines max (Home uses 1) |
| secondary preview | 2 lines |
| metadata | 1 line unless critical |

Stored truth and displayed truncation are separate. Never mutate the underlying
data to make presentation fit.

### Copy budget

Anything generated for Home receives a presentation budget. Targets:

| field | budget |
|---|---|
| question | ≤ 50 characters |
| baseline / reason | ≤ 60 characters |
| choice label | ≤ 20 characters |
| inline choices | ≤ 4 |

These are *generation* targets, not licence to mutilate meaning. Longer
reasoning stays attached and surfaces under *Why am I being asked?*, in the
focused detail, and to the assistant. `model writes paragraph → CSS invents
scroll` is the failure this prevents.

### Presentation reduction

Attention hands Home a ranked projection, never arbitrary prose:

```
headline · primaryFact · primaryAction · optionalSecondary
```

A scrollable Home card is evidence that prioritisation failed.

### Home shows life state, not engine state

Ranking scores, handled counts, confidence, lifecycle states and source
mechanics belong behind diagnostics. Every visible number must answer *why
should the user care about this?*

### Gesture navigation

Swipe is the primary mobile interaction for paged content and may never be the
only one. Non-touch and assistive paths exist (keyboard arrows, operable
pagination dots). They must not spend permanent mobile screen space on redundant
navigation chrome — no permanent `‹ • ›` rows.

---

## CALENDAR

- Focused object modes: `browse → detail → edit`.
- No persistent Calendar detail drawer.
- **The detail sheet does not scrim, dim or blur the calendar behind it.** It is
  a compact card over a live surface: tapping another event switches the card to
  that event, which is what someone comparing two things is trying to do. The
  Phase 1 design drew a bottom gradient over the day; it was not taken.
- **Editing replaces the calendar.** No grid behind it, no composer competing
  with the fields, and the way out is on the screen.
- Day, week and month all ship. Nothing appears in the view picker that does not
  draw a real view.

## MAIL

- Reader and reply modes. The shared composer becomes the reply.
- No reply drawer.

## ACTIVITY

- One summary, one interactive chart.
- Gesture-first navigation.
- Missing ≠ zero.

## QUESTIONS

- Answered inline on Home.
- Never become empty surfaces.

## GLOBAL

- One dominant interaction at a time.
- One composer.
- No blank pane.
- Every application surface has a declared empty-state component. A title plus
  an empty black region is invalid.

---

## HOW THIS IS ENFORCED

`scripts/shots.mjs` runs the real app in Chromium and measures, on every
capture:

| invariant | measurement |
|---|---|
| no nested Home vertical scroller | every descendant of `[data-frame="home"]`: computed `overflow-y`, `scrollHeight` vs `clientHeight`. The deck's `overflow-x` is the one exemption and is asserted to be `x` only |
| no launcher | absence of any permanent app-tile row on Home; the zoom-out grid must be absent unless `[data-home-mode="overview"]` |
| dots are inert | the dot row carries no click handler and no `cursor:pointer` |
| slot geometry | deck widget 340, relevance 126, intelligence 170, mini 104 |
| empty collapses | an empty band's rendered height against `LANE.empty` |
| no blank destination | tap every Home card, assert content or `[data-empty-state]` |
| critical content legible | question and primary action fully inside the card box |
| accessibility text | the whole matrix again at the maximum supported text scale |

Green unit tests are not sufficient evidence for any of the above.

## THE DECISION LOG

Settled interaction decisions, with what each one replaced. A later session
that reverses one of these is undoing a decision, not fixing a bug.

| decision | replaced |
|---|---|
| Home is card-driven, no launcher | a lane of six app cards; then a strip of six tiles |
| An empty band is one line | an empty band keeping its full card geometry and frame |
| Three fixed card tiers, `tall` is the ceiling | band heights derived from the device (up to 274px) |
| Home cards never scroll; the ladder reduces | `overflow-y:auto` on the question card |
| The copy budget is applied server-side | generators writing paragraphs for a 224px card |
| Reduction is measured, not predicted | rungs chosen from the card's height |
| Row heights and card thresholds scale with text | `const ROW = 19` and `size.h >= 132` |
| Pagination is dots + keyboard, no arrow rows | `‹ ● ● ›` under every band |
| Quiet applications are reached by `#/open/<id>` | the permanent launcher |
| Every surface declares its empty state | six inline sentences nothing could detect |
| Home is a widget deck of three slots | three attention bands, one card each |
| Deck geometry: 340 / 126 / 170 / 104 | the three tiers, 112 / 168 / 224 |
| The dots are a readout and are not tappable | — (they were never a control) |
| The zoom-out grid is transient, closes on pick | — |
| Nothing on Home restates the phone | a context row with date, place and "as of" |
| The Calendar detail sheet does not scrim | — (the design proposed one; refused) |
| Slot three renders compiled cognition or nothing | a model's synthesis `opening`, which was a mail count |
| A quiet intelligence slot is absent, not a placeholder | — (no "nothing to report" card was ever built; the rule forecloses it) |
| The object performs its own action: a thumbnail plays | a `Watch ↗` pill on every video card, with the thumbnail wired to expand |
| Settings is reachable by asking for it | a 500ms long-press on the send arrow, with no affordance saying so |
| A Home card carries no `setting` action | `Make 7,180 the goal`, a white pill and the loudest thing on the Activity card |
| Only an operation that MAKES something is undoable | `Opened Re: Odelia — Saturday.  undo`, after looking at a message |
| The eyebrow says when, the sub says what is new, and one generator writes both | `TOMORROW · 11:00` above "Tomorrow at 11:00 AM…", and — in production — an eyebrow that was a 47-character prefix of the sub |

### Two enforcements of 2026-08-17

Neither is a reversal. Both are rules in this file being applied to something
that had drifted past them, found by **using the app** rather than by reading it
— see `docs/ux-audit.md` for the method and the rest of the findings.

| defect | invariant | fix | why it preserves the rest |
|---|---|---|---|
| Home's status row printed `as of 14:20` | "Nothing on Home restates the phone… no 'as of' stamp" | the stale signal became a boolean, so a caller cannot render a time it was never given | the band stays reserved, so the layout still never moves; the *stale-day warning* survives, because "showing yesterday" is a correctness claim and not a clock |
| the relevance card's action pill said "Set a reminder" and opened the Calendar | no dead controls; a card that opens on tap must not carry a control that opens it; a secondary action must not outweigh its content | the pill and its dead `Relevance.action` projection are gone | the card's own tap is unchanged, and the freed row lets `sub` finish its sentence instead of clamping mid-word |

The `as of` case is the one worth remembering. Nobody reversed that rule — it
came back as the **else-branch of the warning beside it**, which is how every
rule in this file has been broken so far: not by a decision, but as a side effect
of something else being correct.

The pill is worth remembering for a different reason: it was not unfinished
wiring. `deck.ts` projected `action: n.action?.label ?? ''`, so the client was
handed a **label** and never an action id. A control that cannot possibly work is
a design defect at the boundary, not a TODO.

### The enforcements of 2026-08-18

Phase 6–8. None is a reversal; all four are rules that did not exist because
nothing had broken in that particular way yet.

| rule | the failure that produced it |
|---|---|
| **The intelligence slot may only render compiled cognition.** Its type is `IntelligencePresentation` and the only thing that can build one is `server/intelligence.ts`, from a `Hypothesis`, an `Anomaly` or a `Prediction`. No model prose, no source count, no fallback. | The slot's type was `{ needId, body, chips }`, which can hold any sentence any generator writes. What it held was *"6 in the last week from 5 senders. Newest: Your…"* — a mail count, on the one part of Home that is supposed to say what Crucible understood. Nobody chose that; the type permitted it. |
| **A quantity may not appear in generated copy unless a record computed it.** Enforced by `ungrounded()`, against the set of figures the typed input actually carried — including numbers written as words. | Nothing has hallucinated a figure yet, because the copy is currently TypeScript. The rule exists now precisely because the interesting moment is later: the first time a model is handed the wording, this is the only thing between his home screen and a fluent invention. Costs nothing while it is unnecessary. |
| **Certainty is language, never a number.** No `confidence 0.73`, no `support 19 · contradiction 4` on any user surface. The epistemic state maps to five bands and the bands choose the verb. | "Home shows life state, not engine state" already said this; the memory core arrived with five new numbers per card that all look meaningful, and a rule stated for ranking scores does not obviously cover a hypothesis's support count. |
| **A slot's height may not be derived from what is inside it when what is inside it is derived from the height.** Give the slot a fixed flex basis; measure; reduce content. | The intelligence card measures its own box to decide how many lines fit. With `flex:0 1 auto` the box came from the content, so a short first measurement dropped a line, which shortened the card, which dropped another. It converged on a headline alone inside 70px of unused space, and every individual step was correct. |

The last one generalises past this card, which is why it is here rather than in a
comment: any component that both measures its container and decides its own
content is a loop, and the loop always resolves towards less content.

### The Phase 8 enforcements of 2026-08-18

Four rules, none a reversal. The first three are the shape of domain enrichment;
the fourth is about how any of it gets tested.

| rule | the failure that produced it |
|---|---|
| **A domain gets CONTEXT; only slot three gets COGNITION.** What the memory core adds to Calendar, Activity, Places or Mail is one line, on an object he is already looking at, carrying no evidence trail, no visual, no actions and no feedback controls, and never a card of its own. There is one certainty ladder and one grounding guard in this codebase and they are `intelligence.ts`'s; a domain compiler imports them. | Not a failure yet — a shape chosen before four of them could each invent their own hypothesis wording, certainty system, evidence semantics and feedback model. The moment that had happened, "Crucible thinks" would have meant five different things on one screen, and no single one of the five would have been wrong enough to notice. |
| **Enrichment takes space that was free, never space that was earning.** A card must not grow a row because the memory core has something to say. Where two things want one row, the harder claim keeps it: a calendar clash beats a comparison about Fridays, a withheld figure and a stopped feed both beat a baseline. | The Activity card had a figure, a chart, a sentence and a white pill offering to set a goal. Adding "a little above your usual Thursday" to that would have been a fifth thing, on the surface that §9 says should resolve to three. What made room was deleting the pill — which is the trade to look for, and it is not the one the reflex reaches for. |
| **A quantity the memory core computed does not reach a domain card.** No probability, no observation count, no confidence, no σ. "Dervio · probability 0.76 · 14 observations" is what "Dervio · usually Saturday morning" is instead of. The numbers decide WHETHER the line appears; they never appear IN it. | The same rule slot three already had, restated because a domain line is a different code path with a different author, and because a rhythm's numbers are unusually tempting: they are the most defensible figures in the whole store. |
| **The fixture owns the data. The real code owns the projection.** Anything that turns data into what is drawn — the deck, the presentation compiler, the copy budget, the enrichment pass — is imported by the fixture, never re-typed in it. | `4 this week.` was hand-written into the fixture, drawn as the Mail header's subtitle, and captured 69 times as though it were the product. `panes.ts#row` sets `status: ''` and the server has never emitted a subtitle there. A gate is a picture of whatever the fixture serves. |
| **A harness verifies that the process answering it is the one it started.** | `freePort` refuses to kill anything that is not an orphan, and that restraint is correct — a port-killer once shot a sibling suite. The consequence is that a fixture left running by hand survives it, the harness's own fails to bind with its stdio ignored, and the run is green against whatever code that process was started with. It happened during Phase 8 and cost two green runs of an assertion whose subject had stopped existing. |

The second row is the one worth carrying forward, because it is a rule about
subtraction and every instinct here is additive: **information should replace
chrome.** Both cards that got a memory-core sentence this round lost a control to
make room, and both are better for the exchange in a way that has nothing to do
with the sentence.

### The three reversals of 2026-08-13

The first four rows above **reverse** frozen rules, on explicit authorisation,
after several hours of design iteration. They are not a session deciding the
contract was inconvenient:

| what was reversed | what authorised it |
|---|---|
| three fixed card tiers, `tall` is the ceiling | "1 reverse the rule" |
| no new global navigation region | "2 implement as designed", with the dots made non-interactive |
| ranking decides whether a domain appears | the design: ranking picks where you land, never what exists |

Everything else in this file still holds, and the reason it holds is unchanged:
each rule was settled after a regression, and each was later broken by a change
that was fixing something else.

Reversing any row above requires explicit user authorisation. Three of them
have now been reversed once already, in the direction of "more permanent chrome,
more geometry, more scroll", each time as a side effect of fixing something
else. That is the failure mode this document exists to stop.

## PROCESS

Before implementing any UI fix, write down:

```
reported defect
affected frozen invariants
proposed fix
why the fix preserves each invariant
```

Reject the fix if it violates another invariant. "Scroll it" is the answer that
gets rejected most often, and correctly.

### The Live Product Recovery enforcements of 2026-08-18

Found by using the app against his real production world rather than a fixture.
None is a reversal. The first is the one worth carrying forward, because every
gate in the repository was green while it was on his home screen.

| rule | the failure that produced it |
|---|---|
| **"Ahead" has one definition, and it lives in `server/calendar.ts`.** No surface re-derives whether an event is current. | There were two. `panes.ts#nextEvent` filtered correctly; `deck.ts` filtered `e.allDay ? true`, which is not a filter — it exempts every all-day event from ever expiring. His calendar is almost entirely all-day events, so on 18 August Home led with a restaurant booking from the 8th and said `8 ahead`, while the line built from the *other* filter, in the same payload, correctly said "Nothing on today's agenda. Hiking with Mauro is tomorrow." Nothing was stale, cached or unsynced. Two functions disagreed about one word. |
| **A sync declares what it is COMPLETE for, and what it does not return inside that window is gone.** `Coverage` in `world.ts`; declared only after a successful, untruncated fetch, and scoped to one source. | `foldObservations` could only add or update. Google is asked for `[now, +7d]` and omits cancelled instances, so a deleted event simply stopped arriving — and the fold's answer to a record that stopped arriving was to keep it forever. There was no code path in the application that could remove an event, and ten days of finished commitments had accumulated in the world document. |
| **A Home chip may not perform an action whose parameters the card cannot carry.** Creation is the whole class: it needs words, and a 340px card has nowhere to type them. | `New event` on the Calendar card ran `calendar.create` with no parameters. `capabilities.ts` fills the gaps with `summary: undefined` and `start: new Date().toISOString()`, so one tap on Home wrote an untitled event onto his real Google Calendar, at that instant, with no confirmation and no way to tell it had happened. Not a dead control — the far worse kind, a live one pointed at nothing. |
| **A card is attributed by `focus` OR by `basis`, and an unattributed card may not sit under a widget.** `objectIdsOf` in `panes.ts` is the one place that knows a connector's id scheme in reverse. | Every no-restatement check was written against object ids; a model-authored card attributes itself with `basis`, which holds OBSERVATION ids. So a synthesis card that had correctly recorded which event it was about was indistinguishable, to the only guard that matters, from one that had said nothing — and "Hiking with Mauro · Scheduled for tomorrow at 9am" sat in slot two directly beneath the Calendar hero drawing the same event. The 9am was read out of the title; the event is all-day and has no clock. |
| **A shortfall against a daily target is a verdict, and a day still running has not earned one.** The figure and the target both stay; only the framing moves. | "0 steps today, averaging 2,796 over the last 7 days — 425 short of your 3,221", drawn at 10:00 from a sync taken at 08:00. Every number in it was correct. |
| **A control that cannot change what is on screen is not drawn.** | `All · Armed 0 · Paused · Changed` above "Nothing being watched yet." — four controls partitioning an empty set, which also makes an empty state look like a failed load. |

The general lesson of the first row is not about calendars. **Two implementations
of one predicate is a defect even when both are reachable and one is correct**,
because the wrong one will end up owning the largest object on the screen and
nothing in a type system, a capture gate or a unit test can see it. `shots.mjs`
photographed that card 69 times.

`scripts/freshness.mjs` is the gate for all of this. It asks the question none of
the others asks — *is the thing being drawn still true, and does every surface
agree what it is* — and its scenarios are his real 18 August calendar.
