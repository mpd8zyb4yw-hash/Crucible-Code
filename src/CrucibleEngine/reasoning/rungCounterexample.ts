// ═══════════════════════════════════════════════════════════════════════════════
// RUNG COUNTEREXAMPLES — turn a failed mechanical composition into proof that a helper is wrong.
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE MEASUREMENT (2026-08-02c). Re-running every certified helper against held-out cases it never
// saw: **5 of 12 were not the intended function**. `nextUnquotedComma` certified 6/6 against its own
// examples in five of six draws and was wrong in all five — always the same defect, `('a,,b', 0)`
// returning 2 instead of 1. Its shown cases test `'a,,b'` only from=2, so nothing in the loop could
// see it. The correlation with outcome was exact: every draw whose helper generalised SOLVED (6
// calls, 20.6s, composed mechanically at zero model calls); every draw whose helper was overfit
// failed no matter what tried to compose it.
//
// So "certified" means "satisfies 5-6 planner-invented examples", not "is the function". Six
// interventions aimed at the COMPOSITION step all failed because the composition was never the
// problem — the model and the mechanical templates were both being handed a broken helper.
//
// WHAT THIS MODULE DOES. When a mechanical composition of the right SHAPE fails against the
// original gold cases, the failure localises: a template that is structurally correct fails only if
// a helper misbehaved. For a known shape the gold output says what the helper MUST have returned,
// which is a counterexample the loop currently discards — it just shrugs and asks the model, which
// then fails for the same reason.
//
// SOUNDNESS — the whole design rests on this. A derived counterexample is only emitted when the
// derivation is FORCED by the gold data, never guessed:
//   • SCAN-INDEX: gold says input "a,,b" splits into 3 fields. Locating the boundaries of a
//     3-element split of a 4-character string is determined once the field texts are known, so
//     "the locator must return 1 from position 0" is arithmetic on the gold, not an opinion.
//   • Anything not forced is NOT emitted. This module returns nothing rather than a plausible
//     guess, because a WRONG counterexample would make a CORRECT helper un-certifiable — turning a
//     solvable rung into a permanently failing one. That failure mode is worse than no fix at all,
//     so every rule here is conservative and bails on the first ambiguity.
//
// A counterexample is still only a CASE: it is added to a rung's spec and the rung is re-ground and
// re-verified exactly as before. It cannot certify anything; it can only make a wrong helper fail
// the check that should have caught it in the first place.

import type { CodeAcceptance } from './codeVerifier'

export interface DerivedCase {
  /** Which helper the case constrains. */
  helper: string
  /** The case to add to that helper's spec. */
  testCase: NonNullable<CodeAcceptance['cases']>[number]
  /** Why this is forced by the gold data — carried into the prompt and the audit trail. */
  why: string
}

/**
 * SCAN-INDEX derivation. The template walks `input` with a locator `(string, number) -> number`,
 * slicing each segment and optionally passing it through a transform. Given a gold case whose
 * expected value is the list of FIELD TEXTS, the boundary positions are recoverable whenever the
 * fields appear in the input verbatim — i.e. when the transform did not rewrite them.
 *
 * Conservative by construction: it walks the gold fields left to right, requiring each to sit at
 * the current scan position in the input, and abandons the whole derivation the moment one does not
 * (which is exactly the case where a transform changed the text and the boundary is not determined).
 */
export function deriveScanIndexCases(
  locator: string,
  input: unknown,
  expected: unknown,
  separator = ',',
): DerivedCase[] {
  if (typeof input !== 'string' || !Array.isArray(expected)) return []
  if (!expected.every(f => typeof f === 'string')) return []
  const fields = expected as string[]
  if (fields.length < 2) return []          // a single field determines no boundary

  const out: DerivedCase[] = []
  let pos = 0
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    // The field must appear VERBATIM at the scan position, or the transform rewrote it and the
    // boundary is not forced. Bail entirely rather than emit a guess.
    if (input.slice(pos, pos + field.length) !== field) return []
    const boundary = pos + field.length
    if (i < fields.length - 1) {
      if (input[boundary] !== separator) return []   // not the shape we think it is
      out.push({
        helper: locator,
        testCase: { args: [input, pos], expected: boundary },
        why: `gold case ${JSON.stringify(input)} -> ${JSON.stringify(fields)} puts field ${i} at [${pos}, ${boundary}), ` +
          `so the locator must return ${boundary} when scanning from ${pos}`,
      })
      pos = boundary + 1
    } else {
      // The final field: the locator must report "no more boundaries" from here.
      out.push({
        helper: locator,
        testCase: { args: [input, pos], expected: -1 },
        why: `gold case ${JSON.stringify(input)} -> ${JSON.stringify(fields)} has no separator after field ${i}, ` +
          `so the locator must return -1 when scanning from ${pos}`,
      })
    }
  }
  return out
}

/**
 * Merge derived cases into a helper's spec, skipping any the spec already pins (same args) and any
 * that CONTRADICT it. A contradiction means the derivation disagrees with a case the rung was
 * certified against — the derivation is then unsound for this task and the whole batch is dropped,
 * because acting on it could make a correct helper un-certifiable.
 */
export function mergeDerivedCases(
  existing: CodeAcceptance['cases'],
  derived: DerivedCase[],
): { cases: CodeAcceptance['cases']; added: DerivedCase[]; contradicted: boolean } {
  const cur = existing ?? []
  const key = (args: unknown[]): string => JSON.stringify(args)
  const byArgs = new Map(cur.map(c => [key(c.args ?? []), c.expected]))
  const added: DerivedCase[] = []
  for (const d of derived) {
    const prior = byArgs.get(key(d.testCase.args ?? []))
    if (prior === undefined) { added.push(d); continue }
    if (JSON.stringify(prior) !== JSON.stringify(d.testCase.expected)) {
      return { cases: cur, added: [], contradicted: true }
    }
  }
  return { cases: [...cur, ...added.map(d => d.testCase)], added, contradicted: false }
}
