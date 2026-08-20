import type { Pane } from './revisions.js'

/**
 * Which pane he meant.
 *
 * "Actually, three from 60 Minutes instead" names no pane. Neither does "change
 * the scary ones" or "the one above the Chase emails". Picking between "the
 * client sends focus" and "the model names an id" is a false choice: focus is
 * right for the pane he is looking at and wrong for one he scrolled past, and
 * an id is right for a UI action and useless for a sentence.
 *
 * So reference resolution is LAYERED, most explicit first, and the layers are
 * ordered by how much each one could be wrong about:
 *
 *   1. explicit      — a UI action carried the pane id. Not a guess.
 *   2. conversational— the model named a pane it is holding in the thread.
 *   3. focus         — the client says this is the current interaction target.
 *   4. semantic      — his description matches exactly one open pane.
 *   5. layout        — "above the Chase emails", resolved from what he can see.
 *   6. last-touched  — only when nothing else is plausible AND it is unambiguous.
 *   7. ask.
 *
 * IDS ARE MACHINE IDENTITY, NOT UX. Nothing here ever requires him to know,
 * name or read one. They exist so that a UI action and a model action can mean
 * the same pane with certainty; every path he actually speaks through is one of
 * the other five.
 */

export interface InteractionContext {
  /** A UI action carried this. The strongest signal there is. */
  explicitPaneId?: string
  /** The model named this from the conversation it is holding. */
  namedPaneId?: string
  /** What the client says he is interacting with. */
  focusedPaneId?: string
  /** On screen right now, in visual order, top first. */
  visiblePaneIds?: string[]
  /** Most recently touched first. Only consulted at the bottom of the ladder. */
  recentPaneIds?: string[]
}

/** A reference in his words, as the model compiled it. */
export interface PaneRef {
  /** What he called it: "the scary videos", "the Chase emails". */
  describes?: string
  /** A spatial relation to another described pane. */
  relative?: { of: string; where: 'above' | 'below' }
}

export type Resolution =
  | { kind: 'resolved'; paneId: string; how: How; confidence: number }
  | { kind: 'ambiguous'; candidates: { paneId: string; why: string }[] }
  | { kind: 'none'; why: string }

export type How = 'explicit' | 'conversational' | 'focus' | 'semantic' | 'layout' | 'last-touched'

/**
 * What each pane can be described BY.
 *
 * Its title, and the titles of the things currently in it — so "the scary
 * videos" can match a pane whose own title is "Tonight" because the items in it
 * are what he is describing. Supplied by the caller rather than read here,
 * because this file must not know how to render a pane.
 */
export interface PaneDescription {
  paneId: string
  title?: string
  /** Item titles, source names, anything he might reasonably call it. */
  terms: string[]
}

/**
 * How sure a layer is when it fires.
 *
 * Not decoration: `resolve` refuses to answer a high-consequence request below
 * a threshold, and a number is the only way to express "this is probably right"
 * without every caller re-deriving the same judgement.
 */
const CONFIDENCE: Record<How, number> = {
  explicit: 1,
  conversational: 0.95,
  focus: 0.85,
  semantic: 0.8,
  layout: 0.75,
  'last-touched': 0.5,
}

export interface ResolveOptions {
  /**
   * This request would change something he cannot easily get back.
   *
   * Ambiguity is then never resolved by guessing — the bottom two layers are
   * refused and he is asked instead. Refining a pane is cheap and recoverable
   * because the previous revision survives; closing panes or firing actions
   * off the back of one is not, and the difference has to be expressible.
   */
  consequential?: boolean
}

export function resolvePaneRef(
  ref: PaneRef | undefined,
  ctx: InteractionContext,
  panes: PaneDescription[],
  opts: ResolveOptions = {}
): Resolution {
  const known = new Set(panes.map((p) => p.paneId))
  const floor = opts.consequential ? 0.75 : 0

  const direct = (id: string | undefined, how: How): Resolution | null =>
    id && known.has(id) ? { kind: 'resolved', paneId: id, how, confidence: CONFIDENCE[how] } : null

  // 1–2. Nothing to infer: something already knows the answer.
  const explicit = direct(ctx.explicitPaneId, 'explicit') ?? direct(ctx.namedPaneId, 'conversational')
  if (explicit) return explicit

  // 5. Layout relations come before bare description, because "the pane above
  // the Chase emails" contains a description that would otherwise match the
  // Chase pane itself and confidently return the wrong neighbour.
  if (ref?.relative) {
    const anchor = matches(ref.relative.of, panes)
    if (anchor.length === 1) {
      const order = ctx.visiblePaneIds ?? panes.map((p) => p.paneId)
      const at = order.indexOf(anchor[0]!.paneId)
      const nextId = order[at + (ref.relative.where === 'above' ? -1 : 1)]
      if (at >= 0 && nextId && known.has(nextId)) {
        return { kind: 'resolved', paneId: nextId, how: 'layout', confidence: CONFIDENCE.layout }
      }
      return { kind: 'none', why: `There's nothing ${ref.relative.where} that one.` }
    }
    if (anchor.length > 1) {
      return { kind: 'ambiguous', candidates: anchor.map((p) => ({ paneId: p.paneId, why: p.title ?? p.terms[0] ?? '' })) }
    }
  }

  /**
   * 4. A description resolves when it matches exactly one pane.
   *
   * Checked BEFORE focus, deliberately. If he described something, he was
   * describing it — a description that matches exactly one pane on screen beats
   * whatever the client happens to have focused, because the description is the
   * more specific statement of intent. This is what makes "change the scary
   * videos" work when he is looking at a different pane.
   */
  if (ref?.describes) {
    const hits = matches(ref.describes, panes)
    if (hits.length === 1) {
      return { kind: 'resolved', paneId: hits[0]!.paneId, how: 'semantic', confidence: CONFIDENCE.semantic }
    }
    if (hits.length > 1) {
      // Narrow by what he can actually see before giving up on it.
      const visible = hits.filter((h) => ctx.visiblePaneIds?.includes(h.paneId))
      if (visible.length === 1) {
        return { kind: 'resolved', paneId: visible[0]!.paneId, how: 'semantic', confidence: CONFIDENCE.semantic }
      }
      return {
        kind: 'ambiguous',
        candidates: (visible.length ? visible : hits).map((p) => ({ paneId: p.paneId, why: p.title ?? p.terms[0] ?? '' })),
      }
    }
    // A description that matches nothing is not an invitation to use focus —
    // he named something, and the honest answer is that it is not here.
    if (!ctx.explicitPaneId) return { kind: 'none', why: `I can't find a pane you'd call "${ref.describes}".` }
  }

  // 3. No description, so the thing he is interacting with is the thing.
  const focused = direct(ctx.focusedPaneId, 'focus')
  if (focused) return focused

  /**
   * 6. Last-touched, and only when there is nothing to be ambiguous BETWEEN.
   *
   * "Immediately after creating a pane, 'make those three from 60 Minutes'
   * should need no clarification" is this layer doing its job. With several
   * panes recently touched it is a coin flip wearing a heuristic, so it
   * declines rather than guesses.
   */
  const recent = ctx.recentPaneIds?.filter((id) => known.has(id)) ?? []
  const mayGuess = CONFIDENCE['last-touched'] >= floor
  if (mayGuess && (recent.length === 1 || (recent.length > 1 && onlyOneIsFresh(recent, panes)))) {
    return { kind: 'resolved', paneId: recent[0]!, how: 'last-touched', confidence: CONFIDENCE['last-touched'] }
  }
  if (mayGuess && panes.length === 1) {
    return { kind: 'resolved', paneId: panes[0]!.paneId, how: 'last-touched', confidence: CONFIDENCE['last-touched'] }
  }
  /**
   * A consequential request that got this far is one this layer would have
   * guessed at. It says so rather than falling through to "I'm not sure",
   * because "which of these did you mean" is answerable and "I don't know" is
   * not.
   */
  if (!mayGuess && (recent.length || panes.length === 1)) {
    const candidates = (recent.length ? recent : [panes[0]!.paneId]).slice(0, 4)
    return {
      kind: 'ambiguous',
      candidates: candidates.map((id) => {
        const p = panes.find((x) => x.paneId === id)
        return { paneId: id, why: p?.title ?? p?.terms[0] ?? '' }
      }),
    }
  }

  if (recent.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: recent.slice(0, 4).map((id) => {
        const p = panes.find((x) => x.paneId === id)
        return { paneId: id, why: p?.title ?? p?.terms[0] ?? '' }
      }),
    }
  }
  return { kind: 'none', why: 'I’m not sure which pane you mean.' }
}

/**
 * Only the most recent counts as unambiguous.
 *
 * A deliberately conservative reading: the caller supplies `recentPaneIds`
 * most-recent-first, and this only fires when the runner-up is not also a
 * plausible target — which, without timestamps at this layer, means there is
 * exactly one candidate the description could have been about.
 */
function onlyOneIsFresh(recent: string[], panes: PaneDescription[]): boolean {
  return panes.filter((p) => recent.slice(0, 2).includes(p.paneId)).length === 1
}

/**
 * Does his phrase describe this pane?
 *
 * Word overlap against the title and the pane's own contents, requiring every
 * significant word to appear somewhere. Crude on purpose: this layer's job is
 * to be RIGHT when it fires and silent otherwise, and a fuzzy matcher that
 * returns a best guess would resolve "the scary videos" to the mail pane on a
 * quiet day. Anything cleverer is a model call, which is layer 2's job.
 */
function matches(phrase: string, panes: PaneDescription[]): PaneDescription[] {
  const words = significant(phrase)
  if (!words.length) return []

  /**
   * Score by how many of his words the pane actually contains, and return only
   * the panes that score highest.
   *
   * Requiring EVERY word was the obvious rule and the wrong one: "the scary
   * videos" contains a word no pane will ever literally hold, so a pane full of
   * horror films scored zero and the reference failed. Requiring ANY word is
   * worse — "the" aside, one incidental hit would resolve confidently to the
   * wrong pane. Highest-and-unique keeps the property that matters: this layer
   * either knows, or defers to the one below it. A tie is not a tiebreak, it is
   * a question, and it goes back to him as one.
   */
  const scored = panes.map((p) => {
    const hay = `${p.title ?? ''} ${p.terms.join(' ')}`.toLowerCase()
    return { pane: p, score: words.filter((w) => hay.includes(w)).length }
  })
  const best = Math.max(0, ...scored.map((s) => s.score))
  return best === 0 ? [] : scored.filter((s) => s.score === best).map((s) => s.pane)
}

/** Words that carry meaning. The rest match everything and mean nothing. */
const STOP = new Set([
  'the', 'a', 'an', 'that', 'those', 'these', 'this', 'my', 'me', 'i', 'one',
  'ones', 'pane', 'panes', 'card', 'cards', 'it', 'them', 'thing', 'things',
  'of', 'in', 'on', 'with', 'and', 'or', 'from', 'about', 'show', 'showing',
])

export function significant(phrase: string): string[] {
  return [...new Set(
    phrase
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  )]
}

/**
 * Describe panes so they can be referred to.
 *
 * Kept here beside the matcher, but fed by the caller: it is handed each pane's
 * title and the titles currently rendered in it. Nothing in this file reads a
 * widget, an object or a connector.
 */
export function describe(pane: Pane, terms: string[]): PaneDescription {
  return { paneId: pane.id, title: pane.title, terms: terms.filter(Boolean).slice(0, 40) }
}
