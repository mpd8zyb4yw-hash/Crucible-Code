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

// ─── Signature parsing (for annotation grafting + call-site safety) ───────────

export interface ParamInfo {
  /** Bare parameter name, or null for destructuring/rest patterns we don't rename. */
  name: string | null
  /** Full source text of the parameter (name, annotation, default). */
  text: string
  /** Has an explicit `: type` annotation. */
  hasType: boolean
  /** Optional (`?`) or defaulted (`=`) — call sites may omit it. */
  optional: boolean
  rest: boolean
}

export interface Signature {
  params: ParamInfo[]
  /** Return-type annotation text (without the leading `:`), or null. */
  returnType: string | null
  /** Absolute index of the opening paren of the param list in the source scanned. */
  parenOpen: number
  /** Absolute index of the matching closing paren. */
  parenClose: number
}

/**
 * Parse `entry`'s signature out of a definition source (`function entry(…)` or
 * `const entry = (…) =>`). Null when it can't be located or parsed — callers must
 * treat null as "unknown signature" and stay conservative, never guess.
 */
export function parseSignature(def: string, entry: string): Signature | null {
  const e = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m =
    new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${e}\\s*\\(`).exec(def) ??
    new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${e}\\s*=\\s*(?:async\\s*)?\\(`).exec(def)
  if (!m) return null
  const parenOpen = m.index + m[0].length - 1
  const parenClose = matchParen(def, parenOpen)
  if (parenClose === -1) return null

  const params: ParamInfo[] = []
  for (const text of splitTopLevel(def.slice(parenOpen + 1, parenClose))) {
    const t = text.trim()
    if (!t) continue
    const rest = t.startsWith('...')
    const nameM = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(t)
    params.push({
      name: nameM ? nameM[1] : null,
      text: t,
      hasType: hasTopLevelColon(t),
      optional: /^(?:\.\.\.)?[A-Za-z_$][\w$]*\s*\?/.test(t) || hasTopLevelEquals(t),
      rest,
    })
  }

  // Return type: a top-level `:` right after the close paren, up to `{` (function body)
  // or `=>` (arrow), scanned at bracket depth 0.
  let returnType: string | null = null
  let i = parenClose + 1
  while (i < def.length && /\s/.test(def[i])) i++
  if (def[i] === ':') {
    let depth = 0
    for (let j = i + 1; j < def.length; j++) {
      const c = def[j]
      if (c === '(' || c === '[' || c === '{') {
        if (c === '{' && depth === 0) { returnType = def.slice(i + 1, j).trim(); break }
        depth++
      } else if (c === ')' || c === ']' || c === '}') depth--
      else if (c === '=' && def[j + 1] === '>' && depth === 0) { returnType = def.slice(i + 1, j).trim(); break }
    }
    // Guard against `{` belonging to an object return type: if what we captured is empty, bail.
    if (returnType === '') returnType = null
  }
  return { params, returnType, parenOpen, parenClose }
}

/** Index of the `)` matching def[open] (which must be `(`), or -1. String/comment aware. */
function matchParen(content: string, open: number): number {
  let depth = 0
  for (let i = open; i < content.length; i++) {
    const c = content[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(content, i); if (i === -1) return -1; continue }
    if (c === '/' && content[i + 1] === '/') { i = content.indexOf('\n', i); if (i === -1) return -1; continue }
    if (c === '/' && content[i + 1] === '*') { i = content.indexOf('*/', i); if (i === -1) return -1; i++; continue }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0 && c === ')') return i }
  }
  return -1
}

/** Split `s` at commas that sit at bracket depth 0 (outside strings). */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') { i = skipString(s, i); if (i === -1) return [s]; continue }
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1 }
  }
  out.push(s.slice(start))
  return out
}

function hasTopLevelColon(param: string): boolean {
  let depth = 0
  for (let i = 0; i < param.length; i++) {
    const c = param[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (c === ':' && depth === 0) return true
    else if (c === '=' && depth === 0) return false // default value starts — any later `:` is inside it
  }
  return false
}

function hasTopLevelEquals(param: string): boolean {
  let depth = 0
  for (let i = 0; i < param.length; i++) {
    const c = param[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (c === '=' && param[i + 1] !== '>' && depth === 0) return true
  }
  return false
}

/**
 * Graft the ORIGINAL definition's type annotations onto untyped certified code, positionally.
 * Only fires when both signatures parse and arity matches — the certified code was verified
 * by execution against the same examples, so same-position params carry the same types.
 * Best-effort: any doubt returns `code` unchanged (the compile gate still runs downstream).
 */
export function graftAnnotations(code: string, original: string, entry: string): string {
  const newSig = parseSignature(code, entry)
  const oldSig = parseSignature(original, entry)
  if (!newSig || !oldSig || newSig.params.length !== oldSig.params.length) return code

  let out = code
  // Rewrite params right-to-left so earlier indices stay valid.
  const pieces = newSig.params.map((p, i) => {
    const o = oldSig.params[i]
    if (p.hasType || !o.hasType || !p.name || p.rest !== o.rest) return p.text
    const colon = topLevelColonIndex(o.text)
    const oType = colon === -1 ? null : stripDefault(o.text.slice(colon + 1))
    if (!oType) return p.text
    const eq = hasTopLevelEquals(p.text) ? p.text.search(/=(?!>)/) : -1
    return eq === -1
      ? `${p.text.trimEnd()}: ${oType}`
      : `${p.text.slice(0, eq).trimEnd()}: ${oType} ${p.text.slice(eq)}`
  })
  out = out.slice(0, newSig.parenOpen + 1) + pieces.join(', ') + out.slice(newSig.parenClose)

  if (!newSig.returnType && oldSig.returnType) {
    // Re-locate the (possibly shifted) close paren and insert the return annotation.
    const reSig = parseSignature(out, entry)
    if (reSig) out = out.slice(0, reSig.parenClose + 1) + `: ${oldSig.returnType}` + out.slice(reSig.parenClose + 1)
  }
  return out
}

function topLevelColonIndex(param: string): number {
  let depth = 0
  for (let i = 0; i < param.length; i++) {
    const c = param[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (c === ':' && depth === 0) return i
    else if (c === '=' && depth === 0) return -1
  }
  return -1
}

/** Drop a trailing ` = default` from an annotation slice, keeping just the type text. */
function stripDefault(typeText: string): string {
  let depth = 0
  for (let i = 0; i < typeText.length; i++) {
    const c = typeText[i]
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++
    else if (c === ')' || c === ']' || c === '}' || c === '>') depth--
    else if (c === '=' && typeText[i + 1] !== '>' && depth === 0) return typeText.slice(0, i).trim()
  }
  return typeText.trim()
}

// ─── Call-site safety on signature change ──────────────────────────────────────

interface CallSite { open: number; close: number; args: string[] }

/** All `entry(…)` call sites in `content` OUTSIDE [defStart, defEnd) — the definition's own
 * recursion already matches the new signature. Skips property access (`x.entry(`) and
 * declarations (`function entry(`). */
export function findCallSites(content: string, entry: string, defStart: number, defEnd: number): CallSite[] {
  const e = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`\\b${e}\\s*\\(`, 'g')
  const sites: CallSite[] = []
  let m: RegExpExecArray | null
  while ((m = rx.exec(content))) {
    const at = m.index
    if (at >= defStart && at < defEnd) continue
    const before = content.slice(0, at)
    if (/[.\w$]$/.test(before)) continue                       // x.entry( / myentry(
    if (/(?:function|const|let|var)\s+$/.test(before)) continue // a declaration, not a call
    const open = at + m[0].length - 1
    const close = matchParen(content, open)
    if (close === -1) continue
    const inner = content.slice(open + 1, close)
    sites.push({ open, close, args: inner.trim() === '' ? [] : splitTopLevel(inner).map(s => s.trim()) })
  }
  return sites
}

/**
 * Given the file AFTER the definition splice, verify existing call sites still fit the new
 * signature — and mechanically repair the one safe case (trailing params removed → trim
 * extra args). Returns the (possibly rewritten) content, or null when a call site would
 * break and no safe repair exists — the caller downgrades to a fresh file, never ships a
 * silently broken call (esbuild's transform gate parses but does NOT typecheck arity).
 */
export function reconcileCallSites(
  content: string, entry: string, defStart: number, defEnd: number,
  newSig: Signature | null, oldSig: Signature | null,
): { content: string; repaired: number } | null {
  const sites = findCallSites(content, entry, defStart, defEnd)
  if (!sites.length) return { content, repaired: 0 }
  if (!newSig) return null // signature unknown → can't vouch for call sites

  const hasRest = newSig.params.some(p => p.rest)
  const required = newSig.params.filter(p => !p.optional && !p.rest).length
  const total = newSig.params.length
  const fits = (n: number) => n >= required && (hasRest || n <= total)

  if (sites.every(s => fits(s.args.length))) return { content, repaired: 0 }

  // Safe mechanical repair: the new params are a positional prefix of the old ones
  // (trailing params dropped) → trim each call to the new arity.
  const oldNames = oldSig?.params.map(p => p.name)
  const newNames = newSig.params.map(p => p.name)
  const isPrefix = !!oldNames && !hasRest && newNames.length < oldNames.length &&
    newNames.every((n, i) => n !== null && n === oldNames[i])
  if (!isPrefix) return null

  let out = content
  let repaired = 0
  for (const s of [...sites].sort((a, b) => b.open - a.open)) {
    if (fits(s.args.length)) continue
    if (s.args.length < total) return null // too few args even for the new signature
    out = out.slice(0, s.open + 1) + s.args.slice(0, total).join(', ') + out.slice(s.close)
    repaired++
  }
  return { content: out, repaired }
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

// ─── Multi-file merge (modify inside multi-file requests) ─────────────────────

/** Top-level declaration names in a module source (exported or not), first-seen order. */
export function topLevelDeclarations(source: string): string[] {
  const rx = /^[ \t]*(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/gm
  const seen = new Set<string>()
  for (let m; (m = rx.exec(source)); ) seen.add(m[1] ?? m[2])
  return [...seen]
}

const IMPORT_LINE_RX = /^import\s[^\n]*$/gm
const NAMED_IMPORT_RX = /^import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?\s*$/

/**
 * Merge a CERTIFIED module source into an EXISTING file at the same path: existing
 * declarations with the same name are spliced in place (annotations grafted, call sites
 * reconciled), new ones are appended, and the certified file's imports are unioned in.
 * Only valid for modify-shaped requests — the caller gates on isModifyRequest.
 * Returns null (with a reason) on ANY doubt; callers must then refuse the whole write,
 * never merge half a file. The merged content still needs the caller's compile/execution
 * re-verification — this function is structural, not behavioral.
 */
export function mergeCertifiedSource(
  existing: string,
  certified: string,
): { content: string; spliced: string[]; appended: string[]; callSitesRepaired: number } | null {
  let merged = existing

  // 1) Imports: union the certified file's imports into the existing file.
  const certImports = certified.match(IMPORT_LINE_RX) ?? []
  const body = certified.replace(IMPORT_LINE_RX, '').trim()
  for (const line of certImports) {
    const nm = NAMED_IMPORT_RX.exec(line.trim())
    if (!nm) return null // non-named import form — too ambiguous to merge safely
    const [, names, , spec] = nm
    const specRx = new RegExp(`^import\\s[^\\n]*from\\s*['"]${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'm')
    const existingLineM = specRx.exec(merged)
    if (!existingLineM) { merged = line.trimEnd() + '\n' + merged; continue }
    const fullLine = merged.slice(existingLineM.index).split('\n')[0]
    const em = NAMED_IMPORT_RX.exec(fullLine.trim())
    if (!em) return null // same specifier, non-named existing import — bail
    const union = [...new Set([...em[1].split(','), ...names.split(',')].map(s => s.trim()).filter(Boolean))]
    merged = merged.replace(fullLine, `import { ${union.join(', ')} } from '${spec}'`)
  }

  // 2) Each top-level declaration: splice over a same-named existing one, else append.
  const spliced: string[] = []
  const appended: string[] = []
  let callSitesRepaired = 0
  for (const name of topLevelDeclarations(body)) {
    const certSpan = extractFunctionSpan(body, name)
    if (!certSpan) return null // can't isolate the certified declaration — no blind copy
    const certDef = body.slice(certSpan.start, certSpan.end).trim()
    const oldSpan = extractFunctionSpan(merged, name)
    if (oldSpan) {
      const original = merged.slice(oldSpan.start, oldSpan.end)
      const grafted = graftAnnotations(certDef, original, name)
      const replaced = merged.slice(0, oldSpan.start) + grafted + merged.slice(oldSpan.end)
      const rec = reconcileCallSites(
        replaced, name, oldSpan.start, oldSpan.start + grafted.length,
        parseSignature(grafted, name), parseSignature(original, name),
      )
      if (!rec) return null // a call site can't absorb the new signature
      merged = rec.content
      callSitesRepaired += rec.repaired
      spliced.push(name)
    } else if (alreadyDefines(merged, name)) {
      return null // defined in a shape we can't locate (e.g. re-export) — no duplicate risk
    } else {
      merged = merged.replace(/\s*$/, '') + '\n\n' + certDef + '\n'
      appended.push(name)
    }
  }
  return { content: merged, spliced, appended, callSitesRepaired }
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
        const original = existing.slice(span.start, span.end)
        const oldSig = parseSignature(original, entry)
        // Keep the file's type annotations: graft the original's param/return types onto
        // untyped certified code (positional, arity-equal only — best-effort).
        const spliced = graftAnnotations(code.trim(), original, entry)
        const newSig = parseSignature(spliced, entry)
        const replaced = existing.slice(0, span.start) + spliced + existing.slice(span.end)
        // If the signature changed, existing call sites must still fit (esbuild won't
        // catch arity breaks) — trim trailing args when that's mechanically safe.
        const reconciled = reconcileCallSites(replaced, entry, span.start, span.start + spliced.length, newSig, oldSig)
        if (!reconciled) {
          return fresh(`certified ${entry} changes its signature in a way existing call sites in ${targetPath} can't absorb → new file instead (existing file left untouched)`)
        }
        try {
          await transform(reconciled.content, { loader: 'ts', format: 'esm', target: 'node18' })
          const extra = reconciled.repaired ? `; updated ${reconciled.repaired} call site(s) for the new signature` : ''
          return { rel: targetPath, content: reconciled.content, mode: 'modify', detail: `replaced ${entry} in ${targetPath} with the certified implementation (full file recompiles${extra})` }
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

// ─── Whole-tree signature propagation ──────────────────────────────────────────
//
// planEmit reconciles call sites INSIDE the modified file. But a signature change to an
// exported function also breaks call sites in OTHER files that import it. This layer scans
// sibling modules, repairs the mechanically-safe cases (trailing-param trim), and — crucially
// — refuses the WHOLE edit when any importer can't absorb the change. Whole-tree is
// all-or-nothing: we never ship a modify that knowingly breaks a caller elsewhere in the repo.

/** Two signatures accept the same set of call arities (added/removed OPTIONAL or rest params
 * that don't shift what existing positional calls need). When true, existing call sites in any
 * file remain valid and no propagation is needed. */
export function signaturesCallCompatible(a: Signature | null, b: Signature | null): boolean {
  if (!a || !b) return false
  const req = (s: Signature) => s.params.filter(p => !p.optional && !p.rest).length
  const rest = (s: Signature) => s.params.some(p => p.rest)
  return req(a) === req(b) && a.params.length === b.params.length && rest(a) === rest(b)
}

/** Resolve a relative import specifier (from `fromRel`'s directory) to a project-relative
 * module path with no extension, for comparison against a target file. Returns null for
 * bare/package specifiers (no leading `.`). */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : ''
  const parts = (fromDir ? fromDir.split('/') : []).concat(spec.split('/'))
  const stack: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') stack.pop()
    else stack.push(p)
  }
  return stack.join('/').replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
}

/** Local names under which `entry` is imported from `targetRel` in `content` — resolving aliases,
 *  so `import { pad as p } from './pad'` yields `['p']` (the name the call sites actually use).
 *  Empty when `entry` is not imported from that module. Named imports only. */
export function importedLocalNames(content: string, entry: string, siblingRel: string, targetRel: string): string[] {
  const targetNoExt = targetRel.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
  const out: string[] = []
  let m: RegExpExecArray | null
  const rx = new RegExp(NAMED_IMPORT_RX.source, 'gm')
  while ((m = rx.exec(content))) {
    if (resolveSpecifier(siblingRel, m[3]) !== targetNoExt) continue
    for (const raw of m[1].split(',')) {
      const [orig, alias] = raw.trim().split(/\s+as\s+/).map(s => s.trim())
      const local = alias || orig
      if (orig === entry && local) out.push(local)
    }
  }
  return out
}

/** True when `content` (a sibling module at `siblingRel`) imports `entry` from `targetRel`. */
export function importsEntryFrom(content: string, entry: string, siblingRel: string, targetRel: string): boolean {
  return importedLocalNames(content, entry, siblingRel, targetRel).length > 0
}

export interface TreeEmit {
  /** The plan for the primary target file (possibly downgraded to a fresh file). */
  primary: EmitPlan
  /** Edits to sibling files whose call sites were repaired for the new signature. */
  propagated: EmitPlan[]
  notes: string[]
}

/**
 * Extend a single-file emit to the whole tree. `siblings` maps project-relative paths (EXCLUDING
 * the primary target) to their current contents. When the primary is a signature-changing modify,
 * every sibling that imports `entry` from the target is checked: safe cases are repaired and
 * emitted, and if ANY sibling can't absorb the change the entire edit downgrades to a fresh file
 * (all existing files left untouched). The caller still compile/execution-re-verifies each write.
 */
export async function planEmitTree(
  nl: string, entry: string, code: string, existing: string | null,
  targetPath: string | null = detectTargetPath(nl),
  siblings: Record<string, string> = {},
): Promise<TreeEmit> {
  const primary = await planEmit(nl, entry, code, existing, targetPath)
  const notes: string[] = []

  // Propagation only applies when we replaced an existing definition in a real target file.
  if (primary.mode !== 'modify' || existing == null || !targetPath) return { primary, propagated: [], notes }

  const oldSpan = extractFunctionSpan(existing, entry)
  const newSpan = extractFunctionSpan(primary.content, entry)
  const oldSig = oldSpan ? parseSignature(existing.slice(oldSpan.start, oldSpan.end), entry) : null
  const newSig = newSpan ? parseSignature(primary.content.slice(newSpan.start, newSpan.end), entry) : null

  // Signature unchanged (in a call-affecting way) → existing importers stay valid.
  if (signaturesCallCompatible(oldSig, newSig)) return { primary, propagated: [], notes }

  const fresh: EmitPlan = {
    rel: `src/${entry}.ts`, content: code, mode: 'create',
    detail: `certified ${entry} changes its signature in a way an importer of ${targetPath} can't absorb → new file instead (all existing files left untouched)`,
  }

  const propagated: EmitPlan[] = []
  for (const [rel, content] of Object.entries(siblings)) {
    if (rel === targetPath) continue
    const locals = importedLocalNames(content, entry, rel, targetPath)
    if (!locals.length) continue
    if (alreadyDefines(content, entry)) return { primary: fresh, propagated: [], notes: [`${rel} both imports and shadows ${entry} — too ambiguous to reconcile`] }

    // Reconcile the call sites under EACH local (possibly aliased) name the importer uses —
    // `import { pad as p }` means the calls read `p(…)`, not `pad(…)`. No local definition
    // exists here, so scan across the whole file (defStart/defEnd out of range).
    let repairedContent = content
    let repairedTotal = 0
    for (const local of locals) {
      const rec = reconcileCallSites(repairedContent, local, -1, -1, newSig, oldSig)
      if (!rec) return { primary: fresh, propagated: [], notes: [`${rel} calls ${entry} in a way the new signature can't absorb → refused the whole edit`] }
      repairedContent = rec.content
      repairedTotal += rec.repaired
    }
    if (repairedTotal === 0) continue // all call sites already fit
    try {
      await transform(repairedContent, { loader: 'ts', format: 'esm', target: 'node18' })
    } catch {
      return { primary: fresh, propagated: [], notes: [`repairing ${rel}'s calls to ${entry} would not compile → refused the whole edit`] }
    }
    propagated.push({ rel, content: repairedContent, mode: 'modify', detail: `updated ${repairedTotal} call site(s) of ${entry} for its new signature` })
    notes.push(`${rel}: ${repairedTotal} call site(s) reconciled`)
  }

  return { primary, propagated, notes }
}
