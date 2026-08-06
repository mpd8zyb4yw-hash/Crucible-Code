// ============================================================================
// Gate A3 — contract/interface checker (Frontier-SWE-gap Workstream 1, critic #2).
//
// Gap this closes: Gate A's tsconfig is deliberately lenient (`strict:false,
// noImplicitAny:false` — see oracle.ts writeTsConfig) so unrelated generated code still
// typechecks. That leniency means a candidate can compile clean while silently violating
// the "Exact public API" contract a spec pins down verbatim — wrong param count, a renamed
// export, an added optional param, a changed return type — none of which trip a loose tsc
// pass, especially once `any` is in play. Every "Exact public API (<path>):" block in this
// repo's benchmark specs (coding-benchmarks.ts) exists BECAUSE "an automated audit imports
// it verbatim" — this gate is that audit, generalized to any spec carrying the same block.
//
// Design constraints, matching lintGate.ts (Gate A2):
// - Local, deterministic, no model call — pure text extraction of the declared contract +
//   TS compiler API (already a repo dependency, syntactic mode only — no Program/checker)
//   over the candidate's actual exports.
// - Fails OPEN: no "Exact public API" block in the spec → nothing to check → ok:true,
//   ran:false. A parse failure on either side degrades the same way. This gate only ever
//   ADDS a check; it never blocks a candidate it can't confidently evaluate.
// - Contract-violation only, never style: it checks function name, parameter COUNT, and
//   return-type text (structurally, whitespace-insensitive) — not implementation details.
// ============================================================================
import ts from 'typescript'
import type { SynthFile } from './synthEngine'
import { recordGate } from '../debug/gateTelemetry'

export interface ContractVerdict {
  ok: boolean
  detail: string   // '' when ok; first violation formatted for the retry prompt otherwise
  ran: boolean      // false when the spec had no checkable "Exact public API" block
}

interface DeclaredSig { name: string; paramCount: number; returnType: string | null }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Coarse, false-positive-averse return-type comparison. Gate A's own tsconfig runs
 *  `noImplicitAny:false` — a candidate declaring `any[]` where the spec pins `User[]` is a
 *  legitimate, compile-clean loosening, not a contract violation, so exact text equality
 *  would block genuinely correct candidates (worse than missing a bug). Only flag a
 *  category-level mismatch: array-ness and void-ness, the two properties a caller's
 *  call-site actually breaks on. Anything the candidate widens to `any`/`unknown`/a
 *  generic container is never flagged. */
function returnShapeMismatch(declared: string | null, actual: string | null): boolean {
  if (!declared || !actual) return false
  if (/\b(any|unknown)\b/.test(actual)) return false
  const isArray = (t: string) => /\[\]\s*$/.test(t) || /^Array</.test(t) || /^ReadonlyArray</.test(t)
  const isVoid = (t: string) => /^void$/.test(t) || /^Promise<void>$/.test(t)
  if (isArray(declared) !== isArray(actual)) return true
  if (isVoid(declared) !== isVoid(actual)) return true
  return false
}

/** Pull the "Exact public API (<path>):" block out of a spec and extract its top-level
 *  function/method signatures. Returns [] if the spec carries no such block. */
function declaredSignatures(spec: string): DeclaredSig[] {
  const blockMatch = spec.match(/Exact public API[^:]*:\n([\s\S]*?)(?:\n\n|\nRules:|$)/)
  if (!blockMatch) return []
  const block = blockMatch[1]
  const sigs: DeclaredSig[] = []
  // `export function name(a: T, b: U): R` or `function name(a, b): R` inside the block.
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^\n;]+))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block))) {
    const [, name, params, ret] = m
    const paramCount = params.trim() === '' ? 0 : params.split(',').filter(p => p.trim() !== '').length
    sigs.push({ name, paramCount, returnType: ret ? norm(ret) : null })
  }
  return sigs
}

/** Walk a candidate file's AST (syntactic-only, no type-checker) for its exported function
 *  declarations, matching the same shape declaredSignatures() extracts from the spec.
 *
 *  Found + fixed 2026-07-06: this originally only recognized `export function name(...)`
 *  (FunctionDeclaration). A candidate written in the equally-common
 *  `export const name = (a, b): R => ...` or `export const name = function(a, b): R {...}`
 *  style was invisible to it — `actual` never contained the export at all, so checkContract
 *  rejected a CORRECT candidate with "missing export", a false positive that actively hurts
 *  generation accuracy (Gate A3 exists to add confidence, not to punish a valid style
 *  choice). Now also walks exported `const name = <arrow|function-expression>` bindings. */
function actualSignatures(path: string, content: string): DeclaredSig[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true,
    /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const sigs: DeclaredSig[] = []
  const isExported = (n: ts.Node) =>
    !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
  const fromFunctionLike = (name: string, fn: ts.FunctionLikeDeclarationBase) => {
    sigs.push({
      name,
      paramCount: fn.parameters.length,
      returnType: fn.type ? norm(fn.type.getText(sf)) : null,
    })
  }
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && isExported(n)) {
      fromFunctionLike(n.name.text, n)
    } else if (ts.isVariableStatement(n) && isExported(n)) {
      for (const decl of n.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          fromFunctionLike(decl.name.text, decl.initializer)
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sigs
}

/** Check every candidate file's exports against any "Exact public API" contract in the spec. */
export function checkContract(spec: string, files: SynthFile[]): ContractVerdict {
  let declared: DeclaredSig[]
  try { declared = declaredSignatures(spec) } catch { declared = [] }
  if (!declared.length) {
    recordGate({ gate: 'gateA3_contract', ran: false, reason: 'no "Exact public API" block in spec' })
    return { ok: true, detail: '', ran: false }
  }

  const actual: DeclaredSig[] = []
  for (const f of files) {
    if (!/\.tsx?$/.test(f.path)) continue
    try { actual.push(...actualSignatures(f.path, f.content)) } catch { /* fail open on parse error */ }
  }

  for (const d of declared) {
    const match = actual.find(a => a.name === d.name)
    if (!match) {
      recordGate({ gate: 'gateA3_contract', ran: true, reason: `rejected: missing export ${d.name}` })
      return { ok: false, ran: true, detail: `contract: spec declares export "${d.name}" but no candidate file exports a function of that name` }
    }
    if (match.paramCount !== d.paramCount) {
      recordGate({ gate: 'gateA3_contract', ran: true, reason: `rejected: ${d.name} arity mismatch` })
      return {
        ok: false, ran: true,
        detail: `contract: "${d.name}" declared with ${d.paramCount} parameter(s), candidate has ${match.paramCount}`,
      }
    }
    if (returnShapeMismatch(d.returnType, match.returnType)) {
      recordGate({ gate: 'gateA3_contract', ran: true, reason: `rejected: ${d.name} return-type mismatch` })
      return {
        ok: false, ran: true,
        detail: `contract: "${d.name}" declared to return "${d.returnType}", candidate declares "${match.returnType}"`,
      }
    }
  }
  recordGate({ gate: 'gateA3_contract', ran: true, reason: 'clean' })
  return { ok: true, detail: '', ran: true }
}
