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

/** Propose zero or more deterministically-repaired variants of a rejected candidate. */
export function proposeRepairs(candidate: string, detail: string, spec: string): string[] {
  // Stage 1: detail-driven repairs, seeded with the original so spec-driven repairs below can
  // also apply to it standalone (covers the case where only the assignment is missing).
  const stage1 = [candidate]
  const missing = repairMissingField(candidate, detail)
  if (missing) stage1.push(missing)
  const noGuard = repairArrayGuard(candidate, detail)
  if (noGuard) stage1.push(noGuard)

  const out = new Set<string>()
  for (const c of stage1) {
    if (c !== candidate) out.add(c)               // the detail-driven repair alone
    const withDerived = repairDerivedField(c, spec)
    if (withDerived && withDerived !== candidate) out.add(withDerived)   // composed with spec-driven
  }
  return Array.from(out)
}
