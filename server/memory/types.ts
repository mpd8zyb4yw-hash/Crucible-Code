/**
 * MEMORY IS DURABLE; THE WORLD IS RECONSTRUCTED.
 *
 * `world.ts` has been doing two jobs that pull in opposite directions. It is the
 * SNAPSHOT the prompt reads — a current picture, trimmed to a token budget, with
 * the oldest observations dropped out of the render. And it is the ARCHIVE — the
 * one durable record of everything that has ever been seen. Those cannot both be
 * true of one JSON document: the render budget in `renderWorld` exists precisely
 * because the document grew without limit, and the growth exists precisely
 * because the document is the only place history lives.
 *
 * So the substrate splits in two.
 *
 *   · A LEDGER of raw events and typed observations, append-oriented, indexed by
 *     time, which nothing summarises away. It is not read whole, ever.
 *   · Derived cognition — entities, episodes, routines, hypotheses, predictions —
 *     each recording the version of the code that produced it, so that improving
 *     the code means REBUILDING rather than migrating.
 *
 * The world snapshot then becomes a computed thing over both, and `World` stays
 * exactly as it is for as long as it takes to move each consumer across. Nothing
 * in this directory writes to `World`.
 *
 * WHAT THIS FILE IS. The vocabulary, above persistence, shared verbatim between
 * the Mac and the edge. Both hosts run the same repository code over the same
 * schema (see `sql.ts`), so "equivalent cognition on both hosts" is a property of
 * the design rather than a thing tests have to keep re-establishing — but the
 * test exists anyway, because a property nobody checks is a property that stops
 * being true.
 *
 * WHAT IS DELIBERATELY REUSED RATHER THAN REDEFINED. `person.ts` already owns the
 * epistemic vocabulary: who set a value, whether he said it or we worked it out,
 * and the rule that an inference may never overwrite him. `KnowledgeKind` below
 * maps onto that rather than competing with it, and `facts.ts`'s writer refuses
 * exactly what `mayReplace` refuses. Two ownership models over one life is how a
 * correction gets lost.
 */

import type { FactStatus, Setter } from '../person.js'

// ── Provenance and evidence ──────────────────────────────────────────────────

/**
 * How a piece of memory is known.
 *
 * Deliberately the same five words the rest of the app uses, and deliberately
 * ORDERED BY NOTHING. A ranking would invite `Math.max` over two of them, which
 * is how "he told us" quietly loses to "we saw it three times". What matters is
 * that the distinction survives into storage, so a writer can be refused.
 *
 *   'stated'    — he said it. Only he may change it. See `mayReplace`.
 *   'observed'  — a connector reported it and we recorded what it reported.
 *   'derived'   — code computed it from observations. Arithmetic, not judgement.
 *   'inferred'  — we concluded it. Presentable as our conclusion, never as fact.
 *   'predicted' — we expect it. Not yet true, and may never become true.
 */
export type KnowledgeKind = 'stated' | 'observed' | 'derived' | 'inferred' | 'predicted'

/** `person.ts`'s `FactStatus`, for the same claim, so one vocabulary reaches the UI. */
export const STATUS_FOR: Record<KnowledgeKind, FactStatus> = {
  stated: 'user_provided',
  observed: 'verified',
  derived: 'inferred',
  inferred: 'inferred',
  predicted: 'estimated',
}

/** Who put a value here — `person.ts`'s `Setter`, unchanged, so `mayReplace` applies. */
export type { Setter }

/**
 * Where something came from, kept on every record that was not typed by hand.
 *
 * `sourceId` is the id the SOURCE uses, not ours: a Google event id, a message
 * id, a sample identifier. Keeping it is what makes ingestion idempotent without
 * a content hash, and what makes "open this in Gmail" possible from a conclusion
 * five layers downstream of the message.
 */
export interface Provenance {
  /** 'calendar' | 'gmail' | 'health' | 'location' | 'user' | 'crucible' | … */
  source: string
  /** The source's own id for the thing, when it has one. */
  sourceId?: string
  /** When the SOURCE says it happened or was true. */
  sourceAt?: string
  /** When we first recorded it. Ours, never the source's. */
  observedAt: string
}

/**
 * A pointer at the evidence for a claim.
 *
 * Every derived structure carries these and nothing derived may exist without
 * at least one, which is the mechanical form of the rule in §39 of the handoff:
 * a conclusion that cannot be traced to evidence is a conclusion that fails the
 * test rather than one that ships with a caveat.
 */
export interface EvidenceRef {
  kind: 'event' | 'observation' | 'episode' | 'entity' | 'routine' | 'hypothesis' | 'prediction' | 'fact'
  id: string
  /** What this particular piece of evidence contributes, in one clause. */
  says?: string
}

// ── The ledger ───────────────────────────────────────────────────────────────

/**
 * A RAW SOURCE EVENT, kept because cognition will get better and this will not
 * be re-fetchable.
 *
 * Google will not hand back last March's calendar as it stood in March, the
 * phone will not re-emit a location sample, and he will certainly not say the
 * same sentence again. So the payload is stored losslessly, once, and every
 * later improvement to normalisation, entity resolution or episode assembly is
 * applied by REPLAY rather than by migration. That is the whole reason this
 * layer exists as something other than an implementation detail.
 *
 * APPEND-ORIENTED. A correction is a new event, not an edit to an old one. The
 * only field that is ever rewritten is `normalizedAt`/`normalizeVersion`, which
 * is bookkeeping about our own processing rather than about the world.
 */
export interface MemoryEvent {
  /** Deterministic: `evt:<source>:<sourceId>` where there is one. See `eventId`. */
  id: string
  source: string
  /** The source's own identifier. Half of the deduplication key. */
  sourceId: string
  /** ISO instant the thing happened, per the source. */
  sourceAt: string
  /** ISO instant we recorded it. */
  observedAt: string
  /**
   * What kind of record this is, in the source's terms rather than ours:
   * 'calendar.event' | 'gmail.message' | 'health.steps' | 'location.visit' |
   * 'user.statement' | 'crucible.recommendation.shown' | …
   */
  type: string
  /** The payload, verbatim. Stored as JSON; never interpreted by this layer. */
  payload: unknown
  /**
   * The version of the INGESTION contract that wrote this row.
   *
   * Distinct from `normalizeVersion`: this says how the payload was captured,
   * that says how it was read. A payload captured under an older ingestion that
   * dropped a field cannot be repaired by re-normalising, and the difference has
   * to be visible or a replay will quietly conclude the field never existed.
   */
  ingestVersion: number
  /**
   * Deduplication key. Two events with the same key are the same observation of
   * the same thing, however many times a sync re-reads it.
   *
   * Defaults to `<source>:<sourceId>` and is separate from `id` because some
   * sources have no stable id and need a content hash instead — a location
   * sample, a sentence he typed.
   */
  dedupeKey: string
  /** When this event was last normalised, and by which version. Null = never. */
  normalizedAt?: string | null
  normalizeVersion?: number | null
}

/**
 * ONE TYPED THING THAT HAPPENED, with the connector's shape removed.
 *
 * The layer exists because "lunch with Bernardo" arrives four different ways —
 * a calendar row, a sentence in a mail, something he typed, a restaurant visit
 * in the location stream — and every one of them is the same KIND of fact about
 * his life. Without this, episode assembly and routine learning would each have
 * to know the shape of every connector, and adding a connector would mean
 * editing the cognition.
 *
 * DETERMINISTIC BY CONTRACT. Nothing in `normalize.ts` calls a model. A payload
 * maps to observations by code alone, which is what makes replay produce the
 * same answer twice and what keeps a bad generation from rewriting history.
 */
export interface NormalizedObservation {
  /** Deterministic: derived from the event id and the observation's role in it. */
  id: string
  /** The event this was read out of. Always present — an observation with no event is not one. */
  eventId: string
  type: ObservationType
  /** ISO instant, for point-in-time observations. */
  occurredAt?: string
  /** ISO interval, for things with a duration. Either this or `occurredAt`. */
  interval?: { start: string; end?: string }
  /** Resolved entity id, once entity resolution has run. Null until then. */
  actorEntityId?: string | null
  /**
   * Who or what this observation NAMES, before resolution has decided who they
   * are. Kept on the observation rather than resolved in place, because
   * resolution is versioned and re-runnable and this is the input to it.
   */
  entityCandidates?: EntityCandidate[]
  /** The typed payload for this observation type. Shape by convention, not by union — see below. */
  attributes: Record<string, unknown>
  provenance: Provenance
  /** 0..1 — what the EXTRACTION warrants, not how true the underlying thing is. */
  confidence: number
  normalizeVersion: number
}

/**
 * The observation vocabulary.
 *
 * OPEN BY INTENT — a string union rather than a closed enum in the database, so
 * a new connector can contribute a type without a migration, and the cognition
 * that does not understand it simply does not match on it. The named members are
 * the ones something downstream actually reads today.
 */
export type ObservationType =
  /** Something scheduled to happen, with people and possibly a place. */
  | 'planned_meeting'
  /** A message sent or received. */
  | 'communication'
  /** Time spent somewhere. */
  | 'location_visit'
  /** A number a sensor reported for a period. */
  | 'activity_measurement'
  /** Something he said, in his words. */
  | 'user_statement'
  /** Something he said about what he likes or does. */
  | 'preference_statement'
  /** Evidence that two people are connected. NEVER a relationship label itself. */
  | 'relationship_evidence'
  | 'other'

/**
 * Someone or somewhere an observation names, before we have decided who.
 *
 * The three fields are the whole of the anti-overmerge design. `key` is a
 * STRUCTURED identity (an email address, a place id) when the source gave one
 * and null when it did not; `label` is the text as written. A candidate with a
 * key resolves by identity and is safe. A candidate without one — "Bernardo" in
 * a calendar summary — accumulates evidence and may never resolve at all, which
 * is a correct outcome rather than a failure.
 */
export interface EntityCandidate {
  kind: EntityKind
  /** Structured identity, when the source supplied one. Lowercased. */
  key?: string | null
  /** The text as the source wrote it. */
  label: string
  /** How this candidate appeared: 'event-attendee' | 'email-sender' | 'mentioned' | … */
  via: string
  /** 0..1 — how sure we are the label names a real entity of this kind at all. */
  confidence: number
}

// ── Entities and relationships ───────────────────────────────────────────────

export type EntityKind = 'person' | 'place' | 'organization' | 'project'

/**
 * A thing in his life with an identity that outlives any one record.
 *
 * `people.ts` already resolves people from structured records and this does not
 * replace it: for a person with an email address the identity rule here is the
 * SAME rule — the address, lowercased — so the two agree by construction and an
 * entity can be joined to a `Person` without guessing. What this adds is places,
 * organisations, projects, and an evidence-accumulating path for names that
 * arrive with no key at all.
 */
export interface Entity {
  /** Deterministic: `ent:<kind>:<slug of key or canonical label>`. */
  id: string
  kind: EntityKind
  /** The name we use for it. His correction wins; otherwise the source's. */
  label: string
  /** Other names the same thing has appeared under. */
  aliases: string[]
  /**
   * Structured identities that all mean this entity: `email:anna@…`,
   * `place:45.9,9.4`, `gcal:…`. The join key across sources.
   */
  identities: string[]
  /** Kind-specific: coordinates for a place, a domain for an organisation. */
  attributes: Record<string, unknown>
  /** 0..1 that this is a real distinct entity, not that any claim about it is true. */
  confidence: number
  evidence: EvidenceRef[]
  firstObservedAt: string
  lastObservedAt: string
  /** Entity ids folded into this one, kept so a merge can be explained or undone. */
  mergedFrom?: string[]
  by: Setter
  resolveVersion: number
}

/**
 * A typed edge between two entities.
 *
 * THE RULE THAT MATTERS IS `knowledgeKind`. `people.ts` refuses to infer a
 * relationship from an email address or from event attendance, and that refusal
 * has to survive into a graph that is much better at counting co-occurrences
 * than a person is. So the graph is allowed to assert `frequently_meets` from
 * behaviour — that is literally what it measured — and is not allowed to assert
 * `friend`, `family` or `spouse` from anything but him. `RELATIONSHIP_RULES`
 * below is where that is enforced rather than merely described.
 */
export interface Relationship {
  /** Deterministic: `rel:<from>:<type>:<to>`. */
  id: string
  fromEntityId: string
  toEntityId: string
  type: RelationshipType
  knowledgeKind: KnowledgeKind
  confidence: number
  evidence: EvidenceRef[]
  firstObservedAt: string
  lastObservedAt: string
  by: Setter
  /** Set when the edge has stopped being supported. Never deleted silently. */
  retiredAt?: string | null
  note?: string
}

export type RelationshipType =
  // ── Only he may assert these. ──
  | 'spouse'
  | 'family'
  | 'friend'
  | 'colleague'
  | 'household'
  // ── These are measurements, and code may assert them. ──
  | 'member_of'
  | 'works_with'
  | 'frequently_meets'
  | 'frequent_contact'
  | 'associated_with'
  | 'located_at'
  | 'related_to_project'

/**
 * WHICH EDGES BEHAVIOUR IS ALLOWED TO DRAW.
 *
 * The table, not a comment, because the failure it prevents is one line of
 * plausible code: someone appears on nine events, the graph writes `friend`, and
 * the app starts speaking about a work contact as though he were close. Frequency
 * is evidence of frequency. It is not evidence of kinship, affection or trust,
 * and no amount of it ever becomes evidence of those.
 *
 * `stated: true` means the edge exists ONLY when he says so. `demandRelationship`
 * in `people.ts` is how it gets asked; nothing here fills it in meanwhile.
 */
export const RELATIONSHIP_RULES: Record<RelationshipType, { stated: boolean; says: string }> = {
  spouse: { stated: true, says: 'a relationship only he can state' },
  family: { stated: true, says: 'a relationship only he can state' },
  friend: { stated: true, says: 'a relationship only he can state' },
  colleague: { stated: true, says: 'a relationship only he can state' },
  household: { stated: true, says: 'a relationship only he can state' },
  member_of: { stated: false, says: 'membership a source asserted' },
  works_with: { stated: false, says: 'repeated shared work records' },
  frequently_meets: { stated: false, says: 'repeated shared episodes' },
  frequent_contact: { stated: false, says: 'repeated messages both ways' },
  associated_with: { stated: false, says: 'appeared together more than chance' },
  located_at: { stated: false, says: 'observed at this place' },
  related_to_project: { stated: false, says: 'appeared on the same project records' },
}

/** May code assert this edge, or must it wait for him? */
export function mayDerive(type: RelationshipType): boolean {
  return !RELATIONSHIP_RULES[type].stated
}

// ── Episodes ─────────────────────────────────────────────────────────────────

/**
 * A MEANINGFUL STRETCH OF HIS LIFE, assembled from observations that were never
 * connected at the source.
 *
 * The calendar knows there was an event. The location stream knows he was in
 * Dervio. The mail knows Bernardo confirmed. None of the three knows there was a
 * TRIP, and the trip is the thing a person would name. Assembly is what turns
 * four rows into one, and it is versioned because the rule for what belongs
 * together will keep improving.
 *
 * TOLERANT BY DESIGN. Not every observation joins an episode; an episode may sit
 * at `uncertain` indefinitely; a plan that never happened stays `planned` and
 * then `cancelled` rather than being deleted. Forcing unrelated things together
 * to make the timeline look tidy is the failure mode, and the confidence field
 * is what lets assembly decline rather than guess.
 */
export interface Episode {
  /** Deterministic: `epi:<type>:<start day>:<slug>`. */
  id: string
  /** 'meeting' | 'errand' | 'trip' | 'stay' | 'correspondence' | … open. */
  type: string
  startAt: string
  endAt?: string | null
  participantEntityIds: string[]
  placeEntityIds: string[]
  observationIds: string[]
  /** One line, for a person. Written by code; a model may improve the wording only. */
  summary?: string
  attributes: Record<string, unknown>
  confidence: number
  status: 'planned' | 'ongoing' | 'completed' | 'cancelled' | 'uncertain'
  firstAssembledAt: string
  updatedAt: string
  assemblyVersion: number
}

// ── Semantic memory ──────────────────────────────────────────────────────────

/**
 * A durable claim about him, as opposed to a thing that happened.
 *
 * "He prefers the train to Milan" is not an episode and is not a routine; it is
 * a standing fact with an owner. It lives here rather than only in `Person_`
 * because it needs evidence, a history and a rebuild path — but `Person_` stays
 * the surface the prompt and the correction endpoints read, and `facts.ts`
 * projects into it under `mayReplace`. One writer, one ownership rule.
 */
export interface SemanticFact {
  /** Deterministic: `fct:<subject>:<predicate>`. */
  id: string
  /** Whose fact it is: 'user' or an entity id. */
  subject: string
  /** 'prefers.transport.milan', 'relationship', 'home.city'. Namespaced. */
  predicate: string
  value: unknown
  knowledgeKind: KnowledgeKind
  confidence: number
  evidence: EvidenceRef[]
  by: Setter
  firstObservedAt: string
  updatedAt: string
  /** Why it is held, and what would change it. */
  note?: string
}

// ── Temporal models ──────────────────────────────────────────────────────────

/**
 * A BASELINE FOR ONE MEASURABLE THING, in the shape `activity.ts` already proved.
 *
 * `activity.ts` computes current-versus-prior-versus-baseline for steps and does
 * it well; the reason this exists is that nothing else in the app could, so
 * "your Thursdays are unusual" was a sentence only a model could produce and
 * therefore a sentence nobody could check. Generalising the shape is what lets
 * calendar load, departure time and contact cadence be compared the same way,
 * by code, with the arithmetic visible.
 */
export interface TemporalSummary {
  /** Deterministic: `tmp:<domain>:<metric>:<scope>`. */
  id: string
  /** 'calendar' | 'location' | 'people' | 'activity'. */
  domain: string
  /** 'events_per_day' | 'departure_minute' | 'contact_days' | 'steps'. */
  metric: string
  /**
   * What slice this describes: 'all', 'weekday:2', 'entity:ent:person:…'.
   * A summary with no scope is the whole population.
   */
  scope: string
  /** The window measured, as days. */
  windowDays: number
  /** Values in the window, oldest first, with their days. Days with none are absent. */
  samples: { day: string; value: number }[]
  count: number
  mean: number | null
  median: number | null
  stdDev: number | null
  /** The same statistics over the window immediately before this one. */
  priorMean: number | null
  changePercent: number | null
  direction: 'up' | 'down' | 'flat' | 'unknown'
  /**
   * The day a sustained level change begins, when one is detectable.
   *
   * Distinct from `direction`, and the distinction is the product: a drifting
   * average and a step change look the same in a percentage and mean completely
   * different things. "Your Tuesdays moved later six weeks ago" is only sayable
   * because this field exists.
   */
  changePoint?: { day: string; before: number; after: number; magnitude: number } | null
  computedAt: string
  modelVersion: number
}

/**
 * SOMETHING HE DOES ON A RHYTHM, AS DISTRIBUTIONS RATHER THAN AS A PHRASE.
 *
 * `person.ts` already has a `Routine`, and its `cadence` is free text — "most
 * weekday evenings" — which is exactly right for the prompt and useless for
 * arithmetic. Nothing can ask a sentence whether 12:30 on a Saturday with no
 * grocery trip is unusual. This is the same concept with the numbers kept, and
 * the two are joined rather than duplicated: `routines.ts` writes both, so the
 * prompt keeps reading the phrase it always read.
 */
export interface RoutineModel {
  /** Deterministic: `rtn:<activityType>:<scope>`. */
  id: string
  /** What is done: 'grocery', 'departure', 'meeting-with:<entity>'. Open. */
  activityType: string
  /** Entities that are part of the routine's identity, when any are. */
  entityRefs: string[]
  temporal: {
    /** 0=Sunday…6. Absent when the rhythm is not weekly. */
    daysOfWeek?: number[]
    /**
     * P(it happens | one of those days arrives), measured, not asserted.
     *
     * The denominator is the number of qualifying days IN THE OBSERVED WINDOW,
     * which is why a routine cannot reach high probability from a short history:
     * three Saturdays out of three is 1.0 with an evidence count of 3, and the
     * confidence field — not this one — is what stops that being believed.
     */
    recurrenceProbability: number
    /** Minutes past local midnight, in HIS zone. Never UTC. */
    typicalStartMinutes?: number
    startStdDevMinutes?: number
    typicalDurationMinutes?: number
    durationStdDevMinutes?: number
    /** For rhythms that are not weekly: the median gap between occurrences. */
    intervalDaysMedian?: number
  }
  context: Record<string, unknown>
  confidence: number
  evidenceCount: number
  /** How many distinct days the evidence spans. A week of evidence is not a routine. */
  temporalCoverageDays: number
  evidence: EvidenceRef[]
  firstObservedAt: string
  lastObservedAt: string
  status: 'candidate' | 'emerging' | 'established' | 'weakening' | 'inactive'
  modelVersion: number
}

// ── Hypotheses ───────────────────────────────────────────────────────────────

/**
 * A CANDIDATE EXPLANATION THAT HAS NOT EARNED FACT STATUS.
 *
 * The reason this is a separate type rather than a low-confidence fact: a fact
 * gets more or less certain, a hypothesis gets SUPPORTED OR CONTRADICTED, and
 * only the second can be wrong in a way that is worth recording. Storing
 * contradiction separately from support is what makes a hypothesis falsifiable
 * instead of an append-only pile of confirmations — which is what "confidence
 * went up again" always is when the only thing counted is agreement.
 */
export interface Hypothesis {
  /** Deterministic: `hyp:<proposition kind>:<subject>:<object>`. */
  id: string
  proposition: TypedProposition
  /** Occasions the proposition predicted correctly. */
  support: number
  /** Occasions it predicted wrongly. Never folded into `support`. */
  contradiction: number
  observationCount: number
  /**
   * How many INDEPENDENT kinds of evidence bear on it.
   *
   * Six calendar rows are one kind of evidence six times. A calendar row, a
   * location visit and something he said are three. The difference is the whole
   * difference between a correlation inside one connector's quirks and a pattern
   * in his life, and it is why the promotion rule below counts this and not just
   * `observationCount`.
   */
  evidenceDiversity: number
  temporalCoverageDays: number
  confidence: number
  firstObservedAt: string
  lastObservedAt: string
  status: HypothesisStatus
  evidence: EvidenceRef[]
  /** Other hypotheses that explain the same observations differently. */
  alternatives: string[]
  lastEvaluatedAt: string
  modelVersion: number
}

export type HypothesisStatus = 'candidate' | 'emerging' | 'supported' | 'weakening' | 'rejected'

/**
 * WHAT A HYPOTHESIS ACTUALLY CLAIMS, as structure rather than as a sentence.
 *
 * A sentence cannot be tested. This can: each variant names the fields an
 * evaluator needs to go and check, and the wording is generated from it at the
 * end rather than being the thing that is stored. It is also what keeps the
 * causal claim out of reach — there is an `association` variant and there is no
 * `causation` variant, and adding one would mean writing an evaluator that can
 * actually establish it.
 */
export type TypedProposition =
  /** "On days when A, B tends to be lower/higher." */
  | {
      kind: 'association'
      /** The condition, as a computable predicate name and its argument. */
      when: { metric: string; comparator: 'above' | 'below'; threshold: number; scope?: string }
      /** What is measured on those days. */
      then: { metric: string; direction: 'lower' | 'higher'; scope?: string }
    }
  /** "This routine's timing has shifted." */
  | {
      kind: 'shift'
      routineId: string
      metric: string
      direction: 'later' | 'earlier' | 'more' | 'less'
      /** The day the shift appears to begin. */
      since: string
      magnitude: number
    }
  /** "This routine is weakening / has stopped." */
  | { kind: 'cadence_change'; routineId: string; direction: 'less_frequent' | 'more_frequent'; magnitude: number }

// ── Predictions ──────────────────────────────────────────────────────────────

/**
 * A FALSIFIABLE STATEMENT ABOUT WHAT HAPPENS NEXT, with a window in which it can
 * be checked.
 *
 * The point is not to tell him what is going to happen. It is that an assistant
 * which commits to an expectation can MEASURE ITS OWN ERROR, and prediction
 * error is a far better place to spend attention than a language model asked to
 * find something interesting in an entire life. Everything Crucible knows is in
 * the model that produced the expectation, so a miss is informative in a way
 * that a scan over raw data never is.
 */
export interface Prediction {
  /** Deterministic: `prd:<target kind>:<subject>:<window start>`. */
  id: string
  target: TypedPredictionTarget
  createdAt: string
  resolutionWindow: { start: string; end: string }
  /** What we expect. Shape depends on the target. */
  expected: unknown
  probability?: number
  /** For numeric targets, the interval we would accept as correct. */
  interval?: { lower: number; upper: number }
  evidence: EvidenceRef[]
  /** Which routines/summaries/hypotheses produced it, by id. */
  modelBasis: string[]
  confidence: number
  status: 'pending' | 'resolved' | 'expired' | 'unverifiable'
  modelVersion: number
}

export type TypedPredictionTarget =
  /** "A grocery episode will occur on Saturday." */
  | { kind: 'episode_occurs'; activityType: string; day: string }
  /** "He will leave home between 10:00 and 11:00." */
  | { kind: 'timing'; metric: string; day: string; scope?: string }
  /** "Steps will be below his Thursday baseline." */
  | { kind: 'measure'; metric: string; day: string; scope?: string }

/**
 * WHAT ACTUALLY HAPPENED, and how wrong we were.
 *
 * Kept apart from anything he did, deliberately and permanently. He does not
 * have to interact with a prediction for it to be resolved — reality resolves
 * it — and treating a miss as though he had rejected something would poison the
 * engagement model with evidence about the weather. See `RecommendationOutcome`.
 */
export interface PredictionOutcome {
  /** Deterministic: `pro:<predictionId>`. One outcome per prediction, ever. */
  id: string
  predictionId: string
  observedReality: unknown
  resolvedAt: string
  /** In the target's units, signed: observed − expected. Absent for non-numeric targets. */
  error?: number | null
  calibrationResult: 'correct' | 'partially_correct' | 'incorrect' | 'unverifiable'
  evidence: EvidenceRef[]
}

// ── Recommendations ──────────────────────────────────────────────────────────

/**
 * ONE TIME WE SUGGESTED SOMETHING, and what he did about it.
 *
 * `person.ts` already learns from accept/dismiss counts per subject, bounded so
 * behaviour can never overrule a stated preference. That system stays exactly as
 * it is; this sits UNDERNEATH it, holding the individual occasions, because a
 * running count cannot answer "which of these did he ignore and why" and cannot
 * be replayed. `recommendations.ts` aggregates back into the existing counters
 * rather than beside them.
 */
export interface RecommendationInstance {
  id: string
  /** The `fitOf`/`not-relevant` vocabulary: 'travel', 'fitness', … */
  subject: string
  recommendation: string
  context: EvidenceRef[]
  /** Ids of the hypotheses, routines or predictions that argued for it. */
  reasoningRefs: string[]
  shownAt: string
  /** The attention scores it was shown with, so a bad call can be attributed to an axis. */
  attentionScore?: unknown
}

export interface RecommendationOutcome {
  id: string
  recommendationId: string
  opened?: boolean
  dismissed?: boolean
  accepted?: boolean
  actedOn?: boolean
  userFeedback?: string
  observedResult?: unknown
  recordedAt: string
}

// ── Reflection bookkeeping ───────────────────────────────────────────────────

/**
 * One consolidation pass, recorded whether it worked or not.
 *
 * A failed reflection that leaves no trace is indistinguishable from one that
 * found nothing, and those need opposite responses. `cursor` is what makes the
 * next pass incremental: full replay is for tests and rebuilds, never for the
 * ordinary run.
 */
export interface ReflectionRun {
  id: string
  kind: 'ingest' | 'short' | 'daily' | 'weekly' | 'rebuild'
  startedAt: string
  finishedAt?: string | null
  status: 'running' | 'ok' | 'failed'
  /** What it did, in counts. Written even on failure, for the part that got through. */
  counts: Record<string, number>
  /** Considered and not surfaced, in the same spirit as `InsightRun.notes`. */
  notes: string[]
  error?: string | null
}

// ── The shadow log ───────────────────────────────────────────────────────────

/**
 * WHY SOMETHING TRUE DID NOT REACH A SCREEN.
 *
 * The vocabulary lives here with the other record types rather than beside the
 * gate that produces it, for the ordinary reason: `ShadowRun` stores these, the
 * store contract names `ShadowRun`, and a type flowing the other way would make
 * `types.ts` depend on a scoring rule. `significance.ts` imports it from here.
 *
 * A union rather than a sentence because §29's developer view has to be able to
 * COUNT these. "Nine of eleven candidates were suppressed as `too-small`" is a
 * statement about a threshold being wrong; nine different prose reasons are a
 * statement about nothing.
 */
export type SuppressionReason =
  | 'thin-evidence'
  | 'no-information'
  | 'too-small'
  | 'not-actionable'
  | 'already-on-screen'
  | 'said-recently'
  | 'below-rank'

/** An id and what it is, so a log reads without a second lookup. */
export interface Ref {
  id: string
  says: string
}

export interface HypothesisDelta extends Ref {
  supportAdded: number
  contradictionAdded: number
  confidenceDelta: number
  /** `emerging → supported`, or absent when only the numbers moved. */
  statusChange?: string
}

export interface CandidateRecord extends Ref {
  source: 'anomaly' | 'explained_anomaly' | 'hypothesis' | 'prediction'
  score: number
  surfaced: boolean
  reason?: SuppressionReason
  why: string
  informationBits?: number
  /** The evidence chain's top rows. §39 — a card that cannot cite is not a card. */
  grounds: { kind: string; id: string; says: string }[]
}

/**
 * ONE PASS OF COGNITION, AS SOMETHING A PERSON CAN READ.
 *
 * Every array is a delta against the state before the pass, except `anomalies`
 * and `candidates`, which are per-pass by nature — an anomaly is detected fresh
 * each cycle and a candidate is a judgement made at an instant.
 *
 * Deliberately NOT on `DERIVED_TABLES`: this is the record of what the model
 * concluded when it stood as it did, which a rebuild cannot reproduce and is
 * usually the thing a rebuild is being compared against.
 */
export interface ShadowRun {
  id: string
  /** The `ReflectionRun` this wrapped. The two are always written together. */
  runId: string
  kind: ReflectionRun['kind']
  startedAt: string
  finishedAt: string
  status: ReflectionRun['status']
  error?: string | null
  /** The derivation versions in force. A delta across a version bump is not news. */
  versions: Record<string, number>
  counts: Record<string, number>
  inputEvents: number

  entities: { added: Ref[]; notEntities: string[] }
  episodes: { opened: Ref[]; updated: Ref[]; closed: Ref[] }
  routines: { emerging: Ref[]; strengthened: Ref[]; weakened: Ref[]; inactive: Ref[]; rejected: string[] }
  hypotheses: HypothesisDelta[]
  predictions: {
    created: Ref[]
    resolved: { id: string; says: string; result: string; error?: number }[]
    /** Hit rate and mean signed error, after this pass folded its resolutions in. */
    calibration: { samples: number; hitRate: number; meanError: number } | null
    declined: string[]
  }
  anomalies: Ref[]
  candidates: CandidateRecord[]
  /** Which sections of the generated `WorldSnapshot` changed size, and by how much. */
  snapshotDelta: Record<string, number>
  notes: string[]
}

/** Where incremental processing got to. One row per named cursor. */
export interface Cursor {
  name: string
  /** The last event `observedAt` fully processed. Time, not id, so ties re-run. */
  at: string
  updatedAt: string
}

// ── The world, computed ──────────────────────────────────────────────────────

/**
 * THE CURRENT PICTURE, REBUILT FROM MEMORY RATHER THAN ACCUMULATED IN A FILE.
 *
 * Nothing persists this. It is produced on demand from the ledger and the
 * derived tables, which is what makes "delete every derived row and rebuild"
 * a supported operation rather than a catastrophe. `World` remains the thing the
 * app's existing surfaces read; `snapshot.ts` maps between them so consumers move
 * across one at a time.
 */
export interface WorldSnapshot {
  generatedAt: string
  now: {
    instant: string
    /** His day and his weekday, in his zone. Never the runtime's. */
    day: string
    weekday: number
    timeZone?: string
  }
  activeEntities: Entity[]
  activeEpisodes: Episode[]
  routines: RoutineModel[]
  hypotheses: Hypothesis[]
  predictions: Prediction[]
  anomalies: Anomaly[]
  summaries: TemporalSummary[]
  unresolvedQuestions: KnowledgeGap[]
  snapshotVersion: number
}

/**
 * SOMETHING DEPARTED FROM WHAT WAS EXPECTED.
 *
 * An anomaly is EVIDENCE, not an insight, and the type says so by carrying the
 * expectation alongside the observation. A deviation with no stated expectation
 * is just a number, and a number is what a model turns into a confident sentence
 * about nothing. Nothing here reaches a screen until it has been through
 * `attention.ts` like everything else.
 */
export interface Anomaly {
  id: string
  kind:
    | 'routine_missed'
    | 'routine_timing'
    | 'baseline_deviation'
    | 'change_point'
    | 'contact_cadence'
    | 'prediction_miss'
  /** What it is about, in the domain's terms. */
  subject: string
  day: string
  expected: number | string | null
  observed: number | string | null
  /** How far out, in the metric's own units. Always positive. */
  magnitude: number
  /** Why this counts as unusual, in one clause, from the arithmetic. */
  why: string
  confidence: number
  evidence: EvidenceRef[]
}

/**
 * A QUESTION WORTH ASKING, because something concrete cannot be settled without
 * the answer.
 *
 * `person.ts`'s `demands` is the same idea one layer up and this feeds it rather
 * than competing: a gap here becomes a demand there, so the existing question
 * ranking decides whether it is ever put to him. What this adds is that the gap
 * came from a MODEL AMBIGUITY — a routine that changed and might have changed on
 * purpose — rather than from an onboarding checklist.
 */
export interface KnowledgeGap {
  id: string
  /** The `SLOTS` key or a new namespaced one. */
  key: string
  question: string
  /** What is blocked on it. */
  why: string
  /** What we would do differently depending on the answer. Empty = do not ask. */
  changesIfAnswered: string[]
  evidence: EvidenceRef[]
  confidence: number
}

// ── The store contract ───────────────────────────────────────────────────────

/**
 * WHAT COGNITION IS ALLOWED TO ASK OF STORAGE.
 *
 * Narrow on purpose. Every method here is either an idempotent upsert or a query
 * with an index behind it — there is no "give me everything" except the explicit
 * replay reader, because the moment cognition can read the whole ledger cheaply
 * it will, and the incremental design dies quietly.
 */
export interface MemoryStore {
  events: EventRepository
  observations: ObservationRepository
  entities: EntityRepository
  relationships: RelationshipRepository
  episodes: EpisodeRepository
  facts: FactRepository
  summaries: SummaryRepository
  routines: RoutineRepository
  hypotheses: HypothesisRepository
  predictions: PredictionRepository
  recommendations: RecommendationRepository
  runs: RunRepository
  /** What each pass concluded and what it threw away. Inspection, never a read path. */
  shadow: ShadowRepository
  /** Drop every derived row, keep the ledger. The first half of a replay. */
  clearDerived(): void
  /** Which schema version the underlying database is at. */
  schemaVersion(): number
  close?(): void
}

export interface EventRepository {
  /** Idempotent on `dedupeKey`. Returns the ids actually written. */
  append(events: MemoryEvent[]): string[]
  byId(id: string): MemoryEvent | null
  /** Events with `observedAt > after`, oldest first. The incremental read. */
  since(after: string, limit?: number): MemoryEvent[]
  /** Every event, oldest first. FOR REPLAY AND TESTS ONLY. */
  all(): MemoryEvent[]
  /** Events not yet normalised at `version`, oldest first. */
  needingNormalization(version: number, limit?: number): MemoryEvent[]
  markNormalized(ids: string[], at: string, version: number): void
  count(): number
}

export interface ObservationRepository {
  put(observations: NormalizedObservation[]): void
  byEvent(eventId: string): NormalizedObservation[]
  byId(id: string): NormalizedObservation | null
  /** In a time window, optionally of one type. The workhorse query. */
  between(startAt: string, endAt: string, type?: ObservationType): NormalizedObservation[]
  ofType(type: ObservationType, limit?: number): NormalizedObservation[]
  all(): NormalizedObservation[]
  count(): number
}

export interface EntityRepository {
  put(entities: Entity[]): void
  byId(id: string): Entity | null
  /** By a structured identity string, which is how resolution joins sources. */
  byIdentity(identity: string): Entity | null
  ofKind(kind: EntityKind): Entity[]
  all(): Entity[]
}

export interface RelationshipRepository {
  put(rels: Relationship[]): void
  byId(id: string): Relationship | null
  from(entityId: string): Relationship[]
  all(): Relationship[]
}

export interface EpisodeRepository {
  put(episodes: Episode[]): void
  byId(id: string): Episode | null
  between(startAt: string, endAt: string): Episode[]
  ofType(type: string): Episode[]
  all(): Episode[]
  /**
   * Clear a window before reassembling it.
   *
   * THE ONE DESTRUCTIVE METHOD IN THE STORE, and it exists because an episode's
   * id is a function of what is in it. Add a fifth observation to a four-part
   * episode and the id moves, so an upsert alone would leave the four-part
   * version behind as a ghost with the same evidence — two episodes where his
   * life had one. Assembly is therefore defined per day: clear the day, write
   * what the day now assembles to. That is also what makes reassembly and a
   * from-scratch rebuild produce identical rows, which is what §34 asserts.
   */
  removeBetween(startAt: string, endAt: string): number
}

export interface FactRepository {
  put(facts: SemanticFact[]): void
  byId(id: string): SemanticFact | null
  bySubject(subject: string): SemanticFact[]
  all(): SemanticFact[]
}

export interface SummaryRepository {
  put(summaries: TemporalSummary[]): void
  byId(id: string): TemporalSummary | null
  forDomain(domain: string): TemporalSummary[]
  all(): TemporalSummary[]
}

export interface RoutineRepository {
  put(routines: RoutineModel[]): void
  byId(id: string): RoutineModel | null
  all(): RoutineModel[]
}

export interface HypothesisRepository {
  put(hypotheses: Hypothesis[]): void
  byId(id: string): Hypothesis | null
  withStatus(status: HypothesisStatus): Hypothesis[]
  all(): Hypothesis[]
}

export interface PredictionRepository {
  put(predictions: Prediction[]): void
  byId(id: string): Prediction | null
  /** Pending predictions whose window has closed by `at`. The resolution queue. */
  due(at: string): Prediction[]
  pending(): Prediction[]
  all(): Prediction[]
  putOutcome(outcomes: PredictionOutcome[]): void
  outcomeFor(predictionId: string): PredictionOutcome | null
  outcomes(): PredictionOutcome[]
}

export interface RecommendationRepository {
  put(recs: RecommendationInstance[]): void
  byId(id: string): RecommendationInstance | null
  all(): RecommendationInstance[]
  putOutcome(outcomes: RecommendationOutcome[]): void
  outcomeFor(recommendationId: string): RecommendationOutcome | null
  outcomes(): RecommendationOutcome[]
}

export interface ShadowRepository {
  /** Writes, then trims to the log's ceiling. The one repository that deletes. */
  put(run: ShadowRun): void
  byId(id: string): ShadowRun | null
  recent(limit?: number): ShadowRun[]
  /** Only the passes that would have said something. The short list worth reading. */
  withCandidates(limit?: number): ShadowRun[]
}

export interface RunRepository {
  put(run: ReflectionRun): void
  recent(limit?: number): ReflectionRun[]
  cursor(name: string): Cursor | null
  setCursor(name: string, at: string, now: string): void
}

// ── Versions ─────────────────────────────────────────────────────────────────

/**
 * THE VERSION OF EACH DERIVATION, STORED ON EVERY ROW IT PRODUCES.
 *
 * Bumping one of these is the supported way to change how something is derived:
 * the replay tooling re-runs exactly the stages whose version has moved, and a
 * row still carrying the old number is visibly stale rather than silently wrong.
 * Nothing infers a version from a timestamp — a rebuild and an improvement look
 * identical in a clock and completely different here.
 */
export const VERSIONS = {
  ingest: 1,
  normalize: 1,
  resolve: 1,
  assemble: 1,
  temporal: 1,
  routine: 1,
  hypothesis: 1,
  prediction: 1,
  snapshot: 1,
} as const
