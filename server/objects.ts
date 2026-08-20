import {
  derive,
  effectiveOrigin,
  type Origin,
  type Provenance,
} from './provenance.js'

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
 * IDENTITY IS NOT METADATA. `youtube:video:abc` is a permanent name for a thing
 * in the world. Its title, thumbnail, channel and view count are what one
 * source said about that thing at one moment — and different sources say
 * different amounts at different times. Storing those as intrinsic fields of
 * the object was a real defect, not a stylistic one: `remember()` upserted a
 * whole record by id, newest fetch winning, so importing a Takeout export
 * (which carries no thumbnail) ERASED the thumbnail of any video already read
 * live, and the next live read erased Takeout's `watchedAt`. The two readings
 * were never in conflict; the storage shape forced them to overwrite.
 *
 * So an identity holds many observations, an observation belongs to the route
 * that produced it, and reading an object MERGES them field by field — most
 * authoritative reading of each field wins, and each field remembers which
 * reading it came from. Two sources describing one thing is the normal case,
 * not the exception, and it is what a second connector needs to work at all.
 *
 * Nothing here is YouTube-shaped. A connector added later stores its objects
 * with its own `source` and `kind` and inherits citation, provenance, staleness
 * and cross-source lookup without adding a line to this file.
 */

export type FieldValue = string | number | boolean | null

/**
 * A thing in the world. Never stale, never revised, never inferred.
 *
 * Everything here is either part of the name or fixed by it. If a piece of data
 * can change while the thing stays the same thing, it is an observation.
 */
export interface ObjectIdentity {
  /** `source:kind:nativeId` — stable, and the only name anything else uses. */
  id: string
  /** The connector that names it. Not necessarily the only one that sees it. */
  source: string
  /** 'video' | 'channel' | 'email' | 'event' | 'place' | … connector's choice. */
  kind: string
  /** The id the source itself uses, unprefixed. */
  nativeId: string
  /** When it was first seen, by anything. */
  firstSeen: string
}

/**
 * What one route said about one identity at one time.
 *
 * Keyed by `(identity, source, via)` so re-running a route REPLACES its own
 * previous reading — a second subscriptions pull updates the view count — while
 * a different route's reading survives beside it. That is the whole reason a
 * Takeout import and a live read can now describe the same video without either
 * one destroying the other.
 */
export interface ObjectObservation {
  /** `${of}#${source}/${via}` — stable, so a re-read overwrites itself only. */
  id: string
  /** Identity this describes. */
  of: string
  /** Whatever this route actually returned. Absent ≠ null: absent is silence. */
  fields: Record<string, FieldValue | undefined>
  prov: Provenance
}

export interface StoredObject {
  identity: ObjectIdentity
  observations: ObjectObservation[]
}

/**
 * A resolved object: one identity, its fields merged, ready to render.
 *
 * This is a VIEW computed at read time, never a stored record. The named
 * fields are the ones every renderer wants; the rest stay in `fields`. Its
 * shape is unchanged from when objects were stored flat, so panes, widgets and
 * `resolveRefs` did not have to learn anything about observations.
 */
export interface RetrievedObject {
  id: string
  source: string
  kind: string
  nativeId: string
  /** Headline. Always some source's own, never a paraphrase. */
  title: string
  sub?: string
  body?: string
  /** Absolute URL, already checked against the image host allowlist. */
  image?: string
  /** When the THING happened, as distinct from when we fetched it. */
  at?: string
  /** Anything else any source returned that a renderer might want. */
  fields?: Record<string, FieldValue>
  /**
   * The provenance of the record AS ASSEMBLED. One contributing reading and
   * this is that reading; two or more and it is an `enriched` step over both,
   * because a record built from a live read and a March export is neither.
   */
  prov: Provenance
  /** Where each individual field came from. The honest, unsummarised answer. */
  fieldProv: Record<string, Provenance>
  /** How many distinct readings contributed. Breadth, countable. */
  readings: number
}

/**
 * What a connector hands in: one route's account of one thing.
 *
 * The same field names a resolved object has, minus the two the store works
 * out — a connector cannot know how many readings exist or where a field it did
 * not return came from, and should not be able to claim either.
 */
export type ObjectDraft = Omit<RetrievedObject, 'fieldProv' | 'readings'>

export interface ObjectStore {
  read(): Promise<StoredObject[] | null>
  write(objects: StoredObject[]): Promise<void>
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
      return raw ? migrate(JSON.parse(raw)) : null
    },
    async write(objects) {
      await kv.put(key, JSON.stringify(objects))
    },
  }
}

/**
 * Read a store written before identities and observations were separate.
 *
 * The old file is an array of flat records. Each becomes an identity with
 * exactly one observation, which is what it always was — the merge just had
 * nowhere to happen. Kept because losing the cache costs thumbnails on panes he
 * pinned months ago, and a migration is four lines.
 */
export function migrate(raw: unknown): StoredObject[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r) => {
    const o = r as Record<string, any>
    if (o?.identity && Array.isArray(o?.observations)) return [o as StoredObject]
    if (!o?.id || !o?.source || !o?.kind) return []
    const { id, source, kind, nativeId, prov, fields, ...rest } = o
    return [{
      identity: { id, source, kind, nativeId: nativeId ?? String(id).split(':').slice(2).join(':'), firstSeen: prov?.retrievedAt ?? new Date(0).toISOString() },
      observations: [{
        id: observationId(id, prov?.source ?? source, prov?.via),
        of: id,
        fields: { ...rest, ...(fields ?? {}) },
        prov: prov ?? { origin: 'retrieved', source, retrievedAt: new Date(0).toISOString() },
      }],
    }]
  })
}

export function objectId(source: string, kind: string, nativeId: string): string {
  return `${source}:${kind}:${nativeId}`
}

export function observationId(of: string, source: string, via?: string): string {
  return `${of}#${source}/${via ?? '-'}`
}

/**
 * How many identities to keep.
 *
 * High enough that a pane he pinned in March still resolves its thumbnails in
 * June, low enough that this stays a file you can open. Eviction is by the
 * newest reading of each identity, so the things he is actually looking at
 * survive.
 */
const MAX_OBJECTS = 4000

async function readAll(): Promise<StoredObject[]> {
  const s = maybeStore()
  if (!s) return []
  return (await s.read()) ?? []
}

/** Every identity, with all readings, newest-read first. Rarely what you want. */
export async function allStored(): Promise<StoredObject[]> {
  return readAll()
}

/** Every object as it currently resolves. */
export async function allObjects(now = Date.now()): Promise<RetrievedObject[]> {
  return (await readAll()).flatMap((s) => {
    const r = project(s, now)
    return r ? [r] : []
  })
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Record what a connector just fetched.
 *
 * Takes the flat shape connectors already produce and files it as one reading
 * against one identity. A connector needs to know nothing about any of this: it
 * describes what it saw, and the store works out that what it saw is another
 * account of something it already knows about.
 */
export async function remember(objects: ObjectDraft[]): Promise<void> {
  await observe(
    objects.map((o) => ({
      identity: { id: o.id, source: o.source, kind: o.kind, nativeId: o.nativeId },
      fields: {
        title: o.title,
        sub: o.sub,
        body: o.body,
        image: o.image,
        at: o.at,
        ...(o.fields ?? {}),
      },
      prov: o.prov,
    }))
  )
}

/**
 * The lower-level write: identities and the readings made of them.
 *
 * `remember` is this with the field names filled in. A connector that wants to
 * file a partial reading — an enrichment that only learned a price, a source
 * that only knows availability — calls this and overwrites nothing else.
 */
export async function observe(
  readings: {
    identity: { id: string; source: string; kind: string; nativeId: string }
    fields: Record<string, FieldValue | undefined>
    prov: Provenance
  }[]
): Promise<void> {
  const s = maybeStore()
  if (!s || !readings.length) return

  const existing = await readAll()
  const byId = new Map(existing.map((o) => [o.identity.id, o]))

  for (const r of readings) {
    const now = r.prov.retrievedAt || new Date().toISOString()
    let entry = byId.get(r.identity.id)
    if (!entry) {
      entry = { identity: { ...r.identity, firstSeen: now }, observations: [] }
      byId.set(r.identity.id, entry)
    }
    // Silence is not a value: a route that did not return a field must not be
    // recorded as having returned nothing for it, or absence overwrites fact.
    const fields: Record<string, FieldValue> = {}
    for (const [k, v] of Object.entries(r.fields)) if (v !== undefined) fields[k] = v

    const oid = observationId(r.identity.id, r.prov.source, r.prov.via)
    const at = entry.observations.findIndex((o) => o.id === oid)
    const reading: ObjectObservation = { id: oid, of: r.identity.id, fields, prov: r.prov }
    if (at >= 0) entry.observations[at] = reading
    else entry.observations.push(reading)
  }

  const merged = [...byId.values()].sort((a, b) => newestRead(b) - newestRead(a))
  await s.write(merged.slice(0, MAX_OBJECTS))
}

const newestRead = (s: StoredObject): number =>
  s.observations.reduce((max, o) => Math.max(max, Date.parse(o.prov.retrievedAt) || 0), 0)

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * How much a reading's account of ONE field is worth, right now.
 *
 * Per field rather than per record, because that is how truth actually decays:
 * at twenty hours old a live reading is still authoritative about a video's
 * title and no longer authoritative about its view count, and both of those are
 * true of the same reading at the same instant. A record-level answer has to
 * pick one and be wrong about the other.
 */
const AUTHORITY: Record<Origin, number> = {
  retrieved: 6,
  historical: 5,
  enriched: 5,
  stale: 4,
  ranked: 3,
  transformed: 2,
  inferred: 1,
  unavailable: 0,
}

/**
 * Merge every reading of one identity into the record to render.
 *
 * Field by field: the most authoritative reading that actually carries the
 * field wins, ties broken by recency. So a live read supplies the thumbnail, a
 * Takeout export supplies `watchedAt`, neither erases the other, and if the
 * live read has aged past its view-count window while its title window is still
 * open then the title stays `retrieved` and the count reads `stale`.
 *
 * Returns null for an identity nobody has said anything renderable about —
 * blank is a correct answer where a confident wrong one is not.
 */
export function project(s: StoredObject, now = Date.now()): RetrievedObject | null {
  const fields: Record<string, FieldValue> = {}
  const fieldProv: Record<string, Provenance> = {}
  const contributing = new Set<Provenance>()

  const names = new Set(s.observations.flatMap((o) => Object.keys(o.fields)))
  for (const name of names) {
    let best: ObjectObservation | undefined
    let bestScore = -1
    let bestAt = -1
    for (const o of s.observations) {
      if (o.fields[name] === undefined) continue
      const score = AUTHORITY[effectiveOrigin(o.prov, now, name)]
      const at = Date.parse(o.prov.retrievedAt) || 0
      if (score > bestScore || (score === bestScore && at > bestAt)) {
        best = o
        bestScore = score
        bestAt = at
      }
    }
    if (!best) continue
    fields[name] = best.fields[name]!
    fieldProv[name] = best.prov
    contributing.add(best.prov)
  }

  const title = typeof fields.title === 'string' ? fields.title : undefined
  if (!title) return null

  const provs = [...contributing]
  /**
   * One reading is its own provenance; several is a composition of them.
   *
   * Calling a record built from a live read and a March export `retrieved`
   * would be a lie about half of it, and calling it `historical` a lie about
   * the other half. `enriched` over both is what it is, and the per-field map
   * below is where the unsummarised answer lives.
   */
  const prov =
    provs.length === 1
      ? provs[0]!
      : derive('enriched', provs, { note: `merged from ${provs.length} readings` })

  const { title: _t, sub, body, image, at, ...rest } = fields
  return {
    id: s.identity.id,
    source: s.identity.source,
    kind: s.identity.kind,
    nativeId: s.identity.nativeId,
    title,
    sub: typeof sub === 'string' ? sub : undefined,
    body: typeof body === 'string' ? body : undefined,
    image: typeof image === 'string' ? image : undefined,
    at: typeof at === 'string' ? at : undefined,
    fields: Object.keys(rest).length ? rest : undefined,
    prov,
    fieldProv,
    readings: s.observations.length,
  }
}

export async function lookup(id: string, now = Date.now()): Promise<RetrievedObject | undefined> {
  const s = (await readAll()).find((o) => o.identity.id === id)
  return s ? project(s, now) ?? undefined : undefined
}

/** Resolve many at once — one store read for a whole pane. */
export async function lookupMany(ids: string[], now = Date.now()): Promise<Map<string, RetrievedObject>> {
  const want = new Set(ids)
  const out = new Map<string, RetrievedObject>()
  if (!want.size) return out
  for (const s of await readAll()) {
    if (!want.has(s.identity.id)) continue
    const r = project(s, now)
    if (r) out.set(s.identity.id, r)
  }
  return out
}

/**
 * The query surface.
 *
 * Still a linear scan over a capped array — an index is not what stands between
 * this and being useful. It has grown ordering and field predicates because the
 * plan IR executes against it: a deterministic refresh has to be expressible
 * here or it is not deterministic, it is another model call.
 */
export interface ObjectQuery {
  source?: string
  /** Several sources at once, which is what a cross-source plan needs. */
  sources?: string[]
  kind?: string
  kinds?: string[]
  /** Case-insensitive substring over title, sub and body. */
  text?: string
  /** Exact matches on `fields`, all of which must hold. */
  where?: Record<string, FieldValue>
  /** Only objects whose provenance came through this route. */
  via?: string
  /** Exclude anything that has decayed past `retrieved`. */
  freshOnly?: boolean
  /** Only objects with a reading no older than this. */
  seenWithinMs?: number
  /** 'at' (when the thing happened), 'seen' (when we read it), or a field. */
  sort?: { by: string; dir?: 'asc' | 'desc' }
  limit?: number
}

export async function query(q: ObjectQuery = {}, now = Date.now()): Promise<RetrievedObject[]> {
  const needle = q.text?.toLowerCase()
  const sources = q.sources ?? (q.source ? [q.source] : undefined)
  const kinds = q.kinds ?? (q.kind ? [q.kind] : undefined)

  const hits = (await readAll()).flatMap((s) => {
    if (sources && !sources.includes(s.identity.source)) return []
    if (kinds && !kinds.includes(s.identity.kind)) return []
    if (q.via && !s.observations.some((o) => o.prov.via === q.via)) return []
    if (q.seenWithinMs !== undefined && now - newestRead(s) > q.seenWithinMs) return []
    const r = project(s, now)
    if (!r) return []
    if (q.freshOnly && effectiveOrigin(r.prov, now) !== 'retrieved') return []
    if (needle) {
      const hay = `${r.title} ${r.sub ?? ''} ${r.body ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return []
    }
    if (q.where) {
      for (const [k, v] of Object.entries(q.where)) {
        const have = k === 'title' ? r.title : k === 'sub' ? r.sub : r.fields?.[k]
        if (have !== v) return []
      }
    }
    return [r]
  })

  if (q.sort) hits.sort(comparator(q.sort.by, q.sort.dir ?? 'desc'))
  return hits.slice(0, q.limit ?? 100)
}

function comparator(by: string, dir: 'asc' | 'desc') {
  const sign = dir === 'asc' ? 1 : -1
  const key = (o: RetrievedObject): number | string => {
    if (by === 'at') return Date.parse(o.at ?? '') || 0
    if (by === 'seen') return Date.parse(o.prov.retrievedAt) || 0
    if (by === 'title') return o.title.toLowerCase()
    const v = o.fields?.[by]
    return typeof v === 'number' ? v : typeof v === 'string' ? v.toLowerCase() : 0
  }
  return (a: RetrievedObject, b: RetrievedObject) => {
    const x = key(a)
    const y = key(b)
    if (typeof x === 'string' || typeof y === 'string') return sign * String(x).localeCompare(String(y))
    return sign * (Number(x) - Number(y))
  }
}

/** Drop everything from one connector — what disconnecting an account means. */
export async function forgetSource(source: string): Promise<number> {
  const s = maybeStore()
  if (!s) return 0
  const existing = await readAll()
  /**
   * A disconnected source loses its READINGS, not every identity it ever
   * touched. An identity another connector also described stays, minus what
   * this one said about it — otherwise disconnecting YouTube would delete a
   * video a mail thread also refers to.
   */
  let removed = 0
  const keep: StoredObject[] = []
  for (const o of existing) {
    const left = o.observations.filter((r) => {
      const drop = r.prov.source === source
      if (drop) removed++
      return !drop
    })
    if (left.length) keep.push({ ...o, observations: left })
  }
  await s.write(keep)
  return removed
}
