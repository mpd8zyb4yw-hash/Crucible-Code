import { contextFor, type DomainContext } from './domain.js'
import { isToday, leadFor, nextUp, relFor, upcoming } from './calendar.js'
import { objectIdsOf } from './panes.js'
import type { WidgetPane, Widget, WidgetAction } from './widgets.js'
import type { Need } from './think.js'
import type { HomeState } from './home.js'
import type { IntelligencePresentation } from './intelligence.js'

/**
 * HOME'S THREE SLOTS, PROJECTED ON THE SERVER.
 *
 * The Phase 1 design replaced the three attention bands with three fixed slots —
 * a swipeable deck of domain widgets, the one thing most worth saying underneath
 * it, and Crucible thinking out loud. This file is where those three become
 * data, and the reason it is on the server rather than in `Home.tsx` is the same
 * reason `band` is: every input to the decision lives here, and a client
 * reconstructing it from `heat` would be a second opinion about the most
 * consequential thing on the screen.
 *
 * IT IS A PROJECTION, NOT A SOURCE. Every field below is derived from the SAME
 * typed panes the full application surface draws — `need.panes[0].widget` — so
 * the deck cannot advertise an event Calendar does not have, or a message Mail
 * cannot open. That was the whole point of `canonical`, one level up: one
 * reading, many projections. This is another projection, not another reading.
 *
 * WHAT IS DELIBERATELY ABSENT. The design draws eight domains; six exist. Money
 * and Sleep have no connector, no observations and no capability, so they are
 * not in this file and they are not in the deck. The renderings exist in
 * `src/home/DeckWidget.tsx` and will draw the moment there is something true to
 * put in them. A widget with invented numbers would be the exact failure the
 * "no vibe metrics" rule exists to stop, and it would be worse here than
 * anywhere else, because the deck is now the navigation.
 */

/**
 * How a widget draws itself. One per shape of picture, NOT one per domain.
 *
 * Named after the picture rather than the source, because the picture is the
 * decision: `bars` is seven days against a goal line whether the days are steps
 * or something later, and a second domain that depletes over time should reuse
 * `stock` rather than invent a ninth rendering.
 */
export type DeckRender =
  | 'cal' | 'mail' | 'video' | 'bars' | 'places' | 'stock' | 'runway' | 'drift'

export interface DeckChip {
  label: string
  primary?: boolean
  /** The capability this runs. Absent means the chip is not offered at all. */
  action: WidgetAction
}

export interface DeckRow {
  id: string
  /** Left column: a clock time, an initial, a place name — the row's anchor. */
  lead: string
  title: string
  sub?: string
  /**
   * The dimmed continuation of `sub`, on the same line.
   *
   * Mail's snippet, and only Mail's: subject and snippet are one thought, and
   * splitting them over two rows was two lines of grey saying less than one.
   */
  note?: string
  /** Right-hand value: an age, a distance, a time left. */
  trail?: string
  /**
   * This row is THE one. Tints the row — and there is at most one per widget.
   *
   * `hot` and `unread` were the same field, so with eight unread messages all
   * four Mail rows were tinted and dotted: four accents, which is the same as
   * none. "One accent per widget, used for the single most important mark only"
   * is the design's rule and this is the split that lets it hold — the accent
   * says WHICH ONE, and `unread` goes on saying which are unread.
   */
  hot?: boolean
  /** Unread state, as a readout. Lights the dot without claiming the accent. */
  unread?: boolean
  /** 0–1, for the depletion renderings. */
  fill?: number
  /**
   * How many messages are in this thread, when more than one.
   *
   * The row stands for a CONVERSATION, not a message — three rows that were
   * the same exchange were three quarters of the mail widget saying one thing.
   */
  count?: number
  /**
   * A watch's recent checks, oldest first, and which of them moved the answer.
   *
   * The rows said what each watch last found and left the bottom third of the
   * card black. This is the rest of `history` — already on the object, already
   * unused — as the one picture that says how OFTEN a thing moves, which is
   * what decides whether "no change since Tuesday" is reassuring or a watch
   * quietly failing.
   */
  spark?: { changed: boolean }[]
}

/**
 * REAL GEOGRAPHY, PROJECTED ON THE SERVER.
 *
 * What this replaced was a drawing: two radial gradients, a dot at 24%/66%, a
 * second dot at 64%/36% and a line rotated -34° between them. It looked like a
 * map of somewhere and it was a map of nowhere — the marker did not move when
 * the place did, and the "route" was a CSS transform. On the one widget whose
 * entire job is to say where things are relative to each other, that is the
 * hallucination rule broken in the most literal way available.
 *
 * Web-Mercator is arithmetic, so it happens here rather than in the renderer:
 * the client is handed tile URLs and pixel offsets and draws them, which keeps
 * the picture re-derivable for a stated set of coordinates and testable without
 * a browser.
 */
export interface DeckMap {
  /** Canvas the offsets are relative to. */
  w: number
  h: number
  tiles: { key: string; url: string; left: number; top: number }[]
  marks: { id: string; left: number; top: number; self?: boolean; label?: string }[]
  /**
   * The viewport these offsets were computed for — centre and zoom.
   *
   * Sent so the widget can DRAG. Everything above is a picture computed for one
   * fixed frame, which is correct and is also why the map could only ever be
   * looked at: to pan you have to know which ground is under the canvas, and
   * pixel offsets alone cannot say. With these three numbers the renderer can
   * re-derive tiles and pin positions for a moved frame using the same
   * Web-Mercator arithmetic, and it is the same arithmetic — see `project` here
   * and `worldPx` in DeckWidget, which are deliberately the same four lines.
   *
   * The precomputed `tiles` stay, and stay authoritative for the first paint:
   * they arrive with the feed, so the map is on screen before any client
   * measurement or gesture, which is the instant-paint rule.
   */
  lat: number
  lon: number
  z: number
}

/**
 * CALENDAR'S DAY, AS A SHAPE RATHER THAN A LIST.
 *
 * `top`/`height` are fractions of the strip, so the renderer positions by real
 * elapsed time and two events that overlap are two blocks side by side — a
 * collision you can see without reading a word. A list of rows cannot express
 * that at all, which is why the count-plus-titles version could tell him what
 * was on today but never that two of them were at once.
 */
export interface DeckStrip {
  /** Hour labels down the gutter, with their fractional positions. */
  ticks: { at: number; label: string }[]
  /** Where "now" falls in the window, or null when the window is not today. */
  nowAt: number | null
  blocks: {
    id: string
    title: string
    lead: string
    top: number
    height: number
    /** Which column of `lanes`, for overlapping events. */
    lane: number
    lanes: number
    /** Awaiting his RSVP — drawn as an outline rather than a fill. */
    tentative?: boolean
    hot?: boolean
  }[]
  /** All-day events are a band above the axis. They are never timed blocks. */
  allDay: { id: string; title: string }[]
}

export interface DeckWidget {
  /** The nav id. Tapping the widget opens this application. */
  id: string
  /** The feed need it was projected from, so the tap resolves (see nav.ts). */
  needId: string
  name: string
  /**
   * The top-right count. A COUNT, never a timestamp and never a source name.
   *
   * "as of 08:31" and "google · calendar" both came off Home in this design and
   * neither is coming back through here: the widget says which domain it is, and
   * how stale it is belongs to the surface that can do something about it.
   */
  meta: string
  render: DeckRender
  /** This domain is the live one right now. */
  hot: boolean
  hero?: { title: string; sub?: string; rel?: string; dur?: string; image?: string; play?: boolean }
  /**
   * The object the hero stands for.
   *
   * Two jobs, and both were bugs without it. Tapping the hero has to open THAT
   * object — it was opening `rows[0]`, which is the event AFTER the one being
   * displayed. And slot two has to be able to tell that it is about to repeat
   * the hero, which is the check `relevanceFor` makes below.
   */
  heroId?: string
  rows?: DeckRow[]
  thumbs?: { id: string; dur: string; image?: string; title?: string; channel?: string }[]
  /** Places only. Real tiles, real markers. See `DeckMap`. */
  map?: DeckMap
  /** Video only: the store has real thumbnails, so a media layout is honest. */
  art?: boolean
  /**
   * THIS DOMAIN HAS NOTHING TO SHOW, AND SAYS SO IN A LINE RATHER THAN A BOX.
   *
   * The frozen contract already required this — "empty attention collapses; an
   * empty band is a compact unboxed row, not a bordered card-sized region;
   * empty content does not preserve populated geometry" — and the deck was
   * built without honouring it. On his real account that meant Calendar,
   * Places and YouTube each drew a 340px filled rectangle containing one word,
   * so more than half of Home was black boxes you had to swipe through.
   *
   * The SLIDE keeps its height: deck geometry is fixed and a card that resized
   * itself would break the snap. What collapses is the CARD — no fill, no
   * border, no 340px of surface — leaving a quiet line and honest space.
   */
  quiet?: boolean
  /** Calendar only. The day as a shape. See `DeckStrip`. */
  strip?: DeckStrip
  /**
   * The reading is history, not news.
   *
   * Sent as its own flag rather than folded into the sentence so the PICTURE
   * can say it: desaturated bars are the difference between "you barely moved"
   * and "this has not synced since Friday", which are opposite facts that a
   * caption underneath is very easy not to read.
   */
  stale?: boolean
  figure?: string
  /** Which day the figure is from, when that is not today. Blank otherwise. */
  note?: string
  unit?: string
  delta?: string
  /**
   * Seven values in 0–1 with their labels, and which one is today.
   *
   * `v` is the HEIGHT and `value` is the READING, and the widget now needs both
   * because the chart scrubs: a finger on a bar has to be answered with the
   * number that bar stands for, and a normalised fraction of the week's peak is
   * not a number anyone asked about. `day` is the same fact for the date — the
   * one-letter axis label is enough to read a shape and not enough to identify
   * a day once you are pointing at one.
   *
   * Both are formatted on the server, like every other string in this file: the
   * unit, the thousands separator and the weekday name are all locale and
   * timezone decisions, and `clock.ts` owns those.
   */
  bars?: { label: string; v: number | null; now?: boolean; value?: string; day?: string }[]
  goal?: { at: number; label: string } | null
  /**
   * The sentence under the picture, and it is allowed to be empty.
   *
   * Prose only where a number cannot carry the meaning. Six widgets each
   * explaining themselves in a line is the caption habit the design removed, so
   * this is populated only when the sentence says something the picture does
   * not already say.
   */
  foot: string
  chips: DeckChip[]
  /** The zoomed-out card. One figure, one line. */
  mini: { value: string; line: string }
}

/**
 * SLOT TWO. Not a summary of the widget above it.
 *
 * "Whatever most deserves the space underneath, whether or not it belongs to the
 * widget above it" — so it answers to his situation, not to what he happens to
 * have swiped to. `forWidget` is the exception and is the reason the design put
 * it there: when the deck is on Money and there IS something to say about money,
 * saying it is better than holding the general answer.
 */
export interface Relevance {
  needId: string
  eyebrow: string
  head: string
  sub: string
  /**
   * NO `action`. It used to project `n.action?.label` — the LABEL alone, with the
   * action's id and its `done` state dropped — and the client rendered it as a
   * white pill that looked like the primary control and could not possibly
   * perform anything, because it had never been sent anything to perform. On the
   * reference fixture the pill read "Set a reminder" and opened the calendar.
   *
   * Restoring an action here means sending something `perform` can take, not a
   * string. See the note in `RelevanceCard`.
   */
  tone: 'urgent' | 'changed' | 'active' | 'warning' | 'time' | 'neutral' | 'resolved'
}

/**
 * SLOT THREE. WHAT CRUCIBLE UNDERSTOOD — and nothing else.
 *
 * IT WAS A MAIL COUNTER. Not by anybody's decision: the slot rendered whichever
 * synthesis need carried an `opening`, and the model's opening is a summary of
 * the loudest source, so on the reference fixture the "intelligence" slot read
 * *"6 in the last week from 5 senders. Newest: Your…"* — a count as primary
 * content, truncated mid-word, restating the Mail widget one swipe away, and
 * carried onto every other surface by the collapsed chat handle. Three separate
 * frozen rules, all broken by one projection that nobody had ever pointed at the
 * cognition it was named after.
 *
 * It is now `IntelligencePresentation`, compiled by `intelligence.ts` from typed
 * cognition — a supported hypothesis, a change point, an anomaly against a
 * baseline — and by nothing else. There is no fallback. A model's prose cannot
 * reach this slot, a source count cannot reach this slot, and when the memory
 * core has concluded nothing that clears `significance.ts`'s bar the slot is
 * ABSENT. §8: a quiet slot is valid; filler is not.
 */

export interface HomeDeck {
  widgets: DeckWidget[]
  relevance: Relevance | null
  /** Keyed by widget id. Overrides `relevance` while that widget is in front. */
  relevanceFor: Record<string, Relevance>
  intelligence: IntelligencePresentation | null
  /**
   * Domains he has switched off, so the deck settings screen can list them
   * without a second round trip and without the client inventing the roster.
   */
  off: string[]
}

/** need id → nav id. The one place the two vocabularies meet; see nav.ts. */
const NAV: Record<string, string> = {
  'src-calendar': 'calendar',
  'src-email': 'mail',
  'src-map': 'places',
  'src-youtube': 'video',
  'src-health': 'fitness',
  'src-keepaneye': 'watch',
}

const RENDER: Record<Widget['kind'], DeckRender | null> = {
  calendar: 'cal', mail: 'mail', video: 'video', fitness: 'bars',
  map: 'places', watch: 'stock',
  // Generic widget kinds have no picture of their own. A source that projects
  // one is not in the deck; it is still an application and still opens.
  list: null, agenda: null, chart: null, media: null, detail: null, compose: null,
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const hhmm = (iso: string, tz?: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || undefined,
  }).format(d)
}

/**
 * "in 3h", "in 40 min", "now". Relative to a PASSED instant, never `Date.now()`.
 *
 * The whole file takes `now` as a parameter for the reason `clock.ts` exists:
 * the Worker runs in UTC, he is in Europe/Rome, and a projection that reads the
 * ambient clock can be neither re-derived for a stated time nor tested.
 */
const relTime = (iso: string, now: Date): string => {
  const mins = Math.round((Date.parse(iso) - now.getTime()) / 60_000)
  if (!Number.isFinite(mins)) return ''
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins} min`
  const h = Math.round(mins / 60)
  if (h < 24) return `in ${h}h`
  const d = Math.round(h / 24)
  return d === 1 ? 'tomorrow' : `in ${d} days`
}

const duration = (seconds?: number): string => {
  if (!seconds || seconds < 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

const age = (iso: string, now: Date): string => {
  const mins = Math.round((now.getTime() - Date.parse(iso)) / 60_000)
  if (!Number.isFinite(mins) || mins < 0) return ''
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const initial = (name: string): string => (name.trim()[0] ?? '·').toUpperCase()

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── Geography ────────────────────────────────────────────────────────────────

const TILE = 256

/** Web-Mercator world pixel for a coordinate at a zoom level. */
const project = (lat: number, lon: number, z: number) => {
  const n = TILE * 2 ** z
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180)
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  }
}

/** Great-circle metres. Used for the one figure the Places widget is about. */
const metresBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = 6_371_000
  const p = Math.PI / 180
  const h =
    0.5 - Math.cos((b.lat - a.lat) * p) / 2 +
    (Math.cos(a.lat * p) * Math.cos(b.lat * p) * (1 - Math.cos((b.lon - a.lon) * p))) / 2
  return 2 * r * Math.asin(Math.sqrt(h))
}

const distanceLabel = (m: number): string =>
  m < 950 ? `${Math.round(m / 10) * 10} m` : m < 100_000 ? `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km` : `${Math.round(m / 1000)} km`

/**
 * THE TILES AND MARKERS FOR ONE SMALL MAP.
 *
 * Zoom is chosen so the widest gap between the points fits the canvas with
 * margin — a fixed zoom either buried two neighbouring places under one pin or
 * put a city and a mountain on opposite sides of the world. Returns null when
 * there is nothing to draw, and null is the honest answer: an empty map is
 * better than a map of Rome he has never been to.
 */
function deckMap(points: { id: string; lat: number; lon: number; self?: boolean; label?: string }[], w: number, h: number): DeckMap | null {
  if (!points.length) return null

  const lats = points.map((p) => p.lat)
  const lons = points.map((p) => p.lon)
  const centre = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 }

  let z = 16
  if (points.length > 1) {
    // Largest zoom at which every point still lands inside 80% of the canvas.
    for (; z > 2; z--) {
      const px = points.map((p) => project(p.lat, p.lon, z))
      const spanX = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x))
      const spanY = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y))
      if (spanX <= w * 0.8 && spanY <= h * 0.8) break
    }
  } else {
    z = 14
  }

  const c = project(centre.lat, centre.lon, z)
  const originX = c.x - w / 2
  const originY = c.y - h / 2
  const n = 2 ** z

  const tiles: DeckMap['tiles'] = []
  const tx0 = Math.floor(originX / TILE)
  const ty0 = Math.floor(originY / TILE)
  const tx1 = Math.floor((originX + w) / TILE)
  const ty1 = Math.floor((originY + h) / TILE)
  for (let ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= n) continue
    for (let tx = tx0; tx <= tx1; tx++) {
      const wx = ((tx % n) + n) % n
      tiles.push({
        key: `${z}/${wx}/${ty}`,
        url: `https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`,
        left: Math.round(tx * TILE - originX),
        top: Math.round(ty * TILE - originY),
      })
    }
  }

  return {
    w, h, tiles, lat: centre.lat, lon: centre.lon, z,
    /*
      MARKS ARE CLAMPED INTO THE CANVAS.

      The zoom search fits every point inside 80% of the box, which is true of
      the points it was given and not of a single point far from the rest at
      zoom 14, or of any point once the box is measured smaller than the canvas.
      A pin at left:-40px is a child node hanging outside its card, which the
      capture gate reports — correctly — as content that did not fit. Clamped,
      the pin sits on the edge it is beyond, which is also the honest picture.
    */
    marks: points.map((p) => {
      const q = project(p.lat, p.lon, z)
      const clamp = (v: number, hi: number) => Math.max(9, Math.min(hi - 9, Math.round(v)))
      return {
        id: p.id,
        left: clamp(q.x - originX, w),
        top: clamp(q.y - originY, h),
        self: p.self,
        label: p.label,
      }
    }),
  }
}

// ── Time, as a shape ─────────────────────────────────────────────────────────

/**
 * The day's timed events laid out on a common axis, with overlaps in lanes.
 *
 * The window is the events themselves rather than a fixed 00:00–24:00: eight
 * empty hours of night is eight-ninths of the picture spent saying nothing, and
 * the thing worth seeing — that two of these collide — was two pixels tall.
 */
function deckStrip(events: CalEventLike[], now: Date, tz?: string): DeckStrip | null {
  const timed = events.filter((e) => !e.allDay && Number.isFinite(Date.parse(e.start)))
  const allDay = events.filter((e) => e.allDay).slice(0, 2).map((e) => ({ id: e.id, title: clip(e.title, 40) }))
  if (!timed.length) return allDay.length ? { ticks: [], nowAt: null, blocks: [], allDay } : null

  const startOf = (e: CalEventLike) => Date.parse(e.start)
  const endOf = (e: CalEventLike) => {
    const en = e.end ? Date.parse(e.end) : NaN
    return Number.isFinite(en) && en > startOf(e) ? en : startOf(e) + 30 * 60_000
  }

  const HOUR = 3600_000
  let from = Math.min(now.getTime(), ...timed.map(startOf))
  let to = Math.max(...timed.map(endOf))
  // Round out to whole hours, and never draw a window so short that a 30-minute
  // event fills it or so long that everything in it is a hairline.
  from = Math.floor(from / HOUR) * HOUR
  to = Math.ceil(to / HOUR) * HOUR
  if (to - from < 4 * HOUR) to = from + 4 * HOUR
  if (to - from > 12 * HOUR) to = from + 12 * HOUR
  const span = to - from

  const ticks: DeckStrip['ticks'] = []
  const hours = Math.round(span / HOUR)
  const step = hours > 8 ? 2 : 1
  for (let i = 0; i <= hours; i += step) {
    ticks.push({ at: (i * HOUR) / span, label: hhmm(new Date(from + i * HOUR).toISOString(), tz) })
  }

  // Lanes: an event shares a column with anything it does not overlap. Greedy
  // is correct here because the list is sorted and short — the answer only has
  // to be a true statement about which pairs collide.
  const ordered = [...timed].sort((a, b) => startOf(a) - startOf(b))
  /*
    LANES ARE PER CLUSTER, NOT PER DAY.

    A single global lane count made every block half-width the moment any two
    events anywhere in the window overlapped — so one 20:30 collision narrowed
    the 21:30 supper that collides with nothing, and the shape stopped meaning
    "this one is contended". A cluster ends when a block starts after everything
    before it has finished, and each cluster is laned on its own.
  */
  const placed: { e: CalEventLike; s: number; en: number; lane: number; lanes: number }[] = []
  let cluster: typeof placed = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  const closeCluster = () => {
    const n = Math.max(1, laneEnds.length)
    for (const p of cluster) p.lanes = n
    placed.push(...cluster)
    cluster = []
    laneEnds = []
  }
  for (const e of ordered) {
    const s = startOf(e)
    const en = endOf(e)
    if (cluster.length && s >= clusterEnd) closeCluster()
    let lane = laneEnds.findIndex((x) => x <= s)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(en) } else { laneEnds[lane] = en }
    cluster.push({ e, s, en, lane, lanes: 1 })
    clusterEnd = Math.max(clusterEnd === -Infinity ? en : clusterEnd, en)
  }
  closeCluster()

  return {
    ticks,
    nowAt: now.getTime() >= from && now.getTime() <= to ? (now.getTime() - from) / span : null,
    allDay,
    blocks: placed
      .filter((p) => p.en > from && p.s < to)
      .slice(0, 12)
      .map((p) => ({
        id: p.e.id,
        title: clip(p.e.title, 44),
        lead: hhmm(p.e.start, tz),
        top: Math.max(0, (p.s - from) / span),
        height: Math.min(1, (Math.min(p.en, to) - Math.max(p.s, from)) / span),
        lane: p.lane,
        lanes: p.lanes,
        tentative: p.e.response === 'needsAction' || p.e.response === 'tentative',
        // ONE ACCENT PER WIDGET, so `hot` is the block that is running or about
        // to. At a three-hour threshold every block on an evening's strip lit
        // up, which is the same as none of them lighting up.
        hot: p.s - now.getTime() < HOUR && p.en >= now.getTime(),
      })),
  }
}

interface CalEventLike {
  id: string
  title: string
  start: string
  end?: string
  allDay?: boolean
  response?: string
}

/**
 * HOW MANY ROWS FIT, GIVEN WHAT ELSE THE CARD IS CARRYING.
 *
 * The card is 340px whatever is in it — geometry never adapts to content — so
 * the content adapts to the geometry, which is the overflow ladder's first rung
 * ("show less information") run in reverse: when there is no footing sentence
 * and no chips, that space is real and belongs to more of his actual data.
 *
 * The first capture is the argument. Calendar had a hero, two rows, no foot and
 * no chips, and the bottom THIRD of the primary widget on the home screen was
 * black. A fixed row count copied from a mock that always had a caption is a
 * constant standing in for a measurement, which is the same mistake in a
 * different place.
 *
 *   340 − 29 padding − 19 header = 292 usable
 *   cal:  − 94 hero → 198 ⇒ 4 rows at 44 + 6 gap (194)
 *   mail: 292 ⇒ 4 rows at 64 + 6 gap (274)
 *
 * With a foot and chips the design's own counts are what fits, and those are
 * what it asks for.
 */
const roomFor = (busy: boolean, withFoot: number, without: number) => (busy ? withFoot : without)

/**
 * The chips a widget offers, filtered to the ones that will actually run.
 *
 * `sanitiseActions` upstream has already dropped anything outside the
 * capability table, so this only decides how many are offered and which is
 * primary. A chip wired to nothing is the failure that shipped three times; the
 * defence is that there is no path here that invents an action.
 */
/**
 * The card's chips — and a Home card does not offer to be configured.
 *
 * `setting` actions are dropped here rather than at each producer, because the
 * producer is right to offer them: `Make 7,180 the goal` belongs on the Activity
 * SURFACE, beside the sentence that says where 7,180 came from. What it does not
 * belong on is a 340px card whose job is to say how today went, as the loudest
 * element on it, above the figure and the sentence it competes with. §24's trade,
 * measured on the card it was found on: one white pill out, one line of useful
 * comparison in.
 */
/**
 * AND A HOME CHIP MAY NOT CREATE SOMETHING IT CANNOT LET HIM NAME.
 *
 * `New event` was on the Calendar card, and it was not a dead control — it was
 * worse. It ran `calendar.create` with no parameters at all, because a 340px
 * card has nowhere to type a title or pick a time; `capabilities.ts` fills the
 * gaps with `summary: undefined` and `start: new Date().toISOString()`. One tap
 * on his home screen wrote an untitled event onto his real Google Calendar, at
 * that instant, with no confirmation and no way to tell it had happened.
 *
 * The distinction is not "writes" — `calendar.rsvp` writes, and Accept on a card
 * showing the invitation is a complete and correct answer to a named object.
 * It is whether the card carries everything the action needs. Creation never is:
 * it needs words, and the place for words is the surface with the fields on it,
 * where `New event` already lives.
 */
const NEEDS_INPUT = /\.(create|add|new|compose|draft)$/

const chipsOf = (pane: WidgetPane | undefined, extra: WidgetAction[] = []): DeckChip[] => {
  const all = [...(pane?.actions ?? []), ...extra]
    .filter((a) => !a.setting)
    .filter((a) => !NEEDS_INPUT.test(a.kind) || Object.keys(a.params ?? {}).length > 0)
  return all.slice(0, 2).map((a, i) => ({
    label: clip(a.label, 24), primary: a.primary ?? i === 0, action: a,
  }))
}

/**
 * ONE DOMAIN, DRAWN.
 *
 * Returns null when the need carries no typed widget this deck knows how to
 * picture — which is not a failure and not something to paper over with a
 * generic card. It means the domain is an application without a picture yet, and
 * the correct behaviour is to be absent from the deck and reachable by opening
 * it, exactly as a switched-off domain is.
 */
export function deckWidget(need: Need, now: Date, tz?: string): DeckWidget | null {
  const built = buildWidget(need, now, tz)
  /*
    QUIET IS OBSERVED, NOT DECLARED.

    Derived from what the widget actually ended up carrying rather than set by
    hand in each branch, because "did this one come out empty" is exactly the
    question six separate branches would answer six slightly different ways —
    and the branch that forgot is the one that ships a black rectangle. A
    figure counts as content; a `—` does not.
  */
  if (!built) return null
  const hasFigure = !!built.figure && built.figure !== '—'
  const quiet =
    !built.hero && !built.rows?.length && !built.thumbs?.length && !built.map
    && !built.strip?.blocks.length && !built.strip?.allDay.length
    && !built.bars?.length && !hasFigure
  return quiet ? { ...built, quiet: true } : built
}

function buildWidget(need: Need, now: Date, tz?: string): DeckWidget | null {
  const pane = need.panes?.[0]
  const w = pane?.widget
  if (!w) return null
  const render = RENDER[w.kind]
  if (!render) return null

  /*
    PHASE 8. The memory core's lines for this widget, or nothing.

    Read once, here, and consumed by the branches that have somewhere honest to
    put a sentence. `contextFor` is the gate rather than an `if` per branch: it
    filters on `weight`, so a `depth` context — Mail's, and Calendar's departure
    lines — is structurally unable to reach a Home card even if a branch below
    reached for it by mistake.
  */
  const context: DomainContext[] | undefined = 'context' in w ? w.context : undefined

  const id = NAV[need.id] ?? need.id.replace(/^src-/, '')
  const base = {
    id, needId: need.id, name: need.title, render,
    hot: need.heat === 'hot',
    foot: '', chips: chipsOf(pane), meta: '',
    mini: { value: '', line: '' },
  }

  switch (w.kind) {
    case 'calendar': {
      /*
        WHAT IS AHEAD IS NOT DECIDED HERE. See `calendar.ts`.

        It used to be, and the filter it used was `e.allDay ? true` — which is
        not a filter. Every all-day event ever synced stayed "ahead" forever, and
        his calendar is almost entirely all-day events, so on 18 August this card
        led with a restaurant booking from the 8th and claimed `8 ahead` while
        the line built by the OTHER "ahead" — the correct one, forty lines away
        in `panes.ts` — said "Nothing on today's agenda. Hiking with Mauro is
        tomorrow." One list, two readers, and the wrong reader owned the largest
        object on the home screen.
      */
      const ahead = upcoming(w.events, now, tz)
      const hero = nextUp(w.events, now, tz)
      if (!hero) {
        return { ...base, meta: '', mini: { value: '—', line: 'Nothing ahead.' } }
      }

      /*
        THE PICTURE IS TODAY, AND ONLY WHEN TODAY HAS A SHAPE.

        The axis exists to say that two things collide and that there is a hole
        after lunch. On a day with no timed events it can say neither: it drew an
        empty gutter of hour labels over 200px of black, which is a picture of
        nothing presented with the confidence of a picture of something. So the
        strip is built from today's events MINUS the hero, and when today has no
        timed events at all, zone B yields its space to the agenda rows below —
        which is §2 exactly: an unused zone gives its space to the others rather
        than leaving void.
      */
      const today = ahead.filter((e) => isToday(e, now, tz) && e.id !== hero.id)
      const strip = deckStrip(today, now, tz)
      const clash = strip?.blocks.some((b) => b.lanes > 1) ?? false

      /*
        ROWS ARE WHAT THE STRIP CANNOT DRAW: the days after today.

        The design asks for the hero and then "the following two, each with its
        time as the lead column", and this card never had them — so on a day
        whose events are all-day, the entire widget was a hero and two chips.
        The lead column is a clock for today and a day name otherwise, per the
        §0 exemption: a date on today's 09:00 meeting is noise, a date on
        Sunday's party is the whole reason to show it.
      */
      const shown = new Set([hero.id, ...(strip?.blocks ?? []).map((b) => b.id), ...(strip?.allDay ?? []).map((a) => a.id)])
      /*
        ROWS AND THE AXIS ARE ALTERNATIVES, NEVER BOTH.

        Both want the same zone and both grow into it, so a card carrying an axis
        AND two rows is a 340px box with 370px in it — measured by the capture
        gate as 30px of overflow and a row hanging 7px outside its card, which is
        exactly what shipping them together did.

        The axis wins when it has anything to draw, because it says things a list
        cannot: that two events collide, and that there is a hole after lunch.
        The rows are what fills the zone when there is no axis to draw at all.
      */
      const room = strip?.blocks.length
        ? 0
        : roomFor(!!clash || !!contextFor(context, 'calendar', '', 'card'), 3, 4)
      const rows: DeckRow[] = ahead
        .filter((e) => !shown.has(e.id))
        .slice(0, room)
        .map((e) => ({
          id: e.id,
          lead: leadFor(e, now, tz),
          title: clip(e.title, 40),
          sub: e.location ? clip(e.location, 28) : undefined,
        }))

      return {
        ...base,
        /*
          THE COUNT IS OF WHAT IS STILL AHEAD, and `clear` when that is none.
          It said `8 ahead` on a week holding two things.
        */
        meta: ahead.length ? plural(ahead.length, 'ahead', 'ahead') : 'clear',
        heroId: hero.id,
        hero: {
          title: hero.title,
          sub: [hero.allDay ? 'all day' : hhmm(hero.start, tz), hero.location].filter(Boolean).join(' · '),
          /*
            AN ALL-DAY EVENT GETS A DAY, NOT A COUNTDOWN.

            `rel` was blank for every all-day event, so a card whose hero is
            tomorrow's hike said nothing at all about when it is — and "tomorrow"
            is the only fact on that card worth having. It cannot be "in 40
            minutes", because an all-day event has no clock; it can be a day
            away, and `relFor` is the one place that decides which.
          */
          rel: relFor(hero, now, tz),
        },
        strip: strip ?? undefined,
        rows: rows.length ? rows : undefined,
        /*
          THE ONE SENTENCE A PICTURE OF BLOCKS CANNOT MAKE, AND ONLY WHEN TRUE.

          Two candidates, and the order between them is the product decision. A
          collision is a fact about today that he can act on in the next hour;
          "busier than your usual Friday" is a comparison, and a comparison that
          displaced a clash would be the softer claim taking the harder one's
          row. So the clash wins the row outright and the memory core gets it
          only when there is no clash — which is §6 exactly: enrichment takes
          space that was free, never space that was earning.
        */
        foot:
          clash
            ? 'Two of these are at the same time.'
            : contextFor(context, 'calendar', '', 'card')?.line ?? '',
        mini: {
          value: hero.allDay ? relFor(hero, now, tz) : hhmm(hero.start, tz),
          line: clip([hero.title, hero.location].filter(Boolean).join(', '), 60),
        },
      }
    }

    case 'mail': {
      /*
        THE WIDGET IS ABOUT THE LAST WEEK, AND NOW SAYS ONLY THAT.

        Its own empty copy has always read "Nothing in the last week." and Gmail
        is queried with `newer_than:7d` — but the world document keeps every
        message it has ever seen, so the card was drawing mail from eleven and
        twelve days ago and calling eight of them unread. Same shape as the
        calendar defect: the window was in the QUERY and never in the READ.
      */
      const WEEK = 7 * 86_400_000
      const recent = w.messages.filter((m) => {
        const t = Date.parse(m.at)
        return !Number.isFinite(t) || now.getTime() - t <= WEEK
      })
      const newest = [...recent].sort((a, b) => b.at.localeCompare(a.at))
      const unread = newest.filter((m) => m.unread)

      /*
        A ROW IS A CONVERSATION, NOT A MESSAGE.

        `threadId` has been on the payload since Mail was written and nothing
        ever read it, so a four-message exchange with one person was the entire
        widget — four rows, four initials, one subject, and no room for anybody
        else. Rolled up, the widget shows four DIFFERENT people, which is the
        only version of this card that answers "who wants something".

        The thread carries the newest message's identity and the whole thread's
        unread state: a reply you have not read is unread whatever the state of
        the message under it.
      */
      const threads = new Map<string, { head: typeof newest[number]; n: number; unread: boolean }>()
      for (const m of newest) {
        const key = m.threadId || m.id
        const t = threads.get(key)
        if (!t) threads.set(key, { head: m, n: 1, unread: !!m.unread })
        else { t.n++; t.unread ||= !!m.unread }
      }

      /*
        IMPORTANCE, NOT RECENCY. Recency alone is an inbox, and he has one of
        those already: the widget's job is which four of these he would regret
        not seeing. Unread outranks read, and a message addressed to him alone
        outranks one he is a name on a list of — both facts already in the
        payload, neither of them previously consulted.
      */
      const direct = (to?: string) => !!to && !to.includes(',')
      /*
        A MACHINE THAT CANNOT BE REPLIED TO IS NOT CORRESPONDENCE.

        Ranking on unread alone put bulk mail at the top of the card, because
        bulk mail is precisely what stays unread: his Mail widget was four rows
        of Claude Team onboarding and Google security alerts, four days to ten
        days old, every one of them tinted as though it were waiting on him.
        "Who wants something" is the question this widget answers, and nobody
        wants anything from `no-reply@`.

        Read off the address rather than a category label, because the address is
        the sender's own statement that there is no conversation here.
      */
      const automated = (from: string) =>
        /(^|[<.\-_])(no-?reply|do-?not-?reply|noreply|notifications?|mailer|bounce|postmaster|automated)([@.\-_]|$)/i
          .test(from)
      /*
        The two facts carry equal weight and recency breaks the tie: an unread
        message from a person is the top of the card, a read one from a person
        and an unread one from a machine are worth about the same, and a read
        automated notice is the bottom. Weighting either one higher produced a
        visibly wrong card — humans-first alone put a twelve-day-old receipt he
        had already read above this week's unread mail.
      */
      const ranked = [...threads.values()].sort((a, b) => {
        const score = (t: typeof a) =>
          (automated(t.head.from) ? 0 : 4) + (t.unread ? 4 : 0) + (direct(t.head.to) ? 1 : 0)
        return score(b) - score(a) || b.head.at.localeCompare(a.head.at)
      })

      return {
        ...base,
        meta: unread.length ? `${unread.length} unread` : plural(threads.size, 'this week', 'this week'),
        rows: ranked.slice(0, roomFor(base.foot.length > 0 || base.chips.length > 0, 3, 4)).map((t, i) => ({
          id: t.head.id,
          lead: initial(t.head.fromName || t.head.from),
          title: t.head.fromName || t.head.from,
          sub: t.head.subject,
          // Subject and snippet are one line, the snippet dimmed. Two rows of
          // grey said less than one and cost a whole conversation's height.
          /*
            A SNIPPET THAT IS THE SUBJECT AGAIN IS NOT A SNIPPET.

            Mailers that put the subject line at the top of the body — receipts,
            statements, alerts — produce exactly that, and the row rendered
            "Your receipt from Anthropic — Your receipt from Anthropic". The
            second half is not extra information at any width, so it is dropped
            rather than clamped.
          */
          note: (() => {
            const s = (t.head.snippet ?? '').replace(/\s+/g, ' ').trim()
            if (!s) return ''
            const subj = t.head.subject.replace(/\s+/g, ' ').trim().toLowerCase()
            return s.toLowerCase().startsWith(subj.slice(0, 40)) ? '' : clip(s, 90)
          })(),
          trail: age(t.head.at, now),
          /*
            THE ACCENT GOES TO ONE ROW, and only when that row is genuinely
            waiting on him. A card whose top row is a ten-day-old automated
            notice has nothing worth accenting, and says so by accenting nothing.
          */
          hot: i === 0 && t.unread && !automated(t.head.from),
          unread: t.unread,
          count: t.n > 1 ? t.n : undefined,
        })),
        mini: {
          value: unread.length ? String(unread.length) : String(threads.size),
          line: unread.length
            ? `unread, newest ${age(newest[0]!.at, now)} ago`
            : threads.size ? 'in the last week' : 'Nothing in the last week.',
        },
      }
    }

    case 'video': {
      /*
        A VIDEO YOU CANNOT PLAY IS STILL A VIDEO YOU CAN KNOW ABOUT.

        This filtered `videos` down to the ones with a verified `url`, on the
        reasoning that a play button leading nowhere is the blank-destination
        rule broken by a picture. The reasoning was right about the play button
        and wrong about the video: against his actual store, where none of the
        six carries a `url` yet, it turned a populated widget into the words
        "nothing new" — deleting six real titles to avoid one false affordance.
        That is a worse lie than the one it was fixing, and it is the failure the
        empty rectangles are made of.

        So nothing is dropped. `playable` decides only whether a PLAY affordance
        is offered; the title, channel and duration are real either way, and the
        surface already explains, in words, why an unidentified video cannot be
        opened.
      */
      const [first, ...rest] = w.videos
      if (!first) return { ...base, meta: 'nothing new', mini: { value: '—', line: 'Nothing new from the channels you follow.' } }
      const playable = w.videos.filter((v) => !!v.url).length
      const art = w.videos.some((v) => !!v.thumbnail)
      return {
        ...base,
        // "3 new", never "3 news" — `plural` needs telling when the plural is
        // not the word plus an s, and an adjective never is.
        meta: plural(w.videos.length, 'new', 'new'),
        heroId: first.id,
        hero: {
          title: first.title,
          // The channel is who is talking, which is most of how he chooses.
          sub: first.channel ? clip(first.channel, 40) : '',
          dur: duration(first.seconds),
          image: first.thumbnail,
          // The ▶ is a claim that this will play. Made only when it will.
          play: !!first.url,
        },
        // Three under a hero panel; more when there is no panel, because the
        // list layout has the room and a fifth real title beats 130px of black.
        thumbs: rest.slice(0, art ? 3 : 5).map((v) => ({
          id: v.id, dur: duration(v.seconds), image: v.thumbnail,
          title: clip(v.title, 60), channel: v.channel ? clip(v.channel, 28) : '',
        })),
        /*
          WITH NO THUMBNAILS THERE IS NO THUMBNAIL GRID.

          Three empty gradient rectangles are not a picture of anything. When
          the store has no images — which is the state his account is actually
          in — the widget draws the titles instead, because a readable list of
          six real videos beats a media layout with no media in it.
        */
        art,
        foot: playable === 0 && w.videos.length > 0
          ? 'None of these are identified yet, so I cannot open them.'
          : '',
        mini: { value: String(w.videos.length), line: clip(first.title, 60) },
      }
    }

    case 'fitness': {
      const r = w.report
      const series = w.series[0]
      /*
        NO SERIES AT ALL IS A QUIET WIDGET, NOT AN ABSENT ONE.

        This returned null when either the series or the report was missing, and
        that is a domain DISAPPEARING from the deck because it had a thin day —
        the precise behaviour the design deleted. A domain he has switched on
        keeps its place whether or not it has news.

        The report may legitimately be absent while the series is not: that is
        what a source disagreement looks like, and `activityReport` withholds the
        figure on purpose rather than picking a winner. So the figure goes, the
        bars stay, and the widget says what it has.
      */
      if (!series) {
        return { ...base, meta: 'nothing yet', figure: '—', mini: { value: '—', line: 'No activity has been recorded yet.' } }
      }
      /*
        SEVEN DAYS AGAINST THE BUSIEST OF THEM, and `null` stays null.

        Missing ≠ zero is a frozen Activity rule and this is where a bar chart
        breaks it most easily: a day with no reading drawn at height zero is a
        claim that he did not move, which is a different and much worse
        statement than "no reading". The bar renders as an absence.
      */
      const days = series.days.slice(-7)
      const peak = Math.max(1, ...days.map((d) => d.value ?? 0))
      /*
        A `steady` GOAL GETS NO LINE.

        `fraction` is null for steady goals precisely because a bar implies a
        finish line, and a dashed rule across the chart is the same claim drawn
        differently: it says "above this is done". Steady goals are not done.
      */
      const goalFrac =
        r?.goal && r.goal.target > 0 && r.goal.direction !== 'steady'
          ? Math.min(1, r.goal.target / peak)
          : null
      /*
        THE FIGURE IS WITHHELD WHEN IT IS NOT TRUSTWORTHY.

        `current: null` means two sources disagree and he has not ruled. The
        widget shows no number and says why, which is the entire difference
        between an app that has a conflict type and one that displays whichever
        source synced last. `says` already carries the sentence.
      */
      const stale = r?.freshness.level === 'stale'
      return {
        ...base,
        meta: plural(days.length, 'day'),
        /*
          THE SEPARATOR IS A LOCALE DECISION AND THE SERVER MAKES IT — every
          other number on this card already did. The one that did not was the
          largest: `4385` at 34px, above a scrub readout saying `4,385 steps`.
        */
        figure: r?.current ? r.current.value.toLocaleString('en-GB') : '—',
        unit: r?.current ? (r?.unit ?? series.unit ?? '') : '',
        stale,
        /*
          ONE COMPARISON, NOT TWO.

          `+12%` is this week against last week; "a little above your usual
          Thursday" is this reading against the population it belongs to. Both are
          true, both say roughly "a bit better than usual", and printing them
          together is the metric soup §9 names — two units for one conclusion, in
          the two most prominent places on the card.

          The personal one wins when it exists, because it is the comparison that
          is HIS: a flat seven-day mean lumps a Sunday in with a Wednesday. When
          the memory core has nothing to say — which is every day it has not
          earned a baseline, and every host where `baselines` is still shadowed —
          the percentage keeps the corner it has always had. Degrading to what
          shipped before is the whole shape of this phase.

          A GOAL IS NOT A COMPARISON and is unaffected. "goal 8,000" says what he
          is aiming at, which neither of the other two answers.
        */
        /*
          THE CORNER SAYS THE GOAL ONLY WHEN THE CHART CANNOT.

          "A GOAL IS NOT A COMPARISON" still holds and is why this branch exists
          at all — but when `goalFrac` is set, the dashed rule across the bars is
          already drawing the target, and the footing sentence names the figure a
          third time. `goal 3221` in the corner of a card that also draws the goal
          line and says "425 short of your 3,221" is the same fact three times, in
          the slot §6 reserves for the trend, and unformatted where the other two
          are not. So: the line draws it when it can, and the corner falls back to
          the comparison it was always meant to carry.
        */
        delta: r?.goal && goalFrac === null
          ? `goal ${r.goal.target.toLocaleString('en-GB')}`
          : contextFor(context, 'activity', '', 'card')
            ? ''
            : r && r.trend.changePercent !== null
              ? `${r.trend.changePercent > 0 ? '+' : ''}${Math.round(r.trend.changePercent)}%`
              : '',
        /*
          THE ACCENTED BAR IS TODAY, NOT THE LAST ONE IN THE ARRAY.

          `i === days.length - 1` is the same thing only on a day the source has
          already reported. On this fixture it is not: the newest reading is
          yesterday's, so the widget accented yesterday's bar and the person
          reading it is told, in the app's one emphasis colour, that this is
          where he has got to today. `freshness.today` is the server's own
          answer to which date is today, so the accent is decided by it — and on
          a day with no reading yet, nothing is accented, which is true.
        */
        bars: days.map((d) => {
          const noon = new Date(`${d.date}T12:00:00Z`)
          const unit = r?.unit ?? series.unit ?? ''
          return {
            label: new Intl.DateTimeFormat('en-GB', { weekday: 'narrow', timeZone: tz || undefined }).format(noon),
            v: d.value === null ? null : d.value / peak,
            now: r ? d.date === r.freshness.today : false,
            /*
              WHAT THE SCRUB READS OUT, and "no reading" survives it.

              An empty string here is the same fact the hollow bar draws, and the
              widget prints the absence rather than a zero. Formatting the number
              here rather than on the client is the standing rule: the separator
              is a locale decision and the client has no business making one.
            */
            value: d.value === null ? '' : `${d.value.toLocaleString('en-GB')}${unit ? ` ${unit}` : ''}`,
            day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: tz || undefined }).format(noon),
          }
        }),
        /*
          WHICH DAY THE BIG NUMBER IS FROM, when it is not today's.

          `isToday` exists on the brief precisely because printing Friday's
          count on a Tuesday in the place a reader takes for "today" is a true
          number that reads as a false one. Blank when the reading IS today's —
          the phone already knows what day it is, and this is the §6 exemption
          rather than an exception to it: without it the figure means something
          different from what it says.
        */
        note: r?.current && !r.current.isToday ? r.gap.lastDayLabel : '',
        goal: goalFrac === null ? null : { at: goalFrac, label: 'goal' },
        // The one place a sentence genuinely carries what the bars cannot: what
        // the trend MEANS. Computed in activity.ts, not written here — and when
        // the report is withheld, the widget says nothing rather than guessing.
        /*
          THE CONCLUSION, AND MISSING STILL BEATS IT.

          §8: the memory core's most valuable contribution to Activity is the
          PERSONALISED comparison — "a little below your usual Thursday" — and it
          is strictly more useful than `says`, which is a statement about the
          week's shape against a goal he may not have set. So it takes the row
          when it exists.

          It takes the row SECOND, though, and the ladder below is the whole of
          §10. A withheld figure and a feed that stopped reporting are facts
          about whether there is anything to compare at all, and a baseline
          sentence drawn over either of them would be the app quietly reading a
          gap as a quiet week. Those two cases keep the row whatever the memory
          core concluded — and, upstream, `activityContext` is handed
          `report.current` rather than a bar, so on those days it has nothing to
          say in the first place. Two independent guards for one semantic rule,
          because it is the one this domain is most likely to break by accident.
        */
        foot: r
          ? (!r.current
              ? (r.source.why || r.says)
              : stale
                ? `Nothing since ${r.gap.lastDayLabel}.`
                : contextFor(context, 'activity', '', 'card')?.line ?? r.says)
          : '',
        mini: {
          value: r?.current ? `${r.current.value}` : '—',
          line: clip(r?.says ?? series.label, 60),
        },
      }
    }

    // The widget kind is `map`; the application calls itself Places. Both
    // vocabularies, deliberately — see `NAV` above and `sourceIdFor` in nav.ts.
    case 'map': {
      const marks = w.places.filter((p) => !p.self)
      const self = w.places.find((p) => p.self) ?? null
      /*
        REAL TILES, REAL PINS, AND NO ROUTE WE HAVE NOT ROUTED.

        The previous picture was two radial gradients, a dot at 24%/66%, a
        second dot at 64%/36%, and a line rotated -34° between them. None of the
        three moved when the data did. It was a drawing of a map, on the one
        widget whose entire subject is where things are relative to each other.

        What replaces it is projected from the coordinates the pane already
        carries. Straight-line distance is stated as such and computed here; a
        travel time is NOT shown, because routing is a network call
        (`maps.ts#routeBetween`) and the deck is on the instant-paint path. A
        distance that is true beats a duration that is guessed.
      */
      const points = [
        ...(self ? [{ id: self.id, lat: self.lat, lon: self.lon, self: true }] : []),
        ...marks.slice(0, 6).map((p) => ({ id: p.id, lat: p.lat, lon: p.lon, label: clip(p.label, 18) })),
      ]
      const withDistance = marks.map((p) => ({
        p, m: self ? metresBetween(self, p) : null,
      })).sort((a, b) => (a.m ?? Infinity) - (b.m ?? Infinity))
      const nearest = withDistance[0]

      return {
        ...base,
        meta: marks.length ? plural(marks.length, 'place') : '',
        map: deckMap(points, 330, 150) ?? undefined,
        rows: withDistance.slice(0, 2).map(({ p, m }) => ({
          // CLIPPED AT THE SOURCE, like every other string in this file.
          // "San Giovanni in Persiceto, Città metropolitana di Bologna,
          // Emilia-Romagna" is a real place name and it is what the hostile
          // fixture serves; unclipped it drove the row 130px past the card.
          id: p.id,
          lead: clip(p.label, 24),
          /*
            WHEN HE IS USUALLY HERE BEATS WHAT PROVINCE IT IS IN.

            §13's example, and the row it goes in already exists. `sub` is a
            geocoder's address tail — "Emilia-Romagna" — which tells him nothing
            he did not know from the pin. A learned rhythm is the one thing on
            this card that a map cannot draw, so when there is one it takes the
            slot and the address tail is what gives way.
          */
          title: contextFor(context, 'places', p.id, 'card')?.line ?? clip(p.sub ?? '', 60),
          trail: m === null ? '' : distanceLabel(m),
        })),
        /*
          NO FOOT. It read "Nearest is Avano, 3.4 km away." above a row reading
          "Avano … 3.4 km", and the rows are sorted by distance, so row one IS
          the nearest by construction. One card, one fact, printed twice — the
          same restatement slot two is forbidden from doing to the widget above
          it, happening inside a single widget. The sentence is gone rather than
          reworded: there is no version of it that the rows are not already
          saying.
        */
        foot: '',
        mini: {
          value: nearest?.m != null ? distanceLabel(nearest.m) : String(marks.length),
          line: marks.length ? clip(marks[0]!.label, 60) : 'Nothing here has coordinates yet.',
        },
      }
    }

    case 'watch': {
      /*
        A STANDING INTEREST DEPLETES TOWARDS ITS NEXT CHECK, and that is what
        the depletion rendering is drawn from here.

        The design's version of this widget was a pantry — "4 days of pasta
        left" — and we do not have a pantry. What we have is watches with a
        period and a last run, which is the same shape of fact: a bar that
        empties, and a figure saying how long is left. A watch that has never
        run reads as full and says so, because that is the failure the Watch
        card exists to make visible.
      */
      /*
        A WATCH IS ITS ANSWER, NOT ITS SCHEDULE.

        This drew a depletion bar emptying towards the next check — a picture of
        the cron timer. Every field that says something worth knowing was on the
        object and unused: `state` is what it last found, in its own words, and
        `changedAt` is when that answer last CHANGED as opposed to when it was
        last looked at.

        The distinction is the whole product. A watch checked forty times that
        has never moved is quiet and must read as quiet; a watch whose answer
        changed an hour ago is the reason he opened the app. A countdown to the
        next poll made those two identical, and made the one that had never run
        at all — the silent failure this surface exists to expose — look
        healthiest of the three, because its bar was full.
      */
      const active = w.watches.filter((t) => t.active)
      const changedAge = (t: typeof active[number]) =>
        t.changedAt ? now.getTime() - Date.parse(t.changedAt) : Infinity

      const rows: DeckRow[] = [...active]
        .sort((a, b) => changedAge(a) - changedAge(b))
        .slice(0, roomFor(false, 3, 4))
        .map((t) => {
          const never = !t.lastRunAt
          const moved = changedAge(t)
          return {
            id: t.id,
            lead: clip(t.what, 34),
            title: never
              ? 'Not checked yet.'
              : clip(t.state ?? 'Checked, nothing came back.', 80),
            // WHEN THE ANSWER MOVED, not when it was polled. A watch with no
            // change to report says so rather than borrowing the poll's time.
            trail: never ? 'never run' : t.changedAt ? age(t.changedAt, now) : 'steady',
            // Never-run is hot because it is broken; a change inside a day is
            // hot because it is news. Nothing else competes for the accent.
            hot: never || moved < 24 * 3600_000,
            // Oldest first, so the row reads left-to-right like everything else
            // on the card. A watch with no history yet gets no picture, which
            // is the correct picture of a watch with no history yet.
            spark: (t.history ?? []).slice(0, 10).reverse().map((h) => ({ changed: !!h.changed })),
          }
        })

      const fresh = active.filter((t) => changedAge(t) < 24 * 3600_000).length
      const never = active.filter((t) => !t.lastRunAt).length
      return {
        ...base,
        meta: active.length ? plural(active.length, 'watching', 'watching') : '',
        rows,
        // The alarm outranks the news, and both outrank silence — which gets no
        // sentence at all, because the rows already read as quiet.
        foot: never
          ? `${never === 1 ? 'One has' : `${never} have`} never returned anything.`
          : '',
        mini: {
          value: fresh ? String(fresh) : String(active.length),
          line: active.length
            ? clip(rows[0]?.title || active[0]!.what, 60)
            : 'Nothing is being watched.',
        },
      }
    }

    default:
      return null
  }
}

/**
 * THE ORDER OF THE DECK — his first, relevance second.
 *
 * Ranking chooses which widget he LANDS on; it never chooses which ones exist,
 * and it never overrides an order he has expressed. `systemOrder` is a fact
 * about him and outranks the score, which is the shelf rule applied to the deck:
 * an arrangement he made is not the assistant's to rearrange.
 *
 * Within what he has NOT ordered, hot before warm before quiet — so the domain
 * with something happening is the one in front when he opens the app.
 */
const HEAT_RANK: Record<string, number> = { hot: 0, warm: 1, quiet: 2, handled: 3 }

/**
 * "There is genuinely nothing to add under this widget."
 *
 * A sentinel rather than `null`, because `relevanceFor` overriding with nothing
 * has to be distinguishable from `relevanceFor` having no opinion — the first
 * means "hold your tongue on this widget", the second means "use the general
 * card". The client draws no card for it.
 */
export const SILENT: Relevance = {
  needId: '', eyebrow: '', head: '', sub: '', tone: 'neutral',
}

/** Every object a widget currently has on screen. See `relevanceFor`. */
const shown = (w: DeckWidget): Set<string> =>
  new Set([
    w.heroId,
    ...(w.rows ?? []).map((r) => r.id),
    ...(w.thumbs ?? []).map((t) => t.id),
    // The strip's blocks and band are objects the widget is DISPLAYING, so slot
    // two repeating one of them is the same restatement as repeating a row. The
    // rule is "everything the widget shows", and the strip is now most of what
    // Calendar shows — omitting it here would quietly reopen the hole that the
    // hero-only version of this set already cost two rounds to close.
    ...(w.strip?.blocks ?? []).map((b) => b.id),
    ...(w.strip?.allDay ?? []).map((a) => a.id),
    ...(w.map?.marks ?? []).map((m) => m.id),
  ].filter((x): x is string => !!x))

export function buildDeck(
  sources: Need[],
  attention: Need[],
  synthesis: Need[],
  /**
   * His arrangement, passed in rather than read here.
   *
   * `reproject` rebuilds the deck on the cached path and is synchronous by
   * design — it is what the first paint runs, before any network — so this
   * cannot be the thing that makes it await. See the instant-paint rule.
   */
  home: Pick<HomeState, 'systemOrder' | 'hiddenApps'>,
  now: Date,
  tz?: string,
  /**
   * SLOT THREE, ALREADY COMPILED.
   *
   * Optional, and its absence is the normal state: every host that has not
   * promoted the `intelligence` capability passes nothing, and the slot is empty.
   * Deliberately an INPUT rather than something read here — `intelligence.ts`
   * needs the memory store, and this function is the synchronous projection the
   * cold path runs before any of that is reachable.
   */
  opts?: { intelligence?: IntelligencePresentation | null },
): HomeDeck {
  const hidden = new Set(home.hiddenApps)

  const built = sources
    .map((n) => deckWidget(n, now, tz))
    .filter((w): w is DeckWidget => !!w)

  const off = built.filter((w) => hidden.has(w.id)).map((w) => w.id)
  const on = built.filter((w) => !hidden.has(w.id))

  const placed = home.systemOrder.filter((id) => on.some((w) => w.id === id))
  const widgets = [
    ...placed.map((id) => on.find((w) => w.id === id)!),
    ...on
      .filter((w) => !placed.includes(w.id))
      .sort((a, b) => (HEAT_RANK[a.hot ? 'hot' : 'quiet'] ?? 9) - (HEAT_RANK[b.hot ? 'hot' : 'quiet'] ?? 9)),
  ]

  /*
    SLOT TWO comes off the attention engine, and only off the attention engine.

    Not off the deck: a card that summarised the widget above it would be the
    screen saying the same thing twice, which is the caption habit this design
    removed everywhere else. `attention` is already ranked and already banded, so
    the first one that is not a source row IS "the thing most worth saying".
  */
  const candidates = [...attention, ...synthesis].filter((n) => !n.id.startsWith('src-'))
  const relevance = candidates.length ? relevanceFrom(candidates[0]!) : null

  /*
    The per-widget override. A card is filed against a domain by its OWN basis
    records — the sources it was computed from — rather than by matching words in
    its title, which is the kind of re-derivation `canonical` exists to forbid.
  */
  const relevanceFor: Record<string, Relevance> = {}
  for (const w of widgets) {
    const src = w.needId.replace(/^src-/, '')
    const on = shown(w)

    /*
      A CARD THAT DOES NOT NAME ITS OBJECT CANNOT BE OFFERED HERE.

      `focus` is "the id of the ONE object this card's line is about", and
      without it there is no way to establish that the card is not simply
      restating a row of the widget above — which is what happened: a card with
      no focus, about the calendar, sat under a Calendar widget that was already
      listing the very event it discussed.

      The alternative would be comparing their titles, and that is the prose
      re-derivation this codebase has a standing rule against: it is the same
      mistake as reading a time out of a rendered sentence, and it fails in the
      same direction — confidently, and only on real data.

      So an unattributed card is not eligible for the per-domain override. It is
      still eligible as the GENERAL card, where there is no widget to collide
      with, and it is still eligible for slot three.
    */
    /*
      ATTRIBUTED BY `focus` OR BY `basis`, because a model-authored card uses the
      second and every check here was written against the first. See
      `objectIdsOf` — this is the line that let a synthesis card restate the
      Calendar hero directly underneath it.
    */
    const about = (n: Need): string[] =>
      [n.focus, ...objectIdsOf(n.basis)].filter((x): x is string => !!x)
    const free = (n: Need) => !about(n).some((id) => on.has(id))
    const hit = candidates.find(
      (n) => !!n.focus && free(n) && n.basis?.some((b) => b === `source:${src}` || b.startsWith(`${src}:`)),
    )
    if (hit && hit.id !== candidates[0]?.id) { relevanceFor[w.id] = relevanceFrom(hit); continue }

    /*
      AND SLOT TWO NEVER REPEATS ANYTHING THE WIDGET IS ALREADY SHOWING.

      Seen twice while building this. First: Calendar led with "Restaurant with
      Odelia" and the card underneath said "Restaurant with Odelia" again.
      Narrowing it to the hero fixed that capture and not the rule — the next
      one put "Cinzia's concert in Avano" in slot two while the widget listed
      "21:00 Cinzia's concert in Avano" two inches above it. The check is against
      EVERYTHING the widget draws, because that is what the rule was always
      about: the slot is for what the deck is not already saying.

      Detected by the object each is about, never by comparing their words: the
      card carries `focus`, the widget carries the ids of what it drew, and they
      are the same string when they are the same thing. When they collide, this
      widget gets the next candidate about something else — or none, and the slot
      is empty, which is the honest answer to "there is nothing to add".
    */
    const general = candidates[0]
    if (general && !free(general)) {
      const other = candidates.find((n) => n.id !== general.id && free(n) && (!!n.focus || !!n.basis?.length))
      relevanceFor[w.id] = other ? relevanceFrom(other) : SILENT
    }
  }

  /*
    SLOT THREE IS COMPILED COGNITION OR IT IS EMPTY.

    It is handed in rather than derived here, because deriving it needs the
    memory store and this function is the synchronous one the first paint runs.
    `feed.ts` reads the store; this places what it was given.

    AND IT NEVER RESTATES SLOT TWO — now by SUBJECT rather than by id.

    The id check was right about the failure and too narrow to catch it. Slot two
    is an attention card about an object; slot three is a conclusion about a
    pattern, and those two are different rows with different ids that can be
    about the same thing on the same morning. §19's invalid example is exactly
    that shape:

        RELEVANCE      Dentist at 11:00
        INTELLIGENCE   You have a dentist appointment at 11:00.

    So the comparison is `subjectRefs` against the object slot two is about, plus
    the id it came from. Ids and typed subjects, never words — comparing the two
    rendered sentences is the prose re-derivation this file refuses everywhere
    else, and it would pass the invalid example above because the wordings
    differ.

    Only the GENERAL card is excluded here, not every per-widget override. Which
    override is live depends on which widget is in front, which is device state
    this function does not have and must not guess at. The client makes the final
    check against whichever card is actually in slot two.
  */
  const intelligence = notAbout(opts?.intelligence ?? null, candidates[0] ?? null, relevance)

  return { widgets, relevance, relevanceFor, intelligence, off }
}

/**
 * SLOT THREE, UNLESS IT IS ABOUT THE SAME THING AS SLOT TWO.
 *
 * Returns null on a collision, which suppresses the intelligence item rather
 * than the relevance one. That direction is deliberate: slot two is the concrete
 * thing happening at a time and slot three is a conclusion about it, and if only
 * one of them can be on the screen the appointment beats the observation about
 * the appointment.
 */
function notAbout(
  m: IntelligencePresentation | null,
  general: Need | null,
  relevance: Relevance | null
): IntelligencePresentation | null {
  if (!m) return null
  if (relevance && m.id === relevance.needId) return null
  const subjects = new Set(m.subjectRefs.filter(Boolean))
  if (general?.focus && subjects.has(general.focus)) return null
  if (general?.basis?.some((b) => subjects.has(b))) return null
  return m
}

/**
 * An attention card, as the relevance slot draws it.
 *
 * The eyebrow is the card's OWN account of why it is on screen, and it is never
 * generated here: a slot that writes its own justification is a slot that can
 * justify anything.
 *
 * IT USED TO FALL BACK TO `because.sentence`, AND THAT WAS THE OTHER HALF OF THE
 * AUDIT'S FINDING #12.
 *
 * `needFrom` sets `detail` from the builder and `status` from `because.sentence`
 * — and for the travel-plan builder those are THE SAME STRING, because its
 * detail IS its justification. So on the one card type the app is most proud of,
 * the eyebrow was the first 47 characters of the sentence printed underneath it,
 * in small caps. Not a near-duplicate the eye forgives: a literal prefix.
 *
 * The fix is at the source rather than in a comparison. `heatLabel` is written
 * by `heatLabelFor` from typed inputs — the item's kind and how soon it is — so
 * it cannot be the same string as anything a builder wrote, and the justification
 * keeps the two places it was always supposed to live: `status`, and the report.
 */
function relevanceFrom(n: Need): Relevance {
  const tone: Relevance['tone'] =
    n.heat === 'hot' ? 'urgent'
    : n.heat === 'handled' ? 'resolved'
    : n.asks ? 'changed'
    : n.heat === 'warm' ? 'warning'
    : 'neutral'
  return {
    needId: n.id,
    eyebrow: clip(n.heatLabel ?? '', 48),
    head: clip(n.title, 90),
    /*
      60 WAS THE OLD LAYOUT'S BUDGET, NOT THE CARD'S.

      One line, sharing its row with the action pill, is about 60 characters. The
      pill is gone and the client now clamps to the contract's two lines for a
      secondary preview, so the generation budget was the thing still cutting the
      sentence short — a clamp applied twice at two different widths, where the
      tighter one wins and it was the one describing a layout that no longer
      exists. ~46 characters to the line at 12px across 340px.
    */
    sub: clip(n.sub, 92),
    tone,
  }
}
