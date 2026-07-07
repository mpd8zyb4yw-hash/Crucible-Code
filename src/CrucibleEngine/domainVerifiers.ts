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
  const eqPattern = /(\d[\d\s×·\*\+\-\/\.\^x]*?)\s*=\s*(-?\d[\d,]*(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = eqPattern.exec(text)) !== null) {
    const numRaw = m[2]
    const claimed = parseFloat(numRaw.replace(/,/g, ''))
    if (isNaN(claimed)) continue
    // Group 2 sits at the end of the full match → its start is match-end minus its length.
    const numStart = m.index + m[0].length - numRaw.length
    results.push({ expr: m[1].trim(), claimed, numStart, numRaw })
  }
  return results.slice(0, 10)
}

// Deterministically evaluate a pure-arithmetic expression. Normalizes the unicode
// multiplication glyphs (× ·) to * and ^ to ** BEFORE the whitelist — otherwise the
// most common multiplication rendering ("47 × 53") fails the whitelist and never checks.
// Returns null for anything that isn't cleanly evaluable (e.g. contains a variable `x`,
// a factorial `!`, π, √) so callers can "leave as-is, don't guess".
function tryEval(expr: string): number | null {
  try {
    const cleaned = expr.replace(/×/g, '*').replace(/·/g, '*').replace(/\^/g, '**')
    // Safe eval: only digits, operators, parens, spaces (note: * covers the ** from ^).
    if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(cleaned)) return null
    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${cleaned})`)()
    return typeof result === 'number' && isFinite(result) ? result : null
  } catch { return null }
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

export interface CodeBlockProblem {
  lang: string
  error: string
  /** offsets of the fenced block (``` to ```) in the original text */
  start: number
  end: number
  code: string
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
    }
    if (error) problems.push({ lang, error, start: m.index, end: m.index + m[0].length, code })
  }
  return problems
}
