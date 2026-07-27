// ═══════════════════════════════════════════════════════════════════════════════
// TRACE-DERIVED HELPER SPECS — let GOLD ground truth flow DOWN the carve
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (see DOCTRINE.md): correctness comes from the LOOP, not the oracle. And:
// "NOT trust the model — its output is a PROPOSAL that is worthless until ground truth
// certifies it."
//
// THE HOLE THIS CLOSES. Decomposition today asks the planner to invent, per helper, a name, a
// signature, AND a set of example input/output cases. Those invented cases then become that
// rung's ACCEPTANCE CRITERIA — the thing `verifyCode` executes against. So the model is seeding
// its own oracle. Every rung below the entry is certified against data the model made up, and
// the doctrine's "never trust the model" stops applying at exactly the layer where it matters
// most. Captured live from the head on :8080:
//
//   isBracket      cases=[{args:["("],expected:true},{args:["{","}"],expected:true},
//                         {args:["[","]"],expected:true}]     ← all true ⇒ `() => true` certifies it
//   isBalancedPair cases=[{args:["(",")","{","}","[","]"],expected:true},
//                         {args:["(",")","{","}","[","]"],expected:false}]  ← unsatisfiable
//   isBalancedHelper2 cases=[…{args:["[{}]",null],expected:2}]              ← arity drift + null pad
//
// Four helpers certified by trivial constants, composing to nothing, then 92 model calls ground
// against garbage. Gating those specs after the fact (reject the contradictory ones, reject the
// ones a constant satisfies) treats the symptom. The root cause is that the model was asked for
// an output value at all.
//
// THE FIX. Never ask. DERIVE. The entry's own acceptance cases are GOLD — they come from the
// user or the task, not the model. So:
//
//   1. The planner proposes only a carve: helper signatures plus an entry written in terms of
//      them. No invented outputs.
//   2. The model drafts one composed module implementing all of it (ONE draw).
//   3. We INSTRUMENT that module so every helper call records (args → returned).
//   4. We run the ENTRY's gold cases through it.
//
// Now every helper has observations grounded in gold inputs. Two distinct, both-sound uses:
//
//   • For a gold case the entry PASSES, the helper I/O recorded on that case provably
//     participated in a computation that produced the gold answer. Those (args → returned)
//     pairs are a spec grounded in ground truth — not universally correct, but *witnessed*,
//     which is categorically better than invented. `deriveHelperSpecs` returns exactly these.
//
//   • For gold cases the entry FAILS, the trace localizes the fault. A helper exercised on
//     every failing case and no passing one is the suspect; a helper exercised identically on
//     both is likely innocent. `localizeFault` ranks them (Ochiai, the standard
//     spectrum-based fault-localization coefficient). Today the per-rung budget is spent
//     UNIFORMLY — every rung gets the same draws regardless of whether it is the broken one.
//     This is how you spend it where the fault is, at zero model calls.
//
// SOUNDNESS. Nothing here certifies anything. A derived spec is a PROPOSAL for what a rung
// should be held to, and any implementation of that rung is still executed by `verifyCode`
// against it, and the composed whole is still executed against the ORIGINAL gold cases before
// anything is called solved. A wrong derivation can waste draws; it cannot admit a wrong answer.
// The one genuinely new claim is negative and safe: we no longer accept a rung spec whose
// expected values the model authored.
//
// COST. One child process per trace run, ~40ms, zero model calls.
// ═══════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transform } from 'esbuild'
import type { CodeAcceptance, CodeCase } from './codeVerifier'

/** One recorded helper invocation. */
export interface TraceCall {
  helper: string
  args: unknown[]
  returned: unknown
  /**
   * Index of the entry case that was running when this call happened, or -1 for a call made during
   * MODULE EVALUATION (before any case ran). -1 deliberately fails the `casePassed[caseIndex]`
   * lookup in `deriveHelperSpecs`, so such a call proves the helper was REACHED without ever
   * contributing an I/O witness to a rung's acceptance set.
   */
  caseIndex: number
  /** The helper threw instead of returning. Counts as CALLED; contributes no return witness. */
  threw?: boolean
}

/** The outcome of running the entry's gold cases against an instrumented module. */
export interface TraceRun {
  /** Per gold case: did the ENTRY produce the expected value? */
  casePassed: boolean[]
  /** Every helper invocation recorded, in order. */
  calls: TraceCall[]
  /** Helper names that were never invoked at all — dead rungs in the carve. */
  neverCalled: string[]
  /** Set when the module could not be loaded/instrumented; everything else is then empty. */
  error: string | null
}

// ── instrumentation ────────────────────────────────────────────────────────────

const PREFIX = '__crucible_orig_'
const REC = '__crucible_rec'
const SNAP = '__crucible_snap'

function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * The two declaration forms `instrumentForTrace` can rename-and-wrap, for one helper name.
 *
 * TOP-LEVEL ONLY — deliberately no leading-whitespace allowance. Rename-and-wrap hoists a fresh
 * `export function <name>` to module scope, so it is only sound for a declaration that already
 * lives there. Matching an INDENTED (nested) declaration renamed it in place while the wrapper went
 * to module scope, leaving the wrapper's `__crucible_orig_<name>` out of scope: every call through
 * it threw ReferenceError, which corrupted `casePassed` (and therefore both the derived-spec witness
 * set and localizeFault) and then reported the helper never-called so the carve's rung was pruned.
 * A nested helper now simply goes un-instrumented AND un-declared, which is the safe direction: the
 * dead-rung rule requires BOTH never-called and declared, so it cannot fire on one.
 */
function declPatterns(name: string): RegExp[] {
  const n = esc(name)
  return [
    new RegExp(`(^|\\n)(export\\s+)?function(\\s+)${n}\\s*\\(`, 'g'),
    new RegExp(`(^|\\n)(export\\s+)?(const|let|var)(\\s+)${n}\\s*=`, 'g'),
  ]
}

/**
 * Which of `names` does `src` DECLARE in a form this module can instrument?
 *
 * Exported because the difference between "the module defines this helper and never calls it"
 * and "the module never defined it at all" is the difference between a provably DEAD RUNG and a
 * draft that simply ignored the plan — and `TraceRun.neverCalled` cannot tell them apart. Any
 * caller that treats `neverCalled` as evidence ABOUT THE CARVE must intersect it with this, or it
 * will reject good carves on the strength of one lazy draw. Same regexes the instrumenter uses,
 * so the two can never drift.
 */
export function declaredHelpers(src: string, names: string[]): string[] {
  return names.filter(n => declPatterns(n).some(re => re.test(src)))
}

/**
 * Rewrite `src` so every named helper records its calls.
 *
 * The rename-and-wrap shape is what makes this work for INTERNAL calls too: the original
 * definition is renamed to `__crucible_orig_<name>`, and a fresh `<name>` wrapper is defined in
 * its place. Every existing call site — including one helper calling another, and recursion —
 * resolves `<name>` by scope to the wrapper, so it is recorded without touching any call site.
 *
 * Only `function <name>` and `const/let <name> = ` declaration forms are handled; a helper the
 * carve declares some other way is simply left un-instrumented and shows up in `neverCalled`,
 * which is honest (we report what we could not observe rather than guessing).
 */
export function instrumentForTrace(src: string, helperNames: string[]): string {
  let out = src
  const wrapped: string[] = []

  for (const name of helperNames) {
    const before = out
    const [fnDecl, varDecl] = declPatterns(name)

    // `export function NAME(` / `function NAME(`  → rename the definition
    out = out.replace(fnDecl,
      (_m, lead: string, _exp: string, sp: string) => `${lead}function${sp}${PREFIX}${name}(`)

    // `export const NAME = ` / `const NAME = ` (arrow or function expression)
    out = out.replace(varDecl,
      (_m, lead: string, _exp: string, kind: string, sp: string) => `${lead}${kind}${sp}${PREFIX}${name} =`)

    if (out !== before) wrapped.push(name)
  }

  if (!wrapped.length) return src

  // A THROWING helper must still count as CALLED. Recording only on the normal-return path made
  // `neverCalled` actually mean "never RETURNED", so any validator/parser rung that signals failure
  // by throwing looked unreachable and was pruned as a dead branch of the carve.
  // ARGS ARE SNAPSHOT BEFORE THE CALL. Taking it afterwards observes the arguments the helper has
  // already MUTATED, which is how `pushAndCount([], 'a') -> 1` was recorded as `[['a'], 'a'] -> 1`
  // — a pair the helper never produced, installed as the rung's acceptance target.
  const wrappers = wrapped.map(name => {
    const n = JSON.stringify(name)
    return `export function ${name}(...a) { var __a = ${SNAP}(a); ` +
           `try { var r = ${PREFIX}${name}(...a); ${REC}(${n}, __a, ${SNAP}(r), false); return r } ` +
           `catch (e) { ${REC}(${n}, __a, null, true); throw e } }`
  }).join('\n')

  // The recorder is declared with `var` and hoisted so a wrapper invoked during module
  // evaluation (a top-level call in the carve) still finds it.
  //
  // SNAPSHOT AT CALL TIME, not at end-of-case. Args and return values were previously pushed BY
  // REFERENCE and serialized only after the case finished, so any helper that mutates an argument
  // (or returns a container the caller then mutates) had its derived acceptance case rewritten to an
  // (args → expected) pair no execution ever produced — the exact "rung specified by a wrong value"
  // shape this module exists to eliminate. A throwing call records its args but NO return witness.
  const preamble =
    `var ${SNAP} = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch { return null } };\n` +
    `var ${REC} = (n, a, r, threw) => { (globalThis.__crucible_trace ||= []).push(` +
    `{ helper: n, args: a, returned: threw ? null : r, threw: !!threw }) };\n`

  return `${preamble}${out}\n${wrappers}\n`
}

// ── the runner ─────────────────────────────────────────────────────────────────

const TRACE_RUNNER = (entry: string, cases: CodeCase[]) => `
import * as M from './candidate.mjs'
const CASES = ${JSON.stringify(cases)}
const ENTRY = ${JSON.stringify(entry)}

const eq = (a, b) => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return Number.isNaN(a) && Number.isNaN(b)
}

const casePassed = []
const calls = []

// MODULE-EVALUATION CALLS. The import above is hoisted, so a helper invoked while the module
// evaluates (a precomputed lookup table, a memo warm-up) has already run before this loop starts.
// Resetting the buffer at the top of case 0 discarded those calls entirely, so such a helper was
// reported never-called — and since it IS declared and some case DOES pass, the dead-rung rule
// fired and pruned a rung the working composition depends on. caseIndex -1 marks them as belonging
// to no single case, which keeps them out of the per-case witness sets while still proving the
// helper was reached.
for (const t of (globalThis.__crucible_trace || [])) calls.push({ ...t, caseIndex: -1 })

for (let i = 0; i < CASES.length; i++) {
  globalThis.__crucible_trace = []
  const c = CASES[i]
  const fn = M[c.entry || ENTRY]
  let ok = false
  try { ok = typeof fn === 'function' && eq(fn(...c.args), c.expected) } catch { ok = false }
  casePassed.push(ok)
  // Already snapshot-serialized inside the recorder, at call time.
  for (const t of (globalThis.__crucible_trace || [])) calls.push({ ...t, caseIndex: i })
}
process.stdout.write('\\n' + JSON.stringify({ __trace: true, casePassed, calls }) + '\\n')
`

/**
 * Run the entry's gold cases against an instrumented copy of `src` and return what every helper
 * actually did. Deterministic, one child process, zero model calls.
 */
export async function traceEntryCases(
  src: string, helperNames: string[], acc: CodeAcceptance, timeoutMs = 5000,
): Promise<TraceRun> {
  const empty = (error: string): TraceRun => ({ casePassed: [], calls: [], neverCalled: helperNames.slice(), error })
  const instrumented = instrumentForTrace(src, helperNames)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgr-trace-'))
  try {
    let js: string
    try {
      js = (await transform(instrumented, { loader: 'ts', format: 'esm', target: 'node18' })).code
    } catch (e: any) {
      return empty(`instrumented module does not compile: ${String(e?.errors?.[0]?.text ?? e?.message ?? e).slice(0, 200)}`)
    }
    fs.writeFileSync(path.join(dir, 'candidate.mjs'), js, 'utf-8')
    fs.writeFileSync(path.join(dir, 'run.mjs'), TRACE_RUNNER(acc.entry, acc.cases), 'utf-8')

    const out = await new Promise<{ stdout: string; stderr: string }>(resolve => {
      execFile('node', [path.join(dir, 'run.mjs')], { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (_err, stdout, stderr) => resolve({ stdout, stderr }))
    })
    const line = out.stdout.split('\n').reverse().find(l => l.trim().startsWith('{"__trace"'))
    if (!line) return empty(`trace runner produced no result: ${(out.stderr || '').slice(0, 200)}`)

    let parsed: { casePassed: boolean[]; calls: TraceCall[] }
    try { parsed = JSON.parse(line) } catch { return empty('trace runner emitted unparseable output') }

    const seen = new Set(parsed.calls.map(c => c.helper))
    return {
      casePassed: parsed.casePassed,
      calls: parsed.calls,
      neverCalled: helperNames.filter(h => !seen.has(h)),
      error: null,
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }
}

// ── (1) sound spec derivation ──────────────────────────────────────────────────

export interface DerivedSpec {
  helper: string
  /** Gold-witnessed cases: recorded on entry cases that PASSED. */
  cases: CodeCase[]
  /** How many distinct gold entry cases contributed. */
  witnesses: number
  /** Set when the helper returned different values for the same args — stateful/non-deterministic. */
  inconsistent: boolean
}

const keyOf = (args: unknown[]): string => { try { return JSON.stringify(args) } catch { return String(args) } }

/**
 * Derive each helper's spec from the calls recorded on PASSING entry cases.
 *
 * Why passing-only. A helper's recorded behaviour on a passing gold case is witnessed to
 * participate in a computation that produced the gold answer. On a FAILING case it is a
 * hypothesis at best and the bug at worst, so folding it in would reintroduce exactly the
 * invented-oracle problem this module exists to remove.
 *
 * A helper that returns two different values for identical args is flagged `inconsistent` and
 * gets NO derived cases: its behaviour depends on hidden state, so no pure spec describes it.
 */
export function deriveHelperSpecs(run: TraceRun): DerivedSpec[] {
  const byHelper = new Map<string, TraceCall[]>()
  for (const c of run.calls) {
    if (!run.casePassed[c.caseIndex]) continue
    // A thrown call witnessed no return value. Admitting it would install `expected: null` as the
    // rung's acceptance for those args — a value the helper never produced.
    if (c.threw) continue
    const list = byHelper.get(c.helper)
    if (list) list.push(c); else byHelper.set(c.helper, [c])
  }

  const out: DerivedSpec[] = []
  for (const [helper, calls] of byHelper) {
    const byArgs = new Map<string, { args: unknown[]; returned: unknown; cases: Set<number> }>()
    let inconsistent = false
    for (const c of calls) {
      const k = keyOf(c.args)
      const prior = byArgs.get(k)
      if (!prior) { byArgs.set(k, { args: c.args, returned: c.returned, cases: new Set([c.caseIndex]) }); continue }
      if (keyOf([prior.returned]) !== keyOf([c.returned])) inconsistent = true
      prior.cases.add(c.caseIndex)
    }
    const witnesses = new Set(calls.map(c => c.caseIndex)).size
    out.push({
      helper,
      cases: inconsistent ? [] : [...byArgs.values()].map(v => ({ args: v.args, expected: v.returned })),
      witnesses,
      inconsistent,
    })
  }
  return out.sort((a, b) => b.witnesses - a.witnesses)
}

/**
 * Would a constant function satisfy this derived spec? A spec that cannot reject a constant has
 * no teeth — certifying a rung against it proves nothing. This is the `isBracket` failure exactly
 * (three cases, all `expected: true`), and it applies to DERIVED specs too: a helper genuinely
 * called with one argument shape only will produce a weak spec, and we should know that before
 * spending a rung's budget on it.
 */
export function isNonDiscriminating(cases: CodeCase[]): boolean {
  if (cases.length < 2) return true
  const outs = new Set(cases.map(c => keyOf([c.expected])))
  if (outs.size === 1) return true                                  // constant satisfies it
  // identity on the first argument satisfies it
  if (cases.every(c => c.args.length >= 1 && keyOf([c.args[0]]) === keyOf([c.expected]))) return true
  return false
}

// ── (2) fault localization ─────────────────────────────────────────────────────

export interface Suspect {
  helper: string
  /** Ochiai suspiciousness in [0,1]. 1 = executed on every failing case and no passing one. */
  suspicion: number
  failingCases: number
  passingCases: number
}

/**
 * Rank helpers by how strongly their execution correlates with entry-case FAILURE.
 *
 * Ochiai coefficient — the standard spectrum-based fault-localization measure:
 *
 *     suspicion(h) = failed(h) / sqrt( totalFailed * (failed(h) + passed(h)) )
 *
 * where failed(h)/passed(h) are the failing/passing entry cases that executed h. A helper on
 * every failing case and no passing one scores 1; one exercised uniformly scores low.
 *
 * A helper that was NEVER CALLED is reported with suspicion 1: a rung the composition does not
 * even reach cannot be part of a correct whole, and it is a dead branch of the carve — the
 * strongest possible signal, and one the current uniform-budget loop is completely blind to.
 */
export function localizeFault(run: TraceRun): Suspect[] {
  const totalFailed = run.casePassed.filter(p => !p).length
  const out: Suspect[] = run.neverCalled.map(helper => ({ helper, suspicion: 1, failingCases: 0, passingCases: 0 }))
  if (!totalFailed) return out.sort((a, b) => b.suspicion - a.suspicion)

  const byHelper = new Map<string, { failed: Set<number>; passed: Set<number> }>()
  for (const c of run.calls) {
    let e = byHelper.get(c.helper)
    if (!e) { e = { failed: new Set(), passed: new Set() }; byHelper.set(c.helper, e) }
    ;(run.casePassed[c.caseIndex] ? e.passed : e.failed).add(c.caseIndex)
  }

  for (const [helper, e] of byHelper) {
    const f = e.failed.size, p = e.passed.size
    const denom = Math.sqrt(totalFailed * (f + p))
    out.push({ helper, suspicion: denom > 0 ? f / denom : 0, failingCases: f, passingCases: p })
  }
  return out.sort((a, b) => b.suspicion - a.suspicion || b.failingCases - a.failingCases)
}

/** Render the localization as proposer-facing feedback. Pure text; certifies nothing. */
export function describeLocalization(run: TraceRun): string[] {
  if (run.error) return []
  const suspects = localizeFault(run)
  if (!suspects.length) return []
  const lines: string[] = []
  for (const s of suspects.filter(x => x.suspicion > 0).slice(0, 3)) {
    if (!s.failingCases && !s.passingCases) {
      lines.push(`\`${s.helper}\` is NEVER CALLED by the composition — it is a dead branch of the carve, not a step in the answer.`)
    } else {
      lines.push(
        `\`${s.helper}\` ran on ${s.failingCases} failing case(s) and ${s.passingCases} passing one(s) ` +
        `(suspicion ${s.suspicion.toFixed(2)}) — ${s.suspicion >= 0.7 ? 'the most likely location of the bug' : 'a secondary suspect'}.`)
    }
  }
  return lines
}
