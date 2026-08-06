// Codebase indexing — Gap 3 (Persistent World Model).
// Walks the project on first agent run, extracts symbols + imports deterministically
// (no model calls), persists to .crucible/codebase-index.json. On each agent turn,
// top-K relevant files are retrieved via cosine similarity and injected into the
// system preamble. Re-indexes changed files after every agent mutation pass.

import fs from 'fs'
import path from 'path'
import { crucibleDir } from './session'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileEntry {
  rel: string          // path relative to projectPath
  lang: string         // 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'css' | 'json' | 'other'
  size: number
  mtime: number
  symbols: string[]    // exported / top-level names
  imports: string[]    // raw import sources (first 12)
  summary: string      // one-line deterministic descriptor
  vec: Record<string, number>  // tf-normalized token vector for retrieval
}

export interface CodebaseIndex {
  projectPath: string
  indexedAt: number
  entries: FileEntry[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.crucible', '.next', 'out',
  'coverage', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
])
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.swift', '.kt',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.md', '.sh', '.bash',
])
const MAX_FILE_SIZE = 200_000  // skip files > 200 KB
const MAX_ENTRIES   = 400      // cap total indexed files
const INDEX_FILE    = 'codebase-index.json'

// ── Tokenizer (mirrors server.ts vectorize/cosineSim) ─────────────────────────

const STOPWORDS = new Set([
  'the','and','for','are','but','not','you','all','this','with','have','from',
  'they','will','would','could','should','been','that','than','then','when',
  'what','which','there','their','about','into','more','also','some','its',
  'was','were','has','had','can','may','any','one','use','used','using',
  'new','get','set','add','run','file','path','type','let','var','const',
  'import','export','return','async','await','function','class','interface',
])

function stem(t: string): string {
  return t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t
}

function vectorize(text: string): Record<string, number> {
  const vec: Record<string, number> = {}
  const tokens = (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
    .filter(t => !STOPWORDS.has(t)).map(stem)
  for (const t of tokens) vec[t] = (vec[t] ?? 0) + 1
  // tf-normalize
  const total = tokens.length || 1
  for (const k in vec) vec[k] /= total
  return vec
}

export function cosineSim(a: Record<string, number>, b: Record<string, number>): number {
  let dot = 0
  for (const [k, w] of Object.entries(a)) { if (b[k]) dot += w * b[k] }
  let na = 0; for (const w of Object.values(a)) na += w * w
  let nb = 0; for (const w of Object.values(b)) nb += w * w
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

// ── Symbol extraction (regex-only, no AST, fast) ─────────────────────────────

function extractSymbols(content: string, lang: string): string[] {
  const syms: string[] = []
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx' || lang === 'mjs') {
    const patterns = [
      /export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\s+(\w+)/g,
      /export\s+(?:const|let|var|type|interface|enum)\s+(\w+)/g,
      /^(?:async\s+)?function\s+(\w+)/gm,
      /^(?:const|let|var)\s+(\w+)\s*=/gm,
      /^class\s+(\w+)/gm,
    ]
    for (const pat of patterns) {
      for (const m of content.matchAll(pat)) {
        if (m[1] && m[1].length > 1 && m[1] !== 'default') syms.push(m[1])
      }
    }
  } else if (lang === 'py') {
    for (const m of content.matchAll(/^(?:async\s+)?def\s+(\w+)/gm)) syms.push(m[1])
    for (const m of content.matchAll(/^class\s+(\w+)/gm)) syms.push(m[1])
  } else if (lang === 'go') {
    for (const m of content.matchAll(/^func\s+(?:\([^)]*\)\s+)?(\w+)/gm)) syms.push(m[1])
    for (const m of content.matchAll(/^type\s+(\w+)/gm)) syms.push(m[1])
  }
  // Deduplicate, cap at 20
  return [...new Set(syms)].slice(0, 20)
}

function extractImports(content: string, lang: string): string[] {
  const imps: string[] = []
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx' || lang === 'mjs') {
    for (const m of content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)) imps.push(m[1])
    for (const m of content.matchAll(/require\(['"]([^'"]+)['"]\)/g)) imps.push(m[1])
  } else if (lang === 'py') {
    for (const m of content.matchAll(/^(?:import|from)\s+([\w.]+)/gm)) imps.push(m[1])
  } else if (lang === 'go') {
    for (const m of content.matchAll(/"([^"]+)"/g)) imps.push(m[1])
  }
  return [...new Set(imps)].slice(0, 12)
}

function langFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py', '.go': 'go', '.rs': 'rs', '.rb': 'rb', '.java': 'java',
    '.swift': 'swift', '.kt': 'kt', '.css': 'css', '.scss': 'css',
    '.html': 'html', '.vue': 'vue', '.svelte': 'svelte',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
    '.md': 'md', '.sh': 'sh', '.bash': 'sh',
  }
  return map[ext] ?? 'other'
}

function buildSummary(rel: string, lang: string, symbols: string[], imports: string[]): string {
  const base = path.basename(rel)
  const parts: string[] = [`${base} (${lang})`]
  if (symbols.length) parts.push(`exports: ${symbols.slice(0, 6).join(', ')}`)
  const extImports = imports.filter(i => !i.startsWith('.') && !i.startsWith('/'))
  if (extImports.length) parts.push(`uses: ${extImports.slice(0, 4).join(', ')}`)
  return parts.join(' — ')
}

// ── Index a single file ───────────────────────────────────────────────────────

function indexFile(abs: string, rel: string): FileEntry | null {
  try {
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return null
    const ext = path.extname(abs).toLowerCase()
    if (!SOURCE_EXTS.has(ext)) return null
    const content = fs.readFileSync(abs, 'utf-8')
    const lang = langFromExt(ext)
    const symbols = extractSymbols(content, lang)
    const imports = extractImports(content, lang)
    const summary = buildSummary(rel, lang, symbols, imports)
    const vecText = [rel, ...symbols, ...imports, summary].join(' ')
    return {
      rel, lang,
      size: stat.size,
      mtime: stat.mtimeMs,
      symbols, imports, summary,
      vec: vectorize(vecText),
    }
  } catch { return null }
}

// ── Walk project tree ─────────────────────────────────────────────────────────

function walkProject(projectPath: string): string[] {
  const results: string[] = []

  function walk(dir: string) {
    if (results.length >= MAX_ENTRIES * 2) return
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs)
      } else if (e.isFile()) {
        results.push(abs)
      }
    }
  }

  walk(projectPath)
  return results
}

// ── Index path ────────────────────────────────────────────────────────────────

function indexPath(projectPath: string): string {
  return path.join(crucibleDir(projectPath), INDEX_FILE)
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Build (or rebuild) the full index. Returns entry count. */
export function buildIndex(projectPath: string): number {
  const abs = path.resolve(projectPath)
  const files = walkProject(abs)
  const entries: FileEntry[] = []
  for (const f of files) {
    if (entries.length >= MAX_ENTRIES) break
    const rel = path.relative(abs, f)
    const entry = indexFile(f, rel)
    if (entry) entries.push(entry)
  }
  const idx: CodebaseIndex = { projectPath: abs, indexedAt: Date.now(), entries }
  const dest = indexPath(abs)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(idx), 'utf-8')
  return entries.length
}

/** Load existing index or return null. */
export function loadIndex(projectPath: string): CodebaseIndex | null {
  try {
    return JSON.parse(fs.readFileSync(indexPath(path.resolve(projectPath)), 'utf-8'))
  } catch { return null }
}

/**
 * Ensure index exists and is fresh. Re-indexes files modified since last run.
 * Fast: only re-hashes changed files, so hot paths stay < 50ms.
 * Returns the loaded-or-built index.
 */
export function ensureIndex(projectPath: string): CodebaseIndex {
  const abs = path.resolve(projectPath)
  const existing = loadIndex(abs)
  if (!existing) {
    buildIndex(abs)
    return loadIndex(abs)!
  }

  // Incremental update: check mtimes
  const entryMap = new Map(existing.entries.map(e => [e.rel, e]))
  const files = walkProject(abs)
  let changed = 0

  for (const f of files) {
    if (entryMap.size >= MAX_ENTRIES) break
    const rel = path.relative(abs, f)
    try {
      const mtime = fs.statSync(f).mtimeMs
      const existing_entry = entryMap.get(rel)
      if (!existing_entry || existing_entry.mtime < mtime) {
        const entry = indexFile(f, rel)
        if (entry) { entryMap.set(rel, entry); changed++ }
      }
    } catch { /* file disappeared */ }
  }

  // Remove deleted files
  for (const rel of entryMap.keys()) {
    if (!fs.existsSync(path.join(abs, rel))) { entryMap.delete(rel); changed++ }
  }

  if (changed > 0) {
    const idx: CodebaseIndex = {
      projectPath: abs,
      indexedAt: Date.now(),
      entries: [...entryMap.values()],
    }
    fs.writeFileSync(indexPath(abs), JSON.stringify(idx), 'utf-8')
    return idx
  }

  return existing
}

/**
 * Re-index specific files after an agent mutation.
 * Call with the list of abs paths that were written.
 */
export function reindexFiles(projectPath: string, changedAbs: string[]): void {
  const abs = path.resolve(projectPath)
  const existing = loadIndex(abs)
  if (!existing) return
  const entryMap = new Map(existing.entries.map(e => [e.rel, e]))
  for (const f of changedAbs) {
    const rel = path.relative(abs, f)
    if (!rel.startsWith('..')) {
      const entry = indexFile(f, rel)
      if (entry) entryMap.set(rel, entry)
      else entryMap.delete(rel)
    }
  }
  const idx: CodebaseIndex = { projectPath: abs, indexedAt: Date.now(), entries: [...entryMap.values()] }
  fs.writeFileSync(indexPath(abs), JSON.stringify(idx), 'utf-8')
}

/**
 * Retrieve top-K most relevant files for a query.
 * Returns entries sorted by cosine similarity to the query.
 */
export function searchIndex(idx: CodebaseIndex, query: string, topK = 8): FileEntry[] {
  const qv = vectorize(query)
  if (!Object.keys(qv).length) return []
  return idx.entries
    .map(e => ({ e, sim: cosineSim(qv, e.vec) }))
    .filter(x => x.sim > 0.05)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, topK)
    .map(x => x.e)
}

/**
 * Build a compact preamble block for injection into agent system prompt.
 * Includes: file count, top relevant files with their symbols.
 */
export function buildCodebaseContext(projectPath: string, query: string, topK = 8): string {
  const idx = ensureIndex(projectPath)
  const total = idx.entries.length
  if (total === 0) return ''

  const relevant = searchIndex(idx, query, topK)
  if (!relevant.length) return ''

  const lines: string[] = [
    `CODEBASE (${total} files indexed):`,
  ]
  for (const e of relevant) {
    const sym = e.symbols.length ? ` [${e.symbols.slice(0, 5).join(', ')}]` : ''
    lines.push(`  ${e.rel}${sym}`)
  }
  return lines.join('\n')
}

/** Stats for /api/debug/codebase endpoint. */
export function indexStats(projectPath: string): {
  total: number; indexedAt: number | null; byLang: Record<string, number>
} {
  const idx = loadIndex(path.resolve(projectPath))
  if (!idx) return { total: 0, indexedAt: null, byLang: {} }
  const byLang: Record<string, number> = {}
  for (const e of idx.entries) byLang[e.lang] = (byLang[e.lang] ?? 0) + 1
  return { total: idx.entries.length, indexedAt: idx.indexedAt, byLang }
}
