/**
 * GETTING THINGS INTO THE LEDGER, ONCE, WITHOUT LOSING WHAT THEY SAID.
 *
 * Two doors, and the difference between them is the migration strategy.
 *
 *   · `eventsFromWorldObservations` is the DUAL-WRITE door. The connectors are
 *     not touched at all: they keep producing `Observation` records into the
 *     world document exactly as they do today, and this reads that same array
 *     and writes the ledger beside it. That is what makes Phase B of the
 *     migration a change to one call site rather than a rewrite of `google.ts`,
 *     and it is what makes parity checkable — both halves are fed by the same
 *     fetch, so a disagreement is a bug here rather than a difference in what
 *     was fetched.
 *
 *   · `event` is the DIRECT door, for sources the world document never modelled.
 *     Location visits are the first: `ObservationData` has a `place` kind that
 *     carries a label and a coordinate and no duration, so "he was at the Coop
 *     from 10:06 to 11:31" was not expressible and therefore was never stored.
 *     A temporal model of departures cannot be built out of records with no end.
 *
 * IDEMPOTENCE IS THE WHOLE JOB. Google is pulled every three hours and returns
 * the same fortnight each time. If a re-read produced a second event, then every
 * count downstream — how many Saturdays had a grocery trip, how often two people
 * meet, how many events a Thursday holds — would measure sync frequency instead
 * of his life, and would keep climbing forever. `dedupeKey` is what prevents it,
 * and the store enforces it with a UNIQUE index rather than trusting this file.
 *
 * WHAT A CORRECTION IS. A new event, never an edit. When Google renames an event
 * the ledger gains a second record of that event at a later `observedAt`, and
 * both are true statements about what the source said when. Normalisation reads
 * the newest, and history stays reconstructable — which is the only reason the
 * "Cinzia's concert" failure in `world.ts` was ever diagnosable.
 */

import type { Observation } from '../world.js'
import { hash, idOf, slug } from './ids.js'
import { VERSIONS, type MemoryEvent } from './types.js'

/** What a caller has to supply. Everything else is derived or defaulted. */
export interface EventInput {
  source: string
  /** The source's own id. Omit only when the source genuinely has none. */
  sourceId?: string
  sourceAt: string
  type: string
  payload: unknown
  /** When we saw it. Defaults to `sourceAt` — see below. */
  observedAt?: string
  /** Override only when the source's id is not a stable identity. */
  dedupeKey?: string
}

/**
 * Build one ledger event.
 *
 * `observedAt` DEFAULTS TO `sourceAt` rather than to now, and that is deliberate
 * for a reason that only shows up in the fixture and in a backfill: a synthetic
 * or imported history stamped with the wall clock would place four months of a
 * life at one instant, and every incremental cursor — which reads by
 * `observedAt` — would then process it as a single lump or skip it entirely.
 * A caller doing live ingestion passes the real instant; a caller replaying
 * history gets history.
 *
 * A source with no id gets a CONTENT HASH, which is the honest answer: two
 * location samples with identical coordinates, timestamps and payloads are the
 * same sample reported twice, and there is nothing else to tell them apart.
 */
export function event(input: EventInput, ingestVersion = VERSIONS.ingest): MemoryEvent {
  const sourceId = input.sourceId ?? hash(JSON.stringify([input.type, input.sourceAt, input.payload]))
  const dedupeKey = input.dedupeKey ?? `${input.source}:${sourceId}`
  return {
    id: idOf('evt', slug(input.source, 16), slug(sourceId, 60)),
    source: input.source,
    sourceId,
    sourceAt: input.sourceAt,
    observedAt: input.observedAt ?? input.sourceAt,
    type: input.type,
    payload: input.payload,
    ingestVersion,
    dedupeKey,
    normalizedAt: null,
    normalizeVersion: null,
  }
}

/**
 * THE BRIDGE FROM THE WORLD DOCUMENT'S OBSERVATION LIST.
 *
 * `Observation.data` is already the structured payload every connector produces,
 * and its `kind` already discriminates. So the mapping is mechanical, and its
 * being mechanical is the point: nothing is interpreted here, nothing is dropped
 * silently, and an observation whose `data` is absent still becomes an event —
 * carrying only its text, which is what the pre-`data` records genuinely are.
 *
 * `changedAt` is the field that makes a re-observation visible. `foldObservations`
 * in `world.ts` sets it when a record's content actually moved, so an event
 * carrying one is a genuinely NEW statement by the source about a thing it had
 * described differently before, and it gets its own ledger row rather than being
 * deduplicated away against the original.
 */
export function eventsFromWorldObservations(observations: Observation[], observedAt: string): MemoryEvent[] {
  return observations.map((o) => {
    const kind = o.data?.kind
    const type = kind ? `${o.source}.${kind}` : `${o.source}.text`
    /**
     * A changed record is a second event about the same thing, so the dedupe key
     * has to admit both. Including `changedAt` is what does it: unchanged
     * re-reads collapse onto one row, a rewrite lands beside the original.
     */
    const dedupeKey = o.changedAt ? `world:${o.id}:${o.changedAt}` : `world:${o.id}`
    return event({
      source: o.source,
      sourceId: o.id,
      sourceAt: o.at,
      observedAt: o.changedAt ?? observedAt,
      type,
      payload: { id: o.id, text: o.text, at: o.at, data: o.data ?? null },
      dedupeKey,
    })
  })
}

// ── The source shapes the world document never had ───────────────────────────

/**
 * A visit: somewhere he was, from when until when.
 *
 * The DURATION is the whole reason this exists. A point sample says he was at a
 * coordinate at an instant, which supports no question anyone asks — "when do
 * you usually leave", "how long does the shop take", "were you at home all
 * morning" are all questions about intervals. `place` in `ObservationData` has no
 * end field, so none of them was answerable from stored data.
 *
 * `placeKey` is a STRUCTURED identity when the source has one (a maps id, a
 * geofence name) and absent when it does not, in which case entity resolution
 * clusters on the coordinate. That split is the same one `EntityCandidate` makes
 * everywhere: a key resolves, a label accumulates evidence.
 */
export interface VisitInput {
  start: string
  end?: string
  label?: string
  lat?: number
  lon?: number
  placeKey?: string
  /** 'home' | 'work' | 'shop' | … only when the SOURCE said so. Never guessed. */
  category?: string
}

export function visitEvent(v: VisitInput, opts: { source?: string; observedAt?: string } = {}): MemoryEvent {
  const source = opts.source ?? 'location'
  /**
   * The identity of a visit is where and when it STARTED, not its label — a
   * label can be enriched later ("unknown" becoming "Coop") and re-ingesting the
   * same visit under a better name must not create a second one.
   */
  const sourceId = v.placeKey ? `${v.placeKey}@${v.start}` : `${round(v.lat)},${round(v.lon)}@${v.start}`
  return event({
    source,
    sourceId,
    sourceAt: v.start,
    observedAt: opts.observedAt ?? v.end ?? v.start,
    type: 'location.visit',
    payload: v,
  })
}

/**
 * Coordinates rounded to about eleven metres for identity purposes.
 *
 * Four decimal places. GPS jitter on a stationary phone is metres, so an
 * unrounded coordinate would make every arrival at his own kitchen a different
 * place and there would be no such thing as "home". Eleven metres is small
 * enough that two shops on one street stay distinct and large enough that one
 * shop stays one shop. `entities.ts` clusters further on top of this; this is
 * only about not creating a hundred ids for one doorway.
 */
const round = (n?: number): string => (typeof n === 'number' ? n.toFixed(4) : '?')

/**
 * Something he said, as evidence rather than as a setting.
 *
 * `kind` separates a statement about the world ("I'm getting lunch with
 * Bernardo tomorrow") from a statement about himself ("I prefer the train"),
 * because only the second is a durable fact and treating the first as one is how
 * a Tuesday's plan becomes a permanent belief about him.
 */
export function statementEvent(
  text: string,
  at: string,
  kind: 'statement' | 'preference' = 'statement',
  opts: { observedAt?: string } = {}
): MemoryEvent {
  return event({
    source: 'user',
    sourceId: hash(`${kind}:${at}:${text}`),
    sourceAt: at,
    observedAt: opts.observedAt ?? at,
    type: `user.${kind}`,
    payload: { text, kind },
  })
}

/**
 * A recommendation we put on his screen, recorded as an event in his life.
 *
 * It belongs in the ledger for the same reason his own statements do: it
 * happened, we caused it, and the record of what we said is the only thing that
 * makes "he ignores travel advice" checkable rather than a running counter with
 * no history behind it. See `recommendations.ts` for the outcome half and for
 * why it never touches prediction calibration.
 */
export function recommendationEvent(
  recommendationId: string,
  subject: string,
  text: string,
  shownAt: string
): MemoryEvent {
  return event({
    source: 'crucible',
    sourceId: recommendationId,
    sourceAt: shownAt,
    type: 'crucible.recommendation.shown',
    payload: { recommendationId, subject, text },
  })
}
