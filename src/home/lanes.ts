import type { Feed, FeedItem, FeedPane, Need, WatchObject } from '../api'
import type { LaneId, StateTone } from '../tokens'

/**
 * HOME IS ATTENTION, AND ATTENTION HAS THREE SPEEDS.
 *
 * What this replaced: four lanes named after where things CAME FROM — apps,
 * saved panes, tasks, insights. That is a filing system. It asked the reader to
 * do the triage, at four equal weights, and the one question he actually opens
 * the app with — "is anything on fire?" — could only be answered by reading all
 * of it. Meanwhile the server had grown a real attention model, with lifecycles
 * and grounds and a ranking, and the screen had nowhere to put its answer.
 *
 *   now         blocked on him, or close enough that waiting costs him
 *   next        context for what is coming
 *   background  true, quiet, safe to ignore today
 *
 * THE BAND IS THE SERVER'S DECISION, NOT THIS FILE'S. A computed card arrives
 * carrying `need.band`, from `attention.ts`'s `bandOf`, which reads the item's
 * kind, its instant, its lifecycle and whether there is anything to do about it.
 * None of those survive the trip to the browser intact, so a client that
 * re-derived the band would be a second opinion about the most consequential
 * thing on the screen. What this file decides is only the band for things the
 * attention model does not produce — a task, a watch, a pane he saved — and each
 * of those rules is written down once, in `bandOf` below.
 *
 * THE SIX APPLICATIONS ARE NOT A BAND. They are a strip of tiles at the foot of
 * the screen: navigation, at the weight navigation deserves. An app launcher
 * sitting at the same size as "you have no way of getting to tomorrow's dinner"
 * was the screen asserting they were comparably important, and it is the single
 * change that makes the rest of this legible. Their live state is a dot and a
 * count on the tile; when a source has something that genuinely needs him it
 * reaches a band as a card, like everything else.
 *
 * The classification is derived from the feed rather than stored, because the
 * feed is the canonical source and a second stored copy of "which band is this
 * in" is a second thing that can disagree with it. What IS stored is the small
 * set of decisions only the user can make: order, hidden, saved, dismissed.
 */

export type Lane = LaneId
export type Band = LaneId

/**
 * WHAT KIND OF THING A CARD STANDS FOR.
 *
 * Distinct from its band, and both are needed: the band decides WHERE it is
 * drawn, this decides HOW — which controls it offers, whether it expires, and
 * whether it can be argued with. Two cards in `now` can be a conflict the app
 * cannot resolve and a research task waiting on an answer, and they are not the
 * same kind of object however similar their urgency.
 */
export type CardKind = 'attention' | 'task' | 'watch' | 'pane' | 'source'

export type TaskState =
  | 'running' | 'waiting' | 'blocked'
  | 'failedRetryable' | 'failedTerminal'
  | 'completed'

export type WatchState = 'active' | 'paused' | 'stopped'

/** What an object on Home is, in enough detail to rank and to draw it. */
export interface HomeObject {
  /**
   * CANONICAL IDENTITY.
   *
   * One real-world object has one id, and every projection of it uses that id:
   * a watch in the Tasks lane and the same watch inside Keep an Eye are the
   * same string, so stopping it in one place is immediately true in the other.
   * Projections appear and disappear; canonical state never forks.
   */
  id: string
  /** Which of the three bands draws it. See `bandOf`. */
  lane: Lane
  /** What sort of object this is, which decides how it is drawn. See `CardKind`. */
  kind: CardKind
  title: string
  /** One line of state. Never the whole application. */
  line: string
  /** What kind of state this is in. Colour comes from here, and only here. */
  tone: StateTone
  /** The state, in two or three words. "waiting on you", "3 unread". */
  stateLabel: string
  /** ISO time this object is about, when it has one. Used for imminence only. */
  at?: string
  /** This will not progress without him. Ranks above everything else in its lane. */
  needsUser: boolean
  /** New or changed since he last looked. */
  changed: boolean
  /** Which view opens when it is tapped — always the canonical object's own app. */
  opens: string
  /**
   * WHAT THIS OBJECT ACTUALLY CONTAINS, for the card to draw.
   *
   * The SAME widget its application renders — not a summary of it, and not a
   * second query. A card said its title and one sentence of prose and then left
   * two thirds of its frame empty, so Home was four headlines on a black field:
   * technically the right information, and nothing you could act on without
   * opening something first.
   *
   * A card is an attention projection, and a projection of a mailbox is the
   * senders, not the word "Mail". Reading it from the object's own widget is
   * what keeps the card and the app from disagreeing — there is one list, and
   * the card shows the top of it.
   */
  preview?: FeedPane['panes'][number]['widget']
  /** Lane-specific detail the renderers need. */
  task?: { state: TaskState; phase?: string; retryable: boolean }
  watch?: { state: WatchState; everyHours: number }
  pane?: FeedPane
  need?: Need
}

/**
 * The system apps, in their factory order. Nothing else is ever first-class.
 *
 * `src` IS LOAD-BEARING AND WAS MISSING. A card's id is its NAVIGATION id — the
 * view it opens, `mail`, chosen for the router. The feed names the same thing
 * by its SOURCE id, `src-email`, chosen for the connector. Two vocabularies for
 * one object, and the card looked its state up by the wrong one:
 *
 *     const need = all.find((n) => n.id === id)   // 'mail' never equals 'src-email'
 *
 * So `need` was undefined for all six, always, for every possible feed. Every
 * source card on his home screen rendered "Nothing right now / NOT CONNECTED"
 * with a neutral tone and no preview, over a live account holding nine messages
 * and six unread. Nothing was broken about the data, the connector or the API —
 * the two halves of the app simply had no id in common, and the failure looked
 * exactly like a Google account that had come unlinked.
 *
 * `id` and `src` are therefore both written down, once, here. Nothing derives
 * one from the other by string surgery — `mail`→`src-email` and
 * `fitness`→`src-health` are not transformations, they are facts.
 */
export const SYSTEM_APPS: { id: string; label: string; short: string; src: string }[] = [
  { id: 'calendar', label: 'Calendar', short: 'Cal', src: 'src-calendar' },
  { id: 'mail', label: 'Mail', short: 'Mail', src: 'src-email' },
  { id: 'places', label: 'Places', short: 'Map', src: 'src-map' },
  { id: 'video', label: 'YouTube', short: 'Video', src: 'src-youtube' },
  { id: 'fitness', label: 'Activity', short: 'Steps', src: 'src-health' },
  { id: 'watch', label: 'Keep an eye', short: 'Watch', src: 'src-keepaneye' },
]

const SYSTEM_IDS = new Set(SYSTEM_APPS.map((a) => a.id))

export const isSystemApp = (id: string): boolean => SYSTEM_IDS.has(id)

/**
 * WHY THERE IS A `short` AS WELL AS A `label`.
 *
 * Six tiles across a 375px phone leaves about fifty pixels each. "Calendar"
 * rendered as "Cale…", "Keep an eye" as "Kee…", and four of the six tiles were
 * ellipses — which is not a label, it is the ghost of one, and a launcher whose
 * captions cannot be read is worse than one with no captions at all.
 *
 * So the strip has its own vocabulary, written down rather than truncated:
 * short enough to fit at that width, and the same word every day so the hand
 * learns the position and stops reading. `label` is what the application calls
 * itself everywhere it has room to say it.
 */

/**
 * A navigation id → the id the feed files that object under.
 *
 * The ONE place the two vocabularies are allowed to meet. Every lookup that
 * crosses from a view id to a feed need goes through here, so a seventh app
 * cannot be added with a card that silently never finds its data.
 */
export const sourceIdFor = (navId: string): string =>
  SYSTEM_APPS.find((a) => a.id === navId)?.src ?? navId

/**
 * How long a finished task stays before it takes itself off Home.
 *
 * Two windows, and the difference between them is the whole point. A completed
 * task and a terminal failure both have to leave — "completed work cleans itself
 * up" and "failures do not become permanent debris" are the same rule — but
 * neither may vanish before it has been seen, or the app silently discards the
 * answer to the thing that was asked. So the clock starts when it is first
 * rendered, not when it finished.
 *
 * A retryable failure has no window at all. It is actionable, and actionable
 * things wait for him.
 */
export const RETENTION = {
  completed: 6 * 60 * 60_000,
  failedTerminal: 24 * 60 * 60_000,
  /** An insight nobody engaged with is not intelligence any more. */
  insight: 12 * 60 * 60_000,
} as const

/** The user-owned decisions that the feed cannot know. Durable; see homeState. */
export interface Durable {
  /** System app order, as ids. Anything unlisted keeps its factory position. */
  systemOrder: string[]
  hiddenApps: string[]
  /** Panes he pinned to the front of his own lane. */
  pinnedPanes: string[]
  /** Task results and insights he saved — these become User Panes. */
  saved: string[]
  /** Panes he archived or deleted. Removed from Home; the object itself is not. */
  archived: string[]
  dismissed: string[]
  /** When each ephemeral object was first put in front of him. */
  seenAt: Record<string, string>
}

export const blankDurable = (): Durable => ({
  systemOrder: [], hiddenApps: [], pinnedPanes: [], saved: [], archived: [], dismissed: [], seenAt: {},
})

// ── deriving state ───────────────────────────────────────────────────────────

/**
 * A pane whose head revision holds nothing is a record of an attempt, not a
 * result. That distinction is what stops "No route found" from occupying more
 * of Home than Calendar.
 */
export function isBarren(pane: FeedPane): boolean {
  const count = (w: FeedPane['panes'][number]['widget']): number => {
    switch (w.kind) {
      case 'list': case 'agenda': case 'media': return w.items.length
      case 'calendar': return w.events.length
      case 'mail': return w.messages.length
      case 'video': return w.videos.length
      case 'watch': return w.watches.length
      case 'fitness': return w.series.length
      case 'map': return w.places.length
      case 'chart': return w.points.length
      case 'detail': return w.rows.length
      // A composer is not empty in the sense that matters: it is a thing to do,
      // not a result that failed to arrive.
      case 'compose': return 1
    }
  }
  return (pane.panes ?? []).every((p) => count(p.widget) === 0)
}

/**
 * What state a transient pane is in.
 *
 * Failure is made explicit and split, because the two halves have opposite
 * lifecycles. A retryable failure is a thing to do and stays until he does it;
 * a terminal one is information and gets a short window. Anything that produced
 * a result is completed and is on its way off Home unless he keeps it.
 */
export function taskStateOf(pane: FeedPane): TaskState {
  if (pane.pendingRevisionId) return 'waiting'
  if (pane.refresh === 'live' && isBarren(pane)) return 'running'
  if (isBarren(pane)) return 'failedRetryable'
  return 'completed'
}

const TASK_TONE: Record<TaskState, StateTone> = {
  running: 'active',
  waiting: 'timeSensitive',
  blocked: 'urgent',
  failedRetryable: 'warning',
  failedTerminal: 'neutral',
  completed: 'resolved',
}

const TASK_LABEL: Record<TaskState, string> = {
  running: 'running',
  waiting: 'waiting on you',
  blocked: 'blocked',
  failedRetryable: 'failed · retry',
  failedTerminal: 'didn’t work',
  completed: 'done',
}

const heatTone = (n: Need): StateTone =>
  n.heat === 'hot' ? 'urgent' : n.heat === 'warm' ? 'timeSensitive' : n.heat === 'handled' ? 'resolved' : 'neutral'

// ── classification ───────────────────────────────────────────────────────────

export interface Lanes {
  /** The launcher strip. Not a band; never ranked; his order, always. */
  apps: AppTile[]
  now: HomeObject[]
  next: HomeObject[]
  background: HomeObject[]
}

/**
 * One application, as a tile.
 *
 * Deliberately NOT a `HomeObject`. A tile has no band, no lifecycle, no
 * corrections and no preview — giving it those fields would be the first step
 * back towards an app being a card, and the whole point of the strip is that it
 * is not one. What it carries is what a launcher needs: what it is called,
 * whether it is connected, and how loud its state is right now.
 */
export interface AppTile {
  id: string
  /** What the strip prints. Short by necessity — see SYSTEM_APPS. */
  label: string
  /** What the application calls itself, for assistive text and the tooltip. */
  fullLabel: string
  tone: StateTone
  /** The one number worth putting on a tile — "6", "2". Empty when there is none. */
  count: string
  /** The state in a few words, for assistive text and the long-press hint. */
  state: string
  connected: boolean
}

/**
 * WHICH BAND SOMETHING THAT IS NOT AN ATTENTION ITEM BELONGS IN.
 *
 * Computed cards arrive with `need.band` already decided by the server and this
 * is not consulted for them — see the file header. What is left is the app's own
 * furniture, and each of these is a rule rather than a preference:
 *
 *   · A task WAITING ON HIM is the definition of `now`. It will not progress
 *     otherwise, and it is the only thing on this list where the app is
 *     genuinely stuck.
 *   · A task RUNNING is `next`: it is about to produce something, and he does
 *     not have to do anything about it in the meantime.
 *   · A watch that has CHANGED is `next` — it found something, which is news
 *     and not an emergency. A quiet watch is background.
 *   · A pane he SAVED is background unless it is asking him to accept a
 *     revision, which is a task waiting on him wearing a different hat.
 *   · A source is only ever a card when it is hot or warm; see `classify`.
 */
export function bandOf(o: Omit<HomeObject, 'lane'>): Band {
  if (o.needsUser) return 'now'
  if (o.kind === 'task') return o.task?.state === 'running' ? 'next' : 'background'
  if (o.kind === 'watch') return o.changed ? 'next' : 'background'
  if (o.kind === 'source') return o.tone === 'urgent' ? 'now' : 'next'
  return 'background'
}

/** The one widget an object is really about — the first its pane declares. */
const previewOf = (panes?: { widget: FeedPane['panes'][number]['widget'] }[]) => panes?.[0]?.widget

const needs = (items: FeedItem[]): Need[] => items.flatMap((i) => ('need' in i && i.need ? [i.need] : []))
const feedPanes = (items: FeedItem[]): FeedPane[] => items.flatMap((i) => ('pane' in i && i.pane ? [i.pane] : []))

/** Every watch the world currently holds, read from Keep an Eye's own widget. */
export function watchesOf(items: FeedItem[]): WatchObject[] {
  const keep = needs(items).find((n) => n.id === sourceIdFor('watch'))
  return (keep?.panes ?? []).flatMap((p) => (p.widget.kind === 'watch' ? p.widget.watches : []))
}

const expired = (id: string, d: Durable, ms: number, now: number): boolean => {
  const seen = Date.parse(d.seenAt[id] ?? '')
  return Number.isFinite(seen) && now - seen > ms
}

/**
 * Feed + user decisions → four lanes, each already ranked.
 *
 * Everything the lifecycle rules say leaves Home is dropped here rather than
 * rendered greyed out: "leaves Home" has to mean it is not on the screen, or
 * Home accumulates exactly the way the whole design forbids.
 */export function classify(feed: Feed | null, d: Durable, now = Date.now()): Lanes {
  const items = feed?.items ?? []
  const all = needs(items)
  const panes = feedPanes(items)
  const dismissed = new Set(d.dismissed)
  const archived = new Set(d.archived)
  const saved = new Set(d.saved)
  const hidden = new Set(d.hiddenApps)

  // ── THE APPLICATION STRIP ─────────────────────────────────────────────────
  // Manual stable order ONLY, and no ranking anywhere near it. A row of
  // capabilities that reshuffles daily is not a row the hand can learn, and the
  // hand is the entire reason the strip exists. Relevance shows up as a dot and
  // a count; it never moves a tile.
  const order = [...d.systemOrder, ...SYSTEM_APPS.map((a) => a.id).filter((id) => !d.systemOrder.includes(id))]
  const apps: AppTile[] = order
    .filter((id) => !hidden.has(id))
    .flatMap((id) => {
      const app = SYSTEM_APPS.find((a) => a.id === id)
      if (!app) return []
      // By the SOURCE id, which is what the feed calls this object. See SYSTEM_APPS.
      const need = all.find((n) => n.id === app.src)
      const stat = need?.stats?.[0]
      return [{
        id,
        label: app.short,
        fullLabel: app.label,
        tone: need ? heatTone(need) : 'neutral',
        /**
         * ONE NUMBER, AND ONLY WHEN IT MEANS SOMETHING.
         *
         * A tile is 40px. "2 · next 7 days" does not fit on it and never did —
         * the count is the fact, the qualifier is the detail, and the detail is
         * one tap away inside the application that owns it.
         */
        count: stat ? stat.v : '',
        state: need?.sub ?? (need ? '' : 'not connected'),
        connected: !!need,
      }]
    })

  // ── SOURCES THAT HAVE SOMETHING TO SAY ────────────────────────────────────
  /**
   * A source becomes a CARD only when it is hot or warm.
   *
   * This is the other half of demoting the applications, and without it the
   * demotion would be a lie: six quiet source cards moved out of a lane and into
   * `background` would be the same six equal-weight launchers, one band lower.
   * A quiet mailbox has nothing to say, and its tile already says so.
   *
   * A hot source is `now` and a warm one is `next`, decided by `bandOf` from the
   * tone rather than here, so there is one table of these rules.
   */
  const sourceCards: HomeObject[] = all
    .filter((n) => (n.heat === 'hot' || n.heat === 'warm') && !dismissed.has(n.id))
    .flatMap((n) => {
      const app = SYSTEM_APPS.find((a) => a.src === n.id)
      if (!app || hidden.has(app.id)) return []
      const stat = n.stats?.[0]
      return [withBand({
        id: n.id,
        kind: 'source' as CardKind,
        title: app.label,
        line: n.sub,
        tone: heatTone(n),
        stateLabel: stat ? `${stat.v} · ${stat.l}` : n.heatLabel,
        needsUser: false,
        changed: n.heat === 'hot',
        opens: app.id,
        preview: previewOf(n.panes),
        need: n,
      })]
    })

  // ── WHAT HE SAVED ─────────────────────────────────────────────────────────
  // His, and persistent until he archives or deletes them. Nothing here expires.
  const userPanes: HomeObject[] = panes
    .filter((p) => (p.pinned !== null || saved.has(p.paneId)) && !archived.has(p.paneId))
    .map((p) => withBand({
      id: p.paneId,
      kind: 'pane' as CardKind,
      title: p.title,
      line: p.summary || p.intent,
      tone: (p.pendingRevisionId ? 'timeSensitive' : 'neutral') as StateTone,
      stateLabel: p.pinned === 'content' ? 'kept' : p.pinned === 'intent' ? 'standing' : 'saved',
      at: p.updatedAt,
      needsUser: !!p.pendingRevisionId,
      changed: !!p.pendingRevisionId,
      opens: p.paneId,
      preview: previewOf(p.panes),
      pane: p,
    }))

  // ── TASKS AND WATCHES ─────────────────────────────────────────────────────
  const taskPanes: HomeObject[] = panes
    .filter((p) => p.pinned === null && !saved.has(p.paneId) && !dismissed.has(p.paneId))
    .flatMap((p) => {
      const state = taskStateOf(p)
      // Completed work leaves Home once it has been seen; a terminal failure
      // gets a longer look but also leaves. Neither becomes furniture.
      if (state === 'completed' && expired(p.paneId, d, RETENTION.completed, now)) return []
      if (state === 'failedTerminal' && expired(p.paneId, d, RETENTION.failedTerminal, now)) return []
      return [withBand({
        id: p.paneId,
        kind: 'task' as CardKind,
        title: p.title || p.intent,
        line: p.summary || p.intent,
        tone: TASK_TONE[state],
        stateLabel: TASK_LABEL[state],
        at: p.updatedAt,
        needsUser: state === 'waiting' || state === 'blocked' || state === 'failedRetryable',
        changed: state === 'completed',
        opens: p.paneId,
        preview: previewOf(p.panes),
        task: { state, retryable: state !== 'failedTerminal' },
      })]
    })

  // Individual watches, projected from the SAME canonical objects Keep an Eye
  // renders. Stopping one there updates this immediately, because there is only
  // one of them.
  const watchItems: HomeObject[] = watchesOf(items)
    .filter((w) => w.active && !dismissed.has(w.id))
    .map((w) => withBand({
      id: w.id,
      kind: 'watch' as CardKind,
      title: w.what,
      line: w.state || w.why || 'watching',
      tone: (w.changedAt ? 'changed' : 'active') as StateTone,
      stateLabel: w.changedAt ? 'changed' : `every ${w.everyHours}h`,
      at: w.nextRunAt ?? w.lastRunAt ?? undefined,
      needsUser: false,
      changed: !!w.changedAt,
      opens: 'watch',
      watch: { state: w.active ? 'active' : 'stopped', everyHours: w.everyHours },
    }))

  // ── WHAT THE ATTENTION MODEL WORKED OUT ───────────────────────────────────
  /**
   * The cards that are the whole reason for the three bands.
   *
   * `need.band` comes from the server and is used verbatim — see the file
   * header for why the client must not re-derive it. A card with no band is
   * model prose, which gets `background`: a language model asked how urgent its
   * own output is answers "very", every time, so prose is not allowed to claim
   * the top of the screen.
   */
  const attention: HomeObject[] = items
    .flatMap((i) => (i.kind === 'synthesis' && 'need' in i && i.need ? [i.need] : []))
    .filter((n) => !dismissed.has(n.id) && !saved.has(n.id))
    /**
     * THE BAND HOLDS NO LIFETIME POLICY OF ITS OWN. IT OBEYS ONE.
     *
     * Three versions of this rule, and it is worth recording all three because
     * the first two each looked like the fix.
     *
     *   1. A flat 12-hour window on everything. Right for model prose — an
     *      insight nobody engaged with is not intelligence any more — and wrong
     *      for an obligation. A dinner on Wednesday does not stop mattering
     *      because he did not tap the card on Monday.
     *
     *   2. `standing: true` exempted computed cards from the window. That
     *      removed the wrong expiry and put nothing in its place, so a leave-by
     *      time for four o'clock was still on screen at midnight.
     *
     *   3. This. The server's attention model owns lifecycle — see
     *      `attention.ts`'s `Lifecycle` — and sends `expiresAt` when there is a
     *      clock and nothing when the expiry is not time-based.
     *
     * The 12-hour window survives for exactly what it was right for: a card a
     * model wrote, which carries no lifecycle because a model cannot honestly
     * assert one.
     */
    .filter((n) => {
      if (n.expiresAt) {
        const until = Date.parse(n.expiresAt)
        // A grace period is the server's business and is already inside
        // `expiresAt`. The client compares and nothing more.
        return !Number.isFinite(until) || now <= until
      }
      // No clock and server-owned: it leaves by not being sent again.
      if (n.standing) return true
      return !expired(n.id, d, RETENTION.insight, now)
    })
    .map((n) => ({
      id: n.id,
      lane: (n.band ?? 'background') as Band,
      kind: 'attention' as CardKind,
      title: n.title,
      line: n.sub,
      tone: heatTone(n),
      stateLabel: n.heatLabel,
      at: n.stats?.[0]?.v,
      needsUser: n.asks,
      changed: false,
      opens: n.id,
      preview: previewOf(n.panes),
      need: n,
    }))

  const everything = [...attention, ...sourceCards, ...userPanes, ...taskPanes, ...watchItems]
  const inBand = (b: Band) => rankBand(everything.filter((o) => o.lane === b), d)

  return { apps, now: inBand('now'), next: inBand('next'), background: inBand('background') }
}

/** Give an object its band, from the one table of rules. See `bandOf`. */
const withBand = (o: Omit<HomeObject, 'lane'>): HomeObject => ({ ...o, lane: bandOf(o) })

// ── ranking ──────────────────────────────────────────────────────────────────

/**
 * ONE RANKING, FOR ALL THREE BANDS.
 *
 * There used to be three — `rankPanes`, `rankTasks`, `rankInsights` — one per
 * lane, each with its own bands-within-the-lane, and between them they encoded
 * the same four ideas in three different orders. That was defensible while a
 * lane meant "kind of object", because a watch and a saved pane genuinely sort
 * differently. It is not defensible now: a band already means "how much this
 * deserves his attention", so within one band the only questions left are the
 * ones below, and they are the same questions whatever kind of thing it is.
 *
 * Freshness is a tie-breaker everywhere and a criterion nowhere. "Most recent"
 * as a primary sort is how a feed becomes a log.
 */
const recency = (o: HomeObject): number => {
  const t = Date.parse(o.at ?? '')
  return Number.isFinite(t) ? t : 0
}

/** How soon the thing it is about happens. Absent is "not about a moment". */
const imminence = (o: HomeObject, now: number): number => {
  const t = Date.parse(o.at ?? '')
  if (!Number.isFinite(t)) return Infinity
  return Math.abs(t - now)
}

function rankBand(list: HomeObject[], d: Durable, now = Date.now()): HomeObject[] {
  const pinned = new Set(d.pinnedPanes)
  return [...list].sort((a, b) => {
    // 1. Pinned by him. His arrangement outranks every judgement below it.
    const p = Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    if (p) return p
    // 2. Will not progress without him.
    const u = Number(b.needsUser) - Number(a.needsUser)
    if (u) return u
    // 3. What the attention model scored it, where it scored anything. A card
    //    with no score is not thereby last — it sorts on the clock, below.
    const sa = a.need?.score ?? null
    const sb = b.need?.score ?? null
    if (sa !== null && sb !== null && sa !== sb) return sb - sa
    // 4. New or changed since he looked.
    const c = Number(b.changed) - Number(a.changed)
    if (c) return c
    // 5. Nearest in time, in either direction — a thing an hour ago and a thing
    //    in an hour are both more pressing than a thing next week.
    const i = imminence(a, now) - imminence(b, now)
    if (Number.isFinite(i) && i) return i
    return recency(b) - recency(a)
  })
}

/**
 * THE ONE ALLOWED AUTOMATIC MOVE.
 *
 * Crucible may not silently change which card he is looking at. The single
 * exception is lifecycle: the object he was looking at genuinely ceased to
 * exist — it completed, expired, was deleted, or became ineligible. Leaving a
 * dead id selected would show him an empty band; jumping to card one on every
 * re-rank would be the agent driving his viewport. So: fall through to the
 * highest-ranked eligible replacement, and otherwise show the quiet empty state.
 *
 * This is cleanup, not navigation, and the renderer marks it with a restrained
 * transition so the substitution is understandable rather than startling.
 */
export function resolveVisible(ranked: HomeObject[], visibleId: string | null): { id: string | null; replaced: boolean } {
  if (!ranked.length) return { id: null, replaced: visibleId !== null }
  if (visibleId && ranked.some((o) => o.id === visibleId)) return { id: visibleId, replaced: false }
  return { id: ranked[0].id, replaced: visibleId !== null }
}
