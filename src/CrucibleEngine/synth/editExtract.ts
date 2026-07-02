// ============================================================================
// editExtract — focused file-section extraction for FM-guided edits.
//
// Problem: the FM has a limited context window (~1200 tokens out, ~4000 in).
// When editing a large existing file (800+ lines) it needs to see the whole
// file structure AND the specific function to change — but not 800 lines.
//
// Solution: build a two-part view:
//   1. STRUCTURE SKETCH  — all function/class signatures (one line each, no bodies)
//   2. TARGET SECTION    — the full body of the function(s) the goal mentions
//
// This fits in ~600 tokens for a 500-line file while giving the FM exactly
// what it needs to produce a correct, non-regressive edit.
// ============================================================================

/** Line range (inclusive, 0-indexed). */
interface LineRange { start: number; end: number }

/**
 * Extract a brace-balanced function/class block starting at `startLine`.
 * Returns the line range of the entire definition (signature + body).
 */
function extractBlock(lines: string[], startLine: number): LineRange {
  let depth = 0
  let inBlock = false
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; inBlock = true }
      if (ch === '}') depth--
    }
    if (inBlock && depth === 0) return { start: startLine, end: i }
  }
  return { start: startLine, end: Math.min(startLine + 60, lines.length - 1) }
}

/** Return a one-line signature sketch of a function/class declaration. */
function sketchLine(line: string): string {
  // Keep up to the first { or EOL, strip body
  const idx = line.indexOf('{')
  const sig = (idx >= 0 ? line.slice(0, idx) : line).trimEnd()
  return sig.length > 120 ? sig.slice(0, 117) + '…' : sig
}

/**
 * Find all top-level function/class definitions in `lines`.
 * Returns [{name, lineIndex}] sorted by line order.
 */
function findTopLevelDefs(lines: string[]): Array<{ name: string; line: number }> {
  const defs: Array<{ name: string; line: number }> = []
  const DEF_RE = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/
  const ARROW_RE = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[=:]/
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEF_RE) ?? lines[i].match(ARROW_RE)
    if (m?.[1]) defs.push({ name: m[1], line: i })
  }
  return defs
}

/**
 * Find function/symbol names mentioned in the goal text.
 * Looks for camelCase/PascalCase identifiers that appear in the file.
 */
function goalSymbols(goal: string, knownNames: string[]): string[] {
  const knownSet = new Set(knownNames)
  // Extract identifiers from goal (camelCase / PascalCase / snake_case)
  const tokens = goal.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []
  const mentioned: string[] = []
  for (const t of tokens) {
    if (knownSet.has(t) && !mentioned.includes(t)) mentioned.push(t)
  }
  return mentioned
}

export interface ExtractedView {
  /**
   * Compact view of the file for the FM:
   *   STRUCTURE SKETCH + TARGET SECTIONS (full bodies)
   * Always < ~100 lines regardless of original file size.
   */
  view: string
  /** The total original line count, for context in the prompt. */
  totalLines: number
  /** Names of sections included in full. */
  includedSections: string[]
}

/**
 * Build a focused view of `fileContent` for editing according to `goal`.
 *
 * If the file is short (<= FULL_THRESHOLD lines) the full content is returned as-is.
 * For larger files, returns a structure sketch + targeted full bodies.
 */
export function buildEditView(fileContent: string, goal: string): ExtractedView {
  const FULL_THRESHOLD = 80  // lines below which we just return the whole thing
  const MAX_TARGET_LINES = 120  // max lines to include per target section
  const MAX_SECTIONS = 3  // max number of target sections to include

  const lines = fileContent.split('\n')

  if (lines.length <= FULL_THRESHOLD) {
    return { view: fileContent, totalLines: lines.length, includedSections: [] }
  }

  const defs = findTopLevelDefs(lines)
  const defNames = defs.map(d => d.name)
  const targets = goalSymbols(goal, defNames)

  // Build structure sketch: one line per top-level def
  const sketchLines: string[] = [`// FILE STRUCTURE (${lines.length} lines total):`]
  for (const d of defs) {
    const marker = targets.includes(d.name) ? '◀ EDIT TARGET' : ''
    sketchLines.push(`//   L${d.line + 1}: ${sketchLine(lines[d.line])}${marker ? '  ' + marker : ''}`)
  }
  sketchLines.push('')

  // Include full bodies of target sections (or fallback to first def if no targets found)
  const toInclude = targets.length ? targets.slice(0, MAX_SECTIONS) : defNames.slice(0, 1)
  const included: string[] = []
  const bodyChunks: string[] = []

  for (const name of toInclude) {
    const def = defs.find(d => d.name === name)
    if (!def) continue
    const range = extractBlock(lines, def.line)
    const bodyLines = lines.slice(range.start, Math.min(range.end + 1, range.start + MAX_TARGET_LINES))
    if (range.end - range.start >= MAX_TARGET_LINES) bodyLines.push('  // ... (body truncated)')
    bodyChunks.push(`// ── SECTION: ${name} (L${range.start + 1}–L${range.end + 1}) ──`)
    bodyChunks.push(...bodyLines)
    bodyChunks.push('')
    included.push(name)
  }

  const view = sketchLines.join('\n') + bodyChunks.join('\n')
  return { view, totalLines: lines.length, includedSections: included }
}

/**
 * Build the FM edit spec for a large-file edit.
 * Combines the focused view with the goal and explicit re-emit instruction.
 */
export function buildEditSpec(
  goal: string,
  targetPath: string,
  fileContent: string,
  errors: string,
): string {
  const { view, totalLines, includedSections } = buildEditView(fileContent, goal)
  const isLargeFile = totalLines > 80

  const errorCtx = errors ? `\nPrevious tsc errors to fix:\n${errors}\n` : ''

  if (!isLargeFile) {
    // Small file: full content, ask for full re-emit
    return [
      goal,
      errorCtx,
      `\nExisting file content (${targetPath}):`,
      '```typescript',
      fileContent.slice(0, 8000),
      '```',
      'Output the COMPLETE updated file.',
      `\nTarget file: ${targetPath}`,
    ].join('\n')
  }

  // Large file: focused view + section-patch mode.
  // FM emits ONLY changed sections; Node splices them back via applyPatch().
  return [
    goal,
    errorCtx,
    `\nFile: ${targetPath} (${totalLines} lines total). IMPORTANT: output ONLY changed sections below.`,
    includedSections.length
      ? `Edit target(s): ${includedSections.join(', ')}`
      : '',
    '',
    view,
    '',
    '## Instructions',
    'Output ONLY the updated version of each changed function/section using this format:',
    '```typescript',
    '// SECTION: <function_or_class_name>',
    '<complete updated function or class body here>',
    '// END_SECTION',
    '```',
    'Do NOT output unchanged sections. The system will splice your changes back into the original file.',
    `\nTarget file: ${targetPath}`,
  ].filter(Boolean).join('\n')
}

// ── Section-level patch splicing (Gate #2) ────────────────────────────────────

export interface SectionPatch {
  name: string
  code: string
}

/**
 * Parse FM output that was generated using the section-patch mode.
 * Looks for // SECTION: <name> ... // END_SECTION blocks.
 */
export function parseSectionPatches(fmOutput: string): SectionPatch[] {
  const patches: SectionPatch[] = []
  // Match ```typescript blocks or bare SECTION: markers
  const blockRe = /(?:```(?:typescript|ts)?\s*)?\s*\/\/\s*SECTION:\s*(\w+)\s*\n([\s\S]*?)\/\/\s*END_SECTION(?:\s*```)?/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(fmOutput)) !== null) {
    const name = m[1].trim()
    const code = m[2].trimEnd()
    if (name && code) patches.push({ name, code })
  }
  return patches
}

/**
 * Apply section patches to the original file content.
 * Replaces each named function/class body with the patched version.
 * Returns the fully patched file content.
 *
 * Gate #2: this is the primitive that lets Crucible edit existing files
 * at section granularity without the FM having to re-emit the entire file.
 */
export function applyPatch(original: string, patches: SectionPatch[]): string {
  if (!patches.length) return original

  const lines = original.split('\n')
  const defs = findTopLevelDefs(lines)

  // Build a map: name → line range in original
  const defMap = new Map(defs.map(d => [d.name, d]))

  let result = [...lines]
  // Apply in reverse order so line indices don't shift
  const toApply = patches
    .map(p => ({ patch: p, def: defMap.get(p.name) }))
    .filter(x => x.def)
    .sort((a, b) => (b.def!.line) - (a.def!.line))  // descending by line

  for (const { patch, def } of toApply) {
    const range = extractBlock(result, def!.line)
    const newLines = patch.code.split('\n')
    result.splice(range.start, range.end - range.start + 1, ...newLines)
  }

  return result.join('\n')
}

/**
 * Detect if FM output is in section-patch format or whole-file format.
 * Returns true if at least one SECTION: marker is present.
 */
export function isSectionPatchOutput(fmOutput: string): boolean {
  return /\/\/\s*SECTION:\s*\w+/.test(fmOutput)
}
