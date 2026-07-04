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

/** Propose zero or more deterministically-repaired variants of a rejected candidate. */
export function proposeRepairs(candidate: string, detail: string, _spec: string): string[] {
  const out: string[] = []

  // ── Repair 1: derived field never assigned (grouped-ledger-aggregate failures). ─────────
  // Failure detail pins the exact relationship: `.balance === credits - debits (got 0, ...)`.
  // Transform: before every `return <ident>` in the candidate, inject a loop that assigns
  // the derived field on every entry. If the returned identifier isn't actually the result
  // record, tsc or the behavioral re-run rejects the repair — no risk of shipping garbage.
  const rel = detail.match(/\.(\w+) === (\w+) - (\w+)[^|]*\(got /)
  if (rel) {
    const [, field, a, b] = rel
    const returnedIdents = new Set(
      Array.from(candidate.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*[;\n}]/g), m => m[1])
        .filter(v => !['null', 'undefined', 'true', 'false', 'this', 'void'].includes(v)),
    )
    for (const v of returnedIdents) {
      const fix = `for (const __k of Object.keys(${v})) { (${v} as any)[__k].${field} = (${v} as any)[__k].${a} - (${v} as any)[__k].${b} }\n  `
      const repaired = candidate.replace(new RegExp(`(\\breturn\\s+${v}\\b)`, 'g'), `${fix}$1`)
      if (repaired !== candidate) out.push(repaired)
    }
  }

  // ── Repair 2: spurious Array.isArray guard on a non-array opts parameter. ───────────────
  // The FM copy-pastes the (correct) items-array validation onto the singular opts object,
  // making the function throw on every legitimate call. Strip exactly that guard.
  if (/does not throw on a well-formed call/.test(detail) && /threw:/.test(detail)) {
    const guardRx = /[ \t]*if\s*\(\s*!Array\.isArray\(\s*opts\s*\)\s*\)\s*(?:\{[^{}]*\}|throw[^;]*;|[^;{]*;)\s*\n?/g
    if (guardRx.test(candidate)) {
      guardRx.lastIndex = 0
      const repaired = candidate.replace(guardRx, '')
      if (repaired !== candidate) out.push(repaired)
    }
  }

  return out
}
