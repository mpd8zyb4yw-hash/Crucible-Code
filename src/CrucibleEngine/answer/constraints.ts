// ═══════════════════════════════════════════════════════════════════════════════
// Answer engine — UNIT / MAGNITUDE / CONSTRAINT sanity critics (deterministic, zero model)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Recomputation (wordProblem.ts) certifies the VALUE of an arithmetic answer, but a wrong
// SETUP shared across all extractions is its documented honest limit — and a wrong setup very
// often violates a constraint the QUESTION itself imposes. These critics read constraints off
// the question deterministically and check the answered value against them:
//
//   • asked-unit consistency — "how many HOURS…" answered in a different recognized unit;
//   • percent bounds — "what percent of" answers must land in [0, 100];
//   • probability bounds — probability answers must land in [0, 1];
//   • count sanity — "how many <discrete things>" must be a non-negative integer (allowing
//     the conversational "2.5 boxes" only when the question involves rates/averages);
//   • part-of-whole — "what fraction/percent/how many OF the N …" can never exceed N.
//
// A violation is NOT auto-fixed (there is no machine value to splice — the setup itself is
// suspect); it degrades the recomputation from "certified" to "rejected" so the caller keeps
// the draft un-stamped, or flags a drafted bare answer for one repair round. Honesty over
// confidence: a value that violates the question's own constraints must never ship stamped
// "machine-verified".
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConstraintViolation {
  kind: 'unit-mismatch' | 'percent-range' | 'probability-range' | 'count-not-integer' | 'count-negative' | 'exceeds-whole'
  detail: string
}

// Recognized unit families — a mismatch is only flagged across DIFFERENT families we both
// recognize; unknown/absent units are never flagged (unit words are too open-ended to police).
const UNIT_FAMILIES: Record<string, string[]> = {
  time: ['second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years'],
  distance: ['millimeter', 'millimeters', 'centimeter', 'centimeters', 'cm', 'meter', 'meters', 'kilometer', 'kilometers', 'km', 'inch', 'inches', 'foot', 'feet', 'yard', 'yards', 'mile', 'miles'],
  money: ['dollar', 'dollars', 'cent', 'cents', 'euro', 'euros', 'pound', 'pounds'],
  mass: ['gram', 'grams', 'kilogram', 'kilograms', 'kg', 'ounce', 'ounces', 'pound', 'pounds', 'ton', 'tons'],
}

function familyOf(unit: string): string | null {
  const u = unit.toLowerCase().trim()
  // 'pounds' is both money and mass; ambiguous units never flag.
  const hits = Object.entries(UNIT_FAMILIES).filter(([, words]) => words.includes(u)).map(([f]) => f)
  return hits.length === 1 ? hits[0] : null
}

/** The unit the QUESTION asks the answer in ("how many hours", "in miles"), if recognizable. */
export function askedUnit(question: string): string | null {
  const q = question.toLowerCase()
  const m = /\bhow (?:many|much)\s+([a-z]+)\b/.exec(q) ?? /\bin\s+([a-z]+)\s*\?/.exec(q)
  if (!m) return null
  return familyOf(m[1]) ? m[1] : null
}

const PERCENT_ASK = /\bwhat\s+percent(?:age)?\b|\bhow many percent\b/i
const PROBABILITY_ASK = /\b(what (?:is|are) the )?probabilit(?:y|ies)\b|\bhow likely\b|\bchance that\b/i
// Discrete-count ask: "how many <plural noun>" where the question isn't about a continuous
// quantity (time/distance/money/mass) or a rate/average (those legitimately yield fractions).
const RATEY = /\b(average|mean|per\b|rate|speed|each (hour|day|minute))\b/i

/** Numbers stated in the question, for part-of-whole checks. */
function questionNumbers(question: string): number[] {
  return (question.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map(s => Number(s.replace(/,/g, ''))).filter(isFinite)
}

/**
 * Check a computed/stated answer VALUE (+ optional unit) against constraints the QUESTION
 * imposes. Deterministic; returns [] when nothing is provably violated.
 */
export function checkConstraints(
  question: string,
  value: number,
  unit?: string,
): ConstraintViolation[] {
  const out: ConstraintViolation[] = []
  const q = question ?? ''

  // Asked-unit consistency (only across two RECOGNIZED, distinct families).
  const asked = askedUnit(q)
  if (asked && unit) {
    const fAsked = familyOf(asked)
    const fGot = familyOf(unit)
    if (fAsked && fGot && fAsked !== fGot) {
      out.push({ kind: 'unit-mismatch', detail: `The question asks for ${asked} (${fAsked}) but the answer is in ${unit} (${fGot}).` })
    }
  }

  if (PERCENT_ASK.test(q) && (value < 0 || value > 100)) {
    out.push({ kind: 'percent-range', detail: `A "what percent" answer must be between 0 and 100; got ${value}.` })
  }

  if (PROBABILITY_ASK.test(q) && (value < 0 || value > 1) && !PERCENT_ASK.test(q) && !(unit && /percent|%/.test(unit))) {
    // Allow percent-phrased probabilities up to 100.
    if (value < 0 || value > 100) {
      out.push({ kind: 'probability-range', detail: `A probability answer must be between 0 and 1 (or 0–100%); got ${value}.` })
    } else if (value > 1 && !/percent|%|\bout of\b/i.test(q)) {
      out.push({ kind: 'probability-range', detail: `A probability answer must be between 0 and 1 unless expressed as a percent; got ${value}.` })
    }
  }

  // Discrete-count sanity — "how many apples/people/pages…" (not a recognized continuous unit,
  // not rate/average phrasing) must be a non-negative integer.
  const countAsk = /\bhow many\s+([a-z]+)\b/i.exec(q)
  if (countAsk && !familyOf(countAsk[1]) && !RATEY.test(q) && !PERCENT_ASK.test(q)) {
    if (value < 0) out.push({ kind: 'count-negative', detail: `A count of ${countAsk[1]} cannot be negative; got ${value}.` })
    else if (!Number.isInteger(Math.round(value * 1e6) / 1e6)) {
      out.push({ kind: 'count-not-integer', detail: `A count of ${countAsk[1]} should be a whole number; got ${value}.` })
    }
  }

  // Part-of-whole — "how many OF the N …" / "out of N" can never exceed N.
  const whole = /\b(?:of the|out of(?: the)?)\s+(\d[\d,]*)\b/i.exec(q)
  if (whole && !PERCENT_ASK.test(q)) {
    const n = Number(whole[1].replace(/,/g, ''))
    if (isFinite(n) && value > n) {
      out.push({ kind: 'exceeds-whole', detail: `The answer (${value}) exceeds the whole stated in the question (${n}).` })
    }
  }

  return out
}
