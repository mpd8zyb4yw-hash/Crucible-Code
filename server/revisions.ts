import type { Plan, RefreshPolicy } from './ir.js'
import type { WidgetPane } from './widgets.js'

/**
 * Panes, and every state a pane has ever been in.
 *
 * The thing that makes a pane revisable is not undo. It is that "actually,
 * three from 60 Minutes instead" and "keep these, but find cheaper ones" are
 * two CHILDREN of the same state, and a linear history cannot hold both. So
 * this is a DAG: a revision names its parents, a pane names its head, and a
 * branch is an ordinary second child rather than a special case.
 *
 * A revision is an immutable SEMANTIC snapshot: exactly what he saw and exactly
 * what the system knew when he saw it. It is deliberately not a query to be
 * replayed. Sources move underneath us — a video is taken down, an email is
 * archived, a price changes — so replaying March's query in August compares the
 * wrong things and calls the difference history. Replay is how you make a NEW
 * revision, never how you read an old one.
 *
 * That is the semantic requirement. Physically, storing a fresh copy of five
 * hundred rendered items every time he nudges a pane is silly, so the rendered
 * body is content-addressed and shared: a refinement that keeps four of five
 * widgets stores one new blob and references four existing ones. Reconstruction
 * still yields an immutable snapshot — the sharing is invisible above this file,
 * which is the only way it stays safe to optimise further later.
 */

export type RevisionOp =
  /** The pane came into being. No parents. */
  | 'create'
  /** He changed what it should show. One parent. */
  | 'refine'
  /** The same plan, run again. One parent, and never destructive. */
  | 'refresh'
  /** A second child of a state that already had one. */
  | 'branch'
  /** A parameter turned without a model: "same thing, ten of them". */
  | 'reparameterise'

export interface Revision {
  id: string
  paneId: string
  /**
   * What this state came from. Empty for `create`.
   *
   * An array because a revision that merges two branches is expressible even
   * though nothing produces one yet — leaving it singular would have made
   * merging a schema change rather than a feature.
   */
  parents: string[]
  op: RevisionOp
  /** His words, when it was his doing. Empty for an automatic refresh. */
  intent: string
  /** The plan AS EXECUTED. Not a pointer to the pane's current plan. */
  plan: Plan
  /** The objects it resolved to, in the order shown. */
  refs: string[]
  /** Hashes of the rendered body. Resolved through `blobs` on read. */
  body: string[]
  /**
   * Provenance as OBSERVED, per ref, at the moment it was shown.
   *
   * Stored rather than recomputed, because "youtube · subscriptions · just now"
   * was true then and recomputing it in August would print a different sentence
   * under an identical snapshot. The label is part of what he saw.
   */
  observed: Record<string, string>
  at: string
  /** What ran it, when nobody asked: 'interval', 'on-open', 'on-change'. */
  by?: string
  /**
   * Whether the run behind this revision ACTUALLY ANSWERED.
   *
   * False means it retrieved nothing and reported a skip — the plan did not
   * run, as opposed to running and finding nothing. Both look identical in the
   * stored presentation (an empty widget), and conflating them is how "Show
   * route to Avano" became a permanent empty card on his home screen: a
   * transient routing failure, saved as a revision, is indistinguishable
   * afterwards from a route that legitimately has no result.
   *
   * Recorded rather than recomputed because it is a fact about the RUN, and the
   * run is over. Absent on revisions written before this existed, which are
   * treated as answered — an old pane that has been working is not retroactively
   * suspect.
   */
  answered?: boolean
}

/** A revision with its body reassembled. What everything above this file uses. */
export interface RevisionSnapshot extends Omit<Revision, 'body'> {
  presentation: WidgetPane[]
}

/**
 * Pinning: two different operations that look like one.
 *
 *   content — "keep exactly these five videos". The snapshot is the point.
 *             Refreshing finds new results and does NOT replace them; it offers.
 *   intent  — "always keep a pane here showing five good videos matching this".
 *             The query is the point, and refreshing is supposed to change it.
 *
 * Collapsing these into one boolean is what forces the false choice between a
 * pin that silently changes and a pin that goes stale forever.
 */
export interface Pin {
  mode: 'content' | 'intent'
  at: string
}

export interface Pane {
  /** Opaque and stable. Machine identity — he never sees it or types it. */
  id: string
  /** The revision currently on screen. */
  head: string
  /**
   * A revision produced while the head was pinned to content.
   *
   * The whole of "pinned-but-not-stale": the new results exist, are recoverable,
   * and are not on screen until he says so.
   */
  pending?: string
  title?: string
  pin?: Pin
  refresh: RefreshPolicy
  createdAt: string
  /** Last time anything happened to it — the input to last-touched addressing. */
  touchedAt: string
  lastRefreshedAt?: string
  /** Closed panes keep every revision. Reopening restores the exact head. */
  closed?: boolean
  /**
   * Every head this pane has had, oldest first.
   *
   * Undo is a move along this, not a deletion, which is why undo is itself
   * undoable and why closing and reopening restores the state he was actually
   * looking at rather than the newest thing that happened.
   */
  headLog: string[]
}

export interface RevisionDb {
  panes: Pane[]
  revisions: Revision[]
  /** hash → one rendered widget pane. Shared across every revision using it. */
  blobs: Record<string, WidgetPane>
}

export interface RevisionStore {
  read(): Promise<RevisionDb | null>
  write(db: RevisionDb): Promise<void>
}

const EMPTY: RevisionDb = { panes: [], revisions: [], blobs: {} }

let store: RevisionStore | null = null

export function setRevisionStore(s: RevisionStore): void {
  store = s
}

/**
 * Panes are state, not cache: without a store there are no panes at all.
 *
 * Deliberately unlike the object store, which degrades to "no thumbnails". A
 * pane he revised and pinned that silently failed to persist would be the worst
 * failure in the system, so it fails loudly instead.
 */
function need(): RevisionStore {
  if (!store) throw new Error('No revision store installed')
  return store
}

export function kvRevisionStore(kv: KVNamespace, key = 'panes'): RevisionStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as RevisionDb) : null
    },
    async write(db) {
      await kv.put(key, JSON.stringify(db))
    },
  }
}

async function read(): Promise<RevisionDb> {
  return (await need().read()) ?? { ...EMPTY }
}

// ── Content addressing ───────────────────────────────────────────────────────

/**
 * A stable hash of a rendered widget pane.
 *
 * Keys are sorted before hashing so two structurally identical panes built by
 * different code paths share one blob. `crypto.subtle` rather than node:crypto
 * because this file has to run at the edge as well as on the Mac.
 */
export async function hashOf(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stable(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stable(val)}`).join(',')}}`
}

/**
 * Drop blobs nothing points at any more.
 *
 * The only place anything is ever deleted, and it can only delete bodies that
 * no revision references — a revision itself is never removed, so no history is
 * reachable-but-collected.
 */
function collect(db: RevisionDb): RevisionDb {
  const live = new Set(db.revisions.flatMap((r) => r.body))
  const blobs: Record<string, WidgetPane> = {}
  for (const [h, b] of Object.entries(db.blobs)) if (live.has(h)) blobs[h] = b
  return { ...db, blobs }
}

// ── Ids ──────────────────────────────────────────────────────────────────────

/**
 * Ids are opaque and monotonic, not random.
 *
 * `Math.random` is unavailable in some hosts this runs in, and a counter tied
 * to the clock sorts correctly, which matters when reconstructing what order
 * two revisions in the same millisecond happened in.
 */
let seq = 0
function mint(prefix: string, at: number): string {
  seq = (seq + 1) % 4096
  return `${prefix}_${at.toString(36)}${seq.toString(36).padStart(3, '0')}`
}

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewRevision {
  op: RevisionOp
  intent?: string
  plan: Plan
  refs: string[]
  presentation: WidgetPane[]
  observed?: Record<string, string>
  by?: string
  /** See `Revision.answered`. Defaults to true for callers that cannot tell. */
  answered?: boolean
}

async function store_(db: RevisionDb, paneId: string, parents: string[], r: NewRevision, at: string): Promise<Revision> {
  const body: string[] = []
  for (const p of r.presentation) {
    const h = await hashOf(p)
    db.blobs[h] = p
    body.push(h)
  }
  const rev: Revision = {
    id: mint('rev', Date.parse(at)),
    paneId,
    parents,
    op: r.op,
    intent: r.intent ?? '',
    plan: r.plan,
    refs: r.refs,
    body,
    observed: r.observed ?? {},
    at,
    by: r.by,
    answered: r.answered ?? true,
  }
  db.revisions.push(rev)
  return rev
}

/** Bring a pane into being, at its first revision. */
export async function createPane(
  r: NewRevision,
  opts: { title?: string; pin?: Pin['mode']; refresh?: RefreshPolicy } = {}
): Promise<{ pane: Pane; revision: RevisionSnapshot }> {
  const db = await read()
  const at = new Date().toISOString()
  const paneId = mint('pane', Date.parse(at))
  const rev = await store_(db, paneId, [], r, at)
  const pane: Pane = {
    id: paneId,
    head: rev.id,
    title: opts.title,
    pin: opts.pin ? { mode: opts.pin, at } : undefined,
    refresh: opts.refresh ?? r.plan.refresh,
    createdAt: at,
    touchedAt: at,
    headLog: [rev.id],
  }
  db.panes.push(pane)
  await need().write(collect(db))
  return { pane, revision: hydrate(db, rev) }
}

/**
 * Add a revision to a pane.
 *
 * `from` decides the shape of the history: omitted, it extends the head;
 * naming an older revision creates a BRANCH, because two children of one state
 * is exactly what "keep these but find cheaper ones" means when he has already
 * said "make these shorter".
 *
 * Whether the new revision becomes what he sees is a separate question,
 * answered by the pin. That separation is the whole of the refresh problem:
 * refreshing always produces a revision, and only sometimes changes the screen.
 */
export async function addRevision(
  paneId: string,
  r: NewRevision,
  opts: { from?: string; advance?: boolean } = {}
): Promise<{ pane: Pane; revision: RevisionSnapshot } | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return null

  const parent = opts.from ?? pane.head
  if (!db.revisions.some((x) => x.id === parent)) return null

  const at = new Date().toISOString()
  const siblings = db.revisions.filter((x) => x.parents.includes(parent))
  const op: RevisionOp = r.op === 'refine' && siblings.length ? 'branch' : r.op
  const rev = await store_(db, paneId, [parent], { ...r, op }, at)

  /**
   * A content pin holds the screen; everything else advances.
   *
   * The refreshed result is not discarded and not hidden — it is a real
   * revision sitting in `pending`, so the pane can say "there are newer
   * results" and he can take them with one tap or never.
   */
  const pinned = pane.pin?.mode === 'content' && r.op === 'refresh'
  const advance = opts.advance ?? !pinned
  if (advance) {
    pane.head = rev.id
    pane.headLog.push(rev.id)
    pane.pending = undefined
  } else {
    pane.pending = rev.id
  }
  pane.touchedAt = at
  if (r.op === 'refresh') pane.lastRefreshedAt = at

  await need().write(collect(db))
  return { pane, revision: hydrate(db, rev) }
}

/** Take the pending revision — what "accept" on a pinned pane does. */
export async function acceptPending(paneId: string): Promise<Pane | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane?.pending) return null
  pane.head = pane.pending
  pane.headLog.push(pane.pending)
  pane.pending = undefined
  pane.touchedAt = new Date().toISOString()
  // Accepting new content means the old snapshot is no longer what he pinned.
  if (pane.pin?.mode === 'content') pane.pin = { mode: 'content', at: pane.touchedAt }
  await need().write(db)
  return pane
}

/**
 * Step the head back one, and forward again.
 *
 * A move along `headLog`, never a deletion: the revision undone is still there,
 * still addressable, still the parent of anything branched from it. Undoing an
 * undo is therefore the same operation in the other direction rather than a
 * second mechanism that has to agree with the first.
 */
export async function undo(paneId: string): Promise<{ pane: Pane; revision: RevisionSnapshot } | null> {
  return step(paneId, -1)
}

export async function redo(paneId: string): Promise<{ pane: Pane; revision: RevisionSnapshot } | null> {
  return step(paneId, +1)
}

async function step(paneId: string, dir: -1 | 1): Promise<{ pane: Pane; revision: RevisionSnapshot } | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return null
  const at = pane.headLog.lastIndexOf(pane.head)
  const next = pane.headLog[at + dir]
  if (at < 0 || next === undefined) return null
  pane.head = next
  pane.touchedAt = new Date().toISOString()
  await need().write(db)
  const rev = db.revisions.find((r) => r.id === next)
  return rev ? { pane, revision: hydrate(db, rev) } : null
}

export async function setPin(paneId: string, mode: Pin['mode'] | null): Promise<Pane | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return null
  const at = new Date().toISOString()
  pane.pin = mode ? { mode, at } : undefined
  pane.touchedAt = at
  await need().write(db)
  return pane
}

export async function setRefresh(paneId: string, policy: RefreshPolicy): Promise<Pane | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return null
  pane.refresh = policy
  pane.touchedAt = new Date().toISOString()
  await need().write(db)
  return pane
}

/**
 * Closing is not deleting.
 *
 * The pane keeps its head, its history and its pin, so reopening restores the
 * exact state he left rather than re-running anything. A pane he refined four
 * times and undid twice reopens two revisions back, which is where he was.
 */
export async function closePane(paneId: string, closed = true): Promise<Pane | null> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return null
  pane.closed = closed
  pane.touchedAt = new Date().toISOString()
  await need().write(db)
  return pane
}

// ── Reading ──────────────────────────────────────────────────────────────────

function hydrate(db: RevisionDb, rev: Revision): RevisionSnapshot {
  const { body, ...rest } = rev
  return { ...rest, presentation: body.flatMap((h) => (db.blobs[h] ? [db.blobs[h]!] : [])) }
}

export async function listPanes(opts: { includeClosed?: boolean } = {}): Promise<Pane[]> {
  const db = await read()
  return db.panes
    .filter((p) => opts.includeClosed || !p.closed)
    .sort((a, b) => b.touchedAt.localeCompare(a.touchedAt))
}

export async function getPane(paneId: string): Promise<Pane | undefined> {
  return (await read()).panes.find((p) => p.id === paneId)
}

export async function getRevision(revisionId: string): Promise<RevisionSnapshot | undefined> {
  const db = await read()
  const rev = db.revisions.find((r) => r.id === revisionId)
  return rev ? hydrate(db, rev) : undefined
}

/** The pane as it should currently render, plus what is waiting behind it. */
export async function headOf(
  paneId: string
): Promise<{ pane: Pane; revision: RevisionSnapshot; pending?: RevisionSnapshot } | undefined> {
  const db = await read()
  const pane = db.panes.find((p) => p.id === paneId)
  if (!pane) return undefined
  const rev = db.revisions.find((r) => r.id === pane.head)
  if (!rev) return undefined
  const pending = pane.pending ? db.revisions.find((r) => r.id === pane.pending) : undefined
  return { pane, revision: hydrate(db, rev), pending: pending ? hydrate(db, pending) : undefined }
}

/** Every revision of a pane, oldest first. The DAG, flattened for display. */
export async function historyOf(paneId: string): Promise<RevisionSnapshot[]> {
  const db = await read()
  return db.revisions.filter((r) => r.paneId === paneId).map((r) => hydrate(db, r))
}

/** The children of a revision. More than one means he branched here. */
export async function childrenOf(revisionId: string): Promise<RevisionSnapshot[]> {
  const db = await read()
  return db.revisions.filter((r) => r.parents.includes(revisionId)).map((r) => hydrate(db, r))
}

/**
 * What changed between two revisions.
 *
 * Compares two stored snapshots — never two replays. Comparing a replay against
 * a snapshot would attribute the source's own drift to his edit, which is the
 * specific mistake that makes replay-based history untrustworthy.
 */
export interface RevisionDiff {
  added: string[]
  removed: string[]
  kept: string[]
  reordered: boolean
  planChanged: boolean
  intent: { from: string; to: string }
}

export async function diff(fromId: string, toId: string): Promise<RevisionDiff | null> {
  const db = await read()
  const a = db.revisions.find((r) => r.id === fromId)
  const b = db.revisions.find((r) => r.id === toId)
  if (!a || !b) return null
  const before = new Set(a.refs)
  const after = new Set(b.refs)
  const kept = a.refs.filter((r) => after.has(r))
  return {
    added: b.refs.filter((r) => !before.has(r)),
    removed: a.refs.filter((r) => !after.has(r)),
    kept,
    reordered: kept.join() !== b.refs.filter((r) => before.has(r)).join(),
    planChanged: stable(a.plan) !== stable(b.plan),
    intent: { from: a.intent, to: b.intent },
  }
}

/**
 * Which panes are due to be re-run, by their own policy.
 *
 * Read-only and cheap, so the cron path can ask on every wake. A content-pinned
 * pane is still due — refreshing it produces a pending revision it can offer,
 * which is the difference between a pin and an abandonment.
 */
export async function dueForRefresh(now = Date.now()): Promise<Pane[]> {
  const db = await read()
  return db.panes.filter((p) => {
    if (p.closed) return false
    if (p.refresh.mode !== 'interval') return false
    const last = Date.parse(p.lastRefreshedAt ?? p.createdAt) || 0
    return now - last >= p.refresh.everyMs
  })
}

/** How much the sharing is actually saving. Measured, not asserted. */
export async function storageStats(): Promise<{ panes: number; revisions: number; blobs: number; bodyRefs: number }> {
  const db = await read()
  return {
    panes: db.panes.length,
    revisions: db.revisions.length,
    blobs: Object.keys(db.blobs).length,
    bodyRefs: db.revisions.reduce((n, r) => n + r.body.length, 0),
  }
}
