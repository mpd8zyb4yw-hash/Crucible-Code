// ═══════════════════════════════════════════════════════════════════════════════
// FUZZ RESEARCH — coverage-guided differential fuzzing as a sound ResearchFn (W12→ladder, W5)
// ═══════════════════════════════════════════════════════════════════════════════
//
// iterate()'s stall channel accepts a ResearchFn that may tighten the VERIFIER — but ONLY
// with a counterexample it can INDEPENDENTLY justify (iterate.ts §"RESEARCH IS SOUND OR IT
// IS NOTHING"). A differential disagreement against a TRUSTED canonical reference is exactly
// such a justification: the reference is the oracle, so an input where the certified candidate
// and the reference differ is a real defect the fixed acceptance cases missed — the "certified
// but edge-case-wrong" hole (metamorphicSpec's canonical impls exist precisely for these
// families). This wires coverageFuzz into the verifier ladder as a post-acceptance gate WITHOUT
// editing iterate.ts: the loop already knows how to fold a ResearchFn's new case into the next
// epoch's verifier and re-certify against it.
//
// It also carries W5's typed feedback: the MINIMIZED witness (from coverageFuzz's shrinker) and
// the TOP SUSPECT LINE (from faultLocalize, run on that very witness) become proposer grounding —
// the two highest-information artifacts for a weak model to localize and fix the edge-case bug.
//
// Soundness: a new case is injected ONLY when the reference returns a VALUE on the witness (so
// `expected` is a trusted value). A witness where the reference itself throws yields proposer
// context only, never a verifier case. No model is consulted here.
// ═══════════════════════════════════════════════════════════════════════════════

import { coverageFuzz, intArrayMutator, stringMutator, type Mutator } from './coverageFuzz'
import { createCoverageHarness, localizeFault, type CoverageHarness, type LocCase } from './faultLocalize'
import { deriveMetamorphicSpec, canonicalImpl } from './metamorphicSpec'
import type { CodeCase } from './codeVerifier'
import type { ResearchFn, ResearchOutput } from './iterate'
import type { Candidate, Verdict } from './types'
import type { LadderStage } from './verifierLadder'

export interface FuzzResearchOpts {
  entry: string
  /** Trusted reference source (an ES module exporting `entry`) — the differential oracle. */
  referenceSource: string
  /** Input generator/mutator. Defaults by inferred shape (string family → string, else int-array). */
  mutate?: Mutator
  /** Initial corpus. Defaults to a small shape-appropriate battery. */
  seeds?: unknown[][]
  iterations?: number
  seed?: number
  timeoutMs?: number
  /** Label folded into the injected case's name / audit note. */
  family?: string
}

const ARRAY_SEEDS: unknown[][] = [[[]], [[1]], [[2, 1]], [[3, 1, 2, 1]], [[-1, 0, 5, 5]]]
const STRING_SEEDS: unknown[][] = [[''], ['a'], ['Hello World'], ['  a--b  '], ['ABC123']]

/** Wrap a trusted reference SOURCE into a plain callable `(...args) => value` (throws on ref throw). */
function referenceCallable(source: string, entry: string, timeoutMs?: number):
  | ((...args: unknown[]) => unknown)
  | { error: string } {
  const h = createCoverageHarness(source, { timeoutMs })
  if ('error' in h) return { error: h.error }
  const harness = h as CoverageHarness
  if (!harness.hasEntry(entry)) return { error: `reference does not export '${entry}'` }
  return (...args: unknown[]) => {
    const c = harness.call(entry, args)
    if (!c.ok) throw new Error(c.threw ?? 'reference threw')
    return c.value
  }
}

/**
 * A ResearchFn that, on a stall, coverage-fuzzes the best candidate against a trusted reference
 * and — on the first minimized differential counterexample — tightens the verifier with that
 * case AND grounds the proposer with the witness + top suspect line. Returns null when the
 * candidate agrees with the reference across the budget (no false progress).
 */
export function makeFuzzResearchFn(opts: FuzzResearchOpts): ResearchFn<string> {
  const isStringFamily = /slug|trim|uppercase|lowercase|string/.test(opts.family ?? '')
  const mutate = opts.mutate ?? (isStringFamily ? stringMutator : intArrayMutator)
  const seeds = opts.seeds ?? (isStringFamily ? STRING_SEEDS : ARRAY_SEEDS)

  // Build the reference callable once; a broken reference simply disables this channel.
  const ref = referenceCallable(opts.referenceSource, opts.entry, opts.timeoutMs)

  return async ({ best, priorContext, signal }) => {
    if ('error' in ref) return null
    if (signal?.aborted) return null
    const candidate = best?.candidate?.value
    if (!candidate) return null

    const r = coverageFuzz(candidate, opts.entry, seeds, mutate, {
      reference: ref,
      iterations: opts.iterations ?? 400,
      seed: opts.seed ?? 0x1234_5678,
      timeoutMs: opts.timeoutMs,
    })
    if (r.status !== 'counterexample' || !r.counterexample) return null

    const cx = r.counterexample
    // The reference's value on the witness is the trusted expected output. If the reference threw
    // on this witness (kind 'crash' with ref-throw), we cannot form a value case — ground only.
    let refValue: unknown
    let refThrew = false
    try { refValue = ref(...cx.args) } catch { refThrew = true }

    const out: ResearchOutput = {}
    const notes: string[] = []
    const fam = opts.family ? `${opts.family} ` : ''

    if (!refThrew) {
      const newCase: CodeCase = {
        args: cx.args,
        expected: refValue,
        name: `fuzz-${fam.trim() || 'differential'}`,
        entry: opts.entry,
      }
      // De-dupe against context already carried (avoid re-injecting the same witness every stall).
      const caseSig = `fuzz-case:${opts.entry}:${JSON.stringify(cx.args)}`
      if (!priorContext.some(p => p.includes(caseSig))) {
        out.acceptance = { cases: [newCase] }
        // W5 feedback: witness + candidate's wrong output + the top suspect line, localized ON
        // this very counterexample (a passing seed vs the failing witness gives the spectrum).
        const suspect = topSuspectLine(candidate, opts.entry, cx.args, refValue, seeds, ref)
        const wrong = cx.candidate.threw ? `threw ${cx.candidate.threw}` : `returned ${fmt(cx.candidate.value)}`
        out.context = [
          `${caseSig}`,
          `Coverage-guided fuzzing found a ${fam}edge case the fixed cases miss:`,
          `  input ${cx.args.map(fmt).join(', ')} → your code ${wrong}, but the correct answer is ${fmt(refValue)}.`,
          suspect ? `  Most suspect line (Ochiai): ${suspect}` : '',
        ].filter(Boolean).join('\n')
        notes.push(`fuzz found a ${fam}differential counterexample (minimized), tightened the verifier`)
      }
    } else {
      // Reference throws on the witness → the candidate must ALSO throw there; carry as a hint.
      out.context = `Fuzzing: on input ${cx.args.map(fmt).join(', ')} the reference rejects (throws); your code must handle/​reject it the same way.`
      notes.push('fuzz found an input where the reference rejects; grounded the proposer')
    }

    if (!out.context && !out.acceptance) return null
    out.note = notes.join('; ')
    return out
  }
}

/** Localize the fault to a single top suspect line using the failing witness against passing seeds. */
function topSuspectLine(
  candidate: string,
  entry: string,
  witness: unknown[],
  expected: unknown,
  seeds: unknown[][],
  ref: (...args: unknown[]) => unknown,
): string | null {
  // Build a real pass/fail spectrum: the failing witness (expected=trusted value) plus seed cases
  // whose expected values come from the SAME trusted reference — so the candidate PASSES them (it
  // only fails the witness). Ochiai then isolates the branch that runs on the witness but not the
  // passing seeds, instead of flagging every executed line (which is what expected=undefined did).
  const cases: LocCase[] = [{ args: witness, expected, name: 'witness' }]
  for (const s of seeds.slice(0, 4)) {
    let exp: unknown
    try { exp = ref(...s) } catch { continue }  // skip seeds the reference rejects
    cases.push({ args: s, expected: exp, name: 'seed' })
  }
  try {
    const loc = localizeFault(candidate, entry, cases)
    const top = loc.status === 'localized' ? loc.ranked[0] : null
    return top ? `line ${top.line}: \`${top.text}\` (suspiciousness ${top.score.toFixed(2)})` : null
  } catch {
    return null
  }
}

/**
 * Build the same coverage-guided differential fuzz as a VERIFIER-LADDER STAGE (not a stall-only
 * ResearchFn). This is what lets the fuzz gate fire on the SINGLE-SHOT solve path: composed after
 * the acceptance stage in a `runLadder`, it runs ONLY on candidates acceptance already certified
 * (cheapest-first short-circuit), and a minimized disagreement with the trusted reference FAILS the
 * candidate (hard gate) — so search()/iterate() keep climbing instead of shipping an edge-case-wrong
 * answer. Cost 5 (post-acceptance, pre-mutation, matching the ladder's documented ordering).
 *
 * Soundness mirrors makeFuzzResearchFn: the reference is the oracle, a disagreement is ground truth.
 * A broken/unloadable reference, an abstaining fuzz run, or a candidate that agrees across the budget
 * all yield a PASSING verdict — the stage can only ever REJECT on a witnessed differential, never
 * fabricate a failure. No model is consulted.
 */
export function makeFuzzStage(opts: FuzzResearchOpts): LadderStage<string> {
  const isStringFamily = /slug|trim|uppercase|lowercase|string/.test(opts.family ?? '')
  const mutate = opts.mutate ?? (isStringFamily ? stringMutator : intArrayMutator)
  const seeds = opts.seeds ?? (isStringFamily ? STRING_SEEDS : ARRAY_SEEDS)
  const ref = referenceCallable(opts.referenceSource, opts.entry, opts.timeoutMs)
  const pass: Verdict = { pass: true, score: 0, signals: [] }
  const fam = opts.family ? `${opts.family} ` : ''

  return {
    name: 'fuzz',
    cost: 5,
    hard: true,
    verify: (candidate: Candidate<string>): Verdict => {
      if ('error' in ref) return pass                       // no oracle → inert (sound: never reject blindly)
      if (!candidate.value) return pass
      const r = coverageFuzz(candidate.value, opts.entry, seeds, mutate, {
        reference: ref as (...a: unknown[]) => unknown,
        iterations: opts.iterations ?? 400,
        seed: opts.seed ?? 0x1234_5678,
        timeoutMs: opts.timeoutMs,
      })
      if (r.status !== 'counterexample' || !r.counterexample) return pass
      const cx = r.counterexample
      const wrong = cx.candidate.threw ? `threw ${cx.candidate.threw}` : `returned ${fmt(cx.candidate.value)}`
      const want = cx.reference?.threw ? 'reference rejects (throws)' : `the correct answer is ${fmt(cx.reference?.value)}`
      return {
        pass: false,
        score: -1,   // passed every fixed case, fails ONE fuzz witness — a near-miss, not a syntax collapse
        signals: [`${fam}edge case the fixed cases miss: input ${cx.args.map(fmt).join(', ')} → your code ${wrong}, but ${want}`],
      }
    },
  }
}

/**
 * Convenience: build a fuzz LADDER STAGE from a natural-language request IFF it maps to a canonical
 * family with a known reference implementation. Returns null otherwise (no reference → no oracle →
 * no gate). This is the solve.ts wiring point for the single-shot post-acceptance fuzz gate.
 */
export function makeCanonicalFuzzStage(nl: string, entry?: string): LadderStage<string> | null {
  const meta = deriveMetamorphicSpec(nl, entry)
  if (!meta) return null
  const referenceSource = canonicalImpl(meta)
  if (!referenceSource) return null
  return makeFuzzStage({ entry: meta.entry, referenceSource, family: meta.family })
}

/**
 * Convenience: build a fuzz ResearchFn from a natural-language request IFF it maps to a canonical
 * family with a known reference implementation. Returns null otherwise (no reference → no oracle →
 * no fuzz channel). This is the solve.ts wiring point for stage-5 fuzzing on the case tiers.
 */
export function makeCanonicalFuzzResearch(nl: string, entry?: string): ResearchFn<string> | null {
  const meta = deriveMetamorphicSpec(nl, entry)
  if (!meta) return null
  const referenceSource = canonicalImpl(meta)
  if (!referenceSource) return null
  return makeFuzzResearchFn({ entry: meta.entry, referenceSource, family: meta.family })
}

/** Compose several ResearchFns: run each, MERGE their outputs (contexts concatenated, cases unioned). */
export function composeResearchFns(...fns: (ResearchFn<string> | null | undefined)[]): ResearchFn<string> {
  const active = fns.filter(Boolean) as ResearchFn<string>[]
  return async input => {
    const contexts: string[] = []
    const cases: unknown[] = []
    const notes: string[] = []
    for (const fn of active) {
      if (input.signal?.aborted) break
      let r: ResearchOutput | null = null
      try { r = await fn(input) } catch { r = null }
      if (!r) continue
      if (r.context) contexts.push(r.context)
      const incoming = (r.acceptance as { cases?: unknown[] } | undefined)?.cases
      if (incoming?.length) cases.push(...incoming)
      if (r.note) notes.push(r.note)
    }
    if (!contexts.length && !cases.length) return null
    const out: ResearchOutput = {}
    if (contexts.length) out.context = contexts.join('\n\n')
    if (cases.length) out.acceptance = { cases }
    if (notes.length) out.note = notes.join('; ')
    return out
  }
}

function fmt(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '…' : s }
  catch { return String(v) }
}
