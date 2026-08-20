/**
 * The widget vocabulary.
 *
 * Every card in the feed opened into the same thing: a header, a row of stats,
 * and a chat thread. Tapping Mail got you a conversation ABOUT your mail.
 * Tapping Calendar got you a conversation about your calendar. The app had
 * become a mail room — things arrive, get sorted, and you are sent somewhere
 * else to actually do anything with them.
 *
 * A card should open into the thing itself. Mail opens a list of messages you
 * can read and reply to. Calendar opens an agenda you can RSVP from. A map card
 * opens a map you can search and route on. And this has to hold for cards
 * nobody has written code for yet, because the feed is model-driven: a card can
 * be about anything the assistant noticed, and "anything" cannot be enumerated
 * in advance.
 *
 * So widgets are DECLARED, not drawn. This file defines a small vocabulary of
 * primitives with typed props, and two very different producers emit the same
 * vocabulary:
 *
 *   - `server/panes.ts` builds specs deterministically from observations the
 *     app already holds. These render with the brain switched off, out of
 *     budget, or offline — the standing state of his life is a FACT, and a
 *     calendar that only works when an LLM is reachable is worse than useless.
 *
 *   - the synthesis prompt emits specs for cards the model invents, choosing
 *     from these same primitives. That is what makes it universal: a novel card
 *     gets a real widget without the model being handed the ability to write
 *     arbitrary markup into the app, which is both a security boundary and the
 *     only way the result can be guaranteed to match the design.
 *
 * The client renders a spec it does not recognise as nothing at all, so an
 * older app and a newer brain degrade to the chat thread rather than crashing.
 */

import type { DomainContext } from './domain.js'
import { lookupMany } from './objects.js'
import { effectiveOrigin, provenanceLabel, type Origin } from './provenance.js'

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * An action a widget element can ask the app to perform.
 *
 * Deliberately a NAMED intent with parameters, never a URL or a fragment of
 * code. The client maps the name to a call it already knows how to make, so
 * the set of things a model-authored widget can do is bounded by what has been
 * implemented, not by what the model can compose. Anything that leaves the
 * device or cannot be undone is confirmed by the user in the UI first.
 */
export interface WidgetAction {
  /** e.g. 'mail.archive', 'calendar.rsvp', 'map.route', 'world.tell'. */
  kind: string
  /** What the button says. */
  label: string
  /** Opaque to the renderer; meaningful to the handler for `kind`. */
  params?: Record<string, string | number | boolean | null>
  /** Shown while it runs. */
  busy?: string
  /**
   * True when the effect is visible to someone else or cannot be taken back —
   * sending mail, replying, cancelling an event. The renderer must confirm
   * before performing one of these, every time.
   */
  irreversible?: boolean
  /** Pull this action out as the primary button. */
  primary?: boolean
  /**
   * THIS CHANGES HOW THE APP TREATS HIM FROM NOW ON, rather than acting on
   * something that is on the screen.
   *
   * Setting a goal, choosing a source, turning a domain off. The distinction
   * matters in exactly one place — a Home deck card, where `chipsOf` refuses to
   * draw one — and it is a flag on the action rather than a list of `kind`s
   * kept beside the renderer, because the renderer is the wrong place to know
   * what `activity.goal` means.
   *
   * WHY THE HOME CARD REFUSES IT. "Make 7,180 the goal" was a white pill and the
   * loudest element on the Activity widget, above a chart and a sentence it was
   * competing with, offering to configure how every future reading gets judged —
   * from a card whose job is to say how today went. The same action is on the
   * Activity surface WITH the line that explains it ("Your seven-day average"),
   * which is where a decision like that can actually be made. Nothing is
   * removed: the capability, the surface control and the assistant's ability to
   * run it are all untouched. See docs/ux-audit.md.
   */
  setting?: boolean
}

/** One entry in a list: a message, an event, a transaction, a video. */
export interface WidgetItem {
  id: string
  title: string
  /** One line under the title. */
  sub?: string
  /** Longer body, shown when the item is expanded. */
  body?: string
  /** Right-aligned: a time, an amount, a duration. */
  meta?: string
  /** ISO timestamp, for grouping and ordering. */
  at?: string
  /**
   * Square image — an avatar, a thumbnail.
   *
   * Set by the SERVER, never accepted from a model. See `ref` below.
   */
  image?: string
  /**
   * `source:kind:id` of the retrieved object this item stands for.
   *
   * This is how a model-authored card gets a real picture. It names an object
   * the server fetched; the server fills in the image from its own record. It
   * cannot supply a URL, so it cannot pair a title with the wrong picture —
   * which was not a hypothetical: the host allowlist passed any `ytimg.com`
   * URL, so an invented video id rendered a real thumbnail of a real video
   * that had nothing to do with the title above it.
   *
   * A ref that matches nothing yields no image. Blank is a correct answer;
   * a confident wrong one is not.
   */
  ref?: string
  /** Where this came from, ready to render. From `provenanceLabel`. */
  provenance?: string
  /** retrieved | historical | inferred | stale | unavailable. */
  origin?: Origin
  /** Small coloured tags. */
  tags?: string[]
  /** True renders it as unread: brighter, with a dot. */
  unread?: boolean
  accent?: string
  /** What can be done to THIS item. */
  actions?: WidgetAction[]
}

/** A point on a map. */
export interface WidgetPlace {
  id: string
  label: string
  lat: number
  lon: number
  sub?: string
  /** Marks the user's own position, drawn differently. */
  self?: boolean
}

/** One bar or point in a chart. */
export interface WidgetPoint {
  label: string
  value: number
  /** Optional second series, drawn behind — a target, last week, an average. */
  compare?: number
}

// ── Domain objects ───────────────────────────────────────────────────────────

/**
 * Typed objects, for the renderers that need more than a title and a subtitle.
 *
 * The generic primitives above flatten everything into `WidgetItem`, which is
 * the right trade for a card the model invented and the wrong one for a
 * calendar: a `WidgetItem` has no end time, so no renderer built on it can draw
 * a week grid, work out an overlap, or find a ninety-minute gap. The
 * information needed to DO those things was being thrown away one layer above
 * the place it was needed.
 *
 * These are deliberately not a new concept in the pane/revision layer. A
 * revision stores whatever presentation its plan produced and has never
 * inspected it; these ride in exactly the same field as `list` and `agenda` do.
 * What changes is only that a domain renderer receives the domain's own shape.
 *
 * They are also TRUSTED-PRODUCER ONLY (see `TRUSTED_KINDS`). A model cannot
 * emit one, because every field here is something the app either fetched or can
 * verify, and an invented event id that reaches an RSVP button is a different
 * class of mistake from an invented headline.
 */

/**
 * ONE EVENT IS TIMED OR IT IS ALL-DAY. NEVER BOTH.
 *
 * A card read "Time: 11:00 AM" and, four lines below it, "All-day event marker
 * set for 11 AM." Those are not two views of one fact, they are two mutually
 * exclusive kinds of event asserted about the same object, and once both are in
 * the payload every consumer picks whichever it happens to check first: the
 * agenda drew a timed row, the day grid drew an all-day banner, and the model
 * described a contradiction it had been handed.
 *
 * The distinction is structural, so it is settled at ingestion rather than
 * inferred later by each reader:
 *
 *   timed    `start`/`end` are instants. `allDay` is false.
 *   all-day  `start`/`end` are calendar dates with no clock. `allDay` is true.
 *
 * THE SHAPE OF `start` IS THE AUTHORITY, not the flag beside it. A flag is one
 * boolean that can be wrong; a date-only string cannot pretend to name an
 * instant. So a `YYYY-MM-DD` start makes the event all-day whatever the flag
 * said, and a flag claiming all-day over a real timestamp is a claim we drop
 * rather than a clock time we invent.
 */
export function normaliseEvent<T extends { start: string; end?: string; allDay?: boolean }>(e: T): T {
  const dateOnly = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())
  const allDay = dateOnly(e.start)

  const day = (s: string | undefined): string | undefined => {
    if (!s) return undefined
    if (dateOnly(s)) return s.trim()
    const t = Date.parse(s)
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : undefined
  }

  if (allDay) {
    // A clock time on an all-day event is the contradiction itself. Dropped,
    // not rounded to midnight — midnight is a time, and this event has none.
    return { ...e, allDay: true, start: e.start.trim(), end: day(e.end) }
  }

  // An end before its start is a payload we cannot render honestly; a missing
  // end is a fact the surface already knows how to draw.
  const s = Date.parse(e.start)
  const en = e.end ? Date.parse(e.end) : NaN
  const end = Number.isFinite(en) && Number.isFinite(s) && en >= s ? e.end : undefined
  return { ...e, allDay: false, end }
}

export interface CalEvent {
  id: string
  title: string
  /** ISO datetime, or a plain YYYY-MM-DD for all-day events. */
  start: string
  end?: string
  /**
   * WHAT CRUCIBLE WORKED OUT ABOUT THIS ONE OBJECT, WITH ITS PROVENANCE.
   *
   * Mirrors `src/api.ts`. Typed, optional, computed on the server or absent, and
   * NEVER rendered without `grounds` — a claim on an opened object that cannot
   * say where it came from is the confident wrong answer this app keeps being
   * asked not to give.
   *
   * Populated by `enrichPanes` from a `depth`-weight `DomainContext`. The slot
   * predates that and was designed for a routed leave-by; both are the same kind
   * of thing, which is why there is one slot rather than two.
   */
  note?: { says: string; grounds: string }
  allDay?: boolean
  location?: string
  description?: string
  attendees?: { email: string; name?: string; response?: string }[]
  /** Our own response: accepted | declined | tentative | needsAction. */
  response?: string
  organizer?: string
  calendarId?: string
  accent?: string
  actions?: WidgetAction[]
}

/**
 * WHAT GMAIL'S `snippet` ACTUALLY CONTAINS.
 *
 * Two kinds of rubbish, both of which reached his screen verbatim and neither of
 * which is a rendering decision — this is dirty data, so it is cleaned once here
 * rather than in the widget, the list row, the reader and the prompt:
 *
 *   · HTML ENTITIES. Gmail returns the snippet escaped, so "Here's" arrives as
 *     `Here&#39;s`. React then escapes it again on the way out, which is correct
 *     behaviour producing a literally wrong string. Four of his four mail rows
 *     read `Here&#39;s` and `didn&#39;t`.
 *   · PREHEADER PADDING. Marketing senders pad the preview text with runs of
 *     U+034F (combining grapheme joiner) and zero-width spaces so the client
 *     shows nothing after their opening line. Gmail's snippet keeps them, so his
 *     Mail widget drew one sentence followed by ninety invisible characters, and
 *     every row's preview was a sentence and then a long grey nothing.
 *
 * Entities first, then the invisibles — decoding can produce them.
 */
export function cleanSnippet(raw: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  }
  return raw
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m)
    // Zero-width and invisible formatting characters, plus the joiner senders
    // use as padding. Not a blocklist of one vendor: it is the whole class.
    .replace(/[\u034F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * WHAT A VIDEO IS ABOUT, WITHOUT THE MERCHANDISE.
 *
 * A YouTube description is not a synopsis. It is a synopsis followed by a
 * Patreon link, a coffee promo code, a chapter index, an explicit-content
 * disclaimer and a wall of hashtags — and all of it was rendered verbatim into
 * a 150px box with its own scrollbar, which is several hundred words of somebody
 * else's advertising inside his assistant.
 *
 * The leading paragraphs ARE worth keeping: they say what the thing is, which is
 * the one question the surface is answering. So this keeps prose until it hits
 * the first thing that is plainly not prose, and stops there.
 *
 * Returns an empty string when there is nothing left, and an empty string draws
 * nothing — a description that was ONLY promotion had no synopsis to lose.
 */
export function synopsis(raw: string | undefined): string {
  if (!raw) return ''
  const promo =
    /^\s*(https?:\/\/|#\w|\*\s*\*|[\d:]+\s+\S|(patreon|membership|merch|promo code|subscribe|follow|credit for|author:|music|sound effects?|disclaimer|explicit content|use code|discount|sponsor|if you would like|submit (a |your )?stor|check out|thanks for watching|click here)\b)/i
  const out: string[] = []
  for (const para of raw.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue
    if (promo.test(p)) break
    // A paragraph that is mostly link is a link with a sentence attached.
    if ((p.match(/https?:\/\//g) ?? []).length > 1) break
    out.push(p.replace(/\s*https?:\/\/\S+/g, '').replace(/[ \t]+/g, ' ').trim())
    if (out.join(' ').length > 400) break
  }
  // A sentence whose object was a URL is left dangling by the strip above —
  // "please submit your story here -" is not prose, it is the wreck of a link.
  const text = out.join(' ').replace(/[\s\u2013\u2014:;,-]+$/, '').trim()
  return text.length > 420 ? `${text.slice(0, 419).replace(/\s\S*$/, '')}…` : text
}

export interface MailMessage {
  id: string
  threadId?: string
  subject: string
  from: string
  fromName?: string
  /**
   * WHAT CRUCIBLE WORKED OUT ABOUT THIS ONE OBJECT, WITH ITS PROVENANCE.
   *
   * Mirrors `src/api.ts`. Typed, optional, computed on the server or absent, and
   * NEVER rendered without `grounds` — a claim on an opened object that cannot
   * say where it came from is the confident wrong answer this app keeps being
   * asked not to give.
   *
   * Populated by `enrichPanes` from a `depth`-weight `DomainContext`. The slot
   * predates that and was designed for a routed leave-by; both are the same kind
   * of thing, which is why there is one slot rather than two.
   */
  note?: { says: string; grounds: string }
  to?: string
  snippet?: string
  body?: string
  /** ISO timestamp it arrived. */
  at: string
  unread?: boolean
  labels?: string[]
  actions?: WidgetAction[]
}

export interface VideoObject {
  id: string
  title: string
  channel?: string
  thumbnail?: string
  publishedAt?: string
  /** Runtime in seconds. The whole point of "only ones over 30 minutes". */
  seconds?: number
  description?: string
  /**
   * Canonical watch URL, built from a verified provider id — see
   * `youtube.ts#presentable`. Absent means the video could not be identified,
   * and no renderer may offer a way to open it. Mirrored in `src/api.ts`.
   */
  url?: string
  provenance?: string
  origin?: Origin
  actions?: WidgetAction[]
}

/** One named line of daily numbers: steps, sleep, resting heart rate. */
export interface FitnessSeries {
  key: string
  label: string
  unit?: string
  accent?: string
  /**
   * Oldest first, and EVERY day in the window — including the ones with nothing.
   *
   * `value: null` is a day the source did not report. It used to be expressed by
   * the day simply being absent from the array, which meant the renderer could
   * not tell "no reading" from "a zero it happened not to send", and drew both
   * as a stub three pixels high. On a week where the feed had stopped, that is
   * the difference between "you barely moved" and "this has not synced since
   * Friday" — opposite facts, identical pictures. See §35.
   */
  days: { date: string; value: number | null }[]
  /**
   * Which source these readings came from, and when it last delivered.
   *
   * Carried on the series rather than looked up beside it so that a chart can
   * never be drawn from one source while its caption names another — the
   * lineage §10 asks for, attached to the thing it describes.
   */
  source?: { id: string; lastReportedDay: string | null }
}

/**
 * THE ACTIVITY SURFACE'S HEADER, AS DATA RATHER THAN AS A CHART.
 *
 * A flattened view of `ActivityReport` — flattened deliberately, because this
 * crosses to the client and the client must not be able to recompute any of it.
 * Every figure here is decided on the server, where the goal, the source
 * preference and the conflict state all live; the surface's job is to draw what it
 * is given and to say when it has been given nothing.
 *
 * `current: null` is the field that matters most. It means there IS no trustworthy
 * figure — two sources disagree and he has not ruled — and the surface renders
 * `why` in its place rather than a number. That is the whole difference between an
 * app that has a conflict type and an app that shows whichever number synced last.
 */
export interface ActivityBrief {
  metric: string
  unit?: string
  /** One honest sentence. The Home row and the surface header share it. */
  says: string
  /**
   * The trusted latest figure, or null with `why` explaining the absence.
   *
   * `isToday` is not decoration. Without it the surface printed Friday's count
   * on a Tuesday in the place a reader takes for "today", which is a true number
   * that reads as a false one. See `freshness`.
   */
  current: { day: string; value: number; isToday: boolean } | null
  /**
   * HOW OLD THE NUMBER IS, AS ITS OWN FACT.
   *
   * Sent so the surface can make staleness impossible to miss rather than
   * leaving it to a sentence further down the screen. `level` is the loudness:
   * a phone that has not synced since this morning is ordinary, and one that has
   * not synced since Friday means the chart is history.
   */
  freshness: { today: string; haveToday: boolean; todayValue: number | null; staleDays: number; level: 'current' | 'lagging' | 'stale' }
  source: { id: string | null; by: 'chosen' | 'only' | 'disputed' | 'none'; canSupportGoal: boolean; why?: string; available: string[] }
  trend: {
    average: number | null
    priorAverage: number | null
    changePercent: number | null
    direction: 'up' | 'down' | 'flat' | 'unknown'
    covered: number
    windowDays: number
  }
  goal:
    | {
        id: string
        description: string
        target: number
        unit?: string
        direction: 'up' | 'down' | 'steady'
        current: number
        /** 0..1, or null for a 'steady' goal — a bar would imply a finish line. */
        fraction: number | null
        met: boolean
        shortfall: number
        timeframe?: string
      }
    | null
  gap: { missingDays: string[]; staleDays: number; lastDay: string | null; lastDayLabel: string }
  conflicts: { metric: string; scope: string; readings: { source: string; value: number }[]; differencePercent: number }[]
  /** The one thing worth doing, and what tapping it actually does. */
  next: { label: string; detail: string; does: string; options?: string[] }
}

/** A standing interest, as the dashboard shows it. */
export interface WatchObject {
  id: string
  what: string
  why?: string
  question?: string | null
  everyHours: number
  lastRunAt: string | null
  /** When the next check is due, computed from the interval. */
  nextRunAt?: string | null
  active: boolean
  by: 'user' | 'agent'
  /** The last thing it found, in its own words. */
  state?: string
  /** When that answer last CHANGED, as opposed to when it was last checked. */
  changedAt?: string | null
  history?: { at: string; text: string; changed?: boolean }[]
  actions?: WidgetAction[]
}

// ── The spec ─────────────────────────────────────────────────────────────────

export type Widget =
  /**
   * A scrollable list of things. The workhorse: mail, transactions, tracks,
   * search results, anything enumerable.
   */
  | {
      kind: 'list'
      items: WidgetItem[]
      /** Chips that narrow the list, applied client-side on `tags`. */
      filters?: string[]
      /** Message when `items` is empty — never leave a blank rectangle. */
      empty?: string
      /** Let an item expand in place to show `body`. */
      expandable?: boolean
    }
  /**
   * Time-ordered items grouped by day. A calendar is not a list: what matters
   * is which day a thing falls on and what else is on that day.
   */
  | {
      kind: 'agenda'
      items: WidgetItem[]
      /** ISO date the agenda opens on. Defaults to today. */
      focus?: string
      /** How many days it spans from `focus`. */
      days?: number
      empty?: string
    }
  /** Bars over labels. Steps, spend, hours — anything counted per period. */
  | {
      kind: 'chart'
      points: WidgetPoint[]
      unit?: string
      /** Drawn as a dashed line across the bars. */
      target?: number
      /** What the second series is called, when `compare` is used. */
      compareLabel?: string
      accent?: string
    }
  /**
   * Images with captions. YouTube, photos, anything where the picture is the
   * point and a text list would be strictly worse.
   */
  | {
      kind: 'media'
      items: WidgetItem[]
      /** 1 renders full-width cards; 2 a grid. */
      columns?: 1 | 2
      empty?: string
    }
  /**
   * A map with places on it, optionally a route between them.
   *
   * Tiles and routing are keyless (OpenStreetMap, OSRM) so this costs nothing
   * and needs no billing account. `follow` asks the client for the device's
   * own position, which is the phone's, since that is the device he carries.
   */
  | {
      kind: 'map'
      places: WidgetPlace[]
      /** Draw a route through `places` in order, by this means of travel. */
      route?: 'walk' | 'drive' | 'cycle'
      /** Track and show the device's live position. */
      follow?: boolean
      /** Let the user search for a place and add it. */
      searchable?: boolean
      zoom?: number
      /**
       * WHAT THE MEMORY CORE ADDS, AND NOTHING THE DOMAIN COULD HAVE WORKED OUT.
       *
       * See the identical field on `calendar`. Keyed by pin id, so a rhythm is
       * attached to the place it is about and travels with it into both the Home
       * row and the map.
       */
      context?: DomainContext[]
    }
  /** Labelled facts in two columns. An event's details, an order, a summary. */
  | {
      kind: 'detail'
      rows: { label: string; value: string; accent?: string }[]
      body?: string
    }
  /**
   * A composer. The one primitive that produces text rather than showing it —
   * a reply, a note, an event title.
   */
  | {
      kind: 'compose'
      placeholder?: string
      /** Pre-filled, e.g. a quoted reply. */
      value?: string
      /** Shown above the box: who this goes to. */
      to?: string
      submit: WidgetAction
      multiline?: boolean
    }
  // ── Domain surfaces ────────────────────────────────────────────────────────
  // Trusted producers only. Each one has a renderer that is a real application
  // for that domain, and each one declares typed capabilities that the person
  // and the model drive through the same reducer.
  /** An actual calendar: month, week and day views over real events. */
  | {
      kind: 'calendar'
      events: CalEvent[]
  /**
   * WHAT THE MEMORY CORE ADDS, AND NOTHING THE DOMAIN COULD HAVE WORKED OUT.
   *
   * Phase 8. Compiled by `server/domain.ts` from typed cognition and attached
   * HERE — on the widget — rather than beside it, because the widget is the one
   * object both projections read: `deck.ts` builds the Home card from it and the
   * surface renders it. A context attached anywhere else could be present on the
   * card and absent in depth, which is the disagreement `canonical` exists to
   * make impossible.
   *
   * Absent is the normal state. Every consumer draws the domain unchanged when
   * there is nothing here.
   */
  context?: DomainContext[]
      /** ISO date it opens on. Defaults to today. */
      focus?: string
      view?: 'month' | 'week' | 'day'
      empty?: string
    }
  /** A mailbox: threads, unread state, senders, bodies, a composer. */
  | {
      kind: 'mail'
      messages: MailMessage[]
  /**
   * WHAT THE MEMORY CORE ADDS, AND NOTHING THE DOMAIN COULD HAVE WORKED OUT.
   *
   * Phase 8. Compiled by `server/domain.ts` from typed cognition and attached
   * HERE — on the widget — rather than beside it, because the widget is the one
   * object both projections read: `deck.ts` builds the Home card from it and the
   * surface renders it. A context attached anywhere else could be present on the
   * card and absent in depth, which is the disagreement `canonical` exists to
   * make impossible.
   *
   * Absent is the normal state. Every consumer draws the domain unchanged when
   * there is nothing here.
   */
  context?: DomainContext[]
      empty?: string
    }
  /** Results with authoritative thumbnails, channels and durations. */
  | {
      kind: 'video'
      videos: VideoObject[]
      empty?: string
    }
  /** Interactive daily series with a range and toggleable lines. */
  | {
      kind: 'fitness'
      series: FitnessSeries[]
      /**
       * What the numbers MEAN, computed by `activity.ts`.
       *
       * Optional because a fitness widget can legitimately be a bare series — a
       * model-authored chart of something, a metric with no goal attached — and
       * the surface renders the chart either way. When present, the surface leads
       * with it, because seven bars and an average was a picture of data with no
       * statement about whether any of it was going the way he wanted.
       */
      report?: ActivityBrief
  /**
   * WHAT THE MEMORY CORE ADDS, AND NOTHING THE DOMAIN COULD HAVE WORKED OUT.
   *
   * Phase 8. Compiled by `server/domain.ts` from typed cognition and attached
   * HERE — on the widget — rather than beside it, because the widget is the one
   * object both projections read: `deck.ts` builds the Home card from it and the
   * surface renders it. A context attached anywhere else could be present on the
   * card and absent in depth, which is the disagreement `canonical` exists to
   * make impossible.
   *
   * Absent is the normal state. Every consumer draws the domain unchanged when
   * there is nothing here.
   */
  context?: DomainContext[]
      empty?: string
    }
  /** The operational dashboard for standing interests. */
  | {
      kind: 'watch'
      watches: WatchObject[]
      empty?: string
    }

/** A widget plus how it is introduced. Cards carry zero or more of these. */
export interface WidgetPane {
  /** Small heading above it. Omitted for a single unlabelled widget. */
  title?: string
  widget: Widget
  /** Actions for the pane as a whole, below it. */
  actions?: WidgetAction[]
}

// ── Guarding what the model produces ─────────────────────────────────────────

/**
 * The set of primitives a model-authored spec may use.
 *
 * Kept as data rather than a type check because it is also the list that goes
 * INTO the synthesis prompt — the model is told exactly what it may emit, and
 * then held to it here. A spec naming anything else is dropped rather than
 * repaired, because a half-understood widget is worse than the chat thread it
 * would replace.
 */
export const WIDGET_KINDS = ['list', 'agenda', 'chart', 'media', 'map', 'detail', 'compose'] as const

/**
 * The domain surfaces, which a model may NOT emit.
 *
 * Not an oversight and not a permissions afterthought: these carry ids that
 * actions are taken against — an event that gets an RSVP, a message that gets
 * archived — and every one of them here came out of a record the app fetched.
 * `sanitiseWidget` rejects any kind outside `WIDGET_KINDS` already, so this
 * list is what the exclusion MEANS rather than a second check. Producers build
 * these as typed literals and never through the sanitiser.
 *
 * The model operates these surfaces through commands instead (see
 * `src/surface/`), which name objects that are already on screen. It can say
 * "select the third video"; it cannot invent a fourth.
 */
export const TRUSTED_KINDS = ['calendar', 'mail', 'video', 'fitness', 'watch'] as const

/**
 * Actions a model-authored widget is allowed to request.
 *
 * Everything a MODEL can put in front of him is read-only or additive. Nothing
 * that sends, deletes, or cancels appears here: those exist, but only on panes
 * the server itself built from a known source, where the parameters came from
 * real data rather than from generated text. A model that hallucinates a
 * message id should be unable to express "archive it" at all — the safest way
 * to handle a dangerous instruction from generated content is for the grammar
 * to have no word for it.
 */
const MODEL_SAFE_ACTIONS = new Set([
  'world.tell',
  'track.add',
  'card.act',
  'map.route',
  'map.search',
  'mail.open',
  'calendar.open',
  'media.open',
])

const str = (v: unknown, max = 400): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined

const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Take whatever the model emitted and return something safe to render, or null.
 *
 * Model output is untrusted input. It arrives as JSON that claims to be a
 * widget and may be anything at all: a kind that does not exist, an image
 * pointing at an arbitrary host, an action asking to delete his mail. Every
 * field is therefore rebuilt here from scratch rather than passed through, so
 * an unexpected key cannot survive into the renderer.
 */
export interface SanitiseOptions {
  /**
   * The producer built this from data it fetched, so its image URLs are its
   * own. True only for `panes.ts`. Model output must never set it.
   */
  trusted?: boolean
}

export function sanitiseWidget(raw: unknown, opts: SanitiseOptions = {}): Widget | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Record<string, unknown>
  const kind = str(w.kind, 20)
  if (!kind || !(WIDGET_KINDS as readonly string[]).includes(kind)) return null

  const items = (v: unknown): WidgetItem[] =>
    Array.isArray(v)
      ? v.slice(0, 60).flatMap((x, i) => {
          const o = (x ?? {}) as Record<string, unknown>
          const title = str(o.title, 200)
          if (!title) return []
          return [{
            id: str(o.id, 80) ?? `i${i}`,
            title,
            sub: str(o.sub, 300),
            body: str(o.body, 4000),
            meta: str(o.meta, 60),
            at: str(o.at, 40),
            /**
             * A URL survives only from a trusted producer — `panes.ts`, which
             * built it out of a record it fetched itself. From a model, the
             * field is dropped whatever it contains and only `ref` can put a
             * picture on screen.
             */
            image: opts.trusted ? safeImage(o.image) : undefined,
            ref: str(o.ref, 120),
            tags: Array.isArray(o.tags) ? o.tags.flatMap((t) => str(t, 40) ?? []).slice(0, 6) : undefined,
            unread: o.unread === true,
            accent: str(o.accent, 20),
            actions: actions(o.actions),
          }]
        })
      : []

  switch (kind) {
    case 'list':
      return {
        kind: 'list',
        items: items(w.items),
        filters: Array.isArray(w.filters) ? w.filters.flatMap((f) => str(f, 40) ?? []).slice(0, 8) : undefined,
        empty: str(w.empty, 200),
        expandable: w.expandable !== false,
      }
    case 'agenda':
      return {
        kind: 'agenda',
        items: items(w.items),
        focus: str(w.focus, 40),
        days: Math.max(1, Math.min(31, numOr(w.days, 7))),
        empty: str(w.empty, 200),
      }
    case 'media':
      return {
        kind: 'media',
        items: items(w.items),
        columns: w.columns === 1 ? 1 : 2,
        empty: str(w.empty, 200),
      }
    case 'chart': {
      const points = Array.isArray(w.points)
        ? w.points.slice(0, 60).flatMap((p) => {
            const o = (p ?? {}) as Record<string, unknown>
            const label = str(o.label, 40)
            if (label === undefined || typeof o.value !== 'number' || !Number.isFinite(o.value)) return []
            return [{ label, value: o.value, compare: typeof o.compare === 'number' ? o.compare : undefined }]
          })
        : []
      if (!points.length) return null
      return {
        kind: 'chart',
        points,
        unit: str(w.unit, 20),
        target: typeof w.target === 'number' ? w.target : undefined,
        compareLabel: str(w.compareLabel, 40),
        accent: str(w.accent, 20),
      }
    }
    case 'map': {
      const places = Array.isArray(w.places)
        ? w.places.slice(0, 40).flatMap((p, i) => {
            const o = (p ?? {}) as Record<string, unknown>
            const label = str(o.label, 120)
            const lat = typeof o.lat === 'number' ? o.lat : NaN
            const lon = typeof o.lon === 'number' ? o.lon : NaN
            // A place off the globe is a hallucinated coordinate, not a place.
            if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return []
            if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return []
            return [{ id: str(o.id, 60) ?? `p${i}`, label, lat, lon, sub: str(o.sub, 200), self: o.self === true }]
          })
        : []
      const route = w.route
      return {
        kind: 'map',
        places,
        route: route === 'walk' || route === 'drive' || route === 'cycle' ? route : undefined,
        follow: w.follow === true,
        searchable: w.searchable === true,
        zoom: Math.max(1, Math.min(19, numOr(w.zoom, 13))),
      }
    }
    case 'detail': {
      const rows = Array.isArray(w.rows)
        ? w.rows.slice(0, 30).flatMap((r) => {
            const o = (r ?? {}) as Record<string, unknown>
            const label = str(o.label, 80)
            const value = str(o.value, 500)
            return label && value ? [{ label, value, accent: str(o.accent, 20) }] : []
          })
        : []
      if (!rows.length) return null
      return { kind: 'detail', rows, body: str(w.body, 4000) }
    }
    case 'compose': {
      const submit = actions([(w as Record<string, unknown>).submit])?.[0]
      if (!submit) return null
      return {
        kind: 'compose',
        placeholder: str(w.placeholder, 120),
        value: str(w.value, 4000),
        to: str(w.to, 200),
        submit,
        multiline: w.multiline !== false,
      }
    }
  }
  return null
}

/**
 * Images may only come from hosts we already deal with.
 *
 * An `<img>` pointing anywhere is a beacon: it reports his IP, his rough
 * location and the moment he opened a card to whoever controls that host. Mail
 * senders do this deliberately, and a model can be talked into emitting one by
 * the very content it is summarising. `data:` is refused too — it is a way to
 * smuggle arbitrary bytes past a host check.
 */
const IMAGE_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(ytimg\.com|ggpht\.com|googleusercontent\.com|gstatic\.com|tile\.openstreetmap\.org)\//i

function safeImage(v: unknown): string | undefined {
  const s = str(v, 500)
  return s && IMAGE_HOSTS.test(s) ? s : undefined
}

function actions(v: unknown): WidgetAction[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>
    const kind = str(o.kind, 40)
    const label = str(o.label, 60)
    if (!kind || !label || !MODEL_SAFE_ACTIONS.has(kind)) return []
    const params: Record<string, string | number | boolean | null> = {}
    if (o.params && typeof o.params === 'object') {
      for (const [k, val] of Object.entries(o.params as Record<string, unknown>)) {
        if (Object.keys(params).length >= 12) break
        if (val === null || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          params[k.slice(0, 40)] = typeof val === 'string' ? val.slice(0, 500) : val
        }
      }
    }
    return [{
      kind,
      label,
      params,
      busy: str(o.busy, 60),
      // A model may never mark its own action safe, and none of the actions it
      // is allowed to name are irreversible in the first place.
      irreversible: false,
      primary: o.primary === true,
    }]
  })
  return out.length ? out.slice(0, 6) : undefined
}

/** Sanitise a whole pane the model produced. */
export function sanitisePane(raw: unknown, opts: SanitiseOptions = {}): WidgetPane | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const widget = sanitiseWidget(p.widget ?? p, opts)
  if (!widget) return null
  return { title: str(p.title, 80), widget, actions: actions(p.actions) }
}

// ── Citation ─────────────────────────────────────────────────────────────────

/** Every item in a widget, whatever shape the widget is. */
function widgetItems(w: Widget): WidgetItem[] {
  return 'items' in w && Array.isArray(w.items) ? (w.items as WidgetItem[]) : []
}

/**
 * Fill in what a model may only cite.
 *
 * Runs after sanitising, against the store of things connectors actually
 * fetched. For each item naming a `ref`, the image, the missing subtitle and
 * the provenance label are taken from that record — so what is on screen is
 * what was retrieved, and an item whose ref resolves to nothing is left plain
 * rather than decorated with a guess.
 *
 * It is one store read per pane regardless of item count, and it is the same
 * call for every connector: nothing here knows what a video is.
 */
export async function resolveRefs(panes: WidgetPane[]): Promise<WidgetPane[]> {
  const refs = panes.flatMap((p) => widgetItems(p.widget).flatMap((i) => (i.ref ? [i.ref] : [])))
  if (!refs.length) return panes

  const found = await lookupMany(refs)
  const now = Date.now()

  for (const pane of panes) {
    for (const item of widgetItems(pane.widget)) {
      if (!item.ref) continue
      const obj = found.get(item.ref)
      if (!obj) {
        /**
         * A ref resolving to nothing means one of two very different things.
         *
         * If the item already has an image, a TRUSTED producer built it from a
         * record it fetched itself and simply predates the object cache — it is
         * as real as anything here and must not be labelled otherwise. If it
         * has no image, the ref is the only claim being made and nothing backs
         * it, which is worth saying out loud.
         */
        if (!item.image) {
          item.origin = 'unavailable'
          item.provenance = 'not in anything I retrieved'
        }
        continue
      }
      item.image = obj.image
      item.sub ??= obj.sub
      item.at ??= obj.at
      item.origin = effectiveOrigin(obj.prov, now)
      item.provenance = provenanceLabel(obj.prov, now)
    }
  }
  return panes
}
