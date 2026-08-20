#!/usr/bin/env node
/**
 * TWO EDGE REQUESTS, ONE DOCUMENT, AND NEITHER CORRECTION DISAPPEARS.
 *
 * This is the acceptance test the last handoff asked for, and it is written as a
 * demonstration rather than as a unit test because the thing being asserted is a
 * property of a race, not of a function. The shape is:
 *
 *   1. It PROVES THE WINDOW IS REAL by reproducing it. Two overlapping writes go
 *      through the KV store — the read-hash-compare-write the edge used to have —
 *      with the get and the put deliberately taking a tick each, which is what a
 *      real KV round-trip does. One correction is destroyed. If this half ever
 *      stops failing, the test below it has stopped proving anything.
 *
 *   2. It PROVES THE ROOM CLOSES IT. The identical two writes go through
 *      `roomWorldStore` against one `WorldRoom` — the same class the Durable
 *      Object wraps, over storage with the same artificial latency — and both
 *      corrections are present at the end.
 *
 * Both halves drive `mutateThrough` rather than `mutateWorld`, and that is the
 * point of that export existing: `mutateWorld`'s in-process queue would serialise
 * the two calls and the test would pass without testing anything. Two separate
 * store clients running their own retry loop over one document IS two isolates.
 *
 * Run: npm test
 */
import { mutateThrough } from '../server/world.ts'
import { kvWorldStore, roomWorldStore, memoryWorldStore } from '../server/store.ts'
import { WorldRoom } from '../server/worldRoom.ts'
import { readPerson, fact, setFact, getFact } from '../server/person.ts'

let failures = 0
const ok = (what, cond, detail = '') => {
  if (cond) return
  failures++
  console.error(`FAIL  ${what}${detail ? ` — ${detail}` : ''}`)
}
const check = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)

/** A turn of the event loop, which is what every storage call here costs. */
const tick = () => new Promise((r) => setTimeout(r, 0))

const START = {
  version: 6,
  profile: '',
  timeZone: 'Europe/Rome',
  observations: [],
  beliefs: [],
  tracks: [],
  sources: {},
  curation: 'auto',
  person: { identity: {}, preferences: {}, goals: [], people: [], routines: [], constraints: [], conflicts: [], asked: {}, demands: {}, updatedAt: '1970-01-01T00:00:00.000Z' },
}

/**
 * The two things he says, as the corrections they really are.
 *
 * Deliberately DIFFERENT KEYS. A last-writer-wins document loses one of these
 * completely — not a merged value, not a stale value, an absent one — which is
 * why the assertion is "both keys are present" rather than "the value is right".
 */
const say = (key, value) => (w) => {
  const person = readPerson(w)
  setFact(person, 'preferences', fact(key, value, {
    source: 'user', status: 'user_provided', confidence: 1, by: 'user',
    sourceAt: new Date().toISOString(),
  }))
  w.person = person
}

/**
 * A mutation that takes its time.
 *
 * The window is not hypothetical and it is not microseconds when a real caller
 * is involved: a feed build geocodes against volunteer services between reading
 * the document and writing it back. `delay` is that gap, and it is what makes
 * the two writes genuinely overlap rather than merely being started together.
 */
const slow = (key, value, delay) => async (w) => {
  await new Promise((r) => setTimeout(r, delay))
  say(key, value)(w)
}

const keysIn = (raw) => Object.keys(JSON.parse(raw).person.preferences).sort()

// ── 1. The window, reproduced ────────────────────────────────────────────────
{
  /**
   * KV as it actually behaves: a get and a put that each take a turn, and no
   * conditional write anywhere. Nothing here is exaggerated to make the point —
   * this is `kvWorldStore` over a namespace whose calls are asynchronous, which
   * is the only kind there is.
   */
  let raw = JSON.stringify(START)
  const kv = {
    async get() { await tick(); return raw },
    async put(_k, v) { await tick(); raw = v },
  }
  const store = () => kvWorldStore(kv)

  await Promise.all([
    mutateThrough(store(), slow('transport.default', 'transit', 6), { label: 'A' }),
    mutateThrough(store(), slow('format.dates', 'dmy', 4), { label: 'B' }),
  ])

  const kept = keysIn(raw)
  ok(
    'the KV window is real: one of two overlapping corrections is destroyed',
    kept.length < 2,
    `both survived (${kept.join(', ')}) — if KV has grown a conditional write, the room test below needs rewriting, not deleting`
  )
}

// ── 2. The window, closed ────────────────────────────────────────────────────
{
  /**
   * The same two writes, the same latency, through the room. Two store clients,
   * because two edge requests get two clients — they share nothing but the room,
   * exactly as two isolates share nothing but the Durable Object.
   */
  const disk = new Map()
  const room = new WorldRoom(
    {
      async get(k) { await tick(); return disk.get(k) },
      async put(k, v) { await tick(); disk.set(k, v) },
      async delete(k) { disk.delete(k) },
    },
    { seed: async () => JSON.stringify(START) }
  )
  const client = () => roomWorldStore((r) => room.handle(r))

  const [a, b] = await Promise.all([
    mutateThrough(client(), slow('transport.default', 'transit', 6), { label: 'A' }),
    mutateThrough(client(), slow('format.dates', 'dmy', 4), { label: 'B' }),
  ])

  /**
   * THE RACE MUST HAVE HAPPENED. A test that asserts both values survived, on a
   * run where the two writes never actually overlapped, is a test that passes for
   * the wrong reason and will keep passing after the guarantee is removed.
   */
  ok('the two writes really did collide', a.retries + b.retries > 0, `retries A=${a.retries} B=${b.retries}`)

  const { raw: finalRaw } = await room.handle({ op: 'read' })
  check('both corrections survived', keysIn(finalRaw), ['format.dates', 'transport.default'])

  const person = readPerson(JSON.parse(finalRaw))
  check('and each holds what he said', [
    getFact(person, 'transport.default')?.value,
    getFact(person, 'format.dates')?.value,
  ], ['transit', 'dmy'])
  check('by him, not by an agent', [
    getFact(person, 'transport.default')?.by,
    getFact(person, 'format.dates')?.by,
  ], ['user', 'user'])
}

// ── 3. Ten at once ───────────────────────────────────────────────────────────
{
  const disk = new Map()
  const room = new WorldRoom(
    { async get(k) { await tick(); return disk.get(k) }, async put(k, v) { await tick(); disk.set(k, v) } },
    { seed: async () => JSON.stringify(START) }
  )
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      mutateThrough(roomWorldStore((r) => room.handle(r)), slow(`pref.${i}`, i, (i % 3) + 1), { label: `#${i}` })
    )
  )
  const { raw } = await room.handle({ op: 'read' })
  check('ten simultaneous corrections all landed', keysIn(raw).length, 10)
  ok('and the collisions were retried rather than lost', results.some((r) => r.retries > 0))
}

// ── 4. The document survives being larger than one storage value ─────────────
{
  /**
   * A world model that fails to save because it grew is the same silent loss
   * everything above is about. The room chunks at 100 KiB; this writes ~250 KiB
   * of observations and reads them back byte for byte.
   */
  const disk = new Map()
  const room = new WorldRoom({ async get(k) { return disk.get(k) }, async put(k, v) { disk.set(k, v) } })
  const big = {
    ...START,
    observations: Array.from({ length: 900 }, (_, i) => ({
      id: `o${i}`, source: 'calendar', at: '2026-08-11T00:00:00.000Z', text: 'x'.repeat(280),
    })),
  }
  const raw = JSON.stringify(big)
  ok('the fixture is actually bigger than one chunk', raw.length > 100 * 1024, `${raw.length} bytes`)
  const first = await room.handle({ op: 'read' })
  const wrote = await room.handle({ op: 'write', raw, token: first.token })
  check('a multi-chunk document is accepted', wrote.wrote, true)
  ok('and stored in pieces', [...disk.keys()].filter((k) => k.startsWith('world:') && k !== 'world:meta').length > 1)

  // A COLD reader, sharing only the storage — which is what a Durable Object
  // looks like after it has been evicted and brought back.
  const cold = new WorldRoom({ async get(k) { return disk.get(k) }, async put(k, v) { disk.set(k, v) } })
  const back = await cold.handle({ op: 'read' })
  check('and reassembled exactly', back.raw === raw, true)
  check('with a token a writer can still use', back.token, wrote.token)
}

// ── 5. A refused write says so rather than pretending ────────────────────────
{
  const store = memoryWorldStore(START)
  const disk = new Map()
  const room = new WorldRoom({ async get(k) { return disk.get(k) }, async put(k, v) { disk.set(k, v) } }, { seed: async () => JSON.stringify(START) })
  const client = roomWorldStore((r) => room.handle(r))
  const { token } = await client.readVersioned()
  // Someone else writes first.
  await client.writeIfUnchanged({ ...START, profile: 'theirs' }, token)
  // Our stale token must be refused, not silently accepted.
  check('a stale token is refused', await client.writeIfUnchanged({ ...START, profile: 'ours' }, token), false)
  const { world } = await client.readVersioned()
  check('and the earlier write is intact', world.profile, 'theirs')
  ok('the memory store still implements the same contract', typeof store.writeIfUnchanged === 'function')
}

if (failures) {
  console.error(`\n${failures} world-persistence failure(s).`)
  process.exit(1)
}
console.log(
  'world ok — the KV write window was reproduced and destroys a correction; the same two overlapping ' +
  'edge writes through the room both survive, with the collision asserted rather than assumed; ' +
  'ten at once all land; a document larger than one storage value round-trips through a cold room; ' +
  'and a stale token is refused rather than forced'
)
