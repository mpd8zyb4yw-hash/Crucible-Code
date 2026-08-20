import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { css } from './css'
import {
  listProviders, say, enablePush,
  getFeed, refreshFeed, refreshPane, askFor, leaveByFor, judgeIntelligence,
  syncIfDue, revisionOf,
  type Feed, type IntelligencePresentation, type Need, type WidgetAction,
} from './api'
import Home from './Home'
import { AboveKeyboard, ViewportShell } from './ViewportShell'
import { useViewport } from './viewport'
import { Boundary } from './Boundary'
import { Diagnostics, wantsDiagnostics } from './Diagnostics'
import { recordNav, resolve, type Target } from './nav'
import { contained } from './poison'
import { safeText } from './safeText'
import Report, { type Msg } from './Report'
import Settings from './Settings'
import {
  cancelOperation, ensure, operationOf, runOperation, undo as undoSurface, useHistory,
} from './surface/store'
import { contextFor } from './context'
import { classify } from './task/intent'
import { SurfaceStatus } from './SurfaceStatus'
import { runCommands, type Run } from './surface/run'
import { cache, mark, measure, report } from './surface/timing'
import { ChatOverlay, asksForRoom, asksForSettings, type Snap } from './home/ChatOverlay'
import { InterruptLayer, isCritical, type CriticalInterrupt } from './home/Interrupt'
import { IntelligenceDepth } from './home/Intelligence'
import {
  canUndoHome, lastHomeAction, reconcileHome, setChatSnap, undoHome, useHomeState,
} from './home/homeState'
import { sourceIdFor } from './home/lanes'
import {
  answer, resumeInstruction, resolveSlots, restates, suggestionsFor, suspend,
  TASK_SLOTS, type KnownWorld, type SuspendedTask,
} from './task/resolve'

type View = string | null

/**
 * The last feed this browser saw.
 *
 * Painted synchronously on mount, before any request goes out, so a reload
 * shows his actual home screen rather than an empty one that fills in a second
 * later. It is explicitly a CACHE and is labelled as one on screen ("as of…")
 * until a live build replaces it — the failure this guards against is not a
 * slow app, it is an app that confidently shows yesterday.
 */
const CACHE = 'cru:feed'

/**
 * Hydration runs before ANYTHING has painted, so a throw here is the one
 * failure that produces a blank document with no boundary having rendered yet.
 * Contained, with "no cache" as the safe value — a cold start is a slower first
 * paint; a throw is no first paint.
 */
function cachedFeed(): Feed | null {
  return contained('hydrate', () => {
    const raw = localStorage.getItem(CACHE)
    return raw ? (JSON.parse(raw) as Feed) : null
  }, null)
}

/**
 * IS THIS SCREEN SHOWING YESTERDAY — and nothing else about how old it is.
 *
 * This was `staleLabel`, and it returned two completely different things down
 * one channel: `'yesterday'`, which is a correctness warning, and `asOf(f.at)`
 * — "14:20", "Tue" — which is a timestamp. The status row then printed either as
 * `as of <x>`, so most of the time Home carried a clock.
 *
 * `docs/ui-contract.md` forbids exactly that, by name: "Nothing on Home restates
 * the phone. No date, no day name, no clock, no town, no 'as of' stamp." The
 * decision log records it settled against "a context row with date, place and
 * 'as of'". It came back not as a reversal but as the else-branch of the warning,
 * which is the way every rule in that file has been broken so far.
 *
 * The warning itself is NOT chrome and is kept. `staleDay` means the model's
 * cards were written before the day turned over, and a screen quietly showing
 * yesterday's day-bound cards under today's deck is the worst thing this app can
 * do. So the signal survives and the clock does not — which is why this returns
 * a boolean: a caller cannot render a time it was never given.
 *
 * Still gated on synthesis being on screen. The source rows are re-derived from
 * the stored world on every read and are current to the millisecond; only the
 * model's cards can be old, so a feed with no synthesis in it is not stale.
 */
function showingYesterday(f: Feed | null): boolean {
  if (!f) return false
  if (!f.items.some((i) => i.kind === 'synthesis')) return false
  return !!f.staleDay
}

/**
 * Room the collapsed composer needs at the bottom of Home, until it says.
 *
 * A STARTING VALUE, not a fact. It was a fixed 70 — correct in Chromium, two
 * pixels short in Safari, where the pill renders taller — so the status line
 * and the composer touched on his phone and only on his phone. The composer
 * measures itself and reports up (`onComposerHeight`); this is what Home uses
 * for the single frame before that arrives.
 */
const COMPOSER_RESERVE = 70

/**
 * Clear air between the last thing Home draws and the composer.
 *
 * Two pixels is not separation, it is a near miss — and it was the near miss
 * that put "undo" through the top of the composer pill. Nothing in this app is
 * allowed to be one font metric away from overlapping.
 */
const COMPOSER_CLEARANCE = 10

/** Unresolved work, which survives a launch. Conversation does not. */
const TASKS = 'cru:tasks'

/**
 * A FAILED REQUEST, AS A TURN HE CAN READ.
 *
 * One place, because both chat paths had the same bug and would otherwise have
 * to be fixed identically twice — which is how one of them ends up not being.
 */
function failureTurn(e: unknown): Msg {
  const api = e as { userMessage?: string; retryable?: boolean }
  return {
    who: 'ai',
    text: api?.userMessage || 'I couldn’t get an answer just now.',
    failed: true,
    retryable: api?.retryable !== false,
  }
}

export default function App() {
  const [view, setView] = useState<View>(null)
  const { local } = useHomeState()
  /**
   * CONVERSATIONS LIVE AS LONG AS THE SESSION, AND NO LONGER.
   *
   * They used to be written to `cru:threads` and restored on every launch,
   * forever. That is the wrong abstraction wearing the word "memory": a chat
   * bubble is not a fact. What deserves to outlive a launch is what was LEARNED
   * — facts, preferences, corrections, people, commitments — and all of that
   * already lives in the world model and the memory core, typed and
   * correctable. The transcript was a second, untyped, uncorrectable copy of
   * some of it, plus a great deal of noise, plus — because failures were
   * appended as assistant turns — a permanent record of every network blip the
   * app had ever had. Opening Crucible on Tuesday and being greeted by
   * Monday's "HTTP 503" is the failure this removes.
   *
   * Within a session they still outlive the cards they were opened from, which
   * is what the persistence was originally added for: synthesis mints new card
   * ids every pass, so a reply used to orphan the thread it came from. That is
   * a same-session problem and this is a same-session store.
   */
  const [threads, setThreads] = useState<Record<string, Msg[]>>({})
  const history = useHistory()
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState<Record<string, string>>({})
  const note = useCallback((id: string, text: string) => {
    setNotes((p) => ({ ...p, [id]: text }))
  }, [])
  const [hasBrain, setHasBrain] = useState<boolean | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [result, setResult] = useState<Feed | null>(() => {
    const f = cachedFeed()
    cache(f ? 'hit' : 'miss')
    return f
  })
  // `fromCache` used to live here: initialised true and never once written, so
  // every feed — including one built a moment ago — was treated as cached. It
  // only ever looked right because `asOf` returns nothing under ninety seconds.
  // Staleness is a property of the feed, so it is read off the feed.
  const [thinking, setThinking] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<{ run: Run; step: string } | null>(null)
  /**
   * The task that is waiting on one answer.
   *
   * Typed state, not a sentence in the transcript: his next message fills the
   * blocking slot and THIS task resumes, so he never has to say the original
   * instruction twice. See task/resolve.ts.
   */
  /**
   * THE ONE THING THAT DOES SURVIVE A LAUNCH: WORK STILL WAITING ON HIM.
   *
   * A suspended task is not conversation. It is a request he made that could not
   * finish because exactly one thing was missing, and it is still true tomorrow
   * — so closing the app and coming back should find it waiting rather than
   * silently dropped. What is stored is the task: its kind, its instruction, the
   * slots resolved so far and the question it is blocked on. Not the bubbles
   * around it.
   *
   * This is the distinction the old `cru:threads` could not make. It kept every
   * word and no state; this keeps the state and none of the words.
   */
  const [pending, setPending] = useState<Record<string, SuspendedTask>>(
    () => contained('hydrate', () => JSON.parse(localStorage.getItem(TASKS) ?? '{}'), {}),
  )

  useEffect(() => {
    try { localStorage.setItem(TASKS, JSON.stringify(pending)) } catch { /* private mode */ }
  }, [pending])
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  /** The question the composer is currently answering, if he chose to type one. */
  const [answering, setAnswering] = useState<Need | null>(null)

  /**
   * THE INTELLIGENCE CARD, OPENED.
   *
   * Held here rather than routed through `resolve`, and the difference matters:
   * `resolve` maps a view id onto a need or a pane, and a presentation is
   * neither — it is an object already in hand, compiled before the screen
   * changed. That is precisely the "no blank navigation destination" condition
   * the contract asks for, satisfied structurally: there is no id to look up and
   * therefore no lookup that can come back empty.
   */
  const [depth, setDepth] = useState<IntelligencePresentation | null>(null)
  /** `/#diag` — the on-device geometry readout. See Diagnostics.tsx. */
  const [diag, setDiag] = useState(wantsDiagnostics)
  /** What the collapsed composer actually measures. See COMPOSER_RESERVE. */
  const [composerH, setComposerH] = useState(COMPOSER_RESERVE)
  const inFlight = useRef(false)
  const askedPush = useRef(false)
  const landedLive = useRef(false)

  useEffect(() => {
    const onHash = () => setDiag(wantsDiagnostics())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /**
   * `#/open/<id>` — A NAVIGATION THAT COSTS NO SCREEN.
   *
   * Home no longer carries an application launcher, and the objection to
   * removing one is real: a quiet mailbox has no card, so how is it reached? Two
   * ways, and neither of them is a row of tiles. The composer already resolves
   * "open mail". This is the other: a URL, which is free, bookmarkable, works
   * from a Home Screen shortcut, and is what the harness drives instead of a
   * tile it can no longer tap.
   *
   * It goes through `openView`, so it obeys the same resolution rules as a card
   * tap — an id that cannot mount leaves the screen alone and says why, rather
   * than opening a blank frame because it arrived from the address bar.
   */
  useEffect(() => {
    const onOpenHash = () => {
      const m = /^#\/open\/(.+)$/.exec(window.location.hash)
      if (!m) return
      // Cleared first: the hash is an instruction, not a location, and leaving
      // it set would re-fire it on every later `hashchange`.
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      openViewRef.current?.(decodeURIComponent(m[1]!))
    }
    onOpenHash()
    window.addEventListener('hashchange', onOpenHash)
    return () => window.removeEventListener('hashchange', onOpenHash)
  }, [])

  /*
    THE OLD TRANSCRIPT STORE, REMOVED FROM DEVICES THAT ALREADY HAVE ONE.

    Not leaving it: it is his conversation history sitting in localStorage on a
    phone, it will never be read again, and "unused data we decided to keep" is
    the shape of every privacy incident. One line, once, on launch.
  */
  useEffect(() => {
    try { localStorage.removeItem('cru:threads') } catch { /* private mode */ }
  }, [])

  useEffect(() => {
    mark('shell')
    const f = cachedFeed()
    if (f) mark('persisted')
    if (f?.items?.length) mark('useful')
  }, [])

  /** Durable Home state: paint from the local mirror, reconcile after. */
  useEffect(() => { void reconcileHome() }, [])

  /**
   * LAND A FEED, UNLESS SOMETHING NEWER IS ALREADY ON SCREEN.
   *
   * A cold launch puts three requests in the air within a second — the cached
   * read, the live build, and the sync-if-due — and a phone does not return
   * them in the order it sent them. Whoever answered last used to win, so a slow
   * older build could land on top of a fast newer one and put stale events back
   * on Home with nothing anywhere saying so.
   *
   * `landedLive` was the only guard and it only covered one direction: cached
   * must not overwrite live. It said nothing about live-vs-live, which is the
   * case that actually reorders.
   *
   * So the comparison is now on the server's own monotonic `revision`, and it is
   * a strict `>`: an equal revision is the SAME BUILD arriving twice, and
   * re-landing it would throw away nothing but would also mean the cache write
   * and the paint happen for no reason.
   */
  const landedRevision = useRef(0)

  const land = useCallback((feed: Feed, cached: boolean) => {
    const rev = revisionOf(feed)
    if (rev <= landedRevision.current) return
    landedRevision.current = rev
    if (!cached) landedLive.current = true
    setResult(feed)
    if (feed.items.length) mark('useful')
    if (!cached) {
      mark('fresh')
      report()
    }
    try { localStorage.setItem(CACHE, JSON.stringify(feed)) } catch { /* private mode */ }
  }, [])

  const reconsider = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setThinking(true)
    setError(null)
    const began = performance.now()
    try {
      const feed = await getFeed()
      measure('connectorMs', performance.now() - began)
      land(feed, false)
      if (!askedPush.current) {
        askedPush.current = true
        void enablePush()
      }
    } catch (e) {
      try {
        const r = await refreshFeed()
        land(r.feed, false)
        setError(null)
      } catch {
        setError((e as Error).message)
      }
    } finally {
      measure('refreshMs', performance.now() - began)
      setThinking(false)
      inFlight.current = false
    }
  }, [land])

  const checkBrain = useCallback(async () => {
    try {
      const r = await listProviders()
      setNeedsSignIn(false)
      const ok = r.providers.some((p) => p.configured)
      setHasBrain(ok)
      if (ok) void reconsider()
      else refreshFeed().then((x) => land(x.feed, false)).catch(() => {})
    } catch (e) {
      if (/not signed in/i.test((e as Error).message)) setNeedsSignIn(true)
      setHasBrain(false)
    }
  }, [reconsider, land])

  useEffect(() => { void checkBrain() }, [checkBrain])

  useEffect(() => {
    let alive = true
    getFeed({ cached: true })
      .then((f) => { if (alive && !landedLive.current) land(f, true) })
      .catch(() => {})
    return () => { alive = false }
  }, [land])

  /**
   * ARRIVING IS ITSELF A REASON TO GO AND LOOK.
   *
   * The missing half of "it is current when he opens it". The cached paint above
   * is instant and is made of whatever the last pass stored; nothing then went
   * and asked the connectors whether any of it had changed, so the only way to
   * make Calendar true was to OPEN Calendar — the domain fetched on arrival and
   * Home did not. That is the app asking him to do its job.
   *
   * Fired once per launch, after the cached paint rather than before it, so the
   * first frame is never waiting on a network. The server decides whether this
   * costs a connector call at all; with everything fresh it is one comparison
   * and the same feed comes back, which `land` then declines as not newer.
   */
  useEffect(() => {
    let alive = true
    syncIfDue()
      .then((r) => { if (alive && r.feed) land(r.feed, false) })
      .catch(() => { /* a sync that will not run costs freshness, never a screen */ })
    return () => { alive = false }
  }, [land])

  /**
   * COMING BACK, AND STAYING.
   *
   * This used to reconsider only if the FEED was more than ten minutes old,
   * which asked the wrong question twice over. The feed's age says nothing
   * about its sources' age — a feed rebuilt sixty seconds ago over three-hour-
   * old mail is fresh by that test and wrong on screen — and `reconsider()` runs
   * a full synthesis, which is far too expensive to attach to every foreground.
   *
   * So returning to the app asks the cheap question instead: is any SOURCE
   * overdue. The server answers it, and answers "no" for free.
   *
   * The interval is the other half. He leaves this open on a desk; without it,
   * an app that has been visible for an hour is an hour stale and only a tab
   * switch would fix it. Ninety seconds is chosen against the shortest cadence
   * in `sync.ts` (five minutes) — often enough that a source is never much past
   * its ceiling, rare enough that the no-op case is genuinely idle. The server
   * gates the actual work either way, so this cannot become a quota problem.
   */
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return
      syncIfDue()
        .then((r) => { if (r.feed) land(r.feed, false) })
        .catch(() => {})
    }
    document.addEventListener('visibilitychange', check)
    const timer = setInterval(check, 90_000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      clearInterval(timer)
    }
  }, [land])

  const needs = useMemo(() => result?.needs ?? [], [result])
  const items = useMemo(() => result?.items ?? [], [result])
  const yesterday = useMemo(() => showingYesterday(result), [result])

  /**
   * A CRITICAL INTERRUPT.
   *
   * Recognised by kind against a closed list, never by a producer asserting its
   * own importance. Routine notifications may not use this precedence; if
   * anything could opt in, everything eventually would, and the layer that is
   * allowed to sit above chat would become the layer everything sits in.
   */
  const interrupt: CriticalInterrupt | null = useMemo(() => {
    const n = needs.find((x) => isCritical(x.id) && !acknowledged.has(x.id))
    return n ? { id: n.id, title: n.title, detail: n.sub || n.status } : null
  }, [needs, acknowledged])

  const panes = useMemo(() => items.flatMap((i) => ('pane' in i && i.pane ? [i.pane] : [])), [items])

  /**
   * WHAT IS ON SCREEN, resolved rather than discovered.
   *
   * `resolve` is total: there is no `view` for which this is undefined, which
   * is the property that makes a blank viewport unreachable. The old code
   * looked the id up in `needs`, fell back to a pane, and rendered nothing at
   * all when neither matched — so a system app with no connected source tore
   * Home down and put a background gradient in its place. See nav.ts.
   */
  const target: Target = useMemo(() => resolve(view, needs, panes), [view, needs, panes])

  /**
   * LAST KNOWN GOOD.
   *
   * A view can stop being resolvable while it is open — a task pane expires, a
   * refresh drops the need it was built from. That must return him to Home, not
   * unmount everything, so the recovery happens here rather than being left to
   * a render that has nothing to draw.
   */
  useEffect(() => {
    if (target.kind !== 'unresolvable') return
    recordNav({ from: target.id, to: 'home', target: 'home', renderer: 'none', source: 'recovery', error: target.why })
    setView(null)
    setError(target.why)
  }, [target])

  /**
   * The object he tapped INSIDE a card, if he tapped one.
   *
   * A card preview shows the application's own objects, so a tap on a row is a
   * tap on that object and the app must open ON it. The need carries a `focus`
   * chosen by the server for the card as a whole; this overrides it for exactly
   * one navigation, and is cleared the moment the view changes — a stale focus
   * silently reappearing on a later visit would be the app deciding what he is
   * looking at.
   */
  const [focusOverride, setFocusOverride] = useState<string | null>(null)

  const open = useMemo(() => {
    if (target.kind !== 'surface') return null
    return focusOverride ? { ...target.need, focus: focusOverride } : target.need
  }, [target, focusOverride])

  /**
   * A CARD TAP, VALIDATED BEFORE IT COSTS HIM THE SCREEN.
   *
   * The target is built while Home is still mounted. Only a target that
   * resolved is committed, so there is never a frame in which Home has gone and
   * nothing has arrived — which was the other half of the blank screen, and the
   * half that no amount of error boundary would have caught, because nothing
   * threw.
   */
  const openView = useCallback((id: string, focus?: string) => {
    const next = id === 'notice-brain' ? 'settings' : id
    const t = resolve(next, needs, panes)
    if (t.kind === 'unresolvable') {
      recordNav({ from: id, to: 'home', target: 'unresolvable', renderer: 'none', source: 'refused', error: t.why })
      setError(t.why)
      return
    }
    recordNav({
      from: id,
      to: next,
      target: t.kind,
      renderer: t.kind === 'surface' ? t.renderer : t.kind,
      source: t.kind === 'surface' ? t.source : t.kind,
    })
    setError(null)
    setFocusOverride(focus ?? null)
    setView(next)
  }, [needs, panes])

  /**
   * The current `openView`, for the hash listener.
   *
   * The listener is installed once, on mount, and `openView` is rebuilt whenever
   * the feed changes. Closing over the first one would resolve every deep link
   * against an empty feed — which is the "it opened the placeholder instead of
   * my mail" failure, arriving by a new route.
   */
  const openViewRef = useRef<((id: string, focus?: string) => void) | null>(null)
  openViewRef.current = openView

  /** A row inside a card. Same navigation, landing on that object. */
  const openObject = useCallback(
    (app: string, objectId: string) => openView(app, objectId),
    [openView],
  )

  /**
   * What the resolution ladder is allowed to read before it asks him anything.
   *
   * Assembled from the canonical objects already in hand — calendar events, mail
   * threads, saved places, watches. This is the difference between answering
   * "route to lunch with Odelia" and asking which restaurant while the event
   * naming the address is on screen.
   */
  /*
    ONE DERIVATION, TWO READERS.

    This used to be assembled here, by hand, from the feed's panes — a second
    copy of what `snapshot()` already publishes to the model, with one enormous
    difference nobody had noticed: it had no notion of ATTENTION. Every object
    was equally "on screen", so the focused event and a thing three cards down
    were indistinguishable, and `stated` was a literal `{}` — the empty object,
    passed to a ladder whose whole job is to look before it asks.

    `contextFor` derives both shapes from the same traversal, adds the ranks,
    and includes Home, which `snapshot()` structurally cannot. See context.ts.
  */
  const ctx = useMemo(
    () => contextFor({ open, feed: result, stated: result?.known ?? {} }),
    [open, result],
  )
  const world: KnownWorld = ctx.world

  const snap: Snap = local.chat

  /**
   * Anything he says — typed, or tapped as a suggestion.
   *
   * Three things happen before it is sent, in this order, and the order is the
   * design:
   *
   *   · a task waiting on an answer takes it, and RESUMES — his reply is a slot
   *     value, not a new request;
   *   · an explicit request for more room moves the panel, because Max is his to
   *     enter and the model's to never touch;
   *   · otherwise the ladder resolves what it can and only then, if something
   *     genuinely blocks, does anything get asked.
   */
  const onSay = async (id: string, text: string) => {
    if (running) { running.run.cancel(); setRunning(null) }

    setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'me', text }] }))

    if (id === 'home') {
      /*
        "SETTINGS" OPENS SETTINGS, and it is the only discoverable way in.

        The other one is a 500ms press on the send arrow with nothing on screen
        saying so. Handled here, before the model sees it, for the same reason
        `asksForRoom` is: this is a navigation request with an exact answer, and
        routing it through a language model would make the app's own settings
        screen something it might or might not find, depending on quota.

        It returns rather than falling through, so the request does not also
        arrive as a question — the screen he asked for is the whole reply.
      */
      if (asksForSettings(text)) {
        setThreads((p) => ({ ...p, home: [...(p.home || []), { who: 'ai', text: 'Here they are.' }] }))
        setChatSnap('collapsed')
        openView('settings')
        return
      }
      const wants = asksForRoom(text)
      if (wants) setChatSnap(wants)
    }

    /*
      A suspended task owns the next thing he says — IN THE CONVERSATION IT WAS
      SUSPENDED IN. This used to be a single task and only Home's thread could
      resume it, which is backwards: the clarification he was answering was the
      one on screen, and a route asked about from the Calendar card had nowhere
      to be resumed at all. Tasks are per surface because conversations are.
    */
    const waiting = pending[id]
    if (waiting) {
      const next = answer(waiting, text)
      if (next.status === 'awaitingClarification') {
        setPending((p) => ({ ...p, [id]: next }))
        setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'ai', text: next.question }] }))
        return
      }
      setPending((p) => { const { [id]: _gone, ...rest } = p; return rest })
      /*
        The SAME task continues, with the slot he just filled carried into it.
        `resumeInstruction` is still what a text-compiled task ("search", which
        ends at the planner) is resumed with; a typed task resumes on its slots,
        which is stronger — nothing is re-parsed out of a sentence that was
        already turned into values.
      */
      await runTask(id, next.kind, resumeInstruction(next), next)
      return
    }

    /*
      A ROUTE IS A TASK, NOT A REMARK — AND A DEPARTURE TIME IS A DIFFERENT TASK.

      "Show route" went straight to the chat model, which — having no route
      engine and no way to start one — replied with a paragraph explaining that
      it did not know the address, and the whole missing-slot mechanism below
      was unreachable from the one request it was written for.

      "What time should I leave for Avano?" was worse: it matched no pattern at
      all, so it reached the model, which answered with the nearest calendar fact
      it could see. Classification is one function now, and it distinguishes the
      two computations rather than treating a departure as a route with extra
      words. See task/intent.ts.
    */
    const intent = classify(text)
    if (intent.kind) {
      await runTask(id, intent.kind, text)
      return
    }

    /*
      A FREEFORM ANSWER IS STILL AN ANSWER TO THAT QUESTION.

      "Something else…" on a question card hands him the composer. Without
      carrying the question across, what he types arrives as a remark on Home —
      and `slotForReply` reads the CARD's id to decide which typed field an
      answer belongs to, so the reply would have been filed as prose and the
      question asked again tomorrow. `answering` is that card, and it is cleared
      the moment it is used: the next thing he says is a new thing.
    */
    const answered = id === 'home' ? answering : null
    if (answered) setAnswering(null)

    // Both vocabularies, for the same reason as `nav.ts`: `id` is whatever the
    // surface was opened by, which for a system app is its view id and not the
    // id the feed files it under. Without this, talking to Mail sent the model
    // no context about what was on screen.
    const need = answered ?? needs.find((n) => n.id === id || n.id === sourceIdFor(id)) ?? null
    setSending(true)
    try {
      const r = await say(
        text,
        need ? { id: need.id, title: need.title, status: need.status, asks: need.asks } : null,
        threads[id] || [],
        // What he is looking at — including Home, which `snapshot()` alone
        // cannot describe because nothing is mounted there. See context.ts.
        ctx.briefs,
      )
      /*
        Filtered again HERE, on his device.

        Not belt-and-braces over the server's own boundary — a different
        question. This bundle can be older or newer than whatever server
        answered, which on a Home Screen app is the normal case rather than an
        edge one, so "the server guarantees it" is a guarantee about a server
        and this is the string actually being drawn. See safeText.ts.
      */
      setThreads((p) => ({
        ...p,
        [id]: [
          ...(p[id] || []),
          { who: 'ai', text: safeText(r.reply) },
          ...(r.did && r.didKind !== 'telemetry' ? [{ who: 'ai' as const, text: safeText(r.did) }] : []),
        ],
      }))
      if (r.did && r.didKind === 'telemetry') note(id, r.did)

      if (r.ui?.length) {
        const run = runCommands(r.ui, (said) => setRunning((cur) => (cur ? { ...cur, step: said } : cur)))
        setRunning({ run, step: '' })
        const { said, cancelled } = await run.done
        setRunning(null)
        const line = said.join(' ') + (cancelled ? ' (stopped)' : '')
        if (line.trim()) note(id, line.trim())
      }

      if (r.learned) void reconsider()
    } catch (e) {
      /*
        THE SAFE SENTENCE, NEVER THE RAW ONE.

        This line used to append `(e as Error).message`, and `api.ts` minted that
        message as `HTTP ${res.status}` — so a bad gateway spoke to him in the
        assistant's voice, and then persisted. `ApiError.userMessage` is written
        to be read aloud; the provider's actual words live in the server log
        against `diagnosticId`.
      */
      setThreads((p) => ({ ...p, [id]: [...(p[id] || []), failureTurn(e)] }))
    } finally {
      setSending(false)
    }
  }

  /**
   * A pane request, with the ladder run first.
   *
   * If everything a route needs is already known, it executes. If exactly one
   * thing genuinely blocks, the task suspends with that slot named, and his next
   * message resumes it. Nothing here demands precision that was never available.
   */
  const runTask = async (id: string, kind: string, instruction: string, resumed?: SuspendedTask) => {
    const slots = resolveSlots(TASK_SLOTS[kind] ?? [], instruction, world, resumed?.slots ?? pending[id]?.slots)
    const suspended = suspend(kind, instruction, slots)
    if (suspended) {
      /*
        THE DAY THE TASK IS ABOUT travels with it.

        Without this, "7pm" answered against a missing start time becomes seven
        tonight rather than seven on the day of the event — which is a wrong
        answer produced by the very mechanism that exists to prevent wrong
        answers. Read off whichever object the destination resolved to.
      */
      const ref = Object.values(slots).find((s) => s.status === 'resolved' && s.ref)
      const anchored = ref && 'ref' in ref ? world.objects.find((o) => o.id === ref.ref) : undefined
      setPending((p) => ({ ...p, [id]: { ...suspended, dayHint: anchored?.at } }))
      setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'ai', text: suspended.question }] }))
      return
    }

    if (kind === 'leaveBy') return runLeaveBy(id, slots)

    setSending(true)
    try {
      const r = await askFor(instruction)
      if (r.question) {
        setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'ai', text: safeText(r.question!) }] }))
      } else {
        setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'ai', text: 'Done — it’s in your tasks.' }] }))
        const f = await refreshFeed()
        land(f.feed, false)
      }
    } catch (e) {
      /*
        THE SAFE SENTENCE, NEVER THE RAW ONE.

        This line used to append `(e as Error).message`, and `api.ts` minted that
        message as `HTTP ${res.status}` — so a bad gateway spoke to him in the
        assistant's voice, and then persisted. `ApiError.userMessage` is written
        to be read aloud; the provider's actual words live in the server log
        against `diagnosticId`.
      */
      setThreads((p) => ({ ...p, [id]: [...(p[id] || []), failureTurn(e)] }))
    } finally {
      setSending(false)
    }
  }

  /**
   * THE DEPARTURE COMPUTATION, AS AN OPERATION THAT MUST TERMINATE.
   *
   * Run through `runOperation` rather than as a bare await, because that is the
   * existing contract for "work is happening" and it is the only one with a
   * timeout that resolves the state whatever the caller does. §44's rule — no
   * acknowledgment without completion — is not a promise made in a prompt here;
   * it is the operation runtime, which cannot leave a surface in `running`.
   *
   * The holder is a `detail` surface, which declares NO operations. That is
   * deliberate: a conversation is a place work is reported, not a thing the
   * model may operate, and the capability table says so.
   */
  const runLeaveBy = async (id: string, slots: Record<string, { status: string; value?: string }>) => {
    const key = `${id}#task`
    ensure(key, 'detail')
    const value = (n: string) => String((slots[n] as { value?: string })?.value ?? '')
    const r = await runOperation(key, { kind: 'leaveBy', provider: 'osrm', cancellable: true }, async () => {
      const out = await leaveByFor({
        destination: value('destination'),
        eventStart: value('eventStart'),
        origin: value('origin'),
        transportMode: value('transportMode'),
      })
      // A refusal is a COMPLETED operation with an honest answer, not a crash:
      // "I can't time a bus journey" is a result he can act on.
      return { value: out, resultCount: out.ok ? 1 : 0 }
    })
    const said = r?.value?.says ?? r?.reason ?? 'I couldn’t work that out.'
    setThreads((p) => ({ ...p, [id]: [...(p[id] || []), { who: 'ai', text: safeText(said) }] }))
  }

  const act = async (action: WidgetAction, where: { card?: string; paneId?: string; revisionId?: string }) => {
    const res = await fetch('/api/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: action.kind,
        params: action.params ?? {},
        confirmed: action.irreversible === true,
        ...where,
      }),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(body?.error ?? `That didn't work (HTTP ${res.status})`)
    if (body?.refresh !== false) void reconsider()
  }

  /**
   * A card's own action, performed.
   *
   * The card is marked handled only AFTER the call succeeds — an optimistic
   * green tick over a request that failed is the app lying about his account.
   */
  const onAction = async (need: Need, action: WidgetAction) => {
    await act(action, { card: need.title })
    setDoneIds((p) => new Set(p).add(need.id))
  }

  const onRetryTask = async (paneId: string) => {
    try {
      await refreshPane(paneId)
      const r = await refreshFeed()
      land(r.feed, false)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /**
   * The one status line, for whichever view is on screen.
   *
   * It merges the four things that can be true at once and all live here: the
   * surface's last operational line, a model-driven run still going, the surface
   * undo history, and the Home lifecycle undo — saving, archiving and dismissing
   * are the moves where "put that back" is a real sentence.
   */
  /**
   * THE STATUS LINE BELONGS TO THE SCREEN IT IS ABOUT.
   *
   * It used to read the GLOBAL top of the surface undo stack, so zooming the
   * map put "Zoomed the map. undo" on Home, on YouTube and on Activity — three
   * screens reporting something that had not happened to them, and offering an
   * undo that would have reached across into a different application. The
   * surface undo is scoped by id now; Home keeps only its own lifecycle undo.
   */
  const statusFor = (id: string) => {
    const mine = id === 'home' ? null : history.lastIn(id)
    const homeUndo = id === 'home' && canUndoHome()
    return (
      <SurfaceStatus
        /* Work the CONVERSATION started, reported where every other piece of
           machinery is reported. Without this a departure calculation was
           invisible while it ran and its failure was a bubble with no state
           behind it — the "acknowledged, then nothing" shape §44 bans. */
        op={operationOf(`${id}#task`)}
        /* A failure that cost him the screen is said at the seam, in the one
           place the app already reports what it just did — not as a card, and
           never as a silent empty Home. */
        note={notes[id] ?? (id === 'home' ? error : null)}
        running={running}
        canUndo={!!mine || homeUndo}
        lastSaid={mine?.said ?? (homeUndo ? lastHomeAction() : null)}
        onClear={() => setNotes((p) => ({ ...p, [id]: '' }))}
        onStop={() => { running?.run.cancel(); setRunning(null); cancelOperation(`${id}#task`) }}
        onUndo={() => { if (mine) undoSurface(id); else undoHome() }}
      />
    )
  }

  /**
   * SUGGESTIONS, inside chat and nowhere else.
   *
   * Capped at three, and every one has to be executable now or backed by a
   * clarification path. When a task is waiting on an answer the chips become the
   * candidates for THAT answer, which is the shortest possible route through a
   * clarification.
   */
  const suggestions = useMemo(
    () => chipsFor(pending.home ?? null, result?.ask?.chips ?? [], world),
    [pending.home, result, world],
  )

  const homeOpen = target.kind === 'home' || target.kind === 'unresolvable'
  /**
   * Whether Home is reachable at all.
   *
   * Two things can take the foreground, and both block it completely. Chat
   * expanded or maxed makes Home visual context only; a critical interrupt does
   * the same from one layer higher. `inert` is the accessibility half of the
   * rule the scrim enforces for the finger — no focus, no activation, nothing
   * underneath reachable — and it has to follow BOTH, or the layer above chat
   * would be the one place assistive technology could still reach through.
   */
  const homeInert = homeOpen && (snap !== 'collapsed' || !!interrupt)

  return (
    <ViewportShell>
      {/* The background plane is the SHELL's, not this tree's — it has to run
          under the status bar and behind the home indicator, and everything
          here lives inside the usable rectangle. See ViewportShell.tsx. */}
      <div style={css('position:relative; height:100%; min-height:0; display:flex; flex-direction:column;')}>
        <StatusBar clock={result?.clock ?? '12h'} />

        {homeOpen && depth && (
          /*
            DEPTH REPLACES HOME RATHER THAN COVERING IT.

            The same rule every application surface follows here, and for the
            same reason: two screens alive at once is two things competing for
            the one dominant interaction, and a card underneath a sheet is a card
            that can still be tapped through the glass. The composer stays, so
            there is still exactly one.
          */
          <Boundary
            scope="Intelligence"
            level="surface"
            fallback={({ error }) => <Recovered what="this" error={error} onHome={() => setDepth(null)} />}
          >
            <AboveKeyboard>
              <IntelligenceDepth
                m={depth}
                onClose={() => setDepth(null)}
                onFeedback={async (verdict, correction) => {
                  const r = await judgeIntelligence({ id: depth.id, verdict, correction })
                  /*
                    HIS SENTENCE, VERBATIM. The route says what it actually did —
                    "I have dropped that", or "I could not record that, my memory
                    is not running" — and that is what reaches the screen. The
                    client has no opinion to add and no cheerful default to fall
                    back on.
                  */
                  return r.said
                }}
                onAct={(a) => {
                  setDepth(null)
                  if (a.kind === 'open') openView(a.surface, a.focus)
                  else void onSay('home', a.text)
                }}
              />
            </AboveKeyboard>
          </Boundary>
        )}

        {homeOpen && !depth && (
          <div
            inert={homeInert ? true : undefined}
            style={css('flex:1; min-height:0; display:flex; flex-direction:column;')}
          >
            {/*
              HOME'S OWN BOUNDARY.

              Home is the screen everything else recovers TO, which made it the
              one place a throw had nowhere to fall: it went straight to the app
              boundary and took the whole tree. Deliberate failure injection is
              what showed this — the seam that had containment was the only one
              being tested, and this one had none.
            */}
            <Boundary
              scope="Home"
              level="surface"
              fallback={({ error, retry }) => <Recovered what="Home" error={error} onHome={retry} label="Try again" />}
            >
            <Home
              feed={result}
              thinking={thinking}
              cold={result === null}
              needsBrain={hasBrain === false}
              needsSignIn={needsSignIn}
              onOpen={openView}
              onOpenObject={openObject}
              onOpenSettings={() => openView('settings')}
              onRetryTask={onRetryTask}
              reserve={composerH + COMPOSER_CLEARANCE}
              status={statusFor('home')}
              showingYesterday={yesterday}
              /*
                A WIDGET CHIP RUNS A REAL CAPABILITY, OR IT IS NOT ON THE WIDGET.

                It goes through the same `act` every other action does — the same
                undo record, the same failure reporting, the same refusal when
                the capability table does not have it. `deck.ts` only ever emits
                actions it was handed by the pane, and the pane's actions have
                already been through `sanitiseActions`, so there is no path here
                that can invent one.
              */
              onChip={(c) => { void act(c.action, { card: 'Home' }) }}
              /*
                THE INTELLIGENCE CARD OPENS ITS OWN EVIDENCE.

                It used to carry two model-written chips that went to chat, which
                was the app's answer to "let him argue with it" — and it was the
                wrong answer twice over. The chips were the only tappable thing
                on the card, so the card itself did nothing; and a conversation
                is where a correction goes to be re-parsed out of a sentence,
                when the whole point of the memory core is that a correction is a
                TYPED verb against a named hypothesis.
              */
              onOpenIntelligence={setDepth}
              /*
                AN ANSWER IMMEDIATELY BECOMES WHAT IT UNBLOCKED.

                `reconsider` is the whole of §33: the fact is written, the feed
                is rebuilt, and the question is replaced by the figure it was
                asking about — the goal-aware Activity line rather than a card
                that silently disappears.
              */
              onAnswer={(said) => { note('home', said); void reconsider() }}
              /*
                "Something else…" hands him the composer with the question in
                front of it. The card is set as the conversation's card, so a
                freeform reply is still written to the SLOT the question was
                about rather than being filed as a remark — see `slotForReply`.
              */
              onElaborate={(question) => {
                const asked = needs.find((n) => n.asks && n.title === question) ?? null
                setAnswering(asked)
                setChatSnap('expanded')
                setThreads((p) => ({ ...p, home: [...(p.home || []), { who: 'ai', text: question }] }))
              }}
            />
            </Boundary>
          </div>
        )}

        {/*
          THE NAVIGATION BOUNDARY.

          Distinct from the per-renderer ones inside `Widgets`, and it has to
          be: those contain a widget that threw and leave the workspace around
          it, but a throw in the workspace ITSELF — the transition, the header,
          the settings screen — had nothing between it and the app boundary,
          which means the whole app. Failing here returns him to Home, which is
          always mountable, rather than to a recovery screen.
        */}
        {target.kind === 'settings' && (
          <Boundary
            scope="Settings"
            level="surface"
            fallback={({ error }) => <Recovered what="Settings" error={error} onHome={() => setView(null)} />}
          >
            <AboveKeyboard>
            <Settings
              onClose={() => setView(null)}
              onChanged={() => void checkBrain()}
              onLayoutChanged={() => { refreshFeed().then((r) => land(r.feed, false)).catch(() => {}) }}
            />
            </AboveKeyboard>
          </Boundary>
        )}

        {open && (
          <Boundary
            scope={open.title}
            level="surface"
            fallback={({ error }) => <Recovered what={open.title} error={error} onHome={() => setView(null)} />}
          >
            <AboveKeyboard>
            <Report
              need={open}
              chips={chipsFor(pending[open.id] ?? null, open.chips, world)}
              thread={threads[open.id] || []}
              status={statusFor(open.id)}
              done={doneIds.has(open.id)}
              onSay={(need, text) => onSay(need.id, text)}
              onAction={onAction}
              onClose={() => setView(null)}
            />
            </AboveKeyboard>
          </Boundary>
        )}
      </div>

      {/*
        HOME ONLY. An opened domain application keeps its own ChatFrame inside
        the workspace — chat never overlays an application, because there the
        application IS the thing being operated and covering it with the steering
        interface is the inversion the workspace layout exists to prevent.
      */}
      {homeOpen && (
        <ChatOverlay
          onComposerHeight={setComposerH}
          snap={snap}
          onSnap={setChatSnap}
          thread={threads.home ?? []}
          opening={result?.ask?.opening ?? 'What’s on your mind?'}
          suggestions={suggestions}
          sending={sending}
          interrupted={!!interrupt}
          onOpenSettings={() => setView('settings')}
          onSend={(text) => void onSay('home', text)}
        />
      )}

      {/*
        THE GEOMETRY READOUT.

        Above even the interrupt layer, because it is not part of the app — it
        is the instrument for measuring the app, and an instrument that can be
        covered by the thing it is measuring is no use. Reachable only from
        `/#diag`. See Diagnostics.tsx.
      */}
      {diag && <Diagnostics onClose={() => { window.location.hash = ''; setDiag(false) }} />}

      {/* Above everything, including chat. See Interrupt.tsx for why that is an
          exception to foreground ownership rather than a hole in it. */}
      {interrupt && (
        <InterruptLayer
          interrupt={interrupt}
          onAcknowledge={() => setAcknowledged((p) => new Set(p).add(interrupt.id))}
        />
      )}
    </ViewportShell>
  )
}

/**
 * THE CHIPS, DERIVED FROM TASK STATE.
 *
 * A blocked task replaces the feed's suggestions entirely rather than being
 * added to them: while something is waiting on one answer, every chip that is
 * not about that answer is a way to abandon it. And whatever survives is
 * filtered against the instruction that is stuck, because the failure worth
 * naming is the screenshot where the chip under "I don't have the address" was
 * "Show route" — the very thing that had just failed for want of the address.
 */
function chipsFor(task: SuspendedTask | null, feedChips: string[], world: KnownWorld): string[] {
  if (!task) return feedChips.slice(0, 3)
  return suggestionsFor(task, world).filter((c) => !restates(c, task.instruction)).slice(0, 3)
}

/**
 * A workspace that could not be drawn, WITH the way back.
 *
 * The generic boundary fallback offers "retry", which is right for a widget
 * inside a working screen and wrong here: if the surface itself threw, retrying
 * it usually throws again, and he is left on a page whose only control does
 * nothing. Home is the screen that is always mountable, so it is the offer.
 */
function Recovered({
  what, error, onHome, label = 'Back to home',
}: { what: string; error: Error; onHome: () => void; label?: string }) {
  return (
    <div
      role="alert"
      data-frame="recovered"
      style={css('flex:1; min-height:0; display:flex; flex-direction:column; justify-content:center; gap:12px; padding:24px 22px;')}
    >
      <div style={css('font-size:20px; font-weight:600; letter-spacing:-.02em;')}>{what} couldn’t be drawn</div>
      <div style={css('font-size:13.5px; line-height:1.5; color:rgba(237,238,241,.6);')}>
        Nothing was lost — everything else still works, and this is recorded.
      </div>
      <div
        onClick={onHome}
        style={css('align-self:flex-start; padding:10px 16px; border-radius:12px; cursor:pointer; background:rgba(237,238,241,.92); color:#0B0B0D; font-size:13px; font-weight:600;')}
      >{label}</div>
      <div style={css('font-size:11px; line-height:1.45; color:rgba(237,238,241,.28);')}>{String(error?.message ?? error)}</div>
    </div>
  )
}

/**
 * The app's own status row.
 *
 * Drawn only inside the desktop bezel, where there is no real one to read. On a
 * phone iOS is already painting the time and the battery a few pixels above
 * this, and a second identical row is 46px spent saying it twice.
 */
function StatusBar({ clock }: { clock: '12h' | '24h' }) {
  const { bezel } = useViewport()
  if (!bezel) return null
  return (
    <div style={css('height:46px; flex:none; display:flex; align-items:flex-end; justify-content:space-between; padding:0 26px 6px; font-size:13px; font-weight:600; color:rgba(237,238,241,.48);')}>
      <div>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: clock === '12h' })}</div>
      <div style={css('display:flex; gap:5px; align-items:center;')}>
        <div style={css('width:15px; height:7px; background:rgba(237,238,241,.18);')} />
        <div style={css('width:20px; height:8px; background:rgba(237,238,241,.34);')} />
      </div>
    </div>
  )
}
