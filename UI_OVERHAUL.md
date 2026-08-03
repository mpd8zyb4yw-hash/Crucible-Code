# Crucible — UI OVERHAUL SPEC

> **Status: SPECIFICATION ONLY. No UI code has been written against this yet.**
> This document is written to be handed to a fresh session with no prior context. It should be
> implementable from this file alone, plus the repo.
>
> **Authored 2026-08-03**, immediately after the scope change in `DOCTRINE.md` (Crucible is a
> broadly capable agentic assistant, not a coding agent). Read `DOCTRINE.md` §0, §5 and §6 first —
> several rules below are doctrine obligations, not aesthetic preferences, and they are marked
> **[DOCTRINE]** where that is the case.

---

## 0. What is wrong with the UI today (the problem this solves)

The current UI is a **chat transcript with special-case renderers bolted on**. `src/App.tsx` is
3,440 lines, `src/chat/MessageList.tsx` is 1,032, and between them they special-case ~40 distinct
SSE event types (`masterpiece_shard`, `analysis_deepening`, `attack_start`, `local_debate`, …).
Each new capability has historically meant another `case` in a switch and another bespoke renderer.

That worked when the product was one thing. It does not work now, because the assistant's answer to
"summarize my inbox and draft replies to anything urgent" is not a paragraph — it is **a set of
structured objects the user needs to inspect, expand, correct, and act on.**

**The core move of this overhaul: the assistant stops returning text and starts returning a
composition of typed, nested, actionable CARDS. The chat input stops being a text box and becomes
an adaptive control that changes shape based on what is on screen.**

Two hard constraints that shape everything:

1. **One card system, not per-feature renderers.** Adding a capability must mean emitting an
   existing card type, or adding exactly one new type to a registry. If implementing a feature
   requires touching layout code, the abstraction has failed. This mirrors **[DOCTRINE §5]** — one
   spine, a new capability is a tool + a verifier, never a new pipeline. The UI gets the same rule.
2. **Phone and desktop are the same component tree with different layout policy.** Not two apps,
   not a "mobile view" fork. A card must be legible and actionable at 360px wide.

---

## 1. Design language (non-negotiable house rules)

From `CLAUDE.md`, still binding:

- **No emojis. Anywhere.** Not in labels, not in empty states, not as status icons. Use text,
  geometry, or self-authored SVG.
- **No stock or external imagery.** Every visual is self-authored. This also means **no external
  asset requests at runtime** — icons are inline SVG or a local sprite.
- **Text stays inside its box.** No overflow, no clipped descenders, no text riding a border. Every
  card must survive a 3× longer string than the design mock without breaking layout.
- **Animation eases in and out, fast and clean.** 120–200ms for state changes, 240–320ms for
  entrances. `cubic-bezier(0.4, 0, 0.2, 1)`. Never bounce, never spring, never spin decoratively.
  Respect `prefers-reduced-motion` by dropping to opacity-only transitions.

Additional rules for this overhaul:

- **Density over decoration.** The user is scanning results, not admiring chrome. Whitespace should
  separate meaning, not fill space.
- **Monospace for machine data only** — IDs, paths, numbers in tables, code. Never for prose.
- **Color carries meaning, never decoration.** Reserve saturated color for state
  (verified / unverified / abstained / error / pending). Everything else is neutral.
- **Dark and light must both be first-class**, driven by `prefers-color-scheme` with a manual
  override that wins in both directions. Do not ship a dark-only design.

---

## 2. The Surface protocol (the backend contract)

This is the heart of the spec. **The UI renders `Surface` objects. The backend emits them.**

> **IMPLEMENTATION NOTE — this protocol DOES NOT EXIST YET.** Today the server emits ~40 ad-hoc SSE
> event types (`grep -oE "send\(\{\s*type: '[a-z_]+'" server.ts`). Building this protocol server-side
> is a prerequisite, and it is deliberately *not* part of the UI session's job. Coordinate: the UI
> session should build against the fixtures in §2.5 and a translation shim, so the two halves can
> land independently.

### 2.1 Core shape

```ts
type SurfaceState = 'streaming' | 'ready' | 'error' | 'abstained'

interface Surface {
  /** Stable across updates. The UI diffs on this — a re-emitted id updates in place. */
  id: string
  type: SurfaceType
  /** One line, <= 60 chars. Always present. Shown in every collapse state. */
  title: string
  /** One line, <= 90 chars. The "what you need to know without expanding" line. */
  summary?: string
  state: SurfaceState
  /** Rendered when expanded. Blocks are a small closed set — see §2.3. */
  body?: Block[]
  /** Nested surfaces. Depth is capped at 3 (see §3.4). */
  children?: Surface[]
  actions?: SurfaceAction[]
  provenance?: Provenance
  layout?: LayoutHint
  /** Server-authored ordering. Lower sorts first. Ties break by emission order. */
  rank?: number
}

interface LayoutHint {
  /** Desktop column span out of 12. Phone always spans full width. */
  span?: number
  /** 'always' = never collapsed. 'auto' = collapsed unless it is the only surface. */
  expand?: 'always' | 'auto' | 'never'
  /** True = this surface is the answer to the user's question; gets primary placement. */
  primary?: boolean
}
```

### 2.2 Surface types

Implement as a registry: `Record<SurfaceType, React.ComponentType<{surface: Surface}>>`. An
unknown type MUST fall back to a generic card that renders `title`, `summary`, and any `text`
blocks — never a crash, never a blank.

| Type | Purpose | Collapsed shows | Expanded shows |
|---|---|---|---|
| `answer` | The direct prose response | First ~2 lines | Full prose, formatted |
| `claim` | One verified statement | Statement + confidence chip | Evidence quote, tier, sources |
| `source` | A citation | Domain + title | Snippet, fetch time, tier |
| `email` | A mail message | Sender, subject, 1-line preview | Full body, thread, reply affordances (§4) |
| `event` | Calendar entry | Time + title | Attendees, location, conflicts |
| `file` | A file produced or read | Name, size, type | Preview (text/image/PDF page 1) |
| `table` | Tabular data / spreadsheet | Dimensions + first row | Scrollable grid (§5) |
| `run` | An agentic task in flight | Step count + current step | Step timeline (§6) |
| `step` | One tool call | Tool name + ok/fail | Args, output, duration |
| `plan` | The decomposition | N sub-questions | The list, each linking to its result |
| `comparison` | Side-by-side | The axes compared | Matrix (§5.3) |
| `abstain` | Honest non-answer **[DOCTRINE §6.4]** | What could not be verified | Why, what was tried, what would help |
| `automation` | A scheduled job | Name + next run | Trigger, last runs, output history |
| `choice` | Assistant needs a decision | The question | Options as buttons (§7.3) |

### 2.3 Blocks (the body vocabulary)

Keep this set **small and closed**. Resist adding types; compose instead.

```ts
type Block =
  | { kind: 'text';    md: string }                       // restricted markdown — see below
  | { kind: 'kv';      rows: Array<[string, string]> }    // label/value pairs
  | { kind: 'list';    items: string[]; ordered?: boolean }
  | { kind: 'table';   columns: string[]; rows: string[][]; align?: ('l'|'r'|'c')[] }
  | { kind: 'quote';   text: string; cite?: string }      // evidence quotes
  | { kind: 'code';    lang: string; text: string }
  | { kind: 'diff';    before: string; after: string }    // draft edits, file changes
  | { kind: 'image';   dataUri: string; alt: string }     // MUST be a data URI, never a URL
  | { kind: 'divider' }
```

**Restricted markdown** for `text`: bold, italic, inline code, links, bullet and numbered lists,
paragraphs. **No** headings (the card title is the heading), no images (use the `image` block), no
raw HTML, no tables (use the `table` block). Sanitize; never `dangerouslySetInnerHTML` on model
output.

### 2.4 Actions and the safety gate

```ts
interface SurfaceAction {
  id: string
  label: string                       // imperative, <= 24 chars: "Send reply", "Open in Drive"
  kind: 'primary' | 'secondary' | 'destructive'
  /** How the action is confirmed before it fires. See the hard rule below. */
  confirm: 'none' | 'inline' | 'modal'
  /** What the client sends back. The server decides what it means. */
  emits: { intent: string; args: Record<string, unknown> }
  /** Disabled with a reason shown on hover/long-press. */
  disabledReason?: string
}
```

> **HARD RULE — confirmation is not optional and is not the model's decision.**
> The **client** enforces the confirm level based on the action's *effect class*, and it must
> ignore a server-supplied `confirm: 'none'` on anything in the gated set. Anything that sends,
> posts, publishes, purchases, deletes, or changes a setting requires **explicit human confirmation
> in the UI, every time**, with the exact payload visible before the confirming tap.
>
> - `confirm: 'none'` — permitted only for read-only, local, reversible actions (expand, copy,
>   re-run a search, open a preview).
> - `confirm: 'inline'` — a two-step button inside the card ("Send reply" → "Confirm send").
>   Default for reversible outward actions.
> - `confirm: 'modal'` — a blocking sheet showing the full payload. Required for: sending any
>   message, deleting anything, spending money, changing account settings, granting access.
>
> **Never auto-send. Never pre-check a destructive option. Never make the destructive action the
> default focus target.** A draft is always reviewed by a human before it leaves the device.

### 2.5 Streaming and fixtures

- Surfaces arrive incrementally over SSE. A surface may be emitted with `state: 'streaming'` and a
  partial `body`, then re-emitted with the same `id` and `state: 'ready'`.
- **Re-emission updates in place.** Never append a duplicate card. Diff on `id`.
- The UI must look correct at every intermediate state, not just the final one.
- **Ship a fixture file** (`src/surfaces/__fixtures.ts`) containing at least one realistic example
  of every surface type, in every state, including pathological content: a 400-character title, an
  email with no subject, a table with 40 columns, a claim with zero sources, an abstain with a long
  reason. **The card gallery route (§9) renders these.** This is how the UI gets built and reviewed
  without waiting on the backend.

---

## 3. Layout

### 3.1 The two-region model

Every screen is exactly two regions:

```
┌─────────────────────────────┐
│                             │
│      SURFACE REGION         │   scrolls; holds the card composition
│                             │
├─────────────────────────────┤
│      CONSOLE                │   fixed to bottom; the adaptive chat control (§7)
└─────────────────────────────┘
```

There is no third region. Navigation (the existing `NavRail` / `SidebarRail`) is an overlay on
phone and a collapsible rail on desktop — it is chrome, not a region.

### 3.2 Phone (< 640px)

- Surface region: **single column**, full-bleed cards with 12px gutters, 8px between cards.
- Cards are collapsed by default except the `primary` one.
- **Console is a bottom sheet** with three detents: `peek` (input only, ~56px), `half` (~45vh),
  `full` (~92vh). Drag or swipe between them; it also changes detent automatically by mode (§7.2).
- Tapping a card expands it inline. Tapping its "focus" affordance pushes a **full-screen detail
  view** with a back affordance — this is how nested depth is handled on a small screen (§3.4).
- Minimum touch target 44×44px. Respect safe-area insets (`env(safe-area-inset-*)`).

### 3.3 Desktop (>= 640px)

- Surface region: **12-column grid**, cards span per `layout.span` (default 12 for `primary`,
  6 otherwise), max content width 1100px, centered.
- Console is docked to the bottom of the surface region, not the viewport, and grows upward.
- **Optional focus pane:** activating a card's focus affordance opens a right-hand pane (40% width)
  while the composition stays visible on the left. This is the desktop equivalent of the phone's
  push navigation, and it is what makes the email flow (§4) feel like a real mail client.

### 3.4 Nesting depth

Maximum **3 levels**: `Surface → child → grandchild`. Beyond that, the third level renders a
"Open N more" affordance that pushes/focuses rather than nesting further.

Rationale: a research answer is naturally `answer → claim → source`, an inbox is
`run → email → thread message`. Three covers the real cases; four is unreadable at 360px.

---

## 4. The email pane (worked example — build this one first)

The user asked for this specifically, and it is the best proving ground because it exercises
nesting, in-place state change, actions, and the safety gate all at once.

### 4.1 States

The email surface is a small state machine. **The user's query determines the entry state** — that
is the interesting part, and it is what makes it feel intelligent rather than like a mail client.

| Entry state | Triggered by a query like | Renders |
|---|---|---|
| `list` | "check my email", "what came in today" | Stack of `email` cards, collapsed |
| `reading` | "what did Sarah say about the invoice" | One email expanded, thread beneath |
| `drafting` | "reply to Sarah saying I'll be late" | Reply composer, **pre-filled with the draft**, cursor at end |
| `reviewing` | after the assistant revises a draft | Draft with a `diff` block showing what changed |
| `sent` | after the human confirms | Confirmation + the sent copy, immutable |

### 4.2 Behavior

- Transitions animate the **same** card — never unmount and remount. The card grows into the
  composer; it does not swap for a different component. This is the "updates displayed info when
  interacted with" behavior, and it is what sells the whole design.
- The draft body is **always editable** by the human before sending. The assistant's text is a
  starting point, never a fait accompli.
- Revisions ("make it warmer", "shorter") re-emit the same surface `id` in `reviewing` state with a
  `diff` block. The human sees exactly what changed.
- **Sending requires `confirm: 'modal'`** showing recipient, subject, and full body (§2.4). The
  recipient list is rendered in full, never truncated with an ellipsis — a hidden BCC is a
  security problem, not a layout problem.
- `sent` is terminal and visually distinct (reduced contrast, a "Sent HH:MM" stamp). No edit
  affordance.

### 4.3 Threading

A thread is `children` on the email surface, newest last, collapsed to sender + one line each. The
message the user asked about is expanded; the rest are not.

---

## 5. Tabular data and spreadsheets

Spreadsheets are the one genuine capability gap in the current product (`DOCTRINE` §2 / ROADMAP
2026-08-03a), so the UI should be ready before the backend lands.

### 5.1 The `table` surface

- Collapsed: `"14 rows x 6 columns"` plus the header row.
- Expanded: virtualized grid. **Horizontal scroll lives inside the card**, never on the page body.
- Sticky header row; sticky first column when columns > 4.
- Right-align numeric columns; monospace numerals so digits line up.
- Cell selection copies as TSV.
- Phone: below 4 columns render as a grid; at 4+ render **one card per row** (label/value pairs) —
  a 12-column table is unreadable at 360px and horizontal scrolling for primary content is a
  failure state, not a solution.

### 5.2 Editing

- Cells are read-only until the surface declares an `edit` action. Editing emits an intent; it does
  **not** mutate local state optimistically — the server is the source of truth and the round trip
  is fast enough.
- A computed/derived cell shows a small marker and reveals its formula or provenance on focus.
  **[DOCTRINE §6.5]** — a number the assistant produced must be traceable to how it got there.

### 5.3 Comparison surfaces

`comparison` is a table with a fixed shape: options as columns, criteria as rows. On phone it
transposes to one card per option. Highlight the winning cell per row only when the backend marks
it — never let the UI decide what "best" means.

---

## 6. Agentic run visualization

When the assistant is *doing* something (not just answering), a `run` surface is the primary card.

- **Collapsed:** current step text plus a determinate progress indicator when total steps are
  known, indeterminate when not. Never fake a percentage.
- **Expanded:** a vertical timeline of `step` children. Each step: tool name, one-line result,
  duration, ok/fail marker. Failed steps expand to show the error.
- **Live:** steps stream in. The list auto-scrolls **only while the user is already at the bottom**;
  if they have scrolled up to read, do not yank them back.
- **[DOCTRINE §6.1] "Degrade latency, never correctness."** When a run is slow, the UI says so
  honestly — elapsed time, current step, and a cancel affordance. It must **never** imply the
  assistant is finished when it is still working, and it must never present a partial result as
  final. A slow honest answer is the designed behavior, not a failure to paper over.
- Cancel is always available on a running task and is `confirm: 'none'` (stopping is safe).

---

## 7. The console (the adaptive chat control)

The user asked for "a chat bubble below that can be interacted with and adjust size and content
dynamically." This is that component, specified.

### 7.1 Modes

The console is one component with six modes. It **morphs**; it does not swap.

| Mode | When | Shows |
|---|---|---|
| `rest` | Idle | Single-line input, send affordance, attach, mic |
| `composing` | User is typing | Grows to fit content, max 40vh, then scrolls internally |
| `clarifying` | Assistant needs info **before** it can proceed | The question plus 2–4 chips; typing a free answer is always allowed |
| `confirming` | A gated action awaits approval (§2.4) | Payload summary, Cancel / Confirm; Cancel holds initial focus |
| `working` | A run is in flight | Current step, elapsed, Cancel; input stays live so the user can queue a follow-up |
| `reviewing` | A draft/artifact awaits edit | Inline editor bound to the focused surface |

### 7.2 Sizing

- Height is **content-driven with clamps**, animated (180ms, standard easing). Never jump.
- Mode changes may change detent on phone: `clarifying` and `confirming` raise to `half`;
  `working` drops to `peek`.
- The surface region's scroll position is preserved across console resizes — the content must not
  jump under the user's thumb when the console grows.

### 7.3 Clarification

**[DOCTRINE §5.1]** — the system abstains rather than guessing. Clarification is how that surfaces
when a question is answerable but underspecified.

- Chips are concrete values, never "Yes/No" for open questions.
- Always allow free text. Chips are a shortcut, not a cage.
- **Cap at one clarification round per turn** unless the user adds new information. An assistant
  that interrogates is worse than one that picks a sensible default and says which default it
  picked — say it in the answer, and let the human correct it.

---

## 8. State, error, and honesty states

These are the states most likely to be skipped. They are the ones that determine whether the
product feels trustworthy.

- **Empty:** never a bare blank. State what would fill this space and how to start.
- **Loading:** skeleton cards matching the expected shape. No spinners over 400ms without text.
- **Error:** what failed, in plain language; what the user can do; a retry affordance. Never a raw
  stack trace, never an error code alone.
- **Abstain [DOCTRINE §6.4]:** a **first-class card, styled distinctly from an error** — the system
  worked correctly and honestly reported it could not verify something. It must NOT look like a
  failure. Show: what could not be verified, what was tried, and what would let it succeed.
- **Unverified content:** when a claim is not verified, say so on the claim. Do not hide it, and do
  not let it inherit the visual treatment of a verified claim. **[DOCTRINE §1]**
- **Offline:** the local floor is a real product state, not a degradation. Say "running on-device"
  plainly; do not apologize for it and do not gray the interface out. **[DOCTRINE §8]**

### 8.1 The verification chip

Every `claim` and `answer` surface carries a verification chip. This is the single most important
visual element in the product, because it is the doctrine made visible.

- Four states: `verified`, `corroborated`, `unverified`, `abstained`.
- Tapping it reveals provenance: what checked it, against what, and when.
- **The chip must reflect the actual verification state.** As of 2026-08-03 the answer path reports
  `verified: true` on answers that are plainly wrong (measured — see ROADMAP 2026-08-03b). **Until
  the backend signal is trustworthy, the UI must render the chip only when the backend supplies a
  provenance record to back it, and render nothing otherwise.** A verification badge that lies is
  far worse than no badge.

---

## 9. Implementation plan (suggested order)

1. **Surface protocol types + fixture file + card gallery route** (`/_cards`). Every type, every
   state, pathological content. Build and review here before wiring anything live.
2. **Shell:** two-region layout, responsive policy, phone bottom-sheet detents, desktop grid.
3. **Card primitives:** collapse/expand, focus (push on phone, pane on desktop), the block
   renderers, the verification chip, the action bar with the confirm gate.
4. **Console:** all six modes, morphing sizing, mode-driven detents.
5. **Email pane** end to end against fixtures — the best proof the system works (§4).
6. **Run/step timeline** (§6).
7. **Table/comparison** (§5).
8. **Translation shim:** map today's ~40 SSE event types onto surfaces so the new UI runs against
   the current server. This is the migration path — it lets the UI ship before the backend protocol.
9. **Retire the shim** once the server emits surfaces natively.

**Do not port `App.tsx` incrementally.** Build the new shell beside it behind a flag, reach parity
on the paths that matter, then delete. Incremental porting of a 3,440-line component with 40
special-cased event types is how the current state happened.

---

## 10. Definition of done

- [ ] Every surface type renders correctly at 360px and 1440px, in light and dark.
- [ ] Card gallery covers every type × every state, including pathological content.
- [ ] No card can break layout with a 3× longer string in any text field.
- [ ] Every gated action requires explicit confirmation with the full payload visible; a
      server-supplied `confirm: 'none'` on a gated intent is ignored by the client.
- [ ] Nothing auto-sends. No destructive action holds initial focus.
- [ ] Abstain renders distinctly from error.
- [ ] The verification chip appears only when backed by a provenance record.
- [ ] Keyboard: full navigation, visible focus rings, Escape closes focus/modal, Enter sends,
      Shift+Enter newlines.
- [ ] Screen reader: cards are `article`s with labelled headings; live regions announce run steps
      without spamming; state changes are announced.
- [ ] `prefers-reduced-motion` honored.
- [ ] No emoji, no external asset requests, no `dangerouslySetInnerHTML` on model output.
- [ ] Surface region never scrolls horizontally; wide content scrolls within its own card.
- [ ] 60fps scroll with 200 cards (virtualize the surface region).

---

## 11. Open questions for the implementing session

1. **Does the surface protocol exist server-side yet?** If not, build against fixtures (§2.5) and
   the shim (§9.8). Do not block.
2. **Focus pane vs. push on tablet widths (640–1024px)?** Untested. Recommend push until measured.
3. **How much history stays mounted?** Recommend virtualizing beyond ~50 surfaces and lazily
   rehydrating on scroll-back.
4. **Does the existing `NavRail`/`SidebarRail` survive?** Probably yes as chrome, but it was
   designed for a tab-based product. Re-evaluate once the two-region shell exists.
