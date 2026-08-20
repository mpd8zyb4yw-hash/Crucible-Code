/**
 * The shared application state.
 *
 * The premise of this layer is that there is no human mode and no AI mode.
 * There is one live application state, and two things that drive it: his thumb
 * and the model. Both go through the same reducer, land in the same history,
 * and are undone by the same operation — which is why "open Tuesday" and
 * tapping Tuesday cannot diverge, and why he can take over from wherever the
 * model stopped.
 *
 * Everything a surface knows about itself lives in ONE shape. Not because a map
 * needs a `draft` or a mailbox needs a `viewport`, but because this object is
 * also what gets serialised to the model, and a per-kind union would mean a
 * per-kind serialiser, a per-kind prompt fragment and a per-kind reducer — three
 * places for calendar and mail to drift apart. Renderers read the fields they
 * care about and ignore the rest.
 */

export type SurfaceKind =
  | 'calendar' | 'mail' | 'video' | 'fitness' | 'watch' | 'map'
  | 'list' | 'agenda' | 'chart' | 'media' | 'detail' | 'compose'

/** A composed message that has not been sent. Visible, editable, never automatic. */
export interface Draft {
  to?: string
  subject?: string
  text: string
  /** Message id being replied to, when this is a reply. */
  replyTo?: string
  /** True when the model wrote it, so the UI can say so before he sends it. */
  byModel?: boolean
}

/**
 * WHICH JOB THE SURFACE IS DOING RIGHT NOW.
 *
 * The handoff's central rule (§2, §28, §42) is that a deeper interaction
 * REPLACES the current one rather than stacking a panel over it, and that rule
 * needs somewhere to live or every surface invents its own boolean. It is one
 * field, and the transitions are the whole state machine:
 *
 *     browse ──tap──▶ detail ──edit──▶ edit ──save/cancel──▶ detail ──✕──▶ browse
 *
 * `detail` is deliberately NOT a drawer. It is a compact contextual card that
 * shares the frame with the application underneath — what replaced the half
 * screen of metadata Calendar and Mail were both putting up. `edit` and `read`
 * genuinely take the frame, because in those the object IS the job.
 */
export type SurfaceMode = 'browse' | 'detail' | 'read' | 'edit'

export interface SurfaceState {
  kind: SurfaceKind
  /** 'month' | 'week' | 'day' for a calendar; 'grid' | 'list' elsewhere. */
  view: string
  /** What the surface is doing. See `SurfaceMode`. Absent means `browse`. */
  mode?: SurfaceMode
  /** The date a time-based surface is looking at, as YYYY-MM-DD. */
  cursor: string | null
  /** The one object with attention on it. Selection is plural; focus is not. */
  focus: string | null
  selected: string[]
  /** The object opened in place, showing its full body. */
  expanded: string | null
  query: string
  /** Narrowing, by whatever keys the renderer understands. */
  filters: Record<string, string | number | boolean>
  sort: string | null
  /** An explicit window, when the surface is showing a span rather than a day. */
  range: { from: string; to: string } | null
  viewport: { lat: number; lon: number; zoom: number } | null
  draft: Draft | null
  /** Series keys switched off — "hide sleep". */
  hidden: string[]
  /** A second thing to draw against the first: 'previous'. */
  compare: string | null
  /**
   * Ids the surface is calling out right now — candidate free windows, search
   * matches, the results of "which of these…". Distinct from selection, which
   * is his, and from focus, which is where he is.
   */
  marks: string[]
  /** One line about what the last operation did. Cleared by the next one. */
  note: string | null
  /**
   * The async work this surface has in flight, or how the last piece ended.
   *
   * Lives in surface state rather than in each renderer's own `busy` boolean,
   * because "Searching for scary stories." was a string in a component and a
   * separate sentence in the chat, and neither was a STATE that anything could
   * require to terminate. A surface may only be in one of the statuses below,
   * and every one of them except `requested`/`running` is terminal.
   */
  operation: Operation | null
}

/**
 * Why an operation ended the way it did. Never "something went wrong": the
 * difference between quota, auth and network is the difference between wait,
 * reconnect and retry, and only the surface knows which to offer.
 */
export type OpFailure =
  | 'auth' | 'quota' | 'network' | 'timeout' | 'provider'
  | 'unsupported' | 'model' | 'cancelled' | 'interrupted'

export type OpStatus =
  | 'requested' | 'running' | 'partial'
  | 'completed' | 'failed' | 'cancelled' | 'timedOut'

/** Statuses that are allowed to persist. Anything else must still resolve. */
export const TERMINAL: ReadonlySet<OpStatus> =
  new Set<OpStatus>(['completed', 'failed', 'cancelled', 'timedOut'])

/**
 * What a persisted operation becomes when the app restarts.
 *
 * Pure, and exported, so the rule is testable without a browser: a terminal
 * operation is returned untouched (a completed search stays completed, a
 * failure stays failed and retryable), and anything still in flight becomes
 * `cancelled/interrupted` — the promise behind it died with the page, so it is
 * not resumable, and leaving it `running` is precisely the infinite spinner
 * that survives a relaunch.
 */
export function reconcileOperation(op: Operation | null, now = new Date().toISOString()): Operation | null {
  if (!op || TERMINAL.has(op.status)) return op
  return {
    ...op,
    status: 'cancelled',
    failure: 'interrupted',
    retryable: true,
    reason: 'This was still running when the app closed.',
    updatedAt: now,
  }
}

export interface Operation {
  id: string
  surfaceId: string
  /** 'search' | 'route' | 'locate' | 'refresh' | … — what work this is. */
  kind: string
  status: OpStatus
  startedAt: string
  updatedAt: string
  /** Only where a count means something. Absent ≠ zero. */
  resultCount?: number
  /** Machine-readable cause, for choosing the recovery to offer. */
  failure?: OpFailure
  /** The same cause in his words. */
  reason?: string
  retryable?: boolean
  /** Who was asked — 'youtube', 'nominatim', 'osrm', a model id. */
  provider?: string
  /** Only when genuinely informative; not a fake progress bar. */
  phase?: string
  cancellable?: boolean
}

/**
 * The minimum a renderer publishes about what is on screen.
 *
 * This is what makes "open the Chase email" resolvable without the model ever
 * holding a message id: it names a MATCH, and the match is run here against the
 * objects actually rendered. A model that invents an id gets nothing; a model
 * that describes something on screen gets the right thing.
 */
export interface SurfaceObject {
  id: string
  label: string
  sub?: string
  /** ISO start for an event, ISO timestamp for anything else. */
  at?: string
  end?: string
  allDay?: boolean
  /** Runtime in seconds, where the thing has one. */
  seconds?: number
  unread?: boolean
  tags?: string[]
}

export type SurfaceOp =
  | 'setView' | 'navigate' | 'focus' | 'select' | 'deselect' | 'clearSelection'
  | 'expand' | 'collapse' | 'filter' | 'clearFilters' | 'search' | 'sort'
  | 'range' | 'viewport' | 'toggleSeries' | 'compare' | 'draft' | 'keepOnly'
  | 'findOpenings' | 'mark' | 'clear' | 'mode'

export interface SurfaceCommand {
  /** Which surface. Omitted by the model when only one is open. */
  surface?: string
  op: SurfaceOp
  args?: Record<string, unknown>
}

/**
 * What each kind of surface can be asked to do.
 *
 * Held as data because it is read by three different things that must agree:
 * the reducer (which refuses an op a surface does not declare), the renderer
 * (which draws only controls it actually supports) and the prompt (which is
 * generated from this table, so the model is never told about an operation that
 * does not exist). Adding a capability in one place adds it everywhere.
 */
export interface Capability {
  op: SurfaceOp
  /** For the prompt: what it does, in the fewest words that are still exact. */
  says: string
  /** Argument names, for the prompt. */
  args?: string
}

const COMMON: Capability[] = [
  { op: 'focus', says: 'put attention on one object', args: 'id | match' },
  { op: 'select', says: 'add to the selection', args: 'ids | match | all' },
  { op: 'deselect', says: 'remove from the selection', args: 'ids | match' },
  { op: 'clearSelection', says: 'select nothing' },
  { op: 'expand', says: 'open one object in place to show its detail', args: 'id | match' },
  { op: 'collapse', says: 'close the opened object' },
  { op: 'search', says: 'set the text query', args: 'query' },
  { op: 'clearFilters', says: 'drop every filter and the query' },
  { op: 'mark', says: 'call attention to objects without selecting them', args: 'ids | match' },
  /**
   * PUT THE SURFACE BACK TO NOTHING IN PARTICULAR.
   *
   * This was implemented in the reducer and declared nowhere, and `apply`
   * refuses any op a kind has not declared. So the three controls that send it
   * did nothing at all, silently: the ✕ on Calendar's opened event, the ✕ on a
   * focused place in Maps, and "back to mine" after a map search. An opened
   * event could not be closed by the control whose entire job is closing it.
   *
   * The refusal is not the bug — the refusal is correct and is what keeps the
   * model honest. The bug was a table and a reducer that were allowed to
   * disagree, which `scripts/contract.mjs` now fails the build over.
   */
  { op: 'clear', says: 'drop the selection, the focus, the query and every filter' },
]

export const CAPABILITIES: Record<string, Capability[]> = {
  calendar: [
    { op: 'setView', says: 'switch between month, week and day', args: 'view: month|week|day' },
    /**
     * The mode transition, declared so it exists for BOTH drivers.
     *
     * `scripts/contract.mjs` fails the build when the reducer and this table
     * disagree, and that guard is why editing had to be declared rather than
     * bolted into the renderer: an edit screen the model cannot open is an edit
     * screen he cannot ask for, and a control wired to an undeclared op is a
     * control that silently does nothing (see `clear`, which shipped that way).
     */
    { op: 'mode', says: 'open the focused event, edit it, or go back to the calendar', args: 'to: browse|detail|edit' },
    { op: 'navigate', says: 'move the visible dates', args: 'date | to: today|next|prev | delta days' },
    { op: 'findOpenings', says: 'find free windows of a given length and mark them', args: 'minutes, days' },
    { op: 'range', says: 'show an explicit span', args: 'from, to' },
    ...COMMON,
  ],
  mail: [
    { op: 'mode', says: 'read the focused message, or go back to the list', args: 'to: browse|read' },
    { op: 'filter', says: 'narrow the mailbox', args: 'unread: true | sender: text | label: text' },
    { op: 'sort', says: 'reorder', args: 'by: at|sender|subject, dir: asc|desc' },
    { op: 'draft', says: 'put a reply in the composer for him to read — never sends it', args: 'text, to, subject, replyTo' },
    ...COMMON,
  ],
  video: [
    /**
     * Minutes, not seconds.
     *
     * It was seconds, and "only ones over thirty minutes" reliably produced
     * `minSeconds: 30` — a filter for half a minute, which passes everything
     * and looks exactly like a filter that did not run. The unit people say
     * out loud is the unit the interface should take.
     */
    { op: 'filter', says: 'narrow the results', args: 'minMinutes, maxMinutes, channel' },
    { op: 'sort', says: 'reorder', args: 'by: at|duration|title, dir' },
    { op: 'keepOnly', says: 'keep these and drop the rest from view', args: 'ids | match' },
    { op: 'setView', says: 'switch between grid and list', args: 'view: grid|list' },
    ...COMMON,
  ],
  fitness: [
    { op: 'range', says: 'show a span of dates', args: 'from, to' },
    { op: 'navigate', says: 'move the window', args: 'to: today|next|prev' },
    { op: 'setView', says: 'switch the window', args: 'view: week|month' },
    { op: 'toggleSeries', says: 'show or hide one line', args: 'key, on' },
    { op: 'compare', says: 'draw the previous period behind this one', args: 'key: previous | null' },
    ...COMMON,
  ],
  watch: [
    { op: 'filter', says: 'narrow the dashboard', args: 'active: true|false, changed: true' },
    ...COMMON,
  ],
  map: [
    { op: 'viewport', says: 'move or zoom the map', args: 'lat, lon, zoom' },
    /**
     * No `filter` here, deliberately.
     *
     * "Only the ones open tonight" is the obvious next capability and it is not
     * declared, because nothing behind this surface knows opening hours —
     * Nominatim does not return them and no connector supplies them. Declaring
     * it would put a filter in the model's vocabulary that silently passes
     * everything, which reads as a working filter and is worse than a refusal.
     * When a source carries hours, the capability and the code arrive together.
     */
    ...COMMON,
  ],
  list: COMMON,
  agenda: COMMON,
  media: COMMON,
  chart: [],
  detail: [],
  compose: [],
}

/**
 * EVERY OPERATION ANY SURFACE ACTUALLY DECLARES, once.
 *
 * Derived from `CAPABILITIES` rather than written beside it, because that table
 * is already the authority three things agree through — the reducer, the
 * renderer and the prompt — and a fourth hand-maintained list of the same names
 * is a fourth thing that can drift. An operation nobody declares cannot be
 * dispatched at all (`apply` refuses it), so this is the whole reachable
 * vocabulary and not an approximation of it.
 *
 * Read by `store.ts` to decide which operations enter the undo history.
 */
export const OPERATIONS: SurfaceOp[] = [
  ...new Set(Object.values(CAPABILITIES).flatMap((caps) => caps.map((c) => c.op))),
]

export function blankState(kind: SurfaceKind, seed: Partial<SurfaceState> = {}): SurfaceState {
  return {
    kind,
    view: kind === 'calendar' ? 'week' : kind === 'video' ? 'grid' : kind === 'fitness' ? 'week' : 'list',
    mode: 'browse',
    cursor: null,
    focus: null,
    selected: [],
    expanded: null,
    query: '',
    filters: {},
    sort: null,
    range: null,
    viewport: null,
    draft: null,
    hidden: [],
    compare: null,
    marks: [],
    note: null,
    operation: null,
    ...seed,
  }
}
