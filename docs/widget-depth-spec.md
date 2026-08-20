# WIDGET DEPTH — DESIGN SPECIFICATION

**Status:** specification for the implementer. Authorised 2026-08-13.
**Scope:** the compact widget and the opened surface for Calendar, Mail,
Video, Activity, Places and Watch. **Home's composition is not in scope and
does not change.**

Phase 1 settled *where things live*. This pass settles *whether what lives
there is worth looking at*. Every rule in `docs/ui-contract.md` continues to
hold; nothing below may be implemented in a way that weakens one. In
particular: the deck stays, slot two holds **one** relevance object with no
paging, slot three stays distinct from both, there is one composer, and there
is no launcher.

---

## 0. THE TWO OBLIGATIONS, AS AN ACCEPTANCE TEST

Every domain is reviewed in two states. A surface that cannot answer all
three questions in a sentence each is **unfinished** and must not be marked
done:

1. **Before the tap** — what real, specific information is on screen?
2. **After the tap** — what becomes *possible* that was not possible on Home?
3. **The delta** — why is opening it materially richer than staying?

A count is not an answer to (1). A larger rendering of the compact widget is
not an answer to (2). "You can see more of it" is not an answer to (3).

### The counter ban, stated precisely

A compact widget may not spend its primary line on a cardinality. `3 events`,
`5 new`, `12 unread` are all forbidden as the *subject* of the widget. A count
is permitted **only** in `DeckWidget.meta` (top-right), which exists for
exactly that and is already constrained by the contract to be a count and
never a timestamp or a source name.

### The ambient-information ban, extended to widget interiors

The contract already forbids date, day, clock, town, "as of" and source
labels on Home. This pass extends it into the widget body with one exemption,
which the implementer must apply per row rather than per widget:

> An ambient fact may appear **only when its absence would change the
> interpretation of the specific thing shown beside it.**

Permitted by that test: a date on an event that is not today; a place name on
a recommendation whose whole point is where it is; a "last synced Friday"
marker when the chart would otherwise read as a real decline. Forbidden by it:
a date on today's 09:00 meeting, a source badge on anything, a domain label
repeating the widget's own name, and any technical status string.

---

## 1. WHAT THE DATA ACTUALLY SUPPORTS

The compact designs below are drawn only from fields that exist today. This
section is the ground truth the implementer works against; anything marked
**GAP** is not to be faked and not to be shipped as prose.

| domain | typed object | fields available now | gaps |
|---|---|---|---|
| Calendar | `CalEvent` (`server/widgets.ts`) | start/end instants, `allDay` settled at ingestion, location, attendees + `response`, organizer, description | none blocking |
| Mail | `MailMessage` | subject, from, fromName, snippet, body, `at`, `unread`, labels, threadId | thread *grouping* is unbuilt — `threadId` exists but nothing rolls messages up |
| Video | `VideoObject` | verified `thumbnail`, `title`, `channel`, `seconds`, `publishedAt`, `url` (absent ⇒ unopenable) | none blocking |
| Activity | `FitnessSeries` + `ActivityBrief` | per-day values with explicit `null` for no-reading, `current` (nullable on conflict), `freshness.level`, `trend`, `goal` with `fraction`, `conflicts`, `next` | none blocking — this is the richest brief in the app and is currently under-drawn |
| Places | `WidgetPlace` + `maps.ts` (`searchPlaces`, `routeBetween`) + `leaveby.ts` | lat/lon/label, keyless OSM tiles, OSRM routes, leave-by computation | no saved-place set; no live position outside `follow` |
| Watch | `WatchObject` | `what`, `why`, `question`, `everyHours`, `lastRunAt`/`nextRunAt`, `active`, `state` (its own words), `changedAt`, `history[]` | none blocking — `history` and `changedAt` are currently unused by the UI |

**Money and Sleep remain absent.** `server/deck.ts` has no branch that can
build them. The renderings stay unused until a connector exists. Do not add
them to this pass.

---

## 2. SHARED VISUAL LANGUAGE

The deck widget is **340px tall, full width**, fixed. Nothing below may claim
its own height. The interior divides into three zones, and a domain uses the
ones it needs — an unused zone yields its space to the others rather than
leaving void (this was a real defect: a third of the card was empty).

```
zone A  identity strip     28px   name (clamped) · meta count, right
zone B  the picture        flex   the domain's own rendering — this is the widget
zone C  chips              44px   0–2 capability chips, omitted entirely when none
```

**Zone B is the product.** If zone B can be replaced by a paragraph without
loss, the widget has failed this pass.

- **Foundation** near-black; cards are separated by elevation and spacing, not
  borders. At most one hairline per widget, and only where it carries meaning
  (a now-line, a goal line, a day boundary).
- **One accent per widget**, used for the single most important mark only —
  the hot row, the now-line, the goal line, the unread dot. Two accents in one
  widget means the hierarchy failed.
- **Type ramp**: figure 34/600 · title 15/600 · row 14/500 · sub 13/400 ·
  eyebrow 11/600 tracked. Nothing smaller than 11.
- **Every widget clamps**: title one line, sub one line, and the clamp ladder
  applies to *every* string that can come from the outside world — a
  70-character place name and a long widget name have both already broken
  this card.
- **The domains must not be six recolours of one card.** Calendar reads
  temporal, Activity quantitative, Video like media, Places spatial, Mail like
  correspondence, Watch like an instrument. Shared: palette, ramp, spacing,
  motion. Not shared: the shape of zone B.

**Tap targets.** The hero opens *the object it displays* (this was a bug — it
opened the next one). Every row is its own target of at least 44px, and a row
with no destination is not a target. No fake links, no action reported as
completed that was not performed.

---

## 3. CALENDAR — *temporal*

### Compact
Zone B is a **strip of the working day**, not a list. A vertical time axis for
the hours that actually contain something (compressed elsewhere), with events
as filled blocks positioned by real start and duration, and a now-line in the
accent. Overlapping events draw as side-by-side columns — a conflict must be
*visible as a shape*, not described in words.

- Hero: the next event, with relative timing (`in 40 min`), location only if
  it changes what to do about it.
- Rows below: the following two, each with its time as the lead column.
- All-day events sit as a single flat band above the axis, never as a timed
  block (`normaliseEvent` already guarantees the two are exclusive).
- Awaiting-RSVP events draw with an outlined block rather than a filled one.
- Chips: `Accept` when the hero needs a response; `Leave by` when the hero has
  a location and `leaveby.ts` can compute one.

### Opened
Day view is the default (already shipped). Depth this pass must add:

- **Scrub the axis** to move through the day; swipe the week strip for days.
- **Gap awareness** — free intervals over 30 minutes are selectable, and
  selecting one starts an event there with the time pre-filled.
- **Event detail** as the non-scrimming sheet (calendar stays live behind it):
  attendees with their actual responses, organizer, description, location →
  hand-off to Places for a route, and RSVP performed in place.
- **Conflict resolution**: overlapping events surface both, with the option to
  decline one.

**Delta:** Home shows *what is next and whether the day collides*. Opening
lets him *move through time, find space, and answer people*.

---

## 4. MAIL — *correspondence*

### Compact
Zone B is **three conversations**, not three subject lines.

- Lead column: sender initial in a tinted disc — the identity, not an icon.
- Line 1: sender name, weighted; unread carries the accent dot.
- Line 2: subject and snippet joined, clamped to one line, snippet dimmed so
  the two read as one continuous thought rather than two fields.
- Trail: age (`2h`, `Tue`) — the one temporal fact that changes whether it
  matters.
- Selection is by **importance, not recency**: unread first, then anything
  addressed directly to him, then the rest. Recency alone is an inbox, and he
  already has one.
- Chips: `Archive` on the hot row when that capability exists; otherwise none.

**GAP to close first:** roll messages up by `threadId` and show the thread's
message count as a small trailing numeral when > 1. Three rows that are the
same conversation is the failure mode this prevents.

### Opened
- Real reading: full body, correct typography, quoted history collapsed.
- **Reply with intelligent assistance** — a draft offered, editable, never
  sent without an explicit confirm (irreversible action, per the widget
  contract's `irreversible` flag).
- Archive, mark, and label, performed in place with real optimistic state and
  honest failure.
- Search across the retrieved window.

**Delta:** Home shows *who wants something and how urgent it is*. Opening lets
him *read it and answer it*.

---

## 5. VIDEO — *media*

### Compact
Zone B is **thumbnails**, at a size where the picture actually functions.

- One hero thumbnail at 16:9 full card width, with the duration burned into
  its corner, title over the lower gradient (two lines max), channel beneath
  in dimmed text.
- Two smaller thumbs in a row beneath it.
- A video **without a verified `url` is not rendered at all**. No placeholder,
  no unopenable tile. Blank is a correct answer; a confident wrong one is not.
- No published-date unless it is the reason the video is being surfaced.
- Chips: none. The thumbnail is the affordance.

### Opened
- A real browse surface: subscriptions, liked, and search results as a grid of
  the same verified objects.
- **Opening plays the correct video** via its canonical `url`. Identity is
  verified upstream in `youtube.ts#presentable`; the surface must not
  reconstruct a URL from an id under any circumstance.
- Filters that reflect how he actually chooses — duration, channel.

**Delta:** Home shows *what is worth watching*. Opening lets him *find and
watch it*.

---

## 6. ACTIVITY — *quantitative*

The brief is already the richest object in the app and the widget draws almost
none of it. This is the largest single win in this pass.

### Compact
Zone B is **the figure and the shape of the week together**.

- The figure large (34/600), with its unit small and adjacent, never on its
  own line.
- Seven bars beneath, oldest → today, today's bar in the accent.
- **A `null` day draws as a hollow outline, not a short bar.** "No reading"
  and "barely moved" are opposite facts and must not share a picture.
- The goal draws as a dashed line across the bars at `goal.at`. If the goal is
  `steady`, no line and no progress bar — a bar implies a finish line.
- Trend as a single signed delta beside the figure (`+12%`), never a sentence.
- **`current: null` is a first-class state**: no number, `why` in its place.
  Two sources disagreeing must never resolve to whichever synced last.
- `freshness.level === 'stale'` desaturates the bars and shows the last
  reporting day — this is the one permitted date, by the §0 exemption.
- Chips: `Set goal` / `Pause goal` (already built, backed end to end).

### Opened
- **Scrub the series**: select any bar to read that day's exact value and date.
- Range switch (7 / 30 / 90) and multiple series as toggleable lines.
- Goal editing, with the shortfall stated in the metric's own units.
- **Conflict resolution surfaced as a decision**, not a warning: both readings,
  both sources, and a way to rule between them — which is what makes
  `current` trustworthy afterwards.

**Delta:** Home shows *where he is against where he meant to be*. Opening lets
him *interrogate any day, change the goal, and settle which source is true*.

---

## 7. PLACES — *spatial*

### Compact
Zone B is **map**, edge to edge, not a list of place names.

- Real OSM tiles, dark-styled to the foundation, with his position and the
  relevant destination on it.
- When a destination exists (usually the next located calendar event), draw
  the **route line** and overlay one figure: travel time, plus leave-by when
  `leaveby.ts` yields one. That figure is the widget's subject.
- With no destination: the map centred on him with genuinely nearby relevance
  marked. Still spatial, still not a counter.
- The town name is permitted **only** when it makes a recommendation
  understandable — otherwise the map already says where he is.
- Chips: `Route` / `Leave by`.

### Opened
- A real map: pan, zoom, search (`searchPlaces`), and routing between picked
  points (`routeBetween`), by walk / drive / cycle.
- Route detail with the leave-by time, and hand-off back to the calendar event
  that motivated it.
- Live position when following.

**Delta:** Home shows *whether he needs to leave and when*. Opening lets him
*search, route and navigate*.

---

## 8. WATCH — *instrument*

### Compact
Zone B is **the tracked objects and what changed**, which is exactly the data
already on `WatchObject` and currently unused.

- One row per watch: `what` as the title, `state` — its own last answer — as
  the sub, clamped to one line.
- Trail: how long ago the answer **changed** (`changedAt`), not when it was
  last checked. A watch that has been checked 40 times and never changed is
  quiet, and must read as quiet.
- A watch whose state changed since he last looked is the hot row and takes
  the accent dot.
- Inactive watches dim rather than disappear — the contract forbids a
  connected domain vanishing because it is quiet.
- Chips: none by default.

### Opened
- Per-watch **history** (`history[]`) as a timeline with the changes marked,
  so the reasoning is inspectable rather than asserted.
- The `question` being asked, plainly stated, and editable.
- Interval control, pause/resume, and deletion — each one honest about when it
  next runs (`nextRunAt`).

**Delta:** Home shows *what changed*. Opening shows *the whole history and why
Crucible thinks it changed*.

---

## 9. WHAT MUST NOT REGRESS

Restated because this pass touches every surface:

- Horizontal deck; no vertical scroll inside a Home card; no bottom tabs; no
  launcher; dots stay inert.
- Slot two never repeats the active widget — including any row it displays,
  not just its hero. Slot three never repeats slot two.
- Persistent connected domains stay in the deck when quiet.
- No blank destination, no dead control, no fake link, no hallucinated
  completion. Irreversible actions confirm, every time.
- One composer.
- Deeper information arrives through interaction, never by adding prose to
  Home.

---

## 10. HOW THIS PASS IS GATED

The existing gates stay and are necessary. They are not sufficient: 69/69 and
90/90 say the pixels are where they were told to be, not that anything useful
is on the screen. Add, per domain:

1. **A density assertion** — the compact widget renders at least N real
   domain objects with their own distinguishing fields (event with a real
   time, message with a real sender, video with a real thumbnail). A widget
   whose text content is entirely derivable from a count fails.
2. **A depth assertion** — the opened surface exposes at least one capability
   or view that Home does not, exercised through the real reducer.
3. **A no-ambient assertion** — no date, clock, town or source string appears
   in a widget body except where a per-row exemption is explicitly declared.
4. **Every domain has a fixture.** A component with no fixture has no gate;
   that is how 56/56 passed green while a card never rendered at all.

The two-state review table in §0 is the deliverable of the next
implementation pass, filled in per domain with screenshots of both states.
