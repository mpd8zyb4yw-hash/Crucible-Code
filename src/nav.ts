import type { FeedPane, Need, Widget } from './api'
import { SYSTEM_APPS, sourceIdFor } from './home/lanes'
import { contained } from './poison'

/**
 * NAVIGATION IS RESOLVED BEFORE IT IS COMMITTED.
 *
 * The blank screen had nothing to do with a crash. `App` rendered Home when
 * `view === null`, Settings when `view === 'settings'`, and a `Report` when the
 * feed happened to hold a `Need` with that id — and NOTHING AT ALL in every
 * other case. A Home card carries the id of the object it stands for, so any
 * card whose object was not also a `Need` in the same feed — a system app with
 * no connected source, a watch, a pane that expired between paint and tap —
 * tore Home down and put nothing in its place. Three divs of background
 * gradient, no content, and no way back but killing the app.
 *
 * That is a whole class of bug rather than one missing case, and it comes from
 * a structural mistake: navigation was a `setState`, and its consequences were
 * discovered later, in render, where the only thing left to do about them is
 * draw nothing.
 *
 * So navigation RESOLVES FIRST. `resolve()` is total — every input produces a
 * decision — and it is called before the view changes rather than after. A
 * target that cannot be built is a navigation that does not happen, and the
 * reason is said at the seam instead of being painted as an empty screen.
 *
 * Three rules follow, and they are the whole file:
 *
 *   · A SYSTEM APP ALWAYS OPENS ITS OWN APPLICATION. "Not connected" is a state
 *     OF Calendar, not a reason to have no Calendar. `systemNeed` builds the
 *     real renderer with an empty payload, so tapping Calendar mounts the
 *     calendar renderer whatever the feed happens to know.
 *   · ANYTHING ELSE THAT CANNOT RESOLVE LEAVES THE CURRENT SCREEN ALONE. The
 *     previous workspace is never unloaded before the next one proves mountable.
 *   · EVERY TRANSITION IS RECORDED with enough to explain a screenshot: the
 *     card tapped, what it resolved to, which renderer, and the build.
 */

export type Target =
  | { kind: 'home' }
  | { kind: 'settings' }
  | { kind: 'surface'; need: Need; renderer: string; source: 'feed' | 'pane' | 'system' }
  /** Nothing mountable. The caller keeps what is on screen and says why. */
  | { kind: 'unresolvable'; id: string; why: string }

/** The renderer each permanent application IS, whatever its data says. */
const SYSTEM_RENDERER: Record<string, Widget['kind']> = {
  calendar: 'calendar',
  mail: 'mail',
  places: 'map',
  video: 'video',
  fitness: 'fitness',
  watch: 'watch',
}

/** What each application says when it has nothing to show yet. */
const SYSTEM_EMPTY: Record<string, string> = {
  calendar: 'Nothing scheduled. Connect your calendar and this fills in.',
  mail: 'No mail yet. Connect Gmail and this fills in.',
  places: 'No places yet. Ask for a route, or search for somewhere.',
  video: 'Nothing new. Connect YouTube and this fills in.',
  fitness: 'No activity yet. Connect Google Fit and this fills in.',
  watch: 'Nothing being watched. Ask me to keep an eye on something.',
}

/** An empty payload of the right SHAPE, so the domain renderer still mounts. */
function emptyWidget(app: string): Widget {
  const empty = SYSTEM_EMPTY[app]
  switch (SYSTEM_RENDERER[app]) {
    case 'calendar': return { kind: 'calendar', events: [], view: 'week', empty }
    case 'mail': return { kind: 'mail', messages: [], empty }
    case 'video': return { kind: 'video', videos: [], empty }
    case 'fitness': return { kind: 'fitness', series: [], empty }
    case 'watch': return { kind: 'watch', watches: [], empty }
    default: return { kind: 'map', places: [], searchable: true }
  }
}

const blank = (id: string, title: string): Need => ({
  id, tier: 'quiet', heat: 'quiet', heatLabel: title.toLowerCase(),
  title, sub: '', status: '', opening: '', stats: null, chips: [],
  gauges: null, meter: null, glyph: null, accent: null, action: null,
  proposes: null, basis: [], asks: false, panes: [],
})

/**
 * A permanent application, with nothing in it.
 *
 * This is the difference between "Calendar has nothing today" and "Calendar
 * does not exist". The first is a fact about the day and belongs on screen; the
 * second is what the app used to show — an empty rectangle, indistinguishable
 * from a crash.
 */
export function systemNeed(app: string): Need | null {
  const meta = SYSTEM_APPS.find((a) => a.id === app)
  if (!meta || !SYSTEM_RENDERER[app]) return null
  return {
    ...blank(app, meta.label),
    sub: SYSTEM_EMPTY[app] ?? '',
    status: 'Nothing connected yet.',
    opening: 'Nothing here yet — connect it in settings and this fills in.',
    panes: [{ title: meta.label, widget: emptyWidget(app) }],
  }
}

/**
 * A pane, as the surface that opens it.
 *
 * `pinned === 'intent'` is a standing request rather than a kept result, and
 * that is the only thing that changes about how it is labelled. Everything
 * else — title, what it is showing, which revision — is the pane's own.
 */
export function paneNeed(p: FeedPane): Need {
  return {
    ...blank(p.paneId, p.title),
    heatLabel: p.pinned === 'intent' ? 'standing' : 'you asked for',
    sub: p.summary,
    status: p.intent && p.intent !== p.title ? p.intent : p.summary,
    opening: p.summary || 'Here it is.',
    panes: p.panes,
  }
}

/** Which renderer a need will actually mount, for the diagnostic record. */
export const rendererOf = (need: Need): string =>
  (need.panes ?? []).map((p) => p.widget?.kind).filter(Boolean).join('+') || 'none'

/**
 * THE TOTAL FUNCTION.
 *
 * Given a requested view and everything currently known, say what will be on
 * screen. There is no input for which this returns "nothing" — that case is
 * named `unresolvable` and the caller is obliged to handle it by keeping the
 * screen it already has.
 */
export function resolve(view: string | null, needs: Need[], panes: FeedPane[]): Target {
  /*
    Resolution is not a React render, so there is no boundary above it — a throw
    here would reach the app root and take everything. Contained explicitly, and
    the safe value is Home, which is the screen that is always mountable.
  */
  return contained('nav', () => resolveOrThrow(view, needs, panes), { kind: 'home' })
}

function resolveOrThrow(
  view: string | null,
  needs: Need[],
  panes: FeedPane[],
): Target {
  if (view === null) return { kind: 'home' }
  if (view === 'settings') return { kind: 'settings' }

  /**
   * Matched on BOTH vocabularies, because a view id and a feed need id are two
   * names for one object (see `SYSTEM_APPS`). This looked up the view id alone,
   * so a system app never once resolved to its live data and always fell
   * through to the empty placeholder below — the placeholder was hiding the
   * bug rather than covering a real absence.
   */
  const wanted = sourceIdFor(view)
  const fromFeed = needs.find((n) => n.id === view || n.id === wanted)
  if (fromFeed) {
    /**
     * A QUESTION HAS NOWHERE TO OPEN, AND SAYS SO INSTEAD OF OPENING NOWHERE.
     *
     * A clarification is a `Need` with `asks: true` and no panes, so it
     * satisfied every check here and mounted a `Report` around an empty frame:
     * a header, a blank application area and a composer. That is the screenshot
     * in the handoff, and it is the shape of the rule rather than one card's
     * bug — ANY need with nothing to render produces it.
     *
     * `unresolvable` is not a failure here, it is the correct answer: the
     * caller keeps the screen it has, which is Home, where the question is
     * already fully readable and answerable. See `home/QuestionCard.tsx`.
     */
    if (!(fromFeed.panes ?? []).length) {
      return {
        kind: 'unresolvable',
        id: view,
        why: fromFeed.asks
          ? 'That one is a question — answer it right there on the card.'
          : 'There is nothing to open for that one.',
      }
    }
    return { kind: 'surface', need: fromFeed, renderer: rendererOf(fromFeed), source: 'feed' }
  }

  const pane = panes.find((p) => p.paneId === view)
  if (pane) {
    const need = paneNeed(pane)
    return { kind: 'surface', need, renderer: rendererOf(need), source: 'pane' }
  }

  // A permanent application always opens, even with nothing behind it. This is
  // the case that produced the blank screen: six cards on Home whose ids were
  // only sometimes also feed needs.
  const system = systemNeed(view)
  if (system) return { kind: 'surface', need: system, renderer: rendererOf(system), source: 'system' }

  return {
    kind: 'unresolvable',
    id: view,
    // His words, not the machine's. He tapped something that has since gone.
    why: 'That isn’t here any more.',
  }
}

// ── diagnostics ──────────────────────────────────────────────────────────────

/**
 * Every transition, kept where a phone with no tooling can read it back:
 * `__cruNav()`.
 *
 * The point is to make a screenshot explainable after the fact. "I tapped a
 * card and got a black screen" is unanswerable; "card `places` resolved to
 * source=system renderer=map on build 8a40f95" is a bug report.
 */
export interface NavRecord {
  at: string
  /** The card he tapped, or 'back'. */
  from: string
  /** What it resolved to. */
  to: string
  target: Target['kind']
  renderer: string
  source: string
  build: unknown
  /** Set only when the transition was refused or recovered. */
  error?: string
}

const NAV_LOG = 'cru.nav'

export function recordNav(rec: Omit<NavRecord, 'at' | 'build'>) {
  try {
    const full: NavRecord = {
      ...rec,
      at: new Date().toISOString(),
      build: (window as unknown as { __cruBuild?: unknown }).__cruBuild,
    }
    const prior: NavRecord[] = JSON.parse(localStorage.getItem(NAV_LOG) ?? '[]')
    localStorage.setItem(NAV_LOG, JSON.stringify([full, ...prior].slice(0, 40)))
  } catch {
    // A navigation must not fail because its own audit trail could not be
    // written. Losing the record is acceptable; throwing from here is not.
  }
}

export function navLog(): NavRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_LOG) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
