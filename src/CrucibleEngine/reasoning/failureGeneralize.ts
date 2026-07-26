// ═══════════════════════════════════════════════════════════════════════════════
// COUNTEREXAMPLE GENERALIZATION — say what the failures have in common, not what they are
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (see DOCTRINE.md): "Maximize information per model call. Every rejected candidate
// must return RICH STRUCTURED FEEDBACK so the next proposal converges in a handful of calls."
//
// The loop already returns rich feedback — but only as INSTANCES:
//
//   case isBalanced #1 on input "abc" → got false, expected true
//   case isBalanced #5 on input "a(b[c]{d})e" → got false, expected true
//
// A strong model infers the rule behind those two lines. A 1.5B does not: measured live
// (2026-07-26), the head was handed exactly that feedback eight times in a row and re-emitted a
// variant of the same wrong program every time, never generalizing "the failures are the inputs
// containing non-bracket characters". The information needed to converge was PRESENT IN THE
// VERIFIER'S OWN DATA and was never stated.
//
// So state it. This module reads the structured `CaseOutcome[]` the verifier already computes and
// derives the INVARIANT that separates the failing cases from the passing ones:
//
//   "All 2 failing inputs contain characters outside the set the passing inputs use
//    (extra: a b c d e). Every passing input is built only from ( ) [ ] { }."
//   "Every case you get wrong expects `true`; you never wrongly return `true`.
//    Your predicate is too STRICT — it rejects valid input."
//
// That is a different KIND of signal: a hypothesis about the bug, derived mechanically from
// ground truth, at zero model calls. It costs a few hundred microseconds and it is the cheapest
// unexploited lever in the loop.
//
// SOUNDNESS. Everything here is a HINT threaded into the proposal prompt. It cannot certify
// anything: the verifier is unchanged and still executes every candidate against the real cases.
// A wrong generalization can only waste a draw, never admit a wrong answer. And every analysis is
// a GENERAL property of the data (types, character sets, orderings, offsets) — never knowledge
// about any particular task, which is the "NOT preloaded answers" line in DOCTRINE.md.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CaseOutcome } from './codeVerifier'

/** How many derived facts to surface. More than a handful buries the goal in a 4096-token slot. */
const MAX_FACTS = 4

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A structural type name that distinguishes the shapes a weak head actually confuses. */
export function shapeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) {
    const inner = new Set(v.map(shapeOf))
    return inner.size === 0 ? 'empty array' : inner.size === 1 ? `${[...inner][0]}[]` : 'mixed[]'
  }
  if (isObj(v)) return 'object'
  return typeof v
}

const fmt = (v: unknown): string => {
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + '…' : s }
  catch { return String(v) }
}

/** Multiset equality — used to tell "wrong elements" from "right elements, wrong order". */
function sameMultiset(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false
  const key = (x: unknown) => fmt(x)
  const counts = new Map<string, number>()
  for (const x of a) counts.set(key(x), (counts.get(key(x)) ?? 0) + 1)
  for (const x of b) {
    const k = key(x)
    const n = counts.get(k)
    if (!n) return false
    counts.set(k, n - 1)
  }
  return true
}

/** The set of characters appearing in every string argument of a case. */
function charsOf(args: unknown[]): Set<string> {
  const out = new Set<string>()
  for (const a of args) if (typeof a === 'string') for (const ch of a) out.add(ch)
  return out
}

/**
 * Derive the invariants separating failing cases from passing ones.
 *
 * Returns human-readable facts, highest-signal first, capped at MAX_FACTS. Empty when nothing
 * generalizes — which is itself correct behaviour: saying nothing beats inventing a pattern.
 */
export function generalizeFailures(outcomes: CaseOutcome[]): string[] {
  const failing = outcomes.filter(o => !o.ok)
  const passing = outcomes.filter(o => o.ok)
  if (!failing.length) return []
  const facts: string[] = []
  const F = failing.length

  // ── 1. EVERY failure is a throw, and they agree on the error. ────────────────────────────
  // Highest-signal case in practice: this is a LANGUAGE mistake (a bad idiom), not a wrong
  // algorithm, and the two need completely different fixes. Measured live: wordFrequencyTop
  // stalled at "best score -1" for eight draws on `map.entries(...).sort is not a function`.
  const thrown = failing.filter(o => o.error)
  if (thrown.length === F) {
    const heads = new Set(thrown.map(o => String(o.error).split('\n')[0].trim()))
    if (heads.size === 1) {
      facts.push(
        `ALL ${F} failing case(s) THROW the same error, they do not compute a wrong value: ` +
        `"${[...heads][0]}". This is a language/API mistake in one expression, not a flaw in your ` +
        `algorithm — the surrounding logic may already be correct. Fix that one expression.`)
    } else {
      facts.push(`ALL ${F} failing case(s) THROW rather than returning a wrong value — the bug is a runtime/API error, not wrong arithmetic.`)
    }
  }

  const valued = failing.filter(o => !o.error)

  // ── 2. Return SHAPE disagrees with the spec. ─────────────────────────────────────────────
  // A weak head routinely returns the right computation in the wrong container (counts instead
  // of the words that carry them). No amount of algorithm feedback fixes a shape error.
  if (valued.length) {
    const actualShapes = new Set(valued.map(o => shapeOf(o.actual)))
    const expectedShapes = new Set(valued.map(o => shapeOf(o.expected)))
    if (actualShapes.size === 1 && expectedShapes.size === 1) {
      const a = [...actualShapes][0], e = [...expectedShapes][0]
      if (a !== e) {
        facts.push(
          `Your function returns the WRONG TYPE on every failing case: it produced \`${a}\` where ` +
          `the spec requires \`${e}\`. You are returning the wrong thing, not computing it wrongly — ` +
          `check what the return value is supposed to CONTAIN before touching the algorithm.`)
      }
    }
  }

  // ── 3. Boolean predicate is DIRECTIONALLY biased. ────────────────────────────────────────
  // "Every case you get wrong expects true" tells the head its predicate is too strict — an
  // enormously more actionable statement than two instances of a false negative.
  const bools = valued.filter(o => typeof o.expected === 'boolean' && typeof o.actual === 'boolean')
  if (bools.length && bools.length === valued.length) {
    const expectedTrue = bools.filter(o => o.expected === true).length
    if (expectedTrue === bools.length) {
      facts.push(
        `Every case you get wrong expects \`true\` and you returned \`false\`; you never wrongly ` +
        `return \`true\`. Your predicate is TOO STRICT — it rejects valid input. Look for a ` +
        `condition that should accept a case you are currently rejecting.`)
    } else if (expectedTrue === 0) {
      facts.push(
        `Every case you get wrong expects \`false\` and you returned \`true\`; you never wrongly ` +
        `return \`false\`. Your predicate is TOO LOOSE — it accepts invalid input. You are missing ` +
        `a rejection condition.`)
    }
  }

  // ── 4. Right elements, wrong ORDER. ──────────────────────────────────────────────────────
  // Distinguishes a sorting/tie-break bug from a computation bug. These look identical in
  // instance feedback and need opposite fixes.
  const arrs = valued.filter(o => Array.isArray(o.actual) && Array.isArray(o.expected))
  if (arrs.length && arrs.length === valued.length) {
    if (arrs.every(o => sameMultiset(o.actual as unknown[], o.expected as unknown[]))) {
      facts.push(
        `On every failing case you produce EXACTLY THE RIGHT ELEMENTS IN THE WRONG ORDER. The ` +
        `computation is correct — only your sort/tie-break is wrong. Do not rewrite the algorithm; ` +
        `fix the comparator.`)
    } else {
      const missing = arrs.every(o => (o.actual as unknown[]).every(x => (o.expected as unknown[]).some(y => fmt(x) === fmt(y))))
      const extra = arrs.every(o => (o.expected as unknown[]).every(x => (o.actual as unknown[]).some(y => fmt(x) === fmt(y))))
      if (missing && !extra) facts.push(`Every value you return is correct but you return TOO FEW — you are dropping entries that belong in the result.`)
      else if (extra && !missing) facts.push(`Your result CONTAINS every expected value plus extras — you are failing to filter/limit the result.`)
    }
  }

  // ── 5. A constant numeric OFFSET (the classic off-by-one). ───────────────────────────────
  const nums = valued.filter(o => typeof o.actual === 'number' && typeof o.expected === 'number')
  if (nums.length && nums.length === valued.length) {
    const deltas = new Set(nums.map(o => (o.actual as number) - (o.expected as number)))
    if (deltas.size === 1) {
      const d = [...deltas][0]
      if (d !== 0) {
        facts.push(
          `Your answer is off by EXACTLY ${d > 0 ? `+${d}` : d} on every failing case — a constant ` +
          `offset, not a wrong algorithm. This is an off-by-one/boundary error: check a loop bound, ` +
          `an initial accumulator value, or an inclusive-vs-exclusive comparison.`)
      }
    }
  }

  // ── 6. String answers that differ only by CASE or WHITESPACE. ────────────────────────────
  const strs = valued.filter(o => typeof o.actual === 'string' && typeof o.expected === 'string')
  if (strs.length && strs.length === valued.length) {
    if (strs.every(o => (o.actual as string).toLowerCase() === (o.expected as string).toLowerCase())) {
      facts.push(`Your output is character-for-character correct except for LETTER CASE. Only the casing is wrong.`)
    } else if (strs.every(o => (o.actual as string).trim() === (o.expected as string).trim())) {
      facts.push(`Your output is correct except for surrounding WHITESPACE.`)
    }
  }

  // ── 7. All failures agree on the EXPECTED value. ─────────────────────────────────────────
  // Very often the whole bug is one unhandled class of input mapping to one answer.
  if (valued.length > 1 && facts.length < MAX_FACTS) {
    const exp = new Set(valued.map(o => fmt(o.expected)))
    if (exp.size === 1 && passing.length) {
      const passExp = new Set(passing.map(o => fmt(o.expected)))
      if (!(passExp.size === 1 && passExp.has([...exp][0]))) {
        facts.push(`Every failing case expects the same answer, \`${[...exp][0]}\` — one specific class of input is unhandled.`)
      }
    }
  }

  // ── 8. CHARACTER-CLASS discriminator over string inputs. ─────────────────────────────────
  // The isBalanced archetype: the failing inputs are exactly the ones containing characters the
  // passing inputs never contain. Computed purely from the observed alphabet — no task knowledge.
  if (passing.length && facts.length < MAX_FACTS) {
    const failChars = failing.map(o => charsOf(o.args ?? []))
    const passChars = passing.map(o => charsOf(o.args ?? []))
    if (failChars.every(s => s.size) && failChars.length) {
      const inAllFail = [...failChars[0]].filter(c => failChars.every(s => s.has(c)))
      const inNoPass = inAllFail.filter(c => passChars.every(s => !s.has(c)))
      if (inNoPass.length) {
        facts.push(
          `Every failing input contains ${inNoPass.length === 1 ? 'the character' : 'the characters'} ` +
          `${inNoPass.slice(0, 12).map(c => JSON.stringify(c)).join(' ')} and NO passing input does. ` +
          `That is the distinguishing feature of the inputs you get wrong — handle it explicitly.`)
      }
    }
  }

  // ── 9. LENGTH/EMPTINESS discriminator over the first argument. ───────────────────────────
  if (passing.length && facts.length < MAX_FACTS) {
    const len = (o: CaseOutcome): number | null => {
      const a = (o.args ?? [])[0]
      return typeof a === 'string' || Array.isArray(a) ? a.length : null
    }
    const fl = failing.map(len), pl = passing.map(len)
    if (fl.every(x => x !== null) && pl.every(x => x !== null)) {
      if (fl.every(x => x === 0) && pl.every(x => x !== 0)) {
        facts.push(`Every failing case is the EMPTY input and every non-empty input passes — you are missing the empty-input base case.`)
      } else if (fl.every(x => x !== 0) && pl.every(x => x === 0)) {
        facts.push(`ONLY the empty input passes — your handling of non-empty input is broken.`)
      } else {
        const maxPass = Math.max(...(pl as number[])), minFail = Math.min(...(fl as number[]))
        if (minFail > maxPass) facts.push(`Every failing input is LONGER (${minFail}+) than every passing input (≤${maxPass}) — your logic breaks as input size grows.`)
      }
    }
  }

  return facts.slice(0, MAX_FACTS)
}

/**
 * SPEC-QUALITY GATE: does a TRIVIAL implementation satisfy this case set?
 *
 * A specification that cannot reject a constant function is not a specification, and certifying a
 * candidate against it proves nothing. This matters because the decomposition planner INVENTS the
 * example I/O for each helper rung, and that model-invented data then becomes the verifier's
 * acceptance criteria — the one place in the system where the model seeds its own oracle. Measured
 * live: the planner emitted `isBracket` with three cases all expecting `true`, so `() => true`
 * certifies the rung, four such helpers certify, and the composition that consumes them cannot
 * possibly work.
 *
 * Deterministic, zero model calls, and it can only trigger a RESAMPLE — never a certification.
 * Returns the trivial implementation that defeats the case set, or null when the spec has teeth.
 */
export function trivialImplThatPasses(cases: Array<{ args: unknown[]; expected: unknown }>): string | null {
  if (!cases.length) return 'any implementation (the spec has NO cases)'
  const expected = cases.map(c => c.expected)

  // (a) One constant answer satisfies everything.
  const distinct = new Set(expected.map(fmt))
  if (distinct.size === 1) return `() => ${fmt(expected[0])}`

  // (b) Identity / project-the-nth-argument satisfies everything.
  const arity = Math.max(...cases.map(c => c.args.length))
  for (let i = 0; i < arity; i++) {
    if (cases.every(c => c.args.length > i && fmt(c.args[i]) === fmt(c.expected))) {
      return arity === 1 ? '(x) => x' : `(...a) => a[${i}]`
    }
  }

  // (c) A lookup keyed on the first argument — i.e. the cases never repeat an input, so a table
  //     of them passes. This is weaker evidence than (a)/(b): it only says the case set is small
  //     enough to memorize, which is true of most honest small specs. Deliberately NOT reported.
  return null
}

/**
 * CONTRADICTION / WELL-FORMEDNESS gate for a model-invented case set.
 * Returns a reason string when the spec is unsatisfiable or malformed, else null.
 * No implementation can ever satisfy such a spec, so spending ANY budget on it is pure waste.
 */
export function incoherentSpecReason(cases: Array<{ args: unknown[]; expected: unknown }>): string | null {
  if (!cases.length) return 'the case set is empty — nothing to verify against'

  // Same input, two different expected outputs ⇒ no function satisfies it.
  const byArgs = new Map<string, Set<string>>()
  for (const c of cases) {
    const k = fmt(c.args)
    if (!byArgs.has(k)) byArgs.set(k, new Set())
    byArgs.get(k)!.add(fmt(c.expected))
  }
  for (const [k, exp] of byArgs) {
    if (exp.size > 1) return `contradictory: input ${k} is required to produce ${[...exp].join(' AND ')} — no function can do both`
  }

  // Arity disagreement across cases of ONE function ⇒ the cases describe different functions.
  const arities = new Set(cases.map(c => c.args.length))
  if (arities.size > 1) return `arity-inconsistent: cases call the function with ${[...arities].sort().join(' and ')} arguments`

  // Null/undefined padding — the planner filling a slot it did not understand.
  if (cases.some(c => c.args.some(a => a === null || a === undefined))) {
    return 'null-padded: at least one case passes null/undefined as an argument, which is padding rather than a real example'
  }
  return null
}
