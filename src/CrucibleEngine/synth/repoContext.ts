// ============================================================================
// Phase C — Repo-context layer for synthesis.
//
// When a synthesis task targets a file inside a known project, this module
// extracts local conventions (types, imports, related symbols) from the
// codebase index and returns:
//
//   1. A compact "REPO CONTEXT:" spec prefix — enriches feature extraction so
//      the skill matcher sees project-specific signals (framework, types, etc.).
//
//   2. A list of relevant source files for the oracle to copy into its scratch
//      dir, so `tsc --noEmit` sees project types and rejects incompatible emits.
//
// Both outputs are opt-in: callers that don't pass projectPath get the current
// behaviour unchanged. The index is loaded lazily (one disk read per session).
// ============================================================================
import fs from 'fs'
import path from 'path'
import { loadIndex, searchIndex, type FileEntry } from '../state/codebaseIndex'

const MAX_CONTEXT_FILES = 5
const MAX_CONTENT_BYTES = 4_000   // cap per file to keep spec prefix short
const SKIP_CONTENT_EXTS = new Set(['.json', '.md', '.yaml', '.yml', '.toml', '.sh', '.bash'])

export interface OracleContextFile {
  /** Absolute path on disk. */
  src: string
  /** Path relative to project root — used by the oracle to place the file in scratch at the
   *  same relative location so generated imports (e.g. `'./types'`) resolve correctly. */
  rel: string
}

export interface RepoContextResult {
  /** Compact prefix to prepend to the spec for feature extraction. May be empty. */
  specPrefix: string
  /** Project source files with placement info for the oracle scratch copy. */
  oracleFiles: OracleContextFile[]
  /** The current content of the target file (if it exists). Null if new/absent. */
  targetContent: string | null
}

/**
 * Build repo context for a synthesis task.
 * @param projectPath  Absolute path to the project root.
 * @param spec         The raw synthesis spec string.
 * @param targetPath   Relative path of the file being synthesized (from spec extraction).
 */
export function buildRepoContext(
  projectPath: string,
  spec: string,
  targetPath: string | null,
): RepoContextResult {
  const empty: RepoContextResult = { specPrefix: '', oracleFiles: [], targetContent: null }


  // Load index — cheap if already built (one readFileSync).
  const idx = loadIndex(path.resolve(projectPath))
  if (!idx || !idx.entries.length) return empty

  // Search for files relevant to this spec.
  const relevant = searchIndex(idx, spec, MAX_CONTEXT_FILES)
  if (!relevant.length) return empty

  // Read current target file content (if it exists).
  let targetContent: string | null = null
  if (targetPath) {
    const abs = path.join(path.resolve(projectPath), targetPath)
    try { targetContent = fs.readFileSync(abs, 'utf-8') } catch { /* new file */ }
  }

  // Build spec prefix from relevant files.
  const lines: string[] = ['REPO CONTEXT (extracted offline from codebase index):']

  // If target already exists, summarise its current state first.
  if (targetContent && targetPath) {
    const preview = targetContent.slice(0, 800)
    lines.push(`TARGET FILE (${targetPath} — current content):`)
    lines.push(preview)
    if (targetContent.length > 800) lines.push('... (truncated)')
  }

  // Summarise top-K related files. For small TS/JS files include the actual content so the
  // FM sees field names and concrete data (e.g. User.email) rather than just symbol names.
  lines.push('RELATED FILES:')
  for (const e of relevant) {
    if (SKIP_CONTENT_EXTS.has(path.extname(e.rel))) {
      // Non-source files: just symbol/import summary.
      const sym = e.symbols.length ? `exports: ${e.symbols.slice(0, 8).join(', ')}` : ''
      const imp = e.imports.filter(i => !i.startsWith('.')).slice(0, 4)
      const deps = imp.length ? `uses: ${imp.join(', ')}` : ''
      lines.push(`  ${[e.rel, sym, deps].filter(Boolean).join(' — ')}`)
    } else {
      // Source files: include content when small enough (field names, interfaces, data).
      const abs = path.join(path.resolve(projectPath), e.rel)
      let content: string | null = null
      try {
        const size = fs.statSync(abs).size
        if (size > 0 && size <= MAX_CONTENT_BYTES) content = fs.readFileSync(abs, 'utf-8')
      } catch { /* skip */ }
      if (content) {
        lines.push(`  // ${e.rel}`)
        lines.push(content.trimEnd())
      } else {
        const sym = e.symbols.length ? `exports: ${e.symbols.slice(0, 8).join(', ')}` : ''
        lines.push(`  ${[e.rel, sym].filter(Boolean).join(' — ')}`)
      }
    }
  }

  // Collect source files for oracle scratch copy (TS/JS only, with non-trivial type content).
  // Include both src (abs path) and rel (project-relative) so the oracle places them at the
  // correct path in scratch — ensuring imports like `'./types'` resolve correctly.
  const oracleFiles: OracleContextFile[] = []
  for (const e of relevant) {
    if (SKIP_CONTENT_EXTS.has(path.extname(e.rel))) continue
    const abs = path.join(path.resolve(projectPath), e.rel)
    if (!fs.existsSync(abs)) continue
    try {
      const size = fs.statSync(abs).size
      if (size > 0 && size < MAX_CONTENT_BYTES * 4) oracleFiles.push({ src: abs, rel: e.rel })
    } catch { /* skip */ }
  }

  const specPrefix = lines.join('\n') + '\n\nSYNTHESIS SPEC:\n'
  return { specPrefix, oracleFiles, targetContent }
}

/**
 * Enrich a spec with repo context for feature extraction.
 * The prefix is structural (not prose), so extractFeatures sees richer signals
 * without losing the actual spec text.
 */
export function enrichSpec(spec: string, ctx: RepoContextResult): string {
  if (!ctx.specPrefix) return spec
  return ctx.specPrefix + spec
}

/**
 * Fold a pre-processed internet-retrieval block (Tier 1.3) into the repo-context
 * prefix, ahead of the SYNTHESIS SPEC marker so the FM reads it as grounding. The
 * block is already boilerplate-stripped, relevance-ranked and budget-fit by the
 * retrieval layer — the FM never sees a raw dump. No-op when there is nothing to add.
 */
export function withRetrieval(ctx: RepoContextResult, retrievalBlock: string): RepoContextResult {
  if (!retrievalBlock) return ctx
  const marker = '\n\nSYNTHESIS SPEC:\n'
  const specPrefix = ctx.specPrefix.endsWith(marker)
    ? ctx.specPrefix.slice(0, -marker.length) + `\n${retrievalBlock}` + marker
    : (ctx.specPrefix || '') + `${retrievalBlock}${marker}`
  return { ...ctx, specPrefix }
}
