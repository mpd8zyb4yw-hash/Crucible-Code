import {
  describe,
  resolvePaneRef,
  type InteractionContext,
  type PaneDescription,
  type PaneRef,
  type Resolution,
} from './addressing.js'
import { answeredBy, execute, type ExecuteOptions, type ExecutionResult } from './execute.js'
import { classify, describePlan, withParameter, type Plan, type RefreshPolicy } from './ir.js'
import {
  acceptPending,
  addRevision,
  childrenOf,
  closePane,
  createPane,
  diff,
  dueForRefresh,
  getPane,
  headOf,
  historyOf,
  listPanes,
  redo,
  setPin,
  setRefresh,
  undo,
  type Pane,
  type RevisionSnapshot,
} from './revisions.js'
import type { WidgetItem, WidgetPane } from './widgets.js'

/**
 * The pane protocol: one place where addressing, planning, execution and
 * revision meet.
 *
 * Each of those is a file that knows nothing about the others — `addressing`
 * has never heard of a plan, `ir` has never heard of a pane, `revisions` has
 * never heard of a connector. This is the seam, and it is deliberately thin:
 * every operation here is the same four steps in the same order.
 *
 *   which pane he meant  →  what he wants it to be  →  run it  →  keep the
 *   result as a new state, without destroying the old one
 *
 * The last of those is not negotiable and has no options. There is no code path
 * in this file that overwrites a revision, and refresh is not an exception —
 * it produces a revision like everything else, and whether that revision
 * reaches the screen is a question about the pin, asked later and separately.
 */

export interface PaneView {
  pane: Pane
  revision: RevisionSnapshot
  /** A refreshed result waiting behind a content pin. */
  pending?: RevisionSnapshot
  /** True when there is somewhere to go back to. */
  canUndo: boolean
  canRedo: boolean
  /** More than one child anywhere means this pane has branched. */
  branches: number
  /** 'deterministic' | 'parameterized' | 'model-required' | 'hybrid'. */
  planClass: ReturnType<typeof classify>
  /** What the plan does, in one line. For the history list, not for parsing. */
  summary: string
  /**
   * Has this pane EVER, in its whole history, produced anything?
   *
   * Asked of the history rather than the head because failing once is normal
   * and must not cost a pane its place — a working pane whose refresh times out
   * still has every earlier revision behind it. Never having worked at all is a
   * different condition, and it is the one worth acting on.
   *
   * Two panes in his store answered it `false`: "Show route to Avano" and
   * "Show route to Odelia", 11 and 3 revisions respectively, every one of them
   * with zero refs and an empty list reading "No route found". They had been
   * retried fourteen times across two days, produced nothing every time, and
   * repainted on his home screen on every load throughout.
   *
   * `refs.length > 0` is the retroactive half — proof that something was once
   * shown, and readable on revisions written long before any of this existed.
   * `answered === true` is the forward half, which additionally keeps a pane
   * that ran correctly and legitimately found nothing.
   */
  everAnswered: boolean
}

async function view(pane: Pane): Promise<PaneView | null> {
  const at = await headOf(pane.id)
  if (!at) return null
  const log = pane.headLog
  const i = log.lastIndexOf(pane.head)
  const kids = await Promise.all(log.map((r) => childrenOf(r)))
  const past = await historyOf(pane.id).catch(() => [])
  return {
    pane,
    revision: at.revision,
    pending: at.pending,
    canUndo: i > 0,
    canRedo: i >= 0 && i < log.length - 1,
    branches: kids.filter((k) => k.length > 1).length,
    planClass: classify(at.revision.plan),
    summary: describePlan(at.revision.plan),
    everAnswered: past.some((r) => r.refs.length > 0 || r.answered === true),
  }
}

// ── Addressing ───────────────────────────────────────────────────────────────

/**
 * What every open pane can be called.
 *
 * The terms are the titles currently rendered inside each pane, which is what
 * makes "the scary videos" resolvable when the pane's own title is "Tonight".
 * Reading them here rather than in `addressing.ts` keeps that file free of any
 * knowledge of widgets — it matches phrases against strings and nothing else.
 */
export async function paneDescriptions(): Promise<PaneDescription[]> {
  const panes = await listPanes()
  const out: PaneDescription[] = []
  for (const p of panes) {
    const at = await headOf(p.id)
    const terms = at ? itemsOf(at.revision.presentation).map((i) => i.title) : []
    const sources = at ? [...new Set(at.revision.refs.map((r) => r.split(':')[0]!))] : []
    out.push(describe(p, [...terms, ...sources, at?.revision.intent ?? '']))
  }
  return out
}

function itemsOf(panes: WidgetPane[]): WidgetItem[] {
  return panes.flatMap((p) => ('items' in p.widget && Array.isArray(p.widget.items) ? (p.widget.items as WidgetItem[]) : []))
}

/** Resolve a reference in his words to a pane, or say why it could not be. */
export async function whichPane(
  ref: PaneRef | undefined,
  ctx: InteractionContext,
  opts: { consequential?: boolean } = {}
): Promise<Resolution> {
  return resolvePaneRef(ref, ctx, await paneDescriptions(), opts)
}

// ── The operations ───────────────────────────────────────────────────────────

export interface RunResult {
  view: PaneView
  /**
   * The revision this run produced.
   *
   * Not the same thing as `view.revision`, and the difference is the point: on
   * a content-pinned pane the head does not move, so what he sees and what was
   * just produced are two different states. A caller that conflated them would
   * report a refreshed pane as unchanged.
   */
  created: RevisionSnapshot
  execution: ExecutionResult
}

/** A new pane, from a compiled plan. */
export async function open(
  plan: Plan,
  opts: { title?: string; pin?: 'content' | 'intent'; refresh?: RefreshPolicy } & ExecuteOptions = {}
): Promise<RunResult> {
  const run = await execute(plan, opts)
  const { pane, revision } = await createPane(
    { op: 'create', intent: plan.intent, plan, refs: run.refs, presentation: run.presentation, observed: run.observed, answered: answeredBy(run) },
    /**
     * A pane with no explicit title is named by what he ASKED FOR.
     *
     * Not cosmetic. A revision's `intent` is his words for the change that
     * produced it, and a refresh is nobody's words — its intent is empty by
     * design. So a caller reading the head revision to find a name gets his
     * sentence right up until the first refresh, and machine gibberish
     * afterwards ("gmail/inbox → sort:at → as list"), which is both ugly and a
     * quiet loss of the one field that says what the pane is FOR. Naming the
     * pane at creation puts it somewhere refreshing cannot reach.
     */
    { title: opts.title ?? plan.intent.slice(0, 80), pin: opts.pin, refresh: opts.refresh }
  )
  return { view: (await view(pane))!, created: revision, execution: { ...run, presentation: revision.presentation } }
}

/**
 * "Actually, three from 60 Minutes instead."
 *
 * A refinement is a new plan against the same pane. `from` names the state it
 * refines — omit it and it extends the head; pass an older revision and this is
 * a branch, which is how "keep these, but find cheaper ones" and "make these
 * shorter" become two children of one state rather than one overwriting the
 * other.
 */
export async function refine(
  paneId: string,
  plan: Plan,
  opts: { from?: string } & ExecuteOptions = {}
): Promise<RunResult | null> {
  const run = await execute(plan, opts)
  const added = await addRevision(
    paneId,
    { op: 'refine', intent: plan.intent, plan, refs: run.refs, presentation: run.presentation, observed: run.observed, answered: answeredBy(run) },
    { from: opts.from }
  )
  if (!added) return null
  return { view: (await view(added.pane))!, created: added.revision, execution: { ...run, presentation: added.revision.presentation } }
}

/**
 * "Same thing, but ten of them." No model, no re-planning.
 *
 * The parameterised case the IR exists for: turning a knob on the stored plan
 * and re-executing it. Free wherever the plan was deterministic, and it keeps
 * his original instruction attached — the pane still knows it was asked for
 * "videos I'd like tonight", not for `limit=10`.
 */
export async function reparameterise(
  paneId: string,
  edits: { path: string; value: unknown }[],
  opts: ExecuteOptions = {}
): Promise<RunResult | null> {
  const at = await headOf(paneId)
  if (!at) return null
  const plan = edits.reduce((p, e) => withParameter(p, e.path, e.value), at.revision.plan)
  const run = await execute(plan, opts)
  const added = await addRevision(paneId, {
    op: 'reparameterise',
    intent: at.revision.intent,
    plan,
    refs: run.refs,
    presentation: run.presentation,
    observed: run.observed,
    answered: answeredBy(run),
  })
  if (!added) return null
  return { view: (await view(added.pane))!, created: added.revision, execution: { ...run, presentation: added.revision.presentation } }
}

/**
 * Run the pane's own plan again.
 *
 * Always produces a revision. On an ordinary pane it becomes what he sees; on
 * a content-pinned pane it waits in `pending` and the pane says so. Neither
 * case loses anything: the previous revision is still the parent of this one
 * and still reachable, so even an unattended interval refresh at four in the
 * morning is recoverable rather than a silent replacement.
 */
export async function refresh(
  paneId: string,
  opts: { by?: string } & ExecuteOptions = {}
): Promise<RunResult | null> {
  const at = await headOf(paneId)
  if (!at) return null
  const run = await execute(at.revision.plan, opts)
  const added = await addRevision(paneId, {
    op: 'refresh',
    intent: '',
    plan: at.revision.plan,
    refs: run.refs,
    presentation: run.presentation,
    observed: run.observed,
    by: opts.by ?? 'manual',
    answered: answeredBy(run),
  })
  if (!added) return null
  return { view: (await view(added.pane))!, created: added.revision, execution: { ...run, presentation: added.revision.presentation } }
}

/** Every pane whose interval has come round. The cron path's one question. */
export async function refreshDue(opts: ExecuteOptions = {}): Promise<{ paneId: string; ok: boolean }[]> {
  const due = await dueForRefresh()
  const out: { paneId: string; ok: boolean }[] = []
  for (const p of due) {
    const r = await refresh(p.id, { ...opts, by: 'interval' }).catch(() => null)
    out.push({ paneId: p.id, ok: !!r })
  }
  return out
}

// ── State he controls ────────────────────────────────────────────────────────

export async function stepBack(paneId: string): Promise<PaneView | null> {
  const r = await undo(paneId)
  return r ? view(r.pane) : null
}

export async function stepForward(paneId: string): Promise<PaneView | null> {
  const r = await redo(paneId)
  return r ? view(r.pane) : null
}

export async function accept(paneId: string): Promise<PaneView | null> {
  const p = await acceptPending(paneId)
  return p ? view(p) : null
}

export async function pin(paneId: string, mode: 'content' | 'intent' | null): Promise<PaneView | null> {
  const p = await setPin(paneId, mode)
  return p ? view(p) : null
}

export async function schedule(paneId: string, policy: RefreshPolicy): Promise<PaneView | null> {
  const p = await setRefresh(paneId, policy)
  return p ? view(p) : null
}

export async function close(paneId: string): Promise<PaneView | null> {
  const p = await closePane(paneId, true)
  return p ? view(p) : null
}

/**
 * Reopen exactly where he left it.
 *
 * Nothing is re-executed. The head is whatever it was — including two undos
 * back, if that is where he stopped — and the body comes out of the same
 * content-addressed blobs it was stored in. That is what makes "close and
 * reopen recovers exact state" a property of the storage rather than a promise
 * about the network.
 */
export async function reopen(paneId: string): Promise<PaneView | null> {
  const p = await closePane(paneId, false)
  return p ? view(p) : null
}

export async function open_(paneId: string): Promise<PaneView | null> {
  const p = await getPane(paneId)
  return p ? view(p) : null
}

export async function all(includeClosed = false): Promise<PaneView[]> {
  const panes = await listPanes({ includeClosed })
  const out: PaneView[] = []
  for (const p of panes) {
    const v = await view(p)
    if (v) out.push(v)
  }
  return out
}

export async function history(paneId: string): Promise<RevisionSnapshot[]> {
  return historyOf(paneId)
}

/** What changed between two states. Two snapshots — never a replay. */
export async function compare(fromId: string, toId: string) {
  return diff(fromId, toId)
}

/**
 * Open a pane on opening the app, if its policy says so.
 *
 * Separate from `refreshDue` because "on-open" is a different question from
 * "interval": one is about him arriving, the other about the clock, and
 * conflating them means a pane he has not looked at in a week refreshes as
 * though he were standing in front of it.
 */
export async function refreshOnOpen(paneId: string, opts: ExecuteOptions = {}): Promise<RunResult | null> {
  const p = await getPane(paneId)
  if (p?.refresh.mode !== 'on-open') return null
  return refresh(paneId, { ...opts, by: 'on-open' })
}
