// ═══════════════════════════════════════════════════════════════════════════════
// CARVE PROBE — the one draw that turns an UNTRUSTED carve into a GROUNDED one
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (DOCTRINE.md): correctness comes from the LOOP, not the oracle. This module is the
// missing verifier for the ONE component of the decomposition loop that never had one — the CARVE.
//
// THE MEASURED PROBLEM (2026-07-26 control arm, NEXT_SESSION.md). Decomposition is a 10–40× tax on
// tasks the direct path solves at draw 1, and when it fails it fails EXPENSIVELY: `isBalanced`
// burned 92 model calls and `wordFrequencyTop` 115 before anyone learned the carve was junk. The
// reason is structural — the planner invents each helper's name, signature AND EXPECTED OUTPUTS,
// and those invented outputs become that rung's acceptance criteria. So the model seeds its own
// oracle, and a carve is only falsified after every rung has already been ground against garbage:
//
//   isBracket cases=[{args:["("],expected:true},{args:["{","}"],expected:true},…]  ← all `true`,
//                                                                so `() => true` certifies the rung
//
// `traceSpec.ts` built the instrumentation that fixes this and proved it at unit level (13/13); it
// had zero callers. This module is the integration: ONE draw, ~5s, plus an 89ms deterministic trace,
// spent BEFORE the rung budget rather than after it.
//
// WHAT ONE DRAW BUYS (three distinct payoffs, in decreasing order of value):
//
//   1. IT MIGHT JUST SOLVE IT. The probe asks for the whole module — helpers and entry together —
//      and it is verified by `verifyCode` against the ORIGINAL gold cases. On the tasks the control
//      arm says the direct path gets at draw 1, decomposition now stops in ~5s instead of ~60s.
//      This is not a shortcut around verification: it is the same verifier, on the same cases.
//
//   2. GOLD FLOWS DOWN THE CARVE. For every gold case the entry PASSES, each helper's recorded
//      (args → returned) provably participated in a computation that produced the gold answer.
//      Those become the rung's acceptance set, replacing the invented one. Not universally correct
//      — WITNESSED, which is a categorically different kind of evidence from invented.
//
//   3. THE DEAD RUNG BECOMES VISIBLE. A helper a WORKING composition never calls is a dead branch
//      of the carve, catchable in 89ms — strictly better evidence than `isNonComposingCarve`'s
//      static argument-shape guess.
//
// THE FALSE-DEAD-RUNG TRAP, and the rule that avoids it. `TraceRun.neverCalled` cannot distinguish
// "the composition doesn't need this helper" from "this draw ignored the plan and never defined it"
// — and the second is the COMMON case for a weak head. Treating those alike would reject good
// carves on the strength of one lazy draw. So a rung is called dead only when BOTH hold:
//   (a) the draft passed at least one gold case — i.e. there is a working composition to be absent
//       from — and
//   (b) the draft actually DECLARED the helper in an instrumentable form (`declaredHelpers`), so
//       "never called" is an observation and not a gap in our instrumentation.
// Everything else is reported as UNINFORMATIVE and changes nothing. Missing evidence never fires a
// gate; that discipline is inherited from `isNonComposingCarve`.
//
// SOUNDNESS. Nothing here certifies anything. A derived spec is a PROPOSAL for what a rung should
// be held to; the rung's implementation is still executed against it by `verifyCode`, and the
// composed whole is still executed against the ORIGINAL gold cases before anything is called
// solved. A bad derivation can waste draws; it cannot admit a wrong answer. The one genuinely new
// claim is negative and safe: we no longer accept a rung spec whose expected values the model
// authored.
//
// COST. One model call + one ~89ms child process, per plan attempt.
// ═══════════════════════════════════════════════════════════════════════════════

import { type CodeAcceptance, type CodeCase, verifyCode } from './codeVerifier'
import {
  declaredHelpers, deriveHelperSpecs, isNonDiscriminating, localizeFault,
  traceEntryCases, type DerivedSpec, type Suspect, type TraceRun,
} from './traceSpec'
import type { IterateOpts } from './iterate'
import type { Candidate, Proposer, TaskSpec } from './types'

/** A planned helper: the shape `decomposeCodeBySubFunction` carries (name, goal, example I/O). */
export interface PlannedRung {
  name: string
  goal: string
  cases: CodeCase[]
}

export interface CarveProbe {
  /** 'solved' → `certified` holds a module verifyCode passed against the ORIGINAL cases.
   *  'grounded' → the trace was informative; `plan` carries derived rung specs.
   *  'uninformative' → the draw told us nothing (no draft, no passing case, or no instrumentable
   *                    helper). The caller keeps the planner's plan verbatim. */
  status: 'solved' | 'grounded' | 'uninformative'
  /** The composed module, when it passed the ORIGINAL gold cases under verifyCode. */
  certified: string | null
  /** The plan to actually grind: same names/goals, with WITNESSED cases where we could derive them. */
  plan: PlannedRung[]
  /** Helper names whose acceptance set is now trace-derived rather than planner-invented. */
  grounded: string[]
  /** Declared but never called by a composition that passed ≥1 gold case — provably dead rungs. */
  dead: string[]
  /** Ochiai ranking over the helper call spectra; drives the per-rung budget skew. */
  suspects: Suspect[]
  /** How many of the entry's gold cases the probe draft passed (trace runner's own equality). */
  casesPassed: number
  casesTotal: number
  /** Model calls spent here — always 0 or 1. Must be added to the caller's accounting. */
  modelCalls: number
  detail: string
}

/** Cap on how many witnessed cases become a rung's acceptance set (see pickWitnessed). */
export const MAX_DERIVED_CASES = 10

/**
 * Choose which witnessed calls become the rung's acceptance set.
 *
 * A helper called once per character of a 40-char gold input yields dozens of recorded pairs. All
 * of them are sound, but an acceptance set of 60 near-identical cases is slow to execute and adds
 * no discriminating power over a spread — while crowding the proposer's prompt with noise. So take
 * ONE case per distinct output first (that is what makes a spec able to reject a constant), then
 * fill up to the cap with the rest in recorded order. Pure and order-stable.
 */
export function pickWitnessed(cases: CodeCase[], cap = MAX_DERIVED_CASES): CodeCase[] {
  const key = (v: unknown): string => { try { return JSON.stringify(v) } catch { return String(v) } }
  const out: CodeCase[] = []
  const seenOut = new Set<string>()
  for (const c of cases) {
    const k = key(c.expected)
    if (seenOut.has(k)) continue
    seenOut.add(k); out.push(c)
    if (out.length >= cap) return out
  }
  for (const c of cases) {
    if (out.includes(c)) continue
    out.push(c)
    if (out.length >= cap) break
  }
  return out
}

/**
 * Is a derived spec strong enough to REPLACE the planner's invented one?
 *
 * Three ways to fail, all of which mean "grinding a rung against this proves nothing":
 *   • `inconsistent` — the helper returned different values for identical args, so no pure spec
 *     describes it and `deriveHelperSpecs` already refused to emit cases.
 *   • fewer than 2 cases — one case is satisfied by a constant.
 *   • `isNonDiscriminating` — a constant or the identity satisfies every case (the `isBracket`
 *     failure exactly, and it applies to derived specs too when a helper is only ever called one way).
 *
 * A rejected derivation is not a failure of the carve. We simply keep the planner's cases for that
 * rung — status quo, no regression — and say so.
 */
export function isUsableDerivation(d: DerivedSpec | undefined): boolean {
  if (!d || d.inconsistent) return false
  const picked = pickWitnessed(d.cases)
  return picked.length >= 2 && !isNonDiscriminating(picked)
}

/**
 * Fold a trace run into the plan: witnessed acceptance sets where they have teeth, planner-invented
 * ones everywhere else. Pure — the whole probe's judgement lives here so it can be unit-tested
 * without a model or a child process.
 */
export function groundPlan(
  plan: PlannedRung[],
  run: TraceRun,
  draft: string,
): { plan: PlannedRung[]; grounded: string[]; dead: string[]; suspects: Suspect[] } {
  const derived = new Map(deriveHelperSpecs(run).map(d => [d.helper, d]))
  const grounded: string[] = []
  const out = plan.map(h => {
    const d = derived.get(h.name)
    if (!isUsableDerivation(d)) return h
    grounded.push(h.name)
    return { ...h, cases: pickWitnessed(d!.cases) }
  })

  // DEAD RUNGS — only where the evidence actually supports the word "dead". See the header's
  // false-dead-rung trap: no passing case means there is no working composition to be absent from,
  // and a helper this draft never declared was never observable in the first place.
  const anyPassed = run.casePassed.some(Boolean)
  const declared = new Set(declaredHelpers(draft, plan.map(h => h.name)))
  const dead = anyPassed ? run.neverCalled.filter(n => declared.has(n)) : []

  return { plan: out, grounded, dead, suspects: localizeFault(run) }
}

/**
 * Per-rung budget SKEW from the fault localization.
 *
 * Today every rung gets the same purse regardless of whether it is the broken one — so a carve
 * whose fault is concentrated in one helper spends most of its budget on rungs that were already
 * right in the probe draft. Ochiai says which rung the failures ran through; spend there.
 *
 *   suspicion ≥ 0.7  → 1.5× (the fault is here)
 *   suspicion ≤ 0.2 AND witnessed on a passing case → 0.6× (the draft already got this right)
 *   otherwise        → unchanged
 *
 * Mirrors `subLevelIterateBudget`'s shape and floors deliberately: a scaled budget must stay usable
 * (a 1-call, 5s rung can only abstain). Sound — a budget is not a truth claim, so a mis-ranked rung
 * costs draws and nothing else. Pure.
 */
export function skewRungBudget(
  base: Partial<IterateOpts<string>> | undefined,
  suspects: Suspect[],
  helper: string,
): Partial<IterateOpts<string>> {
  const s = suspects.find(x => x.helper === helper)
  if (!s) return { ...(base ?? {}) }
  const scale = s.suspicion >= 0.7 ? 1.5
    : (s.suspicion <= 0.2 && s.passingCases > 0) ? 0.6
      : 1
  if (scale === 1) return { ...(base ?? {}) }

  const out = { ...(base ?? {}) } as Partial<IterateOpts<string>> & Record<string, unknown>
  const bend = (v: unknown, floor: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(floor, Math.round(v * scale)) : v
  if ('globalModelCalls' in out) out.globalModelCalls = bend(out.globalModelCalls, 3)
  if ('wallClockMs' in out) out.wallClockMs = bend(out.wallClockMs, 30_000)
  if ('maxEpochs' in out) out.maxEpochs = bend(out.maxEpochs, 2)
  return out
}

/** The probe's proposal prompt: the WHOLE module, so every helper is observable in one trace. */
export function probeSpec(
  goal: string,
  entry: string,
  cases: CodeCase[],
  plan: PlannedRung[],
  context?: string,
  timeoutMs?: number,
): TaskSpec {
  const sketch = plan.map(h => `  - \`${h.name}\` — ${h.goal}`).join('\n')
  return {
    goal:
      `${goal}\n\nWrite the COMPLETE module in one piece: define each of these helper functions AND ` +
      `\`${entry}\` written in terms of them.\n${sketch}\n` +
      `Export every one of them with \`export function <name>(...)\`.`,
    domain: 'code',
    context,
    acceptance: { entry, cases, timeoutMs } satisfies CodeAcceptance as unknown as Record<string, unknown>,
  }
}

/**
 * Draw ONE composed module for the carve, verify it against the ORIGINAL gold cases, and trace it.
 *
 * Returns 'solved' (the draft IS the answer — certified by `verifyCode`, not by the trace runner),
 * 'grounded' (rung specs are now witnessed), or 'uninformative' (nothing learned; caller proceeds
 * exactly as before). NEVER throws: a probe is an optimisation, and a decomposition that would have
 * worked must not be lost to a trace-runner hiccup.
 *
 * NOTE on the two equality implementations. `traceEntryCases` decides `casePassed` with the trace
 * runner's own comparison; `verifyCode` decides truth. They agree on everything we have observed,
 * but only ONE of them is allowed to certify — so a solve is claimed exclusively on the strength of
 * `verifyCode`, and `casePassed` is used only to decide which observations are witnesses.
 */
export async function probeCarve(
  input: { goal: string; entry: string; cases: CodeCase[]; context?: string; timeoutMs?: number },
  plan: PlannedRung[],
  proposer: Proposer<string>,
  opts: { signal?: AbortSignal; emit?: (e: Record<string, unknown>) => void } = {},
): Promise<CarveProbe> {
  const emit = opts.emit ?? (() => {})
  const nothing = (detail: string, modelCalls = 0): CarveProbe => ({
    status: 'uninformative', certified: null, plan, grounded: [], dead: [], suspects: [],
    casesPassed: 0, casesTotal: input.cases.length, modelCalls, detail,
  })
  if (opts.signal?.aborted) return nothing('aborted before the probe draw')

  const spec = probeSpec(input.goal, input.entry, input.cases, plan, input.context, input.timeoutMs)

  let cand: Candidate<string> | null = null
  try {
    cand = await proposer({ spec, history: [], diversify: false, signal: opts.signal })
  } catch (e: any) {
    return nothing(`probe draw failed: ${String(e?.message ?? e).slice(0, 120)}`, 0)
  }
  // A model-free candidate (retrieval / mechanical repair) must not be charged to the model budget.
  const calls = cand && cand.modelFree ? 0 : 1
  if (!cand) return nothing('probe draw returned no code', calls)

  // (1) The draft might simply BE the answer. verifyCode owns that judgement.
  try {
    const v = await verifyCode(cand, spec)
    if (v.pass) {
      emit({ type: 'thought', text: `carve probe: the composed draft passes all ${input.cases.length} gold case(s) — no rungs needed` })
      return {
        status: 'solved', certified: cand.value, plan, grounded: [], dead: [], suspects: [],
        casesPassed: input.cases.length, casesTotal: input.cases.length, modelCalls: calls,
        detail: `probe draft certified against all ${input.cases.length} original case(s) in 1 model call`,
      }
    }
  } catch { /* fall through — an unverifiable draft is still a usable trace subject */ }

  // (2) Trace it. Deterministic, one child process, zero model calls.
  let run: TraceRun
  try {
    run = await traceEntryCases(cand.value, plan.map(h => h.name), {
      entry: input.entry, cases: input.cases, timeoutMs: input.timeoutMs,
    } as CodeAcceptance)
  } catch (e: any) {
    return nothing(`trace run threw: ${String(e?.message ?? e).slice(0, 120)}`, calls)
  }
  if (run.error) return nothing(`probe draft not traceable: ${run.error}`, calls)

  const passed = run.casePassed.filter(Boolean).length
  const { plan: ground, grounded, dead, suspects } = groundPlan(plan, run, cand.value)
  if (!grounded.length && !dead.length) {
    return nothing(
      `probe traced ${run.calls.length} helper call(s) over ${passed}/${input.cases.length} passing case(s) ` +
      `but derived no spec with teeth — keeping the planner's cases`, calls)
  }

  if (grounded.length) {
    emit({ type: 'thought', text: `carve probe: ${grounded.join(', ')} now specified by GOLD-witnessed I/O (${passed}/${input.cases.length} entry case(s) passed), not invented values` })
  }
  if (dead.length) {
    emit({ type: 'thought', text: `carve probe: ${dead.join(', ')} declared but NEVER CALLED by a composition that passes gold cases — dead branch of the carve` })
  }
  return {
    status: 'grounded', certified: null, plan: ground, grounded, dead, suspects,
    casesPassed: passed, casesTotal: input.cases.length, modelCalls: calls,
    detail: `probe grounded ${grounded.length}/${plan.length} rung(s) from ${passed}/${input.cases.length} passing gold case(s)` +
      (dead.length ? `; ${dead.length} dead rung(s): ${dead.join(', ')}` : ''),
  }
}
