/**
 * THE ONE PLACE THE WORLD DOCUMENT IS WRITTEN.
 *
 * `mutateWorld` already serialises within a process and already refuses a write
 * whose document moved underneath it. On the Mac that is the whole story: one
 * process, one file, no race left. On the edge it was not, and the previous pass
 * said so honestly rather than pretending otherwise — Cloudflare KV has no
 * conditional write, so the compare-and-set there was read-hash-compare-write:
 *
 *     const raw = await kv.get(key)          // ← another isolate can land
 *     if (tokenFor(raw) !== token) return false   //   anywhere in here
 *     await kv.put(key, JSON.stringify(w))   // ← and be flattened by this
 *
 * That window is microseconds wide, which was tolerable while the document held
 * only re-syncable observations. It is not tolerable now. The document holds his
 * CORRECTIONS and his long-lived preferences — things he said once, that nothing
 * will ever re-derive, and whose loss is silent. "Rare" is the wrong bar for
 * that; the right bar is "cannot happen".
 *
 * So the document moves behind a room: a single authoritative holder, with the
 * compare and the assignment in ONE synchronous turn.
 *
 *     const current = this.#token                 //
 *     if (current !== token) return { wrote: false }   //  no await anywhere
 *     this.#raw = raw; this.#token = next          //  between these lines
 *
 * JavaScript is single-threaded, so two calls cannot both observe the same token
 * and both assign: whichever runs second sees the token the first one installed
 * and is refused, and `mutateWorld` re-runs its mutation against the document
 * that actually exists. On Cloudflare this class lives inside a Durable Object,
 * of which there is exactly ONE instance for a given name across the whole
 * network — so "one synchronous turn" is a global guarantee rather than a
 * per-isolate one, and the residual window is closed rather than narrowed.
 *
 * DELIBERATELY HOST-INDEPENDENT, and that is what makes the guarantee testable.
 * The room takes a two-method storage interface and knows nothing about Durable
 * Objects; `scripts/world.mjs` drives it with overlapping writes through the same
 * `WorldStore` clients the edge uses, so the proof exercises this code and not a
 * simplified restatement of it.
 */

import { tokenFor } from './store.js'

/** The smallest storage a room needs. A DO's `state.storage` satisfies it. */
export interface RoomStorage {
  get(key: string): Promise<string | undefined | null>
  put(key: string, value: string): Promise<void>
  delete?(key: string): Promise<unknown>
}

export type RoomRequest =
  | { op: 'read' }
  | { op: 'write'; raw: string; token: string | null }

export type RoomReply =
  | { op: 'read'; raw: string | null; token: string | null }
  | { op: 'write'; wrote: boolean; token: string | null }
  | { op: 'error'; message: string }

/**
 * How the document is split across storage values.
 *
 * Durable Object storage caps a single value — 128 KiB on the classic backend,
 * 2 MiB on the SQLite one — and a world model that has been collecting his
 * calendar and mail for a year will pass the first of those and can pass the
 * second. A document that fails to save because it grew is the same class of
 * silent loss this whole file exists to prevent, so the raw JSON is written in
 * fixed-size pieces and the piece count is written last.
 *
 * 100 KiB rather than the limit itself: the limit is on the encoded value, and
 * leaving headroom is cheaper than discovering the encoding overhead in
 * production.
 */
const CHUNK = 100 * 1024
const META = 'world:meta'
const chunkKey = (i: number) => `world:${i}`

interface Meta {
  chunks: number
  /** The token as it was written. Recomputed on load, and compared, never trusted. */
  token: string | null
  at: string
}

export interface RoomOptions {
  /**
   * Where the document came from before this room existed.
   *
   * Called ONCE, only when the room's own storage is empty. This is the KV
   * migration: the first request after deploy finds nothing in the room, adopts
   * the document KV is holding, and writes it in. Every request after that
   * reads the room and never touches KV again.
   */
  seed?: () => Promise<string | null>
  /**
   * Copy every landed write somewhere else, best-effort.
   *
   * The room is the authority; this is a MIRROR, and its failure is not an
   * error. It exists so `wrangler kv key get world` still shows his real life —
   * which is how the world model has been inspected and repaired all along, and
   * losing that to gain atomicity would be a bad trade.
   */
  mirror?: (raw: string) => Promise<void>
}

export class WorldRoom {
  #storage: RoomStorage
  #opts: RoomOptions
  /** The document, once loaded. `undefined` means "not loaded yet". */
  #raw: string | null | undefined
  #token: string | null = null
  #loading: Promise<void> | null = null
  /** Puts are chained so storage sees them in the order they were accepted. */
  #writes: Promise<unknown> = Promise.resolve()

  constructor(storage: RoomStorage, opts: RoomOptions = {}) {
    this.#storage = storage
    this.#opts = opts
  }

  async handle(req: RoomRequest): Promise<RoomReply> {
    try {
      await this.#load()
      if (req.op === 'read') return { op: 'read', raw: this.#raw ?? null, token: this.#token }
      return await this.#write(req.raw, req.token)
    } catch (e) {
      return { op: 'error', message: (e as Error).message }
    }
  }

  /**
   * THE CRITICAL SECTION.
   *
   * Everything between the token comparison and the assignment is synchronous.
   * There is no `await` in it, and there must never be one: an await here is
   * exactly the KV window this class was written to close, reintroduced in the
   * one place nobody would look for it.
   */
  async #write(raw: string, token: string | null): Promise<RoomReply> {
    if (this.#token !== token) return { op: 'write', wrote: false, token: this.#token }
    const next = tokenFor(raw)
    const previous = { raw: this.#raw, token: this.#token }
    this.#raw = raw
    this.#token = next
    // ── end of the critical section ──

    const landed = this.#writes.then(
      () => this.#persist(raw, next),
      () => this.#persist(raw, next)
    )
    this.#writes = landed.then(
      () => undefined,
      () => undefined
    )

    try {
      await landed
    } catch (e) {
      /**
       * A write that did not reach storage must not be readable as though it
       * had. Rolling back only when we are still the newest value is the honest
       * version: if someone else has written since, their document is the
       * current one and reverting to ours would destroy it — the exact failure
       * this file is about.
       */
      if (this.#token === next) {
        this.#raw = previous.raw
        this.#token = previous.token
      }
      throw e
    }

    if (this.#opts.mirror) {
      try {
        await this.#opts.mirror(raw)
      } catch {
        /* the mirror is a convenience; the room is the truth */
      }
    }
    return { op: 'write', wrote: true, token: next }
  }

  async #persist(raw: string, token: string | null): Promise<void> {
    const chunks: string[] = []
    for (let i = 0; i < raw.length; i += CHUNK) chunks.push(raw.slice(i, i + CHUNK))
    // At least one piece, so an empty document is still a document rather than
    // an absent one — "written and empty" and "never written" are different.
    if (!chunks.length) chunks.push('')
    for (let i = 0; i < chunks.length; i++) await this.#storage.put(chunkKey(i), chunks[i]!)
    /**
     * META LAST, ALWAYS. It is the commit: a reader that finds meta finds a
     * complete document, because every piece meta counts was already written.
     * A crash halfway through leaves the previous meta and the previous
     * document, which is the outcome to want.
     */
    const meta: Meta = { chunks: chunks.length, token, at: new Date().toISOString() }
    await this.#storage.put(META, JSON.stringify(meta))
  }

  #load(): Promise<void> {
    if (this.#raw !== undefined) return Promise.resolve()
    if (this.#loading) return this.#loading
    this.#loading = (async () => {
      const metaRaw = await this.#storage.get(META)
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as Meta
        let raw = ''
        for (let i = 0; i < meta.chunks; i++) raw += (await this.#storage.get(chunkKey(i))) ?? ''
        this.#raw = raw
        // Recomputed rather than read off meta: the token has to describe the
        // bytes actually assembled, or a torn read would hand out a token that
        // matches nothing.
        this.#token = tokenFor(raw)
        return
      }

      const seeded = this.#opts.seed ? await this.#opts.seed() : null
      this.#raw = seeded
      this.#token = tokenFor(seeded)
      if (seeded !== null) await this.#persist(seeded, this.#token)
    })()
    try {
      return this.#loading
    } finally {
      // A failed load must be retryable rather than cached as a permanent
      // failure, so the memo is cleared when it settles unhappily.
      void this.#loading.catch(() => {
        this.#loading = null
        this.#raw = undefined
      })
    }
  }
}
