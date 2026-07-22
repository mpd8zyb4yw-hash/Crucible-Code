// ═══════════════════════════════════════════════════════════════════════════════
// COVERAGE-GUIDED DIFFERENTIAL / PROPERTY FUZZING  (DOCTRINE / GAP_CLOSURE W12)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Fixed acceptance cases only test the inputs someone thought to write down. The
// non-obvious bugs (success bar #3) live in the inputs nobody wrote down — the rare
// branch, the empty edge, the duplicate, the boundary. This fuzzer finds them with
// no oracle-trust and, for the differential mode, no human labels at all:
//
//   • COVERAGE-GUIDED. Every candidate run is instrumented (reusing faultLocalize's
//     probes). An input that reaches a source line no prior input reached is KEPT in
//     the corpus and mutated further — so the search actively drills into unexplored
//     branches instead of re-hitting the same happy path. This is the property the
//     existing fixed-case / random property tests do NOT have.
//
//   • DIFFERENTIAL. Given a trusted reference implementation, ANY input where the
//     candidate and reference disagree is a bug WITH A WITNESS — no oracle needed,
//     the disagreement itself is ground truth (metamorphicSpec.ts supplies canonical
//     references for known families; callers can pass any).
//
//   • PROPERTY. When no reference exists, an invariant (idempotence, sortedness,
//     bounds) is checked on every generated input.
//
//   • MINIMIZED. Any counterexample is delta-debugged (shrunk) to a minimal failing
//     input before it is returned — a 2-element witness is nearly a proof of the bug,
//     a 200-element one teaches almost nothing (doctrine §4, feeds W5's feedback record).
//
// Deterministic: a seeded PRNG (no Math.random), so a run is reproducible from its seed.
// No model is consulted here.
// ═══════════════════════════════════════════════════════════════════════════════

import { createCoverageHarness, deepEqual, type CoverageHarness } from './faultLocalize'

/** Reproducible PRNG — a run is fully determined by its seed (doctrine: no hidden nondeterminism). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = () => number
/** Produce a fresh argument tuple, or mutate an existing one, using the PRNG. */
export type Mutator = (args: unknown[] | null, rng: Rng) => unknown[]

export interface FuzzOpts {
  /** Differential oracle: the trusted reference. Disagreement candidate≠reference is a bug. */
  reference?: (...args: unknown[]) => unknown
  /** Property oracle (used when no reference): must hold for every non-throwing candidate output. */
  property?: (args: unknown[], output: unknown) => boolean
  iterations?: number
  seed?: number
  timeoutMs?: number
  /** Max shrink passes when minimizing a counterexample. */
  maxShrink?: number
}

export interface Counterexample {
  args: unknown[]
  candidate: { value?: unknown; threw?: string }
  reference?: { value?: unknown; threw?: string }
  /** How the oracle was violated. */
  kind: 'differential' | 'property' | 'crash'
}

export interface FuzzResult {
  status: 'clean' | 'counterexample' | 'abstain'
  reason?: string
  counterexample?: Counterexample
  /** Total candidate executions (seeds + generated). */
  iterations: number
  /** Inputs retained because they expanded coverage. */
  corpusSize: number
  /** Distinct source lines the fuzzer drove the candidate through. */
  edgesCovered: number
}

interface Call { ok: boolean; value?: unknown; threw?: string }
function safeCall(fn: (...a: unknown[]) => unknown, args: unknown[]): Call {
  try {
    return { ok: true, value: fn(...args) }
  } catch (e: any) {
    return { ok: false, threw: String(e?.message ?? e) }
  }
}

/**
 * Coverage-guided fuzz of `source`'s `entry` against a reference or property oracle.
 * Returns a minimized counterexample on the first disagreement, or `clean` if none is found
 * within the budget. Abstains honestly if the candidate won't instrument/load or lacks the entry,
 * or if no oracle was supplied.
 */
export function coverageFuzz(
  source: string,
  entry: string,
  seeds: unknown[][],
  mutate: Mutator,
  opts: FuzzOpts = {},
): FuzzResult {
  const iterations = opts.iterations ?? 500
  const maxShrink = opts.maxShrink ?? 200
  const rng = mulberry32(opts.seed ?? 0x1234_5678)

  const abstain = (reason: string): FuzzResult => ({ status: 'abstain', reason, iterations: 0, corpusSize: 0, edgesCovered: 0 })

  if (!opts.reference && !opts.property) return abstain('no oracle: pass a reference or a property')

  const harness = createCoverageHarness(source, { timeoutMs: opts.timeoutMs })
  if ('error' in harness) return abstain(harness.error)
  const h = harness as CoverageHarness
  if (!h.hasEntry(entry)) return abstain(`candidate does not export an '${entry}' function`)

  const globalCov = new Set<number>()

  // Does `args` violate the oracle? Returns a Counterexample or null. Also feeds the global
  // coverage set so the caller's corpus decisions are coverage-guided.
  const check = (args: unknown[]): Counterexample | null => {
    const cand = h.call(entry, args)
    for (const line of cand.covered) globalCov.add(line)

    if (opts.reference) {
      const ref = safeCall(opts.reference, args)
      const agree =
        cand.ok && ref.ok ? deepEqual(cand.value, ref.value)
        : !cand.ok && !ref.ok ? true // both throw on the same input — that is agreement, not a bug
        : false
      if (!agree) {
        return {
          args,
          candidate: cand.ok ? { value: cand.value } : { threw: cand.threw },
          reference: ref.ok ? { value: ref.value } : { threw: ref.threw },
          kind: cand.ok !== ref.ok ? 'crash' : 'differential',
        }
      }
      return null
    }

    // Property mode: a throw can never satisfy a value invariant, so it is a crash counterexample.
    if (!cand.ok) return { args, candidate: { threw: cand.threw }, kind: 'crash' }
    if (!opts.property!(args, cand.value)) return { args, candidate: { value: cand.value }, kind: 'property' }
    return null
  }

  // Coverage tracked for corpus admission: an input that grows global coverage is "interesting".
  const coveringRun = (args: unknown[]): { cex: Counterexample | null; grew: boolean } => {
    const before = globalCov.size
    const cex = check(args)
    return { cex, grew: globalCov.size > before }
  }

  let iters = 0
  const corpus: unknown[][] = []

  // 1) Seed the corpus. A seed that already breaks the oracle short-circuits to shrinking.
  for (const s of seeds) {
    iters++
    const { cex } = coveringRun(s)
    corpus.push(s)
    if (cex) return finish(cex)
  }
  if (!corpus.length) corpus.push(mutate(null, rng))

  // 2) Coverage-guided loop: draw an interesting input, mutate it, keep mutants that expand coverage.
  for (; iters < iterations; iters++) {
    const parent = corpus[Math.floor(rng() * corpus.length)] ?? null
    const child = mutate(parent, rng)
    const { cex, grew } = coveringRun(child)
    if (cex) return finish(cex)
    if (grew) corpus.push(child)
  }

  return { status: 'clean', iterations: iters, corpusSize: corpus.length, edgesCovered: globalCov.size }

  // ── Shrinking: delta-debug the failing input to a minimal one that STILL fails ──
  function stillFails(args: unknown[]): boolean {
    return check(args) !== null
  }
  function finish(cex: Counterexample): FuzzResult {
    let best = cex.args
    for (let round = 0; round < maxShrink; round++) {
      let improved = false
      for (const cand of simplify(best)) {
        if (stillFails(cand)) { best = cand; improved = true; break }
      }
      if (!improved) break
    }
    // Recompute the witness on the minimized input so the reported values match the shrunk args.
    const minimal = check(best) ?? cex
    return { status: 'counterexample', counterexample: minimal, iterations: iters, corpusSize: corpus.length, edgesCovered: globalCov.size }
  }
}

// ── Generic structural simplifications: smaller/simpler candidate arg tuples ──────
function* simplify(args: unknown[]): Iterable<unknown[]> {
  for (let i = 0; i < args.length; i++) {
    for (const s of simplifyValue(args[i])) {
      const copy = args.slice()
      copy[i] = s
      yield copy
    }
  }
}
function* simplifyValue(v: unknown): Iterable<unknown> {
  if (typeof v === 'number' && v !== 0) {
    yield 0
    if (Number.isInteger(v)) {
      const half = Math.trunc(v / 2)
      if (half !== v) yield half
    }
  }
  if (typeof v === 'string' && v.length) {
    yield ''
    yield v.slice(0, -1)
    yield v.slice(1)
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const c = v.slice()
      c.splice(i, 1)
      yield c // drop one element
    }
    for (let i = 0; i < v.length; i++) {
      for (const s of simplifyValue(v[i])) {
        const c = v.slice()
        c[i] = s
        yield c // shrink one element in place
      }
    }
  }
}

// ── Convenience mutators for the common arg shapes ───────────────────────────────
/** Mutate/generate a single `number[]` argument — grows, shrinks, and perturbs elements. */
export const intArrayMutator: Mutator = (args, rng) => {
  const base = Array.isArray(args?.[0]) ? (args![0] as number[]).slice() : []
  const roll = rng()
  if (roll < 0.25 || base.length === 0) base.push(Math.floor(rng() * 21) - 10) // append [-10,10]
  else if (roll < 0.45) base.splice(Math.floor(rng() * base.length), 1) // drop one
  else if (roll < 0.7) base[Math.floor(rng() * base.length)] = Math.floor(rng() * 21) - 10 // perturb
  else if (roll < 0.85) base.push(0) // boundary value
  else base.reverse()
  return [base]
}
