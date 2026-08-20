import type { InteractionContext, PaneRef, Resolution } from './addressing.js'
import { compile, compileLocally, type Compilation } from './compile.js'
import { answeredBy, type ExecuteOptions } from './execute.js'
import { classify, type Plan } from './ir.js'
import * as protocol from './protocol.js'
import { reconcile } from './shelf.js'

/**
 * One sentence in, one pane out.
 *
 * The whole slice, in the order the design says it happens: which pane he
 * meant → what he wants it to be → run it → keep the result without destroying
 * the old one. Every step already existed and was verified on its own; this is
 * the seam that lets him reach them by talking, and it lives here rather than
 * in a route handler because the Mac and the edge must do the identical thing.
 *
 * The interesting decisions are the two refusals.
 *
 * It refuses to guess which pane. If his words describe a pane and the
 * description fits two of them, the answer is a QUESTION, not the more recent
 * one. Refining is cheap and recoverable, so the bar is low — but "low" is not
 * "absent", and a system that silently rewrote the wrong pane would teach him
 * not to speak to it in the first place.
 *
 * It refuses to spend a model call it does not need. A refinement is compiled
 * against the plan it refines, so the model is asked for a change rather than
 * for a fresh guess at everything he already had. And where the instruction has
 * exactly one correct compilation, `compileLocally` produces it for nothing —
 * on a free tier, the difference between "my calendar" costing a call and
 * costing nothing is whether there is a call left when something hard arrives.
 */

export interface AskOptions extends ExecuteOptions {
  /** Which pane, if the client already knows: a UI action carried it. */
  paneId?: string
  /** Which pane, in his words. Resolved through the addressing ladder. */
  ref?: PaneRef
  ctx?: InteractionContext
  /** Extra facts his words assume. Short — it goes in the prompt. */
  context?: string
  /** Force a new pane even if his words could be read as a refinement. */
  fresh?: boolean
  /** Where a new pane should sit: on the splash, or opened on its own. */
  onShelf?: boolean
}

export type AskResult =
  | {
      kind: 'pane'
      /** 'create' when this made a new pane, 'refine' when it changed one. */
      op: 'create' | 'refine'
      paneId: string
      view: protocol.PaneView
      compiled: Compiled
      /** Nodes that could not run, with the reason. Never silent. */
      skipped: { op: string; why: string }[]
      usedModel: boolean
      cost?: number
    }
  /** His words matched more than one pane. The honest answer is to ask. */
  | { kind: 'ask'; question: string; resolution: Resolution }

export interface Compiled {
  intent: string
  planClass: string
  /** 'model' or 'local' — whether compiling this cost a call. Shown, not hidden. */
  by: 'model' | 'local'
  compiledBy?: { providerId: string; model: string }
  fellBackFrom: string[]
  /** Ops this build cannot execute. The plan keeps them; we say so. */
  unknown: string[]
  /** Parts of his instruction that could not be expressed, in his words. */
  unresolved: string[]
}

async function planFor(words: string, from: Plan | undefined, context: string | undefined): Promise<{ plan: Plan; compiled: Compiled }> {
  // A refinement is never compiled locally: the local compiler recognises whole
  // instructions, and "make it three" is not one. Handing it a fragment would
  // produce a confident plan for the wrong thing.
  const local = from ? null : compileLocally(words)
  if (local) {
    return {
      plan: local,
      compiled: { intent: words, planClass: classify(local), by: 'local', fellBackFrom: [], unknown: [], unresolved: [] },
    }
  }
  const c: Compilation = await compile(words, { from, context })
  return {
    plan: c.plan,
    compiled: {
      intent: words,
      planClass: c.planClass,
      by: 'model',
      compiledBy: c.compiledBy,
      fellBackFrom: c.fellBackFrom,
      unknown: c.unknown,
      unresolved: c.unresolved,
    },
  }
}

export async function ask(words: string, opts: AskOptions = {}): Promise<AskResult> {
  const instruction = words.trim()
  if (!instruction) throw new Error('Nothing to do.')

  const target = await whichPane(opts)
  if (target.kind === 'ask') return target

  const exec: ExecuteOptions = { auth: opts.auth, now: opts.now, offline: opts.offline }

  if (target.paneId) {
    const current = await protocol.open_(target.paneId)
    if (!current) throw new Error('That pane is gone.')
    const { plan, compiled } = await planFor(instruction, current.revision.plan, opts.context)
    const run = await protocol.refine(target.paneId, plan, exec)
    if (!run) throw new Error('That pane is gone.')
    return {
      kind: 'pane',
      op: 'refine',
      paneId: target.paneId,
      view: run.view,
      compiled,
      skipped: run.execution.skipped,
      usedModel: run.execution.usedModel,
      cost: run.execution.cost,
    }
  }

  const { plan, compiled } = await planFor(instruction, undefined, opts.context)
  const run = await protocol.open(plan, { ...exec, refresh: plan.refresh })
  const paneId = run.view.pane.id

  /**
   * A pane he asked for goes on the splash by default.
   *
   * That is the whole "auto-populates" behaviour, and it is one line because
   * the shelf reconciles against what exists rather than being told. Doing it
   * here rather than waiting for the next feed build means the pane has a
   * place — and therefore a position he can change — before he has finished
   * reading it.
   *
   * UNLESS THE RUN NEVER ACTUALLY RAN. "Show route to Avano" resolved nothing
   * and was shelved anyway, so an empty card saying "No route found" repainted
   * on his home screen on every load, for good — a transient network failure
   * promoted to a permanent fixture of his day. Two of them were sitting there.
   *
   * The line between the two cases is `skipped`, not emptiness. A run that
   * retrieved nothing and reported no skips is a TRUE empty answer — "no
   * flights under £200 today" is worth keeping and worth watching, and it will
   * fill itself in when one appears. A run that retrieved nothing and reported
   * a skip did not answer the question at all. He still sees it (the pane
   * exists, and the reason is on it); it just does not get a standing place on
   * the splash until a run of it succeeds.
   */
  if (opts.onShelf !== false && answeredBy(run.execution)) {
    await reconcile([{ id: paneId, kind: 'pane', label: run.view.pane.title || instruction }]).catch(() => null)
  }

  return {
    kind: 'pane',
    op: 'create',
    paneId,
    view: run.view,
    compiled,
    skipped: run.execution.skipped,
    usedModel: run.execution.usedModel,
    cost: run.execution.cost,
  }
}

/** Which pane this is about, or the question to ask instead. */
async function whichPane(opts: AskOptions): Promise<{ kind: 'pane'; paneId: string | null } | { kind: 'ask'; question: string; resolution: Resolution }> {
  if (opts.fresh) return { kind: 'pane', paneId: null }
  if (opts.paneId) return { kind: 'pane', paneId: opts.paneId }
  // No reference and no focus is a NEW pane, not a guess at the last one. The
  // addressing ladder's bottom rung exists for "change the scary ones", not for
  // an instruction that named nothing at all.
  if (!opts.ref && !opts.ctx?.explicitPaneId && !opts.ctx?.focusedPaneId) return { kind: 'pane', paneId: null }

  const r = await protocol.whichPane(opts.ref, opts.ctx ?? {})
  if (r.kind === 'resolved') return { kind: 'pane', paneId: r.paneId }
  if (r.kind === 'ambiguous') {
    return {
      kind: 'ask',
      question: `Which one — ${r.candidates.map((c) => c.why).join(', or ')}?`,
      resolution: r,
    }
  }
  // Nothing matched. A description that fits nothing is a new pane, which is
  // almost always what he meant: "videos for tonight" said to an empty screen.
  return { kind: 'pane', paneId: null }
}
