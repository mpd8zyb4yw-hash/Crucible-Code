/**
 * WHO AND WHERE, ACROSS SOURCES — AND THE TWO THINGS THIS REFUSES TO DO.
 *
 * `people.ts` already resolves people out of structured records and states the
 * rule this file inherits verbatim:
 *
 *     A RELATIONSHIP IS NEVER INFERRED FROM AN EMAIL ADDRESS OR FROM EVENT
 *     ATTENDANCE.
 *
 * Nothing here weakens that. What it adds is three things `people.ts` could not
 * do, because it only ever read `Observation.data`:
 *
 *   · PLACES. A coordinate has no display name and a name has no coordinate, and
 *     until both can be one entity there is no such thing as "the shop he goes
 *     to on Saturdays" — only a list of visits.
 *   · KEYLESS PEOPLE. "Bernardo" in a calendar summary has no address. He is
 *     still one of the most present people in the data, and refusing to model
 *     anyone who is not on an invitation means modelling his working life and
 *     none of the rest of it.
 *   · A GRAPH. Two entities that keep appearing together is a measurement, and
 *     measurements are allowed. Which measurement may become which edge is in
 *     `RELATIONSHIP_RULES`, enforced here.
 *
 * THE SECOND REFUSAL, WHICH IS THE HARD ONE: DO NOT OVERMERGE.
 *
 * A candidate with a structured key resolves by that key and is safe — two
 * records naming `email:anna@…` are Anna, whatever else differs. A candidate
 * with no key is the dangerous one, and the temptation is to attach it to the
 * nearest name we already hold. That is how "Bernardo" from a lunch invitation
 * becomes Bernardo Rossi the client, how his history merges with a stranger's,
 * and how the app then speaks about one as though it knew the other.
 *
 * So a keyless candidate NEVER joins a keyed entity. It can only ever accumulate
 * into a keyless entity of its own, it needs repeated independent sightings to
 * become one at all, and if he later says they are the same person that is a
 * merge HE performs. An unresolved name is a correct outcome; a wrong merge is
 * unrecoverable without him noticing something he has no way to see.
 */

import { personMailboxCheck } from '../people.js'
import { hash, idOf, slug } from './ids.js'
import {
  RELATIONSHIP_RULES,
  VERSIONS,
  mayDerive,
  type EntityCandidate,
  type Entity,
  type EntityKind,
  type EvidenceRef,
  type MemoryStore,
  type NormalizedObservation,
  type Relationship,
  type RelationshipType,
  type Setter,
} from './types.js'

/** What one resolution pass did, in the same spirit as `PeopleRun`. */
export interface ResolveRun {
  added: string[]
  enriched: string[]
  /** Candidates deliberately left unresolved, with the reason. Never silent. */
  skipped: { label: string; why: string }[]
  /** Observation id → the entities it turned out to be about. */
  byObservation: Map<string, string[]>
}

/**
 * HOW MANY INDEPENDENT SIGHTINGS A BARE NAME NEEDS BEFORE IT IS ANYBODY.
 *
 * Three, and counted across DISTINCT DAYS rather than across records. One event
 * called "Lunch Bernardo" is a title; the same name on three separate days is a
 * person. Counting records instead of days would let a single recurring calendar
 * entry — one decision, replicated fifty-two times by Google — manufacture a
 * person out of nothing, which is precisely the failure mode `people.ts` avoids
 * by counting appearances rather than rows.
 */
const MENTION_EVIDENCE = 3

/**
 * How close two coordinates have to be to be one place, in metres.
 *
 * `normalize.ts` already rounds to four decimals (~11 m), which absorbs GPS
 * jitter at a stationary phone. This is the second stage: a supermarket has a car
 * park, and arrivals scatter across it by more than 11 m while plainly being the
 * same errand. Eighty metres keeps two shops on one street apart — Italian town
 * centres are the test case, and shopfronts there are rarely 80 m apart on the
 * same side — while collapsing one building's approaches into one place.
 *
 * Too large is the worse failure: merging his home with the neighbour's makes
 * "was he at home" unanswerable and there is no evidence in the data that would
 * ever split them again.
 */
export const PLACE_RADIUS_M = 80

/** `email:anna@x` → `ent:person:<slug>`. Deterministic; see `ids.ts`. */
export function entityIdForKey(kind: EntityKind, key: string): string {
  return idOf('ent', kind, slug(key, 48))
}

/**
 * A keyless entity's id comes from its NAME, and carries a marker saying so.
 *
 * The `~` is load-bearing rather than decorative: it makes "this entity was
 * never identified by a source" visible in every id, every evidence chain and
 * every test failure, so a keyless person cannot be mistaken for a resolved one
 * three layers downstream.
 */
export function entityIdForName(kind: EntityKind, label: string): string {
  return idOf('ent', kind, `~${slug(label, 40)}`)
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Fold a batch of observations into the entity graph.
 *
 * INCREMENTAL AND IDEMPOTENT. Running it twice over the same observations
 * changes nothing, because every entity is upserted under a deterministic id and
 * every evidence list is a set union. That is what lets the reflection cycle run
 * it on whatever arrived since the cursor without ever needing to know what came
 * before.
 */
export function resolveEntities(
  store: MemoryStore,
  observations: NormalizedObservation[],
  now: string
): ResolveRun {
  const run: ResolveRun = { added: [], enriched: [], skipped: [], byObservation: new Map() }
  if (!observations.length) return run

  /**
   * Keyless names are counted across the WHOLE batch before any of them is
   * promoted, because the threshold is about the name's history and not about
   * the record in hand. Counted by day, per the `MENTION_EVIDENCE` note.
   */
  const mentionDays = new Map<string, Set<string>>()
  const mentionEvidence = new Map<string, EvidenceRef[]>()
  for (const o of observations) {
    for (const c of o.entityCandidates ?? []) {
      if (c.key) continue
      const k = `${c.kind}:${c.label.toLowerCase()}`
      const day = (o.occurredAt ?? o.interval?.start ?? o.provenance.observedAt).slice(0, 10)
      const days = mentionDays.get(k) ?? new Set<string>()
      days.add(day)
      mentionDays.set(k, days)
      const ev = mentionEvidence.get(k) ?? []
      ev.push({ kind: 'observation', id: o.id, says: `named "${c.label}"` })
      mentionEvidence.set(k, ev)
    }
  }
  /**
   * Sightings ALREADY HELD count too, or a name seen once a week would never
   * cross the bar: each incremental batch would contain one sighting and forget
   * the others. The alias table is where those live.
   */
  const held = (kind: EntityKind, label: string): Entity | null => {
    const id = entityIdForName(kind, label)
    return store.entities.byId(id)
  }

  // Places are clustered against what already exists, so the geo index is built
  // once per pass rather than per candidate.
  const places = store.entities.ofKind('place')

  const touched = new Map<string, Entity>()
  const get = (id: string): Entity | null => touched.get(id) ?? store.entities.byId(id)

  for (const o of observations) {
    const at = o.occurredAt ?? o.interval?.start ?? o.provenance.observedAt
    const resolved: string[] = []

    for (const c of o.entityCandidates ?? []) {
      const evidence: EvidenceRef = { kind: 'observation', id: o.id, says: `${c.via}: "${c.label}"` }

      /**
       * IS THIS MAILBOX A HUMAN? ASKED OF `people.ts`, NOT ANSWERED HERE.
       *
       * Found by running the resolver over four months of synthetic mail: the
       * Coop's weekly newsletter became a person, accumulated nineteen days of
       * contact, and earned a `frequent_contact` edge — the app would have
       * believed he corresponded regularly with a supermarket.
       *
       * `people.ts` has had the filter for this since it was written. Writing a
       * second one here would have been the specific failure the handoff warns
       * about twice: two systems resolving people from the same records by
       * different rules, with no way to tell from either side which graph is the
       * real one.
       */
      if (c.kind === 'person') {
        const email = c.key?.replace(/^email:/, '')
        const human = personMailboxCheck(c.label, email)
        if (!human.ok) {
          run.skipped.push({ label: c.label, why: human.why })
          continue
        }
      }

      if (c.key) {
        const id = c.kind === 'place' ? placeIdFor(c, places, get) : entityIdForKey(c.kind, c.key)
        const before = get(id)
        const next = foldEntity(before, {
          id,
          kind: c.kind,
          label: c.label,
          identity: c.key,
          at,
          evidence,
          confidence: c.confidence,
          by: 'connector',
        })
        touched.set(id, next)
        if (!before) run.added.push(`${c.kind} ${next.label}`)
        else if (JSON.stringify(before) !== JSON.stringify(next)) run.enriched.push(next.label)
        resolved.push(id)
        if (c.kind === 'place' && !places.some((p) => p.id === id)) places.push(next)
        continue
      }

      // ── keyless ──
      const k = `${c.kind}:${c.label.toLowerCase()}`
      const id = entityIdForName(c.kind, c.label)
      const existing = get(id) ?? held(c.kind, c.label)
      const seenDays = mentionDays.get(k)?.size ?? 0
      if (!existing && seenDays < MENTION_EVIDENCE) {
        run.skipped.push({
          label: c.label,
          why: `named on ${seenDays} day(s); a bare name needs ${MENTION_EVIDENCE} before it is anybody`,
        })
        continue
      }
      const next = foldEntity(existing, {
        id,
        kind: c.kind,
        label: c.label,
        identity: null,
        at,
        evidence,
        /**
         * Capped well below a keyed entity's. This is a name that appears in his
         * data repeatedly and has never been identified by any source, and the
         * number should say so wherever it is read.
         */
        confidence: Math.min(0.6, 0.3 + 0.1 * seenDays),
        by: 'agent',
      })
      if (!existing) {
        next.evidence = dedupeEvidence([...(mentionEvidence.get(k) ?? []), ...next.evidence])
        run.added.push(`${c.kind} ${next.label} (unidentified)`)
      } else run.enriched.push(next.label)
      touched.set(id, next)
      resolved.push(id)
    }

    if (resolved.length) run.byObservation.set(o.id, [...new Set(resolved)])
  }

  if (touched.size) store.entities.put([...touched.values()])
  // Stamped after the write so a caller can see the pass ran even when it found
  // nothing, which is a different thing from the pass not having run.
  void now
  return run
}

/**
 * Merge one sighting into an entity, or make one.
 *
 * THE LABEL RULE IS THE OWNERSHIP RULE. `by: 'user'` is a lock, exactly as it is
 * in `people.ts`'s `liftPeople` and in `mayReplace`: if he has renamed something,
 * no connector re-reading its own record puts the old name back. Everything else
 * merges — identities union, aliases union, evidence unions, the window widens.
 */
function foldEntity(
  held: Entity | null,
  d: {
    id: string
    kind: EntityKind
    label: string
    identity: string | null
    at: string
    evidence: EvidenceRef
    confidence: number
    by: Setter
  }
): Entity {
  if (!held) {
    return {
      id: d.id,
      kind: d.kind,
      label: d.label,
      aliases: [],
      identities: d.identity ? [d.identity] : [],
      attributes: {},
      confidence: d.confidence,
      evidence: [d.evidence],
      firstObservedAt: d.at,
      lastObservedAt: d.at,
      by: d.by,
      resolveVersion: VERSIONS.resolve,
    }
  }

  const aliases = new Set(held.aliases)
  if (held.label !== d.label) aliases.add(d.label)
  const identities = new Set(held.identities)
  if (d.identity) identities.add(d.identity)

  return {
    ...held,
    label: held.by === 'user' ? held.label : d.label,
    aliases: [...aliases].sort(),
    identities: [...identities].sort(),
    /**
     * Confidence is the BEST any sighting warranted, not an average and not a
     * sum. Two weak sightings of a bare name do not add up to an identification,
     * and one strong sighting is not diluted by later weak ones.
     */
    confidence: Math.max(held.confidence, d.confidence),
    evidence: dedupeEvidence([...held.evidence, d.evidence]),
    firstObservedAt: held.firstObservedAt < d.at ? held.firstObservedAt : d.at,
    lastObservedAt: held.lastObservedAt > d.at ? held.lastObservedAt : d.at,
    resolveVersion: VERSIONS.resolve,
  }
}

/**
 * The evidence list is a set, and it is CAPPED.
 *
 * Uncapped, a place he visits daily accumulates a thousand identical evidence
 * refs, the entity row grows without limit, and every read of it parses a
 * kilobyte of proof of something nobody disputes. The first and the most recent
 * are what an explanation actually needs — "since March, most recently
 * yesterday" — so the middle is dropped and the count is what carries the rest.
 */
const EVIDENCE_CAP = 40

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  const out: EvidenceRef[] = []
  for (const r of refs) {
    const k = `${r.kind}:${r.id}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  if (out.length <= EVIDENCE_CAP) return out
  const half = Math.floor(EVIDENCE_CAP / 2)
  return [...out.slice(0, half), ...out.slice(-half)]
}

// ── Places ───────────────────────────────────────────────────────────────────

/**
 * Which place a candidate belongs to, clustering coordinates that are plainly
 * the same doorway.
 *
 * Two candidates for a place identity: the key as given, or an existing place
 * within `PLACE_RADIUS_M`. The existing one WINS when there is one, and the new
 * key is added to its identity list — so the second arrival at the supermarket
 * car park joins the supermarket rather than founding a rival.
 *
 * A candidate with a non-geographic key (`label:coop`, `place:home`) never
 * clusters. It has an identity the source vouched for, and merging two of those
 * on proximity would fold "the pharmacy" into "the square outside the pharmacy".
 */
function placeIdFor(c: EntityCandidate, places: Entity[], get: (id: string) => Entity | null): string {
  const key = c.key!
  const direct = entityIdForKey('place', key)
  const geo = geoOf(key)
  if (!geo) return direct

  // An exact identity match always wins over proximity — it is the same key.
  for (const p of places) {
    const current = get(p.id) ?? p
    if (current.identities.includes(key)) return current.id
  }
  let best: { id: string; metres: number } | null = null
  for (const p of places) {
    const current = get(p.id) ?? p
    for (const identity of current.identities) {
      const other = geoOf(identity)
      if (!other) continue
      const metres = metresApart(geo, other)
      if (metres <= PLACE_RADIUS_M && (!best || metres < best.metres)) best = { id: current.id, metres }
    }
  }
  return best?.id ?? direct
}

export const geoOf = (identity: string): { lat: number; lon: number } | null => {
  const m = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(identity)
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null
}

/**
 * Equirectangular distance, which is the right approximation here and not a
 * corner cut.
 *
 * Haversine's advantage appears over hundreds of kilometres; this is asked
 * questions at eighty metres, where the two agree to well under a metre. The
 * cosine of the latitude is what keeps a longitude degree honest away from the
 * equator — dropping it would make the radius twice as generous in Italy as it
 * looks, which is exactly the "merged his home with the neighbour's" failure.
 */
export function metresApart(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const mPerDegLat = 111_320
  const mPerDegLon = mPerDegLat * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  const dx = (a.lon - b.lon) * mPerDegLon
  const dy = (a.lat - b.lat) * mPerDegLat
  return Math.sqrt(dx * dx + dy * dy)
}

// ── The graph ────────────────────────────────────────────────────────────────

export interface RelationshipRun {
  written: string[]
  /** Edges the rules forbade code from drawing, and why. Kept for the build log. */
  refused: { type: string; why: string }[]
}

const relationshipId = (from: string, type: string, to: string): string =>
  idOf('rel', hash(`${from}|${type}|${to}`))

/**
 * SOMETHING HE SAID ABOUT TWO PEOPLE. The only door for a stated relationship.
 *
 * Every edge in `RELATIONSHIP_RULES` marked `stated` can be created here and
 * nowhere else, and `deriveRelationships` below cannot reach them. That is the
 * structural version of `people.ts`'s rule rather than a restatement of it: an
 * agent that wanted to write "friend" would have to call a function whose name
 * says it is passing on something he said, with `by: 'user'`, which is not
 * something that happens accidentally.
 */
export function stateRelationship(
  store: MemoryStore,
  d: {
    fromEntityId: string
    toEntityId: string
    type: RelationshipType
    at: string
    evidence?: EvidenceRef[]
    note?: string
  }
): Relationship {
  const id = relationshipId(d.fromEntityId, d.type, d.toEntityId)
  const held = store.relationships.byId(id)
  const rel: Relationship = {
    id,
    fromEntityId: d.fromEntityId,
    toEntityId: d.toEntityId,
    type: d.type,
    knowledgeKind: 'stated',
    confidence: 1,
    evidence: dedupeEvidence([...(held?.evidence ?? []), ...(d.evidence ?? [])]),
    firstObservedAt: held?.firstObservedAt ?? d.at,
    lastObservedAt: d.at,
    by: 'user',
    retiredAt: null,
    note: d.note ?? held?.note,
  }
  store.relationships.put([rel])
  return rel
}

/**
 * WHAT BEHAVIOUR IS ALLOWED TO CONCLUDE.
 *
 * Two measurements, both of which are literally what they say:
 *
 *   · `frequently_meets` — they were in the same episode, repeatedly, across a
 *     span of time. Not "friend". Not "colleague". They meet.
 *   · `frequent_contact`  — messages passed between them, repeatedly. Not
 *     "close". They correspond.
 *
 * THE THRESHOLD IS DELIBERATELY NOT `ENGAGEMENT_MIN`. Four is the right number
 * for a bounded nudge to a ranking, where being wrong costs a card's position.
 * This writes a durable claim about two human beings into a graph that other
 * cognition reads, so it asks for more and it asks for SPAN as well as count:
 * six meetings in one week is a project, not a rhythm, and the coverage
 * requirement is what tells them apart.
 *
 * A pair that once qualified and has stopped is RETIRED rather than deleted, so
 * "they used to meet weekly" stays answerable.
 */
const MEETS_MIN_OCCASIONS = 5
const MEETS_MIN_SPAN_DAYS = 21

export function deriveRelationships(store: MemoryStore, selfEntityId: string, now: string): RelationshipRun {
  const run: RelationshipRun = { written: [], refused: [] }

  // ── who he was with, per episode ──
  const meetings = new Map<string, { days: Set<string>; evidence: EvidenceRef[]; first: string; last: string }>()
  for (const ep of store.episodes.all()) {
    if (ep.status === 'cancelled') continue
    for (const participant of ep.participantEntityIds) {
      if (participant === selfEntityId) continue
      const bucket = meetings.get(participant) ?? { days: new Set<string>(), evidence: [], first: ep.startAt, last: ep.startAt }
      bucket.days.add(ep.startAt.slice(0, 10))
      bucket.evidence.push({ kind: 'episode', id: ep.id, says: `${ep.type} on ${ep.startAt.slice(0, 10)}` })
      if (ep.startAt < bucket.first) bucket.first = ep.startAt
      if (ep.startAt > bucket.last) bucket.last = ep.startAt
      meetings.set(participant, bucket)
    }
  }

  const out: Relationship[] = []
  for (const [entityId, bucket] of meetings) {
    const occasions = bucket.days.size
    const spanDays = wholeDaysBetween(bucket.first, bucket.last)
    const id = relationshipId(selfEntityId, 'frequently_meets', entityId)
    const held = store.relationships.byId(id)
    const qualifies = occasions >= MEETS_MIN_OCCASIONS && spanDays >= MEETS_MIN_SPAN_DAYS

    if (!qualifies) {
      if (held && !held.retiredAt) {
        out.push({ ...held, retiredAt: now, note: `now ${occasions} occasion(s) over ${spanDays} days` })
        run.refused.push({ type: 'frequently_meets', why: `retired: ${occasions} occasions over ${spanDays} days` })
      } else if (!held) {
        run.refused.push({
          type: 'frequently_meets',
          why: `${occasions} occasion(s) over ${spanDays} days is under ${MEETS_MIN_OCCASIONS}/${MEETS_MIN_SPAN_DAYS}`,
        })
      }
      continue
    }

    out.push({
      id,
      fromEntityId: selfEntityId,
      toEntityId: entityId,
      type: 'frequently_meets',
      /**
       * `derived`, not `inferred`. The difference is real and is worth the word:
       * this is arithmetic over episodes that happened, presentable as "you have
       * met N times since March". An inference would be a claim about what that
       * means, which is the thing nothing here is allowed to make.
       */
      knowledgeKind: 'derived',
      confidence: Math.min(0.9, 0.4 + 0.05 * occasions),
      evidence: dedupeEvidence(bucket.evidence),
      firstObservedAt: held?.firstObservedAt ?? bucket.first,
      lastObservedAt: bucket.last,
      by: 'agent',
      retiredAt: null,
      note: `${occasions} shared occasions over ${spanDays} days`,
    })
    run.written.push(`frequently_meets → ${entityId} (${occasions})`)
  }

  // ── who he corresponds with ──
  const contact = new Map<string, { days: Set<string>; evidence: EvidenceRef[]; first: string; last: string }>()
  for (const o of store.observations.ofType('communication')) {
    const counterparty = o.attributes.counterparty
    if (typeof counterparty !== 'string') continue
    const entityId = entityIdForKey('person', `email:${counterparty}`)
    const at = o.occurredAt ?? o.provenance.observedAt
    const bucket = contact.get(entityId) ?? { days: new Set<string>(), evidence: [], first: at, last: at }
    bucket.days.add(at.slice(0, 10))
    bucket.evidence.push({ kind: 'observation', id: o.id, says: String(o.attributes.direction ?? 'message') })
    if (at < bucket.first) bucket.first = at
    if (at > bucket.last) bucket.last = at
    contact.set(entityId, bucket)
  }

  for (const [entityId, bucket] of contact) {
    // Only for someone we actually hold — a mailbox that never became an entity
    // is a shop or a robot, and `people.ts`'s filters are what decided so.
    if (!store.entities.byId(entityId)) continue
    const occasions = bucket.days.size
    const spanDays = wholeDaysBetween(bucket.first, bucket.last)
    if (occasions < MEETS_MIN_OCCASIONS || spanDays < MEETS_MIN_SPAN_DAYS) {
      run.refused.push({ type: 'frequent_contact', why: `${occasions} day(s) over ${spanDays} days` })
      continue
    }
    const id = relationshipId(selfEntityId, 'frequent_contact', entityId)
    const held = store.relationships.byId(id)
    out.push({
      id,
      fromEntityId: selfEntityId,
      toEntityId: entityId,
      type: 'frequent_contact',
      knowledgeKind: 'derived',
      confidence: Math.min(0.9, 0.4 + 0.05 * occasions),
      evidence: dedupeEvidence(bucket.evidence),
      firstObservedAt: held?.firstObservedAt ?? bucket.first,
      lastObservedAt: bucket.last,
      by: 'agent',
      retiredAt: null,
      note: `${occasions} days with messages over ${spanDays} days`,
    })
    run.written.push(`frequent_contact → ${entityId} (${occasions})`)
  }

  /**
   * The guard that makes the rule table real rather than documentation. If
   * anything above ever produces a stated-only edge, it is dropped here and the
   * refusal is recorded — a loud, inspectable failure instead of a quiet claim
   * that he is somebody's friend.
   */
  const permitted = out.filter((r) => {
    if (mayDerive(r.type)) return true
    run.refused.push({ type: r.type, why: `${RELATIONSHIP_RULES[r.type].says} — behaviour may not assert it` })
    return false
  })

  if (permitted.length) store.relationships.put(permitted)
  return run
}

/**
 * Whole days between two instants.
 *
 * `clock.ts` owns date arithmetic and `daysBetweenDays` is the function for it,
 * but it takes two `YYYY-MM-DD` in HIS zone and what is in hand here is two UTC
 * instants whose only use is a SPAN — "how long has this been going on" — where
 * the zone cannot change the answer by more than a day and the thresholds are
 * three weeks. Slicing the date out and differencing is honest at this
 * resolution; anything asked to name a specific day goes through `clock.ts`.
 */
function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00.000Z`)
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00.000Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/**
 * WHICH ENTITIES AN OBSERVATION TURNED OUT TO BE ABOUT.
 *
 * The read side of resolution, for every stage that runs after it. A keyed
 * candidate resolves by construction; a keyless one resolves only if it has
 * previously earned an entity of its own, which is the same anti-overmerge rule
 * seen from the other end — a bare name that never crossed `MENTION_EVIDENCE`
 * simply is not about anybody, and every reader gets that answer rather than a
 * best guess.
 *
 * Deliberately a pure lookup with no writes, so assembly and the temporal models
 * cannot create entities as a side effect of reading.
 */
export function resolvedEntityIds(
  store: MemoryStore,
  o: NormalizedObservation,
  kind?: EntityKind
): string[] {
  const out: string[] = []
  for (const c of o.entityCandidates ?? []) {
    if (kind && c.kind !== kind) continue
    if (c.key) {
      // Places may have been clustered into a neighbour, so the identity index
      // is asked rather than the id being recomputed from the key.
      const byIdentity = store.entities.byIdentity(c.key)
      if (byIdentity) {
        out.push(byIdentity.id)
        continue
      }
      const id = entityIdForKey(c.kind, c.key)
      if (store.entities.byId(id)) out.push(id)
      continue
    }
    const id = entityIdForName(c.kind, c.label)
    if (store.entities.byId(id)) out.push(id)
  }
  return [...new Set(out)]
}

/**
 * The entity that is him.
 *
 * A fixed id rather than one derived from his address, because his address can
 * change and the graph's centre cannot. Everything he does hangs off this, and a
 * self entity that forked when he added a second mailbox would split his own
 * history in half.
 */
export const SELF_ENTITY_ID = 'ent:person:self'

export function ensureSelf(store: MemoryStore, now: string, identities: string[] = []): Entity {
  const held = store.entities.byId(SELF_ENTITY_ID)
  const entity: Entity = held
    ? { ...held, identities: [...new Set([...held.identities, ...identities])].sort(), lastObservedAt: now }
    : {
        id: SELF_ENTITY_ID,
        kind: 'person',
        label: 'you',
        aliases: [],
        identities: [...new Set(identities)].sort(),
        attributes: { self: true },
        confidence: 1,
        evidence: [],
        firstObservedAt: now,
        lastObservedAt: now,
        by: 'agent',
        resolveVersion: VERSIONS.resolve,
      }
  store.entities.put([entity])
  return entity
}
