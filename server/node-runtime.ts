import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setKeyStore } from './secrets.js'
import { setWorldStore, tokenFor } from './store.js'
import { setRouterStore, type RouterState } from './router.js'
import { setRegistryStore, type Registry } from './models.js'
import { setObjectStore, migrate, type StoredObject } from './objects.js'
import { setRevisionStore, type RevisionDb } from './revisions.js'
import { setActionStore, type ActionRecord } from './actions.js'
import { setShelfStore, type Shelf } from './shelf.js'
import { setHomeStore, type HomeState } from './home.js'
import { setSnapshotStore, type Feed } from './feed.js'
import * as keychain from './keychain.js'
import { betterSqliteMemoryStore } from './memory/store.js'
import { installMemory, reflect, cadenceFor } from './memory/host.js'
import { READ_ONLY_LIVE } from './memory/authority.js'
import { partsIn } from './clock.js'
import type { World } from './world.js'

/**
 * The Mac's drivers: keys in the macOS keychain, world model in ~/.crucible.
 *
 * Everything Node-only lives behind this one call, which is why the same
 * brain also runs on Cloudflare — the Worker installs its own pair and never
 * imports this file, so `node:fs` never reaches the edge bundle.
 */
const DIR = join(homedir(), '.crucible')
const PATH = join(DIR, 'world.json')
const ROUTER_PATH = join(DIR, 'router.json')
const MODELS_PATH = join(DIR, 'models.json')
const OBJECTS_PATH = join(DIR, 'objects.json')
const PANES_PATH = join(DIR, 'panes.json')
const ACTIONS_PATH = join(DIR, 'actions.json')
const SHELF_PATH = join(DIR, 'shelf.json')
const HOME_PATH = join(DIR, 'home.json')
const FEED_PATH = join(DIR, 'feed.json')
const MEMORY_PATH = join(DIR, 'memory.db')

/**
 * How often the Mac thinks without being asked.
 *
 * A quarter of an hour, matching the edge's light cron, so the two hosts run the
 * same cadence and a difference between them is a difference in cognition rather
 * than in how often it happened. `cadenceFor` decides what each tick actually
 * does; most of them do almost nothing.
 */
const REFLECT_MS = 15 * 60 * 1000

/**
 * THE MAC'S EQUIVALENT OF A DURABLE OBJECT ALARM.
 *
 * `unref()` is the whole subtlety and it is worth the line: without it this timer
 * holds the event loop open and the process never exits — a background
 * consolidation would have turned every `tsx scripts/…` run and every clean
 * shutdown into a hang. A reflection pass is worth doing while the app is alive
 * and is worth nothing at the cost of the app being unable to stop.
 */
function installNodeMemory(): void {
  /**
   * Required through `createRequire` rather than imported at the top.
   *
   * Two reasons, and the second is the one that matters. A native module is
   * resolved at CALL time this way, so a build whose `better-sqlite3` has not
   * been rebuilt for this Node or Electron version fails here — inside the
   * guard — rather than at import, where it would take the whole server down
   * before anything could catch it. And a static import would pull a `.node`
   * binary into the Worker bundle, which does not have one.
   */
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as new (path: string) => never
  const store = betterSqliteMemoryStore(new Database(MEMORY_PATH) as never)

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  /**
   * `me` matters as much as the zone, and was missing here for the same reason
   * it was missing on the edge: `NormalizeOptions.me` is optional, so nothing
   * complained. Without it `ensureSelf` builds a self entity with no identity,
   * every `from === me` test compares against `undefined`, and he is resolved as
   * a person in his own contact graph. `ALLOWED_EMAIL` is the edge's source;
   * here it is the same address out of the environment, and its absence is a
   * degraded resolver rather than a broken one.
   */
  /**
   * THE SAME POSTURE THE EDGE RUNS. Both hosts, one capability map.
   *
   * It defaulted to `SHADOW_ONLY`, which meant the Mac's memory core was as
   * silent as the edge's — for a different reason, but with the same result on
   * screen. Naming the posture here is what keeps the two hosts from disagreeing
   * about what the app is allowed to say, which is a difference that would show
   * up as "it works on the laptop" and nowhere else.
   */
  installMemory(store, { timeZone: zone, me: process.env.ALLOWED_EMAIL }, READ_ONLY_LIVE)

  const timer = setInterval(() => {
    const now = new Date()
    reflect(cadenceFor(partsIn(now, zone)), now)
  }, REFLECT_MS)
  timer.unref?.()
}

export function installNodeRuntime(): void {
  setKeyStore({
    get: keychain.getKey,
    set: keychain.setKey,
    del: keychain.deleteKey,
  })

  const readWorldFile = async (): Promise<string | null> => {
    try {
      return await readFile(PATH, 'utf8')
    } catch {
      return null
    }
  }
  const writeWorldFile = async (w: World): Promise<void> => {
    await mkdir(DIR, { recursive: true })
    // Pretty-printed because this file is meant to be readable by hand —
    // it is the whole of what the assistant knows about him.
    await writeFile(PATH, JSON.stringify(w, null, 2) + '\n')
  }

  setWorldStore({
    async read() {
      const raw = await readWorldFile()
      try {
        return raw ? (JSON.parse(raw) as World) : null
      } catch {
        return null
      }
    },
    /**
     * The token is a hash of the FILE'S BYTES, which is what makes this work for
     * the case it is really here for on the Mac: he edits `world.json` by hand
     * while the server is running. A build holding a document from before the
     * edit is refused and re-runs against what he wrote, instead of overwriting
     * it a few seconds later with no indication that it ever existed.
     */
    async readVersioned() {
      const raw = await readWorldFile()
      let world: World | null = null
      try {
        world = raw ? (JSON.parse(raw) as World) : null
      } catch {
        // Unparseable is not the same as absent, and the token still describes
        // it — so a mutation over a corrupt file is refused rather than silently
        // replacing it with a fresh empty world.
      }
      return { world, token: tokenFor(raw) }
    },
    write: writeWorldFile,
    async writeIfUnchanged(w, token) {
      if (tokenFor(await readWorldFile()) !== token) return false
      await writeWorldFile(w)
      return true
    },
  })

  // Which models are rested, and what today has cost. Beside the world model
  // because it is the same kind of thing: state the brain keeps about itself.
  setRouterStore({
    async read(): Promise<RouterState | null> {
      try {
        return JSON.parse(await readFile(ROUTER_PATH, 'utf8')) as RouterState
      } catch {
        return null
      }
    },
    async write(s) {
      await mkdir(DIR, { recursive: true })
      await writeFile(ROUTER_PATH, JSON.stringify(s, null, 2) + '\n')
    },
  })

  /**
   * The things connectors fetched, as opposed to what they mean.
   *
   * Not pretty-printed and not meant to be read by hand — it is a cache of a
   * few thousand records, and the file that IS meant to be read is world.json
   * next to it. Losing this one costs thumbnails until the next sync, nothing
   * more, which is why it lives outside the world model rather than in it.
   */
  setObjectStore({
    async read(): Promise<StoredObject[] | null> {
      try {
        // Through `migrate`, so a file written when objects were flat records
        // still resolves — each old record becomes the single reading it always
        // was, and the next fetch of the same thing sits beside it instead of
        // overwriting it.
        return migrate(JSON.parse(await readFile(OBJECTS_PATH, 'utf8')))
      } catch {
        return null
      }
    },
    async write(objects) {
      await mkdir(DIR, { recursive: true })
      await writeFile(OBJECTS_PATH, JSON.stringify(objects) + '\n')
    },
  })

  /**
   * Panes, and every state they have been in.
   *
   * Its own file rather than a section of world.json, for one reason that is
   * not tidiness: the world model is read-modify-written whole on every
   * observation, and a revision written into that document would be lost by any
   * sync that started before it and finished after. Panes are the one thing in
   * the app he cannot reconstruct by pulling again.
   */
  setRevisionStore({
    async read(): Promise<RevisionDb | null> {
      try {
        return JSON.parse(await readFile(PANES_PATH, 'utf8')) as RevisionDb
      } catch {
        return null
      }
    },
    async write(db) {
      await mkdir(DIR, { recursive: true })
      await writeFile(PANES_PATH, JSON.stringify(db, null, 2) + '\n')
    },
  })

  // What it did, on whose authority, and whether it can be taken back.
  // Readable by hand on purpose: this is the file that answers "why did it
  // send that", and it is worth nothing if reading it needs the app.
  setActionStore({
    async read(): Promise<ActionRecord[] | null> {
      try {
        return JSON.parse(await readFile(ACTIONS_PATH, 'utf8')) as ActionRecord[]
      } catch {
        return null
      }
    },
    async write(records) {
      await mkdir(DIR, { recursive: true })
      await writeFile(ACTIONS_PATH, JSON.stringify(records, null, 2) + '\n')
    },
  })

  /**
   * How he arranged his home screen. Small, and readable by hand on purpose:
   * if the app ever refuses to draw, this is the file to look at, and deleting
   * it is a supported way to get the default layout back.
   */
  setShelfStore({
    async read(): Promise<Shelf | null> {
      try {
        return JSON.parse(await readFile(SHELF_PATH, 'utf8')) as Shelf
      } catch {
        return null
      }
    },
    async write(s) {
      await mkdir(DIR, { recursive: true })
      await writeFile(SHELF_PATH, JSON.stringify(s, null, 2) + '\n')
    },
  })

  /**
   * The four-lane Home's durable half: order, hidden apps, what he saved,
   * archived or dismissed. Separate from the shelf because the shelf answers
   * "what may appear at all" and this answers "where it sits and what he did
   * with it" — and separate from anything device-local, which never comes here.
   */
  setHomeStore({
    async read(): Promise<HomeState | null> {
      try {
        return JSON.parse(await readFile(HOME_PATH, 'utf8')) as HomeState
      } catch {
        return null
      }
    },
    async write(s) {
      await mkdir(DIR, { recursive: true })
      await writeFile(HOME_PATH, JSON.stringify(s, null, 2) + '\n')
    },
  })

  /**
   * The last assembled feed. A cache, and treated like one everywhere.
   *
   * It exists so that opening the app paints immediately instead of waiting on
   * a synthesis call, and so the cron can leave something current behind for a
   * morning nobody has asked for anything yet. Deleting it costs one slow
   * first paint.
   */
  setSnapshotStore({
    async read(): Promise<Feed | null> {
      try {
        return JSON.parse(await readFile(FEED_PATH, 'utf8')) as Feed
      } catch {
        return null
      }
    },
    async write(f) {
      await mkdir(DIR, { recursive: true })
      await writeFile(FEED_PATH, JSON.stringify(f) + '\n')
    },
  })

  /**
   * THE MEMORY CORE'S MAC STORE — a SQLite file beside the world model.
   *
   * `better-sqlite3` rather than another JSON file, and the reason is the one
   * thing the world document cannot do: the ledger must never be read whole. A
   * year of evidence queried by time and by type is an index seek; the same year
   * in a JSON array is a parse of the entire history on every question.
   *
   * NOT pretty-printed, not readable by hand, and unlike `world.json` it is not
   * meant to be — the file that answers "what does it think about him" is
   * `world.json`, and this is the evidence underneath it. Deleting it costs the
   * derived cognition and, until the ledger is the authority, nothing he would
   * notice; `rebuild()` is the supported way to get it back from what remains.
   *
   * FAILING TO OPEN IT IS NOT FATAL. The require is dynamic and the whole thing
   * is guarded, because `better-sqlite3` is a native module that has to be
   * rebuilt for Electron and will one day not be — and an app that refuses to
   * start because its optional second substrate would not load is a worse app
   * than one that runs without it and says so.
   */
  try {
    installNodeMemory()
  } catch (e) {
    console.warn(`memory core unavailable — running on the world document alone: ${(e as Error).message}`)
  }

  // Which models have actually answered, and which are quarantined and why.
  // Readable by hand like the other two: when the app says it cannot think,
  // this file is where the reason is written down.
  setRegistryStore({
    async read(): Promise<Registry | null> {
      try {
        return JSON.parse(await readFile(MODELS_PATH, 'utf8')) as Registry
      } catch {
        return null
      }
    },
    async write(r) {
      await mkdir(DIR, { recursive: true })
      await writeFile(MODELS_PATH, JSON.stringify(r, null, 2) + '\n')
    },
  })
}
