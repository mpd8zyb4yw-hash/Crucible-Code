/**
 * ONE SQL CORE, TWO DRIVERS — AND WHY THAT IS NOT THE SHAPE THE HANDOFF DREW.
 *
 * The handoff asks for `DurableObjectMemoryStore` and `BetterSqliteMemoryStore`
 * as two classes implementing one interface, and then asks for an acceptance
 * test proving the two produce identical cognition. That test is the tell: two
 * implementations of the same thirty queries WILL drift, the drift will be in a
 * predicate nobody looked at, and the test will be the only thing standing
 * between his life and two different versions of it.
 *
 * They do not have to. Both surfaces are SYNCHRONOUS and both speak SQLite:
 *
 *     Durable Object   state.storage.sql.exec(query, ...bindings).toArray()
 *     Mac              db.prepare(query).all(...bindings)
 *
 * So the difference between the hosts is about four lines wide, and everything
 * above those four lines — the schema, the indexes, every query, every repository
 * — is literally the same code running in both places. Parity becomes a property
 * of the construction rather than a claim maintained by a test.
 *
 * The named constructors from the handoff still exist (`durableObjectMemoryStore`,
 * `betterSqliteMemoryStore` in `store.ts`), because that is the API the next
 * engineer will look for. They differ only in which driver they wrap. The parity
 * test is kept anyway and asserts what it can honestly assert — that the same
 * event stream through both drivers yields byte-identical derived state — with
 * the limitation written into its own output rather than into a comment nobody
 * reads.
 *
 * WHY NOT KV, AND WHY NOT THE EXISTING CHUNKED DOCUMENT. `worldRoom.ts` chunks
 * the world model across storage values because a single value has a ceiling, and
 * that is the right answer for a document that must be read whole. The ledger
 * must never be read whole: the point of it is that a year of evidence is queried
 * by time and by type and never loaded. A chunked JSON blob cannot do that at any
 * size, which is the actual argument for SQL here — not that it is tidier.
 */

/** What SQLite hands back and takes. `ArrayBuffer` is here for the DO's blobs. */
export type SqlValue = string | number | null | ArrayBuffer
export type SqlRow = Record<string, SqlValue>

/**
 * The whole host boundary.
 *
 * Synchronous, because both real backends are. An async signature here would
 * force every repository method to be async, which would force every cognitive
 * function to be async, which would make the pure derivation functions — the
 * ones that are testable precisely because they are pure and synchronous —
 * unable to read their own inputs.
 */
export interface SqlDriver {
  /** One statement, positional `?` bindings. Returns rows; empty for writes. */
  exec(query: string, ...bindings: SqlValue[]): SqlRow[]
  /** Run a function with the statements inside it committed or discarded together. */
  transaction?<T>(fn: () => T): T
}

// ── The two hosts ────────────────────────────────────────────────────────────

/** The shape of `state.storage.sql` on a SQLite-backed Durable Object. */
export interface DurableObjectSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, SqlValue>[] }
}

/**
 * The half of `state.storage` this file needs: the SQL surface, and the
 * platform's own synchronous transaction.
 *
 * ONE OBJECT RATHER THAN TWO PARAMETERS, deliberately. Both come off the same
 * `state.storage`, so taking them separately would create a way for a caller to
 * pass the SQL of one object and the transaction of another, or — far more
 * likely — to pass the SQL and forget the transaction, which is precisely the
 * silent, atomicity-losing mistake this whole change is repairing. Asking for
 * the thing they both live on makes that unexpressible.
 */
export interface DurableObjectSqlStorage {
  sql: DurableObjectSql
  /**
   * Optional in the type because a classic-backend object does not have it, and
   * because it is a platform method whose absence must degrade rather than
   * throw. See the driver below for what absence costs.
   */
  transactionSync?<T>(fn: () => T): T
}

/**
 * The edge driver.
 *
 * IT USED TO HAVE NO TRANSACTION, ON THE STRENGTH OF A BELIEF THAT TURNED OUT TO
 * BE HALF TRUE. The argument was: a Durable Object gates its input so no two
 * requests interleave, and writes within one turn are committed together when
 * the turn ends, so a `BEGIN`/`COMMIT` on top would be a second, weaker
 * mechanism claiming to provide what the platform already provides.
 *
 * The first clause is correct and `scripts/edge.mjs` confirms it: eight
 * concurrent appends to one object each land whole. The second clause is not.
 * Measured on workerd, with the throw escaping the object's own handler so the
 * turn genuinely fails:
 *
 *     statement, statement, uncaught throw   →  both statements SURVIVE
 *     the same inside transactionSync        →  both are discarded
 *
 * "Committed together when the turn ends" describes the success path. There is
 * no rollback on the failure path, so a multi-statement operation that throws
 * halfway leaves the database halfway — and the operation that does this in the
 * memory core is `clearDerived`, which empties fifteen tables in sequence. A
 * throw between the fourth and the fifth leaves eleven tables holding rows from
 * the previous algorithm, which the following rebuild then upserts around
 * because every id is content-derived. That is the exact silent corruption
 * `DERIVED_TABLES` exists to prevent, arriving through the floor.
 *
 * So the driver now uses the platform's own transaction, which is synchronous
 * and therefore fits the `SqlDriver` contract unchanged.
 *
 * WHEN IT IS ABSENT the driver runs the function bare, which is what it did
 * before — a classic-backend object has no SQL storage at all, so in practice
 * the only reader of that branch is a test double.
 */
export function durableObjectSqlDriver(storage: DurableObjectSqlStorage | DurableObjectSql): SqlDriver {
  /*
    Accepting the bare SQL surface too, because `scripts/memory.mjs` builds one
    by hand over better-sqlite3 to prove the adapter maps the same statements —
    a shim that has no `transactionSync` and does not need one, since the
    assertion there is about the SQL and the parity test drives the Mac driver
    for everything else.
  */
  const store = 'sql' in storage ? storage : null
  const sql = store ? store.sql : (storage as DurableObjectSql)

  return {
    exec(query, ...bindings) {
      return sql.exec(query, ...bindings).toArray()
    },
    transaction<T>(fn: () => T): T {
      return store?.transactionSync ? store.transactionSync(fn) : fn()
    },
  }
}

/** The `better-sqlite3` surface this uses. Typed structurally so the import stays optional. */
export interface BetterSqliteDb {
  prepare(source: string): { reader: boolean; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
  exec(source: string): unknown
  /**
   * Typed as taking and returning a nullary thunk rather than with
   * `better-sqlite3`'s own generic signature.
   *
   * The real one is `transaction<T extends (...args) => any>(fn: T): T`, and
   * declaring it that way here makes `db.transaction(fn)` infer `T` as `never` at
   * the one call site — the generic has nothing to bind to through the optional
   * property. This is the only shape this file ever calls it with, so it is the
   * shape it asks for. Structural typing means the real database still satisfies
   * it.
   */
  transaction?(fn: () => unknown): () => unknown
  close?(): void
}

/**
 * The Mac driver.
 *
 * `stmt.reader` is `better-sqlite3`'s own answer to "does this statement return
 * rows", and it is asked rather than guessed from the SQL text because
 * `INSERT … RETURNING` exists and a regex over the query string would get it
 * wrong on exactly the statement where being wrong throws.
 */
export function betterSqliteDriver(db: BetterSqliteDb): SqlDriver {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query)
      if (!stmt.reader) {
        stmt.run(...bindings)
        return []
      }
      return stmt.all(...bindings) as SqlRow[]
    },
    transaction<T>(fn: () => T): T {
      if (!db.transaction) return fn()
      return db.transaction(fn)() as T
    },
  }
}

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * THE STORED SHAPE: A KEYED ROW, INDEXED COLUMNS, AND THE RECORD AS JSON.
 *
 * Every table follows one pattern. The columns that exist are the ones something
 * QUERIES ON — a time, a type, a foreign id — and the record itself is a JSON
 * document in `json`. The duplication is deliberate and the direction is fixed:
 * the JSON is the truth and the columns are a projection of it, written by the
 * same function that writes the JSON, so they cannot disagree.
 *
 * The alternative — a fully normalised column per field — was rejected for a
 * specific reason rather than for convenience. These records are still being
 * designed; `Hypothesis.evidenceDiversity` did not exist an hour ago and
 * `Anomaly` will grow a field the first time a domain needs one. A schema that
 * needs a migration for every field is a schema that discourages the design work
 * this milestone is mostly made of, and SQLite's cost for reading a JSON column
 * it does not filter on is a parse we were going to do anyway.
 *
 * What does NOT go in JSON: anything a WHERE clause touches. `events.observed_at`
 * is a real column because the incremental read is `WHERE observed_at > ?`, and
 * that read happening on every reflection cycle is the difference between
 * incremental processing and a full scan pretending to be one.
 */
const SCHEMA_V1: string[] = [
  // ── Ledger ──
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     source_id TEXT NOT NULL,
     source_at TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     type TEXT NOT NULL,
     dedupe_key TEXT NOT NULL UNIQUE,
     ingest_version INTEGER NOT NULL,
     normalized_at TEXT,
     normalize_version INTEGER,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS events_observed ON events (observed_at)`,
  `CREATE INDEX IF NOT EXISTS events_source ON events (source, source_id)`,
  `CREATE INDEX IF NOT EXISTS events_norm ON events (normalize_version, observed_at)`,

  `CREATE TABLE IF NOT EXISTS observations (
     id TEXT PRIMARY KEY,
     event_id TEXT NOT NULL,
     type TEXT NOT NULL,
     /* The sort key: occurredAt, or the interval's start. One column so every
        temporal query is one predicate rather than a COALESCE nobody indexes. */
     at TEXT NOT NULL,
     end_at TEXT,
     actor_entity_id TEXT,
     normalize_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS observations_at ON observations (at)`,
  `CREATE INDEX IF NOT EXISTS observations_type_at ON observations (type, at)`,
  `CREATE INDEX IF NOT EXISTS observations_event ON observations (event_id)`,

  // ── Entities ──
  `CREATE TABLE IF NOT EXISTS entities (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     label TEXT NOT NULL,
     last_observed_at TEXT NOT NULL,
     resolve_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS entities_kind ON entities (kind)`,
  /* Identities and aliases are their own rows rather than a JSON array, because
     they are the one thing looked up BY VALUE — resolution asks "who owns
     email:anna@…" on every observation, and a scan over every entity's JSON to
     answer it is the query that would make ingestion quadratic. */
  `CREATE TABLE IF NOT EXISTS entity_identities (
     identity TEXT PRIMARY KEY,
     entity_id TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS entity_identities_entity ON entity_identities (entity_id)`,
  `CREATE TABLE IF NOT EXISTS entity_aliases (
     alias TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     PRIMARY KEY (alias, entity_id)
   )`,
  `CREATE INDEX IF NOT EXISTS entity_aliases_alias ON entity_aliases (alias)`,

  `CREATE TABLE IF NOT EXISTS relationships (
     id TEXT PRIMARY KEY,
     from_entity_id TEXT NOT NULL,
     to_entity_id TEXT NOT NULL,
     type TEXT NOT NULL,
     knowledge_kind TEXT NOT NULL,
     retired_at TEXT,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS relationships_from ON relationships (from_entity_id)`,
  `CREATE INDEX IF NOT EXISTS relationships_to ON relationships (to_entity_id)`,

  // ── Episodes ──
  `CREATE TABLE IF NOT EXISTS episodes (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     start_at TEXT NOT NULL,
     end_at TEXT,
     status TEXT NOT NULL,
     assembly_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS episodes_start ON episodes (start_at)`,
  `CREATE INDEX IF NOT EXISTS episodes_type_start ON episodes (type, start_at)`,
  /* The join tables exist so "which episodes was Bernardo in" is an index hit
     rather than a JSON scan; the arrays stay on the record as the truth. */
  `CREATE TABLE IF NOT EXISTS episode_observations (
     episode_id TEXT NOT NULL,
     observation_id TEXT NOT NULL,
     PRIMARY KEY (episode_id, observation_id)
   )`,
  `CREATE INDEX IF NOT EXISTS episode_observations_obs ON episode_observations (observation_id)`,
  `CREATE TABLE IF NOT EXISTS episode_entities (
     episode_id TEXT NOT NULL,
     entity_id TEXT NOT NULL,
     role TEXT NOT NULL,
     PRIMARY KEY (episode_id, entity_id, role)
   )`,
  `CREATE INDEX IF NOT EXISTS episode_entities_entity ON episode_entities (entity_id)`,

  // ── Semantic memory ──
  `CREATE TABLE IF NOT EXISTS facts (
     id TEXT PRIMARY KEY,
     subject TEXT NOT NULL,
     predicate TEXT NOT NULL,
     knowledge_kind TEXT NOT NULL,
     by TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS facts_subject ON facts (subject, predicate)`,

  // ── Temporal models ──
  `CREATE TABLE IF NOT EXISTS summaries (
     id TEXT PRIMARY KEY,
     domain TEXT NOT NULL,
     metric TEXT NOT NULL,
     scope TEXT NOT NULL,
     computed_at TEXT NOT NULL,
     model_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS summaries_domain ON summaries (domain, metric)`,

  `CREATE TABLE IF NOT EXISTS routines (
     id TEXT PRIMARY KEY,
     activity_type TEXT NOT NULL,
     status TEXT NOT NULL,
     last_observed_at TEXT NOT NULL,
     model_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS routines_activity ON routines (activity_type)`,
  `CREATE INDEX IF NOT EXISTS routines_seen ON routines (last_observed_at)`,

  // ── Hypotheses ──
  `CREATE TABLE IF NOT EXISTS hypotheses (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     last_evaluated_at TEXT NOT NULL,
     model_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS hypotheses_status ON hypotheses (status, last_evaluated_at)`,

  // ── Predictions ──
  `CREATE TABLE IF NOT EXISTS predictions (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     window_start TEXT NOT NULL,
     window_end TEXT NOT NULL,
     created_at TEXT NOT NULL,
     model_version INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS predictions_due ON predictions (status, window_end)`,
  `CREATE TABLE IF NOT EXISTS prediction_outcomes (
     id TEXT PRIMARY KEY,
     prediction_id TEXT NOT NULL UNIQUE,
     resolved_at TEXT NOT NULL,
     calibration TEXT NOT NULL,
     json TEXT NOT NULL
   )`,

  // ── Recommendations ──
  `CREATE TABLE IF NOT EXISTS recommendations (
     id TEXT PRIMARY KEY,
     subject TEXT NOT NULL,
     shown_at TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS recommendations_shown ON recommendations (shown_at)`,
  `CREATE TABLE IF NOT EXISTS recommendation_outcomes (
     id TEXT PRIMARY KEY,
     recommendation_id TEXT NOT NULL UNIQUE,
     recorded_at TEXT NOT NULL,
     json TEXT NOT NULL
   )`,

  // ── Bookkeeping ──
  `CREATE TABLE IF NOT EXISTS reflection_runs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     started_at TEXT NOT NULL,
     status TEXT NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS reflection_runs_started ON reflection_runs (started_at)`,
  `CREATE TABLE IF NOT EXISTS cursors (
     name TEXT PRIMARY KEY,
     at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
]

/**
 * The migration ladder, in the same spirit as `migrateWorld`: a list of single
 * steps, each assuming the one below it has run.
 *
 * A step is an array of statements rather than one blob because the Durable
 * Object's `exec` takes ONE statement — a semicolon-separated script would fail
 * at the edge and pass on the Mac, which is the exact class of divergence this
 * file's whole design is meant to make impossible.
 */
/**
 * WHAT THE BRAIN THOUGHT ON A PASS, KEPT SO IT CAN BE READ LATER.
 *
 * A second step rather than a line added to `SCHEMA_V1`, because a database that
 * already exists — the one on his Mac, holding real months of his life — has
 * recorded version 1 and would never run an edited version 1. The ladder is the
 * mechanism; this is the first rung it has actually had to carry.
 *
 * Not on `DERIVED_TABLES`. A shadow run is the record of a judgement made at an
 * instant from the model as it stood then, which is the same argument
 * `reflection_runs` is preserved on and the same one that makes predictions
 * replay-sensitive. Rebuilding would not reproduce it; it would overwrite the
 * evidence of what the previous algorithm concluded, which is the one thing a
 * rebuild is usually being run to compare against.
 */
const SCHEMA_V2: string[] = [
  `CREATE TABLE IF NOT EXISTS shadow_runs (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     started_at TEXT NOT NULL,
     status TEXT NOT NULL,
     /* Denormalised out of the JSON because it is the column a review actually
        filters on: "show me the passes that would have said something". */
     surfaced INTEGER NOT NULL,
     json TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS shadow_runs_started ON shadow_runs (started_at)`,
  `CREATE INDEX IF NOT EXISTS shadow_runs_surfaced ON shadow_runs (surfaced, started_at)`,
]

const MIGRATIONS: string[][] = [SCHEMA_V1, SCHEMA_V2]

export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * Bring a database up to `SCHEMA_VERSION`, running only what it is missing.
 *
 * Idempotent, and safe to call on every construction — which it is, because the
 * alternative is remembering to call it, and a Durable Object that has just been
 * created on a new colo has nobody to remember.
 */
export function migrate(driver: SqlDriver): number {
  driver.exec(`CREATE TABLE IF NOT EXISTS memory_schema (version INTEGER NOT NULL)`)
  const rows = driver.exec(`SELECT version FROM memory_schema LIMIT 1`)
  const at = rows.length ? Number(rows[0]!.version) : 0

  for (let v = at; v < MIGRATIONS.length; v++) {
    for (const statement of MIGRATIONS[v]!) driver.exec(statement)
  }

  if (!rows.length) driver.exec(`INSERT INTO memory_schema (version) VALUES (?)`, SCHEMA_VERSION)
  else if (at !== SCHEMA_VERSION) driver.exec(`UPDATE memory_schema SET version = ?`, SCHEMA_VERSION)
  return SCHEMA_VERSION
}

/**
 * Every table holding DERIVED cognition, in the order they must be emptied.
 *
 * The list is here rather than in the replay tool because it has to be updated
 * in the same breath as the schema: a derived table added above and forgotten
 * here would survive a rebuild, and the rebuilt world would silently contain
 * rows from the old algorithm. `events` is deliberately absent — that is the
 * whole point of the operation.
 *
 * `observations` IS derived. It is a reading of the ledger under a versioned
 * normaliser, not a source record, and treating it as durable is how a
 * normalisation improvement becomes unshippable.
 */
export const DERIVED_TABLES = [
  'observations',
  'entities',
  'entity_identities',
  'entity_aliases',
  'relationships',
  'episodes',
  'episode_observations',
  'episode_entities',
  'facts',
  'summaries',
  'routines',
  'hypotheses',
  'predictions',
  'prediction_outcomes',
  'cursors',
] as const

/**
 * THE ONE TABLE THE NAME-LEVEL RULE CANNOT DECIDE, AS A ROW-LEVEL ONE.
 *
 * `facts` is derived and preserved at the same time, which is a thing no list of
 * table names can say. Most of its rows are cognition — `observed` and `inferred`
 * claims a rebuild must recompute, because leaving them would mean the rebuilt
 * world still contained conclusions from the old algorithm. A `stated` row is the
 * opposite: `statedFact` writes it the moment HE types an answer, no source event
 * produces it, and `clearDerived` deleting it is the unrecoverable loss the
 * comment above `clearDerived` says it is choosing against.
 *
 * It was choosing against it in the wrong place. Naming the tables protects a new
 * table that nobody added here; it does nothing for a table that is half his. So
 * the exception is a predicate, on the two columns that already carry ownership:
 * `knowledge_kind` is the epistemic class and `by` is who wrote it, and
 * `setterFor` in `facts.ts` makes `stated` ⇒ `user` by construction. Both are
 * checked, because the guarantee is worth more than the redundancy costs.
 *
 * The value survives a rebuild in `Person_` either way — that is what `mayReplace`
 * is for. What was being destroyed is the EVIDENCE: the observation holding the
 * sentence he actually wrote, and the trace from the claim back to it. Which is
 * the half `writeFact` exists to keep.
 */
export const DERIVED_ROWS: Partial<Record<(typeof DERIVED_TABLES)[number], string>> = {
  facts: `knowledge_kind != 'stated' AND "by" != 'user'`,
}

/**
 * Tables that record what the app DID or what he SAID, which a rebuild must not
 * touch.
 *
 * `recommendations` and `recommendation_outcomes` are the interesting case: they
 * look derived and are not. A recommendation was shown to him, on a screen, at a
 * time — that is an event in the world, and his dismissal of it is his. Wiping
 * them on a rebuild would silently erase the engagement history that
 * `person.ts` learns from, and nothing would ever regenerate it.
 *
 * `reflection_runs` stays for the same reason a build log stays: it is the record
 * of what happened, including the failures a rebuild is trying to explain.
 */
export const PRESERVED_TABLES = ['events', 'recommendations', 'recommendation_outcomes', 'reflection_runs'] as const
