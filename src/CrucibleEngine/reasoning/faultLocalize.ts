// ═══════════════════════════════════════════════════════════════════════════════
// SPECTRUM-BASED FAULT LOCALIZATION  (DOCTRINE / GAP_CLOSURE W8)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The wrong way to debug with a 1.5B model: paste the whole buggy file and ask
// "which line is broken?". That is oracle-trust with extra steps — the model's
// guess is exactly the unreliable thing the doctrine says never to trust.
//
// The right way is DETERMINISTIC and MODEL-FREE. Run the code against its cases,
// record which source lines each PASSING run and each FAILING run executed, and
// rank lines by a standard suspiciousness metric. A line that runs on every
// failing case and no passing case is almost certainly the fault; a line that runs
// on everything is almost certainly innocent. This is spectrum-based fault
// localization (Ochiai), the technique real debuggers use, and it needs zero model
// calls: the coverage spectrum IS the ground truth.
//
//   good/bad code ──instrument──► per-line hit sets ──Ochiai──► ranked suspects
//
// The model only ever sees the TOP-K localized lines and proposes a FIX for an
// already-localized fault — it never has to find the needle, only mend it.
//
// SELF-VERIFYING: inject a fault at a KNOWN line (faultInject's mutation operators),
// run the localizer, and assert the injected line ranks top-k. Accuracy is therefore
// measurable without a single human label — see __faultlocalize_bench.ts.
//
// No model is consulted here. This file is pure determinism.
// ═══════════════════════════════════════════════════════════════════════════════

import vm from 'node:vm'
import * as ts from 'typescript'

/** One acceptance case: positional args applied to the entry, and the deep-equal expected value.
 *  Same shape as codeVerifier's CodeCase so callers can pass their existing cases straight through. */
export interface LocCase {
  args: unknown[]
  expected: unknown
  name?: string
  /** Which exported function this case targets. Defaults to the localization `entry`. */
  entry?: string
}

/** A source line with its computed suspiciousness and the raw spectrum counts behind it. */
export interface SuspiciousLine {
  line: number
  /** The source text of that line, trimmed — ready to drop into a proposer prompt. */
  text: string
  /** Ochiai suspiciousness in [0,1]; 1 = runs on every failing case and no passing case. */
  score: number
  /** How many FAILING cases executed this line. */
  failHits: number
  /** How many PASSING cases executed this line. */
  passHits: number
}

export interface LocalizationResult {
  status: 'localized' | 'abstain'
  reason?: string
  /** Suspicious lines, Ochiai-descending. Empty when abstaining. */
  ranked: SuspiciousLine[]
  totalFail: number
  totalPass: number
}

export interface LocalizeOpts {
  /** Per-case wall budget for the module load (ms). The call itself is not interruptible in-process
   *  (no worker) — localization is meant for near-correct code with one fault, not hostile loops. */
  timeoutMs?: number
  /** How many suspects the ranked list keeps. Default 5. */
  topK?: number
}

// ── Instrumentation ────────────────────────────────────────────────────────────
// Insert `__cov(<originalLine>)` before every statement inside a block-like body.
// The probe carries the ORIGINAL source line as a literal, so transpilation shifting
// line numbers downstream is irrelevant — the number we record is fixed at insert time.
//
// LIMITATION (honest): only block-bodied statements are instrumented. A brace-less
// `if (c) return x` or a concise arrow body `x => expr` has no Block, so its inner
// expression is not separately probed; it is attributed to the enclosing block's
// probe. This lowers resolution on terse code but never misattributes across
// functions. Callers wanting maximal resolution should brace their bodies.

function instrument(source: string): { code: string } | { error: string } {
  let sf: ts.SourceFile
  try {
    sf = ts.createSourceFile('candidate.ts', source, ts.ScriptTarget.ES2020, /*setParentNodes*/ true, ts.ScriptKind.TS)
  } catch (e: any) {
    return { error: `parse failed: ${e?.message ?? e}` }
  }

  const transformer: ts.TransformerFactory<ts.SourceFile> = ctx => {
    const f = ctx.factory
    const probe = (line: number): ts.Statement =>
      f.createExpressionStatement(
        f.createCallExpression(f.createIdentifier('__cov'), undefined, [f.createNumericLiteral(line)]),
      )

    const weave = (stmts: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): ts.Statement[] => {
      const out: ts.Statement[] = []
      for (const s of stmts) {
        // Line is read from the ORIGINAL node position against the original source file,
        // before any child rewriting — so it is always the true source line.
        const line = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line + 1
        out.push(probe(line))
        out.push(ts.visitNode(s, visit) as ts.Statement)
      }
      return out
    }

    const visit: ts.Visitor = node => {
      if (ts.isBlock(node)) return f.updateBlock(node, weave(node.statements))
      if (ts.isModuleBlock(node)) return f.updateModuleBlock(node, weave(node.statements))
      return ts.visitEachChild(node, visit, ctx)
    }

    // SourceFile top-level statements run once at module load (before any case), so we do NOT
    // probe them — only their nested block bodies, reached via visitEachChild, get probes.
    return sourceFile => ts.visitEachChild(sourceFile, visit, ctx) as ts.SourceFile
  }

  let printed: string
  try {
    const result = ts.transform(sf, [transformer])
    printed = ts.createPrinter().printFile(result.transformed[0])
    result.dispose()
  } catch (e: any) {
    return { error: `instrumentation failed: ${e?.message ?? e}` }
  }

  // Strip types and land in CommonJS so `export function` becomes `exports.foo`, which we read
  // back after load. A genuine syntax error surfaces here and abstains honestly.
  try {
    const js = ts.transpileModule(printed, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
    }).outputText
    return { code: js }
  } catch (e: any) {
    return { error: `transpile failed: ${e?.message ?? e}` }
  }
}

// ── Deterministic deep-equal (no deps; mirrors the verifier's semantics) ─────────
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return Number.isNaN(a as number) && Number.isNaN(b as number)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  return ak.every(k => deepEqual((a as any)[k], (b as any)[k]))
}

// ── Sandbox (network-denied by construction; mirrors executionVerify's globals) ──
function makeSandbox(cov: (line: number) => void): { sandbox: Record<string, unknown>; moduleObj: { exports: Record<string, unknown> } } {
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  const sandbox: Record<string, unknown> = {
    __cov: cov,
    module: moduleObj,
    exports: moduleObj.exports,
    require: (spec: string) => { throw new Error(`Cannot find module '${spec}'`) },
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    JSON, Math, Array, Object, String, Number, Boolean, Date, RegExp, Error, TypeError,
    RangeError, Map, Set, Promise, Symbol, BigInt, isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    setImmediate: () => 0, clearImmediate: () => {}, queueMicrotask: () => {},
  }
  return { sandbox, moduleObj }
}

/**
 * Localize the fault in `source` by running its acceptance `cases` and ranking source lines by
 * Ochiai suspiciousness over the passing/failing coverage spectrum. Pure determinism — no model.
 *
 * Abstains honestly (status: 'abstain') when it cannot produce a meaningful spectrum: code that
 * won't compile/load, a missing entry export, or a case set with no failures (nothing to localize).
 */
export function localizeFault(source: string, entry: string, cases: LocCase[], opts: LocalizeOpts = {}): LocalizationResult {
  const timeoutMs = opts.timeoutMs ?? 3000
  const topK = opts.topK ?? 5
  const empty = (reason: string): LocalizationResult => ({ status: 'abstain', reason, ranked: [], totalFail: 0, totalPass: 0 })

  if (!cases.length) return empty('no cases provided — nothing to localize against')

  const inst = instrument(source)
  if ('error' in inst) return empty(inst.error)

  const srcLines = source.split('\n')

  // Per-line spectrum: how many passing / failing runs touched each line.
  const passHits = new Map<number, number>()
  const failHits = new Map<number, number>()
  let totalPass = 0
  let totalFail = 0

  for (const c of cases) {
    const hit = new Set<number>()
    const { sandbox, moduleObj } = makeSandbox(line => { hit.add(line) })
    const context = vm.createContext(sandbox)

    // Load the module. A load-time throw means we can't get a spectrum for this case; skip it.
    try {
      new vm.Script(inst.code).runInContext(context, { timeout: timeoutMs })
    } catch {
      continue
    }

    const target = c.entry ?? entry
    const fn = moduleObj.exports[target]
    if (typeof fn !== 'function') {
      // No exported entry to exercise — abstain rather than guess against an empty spectrum.
      return empty(`entry '${target}' is not an exported function (localization needs an exported entry)`)
    }

    // Coverage from the CALL only — module top-level already ran during load, above.
    hit.clear()
    let passed: boolean
    try {
      const actual = (fn as (...a: unknown[]) => unknown)(...c.args)
      passed = deepEqual(actual, c.expected)
    } catch {
      // A throw is a failing case — the exception path is exactly what we want to localize.
      passed = false
    }

    const bucket = passed ? passHits : failHits
    if (passed) totalPass++; else totalFail++
    for (const line of hit) bucket.set(line, (bucket.get(line) ?? 0) + 1)
  }

  if (totalFail === 0) return empty(`all ${totalPass} case(s) passed — no fault to localize`)
  if (totalPass + totalFail === 0) return empty('no case produced a usable spectrum (all runs failed to load)')

  // Ochiai: susp(s) = fail(s) / sqrt(totalFail * (fail(s) + pass(s)))
  const lines = new Set<number>([...passHits.keys(), ...failHits.keys()])
  const ranked: SuspiciousLine[] = []
  for (const line of lines) {
    const fh = failHits.get(line) ?? 0
    const ph = passHits.get(line) ?? 0
    if (fh === 0) continue // a line no failing case touched cannot be the fault
    const score = fh / Math.sqrt(totalFail * (fh + ph))
    ranked.push({ line, text: (srcLines[line - 1] ?? '').trim(), score, failHits: fh, passHits: ph })
  }

  // Highest suspiciousness first; ties broken toward the earlier line for stable output.
  ranked.sort((a, b) => b.score - a.score || a.line - b.line)

  return { status: 'localized', ranked: ranked.slice(0, topK), totalFail, totalPass }
}

/**
 * Render the top suspects as a terse proposer-feedback block — the ONLY thing the model sees.
 * Deliberately does NOT wire itself into any prompt builder (that surface is owned elsewhere);
 * callers opt in. Terse by design: raw line dumps burn tokens and bury the signal.
 */
export function renderLocalizationBlock(result: LocalizationResult): string {
  if (result.status !== 'localized' || !result.ranked.length) {
    return `[FAULT LOCALIZATION] no suspect lines (${result.reason ?? 'abstained'}).`
  }
  const head = `[FAULT LOCALIZATION — ${result.totalFail} failing / ${result.totalPass} passing case(s)]`
  const rows = result.ranked.map(
    s => `  L${s.line} (susp ${s.score.toFixed(2)}, fail ${s.failHits}/${result.totalFail}): ${s.text}`,
  )
  return [head, 'Most suspicious lines first — fix the fault here, not elsewhere:', ...rows].join('\n')
}
