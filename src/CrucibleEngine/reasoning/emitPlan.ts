// ═══════════════════════════════════════════════════════════════════════════════
// VGR — emit planning: WHERE certified code goes (create new / append to existing)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Real SWE edits EXISTING files, it doesn't only drop new ones. This decides where a
// VGR-certified function should land:
//   • an explicit target path in the request ("add X to src/utils/strings.ts") → that file
//   • else a new file at src/<entry>.ts
// and whether to CREATE or APPEND. When appending, the COMBINED file must still parse
// (esbuild TS check) or the plan downgrades to a new file — never corrupt a real repo file.
//
// This module is PURE (given file contents in, plan out) so it is fully unit-testable and
// isolated from the server. The server hands the resulting plan to the applyLayer's
// never-regress gate for the actual write.
// ═══════════════════════════════════════════════════════════════════════════════

import { transform } from 'esbuild'

export interface EmitPlan {
  /** Project-relative path to write. */
  rel: string
  /** Full new content of that file. */
  content: string
  /** 'create' = new file; 'append' = existing file + the new function; 'replace' fallback. */
  mode: 'create' | 'append'
  detail: string
}

// A path-like token: has a slash or a code extension, no spaces. Kept conservative so prose
// like "sort the array in ascending order" never reads "ascending" as a path.
const PATH_RX = /\b((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))\b/g
// Prepositions that introduce a target file ("add X TO <path>", "IN <path>").
const TARGETED_RX = /\b(?:in|to|into|inside|within|under|at)\s+(?:the\s+)?(?:file\s+)?`?((?:\.\.?\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs))`?/i

/**
 * Detect an explicit target file path in the request, or null. Prefers a preposition-introduced
 * path ("to src/x.ts"); else the first bare path-like token. Strips a leading "./".
 */
export function detectTargetPath(nl: string): string | null {
  const targeted = TARGETED_RX.exec(nl)
  if (targeted) return normalize(targeted[1])
  const all = nl.match(PATH_RX)
  return all && all.length ? normalize(all[0]) : null
}

function normalize(p: string): string {
  return p.replace(/^\.\//, '').trim()
}

/** True when `content` already declares `export ... <entry>` (avoid duplicate definitions). */
function alreadyDefines(content: string, entry: string): boolean {
  const e = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b(?:function|const|let|var|class)\\s+${e}\\b`).test(content) ||
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${e}\\b`).test(content)
}

/**
 * Decide where the certified `code` (defining `entry`) should be written.
 *
 * @param existing  current content of the detected target file, or null if it doesn't exist.
 * Returns a plan whose `content` is the full file to write. When appending would break parsing
 * (or the target already defines `entry`), it downgrades to a fresh `src/<entry>.ts` rather than
 * corrupt an existing file — honest and safe.
 */
export async function planEmit(
  nl: string,
  entry: string,
  code: string,
  existing: string | null,
  targetPath: string | null = detectTargetPath(nl),
): Promise<EmitPlan> {
  const fresh = (detail: string): EmitPlan => ({ rel: `src/${entry}.ts`, content: code, mode: 'create', detail })

  if (!targetPath) return fresh('no target path in request → new file')

  // Target doesn't exist yet → create it at the requested path.
  if (existing == null) return { rel: targetPath, content: code, mode: 'create', detail: `new file at requested path ${targetPath}` }

  // Target exists and already has this function → don't duplicate; write standalone instead.
  if (alreadyDefines(existing, entry)) {
    return fresh(`${targetPath} already defines ${entry} → new file to avoid a duplicate definition`)
  }

  // Append the certified function and confirm the COMBINED file still compiles.
  const combined = existing.replace(/\s*$/, '') + '\n\n' + code.trim() + '\n'
  try {
    await transform(combined, { loader: 'ts', format: 'esm', target: 'node18' })
    return { rel: targetPath, content: combined, mode: 'append', detail: `appended ${entry} to existing ${targetPath} (combined file compiles)` }
  } catch {
    return fresh(`appending to ${targetPath} would not compile → new file instead (existing file left untouched)`)
  }
}
