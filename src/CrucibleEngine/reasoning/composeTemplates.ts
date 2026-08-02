// ═══════════════════════════════════════════════════════════════════════════════
// MECHANICAL COMPOSITION — build the top-level function from certified helpers with ZERO model calls.
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY THIS EXISTS, measured rather than assumed (2026-08-02b). With a good carve the helper rungs
// certify 6/6 and the COMPOSITION certifies ~0 — 2 solves in 30 draws. The signals say exactly why:
// the composition RE-IMPLEMENTS the certified helpers instead of calling them (the detector fired in
// 6 of 6 draws). A composition that ignores its helpers IS the original coarse task — the one
// measured at 0 certifications in 290 model calls — so the carve's entire benefit is discarded at
// the last step.
//
// Six interventions were measured against that wall and none converted it: telling the model it
// ignored the helpers (0/6), moving that signal where the anti-anchor detector could see it (2/6
// then 0/6 — variance), glue re-decomposition (1/6, and the solve came from compose succeeding
// directly), a 6x purse (0/2), and retrieval on both the finer and the coarse rung (0/4, 0/3).
// The pattern across every result: THIS HEAD'S PRIORS BEAT ITS INSTRUCTIONS. Asking it to call the
// helpers is not a lever.
//
// So don't ask. Most compositions over 2-3 helpers are one of a handful of shapes, and those shapes
// are decidable from the helpers' SIGNATURES — which are known exactly, because the planner supplied
// example I/O for every rung and the verifier just certified against it. Emitting those candidates
// costs no model calls, and each one goes through the same verifier as a generated one.
//
// DOCTRINE. This is "correctness comes from the LOOP, not the oracle" in its most literal form: the
// model proposes the PIECES (which it does well — 6/6) and deterministic code assembles them, with
// the verifier owning truth. It is also the doctrine's "the model only fills leaves small enough".
//
// SOUND, AND THE FAILURE MODE IS BOUNDED. A template is a CANDIDATE, not an answer: it is executed
// against the original cases by the same verifier, so a template that does not fit the task fails
// like any other wrong proposal. It cannot certify a wrong answer, and at worst it costs the
// microseconds to generate a string. It is NOT a template registry of task answers — the templates
// know nothing about CSV, roman numerals or any task; they know only shapes like
// "(T, number) -> number pairs with (string) -> U" and are selected by signature alone.

import type { CodeAcceptance } from './codeVerifier'

export interface CertifiedHelper {
  name: string
  source: string
  /** The helper's own certified cases — the only ground truth about its signature. */
  cases: CodeAcceptance['cases']
}

/** What a helper looks like from outside: how many arguments, and what kind of value it returns. */
interface HelperShape {
  name: string
  arity: number
  /** Type of the FIRST parameter, when it is uniform across cases. */
  argKind: 'string' | 'number' | 'array' | 'other'
  returnKind: 'string' | 'number' | 'boolean' | 'array' | 'other'
}

function kindOf(v: unknown): HelperShape['returnKind'] {
  if (typeof v === 'string') return 'string'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  if (Array.isArray(v)) return 'array'
  return 'other'
}

/** Read a helper's shape off its certified cases. Returns null when the cases disagree. */
function shapeOf(h: CertifiedHelper): HelperShape | null {
  const cases = h.cases ?? []
  if (!cases.length) return null
  const arity = cases[0].args?.length ?? 0
  if (!cases.every(c => (c.args?.length ?? 0) === arity)) return null
  const rk = kindOf(cases[0].expected)
  if (!cases.every(c => kindOf(c.expected) === rk)) return null
  const ak = arity > 0 ? kindOf(cases[0].args[0]) : 'other'
  const argKind = ak === 'boolean' ? 'other' : ak
  if (arity > 0 && !cases.every(c => {
    const k = kindOf(c.args[0])
    return (k === 'boolean' ? 'other' : k) === argKind
  })) return null
  return { name: h.name, arity, argKind: argKind as HelperShape['argKind'], returnKind: rk }
}

/**
 * Emit candidate bodies for `entry` built from the certified helpers. Ordered cheapest-shape-first;
 * the caller runs them through the verifier and keeps the first that passes.
 *
 * Every template below is a general programming shape, chosen because it is what a 2-3 helper carve
 * USUALLY composes into, not because it fits a particular task:
 *   • PIPELINE     — feed the entry input through one helper into the next.
 *   • MAP          — a helper that returns an array, each element through a second helper.
 *   • SCAN-INDEX   — a `(T, number) -> number` locator plus a `(string) -> U` transform: walk the
 *                    input by repeatedly locating the next boundary, transforming each segment.
 *                    (`indexOf`-shaped locators are extremely common, and a locator is exactly the
 *                    kind of helper that certifies reliably — it returns a NUMBER.)
 *   • DIRECT       — the entry is a single helper applied to the input, or to each element of it.
 */
export function composeCandidates(entry: string, helpers: CertifiedHelper[]): string[] {
  const shapes = helpers.map(shapeOf).filter((s): s is HelperShape => !!s)
  if (!shapes.length) return []
  const out: string[] = []
  const push = (body: string): void => { if (!out.includes(body)) out.push(body) }

  const unary = shapes.filter(s => s.arity === 1)
  const locators = shapes.filter(s => s.arity === 2 && s.returnKind === 'number' && s.argKind === 'string')
  const arrayReturning = unary.filter(s => s.returnKind === 'array')
  const stringToString = unary.filter(s => s.argKind === 'string' && s.returnKind === 'string')

  // DIRECT — the composition is one helper, possibly with the entry's own trivial wrapper.
  for (const s of unary) push(`export function ${entry}(input) {\n  return ${s.name}(input)\n}`)

  // MAP — split-then-transform, the single most common two-helper shape.
  for (const a of arrayReturning) {
    for (const b of stringToString) {
      if (a.name === b.name) continue
      push(`export function ${entry}(input) {\n  return ${a.name}(input).map((part) => ${b.name}(part))\n}`)
    }
    // …and the array helper alone, for a carve whose second helper is used elsewhere.
    push(`export function ${entry}(input) {\n  return ${a.name}(input)\n}`)
  }

  // PIPELINE — a -> b, both directions, since the planner does not order its helpers meaningfully.
  for (const a of unary) {
    for (const b of unary) {
      if (a.name === b.name) continue
      push(`export function ${entry}(input) {\n  return ${b.name}(${a.name}(input))\n}`)
    }
  }

  // SCAN-INDEX — a locator walks the input, a transform cleans each segment. Emitted with and
  // without the transform, and with the final segment handled both ways, because "does the last
  // segment count" is precisely the off-by-one a weak head gets wrong (`"a,,b"` -> `["a,","b"]` was
  // the observed failure) and it is free to try both here.
  for (const loc of locators) {
    const transforms: (string | null)[] = [...stringToString.map(s => s.name), null]
    for (const t of transforms) {
      const apply = (expr: string): string => (t ? `${t}(${expr})` : expr)
      push(
        `export function ${entry}(input) {\n` +
        `  const out = []\n` +
        `  let start = 0\n` +
        `  for (;;) {\n` +
        `    const at = ${loc.name}(input, start)\n` +
        `    if (at === -1 || at < start) { out.push(${apply('input.slice(start)')}); break }\n` +
        `    out.push(${apply('input.slice(start, at)')})\n` +
        `    start = at + 1\n` +
        `  }\n` +
        `  return out\n` +
        `}`)
    }
  }

  return out
}
