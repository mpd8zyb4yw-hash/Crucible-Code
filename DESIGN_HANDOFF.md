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
- Home content is real and earned: today's schedule, unread/urgent mail, a running agent, a
  recent verified answer. **If there is nothing real to show, show fewer cards — never filler.**
- First run has no data. Design that state explicitly; it is the first thing anyone sees.

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
3. **Home surface at 390px** — populated, sparse, and first-run/empty.
4. **All four card kinds** at 390px, each in resting / focused / working / error states.
5. **The chat dock** in collapsed / active / full.
6. **The email flow** end to end — triage deck → open item → draft reply → **confirm gate** →
   sent. This is the best test of the whole system; `UI_OVERHAUL.md` §4 has the state machine.
7. **Desktop adaptation at 1280px** of the home surface and one card kind.
8. **The contrast proof** from §3.4 — your glass cards over both the lightest and darkest
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

1. **Desktop chat placement** — right rail vs. bottom dock. Pick one and justify.
2. **Does the home surface personalize over time?** Lanes could reorder by what the user
   actually opens. Powerful, but it makes the UI non-deterministic — worth an explicit decision.
3. **Widget catalogue.** Which widgets ship first? Suggest: Schedule, Mail, Running agents,
   Recent answer. All four have real backing in the engine today.
4. **How much of the verification story surfaces at rest** — is there a home widget for "what
   Crucible checked for you today", or does verification only appear on answers?
