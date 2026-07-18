// Domain-specific verifiers — close the verify loop against reality per prompt type.
// Each verifier takes the synthesis and original question, returns a verdict.
// Called from Stage 5b before polish. Falls through silently on any failure.

export interface VerifyResult {
  passed: boolean
  issues: string[]   // human-readable problems found
  confidence: number // 0–1 how sure we are about the verdict
}

// ── Math verifier — extract numeric claims and check them symbolically ────────
// Uses JS arithmetic for simple expressions; catches the most common errors.
//
// A claim is one "EXPR = NUMBER" shape. We keep enough positional info (the matched
// number's offset/raw text) that the deterministic corrector below can splice the
// computed value back into the original prose without reconstructing surrounding text.
interface NumericClaim {
  expr: string        // left side, e.g. "47 × 53"
  claimed: number     // right side parsed to a number (commas stripped)
  numStart: number    // index in `text` where the claimed-number token begins
  numRaw: string      // the claimed-number token exactly as it appears (e.g. "2,591")
}
function extractNumericClaims(text: string): NumericClaim[] {
  const results: NumericClaim[] = []
  // Match patterns like "3x + 5 = 14 so x = 3" or "17 × 23 = 391" or "47 * 53 = 2,491".
  // Right side allows thousands-separator commas (stripped before parsing) — without this,
  // "2,491" parsed as claimed=2 and false-flagged every comma-formatted correct answer.
  // LHS may carry currency symbols, thousands commas, and space-bounded unit words
  // ("3 shirts * $23 per shirt") — normalizeExpr() strips those and rejects anything
  // ambiguous, so a broad capture here is safe (non-arithmetic spans fall to null).
  // RHS allows an optional leading currency symbol ("= $72") that is NOT part of numRaw,
  // so the splice replaces only the number and preserves the "$".
  const eqPattern = /(\d[\d\s×·\*\+\-\/\.\^x$,a-zA-Z]*?)\s*=\s*[\$£€]?\s*(-?\d[\d,]*(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = eqPattern.exec(text)) !== null) {
    const numRaw = m[2]
    const claimed = parseFloat(numRaw.replace(/,/g, ''))
    if (isNaN(claimed)) continue
    // The broadened capture can swallow prose ("...subtract 2026 from 2007.\n\n2007 - 2026")
    // because letters/newlines are now allowed. Reduce to the arithmetic clause immediately
    // left of the '=': the longest right-anchored token-substring that cleanly evaluates.
    // Without this, a paragraph-length LHS fails normalizeExpr and the real equation next
    // to '=' is never checked.
    const expr = rightArithClause(m[1])
    if (!expr) continue
    // Group 2 sits at the end of the full match → its start is match-end minus its length.
    const numStart = m.index + m[0].length - numRaw.length
    results.push({ expr, claimed, numStart, numRaw })
  }
  return results.slice(0, 10)
}

// Deterministically evaluate a pure-arithmetic expression. Normalizes the unicode
// multiplication glyphs (× ·) to * and ^ to ** BEFORE the whitelist — otherwise the
// most common multiplication rendering ("47 × 53") fails the whitelist and never checks.
// Returns null for anything that isn't cleanly evaluable (e.g. contains a variable `x`,
// a factorial `!`, π, √) so callers can "leave as-is, don't guess".
// Reduce a captured LHS to a pure arithmetic string, or null if it isn't cleanly one.
// Strips currency/commas and standalone unit words ("3 shirts * $23 per shirt" → "3 * 23"),
// but REFUSES when a letter is glued to a digit (algebra "3x", ordinals "23rd", units "5kg")
// or when two numbers end up adjacent with no operator between them — both are ambiguous,
// so the caller leaves the prose untouched rather than guess.
function normalizeExpr(expr: string): string | null {
  const g = expr.replace(/×/g, '*').replace(/·/g, '*').replace(/\^/g, '**')
  // A letter touching a digit means the token isn't a bare number — bail (protects algebra).
  if (/\d[a-zA-Z]|[a-zA-Z]\d/.test(g)) return null
  const stripped = g
    .replace(/[a-zA-Z]+/g, ' ')  // space-bounded unit words → space
    .replace(/[$£€,]/g, '')       // currency + thousands separators
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped || !/[+\-*/]/.test(stripped)) return null // need a real operator
  if (/\d\s+\d/.test(stripped)) return null               // two numbers, no operator → ambiguous
  return stripped
}
function tryEval(expr: string): number | null {
  try {
    const cleaned = normalizeExpr(expr)
    if (cleaned === null) return null
    // Safe eval: only digits, operators, parens, spaces (note: * covers the ** from ^).
    if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(cleaned)) return null
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${cleaned})`)()
    return typeof result === 'number' && isFinite(result) ? result : null
  } catch { return null }
}

// Longest right-anchored substring of a (possibly prose-laden) LHS that tryEval accepts.
// Tokenizes on whitespace and drops leading tokens until the remainder cleanly evaluates,
// so we keep only the arithmetic clause adjacent to '=' and never merge unrelated numbers
// from earlier in the sentence. Returns '' when no suffix is evaluable.
function rightArithClause(lhs: string): string {
  const toks = lhs.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < toks.length; i++) {
    const cand = toks.slice(i).join(' ')
    if (tryEval(cand) !== null) return cand
  }
  return ''
}

// Format a computed number for splicing back into prose: plain integer where exact,
// otherwise trimmed to at most 6 decimals. Never produces a "(corrected: …)" string.
function fmtNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(parseFloat(n.toFixed(6)))
}

export function verifyMath(synthesis: string, _question: string): VerifyResult {
  const claims = extractNumericClaims(synthesis)
  const issues: string[] = []
  let checked = 0
  for (const { expr, claimed } of claims) {
    const actual = tryEval(expr)
    if (actual === null) continue
    checked++
    if (Math.abs(actual - claimed) > 0.01) {
      issues.push(`"${expr} = ${claimed}" is incorrect (actual: ${actual})`)
    }
  }
  return {
    passed: issues.length === 0,
    issues,
    confidence: checked > 0 ? 0.8 : 0.2,
  }
}

// ── Deterministic arithmetic corrector (ZERO inference) ───────────────────────
// For each "EXPR = NUMBER" claim where EXPR is cleanly evaluable and the stated NUMBER
// is wrong, splice the computed value into the text in place of the stated token. Leaves
// non-evaluable claims (variables, factorials, π/√, ranges) untouched — never guesses.
// Replacements are applied right-to-left so earlier offsets stay valid.
export interface ArithmeticCorrection { expr: string; was: string; now: string }
export function correctArithmetic(text: string): { text: string; corrections: ArithmeticCorrection[] } {
  const claims = extractNumericClaims(text)
  const fixes: Array<{ start: number; len: number; now: string; corr: ArithmeticCorrection }> = []
  for (const c of claims) {
    const actual = tryEval(c.expr)
    if (actual === null) continue
    if (Math.abs(actual - c.claimed) <= 0.01) continue // already correct
    const now = fmtNumber(actual)
    fixes.push({ start: c.numStart, len: c.numRaw.length, now, corr: { expr: c.expr, was: c.numRaw, now } })
  }
  if (!fixes.length) return { text, corrections: [] }
  let out = text
  for (const f of fixes.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + f.now + out.slice(f.start + f.len)
  }
  return { text: out, corrections: fixes.map(f => f.corr) }
}

// ── Value-propagation cascade (ZERO inference) ────────────────────────────────
// The single-pass corrector fixes each STATED equation in isolation, but the FM's
// wrong intermediate value cascades: "3 * $23 = $72" gets fixed to $69, yet a later
// "$100 - $72 = $28" is INTERNALLY consistent (100-72 really is 28) so the base pass
// leaves the stale 72 — and the wrong 28 — untouched. This pass propagates a corrected
// result forward: when a value V is corrected to W, any LATER occurrence of V sitting
// directly against an arithmetic operator (an operand, not a bare "72 apples") is
// rewritten to W, and the equation it feeds is re-evaluated. Operator-adjacency is the
// safety scope — it confines substitution to computation chains and refuses free-floating
// number reuse. Iterated to a fixpoint (capped) so multi-step chains fully settle.
function escapeNum(n: string): string {
  return n.replace(/[.]/g, '\\.')
}
function propagateStaleValues(text: string, staleMap: Map<string, string>): string {
  let out = text
  for (const [was, now] of staleMap) {
    if (was === now) continue
    const w = escapeNum(was)
    // operator (optionally currency/space) then the stale operand — e.g. "- $72"
    out = out.replace(new RegExp(`([-+*/×·]\\s*[\\$£€]?\\s*)${w}(?![\\d.,])`, 'g'), `$1${now}`)
    // the stale operand then an operator — e.g. "72 -"
    out = out.replace(new RegExp(`(?<![\\d.,])${w}(\\s*[-+*/×·])`, 'g'), `${now}$1`)
  }
  return out
}
export function correctArithmeticCascade(text: string): { text: string; corrections: ArithmeticCorrection[] } {
  let out = text
  const all: ArithmeticCorrection[] = []
  for (let iter = 0; iter < 6; iter++) {
    const { text: fixed, corrections } = correctArithmetic(out)
    let next = fixed
    let changed = fixed !== out
    if (corrections.length) {
      all.push(...corrections)
      const staleMap = new Map<string, string>()
      for (const c of corrections) {
        const wasCanon = c.was.replace(/,/g, '')
        if (wasCanon !== c.now) staleMap.set(wasCanon, c.now)
      }
      const propagated = propagateStaleValues(fixed, staleMap)
      if (propagated !== fixed) { next = propagated; changed = true }
    }
    out = next
    if (!changed) break
  }
  // De-dup identical corrections (same expr/was/now) accumulated across iterations.
  const seen = new Set<string>()
  const corrections = all.filter(c => {
    const k = `${c.expr}|${c.was}|${c.now}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return { text: out, corrections }
}

// ── Factual verifier — cross-reference key claims against search ──────────────
// Extracts entity+claim pairs, searches DuckDuckGo, flags contradictions.
// Lightweight — only fires on high-stakes factual questions.
function extractClaims(synthesis: string): string[] {
  // Extract sentences with assertive verbs about named things
  const sentences = synthesis.match(/[A-Z][^.!?]*(?:is|are|was|were|has|have|means|stands for|refers to)[^.!?]*[.!?]/g) ?? []
  return sentences.slice(0, 3).map(s => s.trim())
}

export async function verifyFactual(synthesis: string, question: string): Promise<VerifyResult> {
  const claims = extractClaims(synthesis)
  if (!claims.length) return { passed: true, issues: [], confidence: 0.1 }

  const issues: string[] = []
  // For now: check if synthesis mentions key terms from the question
  // Full search cross-reference requires the web_search tool — this is the structural hook
  const qTerms = question.toLowerCase().split(/\s+/).filter(w => w.length > 4)
  const synthLower = synthesis.toLowerCase()
  const mentionedTerms = qTerms.filter(t => synthLower.includes(t))
  const coverage = qTerms.length > 0 ? mentionedTerms.length / qTerms.length : 1

  if (coverage < 0.4) {
    issues.push(`Synthesis may not address the question — only ${Math.round(coverage * 100)}% of key terms covered`)
  }

  return { passed: issues.length === 0, issues, confidence: 0.4 }
}

// ── Consistency verifier — internal consistency check (creative/reasoning) ────
// Checks for contradictions within the synthesis itself.
function findContradictions(text: string): string[] {
  const issues: string[] = []
  const lower = text.toLowerCase()

  // Check for numeric contradictions (same variable assigned two values)
  const assignments: Record<string, number> = {}
  const assignPattern = /\b([a-z])\s*=\s*(\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = assignPattern.exec(lower)) !== null) {
    const [, varName, val] = m
    const num = parseFloat(val)
    if (assignments[varName] !== undefined && Math.abs(assignments[varName] - num) > 0.01) {
      issues.push(`Variable "${varName}" assigned both ${assignments[varName]} and ${num}`)
    }
    assignments[varName] = num
  }

  // Check for obvious logical contradictions
  const contradictionPairs = [
    ['always', 'never'], ['all', 'none'], ['true', 'false'],
    ['increases', 'decreases'], ['faster', 'slower'],
  ]
  for (const [a, b] of contradictionPairs) {
    if (lower.includes(` ${a} `) && lower.includes(` ${b} `)) {
      // Only flag if they appear close together (within 200 chars)
      const ai = lower.indexOf(` ${a} `), bi = lower.indexOf(` ${b} `)
      if (Math.abs(ai - bi) < 200) {
        issues.push(`Potential contradiction: both "${a}" and "${b}" used in close proximity`)
      }
    }
  }
  return issues
}

export function verifyConsistency(synthesis: string, _question: string): VerifyResult {
  const issues = findContradictions(synthesis)
  return { passed: issues.length === 0, issues, confidence: issues.length > 0 ? 0.6 : 0.3 }
}

// ── Router — pick the right verifier for the prompt type ─────────────────────
export async function domainVerify(
  promptType: string,
  synthesis: string,
  question: string
): Promise<VerifyResult> {
  try {
    switch (promptType) {
      case 'math':
        return verifyMath(synthesis, question)
      case 'factual':
        return await verifyFactual(synthesis, question)
      case 'reasoning':
      case 'creative':
        return verifyConsistency(synthesis, question)
      default:
        return { passed: true, issues: [], confidence: 0 }
    }
  } catch {
    return { passed: true, issues: [], confidence: 0 }
  }
}

// ── Code-block syntax verifier ────────────────────────────────────────────────
// Repro (2026-07-07 trust audit): the offline chat brain shipped Python with a bare
// comma where `and` was needed — a SyntaxError on first run — presented as working
// code. "Wrote code" is not "wrote working code": before any chat answer containing
// fenced code ships, syntax-check every Python/JS block. Zero model inference here;
// Python via `python3 -c ast.parse(stdin)`, JS via vm.Script compile. Semantic bugs
// are out of scope — this gate is specifically "would it even parse".
import { spawnSync } from 'child_process'
import vmMod from 'vm'
import ts from 'typescript'

export interface CodeBlockProblem {
  lang: string
  error: string
  /** offsets of the fenced block (``` to ```) in the original text */
  start: number
  end: number
  code: string
}

// Semantic TS errors that are runtime-fatal AND input-independent AND not lib/env-dependent, so
// flagging them can never false-reject a legitimate snippet. Keep this set TINY and conservative:
//   TS2588 — assign to a `const`  (throws "Assignment to constant variable" at runtime)
//   TS2451 — redeclare a block-scoped variable  (a hard binding conflict)
// Do NOT add "cannot find name / module / type" (2304/2307/2503/2552) — those fire on any snippet
// that legitimately references something declared elsewhere, which is the exact false-reject class
// the syntactic-only filter was designed to avoid.
const FATAL_TS_CODES = new Set([2588, 2451])
function semanticFatalTs(code: string): string | null {
  try {
    const opts: import('typescript').CompilerOptions = {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      strict: false, noLib: true, skipLibCheck: true, types: [], noEmit: true,
    }
    const fname = '__answer__.ts'
    const host = ts.createCompilerHost(opts)
    const src = ts.createSourceFile(fname, code, ts.ScriptTarget.ES2020, true)
    const orig = host.getSourceFile.bind(host)
    host.getSourceFile = (f, ...r) => (f === fname ? src : orig(f, ...r))
    host.writeFile = () => {}
    const prog = ts.createProgram([fname], opts, host)
    const hit = ts.getPreEmitDiagnostics(prog).find(
      d => d.category === ts.DiagnosticCategory.Error && FATAL_TS_CODES.has(d.code),
    )
    return hit ? `TS${hit.code}: ${ts.flattenDiagnosticMessageText(hit.messageText, '\n').slice(0, 180)}` : null
  } catch { return null /* checker failure must never block an answer */ }
}

export function verifyCodeBlocks(text: string): CodeBlockProblem[] {
  const problems: CodeBlockProblem[] = []
  const fenceRe = /```(\w*)\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) {
    const lang = (m[1] || '').toLowerCase()
    const code = m[2]
    if (!code.trim()) continue
    let error: string | null = null
    if (lang === 'python' || lang === 'py') {
      try {
        const r = spawnSync('python3', ['-c', 'import sys,ast; ast.parse(sys.stdin.read())'],
          { input: code, timeout: 5000, encoding: 'utf8' })
        if (r.status !== 0) {
          const line = (r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] ?? 'SyntaxError'
          error = line.trim().slice(0, 200)
        }
      } catch { /* python missing / timeout — do not block the answer */ }
    } else if (lang === 'javascript' || lang === 'js') {
      try { new vmMod.Script(code) } catch (e: any) {
        error = `SyntaxError: ${String(e?.message ?? e).slice(0, 200)}`
      }
    } else if (lang === 'typescript' || lang === 'ts' || lang === 'tsx') {
      // TS can't go through vm.Script (types, generics, `import` are all syntax errors to a JS
      // parser) — transpile it and read the compiler's own diagnostics instead. But keep ONLY the
      // SYNTACTIC ones (category Error, code 1000–1999): those are input-independent "this does not
      // parse" defects (e.g. `this.head: T = null` inside a constructor → TS1005). Semantic/type
      // errors (2xxx: unknown types, type mismatches) are deliberately NOT flagged — strict:false
      // ignores them, they need the full lib graph to judge, and rejecting on them false-rejects
      // valid snippets that reference types declared elsewhere. Measured: the 1xxx filter fires on
      // broken syntax and stays silent on type-error-only / undeclared-type / valid code.
      try {
        const out = ts.transpileModule(code, {
          compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, strict: false, jsx: ts.JsxEmit.Preserve },
          reportDiagnostics: true,
        })
        const syntactic = (out.diagnostics ?? []).filter(
          d => d.category === ts.DiagnosticCategory.Error && d.code >= 1000 && d.code < 2000,
        )
        if (syntactic.length) {
          const first = syntactic[0]
          error = `TS${first.code}: ${ts.flattenDiagnosticMessageText(first.messageText, '\n').slice(0, 180)}`
        } else {
          // Parses fine — now catch the narrow set of SEMANTIC errors that are BOTH runtime-fatal
          // AND input-independent AND never a lib/env artifact. A live linked-list answer parsed
          // cleanly but reassigned a `const` (TS2588 → throws "Assignment to constant variable" the
          // first time push() walks the list). The syntactic filter above can't see it. This uses a
          // real type-check Program, but the safety comes from three constraints: `noLib:true` +
          // `types:[]` remove the whole class of lib-collision false positives (measured: a user
          // `Node` class no longer collides with DOM.Node), and the whitelist admits ONLY codes that
          // are definitively broken regardless of surrounding context. Nothing here rejects a snippet
          // for referencing a type/global it declares elsewhere — those codes are deliberately absent.
          const semantic = semanticFatalTs(code)
          if (semantic) error = semantic
        }
      } catch (e: any) {
        error = `SyntaxError: ${String(e?.message ?? e).slice(0, 200)}`
      }
    }
    if (error) problems.push({ lang, error, start: m.index, end: m.index + m[0].length, code })
  }
  return problems
}
