// Tier 2.2 — Mock / stub injection for framework-entangled specs.
//
// The oracle verifies a candidate by compiling it (tsc --noEmit). But code that
// leans on a framework — `import { Request, Response } from 'express'`, a React
// prop type, a project interface that isn't in scratch — fails to compile not
// because it is WRONG but because the type is ABSENT. Previously the FM was flying
// blind on exactly these specs.
//
// This module closes that gap: it analyses a candidate, finds the references it
// cannot resolve locally, and emits a single ambient `.d.ts` that supplies them —
// preferring REAL shapes (from the Tier 1.2 semantic index or Tier 1.3 retrieved
// type signatures) and falling back to a permissive stub only when no real shape is
// known. The oracle drops this file into scratch alongside the candidate so tsc can
// type-check framework-entangled code without the framework installed.
//
// Pure + deterministic + no model: AST analysis (ts.createSourceFile) + string
// emission. Stubs are intentionally permissive (`any`-typed) — their job is to let
// a CORRECT candidate compile, not to re-verify the framework's own types.

import ts from 'typescript'
import type { SemanticIndex } from '../state/semanticIndex'
import { findSymbol } from '../state/semanticIndex'

export interface ImportRef { module: string; names: string[]; hasDefault: boolean; namespace?: string }

export interface ReferenceAnalysis {
  imports: ImportRef[]
  /** Type names referenced in annotations/heritage. */
  typeRefs: string[]
  /** Names declared in this file (so we don't stub what's already defined). */
  locallyDefined: Set<string>
}

export interface StubFile { rel: string; content: string }

export interface StubResult {
  /** Ambient `.d.ts` text for bare modules + global type refs. Empty when none needed. */
  dts: string
  /** Discrete stub files for relative imports (ambient `declare module './x'` does not
   *  resolve for relative specifiers, so these are written at the resolved path). */
  files: StubFile[]
  /** Names supplied by a permissive stub. */
  stubbed: string[]
  /** Names supplied from a real definition (semantic index / retrieved signature). */
  resolved: string[]
}

// ── Analysis ──────────────────────────────────────────────────────────────────────

export function analyzeReferences(code: string): ReferenceAnalysis {
  const sf = ts.createSourceFile('candidate.ts', code, ts.ScriptTarget.Latest, true)
  const imports: ImportRef[] = []
  const typeRefs = new Set<string>()
  const locallyDefined = new Set<string>()

  const visit = (n: ts.Node) => {
    // Imports.
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const module = n.moduleSpecifier.text
      const names: string[] = []
      let hasDefault = false
      let namespace: string | undefined
      const ic = n.importClause
      if (ic) {
        if (ic.name) hasDefault = true
        if (ic.namedBindings) {
          if (ts.isNamespaceImport(ic.namedBindings)) namespace = ic.namedBindings.name.text
          else for (const el of ic.namedBindings.elements) names.push(el.name.text)
        }
      }
      imports.push({ module, names, hasDefault, namespace })
    }
    // Local declarations.
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) ||
         ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) && n.name) {
      locallyDefined.add(n.name.text)
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) locallyDefined.add(n.name.text)
    // Type references.
    if (ts.isTypeReferenceNode(n)) {
      const tn = n.typeName
      typeRefs.add(ts.isIdentifier(tn) ? tn.text : tn.right.text)
    }
    ts.forEachChild(n, visit)
  }
  sf.forEachChild(visit)
  return { imports, typeRefs: [...typeRefs], locallyDefined }
}

// ── Stub generation ─────────────────────────────────────────────────────────────

const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'void', 'never', 'object', 'symbol', 'bigint', 'null', 'undefined',
  'Array', 'Promise', 'Record', 'Map', 'Set', 'Partial', 'Readonly', 'Pick', 'Omit', 'Date', 'RegExp', 'Error',
  'Function', 'Object', 'String', 'Number', 'Boolean', 'Iterable', 'Iterator', 'ReadonlyArray',
])

/** Pull a real `interface X {...}` / `type X = ...` block for `name` from retrieved signatures. */
function realSignatureFor(name: string, signatures: string[]): string | null {
  for (const sig of signatures) {
    if (new RegExp(`\\b(?:interface|type|class)\\s+${name}\\b`).test(sig)) {
      // Normalise to an exported ambient declaration.
      return sig.replace(/^export\s+/, '').replace(/^declare\s+/, '').trim()
    }
  }
  return null
}

/**
 * Build an ambient `.d.ts` that resolves everything a candidate references but does
 * not define locally. Real shapes win; permissive stubs fill the rest.
 */
export function injectMocks(
  code: string,
  opts: { index?: SemanticIndex; retrievedSignatures?: string[]; availableModules?: Set<string> } = {},
): StubResult {
  const a = analyzeReferences(code)
  const sigs = opts.retrievedSignatures ?? []
  const available = opts.availableModules ?? new Set<string>()
  const stubbed: string[] = []
  const resolved: string[] = []
  const blocks: string[] = []
  const files: StubFile[] = []

  // 1. Imports whose types aren't available → supply them. A bare module ('express')
  //    is stubbed via `declare module`; a relative module ('./models') needs a real
  //    file at its resolved path (ambient declare-module does not match relative
  //    specifiers). Modules listed in `availableModules` are left alone (real types).
  for (const imp of a.imports) {
    if (available.has(imp.module)) continue
    const isRelative = imp.module.startsWith('.') || imp.module.startsWith('/')
    const members: string[] = []
    for (const n of imp.names) {
      const real = realSignatureFor(n, sigs)  // prefer a real retrieved signature
      if (real) { members.push(`  export ${real.startsWith('interface') || real.startsWith('type') || real.startsWith('class') ? real : `const ${n}: any`}`); resolved.push(n) }
      else { members.push(`  export const ${n}: any`); members.push(`  export type ${n} = any`); stubbed.push(n) }
    }
    if (imp.hasDefault) members.push('  const _default: any', '  export default _default')
    if (imp.namespace) members.push('  const _ns: any', '  export = _ns')
    const body = [...new Set(members)].join('\n')
    if (isRelative) {
      // './models' → 'models.d.ts'; './a/b' → 'a/b.d.ts'. Strip leading ./ and any ext.
      const rel = imp.module.replace(/^\.\//, '').replace(/^\//, '').replace(/\.[tj]sx?$/, '') + '.d.ts'
      files.push({ rel, content: `// AUTO-GENERATED stub (Tier 2.2) for ${imp.module}\n${body.replace(/^ {2}/gm, '')}\n` })
    } else {
      blocks.push(`declare module '${imp.module}' {\n${body}\n}`)
    }
  }

  // 2. Type references not defined locally, not built-in, not imported → ambient type.
  const importedNames = new Set(a.imports.flatMap(i => [...i.names, i.namespace].filter(Boolean) as string[]))
  for (const t of a.typeRefs) {
    if (BUILTIN_TYPES.has(t) || a.locallyDefined.has(t) || importedNames.has(t)) continue
    // Real shape from semantic index?
    const fromIndex = opts.index ? findSymbol(opts.index, t).find(s => ['interface', 'type', 'class', 'enum'].includes(s.def.kind)) : undefined
    const real = realSignatureFor(t, sigs)
    if (real) { blocks.push(`declare ${real};`.replace(/;;$/, ';')); resolved.push(t) }
    else if (fromIndex) { blocks.push(`type ${t} = any; // real def: ${fromIndex.rel}`); resolved.push(t) }
    else { blocks.push(`type ${t} = any;`); stubbed.push(t) }
  }

  const dts = blocks.length
    ? `// AUTO-GENERATED stub/mock declarations (Tier 2.2) — permissive, verification-only.\n${blocks.join('\n')}\n`
    : ''
  return { dts, files, stubbed: [...new Set(stubbed)], resolved: [...new Set(resolved)] }
}
