/**
 * "THAT IS WRONG" — AS SOMETHING THE SYSTEM CANNOT FORGET.
 *
 * §16. When he denies a conclusion, three things have to be true afterwards, and
 * only the first is obvious:
 *
 *   1. the claim stops being shown;
 *   2. the claim stops being BELIEVED, which is a different thing and is the one
 *      that "dismiss" implementations always skip;
 *   3. it stays denied through a rebuild.
 *
 * The third is what decides the design. A hypothesis is derived state:
 * `clearDerived` wipes it and the next reflection pass re-derives it from the
 * same evidence, which has not changed — so a rejection written onto the
 * hypothesis row is a rejection with a half-life of one replay. He would deny
 * the same claim, watch it disappear, and meet it again a week later, which is
 * worse than never having offered the button.
 *
 * So the denial is a `stated` FACT. Facts are the one table `clearDerived`
 * preserves by row rather than by name — `knowledge_kind = 'stated' OR by =
 * 'user'` — and `writeFact` will not let any derived path overwrite one. The
 * hypothesis is also rejected immediately, because he should not have to wait
 * for a reflection pass to see his correction take effect; that half is the
 * convenience, and the fact is the guarantee.
 *
 * WHAT THE CORRECTION SENTENCE IS FOR. "The summer bus timetable changed" is not
 * a rating and not a complaint: it is a fact about the world that explains the
 * pattern away, and it is the highest-value input this app can receive. It is
 * kept verbatim on the fact, as an observation in the ledger, so the next pass
 * can see BOTH that the conclusion was denied and why — and so the wording of
 * anything nearby can stop making the same assumption.
 */

import { idOf } from './ids.js'
import { writeFact } from './facts.js'
import type { EvidenceRef, MemoryStore, SemanticFact } from './types.js'

/** The predicate a denial is filed under. One row per denied claim, ever. */
export const DENIAL_PREDICATE = 'user.denies'

/**
 * SUBJECT IS THE CLAIM, NOT HIM.
 *
 * `projectFacts` only projects facts whose subject is `'user'` and whose
 * predicate is `identity.`- or `preferences.`-shaped, so filing a denial against
 * the hypothesis id keeps it out of the personal model — where it would appear
 * as a preference in a settings screen that enumerates them, which it is not.
 */
export interface Denial {
  /** The record he denied: a hypothesis, prediction or anomaly id. */
  claimId: string
  /** What he said, verbatim. Optional — "wrong" alone is a complete correction. */
  because?: string
  at: string
}

/** Has he denied this claim? The read every surfacing path makes. */
export function deniedIds(store: MemoryStore): Set<string> {
  const out = new Set<string>()
  for (const f of store.facts.all()) {
    if (f.predicate === DENIAL_PREDICATE) out.add(f.subject)
  }
  return out
}

/**
 * Record a denial, durably, and retire the claim now.
 *
 * Returns the fact so a caller can show him what was stored rather than
 * asserting that something was — the same argument `applyCorrection` makes about
 * saying back what it actually did.
 */
export function denyClaim(store: MemoryStore, d: Denial): { fact: SemanticFact; retired: boolean } {
  /*
    THE SENTENCE ENTERS THE LEDGER AS EVIDENCE, not only as a field.

    `statedFact` writes the fact and keeps what he said attached to it, which is
    what makes the claim traceable to his words rather than merely asserted to
    have come from him. An `EvidenceRef` of kind `fact` is the class
    `candidates.ts` maps to the `fact` ground voice — "you said" — so a later
    card built on this shows him as its source in his own words.
  */
  const evidence: EvidenceRef[] = d.because
    ? [{ kind: 'fact', id: idOf('obs', `denial:${d.claimId}`), says: d.because }]
    : []

  /*
    THROUGH `writeFact`, NOT `statedFact`, AND THE DIFFERENCE COST A ROW.

    `statedFact` is a convenience that hard-codes `subject: 'user'`, which is
    right for "he prefers the train" and wrong here — the subject of a denial is
    the CLAIM. The first version called it and then re-filed the result under the
    claim id, which left the original `user / user.denies` row behind: a second,
    permanently-preserved fact asserting that he denies something, with no way to
    tell which thing. The host-parity check caught it as a fact table that did not
    match, which is a better outcome than the alternative — it would otherwise
    have accumulated one orphan per correction, forever, in the one table a
    rebuild may not clean.

    `knowledgeKind: 'stated'` still does the two things that matter: `setterFor`
    makes it `by: 'user'`, and `writeFact` refuses to let any derived path
    overwrite it.
  */
  const filed = writeFact(store, {
    subject: d.claimId,
    predicate: DENIAL_PREDICATE,
    value: { claimId: d.claimId, because: d.because ?? null, at: d.at },
    knowledgeKind: 'stated',
    confidence: 1,
    evidence,
    at: d.at,
    note: d.because,
  }).fact

  /*
    AND THE ACTIVE HYPOTHESIS IS RETIRED IMMEDIATELY.

    `rejected` rather than deleted: a hypothesis that was proposed and denied is
    a thing that happened, and the evaluator needs to see that it has been
    settled rather than find no row and propose it again in the same pass.
    Contradiction is incremented too — his denial is a genuine count against the
    proposition, and folding it into `support` instead is how a falsifiable
    record turns into an append-only pile of confirmations.
  */
  const h = store.hypotheses.byId(d.claimId)
  if (h) {
    store.hypotheses.put([
      {
        ...h,
        status: 'rejected',
        contradiction: h.contradiction + 1,
        confidence: 0,
        lastEvaluatedAt: d.at,
        evidence: [...h.evidence, ...evidence],
      },
    ])
    return { fact: filed, retired: true }
  }

  const p = store.predictions.byId(d.claimId)
  if (p) {
    /*
      A DENIED PREDICTION IS `unverifiable`, NOT A MISS.

      This is the calibration boundary and it is worth being exact about: a miss
      is reality disagreeing with the model, and that is the signal calibration
      is FOR. Him saying "that is not what I am doing" is information about the
      claim, not an observation of the outcome, and scoring it as a miss would
      poison the hit rate with evidence about his opinion. The same argument
      `PredictionOutcome` makes for keeping outcomes away from engagement.
    */
    store.predictions.put([{ ...p, status: 'unverifiable' }])
    return { fact: filed, retired: true }
  }

  return { fact: filed, retired: false }
}
