// ═══════════════════════════════════════════════════════════════════════════════
// FAULT INJECTION — measuring the RECOVERY loop, not just clean synthesis
// ═══════════════════════════════════════════════════════════════════════════════
//
// Every other bench in this engine starts from a clean spec and asks "can the loop
// synthesize a correct implementation?". This harness asks the question that actually
// matters for agentic coding: given WORKING code with a bug deliberately injected,
// does the loop (a) DETECT the fault by execution, (b) RECOVER — localize, patch and
// re-certify — within budget?
//
//   good code ──inject──► mutant ──verify──► must FAIL (detected)
//                                  └──repair via solveCodeTask(goal=fix, context=mutant)
//                                            └──► certified fix | honest abstain
//
// Mutation operators are DETERMINISTIC source transforms (no model): the classic
// mutation-testing set — comparison flips, arithmetic swaps, boundary shifts,
// condition negation, guard deletion. A mutant the verifier cannot distinguish from
// the original (an "equivalent mutant") is reported as `detected: false` and excluded
// from recovery scoring — that is a CASE-COVERAGE signal about the spec, not a loop
// failure, and surfacing it is itself one of the harness's jobs.
// ═══════════════════════════════════════════════════════════════════════════════

import { verifyCode, type CodeAcceptance } from './codeVerifier'
import { solveCodeTask } from './solve'
import type { Proposer, SearchResult, TaskSpec } from './types'
import type { SearchOpts } from './search'

export interface Mutation {
  name: string
  /** Deterministic source transform. Returns null when the pattern is absent (mutation skipped). */
  apply: (src: string) => string | null
}

/** Replace only the FIRST match — one fault per mutant, so recovery is attributable. */
function first(src: string, re: RegExp, replacement: string): string | null {
  const m = re.exec(src)
  if (!m) return null
  return src.slice(0, m.index) + m[0].replace(re, replacement) + src.slice(m.index + m[0].length)
}

/** The standard mutation-testing operator set, ordered from most to least common real-bug shape. */
export const MUTATIONS: Mutation[] = [
  // Off-by-one at a boundary: `<` ↔ `<=` (loop bounds, range checks).
  { name: 'flip-lt', apply: src => first(src, /<=(?!=)/, '<') ?? first(src, /(?<![<=!])<(?![<=])/, '<=') },
  { name: 'flip-gt', apply: src => first(src, />=/, '>') ?? first(src, /(?<![>=])>(?![>=])/, '>=') },
  // Arithmetic operator swap: `+` ↔ `-` (skips ++, --, +=, -=, unary sign, string concat is caught by cases).
  { name: 'swap-plus-minus', apply: src => first(src, /(?<![+\-=])\+(?![+=])/, '-') },
  // Boundary-shift: a literal 0 used as an index/init becomes 1.
  { name: 'shift-zero', apply: src => first(src, /(?<![\d.\w])0(?![\d.x])/, '1') },
  // Condition negation: the first `if (cond)` becomes `if (!(cond))`.
  {
    name: 'negate-if',
    apply: src => {
      const m = /if\s*\(/.exec(src)
      if (!m) return null
      // Walk to the matching close paren so nested parens survive.
      let depth = 0, i = m.index + m[0].length - 1
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')' && --depth === 0) break
      }
      if (depth !== 0) return null
      const cond = src.slice(m.index + m[0].length, i)
      return src.slice(0, m.index) + `if (!(${cond}))` + src.slice(i + 1)
    },
  },
  // Guard deletion: remove the first single-line early-return guard.
  { name: 'drop-guard', apply: src => first(src, /^[ \t]*if\s*\([^\n]*\)\s*(?:return|continue|break)[^\n]*;?\s*$/m, '') },
  // Return-value corruption: first `return x` → `return undefined` (models a forgotten value).
  { name: 'void-return', apply: src => first(src, /return\s+(?!undefined)[^;\n]+/, 'return undefined') },
]

export interface FaultTarget {
  /** Short id used in reports. */
  id: string
  /** Known-good implementation (must pass `cases` — asserted before any mutation). */
  code: string
  entry: string
  cases: CodeAcceptance['cases']
}

export interface FaultTrial {
  target: string
  mutation: string
  /** False when the operator's pattern was absent from this target (trial skipped). */
  applicable: boolean
  /** True when the mutant FAILED verification — the case set can see this fault. */
  detected: boolean
  /** True when the repair loop shipped a certified fix. Only meaningful when detected. */
  recovered: boolean
  modelCalls: number
  status: SearchResult<string>['status'] | 'skipped' | 'undetected'
  detail: string
}

export interface FaultReport {
  trials: FaultTrial[]
  applicable: number
  detected: number
  recovered: number
  /** detected / applicable — how well the case sets SEE injected faults (spec coverage). */
  detectionRate: number
  /** recovered / detected — the number that matters: does the loop climb back? */
  recoveryRate: number
  totalModelCalls: number
}

const spec = (t: FaultTarget): TaskSpec => ({
  goal: '', domain: 'code',
  acceptance: { entry: t.entry, cases: t.cases } satisfies CodeAcceptance as unknown as Record<string, unknown>,
})

/** Build the repair goal exactly the way the live modify path frames it. */
export function repairGoal(t: FaultTarget): string {
  return `The function \`${t.entry}\` below has a bug — some test cases fail. Fix the bug and return the corrected module. Keep the same exported function name.`
}

/**
 * Run one target × one mutation through detect → repair → re-certify.
 * `proposer` defaults to the live on-device proposer inside solveCodeTask; benches
 * inject deterministic proposers to prove the harness accounting without a model.
 */
export async function runFaultTrial(
  t: FaultTarget,
  mutation: Mutation,
  opts: SearchOpts & { proposer?: Proposer<string> } = {},
): Promise<FaultTrial> {
  const mutated = mutation.apply(t.code)
  if (mutated === null || mutated === t.code) {
    return { target: t.id, mutation: mutation.name, applicable: false, detected: false, recovered: false, modelCalls: 0, status: 'skipped', detail: 'operator pattern absent' }
  }

  // Sanity: the unmutated code must certify, or the target itself is broken.
  const clean = await verifyCode({ value: t.code, fingerprint: 'clean' }, spec(t))
  if (!clean.pass) {
    return { target: t.id, mutation: mutation.name, applicable: false, detected: false, recovered: false, modelCalls: 0, status: 'skipped', detail: `target's own code fails its cases: ${clean.signals[0] ?? ''}` }
  }

  // Detection: execution must see the fault. An equivalent mutant is a spec-coverage gap.
  const v = await verifyCode({ value: mutated, fingerprint: 'mutant' }, spec(t))
  if (v.pass) {
    return { target: t.id, mutation: mutation.name, applicable: true, detected: false, recovered: false, modelCalls: 0, status: 'undetected', detail: 'equivalent mutant — case set cannot see this fault (coverage gap)' }
  }

  // Recovery: the standard repair framing — buggy code as context, same cases as ground truth.
  const result = await solveCodeTask(
    { goal: repairGoal(t), entry: t.entry, cases: t.cases, context: `Buggy current implementation:\n\`\`\`\n${mutated}\n\`\`\`` },
    { maxModelCalls: opts.maxModelCalls ?? 6, ...opts },
    opts.proposer,
  )
  return {
    target: t.id, mutation: mutation.name, applicable: true, detected: true,
    recovered: result.status === 'solved',
    modelCalls: result.modelCalls,
    status: result.status,
    detail: result.detail,
  }
}

/** Full sweep: every target × every mutation, aggregated. */
export async function runFaultSuite(
  targets: FaultTarget[],
  opts: SearchOpts & { proposer?: Proposer<string>; mutations?: Mutation[] } = {},
): Promise<FaultReport> {
  const muts = opts.mutations ?? MUTATIONS
  const trials: FaultTrial[] = []
  for (const t of targets) {
    for (const m of muts) {
      if (opts.signal?.aborted) break
      trials.push(await runFaultTrial(t, m, opts))
    }
  }
  const applicable = trials.filter(x => x.applicable).length
  const detected = trials.filter(x => x.detected).length
  const recovered = trials.filter(x => x.recovered).length
  return {
    trials, applicable, detected, recovered,
    detectionRate: applicable ? detected / applicable : 0,
    recoveryRate: detected ? recovered / detected : 0,
    totalModelCalls: trials.reduce((s, x) => s + x.modelCalls, 0),
  }
}
