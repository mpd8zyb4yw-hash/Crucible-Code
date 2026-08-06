// Goal-example oracle — mine LITERAL input→output examples stated in the goal prose and
// execute them as assertions, before the loop reports success.
//
// Why this exists (measured, cont this session): the agentic loop's only correctness gate is
// the FM-VISIBLE test.ts, which the corpus deliberately keeps weaker than the held-out hidden
// spec. When the FM writes code that greens the visible test but violates the goal, the loop
// reports ok:true — inflation. Three tier-1 tasks did this byte-identically across 3 runs;
// add-titlecase's goal literally says `titleCase("hello world") should return "Hello World"`
// and the FM shipped a file that never declared titleCase at all (the cont.80 synth-router
// clobber), yet passed because the visible test only re-checked the pre-existing slugify.
//
// The intent the FM ignored is IN THE GOAL. So we mine it — but with ZERO inference (the
// BINDING rule): we only extract examples written in explicit `fn(<literals>) → <literal>`
// form, transcribe the literal source spans VERBATIM into an assertion, and let the TS
// runtime evaluate them. We never compute an expected value ourselves, never map prose like
// "an empty array" to `[]`, never guess. If an example is not in clean literal-call form we
// ABSTAIN on it — a verifier fails in two directions (cont.85), and a wrongly-mined assertion
// would false-REJECT a correct candidate and poison the repair loop. Missing a check is safe;
// inventing one is not.
//
// This is the executing half of goal-grounded verification (VGR doctrine: weak FM +
// deterministic verifier + search). It catches the subclass of stable-WRONG whose goal states
// a concrete call example. Goals that state a RULE ("a dot in the domain part after the @")
// rather than an example are out of scope here by design — that is the metamorphic/property
// judge's job (cont.92 contract verifier), a separate and riskier build.

import type { SynthFile } from './synthEngine'

export interface MinedExample {
  /** Source of the whole call expression, spliced verbatim, e.g. `titleCase("hello world")`. */
  call: string
  /** Source of the expected literal, spliced verbatim, e.g. `"Hello World"`. */
  expected: string
  /** The called identifier, for the import and for provenance. */
  fnName: string
}

// Words/symbols that can sit between a `fn(args)` and its stated result. Kept tight: a loose
// cue list is how prose noise becomes a false example. All require a following literal.
const RESULT_CUE = new RegExp(
  '^\\s*(?:' +
    '===?|=>|→|⇒|' +                                   // === , => , → , ⇒
    '(?:should\\s+)?(?:return|returns|yield|yields|give|gives|produce|produces|be|become|becomes|equal|equals)|' +
    'must\\s+(?:return|be|equal)s?|' +
    'evaluates?\\s+to|' +
    'results?\\s+in' +
  ')\\s+',
  'i',
)

/**
 * Read a single JS literal starting at src[i] (skipping leading whitespace). Returns the end
 * index (exclusive) of the literal, or -1 if src[i..] does not begin with a literal. Literal
 * grammar only: string ('/"/`, no ${} interpolation), number, true/false/null/undefined,
 * balanced array or object of literals. This is a VALIDATOR that also delimits the source
 * span — it never evaluates.
 */
function readLiteral(src: string, i: number): number {
  const n = src.length
  while (i < n && /\s/.test(src[i])) i++
  if (i >= n) return -1
  const c = src[i]

  // string
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === c) return j + 1
      if (c === '`' && src[j] === '$' && src[j + 1] === '{') return -1  // interpolation ⇒ not a literal
      j++
    }
    return -1  // unterminated
  }

  // A literal must be followed by a token boundary: structural (, ) ] }), whitespace, EOS, or
  // sentence punctuation (. ; : ! ?). Sentence punctuation matters because a value often ENDS a
  // goal sentence ("returns 3.", "should be true."). The number regex is greedy over decimals,
  // so a trailing "." after a matched number can only be a sentence period, never a lost digit.
  const boundary = (ch: string) => /[\s,;:.!?)\]}]/.test(ch) || ch === ''

  // number (allow leading - and decimals; no exponent/hex — keep it conservative)
  const numMatch = /^-?\d+(?:\.\d+)?/.exec(src.slice(i))
  if (numMatch && boundary(src[i + numMatch[0].length] ?? '')) return i + numMatch[0].length

  // keyword literals
  for (const kw of ['true', 'false', 'null', 'undefined']) {
    if (src.startsWith(kw, i) && boundary(src[i + kw.length] ?? '')) return i + kw.length
  }

  // array / object — balanced, every element/value must itself be a literal
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}'
    let j = i + 1
    while (j < n) {
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === close) return j + 1
      if (c === '{') {
        // key : literal — key is an identifier or a string literal
        const keyStr = readLiteral(src, j)
        if (keyStr !== -1 && (src[j] === '"' || src[j] === "'")) { j = keyStr }
        else {
          const idm = /^[A-Za-z_$][\w$]*/.exec(src.slice(j))
          if (!idm) return -1
          j += idm[0].length
        }
        while (j < n && /\s/.test(src[j])) j++
        if (src[j] !== ':') return -1
        j++
      }
      const vEnd = readLiteral(src, j)
      if (vEnd === -1) return -1
      j = vEnd
      while (j < n && /\s/.test(src[j])) j++
      if (src[j] === ',') { j++; continue }
      if (src[j] === close) return j + 1
      return -1
    }
    return -1
  }

  return -1
}

/** Read a comma-separated list of literals filling `inner` exactly (an arg list). null if any
 *  element is not a clean literal or there is trailing garbage. Empty inner ⇒ []. */
function readLiteralArgs(inner: string): string[] | null {
  if (!inner.trim()) return []
  const args: string[] = []
  let i = 0
  const n = inner.length
  while (i < n) {
    const end = readLiteral(inner, i)
    if (end === -1) return null
    args.push(inner.slice(i, end).trim())
    i = end
    while (i < n && /\s/.test(inner[i])) i++
    if (i >= n) break
    if (inner[i] !== ',') return null  // garbage between literals ⇒ not a clean arg list
    i++
  }
  return args
}

// A call `IDENT( ... )` with no nested parens in the arg list (a nested call is not a literal
// arg list, so we would abstain on it anyway).
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g

/**
 * Mine literal call→value examples from goal prose. Conservative by construction: only
 * `IDENT(literal, …) <cue> literal` yields an example; everything else abstains. Deduped.
 */
export function mineGoalExamples(goal: string): MinedExample[] {
  const out: MinedExample[] = []
  const seen = new Set<string>()
  for (const m of goal.matchAll(CALL_RE)) {
    const fnName = m[1]
    const argsInner = m[2]
    const args = readLiteralArgs(argsInner)
    if (args === null) continue                       // args are not all literals ⇒ abstain

    const after = goal.slice(m.index! + m[0].length)
    const cue = RESULT_CUE.exec(after)
    if (!cue) continue                                // no result cue ⇒ this call is not an example

    const rest = after.slice(cue[0].length)
    const vEnd = readLiteral(rest, 0)
    if (vEnd === -1) continue                         // expected is not a literal ⇒ abstain
    const expected = rest.slice(0, vEnd).trim()

    const call = `${fnName}(${args.join(', ')})`
    const key = `${call}=>${expected}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ call, expected, fnName })
  }
  return out
}

/**
 * Build an executable test file asserting every mined example against the candidate module.
 * Returns null when nothing was mined (the common case — no example in the goal). The emitted
 * file follows the same shape as deriveInvariant's testFile: a self-contained script that
 * imports from the module under test and exits non-zero on any failure, which the existing
 * oracle already knows how to stage and run. deepStrictEqual so array/object results compare
 * by value. If the candidate does not export `fnName`, the import fails and the assertion is
 * a failure — which is exactly the signal we want for the clobber case (titleCase absent).
 */
export function buildGoalExampleTest(goal: string, modulePath: string): SynthFile | null {
  const examples = mineGoalExamples(goal)
  if (!examples.length) return null

  const importPath = '../' + modulePath.replace(/\.tsx?$/, '')
  const fns = [...new Set(examples.map(e => e.fnName))]
  const lines = [
    `// Goal-example oracle — literal call→value examples transcribed VERBATIM from the goal`,
    `// prose (Crucible synth/goalExampleOracle). Zero inference: no expected value was computed.`,
    `import { ${fns.join(', ')} } from '${importPath}'`,
    `let failures = 0`,
  ]
  for (const e of examples) {
    // deepStrictEqual via a tiny inline structural compare to avoid a node:assert import
    // mismatch across the scratch project's module mode; JSON is enough for literal results.
    const label = `${e.call} === ${e.expected}`.replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    lines.push(
      `try {`,
      `  const __got = ${e.call}`,
      `  const __exp = ${e.expected}`,
      `  const __ok = JSON.stringify(__got) === JSON.stringify(__exp)`,
      `  console.log((__ok ? 'PASS' : 'FAIL') + ' — goal example: ${label}' + (__ok ? '' : '  (got ' + JSON.stringify(__got) + ')'))`,
      `  if (!__ok) failures++`,
      `} catch (e) {`,
      `  console.log('FAIL — goal example threw: ${label}  (' + String((e && (e as any).message) || e) + ')')`,
      `  failures++`,
      `}`,
    )
  }
  lines.push(
    `console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)')`,
    `process.exit(failures === 0 ? 0 : 1)`,
    ``,
  )
  return { path: '__goalexample__/spec.test.ts', content: lines.join('\n') }
}

/**
 * DerivedTests-shaped wrapper so the goal-example oracle can slot into universal.ts's
 * effectiveDerived fallback chain (same {testFile, count} contract as deriveTests). Returns
 * null when the goal states no literal call→value example — the common case — so it only ever
 * ADDS coverage for the stable-WRONG subclass and never displaces a stronger derived test.
 */
export function deriveGoalExampleTests(
  goal: string,
  modulePath: string,
): { testFile: SynthFile; count: number } | null {
  const examples = mineGoalExamples(goal)
  if (!examples.length) return null
  const testFile = buildGoalExampleTest(goal, modulePath)
  if (!testFile) return null
  return { testFile, count: examples.length }
}
