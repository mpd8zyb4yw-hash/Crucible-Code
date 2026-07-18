// ============================================================
// CRUCIBLE — Answer-path EXECUTION verifier
//
// WHY THIS EXISTS (cont.86b → 87):
// The answer path certified by PATTERN-MATCHING NAMES: "every identifier the answer
// mentions appears in the docs". That measures PROVENANCE, not correctness. It certified
// this, verbatim, from the live FM:
//
//   const { base64, cidrv4, cuid, email, extend, ipv4, string } = require('zod')
//   const ipv4Schema = { type: 'object', properties: { ip: { pattern: '^(25[0-5]|...' } } }
//   const validateIpv4 = (ip) => ipv4Schema.validate(ip)
//
// JSON Schema with a hand-rolled regex — the exact failure the verifier exists to catch —
// wearing a decorative import so every name is "documented". Each regex tightening closed one
// path and the generator found the next (measured twice in one session). You cannot regex your
// way to correctness: the oracle must EXECUTE.
//
// THE PRINCIPLE — a STRUCTURAL error is INPUT-INDEPENDENT.
//   `ipv4Schema.validate is not a function`  → throws for EVERY input. The code is broken.
//   `ZodError: invalid ip`                   → throws for SOME inputs. That is the code WORKING.
// So we execute the answer's own functions across generic probes and reject only when EVERY
// probe dies structurally. No input synthesis, no per-question test data, no library knowledge
// — which is what makes it universal rather than a per-request band-aid.
//
// It is un-gameable in the way the regex was: name-dropping does not survive execution, because
// a name that isn't really there throws when you CALL it. The FM's laundering call `extend(...)`
// is not a real zod export — regex saw "documented identifier", execution sees TypeError.
//
// FAILS IN TWO DIRECTIONS (cont.85): a false REJECT poisons repair, so every gate here abstains
// rather than guesses, and the bench pins BOTH directions — gamed code REJECTS, canonical
// correct code CERTIFIES.
// ============================================================
/// <reference types="node" />

import * as vm from 'vm'
import { createRequire } from 'module'
import * as ts from 'typescript'
import {
  answerCodeBlocks, extractLibraryUsage, evidenceCovers, documentedCallSurface,
  verifyApiFaithfulness, type FaithfulnessVerdict,
} from './apiFaithfulness'

export type ExecutionStatus = 'certified' | 'violations' | 'abstain'

export interface ExecutionDefect {
  /** The symbol whose call died, or '<module>' for a top-level failure. */
  symbol: string
  /** The structural error, verbatim from the runtime. */
  error: string
}

export interface ExecutionVerdict {
  status: ExecutionStatus
  reason: string
  defects: ExecutionDefect[]
  /** Library actually loaded from disk and exercised. */
  library?: string
  /** Symbols we invoked. Empty => nothing was callable => abstain. */
  exercised: string[]
  executionMs: number
}

// Errors that prove the code is structurally broken NO MATTER the input. These are the shapes a
// JSON-Schema-pretending-to-be-a-library answer dies with. A validation error is NOT here — that
// is the code working correctly.
const STRUCTURAL_ERROR = [
  /\bis not a function\b/,
  /\bis not a constructor\b/,
  /Cannot read propert(?:y|ies) of undefined\b/,
  /Cannot read propert(?:y|ies) of null\b/,
  /\bundefined is not an object\b/,
  /\bis not defined\b/,          // ReferenceError — fabricated free identifier
  // `const x = …; x = …` throws EVERY time that line runs, for any input — the exact bug in the
  // live FM's linked-list demo (`const current = head; current = current.next`). Input-independent,
  // so it belongs here; the codeblock TS gate catches it only in TS blocks (2588), not JS.
  /\bAssignment to constant variable\b/,
  /\bAssignment to constant\b/,   // some engines phrase it "Assignment to constant '<name>'"
]

function isStructural(e: unknown): boolean {
  // CROSS-REALM: `instanceof TypeError` is ALWAYS FALSE for an error thrown by vm code — the vm
  // context has its own intrinsics, so the runtime's TypeError is not the host's. Using instanceof
  // here silently classified every structural error as benign and certified broken code (measured:
  // the whole catch half of the bench failed while the false-reject half passed). Compare by name.
  const name = (e as any)?.name
  const message = (e as any)?.message
  if (typeof name !== 'string' || typeof message !== 'string') return false
  // A ZodError (or any library's own validation error) is the code WORKING. Only the runtime's
  // own structural complaints count, and only by shape — never by library-specific knowledge.
  if (name !== 'TypeError' && name !== 'ReferenceError') return false
  return STRUCTURAL_ERROR.some(p => p.test(message))
}

/**
 * Names bound at the top level of the transpiled code.
 *
 * `vm.runInContext` surfaces `var` and function declarations as context properties, but `const`
 * and `let` stay LEXICAL and are invisible from outside — so the answer's `const validate = ...`
 * could never be found or exercised. We read the declared names off the AST and re-export them
 * from INSIDE the script's own scope, which is the only place they exist.
 */
function topLevelBindings(js: string): string[] {
  const sf = ts.createSourceFile('__answer.js', js, ts.ScriptTarget.ES2020, true)
  const names: string[] = []
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text)
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.push(d.name.text)
        // Destructured bindings are library handles (`const { z } = require('zod')`), not the
        // answer's own functions — exercising them would test zod, not the answer.
      }
    }
  }
  return names
}

// Generic probes. Deliberately value-agnostic: we are not testing the answer's LOGIC (we have no
// oracle for that), only that calling it does not collapse structurally. A correct validator
// rejects most of these with its own error — which is a PASS here.
const PROBES: unknown[] = ['1.2.3.4', 'not-an-ip', '', 0, 42, {}, [], true]

/** Can this library be loaded from disk right now? Unresolvable => environment limit => abstain. */
function resolves(lib: string, from: string): boolean {
  try {
    createRequire(from).resolve(lib)
    return true
  } catch {
    return false
  }
}

/**
 * Execute the answer's code and invoke what it defines.
 *
 * Certifies only what actually RUNS. Everything unprovable abstains — an abstain is honest and
 * strictly better than a gameable green.
 */
export function verifyByExecution(
  answer: string,
  evidence: string,
  opts: { timeoutMs?: number; from?: string } = {},
): ExecutionVerdict {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 5000
  const from = opts.from ?? `${process.cwd()}/package.json`
  const done = (v: Omit<ExecutionVerdict, 'executionMs'>): ExecutionVerdict =>
    ({ ...v, executionMs: Date.now() - started })
  const abstain = (reason: string): ExecutionVerdict =>
    done({ status: 'abstain', reason, defects: [], exercised: [] })

  const blocks = answerCodeBlocks(answer)
  if (!blocks.length) return abstain('no code blocks in the answer — nothing to execute')
  const source = blocks.join('\n')

  // Judge only a library the evidence actually documents AND that exists on disk. Both gates are
  // environment/authority questions, not correctness ones, so failing either abstains.
  const usage = extractLibraryUsage(source)
  const judged = usage.map(u => u.library).find(l => evidenceCovers(evidence, l) && resolves(l, from))
  if (!judged) {
    return abstain(
      usage.length
        ? `no imported library is both documented by the evidence and installed here (${usage.map(u => u.library).join(', ')}) — cannot execute against the real API`
        : 'answer imports nothing — no library surface to execute against',
    )
  }

  // Transpile TS/ESM down to CommonJS so `import { z } from 'zod'` runs as written.
  let js: string
  try {
    js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
    }).outputText
  } catch (e: any) {
    return abstain(`answer code could not be transpiled: ${e?.message ?? e}`)
  }

  const defects: ExecutionDefect[] = []
  const exercised: string[] = []
  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  // Filled from inside the script's own lexical scope — see topLevelBindings.
  const lexical: Record<string, unknown> = {}

  // Network-denied by construction: the ONLY module that resolves is the documented library.
  // No fs, no net, no child_process — an answer cannot reach anything by being executed.
  const guardedRequire = (spec: string): unknown => {
    if (spec !== judged) throw new Error(`Cannot find module '${spec}'`)
    return createRequire(from)(spec)
  }

  const sandbox: Record<string, unknown> = {
    require: guardedRequire,
    module: moduleObj,
    exports: moduleObj.exports,
    __crucible_collect: (bag: Record<string, unknown>) => { Object.assign(lexical, bag) },
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    JSON, Math, Array, Object, String, Number, Boolean, Date, RegExp, Error, TypeError,
    RangeError, Map, Set, Promise, Symbol, BigInt, isNaN, parseInt, parseFloat,
  }

  const context = vm.createContext(sandbox)

  // ── Phase 1: does the module even evaluate? ──────────────────────────────
  // The FM's laundering call `extend(ipv4Schema, {...})` dies HERE: `extend` is not a real zod
  // export, so calling it at top level throws TypeError. Regex called that "used the evidence".
  const bindings = topLevelBindings(js)
  const collector = bindings.length ? `\n;__crucible_collect({ ${bindings.join(', ')} });` : ''
  try {
    new vm.Script(js + collector).runInContext(context, { timeout: timeoutMs })
  } catch (e: any) {
    if (isStructural(e)) {
      return done({
        status: 'violations',
        reason: `the answer's code throws on load: ${e.message}`,
        defects: [{ symbol: '<module>', error: e.message }],
        library: judged,
        exercised: [],
      })
    }
    // Syntax errors / timeouts / a library's own startup complaint are not this verifier's call.
    return abstain(`answer code did not evaluate (${e?.name ?? 'Error'}: ${e?.message ?? e}) — not judged as a structural defect`)
  }

  // ── Phase 2: invoke what it defines ──────────────────────────────────────
  // Read module.exports off the module object, not a captured reference: `module.exports = {...}`
  // REPLACES the object, so a reference grabbed beforehand stays empty forever.
  const callables = collectCallables(lexical, moduleObj.exports)
  if (!callables.length) {
    return abstain('answer defines no callable function — loaded cleanly but there is nothing to exercise')
  }

  for (const { name, fn } of callables) {
    const errors = probe(fn, timeoutMs)
    exercised.push(name)
    // ONLY when EVERY probe dies structurally is the defect input-independent. If even one probe
    // survives, the code has a working path and this verifier has no standing to reject it.
    if (errors.length === PROBES.length && errors.every(isStructural)) {
      defects.push({ symbol: name, error: (errors[0] as Error).message })
    }
  }

  if (defects.length) {
    return done({
      status: 'violations',
      reason: `${defects.length} function${defects.length > 1 ? 's fail' : ' fails'} structurally on every input: ${defects.map(d => `${d.symbol} (${d.error})`).join('; ')}`,
      defects,
      library: judged,
      exercised,
    })
  }

  return done({
    status: 'certified',
    reason: `executed against the real ${judged}: ${exercised.join(', ')} ran without structural failure`,
    defects: [],
    library: judged,
    exercised,
  })
}

/**
 * THE ANSWER-PATH CERTIFY CONDITION. One oracle, used by both the badge (groundedAnswer) and the
 * repair search (faithfulRepair) — they MUST agree, or repair optimizes against a different gate
 * than the one that ships and manufactures a green the badge then trusts (cont.86b).
 *
 * Precedence, strongest evidence first:
 *   1. Execution says it's broken  → violations. We RAN it; no claim about names outranks that.
 *   2. Names are fabricated        → violations. Cheap, and catches what never gets to run.
 *   3. Execution says it works     → certified. EARNED: it ran against the real library.
 *   4. Execution couldn't judge    → fall back to the name check, marked `executed: false`.
 *
 * Case 4 is the honest limit: when the library isn't installed we cannot execute, and a
 * name-matched certify there is exactly as weak as it always was. It is NOT dressed up as more —
 * `executed` says which kind of certify this is, and the caller is expected to tell the truth.
 */
export function certifyAnswer(
  answer: string,
  evidence: string,
  opts: { timeoutMs?: number; from?: string; codeRequested?: boolean } = {},
): FaithfulnessVerdict & { executed: boolean } {
  // CODE WAS ASKED FOR AND NONE CAME BACK. This lives in the SINGLE oracle rather than the
  // caller, because the repair loop re-verifies through certifyAnswer — a check the caller adds
  // on top is invisible inside repair, so the draft re-verifies as `abstain`, the proposer sees
  // no violation and returns the prose unchanged. MEASURED cont.89: "zod schema for a uuid
  // string" came back as prose, repair was entered but had nothing to act on, and the prose
  // shipped. Putting it here means the draft AND every repair attempt are judged the same way.
  if (opts.codeRequested && answerCodeBlocks(answer).length === 0) {
    const surface = documentedCallSurface(evidence)
    return {
      status: 'violations',
      reason: 'the answer is prose with no code block — the question asked for code',
      violations: [{ library: '', identifier: '(no code block)', kind: 'no-code', line: '' }],
      documented: surface, callSurface: surface, library: undefined, executed: false,
    }
  }
  const names = verifyApiFaithfulness(answer, evidence)
  const exec = verifyByExecution(answer, evidence, opts)

  if (exec.status === 'violations') {
    return {
      status: 'violations',
      reason: exec.reason,
      // MERGE, never shadow. The two checks find DIFFERENT things: execution proves the code is
      // broken, the name check names the fabricated API. Returning only the execution defect drops
      // the fabricated identifier, and `rejectedIdentifiers` then has nothing to carry forward —
      // so the search stops accumulating negative information and re-proposes the name it was just
      // told was wrong (cont.84: repair is a search; a search that forgets is a retry loop).
      violations: [
        // Carry the runtime error as the `line` so repairHint can quote it verbatim.
        ...exec.defects.map(d => ({
          library: exec.library ?? 'unknown',
          identifier: d.symbol,
          kind: 'execution-failure' as const,
          line: d.error,
        })),
        ...names.violations,
      ],
      documented: names.documented,
      callSurface: names.callSurface,
      library: exec.library ?? names.library,
      executed: true,
    }
  }

  // PLAIN-CODE PATH. The library exec abstains on pure code (no documented+installed import). Run
  // the answer's own demonstration — it catches a runtime-structural break in code with no library
  // surface (the cont.90 linked-list class). Only reached when the library path had no standing.
  if (exec.status === 'abstain') {
    const plain = verifyPlainCodeByExecution(answer, opts)
    if (plain.status === 'violations') {
      return {
        status: 'violations',
        reason: plain.reason,
        violations: [
          ...plain.defects.map(d => ({
            library: 'unknown',
            identifier: d.symbol,
            kind: 'execution-failure' as const,
            line: d.error,
          })),
          ...names.violations,
        ],
        documented: names.documented,
        callSurface: names.callSurface,
        library: names.library,
        executed: true,
      }
    }
    if (plain.status === 'certified' && names.status !== 'violations') {
      return {
        status: 'certified',
        reason: plain.reason,
        violations: [],
        documented: names.documented,
        callSurface: names.callSurface,
        library: names.library,
        executed: true,
      }
    }
  }

  if (names.status === 'violations') return { ...names, executed: false }

  if (exec.status === 'certified') {
    return {
      status: 'certified',
      reason: exec.reason,
      violations: [],
      documented: names.documented,
      callSurface: names.callSurface,
      library: exec.library,
      executed: true,
    }
  }

  return { ...names, executed: false }
}

// ============================================================
// PLAIN-CODE execution verifier (cont.91)
//
// The library path above needs an imported package the evidence documents. Most answers to
// "reverse a linked list", "implement an LRU cache", "write a debounce" import NOTHING — pure
// JS/TS. The linked-list answer (cont.90) shipped uncompilable code the council stamped GREEN;
// the codeblock TS gate now catches the SYNTACTIC/semantic-fatal slice, but a draft that PARSES
// and then dies structurally at RUNTIME (a method that isn't defined, a fabricated free variable
// reached only when called, `this.head` deref on undefined) slips past a static gate.
//
// WHY NOT PROBE like the library path does. The library probes (`'1.2.3.4'`, 0, {}, …) are
// scalar/loose — safe for a VALIDATOR that takes a string. Plain-code answers take STRUCTURED
// input: `reverseList(head)` wants a linked-list node. Feeding it `'1.2.3.4'` makes a CORRECT
// function throw `Cannot read next of undefined` on every probe → a false reject of working code.
// Synthesizing structured inputs is unbounded and is exactly the false-reject trap the north-star
// memory warns against. So this path synthesizes NOTHING.
//
// WHAT IT DOES INSTEAD — run the answer's OWN demonstration. Good plain-code answers include
// usage: `const list = new LinkedList(); list.push(1); console.log(list.reverse())`. Those are
// the AUTHOR's chosen inputs, so a structural death there is INPUT-INDEPENDENT by construction —
// the same universal principle as the library path, with zero input synthesis and therefore zero
// false-reject risk. No demo → nothing exercised → abstain (honest, never a guess).
// ============================================================

/** Names declared at the top level, INCLUDING classes — used to tell a real demo from noise. */
function topLevelLocals(js: string): Set<string> {
  const sf = ts.createSourceFile('__answer.js', js, ts.ScriptTarget.ES2020, true)
  const names = new Set<string>()
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.add(st.name.text)
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text)
      }
    }
  }
  return names
}

/** Root identifier of a call/new target: `new Foo` → Foo, `list.push` → list, `a.b.c()` → a. */
function rootIdentifier(expr: ts.Expression): string | undefined {
  let e: ts.Expression = expr
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e) || ts.isNonNullExpression(e)) {
    e = ts.isCallExpression(e) ? e.expression : (e as any).expression
  }
  return ts.isIdentifier(e) ? e.text : undefined
}

/**
 * Does the code actually EXERCISE its own definitions? True iff some call/new anywhere roots to a
 * locally-declared name (`new LinkedList()`, `reverseList(x)`, `list.push()`). This is what
 * separates a self-demonstrating answer (safe to certify on a clean run) from a bare definition
 * file (nothing ran → abstain). `console.log(...)` roots to `console`, which is not local, so a
 * lone log never counts as a demo.
 */
function exercisesLocals(js: string, locals: Set<string>): boolean {
  const sf = ts.createSourceFile('__answer.js', js, ts.ScriptTarget.ES2020, true)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const root = rootIdentifier(node.expression)
      if (root && locals.has(root)) { found = true; return }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/**
 * Execute a PLAIN-code answer (no third-party import) and let its OWN demonstration run.
 *
 * Certifies only when the answer exercises its own definitions and survives structurally.
 * Rejects only on an input-independent structural throw from the author's own execution.
 * Everything else abstains.
 */
export function verifyPlainCodeByExecution(
  answer: string,
  opts: { timeoutMs?: number } = {},
): ExecutionVerdict {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 5000
  const done = (v: Omit<ExecutionVerdict, 'executionMs'>): ExecutionVerdict =>
    ({ ...v, executionMs: Date.now() - started })
  const abstain = (reason: string): ExecutionVerdict =>
    done({ status: 'abstain', reason, defects: [], exercised: [] })

  const blocks = answerCodeBlocks(answer)
  if (!blocks.length) return abstain('no code blocks in the answer — nothing to execute')
  // DEDUPE identical blocks before joining. Live FM output routinely emits the SAME program in two
  // fences; joining them redeclares every top-level `const` and throws a SyntaxError, so the whole
  // check false-abstained on real answers (measured cont.91). Exact-duplicate removal is safe —
  // running one copy of an identical program is the same as running two.
  const source = [...new Set(blocks.map(b => b.trim()))].join('\n')

  // This path is for PURE code only. Any import means either the library path already judged it,
  // or it needs a module we would have to DENY — and denying a module the code legitimately needs
  // makes correct code throw `Cannot find module`, a false reject. So imports => not our call.
  if (extractLibraryUsage(source).length > 0) {
    return abstain('answer imports a module — handled by the library path or out of scope for plain-code execution')
  }

  let js: string
  try {
    js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false },
    }).outputText
  } catch (e: any) {
    return abstain(`answer code could not be transpiled: ${e?.message ?? e}`)
  }

  const locals = topLevelLocals(js)
  if (!exercisesLocals(js, locals)) {
    return abstain('answer defines code but never exercises it — no self-demonstration to run')
  }

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} }
  // Deny EVERYTHING. Pure code needs no modules; anything it reaches for is out of scope, and
  // denying it (rather than providing it) keeps the sandbox unable to touch fs/net/child_process.
  const denyRequire = (spec: string): never => { throw new Error(`Cannot find module '${spec}'`) }

  const sandbox: Record<string, unknown> = {
    require: denyRequire,
    module: moduleObj,
    exports: moduleObj.exports,
    console: { log: () => {}, error: () => {}, warn: () => {}, info: () => {} },
    JSON, Math, Array, Object, String, Number, Boolean, Date, RegExp, Error, TypeError,
    RangeError, Map, Set, Promise, Symbol, BigInt, isNaN, parseInt, parseFloat,
    setTimeout: () => 0, clearTimeout: () => {},
  }
  const context = vm.createContext(sandbox)

  try {
    new vm.Script(js).runInContext(context, { timeout: timeoutMs })
  } catch (e: any) {
    if (isStructural(e)) {
      return done({
        status: 'violations',
        reason: `the answer's own example fails structurally when run: ${e.message}`,
        defects: [{ symbol: '<demo>', error: e.message }],
        exercised: [...locals],
      })
    }
    // Syntax errors belong to the codeblock TS gate; a thrown Error the demo raises on purpose, a
    // timeout, or a denied module are not this verifier's call. Abstain rather than guess.
    return abstain(`answer code did not evaluate (${e?.name ?? 'Error'}: ${e?.message ?? e}) — not judged as a structural defect`)
  }

  return done({
    status: 'certified',
    reason: `the answer's own example ran to completion without structural failure`,
    defects: [],
    exercised: [...locals],
  })
}

/** Call fn with each probe; return what each threw (undefined slots are dropped by construction). */
function probe(fn: Function, timeoutMs: number): unknown[] {
  const errors: unknown[] = []
  for (const p of PROBES) {
    try {
      const out = runWithTimeout(fn, p, timeoutMs)
      // A rejected promise is the code's own async error, not a structural collapse.
      if (out instanceof Promise) out.catch(() => {})
    } catch (e) {
      errors.push(e)
    }
  }
  return errors
}

function runWithTimeout(fn: Function, arg: unknown, _timeoutMs: number): unknown {
  // The vm.Script timeout already bounds top-level work; a probe call is a direct invocation and
  // cannot be interrupted mid-loop without a worker. Kept as a seam, deliberately not faked.
  return fn(arg)
}

/** Top-level functions the answer defined (lexical + exported). */
function collectCallables(
  lexical: Record<string, unknown>,
  moduleExports: Record<string, unknown>,
): Array<{ name: string; fn: Function }> {
  const found: Array<{ name: string; fn: Function }> = []
  const seen = new Set<Function>()

  const take = (name: string, v: unknown) => {
    if (typeof v !== 'function' || seen.has(v)) return
    // Arity 0 takes no input, so probing proves nothing about input handling.
    if (v.length === 0) return
    seen.add(v)
    found.push({ name, fn: v })
  }

  for (const [k, v] of Object.entries(moduleExports ?? {})) take(k, v)
  for (const [k, v] of Object.entries(lexical)) take(k, v)
  return found
}
