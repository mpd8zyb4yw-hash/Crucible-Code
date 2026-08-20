/**
 * THE WORKERD HARNESS — CLOSING THE "ONE DEPENDENCY WIDE" GAP.
 *
 * `docs/memory-core.md` §13 is honest about what the acceptance suite does not
 * prove: it drives the real `durableObjectSqlDriver` over a SHIM that presents
 * the Durable Object's `exec().toArray()` surface on top of `better-sqlite3`.
 * That proves the adapter issues the same statements. It proves nothing about
 * Cloudflare's SQLite, about `setAlarm`, about what survives an isolate being
 * evicted, or about what a Durable Object does with a turn that throws.
 *
 * Those are not small remainders. The memory core's whole persistence story is
 * "the object is single, its turns are gated, and its writes land" — three
 * platform properties, none of which a shim can have. And the alarm is the
 * unattended half of the product: the reflection that happens when nobody is
 * looking is exactly the reflection nobody has watched.
 *
 * So this file is a second Worker entry point, run by `scripts/edge.mjs` under
 * `wrangler dev --local`, which is **workerd** — the same runtime Cloudflare
 * runs, with the same SQLite, the same alarm scheduler and the same input
 * gating. It is never deployed. `wrangler.edge-test.jsonc` is its config and
 * points at a scratch `--persist-to` directory, so nothing here can reach the
 * production object.
 *
 * TWO DURABLE OBJECTS, FOR TWO DIFFERENT QUESTIONS.
 *
 *   WorldObject   the REAL production class, re-exported unchanged. This is what
 *                 answers "does the shipping code work on the real platform" —
 *                 append arms an alarm, the alarm wakes the object, the object
 *                 reflects and re-arms. A copy of the class with the same body
 *                 would answer a different and much weaker question.
 *   MemoryProbe   the introspection the production class deliberately does not
 *                 have: row counts, raw SELECTs, a forced mid-reflection
 *                 failure, an isolate abort. Everything here that is not a
 *                 platform call goes through `durableObjectMemoryStore`, so the
 *                 store under test is the shipping store.
 *
 * WHY THE PROBE HAS A RAW `sql` OP AND THE PRODUCTION OBJECT NEVER WILL. The
 * questions this harness asks are about the DATABASE rather than about the
 * cognition — "did `shadow_runs` appear", "is `memory_schema` at 2", "did the
 * row written before the throw survive". A repository method cannot answer any
 * of those, because a repository is the thing being tested.
 */

import { durableObjectMemoryStore } from '../server/memory/store.js'
import {
  SCHEMA_VERSION,
  durableObjectSqlDriver,
  type DurableObjectSql,
  type DurableObjectSqlStorage,
} from '../server/memory/sql.js'
import { syntheticLife } from '../server/memory/fixture.js'
import { recordedCycle } from '../server/memory/shadow.js'
import { runCycle } from '../server/memory/reflect.js'
import { statedFact, writeFact } from '../server/memory/facts.js'
import { recordRecommendation, recordOutcome } from '../server/memory/recommendations.js'
import type { MemoryEvent, MemoryStore } from '../server/memory/types.js'
import { enrichPanes } from '../server/panes.js'
import { cognition as installedCognition } from '../server/memory/cognition.js'
import { dayIn, partsIn } from '../server/clock.js'
import type { Need } from '../server/think.js'

/** The production class, unchanged and unwrapped. See the header. */
export { WorldObject } from './index.js'

/** The production entry point itself, so its own wiring can be exercised. */
import productionWorker from './index.js'

interface ProbeEnv {
  PROBE: DurableObjectNamespace
  WORLD: DurableObjectNamespace
  CRUCIBLE: KVNamespace
}

/**
 * Every table the schema creates, so a test can assert on the whole set rather
 * than on the two or three somebody remembered. Derived from the migration
 * ladder at runtime would be better; the ladder is a list of DDL strings, so
 * this is the honest version — a literal that fails loudly when it drifts.
 */
const EXPECTED_TABLES = [
  'memory_schema',
  'events', 'observations',
  'entities', 'entity_identities', 'entity_aliases', 'relationships',
  'episodes', 'episode_observations', 'episode_entities',
  'facts', 'summaries', 'routines', 'hypotheses',
  'predictions', 'prediction_outcomes',
  'recommendations', 'recommendation_outcomes',
  'reflection_runs', 'cursors',
  'shadow_runs',
]

type ProbeRequest =
  /** Construct the store, which runs `migrate`. Returns the schema version. */
  | { op: 'open' }
  /** `SELECT name FROM sqlite_master`, plus the recorded schema version. */
  | { op: 'schema' }
  /** A read-only statement. Refused if it is not a SELECT or a PRAGMA. */
  | { op: 'sql'; query: string; bindings?: unknown[] }
  /** Row counts for every expected table. */
  | { op: 'census' }
  /**
   * Wind this database back to a genuine v1 by dropping exactly what v2 added.
   *
   * SCHEMA_V2 is one table and its two indexes, so the result is byte-for-byte
   * the database SCHEMA_V1 produces — which is the point. Replaying the v1 DDL
   * from an exported copy would test that two copies of the same strings agree.
   */
  | { op: 'downgrade' }
  /** Append events, idempotent on the dedupe key. Returns how many were new. */
  | { op: 'append'; events: MemoryEvent[] }
  /** Append a slice of the synthetic life, generated inside the isolate. */
  | { op: 'seed'; days?: number }
  /** A real reflection pass. */
  | { op: 'reflect'; kind: 'ingest' | 'short' | 'daily' | 'weekly'; now: string; timeZone?: string }
  /**
   * One of each thing §18 says a migration may never lose, written through the
   * modules the app writes them through — a stated fact, a recommendation and
   * his response to it. Not hand-rolled INSERTs: the point of the assertion is
   * that what `statedFact` produces survives, and a row this file invented could
   * differ from one in exactly the column that decides.
   */
  | { op: 'user-evidence'; at: string }
  /** Read the above back. Absence is the failure the migration gate is looking for. */
  | { op: 'user-evidence-check' }
  /** Delete every derived row. The first half of a replay, on the real platform. */
  | { op: 'clear-derived' }
  /**
   * A reflection pass that throws partway, after the ledger has been written and
   * before the derived tables are finished. §17's question, on the real platform:
   * does the raw evidence survive, and is the derived work still restartable.
   */
  | { op: 'reflect-poisoned'; now: string; timeZone?: string }
  /**
   * Two writes with a throw between them, in ONE turn. Not an assertion — a
   * measurement. What a Durable Object does with a half-finished turn is a
   * platform property, and this harness exists because guessing at platform
   * properties is what put the gap in §13.
   */
  | { op: 'torn-write'; marker: string }
  /** The same tear, inside `storage.transactionSync`. Does the platform undo it? */
  | { op: 'torn-write-tx'; marker: string }
  /** Arm the object's own alarm. Returns the deadline actually recorded. */
  | { op: 'arm'; inMs: number; mode?: 'reflect' | 'throw' }
  /** How many times this object's alarm has run, and what happened on each. */
  | { op: 'alarms' }
  /** `getAlarm()`, so a test can see whether the object is still scheduled. */
  | { op: 'alarm-at' }
  /**
   * Evict the isolate. Everything in memory goes; everything committed to
   * storage must not. `abort()` is workerd's own hard reset and is the closest
   * thing to what happens when Cloudflare reclaims an idle object.
   */
  | { op: 'abort' }

/** Where the alarm log lives. Ordinary DO KV storage, not the SQL side. */
const ALARM_LOG = 'probe:alarms'
const ALARM_MODE = 'probe:alarm-mode'

export class MemoryProbe {
  #state: DurableObjectState
  #store: MemoryStore | null = null

  constructor(state: DurableObjectState) {
    this.#state = state
  }

  #storage(): DurableObjectSqlStorage {
    const storage = this.#state.storage as unknown as DurableObjectSqlStorage
    if (!storage.sql) throw new Error('this object has no SQL storage — check new_sqlite_classes')
    return storage
  }

  #sql(): DurableObjectSql {
    return this.#storage().sql
  }

  /**
   * The store, reconstructed on demand.
   *
   * Cached like the production object caches it, and dropped by `downgrade` and
   * `abort` — because a cached store is a store whose `migrate` already ran, and
   * the migration is half of what this harness is for.
   */
  #memory(): MemoryStore {
    if (!this.#store) this.#store = durableObjectMemoryStore(this.#storage())
    return this.#store
  }

  async fetch(req: Request): Promise<Response> {
    let body: ProbeRequest
    try {
      body = (await req.json()) as ProbeRequest
    } catch {
      return Response.json({ ok: false, message: 'unreadable probe request' }, { status: 400 })
    }
    /*
      `torn-write` must escape THIS handler, not be caught by it. The question it
      asks is what workerd does with a turn that fails, and a turn whose handler
      returns a tidy 500 has not failed — it succeeded at reporting a failure.
      The first version of this harness caught it here and duly measured that the
      write survived, which was true and meant nothing.
    */
    if (body.op === 'torn-write') {
      await this.#handle(body)
      throw new Error('torn-write returned; it is supposed to throw')
    }
    try {
      return Response.json({ ok: true, ...(await this.#handle(body)) })
    } catch (e) {
      return Response.json({ ok: false, message: (e as Error).message, stack: (e as Error).stack })
    }
  }

  async #handle(body: ProbeRequest): Promise<Record<string, unknown>> {
    switch (body.op) {
      case 'open':
        return { schema: this.#memory().schemaVersion(), expected: SCHEMA_VERSION }

      case 'schema': {
        const rows = this.#sql().exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray()
        const tables = rows.map((r) => String(r.name)).filter((n) => !n.startsWith('sqlite_')).sort()
        const version = this.#sql().exec(`SELECT version FROM memory_schema LIMIT 1`).toArray()
        return {
          tables,
          missing: EXPECTED_TABLES.filter((t) => !tables.includes(t)).sort(),
          unexpected: tables.filter((t) => !EXPECTED_TABLES.includes(t) && !t.startsWith('_')),
          version: version.length ? Number(version[0]!.version) : null,
        }
      }

      case 'sql': {
        const q = body.query.trim()
        if (!/^(select|pragma)\b/i.test(q)) throw new Error('the probe only reads')
        return { rows: this.#sql().exec(q, ...((body.bindings ?? []) as never[])).toArray() }
      }

      case 'census': {
        const counts: Record<string, number> = {}
        for (const t of EXPECTED_TABLES) {
          try {
            const r = this.#sql().exec(`SELECT COUNT(*) AS n FROM ${t}`).toArray()
            counts[t] = Number(r[0]?.n ?? 0)
          } catch {
            counts[t] = -1 // the table is absent, which is itself an answer
          }
        }
        return { counts }
      }

      case 'downgrade': {
        this.#memory() // make sure it exists before taking it apart
        for (const s of [
          `DROP INDEX IF EXISTS shadow_runs_surfaced`,
          `DROP INDEX IF EXISTS shadow_runs_started`,
          `DROP TABLE IF EXISTS shadow_runs`,
          `UPDATE memory_schema SET version = 1`,
        ]) this.#sql().exec(s)
        this.#store = null
        return { schema: 1 }
      }

      case 'append':
        return { written: this.#memory().events.append(body.events).length }

      case 'seed': {
        const life = syntheticLife()
        const events = body.days ? sliceDays(life.events, body.days) : life.events
        return {
          written: this.#memory().events.append(events).length,
          offered: events.length,
          timeZone: life.timeZone,
          me: life.me,
        }
      }

      case 'reflect': {
        const { result } = recordedCycle(this.#memory(), body.kind, new Date(body.now), {
          timeZone: body.timeZone,
        })
        return { run: result.run }
      }

      case 'user-evidence': {
        const store = this.#memory()
        const fact = statedFact(store, {
          predicate: 'travel_preference',
          value: 'prefers the train',
          at: body.at,
          note: 'typed by him, in the harness',
        })
        /* An INFERRED fact beside it, so the assertion can fail in both
           directions: his survives, and the derived one next to it does not. */
        const inferred = writeFact(store, {
          subject: 'user',
          predicate: 'usual_departure',
          value: '10:31',
          knowledgeKind: 'inferred',
          confidence: 0.6,
          at: body.at,
        }).fact
        const rec = recordRecommendation(store, {
          subject: 'user',
          recommendation: 'leave ten minutes earlier',
          shownAt: body.at,
        })
        const outcome = recordOutcome(store, {
          recommendationId: rec.id,
          recordedAt: body.at,
          dismissed: true,
        })
        return { fact: fact.id, inferred: inferred.id, recommendation: rec.id, outcome: outcome.id }
      }

      case 'user-evidence-check': {
        const store = this.#memory()
        const facts = store.facts.all()
        return {
          stated: facts.filter((f) => f.knowledgeKind === 'stated').map((f) => f.predicate).sort(),
          inferred: facts.filter((f) => f.knowledgeKind !== 'stated').map((f) => f.predicate).sort(),
          recommendations: store.recommendations.all().length,
          outcomes: store.recommendations.outcomes().length,
          predictionOutcomes: store.predictions.outcomes().length,
          events: store.events.count(),
        }
      }

      case 'clear-derived':
        this.#memory().clearDerived()
        return { cleared: true }

      case 'reflect-poisoned': {
        const store = this.#memory()
        /*
          Fail at the ROUTINE stage: late enough that normalisation, entity
          resolution and episode assembly have all committed rows, early enough
          that hypotheses, predictions and anomalies have not. A failure at the
          very first or very last stage would not distinguish "the ledger
          survived" from "nothing had happened yet".
        */
        const poisoned: MemoryStore = {
          ...store,
          routines: {
            ...store.routines,
            put() { throw new Error('injected failure, mid-reflection') },
          },
        }
        /*
          `runCycle` does not propagate: it catches, marks the run `failed` and
          returns, because a reflection that threw is a reflection to retry and
          not a request to fail. So the evidence that the injection landed is the
          RUN RECORD, and the harness asserts on that rather than on an exception
          it would never see.
        */
        const { run } = runCycle(poisoned, 'daily', new Date(body.now), { timeZone: body.timeZone })
        return { status: run.status, error: run.error ?? null, counts: run.counts }
      }

      case 'torn-write': {
        this.#memory()
        this.#sql().exec(`CREATE TABLE IF NOT EXISTS probe_torn (id TEXT PRIMARY KEY)`)
        this.#sql().exec(`INSERT OR REPLACE INTO probe_torn (id) VALUES (?)`, `${body.marker}:before`)
        throw new Error('torn write: throwing between two committed statements')
      }

      case 'torn-write-tx': {
        this.#memory()
        const storage = this.#storage()
        /*
          Through the SHIPPING DRIVER, not through `transactionSync` directly.
          The platform having a working transaction and the memory core using it
          are two different claims, and only the second one protects anything.
        */
        const driver = durableObjectSqlDriver(storage)
        driver.exec(`CREATE TABLE IF NOT EXISTS probe_torn (id TEXT PRIMARY KEY)`)
        try {
          driver.transaction!(() => {
            driver.exec(`INSERT OR REPLACE INTO probe_torn (id) VALUES (?)`, `${body.marker}:in-tx`)
            throw new Error('torn write, inside a transaction')
          })
        } catch (e) {
          return { available: typeof storage.transactionSync === 'function', threw: (e as Error).message }
        }
        return { available: typeof storage.transactionSync === 'function', threw: null }
      }

      case 'arm': {
        await this.#state.storage.put(ALARM_MODE, body.mode ?? 'reflect')
        const at = Date.now() + body.inMs
        await this.#state.storage.setAlarm(at)
        return { requested: at, recorded: (await this.#state.storage.getAlarm()) ?? null }
      }

      case 'alarms':
        return { log: (await this.#state.storage.get<AlarmEntry[]>(ALARM_LOG)) ?? [] }

      case 'alarm-at':
        return { at: (await this.#state.storage.getAlarm()) ?? null }

      case 'abort': {
        /*
          Scheduled rather than awaited: `abort()` tears down the isolate that is
          currently mid-request, so awaiting it would mean this response never
          leaves. The caller gets an ack and then finds the connection reset,
          which is exactly what an eviction looks like from outside.
        */
        queueMicrotask(() => (this.#state as unknown as { abort(reason?: string): void }).abort('probe restart'))
        return { aborting: true }
      }
    }
  }

  /**
   * The alarm handler, deliberately shaped like the production one: do the work,
   * swallow the failure, re-arm in `finally`. What it adds is a durable log, so
   * the harness can prove the alarm ran rather than inferring it from a side
   * effect that something else might also have caused.
   */
  async alarm(): Promise<void> {
    const log = (await this.#state.storage.get<AlarmEntry[]>(ALARM_LOG)) ?? []
    const mode = (await this.#state.storage.get<string>(ALARM_MODE)) ?? 'reflect'
    const entry: AlarmEntry = { at: new Date().toISOString(), mode, ok: true }
    try {
      if (mode === 'throw') throw new Error('injected alarm failure')
      const { result } = recordedCycle(this.#memory(), 'daily', new Date(), {})
      entry.runId = result.run.id
    } catch (e) {
      entry.ok = false
      entry.message = (e as Error).message
    } finally {
      log.push(entry)
      await this.#state.storage.put(ALARM_LOG, log)
      /*
        RE-ARM ONLY WHILE A TEST IS WATCHING. The production object re-arms
        forever on purpose; a harness object that did the same would keep a
        `wrangler dev` process busy reflecting over synthetic data for as long as
        it ran, and the alarm log the next test reads would not be the one this
        test wrote.
      */
      if (log.length < 3) await this.#state.storage.setAlarm(Date.now() + 400)
    }
  }
}

interface AlarmEntry {
  at: string
  mode: string
  ok: boolean
  message?: string
  runId?: string
}

/** The first `days` days of the fixture, by `observedAt`. Keeps the harness quick. */
function sliceDays(events: MemoryEvent[], days: number): MemoryEvent[] {
  if (!events.length) return events
  const first = events.reduce((a, e) => (e.observedAt < a ? e.observedAt : a), events[0]!.observedAt).slice(0, 10)
  const cutoff = new Date(`${first}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() + days)
  const until = cutoff.toISOString()
  return events.filter((e) => e.observedAt < until)
}


/**
 * THE EDGE'S READ PATH, END TO END, ON THE REAL RUNTIME.
 *
 * ── WHAT THIS PROVES THAT NOTHING ELSE DID ───────────────────────────────────
 *
 * `scripts/memory.mjs` proves the compilers work. It proves it against a local
 * `MemoryStore` — which is the host that was never broken. The defect this
 * route exists to catch lived entirely in the gap between the two hosts: the
 * Worker dual-WROTE to a Durable Object ledger and then asked a completely
 * different abstraction to read it, got null, and skipped enrichment on every
 * production request. Every memory test passed throughout, because every memory
 * test drives the store directly.
 *
 * So this drives the chain the product actually uses, and no part of it is a
 * stand-in:
 *
 *   real evidence  → `syntheticLife()`, appended through the PRODUCTION
 *                    `memory.append` op
 *   real storage   → `WorldObject` on workerd's SQLite, not a shim
 *   real thinking  → `memory.reflect`, the same op the alarm calls
 *   real transport → an RPC cognition built exactly as `worker/index.ts` builds
 *                    it, isolate → object → SQL and back
 *   real seam      → `enrichPanes`, the production function `feed.ts` calls,
 *                    unmodified and imported from the shipping module
 *
 * If any link is broken the answer is an empty context array — which is exactly
 * what production returned before this change, and exactly what the harness
 * asserts against.
 */
async function edgeCognitionAcceptance(env: ProbeEnv, name: string): Promise<Record<string, unknown>> {
  /*
    THE PRODUCTION OBJECT, BY THE NAME PRODUCTION USES.

    `installWorldStore` hard-codes `idFromName('world')`, so seeding anywhere
    else would leave the installed cognition pointing at an empty ledger and the
    test would prove nothing while looking like it had.
  */
  void name
  const stub = env.WORLD.get(env.WORLD.idFromName('world'))
  const call = async (b: unknown): Promise<any> => {
    const res = await stub.fetch('https://world.crucible/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
    return res.json()
  }

  const life = syntheticLife()

  // 1 · evidence into the REAL object, through the real op.
  const appended = await call({
    op: 'memory.append',
    events: life.events,
    now: life.now.toISOString(),
    opts: { timeZone: life.timeZone, me: life.me },
  })

  // 2 · make it think. Daily, because that is the pass that builds baselines.
  const reflected = await call({
    op: 'memory.reflect',
    kind: 'daily',
    now: life.now.toISOString(),
    opts: { timeZone: life.timeZone, me: life.me },
  })

  /*
    3 · THE TRANSPORT PRODUCTION INSTALLS — not one this file builds.

    An earlier version of this test constructed its own RPC cognition with the
    same shape as the Worker's. It passed, and it was nearly worthless: deleting
    `setCognition(edgeCognition)` from `worker/index.ts` — the exact line whose
    absence WAS the bug — would not have failed it. A harness that rebuilds the
    thing it is checking is checking its own copy.

    So the production `fetch` handler is invoked once, purely for its
    installation side effects (`installWorldStore` runs before any routing or
    auth check), and what comes back out of `cognition()` is whatever the
    shipping Worker decided to install. The response itself is discarded — this
    harness binds no ASSETS, so a static path would throw, and that is
    irrelevant to what is being asked.
  */
  let installRan = true
  try {
    await productionWorker.fetch(new Request('https://crucible.test/api/version'), env as never)
  } catch {
    installRan = false
  }
  const cognition = installedCognition()
  if (!cognition) {
    return {
      written: appended?.written ?? 0,
      reflected: reflected?.ok === true,
      installed: false,
      installRan,
      context: [],
      contextRaw: [],
      intelligence: null,
      day: null,
      weekday: null,
    }
  }

  /*
    4 · A DAY THE LEDGER HAS A BASELINE FOR.

    The most recent Thursday at or before the fixture's `now`, in HIS zone —
    baselines are keyed by weekday in the zone the evidence was labelled in, and
    deriving this from the runtime's UTC would ask for a baseline on the wrong
    day roughly a seventh of the time.

    The step value is deliberately absurd rather than computed from the mean.
    The harness cannot see inside the object to read `thu.mean`, and it does not
    need to: one step is below any plausible Thursday, so a working chain must
    produce the "below your usual Thursday" line and a broken one produces
    nothing at all. The assertion is about the CHAIN, not about the arithmetic —
    `scripts/memory.mjs` already owns the arithmetic.
  */
  const thursday = new Date(life.now)
  for (let i = 0; i < 8 && partsIn(thursday, life.timeZone).weekday !== 4; i++) {
    thursday.setUTCDate(thursday.getUTCDate() - 1)
  }
  const day = dayIn(thursday, life.timeZone)

  const needs: Need[] = [
    {
      id: 'src-activity',
      title: 'Activity',
      panes: [
        {
          widget: {
            kind: 'fitness',
            series: [],
            /*
              `says` and `isToday` are required by `ActivityBrief` and are not
              what is under test — `factsOf` reads only `metric` and `current`.
              Filled honestly rather than with placeholders that would read as a
              claim if this widget ever reached a screen, which it does not.
            */
            report: { metric: 'steps', says: '', current: { day, value: 1, isToday: false } },
          },
        },
      ],
    } as unknown as Need,
  ]

  // 5 · the production seam, over the RPC.
  const enrichedNeeds = await enrichPanes(needs, cognition, { now: life.now, timeZone: life.timeZone })
  const widget = (enrichedNeeds[0] as any)?.panes?.[0]?.widget
  const intelligence = await cognition.intelligence({ now: life.now.toISOString(), timeZone: life.timeZone })

  return {
    written: appended?.written ?? 0,
    reflected: reflected?.ok === true,
    /** Whether the SHIPPING Worker installed a read path at all. The bug, named. */
    installed: true,
    installRan,
    day,
    weekday: partsIn(thursday, life.timeZone).weekday,
    /** The sentences that reached the widget. Empty means the chain is broken. */
    context: (widget?.context ?? []).map((c: { line: string }) => c.line),
    /** Carried so the harness can assert §13: no probability reaches a screen. */
    contextRaw: widget?.context ?? [],
    intelligence,
  }
}

/**
 * The worker half: a thin proxy so the harness can address either object over
 * plain HTTP. `idFromName` rather than a random id, so a test that restarts the
 * whole `wrangler dev` process reaches the same object it wrote to.
 */
export default {
  async fetch(req: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/up') return Response.json({ ok: true, schema: SCHEMA_VERSION })

    const name = url.searchParams.get('name') ?? 'probe'

    /* The edge read path, end to end. See `edgeCognitionAcceptance`. */
    if (url.pathname === '/cognition') {
      try {
        return Response.json({ ok: true, ...(await edgeCognitionAcceptance(env, name)) })
      } catch (e) {
        return Response.json({ ok: false, message: (e as Error).message, stack: (e as Error).stack })
      }
    }

    const target = url.pathname === '/world' ? env.WORLD : url.pathname === '/probe' ? env.PROBE : null
    if (!target) return Response.json({ ok: false, message: `no route for ${url.pathname}` }, { status: 404 })

    const stub = target.get(target.idFromName(name))
    try {
      const res = await stub.fetch('https://probe.crucible/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await req.text(),
      })
      return new Response(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } })
    } catch (e) {
      /*
        An aborted object resets the connection, and that is a RESULT here rather
        than an error — `op: 'abort'` is supposed to do this. Reported as a
        distinguishable shape so the harness can tell it apart from a real fault.
      */
      return Response.json({ ok: false, disconnected: true, message: (e as Error).message })
    }
  },
}
