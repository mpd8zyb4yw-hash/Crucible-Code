import { worldStore, type WorldStore } from './store.js'
/**
 * Runtime import, and safe in this direction only: `person.ts` imports nothing
 * from here but TYPES, so the emitted `person.js` has no edge back and the
 * cycle exists solely in the type graph.
 */
import { readPerson, renderPerson, type Person_ } from './person.js'
import { dayIn, daysBetween, isZone } from './clock.js'

/**
 * Re-exported rather than re-implemented. Both of these lived here and are now
 * in `clock.ts`, which owns every date expression in the app; the exports stay
 * so the twenty-odd call sites that import them from here keep working, and so
 * that there is exactly one implementation behind both names.
 */
export { dayIn, daysBetween } from './clock.js'

/**
 * The world model.
 *
 * An assistant that only emits advice goes stale in a day. This is the thing
 * that keeps it honest: a running set of beliefs about the user's life, each
 * carrying where it came from and how sure we are, where confidence DECAYS
 * with time. A belief that decays past the point of usefulness is what makes
 * the assistant turn around and ask ("you shopped Tuesday, but I never saw the
 * basket — how much pasta is left?"). That question is not a feature; it is
 * what this system does when it needs a fact it no longer trusts.
 */


export interface Observation {
  id: string
  /** Which connector saw it: 'calendar' | 'email' | 'health' | 'user' | 'seed' */
  source: string
  /** ISO date the thing happened (not when we saw it). */
  at: string
  /** Plain-language description of the raw event. */
  text: string
  /**
   * The same event as fields, when the connector had them.
   *
   * `text` is what the MODEL reads — one sentence, because the synthesis prompt
   * is a budget and prose is what a language model reasons over. But it is a
   * lossy rendering, and for a long time it was the only thing kept: an email
   * became the string `Email from X — "Subject": snippet`, which no interface
   * can turn back into a message you can open, reply to, or mark read. Every
   * widget in the app was impossible for want of the fields that were thrown
   * away at sync time.
   *
   * So both are stored. `text` stays exactly as it was, so nothing about the
   * brain changes; `data` is what the panes render from. Observations written
   * before this existed simply have no `data`, and a pane that finds none falls
   * back to showing `text` — an old world model degrades, it does not break.
   */
  data?: ObservationData
  /**
   * When this record's CONTENT last changed under a re-sync, as opposed to when
   * the thing happened (`at`) or when we first saw it.
   *
   * Beliefs rest on observation ids, and ids are stable — so a belief formed
   * about "Comic concert in avano" stayed word-for-word true about an id whose
   * content had since been rewritten, and nothing anywhere noticed. This is the
   * timestamp that makes that detectable: a belief confirmed BEFORE the ground
   * it cites moved is a belief nobody has checked since it could have become
   * false. See `reconcileBeliefs`.
   *
   * Absent on observations that have never been re-observed with new content,
   * which is the overwhelming majority of them.
   */
  changedAt?: string
}

/**
 * Structured payloads, one shape per kind of thing a connector can see.
 *
 * Discriminated on `kind` rather than on the observation's `source`, because
 * the two are not the same: a mail-shaped thing could arrive from somewhere
 * other than Gmail, and a source can produce more than one kind.
 */
export type ObservationData =
  | {
      kind: 'email'
      messageId: string
      threadId?: string
      from: string
      fromName?: string
      to?: string
      subject: string
      snippet?: string
      /** Full body, when it has been fetched. Absent until the card is opened. */
      body?: string
      unread?: boolean
      labels?: string[]
    }
  | {
      kind: 'event'
      eventId: string
      calendarId?: string
      summary: string
      /** ISO datetime, or a plain date for all-day events. */
      start: string
      end?: string
      allDay?: boolean
      location?: string
      description?: string
      attendees?: { email: string; name?: string; response?: string }[]
      /** Our own response: accepted | declined | tentative | needsAction. */
      response?: string
      organizer?: string
    }
  | {
      kind: 'steps'
      /** One entry per day, oldest first. */
      days: { date: string; steps: number }[]
      average?: number
    }
  | {
      kind: 'video'
      videoId: string
      title: string
      channel?: string
      thumbnail?: string
      publishedAt?: string
      duration?: string
      /**
       * Runtime in seconds, off the same `videos.list` record as the title.
       *
       * Kept as a number rather than the API's `PT1H4M` string because it is
       * what gets COMPARED — "only ones over thirty minutes" is a filter the
       * person and the model both reach for, and parsing a duration string at
       * render time in every renderer is how one of them ends up wrong.
       */
      durationSec?: number
      description?: string
    }
  | {
      kind: 'place'
      label: string
      lat: number
      lon: number
      address?: string
    }

export interface Belief {
  id: string
  /** A claim about the user's life, in plain language. */
  statement: string
  /** Observation ids this rests on. A belief with no basis is not a belief. */
  basis: string[]
  /** 0..1 at the moment it was last confirmed. */
  confidence: number
  /** ISO date confidence was last refreshed by real evidence. */
  confirmedAt: string
  /**
   * Confidence points lost per day. "Pasta is running low" rots fast; "he
   * lives in Italy" does not. The model sets this when it forms the belief.
   */
  decayPerDay: number
  /**
   * Set when the evidence under this belief moved after it was last confirmed.
   *
   * Confidence decay answers "how long since anyone checked". It does NOT answer
   * "the thing this rests on has since changed", and those are different: a
   * belief can be two hours old, at 0.95, and already contradicted by the very
   * observation it cites. Decay would carry it into every prompt for days as a
   * confident fact.
   *
   * A contested belief is not deleted — the model formed it for a reason, and
   * deleting it silently would lose that. It is knocked below the stale
   * threshold and given the reason, so the next pass sees both the claim and
   * what happened to it, and can ask him rather than guess.
   */
  contested?: { at: string; note: string }
}

/**
 * A standing interest.
 *
 * Beliefs are what we know; a track is what he has asked us to keep watching.
 * Nothing here is a category the app ships with — weather, flight status, a
 * restaurant's opening hours and a permit deadline are all the same object.
 * Either he asked for it or the assistant proposed it and he accepted; there
 * is no third kind, and no list of supported subjects anywhere in the code.
 */
export interface Track {
  id: string
  /** What to watch, in plain language. */
  what: string
  /** What he wants OUT of it — the intent that decides what is worth raising. */
  why: string
  /**
   * A searchable question for the open web, or null when the thing is already
   * arriving through a connector and only needs watching.
   */
  question: string | null
  /** How often it is worth looking again. Weather is hours; a law is months. */
  everyHours: number
  lastRunAt: string | null
  active: boolean
  /** Who put it there. Kept so the assistant never silently drops his. */
  by: 'user' | 'agent'
}

export interface World {
  /**
   * WHICH SHAPE THIS DOCUMENT IS IN.
   *
   * `objects.ts` has had a `migrate()` since the beginning and `ir.ts` carries a
   * version number; the world model — the one document that holds everything the
   * assistant knows about him and the only one that can never be regenerated —
   * had neither. So a structural change to a stored concept had nowhere to be
   * applied: the code would simply read the old shape, find a field missing,
   * and treat "written before this existed" as "he has none of these".
   *
   * That was survivable while everything in here was a list of sentences. It
   * stopped being survivable when the typed personal model landed, because
   * `person` holds his corrections — the one class of data where silently
   * reading a stale shape means quietly reverting something he told us.
   *
   * Absent means version 0: a document written before this field, which
   * `migrateWorld` brings forward. It is never absent after a write.
   */
  version?: number
  /**
   * Stable background the model should always know, as one block of prose.
   *
   * KEPT, AND NO LONGER THE ONLY PLACE STRUCTURE CAN LIVE. This is a paragraph
   * a model wrote and a model reads; it cannot be queried, corrected field by
   * field, or cited. "You walk to the Sunday market" being in here is why the
   * app could not answer "does he walk?" without a language model call, and why
   * correcting it meant rewriting a paragraph.
   *
   * It stays because it is genuinely good at what it is for — carrying the
   * shapeless remainder that no type will ever hold. Everything the CODE reads
   * moved to `person`.
   */
  profile: string
  /**
   * The typed personal model: identity, goals, preferences, people, routines,
   * constraints, and the disagreements between sources.
   *
   * Optional, and read through `readPerson` rather than directly, because every
   * world stored before this existed has none. See `person.ts` for why prose
   * was not enough.
   */
  person?: Person_
  observations: Observation[]
  beliefs: Belief[]
  tracks: Track[]
  /**
   * Per-source consent. One Google sign-in, then he says source by source what
   * it may actually read. Absent means on — signing in is the consent for the
   * default set, and switching one off is a decision he made, so it persists.
   */
  sources: Record<string, boolean>
  /**
   * Who decides what reaches the screen: 'auto' lets the assistant curate,
   * 'manual' restricts the feed to what he has explicitly asked to see.
   */
  curation: 'auto' | 'manual'
  /**
   * The IANA zone his days actually begin and end in, e.g. 'Europe/Rome'.
   *
   * WHY THIS HAS TO BE STORED RATHER THAN ASSUMED. Every day-boundary question
   * in this app — what date the header shows, which event counts as "today",
   * whether a cached feed has crossed into a new day — was answered with the
   * RUNTIME's zone. On the Mac that is his zone and everything looked right. On
   * Cloudflare the runtime is UTC, and he lives two hours ahead of it, so
   * between midnight and 02:00 his time the edge believed it was still
   * yesterday. That is not a rounding error: his home screen was stamped
   * 8/8/2026 at one in the morning on the 9th, and every "is this today" test
   * behind it agreed with the wrong answer.
   *
   * It also made the Mac and the edge disagree about the same stored feed,
   * which the whole injectable-store design exists to prevent.
   *
   * Absent means fall back to the runtime's zone — the old behaviour, and
   * correct on the Mac. See `timeZoneBy` for where it comes from.
   */
  timeZone?: string
  /**
   * Where `timeZone` was learned, because the sources are not equally good.
   *
   * `connector` was the first and obvious choice — Google Calendar reports a
   * zone on the events call the app already makes. Checked against his actual
   * account, it says **UTC** while he is in Italy. That is the default nobody
   * ever changes, and taking it would have stored a wrong zone, left every date
   * computation as broken as it was, and made it look fixed.
   *
   * `device` is the browser's own `resolvedOptions().timeZone` — the zone the
   * machine showing the screen is standing in. It always wins, and a connector
   * may only fill in when nothing better is known.
   */
  timeZoneBy?: 'device' | 'connector'
  /**
   * WHEN EACH SOURCE WAS LAST READ SUCCESSFULLY, by source name.
   *
   * The thing that made per-source freshness possible, and whose absence is why
   * everything was pulled on one three-hourly schedule: there was nowhere to
   * record that calendar had been read four minutes ago and YouTube not for an
   * hour, so the only available policy was "all of it, rarely".
   *
   * Written per source and only on success — see `sync.ts`. A source that
   * failed keeps its old stamp and therefore stays overdue, which is what makes
   * a transient Gmail error cost one retry instead of a whole cadence.
   *
   * Absent means never read, which reads as due. Every account starts there.
   */
  synced?: Record<string, string>
}

/**
 * The current shape of the stored document.
 *
 * Bumped whenever a stored concept changes shape in a way a reader cannot infer
 * from the data itself. Adding an OPTIONAL field does not need a bump — an
 * absent optional is already a legal value and every reader handles it. What
 * needs a bump is a field changing meaning, changing type, or moving.
 */
export const WORLD_VERSION = 1

const EMPTY: World = {
  version: WORLD_VERSION,
  profile: '',
  observations: [],
  beliefs: [],
  tracks: [],
  sources: {},
  curation: 'auto',
}

/**
 * Bring a stored document forward to the current shape.
 *
 * Written as a ladder of single steps rather than one "fix everything" pass, so
 * a document at version 0 and a document at version 3 both arrive at the top by
 * running only the transformations that actually apply to them. Each step is
 * idempotent and each one is allowed to assume the step below it has run.
 *
 * DELIBERATELY TOLERANT OF RUBBISH. This reads a JSON file a person is invited
 * to edit by hand (see `node-runtime.ts`) and a KV value that has been written
 * by several versions of this app. A field of the wrong type is coerced or
 * dropped, never thrown on: the alternative is that one bad array costs him his
 * entire world model on the next read.
 */
export function migrateWorld(raw: unknown): World {
  if (!raw || typeof raw !== 'object') return { ...EMPTY }
  const held = raw as Partial<World> & Record<string, unknown>
  const at = typeof held.version === 'number' ? held.version : 0

  const w: World = {
    ...EMPTY,
    ...held,
    // Every collection is normalised to an array of the right shape here, once,
    // rather than defensively at each of the forty places that read them.
    observations: Array.isArray(held.observations) ? held.observations : [],
    beliefs: Array.isArray(held.beliefs) ? held.beliefs : [],
    tracks: Array.isArray(held.tracks) ? held.tracks : [],
    sources: held.sources && typeof held.sources === 'object' ? held.sources : {},
    curation: held.curation === 'manual' ? 'manual' : 'auto',
    profile: typeof held.profile === 'string' ? held.profile : '',
  }

  /**
   * 0 → 1: the typed personal model became load-bearing.
   *
   * `person` was introduced as an optional field, so a v0 document simply has
   * none and `readPerson` fills in an empty one. What version 1 adds is the
   * GUARANTEE that the field exists once written, which is what lets a later
   * migration reach inside it — a migration that has to cope with the field
   * being absent cannot safely restructure what is in it.
   *
   * A zone that is stored but unusable is also cleared here. `dayIn` falls back
   * to the runtime when it cannot parse a zone, so an unusable stored zone made
   * the world CLAIM to know where his days begin while every read silently
   * disagreed — the worst of the three possible states.
   */
  if (at < 1) {
    if (w.timeZone && !isZone(w.timeZone)) {
      delete w.timeZone
      delete w.timeZoneBy
    }
  }

  w.version = WORLD_VERSION
  return w
}

/**
 * Record where his days begin, keeping the better source.
 *
 * Returns true if anything changed, so callers know whether to persist. A zone
 * that has merely stopped being reported is not a zone that has changed, so
 * this only ever writes a value and never clears one.
 */
export function noteTimeZone(w: World, tz: string, by: 'device' | 'connector'): boolean {
  // Rejected here rather than at each call site: an unusable zone stored is
  // worse than none, because `dayIn` would silently fall back on every read
  // while the world claims to know better.
  if (!tz || !isZone(tz)) return false
  // A connector may inform, but never overrule the machine he is looking at.
  if (by === 'connector' && w.timeZoneBy === 'device') return false
  if (w.timeZone === tz && w.timeZoneBy === by) return false
  w.timeZone = tz
  w.timeZoneBy = by
  return true
}

export async function readWorld(): Promise<World> {
  try {
    return migrateWorld(await worldStore().read())
  } catch {
    return { ...EMPTY }
  }
}

export async function writeWorld(w: World): Promise<void> {
  w.version = WORLD_VERSION
  await worldStore().write(w)
}

// ── Writing without losing anyone else's work ────────────────────────────────

/**
 * READ, MUTATE AND WRITE THE WHOLE DOCUMENT — SAFELY THIS TIME.
 *
 * Every world mutation in this app is a read-modify-write of the entire
 * document, and until now that was simply a known hazard: two overlapping
 * passes each read the same document, each applied its own change, and whichever
 * wrote second silently destroyed the first one's work. It was documented and
 * tolerated because the stakes were low — losing one re-synced observation costs
 * nothing, the next sync writes it again.
 *
 * The stakes are not low any more. The document now holds `person`, and `person`
 * holds his CORRECTIONS. A lost write there is not a lost observation; it is the
 * app reverting something he told it, with no error anywhere and no way for him
 * to know. The exact sequence, which takes about two seconds in practice:
 *
 *   1. A feed build reads the world (t=0) and starts geocoding, which is slow.
 *   2. He taps "I take the bus" on the card in front of him. The correction
 *      reads the world, sets `transport.default = transit` by:'user', writes.
 *   3. The build finishes, having never seen his answer, and writes back the
 *      document it read at t=0. His correction is gone.
 *
 * `mayReplace` cannot help: it protects a user fact from being OVERWRITTEN by an
 * agent, and nothing here overwrote it — the whole document containing it was
 * replaced by an older copy of itself.
 *
 * So: mutations go through this, and this does three things.
 *
 *   - IT SERIALISES within the process. Two mutations on one host cannot
 *     interleave at all, which removes the whole class on the Mac and within a
 *     single Worker isolate.
 *
 *   - IT DETECTS a document that moved underneath it, via the store's optional
 *     compare-and-set, and RE-RUNS the mutation against the fresh document
 *     rather than forcing its stale copy over the top. Re-running rather than
 *     merging is what makes this correct without every caller having to write a
 *     merge function: the mutation is a function of the document, so applied to
 *     the newer document it produces the newer document plus its own change.
 *
 *   - IT REPORTS a conflict it could not resolve, rather than swallowing it.
 *
 * WHAT THIS IS NOT. Cloudflare KV has no atomic compare-and-set, so on the edge
 * the check is read-hash-compare-write: it reliably catches a write that
 * completed before ours and cannot catch one that lands in the microseconds
 * between our check and our put. That residual window is honestly narrower by
 * orders of magnitude than the one it replaces, and closing it entirely needs a
 * Durable Object — which is the right next step and is not this change.
 */
export interface MutateResult<T> {
  world: World
  result: T
  /** How many times the mutation had to be re-run because the document moved. */
  retries: number
}

/**
 * The in-process queue.
 *
 * A single promise chain rather than a keyed lock table, because there is
 * exactly one document. Every mutation waits for the one before it, so a caller
 * that reads inside `mutateWorld` is guaranteed nothing else in this process is
 * between its read and its write.
 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * How many times to re-run a mutation whose document moved before giving up.
 *
 * RAISED FROM FOUR, and the reason is a real failure rather than a tuning
 * preference. Four was chosen against the in-process queue, where the only thing
 * that could collide with a mutation was another host entirely — so losing four
 * races in a row genuinely did mean something was writing continuously.
 *
 * Once writes are genuinely concurrent (see `mutateThrough`), a collision stops
 * being evidence of anything: ten corrections arriving at once produce a
 * thundering herd in which the unlucky ones lose several rounds purely by
 * arithmetic, and a caller was being told his correction could not be applied
 * when nothing was wrong at all. The count is now well above the number of
 * writers this single-tenant app can plausibly have at one instant, and the
 * BACKOFF below is what actually resolves contention.
 */
const MAX_RETRIES = 12

/**
 * Wait a moment before trying again, for a moment that is not the same moment
 * everyone else picked.
 *
 * Without the jitter, N losers re-read in the same turn, re-run their mutations
 * in the same turn, and re-collide — so the loop's throughput does not improve
 * with retries, it just burns them. With it, the herd spreads out and each write
 * lands in a turn of its own. Capped low: this is a correction he is waiting on,
 * not a background job.
 */
function backoff(retries: number): Promise<void> {
  const ceiling = Math.min(40, 2 ** retries)
  return new Promise((r) => setTimeout(r, Math.random() * ceiling))
}

/**
 * THE RETRY LOOP, WITH NO QUEUE AND AN EXPLICIT STORE.
 *
 * Separated out for one reason, and it is a testing reason that is worth the
 * extra export: the queue above removes concurrency WITHIN a process, and the
 * thing that has to be proved is what happens BETWEEN processes — two edge
 * requests, two isolates, one document. A test that went through `mutateWorld`
 * would be serialised by the queue and would prove nothing about the case the
 * Durable Object exists for.
 *
 * So `scripts/world.mjs` calls this directly, twice, against two store clients
 * pointed at one room — which is exactly what two isolates do — and the code
 * under test is this function rather than a restatement of it.
 */
export async function mutateThrough<T>(
  store: WorldStore,
  mutate: (w: World) => T | Promise<T>,
  opts: { label?: string } = {}
): Promise<MutateResult<T>> {
  let retries = 0

  for (;;) {
      /**
       * The token is the document as it was when we read it. A store that
       * cannot produce one gets a null token and `writeIfUnchanged` degrades to
       * an ordinary write — the in-process queue is still doing its job, and a
       * store with no CAS is a store we cannot do better on.
       */
      const versioned = store.readVersioned
        ? await store.readVersioned()
        : { world: await store.read(), token: null as string | null }
      const world = migrateWorld(versioned.world)

      const result = await mutate(world)
      world.version = WORLD_VERSION

      const wrote = store.writeIfUnchanged
        ? await store.writeIfUnchanged(world, versioned.token)
        : (await store.write(world), true)

      if (wrote) return { world, result, retries }

      retries++
      if (retries > MAX_RETRIES) {
        /**
         * Refusing rather than forcing.
         *
         * Four rounds of losing a race means something is writing continuously,
         * and the one thing that must not happen is that we settle it by
         * flattening whatever that is. The caller learns the mutation did not
         * apply; a correction endpoint can then tell him so, which is far better
         * than telling him it worked.
         */
        throw new Error(
          `Could not apply ${opts.label ?? 'a change'} — the world model kept changing underneath it (${retries} attempts).`
        )
      }
      await backoff(retries)
  }
}

export async function mutateWorld<T>(
  mutate: (w: World) => T | Promise<T>,
  opts: { label?: string } = {}
): Promise<MutateResult<T>> {
  const run = () => mutateThrough(worldStore(), mutate, opts)
  const next = queue.then(run, run)
  // The chain must survive a failed mutation, or one thrown error deadlocks
  // every later write in the process.
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/**
 * Fold freshly observed things into the world, REPLACING what is already held
 * under the same id rather than skipping it.
 *
 * This used to drop any observation whose id it had seen before, which sounds
 * like sensible de-duplication and is in fact how a connector's output gets
 * fossilised. Ids are stable and content-free — a calendar event is `gcal-<id>`
 * for as long as it exists — so "already seen" was being read as "already
 * known", and the stored copy could never be corrected or enriched.
 *
 * The concrete failure: events first synced before observations carried a
 * structured `data` field stayed text-only permanently. Every later sync
 * fetched them in full, saw the id, and threw the structured version away. The
 * calendar pane, finding nothing with `data.kind === 'event'`, fell back to
 * printing sentences — so a rich interactive surface silently degraded to two
 * lines of prose on a world model that no amount of re-syncing could repair.
 *
 * A connector that has just fetched a record is the authority on that record.
 * Replacing is also what makes an edited event title or a moved start time show
 * up at all, which skipping never did either.
 */
/**
 * SOMEWHERE ELSE THAT ALSO WANTS TO SEE EVERY OBSERVATION.
 *
 * The dual-write hook for the memory core (`server/memory/`), and the reason it
 * is a sink installed on this function rather than a call added at each
 * connector: `addObservations` is the ONE funnel every source already goes
 * through — Google, YouTube, tracks, capabilities, the fixture — so hooking it
 * here means the ledger sees exactly what the world document sees, from the same
 * fetch, with no chance of the two drifting because somebody added a connector
 * and forgot the second call.
 *
 * ABSENT BY DEFAULT. A host that installs nothing behaves exactly as it did
 * before this existed, which is what makes the migration's first phase a
 * genuinely additive change rather than a change everybody has to trust.
 *
 * The sink is also FORBIDDEN FROM FAILING A SYNC. See the call site: it is
 * awaited inside a try/catch that swallows, because a ledger that is unavailable
 * must cost the memory core its evidence and must not cost him his calendar.
 */
export type ObservationSink = (obs: Observation[], now: Date, opts: { timeZone?: string }) => void | Promise<void>

let observationSink: ObservationSink | null = null

export function setObservationSink(sink: ObservationSink | null): void {
  observationSink = sink
}

/**
 * WHAT A SYNC IS AUTHORITATIVE FOR.
 *
 * `foldObservations` could only ever ADD or UPDATE, and that one property is the
 * whole reason his calendar was a graveyard. Google is asked for events between
 * now and next week; anything it does not return is an event that has been
 * deleted, cancelled, or moved — and the fold's answer to a record that simply
 * stopped arriving was to keep it, forever, exactly as it last looked. Ten days
 * of finished commitments accumulated in the world document and no code path
 * anywhere could remove one.
 *
 * The connector declares what its batch is COMPLETE for, as a predicate over the
 * records it holds, because only the connector knows what it asked for. If the
 * calendar query covered [now, +7d], then a held event that overlaps that window
 * and was not in the reply does not exist any more, and that is a fact rather
 * than an inference.
 *
 * THREE RULES, and each one is a way this can destroy his data if it is wrong:
 *
 *   · Declared only after a SUCCESSFUL fetch. A network error is not evidence
 *     that his week is empty.
 *   · Declared only when the reply was not truncated. A capped page says nothing
 *     about what came after it.
 *   · Scoped to one source. A calendar sync may not retire an email.
 */
export type Coverage = {
  source: string
  /** Would this held record have been in the batch, had it still existed? */
  covers: (o: Observation) => boolean
}

export async function addObservations(
  obs: Observation[],
  now = new Date(),
  opts: { timeZone?: string; coverage?: Coverage[]; synced?: string[] } = {}
): Promise<World> {
  /**
   * Transactional, because a sync is the LONGEST world mutation there is and
   * therefore the likeliest to be overtaken by a correction. Google is pulled
   * for four sources; by the time the observations are folded in, several
   * seconds have passed and he may well have tapped something.
   */
  const { world } = await mutateWorld((w) => {
    foldObservations(w, obs, now, opts)
  }, { label: 'new observations' })

  /**
   * AFTER the world has landed, never before, and never in a way that can
   * throw past this line.
   *
   * Order matters: the world document is the thing the app runs on today and the
   * ledger is the thing it will run on later. Writing the ledger first would
   * mean a failed world write left evidence of a sync that, as far as every
   * surface is concerned, never happened.
   */
  if (observationSink && obs.length) {
    try {
      await observationSink(obs, now, opts)
    } catch {
      /* the ledger is additive; losing a batch costs evidence, not his data */
    }
  }
  return world
}

/** The fold itself, so it can be re-run against a fresh document on a retry. */
function foldObservations(
  w: World,
  obs: Observation[],
  now: Date,
  opts: { timeZone?: string; coverage?: Coverage[]; synced?: string[] } = {}
): void {
  if (opts.timeZone) noteTimeZone(w, opts.timeZone, 'connector')
  /*
    STAMPED INSIDE THE SAME TRANSACTION AS THE OBSERVATIONS THEY CAME FROM.

    Not a second write afterwards: a sync whose observations landed and whose
    stamp did not would be re-pulled on the very next tick forever, and one
    whose stamp landed and whose observations did not would go quiet for a whole
    cadence. Both are avoided by there being one write.
  */
  if (opts.synced?.length) {
    const at = now.toISOString()
    w.synced = { ...(w.synced ?? {}) }
    for (const source of opts.synced) w.synced[source] = at
  }
  const incoming = new Map(obs.map((o) => [o.id, o]))
  const held = new Set(w.observations.map((o) => o.id))

  /*
    RETIREMENT, BEFORE THE FOLD.

    A record inside an authoritative window that did not arrive in the batch is
    gone from the source. Removing it here rather than marking it means every
    reader is correct without knowing this mechanism exists — and `reconcileBeliefs`
    already knows what to do about a belief whose evidence has left the world,
    which is how a cancelled event stops being reasoned about as well as stopping
    being drawn.
  */
  const retired = new Set<string>()
  for (const c of opts.coverage ?? []) {
    for (const o of w.observations) {
      if (o.source !== c.source || incoming.has(o.id)) continue
      try { if (c.covers(o)) retired.add(o.id) } catch { /* a bad predicate retires nothing */ }
    }
  }

  w.observations = [
    ...w.observations.filter((o) => !retired.has(o.id)).map((o) => {
      const next = incoming.get(o.id)
      if (!next) return o
      /**
       * Replacing is right (see above), but replacing SILENTLY is what let a
       * belief outlive its evidence. If the content actually moved, that fact
       * is recorded on the record itself — not to show him, but so
       * `reconcileBeliefs` can find every belief that was confirmed against
       * the old wording and has not been checked since.
       *
       * Compared on the rendered text and the structured payload together,
       * because either can change without the other: a retitled event moves
       * `text` and `data.summary`; an event moved by an hour moves only
       * `data.start`, and that is exactly the change a belief about when to
       * leave needs to notice.
       */
      const same = fingerprint(o) === fingerprint(next)
      return same ? { ...next, changedAt: o.changedAt } : { ...next, changedAt: now.toISOString() }
    }),
    // Order is preserved for things already held, so re-observing something
    // does not shuffle his feed; genuinely new things arrive at the end.
    ...obs.filter((o) => !held.has(o.id)),
  ]
}

/** What counts as "the same record". Identity and sync bookkeeping excluded. */
const fingerprint = (o: Observation) => JSON.stringify([o.text, o.data ?? null, o.at])

/**
 * Knock down every belief whose evidence moved under it.
 *
 * The failure this exists for, concretely: a belief said an event had been
 * renamed to "Cinzia's concert". Google still called it "Comic concert in
 * avano". The belief cited the event's observation id, that id still existed,
 * its confidence was 0.9 and falling by a hundredth a day — so for three months
 * the model would have been told, as near-certain fact, a name for an event
 * that its own observation list contradicted two lines above.
 *
 * Nothing reconciled the two because nothing ever COULD: beliefs were written
 * once against reality and then only ever aged. Evidence changing and evidence
 * getting old are different events, and only the second had a mechanism.
 *
 * Idempotent — a belief already contested by the same evidence is left exactly
 * as it is, so this can run on every build without churning the store.
 */
export function reconcileBeliefs(
  w: World,
  now = new Date(),
  opts: { performed?: PerformedAction[] } = {}
): Belief[] {
  const byId = new Map(w.observations.map((o) => [o.id, o]))
  const touched: Belief[] = []

  for (const b of w.beliefs) {
    // A belief citing nothing cannot be checked against anything. That is a
    // different defect (see the `basis` contract) and not this pass's to fix.
    if (!b.basis?.length) continue

    let note: string | null = null
    let stamp = ''
    for (const id of b.basis) {
      const o = byId.get(id)
      if (!o) {
        note = `The observation ${id} it rested on is no longer in the world.`
        stamp = now.toISOString()
        break
      }
      if (o.changedAt && o.changedAt > b.confirmedAt && o.changedAt > (b.contested?.at ?? '')) {
        note = `${id} has changed since this was confirmed. It now reads: ${clipTo(o.text, 160)}`
        stamp = o.changedAt
        break
      }
    }

    if (!note) {
      const unbacked = claimsUnperformedEffect(b, opts.performed)
      if (unbacked) {
        note = unbacked
        stamp = b.confirmedAt
      }
    }

    if (!note) continue
    if (b.contested?.at === stamp) continue

    b.contested = { at: stamp, note }
    // Below `staleBeliefs`' threshold by construction, so the next synthesis is
    // told to confirm it rather than handed it as fact.
    b.confidence = Math.min(b.confidence, 0.3)
    b.confirmedAt = b.confirmedAt > stamp ? b.confirmedAt : stamp
    touched.push(b)
  }

  return touched
}

/** An action that actually ran, as the action log recorded it. */
export type PerformedAction = { kind: string; at: string; outcome: string; params?: Record<string, unknown> }

/**
 * A BELIEF MAY NOT CLAIM THE APP DID SOMETHING THE APP NEVER DID.
 *
 * The belief that made this necessary, verbatim and at confidence 0.99:
 *
 *     "The event on August 10 in Avano is Cinzia's concert, renamed from
 *      comic concert."
 *
 * Google still called that event "Comic concert in avano 9PM", and it always
 * had. The interesting part was WHY nothing caught it: there was no calendar
 * rename action in this app at all. `registeredActions()` listed
 * `calendar.create` and `calendar.rsvp` and nothing else that touched an event
 * — so the rename was not a write-back that failed, it was an effect the app
 * had never at any point been capable of causing. The model asserted it, the
 * belief store accepted it, and decay then carried it as near-certain fact
 * toward every future prompt.
 *
 * `calendar.update` exists now (server/capabilities.ts), so that particular
 * rename can actually happen — but this check is NOT thereby obsolete, and
 * removing it would be the wrong lesson. The failure was never specific to
 * renaming: it is that a model can assert a completed effect and nothing
 * downstream asks whether the app did it. Every capability added from here on
 * widens the set of things that can be truly claimed, and none of them narrows
 * the set that can be falsely claimed.
 *
 * The action log is the ground truth for what this app has actually done to the
 * world, and it is small, closed and local. So a belief whose statement claims
 * a completed effect is checked against it: no successful action of any kind
 * since the belief was formed means nothing happened that could have caused
 * what it describes.
 *
 * DELIBERATELY A HEURISTIC, AND DELIBERATELY A SAFE ONE. It matches a fixed
 * vocabulary of completed-effect verbs, which will both miss claims worded
 * around it and occasionally catch a true claim about something HE did by hand
 * in Google. Both failures land in the same place: the belief is knocked below
 * the stale threshold and the model is told to confirm it with him. It is never
 * deleted, and nothing is ever asserted on its behalf. Asking one unnecessary
 * question is a far smaller cost than repeating an invented fact for a year.
 */
const EFFECT_CLAIM =
  /\b(renamed|re-named|moved|rescheduled|cancelled|canceled|deleted|removed|archived|booked|reserved|ordered|paid|unsubscribed|updated to|changed to|set to)\b/i

function claimsUnperformedEffect(b: Belief, performed?: PerformedAction[]): string | null {
  // No log available is not evidence of absence. Without it this check is off.
  if (!performed) return null
  if (!EFFECT_CLAIM.test(b.statement)) return null

  /**
   * Backing has to be an action ON THE THING THE BELIEF IS ABOUT.
   *
   * The first version of this asked only whether ANY successful action had run
   * before the belief was formed, and that was useless — it cleared the Cinzia
   * rename because two unrelated `track.check` runs happened to have succeeded
   * that morning. A watch firing is not evidence that a calendar event was
   * renamed, and any rule loose enough to let it count will clear every claim
   * on a system that does anything at all.
   *
   * So the action's parameters must actually name one of the objects the belief
   * cites. Connector prefixes are stripped for the comparison because the same
   * object carries different ids on either side of the boundary: the world
   * knows it as `gcal-tjnl77…`, and `calendar.rsvp` is called with the bare
   * `tjnl77…` that Google uses.
   */
  const targets = new Set(
    b.basis.flatMap((id) => {
      const bare = id.replace(/^(gcal|gmail|yt|fit|obs|res|said|told)-/, '')
      return bare && bare.length > 6 ? [bare] : []
    })
  )
  const backing = performed.some((a) => {
    if (a.outcome !== 'ok' || a.at > b.confirmedAt) return false
    const p = JSON.stringify(a.params ?? {})
    return [...targets].some((t) => p.includes(t))
  })
  if (backing) return null

  return `This describes something as already done, but nothing in the action log did it — no successful action touching ${b.basis.join(' or ')} ran before ${b.confirmedAt}. Do not repeat it as done; ask him what actually happened.`
}

/**
 * One claim, one belief.
 *
 * `tracking-start-day` and `trk-start-day` held the same fact at the same
 * confidence, differing only in how the model happened to word it that pass —
 * so the prompt asserted it twice, and confirming one left the other standing.
 * Ids are minted by the model and it does not reliably reuse them, so identity
 * has to come from the CLAIM rather than from the label on it.
 *
 * The survivor is the one with the most live confidence, and it inherits the
 * union of both bases — the duplicate's evidence is evidence, whatever the id
 * it arrived under.
 */
export function dedupeBeliefs(w: World, now = new Date()): number {
  const kept: { b: Belief; terms: Set<string> }[] = []
  let removed = 0

  for (const b of w.beliefs) {
    const terms = claimTerms(b.statement)
    // A claim with almost no content words carries no signal to compare on;
    // merging on two or three tokens would collapse unrelated beliefs.
    const prior = terms.size >= 4 ? kept.find((k) => restates(k.terms, terms)) : undefined
    if (!prior) {
      kept.push({ b, terms })
      continue
    }

    /**
     * The SURVIVOR IS THE MORE INFORMATIVE ONE, not the more confident one.
     *
     * "…daily routine, workouts, and schedule with Google Fit integration"
     * strictly contains "…daily routine, workouts, and schedule", and dropping
     * the longer because the shorter scored higher that pass would quietly
     * delete the Google Fit part of what he asked for. Confidence is then the
     * best either of them had, since two independent statements of one claim
     * are two sightings of it, not one halved.
     */
    const winner = terms.size > prior.terms.size ? b : prior.b
    const loser = winner === b ? prior.b : b
    winner.basis = [...new Set([...(winner.basis ?? []), ...(loser.basis ?? [])])]
    if (currentConfidence(loser, now) > currentConfidence(winner, now)) {
      winner.confidence = loser.confidence
      winner.confirmedAt = loser.confirmedAt
      winner.decayPerDay = Math.min(winner.decayPerDay, loser.decayPerDay)
    }
    // A contradiction found against either wording applies to the claim itself.
    if (loser.contested && !winner.contested) winner.contested = loser.contested
    prior.b = winner
    prior.terms = winner === b ? terms : prior.terms
    removed++
  }

  w.beliefs = kept.map((k) => k.b)
  return removed
}

/**
 * IS ONE OF THESE JUST THE OTHER, SAID AGAIN?
 *
 * The real duplicate pair in his world was not string-identical and no amount
 * of normalising was going to make it so:
 *
 *   "Serg wants to track daily routine, workouts, and schedule with Google Fit
 *    integration."                                              (conf 0.99)
 *   "You want to start tracking your daily routine, workouts, and schedule."
 *                                                               (conf 0.90)
 *
 * One says strictly more than the other about the same subject. That — not
 * string equality — is what "restatement" actually means here, so it is what
 * gets measured: near-total CONTAINMENT of the smaller claim's content words in
 * the larger's. Two claims that merely overlap ("he walks to the market" /
 * "the market moved to the piazza") share some terms but neither contains the
 * other, and both survive.
 *
 * The threshold is high and the failure direction is chosen deliberately: a
 * missed duplicate costs a repeated line in a prompt, a false merge silently
 * destroys a belief he never gets back. Paraphrases that share no vocabulary
 * are out of reach of any string method and are left alone rather than guessed
 * at — that is a job for a model, and it is not worth a call.
 */
function restates(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let shared = 0
  for (const t of small) if (large.has(t)) shared++
  // Every content word of the smaller claim but at most one appears in the
  // larger. "start" is the single word that separates the pair above.
  return shared >= small.size - 1 && shared / small.size >= 0.8
}

/** Content words of a claim: person, filler and inflection removed. */
const STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'he', 'her', 'his',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'own', 'serg', 'she', 'that', 'the', 'their',
  'them', 'they', 'this', 'to', 'user', 'want', 'was', 'were', 'with', 'you', 'your',
])

function claimTerms(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      // Light stemming only — enough that "track" and "tracking" are one term,
      // not enough to conflate words that genuinely differ.
      .map((t) => t.replace(/(ing|ies|es|ed|s)$/, ''))
      .filter((t) => t.length > 2 && !STOP.has(t)),
  )
}

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The stable background, DERIVED from what is settled rather than stored and
 * forgotten.
 *
 * `profile` was an empty string on a world holding a 0.99-confidence belief
 * that his name is Serg — because the only writer was a settings field he had
 * never opened, and nothing promoted a fact the model was already certain of.
 * So every prompt opened by telling the model it knew nothing about him, over a
 * belief list that knew his name.
 *
 * What qualifies is exactly the pair the `decayPerDay` contract already
 * describes: high confidence AND slow decay. "He lives in Italy" is background;
 * "pasta is running low" is not, however sure we are of it today. A contested
 * belief never qualifies, whatever its numbers.
 *
 * Anything he typed himself is kept verbatim above the derived lines — his own
 * account of himself is not something a derivation gets to overwrite.
 */
export const PROFILE_MARK = '— known —'

export function deriveProfile(w: World, now = new Date()): string {
  const his = (w.profile ?? '').split(PROFILE_MARK)[0].trim()

  /**
   * A belief resting on a DATED OCCURRENCE is never background.
   *
   * Caught by running this against his real world: it promoted "The event on
   * August 10 in Avano is Cinzia's concert" into the permanent profile, because
   * the model had given it `decayPerDay: 0.01` and confidence and decay were
   * the only things being asked about. Both were satisfied and the claim was
   * still completely wrong for this purpose — a single evening in August is not
   * stable background, and writing it into the header of every future prompt
   * would have kept describing it long after it happened.
   *
   * Whether a claim is about an occurrence is not a judgement to make from its
   * wording: it is visible in what the belief RESTS ON. A belief citing a
   * calendar observation is about something that happens at a time. That is
   * structural, needs no model, and cannot be fooled by phrasing.
   */
  const dated = new Set(
    w.observations.filter((o) => o.source === 'calendar' || o.data?.kind === 'event').map((o) => o.id)
  )
  const aboutAnOccurrence = (b: Belief) => (b.basis ?? []).some((id) => dated.has(id))

  const settled = w.beliefs
    .filter((b) => !b.contested && !aboutAnOccurrence(b) && b.decayPerDay <= 0.02 && currentConfidence(b, now) >= 0.85)
    .sort((a, b) => currentConfidence(b, now) - currentConfidence(a, now))
    .slice(0, 12)
    .map((b) => `- ${b.statement}`)

  if (!settled.length) return his
  return [his, `${PROFILE_MARK}\n${settled.join('\n')}`].filter(Boolean).join('\n\n')
}

/**
 * Confidence as of now, after decay. Kept as a function rather than a stored
 * value so it is always current and never needs a background job to tick it.
 */
export function currentConfidence(b: Belief, now = new Date()): number {
  const days = (now.getTime() - new Date(b.confirmedAt).getTime()) / 86_400_000
  return Math.max(0, Math.min(1, b.confidence - days * b.decayPerDay))
}

/** Beliefs the assistant no longer trusts enough to act on — worth asking about. */
export function staleBeliefs(w: World, threshold = 0.4, now = new Date()): Belief[] {
  return w.beliefs.filter((b) => currentConfidence(b, now) < threshold)
}

/** What the model is shown: every observation, and beliefs with live confidence. */
/**
 * How many characters of raw observation the prompt may carry.
 *
 * Every observation ever recorded used to go into every prompt. Google is
 * pulled every three hours, so the prompt grew without limit — and once it
 * passed what a free model will accept, EVERY pass failed, permanently, with
 * no action he could take to recover. The app got slower and more expensive
 * every day it ran and then stopped working altogether.
 *
 * The newest are kept, because a feed is about now. What is dropped is stated
 * in the prompt rather than hidden, so the model never claims to have looked
 * at a whole life when it was handed a window of it.
 */
const DEFAULT_OBS_BUDGET = 24_000

export function renderWorld(w: World, now = new Date(), obsBudget = DEFAULT_OBS_BUDGET): string {
  const lines = w.observations
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((o) => `- [${o.id}] (${o.source}, ${o.at}) ${o.text}`)

  // Fill backwards from the newest until the budget is spent.
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1
    if (used + cost > obsBudget) break
    kept.unshift(lines[i])
    used += cost
  }
  const dropped = lines.length - kept.length
  const obs = kept.join('\n') + (dropped ? `\n(${dropped} older observation(s) not shown — say so if you need them.)` : '')
  const bel = w.beliefs
    .map((b) => {
      const c = currentConfidence(b, now)
      // Contested outranks stale in the label, because they call for different
      // things: stale means nobody has checked lately, contested means the
      // evidence has since moved and the claim may now be false. Handing the
      // model only "STALE" would lose the one detail that says what to ask.
      const tag = b.contested
        ? ` CONTESTED — ${b.contested.note} Do not repeat this claim as fact; confirm it with him.`
        : c < 0.4
          ? ' STALE — worth confirming with him'
          : ''
      return `- [${b.id}] ${b.statement} (confidence ${c.toFixed(2)}, from ${b.basis.join(', ')})${tag}`
    })
    .join('\n')

  const trk = (w.tracks ?? [])
    .filter((t) => t.active)
    .map((t) => `- [${t.id}] ${t.what} — because ${t.why} (${t.by === 'user' ? 'he asked for this' : 'you proposed it, he accepted'})`)
    .join('\n')

  /**
   * The typed model goes FIRST, above the observation list.
   *
   * Order is not cosmetic here. Everything below this line is raw material the
   * model is expected to reason over and may reasonably reach new conclusions
   * about; everything in this block is settled — his own answers, his stated
   * goals, the things he cannot do. A model that reads forty observations and
   * then finds "he does not drive" at the bottom has already spent its
   * attention forming a plan that involves a car.
   */
  const person = w.person ? renderPerson(readPerson(w)) : ''

  return [
    person,
    w.profile ? `ABOUT HIM:\n${w.profile}` : '',
    obs ? `WHAT I HAVE OBSERVED:\n${obs}` : 'WHAT I HAVE OBSERVED:\n(nothing yet)',
    bel ? `WHAT I CURRENTLY BELIEVE:\n${bel}` : '',
    trk ? `WHAT HE HAS ASKED ME TO WATCH:\n${trk}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
