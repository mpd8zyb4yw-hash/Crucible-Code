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
  /** Square image — an avatar, a thumbnail. */
  image?: string
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
export function sanitiseWidget(raw: unknown): Widget | null {
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
            image: safeImage(o.image),
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
export function sanitisePane(raw: unknown): WidgetPane | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const widget = sanitiseWidget(p.widget ?? p)
  if (!widget) return null
  return { title: str(p.title, 80), widget, actions: actions(p.actions) }
}
