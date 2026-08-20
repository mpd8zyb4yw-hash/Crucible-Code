import { history, historyAvailable } from './actions.js'
import { readHome, type HomeState } from './home.js'
import { buildDeck, type HomeDeck } from './deck.js'
import { intelligenceSlot, type IntelligencePresentation } from './intelligence.js'
import { memoryPosture, memoryStore } from './memory/host.js'
import { buildInsights, needFrom, type InsightRun } from './insight.js'
import { enrichPanes, sourcePanes, noticePane } from './panes.js'
import { getFact, liftFromObservations, readPerson } from './person.js'
import * as protocol from './protocol.js'
import { applyShelf, reconcile, readShelf, type Seen, type Shelf } from './shelf.js'
import { think, type Need, type ThinkResult } from './think.js'
import { resolveRefs, type WidgetPane } from './widgets.js'
import { liftPeople } from './people.js'
import { dateLabel as spellDate, dayIn, dateVocabulary } from './clock.js'
import { dedupeBeliefs, deriveProfile, mutateWorld, reconcileBeliefs, writeWorld, type World } from './world.js'

/**
 * The splash, assembled.
 *
 * Three things end up on it and they are not the same kind of thing, which is
 * the reason this file exists rather than the client stitching them together:
 *
 *   synthesis — what the model thinks needs him today. Expensive, rate limited,
 *               and minted fresh every pass.
 *   sources   — what each connected account currently holds. Deterministic,
 *               free, and true whether or not a model ever answers.
 *   panes     — the things he asked for and kept. His, persistent, revisable.
 *
 * A client that assembled these itself would have to know which of them can
 * fail, which are safe to cache, and in what order he wants them — three
 * answers that would then differ between the Mac and the edge. Here it is one
 * answer, and the ordering is a stored preference rather than a layout
 * constant, so "rearrange my feed" is a write rather than a release.
 *
 * The failure behaviour is the point of the shape. Synthesis is the only part
 * that needs a model and the only part that routinely cannot run, so it is
 * wrapped alone: a rate-limited free tier costs him the model's cards and
 * nothing else. His panes and his connected sources still render, in his order,
 * with one card saying what is wrong.
 */

/** A pane as it appears on the splash. Enough to draw and to act on. */
export interface FeedPane {
  paneId: string
  title: string
  /** The rendered body of the head revision. Straight from the snapshot. */
  panes: WidgetPane[]
  revisionId: string
  /** His words, as he said them. What the pane IS. */
  intent: string
  planClass: string
  summary: string
  pinned: 'content' | 'intent' | null
  /** A refresh waiting behind a content pin. The pane says so rather than hides it. */
  pendingRevisionId?: string
  canUndo: boolean
  canRedo: boolean
  refresh: string
  updatedAt: string
}

export type FeedItem =
  | { id: string; kind: 'synthesis' | 'source'; need: Need }
  | { id: string; kind: 'pane'; pane: FeedPane }

export interface Feed extends Omit<ThinkResult, 'beliefUpdates' | 'dropped'> {
  /** Everything on the splash, in his order, with what he switched off removed. */
  items: FeedItem[]
  /**
   * Every card by id, INCLUDING ones the shelf currently hides.
   *
   * The client opens a report by id, and an id can outlive its place on the
   * splash — a notification, a back button, a card switched off between paint
   * and tap. Filtering this to the visible set would turn each of those into a
   * blank screen.
   */
  needs: Need[]
  /**
   * HOME'S THREE SLOTS, ALREADY DECIDED. See `deck.ts`.
   *
   * The client draws this and derives nothing from it. Which domain is in
   * front, what the relevance card says and whether there is a thought to show
   * are all answered from typed state that only exists here, and a client
   * reconstructing any of it from `heat` would be a second opinion about the
   * whole screen.
   */
  deck: HomeDeck
  shelf: Shelf
  /** When this was assembled. The client shows it and decides whether to refetch. */
  at: string
  /**
   * When the deterministic source rows on it were last PROJECTED.
   *
   * Not the same as `at`, and the gap between them is the honest state of a
   * cached paint: the model's cards are as old as `at`, the calendar row was
   * re-derived from the stored world a millisecond ago. One timestamp for both
   * had to lie about one of them.
   */
  sourcesAt?: string
  /**
   * Set when this feed was assembled on an EARLIER LOCAL DAY than it is being
   * served on, and its day-bound parts have been withdrawn rather than painted.
   * The client shows the day is turning over; it must never present the
   * withdrawn parts as absent-because-empty.
   */
  staleDay?: boolean
  /**
   * The few typed facts the client's resolution ladder may read. See the
   * comment at the assignment, which explains why the set is closed and tiny.
   *
   * Declared here because it was already being SENT and was already mirrored in
   * `src/api.ts` — the server's own type was the only thing that had not been
   * told, so the assignment below was a typecheck error and the field travelled
   * anyway. Found while adding `deck`, unrelated to it, fixed rather than
   * stepped around.
   */
  known?: Record<string, string>
  /** Set when the model could not run. The rest of the feed is still real. */
  degraded?: string
  provider?: string
  model?: string
}

/** Cheap, losable, and only ever a faster first paint. See `readSnapshot`. */
export interface SnapshotStore {
  read(): Promise<Feed | null>
  write(f: Feed): Promise<void>
}

let snapshots: SnapshotStore | null = null

export function setSnapshotStore(s: SnapshotStore): void {
  snapshots = s
}

export function kvSnapshotStore(kv: KVNamespace, key = 'feed'): SnapshotStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as Feed) : null
    },
    async write(f) {
      await kv.put(key, JSON.stringify(f))
    },
  }
}

/**
 * The last assembled feed, RE-PROJECTED onto now.
 *
 * Deliberately never an error and deliberately not authoritative: this is what
 * gets painted in the first fifty milliseconds while a real build runs behind
 * it. A snapshot that failed to load costs a slower first paint; a snapshot
 * that threw would cost the screen.
 *
 * WHAT THIS EXISTS TO STOP. It used to return the stored feed verbatim,
 * "whatever its age", and that was wrong in a way no assertion could catch,
 * because a day-old snapshot is internally CONSISTENT — just wrong about what
 * day it is. Concretely: the source rows are computed against `Date.now()` at
 * build time, so "the next event that has not happened yet" was frozen at the
 * moment of the build. Opening the app the next morning painted, as the answer
 * to "what's next", an event that had finished the previous day. The header
 * carried the previous day's date over it.
 *
 * The fix is not a fresher cache. It is that a cached SOURCE ROW should never
 * have existed: those rows are a pure function of the stored world and the
 * clock, with no model and no network in the path — the same reason `panes.ts`
 * gives for their existing at all. So they are re-derived here, on read, for
 * free. What stays cached is what is genuinely expensive and genuinely old:
 * the model's cards, and the stored pane revisions, both of which carry their
 * own timestamps and are honest about being snapshots.
 *
 * Passing no world keeps the old verbatim behaviour, for callers that have no
 * world to project from.
 */
export async function readSnapshot(world?: World, now = new Date()): Promise<Feed | null> {
  if (!snapshots) return null
  let snap: Feed | null = null
  try {
    snap = await snapshots.read()
  } catch {
    return null
  }
  if (!snap) return null
  if (!world) return snap
  try {
    // His arrangement is read here, where awaiting is already the shape of the
    // call, so `reproject` itself stays synchronous — see `buildDeck`.
    return reproject(snap, world, await readHome(), now)
  } catch {
    // A projection that throws must not cost the first paint. The stored feed
    // is still the thing that was true when it was written.
    return snap
  }
}

/**
 * Same calendar day IN HIS ZONE — the unit the header actually claims.
 *
 * Not the runtime's zone. This runs on a Worker, where the runtime is UTC and
 * he is two hours ahead of it, so a runtime-zone comparison put the day
 * boundary at 02:00 his time and disagreed with the Mac about the same stored
 * feed. See `World.timeZone`.
 */
const sameDay = (a: Date, b: Date, tz?: string) => dayIn(a, tz) === dayIn(b, tz)

/**
 * WHAT CRUCIBLE UNDERSTOOD, OR NOTHING — AND NOTHING IS THE NORMAL ANSWER.
 *
 * Three gates stand between the memory core and this slot, and all three are
 * somebody else's:
 *
 *   · `memoryPosture()` — the capability map. `intelligence` is `shadow` in
 *     every host until it is explicitly promoted, so this returns null by
 *     default rather than by omission.
 *   · `significance.ts` — coverage, diversity, magnitude, information value.
 *   · `correction.ts` — anything he has denied.
 *
 * On the real ledger it currently returns null always: thirteen days of evidence
 * does not clear the coverage bars, and lowering one to make the slot speak
 * would trade the only property that makes it worth reading. A quiet slot is the
 * correct picture of a system that has not yet earned a conclusion.
 *
 * Synchronous, and it has to be: `reproject` is what the first paint runs.
 * Defensive to the point of rudeness, for the reason `host.ts` states — a broken
 * ledger costs evidence and must never cost a screen.
 */
function slotThree(now: Date, tz?: string): IntelligencePresentation | null {
  try {
    const store = memoryStore()
    if (!store) return null
    return intelligenceSlot(store, { now, timeZone: tz, posture: memoryPosture(), label: metricLabel })
  } catch {
    return null
  }
}

/**
 * PHASE 8 — WHAT THE MEMORY CORE ADDS TO THE FOUR DOMAINS, OR NOTHING.
 *
 * The same three-gate shape as `slotThree` above and for the same reasons, with
 * one deliberate difference: the capabilities. Domain context reads `entities`,
 * `baselines` and `routines` — the FIRST three of `authority.ts`'s eight — while
 * the intelligence slot reads the seventh. That is not an accident of naming. A
 * baseline comparison on a step count and a hypothesis on his home screen are
 * different sizes of claim, and §52's migration order already says which is
 * earned first. It means domain enrichment can become visible without touching
 * intelligence's authority, which §28 requires stay exactly where it is.
 *
 * Synchronous, defensive, and returns the panes UNCHANGED on any failure. The
 * app that existed before this function is the app that runs when it declines.
 */
function enriched(needs: Need[], now: Date, tz?: string): Need[] {
  try {
    const store = memoryStore()
    if (!store) return needs
    return enrichPanes(needs, store, { now, timeZone: tz, posture: memoryPosture() })
  } catch {
    return needs
  }
}

/** Metric ids in his words. The vocabulary `candidates.ts` already uses. */
const metricLabel = (m: string): string =>
  m === 'steps' ? 'your step count'
  : m === 'events_per_day' ? 'how much is in your calendar'
  : m === 'departure_minute' ? 'when you leave'
  : m === 'contact_days' ? 'how often you are in touch'
  : m

/**
 * Swap every cached source row for one derived from the world as it stands.
 *
 * Matched BY ID and substituted in place, never appended: the order on screen
 * is his shelf arrangement, and a row that arrives without a shelf position
 * would have to be put somewhere this function is not entitled to choose. A
 * source connected since the snapshot was written is therefore absent for the
 * one frame until the live build behind this lands it in its proper place —
 * which is the correct trade, because the alternative is his arrangement
 * silently rearranging itself on a cold start.
 */
function reproject(snap: Feed, world: World, home: HomeState, now: Date): Feed {
  const freshSources = enriched(sourcePanes(world, now), now, world.timeZone)
  const fresh = new Map(freshSources.map((n) => [n.id, n]))
  const stale = !sameDay(new Date(snap.at), now, world.timeZone)
  const hasSynthesis = snap.items.some((i) => i.kind === 'synthesis')

  const items = snap.items.flatMap((i): FeedItem[] => {
    if (i.kind === 'source') {
      const next = fresh.get(i.id)
      return [next ? { ...i, need: next } : i]
    }
    // The model's cards are the day-bound part. "What needs you" computed
    // against yesterday is not a stale version of today's answer, it is an
    // answer to a different question, and there is no honest way to paint it
    // under today's date. Withdrawn, and `staleDay` says so.
    if (i.kind === 'synthesis' && stale) return []
    return [i]
  })

  const needs = snap.needs.flatMap((n) => {
    const next = fresh.get(n.id)
    if (next) return [next]
    if (stale && !snap.items.some((i) => i.kind !== 'synthesis' && i.id === n.id)) return []
    return [n]
  })

  /*
    THE DECK IS RE-PROJECTED, NOT RESTORED.

    For exactly the reason the source rows are: it is a pure function of the
    stored world, his arrangement and the clock, so a cached one would carry
    yesterday's "in 3h" into this morning — a widget saying an event is three
    hours away when it finished last night. The model-authored halves of the
    screen (relevance, the thought) follow the same withdrawal rule as the cards
    they come from: on a stale day they are gone rather than repainted.
  */
  const attentionNow = stale ? [] : snap.needs.filter((n) => !n.id.startsWith('src-') && n.because)
  const synthesisNow = stale ? [] : snap.needs.filter((n) => !n.id.startsWith('src-') && !n.because)

  return {
    ...snap,
    items,
    needs,
    /*
      SLOT THREE IS RE-READ ON THE CACHED PATH TOO, not restored from the
      snapshot, for the same reason the source rows are re-projected: a stored
      presentation is a conclusion frozen at the moment it was written, and it
      may since have been denied. Reading it from the store is what makes "that's
      wrong" take effect on the very next paint rather than on the next think.
    */
    deck: buildDeck(freshSources, attentionNow, synthesisNow, home, now, world.timeZone, {
      intelligence: slotThree(now, world.timeZone),
    }),
    /**
     * KEEP THE STORED LABEL ONLY IF A MODEL WROTE IT.
     *
     * Synthesis mints this in his own conventions and nothing here can
     * reproduce that, so a label with synthesis behind it is preserved. With no
     * synthesis, the stored label is just `toLocaleDateString()` output from
     * whenever the build ran — reproducible exactly, and in this snapshot's
     * case reproducibly WRONG: built at 23:00 UTC, which was already the 9th in
     * Rome, it read "8/8/2026" and the same-day check had no reason to replace
     * it. A header the app can recompute correctly, it should recompute.
     */
    /**
     * Recomputed unconditionally, and the old "keep it if a model wrote it" clause
     * is gone with the reason it existed. That clause preserved the model's label
     * because the app could not reproduce his conventions; it can now — see
     * `headerDate` — so there is nothing left worth preserving, and preserving a
     * stored label was how a snapshot built at 23:00 UTC carried the previous
     * day's date into the next morning.
     */
    dateLabel: headerDate(world, now),
    readLine: stale ? '' : snap.readLine,
    sourcesAt: now.toISOString(),
    staleDay: stale || undefined,
  }
}

/**
 * The date at the top of the screen.
 *
 * Two things come from him and one from the calendar, and keeping them separate is
 * what lets this be both correct and his: the ORDER (day-month or month-day) and
 * how much detail he wants are stored preferences; the year, month, day and
 * weekday are arithmetic. An American in Italy reads "August 11" and someone in
 * Bologna reads "11 August", and neither of them wants the app to be wrong about
 * which day it is in order to get that right.
 *
 * `format.dates` is a preference like any other, absent by default, and absent
 * means day-month — the convention where he actually lives, and the one his
 * calendar already uses.
 */
function headerDate(world: World, now: Date): string {
  const p = world.person
  const order = p?.preferences?.['format.dates']?.value === 'mdy' ? 'mdy' : 'dmy'
  const v = dateVocabulary(now, world.timeZone, { order })
  return spellDate(v.today, { weekday: 'short', month: 'short', year: false, order })
}

async function keep(feed: Feed): Promise<void> {
  try {
    await snapshots?.write(feed)
  } catch {
    /* a snapshot that will not save is next time's problem, not this render's */
  }
}

export interface BuildOptions {
  /** Skip the model entirely. The cron path and every offline rebuild use this. */
  withoutModel?: boolean
  /** Passed through to synthesis: "he just said this". */
  nudge?: string
  now?: number
}

/**
 * Assemble the whole splash and remember it.
 *
 * Order of operations matters in one place: the shelf is reconciled against
 * what this build actually produced BEFORE the ordering is applied, so a source
 * connected a second ago already has a place rather than waiting for the next
 * pass to acquire one. That is the difference between a feed that populates
 * itself and one that populates itself eventually.
 */
/**
 * When each card was first put in front of him, for the novelty axis.
 *
 * Read from the same durable home state the client writes, so "have I already
 * said this" survives a restart and agrees between the Mac and the edge. A
 * store that is not installed is not an error — it means nothing has been seen,
 * which scores everything as new, which is the correct behaviour on a cold app.
 */
async function seenStamps(): Promise<Record<string, { at: string; score: number }>> {
  try {
    const h = await readHome()
    return Object.fromEntries(Object.entries(h.seenAt ?? {}).map(([id, at]) => [id, { at, score: 0 }]))
  } catch {
    return {}
  }
}

export async function buildFeed(world: World, opts: BuildOptions = {}): Promise<Feed> {
  const now = new Date(opts.now ?? Date.now())
  const at = now.toISOString()

  /**
   * SETTLE THE WORLD BEFORE ANYTHING READS IT.
   *
   * All three of these are corrections to what the model would otherwise be
   * handed as fact, so they have to run BEFORE synthesis rather than after it —
   * a pass that reconciles beliefs after thinking has already let the thinking
   * happen over the contradiction.
   *
   * Cheap and deterministic: no network, no model, three walks of a list that
   * is capped by the prompt budget anyway.
   */
  await settle(world, now)

  // ── the model's cards, and nothing else, inside the try ────────────────────
  let synthesis: ThinkResult | null = null
  let degraded: string | undefined
  let provider: string | undefined
  let model: string | undefined
  if (!opts.withoutModel) {
    try {
      const r = await think(world, opts.nudge)
      synthesis = r
      provider = r.provider
      model = r.model
      await applyBeliefs(world, r)
    } catch (e) {
      degraded = (e as Error).message
    }
  }

  /**
   * ── WHAT WE WORKED OUT OURSELVES ──────────────────────────────────────────
   *
   * Deterministic, evidence-backed cards, computed from the world and the typed
   * personal model rather than written by a language model. This runs whether
   * or not the model was reachable, and it runs AFTER `settle` so it reads the
   * same reconciled world the synthesis did.
   *
   * It is outside the model's try/catch on purpose: a provider being down must
   * not take the travel plan down with it. That is the whole argument for
   * computing this in code — the things that matter most are exactly the things
   * that should not depend on a free-tier API answering.
   */
  const person = readPerson(world)
  /**
   * The rescue pass, kept and demoted. It reads sentences he typed BEFORE the
   * typed model existed; nothing new arrives this way any more (see `answer.ts`).
   */
  const learned = liftFromObservations(person, world.observations)
  /**
   * The people in his life, lifted from the structured records that name them.
   *
   * `identity.email` is passed as "me" so he is not filed as an acquaintance of
   * himself — his own address is on every event he organises. Nothing here infers
   * a relationship; see `people.ts` for the full argument about why that line is
   * the whole point of the file.
   */
  const peopleRun = liftPeople(person, world, getFact<string>(person, 'identity.email')?.value)
  let insights: InsightRun | null = null
  try {
    insights = await buildInsights(world, person, { now, seen: await seenStamps(), offline: opts.withoutModel })
  } catch (e) {
    // A failed insight pass is a missing card, never a missing feed.
    degraded ??= `insights: ${(e as Error).message}`
  }
  /**
   * THE GEOGRAPHY THIS BUILD RESOLVED BECOMES ORDINARY PLACES.
   *
   * `planTravel` geocodes every located event it plans for, and that answer was
   * being used for one departure time and then thrown away. Meanwhile the Places
   * domain — whose entire subject is where things are — drew "Nowhere with
   * coordinates yet", because the only geography it would accept was a
   * `kind:'place'` observation and no connector in the app has ever written one.
   * Two halves of the same fact, in the same process, never introduced.
   *
   * A place observation, rather than a private field on the map pane, is the
   * point: it is the same shape a search result or a future connector would
   * write, so the Map surface, routing, leave-by and anything later all read one
   * vocabulary. See the pane-revision note — a connector is just another object
   * source, never a bespoke feature.
   *
   * The id is derived from the COORDINATE, so re-planning the same dinner on
   * every build resolves to the same observation rather than stacking pins on
   * one restaurant.
   */
  const resolvedPlaces: Observation[] = (insights?.plans ?? []).flatMap((plan) => {
    const d = plan.destination
    if (d.state !== 'resolved' || d.lat === undefined || d.lon === undefined) return []
    return [{
      id: `place-${d.lat.toFixed(5)},${d.lon.toFixed(5)}`,
      source: 'calendar',
      at: plan.event.start,
      text: `${d.label ?? d.query} — where ${plan.event.summary} is`,
      data: {
        kind: 'place' as const,
        label: d.label ?? d.query,
        lat: d.lat,
        lon: d.lon,
        address: d.query,
      },
    }]
  })
  if (resolvedPlaces.length) {
    const known = new Set(world.observations.map((o) => o.id))
    world.observations = [...world.observations, ...resolvedPlaces.filter((o) => !known.has(o.id))]
  }

  /**
   * The person is written back because the pass LEARNS: geocoded places are
   * cached onto it, and `demand()` records what could not be answered — which
   * is the entire input to the question engine.
   *
   * THROUGH `mutateWorld`, and this is the write that made the whole transaction
   * mechanism necessary. Between the read at the top of this function and this
   * line, the pass has geocoded destinations and routed journeys against
   * volunteer-run services — seconds, sometimes many. A correction he made in
   * that window was being destroyed by this line, silently, every time.
   *
   * Only the parts this build actually learned are copied across. Writing the
   * whole `world` object back would reintroduce exactly the bug: the observations
   * and beliefs in this closure are as old as the top of the function.
   */
  if (learned.length || peopleRun.added.length || peopleRun.enriched.length || insights) {
    try {
      await mutateWorld((fresh) => {
        fresh.person = person
        fresh.profile = world.profile
        fresh.beliefs = world.beliefs
        /*
          The geocoded places too, appended to whatever the FRESH world holds
          rather than to the stale copy in this closure — same discipline as the
          three lines above, and for the same reason: seconds of network have
          passed since the read at the top of this function.
        */
        const held = new Set(fresh.observations.map((o) => o.id))
        const add = resolvedPlaces.filter((o) => !held.has(o.id))
        if (add.length) fresh.observations = [...fresh.observations, ...add]
      }, { label: 'what this build learned' })
    } catch (e) {
      // A build that cannot persist what it learned still renders what it built.
      degraded ??= `could not save what I learned: ${(e as Error).message}`
    }
  }

  const attentionCards = (insights?.ranked.surface ?? []).map((a) => needFrom(a, now))

  // ── what is already true, model or no model ───────────────────────────────
  const sources = enriched(sourcePanes(world, now), now, world.timeZone)
  const panes = await livePanes()
  await resolveRefs([...sources.flatMap((p) => p.panes ?? []), ...panes.flatMap((p) => p.panes)])

  const modelCards = synthesis?.needs ?? []
  const notice = degraded ? [noticePane(degraded)] : []

  const seen: Seen[] = [
    /**
     * A shelf entry of its OWN, ahead of the model's.
     *
     * Not folded in with `synthesis`, for two reasons. Switching off "the
     * model's opinions on my home screen" is a reasonable thing to want and
     * must not also switch off a conflict warning or a leave-by time — those
     * are not opinions. And the `synthesis` entry is only created when the
     * model produced cards at all, so riding on it would send every computed
     * card to the end of the feed on any build where the model was unreachable,
     * which is exactly when they matter most.
     */
    ...(attentionCards.length ? [{ id: 'attention', kind: 'synthesis' as const, label: 'What I worked out' }] : []),
    ...(modelCards.length ? [{ id: 'synthesis', kind: 'synthesis' as const, label: 'What needs you' }] : []),
    ...sources.map((s) => ({ id: s.id, kind: 'source' as const, label: s.title })),
    ...panes.map((p) => ({ id: p.paneId, kind: 'pane' as const, label: p.title })),
  ]
  const shelf = await reconcile(seen)

  /**
   * The model's cards ride on ONE shelf entry.
   *
   * They are minted with fresh ids every pass, so an entry each would mean a
   * settings screen that grows a dead row every time it thinks. Switching
   * `synthesis` off is therefore "stop putting the model's opinions on my home
   * screen" — which is a real preference someone might hold, and is exactly the
   * granularity at which it can be honoured.
   */
  const entries: { id: string; value: FeedItem }[] = [
    /**
     * Computed cards keep their OWN ids on the item, unlike the model's, which
     * all collapse onto the literal id 'synthesis'.
     *
     * They have to: the id is what `noveltyOf` keys on across passes, what the
     * client uses to open the report, and what `dismissed` records. A card
     * about the dinner on the 12th must be the same object tomorrow, or the
     * app cannot tell that it has already said this.
     */
    ...attentionCards.map((n) => ({ id: 'attention', value: { id: n.id, kind: 'synthesis' as const, need: n } })),
    ...modelCards.map((n) => ({ id: 'synthesis', value: { id: 'synthesis', kind: 'synthesis' as const, need: n } })),
    ...sources.map((n) => ({ id: n.id, value: { id: n.id, kind: 'source' as const, need: n } })),
    ...panes.map((p) => ({ id: p.paneId, value: { id: p.paneId, kind: 'pane' as const, pane: p } })),
  ]

  // The notice is not a shelf entry and cannot be switched off. It is the app
  // saying it is broken, and a feed that can hide that is a feed that lies.
  const items: FeedItem[] = [
    ...notice.map((n): FeedItem => ({ id: n.id, kind: 'source', need: n })),
    ...applyShelf(shelf, entries),
  ]

  const feed: Feed = {
    // His zone, not the runtime's — on the edge the runtime is UTC and this
    // stamped the previous day's date on anything built after his midnight.
    /**
     * THE DATE ON HIS HOME SCREEN IS COMPUTED, NOT QUOTED.
     *
     * This was `synthesis?.dateLabel ?? …` — the model's answer preferred, with a
     * computed value only as a fallback. That preference is precisely how a wrong
     * date reached the top of the screen: everything else had been moved onto his
     * stored zone, and the header still said the 8th on the 9th because a model
     * had been told the wrong instant and faithfully repeated it.
     *
     * A model may not author this value at all now. What it may still influence is
     * the CONVENTION — day-month or month-day is a fact about him, not about the
     * calendar — and that is a stored preference, read here. The arithmetic is
     * `clock.ts`'s, always.
     */
    dateLabel: headerDate(world, now),
    clock: synthesis?.clock ?? '12h',
    place: synthesis?.place ?? null,
    readLine: synthesis?.readLine ?? (panes.length || sources.length ? 'Here’s what I already know.' : ''),
    ask: synthesis?.ask ?? { opening: 'What’s on your mind?', chips: [] },
    quietLog: synthesis?.quietLog ?? [],
    items,
    /**
     * `needs` is how a tapped card resolves. A card in `items` but not here
     * draws and then fails to open — `resolve` returns unresolvable and the app
     * shows an error toast. Both lists, always.
     */
    needs: [...notice, ...attentionCards, ...modelCards, ...sources],
    /*
      Built from the SAME arrays, after the shelf has run — so a domain he
      switched off is gone from the deck for the same reason and at the same
      moment it is gone from everywhere else, rather than by a second rule that
      can drift out of step with the first.
    */
    deck: buildDeck(sources, attentionCards, modelCards, await readHome(), now, world.timeZone, {
      intelligence: slotThree(now, world.timeZone),
    }),
    shelf,
    at,
    /**
     * THE FEW TYPED FACTS THE CLIENT'S RESOLUTION LADDER READS.
     *
     * Deliberately a closed, tiny set rather than the personal model: these are
     * the slots a task can be BLOCKED on that no amount of looking at the screen
     * can answer. How he usually travels and where to treat as home are not
     * derivable from a calendar event, so without them a departure question
     * could only ever end in a question back — which is the "asked for something
     * the app already knows" failure the ladder exists to prevent.
     *
     * Everything else stays on the server. A client that receives the personal
     * model is a client that will eventually reason with it.
     */
    known: {
      ...(getFact<string>(person, 'transport.default')?.value
        ? { transportMode: String(getFact<string>(person, 'transport.default')!.value) }
        : {}),
      ...(getFact<string>(person, 'identity.home')?.value
        ? { origin: String(getFact<string>(person, 'identity.home')!.value) }
        : {}),
    },
    degraded,
    provider,
    model,
  }

  await keep(feed)
  return feed
}

/**
 * Fold the model's belief revisions back into the world.
 *
 * The world-model loop, which used to live in the `/api/think` route and would
 * have been quietly lost by moving synthesis in here. Confidence 0 is
 * RETIREMENT rather than a weak belief: his life moved on and the claim is now
 * false, so it is dropped instead of carried into every future prompt as a
 * contradiction.
 */
async function applyBeliefs(world: World, result: ThinkResult): Promise<void> {
  if (!result.beliefUpdates.length) return
  const byId = new Map(world.beliefs.map((b) => [b.id, b]))
  for (const b of result.beliefUpdates) {
    if (b.confidence === 0) byId.delete(b.id)
    else byId.set(b.id, b)
  }
  world.beliefs = [...byId.values()]
  // The pass that just wrote these is the likeliest source of a duplicate —
  // it mints ids freely and does not reliably reuse the one it used last time.
  // Settling again here is what stops a restatement surviving to the next
  // prompt, where it would be read as two independent pieces of evidence.
  await settle(world, new Date(), { write: false })
  /**
   * BELIEFS ONLY. The whole document is not written back.
   *
   * Synthesis takes as long as a model takes, so `world` here is an old copy of
   * everything except the beliefs this function just revised. Writing it whole
   * would restore a pre-synthesis `person` over any correction he made while the
   * model was thinking — which is a several-second window on every single build.
   */
  await mutateWorld((fresh) => {
    fresh.beliefs = world.beliefs
    fresh.profile = world.profile
  }, { label: 'the beliefs from this pass' }).catch(() => undefined)
}

/**
 * Reconcile, dedupe, and re-derive the profile. Writes only if something moved.
 *
 * Returns nothing on purpose: every caller wants the world corrected, none of
 * them want to decide what to do about it. What was contested is recorded ON
 * the belief, which is where the next reader will look.
 */
async function settle(world: World, now: Date, opts: { write?: boolean } = {}): Promise<void> {
  // What this app has actually DONE, as opposed to what it believes about
  // itself. Passed in rather than imported into `world.ts` so the world model
  // stays a model of HIM and does not acquire a dependency on the action layer.
  // Unavailable is not the same as empty, and `reconcileBeliefs` distinguishes
  // them: an unreadable log turns the check off rather than contesting
  // everything it cannot vouch for.
  const performed = historyAvailable()
    ? await history(500)
        .then((r) => r.map((a) => ({ kind: a.kind, at: a.at, outcome: a.outcome })))
        .catch(() => undefined)
    : undefined

  const contested = reconcileBeliefs(world, now, { performed })
  const merged = dedupeBeliefs(world, now)
  const profile = deriveProfile(world, now)
  const movedProfile = profile !== world.profile
  world.profile = profile
  if (opts.write === false) return
  if (!contested.length && !merged && !movedProfile) return
  try {
    // Beliefs and profile only, for the same reason `applyBeliefs` is narrow:
    // this runs at the top of a build and must not carry the rest of the
    // document forward over anything that lands while the build is running.
    await mutateWorld((fresh) => {
      fresh.beliefs = world.beliefs
      fresh.profile = world.profile
    }, { label: 'reconciled beliefs' })
  } catch {
    // A correction that fails to persist is still applied in memory, so this
    // build reasons over the settled world and the next one tries again.
  }
}

/**
 * Every open pane, in the shape the splash draws.
 *
 * Reads the head revision's stored presentation rather than re-executing
 * anything. That is what makes opening the app instant and what makes it show
 * the same thing it showed before the reload: a revision is a snapshot of what
 * he saw, and painting it is a read. Whether it should be re-run is a separate
 * question, asked by `freshen` below and by the cron, and answered by producing
 * a NEW revision rather than by mutating this one.
 */
async function livePanes(): Promise<FeedPane[]> {
  let views: Awaited<ReturnType<typeof protocol.all>> = []
  try {
    views = await protocol.all()
  } catch {
    // No revision store installed, or it failed to read. Panes are the one
    // thing here that can legitimately be absent; the rest of the feed stands.
    return []
  }
  return views
    /**
     * A PANE THAT HAS NEVER ANSWERED ANYTHING IS NOT A PANE.
     *
     * Two of these were sitting on his home screen — "Show route to Avano" and
     * "Show route to Odelia" — each an empty card reading "No route found",
     * repainted on every single load since the day the routing call failed.
     * Nothing was wrong with the pane machinery: it faithfully preserved a
     * revision, which is exactly its job. The mistake was upstream, in treating
     * a run that never ran as a result worth keeping.
     *
     * `everAnswered` is what makes this safe to do here, and why the test is
     * on the HISTORY rather than the head: a pane that has worked before and
     * whose refresh just failed keeps its place and keeps showing the last good
     * revision, which is the guarantee `refresh` was written to provide and
     * which this must not quietly take away. Only a pane that has never once
     * produced anything, across every revision it has, is withheld.
     *
     * "Withheld" means from the splash and nothing more. The pane keeps its id,
     * its whole history and its plan, stays reachable, and returns on its own
     * the first time a run of it succeeds.
     */
    .filter((v) => v.everAnswered)
    .map((v) => ({
    paneId: v.pane.id,
    // The pane's own name, which is his instruction and survives refreshing.
    // The summary is a last resort for a pane created before names were kept.
    title: v.pane.title || v.revision.intent || v.summary,
    panes: v.revision.presentation,
    revisionId: v.revision.id,
    intent: v.revision.intent,
    planClass: v.planClass,
    summary: v.summary,
    pinned: v.pane.pin?.mode ?? null,
    pendingRevisionId: v.pending?.id,
    canUndo: v.canUndo,
    canRedo: v.canRedo,
    refresh: v.pane.refresh.mode,
    updatedAt: v.revision.at,
  }))
}

/**
 * Bring every pane that wants it up to date, then rebuild.
 *
 * The two policies are asked separately because they are different questions.
 * `on-open` is about HIM arriving and only makes sense on a request he made;
 * `interval` is about the clock and runs whether or not anyone is looking. The
 * cron passes `arriving: false` for exactly that reason — a pane he has not
 * looked at in a week must not behave as though he were standing in front of
 * it every three hours.
 *
 * Nothing here can lose anything. Every refresh produces a revision, a content
 * pin holds the screen and parks the new one in `pending`, and a source that
 * fails leaves the last good revision exactly where it was.
 */
export async function freshen(opts: { arriving: boolean; auth?: Record<string, string> } = { arriving: false }): Promise<{
  refreshed: string[]
  failed: string[]
}> {
  const refreshed: string[] = []
  const failed: string[] = []

  let views: Awaited<ReturnType<typeof protocol.all>> = []
  try {
    views = await protocol.all()
  } catch {
    return { refreshed, failed }
  }

  for (const v of views) {
    const wants =
      v.pane.refresh.mode === 'interval' ||
      (opts.arriving && v.pane.refresh.mode === 'on-open') ||
      v.pane.refresh.mode === 'on-change'
    if (!wants) continue
    // `refreshDue` owns the interval clock; asking it per pane keeps the
    // "has enough time passed" decision in one place rather than two.
    if (v.pane.refresh.mode === 'interval') continue
    try {
      const r = await protocol.refresh(v.pane.id, { auth: opts.auth, by: opts.arriving ? 'on-open' : 'watch' })
      if (r) refreshed.push(v.pane.id)
    } catch {
      failed.push(v.pane.id)
    }
  }

  try {
    for (const d of await protocol.refreshDue({ auth: opts.auth })) {
      ;(d.ok ? refreshed : failed).push(d.paneId)
    }
  } catch {
    /* the interval sweep failing must not lose the on-open work above */
  }

  return { refreshed, failed }
}
