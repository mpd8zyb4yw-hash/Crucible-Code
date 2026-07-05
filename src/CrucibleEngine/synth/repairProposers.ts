// Deterministic candidate-repair proposers — pure-code mutations of a FAILED FM candidate,
// re-gated by the same oracle that rejected the original. Zero model inference.
//
// Rationale ("the intelligence lives in the system"): the on-device FM reproducibly makes a
// small class of mechanical slips it cannot self-correct within its round budget (confirmed
// live 2026-07-04: the never-assigned derived field on summaryModule — byte-identical across
// 3 fires — and the copy-pasted `Array.isArray(opts)` throw-guard on sortModule — identical
// across 2 fires). Both slips are DETECTABLE from the oracle's failure detail and FIXABLE by
// a deterministic source transform. So instead of burning another FM round hoping the model
// notices, we propose the mechanical fix ourselves and let the oracle judge it.
//
// Safety invariant (same as every proposer in this engine): a repair is a PROPOSAL, never a
// ship. Every proposed repair goes back through verifyCandidateAsync (tsc + the full derived
// test) before it can be accepted. A wrong or misfired transform is rejected exactly like a
// wrong FM candidate — the WRONG=0 floor is untouched. Repairs are keyed off the closed-world
// failure shapes OUR OWN derivers emit (deriveInvariant.ts), not arbitrary test output.
//
// COMPOSITION (added 2026-07-04, after the ledger showed a second summaryModule shape): the
// FM doesn't always fail the SAME way. One run omits the derived field's ASSIGNMENT (compiles,
// wrong value — caught by the runtime invariant test); another run omits the field from the
// object literal ENTIRELY (a straight tsc TS2741 "missing in type" error, rejected before the
// runtime test even runs). Fixing only the first shape left the second one dead on arrival —
// no amount of runtime-test repair helps code that doesn't compile. So `repairMissingField`
// (detail-driven, fixes TS2741 with a type-appropriate stub default) and `repairDerivedField`
// (SPEC-driven — parses "X = A - B" straight from the spec text, not from `detail`, so it can
// run regardless of which failure shape triggered this round) are composed: every detail-driven
// repair candidate is ALSO passed through the spec-driven repair, so "stub the missing field"
// and "compute the missing field correctly" can land in the SAME round instead of needing two.

/** Best-effort default literal for a TS primitive type name. */
function defaultForType(t: string): string {
  if (t === 'string') return "''"
  if (t === 'boolean') return 'false'
  if (t === 'number') return '0'
  return 'null'
}

/**
 * TS2741 "Property 'X' is missing in type '{ a: T; b: T }' but required in type 'Y'" — the
 * object literal is missing a required field entirely (a straight compile error, not a value
 * bug). Finds a single-line-ish object literal in source containing all the OTHER fields the
 * error names, and appends the missing field with a stub default inferred from Y's own
 * declaration in the candidate (falls back to '0' if Y isn't found locally).
 */
function repairMissingField(candidate: string, detail: string): string | null {
  const m = detail.match(/Property '(\w+)' is missing in type '\{([^}]*)\}' but required in type '(\w+)'/)
  if (!m) return null
  const [, missingField, presentFieldsRaw, requiredType] = m
  const presentFields = Array.from(presentFieldsRaw.matchAll(/(\w+):/g), x => x[1])
  if (!presentFields.length) return null

  let defaultVal = '0'
  const ifaceMatch = candidate.match(new RegExp(`interface\\s+${requiredType}\\s*\\{([\\s\\S]*?)\\}`))
  if (ifaceMatch) {
    const fieldType = ifaceMatch[1].match(new RegExp(`\\b${missingField}\\s*\\??:\\s*(\\w+)`))
    if (fieldType) defaultVal = defaultForType(fieldType[1])
  }

  // Match an object literal containing ALL present fields as keys (order-independent, no
  // nested braces inside — the exact shape our own bug class produces), not already containing
  // the missing field, and splice the stub field in before its closing brace.
  const keyPattern = presentFields.map(f => `${f}\\s*:`).join('[\\s\\S]*?')
  const literalRx = new RegExp(`\\{[^{}]*?${keyPattern}[^{}]*?\\}`, 'g')
  let replaced = false
  const repaired = candidate.replace(literalRx, (lit) => {
    if (replaced || new RegExp(`\\b${missingField}\\s*:`).test(lit)) return lit
    replaced = true
    return lit.replace(/\}\s*$/, `, ${missingField}: ${defaultVal} }`)
  })
  return replaced ? repaired : null
}

/**
 * SPEC-driven (not detail-driven): if the spec pins a field down as the difference of two
 * others (e.g. "balance = credits - debits" — same regex deriveInvariant.ts uses to build the
 * runtime test), inject an assignment loop before every `return <ident>` so the field is
 * actually computed, whatever `detail` currently says. Runs unconditionally so it composes
 * with detail-driven repairs above (stub-then-compute) instead of needing its own round.
 */
function repairDerivedField(candidate: string, spec: string): string | null {
  const rel = spec.match(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*-\s*([A-Za-z_]\w*)\b/)
  if (!rel) return null
  const [, field, a, b] = rel
  if (field === a || field === b || a === b) return null
  const returnedIdents = new Set(
    Array.from(candidate.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*[;\n}]/g), m => m[1])
      .filter(v => !['null', 'undefined', 'true', 'false', 'this', 'void'].includes(v)),
  )
  let best: string | null = null
  for (const v of returnedIdents) {
    const fix = `for (const __k of Object.keys(${v})) { (${v} as any)[__k].${field} = (${v} as any)[__k].${a} - (${v} as any)[__k].${b} }\n  `
    const repaired = candidate.replace(new RegExp(`(\\breturn\\s+${v}\\b)`, 'g'), `${fix}$1`)
    if (repaired !== candidate) best = repaired   // last matching returned-ident wins; good enough for single-return functions
  }
  return best
}

/**
 * "Dynamic key extracted then used as a bracket-index" bug — confirmed live 2026-07-04 on a
 * sortModule fire: `const key = opts.by === 'price' ? a.price : a.name` correctly extracts the
 * comparison VALUE for `a`, but the comparator then writes `b[key]` — indexing `b` by that
 * VALUE (a number/string) instead of mirroring the same field-selection ternary on `b`. Since
 * `b[19.99]` is `undefined`, every comparison degenerates and the sort order breaks, caught by
 * the opts-transform-smoke family's spec-gated "sorted ascending when direction omitted" check.
 * Deterministic repair: mirror the exact ternary structure that built the key for `a` onto the
 * bracket-indexed variable, replacing `b[key]` with `(opts.by === 'price' ? b.price : b.name)`.
 * Gated on BOTH the syntactic pattern AND the specific sortedness-check failure, keeping it
 * closed-world (tied to an assertion family we ourselves derive) rather than a generic rewrite.
 */
function repairDynamicKeyIndex(candidate: string, detail: string): string | null {
  if (!/FAIL — sorted ascending by \w+ when direction omitted/.test(detail)) return null
  const decl = candidate.match(
    /const\s+(\w+)\s*=\s*([\w.]+)\s*===\s*('[^']*'|"[^"]*")\s*\?\s*(\w+)\.(\w+)\s*:\s*\4\.(\w+)/,
  )
  if (!decl) return null
  const [, keyVar, condExpr, condValue, itemVar, field1, field2] = decl
  const otherVars = new Set(
    Array.from(candidate.matchAll(new RegExp(`\\b${itemVar}\\s*,\\s*(\\w+)\\)\\s*=>`, 'g')), m => m[1]),
  )
  let repaired = candidate
  let changed = false
  for (const other of otherVars) {
    const bracketRx = new RegExp(`\\b${other}\\[${keyVar}\\]`, 'g')
    if (bracketRx.test(repaired)) {
      changed = true
      repaired = repaired.replace(bracketRx, `(${condExpr} === ${condValue} ? ${other}.${field1} : ${other}.${field2})`)
    }
  }
  return changed ? repaired : null
}

/**
 * "Explicit-value check instead of default-negative check" on an optional 'asc'|'desc' field —
 * confirmed live 2026-07-04 alongside the dynamic-key-index bug on the SAME sortModule fire:
 * the comparator gates ascending behavior on `opts.direction === 'asc'`, which is FALSE when
 * `direction` is omitted (undefined !== 'asc'), so the else branch — written for 'desc' — runs
 * by default. The spec pins `direction` default to 'asc'; the exhaustive, safe fix for a field
 * typed `'asc' | 'desc' | undefined` is to treat everything that ISN'T explicitly 'desc' as
 * ascending. Gated on the same sortedness-check failure as the repair above so it only fires
 * when we have a concrete, derived reason to suspect the default branch is wrong.
 */
function repairDefaultDirectionCheck(candidate: string, detail: string): string | null {
  if (!/FAIL — sorted ascending by \w+ when direction omitted/.test(detail)) return null
  const rx = /(\w+)\.direction\s*===\s*'asc'/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, "$1.direction !== 'desc'")
  return repaired !== candidate ? repaired : null
}

/**
 * One-sided case-insensitive comparison — confirmed live 2026-07-04 on a filterModule fire
 * (found via the `testTail` fix that stopped hiding this failure from the retry prompt): the
 * candidate lowercases the FIELD being searched (`user.name.toLowerCase()`) but never
 * lowercases the SEARCH TERM itself (`opts.query`), so `.includes(opts.query)` only matches
 * when the query happens to already be lowercase — searching "ALPHA" misses "alpha". Repair:
 * wrap the `.includes(...)` argument in `.toLowerCase()` wherever it's compared against an
 * already-lowercased field and isn't already lowercased itself.
 */
function repairOneSidedCaseInsensitive(candidate: string, detail: string): string | null {
  if (!/FAIL — query filter case-insensitive/.test(detail)) return null
  const rx = /\.toLowerCase\(\)\.includes\(\s*([A-Za-z_][\w.]*)\s*\)/g
  let changed = false
  const repaired = candidate.replace(rx, (whole, arg) => {
    if (/\.toLowerCase\(\)$/.test(arg)) return whole   // already lowercased, not the bug
    changed = true
    return `.toLowerCase().includes(${arg}.toLowerCase())`
  })
  return changed ? repaired : null
}

/**
 * Classic `if (opts.active && !user.active) continue` guard bug — confirmed live 2026-07-04 on
 * the SAME filterModule fire as the case-insensitive bug above. `opts.active && ...` is FALSE
 * (so the guard is skipped, filtering nothing) whenever `opts.active` is explicitly `false` —
 * the exact case the caller wants to filter ON. The correct check needs to distinguish "no
 * filter given" (`undefined`) from "filter for false" — `opts.active !== undefined` — then
 * exclude on inequality (`user.active !== opts.active`), not truthiness. Repair targets the
 * exact syntactic shape found live: `<field>.active && !<item>.active` used as a skip/continue
 * condition, rewritten to the undefined-aware inequality form.
 */
function repairActiveFalseGuard(candidate: string, detail: string): string | null {
  if (!/FAIL — active=false returns only inactive/.test(detail)) return null
  const rx = /(\w+)\.active\s*&&\s*!\s*(\w+)\.active\b/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, "$1.active !== undefined && $2.active !== $1.active")
  return repaired !== candidate ? repaired : null
}

/**
 * `paramName.sort(...)` mutates its argument in place instead of returning a new array —
 * confirmed live 2026-07-05/06 on a leaderboardModule fire (`sortScoresAscending(scores) {
 * return scores.sort(...) }`), caught by localHardenFuzz's `sort-no-mutate` property (see
 * localHardenFuzzWorker.cjs). The regex only matches a bare `identifier.sort(` — it
 * structurally cannot match an already-safe `[...identifier].sort(` (a `]` sits between the
 * identifier and the dot) or `identifier.slice().sort(` (a `)` sits between them), so this
 * repair is a no-op on already-correct code and only fires on the exact mutating shape.
 * Gated on the fuzz layer's own mutation-failure message so it only proposes this rewrite
 * when there's a concrete, derived reason to suspect an in-place sort.
 */
function repairMutatingSort(candidate: string, detail: string): string | null {
  if (!/mutates its input argument in place/.test(detail)) return null
  const rx = /\b([A-Za-z_$][\w$]*)\.sort\(/g
  if (!rx.test(candidate)) return null
  const repaired = candidate.replace(rx, '[...$1].sort(')
  return repaired !== candidate ? repaired : null
}

/**
 * Spurious Array.isArray guard on a non-array opts parameter — the FM copy-pastes the
 * (correct) items-array validation onto the singular opts object, making the function throw
 * on every legitimate call. Strip exactly that guard.
 */
function repairArrayGuard(candidate: string, detail: string): string | null {
  if (!/does not throw on a well-formed call/.test(detail) || !/threw:/.test(detail)) return null
  const guardRx = /[ \t]*if\s*\(\s*!Array\.isArray\(\s*opts\s*\)\s*\)\s*(?:\{[^{}]*\}|throw[^;]*;|[^;{]*;)\s*\n?/g
  if (!guardRx.test(candidate)) return null
  guardRx.lastIndex = 0
  const repaired = candidate.replace(guardRx, '')
  return repaired !== candidate ? repaired : null
}

// Detail-driven single-bug fixes. More than one can legitimately apply to the SAME candidate
// (confirmed live 2026-07-04: one sortModule fire had both the dynamic-key-index bug and the
// default-direction-check bug at once) — `proposeRepairs` below tries each alone AND all of
// them composed in sequence, so a candidate with N independent slips gets one shot at a fully
// repaired variant instead of needing N separate rounds to discover each in isolation.
const DETAIL_DRIVEN_REPAIRS: Array<(candidate: string, detail: string) => string | null> = [
  repairMissingField,
  repairArrayGuard,
  repairDynamicKeyIndex,
  repairDefaultDirectionCheck,
  repairOneSidedCaseInsensitive,
  repairActiveFalseGuard,
  repairMutatingSort,
]

/** Propose zero or more deterministically-repaired variants of a rejected candidate. */
export function proposeRepairs(candidate: string, detail: string, spec: string): string[] {
  const stage1 = [candidate]   // seed so spec-driven repairs below can apply standalone too
  for (const repair of DETAIL_DRIVEN_REPAIRS) {
    const r = repair(candidate, detail)
    if (r) stage1.push(r)
  }
  // Composed variant: apply every applicable detail-driven repair in sequence to one candidate,
  // for the case where several independent slips co-occur (each fix is self-gated by its own
  // pattern match, so applying a non-matching one is a safe no-op).
  let composed = candidate
  for (const repair of DETAIL_DRIVEN_REPAIRS) {
    const r = repair(composed, detail)
    if (r) composed = r
  }
  if (composed !== candidate) stage1.push(composed)

  const out = new Set<string>()
  for (const c of stage1) {
    if (c !== candidate) out.add(c)               // the detail-driven repair(s) alone
    const withDerived = repairDerivedField(c, spec)
    if (withDerived && withDerived !== candidate) out.add(withDerived)   // composed with spec-driven
  }
  return Array.from(out)
}
