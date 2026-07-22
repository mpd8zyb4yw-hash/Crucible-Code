// ═══════════════════════════════════════════════════════════════════════════════
// CONSENSUS FUZZ — a property-invariant post-acceptance gate for ARBITRARY functions
// (W12 → ladder, no-reference extension)
// ═══════════════════════════════════════════════════════════════════════════════
//
// makeCanonicalFuzzStage (fuzzResearch.ts) closes the "certified-but-edge-case-wrong" hole
// ONLY for canonical families — the ones metamorphicSpec.ts can hand a single trusted
// `canonicalImpl` reference. Every OTHER function the differential tier reaches (`titleCase`,
// `groupBy`, `twoSum`, arbitrary business logic) has NO such reference, so the single-shot
// fuzz gate was inert for exactly the open-ended requests differential consensus exists to serve.
//
// This module extends the gate to those functions using the SAME oracle the differential tier
// already trusts to derive its cases: AGREEMENT ACROSS INDEPENDENTLY-WRITTEN IMPLEMENTATIONS. The
// differential derivation already sampled a quorum of distinct impls (differentialSpec.ts) — here
// we KEEP them and, on every fuzzed input, compute their consensus:
//
//   • a value ≥quorum DISTINCT impls agree on  → that value is the derived oracle for this input;
//     a candidate that disagrees is a witnessed edge-case bug (FAIL, hard gate);
//   • ≥quorum impls THROW                       → throwing is the consensus behaviour; a candidate
//     that returns a value there is wrong (crash-kind counterexample);
//   • NO quorum (impls disagree)                → FUZZ_ABSTAIN: no trusted answer, never judged.
//
// Soundness mirrors the differential tier exactly (and inherits its one honest limit: a bug shared
// systematically across every sampled impl can seat a wrong consensus — strictly rarer than single
// -value consensus, and only ever seen alongside the same risk the derived cases already carry).
// The stage can ONLY reject on a witnessed quorum disagreement; too-few-loadable impls, an
// abstaining fuzz run, or a candidate that agrees across the budget all PASS. No model is consulted.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  coverageFuzz,
  intArrayMutator,
  stringMutator,
  tupleMutator,
  FUZZ_ABSTAIN,
  type Mutator,
  type Rng,
} from './coverageFuzz'
import { createCoverageHarness, type CoverageHarness } from './faultLocalize'
import type { Candidate, Verdict } from './types'
import type { LadderStage } from './verifierLadder'

/** One independently-written implementation (the differential tier's samples). */
export interface ImplRef {
  source: string
  fingerprint: string
}

export interface ConsensusFuzzOpts {
  entry: string
  /** The distinct independent implementations whose agreement is the oracle. */
  impls: ImplRef[]
  /** Fuzz seeds — pass the real acceptance-case argument tuples so the search starts from live inputs. */
  seeds?: unknown[][]
  /** Override the inferred mutator (by default shape-inferred from the seeds). */
  mutate?: Mutator
  /** Distinct-impl agreement required to trust a value. Defaults to the differential quorum. */
  quorum?: number
  iterations?: number
  seed?: number
  timeoutMs?: number
  /** Label folded into the fail signal. */
  family?: string
}

/**
 * Build a CONSENSUS reference callable: `(...args) => value | FUZZ_ABSTAIN` (throws when the
 * quorum's consensus is to throw). Loads each impl into a coverage harness once. Returns null
 * when fewer than two impls load (no corroboration possible → no oracle → caller stays inert).
 */
export function buildConsensusReference(
  impls: ImplRef[],
  entry: string,
  opts: { quorum?: number; timeoutMs?: number } = {},
): { ref: (...args: unknown[]) => unknown; loaded: number } | null {
  const harnesses: CoverageHarness[] = []
  const seenFp = new Set<string>()
  for (const im of impls) {
    if (!im.source || seenFp.has(im.fingerprint)) continue
    const h = createCoverageHarness(im.source, { timeoutMs: opts.timeoutMs })
    if ('error' in h) continue
    if (!(h as CoverageHarness).hasEntry(entry)) continue
    seenFp.add(im.fingerprint)
    harnesses.push(h as CoverageHarness)
  }
  if (harnesses.length < 2) return null

  // Differential quorum: majority AND ≥2 distinct sources (matches differentialSpec.ts).
  const quorum = Math.max(2, opts.quorum ?? Math.floor(harnesses.length / 2) + 1)

  const ref = (...args: unknown[]): unknown => {
    const byValue = new Map<string, number>()  // value-json → count of impls returning it
    let throws = 0
    let usable = 0
    const firstOf = new Map<string, unknown>() // value-json → the parsed value (avoid a re-parse)
    for (const h of harnesses) {
      const c = h.call(entry, args)
      if (!c.ok) { throws++; continue }
      let k: string | undefined
      try { k = JSON.stringify(c.value) } catch { continue } // non-JSON return → not usable ground truth
      if (k === undefined) continue // undefined return → not usable ground truth
      usable++
      byValue.set(k, (byValue.get(k) ?? 0) + 1)
      if (!firstOf.has(k)) firstOf.set(k, c.value)
    }
    // A value quorum wins over a throw quorum (a concrete answer is stronger than "everyone rejects").
    let bestKey: string | null = null
    let bestN = 0
    for (const [k, n] of byValue) if (n > bestN) { bestKey = k; bestN = n }
    if (bestKey != null && bestN >= quorum) return firstOf.get(bestKey)
    if (throws >= quorum) throw new Error('consensus: reference rejects')
    // No quorum on any value and not enough agree to throw → decline (soundness: never guess).
    void usable
    return FUZZ_ABSTAIN
  }
  return { ref, loaded: harnesses.length }
}

/**
 * Build the consensus-fuzz VERIFIER-LADDER STAGE. Composed AFTER acceptance in a runLadder (cost 5,
 * matching the canonical fuzz rung), it runs only on acceptance-certified candidates and hard-fails
 * one that disagrees with the independent-impl consensus on a fuzzed input. Returns null when no
 * consensus reference can be formed (<2 loadable impls) — the caller then leaves the ladder as plain
 * acceptance, so the no-oracle path is byte-for-byte unchanged. Deterministic (seeded fuzz); no model.
 */
export function makeConsensusFuzzStage(opts: ConsensusFuzzOpts): LadderStage<string> | null {
  const built = buildConsensusReference(opts.impls, opts.entry, { quorum: opts.quorum, timeoutMs: opts.timeoutMs })
  if (!built) return null

  const seeds = opts.seeds && opts.seeds.length ? dedupeTuples(opts.seeds) : [[]]
  const mutate = opts.mutate ?? inferMutator(seeds)
  const pass: Verdict = { pass: true, score: 0, signals: [] }
  const fam = opts.family ? `${opts.family} ` : ''

  return {
    name: 'consensus-fuzz',
    cost: 5,
    hard: true,
    verify: (candidate: Candidate<string>): Verdict => {
      if (!candidate.value) return pass
      const r = coverageFuzz(candidate.value, opts.entry, seeds, mutate, {
        reference: built.ref,
        iterations: opts.iterations ?? 300,
        seed: opts.seed ?? 0x1234_5678,
        timeoutMs: opts.timeoutMs,
      })
      if (r.status !== 'counterexample' || !r.counterexample) return pass
      const cx = r.counterexample
      const wrong = cx.candidate.threw ? `threw ${cx.candidate.threw}` : `returned ${fmt(cx.candidate.value)}`
      const want = cx.reference?.threw
        ? `${built.loaded} independent implementations reject it (throw)`
        : `${built.loaded} independent implementations agree the answer is ${fmt(cx.reference?.value)}`
      return {
        pass: false,
        score: -1,   // passed every fixed case, disagrees with consensus on ONE input — a near-miss
        signals: [`${fam}edge case the fixed cases miss: input ${cx.args.map(fmt).join(', ')} → your code ${wrong}, but ${want}`],
      }
    },
  }
}

// ── Shape-inferred mutators for arbitrary arg tuples ──────────────────────────────
// The differential tier reaches functions of unknown shape, so we infer the fuzz mutator from a
// real seed tuple. A shape we don't recognise gets an identity mutator: the coverage loop still
// RUNS the seed (so the consensus oracle is still consulted on it), it just isn't perturbed —
// fewer inputs explored, never an unsound judgement.

const numberMutator: Mutator = (args, rng) => {
  const base = typeof args?.[0] === 'number' ? (args[0] as number) : 0
  const roll = rng()
  if (roll < 0.2) return [0]
  if (roll < 0.35) return [-base]
  if (roll < 0.55) return [base + (Math.floor(rng() * 7) - 3)]
  if (roll < 0.75) return [Math.floor(rng() * 201) - 100]
  if (roll < 0.9) return [base * 2]
  return [base + 1] // boundary nudge
}

const STR_POOL = ['', 'a', 'Hello World', 'racecar', 'aBc', 'noon', '  x  ', 'a1b2']
const strArrayMutator: Mutator = (args, rng) => {
  const base = Array.isArray(args?.[0]) ? (args![0] as string[]).slice() : []
  const roll = rng()
  if (roll < 0.25 || base.length === 0) base.push(STR_POOL[Math.floor(rng() * STR_POOL.length)]!)
  else if (roll < 0.45) base.splice(Math.floor(rng() * base.length), 1)
  else if (roll < 0.7) base[Math.floor(rng() * base.length)] = STR_POOL[Math.floor(rng() * STR_POOL.length)]!
  else base.reverse()
  return [base]
}

const identityMutator = (sample: unknown): Mutator => (_args: unknown[] | null, _rng: Rng) => [sample]

/** Pick a single-position mutator for one argument value's shape. */
function elementMutator(sample: unknown): Mutator {
  if (typeof sample === 'string') return stringMutator
  if (typeof sample === 'number') return numberMutator
  if (Array.isArray(sample)) {
    if (sample.every(x => typeof x === 'number')) return intArrayMutator
    if (sample.every(x => typeof x === 'string')) return strArrayMutator
    return intArrayMutator // mixed/empty array: int-array mutation is a reasonable default
  }
  return identityMutator(sample)
}

/** Infer a whole-tuple mutator from a representative seed tuple. */
export function inferMutator(seeds: unknown[][]): Mutator {
  const sample = seeds.find(s => Array.isArray(s) && s.length > 0) ?? seeds[0] ?? []
  if (sample.length <= 1) return elementMutator(sample[0])
  return tupleMutator(sample.map(elementMutator))
}

function dedupeTuples(tuples: unknown[][]): unknown[][] {
  const seen = new Set<string>()
  const out: unknown[][] = []
  for (const t of tuples) {
    let k: string
    try { k = JSON.stringify(t) } catch { continue }
    if (seen.has(k)) continue
    seen.add(k); out.push(t)
  }
  return out
}

function fmt(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '…' : s }
  catch { return String(v) }
}
