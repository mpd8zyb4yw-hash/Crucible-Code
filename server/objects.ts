import type { Provenance } from './provenance.js'
import { effectiveOrigin } from './provenance.js'

/**
 * Things, as opposed to sentences about things.
 *
 * The world model holds OBSERVATIONS: one-line prose the synthesis reads, a
 * handful at a time, each meaning something about his life. That is the right
 * shape for a brain and the wrong shape for everything else. A curated pane of
 * five videos is not five facts about him — it is five objects, each with an
 * id the model can name, fields a renderer can lay out, and a provenance that
 * says whether the title on screen came from YouTube or from a guess.
 *
 * So retrieved objects live here, beside the world model and not inside it.
 * Two consequences the rest of the design leans on:
 *
 *   - A widget can CITE an object instead of restating it. That is what makes
 *     a forged thumbnail impossible: the model names `youtube:video:dQw4...`
 *     and the server fills in the image from the record it fetched itself. A
 *     model that invents an id gets no image, not the wrong one.
 *
 *   - Panes become revisable. "No, three from 60 Minutes instead" is a new
 *     query against this store producing a new revision of a pane that still
 *     knows what it used to hold. None of that is expressible over prose.
 *
 * Nothing here is YouTube-shaped. A connector added later stores its objects
 * with its own `source` and `kind` and inherits citation, provenance, staleness
 * and cross-source lookup without adding a line to this file.
 */

export interface RetrievedObject {
  /** `source:kind:nativeId` — stable, and the only name anything else uses. */
  id: string
  source: string
  /** 'video' | 'channel' | 'email' | 'event' | 'place' | … connector's choice. */
  kind: string
  /** The id the source itself uses, unprefixed. */
  nativeId: string
  /** Headline. Always the source's own, never a paraphrase. */
  title: string
  sub?: string
  body?: string
  /** Absolute URL, already checked against the image host allowlist. */
  image?: string
  /** When the THING happened, as distinct from when we fetched it. */
  at?: string
  /** Anything else the source returned that a renderer might want. */
  fields?: Record<string, string | number | boolean | null>
  prov: Provenance
}

export interface ObjectStore {
  read(): Promise<RetrievedObject[] | null>
  write(objects: RetrievedObject[]): Promise<void>
}

let store: ObjectStore | null = null

export function setObjectStore(s: ObjectStore): void {
  store = s
}

/** Objects are a cache, not a source of truth: no store means no citations. */
function maybeStore(): ObjectStore | null {
  return store
}

/** The same cache in a single KV key, so citations resolve at the edge too. */
export function kvObjectStore(kv: KVNamespace, key = 'objects'): ObjectStore {
  return {
    async read() {
      const raw = await kv.get(key)
      return raw ? (JSON.parse(raw) as RetrievedObject[]) : null
    },
    async write(objects) {
      await kv.put(key, JSON.stringify(objects))
    },
  }
}

export function objectId(source: string, kind: string, nativeId: string): string {
  return `${source}:${kind}:${nativeId}`
}

/**
 * How many to keep.
 *
 * High enough that a pane he pinned in March still resolves its thumbnails in
 * June, low enough that this stays a file you can open. Eviction is by fetch
 * time, so the things he is actually looking at survive.
 */
const MAX_OBJECTS = 4000

export async function allObjects(): Promise<RetrievedObject[]> {
  const s = maybeStore()
  if (!s) return []
  return (await s.read()) ?? []
}

/**
 * Record what a connector just fetched.
 *
 * Upsert by id, newest fetch winning, because re-running a search must refresh
 * a video's view count rather than duplicate the video.
 */
export async function remember(objects: RetrievedObject[]): Promise<void> {
  const s = maybeStore()
  if (!s || !objects.length) return
  const existing = (await s.read()) ?? []
  const byId = new Map(existing.map((o) => [o.id, o]))
  for (const o of objects) byId.set(o.id, o)

  const merged = [...byId.values()].sort(
    (a, b) => Date.parse(b.prov.retrievedAt) - Date.parse(a.prov.retrievedAt)
  )
  await s.write(merged.slice(0, MAX_OBJECTS))
}

export async function lookup(id: string): Promise<RetrievedObject | undefined> {
  return (await allObjects()).find((o) => o.id === id)
}

/** Resolve many at once — one store read for a whole pane. */
export async function lookupMany(ids: string[]): Promise<Map<string, RetrievedObject>> {
  const want = new Set(ids)
  const out = new Map<string, RetrievedObject>()
  if (!want.size) return out
  for (const o of await allObjects()) if (want.has(o.id)) out.set(o.id, o)
  return out
}

/**
 * The query surface, such as it is.
 *
 * Deliberately dumb — a linear scan over a capped array. It exists so that
 * cross-source reasoning has SOMETHING to call ("every object about Moonshot,
 * whichever connector saw it") without committing to an index before we know
 * what the pane-revision protocol actually asks for.
 */
export interface ObjectQuery {
  source?: string
  kind?: string
  /** Case-insensitive substring over title, sub and body. */
  text?: string
  /** Exclude anything that has decayed past `retrieved`. */
  freshOnly?: boolean
  limit?: number
}

export async function query(q: ObjectQuery = {}): Promise<RetrievedObject[]> {
  const now = Date.now()
  const needle = q.text?.toLowerCase()
  const hits = (await allObjects()).filter((o) => {
    if (q.source && o.source !== q.source) return false
    if (q.kind && o.kind !== q.kind) return false
    if (q.freshOnly && effectiveOrigin(o.prov, now) !== 'retrieved') return false
    if (needle) {
      const hay = `${o.title} ${o.sub ?? ''} ${o.body ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
  return hits.slice(0, q.limit ?? 100)
}

/** Drop everything from one connector — what disconnecting an account means. */
export async function forgetSource(source: string): Promise<number> {
  const s = maybeStore()
  if (!s) return 0
  const existing = (await s.read()) ?? []
  const keep = existing.filter((o) => o.source !== source)
  await s.write(keep)
  return existing.length - keep.length
}
