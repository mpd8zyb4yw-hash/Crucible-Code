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
  /** 'create' = new file; 'append' = existing file + the new function; 'modify' = certified
   * in-place replacement of an existing function's definition. */
  mode: 'create' | 'append' | 'modify'
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

// A modify-shaped request: the user asks to CHANGE existing behavior, not add new. Only
// consulted when the target file already defines `entry`, so bare verbs like "fix" are safe.
const MODIFY_RX = /\b(modify|change|update|fix|rewrite|refactor|improve|correct|replace|edit|adjust|make)\b/i

/** True when the request reads as a modification of existing code. */
export function isModifyRequest(nl: string): boolean {
  return MODIFY_RX.test(nl)
}

/**
 * Find the [start, end) span of `entry`'s definition in `content`, or null when it can't be
 * located unambiguously. Handles `function entry(...)  { … }` (with optional export/async)
 * and `const entry = (…) => …` (block or expression body). A null here downgrades the plan
 * to a fresh file — never a blind splice.
 */
export function extractFunctionSpan(content: string, entry: string): { start: number; end: number } | null {
  const e = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const fnRx = new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${e}\\s*\\(`)
  const constRx = new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${e}\\s*=`)

  const fnM = fnRx.exec(content)
  if (fnM) {
    const start = fnM.index + (fnM[0].startsWith('\n') ? 1 : 0)
    const brace = content.indexOf('{', fnM.index + fnM[0].length - 1)
    if (brace === -1) return null
    const end = matchBrace(content, brace)
    return end === -1 ? null : { start, end }
  }

  const cM = constRx.exec(content)
  if (cM) {
    const start = cM.index + (cM[0].startsWith('\n') ? 1 : 0)
    const end = scanStatementEnd(content, cM.index + cM[0].length)
    return end === -1 ? null : { start, end }
  }
  return null
}

/** Index just past the brace matching content[open] (which must be '{'), or -1. Skips
 * strings, template literals, and comments so a brace inside them never miscounts. */
function matchBrace(content: string, open: number): number {
  let depth = 0
  for (let i = open; i < content.length; i++) {
    const c = content[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(content, i); if (i === -1) return -1; continue }
    if (c === '/' && content[i + 1] === '/') { i = content.indexOf('\n', i); if (i === -1) return -1; continue }
    if (c === '/' && content[i + 1] === '*') { i = content.indexOf('*/', i); if (i === -1) return -1; i++; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}

/** Index just past the closing quote of the string starting at content[i], or -1. */
function skipString(content: string, i: number): number {
  const q = content[i]
  for (let j = i + 1; j < content.length; j++) {
    if (content[j] === '\\') { j++; continue }
    if (content[j] === q) return j
    if (q !== '`' && content[j] === '\n') return j // unterminated line string — bail at EOL
  }
  return -1
}

/** End index (past trailing `;` if present) of the statement whose RHS begins at `from` —
 * scans at bracket depth 0 for a `;` or a blank-line boundary. */
function scanStatementEnd(content: string, from: number): number {
  let depth = 0
  for (let i = from; i < content.length; i++) {
    const c = content[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(content, i); if (i === -1) return -1; continue }
    if (c === '/' && content[i + 1] === '/') { i = content.indexOf('\n', i); if (i === -1) return content.length; continue }
    if (c === '/' && content[i + 1] === '*') { i = content.indexOf('*/', i); if (i === -1) return -1; i++; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ';' && depth === 0) return i + 1
    else if (c === '\n' && depth === 0 && /\n\s*\n/.test(content.slice(i, i + 3))) return i
  }
  return content.length
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

  // Target exists and already defines this function.
  if (alreadyDefines(existing, entry)) {
    // Modify-shaped request → certified IN-PLACE replacement: splice the certified
    // definition over the old one and require the whole file to still compile. The
    // certified code carries its own `export`; if the file also re-exports `entry`
    // elsewhere, the duplicate-export compile error downgrades us safely.
    if (isModifyRequest(nl)) {
      const span = extractFunctionSpan(existing, entry)
      if (span) {
        const replaced =
          existing.slice(0, span.start) + code.trim() + existing.slice(span.end)
        try {
          await transform(replaced, { loader: 'ts', format: 'esm', target: 'node18' })
          return { rel: targetPath, content: replaced, mode: 'modify', detail: `replaced ${entry} in ${targetPath} with the certified implementation (full file recompiles)` }
        } catch {
          return fresh(`in-place replacement of ${entry} in ${targetPath} would not compile → new file instead (existing file left untouched)`)
        }
      }
      return fresh(`could not locate ${entry}'s definition span in ${targetPath} → new file instead (no blind splice)`)
    }
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
