// ═══════════════════════════════════════════════════════════════════════════════
// PLAN SHAPE — score a carve by whether its helpers return values a model will actually produce.
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE MEASUREMENT THIS ENCODES (2026-08-02b). Three hand-written carves of the IDENTICAL rung
// (`splitCsvLine`), same head, same cases, same verifier, same 6-draw budget. The only difference is
// what the hard helper must RETURN:
//
//   carve    hard helper returns                        hard rung certified
//   raw      fields with the wrapping quotes retained    1/9
//   mask     the line with a control-char sentinel       0/6
//   index    a number (index of the next comma)          6/6
//
// A 1.5B will not emit a representation nobody writes down, however the goal is phrased: `raw`
// failed by stripping the quotes it was explicitly told to keep (7 of 8 failures byte-identical),
// `mask` by returning its input untouched. The same work behind a natural return value certified
// essentially every time. So the fillability of a carve is largely decided BEFORE any model call,
// by the shape of the values its helpers are asked to produce — and nothing in the loop looks at
// that today.
//
// WHY A SCORE AND NOT A GATE. The three plan gates in solve.ts reject a plan outright, which is
// right for "this helper IS the entry" (a carve that cannot help). This property is different: an
// unnatural intermediate is a BAD BET, not an impossible one — `raw` did certify once in nine. A
// gate would throw away a carve that sometimes works and could deadlock a task whose only available
// carve is awkward. Ranking resampled plans is the sound use: same number of grinds, better order,
// and a mis-ranked plan costs draws rather than correctness.
//
// EVERYTHING HERE IS STATIC. It reads the planner's own invented example I/O — no execution, no
// model call — so it is free to run on every plan attempt.

import type { SubFunctionSpec } from './solve'

export interface PlanShapeReport {
  /** 0..1, higher is better. The mean of the per-helper scores. */
  score: number
  /** Per-helper detail, in plan order — so a low score can be attributed to a specific rung. */
  helpers: { name: string; score: number; reasons: string[] }[]
}

/** A value the head produces without being argued into it: numbers, booleans, arrays, plain text. */
function valueScore(input: unknown[], expected: unknown): { score: number; reasons: string[] } {
  const reasons: string[] = []

  // Numbers and booleans are the strongest signal in the measurement: `nextUnquotedComma` returns a
  // number and certified 6/6, often in a single call. Nothing to negotiate about the representation.
  if (typeof expected === 'number' || typeof expected === 'boolean') return { score: 1, reasons: ['returns a number/boolean'] }
  if (expected === null || expected === undefined) return { score: 0.6, reasons: ['returns null/undefined'] }

  const asText = Array.isArray(expected) ? expected.filter(x => typeof x === 'string').join('') : expected
  if (typeof asText !== 'string') return { score: 0.7, reasons: ['returns a structured value'] }

  let score = 1

  // CONTROL CHARACTERS — the `mask` failure, exactly. A helper asked to emit String.fromCharCode(1)
  // got 0/6: the head returned its input unchanged rather than invent a sentinel. Anything below
  // 0x20 that is not tab/newline is a marker a human would not put in a return value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(asText)) {
    score -= 0.7
    reasons.push('output contains a control-character sentinel (no model writes this)')
  }

  return { score: Math.max(0, score), reasons }
}

/**
 * Score one helper spec. A helper is judged on the values its OWN example I/O asks for, which is
 * all the planner has committed to at this point.
 */
function scoreHelper(h: SubFunctionSpec): { name: string; score: number; reasons: string[] } {
  const cases = h.cases ?? []
  if (!cases.length) return { name: h.name, score: 0.5, reasons: ['no example I/O to judge'] }

  const per = cases.map(c => valueScore(c.args ?? [], c.expected))
  let score = per.reduce((a, b) => a + b.score, 0) / per.length
  const reasons = [...new Set(per.flatMap(p => p.reasons))]

  // IDENTITY OUTPUT — the other half of the `mask` failure, and it must be judged over the WHOLE
  // helper rather than per case. Pass-through is CORRECT behaviour for many good helpers:
  // `unquoteCsvField` returns an unquoted field unchanged and certifies in one call every time, so
  // penalising it per case blamed the one helper that always works. It is only a warning sign when
  // MOST cases expect the input back (`protectQuotedCommas`: 3 of 5), because then the helper's job
  // is invisible in its own examples and the head cannot tell what it is being asked to change.
  const identity = cases.filter(c => {
    const a = c.args?.[0]
    const e = Array.isArray(c.expected) ? null : c.expected
    return typeof a === 'string' && a.length > 0 && typeof e === 'string' && a === e
  }).length
  if (cases.length >= 2 && identity > cases.length / 2) {
    score -= 0.3
    reasons.push('most examples expect the input back unchanged (the transformation is invisible)')
  }

  // MARKUP RETAINED — the `raw` failure (1/9). Its `splitCsvRaw` had to return fields with the
  // wrapping quotes still attached, and the head stripped them on essentially every draw. The
  // observable signature is that the quote/delimiter characters present in the INPUT survive into
  // the expected OUTPUT: the helper is being asked to carry structural markup forward rather than
  // resolve or remove it. Only counted when it happens on most cases, so a helper that legitimately
  // passes through a quoted character once is not penalised.
  const markupKept = cases.filter(c => {
    const a = c.args?.[0]
    const e = Array.isArray(c.expected) ? c.expected.filter(x => typeof x === 'string').join('') : c.expected
    if (typeof a !== 'string' || typeof e !== 'string') return false
    const marks = (a.match(/["'`]/g) ?? []).length
    return marks > 0 && (e.match(/["'`]/g) ?? []).length >= marks
  }).length
  // Judged against the cases that ACTUALLY CONTAIN markup, not all of them. Measuring against the
  // full case list silently disabled this rule: `splitCsvRaw` carries quotes forward in both of the
  // cases that have quotes, but only 2 of its 5 cases have any, so a majority-of-all test could
  // never fire on the very carve the rule was written from.
  const withMarkup = cases.filter(c => typeof c.args?.[0] === 'string' && /["'`]/.test(c.args[0] as string)).length
  if (withMarkup >= 1 && markupKept > withMarkup / 2) {
    score -= 0.4
    reasons.push('output carries the input\'s quoting/markup forward instead of resolving it')
  }

  return { name: h.name, score: Math.max(0, Math.min(1, score)), reasons }
}

/**
 * Score a whole carve. Use it to RANK resampled plans, never to reject one — see the header for why
 * a gate would be wrong here.
 */
export function planShapeScore(plan: SubFunctionSpec[]): PlanShapeReport {
  if (!plan.length) return { score: 0, helpers: [] }
  const helpers = plan.map(scoreHelper)
  return { score: helpers.reduce((a, b) => a + b.score, 0) / helpers.length, helpers }
}
