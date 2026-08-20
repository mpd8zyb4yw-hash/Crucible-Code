import { BUILD } from '../server/build.js'
import { setKeyStore, kvKeyStore, setKey, deleteKey } from '../server/secrets.js'
import { notify, type PushSub } from '../server/push.js'
import { setWorldStore, kvWorldStore, roomWorldStore } from '../server/store.js'
import { WorldRoom, type RoomReply, type RoomRequest } from '../server/worldRoom.js'
import { setModelPrefs, setRouterStore, kvRouterStore, wake } from '../server/router.js'
import { setRegistryStore, kvRegistryStore, hunt, ensureVerified, snapshot } from '../server/models.js'
import { setObjectStore, kvObjectStore } from '../server/objects.js'
import { setRevisionStore, kvRevisionStore } from '../server/revisions.js'
import { setActionStore, kvActionStore } from '../server/actions.js'
import {
  installYouTubeSource, quotaLedger, presentable,
  search as ytSearch, fromSubscriptions, likedVideos,
} from '../server/youtube.js'
import { installGoogleSources } from '../server/googleSources.js'
import { installReasoner } from '../server/reasoner.js'
import { sourceCatalogue } from '../server/execute.js'
import { sanitisePlan, type RefreshPolicy } from '../server/ir.js'
import { compile, compileLocally } from '../server/compile.js'
import { ask } from '../server/ask.js'
import * as panes from '../server/protocol.js'
import { setShelfStore, kvShelfStore, readShelf, arrange, toggle, forget } from '../server/shelf.js'
import { setHomeStore, kvHomeStore, readHome, writeHome } from '../server/home.js'
import { setSnapshotStore, kvSnapshotStore, buildFeed, freshen, readSnapshot } from '../server/feed.js'
import { perform, registerAction, history as actionHistory, undoAction, type Authoriser } from '../server/actions.js'
import { installCapabilities } from '../server/capabilities.js'
import { budgets } from '../server/router.js'
import { searchPlaces, routeBetween } from '../server/maps.js'
import { leaveBy } from '../server/leaveby.js'
import { mutateWorld, readWorld, addObservations, noteTimeZone, setObservationSink, type World } from '../server/world.js'
import { durableObjectMemoryStore } from '../server/memory/store.js'
import type { DurableObjectSqlStorage } from '../server/memory/sql.js'
import { eventsFromWorldObservations } from '../server/memory/ingest.js'
import { cadenceFor } from '../server/memory/host.js'
import { syncDue, sourceFreshness } from '../server/sync.js'
import { cognitionOverStore, setCognition, type CognitionContext, type MemoryCognition } from '../server/memory/cognition.js'
import { READ_ONLY_LIVE } from '../server/memory/authority.js'
import type { DomainContext, DomainFacts } from '../server/domain.js'
import type { IntelligencePresentation } from '../server/intelligence.js'
import { recordedCycle } from '../server/memory/shadow.js'
import * as inspect from '../server/memory/inspect.js'
import type { MemoryEvent, MemoryStore } from '../server/memory/types.js'
import { partsIn } from '../server/clock.js'
import { think } from '../server/think.js'
import { sourcePanes, noticePane } from '../server/panes.js'
import { say } from '../server/say.js'
import { proposeGaps, researchGap } from '../server/research.js'
import { listTracks, addTrack, updateTrack, removeTrack, runDueTracks } from '../server/tracks.js'
import { personRoute } from '../server/personRoutes.js'
import { providers, byId, listModels, chat, probe } from '../server/providers.js'
import { getKey } from '../server/secrets.js'
import {
  authUrl, exchangeCode, pullObservations, GOOGLE_SOURCES, callbackPath,
  type Tokens,
} from '../server/google.js'

/**
 * Crucible on the edge.
 *
 * The whole point of this file is that it is thin. Synthesis, curiosity,
 * tracks, routing and the Google connector are the SAME modules the Mac runs;
 * only the two host-shaped things differ — where keys come from (Worker
 * secrets) and where the world model lives (KV) — and both are injected at the
 * top of every request. That is what makes the product standalone: nothing
 * here needs a laptop to be awake.
 *
 * It is single-tenant on purpose. One person's world model, one Google
 * account allowed in. Everything under /api is refused without a valid session
 * cookie, because this world model is his calendar, his mail, his health and
 * his location, sitting on a public hostname.
 */

export interface Env {
  CRUCIBLE: KVNamespace
  /**
   * The world model's one authoritative holder. See `worldRoom.ts`.
   *
   * OPTIONAL in the type, because the app must still boot on a deploy where the
   * binding has not been created yet — it degrades to the KV store's weaker
   * guarantee and says so in the log, rather than refusing every request.
   */
  WORLD?: DurableObjectNamespace
  ASSETS: Fetcher
  JWT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /** The one Google account allowed to sign in. Everyone else is refused. */
  ALLOWED_EMAIL: string
  GEMINI_API_KEY?: string
  GROQ_API_KEY?: string
  OPENROUTER_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OPENAI_API_KEY?: string
  XAI_API_KEY?: string
  MISTRAL_API_KEY?: string
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
  BRAVE_API_KEY?: string
  TAVILY_API_KEY?: string
  /**
   * THE CONSOLIDATION CADENCE, IN MILLISECONDS. Unset in production, where it is
   * `REFLECT_MS` — a quarter of an hour, matching the light cron.
   *
   * It is a variable rather than a constant for one reason: an alarm is the only
   * part of this object that cannot be driven by a test. Every other path is a
   * request somebody makes; the alarm is the platform deciding to wake the object
   * later, and "later" was fifteen minutes, so the unattended half of the memory
   * core was the one half no harness could reach. `scripts/edge.mjs` sets it to a
   * fraction of a second and watches the real object wake, reflect and re-arm
   * inside workerd.
   *
   * Deliberately not a `TEST_MODE` boolean. A boolean would say "behave
   * differently", and the value of this seam is that nothing behaves differently
   * — the same handler, the same reflection, the same re-arm, on a shorter clock.
   */
  MEMORY_REFLECT_MS?: string
}

/**
 * THE WORLD MODEL'S ONE HOLDER, ON THE EDGE.
 *
 * A Durable Object is the only thing Cloudflare offers that is genuinely SINGLE:
 * for a given name there is exactly one live instance across the whole network,
 * and its requests are gated so no two run at once. That is precisely the
 * property a read-modify-write of one document needs and precisely the property
 * KV cannot provide — see `worldRoom.ts` for the window this closes and why the
 * stakes changed when the document started holding his corrections.
 *
 * The class is a shell on purpose. All of the behaviour is `WorldRoom`, which
 * takes a two-method storage interface and knows nothing about Cloudflare, so
 * the acceptance test drives the same code the edge runs.
 */
export class WorldObject {
  #room: WorldRoom
  #state: DurableObjectState
  /**
   * THE MEMORY CORE LIVES IN THE SAME OBJECT AS THE WORLD DOCUMENT.
   *
   * Not beside it, and the reason is the property this object exists for. There
   * is exactly one `WorldObject` for a user across the whole network and its
   * requests are gated, so a write to the ledger and a write to the document
   * cannot interleave. Two objects would need a distributed transaction to
   * promise the same thing — which is the problem a Durable Object exists to
   * avoid having.
   *
   * Constructed LAZILY, because it opens SQL and runs migrations, and the
   * overwhelming majority of requests to this object are a world read that has no
   * use for any of it.
   */
  #memory: MemoryStore | null = null
  /** See `Env.MEMORY_REFLECT_MS`. `REFLECT_MS` unless a harness says otherwise. */
  #reflectMs: number
  /**
   * His address, so the alarm's reflection knows which person is him.
   *
   * The unattended pass needs this as much as the attended one: `ensureSelf`
   * runs on every cycle, and a cycle that does not know his address builds a
   * self with no identity that nothing can ever resolve onto.
   */
  #me?: string

  constructor(state: DurableObjectState, env: Env) {
    this.#state = state
    this.#me = env.ALLOWED_EMAIL
    const configured = Number(env.MEMORY_REFLECT_MS)
    this.#reflectMs = Number.isFinite(configured) && configured > 0 ? configured : REFLECT_MS
    this.#room = new WorldRoom(
      {
        get: (k) => state.storage.get<string>(k),
        put: (k, v) => state.storage.put(k, v),
        delete: (k) => state.storage.delete(k),
      },
      {
        /**
         * THE MIGRATION, and it is one line because it has to happen exactly
         * once and nobody should have to remember to run it. The first request
         * after this deploys finds the room empty, adopts the document KV has
         * been holding all along, and writes it in. Every request after that
         * reads the room.
         */
        seed: () => env.CRUCIBLE.get('world'),
        /**
         * And the document stays readable with `wrangler kv key get world`,
         * which is how this world model has been inspected and repaired since
         * it existed. Best-effort: the room is the authority, and a failed
         * mirror is not a failed write.
         */
        mirror: (raw) => env.CRUCIBLE.put('world', raw),
      }
    )
  }

  /**
   * The memory store, opened on first use.
   *
   * `state.storage.sql` exists because the class was registered under
   * `new_sqlite_classes` in `wrangler.jsonc` — see the migration block there. A
   * classic-backend object has no `sql` property at all, so this returns null and
   * the whole memory core is simply absent rather than throwing on a deploy that
   * has not migrated.
   */
  #memoryStore(): MemoryStore | null {
    if (this.#memory) return this.#memory
    const storage = this.#state.storage as unknown as DurableObjectSqlStorage
    if (!storage.sql) return null
    this.#memory = durableObjectMemoryStore(storage)
    return this.#memory
  }

  async fetch(req: Request): Promise<Response> {
    let body: RoomRequest | MemoryRequest
    try {
      body = (await req.json()) as RoomRequest | MemoryRequest
    } catch {
      return Response.json({ op: 'error', message: 'unreadable room request' } satisfies RoomReply, { status: 400 })
    }

    /**
     * THE MEMORY OPS, HANDLED HERE RATHER THAN IN `WorldRoom`.
     *
     * `worldRoom.ts` is deliberately host-independent — it takes a two-method
     * storage interface and knows nothing about Cloudflare — and that is exactly
     * what makes its concurrency guarantee testable outside a Worker. Teaching it
     * about SQL would trade that for the convenience of one fewer branch here.
     *
     * Every path is guarded. The memory core is additive and unread; a failure in
     * it must return a shrug, never a 500 that a sync would surface to him.
     */
    /**
     * COGNITION, INSIDE THE OBJECT, OVER THE REAL LEDGER.
     *
     * This is the half that was missing. The Worker isolate has no SQL and can
     * never have any; the ledger with his life in it is here. So the compilers
     * run HERE — the same `cognitionOverStore` the Mac calls, not an edge
     * variant of it — and only their bounded output crosses back.
     *
     * A failure answers EMPTY rather than erroring. Enrichment that cannot run
     * is a screen without a line on it, which is the app that existed before the
     * memory core did; an exception here would be a 500 on his home screen.
     */
    if ('op' in body && body.op === 'memory.cognition') {
      const empty = body.call === 'intelligence' ? null : []
      const store = this.#memoryStore()
      if (!store) return Response.json({ op: 'memory', ok: true, result: empty })
      try {
        const cog = cognitionOverStore(store, READ_ONLY_LIVE)
        const result =
          body.call === 'intelligence'
            ? await cog.intelligence(body.ctx)
            : await cog.domainContexts(body.facts, body.ctx)
        return Response.json({ op: 'memory', ok: true, result })
      } catch (e) {
        return Response.json({ op: 'memory', ok: false, message: (e as Error).message, result: empty })
      }
    }

    if ('op' in body && (body.op === 'memory.append' || body.op === 'memory.reflect' || body.op === 'memory.inspect')) {
      const store = this.#memoryStore()
      if (!store) return Response.json({ op: 'memory', ok: false, message: 'no sql storage on this object' })
      try {
        if (body.op === 'memory.inspect') return Response.json(inspectMemory(store, body))
        if (body.op === 'memory.append') {
          const written = store.events.append(body.events)
          if (written.length) recordedCycle(store, 'ingest', new Date(body.now), { me: this.#me, ...body.opts })
          /**
           * ARM THE ALARM ON EVERY APPEND, not on a schedule.
           *
           * A Durable Object with no alarm set does not wake up, and one that
           * has never received data has nothing to think about. Setting it when
           * evidence arrives means the consolidation cadence follows his life
           * rather than running forever over an object nobody uses. Re-arming an
           * already-armed alarm is a no-op on the same timestamp, so this is
           * cheap on a busy sync.
           */
          await this.#state.storage.setAlarm(Date.now() + this.#reflectMs)
          return Response.json({ op: 'memory', ok: true, written: written.length })
        }
        const { result } = recordedCycle(store, body.kind, new Date(body.now), { me: this.#me, ...body.opts })
        return Response.json({ op: 'memory', ok: true, run: result.run })
      } catch (e) {
        return Response.json({ op: 'memory', ok: false, message: (e as Error).message })
      }
    }

    return Response.json(await this.#room.handle(body as RoomRequest))
  }

  /**
   * THE UNATTENDED HALF, §21.
   *
   * The cron in `wrangler.jsonc` fires the Worker, not this object, and a Worker
   * invocation is a bad place for consolidation — it would have to reach in
   * through a stub, hold the object for the duration, and race the sync that
   * woke it. An alarm runs INSIDE the object, alone, with the same input gating
   * every other request gets.
   *
   * Re-arms itself so the loop continues, and re-arms even after a failure: a
   * consolidation that threw is a consolidation to retry, and an object that
   * stopped waking because of one bad pass would go quiet permanently with
   * nothing anywhere saying so.
   */
  async alarm(): Promise<void> {
    const store = this.#memoryStore()
    if (!store) return
    try {
      const now = new Date()
      // `cadenceFor` wants HIS hour. The object does not know his zone, so the
      // stored one is read off the world document — the same field every date
      // expression in this app is supposed to go through.
      const raw = await this.#room.handle({ op: 'read' })
      const zone = raw.op === 'read' && raw.raw ? (JSON.parse(raw.raw) as { timeZone?: string }).timeZone : undefined
      recordedCycle(store, cadenceFor(partsIn(now, zone)), now, { timeZone: zone, me: this.#me })
    } catch (e) {
      console.warn(`memory alarm failed: ${(e as Error).message}`)
    } finally {
      await this.#state.storage.setAlarm(Date.now() + this.#reflectMs)
    }
  }
}

/** A quarter of an hour, matching the light cron and the Mac's timer. */
const REFLECT_MS = 15 * 60 * 1000

/**
 * The memory core's half of the object's protocol.
 *
 * Separate from `RoomRequest` on purpose: that type belongs to `worldRoom.ts`,
 * which must stay unaware of any of this for its guarantee to remain testable
 * without a Worker.
 */
type MemoryRequest =
  | { op: 'memory.append'; events: MemoryEvent[]; now: string; opts?: { timeZone?: string; me?: string } }
  | { op: 'memory.reflect'; kind: 'ingest' | 'short' | 'daily' | 'weekly'; now: string; opts?: { timeZone?: string; me?: string } }
  | { op: 'memory.inspect'; view: InspectView; arg?: string; limit?: number }
  /**
   * THE READ PATH THE PRODUCT ACTUALLY USES — see `memory/cognition.ts`.
   *
   * Distinct from `memory.inspect`, which is the developer view and returns
   * rows. This returns only what a screen may draw: a clamped presentation or a
   * handful of clamped context lines, each carrying its certainty and the ids it
   * was compiled from. The ledger never leaves the object.
   *
   * The inputs are equally bounded. `DomainFacts` is the four small typed
   * records the projection has already computed — not the world, not the panes,
   * and never the database. What crosses this wire in either direction is
   * measured in sentences.
   */
  | { op: 'memory.cognition'; call: 'intelligence'; ctx: CognitionContext }
  | { op: 'memory.cognition'; call: 'domainContexts'; facts: DomainFacts; ctx: CognitionContext }

/**
 * THE READ PATH INTO THE EDGE'S MEMORY — AND WHY IT IS NOT A CONTRADICTION.
 *
 * `authority.ts` says nothing the memory core concludes reaches a screen, and
 * that still holds: none of this is a screen. It is `inspect.ts`, which is
 * already the developer view on the Mac, given the one thing it was missing —
 * the ability to see the database that actually has his life in it. `npm run
 * shadow` opens `~/.crucible/memory.db`, and on a hosted deploy that file holds
 * whatever the laptop happened to sync; the real ledger is inside this object.
 *
 * So the tooling that §22 asks for could not be pointed at the data §26 is about.
 * This closes that, and it is deliberately the narrowest possible closure:
 *
 *   READ ONLY   every view below is a SELECT. There is no op here that writes,
 *               and `memory.reflect` — which does — was already its own op with
 *               its own name, so nothing gained a write path it did not have.
 *   NO SCREEN   the caller is `scripts/edge.mjs` and `npm run shadow -- --edge`.
 *               `feed.ts`, `panes.ts` and the widgets still do not import any of
 *               this, which is the property that matters.
 *   SESSION-GATED  reachable only under `/api`, behind the same cookie as
 *               everything else. This is his calendar, his mail and his
 *               location on a public hostname.
 */
type InspectView =
  | 'overview'
  | 'entities'
  | 'routines'
  | 'hypotheses'
  | 'predictions'
  | 'recommendations'
  | 'events'
  | 'explain'
  | 'dump'
  /** Structured, not rendered: the caller renders with `renderShadow` locally. */
  | 'shadow.runs'
  /** Counts only. The cheapest possible "is anything in there". */
  | 'census'

function inspectMemory(store: MemoryStore, body: { view: InspectView; arg?: string; limit?: number }): unknown {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 500)
  switch (body.view) {
    case 'overview': return { op: 'memory', ok: true, text: inspect.overview(store) }
    case 'entities': return { op: 'memory', ok: true, text: inspect.entities(store) }
    case 'routines': return { op: 'memory', ok: true, text: inspect.routines(store) }
    case 'hypotheses': return { op: 'memory', ok: true, text: inspect.hypotheses(store) }
    case 'predictions': return { op: 'memory', ok: true, text: inspect.predictions(store, limit) }
    case 'recommendations': return { op: 'memory', ok: true, text: inspect.recommendations(store) }
    case 'events': return { op: 'memory', ok: true, text: inspect.recentEvents(store, limit) }
    case 'dump': return { op: 'memory', ok: true, text: inspect.dump(store) }
    case 'explain':
      return { op: 'memory', ok: true, text: body.arg ? inspect.explain(store, body.arg) : 'explain needs an id' }
    case 'shadow.runs':
      return { op: 'memory', ok: true, runs: store.shadow.recent(limit) }
    case 'census':
      return {
        op: 'memory',
        ok: true,
        census: {
          schema: store.schemaVersion(),
          events: store.events.count(),
          runs: store.runs.recent(1000).length,
          shadowRuns: store.shadow.recent(1000).length,
          entities: store.entities.all().length,
          routines: store.routines.all().length,
          hypotheses: store.hypotheses.all().length,
          predictions: store.predictions.all().length,
          outcomes: store.predictions.outcomes().length,
        },
      }
    default:
      return { op: 'memory', ok: false, message: `unknown view ${String(body.view)}` }
  }
}

/**
 * Point the brain at whichever write path this deploy actually has.
 *
 * `idFromName('world')` rather than a random id: single-tenant, one document,
 * one room, and the name is what makes it the SAME room on every request from
 * every colo. A missing binding is a degraded deploy rather than a broken one —
 * it falls back to KV's weaker compare-and-set and leaves a line in the log,
 * because a guarantee that quietly stopped applying is worse than one that never
 * did.
 */
/**
 * The object's memory protocol, as a function, for the one caller that is not
 * the observation sink: `/api/memory`. Null on a deploy with no `WORLD` binding,
 * where there is no SQL storage and therefore nothing to inspect.
 */
let callMemory: ((body: MemoryRequest) => Promise<unknown>) | null = null

function installWorldStore(env: Env): void {
  if (!env.WORLD) {
    console.warn('no WORLD durable object bound — world writes fall back to KV compare-and-set')
    setWorldStore(kvWorldStore(env.CRUCIBLE))
    setObservationSink(null)
    callMemory = null
    // No object, no ledger, no cognition. Explicit rather than inherited: a
    // previous isolate on this same runtime may have installed a working one.
    setCognition(null)
    return
  }
  const stub = env.WORLD.get(env.WORLD.idFromName('world'))
  const call = async (body: unknown): Promise<unknown> => {
    const res = await stub.fetch('https://world.crucible/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res.json()
  }

  setWorldStore(roomWorldStore(async (r) => (await call(r)) as RoomReply))
  callMemory = (body) => call(body)

  /**
   * THE EDGE'S READ PATH INTO ITS OWN MEMORY — THE DEFECT THIS DEPLOY CLOSES.
   *
   * Until now this line did not exist, and its absence was invisible. The
   * Worker dual-WROTE to the ledger below and never once read from it: nothing
   * here called `installMemory`, so `memoryStore()` answered null on every
   * production request, and `feed.ts` took its "no store, never mind" branch on
   * every build of every home screen. The memory core was running, thinking,
   * and speaking to nobody.
   *
   * The transport is thin on purpose. All the reasoning lives in
   * `cognitionOverStore`, which runs INSIDE the object next to the SQL; this
   * side only carries the question there and the sentences back. There is no
   * edge-specific cognition to drift from the Mac's.
   *
   * Every failure degrades to the empty answer. An object that is unreachable,
   * a deploy with no SQL storage, a compiler that throws — all of them cost the
   * enrichment and none of them cost the screen, which is the same contract
   * `host.ts` states for the local store.
   */
  const rpc = async (req: MemoryRequest): Promise<unknown> => {
    const res = (await call(req)) as { ok?: boolean; result?: unknown } | null
    return res?.result
  }
  const edgeCognition: MemoryCognition = {
    intelligence: async (ctx) => {
      try {
        return ((await rpc({ op: 'memory.cognition', call: 'intelligence', ctx })) as IntelligencePresentation | null) ?? null
      } catch {
        return null
      }
    },
    domainContexts: async (facts, ctx) => {
      try {
        return ((await rpc({ op: 'memory.cognition', call: 'domainContexts', facts, ctx })) as DomainContext[] | null) ?? []
      } catch {
        return []
      }
    },
  }
  setCognition(edgeCognition)

  /**
   * THE EDGE'S DUAL WRITE — Phase B of §30, and nothing further.
   *
   * Every connector already funnels through `addObservations`; the sink hooks it
   * once, here, so the ledger sees exactly what the world document sees from the
   * same fetch. Nothing on the edge READS the memory core: the feed, the panes,
   * the prompt and the widgets are untouched and do not know it exists.
   *
   * The events are BUILT IN THIS ISOLATE and appended INSIDE THE OBJECT. That
   * split matters: `eventsFromWorldObservations` is pure and the object's own
   * turn is the only place with the SQL storage and the input gating, so nothing
   * else can be halfway through a write when it runs.
   *
   * `addObservations` swallows anything this throws — see `setObservationSink` —
   * so a memory core that is unavailable costs evidence and never costs a sync.
   */
  setObservationSink(async (observations, now, opts) => {
    const events = eventsFromWorldObservations(observations, now.toISOString())
    if (!events.length) return
    await call({
      op: 'memory.append',
      events,
      now: now.toISOString(),
      /**
       * `me` IS PASSED, AND USED NOT TO BE.
       *
       * `NormalizeOptions.me` is documented as "his own address, so he is not
       * lifted as a person in his own life", and no host was supplying it — so
       * `ensureSelf` created a self entity with no identities, every
       * `from === me` test compared against `undefined`, and running this over
       * his real mail duly produced an entity for him, sitting in his own
       * contact graph beside four no-reply addresses.
       *
       * `ALLOWED_EMAIL` is the right source: it is definitionally the one
       * account this deploy serves, it is already required at boot, and it does
       * not need a round trip to find out.
       */
      opts: { timeZone: opts.timeZone, me: env.ALLOWED_EMAIL },
    })
  })
}

/** Provider id → the secret that carries its key. */
const KEY_MAP: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  brave: 'BRAVE_API_KEY',
  tavily: 'TAVILY_API_KEY',
}

const TOKENS_KEY = 'google-tokens'
const COOKIE = 'cru_session'
const enc = new TextEncoder()

// ── session ───────────────────────────────────────────────────────────────
const b64url = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function hmac(data: string, secret: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const p = b64url(enc.encode(JSON.stringify(payload)))
  return `${h}.${p}.${await hmac(`${h}.${p}`, secret)}`
}

async function verify(token: string | null, secret: string): Promise<Record<string, any> | null> {
  if (!token) return null
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return null
  if ((await hmac(`${h}.${p}`, secret)) !== s) return null
  try {
    const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}

const cookie = (req: Request, name: string): string | null => {
  const raw = req.headers.get('cookie') ?? ''
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/**
 * `no-store` is not decoration. Without it the edge cached API replies — a
 * stale "not configured" 503 kept being served after the secrets were set,
 * and the same mechanism would happily serve one person's feed to the next.
 */
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

// ── google tokens, in KV instead of a dotfile ─────────────────────────────
async function loadTokens(env: Env): Promise<Tokens | null> {
  const raw = await env.CRUCIBLE.get(TOKENS_KEY)
  return raw ? (JSON.parse(raw) as Tokens) : null
}

async function saveTokens(env: Env, t: Tokens): Promise<void> {
  await env.CRUCIBLE.put(TOKENS_KEY, JSON.stringify(t))
}

/** A live Google access token, refreshed if it has expired. */
async function googleToken(env: Env): Promise<string | null> {
  const t = await loadTokens(env)
  if (!t?.access_token) return null
  if (t.expiry - 60_000 > Date.now()) return t.access_token
  if (!t.refresh_token) return null

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })
  const b: any = await r.json()
  if (!r.ok) return null
  const next: Tokens = {
    access_token: b.access_token,
    refresh_token: b.refresh_token ?? t.refresh_token,
    expiry: Date.now() + (Number(b.expires_in) || 3600) * 1000,
    scope: b.scope ?? t.scope,
  }
  await saveTokens(env, next)
  return next.access_token
}

const searchKeys = async () => ({
  brave: (await getKey('brave')) ?? undefined,
  tavily: (await getKey('tavily')) ?? undefined,
})

const SUBS_KEY = 'push:subs'

async function loadSubs(env: Env): Promise<PushSub[]> {
  try { return JSON.parse((await env.CRUCIBLE.get(SUBS_KEY)) ?? '[]') } catch { return [] }
}

async function saveSubs(env: Env, subs: PushSub[]): Promise<void> {
  await env.CRUCIBLE.put(SUBS_KEY, JSON.stringify(subs))
}

/**
 * Ring only for a track that actually fired. Calendar and mail refresh on
 * nearly every pass — now more often than ever — so notifying on "new
 * observations" would buzz him all day; a track is something he explicitly
 * agreed to be told about, which is the only thing that has earned an
 * interruption.
 */
async function ringIfWorthIt(env: Env, learned: string[]): Promise<void> {
  if (!learned.length) return
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env
  if (!publicKey || !privateKey || !subject) return
  const subs = await loadSubs(env)
  if (!subs.length) return
  const r = await notify(subs, { publicKey, privateKey, subject })
  // A push service that says the subscription is gone is telling the truth;
  // keeping it would mean retrying a dead endpoint on every pass forever.
  if (r.expired.length) await saveSubs(env, subs.filter((s) => !r.expired.includes(s.endpoint)))
}

/**
 * One unattended pass: refresh what Google can see, then let any standing
 * interest that has come due do its own looking. Each half is wrapped
 * separately — a revoked Google token must not stop tracks from running, and
 * a track that throws must not lose the observations already pulled.
 */
/**
 * ONE TICK, AND THE SOURCES DECIDE FOR THEMSELVES WHETHER THEY ARE IN IT.
 *
 * There used to be two crons — a quarter-hourly one that re-rendered the feed
 * without asking any connector anything, and a three-hourly one that actually
 * pulled Google. So a mailbox could be nearly three hours stale while the feed
 * on top of it was rebuilt eleven times, each rebuild stamping a fresh `at` on
 * a screen made of old facts. He could not see that distinction and should not
 * have had to.
 *
 * Now there is one tick and `sync.ts` owns the policy: each source has its own
 * staleness ceiling and is pulled only when it is over it. A tick where nothing
 * is due costs one clock comparison and no connector call at all — which is why
 * a five-minute cron is affordable where a five-minute `pullObservations` would
 * not have been.
 */
async function tick(env: Env): Promise<void> {
  try {
    const token = await googleToken(env)
    if (token) await syncDue(token, await readWorld())
  } catch {
    /* a dead token is tomorrow's problem, not this run's */
  }
  try {
    const { learned } = await runDueTracks(await searchKeys())
    await ringIfWorthIt(env, learned)
  } catch {
    /* one bad track must not poison the pass */
  }
  /**
   * Re-run the panes whose policy asked for it, then leave a rebuilt feed
   * behind.
   *
   * This is the half that makes "it's current when he opens it" true rather
   * than aspirational. Every refresh here produces a revision like any other:
   * a content-pinned pane parks its new results in `pending` and keeps showing
   * what he kept, and a source that fails at 4am leaves the last good revision
   * exactly where it was. `on-open` panes are deliberately NOT refreshed —
   * that policy is about him arriving, and firing it on a clock would make the
   * distinction meaningless.
   *
   * The rebuild is `withoutModel`. A scheduled synthesis would spend the free
   * tier's daily allowance on an answer nobody is reading and leave none for
   * the moment he actually opens it; the snapshot it writes is his panes and
   * his sources, current, with the model's cards filled in the first time he
   * looks.
   */
  try {
    await freshen({ arriving: false, auth: await planAuth(env) })
    await buildFeed(await readWorld(), { withoutModel: true })
  } catch {
    /* a feed that will not rebuild costs a slower first paint, nothing more */
  }
}

export default {
  /**
   * Work that happens while he is not looking.
   *
   * The product promises "things handled without you today", and until this
   * existed that could only ever be true if he had the app open — every pull
   * and every track ran off a request he made. This is the half that makes the
   * claim honest.
   *
   * Deliberately GATHERING only, never synthesis. Pulling Google and running
   * due tracks is cheap, deterministic, and mostly keyless; a scheduled
   * think() would burn the free tier's daily allowance on an answer nobody is
   * reading, and leave none for the moment he actually opens it. Synthesis
   * stays on-demand, over whatever this has collected.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    setKeyStore(kvKeyStore(env.CRUCIBLE, env as unknown as Record<string, unknown>, KEY_MAP))
    installWorldStore(env)
    setModelPrefs(async () => JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}'))
    setRouterStore(kvRouterStore(env.CRUCIBLE))
    setRegistryStore(kvRegistryStore(env.CRUCIBLE))
    setObjectStore(kvObjectStore(env.CRUCIBLE))
    setRevisionStore(kvRevisionStore(env.CRUCIBLE))
    setActionStore(kvActionStore(env.CRUCIBLE))
    // How he arranged his home screen, and the last feed assembled from it.
    // Both belong on the cron path as well as the request path: the unattended
    // pass is the one that has to leave something current behind for a morning
    // nobody has opened the app yet.
    setShelfStore(kvShelfStore(env.CRUCIBLE))
    setHomeStore(kvHomeStore(env.CRUCIBLE))
    setSnapshotStore(kvSnapshotStore(env.CRUCIBLE))
    installYouTubeSource()
    installGoogleSources()
    installReasoner()
    installWorkerActions(env)
    /**
     * ONE CADENCE, AND PER-SOURCE FRESHNESS INSIDE IT. See `sync.ts`.
     *
     * `refreshDue` still asks each pane whether its own interval has elapsed,
     * so nothing is fetched that no pane asked for; what changed is that the
     * CONNECTORS now get the same treatment. Calendar and mail are allowed to
     * be five minutes old, YouTube two hours, and the tick that notices is the
     * same one either way.
     */
    /*
    ONE PATH. `event.cron` is no longer branched on, because there is no longer
    a cheap tick and an expensive one — there is a tick, and what it costs is
    decided by how stale his sources actually are.
  */
  void event
  ctx.waitUntil(tick(env))
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    // Host drivers first: every downstream module reads keys and the world
    // through these, and neither exists until this runs.
    setKeyStore(kvKeyStore(env.CRUCIBLE, env as unknown as Record<string, unknown>, KEY_MAP))
    installWorldStore(env)
    setModelPrefs(async () => JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}'))
    setRouterStore(kvRouterStore(env.CRUCIBLE))
    setRegistryStore(kvRegistryStore(env.CRUCIBLE))
    setObjectStore(kvObjectStore(env.CRUCIBLE))
    // Panes and the action log are state, not cache: they have to be installed
    // on both paths, or a cron-driven refresh would throw instead of writing.
    setRevisionStore(kvRevisionStore(env.CRUCIBLE))
    setActionStore(kvActionStore(env.CRUCIBLE))
    // How he arranged his home screen, and the last feed assembled from it.
    // Both belong on the cron path as well as the request path: the unattended
    // pass is the one that has to leave something current behind for a morning
    // nobody has opened the app yet.
    setShelfStore(kvShelfStore(env.CRUCIBLE))
    setHomeStore(kvHomeStore(env.CRUCIBLE))
    setSnapshotStore(kvSnapshotStore(env.CRUCIBLE))
    installYouTubeSource()
    installGoogleSources()
    installReasoner()
    installWorkerActions(env)

    const url = new URL(req.url)
    const path = url.pathname
    const origin = url.origin

    /**
     * Fail closed. An unset JWT_SECRET would otherwise hash against the string
     * "undefined" — a secret anyone can guess — and an unset ALLOWED_EMAIL
     * would let the allowlist check throw instead of refuse. Neither is a
     * state this should serve traffic in, so it refuses everything but the
     * static shell until the secrets exist.
     */
    const missing = (['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_EMAIL'] as const)
      .filter((k) => !env[k])
    if (missing.length && (path.startsWith('/api/') || path.startsWith('/auth/'))) {
      return json({ error: `Not configured yet — missing ${missing.join(', ')}` }, 503)
    }

    // ── auth: one Google sign-in, allowlisted to a single account ─────────
    if (path === '/auth/login') {
      return Response.redirect(authUrl(env.GOOGLE_CLIENT_ID, `${origin}${callbackPath}`), 302)
    }

    if (path === callbackPath) {
      const code = url.searchParams.get('code')
      if (!code) return new Response('No code', { status: 400 })
      try {
        const tokens = await exchangeCode(code, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, `${origin}${callbackPath}`)
        const me: any = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }).then((r) => r.json())

        // The allowlist is the whole access-control model. Anyone else who
        // completes Google's flow still gets nothing.
        if (!me?.email || me.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
          // Name the address that was presented — the person reading this owns
          // it, so it leaks nothing, and "not an account this Crucible serves"
          // with no address is impossible to act on. The allowed address is
          // NOT echoed; that one would be a leak.
          return new Response(
            `Not an account this Crucible serves.\n\nYou signed in as: ${me?.email ?? '(no email on the account)'}\n\nSet ALLOWED_EMAIL to that address to let it in:\n  npx wrangler secret put ALLOWED_EMAIL\n  npx wrangler deploy`,
            { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }
          )
        }

        await saveTokens(env, tokens)
        const session = await sign({ sub: me.sub, email: me.email, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }, env.JWT_SECRET)
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': `${COOKIE}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
          },
        })
      } catch (e) {
        return new Response(`Sign-in failed: ${(e as Error).message}`, { status: 400 })
      }
    }

    if (path === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { location: '/', 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
      })
    }

    /**
     * The one /api path that must work WITHOUT a session: it only starts the
     * sign-in flow. Gating it would mean needing a session to get a session,
     * and the app's own "Sign in" button points here.
     */
    if (path === '/api/google/connect') {
      return Response.redirect(`${origin}/auth/login`, 302)
    }

    /**
     * Which code is serving this — answerable without a session.
     *
     * Deliberately outside the auth gate. Its whole job is to let a deploy
     * verify that production picked up the artefact it just uploaded, and a
     * check that needs his cookie cannot run in a pipeline. It discloses a
     * content hash and a timestamp, which tell an unauthenticated caller
     * nothing they could not get by diffing the public bundle.
     */
    if (path === '/api/version') {
      return json({ ...BUILD, worker: true }, 200, { 'Cache-Control': 'no-store' })
    }

    // ── everything else under /api requires a session ────────────────────
    if (path.startsWith('/api/')) {
      const claims = await verify(cookie(req, COOKIE), env.JWT_SECRET)
      if (!claims) return json({ error: 'Not signed in', signIn: '/auth/login' }, 401)

      try {
        return await api(req, env, path, origin)
      } catch (e) {
        return json({ error: (e as Error).message }, 502)
      }
    }

    // ── the app itself ───────────────────────────────────────────────────
    return env.ASSETS.fetch(req)
  },
}

async function api(req: Request, env: Env, path: string, origin: string): Promise<Response> {
  const method = req.method
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH'
    ? await req.json().catch(() => ({} as any))
    : ({} as any)
  // Query parameters, for the GET endpoints that take them (map search/route).
  const url = new URL(req.url)

  if (path === '/api/providers' && method === 'GET') {
    const list = await Promise.all(
      providers.map(async (p) => {
        const key = await getKey(p.id)
        // Same rule as the Mac: only models that have actually answered are
        // offered. The hosted app is where a picker full of dead models does
        // the most damage, because it is the one he uses from his phone with
        // no terminal to diagnose from.
        const verified = key ? await ensureVerified(p.id).catch(() => []) : []
        const all = key ? (await snapshot().catch(() => ({ models: [] }))).models.filter((m) => m.providerId === p.id) : []
        const now = Date.now()
        return {
          id: p.id, label: p.label, hint: p.hint, free: p.free,
          models: verified.map((m) => m.model),
          detail: verified.map((m) => ({
            model: m.model, label: m.label, quality: m.quality,
            measured: m.measured, latencyMs: m.latencyMs, aptitude: m.aptitude ?? null,
          })),
          quarantined: all
            .filter((m) => m.verdict === 'quarantined' && (m.until ?? 0) > now)
            .map((m) => ({ model: m.model, reason: m.reason ?? 'would not answer', until: m.until ?? 0 })),
          model: verified[0]?.model ?? p.defaultModel,
          configured: key !== null,
        }
      })
    )
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    const active = prefs.activeProvider && list.some((p) => p.id === prefs.activeProvider && p.configured)
      ? prefs.activeProvider
      : list.find((p) => p.configured)?.id ?? null
    return json({
      providers: list.map((p) => ({ ...p, model: prefs.models?.[p.id] ?? p.model })),
      routing: prefs.routing ?? 'auto',
      active,
    })
  }

  // A key pasted in the app. Proven before it is stored, exactly as on the Mac:
  // a key that cannot answer is a worse state than no key at all.
  const keyMatch = /^\/api\/providers\/([^/]+)\/key$/.exec(path)
  if (keyMatch && (method === 'PUT' || method === 'DELETE')) {
    const p = byId(keyMatch[1]) ?? (['brave', 'tavily'].includes(keyMatch[1]) ? { id: keyMatch[1], defaultModel: '' } as any : null)
    if (!p) return json({ error: 'Unknown provider' }, 404)
    if (method === 'DELETE') {
      await deleteKey(p.id)
      return json({ ok: true })
    }
    const key = String(body?.key ?? '').trim()
    if (!key) return json({ error: 'No key provided' }, 400)
    if (p.defaultModel) {
      try {
        await chat({ providerId: p.id, model: p.defaultModel, key, prompt: 'Reply with the single word: ok', maxTokens: 16 })
      } catch (err) {
        return json({ error: (err as Error).message }, 400)
      }
    }
    await setKey(p.id, key)
    return json({ ok: true, active: p.id })
  }

  // Who chooses the model: Crucible per task, or the one he pinned.
  if (path === '/api/routing' && method === 'PUT') {
    const r = body?.routing
    if (r !== 'auto' && r !== 'pinned') return json({ error: 'routing must be auto or pinned' }, 400)
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    prefs.routing = r
    await env.CRUCIBLE.put('prefs', JSON.stringify(prefs))
    return json({ ok: true, routing: r })
  }

  // Which provider to lean on. The router still chooses per task; this only
  // nudges its preference, and is stored per-user rather than in a config file.
  if (path === '/api/active' && method === 'POST') {
    const id = String(body?.providerId ?? '')
    const p = byId(id)
    if (!p) return json({ error: 'Unknown provider' }, 404)
    if ((await getKey(id)) === null) return json({ error: 'No key for that provider' }, 400)
    const prefs = JSON.parse((await env.CRUCIBLE.get('prefs')) ?? '{}')
    prefs.activeProvider = id
    if (body?.model) {
      // Being listed is not being allowed: providers list their paid tiers to
      // every key, so without this a free key can select a pro model here and
      // the next home-feed synthesis fails with a quota error for a screen.
      const key = await getKey(id)
      const why = key ? await probe(id, String(body.model), key) : 'No key for that provider'
      if (why) return json({ error: why }, 400)
      // It just answered, so whatever rest it was serving is out of date.
      await wake(id, String(body.model))
      prefs.models = { ...(prefs.models ?? {}), [id]: String(body.model) }
    }
    await env.CRUCIBLE.put('prefs', JSON.stringify(prefs))
    return json({ ok: true, active: id, model: prefs.models?.[id] ?? p.defaultModel })
  }

  if (path === '/api/push/vapid-public' && method === 'GET') {
    return json({ key: env.VAPID_PUBLIC_KEY ?? null })
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    const sub = body?.subscription as PushSub | undefined
    if (!sub?.endpoint) return json({ error: 'invalid subscription' }, 400)
    const subs = await loadSubs(env)
    // One device, one entry — re-subscribing must not stack duplicates.
    await saveSubs(env, [...subs.filter((s) => s.endpoint !== sub.endpoint), sub])
    return json({ ok: true })
  }

  /**
   * The typed personal model — the SAME handler the Mac mounts.
   *
   * Checked before the individual world routes so the two hosts cannot drift:
   * everything about these paths lives in `personRoutes.ts`, and neither host
   * has a copy to forget to update. This is the fix for the shape that left
   * `PUT /api/world/profile` working on a laptop and 404ing on his phone.
   */
  if (path === '/api/person' || path.startsWith('/api/person/') || path === '/api/focus') {
    const out = await personRoute(path, method, body)
    if (out) return json(out.value, out.status)
    return json({ error: 'No such person route' }, 404)
  }

  if (path === '/api/world' && method === 'GET') return json(await readWorld())

  /**
   * THE MEMORY CORE, READ-ONLY, FOR THE TOOLING — see `inspectMemory`.
   *
   * Not a screen and not a read path for the app: the only callers are
   * `scripts/edge.mjs` and `npm run shadow -- --edge`, and it exists because the
   * ledger that has his actual life in it lives inside a Durable Object where the
   * developer view could not reach it.
   */
  if (path === '/api/memory' && method === 'GET') {
    if (!callMemory) return json({ ok: false, message: 'no durable object bound; nothing to inspect' }, 503)
    const view = (url.searchParams.get('view') ?? 'overview') as InspectView
    const arg = url.searchParams.get('id') ?? undefined
    const limit = Number(url.searchParams.get('limit')) || undefined
    return json(await callMemory({ op: 'memory.inspect', view, arg, limit }))
  }

  /**
   * RUN A PASS NOW. The one write here, and it is the same op the alarm calls —
   * `npm run shadow -- reflect` for the edge, so a cycle over real evidence can
   * be triggered and read back rather than waited for.
   */
  if (path === '/api/memory/reflect' && method === 'POST') {
    if (!callMemory) return json({ ok: false, message: 'no durable object bound' }, 503)
    const kind = (body?.kind as 'ingest' | 'short' | 'daily' | 'weekly') ?? 'daily'
    const world = await readWorld()
    return json(
      await callMemory({
        op: 'memory.reflect',
        kind,
        now: new Date().toISOString(),
        opts: { timeZone: world.timeZone, me: env.ALLOWED_EMAIL },
      })
    )
  }

  /**
   * KEPT AS A PATH, REIMPLEMENTED AS A TYPED WRITE.
   *
   * This appended a sentence to the observation list and nothing else — the
   * "observation graveyard" path. Answering "Do you drive?" with "No" left no
   * queryable fact anywhere, so the router still had to guess a travel mode and the
   * question stayed askable forever. It now goes through `tell`, which writes the
   * typed field FIRST and generates the sentence as secondary history. Same URL,
   * because clients call it.
   */
  if (path === '/api/world/tell' && method === 'POST') {
    const out = await personRoute('/api/person/tell', 'POST', body)
    return json(out?.value ?? { ok: false }, out?.status ?? 500)
  }

  if (path === '/api/say' && method === 'POST') {
    const text = String(body?.text ?? '').trim()
    if (!text) return json({ error: 'Nothing said' }, 400)
    const w = await readWorld()
    // The hands. Without these `say` can only describe doing things.
    return json(await say(w, text, body?.card ?? null, body?.thread ?? [], {
      sync: async () => {
        const token = await googleToken(env)
        if (!token) throw new Error('Google is not connected')
        const { observations, timeZone, coverage } = await pullObservations(token, w.sources, w.timeZone)
        if (observations.length || timeZone || coverage.length) await addObservations(observations, new Date(), { timeZone, coverage })
        return { added: observations.length }
      },
      research: async (question) => {
        const obs = await researchGap({ question, who: 'world', why: 'he asked' }, w, undefined as any, await searchKeys())
        if (!obs) return null
        await addObservations([obs])
        return obs.text
      },
      /** "Show me…" said in the composer, compiled and put on his splash. */
      build: async (intent) => {
        const r = await ask(intent, { fresh: true, auth: await planAuth(env) })
        if (r.kind !== 'pane') throw new Error('I wasn’t sure which one you meant.')
        return { title: r.view.pane.title || intent, count: r.view.revision.refs.length, unresolved: r.compiled.unresolved }
      },
    }, Array.isArray(body?.surfaces) ? body.surfaces : []))
  }

  if (path === '/api/think' && method === 'POST') {
    const world = await readWorld()
    // Same contract as the Mac: what the connectors know renders with or
    // without a model, and a brain that cannot answer is one card, not a
    // blank screen. See server/panes.ts for why this is not synthesis's job.
    let result
    try {
      result = await think(world, body?.nudge)
    } catch (err) {
      const panes = sourcePanes(world)
      const message = (err as Error).message
      return json({
        dateLabel: new Date().toLocaleDateString(),
        clock: '12h',
        place: null,
        readLine: panes.length ? 'Here’s what I already know.' : '',
        needs: [noticePane(message), ...panes],
        ask: { opening: 'What’s on your mind?', chips: [] },
        quietLog: [],
        beliefUpdates: [],
        dropped: [],
        degraded: message,
      })
    }
    if (result.beliefUpdates.length) {
      const byIdMap = new Map(world.beliefs.map((b) => [b.id, b]))
      for (const b of result.beliefUpdates) {
        if (b.confidence === 0) byIdMap.delete(b.id)
        else byIdMap.set(b.id, b)
      }
      world.beliefs = [...byIdMap.values()]
      // Beliefs only: `world` predates the model call, so writing it whole would
      // revert anything he corrected while the model was thinking. See `mutateWorld`.
      await mutateWorld((fresh) => { fresh.beliefs = world.beliefs }, { label: 'the beliefs from this pass' })
    }
    const panes = sourcePanes(world)
    const have = new Set(result.needs.map((n) => n.id))
    return json({ ...result, needs: [...result.needs, ...panes.filter((p) => !have.has(p.id))] })
  }

  if (path === '/api/learn' && method === 'POST') {
    const keys = await searchKeys()
    const tracked = await runDueTracks(keys)
    const world = await readWorld()
    const gaps = await proposeGaps(world)
    const worldGaps = gaps.filter((g) => g.who === 'world')
    const found = (await Promise.all(worldGaps.map((g) => researchGap(g, world, undefined, keys).catch(() => null))))
      .filter((o): o is NonNullable<typeof o> => o !== null)
    if (found.length) await addObservations(found)
    return json({
      tracked: tracked.ran,
      asked: worldGaps.map((g) => g.question),
      learned: [...tracked.learned, ...found.map((o) => o.text)],
      unanswered: worldGaps.length - found.length,
      forHim: gaps.filter((g) => g.who === 'user'),
    })
  }

  // ── tracks ──────────────────────────────────────────────────────────────
  if (path === '/api/tracks' && method === 'GET') return json({ tracks: await listTracks() })

  if (path === '/api/tracks' && method === 'POST') {
    const t = await addTrack(body ?? {}, body?.by === 'agent' ? 'agent' : 'user')
    return t ? json({ ok: true, track: t }) : json({ error: 'needs a "what", and must not duplicate an existing track' }, 400)
  }

  if (path === '/api/tracks/run' && method === 'POST') return json(await runDueTracks(await searchKeys()))

  const trackId = path.startsWith('/api/tracks/') ? path.slice('/api/tracks/'.length) : null
  if (trackId && method === 'PATCH') {
    const t = await updateTrack(trackId, body ?? {})
    return t ? json({ ok: true, track: t }) : json({ error: 'no such track' }, 404)
  }
  if (trackId && method === 'DELETE') {
    return (await removeTrack(trackId)) ? json({ ok: true }) : json({ error: 'no such track' }, 404)
  }

  // ── what it may see ─────────────────────────────────────────────────────
  if (path === '/api/sources' && method === 'GET') {
    const w = await readWorld()
    return json({
      sources: GOOGLE_SOURCES.map((id) => ({ id, on: w.sources?.[id] !== false })),
      curation: w.curation ?? 'auto',
    })
  }

  if (path === '/api/sources' && method === 'PUT') {
    const { world: w } = await mutateWorld((fresh) => {
      fresh.sources = fresh.sources ?? {}
      for (const [id, on] of Object.entries(body?.sources ?? {})) fresh.sources[id] = on === true
      if (body?.curation === 'auto' || body?.curation === 'manual') fresh.curation = body.curation
    }, { label: 'which sources I may read' })
    return json({ ok: true, sources: w.sources, curation: w.curation })
  }

  /**
   * YouTube retrieval by scope — the hosted half of the same route.
   *
   * This must exist HERE, not only in the local Express server: crucible.cam
   * runs this worker, so a route added only to `server/index.ts` is a feature
   * that works on the Mac and 404s on his phone. The surface calling it would
   * have failed in production exactly the way it failed before.
   */
  if (path === '/api/youtube/search' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim()
    const scope = url.searchParams.get('scope') ?? 'open'
    const limit = Math.min(50, Number(url.searchParams.get('limit')) || 12)
    const { youtubeToken } = await planAuth(env)

    if (!youtubeToken) {
      return json({ failure: 'auth', reason: 'YouTube isn’t connected — sign in with Google to search it.' }, 401)
    }
    if (scope === 'open' && !q) {
      return json({ failure: 'unsupported', reason: 'Searching YouTube needs something to search for.' }, 400)
    }

    try {
      let videos
      let provenance: string
      const narrow = <V extends { title: string; channel?: string }>(vs: V[]): V[] => {
        if (!q) return vs
        const n = q.toLowerCase()
        return vs.filter((v) => `${v.title} ${v.channel ?? ''}`.toLowerCase().includes(n))
      }
      if (scope === 'subscriptions') {
        videos = narrow((await fromSubscriptions(youtubeToken, { limit })).videos)
        provenance = 'From your subscriptions'
      } else if (scope === 'likes') {
        videos = narrow(await likedVideos(youtubeToken, limit))
        provenance = 'From your likes'
      } else {
        videos = await ytSearch(youtubeToken, q, { limit })
        provenance = 'Across YouTube'
      }
      // Identical mapping to the Mac's, from the same shared function — the
      // two hosts cannot disagree about what a video id is.
      const shown = presentable(videos)
      return json({
        videos: shown.videos, scope, query: q, provenance,
        resultCount: shown.videos.length, unidentified: shown.rejected,
        quota: quotaLedger(), at: new Date().toISOString(),
      })
    } catch (e) {
      // Name the cause: quota means wait, auth means reconnect. One generic
      // message would collapse two different recoveries into none.
      const msg = String((e as Error)?.message ?? e)
      const code = /\b(\d{3})\b/.exec(msg)?.[1]
      const failure =
        code === '403' && /quota/i.test(msg) ? 'quota'
        : code === '401' || code === '403' ? 'auth'
        : 'provider'
      return json({
        failure,
        reason:
          failure === 'quota' ? 'YouTube’s daily search quota is used up. It resets at midnight Pacific.'
          : failure === 'auth' ? 'YouTube refused the account — it needs reconnecting.'
          : `YouTube returned an error: ${msg}`,
        quota: quotaLedger(),
      }, 502)
    }
  }

  // ── google ──────────────────────────────────────────────────────────────
  if (path === '/api/google/status' && method === 'GET') {
    const t = await loadTokens(env)
    return json({ configured: !!env.GOOGLE_CLIENT_ID, connected: !!t?.access_token, scopes: t?.scope?.split(' ') ?? [] })
  }

  if (path === '/api/google/connect' && method === 'GET') {
    // Signing in IS connecting here — one flow, one consent screen.
    return Response.redirect(`${origin}/auth/login`, 302)
  }

  if (path === '/api/google/sync' && method === 'POST') {
    const token = await googleToken(env)
    if (!token) return json({ error: 'Google is not connected' }, 400)
    const w = await readWorld()
    const { observations, errors, timeZone, coverage } = await pullObservations(token, w.sources, w.timeZone)
    if (observations.length || timeZone || coverage.length) await addObservations(observations, new Date(), { timeZone, coverage })
    return json({ added: observations.length, errors, bySource: observations.reduce((a: Record<string, number>, o) => ({ ...a, [o.source]: (a[o.source] ?? 0) + 1 }), {}) })
  }

  if (path === '/api/budgets' && method === 'GET') return json({ budgets: await budgets() })

  if (path === '/api/models/hunt' && method === 'POST') {
    return json(await hunt({ providerId: body?.provider, force: true }))
  }

  if (path === '/api/map/search' && method === 'GET') {
    try {
      const near = parsePoint(url.searchParams.get('near') ?? '')
      return json({ places: await searchPlaces(url.searchParams.get('q') ?? '', near ?? undefined) })
    } catch (e) {
      return json({ error: (e as Error).message }, 502)
    }
  }

  if (path === '/api/map/route' && method === 'GET') {
    const from = parsePoint(url.searchParams.get('from') ?? '')
    const to = parsePoint(url.searchParams.get('to') ?? '')
    if (!from || !to) return json({ error: 'I need two points to route between.' }, 400)
    try {
      return json(await routeBetween(from, to, url.searchParams.get('mode') ?? 'walk'))
    } catch (e) {
      return json({ error: (e as Error).message }, 502)
    }
  }

  /**
   * Widget actions on the edge.
   *
   * Deliberately the same named-intent table as the Mac rather than a thinner
   * version: crucible.cam is the copy he actually uses, from the phone, so a
   * card that can be acted on locally and not here would be the bug this whole
   * change set exists to remove.
   */
  /**
   * One endpoint, a table of named intents, and a record of every attempt.
   *
   * This used to be a hand-written switch that performed the effect and
   * returned `{ok:true}` — the same shape the Mac had before actions were given
   * a log, kept here by omission. It was the more serious of the two, because
   * crucible.cam is the copy he uses from his phone: mail was being sent from
   * the surface with no authorisation check and no record, while the laptop
   * refused the identical request without a confirmation. Both hosts now run
   * the same table.
   */
  if (path === '/api/act' && method === 'POST') {
    const authorisedBy: Authoriser = {
      by: 'user',
      paneId: typeof body?.paneId === 'string' ? body.paneId : undefined,
      revisionId: typeof body?.revisionId === 'string' ? body.revisionId : undefined,
      confirmed: body?.confirmed === true,
    }
    const r = await perform(String(body?.kind ?? ''), (body?.params ?? {}) as Record<string, unknown>, authorisedBy)
    if (r.outcome === 'ok') return json({ ok: true, id: r.result, action: r.id, undoable: !!r.undo })
    return json({ error: r.error, action: r.id }, r.outcome === 'refused' ? 400 : 502)
  }

  if (path === '/api/actions' && method === 'GET') return json({ actions: await actionHistory() })

  if (path.startsWith('/api/actions/') && path.endsWith('/undo') && method === 'POST') {
    const id = path.slice('/api/actions/'.length, -'/undo'.length)
    const done = await undoAction(id, { by: 'user', confirmed: true })
    return done ? json(done) : json({ error: 'That one can’t be taken back.' }, 400)
  }

  // ── His words ───────────────────────────────────────────────────────────
  if (path === '/api/compile' && method === 'POST') {
    const words = String(body?.intent ?? '').trim()
    if (!words) return json({ error: 'Nothing to compile.' }, 400)
    if (body?.model === false) {
      const local = compileLocally(words)
      return local
        ? json({ plan: local, planClass: 'deterministic', by: 'local', unknown: [], unresolved: [] })
        : json({ error: 'That one needs a model to compile.' }, 422)
    }
    return json({ ...(await compile(words, { context: body?.context })), by: 'model' })
  }

  /**
   * WHEN TO SET OFF. The same computation as the Mac, on the same file.
   *
   * Registered here as well as in `server/index.ts` and not only in one of them:
   * his phone talks to the Worker, so a task that exists only on the Mac is a
   * task that does not exist. The calendar-rename verb was missing here for
   * exactly this reason and the feature was invisible in production.
   */
  if (path === '/api/leaveby' && method === 'POST') {
    const need = ['destination', 'eventStart', 'origin', 'transportMode'].filter((k) => !String(body?.[k] ?? '').trim())
    if (need.length) return json({ error: `Missing ${need.join(', ')}.` }, 400)
    const w = await readWorld()
    return json(await leaveBy({
      destination: String(body.destination),
      eventStart: String(body.eventStart),
      origin: String(body.origin),
      transportMode: String(body.transportMode),
    }, w.timeZone))
  }

  if (path === '/api/ask' && method === 'POST') {
    const words = String(body?.intent ?? body?.text ?? '').trim()
    if (!words) return json({ error: 'Nothing to do.' }, 400)
    return json(
      await ask(words, {
        paneId: typeof body?.paneId === 'string' ? body.paneId : undefined,
        ref: body?.ref,
        ctx: body?.context ?? {},
        fresh: body?.fresh === true,
        onShelf: body?.onShelf !== false,
        auth: await planAuth(env),
      })
    )
  }

  // ── The splash ──────────────────────────────────────────────────────────
  if (path === '/api/feed' && method === 'GET') {
    // The zone the machine showing the screen is standing in, which outranks
    // anything a connector reports. See `World.timeZoneBy`.
    const world = await noteClientZone(url.searchParams.get('tz') ?? '')
    if (url.searchParams.get('cached') === '1') {
      // See `readSnapshot`: source rows are re-derived from the world on read,
      // so a cold paint cannot show yesterday's "next event" as next.
      const snap = await readSnapshot(world)
      if (snap) return json(snap)
    }
    await freshen({ arriving: true, auth: await planAuth(env) }).catch(() => null)
    return json(await buildFeed(await readWorld(), { nudge: url.searchParams.get('nudge') ?? undefined }))
  }

  if (path === '/api/feed/refresh' && method === 'POST') {
    const r = await freshen({ arriving: false, auth: await planAuth(env) })
    return json({ ...r, feed: await buildFeed(await readWorld(), { withoutModel: true }) })
  }

  /**
   * "I HAVE ARRIVED" / "I AM BACK" — AND THE SERVER DECIDES WHAT THAT COSTS.
   *
   * The client is allowed to say that a person is looking at the screen. It is
   * NOT allowed to say "fetch Gmail": quota belongs to the account rather than
   * to the tab, and a client that owned this policy would spend the day's
   * allowance on a phone that reloads whenever iOS feels like it, twice over
   * with a second device open.
   *
   * So this takes no source list and accepts no cadence. It asks `sync.ts` what
   * is overdue, pulls exactly that, and returns the rebuilt feed. With nothing
   * overdue it makes no connector call at all and returns the current feed —
   * which is the common case, and is meant to be cheap enough that the app can
   * call it on every foreground without thinking about it.
   *
   * `withoutModel`, deliberately: this fires on arrival and on every return to
   * the app, and a synthesis on each one would spend the free tier's daily
   * allowance on answers nobody asked for. What this guarantees is that his
   * SOURCES are current; the thinking still happens when he asks for it.
   */
  if (path === '/api/sync/due' && method === 'POST') {
    // `noteClientZone` shrugs (undefined) if the zone write failed; a sync must
    // still happen, so fall back to a plain read rather than skipping the pass.
    const world = (await noteClientZone(String(body?.tz ?? ''))) ?? (await readWorld())
    let outcome = { due: [] as string[], synced: [] as string[], errors: [] as string[], observations: 0 }
    try {
      const token = await googleToken(env)
      if (token) outcome = await syncDue(token, world)
    } catch (e) {
      /* A sync that cannot run must still return a feed — see `failure`. */
      outcome.errors = [(e as Error).message]
    }
    /*
      REFRESHED ONLY WHEN SOMETHING ACTUALLY ARRIVED. Rebuilding a feed over a
      world that did not move produces a byte-identical feed with a newer
      timestamp, which is the exact lie this whole change exists to stop.
    */
    if (outcome.synced.length) await freshen({ arriving: false, auth: await planAuth(env) }).catch(() => null)
    const feed = outcome.synced.length
      ? await buildFeed(await readWorld(), { withoutModel: true })
      : ((await readSnapshot(await readWorld())) ?? (await buildFeed(await readWorld(), { withoutModel: true })))
    return json({ ...outcome, freshness: sourceFreshness(await readWorld()), feed })
  }

  /** What each source knows and how old it is. Read-only; no connector call. */
  if (path === '/api/sync/freshness' && method === 'GET') {
    return json({ freshness: sourceFreshness(await readWorld()) })
  }

  if (path === '/api/shelf' && method === 'GET') return json(await readShelf())

  if (path === '/api/shelf' && method === 'PUT') {
    let shelf = await readShelf()
    if (Array.isArray(body?.order)) shelf = await arrange(body.order.map(String))
    if (body?.toggle && typeof body.toggle.id === 'string') shelf = await toggle(body.toggle.id, body.toggle.on !== false)
    if (typeof body?.forget === 'string') shelf = await forget(body.forget)
    return json(shelf)
  }

  // The durable half of the four-lane Home. Device-local spatial state (which
  // card is in front, chat snap state) never syncs — see server/home.ts.
  if (path === '/api/home' && method === 'GET') return json(await readHome())
  if (path === '/api/home' && method === 'PATCH') return json(await writeHome(body ?? {}))

  if (path === '/api/catalogue' && method === 'GET') return json({ sources: sourceCatalogue() })

  // ── Panes ───────────────────────────────────────────────────────────────
  const paneResponse = await paneRoutes(env, path, method, body, url)
  if (paneResponse) return paneResponse

  if (path === '/api/google/disconnect' && method === 'POST') {
    await env.CRUCIBLE.delete(TOKENS_KEY)
    return json({ ok: true })
  }

  return json({ error: 'Not found' }, 404)
}

/**
 * A plan names a source and a route; it never names a credential.
 *
 * So this is the one place a token can enter execution, on this host as on the
 * other. Absent when Google is not connected, and the executor then reports the
 * source as unreachable rather than throwing — a disconnected account degrades
 * one pane, not the screen.
 */
async function planAuth(env: Env): Promise<Record<string, string>> {
  const token = await googleToken(env).catch(() => null)
  return token ? { youtubeToken: token, googleToken: token } : {}
}

/**
 * The pane protocol, on the edge.
 *
 * The Worker had none of this. Panes, revisions and the addressing ladder were
 * verified and reachable on the Mac only, which made "the hosted copy is the
 * one he uses" and "his panes persist" contradictory claims. The handlers are
 * the same functions the Mac calls; only the dispatch shape differs, because
 * this file has no router.
 *
 * Returns null when the path is not a pane path, so the caller can fall
 * through — an unmatched pane-shaped URL must not become a 404 that shadows
 * every route registered after it.
 */
async function paneRoutes(
  env: Env,
  path: string,
  method: string,
  body: any,
  url: URL
): Promise<Response | null> {
  if (!path.startsWith('/api/panes')) return null

  if (path === '/api/panes' && method === 'GET') {
    return json({ panes: await panes.all(url.searchParams.get('closed') === '1') })
  }

  if (path === '/api/panes' && method === 'POST') {
    // A plan is optional: send one and it is sanitised and run, send only
    // `intent` and the compiler writes it. Both end at the same `panes.open`.
    if (!body?.plan) {
      const words = String(body?.intent ?? '').trim()
      if (!words) return json({ error: 'That is not a plan I can run.' }, 400)
      return json(await ask(words, { fresh: true, onShelf: body?.onShelf !== false, auth: await planAuth(env) }))
    }
    const plan = sanitisePlan(body.plan, String(body?.intent ?? ''))
    if (!plan) return json({ error: 'That is not a plan I can run.' }, 400)
    return json(await panes.open(plan, { title: body?.title, pin: body?.pin === 'content' || body?.pin === 'intent' ? body.pin : undefined, auth: await planAuth(env) }))
  }

  if (path === '/api/panes/resolve' && method === 'POST') {
    return json(await panes.whichPane(body?.ref, body?.context ?? {}, { consequential: body?.consequential === true }))
  }

  const rest = path.slice('/api/panes/'.length)
  const slash = rest.indexOf('/')
  const id = slash < 0 ? rest : rest.slice(0, slash)
  const verb = slash < 0 ? '' : rest.slice(slash + 1)
  if (!id) return null

  const or404 = <T>(v: T | null, why = 'No such pane.') => (v ? json(v) : json({ error: why }, 404))

  if (!verb && method === 'GET') return or404(await panes.open_(id))
  if (verb === 'history' && method === 'GET') return json({ revisions: await panes.history(id) })
  if (verb === 'diff' && method === 'GET') {
    const d = await panes.compare(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '')
    return or404(d, 'I don’t have both of those revisions.')
  }

  if (method === 'POST') {
    const auth = await planAuth(env)
    switch (verb) {
      case 'refine': {
        const plan = sanitisePlan(body?.plan, String(body?.intent ?? ''))
        // Same optionality as creation: his words are enough, and a refinement
        // compiles against the plan it refines rather than from nothing.
        if (!plan) {
          const words = String(body?.intent ?? '').trim()
          if (!words) return json({ error: 'That is not a plan I can run.' }, 400)
          return json(await ask(words, { paneId: id, auth }))
        }
        return or404(await panes.refine(id, plan, { from: body?.from, auth }))
      }
      case 'parameters':
        return or404(await panes.reparameterise(id, Array.isArray(body?.edits) ? body.edits : [], { auth }))
      case 'refresh':
        return or404(await panes.refresh(id, { auth }))
      case 'accept':
        return or404(await panes.accept(id), 'Nothing waiting on that pane.')
      case 'undo':
        return (await panes.stepBack(id).then((v) => (v ? json(v) : json({ error: 'Nothing to go back to.' }, 400))))
      case 'redo':
        return (await panes.stepForward(id).then((v) => (v ? json(v) : json({ error: 'Nothing to go forward to.' }, 400))))
      case 'close': {
        const v = await panes.close(id)
        if (!v) return json({ error: 'No such pane.' }, 404)
        // The place on the splash is given up; every revision is kept, so
        // reopening still restores the exact state he left.
        await forget(id).catch(() => null)
        return json(v)
      }
      case 'reopen':
        return or404(await panes.reopen(id))
      default:
        return null
    }
  }

  if (method === 'PUT') {
    if (verb === 'pin') {
      const mode = body?.mode
      return or404(await panes.pin(id, mode === 'content' || mode === 'intent' ? mode : null))
    }
    if (verb === 'refresh-policy') return or404(await panes.schedule(id, body?.policy as RefreshPolicy))
  }

  return null
}

/**
 * The action table, bound to this request's environment.
 *
 * Registered per request rather than once at module scope because every handler
 * needs `env` to reach a Google token, and a Worker isolate may serve requests
 * for the life of the process. Registration is a map write, so doing it again
 * costs nothing and cannot drift between the two.
 */
function installWorkerActions(env: Env): void {
  const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const google = async () => {
    const t = await googleToken(env)
    if (!t) throw new Error('Google is not connected.')
    return t
  }

  /*
    EVERY ACTION, FROM ONE TABLE.

    This was a verbatim copy of the block in `server/index.ts`, differing only
    in how it reached a Google token — and the copy is precisely why
    `calendar.update` existed in neither. The phone talks to THIS host, so a
    capability that lands only in the other one is an assistant that can rename
    an event on a laptop nobody uses. See server/capabilities.ts.
  */
  installCapabilities({ google, searchKeys })
}

/** "44.13,11.11" → a point, or null if it is not one. */
function parsePoint(s: string): { lat: number; lon: number } | null {
  const [a, b] = s.split(',')
  const lat = Number(a)
  const lon = Number(b)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  return { lat, lon }
}

/**
 * Record the client's zone, if it sent one, and hand back the world.
 *
 * Every feed request carries it, so this runs constantly and must be almost
 * free: `noteTimeZone` returns false unless something actually changed, and
 * only then is anything written.
 */
async function noteClientZone(tz: string): Promise<World | undefined> {
  try {
    /**
     * `noteTimeZone` returns false unless something actually changed, so the common
     * case is a plain read and no transaction at all — which matters, because every
     * feed request carries a zone and this runs constantly.
     */
    const w = await readWorld()
    if (!tz || !noteTimeZone(w, tz, 'device')) return w
    const { world } = await mutateWorld((fresh) => { noteTimeZone(fresh, tz, 'device') }, { label: 'your time zone' })
    return world
  } catch {
    return undefined
  }
}
