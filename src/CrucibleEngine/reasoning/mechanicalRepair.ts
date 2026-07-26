// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL-DIRECTED MECHANICAL REPAIR — the verifier's error message IS the localizer
// ═══════════════════════════════════════════════════════════════════════════════
//
// NORTH STAR (see DOCTRINE.md): correctness comes from the LOOP, not the oracle.
//
// MEASURED MOTIVATION (2026-07-26, `__direct_vs_decompose_live.ts`, 3 runs × 10 tasks ×
// 8 draws). Across the hard tasks, roughly a THIRD of terminal best-of-8 failures were not
// reasoning failures at all — the model had the right algorithm and lost to a JavaScript
// gotcha the verifier names outright:
//
//     threw: Assignment to constant variable.                       ×3
//     syntax error: "lastNumber" has already been declared          ×1
//     threw: frequencyMap.entries(...).sort is not a function       ×1
//     syntax error: Unterminated string literal                     ×1
//
// Redrawing from a 1.5B is the worst possible response to those. The draw costs ~4s, the
// model has no idea which of its lines is at fault, and it will usually reproduce the same
// idiom. But the verifier already told us the exact fault class — and often the exact
// identifier. That makes the repair a bounded, deterministic edit costing ~1ms.
//
// HOW THIS DIFFERS FROM `mutationRepair.ts`. That module enumerates BLIND single-token
// operator inversions (`<`↔`<=`, `+`↔`-`) over the whole source, and is wired only to the
// bug-fix path where `buggyCode` is supplied. It is a shotgun aimed at off-by-one faults.
// This module is the opposite: it reads the FAILURE SIGNAL and emits the small set of edits
// that fault class admits. Signal-directed, so it is O(a few) candidates rather than O(source
// length), and it fires on the ordinary synthesis path where no `buggyCode` exists.
//
// SOUNDNESS. Every repair is a PROPOSAL and nothing more. `verifyCode` still executes it
// against the same acceptance cases, so a wrong repair is rejected exactly like a wrong draw.
// This can only ever cause the loop to find a correct program sooner; it can never certify an
// incorrect one. Repairs are marked `modelFree` so they do not consume the model-call budget
// (see `Candidate.modelFree` in types.ts) — that budget bounds MODEL work, and charging free
// deterministic work against it would starve the head of draws it was actually granted.
// ═══════════════════════════════════════════════════════════════════════════════

import type { Candidate, Proposer, ProposeContext, TaskSpec, Verdict } from './types'
import { verifyCode } from './codeVerifier'

/** One deterministic repair proposal: the rewritten source plus why it was attempted. */
export interface MechanicalRepair {
  /** Short human-readable reason, threaded into the audit trail. */
  label: string
  /** The repaired source. */
  code: string
}

// ── identifier helpers ─────────────────────────────────────────────────────────

/** Escape a string for literal use inside a RegExp. */
function esc(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Replace occurrences of `name` that stand as a whole identifier — never a substring of a
 * longer name, and never immediately after a `.` (a property access is a different binding).
 */
function replaceIdent(src: string, name: string, to: string): string {
  return src.replace(new RegExp(`(^|[^\\w$.])${esc(name)}\\b`, 'g'), (_m, pre: string) => `${pre}${to}`)
}

/** Every identifier declared with `const` in `src`, in source order (simple + destructured skipped). */
function constDeclNames(src: string): Array<{ name: string; index: number }> {
  const out: Array<{ name: string; index: number }> = []
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=/g
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ name: m[1], index: m.index })
  return out
}

/** True when `name` is written to somewhere after its declaration (assignment / ++ / -- / op=). */
function isReassigned(src: string, name: string, afterIndex: number): boolean {
  const tail = src.slice(afterIndex + 1)
  const n = esc(name)
  return new RegExp(`(^|[^\\w$.])${n}\\s*(=[^=]|\\+\\+|--|\\+=|-=|\\*=|/=|%=|\\|\\|=|&&=|\\?\\?=)`).test(tail)
    || new RegExp(`(\\+\\+|--)\\s*${n}\\b`).test(tail)
}

// ── the repair rules, one per observed fault class ─────────────────────────────

/**
 * "Assignment to constant variable." — the model declared an accumulator `const` and then
 * mutated it. The runtime does not name the binding, so emit one variant per `const` that is
 * demonstrably reassigned (usually exactly one), plus an all-at-once variant as a fallback.
 */
function repairConstAssignment(src: string): MechanicalRepair[] {
  const out: MechanicalRepair[] = []
  const reassigned = constDeclNames(src).filter(d => isReassigned(src, d.name, d.index))
  for (const d of reassigned) {
    const re = new RegExp(`\\bconst(\\s+${esc(d.name)}\\s*=)`)
    out.push({ label: `const→let for reassigned binding \`${d.name}\``, code: src.replace(re, 'let$1') })
  }
  if (reassigned.length > 1) {
    let all = src
    for (const d of reassigned) all = all.replace(new RegExp(`\\bconst(\\s+${esc(d.name)}\\s*=)`), 'let$1')
    out.push({ label: `const→let for all ${reassigned.length} reassigned bindings`, code: all })
  }
  return out
}

/**
 * "Identifier 'x' has already been declared" / esbuild's `The symbol "x" has already been
 * declared`. The name is IN the message. Two plausible fixes, both cheap: demote the SECOND
 * declaration to a plain assignment (the usual intent — the model re-declared a running
 * variable), or rename the second binding and its trailing references.
 */
function repairDuplicateDeclaration(src: string, name: string): MechanicalRepair[] {
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${esc(name)}\\b`, 'g')
  const decls: number[] = []
  for (let m = declRe.exec(src); m; m = declRe.exec(src)) decls.push(m.index)
  if (decls.length < 2) return []
  const second = decls[1]
  const out: MechanicalRepair[] = []

  // (a) demote the second declaration to an assignment: `let x = …` → `x = …`
  const demoted = src.slice(0, second) + src.slice(second).replace(/^(?:const|let|var)\s+/, '')
  out.push({ label: `demote duplicate declaration of \`${name}\` to an assignment`, code: demoted })

  // (b) rename the second binding (and every reference after it) to `<name>2`
  const head = src.slice(0, second)
  const tail = replaceIdent(src.slice(second), name, `${name}2`)
  out.push({ label: `rename the duplicate \`${name}\` to \`${name}2\``, code: head + tail })
  return out
}

/**
 * "<expr>.sort is not a function" and friends. The overwhelmingly common cause on this head is
 * an ES6 collection ITERATOR treated as an array: `map.entries().sort(…)`, `set.values().map(…)`.
 * The fix is to spread the iterator. Signal-directed: only the named method is targeted.
 */
function repairIteratorNotArray(src: string, method: string): MechanicalRepair[] {
  const out: MechanicalRepair[] = []
  // `<recv>.entries()` / `.keys()` / `.values()` immediately followed by `.<method>(`
  const re = new RegExp(`([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.(?:entries|keys|values)\\(\\))\\s*\\.${esc(method)}\\(`, 'g')
  const spread = src.replace(re, (_m, recv: string) => `[...${recv}].${method}(`)
  if (spread !== src) out.push({ label: `spread iterator before .${method}() — [...x.entries()]`, code: spread })

  // Bare `Object.keys(x).<method>` is already an array; the other frequent shape is a Map/Set
  // value used directly: `myMap.<method>(` where myMap was built with `new Map()`.
  const mapRe = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.${esc(method)}\\(`, 'g')
  const built = new Set<string>()
  for (let m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set)\b/g.exec(src); m;) {
    built.add(m[1]); break
  }
  const allBuilt = [...src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set)\b/g)].map(m => m[1])
  for (const name of allBuilt) built.add(name)
  if (built.size) {
    const wrapped = src.replace(mapRe, (full, recv: string) => (built.has(recv) ? `[...${recv}].${method}(` : full))
    if (wrapped !== src && wrapped !== spread) {
      out.push({ label: `spread Map/Set before .${method}()`, code: wrapped })
    }
  }
  return out
}

/**
 * `[1,10,2].sort()` sorts LEXICOGRAPHICALLY. This is the single most common silent numeric bug
 * in JavaScript and the verifier reports it only as a wrong-order result, so the model rarely
 * localizes it. A comparator-less `.sort()` is a bounded, high-yield edit.
 */
function repairBareNumericSort(src: string): MechanicalRepair[] {
  if (!/\.sort\(\s*\)/.test(src)) return []
  return [
    { label: 'bare .sort() → numeric ascending comparator', code: src.replace(/\.sort\(\s*\)/g, '.sort((a, b) => a - b)') },
    { label: 'bare .sort() → numeric descending comparator', code: src.replace(/\.sort\(\s*\)/g, '.sort((a, b) => b - a)') },
  ]
}

/**
 * Integer division. Several tasks specify "division truncates toward zero" and the head emits a
 * plain `/`. `Math.trunc` around each bare division is a bounded rewrite; the verifier discards
 * it when the task wanted real division.
 */
function repairTruncatingDivision(src: string): MechanicalRepair[] {
  // Only fire when the source has no truncation at all — otherwise the model already handled it.
  if (/Math\.(trunc|floor)\s*\(|\s\|\s*0\b|~~/.test(src)) return []
  const re = /([A-Za-z_$][\w$]*(?:\[[^\]]*\])?)\s*\/\s*([A-Za-z_$][\w$]*(?:\[[^\]]*\])?)/g
  const truncated = src.replace(re, (_m, a: string, b: string) => `Math.trunc(${a} / ${b})`)
  if (truncated === src) return []
  return [{ label: 'wrap bare division in Math.trunc (spec says truncate toward zero)', code: truncated }]
}

/**
 * An unterminated string literal is almost always a quote the model failed to escape or a line
 * it truncated. The only safe deterministic move is to close the literal at end of line.
 */
function repairUnterminatedString(src: string): MechanicalRepair[] {
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const q of ['"', "'"]) {
      // count unescaped quotes of this kind outside of the other kind — crude but bounded
      const n = (line.match(new RegExp(`(?<!\\\\)${q}`, 'g')) || []).length
      if (n % 2 === 1) {
        const fixed = [...lines]
        fixed[i] = line + q
        return [{ label: `close unterminated ${q === '"' ? 'double' : 'single'}-quoted string on line ${i + 1}`, code: fixed.join('\n') }]
      }
    }
  }
  return []
}

/**
 * "x is not defined" where a near-identical name IS defined — a casing/typo slip. Bounded: only
 * propose names already bound in the source whose lowercase form matches.
 */
function repairUndefinedIdentifier(src: string, name: string): MechanicalRepair[] {
  const bound = new Set<string>()
  for (const m of src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1])
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1])
  const target = [...bound].find(b => b !== name && b.toLowerCase() === name.toLowerCase())
  if (!target) return []
  return [{ label: `rename undefined \`${name}\` to the bound \`${target}\``, code: replaceIdent(src, name, target) }]
}

// ── the signal → repair dispatcher ─────────────────────────────────────────────

/**
 * Given a candidate's source and the verifier signals it produced, enumerate the deterministic
 * repairs those signals license. PURE — no execution, no model, no I/O. Returns [] when no rule
 * matches, which is the common case and costs nothing.
 *
 * Deduped by resulting source, and never returns the input unchanged.
 */
export function mechanicalRepairs(src: string, signals: string[]): MechanicalRepair[] {
  if (!src || !src.trim()) return []
  const blob = signals.join('\n')
  const out: MechanicalRepair[] = []

  if (/Assignment to constant variable/i.test(blob)) out.push(...repairConstAssignment(src))

  // esbuild: `The symbol "x" has already been declared`; V8: `Identifier 'x' has already been declared`
  const dup = /(?:symbol|Identifier)\s+["'`]([A-Za-z_$][\w$]*)["'`]\s+has already been declared/i.exec(blob)
  if (dup) out.push(...repairDuplicateDeclaration(src, dup[1]))

  const notFn = /\.?([A-Za-z_$][\w$]*)\s+is not a function/i.exec(blob)
  if (notFn) out.push(...repairIteratorNotArray(src, notFn[1]))

  if (/Unterminated string/i.test(blob)) out.push(...repairUnterminatedString(src))

  const undef = /["'`]?([A-Za-z_$][\w$]*)["'`]?\s+is not defined/i.exec(blob)
  if (undef) out.push(...repairUndefinedIdentifier(src, undef[1]))

  // Wrong-VALUE signals (not throws) license the two silent-semantics rules. `→ got` is the
  // verifier's wrong-output marker; a compile/throw failure never reaches these.
  if (/→\s*got|returned/i.test(blob)) {
    out.push(...repairBareNumericSort(src))
    out.push(...repairTruncatingDivision(src))
  }

  const seen = new Set<string>([src])
  return out.filter(r => {
    if (!r.code || seen.has(r.code)) return false
    seen.add(r.code)
    return true
  })
}

/** Result of running the repair sweep against ground truth. */
export interface RepairSweep {
  /** A repair the verifier CERTIFIED, if one exists. */
  certified: { repair: MechanicalRepair; verdict: Verdict } | null
  /** The best strictly-improving repair, when none certified (partial progress is still signal). */
  improved: { repair: MechanicalRepair; verdict: Verdict } | null
  /** How many variants were executed — for honest reporting. Always small. */
  tried: number
}

/**
 * Execute every licensed repair against the spec and report the best outcome. Deterministic,
 * zero model calls. `baselineScore` is the score of the source being repaired: an "improvement"
 * must beat it strictly, so a repair that merely trades one failure for another is discarded.
 */
export async function sweepMechanicalRepairs(
  src: string, signals: string[], spec: TaskSpec, baselineScore: number,
): Promise<RepairSweep> {
  const repairs = mechanicalRepairs(src, signals)
  let improved: RepairSweep['improved'] = null
  for (const repair of repairs) {
    const cand: Candidate<string> = { value: repair.code, fingerprint: `mech:${repair.label}`, modelFree: true }
    let verdict: Verdict
    try { verdict = await verifyCode(cand, spec) } catch { continue }
    if (verdict.pass) return { certified: { repair, verdict }, improved, tried: repairs.length }
    if (verdict.score > baselineScore && (!improved || verdict.score > improved.verdict.score)) {
      improved = { repair, verdict }
    }
  }
  return { certified: null, improved, tried: repairs.length }
}

/**
 * A Proposer that repairs the most recent failing attempt using its own verifier signals.
 *
 * Budget-honest: the returned candidate carries `modelFree: true`, so `search()` does not charge
 * it against `maxModelCalls`. Returns null when no rule matches or nothing improves — the loop
 * then falls through to the model proposer at zero cost.
 *
 * Returns an IMPROVING-but-not-certified repair as well as a certified one: a repair that turns
 * "does not compile" into "compiles, 2 cases wrong" is a large information gain for the next
 * model draw, and it is still fully verifier-gated.
 */
export function makeMechanicalRepairProposer(): Proposer<string> {
  const exhausted = new Set<string>()
  return async (ctx: ProposeContext<string>): Promise<Candidate<string> | null> => {
    const last = ctx.history[ctx.history.length - 1]
    if (!last || last.verdict.pass) return null
    const src = last.candidate.value
    const key = last.candidate.fingerprint
    if (exhausted.has(key)) return null   // never redo a dead enumeration for the same source
    exhausted.add(key)

    const sweep = await sweepMechanicalRepairs(src, last.verdict.signals, ctx.spec, last.verdict.score)
    const hit = sweep.certified ?? sweep.improved
    if (!hit) return null
    return {
      value: hit.repair.code,
      fingerprint: `mech:${hit.repair.label}:${hit.repair.code.length}`,
      modelFree: true,
      source: 'mechanical-repair',
    }
  }
}
