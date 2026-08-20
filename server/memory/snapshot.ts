/**
 * THE WORLD, COMPUTED — AND THE MIGRATION THAT IS DELIBERATELY NOT A FLAG DAY.
 *
 * §5 is the conceptual centre of this milestone: memory is durable, the world is
 * reconstructed. Everything in this directory has been building toward being able
 * to produce the current picture from evidence rather than accumulating it in a
 * document that can never be regenerated.
 *
 * But `World` is read by the feed, the panes, the prompt, the widgets, the deck
 * and the correction endpoints, and replacing it in one change would mean every
 * one of those surfaces moving at once, on a system whose test suite already
 * fails environmentally more often than it fails really. §22 says so and it is
 * right: the strategy is a COMPATIBILITY LAYER, not a rewrite.
 *
 *     existing consumer  →  World (unchanged)
 *                             ↑
 *                   enrichWorld (this file, additive only)
 *                             ↑
 *                        memory core
 *
 * So there are two functions here and the split is the whole design:
 *
 *   · `worldSnapshot` is the NEW shape. Nothing in the app reads it yet. It is
 *     what a consumer moves ONTO, one at a time, and it exists now so that the
 *     move is a change of read rather than a change of architecture.
 *   · `enrichWorld` writes what the memory core has learned INTO the existing
 *     `Person_`, using the existing types and the existing ownership rule. It
 *     adds and never removes; a world that has never seen the memory core is
 *     unchanged by it, and a consumer that knows nothing about any of this gets
 *     better routines for free.
 *
 * WHAT IS NOT HERE: any write to `World.observations`, `World.beliefs` or
 * `World.profile`. Those are the old substrate and the point of this milestone is
 * to stop growing them. `mutateWorld` remains the only writer of the document and
 * this file does not call it — the caller does, passing the world in, which keeps
 * the transactional discipline in `world.ts` where it already works.
 */

import { dayIn, partsIn } from '../clock.js'
import { addRoutine, mayReplace, readPerson, type Fact, type Person_ } from '../person.js'
import type { World } from '../world.js'
import { routineSentence } from './routines.js'
import { projectFacts } from './facts.js'
import {
  VERSIONS,
  type Anomaly,
  type Entity,
  type Episode,
  type KnowledgeGap,
  type MemoryStore,
  type WorldSnapshot,
} from './types.js'

export interface SnapshotOptions {
  timeZone?: string
  /** How far back an entity or episode counts as "active". */
  activeDays?: number
}

/**
 * THE CURRENT PICTURE, BUILT FROM MEMORY.
 *
 * Nothing persists this and nothing should. It is a read, and being a read is
 * what makes "delete every derived row and rebuild" a supported operation rather
 * than a catastrophe — there is no snapshot to be left stale, because there is no
 * snapshot.
 *
 * "Active" is a window rather than a flag, for the same reason: a flag would have
 * to be maintained by something, and the thing maintaining it would be a second
 * source of truth about whether a person is still in his life.
 */
export function worldSnapshot(store: MemoryStore, now: Date, opts: SnapshotOptions = {}): WorldSnapshot {
  const activeDays = opts.activeDays ?? 45
  const since = new Date(now.getTime() - activeDays * 86_400_000).toISOString()
  const parts = partsIn(now, opts.timeZone)

  const activeEntities = store.entities
    .all()
    .filter((e: Entity) => e.lastObservedAt >= since)
    .sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))

  /**
   * ACTIVE EPISODES ARE THE ONES STILL IN PLAY, not the recent ones.
   *
   * Anything planned or ongoing, plus what has happened in the last few days.
   * A completed episode from March is history and belongs in a query, not in the
   * thing a prompt is handed — which is the distinction the old world document
   * could not make, and the reason `renderWorld` needed a character budget.
   */
  const activeEpisodes = store.episodes
    .all()
    .filter((e: Episode) => e.status === 'planned' || e.status === 'ongoing' || e.startAt >= since)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))

  return {
    generatedAt: now.toISOString(),
    now: {
      instant: now.toISOString(),
      day: dayIn(now, opts.timeZone),
      weekday: parts.weekday,
      timeZone: opts.timeZone,
    },
    activeEntities,
    activeEpisodes,
    routines: store.routines.all().filter((r) => r.status !== 'inactive'),
    // Only what has been tested enough to be worth carrying. A candidate
    // hypothesis in a snapshot is a candidate hypothesis in a prompt.
    hypotheses: store.hypotheses.all().filter((h) => h.status === 'supported' || h.status === 'emerging'),
    predictions: store.predictions.pending(),
    anomalies: [],
    summaries: store.summaries.all(),
    unresolvedQuestions: knowledgeGaps(store, now, opts),
    snapshotVersion: VERSIONS.snapshot,
  }
}

/** The snapshot with today's anomalies folded in, when the caller has computed them. */
export const withAnomalies = (snapshot: WorldSnapshot, anomalies: Anomaly[]): WorldSnapshot => ({
  ...snapshot,
  anomalies,
})

// ── Questions worth asking ───────────────────────────────────────────────────

/**
 * A GAP IS NOT "SOMETHING WE DO NOT KNOW". It is something we do not know that is
 * currently STOPPING a specific piece of reasoning.
 *
 * §26's argument, and the difference between it and an onboarding form is
 * `changesIfAnswered`. A question with an empty list is a question worth not
 * asking, however much curiosity it satisfies — and this returns nothing at all
 * far more often than it returns something, which is the correct behaviour for a
 * system with permission to interrupt.
 *
 * The two gaps here are the two the memory core genuinely produces:
 *
 *   · A ROUTINE THAT HAS SHIFTED. "You have been leaving later on Tuesdays for
 *     about a month — is that deliberate?" is grounded in a detected change with
 *     a magnitude and a date, and the answer changes what is predicted next week.
 *     That is a question no onboarding flow could have thought to ask.
 *   · A PERSON WHO KEEPS APPEARING AND HAS NO STATED RELATIONSHIP. `people.ts`
 *     refuses to infer one and is right to; this is the mechanism by which the
 *     refusal eventually gets resolved instead of standing forever.
 */
function knowledgeGaps(store: MemoryStore, now: Date, opts: SnapshotOptions): KnowledgeGap[] {
  const out: KnowledgeGap[] = []

  for (const h of store.hypotheses.all()) {
    if (h.status !== 'supported') continue
    if (h.proposition.kind !== 'shift') continue
    out.push({
      id: `gap:${h.id}`,
      key: `routine.shift.${h.proposition.routineId}`,
      question: `You have been leaving later since ${h.proposition.since} — about ${Math.round(h.proposition.magnitude)} minutes. Is that deliberate, or has it just been how the last few weeks worked out?`,
      why: 'the departure model is predicting from a level that may or may not be the new normal',
      changesIfAnswered: [
        'whether to predict from the old level or the new one',
        'whether the shift is worth mentioning again',
      ],
      evidence: [{ kind: 'hypothesis', id: h.id, says: `${h.support} of ${h.support + h.contradiction} days since` }],
      confidence: h.confidence,
    })
  }

  /**
   * Someone he keeps seeing whom nothing has named.
   *
   * The threshold is the graph's own `frequently_meets` edge rather than a fresh
   * count, so a question is only asked about somebody the system has already
   * concluded is a recurring part of his life — and `frequently_meets` is a
   * measurement, which is exactly why it cannot answer the question itself.
   */
  const stated = new Set(
    store.relationships
      .all()
      .filter((r) => r.knowledgeKind === 'stated' && !r.retiredAt)
      .map((r) => r.toEntityId)
  )
  for (const rel of store.relationships.all()) {
    if (rel.type !== 'frequently_meets' || rel.retiredAt) continue
    if (stated.has(rel.toEntityId)) continue
    const person = store.entities.byId(rel.toEntityId)
    if (!person) continue
    out.push({
      id: `gap:relationship:${person.id}`,
      key: `relationship.${person.id}`,
      question: `Who is ${person.label} to you?`,
      why: 'they appear repeatedly and nothing has said what the relationship is',
      changesIfAnswered: [
        'whether it is reasonable to draft a message to them',
        'how their events are weighed against work ones',
      ],
      evidence: rel.evidence.slice(-3),
      confidence: rel.confidence,
    })
  }

  void now
  void opts
  return out
}

// ── The compatibility layer ──────────────────────────────────────────────────

export interface EnrichRun {
  routines: string[]
  facts: string[]
  /** Refused by `mayReplace` — what he said, standing against what we measured. */
  refused: { key: string; why: string }[]
}

/**
 * WRITE WHAT THE MEMORY CORE LEARNED INTO THE EXISTING PERSONAL MODEL.
 *
 * ADDITIVE ONLY, and under `mayReplace` throughout. The failure this shape avoids
 * is the one §36 tests for and the one `person.ts` was built to prevent: four
 * months of location data contains dozens of drives to Milan, and a writer that
 * scored evidence would conclude he drives — over the top of "I prefer taking the
 * train", which he typed once and will never type again.
 *
 * `addRoutine` and `setFact` are the existing writers and they are CALLED, not
 * reimplemented. That is not politeness about someone else's code; it is that
 * the ownership rule has exactly one implementation and a second one is a second
 * place for it to be forgotten.
 *
 * The caller passes a `World` and gets a `Person_` back to assign — the write
 * itself belongs inside `mutateWorld`, where the transactional discipline already
 * works, and this file does not go near it.
 */
export function enrichWorld(store: MemoryStore, world: World, now = new Date()): { person: Person_; run: EnrichRun } {
  const person = readPerson(world)
  const run: EnrichRun = { routines: [], facts: [], refused: [] }

  for (const model of store.routines.all()) {
    /**
     * Only rhythms that have earned it. A `candidate` routine in the prompt is a
     * coincidence in the prompt, and the prompt is where a coincidence becomes a
     * sentence somebody reads as fact.
     */
    if (model.status !== 'established' && model.status !== 'weakening') continue
    const label = String(model.context.label ?? model.activityType)
    const { what, cadence } = routineSentence(model, label)

    /**
     * A ROUTINE HE DESCRIBED HIMSELF IS NEVER OVERWRITTEN.
     *
     * `Routine` carries `by`, and `mayReplace` is the same predicate that guards
     * every `Fact`. `addRoutine` merges evidence for one it already holds, so the
     * common path here is enrichment rather than replacement.
     */
    const held = person.routines.find((x) => x.what === what)
    if (held && !mayReplace(asOwned(held.by, held.updatedAt), 'agent')) {
      run.refused.push({ key: what, why: 'he described this routine himself' })
      continue
    }

    addRoutine(person, {
      what,
      cadence,
      basis: model.evidence.map((e) => e.id),
      confidence: model.confidence,
      by: 'agent',
      lastSeen: model.lastObservedAt,
    })
    run.routines.push(`${what}: ${cadence}`)
  }

  const projected = projectFacts(store, person, now)
  run.facts = projected.written
  run.refused.push(...projected.refused)

  return { person, run }
}

/**
 * THE SNAPSHOT AS PROSE, for the day a prompt reads this instead of `renderWorld`.
 *
 * Composed by code, in the same spirit as `renderPerson` and for the same reason:
 * this is a budget, and every sentence in it has to be exactly true. A model
 * writing this paragraph would be a model asserting the contents of the world
 * model, which is the failure `insight.ts` already refuses.
 *
 * Nothing calls this yet. It is here so that the migration's last step — a prompt
 * reading the memory core — is a change of one line rather than a design problem.
 */
export function renderSnapshot(s: WorldSnapshot): string {
  const lines: string[] = []

  if (s.routines.length) {
    lines.push(
      'RHYTHMS I HAVE MEASURED:\n' +
        s.routines
          .filter((r) => r.status === 'established' || r.status === 'weakening')
          .map((r) => {
            const { what, cadence } = routineSentence(r, String(r.context.label ?? r.activityType))
            return `- ${what}: ${cadence} (seen ${r.evidenceCount} times over ${r.temporalCoverageDays} days${r.status === 'weakening' ? ', lately less often' : ''})`
          })
          .join('\n')
    )
  }

  const supported = s.hypotheses.filter((h) => h.status === 'supported')
  if (supported.length) {
    lines.push(
      'PATTERNS THAT HAVE HELD UP:\n' +
        supported
          .map((h) => `- ${describe(h)} — ${h.support} for, ${h.contradiction} against, over ${h.temporalCoverageDays} days`)
          .join('\n')
    )
  }

  if (s.anomalies.length) {
    lines.push('UNUSUAL TODAY:\n' + s.anomalies.map((a) => `- ${a.why}`).join('\n'))
  }

  if (s.unresolvedQuestions.length) {
    lines.push(
      'WHAT I CANNOT SETTLE WITHOUT HIM:\n' +
        s.unresolvedQuestions.map((q) => `- ${q.question} (it decides: ${q.changesIfAnswered.join('; ')})`).join('\n')
    )
  }

  return lines.join('\n\n')
}

/**
 * ASK `mayReplace` ABOUT SOMETHING THAT IS NOT A `Fact`.
 *
 * `Routine` carries the same `by` field as a `Fact` and is governed by the same
 * rule, but it is not one — so the choice is either to duplicate the four lines
 * of `mayReplace` for routines, or to hand it the one field it actually reads.
 * This does the second, and says so, because the duplicate is how the rule ends
 * up applying to facts and not to routines six months from now.
 */
const asOwned = (by: Fact['by'], at: string): Fact => ({
  key: 'routine',
  value: null,
  source: by,
  sourceAt: at,
  updatedAt: at,
  confidence: 1,
  status: by === 'user' ? 'user_provided' : 'inferred',
  by,
})

/** One line for a hypothesis, in the snapshot's own voice. */
function describe(h: WorldSnapshot['hypotheses'][number]): string {
  const p = h.proposition
  if (p.kind === 'shift') return `${p.metric} has moved ${p.direction} by about ${Math.round(p.magnitude)} since ${p.since}`
  if (p.kind === 'cadence_change') return `${p.routineId} has become ${p.direction.replace('_', ' ')}`
  return `on days when ${p.when.metric} is ${p.when.comparator} ${p.when.threshold}, ${p.then.metric} tends to be ${p.then.direction}`
}
