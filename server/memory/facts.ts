/**
 * SEMANTIC MEMORY, AND THE ONE RULE THAT MAY NOT BE RE-IMPLEMENTED HERE.
 *
 *     An inference may never overwrite something he said.
 *
 * `person.ts` owns that rule. It is `mayReplace`, it is four lines long, and the
 * failure it prevents is invisible: he corrects his travel mode to "bus", the
 * next pass observes three walking routes, re-infers "walk", and his correction
 * is gone with no error anywhere and no way for him to know.
 *
 * The memory core makes that failure MUCH easier to cause, because it is far
 * better at accumulating behavioural evidence than anything before it. Four
 * months of location data contains dozens of drives to Milan. A semantic-fact
 * writer that scored evidence would conclude, correctly and disastrously, that
 * he drives — over the top of "I prefer taking the train", which he typed once.
 *
 * So this file does not have an ownership rule. It CALLS the existing one. Every
 * projection into `Person_` goes through `mayReplace`, and a refusal is recorded
 * rather than swallowed — a fact the memory core believes and the person model
 * refuses is exactly the disagreement worth being able to see.
 *
 * WHY BOTH STORES HOLD IT. `Person_` is what the prompt reads (`renderPerson`),
 * what the correction endpoints write, and what the UI knows about. A fact that
 * lived only in SQL would be invisible to all three. A fact that lived only in
 * `Person_` would have no evidence, no history and no rebuild path. So the
 * memory core holds the evidence-backed record and projects a value into the
 * personal model, one way, under his ownership.
 */

import {
  fact as makeFact,
  getFact,
  mayReplace,
  setFact,
  type Person_,
  type Setter,
} from '../person.js'
import { hash, idOf } from './ids.js'
import {
  STATUS_FOR,
  type EvidenceRef,
  type KnowledgeKind,
  type MemoryStore,
  type SemanticFact,
} from './types.js'

/** `fct:<hash of subject|predicate>`. One row per claim, updated in place. */
export const factId = (subject: string, predicate: string): string => idOf('fct', hash(`${subject}|${predicate}`))

export interface FactWrite {
  subject: string
  predicate: string
  value: unknown
  knowledgeKind: KnowledgeKind
  confidence: number
  evidence?: EvidenceRef[]
  at: string
  note?: string
}

/**
 * Who is allowed to have written something of this kind.
 *
 * The mapping is the whole point of it existing: `stated` is his, everything else
 * is ours. There is no way to write a `stated` fact through the derived path,
 * because `by` is not a parameter — it is a function of `knowledgeKind`, and
 * cognition never produces `stated`.
 */
const setterFor = (kind: KnowledgeKind): Setter => (kind === 'stated' ? 'user' : kind === 'observed' ? 'connector' : 'agent')

/**
 * Record a durable claim in the memory core.
 *
 * `stated` NEVER LOSES TO ANYTHING. The guard is here as well as in the
 * projection because the two stores can be read separately, and a memory core
 * holding "prefers driving" while the personal model holds "prefers the train"
 * is a system that will eventually say both.
 */
export function writeFact(store: MemoryStore, d: FactWrite): { fact: SemanticFact; refused?: string } {
  const id = factId(d.subject, d.predicate)
  const held = store.facts.byId(id)

  if (held?.knowledgeKind === 'stated' && d.knowledgeKind !== 'stated') {
    return {
      fact: held,
      refused: `${d.predicate} is something he stated; ${d.knowledgeKind} evidence may not replace it`,
    }
  }

  const next: SemanticFact = {
    id,
    subject: d.subject,
    predicate: d.predicate,
    value: d.value,
    knowledgeKind: d.knowledgeKind,
    confidence: Math.max(0, Math.min(1, d.confidence)),
    evidence: mergeEvidence(held?.evidence ?? [], d.evidence ?? []),
    by: setterFor(d.knowledgeKind),
    firstObservedAt: held?.firstObservedAt ?? d.at,
    updatedAt: d.at,
    note: d.note ?? held?.note,
  }
  store.facts.put([next])
  return { fact: next }
}

export interface ProjectionRun {
  written: string[]
  /** Refused by `mayReplace`, with the key. The interesting half. */
  refused: { key: string; why: string }[]
}

/**
 * PROJECT SEMANTIC FACTS INTO `Person_`, UNDER HIS OWNERSHIP.
 *
 * The projection is one-directional and narrow. Only facts about him
 * (`subject === 'user'`) with a `preferences.`- or `identity.`-shaped predicate
 * are projected at all — a fact about a place or a person has no home in the
 * personal model and forcing one would put entity data into a map the settings
 * UI enumerates.
 *
 * The refusal path is the reason this returns a report instead of nothing. A
 * silent refusal is indistinguishable from a fact that was never derived, and the
 * one thing worth being able to see is precisely where behaviour disagrees with
 * what he told us.
 */
export function projectFacts(store: MemoryStore, p: Person_, now = new Date()): ProjectionRun {
  const run: ProjectionRun = { written: [], refused: [] }

  for (const f of store.facts.bySubject('user')) {
    const into = f.predicate.startsWith('identity.') ? 'identity' : 'preferences'
    const key = f.predicate
    const held = getFact(p, key)
    const by = setterFor(f.knowledgeKind)

    // The existing rule, called rather than restated. `by: 'user'` is a lock.
    if (!mayReplace(held, by)) {
      run.refused.push({ key, why: `he set ${key} himself; ${f.knowledgeKind} evidence may not replace it` })
      continue
    }

    setFact(
      p,
      into,
      makeFact(key, f.value, {
        source: f.knowledgeKind === 'stated' ? 'user' : 'memory-core',
        status: STATUS_FOR[f.knowledgeKind],
        confidence: f.confidence,
        by,
        sourceAt: f.updatedAt,
        basis: f.evidence.map((e) => e.id),
        note: f.note,
      })
    )
    run.written.push(key)
  }

  p.updatedAt = now.toISOString()
  return run
}

/**
 * Capture something he said as BOTH a fact and its evidence.
 *
 * The pair is the point. `person.ts`'s note on `answers are typed first` is that
 * a new answer writes a `Fact` by `'user'` at the moment of capture; this adds
 * that the sentence itself stays in the ledger as an observation, so the fact can
 * be traced to the words rather than merely asserted to have come from him.
 */
export function statedFact(
  store: MemoryStore,
  d: { predicate: string; value: unknown; at: string; evidence?: EvidenceRef[]; note?: string }
): SemanticFact {
  return writeFact(store, {
    subject: 'user',
    predicate: d.predicate,
    value: d.value,
    knowledgeKind: 'stated',
    confidence: 1,
    evidence: d.evidence,
    at: d.at,
    note: d.note,
  }).fact
}

/** Union, newest last, capped — the same shape as `entities.ts`'s. */
function mergeEvidence(held: EvidenceRef[], next: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  const out: EvidenceRef[] = []
  for (const r of [...held, ...next]) {
    const k = `${r.kind}:${r.id}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out.length <= 24 ? out : [...out.slice(0, 12), ...out.slice(-12)]
}
