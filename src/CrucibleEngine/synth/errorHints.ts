// Deterministic oracle-failure → actionable-hint distillation (Workstream 1 critic support).
//
// Why this exists: the on-device FM demonstrably does NOT self-correct from a raw oracle
// failure line within its round budget — confirmed live 2026-07-04 on summaryModule, where
// three consecutive rounds received `FAIL — result["acct-A"].balance === credits - debits
// (got 0, expected 50)` and re-emitted the identical missing-assignment bug every time. A
// small model needs the failure translated into an IMPERATIVE, code-shaped instruction, not
// a test transcript. This module does that translation with zero model inference: it
// pattern-matches the known failure shapes our own derivers emit (so the patterns are
// closed-world, not guesses about arbitrary test output) and returns a one-sentence fix
// instruction the retry prompt can surface above the raw error.
//
// Closed-world contract: every pattern here corresponds to a specific assertion family in
// derive.ts / deriveInvariant.ts. When adding a new assertion family, add its hint here.

export function distillHint(detail: string, _spec: string): string | null {
  // grouped-ledger-aggregate: derived field never assigned (deriveInvariantTests).
  // Detail shape: `result["k"].balance === credits - debits  (got 0, expected 50)`
  let m = detail.match(/\.(\w+) === (\w+) - (\w+)[^|]*\(got /)
  if (m) {
    return `Your code never computes the \`${m[1]}\` field. After accumulating \`${m[2]}\` and \`${m[3]}\` for each entry, you MUST set \`${m[1]} = ${m[2]} - ${m[3]}\` on EVERY entry of the result before returning it.`
  }

  // opts-transform-smoke: candidate throws on a legitimate call (deriveOptsTransformSmokeTest).
  if (/does not throw on a well-formed call/.test(detail) && /threw:.*(?:opts|Opts)/.test(detail)) {
    return 'The second parameter (opts) is a SINGLE plain object, NOT an array. Delete any `Array.isArray(opts)` check or throw on opts — validating opts as an array rejects every legitimate call.'
  }

  // opts-transform-smoke: boolean flag `false` must equal omitted.
  m = detail.match(/FAIL — (\w+):false identical to \1 omitted/)
  if (m) {
    return `\`${m[1]}: false\` must produce EXACTLY the same output as omitting \`${m[1]}\` entirely. Only change behavior when \`${m[1]} === true\` — never treat false differently from undefined.`
  }

  // opts-transform-smoke: default direction must be ascending.
  m = detail.match(/FAIL — sorted ascending by (\w+) when direction omitted/)
  if (m) {
    return `When \`direction\` is omitted it must default to 'asc': the result must be ordered ascending by \`${m[1]}\`. Check your comparator's sign and the default you apply.`
  }

  // opts-transform-smoke / shared: input array mutated.
  if (/FAIL — does not mutate input/.test(detail)) {
    return 'You are mutating the input array (Array.prototype.sort sorts IN PLACE). Copy it first: `[...items].sort(...)` — never call .sort() directly on the parameter.'
  }

  return null
}
