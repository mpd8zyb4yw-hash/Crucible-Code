import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { apply } from './reducer'
import {
  blankState, CAPABILITIES, OPERATIONS, TERMINAL, reconcileOperation,
  type OpFailure, type Operation,
  type SurfaceCommand, type SurfaceKind, type SurfaceObject, type SurfaceState,
} from './types'

/**
 * Where the live application state lives.
 *
 * Outside React on purpose. Two things need to reach it that are not in the
 * same component tree — the renderer that draws a surface and the conversation
 * that operates it — and threading a dispatch down through both would make the
 * chat's access to the calendar a property of where the calendar happens to be
 * mounted. Here, a surface is addressable by key from anywhere, which is what
 * "the model and I operate the same state" actually requires.
 *
 * Read synchronously at module load, so the first frame already knows which day
 * he was looking at and which three messages he had selected. Restoring that a
 * tick later would be a visible flicker on every single launch.
 */

const KEY = 'cru:surfaces'
const HISTORY_LIMIT = 60

interface Entry {
  key: string
  before: SurfaceState
  after: SurfaceState
  said: string
  by: 'me' | 'model'
}

let surfaces: Record<string, SurfaceState> = load()
/** Live, never persisted: what is on screen right now, published by renderers. */
const objects = new Map<string, SurfaceObject[]>()
const titles = new Map<string, string>()
let past: Entry[] = []
let future: Entry[] = []

const listeners = new Set<() => void>()
/** Bumped on every change; `useSyncExternalStore` compares this, not the object. */
let version = 0

function load(): Record<string, SurfaceState> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, SurfaceState>) : {}
  } catch {
    return {}
  }
}

function persist() {
  try {
    // Only surface state — never the objects. What is IN a pane belongs to the
    // pane's revision on the server; what he was DOING with it belongs here.
    localStorage.setItem(KEY, JSON.stringify(surfaces))
  } catch {
    /* private mode */
  }
}

function emit() {
  version++
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

const getVersion = () => version

/** Everything on screen for a surface, as its renderer last published it. */
export const objectsOf = (key: string): SurfaceObject[] => objects.get(key) ?? []

export function stateOf(key: string): SurfaceState | undefined {
  return surfaces[key]
}

/**
 * IS ANY SURFACE UNDER THIS SCREEN HOLDING A DRAFT?
 *
 * The shared composer lives one level above the surfaces — it is a row of the
 * workspace, not part of Mail — so it has to be able to ask whether the screen
 * it belongs to is in the middle of composing something. Scoped by owner, the
 * same prefix rule `lastIn` uses, so a draft in Mail cannot put a reply composer
 * under the Calendar.
 *
 * Returns the KEY as well as the draft, because writing back goes through
 * `put(key, …)` — the composer must not hold its own copy of the text, or there
 * would be two answers to "what will be sent".
 */
export function draftingIn(scope: string): { key: string; state: SurfaceState } | null {
  for (const [key, s] of Object.entries(surfaces)) {
    if (!key.startsWith(`${scope}#`)) continue
    if (s.draft) return { key, state: s }
  }
  return null
}

export function ensure(key: string, kind: SurfaceKind, seed?: Partial<SurfaceState>): SurfaceState {
  const existing = surfaces[key]
  // A surface whose KIND changed is a different surface wearing an old key —
  // the pane was refined into something else. Its old cursor and selection
  // would be meaningless, so it starts clean rather than half-restored.
  if (existing && existing.kind === kind) return existing
  const fresh = blankState(kind, seed)
  surfaces = { ...surfaces, [key]: fresh }
  persist()
  return fresh
}

/**
 * Run a command. The single door.
 *
 * `by` is recorded rather than acted on: a step he took and a step the model
 * took are undone by exactly the same operation, in the order they happened.
 * One history, or the undo button starts lying about what it will do.
 */
export function dispatch(key: string, cmd: SurfaceCommand, by: 'me' | 'model' = 'me'): { said: string; changed: boolean } {
  const before = surfaces[key]
  if (!before) return { said: 'That surface isn’t open.', changed: false }

  const r = apply(before, cmd, objectsOf(key))
  if (!r.changed) {
    // Still report it. A model that asked for something impossible must hear
    // so, or it will describe the change it did not make.
    surfaces = { ...surfaces, [key]: { ...before, note: r.said } }
    emit()
    return { said: r.said, changed: false }
  }

  /*
    A HIGHLIGHT IS NOT A CHANGE HE CAN UNDO, BECAUSE IT CHANGED NOTHING.

    `find 90 min` drew dashed regions on the timeline — which is the answer, and
    says it better than any sentence — and then offered `undo` beside a sentence
    repeating it. Undo of what? Nothing was created, moved or deleted; the only
    effect was which parts of the day are drawn lit. Pressing it un-lit them,
    which is what the `×` next to it already did.

    An undo control that appears after a no-op teaches the most expensive lesson
    this app can teach: that the button does not mean what it says. The next time
    it appears after something that really did mutate his calendar, he has
    already learned to ignore it.

    Same argument the file already makes twice — an operation changing phase is
    not a step he should be able to undo, and zooming the map left "Zoomed the
    map. undo" sitting on three unrelated screens. This is the third instance, so
    it is a list rather than another special case.
  */
  if (VIEW_ONLY.has(cmd.op)) {
    surfaces = { ...surfaces, [key]: r.state }
    persist()
    emit()
    return { said: r.said, changed: true }
  }

  past = [...past, { key, before, after: r.state, said: r.said, by }].slice(-HISTORY_LIMIT)
  future = []
  surfaces = { ...surfaces, [key]: r.state }
  persist()
  emit()
  return { said: r.said, changed: true }
}

/**
 * Operations that move the view and touch nothing in the world.
 *
 * The test for membership is exactly "would undoing this restore any fact?" —
 * not "is it cheap" and not "is it reversible". Selection, highlighting and
 * expansion are all states of looking; none of them is a thing that happened.
 *
 * THE LIST WAS SHORT BY MOST OF ITSELF, and using the app is what showed it.
 * Tapping a message printed
 *
 *     Opened Re: Odelia — Saturday.        undo   ✕
 *
 * because `mode` and `focus` were not in it. Undo of what? Nothing was created,
 * moved or deleted; a message was looked at. That is the fourth instance of
 * exactly the failure the comment above describes, and it appeared on the most
 * ordinary action in the whole application — which is worse than the three
 * before it, because it is the one he does every time.
 *
 * So the list is now derived from the rule instead of being extended a case at a
 * time. Every operation in `SurfaceOp` moves the view: switching a view, walking
 * dates, focusing, filtering, sorting, searching, panning a map, toggling a
 * series. `draft` is the single one that makes something — a reply that did not
 * exist before — and it is the single one that enters the history.
 *
 * `MUTATES` is written as the exception rather than `VIEW_ONLY` as the rule, and
 * that direction is chosen: a new operation added to the vocabulary is view-only
 * by omission, which fails towards a missing undo rather than towards an undo
 * that silently does nothing. `scripts/contract.mjs` fails the build if an
 * operation exists that is in neither set.
 */
export const MUTATES = new Set(['draft'])
const VIEW_ONLY = new Set(OPERATIONS.filter((op) => !MUTATES.has(op)))

/** Set state directly, from a human gesture that is not expressible as a command. */
export function put(key: string, patch: Partial<SurfaceState>, said: string, by: 'me' | 'model' = 'me') {
  const before = surfaces[key]
  if (!before) return
  const after = { ...before, ...patch, note: said || null }
  past = [...past, { key, before, after, said, by }].slice(-HISTORY_LIMIT)
  future = []
  surfaces = { ...surfaces, [key]: after }
  persist()
  emit()
}

/* ── Operation lifecycle ─────────────────────────────────────────────────── */

/**
 * Every async thing a surface does, run through one place.
 *
 * The failure this replaces: "Searching for scary stories." was a component's
 * own string with nothing obliged to ever clear it, so a request that never
 * came back left a sentence that looked like work forever. Here a non-terminal
 * status is not something a surface can be left in — the timeout below always
 * resolves it, whatever the caller does or fails to do.
 *
 * Set state directly rather than through `put`, because an operation changing
 * phase is not a step he should be able to undo.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/** In-flight cancels, by surface. A second request supersedes the first. */
const inflight = new Map<string, AbortController>()

let opSeq = 0

function setOp(key: string, op: Operation | null) {
  const before = surfaces[key]
  if (!before) return
  surfaces = { ...surfaces, [key]: { ...before, operation: op } }
  persist()
  emit()
}

export function operationOf(key: string): Operation | null {
  return surfaces[key]?.operation ?? null
}

/** Stop whatever this surface is doing, and say it was stopped. */
export function cancelOperation(key: string, why: OpFailure = 'cancelled') {
  const op = surfaces[key]?.operation
  inflight.get(key)?.abort()
  inflight.delete(key)
  if (!op || TERMINAL.has(op.status)) return
  setOp(key, {
    ...op,
    status: why === 'timeout' ? 'timedOut' : 'cancelled',
    failure: why,
    updatedAt: new Date().toISOString(),
    retryable: true,
    reason: why === 'timeout' ? 'It took too long, so I stopped waiting.' : 'Stopped.',
  })
}

export interface OpResult<T> {
  value?: T
  resultCount?: number
  /** Report a specific cause. Anything thrown without one is classified below. */
  failure?: OpFailure
  reason?: string
}

/**
 * Run one operation for a surface and guarantee it terminates.
 *
 * `run` receives an AbortSignal and a `partial` callback, so a provider that
 * streams can populate the surface before it finishes — `partial` is a real
 * status, not a spinner with a number next to it.
 */
export async function runOperation<T>(
  key: string,
  spec: { kind: string; provider?: string; phase?: string; timeoutMs?: number; cancellable?: boolean },
  run: (ctx: { signal: AbortSignal; partial: (n: number, phase?: string) => void }) => Promise<OpResult<T> | T>,
): Promise<OpResult<T> | null> {
  // A new request on a surface supersedes the one it replaces; two operations
  // writing one surface's results is how stale results overwrite fresh ones.
  inflight.get(key)?.abort()
  const ctrl = new AbortController()
  inflight.set(key, ctrl)

  const id = `op${++opSeq}-${Date.now().toString(36)}`
  const startedAt = new Date().toISOString()
  const base: Operation = {
    id,
    surfaceId: key,
    kind: spec.kind,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    provider: spec.provider,
    phase: spec.phase,
    cancellable: spec.cancellable ?? true,
  }
  setOp(key, base)

  const finish = (patch: Partial<Operation>) => {
    // Only the operation that is still current may write a terminal state. A
    // superseded request must not overwrite its replacement's result.
    if (surfaces[key]?.operation?.id !== id) return
    setOp(key, { ...base, ...patch, updatedAt: new Date().toISOString() })
  }

  const timer = setTimeout(() => {
    if (surfaces[key]?.operation?.id !== id) return
    ctrl.abort()
    finish({ status: 'timedOut', failure: 'timeout', retryable: true, reason: `${spec.provider ?? 'It'} did not answer in time.` })
  }, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const raw = await run({
      signal: ctrl.signal,
      partial: (n, phase) => {
        if (surfaces[key]?.operation?.id !== id) return
        setOp(key, { ...base, status: 'partial', resultCount: n, phase: phase ?? base.phase, updatedAt: new Date().toISOString() })
      },
    })
    clearTimeout(timer)
    const r = (raw && typeof raw === 'object' && ('value' in raw || 'failure' in raw || 'resultCount' in raw)
      ? raw
      : { value: raw }) as OpResult<T>
    if (r.failure) {
      finish({ status: 'failed', failure: r.failure, reason: r.reason, retryable: r.failure !== 'unsupported', resultCount: r.resultCount })
      return r
    }
    finish({ status: 'completed', resultCount: r.resultCount })
    return r
  } catch (e) {
    clearTimeout(timer)
    if (ctrl.signal.aborted) {
      // Either the timeout above already wrote a terminal state, or a newer
      // request replaced this one. Neither should be reported as a failure.
      if (surfaces[key]?.operation?.id === id) {
        finish({ status: 'cancelled', failure: 'cancelled', retryable: true, reason: 'Stopped.' })
      }
      return null
    }
    const f = classify(e)
    finish({ status: 'failed', failure: f.failure, reason: f.reason, retryable: f.failure !== 'unsupported' })
    return { failure: f.failure, reason: f.reason }
  } finally {
    if (inflight.get(key) === ctrl) inflight.delete(key)
  }
}

/**
 * Turn a thrown thing into a cause worth showing.
 *
 * The point is never to reach a generic message: "quota" tells him to wait,
 * "auth" tells him to reconnect, "network" tells him to retry. A single
 * "couldn't do that" collapses three different actions into none.
 */
function classify(e: unknown): { failure: OpFailure; reason: string } {
  const msg = String((e as Error)?.message ?? e ?? '')
  const s = msg.toLowerCase()
  const status = Number(/\b(\d{3})\b/.exec(msg)?.[1] ?? 0)
  if (status === 401 || status === 403 || /unauthor|forbidden|invalid_grant|token/.test(s)) {
    return { failure: 'auth', reason: 'That account needs reconnecting.' }
  }
  if (status === 429 || /quota|rate.?limit|exhaust/.test(s)) {
    return { failure: 'quota', reason: 'The daily quota for that is used up.' }
  }
  if (/abort|timeout|timed out/.test(s)) return { failure: 'timeout', reason: 'It took too long.' }
  if (/failed to fetch|network|offline|econn|enotfound|dns/.test(s)) {
    return { failure: 'network', reason: 'I couldn’t reach it — the connection looks down.' }
  }
  if (status >= 500) return { failure: 'provider', reason: 'The provider returned an error.' }
  return { failure: 'provider', reason: msg || 'It failed without saying why.' }
}

/**
 * Resolve operations stranded by a reload.
 *
 * A surface persisted mid-request would otherwise come back showing a spinner
 * that no longer has anything behind it — the exact "infinite loading after
 * restart" case. There is no way to resume a request whose promise died with
 * the page, so it is marked interrupted and offered as retryable, which is
 * both true and recoverable. Terminal states are left exactly as they were:
 * a completed search stays completed, a failure stays failed.
 */
function reconcileOperations() {
  let touched = false
  const next = { ...surfaces }
  for (const [k, s] of Object.entries(next)) {
    const op = s?.operation
    if (!op || TERMINAL.has(op.status)) continue
    next[k] = { ...s, operation: reconcileOperation(op) }
    touched = true
  }
  if (touched) {
    surfaces = next
    persist()
  }
}
reconcileOperations()

/**
 * UNDO THE LAST CHANGE TO THE SURFACE HE IS LOOKING AT.
 *
 * `scope` is a surface id; entries are keyed `${owner}#${paneIndex}`, so the
 * prefix identifies the screen. Without it this popped the GLOBAL top of the
 * stack, which is how zooming the map left "Zoomed the map. undo" sitting on
 * Home, on YouTube and on Activity — three screens offering to undo something
 * that had nothing to do with any of them, and one of them would have done it.
 *
 * Removing an entry from the middle of the stack is deliberate. These are
 * independent applications, not one document: the last thing that happened to
 * Mail is not made stale by something later happening to Maps, and "undo" on
 * Mail has exactly one honest meaning.
 */
export function undo(scope?: string): Entry | null {
  const at = scope
    ? past.map((e, i) => ({ e, i })).filter(({ e }) => e.key.startsWith(`${scope}#`)).pop()?.i ?? -1
    : past.length - 1
  const last = at >= 0 ? past[at] : null
  if (!last) return null
  past = [...past.slice(0, at), ...past.slice(at + 1)]
  future = [last, ...future].slice(0, HISTORY_LIMIT)
  surfaces = { ...surfaces, [last.key]: { ...last.before, note: `Undid: ${last.said}` } }
  persist()
  emit()
  return last
}

export function redo(): Entry | null {
  const nextUp = future[0]
  if (!nextUp) return null
  future = future.slice(1)
  past = [...past, nextUp].slice(-HISTORY_LIMIT)
  surfaces = { ...surfaces, [nextUp.key]: { ...nextUp.after, note: nextUp.said } }
  persist()
  emit()
  return nextUp
}

export const canUndo = () => past.length > 0
export const canRedo = () => future.length > 0
export const lastChange = () => past[past.length - 1] ?? null

/** Publish what a renderer is currently showing, so commands can name it. */
export function publish(key: string, title: string, objs: SurfaceObject[]) {
  const prev = objects.get(key)
  const same =
    prev?.length === objs.length && prev.every((o, i) => o.id === objs[i]?.id && o.label === objs[i]?.label)
  objects.set(key, objs)
  titles.set(key, title)
  const opened = takeArrival(key, objs)
  // Only wake anyone if the contents actually moved. Renderers publish on
  // every render, and notifying unconditionally would be an infinite loop.
  if (!same || opened) emit()
}

// ── Arriving on a specific object ────────────────────────────────────────────

/**
 * "Open Mail, on Invoice 4471."
 *
 * A Home card names one object and then used to open the application at the
 * top of a list of forty, leaving him to find by hand the thing the card had
 * just told him about. This is the missing half of that tap.
 *
 * It is a PENDING intent rather than a direct dispatch because the ordering is
 * genuinely uncertain: the surface's objects are published from an effect
 * after its first render, so at the moment the card is tapped there is nothing
 * yet to focus. Recording the intent and letting `publish` consume it means the
 * arrival happens exactly when the object actually exists — and never at all if
 * that pane turns out not to contain it, which is the honest outcome.
 *
 * Consumed once. A later refresh of the same surface must not silently yank him
 * back to a message he has already moved on from.
 */
const arriving = new Map<string, string>()

export function arriveAt(key: string, id: string | null | undefined) {
  if (id) arriving.set(key, id)
  else arriving.delete(key)
}

function takeArrival(key: string, objs: SurfaceObject[]): boolean {
  const want = arriving.get(key)
  if (!want) return false
  if (!objs.some((o) => o.id === want)) return false
  arriving.delete(key)
  const s = surfaces[key]
  if (!s) return false
  // Expanded AND focused: expansion is what makes it readable, focus is what
  // "the one you meant" refers to for a follow-up in chat.
  const at = objs.find((o) => o.id === want)?.at
  surfaces = {
    ...surfaces,
    [key]: {
      ...s,
      expanded: want,
      focus: want,
      /**
       * Move the period to the object's own day.
       *
       * Calendar draws whatever week its cursor is on. Focusing an event next
       * Thursday while the grid still shows this week opens a detail card for
       * something the grid behind it does not contain — a worse state than not
       * arriving at all. Only for surfaces that HAVE a cursor: `?? s.cursor`
       * leaves a mailbox untouched.
       */
      cursor: s.cursor !== null && at ? at.slice(0, 10) : s.cursor,
    },
  }
  persist()
  scrollTo(want)
  return true
}

/**
 * Bring the arrived-at object into view.
 *
 * Expanding an object he cannot see is only half of arriving: the fifth
 * message in a scroller is open, and off screen, which looks exactly like
 * nothing having happened. Done here rather than in each renderer because it
 * is one behaviour, and a surface only has to tag its rows with
 * `data-object` to get it.
 *
 * `block:'nearest'` deliberately — 'center' yanks a list that was already
 * showing the right row. Two frames of delay because the state change above
 * has not painted yet.
 */
function scrollTo(id: string) {
  if (typeof requestAnimationFrame !== 'function') return
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = document.querySelector(`[data-object="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }))
}

export function forget(key: string) {
  objects.delete(key)
  titles.delete(key)
  mountedDiag.delete(key)
}

// ── Diagnostics: which renderer is ACTUALLY mounted ──────────────────────────

/**
 * What is on screen, as opposed to what exists in the codebase.
 *
 * This exists to make one specific category error impossible to hide. A watch
 * called "Maps from Dervio to Tremenico", reporting "Opened Maps…", is a WATCH
 * surface whose subject and actions happen to reference Maps. It is not a Maps
 * surface, and no amount of the word "Maps" appearing in its content makes it
 * one. Reading a screenshot, the two are genuinely hard to tell apart; reading
 * this, they are not.
 *
 * So the fields are deliberately separated:
 *
 *   currentSurfaceKind  what renderer is mounted — the ONLY field that counts
 *                       as "this application's surface is present"
 *   rendererComponent   the component actually drawing it
 *   objectSourceKinds   applications the things ON this surface refer to
 *   actionTargetKinds   applications this surface's buttons would invoke
 *   linkedSurfaceKinds  the above, minus this surface — i.e. everything that
 *                       merely gets MENTIONED here
 *
 * An app name appearing anywhere but `currentSurfaceKind` is a reference, not
 * a renderer.
 */
export interface SurfaceDiag {
  surfaceKey: string
  currentSurfaceKind: SurfaceKind
  rendererComponent: string
  title: string
  objectCount: number
  objectSourceKinds: string[]
  actionTargetKinds: string[]
  linkedSurfaceKinds: string[]
}

const mountedDiag = new Map<string, Omit<SurfaceDiag, 'objectCount' | 'linkedSurfaceKinds'>>()

/** Called by the renderer dispatcher at mount. Never by a domain surface. */
export function registerDiag(d: Omit<SurfaceDiag, 'objectCount' | 'linkedSurfaceKinds'>) {
  mountedDiag.set(d.surfaceKey, d)
}

export function diagnostics(): SurfaceDiag[] {
  return [...mountedDiag.values()].map((d) => {
    const referenced = [...new Set([...d.objectSourceKinds, ...d.actionTargetKinds])]
    return {
      ...d,
      objectCount: objectsOf(d.surfaceKey).length,
      // A surface never "links to" itself; subtracting it is what stops a map
      // action inside a watch from reading as evidence of a map surface.
      linkedSurfaceKinds: referenced.filter((k) => k !== d.currentSurfaceKind),
    }
  })
}

// ── What the model is shown ──────────────────────────────────────────────────

export interface SurfaceSnapshot {
  key: string
  title: string
  kind: string
  state: {
    view: string
    cursor: string | null
    focus: string | null
    selected: string[]
    expanded: string | null
    query: string
    filters: Record<string, string | number | boolean>
    sort: string | null
    range: { from: string; to: string } | null
    hidden: string[]
    marks: number
    draft: boolean
  }
  can: string[]
  /** What is on screen, in order. Trimmed — this goes into a prompt. */
  showing: { id: string; label: string; sub?: string; at?: string; unread?: boolean; minutes?: number }[]
  total: number
}

/**
 * The state, as the model sees it.
 *
 * The same fields the renderer draws from, plus what is actually on screen and
 * what this surface can be asked to do. That last part is why the model does
 * not need connector-specific instructions: it is told, per surface, the
 * operations that surface declares, and anything else it tries is refused by
 * the reducer and reported back rather than silently dropped.
 */
export function snapshot(): SurfaceSnapshot[] {
  return Object.entries(surfaces)
    .filter(([key]) => objects.has(key))
    .map(([key, s]) => {
      const objs = objectsOf(key)
      return {
        key,
        title: titles.get(key) ?? key,
        kind: s.kind,
        state: {
          view: s.view,
          cursor: s.cursor,
          focus: s.focus,
          selected: s.selected,
          expanded: s.expanded,
          query: s.query,
          filters: s.filters,
          sort: s.sort,
          range: s.range,
          hidden: s.hidden,
          marks: s.marks.length,
          draft: !!s.draft,
        },
        can: (CAPABILITIES[s.kind] ?? []).map((c) => `${c.op}(${c.args ?? ''}) — ${c.says}`),
        showing: objs.slice(0, 40).map((o) => ({
          id: o.id,
          label: o.label.slice(0, 90),
          sub: o.sub?.slice(0, 60),
          at: o.at,
          unread: o.unread,
          minutes: o.seconds ? Math.round(o.seconds / 60) : undefined,
        })),
        total: objs.length,
      }
    })
}

// ── React ────────────────────────────────────────────────────────────────────

/**
 * The one history, subscribed to.
 *
 * A hook rather than a bare read because the undo control has to repaint the
 * moment anything happens — including something the model did while he was
 * looking at a different part of the screen. A non-reactive read would leave
 * the button offering to undo an operation two steps old.
 */
export function useHistory(): {
  canUndo: boolean
  canRedo: boolean
  last: Entry | null
  /** The last change to ONE surface. See `undo` for why this scoping exists. */
  lastIn: (scope: string) => Entry | null
} {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    last: past[past.length - 1] ?? null,
    lastIn: (scope) => [...past].reverse().find((e) => e.key.startsWith(`${scope}#`)) ?? null,
  }
}

export function useSurfaces(): Record<string, SurfaceState> {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return surfaces
}

/**
 * Read a surface's state without publishing anything.
 *
 * A renderer that filters its own contents has a chicken-and-egg problem: it
 * must know the filters before it can work out what is visible, and it must
 * know what is visible before it can publish. This is the first half. The
 * ordering matters — what gets published is the VISIBLE list, so "the third
 * one" means the third one he can actually see.
 */
export function useSurfaceState(key: string, kind: SurfaceKind, seed?: Partial<SurfaceState>): SurfaceState {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  return surfaces[key]?.kind === kind ? surfaces[key]! : ensure(key, kind, seed)
}

/**
 * Bind a renderer to its surface.
 *
 * Registers the state if it is new, publishes what is on screen, and hands back
 * a dispatch. The renderer never touches state directly — every control it
 * draws emits the same command a sentence would, which is what keeps the two
 * paths honestly identical rather than merely similar.
 */
export function useSurface(
  key: string,
  kind: SurfaceKind,
  title: string,
  objs: SurfaceObject[],
  seed?: Partial<SurfaceState>
): [SurfaceState, (cmd: SurfaceCommand) => void] {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  const state = surfaces[key]?.kind === kind ? surfaces[key]! : ensure(key, kind, seed)

  /**
   * Renderers hand a fresh array every render, so the effect keys off what is
   * IN it rather than its identity. Depending on the array itself would publish
   * on every render, and since publishing notifies, that is a loop.
   */
  const signature = objs.map((o) => o.id).join('')

  useEffect(() => {
    publish(key, title, objs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, title, signature])

  // Unregistering belongs to unmount alone. Doing it in the publish effect's
  // cleanup would delete the entry a moment before re-adding it, which makes
  // every render look like a change.
  useEffect(() => () => forget(key), [key])

  const send = useCallback((cmd: SurfaceCommand) => { dispatch(key, cmd, 'me') }, [key])
  return [state, send]
}
