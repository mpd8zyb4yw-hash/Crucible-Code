export interface ProviderInfo {
  id: string
  label: string
  hint: string
  free: boolean
  models: string[]
  model: string
  configured: boolean
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
  active: string | null
  /** Who chooses the model: Crucible per task, or the one he pinned. */
  routing: 'auto' | 'pinned'
}

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body as any)?.error ?? `HTTP ${res.status}`)
  return body as T
}

export const listProviders = () => fetch('/api/providers').then(j<ProvidersResponse>)

export const saveKey = (id: string, key: string) =>
  fetch(`/api/providers/${id}/key`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  }).then(j<{ ok: true; active: string }>)

export const removeKey = (id: string) =>
  fetch(`/api/providers/${id}/key`, { method: 'DELETE' }).then(j<{ ok: true; active: string | null }>)

export const setRouting = (routing: 'auto' | 'pinned') =>
  fetch('/api/routing', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routing }),
  }).then(j<{ ok: true; routing: 'auto' | 'pinned' }>)

export interface Rested {
  model: string
  why: string
  backInMs: number
}

export interface ProviderHealth {
  providerId: string
  callsToday: number
  tokensIn: number
  tokensOut: number
  restingModels: string[]
  rested: Rested[]
}

/** What the router currently knows: who is answering, who is resting and why. */
export const getHealth = () =>
  fetch('/api/health').then(j<{ providers: ProviderHealth[]; synthesis: unknown[] }>)

export const setActive = (providerId: string, model?: string) =>
  fetch('/api/active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId, model }),
  }).then(j<{ ok: true; active: string; model: string }>)


/**
 * The widget vocabulary, mirrored from server/widgets.ts.
 *
 * Duplicated rather than imported because the client bundle must not pull in
 * anything from server/ — that tree imports node and Worker globals. The server
 * file is the authority; this is a structural copy of its public shape.
 */
export interface WidgetAction {
  kind: string
  label: string
  params?: Record<string, string | number | boolean | null>
  busy?: string
  irreversible?: boolean
  primary?: boolean
  /** Changes how the app treats him from now on. Never drawn on a Home card. */
  setting?: boolean
}

export interface WidgetItem {
  id: string
  title: string
  sub?: string
  body?: string
  meta?: string
  at?: string
  image?: string
  /** Object this item stands for; the server resolved the image from it. */
  ref?: string
  /** "youtube · subscriptions · 4 min ago". Rendered under the item. */
  provenance?: string
  /**
   * What kind of knowing this is, which decides how it is drawn.
   *
   * The last three only ever appear on data that was composed: `enriched` is
   * two sources describing one thing, `transformed` is the model having read
   * something out of it, `ranked` is an order that is an opinion over items
   * that are not. Mirrored from server/provenance.ts.
   */
  origin?: 'retrieved' | 'historical' | 'inferred' | 'stale' | 'unavailable' | 'transformed' | 'enriched' | 'ranked'
  tags?: string[]
  unread?: boolean
  accent?: string
  actions?: WidgetAction[]
}

export interface WidgetPlace {
  id: string
  label: string
  lat: number
  lon: number
  sub?: string
  self?: boolean
}

export interface WidgetPoint {
  label: string
  value: number
  compare?: number
}

/**
 * The typed domain objects. Mirrored from server/widgets.ts, same as the rest.
 *
 * These carry what a real application surface needs and a `WidgetItem` cannot
 * hold — an end time, a duration in seconds, an attendee list, a check
 * interval. A generic item is the right shape for a card the model invented and
 * the wrong one for a calendar you can find a gap in.
 */
/**
 * WHAT THE MEMORY CORE ADDS TO A DOMAIN — the client's view of it.
 *
 * Mirrors `server/domain.ts`, which is where it is compiled and where the rules
 * about it are written down. Repeated here rather than imported for the reason
 * every other type in this file is: the client and the server are separately
 * built, and a shared file would make the browser bundle depend on the server
 * tree.
 *
 * WHAT A RENDERER MAY DO WITH ONE: draw `line`, on the object named by
 * `subject`, when `weight` allows it there. That is all. `certainty` and
 * `provenanceRefs` are carried for ranking and traceability and are NOT
 * renderable — a client that printed either would be putting the machinery back
 * on the screen, which §13 and the frozen "life state, not engine state" rule
 * both forbid.
 */
export interface DomainContext {
  domain: 'calendar' | 'activity' | 'places' | 'mail'
  subject: string
  subjectRefs: string[]
  line: string
  weight: 'card' | 'depth'
  grounds?: string
  certainty: 'known' | 'strong' | 'likely' | 'possible' | 'unclear'
  provenanceRefs: string[]
}

export interface CalEvent {
  id: string
  title: string
  start: string
  end?: string
  /**
   * WHAT CRUCIBLE WORKED OUT ABOUT THIS EVENT, WITH ITS PROVENANCE.
   *
   * "57 km from home, and the 11:05 is the only bus that arrives before you are
   * due" — the line the Phase 1 design puts under an opened event, and the thing
   * that makes a calendar an assistant rather than a grid.
   *
   * TYPED, OPTIONAL, AND COMPUTED ON THE SERVER OR ABSENT. It is never written
   * in the client and never inferred from the fields around it: a departure time
   * has prerequisites the surface cannot see (§7), and a plausible one is worse
   * than none because it cannot be argued with. `grounds` is what it was derived
   * FROM, and a note without grounds does not render.
   *
   * Nothing populates it yet — leave-by is a routing call and does not belong in
   * a pane build. This is the slot it lands in, and the detail sheet is already
   * written to draw it the moment it is there.
   */
  note?: { says: string; grounds: string }
  allDay?: boolean
  location?: string
  description?: string
  attendees?: { email: string; name?: string; response?: string }[]
  response?: string
  organizer?: string
  calendarId?: string
  accent?: string
  actions?: WidgetAction[]
}

export interface MailMessage {
  id: string
  threadId?: string
  subject: string
  from: string
  fromName?: string
  /**
   * WHAT CRUCIBLE WORKED OUT ABOUT THIS MESSAGE, WITH ITS PROVENANCE.
   *
   * The same slot `CalEvent` carries, and deliberately the same shape rather
   * than a second one: "who this is and what is arranged with them" and "when
   * you usually leave for this" are the same kind of claim about a single opened
   * object, and giving each domain its own would be four parallel mini
   * intelligence systems, which is the thing Phase 8 is explicitly not.
   *
   * Server-computed or absent, and never rendered without `grounds`.
   */
  note?: { says: string; grounds: string }
  to?: string
  snippet?: string
  body?: string
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
  seconds?: number
  description?: string
  /**
   * The canonical watch URL, built server-side from a VERIFIED provider id.
   *
   * Absent means the app cannot identify this video, and the renderer must not
   * offer a way to open it. Previously the client assembled this itself out of
   * `id` — which, for everything coming back from search, was `undefined`,
   * producing `youtube.com/watch?v=undefined`: a page that loads, looks like
   * YouTube, and says the video is unavailable. A URL is a claim that something
   * exists, so it is made once, on the server, from a checked id.
   */
  url?: string
  provenance?: string
  origin?: WidgetItem['origin']
  actions?: WidgetAction[]
}

export interface FitnessSeries {
  key: string
  label: string
  unit?: string
  accent?: string
  /** Every day in the window. `null` is "no reading", which is not zero. */
  days: { date: string; value: number | null }[]
  /** Where these readings came from, and the newest day it delivered. */
  source?: { id: string; lastReportedDay: string | null }
}

/**
 * WHAT THE ACTIVITY NUMBERS MEAN. Computed on the server; mirrors
 * `server/widgets.ts`'s `ActivityBrief` exactly.
 *
 * Every figure here is decided where the goal, the source preference and the
 * conflict state live, and the surface is not able to recompute any of it. That is
 * the point rather than an accident of layering: the old surface computed its own
 * average from whatever series it was handed, so it could — and did — disagree with
 * the Home row about the same week.
 *
 * `current: null` means there is no trustworthy figure, and the surface must render
 * `source.why` instead of a number. Falling back to the latest reading there would
 * be picking a winner in a disagreement the app has explicitly said it cannot
 * settle.
 */
export interface ActivityBrief {
  metric: string
  unit?: string
  says: string
  current: { day: string; value: number; isToday: boolean } | null
  /** How old that figure is, and how loudly to say so. See server/activity.ts. */
  freshness: { today: string; haveToday: boolean; todayValue: number | null; staleDays: number; level: 'current' | 'lagging' | 'stale' }
  source: {
    id: string | null
    by: 'chosen' | 'only' | 'disputed' | 'none'
    canSupportGoal: boolean
    why?: string
    available: string[]
  }
  trend: {
    average: number | null
    priorAverage: number | null
    changePercent: number | null
    direction: 'up' | 'down' | 'flat' | 'unknown'
    covered: number
    windowDays: number
  }
  goal: {
    id: string
    description: string
    target: number
    unit?: string
    direction: 'up' | 'down' | 'steady'
    current: number
    fraction: number | null
    met: boolean
    shortfall: number
    timeframe?: string
  } | null
  gap: { missingDays: string[]; staleDays: number; lastDay: string | null; lastDayLabel: string }
  conflicts: { metric: string; scope: string; readings: { source: string; value: number }[]; differencePercent: number }[]
  next: { label: string; detail: string; does: string; options?: string[] }
}

export interface WatchObject {
  id: string
  what: string
  why?: string
  question?: string | null
  everyHours: number
  lastRunAt: string | null
  nextRunAt?: string | null
  active: boolean
  by: 'user' | 'agent'
  state?: string
  changedAt?: string | null
  history?: { at: string; text: string; changed?: boolean }[]
  actions?: WidgetAction[]
}

export type Widget =
  | { kind: 'list'; items: WidgetItem[]; filters?: string[]; empty?: string; expandable?: boolean }
  | { kind: 'agenda'; items: WidgetItem[]; focus?: string; days?: number; empty?: string }
  | { kind: 'chart'; points: WidgetPoint[]; unit?: string; target?: number; compareLabel?: string; accent?: string }
  | { kind: 'media'; items: WidgetItem[]; columns?: 1 | 2; empty?: string }
  | { kind: 'map'; places: WidgetPlace[]; route?: 'walk' | 'drive' | 'cycle'; follow?: boolean; searchable?: boolean; zoom?: number; context?: DomainContext[] }
  | { kind: 'detail'; rows: { label: string; value: string; accent?: string }[]; body?: string }
  | { kind: 'compose'; placeholder?: string; value?: string; to?: string; submit: WidgetAction; multiline?: boolean }
  | { kind: 'calendar'; events: CalEvent[]; focus?: string; view?: 'month' | 'week' | 'day'; empty?: string; context?: DomainContext[] }
  | { kind: 'mail'; messages: MailMessage[]; empty?: string; context?: DomainContext[] }
  | { kind: 'video'; videos: VideoObject[]; empty?: string }
  | { kind: 'fitness'; series: FitnessSeries[]; report?: ActivityBrief; empty?: string; context?: DomainContext[] }
  | { kind: 'watch'; watches: WatchObject[]; empty?: string }

export interface WidgetPane {
  title?: string
  widget: Widget
  actions?: WidgetAction[]
}

export interface Need {
  id: string
  tier: 'hero' | 'ember' | 'quiet'
  heat: 'hot' | 'warm' | 'quiet' | 'handled'
  heatLabel: string
  title: string
  sub: string
  status: string
  opening: string
  stats: { l: string; v: string; accent?: string }[] | null
  chips: string[]
  /** Hero card: up to two supply vessels, 0–1 full. */
  gauges: { fill: number; accent?: string }[] | null
  /** Ember card: the progress track and the line under it. */
  meter: { fill: number; left: string; right: string } | null
  /** Quiet row: the 40px glyph tile. */
  glyph: { kind: 'dots' | 'lines' | 'bars'; values: number[] } | null
  accent: string | null
  action: { label: string; done: string } | null
  /** A standing interest the card offers to start watching. */
  proposes: { what: string; why: string; question: string | null; everyHours: number } | null
  basis: string[]
  asks: boolean
  /**
   * The id of the ONE object this card's line is about, so opening the card
   * lands on that object rather than at the top of a list of forty.
   */
  focus?: string | null
  /** What this card opens into, before the chat thread. */
  panes?: WidgetPane[]
  /**
   * WHY THIS IS ON SCREEN, as records rather than as a sentence.
   *
   * Present only on cards the server COMPUTED. Model-authored cards do not get
   * one: asking a model to reconstruct its own reasoning after the fact yields
   * a plausible story rather than the actual grounds, and a plausible story is
   * worse than none because it cannot be argued with.
   */
  because?: Because
  /** Corrections this card accepts. Tapping one writes to the personal model. */
  corrections?: Correction[]
  /** What the server does not know about this. Rendered, never swallowed. */
  uncertainty?: string[]
  /** Exempt from the insights lane's 12-hour expiry — see server/think.ts. */
  /**
   * The server owns this card's lifetime; the lane must not apply its own timer.
   * See `attention.ts`'s `Lifecycle` and the filter in `lanes.ts`.
   */
  standing?: boolean
  /** When it must stop being shown, when the expiry is time-based at all. */
  expiresAt?: string
  /** Why it will leave, for the report. */
  expiryReason?: string
  /**
   * WHICH BAND OF HOME THIS BELONGS IN. Computed by the server; see
   * `attention.ts`'s `bandOf`.
   *
   * The client must not derive this. Every input to the decision — the item's
   * kind, whether anything is blocked on it, whether there is an action —
   * exists only on the server's typed attention object, and a client guessing
   * from `heat` would be a second opinion about the most consequential thing on
   * the screen. Absent means background: model prose has no band.
   */
  band?: Band
  /** The subject this card is about, for the engagement loop. See noteEngaged. */
  topic?: string
  score?: number
}

/** The three kinds of attention Home draws. Mirrored from `attention.ts`. */
export type Band = 'now' | 'next' | 'background'

export interface ThinkResult {
  dateLabel: string
  clock: '12h' | '24h'
  place: string | null
  readLine: string
  needs: Need[]
  ask: { opening: string; chips: string[] }
  quietLog: string[]
  provider: string
  model: string
  fellBackFrom: string[]
}

export const think = () =>
  fetch('/api/think', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(j<ThinkResult>)

/**
 * The splash, as the server assembles it.
 *
 * Mirrored from server/feed.ts for the same reason the widget vocabulary is:
 * the client bundle must not import anything under server/, which pulls in Node
 * and Worker globals. That file is the authority; this is a structural copy.
 */
export interface FeedPane {
  paneId: string
  title: string
  panes: WidgetPane[]
  revisionId: string
  intent: string
  planClass: string
  summary: string
  pinned: 'content' | 'intent' | null
  pendingRevisionId?: string
  canUndo: boolean
  canRedo: boolean
  refresh: string
  updatedAt: string
}

export type FeedItem =
  | { id: string; kind: 'synthesis' | 'source'; need: Need }
  | { id: string; kind: 'pane'; pane: FeedPane }

export type ShelfKind = 'synthesis' | 'source' | 'pane'

export interface ShelfItem {
  id: string
  kind: ShelfKind
  label: string
  on: boolean
  by: 'user' | 'agent'
  addedAt: string
}

export interface Shelf {
  items: ShelfItem[]
  updatedAt: string
}

/**
 * HOME'S THREE SLOTS. Mirrored from server/deck.ts, which is the authority.
 *
 * Structurally copied for the same reason the widget vocabulary is: the client
 * bundle must not import anything under `server/`, which pulls in Node and
 * Worker globals.
 *
 * Every field is drawn and none is derived. If Home needs a fact that is not on
 * this type, the fix is in `deck.ts` — a client computing which domain leads,
 * what the relevance card says, or whether a widget is hot would be exactly the
 * second opinion `band` exists to prevent, one screen larger.
 */
export type DeckRender =
  | 'cal' | 'mail' | 'video' | 'bars' | 'places' | 'stock' | 'runway' | 'drift'

export interface DeckChip {
  label: string
  primary?: boolean
  action: WidgetAction
}

export interface DeckRow {
  id: string
  lead: string
  title: string
  sub?: string
  /** The dimmed continuation of `sub` on the same line. Mail's snippet. */
  note?: string
  trail?: string
  /** THE one row that needs him. At most one per widget — it owns the accent. */
  hot?: boolean
  /** Unread state, as a readout: lights the dot without claiming the accent. */
  unread?: boolean
  fill?: number
  /** Messages in this thread, when more than one. A row is a conversation. */
  count?: number
  /** A watch's recent checks, oldest first, and which of them moved. */
  spark?: { changed: boolean }[]
}

/** Real tiles and real pins, projected server-side. See `server/deck.ts`. */
export interface DeckMap {
  w: number
  h: number
  tiles: { key: string; url: string; left: number; top: number }[]
  marks: { id: string; left: number; top: number; self?: boolean; label?: string }[]
  /** Centre and zoom the offsets were computed for, so the widget can pan. */
  lat: number
  lon: number
  z: number
}

/** The day as a shape: blocks positioned by real time, overlaps in lanes. */
export interface DeckStrip {
  ticks: { at: number; label: string }[]
  nowAt: number | null
  blocks: {
    id: string
    title: string
    lead: string
    top: number
    height: number
    lane: number
    lanes: number
    tentative?: boolean
    hot?: boolean
  }[]
  allDay: { id: string; title: string }[]
}

export interface DeckWidget {
  id: string
  needId: string
  name: string
  meta: string
  render: DeckRender
  hot: boolean
  hero?: { title: string; sub?: string; rel?: string; dur?: string; image?: string; play?: boolean }
  /** The object the hero stands for, so tapping it opens THAT one. */
  heroId?: string
  rows?: DeckRow[]
  thumbs?: { id: string; dur: string; image?: string; title?: string; channel?: string }[]
  map?: DeckMap
  /** Video only: the store has real thumbnails, so a media layout is honest. */
  art?: boolean
  /** Nothing to show: draws as a compact unboxed row, not a filled card. */
  quiet?: boolean
  strip?: DeckStrip
  /** The reading is history, not news — the bars say so themselves. */
  stale?: boolean
  figure?: string
  /** Which day the figure is from, when that is not today. Blank otherwise. */
  note?: string
  unit?: string
  delta?: string
  /** `null` is "no reading", which is not zero. See Activity's missing ≠ zero. */
  /** `v` is the bar's height; `value`/`day` are what a scrub reads out. */
  bars?: { label: string; v: number | null; now?: boolean; value?: string; day?: string }[]
  goal?: { at: number; label: string } | null
  foot: string
  chips: DeckChip[]
  mini: { value: string; line: string }
}

export interface Relevance {
  needId: string
  eyebrow: string
  head: string
  sub: string
  /**
   * NO `action`. The server stopped projecting one after the pill reading "Set a
   * reminder" turned out to be a LABEL with no id behind it — structurally
   * incapable of performing anything, and rendered as the loudest thing on Home.
   * The field lingered here after the server dropped it, which is its own small
   * lesson: a client type that declares what the server no longer sends is a
   * standing invitation to render it again.
   */
  tone: 'urgent' | 'changed' | 'active' | 'warning' | 'time' | 'neutral' | 'resolved'
}

/**
 * SLOT THREE, AS THE CLIENT IS ALLOWED TO SEE IT.
 *
 * The mirror of `server/intelligence.ts`, and the boundary is the point: React
 * never sees a `Hypothesis`, a `Prediction`, an `Anomaly`, a shadow run or a
 * memory row. It sees a headline, a certainty BAND rather than a confidence
 * number, an optional picture chosen from four shapes, and an evidence trail
 * whose lines were written where the arithmetic happened.
 *
 * Everything in here is already clamped and already formatted. The client's job
 * is layout; it does no rounding, no date maths and no rephrasing.
 */
export type IntelligenceKind =
  | 'observation' | 'connection' | 'change' | 'question' | 'recommendation' | 'prediction'

export type Certainty = 'known' | 'strong' | 'likely' | 'possible' | 'unclear'

export interface IntelligenceValue { label: string; value: string }

export type IntelligenceVisual =
  | { kind: 'comparison'; before: IntelligenceValue; after: IntelligenceValue }
  | { kind: 'distribution'; bars: { label: string; v: number | null; mark?: boolean }[]; low: string; high: string }
  | { kind: 'tally'; for: number; against: number; caption: string }
  | { kind: 'range'; lo: string; hi: string; point?: string; caption: string }

export interface IntelligenceEvidence {
  trail: { id: string; voice: 'observation' | 'computation' | 'inference' | 'fact'; says: string }[]
  span?: string
  caveats: string[]
}

export type IntelligenceAction =
  | { kind: 'open'; id: string; label: string; surface: string; focus?: string }
  | { kind: 'ask'; id: string; label: string; text: string }

export interface IntelligencePresentation {
  id: string
  kind: IntelligenceKind
  subjectRefs: string[]
  headline: string
  summary?: string
  implication?: string
  certainty: Certainty
  visual?: IntelligenceVisual
  evidence: IntelligenceEvidence
  actions?: IntelligenceAction[]
  provenanceRefs: string[]
  /** Ranking facts. Read by the developer view; never rendered as a number. */
  attention: { score: number; significant: boolean; suppressedFor?: string; ends: string }
  generatedAt: string
}

export interface HomeDeck {
  widgets: DeckWidget[]
  relevance: Relevance | null
  relevanceFor: Record<string, Relevance>
  intelligence: IntelligencePresentation | null
  off: string[]
}

export interface Feed extends Omit<ThinkResult, 'provider' | 'model' | 'fellBackFrom'> {
  items: FeedItem[]
  deck: HomeDeck
  shelf: Shelf
  /** When synthesis was assembled. NOT when the source rows were derived. */
  at: string
  /**
   * WHICH FEED IS NEWER. See `server/feed.ts` for why this is not `at`.
   *
   * Optional only because a snapshot written before this field existed has none;
   * read it through `revisionOf`, never directly.
   */
  revision?: number
  /**
   * When the deterministic source rows were last projected — normally now, even
   * on a cached read, because the server re-derives them from the stored world
   * rather than serving the ones it happened to cache. See `readSnapshot`.
   */
  sourcesAt?: string
  /**
   * This feed was assembled on an earlier day than it is being shown on, and
   * its day-bound parts have been WITHDRAWN. Not "slightly old": the model's
   * cards answered a different day's question and are gone until the rebuild
   * behind this lands. Never present the gap as "nothing needs you".
   */
  staleDay?: boolean
  /**
   * The few typed facts the client's resolution ladder is allowed to read.
   *
   * `transportMode`, `origin` — the slots a task can be blocked on that looking
   * at the screen can never answer. Deliberately not the personal model; see
   * `known` in server/feed.ts.
   */
  known?: Record<string, string>
  /** Set when the model could not run. Everything else in here is still real. */
  degraded?: string
  provider?: string
  model?: string
}

/**
 * `cached` returns the last feed the server assembled, without thinking.
 *
 * The first paint uses it, so opening the app shows his actual home screen
 * rather than a spinner — including on a cold browser, where localStorage has
 * nothing and only the server remembers what he was looking at.
 */
/**
 * THE DEVICE IS THE AUTHORITY ON WHICH DAY IT IS WHERE HE IS.
 *
 * The server originally learned his zone from Google Calendar, which was the
 * obvious place to read it and turned out to be wrong: his calendar's setting
 * is `UTC` while he is in Italy. That is not an unusual state — it is the
 * default nobody changes — and trusting it would have stored `UTC` and left
 * every date computation exactly as broken as before, with the added problem of
 * looking fixed.
 *
 * The browser knows the zone the machine is actually standing in, and it is the
 * same machine the screen is on. So it is sent with every feed request and the
 * server prefers it over anything a connector reports.
 */
const tz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

const withTz = (path: string): string => {
  const z = tz()
  if (!z) return path
  return `${path}${path.includes('?') ? '&' : '?'}tz=${encodeURIComponent(z)}`
}

export const getFeed = (opts: { cached?: boolean } = {}) =>
  fetch(withTz(`/api/feed${opts.cached ? '?cached=1' : ''}`)).then(j<Feed>)

/**
 * HOW OLD IS THIS FEED, AS ONE COMPARABLE NUMBER.
 *
 * Falls back to `at` for a snapshot written before `revision` existed, and to 0
 * for anything unreadable — so an ancient cached feed loses every comparison
 * rather than winning by having no opinion.
 */
export const revisionOf = (f: Feed | null | undefined): number => {
  if (!f) return 0
  if (typeof f.revision === 'number' && Number.isFinite(f.revision)) return f.revision
  const t = Date.parse(f.at ?? '')
  return Number.isFinite(t) ? t : 0
}

export interface SyncOutcome {
  due: string[]
  synced: string[]
  errors: string[]
  observations: number
  freshness: Record<string, { at: string | null; ageMs: number | null; cadenceMs: number }>
  feed: Feed
}

/**
 * TELL THE SERVER SOMEBODY IS LOOKING, AND LET IT DECIDE WHAT THAT COSTS.
 *
 * Deliberately carries no source list and no cadence. The client's whole
 * contribution is the fact of a person being present; which connectors that is
 * worth a call to is a question about the account's quota, and the account does
 * not live in this tab. See `server/sync.ts`.
 */
export const syncIfDue = () =>
  fetch('/api/sync/due', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  }).then(j<SyncOutcome>)

/** Bring panes and sources current with no model. Survives a rate limit. */
export const refreshFeed = () =>
  fetch('/api/feed/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(j<{ refreshed: string[]; failed: string[]; feed: Feed }>)

export interface AskResponse {
  kind: 'pane' | 'ask'
  op?: 'create' | 'refine'
  paneId?: string
  question?: string
  compiled?: { intent: string; planClass: string; by: 'model' | 'local'; unresolved: string[]; unknown: string[] }
  skipped?: { op: string; why: string }[]
}

/** His words to a pane. No plan in the request, no id he has to know. */
export const askFor = (intent: string, opts: { paneId?: string; fresh?: boolean } = {}) =>
  fetch('/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, ...opts }),
  }).then(j<AskResponse>)

/**
 * WHEN TO SET OFF, computed rather than described.
 *
 * Every input is already resolved by the time this is called — the ladder does
 * that against what is on his screen — so there is no "and work out the rest"
 * parameter and no free text. See `src/task/resolve.ts` and `server/leaveby.ts`.
 */
export type LeaveByResult =
  | {
      ok: true
      leaveAt: string
      travelMinutes: number
      bufferMinutes: number
      how: string
      destination: { label: string; lat: number; lon: number }
      origin: { label: string; lat: number; lon: number }
      says: string
    }
  | { ok: false; failed: 'destination' | 'origin' | 'route' | 'mode'; says: string }

export const leaveByFor = (input: {
  destination: string
  eventStart: string
  origin: string
  transportMode: string
}) =>
  fetch('/api/leaveby', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(j<LeaveByResult>)

export const getShelf = () => fetch('/api/shelf').then(j<Shelf>)

const putShelf = (body: unknown) =>
  fetch('/api/shelf', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j<Shelf>)

/** Reorder. Everything named becomes his, and stays where he put it. */
export const arrangeShelf = (order: string[]) => putShelf({ order })

export const toggleShelf = (id: string, on: boolean) => putShelf({ toggle: { id, on } })

export const closePane = (paneId: string) =>
  fetch(`/api/panes/${paneId}/close`, { method: 'POST' }).then(j<unknown>)

export const refreshPane = (paneId: string) =>
  fetch(`/api/panes/${paneId}/refresh`, { method: 'POST' }).then(j<unknown>)

export const acceptPane = (paneId: string) =>
  fetch(`/api/panes/${paneId}/accept`, { method: 'POST' }).then(j<unknown>)

export const undoPane = (paneId: string) =>
  fetch(`/api/panes/${paneId}/undo`, { method: 'POST' }).then(j<unknown>)

export const tell = (text: string, inReplyTo?: string) =>
  fetch('/api/world/tell', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inReplyTo }),
  }).then(j<{ ok: true }>)

export interface Track {
  id: string
  what: string
  why: string
  question: string | null
  everyHours: number
  lastRunAt: string | null
  active: boolean
  by: 'user' | 'agent'
}

export const listTracks = () => fetch('/api/tracks').then(j<{ tracks: Track[] }>)

export const addTrack = (t: Partial<Track> & { by?: 'user' | 'agent' }) =>
  fetch('/api/tracks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(t),
  }).then(j<{ ok: true; track: Track }>)

export const removeTrack = (id: string) =>
  fetch(`/api/tracks/${id}`, { method: 'DELETE' }).then(j<{ ok: true }>)

export const googleStatus = () =>
  fetch('/api/google/status').then(j<{ configured: boolean; connected: boolean; scopes: string[] }>)

export const googleSync = () =>
  fetch('/api/google/sync', { method: 'POST' }).then(j<{ added: number; bySource: Record<string, number>; errors: string[] }>)

export const googleDisconnect = () =>
  fetch('/api/google/disconnect', { method: 'POST' }).then(j<{ ok: true }>)

export interface SourcesResponse {
  sources: { id: string; on: boolean }[]
  curation: 'auto' | 'manual'
}

export const getSources = () => fetch('/api/sources').then(j<SourcesResponse>)

export const putSources = (body: { sources?: Record<string, boolean>; curation?: 'auto' | 'manual' }) =>
  fetch('/api/sources', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j<{ ok: true }>)

/** A command the model wants run against a surface he is looking at. */
export interface UiCommand {
  surface?: string
  op: string
  args?: Record<string, unknown>
}

export const say = (
  text: string,
  /**
   * `id` is sent as well as the prose, and it is the load-bearing field.
   *
   * A clarification card's id IS the slot it asked about — `insight.ts` mints them
   * as `ask:<key>` — so sending it lets the server write a freeform reply into the
   * right typed field without inferring anything from his wording. Without the id
   * the server can only match on the question TEXT, which breaks the moment the
   * wording is improved.
   */
  card?: { id?: string; title: string; status: string; asks?: boolean } | null,
  thread?: { who: 'me' | 'ai'; text: string }[],
  /**
   * What is on screen right now.
   *
   * Sent from here because this is the only place it exists. The server holds
   * the pane's contents; which day is showing and which three messages are
   * selected are facts about this browser, and a model that is not told them
   * has to guess what "these" means.
   */
  surfaces?: unknown[]
) =>
  fetch('/api/say', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, card, thread, surfaces }),
  }).then(j<{
    reply: string
    learned: boolean
    did: string | null
    /**
     * What KIND of thing `did` is.
     *
     * `telemetry` — a sync ran, a fetch happened, a count came back. True, worth
     * keeping, and not conversation: it belongs in the surface's own status line
     * rather than as a message in the thread. Chat filled up with "Pulled 2 new
     * things from Google just now." and the actual exchange got pushed off the
     * top by the app talking about itself.
     *
     * `result` — an answer to what he asked. That IS the conversation.
     */
    didKind?: 'telemetry' | 'result'
    ui?: UiCommand[]
  }>)

export const learn = () =>
  fetch('/api/learn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    .then(j<{ asked: string[]; learned: string[]; unanswered: number; forHim: unknown[] }>)

/**
 * Turn on notifications. Safe to call on every load: the browser returns the
 * existing subscription if there is one, and the server de-dupes by endpoint.
 * Every step is allowed to fail quietly — push is a nicety, and a browser
 * without it (or a permission he declined) must not break the app.
 */
export async function enablePush(): Promise<'on' | 'denied' | 'unsupported'> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  try {
    const reg = await navigator.serviceWorker.register('/sw.js')
    const { key } = await fetch('/api/push/vapid-public').then(j<{ key: string | null }>)
    if (!key) return 'unsupported'
    // Only ask once the app is worth notifying about — never on first paint.
    if (Notification.permission === 'default' && (await Notification.requestPermission()) !== 'granted') return 'denied'
    if (Notification.permission !== 'granted') return 'denied'

    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) }))

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    })
    return 'on'
  } catch {
    return 'unsupported'
  }
}

function urlB64ToBytes(s: string): ArrayBuffer {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}


// ── Corrections ──────────────────────────────────────────────────────────────

/**
 * A correction he made, as the server's closed verb set describes it.
 *
 * Mirrors `server/attention.ts`. Hand-maintained, like every other type in this
 * file, because the client bundle must not import from `server/`.
 */
export type Correction =
  | { verb: 'wrong'; label: string; target: { kind: string; id: string }; note?: string }
  | { verb: 'prefer-source'; label: string; metric: string; source: string }
  | { verb: 'set-preference'; label: string; key: string; value: unknown }
  | { verb: 'forget'; label: string; target: { kind: string; id: string } }
  | { verb: 'not-relevant'; label: string; about: string }
  | { verb: 'relationship'; label: string; personId: string; value: string }

/** Why a computed card is on screen: the grounds, not a story about them. */
export interface Because {
  sentence: string
  grounds: { kind: string; id: string; says: string }[]
}

/**
 * Tell the server it got something wrong.
 *
 * Returns what it says it did, which is shown back to him verbatim. A
 * correction that silently succeeds is indistinguishable from one that did
 * nothing, and this app has already shipped three controls wired to an
 * operation nothing implemented.
 */
export async function applyCorrection(c: Correction): Promise<{ ok: boolean; said: string }> {
  try {
    const r = await fetch('/api/person/correct', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    })
    const b = await r.json().catch(() => null)
    return { ok: !!b?.ok, said: b?.said ?? 'That did not go through.' }
  } catch {
    return { ok: false, said: 'I could not reach the server to record that.' }
  }
}

/**
 * WHAT HE MADE OF SOMETHING CRUCIBLE SAID — and the two verdicts are not one
 * control with three labels.
 *
 * `useful` and `not-useful` are ENGAGEMENT. They say whether he wanted to be
 * told, they move attention's fit axis, and they leave the claim's truth alone.
 * `wrong` is EPISTEMIC: it says the claim is false, and it reaches the
 * hypothesis. Collapsing the two — treating "wrong" as a dismissal — is how a
 * system ends up quietly still believing something he explicitly denied, and
 * merely showing it to him less often.
 *
 * The optional `correction` is the valuable half: "the summer bus timetable
 * changed" is a fact about the world that explains the pattern away, and it is
 * stored as a `stated` fact — the one knowledge kind cognition may never
 * overwrite, and one of the few things that survives a rebuild.
 */
export async function judgeIntelligence(input: {
  id: string
  verdict: 'useful' | 'not-useful' | 'wrong'
  correction?: string
}): Promise<{ ok: boolean; said: string }> {
  try {
    const r = await fetch('/api/intelligence/judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const b = await r.json().catch(() => null)
    return { ok: !!b?.ok, said: b?.said ?? 'That did not go through.' }
  } catch {
    return { ok: false, said: 'I could not reach the server to record that.' }
  }
}

/**
 * A number he supplies himself — "my phone says 10,347 today".
 *
 * Deliberately a READING and not a correction, which is the distinction
 * `noteReading` on the server is built around: a correction would overwrite what
 * the connector said, while a reading sits beside it and lets the conflict
 * machinery ask him which source to trust. Overwriting settles the question by
 * fiat and destroys the fact that two things were ever reported.
 */
export async function noteReading(input: {
  metric: string
  day: string
  value: number
  source?: string
}): Promise<{ ok: boolean; said: string }> {
  try {
    const r = await fetch('/api/person/reading', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const b = await r.json().catch(() => null)
    return { ok: !!b?.ok, said: b?.said ?? 'That did not go through.' }
  } catch {
    return { ok: false, said: 'I could not reach the server to record that.' }
  }
}

/** He states a goal, with the number and direction that make it measurable. */
export async function setGoal(input: {
  description: string
  metric?: string
  target?: number
  unit?: string
  direction?: 'up' | 'down' | 'steady'
  outcome?: string
  timeframe?: string
}): Promise<{ ok: boolean; id?: string }> {
  try {
    const r = await fetch('/api/person/goal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    const b = await r.json().catch(() => null)
    return { ok: !!b?.ok, id: b?.id }
  } catch {
    return { ok: false }
  }
}

/** Alias kept short for surfaces, which read as prose at the call site. */
/**
 * WHAT CRUCIBLE BELIEVES, AND WHERE IT CAME FROM.
 *
 * Mirrored from `server/health.ts`, like every other server shape the client
 * reads — that file is the authority and this is a structural copy, because the
 * bundle must not import anything under server/.
 */
export interface Known {
  key: string
  value: string
  by: 'user' | 'agent' | 'connector'
  source: string
  status: string
  confidence: number
  at: string
  atLabel: string
  freshness: 'live' | 'recent' | 'ageing' | 'stale' | 'unknown'
  bag: 'identity' | 'preferences'
  disputed: boolean
}

export interface DataHealth {
  at: string
  unresolved: {
    disagreements: { metric: string; scope: string; scopeLabel: string; readings: { source: string; value: number }[]; differencePercent: number; state: string; resolvedTo?: string }[]
    questions: { key: string; why: string; wanted: number; before?: string; asked: number }[]
    decayed: { id: string; statement: string; confidence: number; confirmedAt: string; confirmedLabel: string; contested?: string }[]
  }
  known: Known[]
  sources: { id: string; records: number; newest?: string; newestLabel?: string; freshness: Known['freshness']; authoritativeFor: string[] }[]
  counts: { known: number; fromHim: number; stale: number; observations: number; beliefs: number; people: number; goals: number }
}

export const getDataHealth = () => fetch('/api/person/health').then(j<DataHealth>)

export const correct = applyCorrection

/**
 * TELL THE SERVER WHAT HE DID WITH A CARD.
 *
 * Not a correction, and the two must not be confused: a correction is something
 * he SAID and becomes a permanent `by: 'user'` fact; this is something he DID
 * and only nudges a ranking, within bounds, on top of whatever he stated. See
 * `person.ts`'s `engagement`.
 *
 * Fire-and-forget on purpose. If this request fails the app has lost one data
 * point about how interested he is in travel cards, which is not worth an error
 * on his screen and is certainly not worth blocking the dismissal he asked for.
 */
export const noteEngaged = (about: string | undefined, verdict: 'accepted' | 'dismissed'): void => {
  if (!about) return
  void fetch('/api/person/engagement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ about, verdict }),
  }).catch(() => {})
}

/**
 * The preferences he can set directly, and what each currently holds.
 *
 * `value: null` means he has not said — deliberately distinct from him having
 * chosen the middle option, because only the first is still worth asking about. The
 * settings surface renders that difference rather than pre-selecting a default and
 * calling it his choice.
 */
export interface PreferenceSlot {
  key: string
  question: string
  unlocks: string
  label: string
  section: string
  options: { value: string; label: string }[]
  value: unknown
  by?: string
}

export const getPreferences = () =>
  fetch('/api/person/preferences').then(j<{ slots: PreferenceSlot[] }>)

/**
 * "What should I focus on this week?"
 *
 * Computed on the server from the attention model, not written by a language model,
 * so every date in it comes from `clock.ts` and every line can show its grounds and
 * accept a correction. `prose` is the same answer rendered for chat — one structure,
 * two readings, so the sentence he reads cannot disagree with the object behind it.
 */
export const getFocus = () => fetch('/api/focus').then(j<FocusResponse>)

export interface FocusItem {
  id: string
  headline: string
  detail: string
  day: string | null
  when: string
  kind: string
  score: number
  because: Because
  corrections: Correction[]
  uncertainty: string[]
  suggest?: { label: string; detail: string }
}

export interface FocusResponse {
  week: { from: string; to: string; days: { day: string; weekday: string; relative: string }[] }
  remaining: { from: string; to: string }
  summary: string
  days: { day: string; weekday: string; relative: string; items: FocusItem[] }[]
  standing: FocusItem[]
  held: { title: string; why: string }[]
  prose: string
}
