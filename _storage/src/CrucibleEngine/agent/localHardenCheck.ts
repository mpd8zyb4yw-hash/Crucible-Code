// ============================================================================
// Local harden substitute — priority-ladder item 1 (2026-07-04 ladder, ROADMAP.md).
//
// Gap it closes: `runHardenReview` (loop.ts) always routes to the ONLINE free pool
// (turnClass 'critic') because the on-device FM was measured at chance (2/4) on
// correctness judgment — see __critic_bench.ts. That is the right call when the online
// pool is reachable. But when it is NOT (offline-only / strict / quota-exhausted), the
// existing code returns `null` on the driveTurn error and the caller treats null as
// fail-open ACCEPT — i.e. the agent's single strongest correctness gate goes silently
// dark exactly when the model-cost-independent mission needs it most.
//
// This is not an attempt to replicate the online critic's judgment (that needs real
// semantic reasoning about the task, which is exactly the FM capability boundary
// __critic_bench.ts measured). It is a small, deterministic, zero-inference net for the
// highest-confidence, always-a-bug shapes that a senior reviewer would flag on sight —
// so "the online pool is down" degrades to "a narrower but real check ran" instead of
// "no check ran at all".
//
// Design constraints (same discipline as lintGate.ts / contractGate.ts):
// - Local, deterministic, no model call, syntactic-only TS AST walk (no type-checker).
// - Zero false positives on correct code: every pattern below is a shape that is ALWAYS
//   wrong, never a legitimate style choice. When in doubt, don't flag (a missed bug is
//   better than blocking a correct candidate — same principle Gate A2/A3 state).
// - Not exhaustive. This does not claim parity with the online critic; it only trades
//   "silently disabled" for "runs a real, narrower check", and says so via telemetry.
// ============================================================================
import ts from 'typescript'

export interface LocalHardenVerdict {
  solid: boolean
  findings: string   // '' when solid; one line per finding otherwise
}

interface Finding { line: number; message: string }

const SOURCE_HEADER = /^\/\/ ===== (.+) =====$/m

/** Split the concatenated `readProjectSources` blob back into individually-walkable files.
 *  Exported for reuse by localHardenFuzz.ts (the property/fuzz layer needs the same
 *  per-file split to transpile and execute each candidate in isolation). */
export function splitSources(sources: string): Array<{ path: string; content: string }> {
  const parts = sources.split(/\n\n(?=\/\/ ===== )/)
  const out: Array<{ path: string; content: string }> = []
  for (const part of parts) {
    const m = part.match(SOURCE_HEADER)
    if (!m) continue
    out.push({ path: m[1], content: part.slice(part.indexOf('\n') + 1) })
  }
  return out
}

function isLengthAccess(n: ts.Node): { base: ts.Expression } | null {
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') return { base: n.expression }
  return null
}

/** `X[X.length]` or `X[X.length + k]` (k >= 0) — always out of bounds; the last valid
 *  index is `X.length - 1`. This is exactly the bug runHardenReview's own prompt uses as
 *  its canonical example ("last(arr){return arr[arr.length]}"). */
function checkOffByOneTerminalAccess(sf: ts.SourceFile, findings: Finding[]) {
  const visit = (n: ts.Node) => {
    if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression
      let offset: number | null = null
      let lenBase: ts.Expression | null = null
      const len = isLengthAccess(arg)
      if (len) { offset = 0; lenBase = len.base }
      else if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        // Check both operand orders — `X.length + k` AND `k + X.length` — found missing
        // 2026-07-06: the original only matched length-on-the-left, so `arr[1 + arr.length]`
        // (same bug, operands swapped) passed clean.
        const lLeft = isLengthAccess(arg.left)
        const lRight = isLengthAccess(arg.right)
        if (lLeft && ts.isNumericLiteral(arg.right) && Number(arg.right.text) >= 0) {
          offset = Number(arg.right.text); lenBase = lLeft.base
        } else if (lRight && ts.isNumericLiteral(arg.left) && Number(arg.left.text) >= 0) {
          offset = Number(arg.left.text); lenBase = lRight.base
        }
      }
      if (lenBase && lenBase.getText(sf) === n.expression.getText(sf)) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
        findings.push({
          line: line + 1,
          message: `${n.getText(sf)} is always out of bounds — the last valid index is ` +
            `${n.expression.getText(sf)}.length - 1${offset > 0 ? ` (this is +${offset} past even the .length off-by-one)` : ''}`,
        })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

/** `for (let i = 0; i <= arr.length; i++) { ... arr[i] ... }` — the final iteration reads
 *  `arr[arr.length]`, one past the end. Only flagged when the SAME array is both the
 *  loop's length bound and indexed with the loop variable inside the body, so this can't
 *  fire on an intentional `<=` over some other bound (e.g. inclusive numeric ranges).
 *  Handles both orderings — `i <= arr.length` AND the logically-identical reversed form
 *  `arr.length >= i` (found missing 2026-07-06: the original only matched `<=` with the
 *  loop var on the left, so a candidate written the other way around passed clean). */
function checkOffByOneLoopBound(sf: ts.SourceFile, findings: Finding[]) {
  const visit = (n: ts.Node) => {
    if (ts.isForStatement(n) && n.condition && ts.isBinaryExpression(n.condition) &&
        (n.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
         n.condition.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)) {
      const isLte = n.condition.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken
      const lenSide = isLte ? n.condition.right : n.condition.left
      const varSide = isLte ? n.condition.left : n.condition.right
      const len = isLengthAccess(lenSide)
      const loopVar = varSide
      if (len && n.statement && ts.isIdentifier(loopVar)) {
        const arrName = len.base.getText(sf)
        let indexes = false
        const findIndex = (m: ts.Node) => {
          if (ts.isElementAccessExpression(m) && m.expression.getText(sf) === arrName &&
              m.argumentExpression.getText(sf) === loopVar.text) indexes = true
          ts.forEachChild(m, findIndex)
        }
        findIndex(n.statement)
        if (indexes) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
          const boundText = isLte ? `${loopVar.text} <= ${arrName}.length` : `${arrName}.length >= ${loopVar.text}`
          findings.push({
            line: line + 1,
            message: `loop bound "${boundText}" reads ` +
              `${arrName}[${arrName}.length] on the final iteration — always out of bounds; use "<" instead of "<="`,
          })
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

/** Division/modulo by a literal `0` — always NaN/Infinity, never intentional. Guarded to
 *  the literal case only (not "divide by a variable that might be zero", which is the
 *  defensive-hardening class runHardenReview's own prompt explicitly says NOT to flag). */
function checkDivideByZeroLiteral(sf: ts.SourceFile, findings: Finding[]) {
  // Also matches the compound assignment forms `x /= 0` / `x %= 0` (2026-07-06) — same bug,
  // the original only matched the binary-expression form (`x / 0`), not `/=`/`%=`.
  const DIVMOD_OPS = new Set([ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken])
  const DIVMOD_ASSIGN_OPS = new Set([ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken])
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) &&
        (DIVMOD_OPS.has(n.operatorToken.kind) || DIVMOD_ASSIGN_OPS.has(n.operatorToken.kind)) &&
        ts.isNumericLiteral(n.right) && Number(n.right.text) === 0) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      findings.push({ line: line + 1, message: `${n.getText(sf)} always divides by the literal 0` })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

/** `if (x = y)` / `while (x = y)` — an assignment where a comparison was almost certainly
 *  intended; the condition is always truthy (or whatever `y` is) rather than testing
 *  equality. Only flagged on the direct child of an `if`/`while`/`do-while` test — NOT
 *  inside a nested/parenthesized sub-expression, which is the standard "yes, I meant it"
 *  escape hatch (same convention as ESLint's `no-cond-assign` default mode, e.g.
 *  `while ((x = next()) != null)` stays unflagged because the assignment is wrapped in its
 *  own parens one level deeper than the condition itself). Compound assignments
 *  (`+=`, `??=`, ...) are exempted — those are never a stray `=`-for-`==` typo. */
function checkAssignmentInCondition(sf: ts.SourceFile, findings: Finding[]) {
  const flagIfBareAssignment = (test: ts.Expression) => {
    if (ts.isBinaryExpression(test) && test.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { line } = sf.getLineAndCharacterOfPosition(test.getStart(sf))
      findings.push({
        line: line + 1,
        message: `condition "${test.getText(sf)}" is an assignment, not a comparison — ` +
          `did you mean "${test.left.getText(sf)} === ${test.right.getText(sf)}"?`,
      })
    }
  }
  const visit = (n: ts.Node) => {
    if (ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      flagIfBareAssignment(n.expression)
    } else if (ts.isForStatement(n) && n.condition) {
      // Found missing 2026-07-06: `for (...; i = 1; ...)` is the same typo class as
      // `if (x = y)` (an always-truthy assignment where a comparison was meant) but the
      // original only visited if/while/do-while, never a for-loop's own condition slot.
      flagIfBareAssignment(n.condition)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

/** `x === NaN` / `x == NaN` (either operand) — always `false` no matter what `x` is,
 *  because `NaN` compares unequal to everything including itself; the correct check is
 *  `Number.isNaN(x)`. Well-established always-a-bug shape (same as ESLint's `use-isnan`).
 *  Deliberately does NOT flag `x !== x` / `x != x` — that's the classic (if dated) isNaN
 *  idiom, a legitimate pattern, not a bug. */
function checkNaNComparison(sf: ts.SourceFile, findings: Finding[]) {
  // Also matches `Number.NaN` (2026-07-06: the same global NaN value, spelled via the
  // Number namespace — the original only matched the bare `NaN` identifier).
  const isNaNIdentifier = (e: ts.Expression) =>
    (ts.isIdentifier(e) && e.text === 'NaN') ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'NaN' && ts.isIdentifier(e.expression) && e.expression.text === 'Number')
  const EQUALITY_OPS = new Set([
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ])
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) && EQUALITY_OPS.has(n.operatorToken.kind) &&
        (isNaNIdentifier(n.left) || isNaNIdentifier(n.right))) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      findings.push({
        line: line + 1,
        message: `${n.getText(sf)} is always ${n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken || n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ? 'true' : 'false'} — ` +
          `NaN never equals anything, including itself; use Number.isNaN(...) instead`,
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const CHECKS: Array<(sf: ts.SourceFile, findings: Finding[]) => void> = [
  checkOffByOneTerminalAccess,
  checkOffByOneLoopBound,
  checkDivideByZeroLiteral,
  checkAssignmentInCondition,
  checkNaNComparison,
]

/**
 * Deterministic, zero-inference stand-in for runHardenReview when the online critic pool
 * is unreachable. Never throws — a parse failure on one file just skips that file (fail
 * open per-file, same discipline as contractGate.ts's actualSignatures).
 */
export function runLocalHardenCheck(sources: string): LocalHardenVerdict {
  const files = splitSources(sources)
  const findings: Finding[] = []
  for (const f of files) {
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(f.path)) continue
    try {
      const sf = ts.createSourceFile(f.path, f.content, ts.ScriptTarget.Latest, true,
        /\.tsx$/.test(f.path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      for (const check of CHECKS) {
        const before = findings.length
        check(sf, findings)
        for (let i = before; i < findings.length; i++) {
          findings[i] = { ...findings[i], message: `${f.path}:${findings[i].line} — ${findings[i].message}` }
        }
      }
    } catch { /* unparseable file — skip, fail open */ }
  }
  if (!findings.length) return { solid: true, findings: '' }
  return { solid: false, findings: findings.slice(0, 3).map(f => f.message).join('\n') }
}
