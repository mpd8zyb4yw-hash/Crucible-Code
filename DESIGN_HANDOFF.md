# Crucible — DESIGN HANDOFF

> **For: a design session (Claude design). Read this file first, then `UI_OVERHAUL.md` §2–§9 only.**
>
> **Status: design brief. No UI code has been written against it.** The deliverable from the
> design session is *design* — layout, tokens, states, motion, mockups. Implementation is a
> separate session.
>
> **Authored 2026-08-03d**, from design constraints given directly by the product owner.
> Where this file and `UI_OVERHAUL.md` disagree, **this file wins** (see §1).

---

## 0. The product, in one paragraph

Crucible is a **broadly capable agentic personal assistant** — you ask it anything and get
exactly what you asked for, fast and polished, on phone and computer. It is not a coding tool
and not a chatbot. Its answers are frequently **not paragraphs**: they are inboxes triaged,
schedules solved, versions looked up, research verified, drafts prepared for your approval.
The interface has to make that feel like a *personal assistant surface*, not a transcript.

The one-line thesis it is built on: **correctness comes from the loop, not the oracle.** The
system verifies its own answers and abstains when it cannot. That has a direct design
consequence — see §7, honesty states. It is the most product-defining thing about Crucible and
the UI must not bury it.

---

## 1. IMPORTANT — this supersedes part of `UI_OVERHAUL.md`

`UI_OVERHAUL.md` is a real spec and most of it stands. But it was written before the visual
direction was set, and its **§0 and §1 describe a different aesthetic** than the one now
chosen. Specifically, these lines are **REPEALED**:

- *"Density over decoration. The user is scanning results, not admiring chrome."*
- *"Whitespace should separate meaning, not fill space."*
- *"Color carries meaning, never decoration."*

Those describe an instrument panel. The chosen direction is a **calm, spatial, translucent
personal-assistant surface** where atmosphere is part of the value. Do not try to satisfy both.

**What to KEEP from `UI_OVERHAUL.md`:**

| Section | Keep? | Why |
|---|---|---|
| §0–§1 aesthetic | **No** — replaced by §3 here | Conflicting visual direction |
| §2 Surface protocol (typed cards, blocks, actions) | **Yes** | The backend contract; still correct |
| §2.4 Actions + safety gate | **Yes, hard requirement** | Nothing may auto-send. See §7.3 |
| §3 Layout two-region model | **Partly** | Replaced by §4 here (cards-as-home) |
| §4 Email pane worked example | **Yes** | Best concrete test case |
| §5 Tables/spreadsheets | **Yes** | Still unbuilt, still needed |
| §6 Agentic run visualization | **Yes** | Feeds the `run` card in §5.4 here |
| §7 Adaptive console | **Yes, revised** | Becomes the chat dock, §4.3 |
| §8 Honesty states + verification chip | **Yes, hard requirement** | See §7 |

---

## 2. The four binding house rules (from `CLAUDE.md`, non-negotiable)

These are not stylistic preferences and a design that breaks them will be rejected.

1. **No emojis. Anywhere.** Not in labels, empty states, or status. Use text, geometry, or
   self-authored SVG. *(Audited: the current build passes — see §9.)*
2. **No stock or external imagery, and no external asset requests at runtime.** Every visual is
   self-authored. Icons are inline SVG. Fonts are bundled, never fetched.
3. **Text stays inside its box.** No overflow, no clipped descenders, no text riding a border.
   Every card must survive a **3× longer string** than your mock without breaking.
4. **Motion eases in and out, fast and clean.** No bounce, no spring, no decorative spinning.
   Must honour `prefers-reduced-motion`. Concrete values in §6.

---

## 3. The visual system: full-depth frosted glass

**Chosen direction: layered, tinted, alive.** Real backdrop blur, layered translucency, a soft
ambient background the glass samples, genuine depth at elevation changes. Both light and dark
are first-class.

### 3.1 The background is a self-authored ambient field

Glass is meaningless without something behind it. The app background is a **slow gradient mesh
you author in CSS/SVG** — no images, no external assets (rule 2). Three or four large, soft,
low-saturation colour blobs on a deep neutral base, drifting very slowly.

- Drift: 30–60s per cycle, `linear`, imperceptible frame to frame. This is the one place a long
  duration is allowed, because it must never read as "an animation".
- Under `prefers-reduced-motion`: **freeze it.** Keep the gradient, drop the drift entirely.
- The palette carries the brand. Suggest cool indigo/violet base with one warm accent bloom.
- Note: the repo already has `BackgroundBlobs.tsx` and `MoltenPour.tsx` — inspect before
  authoring new, and say plainly if they should be replaced rather than extended.

### 3.2 Glass tokens

Design against these; adjust values with reasons, don't invent a parallel set.

```
--glass-blur:        blur(40px) saturate(180%)
--glass-blur-light:  blur(20px) saturate(140%)   /* chrome, dock, nav */

/* dark (default) */
--glass-fill:        rgba(22, 24, 34, 0.55)
--glass-edge:        1px solid rgba(255,255,255,0.14)
--glass-inner-light: inset 0 1px 0 rgba(255,255,255,0.20)
--glass-shadow:      0 8px 32px rgba(0,0,0,0.32)

/* light */
--glass-fill:        rgba(255,255,255,0.62)
--glass-edge:        1px solid rgba(255,255,255,0.85)
--glass-inner-light: inset 0 1px 0 rgba(255,255,255,0.65)
--glass-shadow:      0 8px 32px rgba(31,38,68,0.14)

--radius-card:  24px   /* phone */
--radius-card-d: 20px  /* desktop */
--radius-sheet: 28px
```

The **inner light edge** (a 1px inset highlight along the top) is what makes glass read as
glass rather than as a grey box. Do not omit it.

### 3.3 Elevation ladder

Depth must mean something. Four levels, no more:

| Level | What | Treatment |
|---|---|---|
| 0 | Ambient background | The gradient field. No blur. |
| 1 | Resting card | `--glass-fill`, standard blur, soft shadow |
| 2 | Focused / dragged card | +6% fill opacity, shadow doubles, scale `1.02` |
| 3 | Sheet, modal, confirm gate | `--radius-sheet`, dimmed scrim behind at 40% |
| 4 | Chat dock | `--glass-blur-light`, sits above everything, never scrolls away |

### 3.4 THE accessibility trap — read this before you design a single card

Frosted glass fails in exactly one predictable way: **text on translucency loses contrast when
the background beneath it changes.** Your mock will look perfect over a dark blob and become
illegible over a light one.

Rules:

- Body text must hit **4.5:1** and large text **3:1** against the *worst-case* background the
  glass can sample, not the average. Test against the lightest and darkest point of your
  gradient field.
- If a card can't hold contrast, give text a **text plate**: a slightly more opaque inner
  region (fill opacity ≥ 0.78) behind the text block. This is preferable to darkening the
  whole card and losing the glass effect.
- Never place body text directly over a gradient seam or a blob edge.
- Provide a **"reduce transparency"** accommodation that swaps `--glass-fill` to ≥ 0.92 opacity
  and drops blur. Mirrors the OS setting; it is an accessibility requirement, not a nicety.

---

## 4. Layout — cards are home, chat is a dock

**Phone-first. Design at 390 × 844. Desktop adapts up from it.**

### 4.1 The home surface

The app opens to a **card surface, not an empty chat box.** This is the single most important
structural decision in this handoff: it is what makes Crucible read as an assistant that is
already working for you rather than a prompt waiting for input.

```
┌───────────────────────────┐
│  Good morning             │   ← greeting + one line of real state
│                           │
│  ┌─────────────────────┐  │
│  │ ▓▓ widget card ▓▓   │  │   ← vertical scroll of lanes
│  └─────────────────────┘  │
│  ┌───────────┐┌──────────┐│   ← a lane can swipe horizontally
│  │ ▓ card ▓  ││ ▓ card ▓ ││
│  └───────────┘└──────────┘│
│      ◦ ◦ ● ◦              │
│                           │
├───────────────────────────┤
│  ▸ Ask anything…          │   ← chat dock, always present
└───────────────────────────┘
```

- **Vertical scroll** moves between lanes. **Horizontal swipe** moves within a lane.
- Home content is real and earned: today's schedule, urgent mail, a running watcher, a
  recent verified answer. **If there is nothing real to show, show fewer cards — never filler.**
- First run has no data. Design that state explicitly; it is the first thing anyone sees.

### 4.1.1 The home adapts, and the user overrules it

The home surface is **dynamically ranked by Crucible and independently customizable by the
user.** Both, at once. That combination is the whole point and it is also the easiest thing in
this document to get wrong, so it gets an explicit law:

> **User intent is sticky. System suggestion is fluid.**
> Anything the user placed stays exactly where they put it, forever, until they move it.
> Everything else is free to reorder as relevance changes.

Concretely:

- The surface has **two regions in one scroll**: a **pinned region** the user controls, and a
  **suggested region** Crucible ranks. The boundary must be *visible but quiet* — a hairline and
  a small label, not a heavy divider.
- **Pinned cards never move on their own.** Not to make room, not because something got urgent.
- **Suggested cards re-rank freely** on signals like time of day, urgency, and what is running.
- **Never re-rank while the user is looking at it.** Recompute on app open, on pull-to-refresh,
  or after a real state change — never under the user's finger mid-scroll. A surface that
  reshuffles as you read it feels haunted.
- Every card carries **pin / hide / resize** in a long-press (phone) or hover (desktop) menu.
  **Hide is permanent and per-card-type**, and must be undoable from settings — a user who
  hides Calendar should not see it return next week because it got "relevant".
- A suggested card that gets promoted should **explain itself in one short line** ("3 replies
  waiting"). Adaptation the user cannot understand reads as randomness.
- **First run ships a sensible default arrangement**, not an empty grid asking to be configured.
  The user edits a working home; they do not assemble one.

Design deliverable: show the home in **three states** — default, personalized (several pinned,
some hidden), and mid-edit (the arrangement mode itself).

### 4.2 Desktop adaptation (≥ 1024px)

Same component tree, different layout policy — **not a second design.**

- Lanes become a **multi-column board** (2–3 columns), cards keep their identity.
- Chat dock moves to a **right-hand rail** (380–420px) or stays bottom-docked — propose one,
  with a reason. It must remain persistent either way.
- Radius tightens to `--radius-card-d`. Blur can stay full-depth (GPU is available).
- Swipe is a phone gesture: on desktop provide **arrows + keyboard** (←/→) and drag. Never
  require a gesture that a mouse can't perform.

### 4.3 The chat dock

- **Collapsed (default):** one-line input, ~56px + safe-area inset, glass level 4.
- **Active:** expands upward to ~45% height showing the current exchange; home stays visible
  and dimmed behind. The user must never lose their place.
- **Full:** drag up for the full transcript as a sheet (level 3).
- Thumb-reachable on phone. Input is never obscured by the keyboard.
- While the assistant is working, the dock shows **what it is doing** in plain words
  ("Checking 3 sources…"), not a spinner alone. See §6.3.

---

## 5. Card kinds — each needs a clearly individual appearance

You asked for the swipe to mean different things in different contexts and for each to look
distinct. That is right: if a deck of emails and a set of lenses look identical, the gesture
becomes ambiguous. **Design four card kinds that are instantly distinguishable at a glance.**

### 5.1 Widget card — ambient, on the home surface

- **Feel:** calm, generous, glanceable. The most "designed" surface in the product.
- Large primary value, small label, at most **one** action. Category tint via a subtle
  gradient wash inside the glass (still obeying "colour is not decoration" — the tint encodes
  *which domain*: mail / time / research / system).
- Sizes on a 2-column phone grid: **S** (1×1), **M** (2×1), **L** (2×2).
- **Swipe within a lane** = browse your dashboard. Page dots below the lane.

### 5.2 Item card — a deck of results

- **Feel:** substantial, full-bleed, one-thing-at-a-time. Distinctly *denser* than a widget.
- One card per email / result / file / row. **Swipe = next item.**
- **Counter, not dots** — "3 of 12" — because decks are long and dots stop scaling past ~7.
- Next card **peeks 12px** at the screen edge so the gesture is discoverable without a hint.
- Actions pinned to a bottom row inside the card, always in the same place across the deck.

### 5.3 Facet card — lenses on ONE answer

- **Feel:** static frame, changing contents. This is the key differentiator: **the card does
  not move.** Content cross-fades in place.
- **Segmented control at the top**, not dots — Summary / Sources / Verification / Actions.
- Because the frame is fixed, the user reads it as "one answer, viewed differently" rather than
  "more items". That distinction should be obvious without a label.

### 5.4 Run card — an agent working

- **Feel:** live, temporal, quietly technical. A timeline, not a card stack.
- Streams steps as they happen; each step is a row that can expand to show what it did.
- Completed runs collapse to a **verdict summary** with the post-condition result.
- This is the one place monospace is appropriate (paths, tool names, IDs). Never for prose.

---

### 5.5 THE FOUR LAUNCH WIDGETS

These four ship first. Each must be **beautiful, simple to use, and extremely powerful** — and
those pull against each other, so the resolution is the same in all four cases:

> **The card at rest shows one answer, not a dashboard. The power lives one tap down.**

A widget that shows six numbers is a report. A widget that shows *the one thing you needed to
know* and opens into full capability is an assistant. Every card below is specified as
**at rest → on tap → the power move.**

All four have real engine backing today — this is not aspirational, and the "what's real"
lines below are measured from the codebase, not assumed.

#### 5.5.1 Deep Research

*Backing: `research/researchDag.ts` — decompose → retrieve → verify → synthesize, with
per-source citations, a confidence score, and honest abstention.*

- **At rest:** the headline finding of your most recent research, one line, with its
  verification state. If a run is in flight, the card becomes live and shows the current phase
  in words ("Checking 6 sources") — never a bare spinner.
- **On tap:** the full report — findings, the sources that actually contributed, and the
  confidence. Facet card (§5.3): Summary / Sources / Verification.
- **The power move:** *research that keeps itself current.* Promote any report to a standing
  question via §5.5.4, so it re-runs and tells you when the answer changes.
- **Design the abstention state deliberately.** This engine really does return "no source
  answered this", and that is a feature. It must look considered, never broken.

#### 5.5.2 Email

*Backing: `gmail_search` / `gmail_read` / `gmail_send`, plus `importance.ts` for ranking and a
draft-approval flow that already exists.*

- **At rest:** **not an unread count.** Unread count is anxiety, not information. Show *"3 need
  you"* — messages actually requiring a reply — and the single most important sender.
- **On tap:** a triage **item deck** (§5.2). One message per card, swipe through, actions in a
  fixed bottom row: Reply / Archive / Later.
- **The power move:** Crucible has already **drafted the replies**. The user reviews and
  approves rather than composing. This is the difference between a mail client and an assistant.
- **The confirm gate (§7.3) is mandatory here.** Nothing sends without an explicit accept
  showing the exact recipient and body. Design it as the most reassuring screen in the product.

#### 5.5.3 Calendar

*Backing: `calendar_list` + `calendar_create` (read **and** write), and — importantly —
`answer/schedule.ts`, a deterministic free/busy solver that computes exact answers in ~2ms.*

- **At rest:** the next thing, with time-until. Below it, one computed line the user actually
  wants: *"Longest free block today: 12–2pm."*
- **On tap:** the day as a timeline with free blocks shown as **first-class objects**, not gaps.
- **The power move:** *"find me 90 minutes before Thursday"* is answered by a **deterministic
  solver, not a model** — exact, instant, and provably correct. Surface that certainty: this
  answer is verified in a way a chatbot's cannot be.
- Because the solver is exact, the calendar card should feel **crisp and confident** — the most
  precise-feeling surface in the app.

#### 5.5.4 Watch — standing questions *(proposed for the 4th)*

*Backing: `automations/store.ts` — triggers, `computeNextRun`, `pickDue`, run history,
auto-disable after 3 consecutive failures, and `offBriefReason`, which checks that a run's
answer actually addressed the brief. Automations already execute through the normal answer
path, so a scheduled run is a normal verified request.*

You asked for something genuinely unique for the fourth. **Scheduled tasks alone are not
unique** — every assistant has reminders. What is unique to Crucible is that it can tell
whether **the answer changed**, as opposed to the wording changing, because it verifies its
answers rather than trusting the model. That makes a category no chatbot can offer:

> **A Watch is a standing question that only speaks up when the verified answer actually
> changes.** Not "run this prompt on a schedule" — *"tell me when the truth moves."*

- **At rest:** how many watches are quiet, and any that have **changed**. A change is the only
  thing that earns attention; silence is the normal, healthy state.
- **On tap:** the watch list. Each shows its question, its cadence, when it last ran, and a
  **before → after diff** when something moved.
- **The power move:** anything the user has ever asked can become a watch in one tap. *"Is Node
  24 still the LTS?"* · *"Has my landlord replied?"* · *"Did this API get deprecated?"*
- **Design the diff.** It is the emotional core of this widget and the thing people will
  screenshot. Old value, new value, when it changed, and what source proved it.
- **Honesty rule, from the engine:** a watch that fails 3 times in a row **disables itself and
  says so.** Silence must never be mistakable for "nothing changed" — design the failed state
  as loudly as the changed state.

If you want a different fourth, the bar it has to clear is this one: *it should be impossible
for an assistant that doesn't verify its own answers.*

## 6. Motion

Motion should feel **fast, settled, and physical without being playful.** Nothing bounces.

```
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1)     /* state changes, fades, resizes */
--ease-glide:    cubic-bezier(0.32, 0.72, 0, 1)   /* card transitions, sheets, swipe settle */

state change / hover / toggle      140–180ms   --ease-standard
card entrance / sheet present      260–320ms   --ease-glide
swipe settle after release         280ms       --ease-glide
cross-fade between facets          180ms       --ease-standard
ambient background drift           30–60s      linear
```

### 6.1 Swipe must track the finger

A swipe follows the finger 1:1 while dragging, then settles with `--ease-glide`. Rubber-band
at the ends of a deck (resistance, no bounce past ~24px). A swipe that only animates on release
feels broken on a phone — this is the single highest-risk interaction in the design.

### 6.2 `prefers-reduced-motion` — currently a real gap

**The current build has zero support for it** (§9). Under reduced motion:
- Freeze the background drift.
- Replace all movement/scale with **opacity-only** transitions at 120ms.
- Swipe still works; it just doesn't animate the transit.

### 6.3 Working states — never a bare spinner

Crucible's answers can take real time (verified research is slower than a guess). The UI must
make waiting feel *legible*, not stalled: show the actual step in words, and where a step
count is known, show progress. A spinner alone is the least informative option available and
the current build leans on it.

---

## 7. Honesty states — the most product-defining UI in Crucible

The engine now returns a **verification ledger**: whether a claim was checked, by what, and
whether it passed. Earlier builds shipped `verified: true` as the default when *nothing had
checked the answer* — a badge that could not fail. That is fixed in the engine, and the UI
must not undo it.

### 7.1 Three states, visually distinct, never collapsed into two

| State | Meaning | Treatment |
|---|---|---|
| **Verified** | A deterministic check ran and passed | Confident marker + "how" on tap |
| **Unverified** | Answered, but nothing could mechanically check it | Neutral, not alarming. This is the **common** case — do not make it feel like an error |
| **Abstained** | The system does not know and says so | Calm and dignified. **A refusal is a correct answer.** Never style it as a failure |

### 7.2 The verification chip must be explainable

Tapping the state marker reveals *what was checked* ("Computed from the published Node.js
release table", "3 sources agree", "No source ties Canberra to 1908"). Never render the chip
without a backing record — if the ledger is absent, show nothing.

### 7.3 The confirmation gate is a hard requirement

Anything outward-facing — sending mail, posting, purchasing, deleting — **must** present a
confirm step the user actively accepts, showing exactly what will happen. No auto-send, ever,
including "the user already approved a similar thing". Design this as a level-3 sheet.

---

## 8. What to deliver

1. **Design tokens** — colour (light + dark), glass, type scale, spacing, radius, elevation,
   motion. As a table or JSON, implementable directly.
2. **The ambient background** — authored gradient field, both themes, with the reduced-motion
   variant.
3. **Home surface at 390px** in **five** states — first-run/empty, populated, sparse (little
   real data), personalized (pinned + hidden), and **mid-edit** (the arrangement mode). §4.1.1.
4. **All four card kinds** at 390px, each in resting / focused / working / error states.
5. **The four launch widgets** (§5.5) — Deep Research, Email, Calendar, Watch — each **at rest
   and expanded**. These are the product's first impression; they carry the most design weight
   in this list.
6. **The chat dock** in collapsed / active / full.
7. **The email flow** end to end — triage deck → open item → draft reply → **confirm gate** →
   sent. This is the best test of the whole system; `UI_OVERHAUL.md` §4 has the state machine.
8. **The Watch diff** (§5.5.4) — the before → after moment, plus the self-disabled failure
   state. This is the most distinctive screen in the product; do not treat it as a list row.
9. **Desktop adaptation at 1280px** of the home surface and one card kind.
10. **The contrast proof** from §3.4 — your glass cards over both the lightest and darkest
    region of your background, with measured ratios. Not optional.

**Deliver as design, not implementation** — mockups, tokens, redlines, and prose. Do not write
application code. A self-contained HTML/CSS mock purely to *demonstrate* the glass system and
the swipe feel is welcome and useful, but it is a prototype to look at, not the product.

---

## 9. Audit of the current build (measured 2026-08-03, not assumed)

Ran against the live UI source on `crucible-northstar-sessions`.

| Rule | Result |
|---|---|
| No emojis | **PASS.** 38 UI files scanned; zero true emoji. The 24 hits are geometric glyphs (`✓ ✕ ○ ◐ ● ✦`), which the rules permit. One borderline: `⚖` in `AgentsTabView.tsx:51` is a pictographic object — replace with geometry or SVG. |
| No external assets | **FAIL — and it is also a privacy leak.** `src/chat/MessageList.tsx:31` builds `https://www.google.com/s2/favicons?domain=…` and renders it in an `<img>`. Every source Crucible retrieves is announced to Google from the user's machine. Replace with self-authored per-domain marks (monogram tile derived from the hostname). **Fix regardless of the redesign.** |
| Text stays in its box | **Partly.** Source chips clip correctly (`textOverflow: ellipsis`), but there is no systematic long-string discipline. The 3× rule needs to be applied per card in the new design. |
| Motion | **FAIL on two counts.** `prefers-reduced-motion` appears **zero** times in the entire codebase. And the shipped easing is `cubic-bezier(0.22, 1, 0.36, 1)` in 26+ places, which is not the documented curve — §6 above resolves this by defining two named curves; adopt them and retire the ad-hoc one. |
| Decorative spin | **Judgment call.** `spin … linear infinite` is used for loading indicators (`App.tsx:2414`, `:3250`). Functional rather than decorative, but §6.3 asks for something better than a bare spinner. |

*Note: an earlier pass of this audit flagged "bounce" in `App.tsx`. That was a false positive —
the matches were all `debounce`. There are no bounce animations in the build.*

---

## 10. Open questions worth resolving during design

*Resolved by the product owner 2026-08-03d: the home both adapts and is user-customizable
(§4.1.1), and the four launch widgets are Deep Research, Email, Calendar and Watch (§5.5).
Those are decided — do not reopen them.*

Still genuinely open:

1. **Desktop chat placement** — right rail vs. bottom dock. Pick one and justify.
2. **What signals may re-rank the suggested region?** Time of day and urgency are safe.
   Behavioural learning ("you open Mail every morning") is more powerful but harder to make
   legible — and §4.1.1 requires every promotion to explain itself in one line. Propose the
   smallest set of signals that feels alive without feeling arbitrary.
3. **How much of the verification story surfaces at rest** — is there a home widget for "what
   Crucible checked for you today", or does verification only appear on answers?
4. **Does Watch deserve to be more than a widget?** If standing verified questions are the
   product's most defensible idea, a widget may undersell it. Say so if the design wants it
   promoted to a primary surface.
