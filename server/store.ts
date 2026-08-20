/**
 * TYPE-ONLY, deliberately. `world.ts` imports `worldStore` from here at runtime,
 * so a runtime import back would be a cycle — and the one thing this file must
 * not do is depend on the brain, since the whole point is that the host decides
 * storage and the brain never learns which store it got.
 */
import type { World } from './world.js'

/**
 * Where the world model is kept — decided by the host, not by the brain.
 *
 * A JSON file under ~/.crucible on the Mac; a KV value on Cloudflare. The
 * synthesis, curiosity and track code never learns which, so the same brain
 * runs in both places and the app does not need a Mac to be awake.
 */
export interface WorldStore {
  read(): Promise<World | null>
  write(w: World): Promise<void>
  /**
   * Read, and say what the document was when it was read.
   *
   * OPTIONAL, so a store written before this existed still works — `mutateWorld`
   * falls back to a plain read with a null token and relies on its in-process
   * queue alone. A store that implements this pair gets lost-write DETECTION on
   * top, which is the whole point: a stale write is refused and the mutation is
   * re-run against the document that actually exists.
   *
   * The token is opaque and belongs to the store. Both implementations here use
   * a hash of the serialised document rather than a counter, because a hash needs
   * no extra key, survives a hand-edit of the file, and answers the only question
   * being asked — "is this still the document I read?"
   */
  readVersioned?(): Promise<{ world: World | null; token: string | null }>
  /**
   * Write only if the document is still the one `token` described.
   *
   * Returns false on a conflict rather than throwing, because a conflict is an
   * ordinary and expected outcome that the caller retries — not an error.
   */
  writeIfUnchanged?(w: World, token: string | null): Promise<boolean>
}

let store: WorldStore | null = null

export function setWorldStore(s: WorldStore): void {
  store = s
}

export function worldStore(): WorldStore {
  if (!store) throw new Error('No world store installed')
  return store
}

/**
 * A cheap content hash, used as the compare-and-set token.
 *
 * FNV-1a over the serialised document. Not cryptographic and does not need to
 * be: the question is "did this change", the two candidate strings are both
 * produced by this app, and there is no adversary trying to forge a collision.
 * It is chosen over a length-and-timestamp check because a correction can leave
 * the document exactly the same length — flipping one boolean does — and over
 * `crypto.subtle` because that is async and this is called on every read.
 */
export function tokenFor(raw: string | null): string | null {
  if (raw === null) return null
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${raw.length}:${(h >>> 0).toString(36)}`
}

/**
 * The world model in a single KV key. One user, one document, one read.
 *
 * NO LONGER THE EDGE'S WRITE PATH, and kept for two jobs it is still right for.
 *
 * The CAS here is READ-COMPARE-WRITE, which catches any write that COMPLETED
 * before ours and cannot catch one that lands between the compare and the put,
 * because KV offers no conditional write. `roomWorldStore` closes that window;
 * this remains as the SEED the room adopts on its first request, and as the
 * MIRROR every landed write is copied to so the document is still readable with
 * `wrangler kv key get world`.
 *
 * It is also the fallback if the Durable Object binding is absent — an app that
 * degrades to the old guarantee is better than one that refuses to start, and
 * the worker says which it is using rather than leaving it to be guessed.
 */
export function kvWorldStore(kv: KVNamespace, key = 'world'): WorldStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as World) : null
    },
    async readVersioned() {
      const raw = await kv.get(key)
      return { world: raw ? (JSON.parse(raw) as World) : null, token: tokenFor(raw) }
    },
    async write(w) {
      await kv.put(key, JSON.stringify(w))
    },
    async writeIfUnchanged(w, token) {
      const raw = await kv.get(key)
      if (tokenFor(raw) !== token) return false
      await kv.put(key, JSON.stringify(w))
      return true
    },
  }
}

/**
 * The world model held by a single authoritative room. See `worldRoom.ts`.
 *
 * The store is a CLIENT. It owns no document and caches nothing, which is what
 * lets several edge requests — several isolates, potentially several colos —
 * share one compare-and-set. `call` is the transport: a Durable Object stub's
 * `fetch` in production, a direct method call in the tests, so the concurrency
 * proof runs against the real room rather than a stand-in for it.
 *
 * `writeIfUnchanged` returning false here means the room REFUSED the write
 * because the document moved, which is the same contract KV's version had and
 * the same one `mutateWorld` retries against. The difference is that this answer
 * is authoritative: there is no window after the check in which someone else can
 * still land.
 */
export function roomWorldStore(
  call: (r: import('./worldRoom.js').RoomRequest) => Promise<import('./worldRoom.js').RoomReply>
): WorldStore {
  const read = async (): Promise<{ raw: string | null; token: string | null }> => {
    const reply = await call({ op: 'read' })
    if (reply.op === 'error') throw new Error(reply.message)
    if (reply.op !== 'read') throw new Error('the world room answered a read with something else')
    return { raw: reply.raw, token: reply.token }
  }

  return {
    async read() {
      const { raw } = await read()
      return raw ? (JSON.parse(raw) as World) : null
    },
    async readVersioned() {
      const { raw, token } = await read()
      return { world: raw ? (JSON.parse(raw) as World) : null, token }
    },
    /**
     * An UNCONDITIONAL write, and the only caller left is `writeWorld` — the
     * legacy path used by imports and by the tests' fixture setup. It is
     * expressed as read-then-write-with-that-token rather than as a "force"
     * flag on the room, because a room that can be told to ignore its own
     * compare-and-set is a room whose guarantee is optional.
     */
    async write(w) {
      const { token } = await read()
      const reply = await call({ op: 'write', raw: JSON.stringify(w), token })
      if (reply.op === 'error') throw new Error(reply.message)
      if (reply.op === 'write' && !reply.wrote) throw new Error('the world moved while it was being replaced')
    },
    async writeIfUnchanged(w, token) {
      const reply = await call({ op: 'write', raw: JSON.stringify(w), token })
      if (reply.op === 'error') throw new Error(reply.message)
      return reply.op === 'write' && reply.wrote
    },
  }
}

/**
 * A world store held entirely in memory.
 *
 * Exists for the tests, and it is not a stub: it implements the full
 * compare-and-set contract, so the end-to-end proof that a correction survives a
 * concurrent build is testing the REAL retry path in `mutateWorld` rather than a
 * simplified one. `writes` counts puts that actually landed and `conflicts`
 * counts the ones refused, which is what makes "the race happened and was
 * handled" assertable instead of assumed.
 */
export function memoryWorldStore(initial?: World | null): WorldStore & {
  writes: number
  conflicts: number
  raw(): string | null
} {
  let raw: string | null = initial ? JSON.stringify(initial) : null
  const self = {
    writes: 0,
    conflicts: 0,
    raw: () => raw,
    async read() {
      return raw ? (JSON.parse(raw) as World) : null
    },
    async readVersioned() {
      return { world: raw ? (JSON.parse(raw) as World) : null, token: tokenFor(raw) }
    },
    async write(w: World) {
      raw = JSON.stringify(w)
      self.writes++
    },
    async writeIfUnchanged(w: World, token: string | null) {
      if (tokenFor(raw) !== token) {
        self.conflicts++
        return false
      }
      raw = JSON.stringify(w)
      self.writes++
      return true
    },
  }
  return self
}
