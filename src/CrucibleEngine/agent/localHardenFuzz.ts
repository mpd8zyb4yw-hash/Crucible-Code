// ============================================================================
// Local harden fuzz layer — priority-ladder item 1's actual close condition
// (ROADMAP.md 2026-07-04): localHardenCheck.ts's AST pattern-matching only catches
// the handful of always-a-bug SHAPES it was explicitly written to recognize. It cannot
// catch a sort that returns the wrong permutation, a comparator that isn't antisymmetric,
// a clamp that lets values escape its own bounds — bugs that are wrong on SOME input but
// look like perfectly ordinary code to a syntactic scanner. Real semantic coverage needs
// to actually RUN the candidate against many generated inputs and check invariants that
// hold for ANY correct implementation of that shape — property-based fuzzing, not pattern
// matching. This module is that layer, scoped to the same small set of well-known,
// implementation-agnostic families synth/derive.ts already recognizes by name convention
// (sort, validator, string-transform, comparator, set-op, number-transform/clamp).
//
// Design constraints, same discipline as localHardenCheck.ts:
// - Zero false positives on correct code: every property asserted holds for ANY correct
//   implementation of that family, regardless of internal approach (e.g. set-op invariants
//   are membership-only, not length-exact, so dedup-vs-multiset choices can't trip it).
// - Execution is real (this is the one deliberate exception to "no execution" in this
//   gate family) but fully isolated: runs in a worker_thread with a hard wall-clock kill,
//   so a genuine infinite loop in the candidate — exactly the class of bug this exists to
//   catch — terminates the worker instead of hanging the agent process.
// - Fail open: any load/transpile/worker error skips fuzzing for that file; it never
//   blocks on its own inability to run, only on a REAL counterexample fast-check found.
// ============================================================================
import ts from 'typescript'
import { Worker } from 'worker_threads'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { splitSources } from './localHardenCheck'

export interface FuzzFinding { path: string; message: string }

const WORKER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'localHardenFuzzWorker.cjs')
const WORKER_TIMEOUT_MS = 4000

interface CheckSpec { name: string; kind: string }

/** Any non-relative import/require means the transpiled module can't run standalone in
 *  the worker (no module resolution there) — skip fuzzing rather than false-fail on an
 *  environment limit. Mirrors sandbox.ts's importsExternalModule convention. */
function hasExternalImport(content: string): boolean {
  const importRe = /\bimport\s[^'"]*from\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(content))) {
    const spec = m[1] ?? m[2]
    if (spec && !spec.startsWith('.')) return true
  }
  return false
}

/** Declared parameter count for a top-level `export function name(...)` or
 *  `export const name = (...) => ...` — used to gate a family to its expected arity so
 *  we never call a real function with the wrong shape (a false-positive risk, not a bug
 *  in the candidate). Returns null when no matching declaration is found. */
function getArity(content: string, name: string): number | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fnDecl = content.match(new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${esc}\\s*\\(([^)]*)\\)`))
  const arrowDecl = content.match(new RegExp(`\\bexport\\s+const\\s+${esc}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`))
  const sig = fnDecl ?? arrowDecl
  if (!sig) return null
  const params = sig[1].trim()
  if (!params) return 0
  // Split on top-level commas only (ignore commas inside default-value object/array literals).
  let depth = 0
  const parts: string[] = []
  let cur = ''
  for (const ch of params) {
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts.filter(p => p.trim()).length
}

/** Classify each exported name into a fuzz-testable family by name convention, gated to
 *  the expected arity. Deliberately narrow — a name match with the wrong arity is not
 *  this family (skip, don't misfire), same convention as derive.ts's sorter arity gate. */
function detectChecks(content: string): CheckSpec[] {
  const exportedNames = new Set<string>()
  for (const m of content.matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)) exportedNames.add(m[1])
  for (const m of content.matchAll(/\bexport\s+const\s+(\w+)\s*=/g)) exportedNames.add(m[1])

  const checks: CheckSpec[] = []
  for (const name of exportedNames) {
    const arity = getArity(content, name)
    if (arity === null) continue
    if (/[Ss]ort/.test(name) && !/topo|topolog/i.test(name) && arity === 1) {
      checks.push({ name, kind: 'sort' })
      // Companion property: the correctness check above always calls fn on a defensive
      // copy (arr.slice()), so a candidate that sorts correctly but ALSO mutates its
      // caller's input in place (e.g. `scores.sort(...)` with no copy) passes it clean —
      // exactly the leaderboardModule bug the hidden suite caught but fuzz didn't
      // (2026-07-05). This variant calls fn on the caller's own array and asserts it's
      // unchanged afterward, independent of whether the return value is correct.
      checks.push({ name, kind: 'sort-no-mutate' })
    } else if (/^is[A-Z]/.test(name) && arity === 1) {
      checks.push({ name, kind: 'validator' })
    } else if (/^(compare|comparator|ascending|descending|byKey|sortKey|cmp)/i.test(name) && arity === 2) {
      checks.push({ name, kind: 'comparator' })
    } else if (/^union/i.test(name) && arity === 2) {
      checks.push({ name, kind: 'set-op-union' })
      checks.push({ name, kind: 'set-op-union-no-mutate' })
    } else if (/^(difference|subtract|complement)/i.test(name) && arity === 2) {
      checks.push({ name, kind: 'set-op-diff' })
      checks.push({ name, kind: 'set-op-diff-no-mutate' })
    } else if (/^(intersect|intersection)/i.test(name) && arity === 2) {
      checks.push({ name, kind: 'set-op-intersect' })
      checks.push({ name, kind: 'set-op-intersect-no-mutate' })
    } else if (/^clamp/i.test(name) && arity === 3) {
      checks.push({ name, kind: 'number-transform-clamp' })
    } else if (/^(dedupe|dedup|unique|distinct)/i.test(name) && arity === 1) {
      checks.push({ name, kind: 'array-dedupe' })
      checks.push({ name, kind: 'array-dedupe-no-mutate' })
    } else if (/^sum/i.test(name) && arity === 1) {
      checks.push({ name, kind: 'number-aggregate-sum' })
    } else if (/case|capitaliz|slug|wrap|trim|pad|strip|escape|unescape|reverse|truncat/i.test(name) && arity === 1) {
      checks.push({ name, kind: 'string-transform' })
    }
  }
  return checks
}

function runWorker(code: string, checks: CheckSpec[]): Promise<Array<{ name: string; kind: string; failed: boolean; message?: string }>> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, { workerData: { code, checks } })
    const timer = setTimeout(() => {
      worker.terminate()
      resolve([{ name: '<module>', kind: 'timeout', failed: true, message: `fuzz run exceeded ${WORKER_TIMEOUT_MS}ms — likely a non-terminating loop in the candidate` }])
    }, WORKER_TIMEOUT_MS)
    worker.once('message', (msg: { results: Array<{ name: string; kind: string; failed: boolean; message?: string }> }) => {
      clearTimeout(timer)
      worker.terminate()
      resolve(msg.results ?? [])
    })
    worker.once('error', () => {
      clearTimeout(timer)
      resolve([]) // fail open — a worker crash is an environment issue, not a candidate bug
    })
  })
}

/**
 * Property/fuzz layer companion to runLocalHardenCheck. Async (spawns a worker per file),
 * so callers combine it with the sync AST pass rather than replacing it — this catches a
 * different, complementary class of bug (semantic/behavioral vs. always-wrong-shape).
 */
export async function runLocalHardenFuzz(sources: string): Promise<FuzzFinding[]> {
  const files = splitSources(sources)
  const findings: FuzzFinding[] = []

  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f.path)) continue
    if (hasExternalImport(f.content)) continue
    const checks = detectChecks(f.content)
    if (!checks.length) continue

    let jsCode: string
    try {
      const out = ts.transpileModule(f.content, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
        reportDiagnostics: false,
      })
      jsCode = out.outputText
    } catch {
      continue // unparseable — fail open, same as the AST pass
    }

    let results: Array<{ name: string; kind: string; failed: boolean; message?: string }>
    try {
      results = await runWorker(jsCode, checks)
    } catch {
      continue
    }

    for (const r of results) {
      if (!r.failed) continue
      // "-no-mutate" findings read as fuzzing jargon ("Property failed after N tests",
      // "Counterexample: [[1,0]]") that doesn't map cleanly to an actual code fix — a live
      // harden round on this exact family (leaderboardModule, 2026-07-05) fed the raw
      // message back to the model, which then re-submitted the same `arr.sort(...)`
      // in-place mutation unchanged. Append the concrete, actionable instruction so the
      // fix prompt can't be misread as "some edge case is wrong" instead of "you mutated
      // the caller's argument."
      const plainFix = r.kind.endsWith('-no-mutate')
        ? ` — the function mutates its input argument in place. Return a NEW array/object instead of modifying the one passed in (e.g. use [...arr].sort(...) or arr.slice(), never arr.sort(...) directly on the parameter).`
        : ''
      findings.push({
        path: f.path,
        message: (r.kind === 'timeout' || r.kind === 'load-error'
          ? `${f.path} — ${r.message}`
          : `${f.path} — ${r.name} fails the ${r.kind} property: ${r.message}`) + plainFix,
      })
    }
  }
  return findings
}
