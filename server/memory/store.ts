/**
 * THE REPOSITORIES. One implementation, both hosts — see `sql.ts` for why that
 * is the shape rather than two classes.
 *
 * Everything here is mechanical on purpose. There is no judgement in this file:
 * no filtering, no defaulting, no "helpfully" dropping a row that looks wrong.
 * A store that quietly declines to save something is indistinguishable from a
 * cognition bug, and this milestone has enough places where a thing can go
 * missing without storage being one of them.
 *
 * THE ONE RULE ABOUT COLUMNS. Indexed columns are projected from the record by
 * the same function that serialises it, in the same statement. Nothing writes a
 * column from one value and the JSON from another; a divergence between the two
 * would produce a row that answers a query and then renders as something else.
 */

import type {
  Cursor,
  Entity,
  EntityKind,
  Episode,
  EventRepository,
  EntityRepository,
  EpisodeRepository,
  FactRepository,
  Hypothesis,
  HypothesisRepository,
  HypothesisStatus,
  MemoryEvent,
  MemoryStore,
  NormalizedObservation,
  ObservationRepository,
  ObservationType,
  Prediction,
  PredictionOutcome,
  PredictionRepository,
  RecommendationInstance,
  RecommendationOutcome,
  RecommendationRepository,
  ReflectionRun,
  Relationship,
  RelationshipRepository,
  RoutineModel,
  RoutineRepository,
  RunRepository,
  SemanticFact,
  ShadowRepository,
  ShadowRun,
  SummaryRepository,
  TemporalSummary,
} from './types.js'
import {
  DERIVED_ROWS,
  DERIVED_TABLES,
  SCHEMA_VERSION,
  betterSqliteDriver,
  durableObjectSqlDriver,
  migrate,
  type BetterSqliteDb,
  type DurableObjectSqlStorage,
  type SqlDriver,
  type SqlRow,
  type SqlValue,
} from './sql.js'

/** Rows come back with `json` as TEXT; this is the only place it is parsed. */
const parse = <T>(rows: SqlRow[]): T[] => rows.map((r) => JSON.parse(String(r.json)) as T)
const one = <T>(rows: SqlRow[]): T | null => (rows.length ? (JSON.parse(String(rows[0]!.json)) as T) : null)

/**
 * Write a record and its projected columns in one upsert.
 *
 * Generic over the column list so a new table is a call rather than a copied
 * block of string concatenation. The columns are named once, at the call site,
 * beside the values they come from — which is what stops a reordering from
 * writing `source_at` into `observed_at` and passing every test that reads the
 * JSON back out.
 */
function upsert(driver: SqlDriver, table: string, columns: string[], values: SqlValue[][]): void {
  if (!values.length) return
  const placeholders = columns.map(() => '?').join(', ')
  // Every column but the primary key is refreshed. `id` is column zero by
  // convention here, checked by the fact that every caller passes it first.
  const assignments = columns
    .slice(1)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(${columns[0]}) DO UPDATE SET ${assignments}`
  for (const row of values) driver.exec(sql, ...row)
}

/** Run several statements atomically where the driver can, plainly where it cannot. */
function tx<T>(driver: SqlDriver, fn: () => T): T {
  return driver.transaction ? driver.transaction(fn) : fn()
}

// ── Events ───────────────────────────────────────────────────────────────────

function eventRepository(driver: SqlDriver): EventRepository {
  return {
    /**
     * IDEMPOTENT ON `dedupeKey`, and returning what was actually new.
     *
     * A sync re-reads the same fortnight of calendar every three hours. Without
     * this, the ledger would be mostly duplicates within a day and every
     * frequency count downstream — how often he does a thing, how many times two
     * people met — would be counting syncs rather than life.
     *
     * `DO NOTHING` rather than `DO UPDATE`: the raw event is what the source said
     * at the time it said it, and if the source now says something different that
     * is a NEW event, not a correction to the old one. Overwriting here is how a
     * replay stops being able to reconstruct what was known when.
     */
    append(events) {
      if (!events.length) return []
      return tx(driver, () => {
        const written: string[] = []
        for (const e of events) {
          const existing = driver.exec(`SELECT id FROM events WHERE dedupe_key = ?`, e.dedupeKey)
          if (existing.length) continue
          driver.exec(
            `INSERT INTO events (id, source, source_id, source_at, observed_at, type, dedupe_key,
                                 ingest_version, normalized_at, normalize_version, json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            e.id,
            e.source,
            e.sourceId,
            e.sourceAt,
            e.observedAt,
            e.type,
            e.dedupeKey,
            e.ingestVersion,
            e.normalizedAt ?? null,
            e.normalizeVersion ?? null,
            JSON.stringify(e)
          )
          written.push(e.id)
        }
        return written
      })
    },

    byId(id) {
      return one<MemoryEvent>(driver.exec(`SELECT json FROM events WHERE id = ?`, id))
    },

    /**
     * The incremental read, and the reason `observed_at` is indexed.
     *
     * Strictly greater-than, with the cursor stored as the last FULLY processed
     * instant. Two events sharing an instant are both re-read on the next pass,
     * which is correct: every stage downstream is idempotent, so re-processing
     * costs a little work and skipping one loses an event forever.
     */
    since(after, limit = 5000) {
      return parse<MemoryEvent>(
        driver.exec(`SELECT json FROM events WHERE observed_at > ? ORDER BY observed_at ASC, id ASC LIMIT ?`, after, limit)
      )
    },

    all() {
      return parse<MemoryEvent>(driver.exec(`SELECT json FROM events ORDER BY observed_at ASC, id ASC`))
    },

    needingNormalization(version, limit = 5000) {
      return parse<MemoryEvent>(
        driver.exec(
          `SELECT json FROM events
           WHERE normalize_version IS NULL OR normalize_version < ?
           ORDER BY observed_at ASC, id ASC LIMIT ?`,
          version,
          limit
        )
      )
    },

    /**
     * Bookkeeping written to BOTH the column and the JSON, because the JSON is
     * the record and a replay reads it. A row whose column says normalised and
     * whose document says otherwise is a row that will be normalised twice by one
     * reader and never by another.
     */
    markNormalized(ids, at, version) {
      if (!ids.length) return
      tx(driver, () => {
        for (const id of ids) {
          const held = one<MemoryEvent>(driver.exec(`SELECT json FROM events WHERE id = ?`, id))
          if (!held) continue
          const next: MemoryEvent = { ...held, normalizedAt: at, normalizeVersion: version }
          driver.exec(
            `UPDATE events SET normalized_at = ?, normalize_version = ?, json = ? WHERE id = ?`,
            at,
            version,
            JSON.stringify(next),
            id
          )
        }
      })
    },

    count() {
      const rows = driver.exec(`SELECT COUNT(*) AS n FROM events`)
      return rows.length ? Number(rows[0]!.n) : 0
    },
  }
}

// ── Observations ─────────────────────────────────────────────────────────────

function observationRepository(driver: SqlDriver): ObservationRepository {
  /** The one sort key. See the schema comment on `observations.at`. */
  const atOf = (o: NormalizedObservation): string => o.occurredAt ?? o.interval?.start ?? o.provenance.observedAt

  return {
    put(observations) {
      tx(driver, () =>
        upsert(
          driver,
          'observations',
          ['id', 'event_id', 'type', 'at', 'end_at', 'actor_entity_id', 'normalize_version', 'json'],
          observations.map((o) => [
            o.id,
            o.eventId,
            o.type,
            atOf(o),
            o.interval?.end ?? null,
            o.actorEntityId ?? null,
            o.normalizeVersion,
            JSON.stringify(o),
          ])
        )
      )
    },

    byEvent(eventId) {
      return parse<NormalizedObservation>(
        driver.exec(`SELECT json FROM observations WHERE event_id = ? ORDER BY id ASC`, eventId)
      )
    },

    byId(id) {
      return one<NormalizedObservation>(driver.exec(`SELECT json FROM observations WHERE id = ?`, id))
    },

    /**
     * HALF-OPEN: `at >= start AND at < end`.
     *
     * Chosen once, here, so that "Tuesday" and "Wednesday" cannot both contain
     * the same midnight observation. Every caller in this directory builds its
     * window from `clock.ts`, so a day boundary is always his day boundary and
     * never the runtime's.
     */
    between(startAt, endAt, type) {
      return type
        ? parse<NormalizedObservation>(
            driver.exec(
              `SELECT json FROM observations WHERE type = ? AND at >= ? AND at < ? ORDER BY at ASC, id ASC`,
              type,
              startAt,
              endAt
            )
          )
        : parse<NormalizedObservation>(
            driver.exec(`SELECT json FROM observations WHERE at >= ? AND at < ? ORDER BY at ASC, id ASC`, startAt, endAt)
          )
    },

    ofType(type: ObservationType, limit = 100000) {
      return parse<NormalizedObservation>(
        driver.exec(`SELECT json FROM observations WHERE type = ? ORDER BY at ASC, id ASC LIMIT ?`, type, limit)
      )
    },

    all() {
      return parse<NormalizedObservation>(driver.exec(`SELECT json FROM observations ORDER BY at ASC, id ASC`))
    },

    count() {
      const rows = driver.exec(`SELECT COUNT(*) AS n FROM observations`)
      return rows.length ? Number(rows[0]!.n) : 0
    },
  }
}

// ── Entities ─────────────────────────────────────────────────────────────────

function entityRepository(driver: SqlDriver): EntityRepository {
  return {
    /**
     * The identity and alias rows are REBUILT for the entity being written, not
     * merged into.
     *
     * A merge would leave an identity pointing at an entity that no longer claims
     * it — which is precisely what happens when two entities are folded together
     * and the loser's identities move. Deleting this entity's rows and writing
     * the current set means the lookup table always says what the records say.
     */
    put(entities) {
      if (!entities.length) return
      tx(driver, () => {
        upsert(
          driver,
          'entities',
          ['id', 'kind', 'label', 'last_observed_at', 'resolve_version', 'json'],
          entities.map((e) => [e.id, e.kind, e.label, e.lastObservedAt, e.resolveVersion, JSON.stringify(e)])
        )
        for (const e of entities) {
          driver.exec(`DELETE FROM entity_identities WHERE entity_id = ?`, e.id)
          driver.exec(`DELETE FROM entity_aliases WHERE entity_id = ?`, e.id)
          for (const identity of new Set(e.identities)) {
            driver.exec(
              `INSERT INTO entity_identities (identity, entity_id) VALUES (?, ?)
               ON CONFLICT(identity) DO UPDATE SET entity_id = excluded.entity_id`,
              identity,
              e.id
            )
          }
          for (const alias of new Set(e.aliases.map((a) => a.toLowerCase()))) {
            driver.exec(
              `INSERT INTO entity_aliases (alias, entity_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
              alias,
              e.id
            )
          }
        }
      })
    },

    byId(id) {
      return one<Entity>(driver.exec(`SELECT json FROM entities WHERE id = ?`, id))
    },

    byIdentity(identity) {
      const rows = driver.exec(`SELECT entity_id FROM entity_identities WHERE identity = ?`, identity)
      if (!rows.length) return null
      return one<Entity>(driver.exec(`SELECT json FROM entities WHERE id = ?`, String(rows[0]!.entity_id)))
    },

    ofKind(kind: EntityKind) {
      return parse<Entity>(driver.exec(`SELECT json FROM entities WHERE kind = ? ORDER BY id ASC`, kind))
    },

    all() {
      return parse<Entity>(driver.exec(`SELECT json FROM entities ORDER BY id ASC`))
    },
  }
}

function relationshipRepository(driver: SqlDriver): RelationshipRepository {
  return {
    put(rels) {
      tx(driver, () =>
        upsert(
          driver,
          'relationships',
          ['id', 'from_entity_id', 'to_entity_id', 'type', 'knowledge_kind', 'retired_at', 'json'],
          rels.map((r) => [
            r.id,
            r.fromEntityId,
            r.toEntityId,
            r.type,
            r.knowledgeKind,
            r.retiredAt ?? null,
            JSON.stringify(r),
          ])
        )
      )
    },
    byId(id) {
      return one<Relationship>(driver.exec(`SELECT json FROM relationships WHERE id = ?`, id))
    },
    from(entityId) {
      return parse<Relationship>(
        driver.exec(`SELECT json FROM relationships WHERE from_entity_id = ? ORDER BY id ASC`, entityId)
      )
    },
    all() {
      return parse<Relationship>(driver.exec(`SELECT json FROM relationships ORDER BY id ASC`))
    },
  }
}

// ── Episodes ─────────────────────────────────────────────────────────────────

function episodeRepository(driver: SqlDriver): EpisodeRepository {
  return {
    put(episodes) {
      if (!episodes.length) return
      tx(driver, () => {
        upsert(
          driver,
          'episodes',
          ['id', 'type', 'start_at', 'end_at', 'status', 'assembly_version', 'json'],
          episodes.map((e) => [e.id, e.type, e.startAt, e.endAt ?? null, e.status, e.assemblyVersion, JSON.stringify(e)])
        )
        for (const e of episodes) {
          // Same rebuild-rather-than-merge rule as entity identities: an episode
          // that dropped an observation on reassembly must not keep the join row.
          driver.exec(`DELETE FROM episode_observations WHERE episode_id = ?`, e.id)
          driver.exec(`DELETE FROM episode_entities WHERE episode_id = ?`, e.id)
          for (const o of new Set(e.observationIds)) {
            driver.exec(`INSERT INTO episode_observations (episode_id, observation_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, e.id, o)
          }
          for (const p of new Set(e.participantEntityIds)) {
            driver.exec(`INSERT INTO episode_entities (episode_id, entity_id, role) VALUES (?, ?, 'participant') ON CONFLICT DO NOTHING`, e.id, p)
          }
          for (const p of new Set(e.placeEntityIds)) {
            driver.exec(`INSERT INTO episode_entities (episode_id, entity_id, role) VALUES (?, ?, 'place') ON CONFLICT DO NOTHING`, e.id, p)
          }
        }
      })
    },
    byId(id) {
      return one<Episode>(driver.exec(`SELECT json FROM episodes WHERE id = ?`, id))
    },
    between(startAt, endAt) {
      return parse<Episode>(
        driver.exec(`SELECT json FROM episodes WHERE start_at >= ? AND start_at < ? ORDER BY start_at ASC, id ASC`, startAt, endAt)
      )
    },
    ofType(type) {
      return parse<Episode>(driver.exec(`SELECT json FROM episodes WHERE type = ? ORDER BY start_at ASC, id ASC`, type))
    },
    all() {
      return parse<Episode>(driver.exec(`SELECT json FROM episodes ORDER BY start_at ASC, id ASC`))
    },
    /** Join rows go first, so a crash between the two cannot orphan them. */
    removeBetween(startAt, endAt) {
      return tx(driver, () => {
        const doomed = driver
          .exec(`SELECT id FROM episodes WHERE start_at >= ? AND start_at < ?`, startAt, endAt)
          .map((r) => String(r.id))
        for (const id of doomed) {
          driver.exec(`DELETE FROM episode_observations WHERE episode_id = ?`, id)
          driver.exec(`DELETE FROM episode_entities WHERE episode_id = ?`, id)
          driver.exec(`DELETE FROM episodes WHERE id = ?`, id)
        }
        return doomed.length
      })
    },
  }
}

// ── The rest ─────────────────────────────────────────────────────────────────

function factRepository(driver: SqlDriver): FactRepository {
  return {
    put(facts) {
      tx(driver, () =>
        upsert(
          driver,
          'facts',
          ['id', 'subject', 'predicate', 'knowledge_kind', 'by', 'updated_at', 'json'],
          facts.map((f) => [f.id, f.subject, f.predicate, f.knowledgeKind, f.by, f.updatedAt, JSON.stringify(f)])
        )
      )
    },
    byId(id) {
      return one<SemanticFact>(driver.exec(`SELECT json FROM facts WHERE id = ?`, id))
    },
    bySubject(subject) {
      return parse<SemanticFact>(driver.exec(`SELECT json FROM facts WHERE subject = ? ORDER BY predicate ASC`, subject))
    },
    all() {
      return parse<SemanticFact>(driver.exec(`SELECT json FROM facts ORDER BY id ASC`))
    },
  }
}

function summaryRepository(driver: SqlDriver): SummaryRepository {
  return {
    put(summaries) {
      tx(driver, () =>
        upsert(
          driver,
          'summaries',
          ['id', 'domain', 'metric', 'scope', 'computed_at', 'model_version', 'json'],
          summaries.map((s) => [s.id, s.domain, s.metric, s.scope, s.computedAt, s.modelVersion, JSON.stringify(s)])
        )
      )
    },
    byId(id) {
      return one<TemporalSummary>(driver.exec(`SELECT json FROM summaries WHERE id = ?`, id))
    },
    forDomain(domain) {
      return parse<TemporalSummary>(driver.exec(`SELECT json FROM summaries WHERE domain = ? ORDER BY id ASC`, domain))
    },
    all() {
      return parse<TemporalSummary>(driver.exec(`SELECT json FROM summaries ORDER BY id ASC`))
    },
  }
}

function routineRepository(driver: SqlDriver): RoutineRepository {
  return {
    put(routines) {
      tx(driver, () =>
        upsert(
          driver,
          'routines',
          ['id', 'activity_type', 'status', 'last_observed_at', 'model_version', 'json'],
          routines.map((r) => [r.id, r.activityType, r.status, r.lastObservedAt, r.modelVersion, JSON.stringify(r)])
        )
      )
    },
    byId(id) {
      return one<RoutineModel>(driver.exec(`SELECT json FROM routines WHERE id = ?`, id))
    },
    all() {
      return parse<RoutineModel>(driver.exec(`SELECT json FROM routines ORDER BY id ASC`))
    },
  }
}

function hypothesisRepository(driver: SqlDriver): HypothesisRepository {
  return {
    put(hypotheses) {
      tx(driver, () =>
        upsert(
          driver,
          'hypotheses',
          ['id', 'status', 'last_evaluated_at', 'model_version', 'json'],
          hypotheses.map((h) => [h.id, h.status, h.lastEvaluatedAt, h.modelVersion, JSON.stringify(h)])
        )
      )
    },
    byId(id) {
      return one<Hypothesis>(driver.exec(`SELECT json FROM hypotheses WHERE id = ?`, id))
    },
    withStatus(status: HypothesisStatus) {
      return parse<Hypothesis>(driver.exec(`SELECT json FROM hypotheses WHERE status = ? ORDER BY id ASC`, status))
    },
    all() {
      return parse<Hypothesis>(driver.exec(`SELECT json FROM hypotheses ORDER BY id ASC`))
    },
  }
}

function predictionRepository(driver: SqlDriver): PredictionRepository {
  return {
    put(predictions) {
      tx(driver, () =>
        upsert(
          driver,
          'predictions',
          ['id', 'status', 'window_start', 'window_end', 'created_at', 'model_version', 'json'],
          predictions.map((p) => [
            p.id,
            p.status,
            p.resolutionWindow.start,
            p.resolutionWindow.end,
            p.createdAt,
            p.modelVersion,
            JSON.stringify(p),
          ])
        )
      )
    },
    byId(id) {
      return one<Prediction>(driver.exec(`SELECT json FROM predictions WHERE id = ?`, id))
    },
    /**
     * A prediction is DUE when its window has closed, not when it was made.
     *
     * `window_end <= at` rather than `<`: a window ending at midnight is over at
     * midnight. Resolving a fraction of a second late would be harmless; leaving
     * a prediction pending forever because the boundary was exclusive is the kind
     * of thing that silently stops the calibration loop.
     */
    due(at) {
      return parse<Prediction>(
        driver.exec(
          `SELECT json FROM predictions WHERE status = 'pending' AND window_end <= ? ORDER BY window_end ASC, id ASC`,
          at
        )
      )
    },
    pending() {
      return parse<Prediction>(
        driver.exec(`SELECT json FROM predictions WHERE status = 'pending' ORDER BY window_start ASC, id ASC`)
      )
    },
    all() {
      return parse<Prediction>(driver.exec(`SELECT json FROM predictions ORDER BY created_at ASC, id ASC`))
    },
    putOutcome(outcomes) {
      tx(driver, () =>
        upsert(
          driver,
          'prediction_outcomes',
          ['id', 'prediction_id', 'resolved_at', 'calibration', 'json'],
          outcomes.map((o) => [o.id, o.predictionId, o.resolvedAt, o.calibrationResult, JSON.stringify(o)])
        )
      )
    },
    outcomeFor(predictionId) {
      return one<PredictionOutcome>(
        driver.exec(`SELECT json FROM prediction_outcomes WHERE prediction_id = ?`, predictionId)
      )
    },
    outcomes() {
      return parse<PredictionOutcome>(driver.exec(`SELECT json FROM prediction_outcomes ORDER BY resolved_at ASC, id ASC`))
    },
  }
}

function recommendationRepository(driver: SqlDriver): RecommendationRepository {
  return {
    put(recs) {
      tx(driver, () =>
        upsert(
          driver,
          'recommendations',
          ['id', 'subject', 'shown_at', 'json'],
          recs.map((r) => [r.id, r.subject, r.shownAt, JSON.stringify(r)])
        )
      )
    },
    byId(id) {
      return one<RecommendationInstance>(driver.exec(`SELECT json FROM recommendations WHERE id = ?`, id))
    },
    all() {
      return parse<RecommendationInstance>(driver.exec(`SELECT json FROM recommendations ORDER BY shown_at ASC, id ASC`))
    },
    putOutcome(outcomes) {
      tx(driver, () =>
        upsert(
          driver,
          'recommendation_outcomes',
          ['id', 'recommendation_id', 'recorded_at', 'json'],
          outcomes.map((o) => [o.id, o.recommendationId, o.recordedAt, JSON.stringify(o)])
        )
      )
    },
    outcomeFor(recommendationId) {
      return one<RecommendationOutcome>(
        driver.exec(`SELECT json FROM recommendation_outcomes WHERE recommendation_id = ?`, recommendationId)
      )
    },
    outcomes() {
      return parse<RecommendationOutcome>(
        driver.exec(`SELECT json FROM recommendation_outcomes ORDER BY recorded_at ASC, id ASC`)
      )
    },
  }
}

/**
 * THE SHADOW LOG, WITH A CEILING.
 *
 * The one repository in this file that DELETES on write, and the reason is that a
 * shadow run is the only record here whose size is set by how interesting a pass
 * was rather than by how much of his life it describes. A quarter-hourly cadence
 * is ninety-six passes a day; at a few kilobytes each and no bound, the inspection
 * artifact would outgrow the evidence it exists to explain inside a month.
 *
 * `KEEP` is generous on purpose — a fortnight at the quarter-hourly cadence — for
 * the case this is for: something looks wrong on Home and the question is what the
 * brain was thinking in the passes before it. A bound that only held yesterday
 * would answer that question exactly never.
 */
const SHADOW_KEEP = 1500

function shadowRepository(driver: SqlDriver): ShadowRepository {
  return {
    put(run: ShadowRun) {
      tx(driver, () => {
        upsert(driver, 'shadow_runs', ['id', 'run_id', 'kind', 'started_at', 'status', 'surfaced', 'json'], [
          [
            run.id,
            run.runId,
            run.kind,
            run.startedAt,
            run.status,
            run.candidates.filter((c) => c.surfaced).length,
            JSON.stringify(run),
          ],
        ])
        driver.exec(
          `DELETE FROM shadow_runs WHERE id NOT IN (
             SELECT id FROM shadow_runs ORDER BY started_at DESC, id DESC LIMIT ?
           )`,
          SHADOW_KEEP
        )
      })
    },
    byId(id) {
      return parse<ShadowRun>(driver.exec(`SELECT json FROM shadow_runs WHERE id = ?`, id))[0] ?? null
    },
    recent(limit = 20) {
      return parse<ShadowRun>(
        driver.exec(`SELECT json FROM shadow_runs ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
      )
    },
    /** The passes that would have said something. The short list worth reading. */
    withCandidates(limit = 20) {
      return parse<ShadowRun>(
        driver.exec(
          `SELECT json FROM shadow_runs WHERE surfaced > 0 ORDER BY started_at DESC, id DESC LIMIT ?`,
          limit
        )
      )
    },
  }
}

function runRepository(driver: SqlDriver): RunRepository {
  return {
    put(run: ReflectionRun) {
      tx(driver, () =>
        upsert(driver, 'reflection_runs', ['id', 'kind', 'started_at', 'status', 'json'], [
          [run.id, run.kind, run.startedAt, run.status, JSON.stringify(run)],
        ])
      )
    },
    recent(limit = 20) {
      return parse<ReflectionRun>(
        driver.exec(`SELECT json FROM reflection_runs ORDER BY started_at DESC, id DESC LIMIT ?`, limit)
      )
    },
    cursor(name) {
      const rows = driver.exec(`SELECT name, at, updated_at FROM cursors WHERE name = ?`, name)
      if (!rows.length) return null
      const r = rows[0]!
      return { name: String(r.name), at: String(r.at), updatedAt: String(r.updated_at) } satisfies Cursor
    },
    /**
     * A cursor only ever MOVES FORWARD.
     *
     * Without the guard, a pass that read a smaller window than the one before it
     * would rewind the cursor and everything between would be reprocessed — which
     * is harmless for idempotent stages and not harmless for the counts a
     * `ReflectionRun` reports, which would then describe work that had already
     * been done. Backwards is always a bug, so it is refused rather than obeyed.
     */
    setCursor(name, at, now) {
      const held = driver.exec(`SELECT at FROM cursors WHERE name = ?`, name)
      if (held.length && String(held[0]!.at) >= at) return
      driver.exec(
        `INSERT INTO cursors (name, at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET at = excluded.at, updated_at = excluded.updated_at`,
        name,
        at,
        now
      )
    },
  }
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * The store, over any driver. Migrates on construction — see `migrate`.
 */
export function sqlMemoryStore(driver: SqlDriver): MemoryStore {
  migrate(driver)
  return {
    events: eventRepository(driver),
    observations: observationRepository(driver),
    entities: entityRepository(driver),
    relationships: relationshipRepository(driver),
    episodes: episodeRepository(driver),
    facts: factRepository(driver),
    summaries: summaryRepository(driver),
    routines: routineRepository(driver),
    hypotheses: hypothesisRepository(driver),
    predictions: predictionRepository(driver),
    recommendations: recommendationRepository(driver),
    runs: runRepository(driver),
    shadow: shadowRepository(driver),

    /**
     * THE FIRST HALF OF A REPLAY, and the reason `DERIVED_TABLES` is a constant
     * next to the schema rather than a list built here.
     *
     * Deliberately not "DELETE FROM everything except a hard-coded few": that
     * form silently includes any table added later, which for a table holding
     * something he said would be a data loss with no error. Naming what may be
     * destroyed means a new derived table is invisible to the rebuild until
     * somebody adds it, and a new PRESERVED table is safe by default. The failure
     * direction is chosen: a stale derived row is a bug, a deleted statement of
     * his is unrecoverable.
     *
     * `DERIVED_ROWS` is the second half of that sentence being honoured rather
     * than merely written down. `facts` is on the list and holds his stated
     * answers, so clearing it whole was exactly the unrecoverable loss above —
     * naming tables cannot protect a table that is half his, and a predicate can.
     */
    clearDerived() {
      tx(driver, () => {
        for (const table of DERIVED_TABLES) {
          const keep = DERIVED_ROWS[table]
          driver.exec(keep ? `DELETE FROM ${table} WHERE ${keep}` : `DELETE FROM ${table}`)
        }
        // The ledger's normalisation bookkeeping is derived state living on a
        // preserved row, so it is reset here rather than left claiming that
        // observations exist for events whose observations were just deleted.
        driver.exec(`UPDATE events SET normalized_at = NULL, normalize_version = NULL`)
        for (const e of parse<MemoryEvent>(driver.exec(`SELECT json FROM events`))) {
          if (e.normalizedAt == null && e.normalizeVersion == null) continue
          driver.exec(
            `UPDATE events SET json = ? WHERE id = ?`,
            JSON.stringify({ ...e, normalizedAt: null, normalizeVersion: null }),
            e.id
          )
        }
      })
    },

    schemaVersion() {
      const rows = driver.exec(`SELECT version FROM memory_schema LIMIT 1`)
      return rows.length ? Number(rows[0]!.version) : SCHEMA_VERSION
    },
  }
}

/**
 * THE EDGE STORE. Hand it `state.storage` from a SQLite-backed Durable Object.
 *
 * The world model's Durable Object (`WorldObject`) is already the single
 * authoritative writer for a user, and this belongs in the same object rather
 * than beside it: two objects holding two halves of one life would need a
 * distributed transaction to stay consistent, which is the thing a Durable Object
 * exists to avoid needing.
 *
 * IT TAKES THE STORAGE, NOT `storage.sql`. It used to take the latter, from a
 * time when this driver had no transaction because the platform was believed to
 * roll a failed turn back. It does not — `scripts/edge.mjs` measures it on
 * workerd — so the driver now needs `transactionSync`, which lives on the
 * storage beside the SQL. Taking the object they are both on is what stops a
 * caller passing one and forgetting the other.
 */
export function durableObjectMemoryStore(storage: DurableObjectSqlStorage): MemoryStore {
  return sqlMemoryStore(durableObjectSqlDriver(storage))
}

/** THE MAC STORE. Hand it an open `better-sqlite3` database. */
export function betterSqliteMemoryStore(db: BetterSqliteDb): MemoryStore {
  const store = sqlMemoryStore(betterSqliteDriver(db))
  return { ...store, close: () => db.close?.() }
}
