// Tier 1.2 — Semantic Repo Index (symbol-level).
//
// The file-level `codebaseIndex` answers "which files look relevant?" via a tf
// vector. This index answers the structural questions downstream stages need:
//   • exports / declarations per file (with kind + exported flag)
//   • import graph (who imports whom, resolved across relative specifiers)
//   • call graph (which symbol calls which) — syntactic, name-resolved
//   • type-dependency chains (interfaces/classes/aliases → referenced types)
//   • interface/class relationships (extends / implements)
//
// It is load-bearing for everything downstream: grounding, context ranking, mock
// generation, and cross-file coherence all query it. So it is built to be QUERIED
// by the DAG (Tier 1.1) and the capability router — see the query API at the foot.
//
// Construction uses the TypeScript compiler API in SYNTACTIC mode only
// (`ts.createSourceFile` per file — no Program, no type-checker, no tsconfig
// resolution). That keeps it deterministic, fast, dependency-light, and — most
// importantly — free of any model inference. Cross-file resolution is by symbol
// name against the global declaration table, the same altitude the rest of the
// engine operates at, but AST-accurate rather than regex-approximate.

import fs from 'fs'
import path from 'path'
import ts from 'typescript'
import { crucibleDir } from './session'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'method'

export interface SymbolDef {
  name: string
  kind: SymbolKind
  exported: boolean
  /** Symbol names this one references (callees for functions, type refs for types). */
  refs: string[]
  /** For class/interface: names it extends or implements. */
  heritage: string[]
}

export interface SemFileEntry {
  rel: string
  mtime: number
  /** Resolved relative-import targets (project-relative, best-effort) + bare specifiers. */
  imports: string[]
  /** Top-level declared symbols. */
  symbols: SymbolDef[]
}

export interface SemanticIndex {
  projectPath: string
  indexedAt: number
  files: SemFileEntry[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.crucible', '.next', 'out',
  'coverage', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
])
const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const MAX_FILE_SIZE = 400_000
const MAX_FILES = 600
const INDEX_FILE = 'semantic-index.json'

// ── AST extraction (syntactic, no type-checker) ─────────────────────────────────

function scriptKind(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX
    case '.jsx': return ts.ScriptKind.JSX
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS
    default: return ts.ScriptKind.TS
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const mods = (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? []
  return mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
}

// Collect every identifier used in a call position, plus referenced type names,
// within a subtree — these become a symbol's `refs` (call + type edges).
function collectRefs(node: ts.Node): string[] {
  const refs = new Set<string>()
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      if (ts.isIdentifier(callee)) refs.add(callee.text)
      else if (ts.isPropertyAccessExpression(callee)) refs.add(callee.name.text)
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      refs.add(n.expression.text)
    } else if (ts.isTypeReferenceNode(n)) {
      const tn = n.typeName
      if (ts.isIdentifier(tn)) refs.add(tn.text)
      else refs.add(tn.right.text)
    }
    ts.forEachChild(n, visit)
  }
  ts.forEachChild(node, visit)
  return [...refs]
}

function heritageNames(node: ts.ClassDeclaration | ts.InterfaceDeclaration): string[] {
  const out: string[] = []
  for (const clause of node.heritageClauses ?? []) {
    for (const t of clause.types) {
      if (ts.isIdentifier(t.expression)) out.push(t.expression.text)
    }
  }
  return out
}

function extractSymbols(sf: ts.SourceFile): SymbolDef[] {
  const syms: SymbolDef[] = []

  const pushExportedNames = (decl: ts.Node, names: string[], kind: SymbolKind, exported: boolean, refs: string[], heritage: string[]) => {
    void decl
    for (const name of names) syms.push({ name, kind, exported, refs, heritage })
  }

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      pushExportedNames(node, [node.name.text], 'function', hasExportModifier(node), collectRefs(node), [])
    } else if (ts.isClassDeclaration(node) && node.name) {
      const refs = collectRefs(node)
      syms.push({ name: node.name.text, kind: 'class', exported: hasExportModifier(node), refs, heritage: heritageNames(node) })
      // Surface public methods as their own symbols (call-graph granularity).
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name)) {
          syms.push({ name: `${node.name.text}.${m.name.text}`, kind: 'method', exported: hasExportModifier(node), refs: collectRefs(m), heritage: [] })
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      pushExportedNames(node, [node.name.text], 'interface', hasExportModifier(node), collectRefs(node), heritageNames(node))
    } else if (ts.isTypeAliasDeclaration(node)) {
      pushExportedNames(node, [node.name.text], 'type', hasExportModifier(node), collectRefs(node), [])
    } else if (ts.isEnumDeclaration(node)) {
      pushExportedNames(node, [node.name.text], 'enum', hasExportModifier(node), [], [])
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node)
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          // An arrow/function-valued const participates in the call graph.
          const refs = d.initializer ? collectRefs(d) : []
          syms.push({ name: d.name.text, kind: 'const', exported, refs, heritage: [] })
        }
      }
    }
    // Only walk the top level for declarations; refs are collected per-decl above.
  }

  sf.forEachChild(visit)
  return syms
}

function extractImports(sf: ts.SourceFile, abs: string, projectRoot: string): string[] {
  const out: string[] = []
  const dir = path.dirname(abs)
  const visit = (node: ts.Node) => {
    let spec: string | null = null
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      spec = node.moduleSpecifier.text
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0]
      if (a && ts.isStringLiteral(a)) spec = a.text
    }
    if (spec) {
      if (spec.startsWith('.')) {
        // Resolve relative import to a project-relative path (best-effort, .ts/.tsx/index).
        const resolved = resolveRelative(dir, spec, projectRoot)
        out.push(resolved ?? spec)
      } else {
        out.push(spec)
      }
    }
    ts.forEachChild(node, visit)
  }
  sf.forEachChild(visit)
  return [...new Set(out)]
}

function resolveRelative(fromDir: string, spec: string, projectRoot: string): string | null {
  const base = path.resolve(fromDir, spec)
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js'),
  ]
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return path.relative(projectRoot, c) } catch { /* next */ }
  }
  return null
}

// ── Indexing ────────────────────────────────────────────────────────────────────

function walk(projectRoot: string): string[] {
  const results: string[] = []
  const go = (dir: string) => {
    if (results.length >= MAX_FILES * 2) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) go(abs) }
      else if (e.isFile() && TS_EXTS.has(path.extname(e.name))) results.push(abs)
    }
  }
  go(projectRoot)
  return results
}

function indexFile(abs: string, projectRoot: string): SemFileEntry | null {
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null
    const content = fs.readFileSync(abs, 'utf-8')
    const ext = path.extname(abs)
    const sf = ts.createSourceFile(abs, content, ts.ScriptTarget.Latest, true, scriptKind(ext))
    return {
      rel: path.relative(projectRoot, abs),
      mtime: stat.mtimeMs,
      imports: extractImports(sf, abs, projectRoot),
      symbols: extractSymbols(sf),
    }
  } catch { return null }
}

function indexPath(projectRoot: string): string {
  return path.join(crucibleDir(projectRoot), INDEX_FILE)
}

/** Build (or rebuild) the full semantic index. Returns file count. */
export function buildSemanticIndex(projectPath: string): number {
  const root = path.resolve(projectPath)
  const files: SemFileEntry[] = []
  for (const abs of walk(root)) {
    if (files.length >= MAX_FILES) break
    const entry = indexFile(abs, root)
    if (entry) files.push(entry)
  }
  const idx: SemanticIndex = { projectPath: root, indexedAt: Date.now(), files }
  const dest = indexPath(root)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(idx), 'utf-8')
  return files.length
}

export function loadSemanticIndex(projectPath: string): SemanticIndex | null {
  try { return JSON.parse(fs.readFileSync(indexPath(path.resolve(projectPath)), 'utf-8')) } catch { return null }
}

/** Load-or-build, with incremental mtime refresh. The DAG/router entry point. */
export function ensureSemanticIndex(projectPath: string): SemanticIndex {
  const root = path.resolve(projectPath)
  const existing = loadSemanticIndex(root)
  if (!existing) { buildSemanticIndex(root); return loadSemanticIndex(root)! }

  const byRel = new Map(existing.files.map(f => [f.rel, f]))
  let changed = 0
  for (const abs of walk(root)) {
    if (byRel.size >= MAX_FILES) break
    const rel = path.relative(root, abs)
    try {
      const mtime = fs.statSync(abs).mtimeMs
      const prev = byRel.get(rel)
      if (!prev || prev.mtime < mtime) { const e = indexFile(abs, root); if (e) { byRel.set(rel, e); changed++ } }
    } catch { /* gone */ }
  }
  for (const rel of [...byRel.keys()]) {
    if (!fs.existsSync(path.join(root, rel))) { byRel.delete(rel); changed++ }
  }
  if (changed > 0) {
    const idx: SemanticIndex = { projectPath: root, indexedAt: Date.now(), files: [...byRel.values()] }
    fs.writeFileSync(indexPath(root), JSON.stringify(idx), 'utf-8')
    return idx
  }
  return existing
}

/** Re-index specific files after a mutation (keeps the call/type graph fresh). */
export function reindexSemanticFiles(projectPath: string, changedAbs: string[]): void {
  const root = path.resolve(projectPath)
  const existing = loadSemanticIndex(root)
  if (!existing) return
  const byRel = new Map(existing.files.map(f => [f.rel, f]))
  for (const abs of changedAbs) {
    const rel = path.relative(root, abs)
    if (rel.startsWith('..')) continue
    const e = indexFile(abs, root)
    if (e) byRel.set(rel, e); else byRel.delete(rel)
  }
  const idx: SemanticIndex = { projectPath: root, indexedAt: Date.now(), files: [...byRel.values()] }
  fs.writeFileSync(indexPath(root), JSON.stringify(idx), 'utf-8')
}

// ── Query API (consumed by the DAG and the capability router) ────────────────────

export interface SymbolLocation { rel: string; def: SymbolDef }

/** All declarations of `name` across the repo (usually one; >1 means a name clash). */
export function findSymbol(idx: SemanticIndex, name: string): SymbolLocation[] {
  const out: SymbolLocation[] = []
  for (const f of idx.files) for (const s of f.symbols) if (s.name === name) out.push({ rel: f.rel, def: s })
  return out
}

export function symbolsInFile(idx: SemanticIndex, rel: string): SymbolDef[] {
  return idx.files.find(f => f.rel === rel)?.symbols ?? []
}

/** Files that import `rel` (reverse import edges). */
export function importersOf(idx: SemanticIndex, rel: string): string[] {
  const stem = rel.replace(/\.[tj]sx?$/, '')
  return idx.files
    .filter(f => f.imports.some(i => i === rel || i.replace(/\.[tj]sx?$/, '') === stem))
    .map(f => f.rel)
}

/** Resolved local files that `rel` imports (forward import edges). */
export function importsOf(idx: SemanticIndex, rel: string): string[] {
  const f = idx.files.find(x => x.rel === rel)
  if (!f) return []
  const known = new Set(idx.files.map(x => x.rel))
  return f.imports.filter(i => known.has(i))
}

/** Symbols whose `refs` include `name` — i.e. callers of a function / users of a type. */
export function callersOf(idx: SemanticIndex, name: string): SymbolLocation[] {
  const out: SymbolLocation[] = []
  for (const f of idx.files) for (const s of f.symbols) if (s.refs.includes(name)) out.push({ rel: f.rel, def: s })
  return out
}

/** What `name`'s definition references (callees / type deps), resolved to known symbols. */
export function calleesOf(idx: SemanticIndex, name: string): string[] {
  const defs = findSymbol(idx, name)
  return [...new Set(defs.flatMap(d => d.def.refs))]
}

/**
 * Transitive type-dependency chain for a type/interface/class: the closure of
 * referenced types and heritage, resolved against declared symbols. Bounded by a
 * visited set so cyclic types terminate.
 */
export function typeChain(idx: SemanticIndex, name: string, maxDepth = 6): string[] {
  const seen = new Set<string>()
  const queue: { n: string; d: number }[] = [{ n: name, d: 0 }]
  while (queue.length) {
    const { n, d } = queue.shift()!
    if (seen.has(n) || d > maxDepth) continue
    seen.add(n)
    for (const loc of findSymbol(idx, n)) {
      if (loc.def.kind === 'interface' || loc.def.kind === 'type' || loc.def.kind === 'class' || loc.def.kind === 'enum') {
        for (const ref of [...loc.def.refs, ...loc.def.heritage]) queue.push({ n: ref, d: d + 1 })
      }
    }
  }
  seen.delete(name)
  return [...seen].filter(n => findSymbol(idx, n).length > 0)
}

/**
 * Files structurally related to `rel`: its importers, its imports, and the files
 * defining the types/symbols it references. This is the primary ranking signal for
 * downstream context assembly and mock generation.
 */
export function relatedFiles(idx: SemanticIndex, rel: string): string[] {
  const out = new Set<string>([...importersOf(idx, rel), ...importsOf(idx, rel)])
  const f = idx.files.find(x => x.rel === rel)
  if (f) {
    for (const s of f.symbols) {
      for (const ref of [...s.refs, ...s.heritage]) {
        for (const loc of findSymbol(idx, ref)) if (loc.rel !== rel) out.add(loc.rel)
      }
    }
  }
  return [...out]
}

/** Compact structural summary of a file for spec injection / logs. */
export function summarizeFile(idx: SemanticIndex, rel: string): string {
  const f = idx.files.find(x => x.rel === rel)
  if (!f) return ''
  const exp = f.symbols.filter(s => s.exported).map(s => `${s.kind} ${s.name}`)
  const local = importsOf(idx, rel)
  const lines = [`${rel}:`]
  if (exp.length) lines.push(`  exports: ${exp.slice(0, 12).join(', ')}`)
  if (local.length) lines.push(`  local imports: ${local.slice(0, 8).join(', ')}`)
  return lines.join('\n')
}
