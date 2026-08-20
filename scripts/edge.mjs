#!/usr/bin/env node
/**
 * THE MEMORY CORE ON THE REAL RUNTIME — §16 to §18.
 *
 * `docs/memory-core.md` §13 lists three things the acceptance suite does not
 * verify, and the first two are this file's subject:
 *
 *     Cloudflare's SQLite      the host-parity test drives the real DO adapter
 *                              over a SHIM built on better-sqlite3. That gap is
 *                              one dependency wide.
 *     The edge integration     `WorldObject`'s memory ops, its alarm and the
 *                              worker-side sink type-check and have never run.
 *
 * `wrangler dev --local` is **workerd** — Cloudflare's runtime, its SQLite, its
 * alarm scheduler, its input gating. Not a simulation of them. So this script
 * starts the harness worker (`worker/edge-probe.ts`, which re-exports the REAL
 * `WorldObject` unchanged), drives it over HTTP, and then kills and restarts the
 * whole process to prove the durability claim against something that actually
 * had to survive.
 *
 * IT CANNOT REACH PRODUCTION. `wrangler.edge-test.jsonc` names a different
 * worker, has no routes, binds a local-only KV id, and everything is persisted
 * into a scratch directory this script creates and deletes. §16's "prefer
 * staging; do not risk production memory during migration testing" is honoured
 * by there being no path from here to the account at all.
 *
 * Run: npm run edge      (also in `npm test`)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.EDGE_TEST_PORT ?? 8799)
const BASE = `http://127.0.0.1:${PORT}`
const PERSIST = mkdtempSync(join(tmpdir(), 'crucible-edge-'))
const VERBOSE = process.argv.includes('--verbose')

let failures = 0
const ok = (what, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${what}`)
  else {
    failures++
    console.error(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (title) => console.log(`\n${title}`)
const eq = (what, got, want) =>
  ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)

// ── The runtime ──────────────────────────────────────────────────────────────

let child = null

/**
 * Start workerd and wait until it answers.
 *
 * `--persist-to` is the whole reason a restart proves anything: without it the
 * object's storage lives in the default `.wrangler` state beside the production
 * config, and with it the storage is a directory this script owns and can point
 * a second process at.
 */
async function start() {
  child = spawn(
    'npx',
    [
      'wrangler', 'dev',
      '--config', 'wrangler.edge-test.jsonc',
      '--local',
      '--ip', '127.0.0.1',
      '--port', String(PORT),
      '--persist-to', PERSIST,
      '--log-level', VERBOSE ? 'info' : 'error',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } }
  )
  const log = []
  const keep = (b) => {
    log.push(b.toString())
    if (VERBOSE) process.stderr.write(b)
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (${child.exitCode})\n${log.join('')}`)
    try {
      const r = await fetch(`${BASE}/up`)
      if (r.ok) return
    } catch {
      /* not listening yet */
    }
    await sleep(300)
  }
  throw new Error(`wrangler never came up on ${PORT}\n${log.join('')}`)
}

async function stop() {
  if (!child) return
  const dead = new Promise((res) => child.once('exit', res))
  child.kill('SIGINT')
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  await dead
  clearTimeout(timer)
  child = null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One request to one object. `name` selects which instance. */
async function call(route, body, name = 'probe') {
  const res = await fetch(`${BASE}${route}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}
const probe = (body, name) => call('/probe', body, name)
const world = (body, name = 'world') => call('/world', body, name)

/** Poll until `read()` satisfies `done`, or give up. Returns the last value. */
async function until(read, done, ms = 12_000, every = 200) {
  const deadline = Date.now() + ms
  let last = await read()
  while (Date.now() < deadline && !done(last)) {
    await sleep(every)
    last = await read()
  }
  return last
}

// ── The tests ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`workerd harness · port ${PORT} · state ${PERSIST}`)
  await start()

  // ── §16 · Schema creation, on Cloudflare's SQLite ──────────────────────────
  section('SCHEMA')
  const opened = await probe({ op: 'open' })
  ok('the store opens on a Durable Object with SQL storage', opened.ok, opened.message)
  eq('migrate() reports the current schema version', opened.schema, opened.expected)

  const schema = await probe({ op: 'schema' })
  eq('every table in the ladder exists', schema.missing, [])
  eq('memory_schema records the version', schema.version, opened.expected)
  ok(
    'no table was created that the schema does not name',
    schema.unexpected.length === 0,
    JSON.stringify(schema.unexpected)
  )

  // The DO adapter has no transaction wrapper — see `durableObjectSqlDriver`.
  // Whether that is safe depends on a platform property, so it is measured.
  const journal = await probe({ op: 'sql', query: 'PRAGMA journal_mode' })
  if (VERBOSE) console.log('    journal:', JSON.stringify(journal.rows))

  // ── §17 · Persistence, and the alarm ───────────────────────────────────────
  section('LEDGER')
  const seeded = await probe({ op: 'seed', days: 40 })
  ok('the ledger accepts a real event stream', seeded.written > 0, JSON.stringify(seeded))
  const firstWrite = seeded.written

  const again = await probe({ op: 'seed', days: 40 })
  eq('appending the same events again writes nothing (idempotent on dedupeKey)', again.written, 0)

  const census1 = await probe({ op: 'census' })
  eq('the row count did not move on the duplicate append', census1.counts.events, firstWrite)

  // Concurrency: a Durable Object gates its input, so N parallel appends of
  // disjoint events must all land and none may interleave into a lost update.
  section('CONCURRENCY')
  const batches = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 5 }, (_, j) => syntheticEvent(`concurrent-${i}-${j}`))
  )
  const results = await Promise.all(batches.map((events) => probe({ op: 'append', events })))
  eq(
    'eight concurrent appends each wrote their own five events',
    results.map((r) => r.written),
    batches.map(() => 5)
  )
  const census2 = await probe({ op: 'census' })
  eq('and the ledger holds exactly the sum', census2.counts.events, firstWrite + 40)

  // ── §17 · The alarm, on the real scheduler ─────────────────────────────────
  section('ALARM')
  const armed = await probe({ op: 'arm', inMs: 300 })
  ok('setAlarm records a deadline', typeof armed.recorded === 'number', JSON.stringify(armed))

  const fired = await until(
    () => probe({ op: 'alarms' }),
    (r) => (r.log?.length ?? 0) >= 2
  )
  ok('the platform woke the object', (fired.log?.length ?? 0) >= 1, JSON.stringify(fired.log))
  ok('the handler ran a real reflection cycle', fired.log?.[0]?.ok === true && !!fired.log?.[0]?.runId, JSON.stringify(fired.log?.[0]))
  ok(
    'and re-armed itself, so the cadence continues',
    (fired.log?.length ?? 0) >= 2,
    `fired ${fired.log?.length ?? 0} times`
  )

  const censusAfterAlarm = await probe({ op: 'census' })
  ok(
    'the alarm persisted its work',
    censusAfterAlarm.counts.reflection_runs > 0 && censusAfterAlarm.counts.observations > 0,
    JSON.stringify({
      runs: censusAfterAlarm.counts.reflection_runs,
      observations: censusAfterAlarm.counts.observations,
    })
  )

  // An alarm that throws must still re-arm — otherwise one bad pass silences the
  // object forever, with nothing anywhere saying so.
  const thrower = 'alarm-failure'
  await probe({ op: 'arm', inMs: 300, mode: 'throw' }, thrower)
  const failedLog = await until(
    () => probe({ op: 'alarms' }, thrower),
    (r) => (r.log?.length ?? 0) >= 2
  )
  ok('a failing alarm is recorded as failed', failedLog.log?.[0]?.ok === false, JSON.stringify(failedLog.log?.[0]))
  ok(
    'and the object still wakes again afterwards',
    (failedLog.log?.length ?? 0) >= 2,
    `fired ${failedLog.log?.length ?? 0} times`
  )

  // ── §17 · The production object, end to end ────────────────────────────────
  //
  // The class above is the harness's. This is `WorldObject` itself: the append
  // op the observation sink calls, the alarm it arms, the reflection that alarm
  // runs. Nothing here is a copy of the shipping code — it IS the shipping code.
  section('THE PRODUCTION OBJECT')
  const events = Array.from({ length: 30 }, (_, i) => syntheticEvent(`world-${i}`))
  const appended = await world({ op: 'memory.append', events, now: new Date().toISOString() })
  ok('WorldObject accepts memory.append', appended.ok === true, JSON.stringify(appended))
  eq('and wrote every event', appended.written, events.length)

  const censusBefore = await world({ op: 'memory.inspect', view: 'census' })
  ok('WorldObject answers memory.inspect', censusBefore.ok === true, JSON.stringify(censusBefore))

  // MEMORY_REFLECT_MS is 600 in the harness config, so the alarm the append
  // armed is due almost immediately. In production it is a quarter of an hour
  // and nothing else about the path differs.
  const grown = await until(
    () => world({ op: 'memory.inspect', view: 'census' }),
    (r) => (r.census?.runs ?? 0) > (censusBefore.census?.runs ?? 0),
    15_000
  )
  ok(
    "the object's own alarm fired and reflected",
    (grown.census?.runs ?? 0) > (censusBefore.census?.runs ?? 0),
    `runs ${censusBefore.census?.runs} → ${grown.census?.runs}`
  )
  ok(
    'the pass was recorded as a shadow run',
    (grown.census?.shadowRuns ?? 0) > 0,
    JSON.stringify(grown.census)
  )

  // ── §17 · Failure halfway through reflection ───────────────────────────────
  section('FAILURE MID-REFLECTION')
  const before = await probe({ op: 'census' })
  const poisoned = await probe({ op: 'reflect-poisoned', now: new Date().toISOString() })
  eq('a pass that failed mid-reflection records itself as failed', poisoned.status, 'failed')
  ok('and says what went wrong', /injected/.test(poisoned.error ?? ''), JSON.stringify(poisoned.error))
  ok(
    'having got far enough to have done some of the work',
    (poisoned.counts?.summaries ?? 0) > 0,
    JSON.stringify(poisoned.counts)
  )

  const afterFail = await probe({ op: 'census' })
  eq('the ledger is untouched by a failed pass', afterFail.counts.events, before.counts.events)
  const retried = await probe({ op: 'reflect', kind: 'daily', now: new Date().toISOString() })
  eq('and the derived work is still restartable', retried.run?.status, 'ok')

  // WHAT A DURABLE OBJECT DOES WITH A TURN THAT THROWS is a platform property,
  // and the DO driver has no transaction wrapper on the strength of a belief
  // about it (see `durableObjectSqlDriver`). Measured, not assumed — and the
  // throw has to escape the object's own handler or the turn did not fail.
  const torn = await probe({ op: 'torn-write', marker: 'a' }).catch((e) => ({ threw: String(e) }))
  const tornRows = await probe({ op: 'sql', query: `SELECT id FROM probe_torn` })
  const survived = Array.isArray(tornRows.rows) && tornRows.rows.length > 0
  console.log(
    `    · turn threw → ${JSON.stringify(torn).slice(0, 80)}\n` +
      `    · a statement committed before an UNCAUGHT throw in the same turn: ${
        survived ? 'SURVIVES' : 'rolled back'
      }`
  )
  ok(
    'a turn that throws does not leave the object wedged',
    (await probe({ op: 'census' })).ok === true
  )
  ok('so an uncaught throw does NOT roll the turn back', survived, 'it rolled back — sql.ts may be right after all')

  // Which is why the driver now has one. The same tear, through the shipping
  // `durableObjectSqlDriver` — the platform having a transaction and the memory
  // core using it are two claims, and only the second protects `clearDerived`.
  const tx = await probe({ op: 'torn-write-tx', marker: 'b' })
  ok('the runtime offers storage.transactionSync', tx.available === true, JSON.stringify(tx))
  const txRows = await probe({ op: 'sql', query: `SELECT id FROM probe_torn WHERE id LIKE '%in-tx'` })
  eq('and the DO driver rolls a failed transaction back', txRows.rows, [])

  // ── §18 · Migration safety ─────────────────────────────────────────────────
  //
  // Starting from the previous schema state, with one of everything §18 says a
  // migration may not lose already in the database.
  section('MIGRATION')
  const mig = 'migration'
  await probe({ op: 'open' }, mig)
  await probe({ op: 'seed', days: 20 }, mig)
  await probe({ op: 'reflect', kind: 'daily', now: '2026-05-01T21:00:00.000Z' }, mig)
  const written = await probe({ op: 'user-evidence', at: '2026-05-01T09:00:00.000Z' }, mig)
  ok('his stated fact was written', !!written.fact, JSON.stringify(written))

  const preMigration = await probe({ op: 'user-evidence-check' }, mig)

  const down = await probe({ op: 'downgrade' }, mig)
  eq('the database can be wound back to v1', down.schema, 1)
  const v1 = await probe({ op: 'schema' }, mig)
  eq('v1 has no shadow_runs', v1.missing, ['shadow_runs'])
  eq('and records itself as v1', v1.version, 1)

  const up = await probe({ op: 'open' }, mig)
  eq('opening a v1 database migrates it to current', up.schema, up.expected)
  const v2 = await probe({ op: 'schema' }, mig)
  eq('the v2 table is there afterwards', v2.missing, [])

  const postMigration = await probe({ op: 'user-evidence-check' }, mig)
  eq('the migration preserved every raw event', postMigration.events, preMigration.events)
  eq('and his stated fact', postMigration.stated, preMigration.stated)
  eq('and the recommendation he was shown', postMigration.recommendations, preMigration.recommendations)
  eq('and what he did with it', postMigration.outcomes, preMigration.outcomes)

  const upAgain = await probe({ op: 'open' }, mig)
  eq('migrating an already-current database is a no-op', upAgain.schema, upAgain.expected)
  const postIdempotent = await probe({ op: 'user-evidence-check' }, mig)
  eq('and changes nothing', postIdempotent, postMigration)

  // §18's other half: derived cognition MAY be destroyed, user evidence may not.
  await probe({ op: 'clear-derived' }, mig)
  const cleared = await probe({ op: 'user-evidence-check' }, mig)
  eq('a rebuild keeps every raw event', cleared.events, preMigration.events)
  eq('a rebuild keeps what he stated', cleared.stated, preMigration.stated)
  eq('a rebuild discards what was inferred beside it', cleared.inferred, [])
  eq('a rebuild keeps the recommendation outcome', cleared.outcomes, preMigration.outcomes)

  // ── §16 · Restart ──────────────────────────────────────────────────────────
  //
  // Two of them, weakest first. `abort()` evicts the isolate while the process
  // lives; killing wrangler takes the process with it, so the second is the only
  // one that proves the bytes reached the disk.
  section('RESTART')
  const beforeAbort = await probe({ op: 'census' })
  await probe({ op: 'abort' })
  await sleep(500)
  const afterAbort = await probe({ op: 'census' })
  eq('an evicted isolate loses no committed rows', afterAbort.counts, beforeAbort.counts)
  eq(
    'and the rebuilt object reopens at the current schema',
    (await probe({ op: 'open' })).schema,
    opened.expected
  )

  const beforeRestart = await probe({ op: 'census' })
  const migBeforeRestart = await probe({ op: 'user-evidence-check' }, mig)
  await stop()
  await start()
  const afterRestart = await probe({ op: 'census' })
  eq('a cold process finds the same database', afterRestart.counts, beforeRestart.counts)
  const migAfterRestart = await probe({ op: 'user-evidence-check' }, mig)
  eq('including his stated evidence', migAfterRestart, migBeforeRestart)
}

/**
 * A minimal well-formed source event.
 *
 * Hand-built rather than taken from the fixture because these exist to be
 * COUNTED — the concurrency and idempotency assertions need events whose dedupe
 * keys this file controls. Anything asserting about cognition uses `op: 'seed'`,
 * which is the real fixture.
 */
function syntheticEvent(key) {
  const at = new Date('2026-06-01T08:00:00.000Z').toISOString()
  return {
    id: `evt:${key}`,
    source: 'harness',
    sourceId: key,
    sourceAt: at,
    observedAt: at,
    type: 'note',
    dedupeKey: `harness:${key}`,
    ingestVersion: 1,
    payload: { text: `probe event ${key}` },
  }
}

// ── Teardown ─────────────────────────────────────────────────────────────────

let exitCode = 0
try {
  await main()
} catch (e) {
  failures++
  console.error(`\nHARNESS FAILED — ${e.stack ?? e.message}`)
}
await stop()
rmSync(PERSIST, { recursive: true, force: true })

if (failures) {
  console.error(`\n${failures} edge assertion${failures === 1 ? '' : 's'} failed`)
  exitCode = 1
} else {
  console.log(
    '\nThe memory core holds on workerd: Cloudflare SQLite, real alarms, real input gating,\n' +
      'migration from v1 with his evidence intact, and a cold process finding it all again.'
  )
}
process.exit(exitCode)
